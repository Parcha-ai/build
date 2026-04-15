import { IpcMain, BrowserWindow, shell } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { AuthService } from '../services/auth.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);
const authService = new AuthService();

type ProviderStatus = {
  loggedIn: boolean;
  method?: 'cli' | 'apiKey' | 'chatgpt';
  detail?: string;
};

// Resolve the real user home, ignoring any HOME override (used by demo mode).
// On macOS the login keychain lives under the real user's home, not the env's HOME.
function realUserHome(): string {
  const user = process.env.USER || process.env.LOGNAME;
  if (process.platform === 'darwin' && user) {
    return `/Users/${user}`;
  }
  return os.homedir();
}

async function checkClaudeCli(): Promise<ProviderStatus> {
  if (process.platform === 'darwin') {
    const keychainPath = path.join(realUserHome(), 'Library', 'Keychains', 'login.keychain-db');
    try {
      await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', keychainPath]);
      return { loggedIn: true, method: 'cli', detail: 'Logged in via claude login' };
    } catch {
      // try default keychain search as a final fallback
      try {
        await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials']);
        return { loggedIn: true, method: 'cli', detail: 'Logged in via claude login' };
      } catch {
        // fall through to file check
      }
    }
  }
  // Linux/fallback: ~/.claude/.credentials.json
  for (const home of [realUserHome(), os.homedir()]) {
    try {
      const credsPath = path.join(home, '.claude', '.credentials.json');
      const stat = await fs.stat(credsPath);
      if (stat.size > 0) {
        return { loggedIn: true, method: 'cli', detail: 'Logged in via claude login' };
      }
    } catch {
      // no creds at this home
    }
  }
  return { loggedIn: false };
}

async function checkCodexCli(): Promise<ProviderStatus> {
  // Try real user home first (so demo HOME override doesn't lie about real auth state),
  // fall back to current HOME (preserves explicit demo overrides if a fake auth.json was placed there).
  const candidates = Array.from(new Set([realUserHome(), os.homedir()]));
  for (const home of candidates) {
    try {
      const authPath = path.join(home, '.codex', 'auth.json');
      const raw = await fs.readFile(authPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.tokens && (parsed.tokens.access_token || parsed.tokens.id_token)) {
        return { loggedIn: true, method: 'chatgpt', detail: 'Signed in with ChatGPT' };
      }
      if (parsed.OPENAI_API_KEY) {
        return { loggedIn: true, method: 'apiKey', detail: 'OpenAI API key configured' };
      }
    } catch {
      // no auth file at this home
    }
  }
  return { loggedIn: false };
}

export function registerAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async () => {
    try {
      const authUrl = await authService.initiateOAuth();

      // Open auth URL in a new window
      const authWindow = new BrowserWindow({
        width: 800,
        height: 700,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      authWindow.loadURL(authUrl);

      return new Promise((resolve, reject) => {
        authWindow.webContents.on('will-redirect', async (event, url) => {
          if (url.startsWith('grep://oauth/callback')) {
            event.preventDefault();
            const urlObj = new URL(url);
            const code = urlObj.searchParams.get('code');

            if (code) {
              try {
                const tokens = await authService.exchangeCode(code);
                authWindow.close();
                resolve(tokens);
              } catch (error) {
                authWindow.close();
                reject(error);
              }
            } else {
              authWindow.close();
              reject(new Error('No authorization code received'));
            }
          }
        });

        authWindow.on('closed', () => {
          reject(new Error('Auth window was closed'));
        });
      });
    } catch (error) {
      console.error('Auth login error:', error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    await authService.logout();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_USER, async () => {
    return authService.getUser();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_REPOS, async () => {
    return authService.getRepos();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_CHECK_PROVIDERS, async () => {
    const [claude, codex] = await Promise.all([checkClaudeCli(), checkCodexCli()]);
    return { claude, codex };
  });
}
