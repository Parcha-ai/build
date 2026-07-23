import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface CacheEnvelope<T> {
  version: 1;
  sessionId: string;
  value: T;
}

interface LegacyMessageCacheStore {
  get(key: string): unknown;
}

type LegacyStoreFactory = () => LegacyMessageCacheStore;

/**
 * A session-sharded cache for remote transcripts.
 *
 * The old electron-store cache grew past 40 MB and every update parsed,
 * serialized, and synchronously rewrote the entire file on Electron's main
 * thread. This store only loads and writes the session being used. The legacy
 * store remains a lazy, read-only fallback so upgrades do not discard cached
 * history when SSH is unavailable.
 */
export class SessionMessageCacheStore<T = unknown> {
  private static readonly instances = new Set<SessionMessageCacheStore<unknown>>();
  private readonly directoryPath: string;
  private readonly values = new Map<string, T>();
  private readonly versions = new Map<string, number>();
  private readonly dirtyVersions = new Map<string, number>();
  private readonly legacyStoreFactory: LegacyStoreFactory;
  private legacyStore: LegacyMessageCacheStore | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeInProgress = false;

  constructor(userDataPath: string, legacyStoreFactory?: LegacyStoreFactory) {
    this.directoryPath = path.join(userDataPath, 'claudette-message-cache');
    this.legacyStoreFactory = legacyStoreFactory || (() => {
      // Keep the heavyweight legacy electron-store completely off the startup
      // path. It is opened only if an SSH failure needs an entry that has not
      // yet been migrated to the sharded cache.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CachedStore } = require('./cached-store') as typeof import('./cached-store');
      return new CachedStore({ name: 'claudette-message-cache' });
    });
    SessionMessageCacheStore.instances.add(this as SessionMessageCacheStore<unknown>);
  }

  get(sessionId: string): T | undefined {
    if (this.values.has(sessionId)) {
      return this.values.get(sessionId);
    }

    const filePath = this.filePathFor(sessionId);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheEnvelope<T>;
      if (parsed?.version === 1 && parsed.sessionId === sessionId) {
        this.values.set(sessionId, parsed.value);
        return parsed.value;
      }
      console.warn(`[Message Cache] Ignoring invalid cache shard for ${sessionId}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[Message Cache] Failed to load cache shard for ${sessionId}:`, error);
      }
    }

    return this.loadLegacyValue(sessionId);
  }

  set(sessionId: string, value: T): void {
    this.values.set(sessionId, value);
    const version = (this.versions.get(sessionId) || 0) + 1;
    this.versions.set(sessionId, version);
    this.dirtyVersions.set(sessionId, version);
    this.scheduleWrite();
  }

  delete(sessionId: string): void {
    this.values.delete(sessionId);
    this.dirtyVersions.delete(sessionId);
    this.versions.set(sessionId, (this.versions.get(sessionId) || 0) + 1);
    void fs.promises.unlink(this.filePathFor(sessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        console.warn(`[Message Cache] Failed to delete cache shard for ${sessionId}:`, error);
      }
    });
  }

  private filePathFor(sessionId: string): string {
    const digest = crypto.createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.directoryPath, `${digest}.json`);
  }

  private loadLegacyValue(sessionId: string): T | undefined {
    try {
      this.legacyStore ||= this.legacyStoreFactory();
      const value = this.legacyStore.get(sessionId) as T | undefined;
      if (value !== undefined) {
        // Migrate only the requested entry. Do not mutate the large legacy file.
        this.set(sessionId, value);
      }
      return value;
    } catch (error) {
      console.warn(`[Message Cache] Failed to load legacy cache for ${sessionId}:`, error);
      return undefined;
    }
  }

  private scheduleWrite(delay = 2000): void {
    if (this.writeTimer || this.writeInProgress || this.dirtyVersions.size === 0) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushNext();
    }, delay);
  }

  private async flushNext(): Promise<void> {
    if (this.writeInProgress) return;
    const next = this.dirtyVersions.entries().next();
    if (next.done) return;

    const [sessionId, version] = next.value;
    const value = this.values.get(sessionId);
    if (value === undefined) {
      this.dirtyVersions.delete(sessionId);
      this.scheduleWrite(25);
      return;
    }

    this.writeInProgress = true;
    const filePath = this.filePathFor(sessionId);
    const tempPath = `${filePath}.${process.pid}.${version}.tmp`;
    let retryDelay = 25;
    try {
      // Only this session is serialized synchronously; disk I/O is asynchronous.
      // Yield between shards so a batch of hydrated sessions cannot monopolize
      // Electron's main event loop.
      const json = JSON.stringify({ version: 1, sessionId, value } satisfies CacheEnvelope<T>);
      await fs.promises.mkdir(this.directoryPath, { recursive: true });
      await fs.promises.writeFile(tempPath, json, 'utf8');

      if (this.dirtyVersions.get(sessionId) === version) {
        await fs.promises.rename(tempPath, filePath);
        this.dirtyVersions.delete(sessionId);
      } else {
        await fs.promises.unlink(tempPath).catch(() => undefined);
      }
    } catch (error) {
      retryDelay = 2000;
      await fs.promises.unlink(tempPath).catch(() => undefined);
      console.warn(`[Message Cache] Failed to persist cache shard for ${sessionId}:`, error);
    } finally {
      this.writeInProgress = false;
      this.scheduleWrite(retryDelay);
    }
  }

  private flushToDiskSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirtyVersions.size === 0) return;

    fs.mkdirSync(this.directoryPath, { recursive: true });
    for (const [sessionId, version] of this.dirtyVersions) {
      const value = this.values.get(sessionId);
      if (value === undefined) continue;
      const filePath = this.filePathFor(sessionId);
      const tempPath = `${filePath}.${process.pid}.${version}.quit.tmp`;
      try {
        const json = JSON.stringify({ version: 1, sessionId, value } satisfies CacheEnvelope<T>);
        fs.writeFileSync(tempPath, json, 'utf8');
        fs.renameSync(tempPath, filePath);
        this.dirtyVersions.delete(sessionId);
      } catch (error) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best effort cleanup while the app is already quitting.
        }
        console.warn(`[Message Cache] Failed to flush cache shard for ${sessionId}:`, error);
      }
    }
  }

  static flushAll(): void {
    for (const instance of SessionMessageCacheStore.instances) {
      instance.flushToDiskSync();
    }
  }
}
