/**
 * Update Service — GitHub Release Checker
 *
 * Periodically checks the Parcha-ai/build GitHub repo for new releases.
 * Notifies the renderer via IPC when a newer version is available.
 * No auto-download, no auto-install — just a polite notification.
 */

import https from 'https';
import { app, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';

// The repo to check for releases
const GITHUB_OWNER = 'Parcha-ai';
const GITHUB_REPO = 'build';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 10 * 1000; // 10 seconds after launch

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
}

/**
 * Compare two semver strings (e.g. "0.5.27" vs "0.5.28").
 * Returns true if `remote` is newer than `local`.
 */
function isNewerVersion(local: string, remote: string): boolean {
  const localParts = local.split('.').map(Number);
  const remoteParts = remote.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const l = localParts[i] || 0;
    const r = remoteParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }

  return false;
}

/**
 * Fetch JSON from a URL using Node's https module.
 * Returns a promise that resolves with the parsed JSON.
 */
function fetchJSON<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': `Build/${app.getVersion()}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    https.get(url, options, (res) => {
      // Handle redirects (GitHub API may 301/302)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON<T>(res.headers.location).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        // Drain the response so the socket can be reused
        res.resume();
        reject(new Error(`GitHub API returned ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

interface GitHubRelease {
  tag_name: string;
  body?: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

class UpdateService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private mainWindow: BrowserWindow | null = null;
  private dismissedVersion: string | null = null;
  private lastNotifiedVersion: string | null = null;

  /**
   * Start the update checker. Call after the main window is created.
   */
  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;

    // Check after a polite delay — let the app settle first
    this.startupTimer = setTimeout(() => {
      this.checkForUpdates();
    }, STARTUP_DELAY_MS);

    // Then check every 30 minutes
    this.timer = setInterval(() => {
      this.checkForUpdates();
    }, CHECK_INTERVAL_MS);

    // Unref timers so they don't keep the process alive during shutdown
    if (this.startupTimer && typeof this.startupTimer === 'object' && 'unref' in this.startupTimer) {
      (this.startupTimer as NodeJS.Timeout).unref();
    }
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }

    console.log('[UpdateService] Started — will check in 10s, then every 30m');
  }

  /**
   * Stop the update checker. Call on app quit.
   */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.mainWindow = null;
  }

  /**
   * Allow the user to dismiss a specific version so we don't nag.
   */
  dismissVersion(version: string): void {
    this.dismissedVersion = version;
  }

  /**
   * Check GitHub for the latest release and notify if newer.
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      const currentVersion = app.getVersion();
      console.log(`[UpdateService] Checking for updates (current: v${currentVersion})`);

      const release = await fetchJSON<GitHubRelease>(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
      );

      // Strip leading 'v' from tag_name
      const remoteVersion = release.tag_name.replace(/^v/, '');

      if (!isNewerVersion(currentVersion, remoteVersion)) {
        console.log(`[UpdateService] Up to date (latest: v${remoteVersion})`);
        return null;
      }

      // Don't notify for dismissed versions
      if (this.dismissedVersion === remoteVersion) {
        console.log(`[UpdateService] v${remoteVersion} available but dismissed by user`);
        return null;
      }

      // Find the .dmg asset
      const dmgAsset = release.assets.find(
        (a) => a.name.endsWith('.dmg')
      );

      const downloadUrl = dmgAsset
        ? dmgAsset.browser_download_url
        : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${release.tag_name}`;

      const updateInfo: UpdateInfo = {
        version: remoteVersion,
        downloadUrl,
        releaseNotes: release.body || undefined,
      };

      console.log(`[UpdateService] Update available: v${remoteVersion}`);

      // Only notify renderer if we haven't already notified for this version
      if (this.lastNotifiedVersion !== remoteVersion) {
        this.lastNotifiedVersion = remoteVersion;
        this.notifyRenderer(updateInfo);
      }

      return updateInfo;
    } catch (error) {
      // Silently handle network errors — the user doesn't need to know
      console.warn('[UpdateService] Check failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Push update notification to all renderer windows.
   */
  private notifyRenderer(info: UpdateInfo): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
    }
  }
}

export const updateService = new UpdateService();
