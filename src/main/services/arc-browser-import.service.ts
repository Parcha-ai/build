import { execFile } from 'child_process';
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CookiesSetDetails, Session as ElectronSession } from 'electron';
import type { ArcBrowserProfile, ArcCookieImportResult } from '../../shared/types';

const ARC_SAFE_STORAGE_SERVICE = 'Arc Safe Storage';
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
const SQLITE_PATH = '/usr/bin/sqlite3';
const SECURITY_PATH = '/usr/bin/security';

interface ArcProfileInfo {
  name?: string;
}

interface ArcLocalState {
  profile?: {
    info_cache?: Record<string, ArcProfileInfo>;
  };
}

interface ArcCookieRow {
  hostKey: string;
  topFrameSiteKey: string;
  name: string;
  value: string;
  encryptedValueHex: string;
  path: string;
  expiresUtc: string;
  isSecure: number;
  isHttpOnly: number;
  hasExpires: number;
  sameSite: number;
  sourceScheme: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runFile(
  executable: string,
  args: string[],
  timeout = 15_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function sameSiteFromChromium(value: number): CookiesSetDetails['sameSite'] {
  switch (value) {
    case 0:
      return 'no_restriction';
    case 1:
      return 'lax';
    case 2:
      return 'strict';
    default:
      return 'unspecified';
  }
}

export function deriveArcCookieKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Chromium cookie DB version 24 prepends SHA-256(host_key) to the plaintext
 * before encryption. Verifying and removing it prevents a cookie from being
 * imported for the wrong domain if a copied database row is malformed.
 */
export function decryptArcCookieValue(
  encryptedValueHex: string,
  hostKey: string,
  databaseVersion: number,
  key: Buffer,
): string | null {
  try {
    const encrypted = Buffer.from(encryptedValueHex, 'hex');
    if (encrypted.length <= 3 || encrypted.subarray(0, 3).toString('ascii') !== 'v10') {
      return null;
    }

    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);

    if (databaseVersion >= 24) {
      if (plaintext.length < 32) return null;
      const expectedDomainHash = createHash('sha256').update(hostKey).digest();
      if (!timingSafeEqual(plaintext.subarray(0, 32), expectedDomainHash)) {
        return null;
      }
      return plaintext.subarray(32).toString('utf8');
    }

    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

export function chromiumCookieTimeToUnixSeconds(value: string): number | undefined {
  try {
    const chromiumMicroseconds = BigInt(value);
    if (chromiumMicroseconds <= 0n) return undefined;
    const unixSeconds = (chromiumMicroseconds / 1_000_000n) - CHROMIUM_EPOCH_OFFSET_SECONDS;
    if (unixSeconds <= 0n) return undefined;
    return Number(unixSeconds);
  } catch {
    return undefined;
  }
}

function cookieSetDetails(
  row: ArcCookieRow,
  value: string,
): CookiesSetDetails | null {
  const host = row.hostKey.replace(/^\./, '').trim();
  if (!host || /[\s/]/.test(host)) return null;

  const secure = Boolean(row.isSecure) || row.sourceScheme === 2;
  const cookiePath = row.path.startsWith('/') ? row.path : '/';
  const url = `${secure ? 'https' : 'http'}://${host}${cookiePath}`;

  try {
    new URL(url);
  } catch {
    return null;
  }

  const details: CookiesSetDetails = {
    url,
    name: row.name,
    value,
    path: cookiePath,
    secure,
    httpOnly: Boolean(row.isHttpOnly),
    sameSite: sameSiteFromChromium(row.sameSite),
  };

  // Omitting domain preserves Chromium host-only cookies. Electron normalizes
  // an explicitly supplied domain to a leading-dot domain cookie.
  if (row.hostKey.startsWith('.')) {
    details.domain = row.hostKey;
  }

  if (row.hasExpires) {
    const expirationDate = chromiumCookieTimeToUnixSeconds(row.expiresUtc);
    if (expirationDate !== undefined) details.expirationDate = expirationDate;
  }

  return details;
}

export class ArcBrowserImportService {
  private readonly userDataPath: string;

  constructor(userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'User Data')) {
    this.userDataPath = userDataPath;
  }

  private assertSupported(): void {
    if (process.platform !== 'darwin') {
      throw new Error('Arc browser import is currently available on macOS only.');
    }
  }

  private async readLocalState(): Promise<ArcLocalState> {
    try {
      const content = await fs.readFile(path.join(this.userDataPath, 'Local State'), 'utf8');
      return JSON.parse(content) as ArcLocalState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Arc browser data was not found on this Mac.');
      }
      throw new Error('Arc profile information could not be read.');
    }
  }

  private async getCookieCount(cookieDbPath: string): Promise<number> {
    try {
      const { stdout } = await runFile(
        SQLITE_PATH,
        ['-readonly', cookieDbPath, 'SELECT COUNT(*) FROM cookies;'],
      );
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  async listProfiles(): Promise<ArcBrowserProfile[]> {
    this.assertSupported();
    const localState = await this.readLocalState();
    const profileInfo = localState.profile?.info_cache || {};
    const entries = await fs.readdir(this.userDataPath, { withFileTypes: true });

    const profiles = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
      .map(async (entry): Promise<ArcBrowserProfile | null> => {
        const info = profileInfo[entry.name];
        const name = info?.name?.trim() || (entry.name === 'Default' ? 'Default' : entry.name);
        if (name === '__ARC_SYSTEM_PROFILE') return null;

        const cookieDbPath = path.join(this.userDataPath, entry.name, 'Cookies');
        try {
          await fs.access(cookieDbPath);
        } catch {
          return null;
        }

        return {
          id: entry.name,
          name,
          isDefault: entry.name === 'Default',
          cookieCount: await this.getCookieCount(cookieDbPath),
        };
      }));

    return profiles
      .filter((profile): profile is ArcBrowserProfile => profile !== null)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
  }

  private async createCookieDatabaseSnapshot(sourcePath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'build-arc-cookie-import-'));
    const snapshotPath = path.join(temporaryDirectory, 'Cookies');
    const quotedSnapshotPath = `'${snapshotPath.replace(/'/g, "''")}'`;

    try {
      await runFile(SQLITE_PATH, ['-readonly', sourcePath, `.backup ${quotedSnapshotPath}`], 30_000);
    } catch {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      throw new Error('Arc cookies are busy. Close Arc briefly and try the import again.');
    }

    return {
      path: snapshotPath,
      cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
    };
  }

  private async readCookieRows(cookieDbPath: string): Promise<{ version: number; rows: ArcCookieRow[] }> {
    const versionResult = await runFile(
      SQLITE_PATH,
      ['-readonly', cookieDbPath, "SELECT value FROM meta WHERE key = 'version';"],
    );
    const version = Number.parseInt(versionResult.stdout.trim(), 10) || 0;
    const query = `
      SELECT
        host_key AS hostKey,
        top_frame_site_key AS topFrameSiteKey,
        name,
        value,
        hex(encrypted_value) AS encryptedValueHex,
        path,
        CAST(expires_utc AS TEXT) AS expiresUtc,
        is_secure AS isSecure,
        is_httponly AS isHttpOnly,
        has_expires AS hasExpires,
        samesite AS sameSite,
        source_scheme AS sourceScheme
      FROM cookies;
    `;
    const cookieResult = await runFile(SQLITE_PATH, ['-readonly', '-json', cookieDbPath, query], 30_000);
    const rows = cookieResult.stdout.trim()
      ? JSON.parse(cookieResult.stdout) as ArcCookieRow[]
      : [];
    return { version, rows };
  }

  private async getSafeStoragePassword(): Promise<string> {
    try {
      const { stdout } = await runFile(
        SECURITY_PATH,
        ['find-generic-password', '-w', '-s', ARC_SAFE_STORAGE_SERVICE],
        30_000,
      );
      const password = stdout.replace(/\r?\n$/, '');
      if (!password) throw new Error('empty password');
      return password;
    } catch {
      throw new Error('Arc Safe Storage access was denied. Allow Keychain access, then try again.');
    }
  }

  async importCookies(profileId: string, targetSession: ElectronSession): Promise<ArcCookieImportResult> {
    this.assertSupported();
    if (!profileId || profileId.includes('/') || profileId.includes('\\') || profileId.includes('\0')) {
      throw new Error('Invalid Arc profile.');
    }

    const profile = (await this.listProfiles()).find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error('That Arc profile is no longer available.');

    const sourcePath = path.join(this.userDataPath, profile.id, 'Cookies');
    const snapshot = await this.createCookieDatabaseSnapshot(sourcePath);
    let key: Buffer | undefined;

    try {
      const { version, rows } = await this.readCookieRows(snapshot.path);
      if (rows.some((row) => row.encryptedValueHex)) {
        key = deriveArcCookieKey(await this.getSafeStoragePassword());
      }

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const nowSeconds = Date.now() / 1000;

      // Keep the Electron cookie store responsive while importing a large Arc
      // profile rather than scheduling thousands of writes simultaneously.
      for (let start = 0; start < rows.length; start += 50) {
        const batch = rows.slice(start, start + 50);
        const results = await Promise.all(batch.map(async (row): Promise<'imported' | 'skipped' | 'failed'> => {
          // Electron's cookie API cannot faithfully represent CHIPS partition
          // keys, so do not widen partitioned cookies into global cookies.
          if (row.topFrameSiteKey) return 'skipped';

          const expirationDate = row.hasExpires
            ? chromiumCookieTimeToUnixSeconds(row.expiresUtc)
            : undefined;
          if (row.hasExpires && (!expirationDate || expirationDate <= nowSeconds)) return 'skipped';

          const value = row.value !== ''
            ? row.value
            : row.encryptedValueHex
              ? (key ? decryptArcCookieValue(row.encryptedValueHex, row.hostKey, version, key) : null)
              : '';
          if (value === null) return 'skipped';

          const details = cookieSetDetails(row, value);
          if (!details) return 'skipped';

          try {
            await targetSession.cookies.set(details);
            return 'imported';
          } catch {
            return 'failed';
          }
        }));

        for (const result of results) {
          if (result === 'imported') imported += 1;
          else if (result === 'skipped') skipped += 1;
          else failed += 1;
        }
      }

      await targetSession.cookies.flushStore();
      return {
        profileId: profile.id,
        profileName: profile.name,
        imported,
        skipped,
        failed,
        importedAt: new Date().toISOString(),
      };
    } finally {
      key?.fill(0);
      await snapshot.cleanup();
    }
  }
}

export const arcBrowserImportService = new ArcBrowserImportService();
