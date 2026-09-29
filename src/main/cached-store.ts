/**
 * CachedStore — drop-in replacement for electron-store that eliminates the
 * beachball caused by synchronous 9.5MB+ JSON reads/writes on every operation.
 *
 * Reads: instant from in-memory cache (populated on first access).
 * Writes: update cache immediately, debounce disk write to every 2 seconds.
 *
 * electron-store's get/set do full file read → JSON.parse → modify → JSON.stringify
 * → file write SYNCHRONOUSLY. With a 9.5MB sessions file and 85+ store operations
 * across the main process, this blocks the event loop for hundreds of ms per call.
 */
import Store from 'electron-store';
import * as fs from 'fs';

const storeInstances = new Map<string, CachedStore>();

export class CachedStore {
  private store: Store;
  private cache: Record<string, unknown> | null = null;
  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly WRITE_DELAY = 2000; // 2s debounce

  constructor(opts: { name: string }) {
    // Reuse existing instance for the same store name
    const existing = storeInstances.get(opts.name);
    if (existing) {
      this.store = existing.store;
      this.cache = existing.cache;
      this.dirty = existing.dirty;
      this.writeTimer = existing.writeTimer;
      return existing;
    }

    this.store = new Store(opts) as any;
    storeInstances.set(opts.name, this);
  }

  private loadCache(): Record<string, unknown> {
    if (!this.cache) {
      // Deep copy to avoid sharing references with electron-store's internal
      // Proxy. If another raw Store instance writes to the same file,
      // electron-store's internal object gets replaced — but our cache would
      // still reference the old (freed) object, causing V8 SIGSEGV crashes.
      const raw = (this.store as any).store || {};
      this.cache = JSON.parse(JSON.stringify(raw));
    }
    return this.cache!;
  }

  get(key?: string, defaultValue?: unknown): unknown {
    const data = this.loadCache();
    if (!key) return data;

    // Support dot-notation paths (e.g., 'sessions.abc123')
    const parts = key.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return defaultValue;
      current = (current as Record<string, unknown>)[part];
    }
    return current === undefined ? defaultValue : current;
  }

  set(key: string, value: unknown): void {
    const data = this.loadCache();

    // Support dot-notation paths
    const parts = key.split('.');
    let current: Record<string, unknown> = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] == null || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;

    this.dirty = true;
    this.scheduleDiskWrite();
  }

  delete(key: string): void {
    const data = this.loadCache();
    const parts = key.split('.');
    let current: Record<string, unknown> = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] == null || typeof current[part] !== 'object') return;
      current = current[part] as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1]];
    this.dirty = true;
    this.scheduleDiskWrite();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    const data = this.loadCache();
    return Object.keys(data).length;
  }

  // For compatibility with code that accesses .store directly
  get store_data(): Record<string, unknown> {
    return this.loadCache();
  }

  private scheduleDiskWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.flushToDisk();
    }, this.WRITE_DELAY);
  }

  flushToDisk(): void {
    if (!this.dirty || !this.cache) return;
    try {
      // Use electron-store's internal path for the file location
      const storePath = (this.store as any).path;
      if (storePath) {
        const json = JSON.stringify(this.cache, null, '\t');
        fs.writeFileSync(storePath, json, 'utf-8');
      }
      this.dirty = false;
    } catch (err) {
      console.error('[CachedStore] Failed to flush to disk:', err);
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  // Flush all stores on app quit
  static flushAll(): void {
    for (const [name, instance] of storeInstances) {
      if (instance.dirty) {
        console.log(`[CachedStore] Flushing ${name} on quit`);
        instance.flushToDisk();
      }
    }
  }
}
