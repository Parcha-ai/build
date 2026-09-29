import type { IpcMain, WebContents } from 'electron';
import * as pty from 'node-pty';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { ParableAuthRunState, ParableVendor } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { parableService } from '../services/parable.service';
import { sshService } from '../services/ssh.service';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import type { Session } from '../../shared/types';

const sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;

let authProcess: { kill: () => void } | null = null;
let authOwner: WebContents | null = null;
let authState: ParableAuthRunState = { running: false, output: '', phase: 'idle' };
let authCancelled = false;

const ANSI_ESCAPE = String.fromCharCode(27);
const URL_PATTERN = new RegExp(`https?://[^\\s${ANSI_ESCAPE}]+`, 'g');
const AUTH_HOSTS: Record<ParableVendor, string[]> = {
  claude: ['claude.ai', 'console.anthropic.com'],
  chatgpt: ['auth.openai.com', 'chatgpt.com'],
  xai: ['accounts.x.ai'],
};

function updateStructuredAuthOutput(chunk: string): void {
  authState.output = (authState.output + chunk).slice(-100_000);
  const urls = authState.output.match(URL_PATTERN);
  if (urls?.length && authState.vendor) {
    const valid = urls.map((value) => value.replace(/[),.;]+$/, '')).filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && AUTH_HOSTS[authState.vendor!].includes(url.hostname);
      } catch {
        return false;
      }
    });
    if (valid.length) authState.authorizationUrl = valid[valid.length - 1];
  }
  const codeMatch = authState.output.match(/(?:device code|enter this code):\s*([A-Z0-9-]+)/i);
  if (codeMatch) authState.userCode = codeMatch[1];
  if (/waiting for .*?(?:callback|authorization)/i.test(authState.output)) authState.phase = 'waiting';
}

function publishAuthState(): void {
  if (authOwner && !authOwner.isDestroyed()) {
    authOwner.send(IPC_CHANNELS.PARABLE_AUTH_EVENT, { ...authState });
  }
}

function startManagedRun(
  owner: WebContents,
  command: string,
  args: string[],
  cwd: string,
  initialOutput: string,
  onExit?: (exitCode: number) => string | void,
): ParableAuthRunState {
  if (authProcess) return { ...authState };
  authCancelled = false;
  authOwner = owner;
  authState = { running: true, output: `${initialOutput}\r\n`, phase: 'starting' };
  const processHandle = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      HOME: process.env.HOME || '',
      TERM: 'xterm-256color',
    },
  });
  authProcess = processHandle;
  processHandle.onData((data) => {
    authState.output = (authState.output + data).slice(-100_000);
    publishAuthState();
  });
  processHandle.onExit(({ exitCode }) => {
    authProcess = null;
    const finalExitCode = authCancelled ? 130 : exitCode;
    try {
      const message = onExit?.(finalExitCode);
      if (message) authState.output += `\r\n${message}\r\n`;
    } catch (error) {
      authState.output += `\r\nMigration cleanup failed: ${error instanceof Error ? error.message : String(error)}\r\n`;
    }
    if (authCancelled) authState.output += '\r\nAuthorization cancelled.\r\n';
    authState = { ...authState, running: false, exitCode: finalExitCode, phase: authCancelled ? 'cancelled' : finalExitCode === 0 ? 'complete' : 'error' };
    authCancelled = false;
    publishAuthState();
  });
  publishAuthState();
  return { ...authState };
}

function startProviderAuth(owner: WebContents, launcherPath: string, configDir: string, vendor: ParableVendor): ParableAuthRunState {
  if (authProcess) return { ...authState };
  authCancelled = false;
  authOwner = owner;
  authState = {
    running: true,
    output: `Starting ${vendor} subscription authorization…\n`,
    vendor,
    phase: 'starting',
  };
  const args = ['auth', 'add', vendor];
  // Device authorization is the most reliable app-hosted ChatGPT flow: no
  // localhost callback or pasted redirect is required.
  if (vendor === 'chatgpt') args.push('--device');
  const child: ChildProcessWithoutNullStreams = spawn(launcherPath, args, {
    cwd: configDir,
    env: { ...(process.env as Record<string, string>), HOME: process.env.HOME || '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Give the authorization wrapper and its native proxy child their own
    // process group so Cancel cannot leave a device-flow poller orphaned.
    detached: process.platform !== 'win32',
  });
  authProcess = {
    kill: () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          return;
        } catch { /* fall through if the group has already exited */ }
      }
      child.kill('SIGTERM');
    },
  };
  const consume = (data: Buffer) => {
    updateStructuredAuthOutput(data.toString('utf8'));
    publishAuthState();
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', (error) => {
    updateStructuredAuthOutput(`\n${error.message}\n`);
  });
  child.once('close', (exitCode, signal) => {
    authProcess = null;
    const finalExitCode = authCancelled ? 130 : (exitCode ?? (signal ? 1 : 0));
    authState = {
      ...authState,
      running: false,
      exitCode: finalExitCode,
      phase: authCancelled ? 'cancelled' : finalExitCode === 0 ? 'complete' : 'error',
    };
    authCancelled = false;
    publishAuthState();
  });
  publishAuthState();
  return { ...authState };
}

export function registerParableHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.PARABLE_GET_STATUS, () => (
    parableService.getSubscriptionStatus()
  ));
  ipcMain.handle(
    IPC_CHANNELS.PARABLE_GET_SETUP_COMMAND,
    (_event, vendors: ParableVendor[], buildProxy = true) => {
      const runtime = parableService.prepareRuntime('settings-setup');
      return parableService.buildSetupCommand(vendors, {
        buildProxy,
        skillDir: runtime.skillDir,
      });
    },
  );
  ipcMain.handle(IPC_CHANNELS.PARABLE_AUTH_GET_RUN, () => ({ ...authState }));
  ipcMain.handle(IPC_CHANNELS.PARABLE_CONFIG_GET, () => parableService.getConfigText());
  ipcMain.handle(IPC_CHANNELS.PARABLE_CONFIG_SET, (_event, content: string) => parableService.saveConfigText(content));
  ipcMain.handle(IPC_CHANNELS.PARABLE_CONFIG_GET_DATA, () => parableService.getConfigData());
  ipcMain.handle(IPC_CHANNELS.PARABLE_CONFIG_SET_DATA, (_event, data: Record<string, unknown>) => parableService.saveConfigData(data));
  ipcMain.handle(IPC_CHANNELS.PARABLE_SYNC_AUTH_SSH, async (_event, sessionId: string) => {
    const session = (sessionStore.get(`sessions.${sessionId}`)
      || sessionStore.get(`discoveredSessions.${sessionId}`)) as Session | undefined;
    if (!session?.sshConfig) throw new Error('The active session is not an SSH session.');
    return sshService.syncLocalParableAuthToRemote(sessionId, session.sshConfig);
  });
  ipcMain.handle(IPC_CHANNELS.PARABLE_SETUP_START, (event, vendors: ParableVendor[]) => {
    const runtime = parableService.prepareRuntime('settings-setup');
    const configDir = path.join(os.homedir(), '.config', 'parable');
    const configPath = path.join(configDir, 'parable.toml');
    const manifestPath = path.join(configDir, 'setup.json');
    let legacyBackup: string | undefined;
    if (fs.existsSync(configDir)) {
      const configDirStat = fs.lstatSync(configDir);
      if (!configDirStat.isDirectory() || configDirStat.isSymbolicLink()) {
        throw new Error(`${configDir} is not a safe configuration directory.`);
      }
      fs.chmodSync(configDir, 0o700);
    }
    if (fs.existsSync(configPath) && !fs.existsSync(manifestPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      legacyBackup = path.join(configDir, `parable.legacy-${stamp}.toml`);
      fs.renameSync(configPath, legacyBackup);
      fs.chmodSync(legacyBackup, 0o600);
    }
    const normalized = (['claude', 'chatgpt', 'xai'] as ParableVendor[])
      .filter((vendor) => vendor === 'claude' || vendors.includes(vendor));
    return startManagedRun(
      event.sender,
      '/bin/bash',
      [
        runtime.skillDir + '/parable.sh',
        '--non-interactive',
        '--vendors',
        normalized.join(','),
        '--build-proxy',
        '--no-auth',
      ],
      process.env.HOME || runtime.subscriptionStatus.configDir,
      legacyBackup
        ? `Preserved legacy configuration at ${legacyBackup}\r\nInstalling Parable and connecting selected subscriptions…`
        : 'Installing Parable and connecting selected subscriptions…',
      (exitCode) => {
        if (!legacyBackup) return;
        if (exitCode !== 0 && !fs.existsSync(configPath)) {
          fs.renameSync(legacyBackup, configPath);
          return `Setup failed; restored the legacy configuration to ${configPath}.`;
        }
        if (exitCode === 0) {
          return `Legacy model and routing settings remain available at ${legacyBackup}.`;
        }
      },
    );
  });
  ipcMain.handle(IPC_CHANNELS.PARABLE_AUTH_START, (event, vendor: ParableVendor) => {
    if (authProcess) return { ...authState };
    const status = parableService.getSubscriptionStatus();
    if (!status.configured) throw new Error('Set up Parable before connecting subscriptions.');
    if (!status.runtimeInstalled) throw new Error('The Parable runtime is not installed.');
    if (!status.vendors.includes(vendor)) throw new Error(`${vendor} is not selected in this Parable setup.`);
    return startProviderAuth(event.sender, status.launcherPath, status.configDir, vendor);
  });
  ipcMain.handle(IPC_CHANNELS.PARABLE_AUTH_CANCEL, () => {
    if (authProcess) {
      authCancelled = true;
      authProcess.kill();
      authState = { ...authState, output: `${authState.output}\r\nCancelling authorization…\r\n` };
      publishAuthState();
    }
  });
}
