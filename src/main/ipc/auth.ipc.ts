import { IpcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { AuthService } from '../services/auth.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import Store from 'electron-store';
import { findUsableLocalExecutable, isUsableLocalExecutable } from '../utils/local-executable';

const execFileAsync = promisify(execFile);
const authService = new AuthService();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

type ProviderStatus = {
  installed?: boolean;
  loggedIn: boolean;
  method?: 'cli' | 'apiKey' | 'chatgpt';
  detail?: string;
  path?: string | null;
  version?: string | null;
  installCommand?: string;
  loginCommand?: string;
  docsUrl?: string;
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
  const cli = await resolveCli(['claude']);
  if (process.platform === 'darwin') {
    const keychainPath = path.join(realUserHome(), 'Library', 'Keychains', 'login.keychain-db');
    try {
      await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', keychainPath]);
      return { installed: cli.installed, loggedIn: cli.installed, method: 'cli', detail: cli.installed ? 'Logged in via claude login' : 'Auth found; install Claude Code CLI', path: cli.path, version: cli.version, installCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/claude-code' };
    } catch {
      // try default keychain search as a final fallback
      try {
        await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials']);
        return { installed: cli.installed, loggedIn: cli.installed, method: 'cli', detail: cli.installed ? 'Logged in via claude login' : 'Auth found; install Claude Code CLI', path: cli.path, version: cli.version, installCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/claude-code' };
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
        return { installed: cli.installed, loggedIn: cli.installed, method: 'cli', detail: cli.installed ? 'Logged in via claude login' : 'Auth found; install Claude Code CLI', path: cli.path, version: cli.version, installCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/claude-code' };
      }
    } catch {
      // no creds at this home
    }
  }
  return { installed: cli.installed, loggedIn: false, path: cli.path, version: cli.version, installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude login', docsUrl: 'https://docs.anthropic.com/claude-code' };
}

async function checkCodexCli(): Promise<ProviderStatus> {
  const cli = await resolveCli(['codex'], getCodexCliCandidates());
  // Try real user home first (so demo HOME override doesn't lie about real auth state),
  // fall back to current HOME (preserves explicit demo overrides if a fake auth.json was placed there).
  const candidates = Array.from(new Set([realUserHome(), os.homedir()]));
  for (const home of candidates) {
    try {
      const authPath = path.join(home, '.codex', 'auth.json');
      const raw = await fs.readFile(authPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.tokens && (parsed.tokens.access_token || parsed.tokens.id_token)) {
        return { installed: cli.installed, loggedIn: cli.installed, method: 'chatgpt', detail: cli.installed ? 'Signed in with ChatGPT' : 'Auth found; install Codex CLI', path: cli.path, version: cli.version, installCommand: 'npm install -g @openai/codex', docsUrl: 'https://github.com/openai/codex' };
      }
      if (parsed.OPENAI_API_KEY) {
        return { installed: cli.installed, loggedIn: cli.installed, method: 'apiKey', detail: cli.installed ? 'OpenAI API key configured' : 'API key found; install Codex CLI', path: cli.path, version: cli.version, installCommand: 'npm install -g @openai/codex', docsUrl: 'https://github.com/openai/codex' };
      }
    } catch {
      // no auth file at this home
    }
  }
  return { installed: cli.installed, loggedIn: false, path: cli.path, version: cli.version, installCommand: 'npm install -g @openai/codex', loginCommand: 'codex auth login', docsUrl: 'https://github.com/openai/codex' };
}

function getCodexCliCandidates(): string[] {
  const platform = process.platform;
  const arch = process.arch;
  let targetTriple = '';
  if (platform === 'darwin' && arch === 'arm64') targetTriple = 'aarch64-apple-darwin';
  else if (platform === 'darwin' && arch === 'x64') targetTriple = 'x86_64-apple-darwin';
  else if (platform === 'linux' && arch === 'x64') targetTriple = 'x86_64-unknown-linux-gnu';
  else if (platform === 'linux' && arch === 'arm64') targetTriple = 'aarch64-unknown-linux-gnu';
  if (!targetTriple) return [];

  const platformPkg = path.join('@openai', `codex-${platform}-${arch}`);
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const binaryRels = [
    path.join('vendor', targetTriple, 'bin', binaryName),
    path.join('vendor', targetTriple, 'codex', binaryName),
  ];
  const candidateBases = [
    path.join(process.resourcesPath || '', 'node_modules', platformPkg),
    path.resolve(process.cwd(), 'node_modules', platformPkg),
    path.resolve(__dirname, '..', '..', 'node_modules', platformPkg),
  ];
  return candidateBases.flatMap((base) => binaryRels.map((binaryRel) => path.join(base, binaryRel)));
}

async function resolveCli(binaryNames: string[], extraCandidates: string[] = []): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  for (const candidate of extraCandidates) {
    if (!isUsableLocalExecutable(candidate)) continue;
    try {
      let version: string | null = null;
      try {
        const versionResult = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
        version = (versionResult.stdout || versionResult.stderr).trim().split('\n')[0] || null;
      } catch {
        // Some CLIs do not support --version or require auth first.
      }
      return { installed: true, path: candidate, version };
    } catch {
      // Try PATH candidates.
    }
  }

  const cliPath = findUsableLocalExecutable(binaryNames);
  if (cliPath) {
    try {
      let version: string | null = null;
      try {
        const versionResult = await execFileAsync(cliPath, ['--version'], { timeout: 5000 });
        version = (versionResult.stdout || versionResult.stderr).trim().split('\n')[0] || null;
      } catch {
        // Some CLIs do not support --version or require auth first.
      }
      return { installed: true, path: cliPath, version };
    } catch {
      // Fall through to "not installed".
    }
  }
  return { installed: false, path: null, version: null };
}

async function checkCursorCli(): Promise<ProviderStatus> {
  const home = realUserHome();
  const cli = await resolveCli(['cursor-agent', 'agent'], [
    path.join(home, '.local', 'bin', 'cursor-agent'),
    path.join(home, '.cursor', 'bin', 'cursor-agent'),
    path.join(home, '.local', 'bin', 'agent'),
    path.join(home, '.cursor', 'bin', 'agent'),
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent',
  ]);
  const base = { installed: cli.installed, path: cli.path, version: cli.version, installCommand: 'curl https://cursor.com/install -fsS | bash', loginCommand: 'cursor-agent login', docsUrl: 'https://cursor.com/cli' };
  if (!cli.path) return { ...base, loggedIn: false };
  try {
    const { stdout, stderr } = await execFileAsync(cli.path, ['status'], { timeout: 5000 });
    const output = `${stdout}\n${stderr}`;
    if (/logged in/i.test(output)) {
      return { ...base, loggedIn: true, method: 'cli', detail: 'Logged in via Cursor CLI' };
    }
  } catch {
    // Fall through to API key check.
  }
  const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
  const hasKey = !!((settings.cursorApiKey as string | undefined)?.trim() || (settingsStore.get('cursorApiKey') as string | undefined)?.trim() || process.env.CURSOR_API_KEY);
  return hasKey
    ? { ...base, loggedIn: true, method: 'apiKey', detail: 'Cursor API key configured' }
    : { ...base, loggedIn: false };
}

async function checkGeminiCli(): Promise<ProviderStatus> {
  const home = realUserHome();
  const cli = await resolveCli(['gemini'], [
    path.join(home, '.local', 'bin', 'gemini'),
    path.join(home, '.npm-global', 'bin', 'gemini'),
    '/usr/local/bin/gemini',
    '/opt/homebrew/bin/gemini',
  ]);
  const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
  const hasKey = !!((settings.geminiApiKey as string | undefined)?.trim() || settingsStore.get('googleApiKey') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const ready = cli.installed && hasKey;
  return {
    installed: cli.installed,
    loggedIn: ready,
    method: hasKey ? 'apiKey' : undefined,
    detail: ready ? 'Gemini API key configured' : hasKey ? 'API key found; install Gemini CLI' : cli.installed ? 'CLI installed; add API key' : undefined,
    path: cli.path,
    version: cli.version,
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  };
}

async function checkOpenCodeCli(): Promise<ProviderStatus> {
  const home = realUserHome();
  const cli = await resolveCli(['opencode'], [
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
    path.join(home, '.npm-global', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ]);
  const npx = cli.installed ? { installed: false, path: null, version: null } : await resolveCli(['npx'], [
    '/usr/local/bin/npx',
    '/opt/homebrew/bin/npx',
  ]);
  const hasRunner = cli.installed || npx.installed;
  const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
  const hasKey = !!((settings.deepseekApiKey as string | undefined)?.trim() || process.env.DEEPSEEK_API_KEY);
  const ready = hasRunner && hasKey;
  const runnerDetail = cli.installed ? 'OpenCode CLI installed' : npx.installed ? 'OpenCode available via npx opencode-ai' : 'Install OpenCode or Node/npm';
  return {
    installed: hasRunner,
    loggedIn: ready,
    method: hasKey ? 'apiKey' : undefined,
    detail: ready ? `DeepSeek API key configured; ${runnerDetail}` : hasKey ? `API key found; ${runnerDetail}` : hasRunner ? `${runnerDetail}; add DeepSeek key` : undefined,
    path: cli.path || npx.path,
    version: cli.version || npx.version,
    installCommand: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai/docs',
  };
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
    const [claude, codex, cursor, gemini, opencode] = await Promise.all([
      checkClaudeCli(),
      checkCodexCli(),
      checkCursorCli(),
      checkGeminiCli(),
      checkOpenCodeCli(),
    ]);
    return { claude, codex, cursor, gemini, opencode };
  });
}
