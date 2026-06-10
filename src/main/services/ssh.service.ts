import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { Readable, Writable, PassThrough } from 'stream';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import { BrowserWindow } from 'electron';
import type { SSHConfig } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { REMOTE_DETACHED_BRIDGE_SCRIPT } from './remote-bridge-script';

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_COLOR_CODE_RE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');

/**
 * Interface matching the Claude Agent SDK's SpawnedProcess
 * Used to wrap SSH exec channels for remote Claude Code execution
 */
export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

/**
 * SDK's spawn options passed to spawnClaudeCodeProcess hook
 */
export interface SDKSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

interface RemoteCommandProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  closeStdinOnEnd?: boolean;
}

interface DetachedRemoteBridgeConfig {
  jobDir: string;
  socketPath: string;
  logPath: string;
  exitPath: string;
  eofPath: string;
  pidPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface DetachedRemoteBridgeJob {
  jobDir: string;
  socketPath: string;
  logPath: string;
  exitPath: string;
  eofPath: string;
  pidPath: string;
  pid?: string;
  command?: string;
  active: boolean;
  completed: boolean;
  recovered: boolean;
  hasMetadata: boolean;
  logBytes: number;
  updatedAt: number;
}

export interface AttachedDetachedRemoteProcess {
  process: SpawnedProcess;
  job: DetachedRemoteBridgeJob;
}

interface RemoteBridgeInstall {
  bridgePath: string;
  nodeCommand: string;
}


export interface SSHConnectionTestResult {
  success: boolean;
  error?: string;
  claudeCodeVersion?: string;
  hostname?: string;
  cliCapabilities?: RemoteCliCapabilities;
  setupWarning?: string;
  missingCliInstallCommands?: RemoteCliSetupCommand[];
}

export interface SSHConnectionInfo {
  client: Client;
  config: SSHConfig;
}

export interface RecoverableRemoteProcessOptions {
  closeAfter?: boolean;
}

interface RemoteBridgeLookupOptions {
  connectionSessionId?: string;
}

export interface RemoteCliCapabilities {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  gemini: boolean;
  opencode: boolean;
}

export interface RemoteCliSetupCommand {
  harness: keyof RemoteCliCapabilities;
  label: string;
  command: string;
  docsUrl: string;
}

type RemoteCommandItem = { name: string; path: string; content: string; description?: string; scope: 'user' | 'project' };
type RemoteSkillItem = { name: string; path: string; content: string; description?: string; scope: 'user' | 'project' };
type RemoteAgentItem = { name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' };

const REMOTE_CLI_SETUP_COMMANDS: Record<keyof RemoteCliCapabilities, RemoteCliSetupCommand> = {
  claude: {
    harness: 'claude',
    label: 'Claude Code',
    command: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/claude-code',
  },
  codex: {
    harness: 'codex',
    label: 'Codex',
    command: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  cursor: {
    harness: 'cursor',
    label: 'Cursor Agent',
    command: 'curl https://cursor.com/install -fsS | bash',
    docsUrl: 'https://cursor.com/cli',
  },
  gemini: {
    harness: 'gemini',
    label: 'Gemini CLI',
    command: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  opencode: {
    harness: 'opencode',
    label: 'OpenCode',
    command: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai/docs',
  },
};

/**
 * Service for managing SSH connections and remote process execution
 */
export class SSHService {
  private connections: Map<string, SSHConnectionInfo> = new Map();
  private connectionTimeout = 30000; // 30 seconds

  // SSH health check intervals — heartbeats to detect dead connections
  private healthCheckIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private healthCheckFailures = new Map<string, number>();
  private readonly MAX_HEALTH_CHECK_FAILURES = 3;

  // Performance optimization: Cache remote transcripts with TTL
  private sshTranscriptCache = new Map<string, {
    content: string;
    fetchedAt: number;
    sessionId: string;
  }>();
  private readonly SSH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private remoteCliCapabilitiesCache = new Map<string, {
    capabilities: RemoteCliCapabilities;
    fetchedAt: number;
  }>();
  private remoteCliCapabilitiesDetections = new Map<string, Promise<RemoteCliCapabilities>>();
  private readonly REMOTE_CLI_CAPABILITIES_TTL = 5 * 60 * 1000; // 5 minutes
  private remoteBridgeReady = new Map<string, Promise<RemoteBridgeInstall>>();
  private activeTunnels: Set<string> = new Set();

  // MCP sync caches — avoid re-uploading when nothing has changed
  private mcpAuthSyncCache = new Map<string, { lastSyncedAt: number; localMtime: number }>();
  private readonly MCP_AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private harnessMcpSyncCache = new Map<string, number>(); // host -> lastSyncedAt
  private readonly HARNESS_MCP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private mcpConfigSyncInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();
  private remoteExtensionScanCache = new Map<string, {
    fetchedAt: number;
    value?: unknown;
    promise?: Promise<unknown>;
  }>();
  private readonly REMOTE_EXTENSION_SCAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

  private getSafeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  private getMcpConfigSyncKey(config: SSHConfig): string {
    const username = config.username || '';
    const host = config.host || '';
    const port = config.port || 22;
    const keyPath = config.privateKeyPath || '';
    return `${username}@${host}:${port}|${keyPath}`;
  }

  private getDetachedBridgeSessionDir(sessionId: string): string {
    return `/tmp/claudette-ssh-bridge/${this.getSafeSessionId(sessionId)}`;
  }

  private getRemoteWorkdirCdCommand(remoteWorkdir: string): string {
    const quotedWorkdir = this.quoteForShell(remoteWorkdir);
    const displayWorkdir = this.quoteForShell(remoteWorkdir || '~');
    return [
      `workdir=${quotedWorkdir}`,
      'case "$workdir" in "~") workdir="$HOME" ;; "~/"*) workdir="$HOME/${workdir#\\~/}" ;; esac',
      `if ! test -d "$workdir"; then echo "Remote workdir not found: ${displayWorkdir}" >&2; exit 66; fi`,
      'cd "$workdir"',
    ].join('; ');
  }

  private buildSessionEnvProcessLoop(sessionId: string, body: string): string {
    const safeSessionId = this.quoteForShell(this.getSafeSessionId(sessionId));
    return [
      `safe_session=${safeSessionId}`,
      'for envfile in /proc/[0-9]*/environ; do',
      'test -r "$envfile" || continue',
      'pid="${envfile#/proc/}"',
      'pid="${pid%/environ}"',
      'grep -azqx "CLAUDETTE_SESSION_ID=$safe_session" "$envfile" 2>/dev/null || continue',
      body,
      'done',
    ].join('\n');
  }

  private buildKillSessionEnvProcessesCommand(sessionId: string): string {
    return this.buildSessionEnvProcessLoop(
      sessionId,
      [
        'test "$pid" = "$$" -o "$pid" = "$PPID" && continue',
        'pkill -P "$pid" 2>/dev/null || true',
        'kill "$pid" 2>/dev/null || true',
        'sleep 0.1',
        'pkill -9 -P "$pid" 2>/dev/null || true',
        'kill -9 "$pid" 2>/dev/null || true',
      ].join('; ')
    );
  }

  private async assertRemoteWorkdirExists(sessionId: string, config: SSHConfig, remoteWorkdir?: string): Promise<void> {
    if (!remoteWorkdir || remoteWorkdir === '.') return;

    const client = await this.getConnection(sessionId, config);
    try {
      await this.execCommand(client, `${this.getRemoteWorkdirCdCommand(remoteWorkdir)}; printf __claudette_workdir_ok__`);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? ` (${error.message.trim()})` : '';
      throw new Error(`Remote workdir not found on ${config.host}: ${remoteWorkdir}${detail}`);
    }
  }

  private clearActiveTunnels(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of [...this.activeTunnels]) {
      if (key.startsWith(prefix)) {
        this.activeTunnels.delete(key);
      }
    }
  }

  /**
   * Test an SSH connection and report supported remote harness CLIs.
   */
  async testConnection(config: SSHConfig): Promise<SSHConnectionTestResult> {
    const client = new Client();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.end();
        resolve({ success: false, error: 'Connection timeout after 30 seconds' });
      }, this.connectionTimeout);

      client.on('ready', async () => {
        clearTimeout(timeout);

        try {
          const capabilities = this.parseRemoteCliCapabilities(
            await this.execCommand(client, this.buildRemoteCliDetectionCommand(config))
          );
          const hasHarnessCli = Object.values(capabilities).some(Boolean);

          if (!hasHarnessCli) {
            const missingCliInstallCommands = this.getMissingRemoteCliSetupCommands(capabilities);
            client.end();
            resolve({
              success: false,
              error: 'No supported harness CLI is installed on the remote machine. Install Claude Code, Codex, Cursor Agent, Gemini CLI, or OpenCode first.',
              cliCapabilities: capabilities,
              missingCliInstallCommands,
            });
            return;
          }

          let claudeCodeVersion: string | undefined;
          if (capabilities.claude) {
            const versionResult = await this.execCommand(
              client,
              `${this.getRemoteCommandPathPrefix(config)}\nclaude --version 2>/dev/null || true`
            );
            claudeCodeVersion = versionResult.trim() || undefined;
          }

          // Get hostname for display
          const hostnameResult = await this.execCommand(client, 'hostname');
          const hostname = hostnameResult.trim();
          const missingCliInstallCommands = this.getMissingRemoteCliSetupCommands(capabilities);
          const missingHarnesses = missingCliInstallCommands.map((command) => command.label);
          const setupWarning = missingHarnesses.length > 0
            ? `Missing remote harness CLIs: ${missingHarnesses.join(', ')}. Those harnesses will be skipped until installed.`
            : undefined;

          client.end();
          resolve({
            success: true,
            hostname,
            claudeCodeVersion,
            cliCapabilities: capabilities,
            setupWarning,
            missingCliInstallCommands,
          });
        } catch (error) {
          client.end();
          resolve({
            success: false,
            error: `Failed to verify Claude Code: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        let errorMessage = err.message;

        // Provide more helpful error messages
        if (err.message.includes('authentication')) {
          errorMessage = 'Authentication failed. Check your username and private key.';
        } else if (err.message.includes('ECONNREFUSED')) {
          errorMessage = `Connection refused. Is SSH running on ${config.host}:${config.port}?`;
        } else if (err.message.includes('ENOTFOUND')) {
          errorMessage = `Host not found: ${config.host}`;
        } else if (err.message.includes('ETIMEDOUT')) {
          errorMessage = `Connection timed out. Check if ${config.host} is reachable.`;
        }

        resolve({ success: false, error: errorMessage });
      });

      // Read private key
      let privateKey: Buffer;
      try {
        privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (error) {
        resolve({
          success: false,
          error: `Cannot read private key: ${config.privateKeyPath}`,
        });
        return;
      }

      // Connect
      client.connect({
        host: config.host,
        port: config.port || 22,
        username: config.username,
        privateKey,
        passphrase: config.passphrase,
        readyTimeout: this.connectionTimeout,
      });
    });
  }

  /**
   * Read a file from the remote machine
   */
  async readRemoteFile(sessionId: string, config: SSHConfig, filePath: string): Promise<string> {
    const connectionInfo = this.connections.get(sessionId);
    if (!connectionInfo) {
      throw new Error(`No SSH connection found for session ${sessionId}`);
    }

    // Use cat to read the file, escape single quotes in path
    const escapedPath = filePath.replace(/'/g, "'\\''");
    const command = `cat '${escapedPath}'`;

    try {
      const content = await this.execCommand(connectionInfo.client, command);
      return content;
    } catch (error) {
      throw new Error(`Failed to read remote file ${filePath}: ${(error as Error).message}`);
    }
  }

  /**
   * Write content to a remote file via SSH
   * Creates parent directories if they don't exist
   * Creates temporary connection if one doesn't exist
   */
  async writeRemoteFile(sessionId: string, config: SSHConfig, filePath: string, content: string): Promise<void> {
    try {
      const client = await this.getConnection(sessionId, config);

      // Escape single quotes in path
      const escapedPath = filePath.replace(/'/g, "'\\''");

      // Create parent directory first (mkdir -p)
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dir) {
        const escapedDir = dir.replace(/'/g, "'\\''");
        await this.execCommand(client, `mkdir -p '${escapedDir}'`);
      }

      // Write content using cat with heredoc (handles multiline content properly)
      const command = `cat > '${escapedPath}' << 'GREP_EOF'\n${content}\nGREP_EOF`;
      await this.execCommand(client, command);

      console.log('[SSH Service] Wrote remote file:', filePath);
    } catch (error) {
      throw new Error(`Failed to write remote file ${filePath}: ${(error as Error).message}`);
    }
  }

  /**
   * List contents of a remote directory
   * Returns an array of file/directory info with name, type, and permissions
   */
  async listRemoteDirectory(
    config: SSHConfig,
    remotePath: string
  ): Promise<Array<{ name: string; type: 'file' | 'directory'; permissions: string }>> {
    // Create a temporary connection for browsing
    const client = new Client();

    return new Promise((resolve, reject) => {
      client.on('ready', async () => {
        try {
          // Expand tilde to absolute path
          const expandedPath = remotePath.startsWith('~')
            ? (await this.execCommand(client, `echo ${remotePath}`)).trim()
            : remotePath;

          // Use find with printf for reliable parsing
          // Format: type|permissions|name (one per line)
          const escapedPath = expandedPath.replace(/'/g, "'\\''");
          const command = `find '${escapedPath}' -maxdepth 1 -mindepth 1 -printf '%y|%M|%f\\n' 2>/dev/null || echo "ERROR: Directory not found"`;
          const output = await this.execCommand(client, command);

          if (output.startsWith('ERROR:') || output.trim() === '') {
            // Try fallback with ls -1 and test -d for each entry
            const lsCommand = `cd '${escapedPath}' && ls -1A 2>/dev/null || echo "ERROR: Directory not found"`;
            const lsOutput = await this.execCommand(client, lsCommand);

            if (lsOutput.startsWith('ERROR:')) {
              client.end();
              reject(new Error('Directory not found or inaccessible'));
              return;
            }

            const names = lsOutput.trim().split('\n').filter(n => n.trim());
            const entries: Array<{ name: string; type: 'file' | 'directory'; permissions: string }> = [];

            // For each name, check if it's a directory
            for (const name of names) {
              const testCmd = `test -d '${escapedPath}/${name.replace(/'/g, "'\\''")}' && echo "d" || echo "f"`;
              const typeResult = await this.execCommand(client, testCmd);
              const type = typeResult.trim() === 'd' ? 'directory' : 'file';

              entries.push({
                name,
                type,
                permissions: type === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--', // Dummy permissions
              });
            }

            client.end();
            resolve(entries);
            return;
          }

          // Parse find output
          const lines = output.trim().split('\n').filter(line => line.trim());
          const entries: Array<{ name: string; type: 'file' | 'directory'; permissions: string }> = [];

          for (const line of lines) {
            // Format: type|permissions|name
            const parts = line.split('|');
            if (parts.length === 3) {
              const [typeChar, permissions, name] = parts;

              // Skip symbolic links (l), sockets (s), etc - only include files (f) and directories (d)
              if (typeChar === 'f' || typeChar === 'd') {
                entries.push({
                  name: name.trim(),
                  type: typeChar === 'd' ? 'directory' : 'file',
                  permissions: permissions.trim(),
                });
              }
            }
          }

          client.end();
          resolve(entries);
        } catch (error) {
          client.end();
          reject(error);
        }
      });

      client.on('error', (err) => {
        reject(err);
      });

      // Connect with provided SSH config
      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
      };

      if (config.privateKeyPath) {
        connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase;
        }
      }

      client.connect(connectConfig);
    });
  }

  /**
   * Recursively list all files in a remote directory (for QuickSearch)
   * Returns FileEntry[] format matching local fs.ipc.ts listFilesRecursive
   * Creates a temporary connection if one doesn't exist
   */
  async listRemoteFilesRecursive(
    sessionId: string,
    config: SSHConfig,
    remotePath: string,
    basePath: string,
    maxDepth = 30,
    currentDepth = 0
  ): Promise<Array<{
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'folder';
    extension?: string;
  }>> {
    if (currentDepth >= maxDepth) return [];

    // Check if we have an existing connection, otherwise create temporary one
    const existingConnection = this.connections.get(sessionId);
    const client = existingConnection?.client || new Client();
    const needsCleanup = !existingConnection;

    try {
      // If no existing connection, establish temporary one
      if (!existingConnection) {
        console.log('[SSH] Creating temporary connection for file listing');
        await new Promise<void>((resolve, reject) => {
          client.on('ready', () => resolve());
          client.on('error', (err) => reject(err));

          const connectConfig: ConnectConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
          };

          if (config.privateKeyPath) {
            connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
            if (config.passphrase) {
              connectConfig.passphrase = config.passphrase;
            }
          }

          client.connect(connectConfig);
        });
      }

      const entries: Array<{
        name: string;
        path: string;
        relativePath: string;
        type: 'file' | 'folder';
        extension?: string;
      }> = [];

      // Directories to skip (same as local listing)
      const IGNORED_DIRS = new Set([
        'node_modules', '.git', '.next', '__pycache__', '.pytest_cache',
        'dist', 'build', '.venv', 'venv', '.idea', '.vscode', 'coverage',
        '.cache', '.turbo',
      ]);

      // Use find command with printf to get type info in one pass (much faster!)
      const escapedPath = remotePath.replace(/'/g, "'\\''");

      // Build exclusion patterns for find command
      const excludePatterns = Array.from(IGNORED_DIRS)
        .map(dir => `-path '*/${dir}' -o -path '*/${dir}/*'`)
        .join(' -o ');

      // Find with printf format: type|fullpath (f=file, d=directory)
      // This avoids 5000 separate SSH commands to check each file type!
      const command = `find '${escapedPath}' \\( ${excludePatterns} \\) -prune -o -printf '%y|%p\\n' 2>/dev/null | head -n 5000`;

      const output = await this.execCommand(client, command);
      const lines = output.trim().split('\n').filter(l => l.trim());

      for (const line of lines) {
        const [typeChar, fullPath] = line.split('|');
        if (!fullPath || fullPath === remotePath) continue;

        const name = fullPath.split('/').pop() || '';

        // Skip hidden files except .env
        if (name.startsWith('.') && !name.startsWith('.env')) continue;

        // typeChar: 'f' = file, 'd' = directory
        const type = typeChar === 'd' ? 'folder' : 'file';

        // Skip if it's a directory in ignored list
        if (type === 'folder' && IGNORED_DIRS.has(name)) continue;

        const relativePath = fullPath.substring(basePath.length + 1); // +1 to remove leading slash

        entries.push({
          name,
          path: fullPath,
          relativePath,
          type,
          extension: type === 'file' ? name.split('.').pop()?.toLowerCase() : undefined,
        });
      }

      console.log(`[SSH] Listed ${entries.length} remote files from ${remotePath}`);

      return entries;
    } catch (error) {
      console.error(`[SSH] Error listing remote directory ${remotePath}:`, error);
      return [];
    } finally {
      // Clean up temporary connection
      if (needsCleanup) {
        client.end();
      }
    }
  }

  /**
   * Best-effort cleanup for stale Build bridge jobs across active SSH connections.
   * Kills orphaned bridge/tail/claude processes older than 6 hours.
   */
  async killAllRemoteProcesses(): Promise<void> {
    for (const [sessionId, conn] of this.connections.entries()) {
      try {
        const bridgeDir = this.getDetachedBridgeSessionDir(sessionId);
        // Only clean up COMPLETED or STALE bridge jobs — never kill active ones.
        // A job is safe to clean if:
        //   - Its stdout.log contains a "result" line (query completed), OR
        //   - Its directory is older than 6 hours (abandoned)
        // Active processes (no result, recent) are left alone so reconnection works.
        await this.execCommand(conn.client,
          `if test -d ${this.quoteForShell(bridgeDir)}; then ` +
          `for jobdir in ${this.quoteForShell(bridgeDir)}/*/; do ` +
          'test -d "$jobdir" || continue; ' +
          'completed=0; stale=0; ' +
          // Check if job completed (has result in stdout.log)
          'test -f "$jobdir/stdout.log" && grep -q \'"type":"result"\' "$jobdir/stdout.log" 2>/dev/null && completed=1; ' +
          // Check if job has an exit.json (process already exited)
          'test -f "$jobdir/exit.json" && completed=1; ' +
          // Check if directory is older than 6 hours (abandoned)
          'find "$jobdir" -maxdepth 0 -mmin +360 2>/dev/null | grep -q . && stale=1; ' +
          // Only kill + clean if completed or stale
          'if [ "$completed" = "1" ] || [ "$stale" = "1" ]; then ' +
          'pid="$(cat "$jobdir/pid" 2>/dev/null || true)"; ' +
          'test -n "$pid" && kill "$pid" 2>/dev/null || true; ' +
          'test -n "$pid" && pkill -P "$pid" 2>/dev/null || true; ' +
          'rm -rf "$jobdir"; ' +
          'fi; ' +
          'done; ' +
          'fi; ' +
          'true'
        );
        console.log(`[SSH Service] Cleaned up stale remote processes via connection ${sessionId}`);
      } catch (error) {
        console.warn(`[SSH Service] Failed to clean stale remote processes for ${sessionId}:`, error);
      }
    }
  }

  /**
   * Kill remote processes for a single Build SSH session.
   * Uses bridge pid files and legacy per-session tmux names instead of pkill-ing
   * every Claude process owned by the remote user.
   */
  async killRemoteProcesses(sessionId: string, config: SSHConfig): Promise<void> {
    try {
      const client = await this.getConnection(sessionId, config);
      const bridgeDir = this.getDetachedBridgeSessionDir(sessionId);
      const legacyPrefix = `/tmp/grep-${sessionId.substring(0, 8)}`;
      const legacyTmuxName = `grep-${sessionId.substring(0, 8)}`;

      await this.execCommand(client,
        `if test -d ${this.quoteForShell(bridgeDir)}; then ` +
        // Kill ALL processes tracked by pid files (not just claude — includes bridge, tail)
        `for pidfile in ${this.quoteForShell(bridgeDir)}/*/pid; do ` +
        'test -f "$pidfile" || continue; ' +
        'pid="$(cat "$pidfile" 2>/dev/null || true)"; ' +
        'test -n "$pid" && kill "$pid" 2>/dev/null || true; ' +
        // Also kill the process tree (tail watchers are children of the bridge)
        'test -n "$pid" && pkill -P "$pid" 2>/dev/null || true; ' +
        'done; ' +
        'sleep 0.2; ' +
        `for pidfile in ${this.quoteForShell(bridgeDir)}/*/pid; do ` +
        'test -f "$pidfile" || continue; ' +
        'pid="$(cat "$pidfile" 2>/dev/null || true)"; ' +
        'test -n "$pid" && kill -9 "$pid" 2>/dev/null || true; ' +
        'test -n "$pid" && pkill -9 -P "$pid" 2>/dev/null || true; ' +
        'done; ' +
        'for proc in $(ps -eo pid=,args= | awk -v dir=' + this.quoteForShell(bridgeDir) + ' \'index($0, dir)>0 {print $1}\'); do ' +
        'test "$proc" = "$$" -o "$proc" = "$PPID" && continue; ' +
        'kill "$proc" 2>/dev/null || true; ' +
        'done; ' +
        `rm -rf ${this.quoteForShell(bridgeDir)}; ` +
        'fi; ' +
        this.buildKillSessionEnvProcessesCommand(sessionId) + '; ' +
        `tmux kill-session -t ${this.quoteForShell(legacyTmuxName)} 2>/dev/null || true; ` +
        `rm -f ${this.quoteForShell(`${legacyPrefix}-in`)} ${this.quoteForShell(`${legacyPrefix}-out`)} ${this.quoteForShell(`${legacyPrefix}-output.log`)} 2>/dev/null || true; ` +
        'true'
      );
      console.log(`[SSH Service] Killed remote processes for session ${sessionId}`);
    } catch (error) {
      // Non-fatal — connection might already be dead
      console.warn(`[SSH Service] Failed to kill remote processes for ${sessionId}:`, error);
    }
  }

  /**
   * Reap detached bridge jobs before a foreground turn starts.
   *
   * A Claude Code process can emit a `result` and then stay alive for background
   * task notifications. That is useful while the turn owns the stream, but it is
   * unsafe once the user starts a new foreground turn: the old process can keep
   * editing files while the new one edits the same workspace. This cleanup is
   * intentionally session-scoped and leaves job logs in place for diagnostics.
   */
  async cleanupDetachedBridgeProcessesForNewTurn(
    sessionId: string,
    config: SSHConfig,
    options: { killActive?: boolean } = {}
  ): Promise<void> {
    try {
      const client = await this.getConnection(sessionId, config);
      const bridgeDir = this.getDetachedBridgeSessionDir(sessionId);
      const killActive = options.killActive ? '1' : '0';
      const recoveredPayload = JSON.stringify({
        recoveredAt: new Date().toISOString(),
        reason: options.killActive ? 'new_foreground_turn' : 'completed_process_reaped',
      });

      await this.execCommand(client,
        `bridge_dir=${this.quoteForShell(bridgeDir)}; ` +
        `kill_active=${this.quoteForShell(killActive)}; ` +
        `recovered_payload=${this.quoteForShell(recoveredPayload)}; ` +
        'if test -d "$bridge_dir"; then ' +
        'for jobdir in "$bridge_dir"/*; do ' +
        'test -d "$jobdir" || continue; ' +
        'pid="$(cat "$jobdir/pid" 2>/dev/null || true)"; ' +
        'active=0; test -n "$pid" && kill -0 "$pid" 2>/dev/null && active=1; ' +
        'completed=0; ' +
        'test -f "$jobdir/exit.json" && completed=1; ' +
        'test -f "$jobdir/stdout.log" && grep -q \'"type":"result"\' "$jobdir/stdout.log" 2>/dev/null && completed=1; ' +
        'should_kill=0; ' +
        'if test "$active" = "1" && test "$completed" = "1"; then should_kill=1; fi; ' +
        'if test "$active" = "1" && test "$kill_active" = "1"; then should_kill=1; fi; ' +
        'if test "$should_kill" = "1"; then ' +
        'if test -n "$pid"; then ' +
        'pkill -P "$pid" 2>/dev/null || true; ' +
        'kill "$pid" 2>/dev/null || true; ' +
        'sleep 0.2; ' +
        'pkill -9 -P "$pid" 2>/dev/null || true; ' +
        'kill -9 "$pid" 2>/dev/null || true; ' +
        'fi; ' +
        'for proc in $(ps -eo pid=,args= | awk -v dir="$jobdir" \'index($0, dir)>0 {print $1}\'); do ' +
        'test "$proc" = "$$" -o "$proc" = "$PPID" && continue; ' +
        'kill "$proc" 2>/dev/null || true; ' +
        'done; ' +
        'printf %s "$recovered_payload" > "$jobdir/recovered.json" 2>/dev/null || true; ' +
        'rm -f "$jobdir/stdin.sock" "$jobdir/stdin.eof" 2>/dev/null || true; ' +
        'fi; ' +
        'done; ' +
        'if test "$kill_active" = "1"; then ' +
        'for proc in $(ps -eo pid=,args= | awk -v dir="$bridge_dir" \'index($0, dir)>0 {print $1}\'); do ' +
        'test "$proc" = "$$" -o "$proc" = "$PPID" && continue; ' +
        'kill "$proc" 2>/dev/null || true; ' +
        'done; ' +
        this.buildKillSessionEnvProcessesCommand(sessionId) + '; ' +
        'fi; ' +
        'fi; true'
      );
      console.log(`[SSH Service] Reaped detached bridge processes for ${sessionId} (killActive=${options.killActive ? 'yes' : 'no'})`);
    } catch (error) {
      console.warn(`[SSH Service] Failed to reap detached bridge processes for ${sessionId}:`, error);
    }
  }

  async hasActiveRemoteProcess(sessionId: string, config: SSHConfig): Promise<boolean> {
    try {
      const client = await this.getConnection(sessionId, config);
      const legacyTmuxName = `grep-${sessionId.substring(0, 8)}`;
      const jobs = await this.listDetachedBridgeJobs(sessionId, config);
      if (jobs.some(job => job.active && !job.completed && !job.recovered && (!job.command || job.command === 'claude'))) {
        return true;
      }

      const output = await this.execCommand(client,
        'active=0; ' +
        this.buildSessionEnvProcessLoop(sessionId, [
          'cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"',
          'case "$cmd" in',
          'claude|claude\\ *|*/claude|*/claude\\ *|*\\ claude|*\\ claude\\ *|*@anthropic-ai/claude-code*|*/claude-code/*|cursor-agent|cursor-agent\\ *|*/cursor-agent|*/cursor-agent\\ *|*\\ cursor-agent|*\\ cursor-agent\\ *|agent|agent\\ *|*/agent|*/agent\\ *|*\\ agent|*\\ agent\\ *) kill -0 "$pid" 2>/dev/null && { active=1; break; } ;;',
          'esac',
        ].join('\n')) + '; ' +
        `if test "$active" = "0" && tmux has-session -t ${this.quoteForShell(legacyTmuxName)} 2>/dev/null; then active=1; fi; ` +
        'echo "$active"'
      );

      return output.trim().split('\n').pop() === '1';
    } catch (error) {
      console.warn(`[SSH Service] Failed to check active remote process for ${sessionId}:`, error);
      return false;
    }
  }

  private parseDetachedBridgeJobs(output: string): DetachedRemoteBridgeJob[] {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): DetachedRemoteBridgeJob | null => {
        const [jobDir, pid, command, active, completed, recovered, hasMetadata, updatedAt, logBytes, logPath, exitPath] = line.split('\t');
        if (!jobDir) return null;
        const normalizedJobDir = jobDir.replace(/\/+$/, '');
        return {
          jobDir: normalizedJobDir,
          socketPath: `${normalizedJobDir}/stdin.sock`,
          logPath: logPath || `${normalizedJobDir}/stdout.log`,
          exitPath: exitPath || `${normalizedJobDir}/exit.json`,
          eofPath: `${normalizedJobDir}/stdin.eof`,
          pidPath: `${normalizedJobDir}/pid`,
          pid: pid || undefined,
          command: command || undefined,
          active: active === '1',
          completed: completed === '1',
          recovered: recovered === '1',
          hasMetadata: hasMetadata === '1',
          logBytes: Number(logBytes || 0) || 0,
          updatedAt: Number(updatedAt || 0) || 0,
        };
      })
      .filter((job): job is DetachedRemoteBridgeJob => Boolean(job));
  }

  async listDetachedBridgeJobs(
    sessionId: string,
    config: SSHConfig,
    options: RemoteBridgeLookupOptions = {}
  ): Promise<DetachedRemoteBridgeJob[]> {
    try {
      const client = await this.getConnection(options.connectionSessionId || sessionId, config);
      const bridgeDir = this.getDetachedBridgeSessionDir(sessionId);
      const output = await this.execCommand(client,
        `if test -d ${this.quoteForShell(bridgeDir)}; then ` +
        `for jobdir in ${this.quoteForShell(bridgeDir)}/*; do ` +
        'test -d "$jobdir" || continue; ' +
        'pidfile="$jobdir/pid"; log="$jobdir/stdout.log"; exitfile="$jobdir/exit.json"; recoveredfile="$jobdir/recovered.json"; ' +
        'pid="$(cat "$pidfile" 2>/dev/null || true)"; ' +
        'cmdname="$(sed -n \'s/^[[:space:]]*"command"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$jobdir/config.json" 2>/dev/null | head -1)"; ' +
        'active=0; test -n "$pid" && kill -0 "$pid" 2>/dev/null && active=1; ' +
        'completed=0; ' +
        'if test -f "$exitfile"; then completed=1; ' +
        'elif test -f "$log" && grep -q \'"type":"result"\' "$log" 2>/dev/null; then completed=1; fi; ' +
        'recovered=0; test -f "$recoveredfile" && recovered=1; ' +
        'metadata=0; test -f "$jobdir/metadata.json" && metadata=1; ' +
        'updated="$(stat -c %Y "$jobdir" 2>/dev/null || stat -f %m "$jobdir" 2>/dev/null || echo 0)"; ' +
        'bytes="$(wc -c < "$log" 2>/dev/null || echo 0)"; ' +
        'printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$jobdir" "$pid" "$cmdname" "$active" "$completed" "$recovered" "$metadata" "$updated" "$bytes" "$log" "$exitfile"; ' +
        'done; ' +
        'fi; true'
      );
      return this.parseDetachedBridgeJobs(output).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      console.warn(`[SSH Service] Failed to list detached bridge jobs for ${sessionId}:`, error);
      return [];
    }
  }

  async getLatestRecoverableRemoteProcess(
    sessionId: string,
    config: SSHConfig,
    options: RemoteBridgeLookupOptions = {}
  ): Promise<DetachedRemoteBridgeJob | null> {
    const jobs = await this.listDetachedBridgeJobs(sessionId, config, options);
    const recentCompletedCutoff = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    return jobs.find((job) => {
      if (job.recovered) return false;
      if (job.command && job.command !== 'claude') return false;
      if (job.active) return true;
      if (!job.hasMetadata) return false;
      if (job.logBytes <= 0) return false;
      return job.completed && job.updatedAt >= recentCompletedCutoff;
    }) || null;
  }

  async hasRecoverableRemoteProcess(
    sessionId: string,
    config: SSHConfig,
    options: RecoverableRemoteProcessOptions = {}
  ): Promise<boolean> {
    if (options.closeAfter) {
      const recoverabilityProbeSessionId = [
        sessionId,
        'recoverable-probe',
        Date.now().toString(),
        Math.random().toString(16).slice(2),
      ].join('-');
      try {
        return Boolean(await this.getLatestRecoverableRemoteProcess(sessionId, config, {
          connectionSessionId: recoverabilityProbeSessionId,
        }));
      } finally {
        console.log(`[SSH Service] Closing one-shot recoverability probe connection for ${sessionId}`);
        this.closeSshConnection(recoverabilityProbeSessionId);
      }
    }

    return Boolean(await this.getLatestRecoverableRemoteProcess(sessionId, config));
  }

  async markDetachedBridgeJobRecovered(sessionId: string, config: SSHConfig, jobDir: string): Promise<void> {
    try {
      const safeJobDir = jobDir.replace(/\/+$/, '');
      if (!safeJobDir.startsWith(this.getDetachedBridgeSessionDir(sessionId) + '/')) {
        throw new Error('Refusing to mark unrelated bridge job as recovered');
      }
      const client = await this.getConnection(sessionId, config);
      const payload = JSON.stringify({ recoveredAt: new Date().toISOString() });
      await this.execCommand(
        client,
        `printf %s ${this.quoteForShell(payload)} > ${this.quoteForShell(`${safeJobDir}/recovered.json`)}`
      );
    } catch (error) {
      console.warn(`[SSH Service] Failed to mark bridge job recovered for ${sessionId}:`, error);
    }
  }

  /**
   * Get the current git branch on the remote for an SSH session.
   * Returns the branch name or null if not a git repo / connection failed.
   */
  async getRemoteBranch(sessionId: string, config: SSHConfig): Promise<string | null> {
    try {
      const client = await this.getConnection(sessionId, config);
      const quotedWorkdir = this.quoteForShell(config.remoteWorkdir || '~');
      const result = await this.execCommand(client, `
workdir=${quotedWorkdir}
case "$workdir" in
  "~") workdir="$HOME" ;;
  "~/"*) workdir="$HOME/\${workdir#\\~/}" ;;
esac
git -C "$workdir" rev-parse --abbrev-ref HEAD 2>/dev/null || true
`);
      const branch = result.trim();
      return branch || null;
    } catch (error) {
      console.warn(`[SSH Service] Failed to get remote branch for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Execute a command on the remote and return stdout.
   * Public to allow IPC layer to query remote state (e.g. git branch, remote URL).
   */
  execCommand(client: Client, command: string, options?: { pty?: boolean }): Promise<string> {
    return new Promise((resolve, reject) => {
      const execOptions = options?.pty ? { pty: true } : {};
      client.exec(command, execOptions, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        channel.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        if (channel.stderr) {
          channel.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        }

        channel.on('close', (code: number) => {
          if (code !== 0 && stderr) {
            reject(new Error(stderr));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  /**
   * Create a persistent connection for a session
   */
  async connect(sessionId: string, config: SSHConfig): Promise<void> {
    // Close existing connection if any
    this.disconnect(sessionId);

    const client = new Client();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      client.on('ready', () => {
        clearTimeout(timeout);
        this.connections.set(sessionId, { client, config });
        this.startHealthCheck(sessionId);
        console.log(`[SSH Service] Connected to ${config.host} for session ${sessionId}`);

        // One-time cleanup of orphaned remote processes on first connection
        if (!this.hasRunStartupCleanup) {
          this.hasRunStartupCleanup = true;
          setTimeout(() => {
            this.killAllRemoteProcesses().catch(e =>
              console.warn('[SSH Service] Startup cleanup failed:', e)
            );
          }, 5000);
        }

        resolve();
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.on('close', () => {
        this.connections.delete(sessionId);
        this.clearActiveTunnels(sessionId);
        console.log(`[SSH Service] Connection closed for session ${sessionId}`);

        // Stop health checks for this connection
        this.stopHealthCheck(sessionId);

        // Clean up MCP stdio bridges for this session
        import('./mcp-stdio-bridge.service').then(({ mcpStdioBridgeService }) => {
          mcpStdioBridgeService.stopBridgesForSession(sessionId).catch((err) => {
            console.warn('[SSH Service] Error stopping MCP bridges on close:', err);
          });
        }).catch(() => {
          // Module not available, ignore
        });

        // Notify renderer of connection loss for immediate UI feedback
        try {
          const windows = BrowserWindow.getAllWindows();
          for (const win of windows) {
            win.webContents.send(IPC_CHANNELS.SSH_CONNECTION_LOST, { sessionId, reason: 'SSH connection closed unexpectedly' });
          }
        } catch (e) {
          console.error('[SSH Service] Failed to send connection-lost event:', e);
        }
      });

      // Read private key
      let privateKey: Buffer;
      try {
        privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (error) {
        reject(new Error(`Cannot read private key: ${config.privateKeyPath}`));
        return;
      }

      client.connect({
        host: config.host,
        port: config.port || 22,
        username: config.username,
        privateKey,
        passphrase: config.passphrase,
        readyTimeout: this.connectionTimeout,
        keepaliveInterval: 10000, // Keep connection alive
        keepaliveCountMax: 3,
      });
    });
  }

  /**
   * Get or create a connection for a session
   */
  private async getConnection(
    sessionId: string,
    config: SSHConfig,
    options?: { livenessProbe?: boolean }
  ): Promise<Client> {
    // By default we skip the active liveness probe. A 30s periodic health check
    // already runs per connection (startHealthCheck), and the cheap socket
    // `destroyed / !writable` check below catches truly dead connections for
    // ~0ms. The active probe adds 40-80ms RTT per call which slows every
    // transcript fetch on SSH sessions. Callers that need extra certainty
    // (e.g. a one-shot operation that won't retry) can pass
    // `{ livenessProbe: true }` explicitly.
    const existing = this.connections.get(sessionId);
    if (existing) {
      // Cheap socket check — half-dead TCP sockets can linger in the map
      // without triggering the 'close' event.
      const socket = (existing.client as any)._sock;
      if (socket && (socket.destroyed || !socket.writable)) {
        console.warn(`[SSH Service] Cached connection for ${sessionId} has a dead socket — removing stale entry`);
        this.connections.delete(sessionId);
        this.stopHealthCheck(sessionId);
        this.clearActiveTunnels(sessionId);
        // Fall through to create a new connection
      } else if (options?.livenessProbe) {
        // Active liveness probe — only run when the caller explicitly asks
        // for it. Covers the Tailscale edge case where TCP stays writable
        // while SSH is blocked.
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('SSH ping timeout')), 5000);
            existing.client.exec('echo ok', (err, channel) => {
              clearTimeout(timeout);
              if (err) return reject(err);
              channel.on('close', () => resolve());
              channel.on('data', () => undefined); // drain
              channel.stderr.on('data', () => undefined); // drain
            });
          });
          return existing.client;
        } catch (err) {
          console.warn(`[SSH Service] Cached connection for ${sessionId} failed liveness probe: ${err} — reconnecting`);
          existing.client.end();
          this.connections.delete(sessionId);
          this.stopHealthCheck(sessionId);
          this.clearActiveTunnels(sessionId);
          // Fall through to create a new connection
        }
      } else {
        // Socket appears healthy — reuse without an RTT-adding probe.
        return existing.client;
      }
    }

    // Deduplicate: if a connect is already in progress for this session, wait for it
    const pendingKey = `_pending_${sessionId}`;
    if ((this as any)[pendingKey]) {
      await (this as any)[pendingKey];
      const recheck = this.connections.get(sessionId);
      if (recheck) return recheck.client;
    }
    const connectPromise = this.connect(sessionId, config);
    (this as any)[pendingKey] = connectPromise;
    try {
      await connectPromise;
    } finally {
      delete (this as any)[pendingKey];
    }
    const conn = this.connections.get(sessionId);
    if (!conn) {
      throw new Error('Failed to establish connection');
    }
    return conn.client;
  }

  /**
   * Run an SSH exec with a single auto-reconnect on failure. Used for idempotent
   * read-only operations (transcript fetch/list) where the cost of a spurious
   * retry is low and the win from skipping the liveness probe is large.
   */
  private async execWithRetry(
    sessionId: string,
    config: SSHConfig,
    command: string,
    options?: { pty?: boolean }
  ): Promise<string> {
    const client = await this.getConnection(sessionId, config);
    try {
      return await this.execCommand(client, command, options);
    } catch (err) {
      console.warn(`[SSH Service] execWithRetry failed first attempt, reconnecting: ${err}`);
      // Drop the stale connection and try once more with a fresh one.
      const existing = this.connections.get(sessionId);
      if (existing) {
        try { existing.client.end(); } catch { /* best-effort */ }
        this.connections.delete(sessionId);
        this.stopHealthCheck(sessionId);
        this.clearActiveTunnels(sessionId);
      }
      const fresh = await this.getConnection(sessionId, config);
      return this.execCommand(fresh, command, options);
    }
  }

  private closeSshConnection(sessionId: string): void {
    this.stopHealthCheck(sessionId);

    const conn = this.connections.get(sessionId);
    if (conn) {
      try {
        conn.client.end();
      } catch (error) {
        console.error('[SSH Service] Error disconnecting:', error);
      }
      this.connections.delete(sessionId);
      this.clearActiveTunnels(sessionId);
    }
  }

  private getRemoteBridgeInstallKey(config: SSHConfig): string {
    return `${config.username}@${config.host}:${config.port || 22}`;
  }

  private quoteForShell(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private getRemoteCommandPathPrefix(config: SSHConfig): string {
    return `export PATH="/home/${config.username}/.local/bin:/home/${config.username}/.cursor/bin:/home/${config.username}/.bun/bin:/home/${config.username}/.npm-global/bin:/home/${config.username}/bin:$HOME/.local/bin:$HOME/.cursor/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH`;
  }

  private buildRemoteCliDetectionCommand(config: SSHConfig): string {
    return `
${this.getRemoteCommandPathPrefix(config)}
detect_cli() {
  key="$1"
  shift
  for bin in "$@"; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '%s=1\\n' "$key"
      return
    fi
  done
  printf '%s=0\\n' "$key"
}

detect_cli claude claude
detect_cli codex codex
detect_cli cursor cursor-agent agent
detect_cli opencode opencode npx
detect_cli gemini gemini
`;
  }

  private parseRemoteCliCapabilities(output: string): RemoteCliCapabilities {
    const capabilities: RemoteCliCapabilities = {
      claude: false,
      codex: false,
      cursor: false,
      gemini: false,
      opencode: false,
    };

    for (const line of output.split('\n')) {
      const match = /^(claude|codex|cursor|gemini|opencode)=(0|1)$/.exec(line.trim());
      if (!match) continue;
      capabilities[match[1] as keyof RemoteCliCapabilities] = match[2] === '1';
    }

    return capabilities;
  }

  private getMissingRemoteCliSetupCommands(capabilities: RemoteCliCapabilities): RemoteCliSetupCommand[] {
    return (Object.keys(REMOTE_CLI_SETUP_COMMANDS) as Array<keyof RemoteCliCapabilities>)
      .filter((harness) => !capabilities[harness])
      .map((harness) => REMOTE_CLI_SETUP_COMMANDS[harness]);
  }

  private getRemoteCliCapabilitiesCacheKey(config: SSHConfig): string {
    return `${config.username}@${config.host}:${config.port || 22}`;
  }

  getCachedRemoteCliCapabilities(config: SSHConfig): RemoteCliCapabilities | undefined {
    const cached = this.remoteCliCapabilitiesCache.get(this.getRemoteCliCapabilitiesCacheKey(config));
    if (!cached || Date.now() - cached.fetchedAt >= this.REMOTE_CLI_CAPABILITIES_TTL) {
      return undefined;
    }
    return cached.capabilities;
  }

  async detectRemoteCliCapabilities(
    sessionId: string,
    config: SSHConfig,
    options?: { force?: boolean },
  ): Promise<RemoteCliCapabilities> {
    const cacheKey = this.getRemoteCliCapabilitiesCacheKey(config);
    const cached = this.getCachedRemoteCliCapabilities(config);
    if (!options?.force && cached) {
      return cached;
    }

    if (!options?.force) {
      const pending = this.remoteCliCapabilitiesDetections.get(cacheKey);
      if (pending) {
        return pending;
      }
    }

    const detection = (async () => {
      let capabilities: RemoteCliCapabilities = {
        claude: false,
        codex: false,
        cursor: false,
        gemini: false,
        opencode: false,
      };

      try {
        const client = await this.getConnection(sessionId, config);
        capabilities = this.parseRemoteCliCapabilities(
          await this.execCommand(client, this.buildRemoteCliDetectionCommand(config))
        );

        this.remoteCliCapabilitiesCache.set(cacheKey, {
          capabilities,
          fetchedAt: Date.now(),
        });
        console.log('[SSH Service] Remote CLI capabilities:', capabilities);
      } catch (error) {
        console.warn('[SSH Service] Failed to detect remote CLI capabilities:', error);
        if (cached) {
          return cached;
        }
      }

      return capabilities;
    })();

    if (!options?.force) {
      this.remoteCliCapabilitiesDetections.set(cacheKey, detection);
      try {
        return await detection;
      } finally {
        this.remoteCliCapabilitiesDetections.delete(cacheKey);
      }
    }

    return detection;
  }

  private async ensureDetachedRemoteBridge(sessionId: string, config: SSHConfig): Promise<RemoteBridgeInstall> {
    const key = this.getRemoteBridgeInstallKey(config);
    const existing = this.remoteBridgeReady.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const client = await this.getConnection(sessionId, config);
      const safeUsername = config.username.replace(/[^a-zA-Z0-9_-]/g, '-');
      const bridgePath = `/tmp/claudette-remote-bridge-${safeUsername}.js`;

      const nodeResult = await this.execCommand(
        client,
        `${this.getRemoteCommandPathPrefix(config)} && (command -v node || command -v nodejs || echo "__NODE_NOT_FOUND__")`
      );
      const nodeCommand = nodeResult.trim().split('\n').find((line) => line.trim().length > 0) || '';
      if (!nodeCommand || nodeCommand === '__NODE_NOT_FOUND__') {
        throw new Error('Remote machine needs node or nodejs installed to keep SSH sessions running after disconnects.');
      }

      await this.execCommand(client, `mkdir -p ${this.quoteForShell('/tmp/claudette-ssh-bridge')}`);
      await this.writeRemoteFile(sessionId, config, bridgePath, REMOTE_DETACHED_BRIDGE_SCRIPT);
      await this.execCommand(client, `chmod 700 ${this.quoteForShell(bridgePath)}`);

      return { bridgePath, nodeCommand };
    })().catch((error) => {
      this.remoteBridgeReady.delete(key);
      throw error;
    });

    this.remoteBridgeReady.set(key, promise);
    return promise;
  }

  private createDetachedBridgeConfig(
    sessionId: string,
    options: RemoteCommandProcessOptions
  ): DetachedRemoteBridgeConfig {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const jobDir = `${this.getDetachedBridgeSessionDir(sessionId)}/${jobId}`;
    const env = Object.fromEntries(
      Object.entries(options.env || {}).filter(([, value]) => value !== undefined)
    ) as Record<string, string>;

    return {
      jobDir,
      socketPath: `${jobDir}/stdin.sock`,
      logPath: `${jobDir}/stdout.log`,
      exitPath: `${jobDir}/exit.json`,
      eofPath: `${jobDir}/stdin.eof`,
      pidPath: `${jobDir}/pid`,
      command: options.command,
      args: options.args,
      cwd: options.cwd || '.',
      env,
    };
  }

  private createDirectCommandProcess(
    sessionId: string,
    config: SSHConfig,
    options: RemoteCommandProcessOptions
  ): SpawnedProcess {
    const passThrough = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    };

    let channel: ClientChannel | null = null;
    let killed = false;
    let exitCode: number | null = null;
    const emitter = new EventEmitter();
    const closeStdinOnEnd = options.closeStdinOnEnd === true;
    let stdinEnded = false;

    const envExports = Object.entries(options.env || {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `export ${key}=${this.quoteForShell(value || '')}`);

    const escapedArgs = options.args.map((arg) => {
      if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('{')) {
        return this.quoteForShell(arg);
      }
      return arg;
    }).join(' ');

    const command = [
      this.getRemoteCommandPathPrefix(config),
      options.cwd ? this.getRemoteWorkdirCdCommand(options.cwd) : '',
      ...envExports,
      `exec ${options.command} ${escapedArgs}`,
    ].filter(Boolean).join(' && ');

    const abortHandler = () => {
      killed = true;
      if (channel) {
        try {
          channel.signal('TERM');
          channel.close();
        } catch (error) {
          console.error('[SSH Service] Error closing direct SSH command on abort:', error);
        }
      }
    };
    options.signal?.addEventListener('abort', abortHandler);

    const pendingData: Buffer[] = [];
    let channelReady = false;

    passThrough.stdin.on('data', (data: Buffer) => {
      if (channelReady && channel) {
        channel.stdin.write(data);
      } else {
        pendingData.push(data);
      }
    });

    passThrough.stdin.on('end', () => {
      stdinEnded = true;
      if (closeStdinOnEnd && channelReady && channel) {
        channel.stdin.end();
      }
    });

    (async () => {
      try {
        const client = await this.getConnection(sessionId, config);
        client.exec(command, { pty: false }, (err, ch) => {
          if (err) {
            emitter.emit('error', err);
            passThrough.stdout.end();
            options.signal?.removeEventListener('abort', abortHandler);
            return;
          }

          channel = ch;
          channelReady = true;
          for (const data of pendingData) {
            ch.stdin.write(data);
          }
          pendingData.length = 0;
          if (stdinEnded && closeStdinOnEnd) {
            ch.stdin.end();
          }

          ch.on('data', (data: Buffer) => {
            passThrough.stdout.write(data);
          });

          ch.stderr.on('data', (data: Buffer) => {
            passThrough.stdout.write(data);
          });

          let exitEmitted = false;

          ch.on('exit', (code: number | null, signal: string | undefined) => {
            if (exitEmitted) return;
            exitEmitted = true;
            exitCode = code;
            emitter.emit('exit', code, signal as NodeJS.Signals | null);
          });

          ch.on('close', () => {
            // close fires after exit (or instead of exit on connection drop).
            // Only emit exit here if the exit event never fired — and use
            // code 1 (not undefined) so the SDK treats it as a real exit.
            if (!exitEmitted) {
              exitEmitted = true;
              exitCode = exitCode ?? 1;
              emitter.emit('exit', exitCode, null);
            }
            passThrough.stdout.end();
            options.signal?.removeEventListener('abort', abortHandler);
          });

          ch.on('error', (error: Error) => {
            emitter.emit('error', error);
          });
        });
      } catch (error) {
        emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
        passThrough.stdout.end();
        options.signal?.removeEventListener('abort', abortHandler);
      }
    })();

    return {
      stdin: passThrough.stdin,
      stdout: passThrough.stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      kill(signal: NodeJS.Signals): boolean {
        if (killed) return false;
        killed = true;
        if (channel) {
          try {
            channel.signal(signal === 'SIGKILL' ? 'KILL' : 'TERM');
            return true;
          } catch {
            try {
              channel.close();
              return true;
            } catch {
              return false;
            }
          }
        }
        return false;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      once(event: string, listener: (...args: any[]) => void) {
        emitter.once(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      off(event: string, listener: (...args: any[]) => void) {
        emitter.off(event, listener);
      },
    } as SpawnedProcess;
  }

  createDetachedCommandProcess(
    sessionId: string,
    config: SSHConfig,
    options: RemoteCommandProcessOptions
  ): SpawnedProcess {
    const passThrough = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    };

    let killed = false;
    let exitCode: number | null = null;
    const emitter = new EventEmitter();
    const bridge = this.createDetachedBridgeConfig(sessionId, options);
    const closeStdinOnEnd = options.closeStdinOnEnd === true;
    const pendingData: Buffer[] = [];
    let stdinBridgeChannel: ClientChannel | null = null;
    let stdinBridgeOpening: Promise<void> | null = null;
    let stdinBridgeReady = false;
    let stdinEnded = false;
    let stdinEofSignaled = false;
    let readerChannel: ClientChannel | null = null;
    let stdoutOffset = 0;
    let finalized = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let exitPoller: ReturnType<typeof setInterval> | null = null;
    let fallbackProcess: SpawnedProcess | null = null;
    let bridgeLaunched = false;

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (exitPoller) {
        clearInterval(exitPoller);
        exitPoller = null;
      }
    };

    const scheduleReaderReconnect = () => {
      if (finalized || killed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attachReader().catch((error) => {
          console.warn('[SSH Service] Failed to reattach remote stdout bridge:', error);
          scheduleReaderReconnect();
        });
      }, 1000);
    };

    const signalRemoteStdinEof = async (): Promise<void> => {
      if (stdinEofSignaled || !closeStdinOnEnd || fallbackProcess) return;
      stdinEofSignaled = true;
      try {
        const client = await this.getConnection(sessionId, config);
        await this.execCommand(client, `touch ${this.quoteForShell(bridge.eofPath)}`);
      } catch (error) {
        stdinEofSignaled = false;
        throw error;
      }
    };

    const writeToStdinBridge = (data: Buffer): boolean => {
      if (!stdinBridgeReady || !stdinBridgeChannel) return false;
      stdinBridgeChannel.write(data);
      return true;
    };

    const endStdinBridge = (): void => {
      if (!stdinBridgeReady || !stdinBridgeChannel) return;
      stdinBridgeChannel.end();
    };

    const openStdinBridge = (): Promise<void> => {
      if (finalized || killed || fallbackProcess || stdinBridgeReady || stdinBridgeChannel) {
        return Promise.resolve();
      }
      if (!bridgeLaunched) {
        return Promise.resolve();
      }
      if (stdinBridgeOpening) {
        return stdinBridgeOpening;
      }

      stdinBridgeOpening = (async () => {
        const install = await this.ensureDetachedRemoteBridge(sessionId, config);
        const client = await this.getConnection(sessionId, config);
        const command = `${this.getRemoteCommandPathPrefix(config)} && ${install.nodeCommand} ${this.quoteForShell(install.bridgePath)} stdin ${this.quoteForShell(bridge.socketPath)}`;

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let readyBuffer = '';

          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            stdinBridgeReady = false;
            stdinBridgeChannel = null;
            reject(error);
          };

          const markReady = (channel: ClientChannel) => {
            if (settled) return;
            settled = true;
            stdinBridgeChannel = channel;
            stdinBridgeReady = true;

            const queuedBytes = pendingData.reduce((total, chunk) => total + chunk.length, 0);
            console.log(`[SSH Service] Remote stdin bridge ready for ${sessionId}; flushing ${queuedBytes} queued bytes`);

            for (const chunk of pendingData) {
              channel.write(chunk);
            }
            pendingData.length = 0;

            if (stdinEnded && closeStdinOnEnd) {
              channel.end();
              signalRemoteStdinEof().catch((error) => {
                console.warn('[SSH Service] Failed to signal remote stdin EOF:', error);
              });
            }

            resolve();
          };

          client.exec(command, (err, channel) => {
            if (err) {
              fail(err);
              return;
            }

            stdinBridgeChannel = channel;

            channel.on('data', (data: Buffer) => {
              if (settled) return;
              readyBuffer += data.toString('utf8');
              if (readyBuffer.includes('[stdin-ready]')) {
                markReady(channel);
              }
            });
            channel.on('close', () => {
              const wasReady = stdinBridgeReady;
              stdinBridgeReady = false;
              stdinBridgeChannel = null;
              if (!settled && !wasReady) {
                fail(new Error('Remote stdin bridge closed before it was ready'));
              }
            });
            channel.on('error', (error: Error) => {
              stdinBridgeReady = false;
              stdinBridgeChannel = null;
              if (!settled) {
                fail(error);
              }
            });
            channel.stderr.on('data', (data: Buffer) => {
              const message = data.toString('utf8').trim();
              if (message) {
                console.warn('[SSH Service] Remote stdin bridge stderr:', message);
                if (!settled) {
                  fail(new Error(message));
                }
              }
            });
          });
        });
      })().finally(() => {
        stdinBridgeOpening = null;
      });

      return stdinBridgeOpening;
    };

    const fetchRemainingOutput = async (): Promise<void> => {
      const client = await this.getConnection(sessionId, config);
      const remaining = await this.execCommand(
        client,
        `tail -c +${stdoutOffset + 1} ${this.quoteForShell(bridge.logPath)} 2>/dev/null || true`
      );
      if (remaining) {
        stdoutOffset += Buffer.byteLength(remaining);
        passThrough.stdout.write(Buffer.from(remaining));
      }
    };

    const finalize = async (code: number | null, signal: NodeJS.Signals | null, flushRemaining: boolean): Promise<void> => {
      if (finalized) return;
      finalized = true;
      clearTimers();

      if (readerChannel) {
        try {
          readerChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
        readerChannel = null;
      }
      if (stdinBridgeChannel) {
        try {
          stdinBridgeChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
        stdinBridgeChannel = null;
        stdinBridgeReady = false;
      }

      if (flushRemaining) {
        try {
          await fetchRemainingOutput();
        } catch (error) {
          console.warn('[SSH Service] Failed to fetch trailing remote bridge output:', error);
        }
      }

      exitCode = code;
      emitter.emit('exit', code, signal);
      passThrough.stdout.end();
      options.signal?.removeEventListener('abort', abortHandler);
      if (flushRemaining && !killed) {
        void this.markDetachedBridgeJobRecovered(sessionId, config, bridge.jobDir);
      }
    };

    const attachReader = async (): Promise<void> => {
      if (finalized || killed || readerChannel) return;
      const client = await this.getConnection(sessionId, config);
      const command = `touch ${this.quoteForShell(bridge.logPath)} && tail -c +${stdoutOffset + 1} -F ${this.quoteForShell(bridge.logPath)}`;

      await new Promise<void>((resolve, reject) => {
        client.exec(command, (err, channel) => {
          if (err) {
            reject(err);
            return;
          }

          readerChannel = channel;
          channel.on('data', (data: Buffer) => {
            stdoutOffset += data.length;
            passThrough.stdout.write(data);
          });
          channel.stderr.on('data', () => {
            // tail -F can emit transient reopen messages; ignore them.
          });
          channel.on('close', () => {
            readerChannel = null;
            if (!finalized && !killed) {
              scheduleReaderReconnect();
            }
          });
          channel.on('error', (error: Error) => {
            console.warn('[SSH Service] Detached stdout bridge error:', error.message);
          });

          resolve();
        });
      });
    };

    const pollForExit = async (): Promise<void> => {
      if (finalized || killed) return;
      try {
        const client = await this.getConnection(sessionId, config);
        const output = await this.execCommand(
          client,
          `test -f ${this.quoteForShell(bridge.exitPath)} && cat ${this.quoteForShell(bridge.exitPath)} || echo ""`
        );
        if (!output.trim()) {
          return;
        }

        let parsed: { code?: number | null; signal?: string | null } = {};
        try {
          parsed = JSON.parse(output.trim());
        } catch {
          parsed = {};
        }

        await finalize(
          typeof parsed.code === 'number' ? parsed.code : null,
          (parsed.signal as NodeJS.Signals | null) || null,
          true
        );
      } catch (error) {
        console.warn('[SSH Service] Detached bridge exit poll failed:', error);
      }
    };

    const abortHandler = () => {
      killed = true;
      if (fallbackProcess) {
        fallbackProcess.kill('SIGTERM');
        return;
      }
      if (readerChannel) {
        try {
          readerChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
      }
      if (stdinBridgeChannel) {
        try {
          stdinBridgeChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
      }
      void this.killDetachedProcess(sessionId, config, bridge).finally(() => {
        void finalize(exitCode, 'SIGTERM', false);
      });
    };

    options.signal?.addEventListener('abort', abortHandler);

    passThrough.stdin.on('data', (data: Buffer) => {
      if (writeToStdinBridge(data)) {
        return;
      }

      pendingData.push(data);
      if (bridgeLaunched) {
        void openStdinBridge().catch((error) => {
          console.warn('[SSH Service] Failed to attach remote stdin bridge:', error);
        });
      }
    });

    passThrough.stdin.on('end', () => {
      stdinEnded = true;
      if (closeStdinOnEnd && stdinBridgeReady && stdinBridgeChannel) {
        endStdinBridge();
        void signalRemoteStdinEof().catch((error) => {
          console.warn('[SSH Service] Failed to signal remote stdin EOF:', error);
        });
      }
    });

    void (async () => {
      try {
        await this.launchDetachedRemoteBridge(sessionId, config, bridge);
        bridgeLaunched = true;
        await attachReader();
        await openStdinBridge();
        exitPoller = setInterval(() => {
          void pollForExit();
        }, 1000);
      } catch (error) {
        if (bridgeLaunched) {
          console.warn('[SSH Service] Detached bridge launched but initial attach failed; retrying:', error);
          scheduleReaderReconnect();
          void openStdinBridge().catch((attachError) => {
            console.warn('[SSH Service] Failed to reattach remote stdin bridge:', attachError);
          });
          exitPoller = setInterval(() => {
            void pollForExit();
          }, 1000);
          return;
        }

        if (error instanceof Error && error.message.includes('Remote workdir not found')) {
          console.warn('[SSH Service] Detached bridge refused missing remote workdir:', error.message);
          passThrough.stdout.write(Buffer.from(`${error.message}\n`));
          await finalize(66, null, false);
          return;
        }

        console.warn('[SSH Service] Detached bridge unavailable, falling back to direct SSH exec:', error);
        const direct = this.createDirectCommandProcess(sessionId, config, options);
        fallbackProcess = direct;

        passThrough.stdin.removeAllListeners('data');
        passThrough.stdin.removeAllListeners('end');
        passThrough.stdin.on('data', (data: Buffer) => {
          direct.stdin.write(data);
        });
        passThrough.stdin.on('end', () => {
          if (closeStdinOnEnd) {
            direct.stdin.end();
          }
        });
        direct.stdout.on('data', (data: Buffer) => {
          passThrough.stdout.write(data);
        });
        direct.on('exit', (code, signal) => {
          exitCode = code;
          emitter.emit('exit', code, signal);
          passThrough.stdout.end();
        });
        direct.on('error', (err) => {
          emitter.emit('error', err);
          passThrough.stdout.end();
        });

        if (pendingData.length > 0) {
          for (const chunk of pendingData) {
            direct.stdin.write(chunk);
          }
          pendingData.length = 0;
        }
        if (stdinEnded && closeStdinOnEnd) {
          direct.stdin.end();
        }
      }
    })();

    return {
      stdin: passThrough.stdin,
      stdout: passThrough.stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      kill: (signal: NodeJS.Signals) => {
        if (killed) return false;
        killed = true;
        if (fallbackProcess) {
          return fallbackProcess.kill(signal);
        }
        void this.killDetachedProcess(sessionId, config, bridge).finally(() => {
          void finalize(exitCode, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM', false);
        });
        return true;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      once(event: string, listener: (...args: any[]) => void) {
        emitter.once(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      off(event: string, listener: (...args: any[]) => void) {
        emitter.off(event, listener);
      },
    } as SpawnedProcess;
  }

  private createDetachedBridgeConfigFromJob(job: DetachedRemoteBridgeJob): DetachedRemoteBridgeConfig {
    return {
      jobDir: job.jobDir,
      socketPath: job.socketPath,
      logPath: job.logPath,
      exitPath: job.exitPath,
      eofPath: job.eofPath,
      pidPath: job.pidPath,
      command: 'claude',
      args: [],
      cwd: '.',
      env: {},
    };
  }

  async attachLatestDetachedCommandProcess(
    sessionId: string,
    config: SSHConfig,
    signal?: AbortSignal
  ): Promise<AttachedDetachedRemoteProcess | null> {
    const job = await this.getLatestRecoverableRemoteProcess(sessionId, config);
    if (!job) {
      return null;
    }

    const process = this.attachDetachedCommandProcess(sessionId, config, job, signal);
    return { process, job };
  }

  private attachDetachedCommandProcess(
    sessionId: string,
    config: SSHConfig,
    job: DetachedRemoteBridgeJob,
    signal?: AbortSignal
  ): SpawnedProcess {
    const passThrough = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    };

    const bridge = this.createDetachedBridgeConfigFromJob(job);
    const emitter = new EventEmitter();
    let killed = false;
    let exitCode: number | null = null;
    let readerChannel: ClientChannel | null = null;
    let stdoutOffset = 0;
    let finalized = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let exitPoller: ReturnType<typeof setInterval> | null = null;

    passThrough.stdin.on('data', () => {
      // Attach-only recovery never sends a new user prompt. Input is ignored
      // unless the user explicitly cancels, which goes through kill().
    });

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (exitPoller) {
        clearInterval(exitPoller);
        exitPoller = null;
      }
    };

    const scheduleReaderReconnect = () => {
      if (finalized || killed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attachReader().catch((error) => {
          console.warn('[SSH Service] Failed to reattach recovered remote stdout bridge:', error);
          scheduleReaderReconnect();
        });
      }, 1000);
    };

    const fetchRemainingOutput = async (): Promise<void> => {
      const client = await this.getConnection(sessionId, config);
      const remaining = await this.execCommand(
        client,
        `tail -c +${stdoutOffset + 1} ${this.quoteForShell(bridge.logPath)} 2>/dev/null || true`
      );
      if (remaining) {
        stdoutOffset += Buffer.byteLength(remaining);
        passThrough.stdout.write(Buffer.from(remaining));
      }
    };

    const finalize = async (code: number | null, signalName: NodeJS.Signals | null, flushRemaining: boolean): Promise<void> => {
      if (finalized) return;
      finalized = true;
      clearTimers();

      if (readerChannel) {
        try {
          readerChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
        readerChannel = null;
      }

      if (flushRemaining) {
        try {
          await fetchRemainingOutput();
        } catch (error) {
          console.warn('[SSH Service] Failed to fetch trailing recovered bridge output:', error);
        }
      }

      exitCode = code;
      emitter.emit('exit', code, signalName);
      passThrough.stdout.end();
      signal?.removeEventListener('abort', abortHandler);
    };

    const attachReader = async (): Promise<void> => {
      if (finalized || killed || readerChannel) return;
      const client = await this.getConnection(sessionId, config);
      const command = `touch ${this.quoteForShell(bridge.logPath)} && tail -c +${stdoutOffset + 1} -F ${this.quoteForShell(bridge.logPath)}`;

      await new Promise<void>((resolve, reject) => {
        client.exec(command, (err, channel) => {
          if (err) {
            reject(err);
            return;
          }

          readerChannel = channel;
          channel.on('data', (data: Buffer) => {
            stdoutOffset += data.length;
            passThrough.stdout.write(data);
          });
          channel.stderr.on('data', () => {
            // tail -F can emit transient reopen messages; ignore them.
          });
          channel.on('close', () => {
            readerChannel = null;
            if (!finalized && !killed) {
              scheduleReaderReconnect();
            }
          });
          channel.on('error', (error: Error) => {
            console.warn('[SSH Service] Recovered stdout bridge error:', error.message);
          });

          resolve();
        });
      });
    };

    const pollForExit = async (): Promise<void> => {
      if (finalized || killed) return;
      try {
        const client = await this.getConnection(sessionId, config);
        const output = await this.execCommand(
          client,
          `if test -f ${this.quoteForShell(bridge.exitPath)}; then ` +
          `echo __EXIT__; cat ${this.quoteForShell(bridge.exitPath)}; ` +
          `elif test -f ${this.quoteForShell(bridge.logPath)} && grep -q '"type":"result"' ${this.quoteForShell(bridge.logPath)} 2>/dev/null; then ` +
          'echo __RESULT__; ' +
          `else pid="$(cat ${this.quoteForShell(bridge.pidPath)} 2>/dev/null || true)"; ` +
          'if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then echo __RUNNING__; else echo __GONE__; fi; fi'
        );
        const trimmed = output.trim();
        if (!trimmed || trimmed === '__RUNNING__') {
          return;
        }

        if (trimmed.startsWith('__EXIT__')) {
          const rawJson = trimmed.replace(/^__EXIT__\s*/, '');
          let parsed: { code?: number | null; signal?: string | null } = {};
          try {
            parsed = JSON.parse(rawJson);
          } catch {
            parsed = {};
          }
          await finalize(
            typeof parsed.code === 'number' ? parsed.code : null,
            (parsed.signal as NodeJS.Signals | null) || null,
            true
          );
          return;
        }

        if (trimmed === '__RESULT__') {
          await finalize(0, null, true);
          return;
        }

        if (trimmed === '__GONE__') {
          await finalize(1, null, true);
        }
      } catch (error) {
        console.warn('[SSH Service] Recovered bridge exit poll failed:', error);
      }
    };

    const abortHandler = () => {
      killed = true;
      if (readerChannel) {
        try {
          readerChannel.close();
        } catch {
          // Best-effort bridge teardown.
        }
      }
      void this.killDetachedProcess(sessionId, config, bridge).finally(() => {
        void finalize(exitCode, 'SIGTERM', false);
      });
    };

    signal?.addEventListener('abort', abortHandler);

    void (async () => {
      try {
        if (job.completed && !job.active) {
          await finalize(0, null, true);
          return;
        }

        await attachReader();
        exitPoller = setInterval(() => {
          void pollForExit();
        }, 1000);
        void pollForExit();
      } catch (error) {
        console.warn('[SSH Service] Initial recovered bridge attach failed; retrying:', error);
        scheduleReaderReconnect();
        exitPoller = setInterval(() => {
          void pollForExit();
        }, 1000);
      }
    })();

    return {
      stdin: passThrough.stdin,
      stdout: passThrough.stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      kill: (signalName: NodeJS.Signals) => {
        if (killed) return false;
        killed = true;
        void this.killDetachedProcess(sessionId, config, bridge).finally(() => {
          void finalize(exitCode, signalName === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM', false);
        });
        return true;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      once(event: string, listener: (...args: any[]) => void) {
        emitter.once(event, listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      off(event: string, listener: (...args: any[]) => void) {
        emitter.off(event, listener);
      },
    } as SpawnedProcess;
  }

  private async launchDetachedRemoteBridge(
    sessionId: string,
    config: SSHConfig,
    bridge: DetachedRemoteBridgeConfig
  ): Promise<void> {
    await this.assertRemoteWorkdirExists(sessionId, config, bridge.cwd);
    const install = await this.ensureDetachedRemoteBridge(sessionId, config);
    const client = await this.getConnection(sessionId, config);

    await this.execCommand(client, `mkdir -p ${this.quoteForShell(bridge.jobDir)}`);
    await this.execCommand(
      client,
      `find ${this.quoteForShell(this.getDetachedBridgeSessionDir(sessionId))} -mindepth 1 -maxdepth 1 -type d -mmin +360 -exec rm -rf {} + 2>/dev/null || true`
    );
    await this.writeRemoteFile(sessionId, config, `${bridge.jobDir}/config.json`, JSON.stringify(bridge, null, 2));
    await this.writeRemoteFile(sessionId, config, `${bridge.jobDir}/metadata.json`, JSON.stringify({
      sessionId,
      safeSessionId: this.getSafeSessionId(sessionId),
      createdAt: new Date().toISOString(),
      command: bridge.command,
      args: bridge.args,
      cwd: bridge.cwd,
    }, null, 2));

    const startCommand = `${this.getRemoteCommandPathPrefix(config)} && (nohup ${install.nodeCommand} ${this.quoteForShell(install.bridgePath)} spawn ${this.quoteForShell(`${bridge.jobDir}/config.json`)} >/dev/null 2>&1 </dev/null & echo __claudette_bridge_started__)`;
    await new Promise<void>((resolve, reject) => {
      client.exec(startCommand, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }

        let settled = false;
        let stderr = '';
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            channel.close();
          } catch {
            // The background bridge is detached; channel close is best-effort.
          }
          resolve();
        }, 3000);

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            channel.close();
          } catch {
            // The background bridge is detached; channel close is best-effort.
          }
          resolve();
        };

        channel.on('data', (data: Buffer) => {
          if (data.toString('utf8').includes('__claudette_bridge_started__')) {
            finish();
          }
        });
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        channel.on('close', (code: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (code !== 0 && stderr.trim()) {
            reject(new Error(stderr.trim()));
          } else {
            resolve();
          }
        });
      });
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await this.execCommand(
        client,
        `test -S ${this.quoteForShell(bridge.socketPath)} && test -f ${this.quoteForShell(bridge.logPath)} && echo ready || echo waiting`
      );
      if (ready.trim() === 'ready') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error('Timed out waiting for detached remote process bridge');
  }

  private async killDetachedProcess(
    sessionId: string,
    config: SSHConfig,
    bridge: DetachedRemoteBridgeConfig
  ): Promise<void> {
    const client = await this.getConnection(sessionId, config);
    await this.execCommand(
      client,
      `if test -f ${this.quoteForShell(bridge.pidPath)}; then kill $(cat ${this.quoteForShell(bridge.pidPath)}) 2>/dev/null || true; fi`
    );
  }

  /**
   * Create a remote process that satisfies SpawnedProcess interface
   * Used by Claude Agent SDK's spawnClaudeCodeProcess hook
   */
  createRemoteProcess(
    sessionId: string,
    config: SSHConfig,
    sdkOptions: SDKSpawnOptions
  ): SpawnedProcess {
    // Build environment exports - only include essential variables for Claude.
    // We explicitly whitelist rather than blacklist to avoid sending unrelated local machine paths/configs.
    // If the app has an Anthropic API key configured, pass it through so the next remote turn uses it
    // immediately instead of relying on whatever OAuth/auth state exists on the remote host.
    const includeVars = [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CODE_ENTRYPOINT',
      'ENABLE_TOOL_SEARCH',
      'TERM',
      'LANG',
    ];
    const filteredEnv = Object.fromEntries(Object.entries(sdkOptions.env)
      .filter(([key, value]) => value !== undefined && includeVars.includes(key))
    ) as Record<string, string | undefined>;
    filteredEnv.CLAUDETTE_SESSION_ID = this.getSafeSessionId(sessionId);

    // Build the command using the SDK's args
    // The SDK passes args like: ["/path/to/cli.js", "--output-format", "stream-json", "--verbose", ...]
    // The first arg may be the local path to the CLI file - we need to filter it out
    // because we'll use the globally installed 'claude' command on the remote machine
    const filteredArgs = sdkOptions.args.filter(arg => {
      // Filter out local paths to the CLI file
      if (arg.includes('claude-agent-sdk') || arg.includes('cli.js') || arg.includes('node_modules')) {
        console.log('[SSH Service] Filtering out local CLI path from args:', arg);
        return false;
      }
      return true;
    });

    console.log('[SSH Service] Config:', JSON.stringify(config, null, 2));
    console.log('[SSH Service] SDK args (original):', sdkOptions.args);
    console.log('[SSH Service] SDK args (filtered):', filteredArgs);

    // Use the detached bridge instead of direct SSH exec. The bridge keeps the
    // remote Claude process alive across SSH transport drops, streams stdout
    // from an append-only log, and avoids the old tmux/FIFO deadlocks.
    return this.createDetachedCommandProcess(sessionId, config, {
      command: 'claude',
      args: filteredArgs,
      cwd: config.remoteWorkdir,
      env: filteredEnv,
      signal: sdkOptions.signal,
      closeStdinOnEnd: true,
    });
  }

  /**
   * Create an interactive shell for terminal use
   */
  async createShell(
    sessionId: string,
    config: SSHConfig
  ): Promise<ClientChannel> {
    const client = await this.getConnection(sessionId, config);

    return new Promise((resolve, reject) => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: 80,
          rows: 24,
        },
        (err, channel) => {
          if (err) {
            reject(err);
            return;
          }

          // Change to remote workdir
          channel.write(`cd "${config.remoteWorkdir}" && clear\n`);
          resolve(channel);
        }
      );
    });
  }

  /**
   * Resize a shell channel
   */
  resizeShell(channel: ClientChannel, cols: number, rows: number): void {
    try {
      channel.setWindow(rows, cols, 0, 0);
    } catch (error) {
      console.error('[SSH Service] Failed to resize shell:', error);
    }
  }

  /**
   * Disconnect a session's SSH connection
   */
  disconnect(sessionId: string): void {
    this.closeSshConnection(sessionId);

    // Clean up MCP stdio bridges for this session
    import('./mcp-stdio-bridge.service').then(({ mcpStdioBridgeService }) => {
      mcpStdioBridgeService.stopBridgesForSession(sessionId).catch((err) => {
        console.warn('[SSH Service] Error stopping MCP bridges for session:', err);
      });
    }).catch(() => {
      // Module not available, ignore
    });
  }

  /**
   * Start a health check heartbeat for an SSH connection.
   * Sends `echo ok` every 30 seconds.
   *
   * Important: this check must be non-disruptive. We already rely on ssh2's
   * keepalive (`keepaliveInterval` / `keepaliveCountMax`) and close/error events
   * for authoritative connection state. If this exec-based heartbeat times out
   * under load, force-disconnecting creates reconnect loops.
   */
  // Track which sessions are actively being used (streaming, sending messages).
  // Only these get health checks — idle connections are cleaned up on next use.
  private activeSessionIds = new Set<string>();
  private hasRunStartupCleanup = false;

  markSessionActive(sessionId: string): void {
    this.activeSessionIds.add(sessionId);
  }

  markSessionInactive(sessionId: string): void {
    this.activeSessionIds.delete(sessionId);
    this.stopHealthCheck(sessionId);
  }

  private startHealthCheck(sessionId: string): void {
    // Only health-check sessions that are actively being used.
    // With 128+ SSH sessions, health-checking all of them saturates the
    // SSH connection to the remote host and causes beachballs/crashes.
    if (!this.activeSessionIds.has(sessionId)) {
      return;
    }
    this.stopHealthCheck(sessionId); // Clear any existing interval
    this.healthCheckFailures.delete(sessionId);

    const interval = setInterval(async () => {
      const conn = this.connections.get(sessionId);
      if (!conn) {
        this.stopHealthCheck(sessionId);
        return;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Health check timeout')), 10000);
          conn.client.exec('echo ok', (err, channel) => {
            if (err) {
              clearTimeout(timeout);
              reject(err);
              return;
            }
            // Must consume stdout or the stream stays paused and 'close' never fires
            channel.on('data', () => { /* drain */ });
            channel.stderr.on('data', () => { /* drain */ });
            channel.on('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            channel.on('error', (e: Error) => {
              clearTimeout(timeout);
              reject(e);
            });
          });
        });

        this.healthCheckFailures.delete(sessionId);
      } catch (error) {
        const failures = (this.healthCheckFailures.get(sessionId) || 0) + 1;
        this.healthCheckFailures.set(sessionId, failures);
        console.warn(
          `[SSH Service] Health check failed for session ${sessionId} (${failures}/${this.MAX_HEALTH_CHECK_FAILURES}):`,
          error
        );

        // Keep the connection alive; let ssh2 keepalive + real close/error events
        // drive reconnection. Stop noisy heartbeats after repeated failures.
        if (failures >= this.MAX_HEALTH_CHECK_FAILURES) {
          console.warn(
            `[SSH Service] Disabling heartbeat checks for ${sessionId} after repeated failures (connection remains active)`
          );
          this.stopHealthCheck(sessionId);
        }
      }
    }, 30000);

    this.healthCheckIntervals.set(sessionId, interval);
  }

  /**
   * Stop the health check heartbeat for a session
   */
  private stopHealthCheck(sessionId: string): void {
    const interval = this.healthCheckIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(sessionId);
    }
    this.healthCheckFailures.delete(sessionId);
  }

  /**
   * Check if a session has an active SSH connection
   */
  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  /**
   * Disconnect all sessions
   */
  disconnectAll(): void {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }
  }

  /**
   * Get GitHub token from gh CLI (handles keychain storage)
   */
  private async getGitHubToken(): Promise<string | null> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      // gh auth token extracts the token regardless of storage method
      const { stdout } = await execAsync('gh auth token');
      return stdout.trim();
    } catch (error) {
      console.log('[SSH Service] Could not get GitHub token:', error);
      return null;
    }
  }

  /**
   * Get GitHub username from gh CLI
   */
  private async getGitHubUser(): Promise<string | null> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync('gh api user --jq .login');
      return stdout.trim();
    } catch (error) {
      console.log('[SSH Service] Could not get GitHub user:', error);
      return null;
    }
  }

  /**
   * Sync local Claude settings to remote machine via SFTP
   * Syncs: ~/.claude/agents/, ~/.claude/commands/, ~/.claude/CLAUDE.md, ~/.claude/settings.json
   * Also syncs GitHub credentials for git/gh operations
   */
  async syncSettings(sessionId: string, config: SSHConfig): Promise<{ success: boolean; error?: string }> {
    const os = await import('os');
    const path = await import('path');
    const fsPromises = await import('fs/promises');

    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');

    // Check if local .claude directory exists. MCP config/auth sync still runs
    // even if the user has not created local Claude settings yet.
    let hasClaudeDir = true;
    try {
      await fsPromises.access(claudeDir);
    } catch {
      console.log('[SSH Service] No local ~/.claude directory, skipping Claude file sync');
      hasClaudeDir = false;
    }

    let sftp: import('ssh2').SFTPWrapper | null = null;

    try {
      const client = await this.getConnection(sessionId, config);

      // Create SFTP session
      sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftpSession) => {
          if (err) reject(err);
          else resolve(sftpSession);
        });
      });

      // Ensure remote directories exist
      console.log('[SSH Service] Creating remote directories...');
      await this.execCommand(client, 'mkdir -p ~/.claude/agents ~/.claude/commands ~/.config/gh');

      // Get GitHub token and create hosts.yml for remote
      const ghToken = await this.getGitHubToken();
      const ghUser = await this.getGitHubUser();
      let tempGhHostsPath: string | null = null;

      if (ghToken && ghUser) {
        console.log('[SSH Service] Creating GitHub hosts.yml for remote...');
        // Create a hosts.yml with the token embedded (for Linux remote without keychain)
        const hostsYml = `github.com:
    git_protocol: https
    user: ${ghUser}
    oauth_token: ${ghToken}
`;
        // Write to temp file
        const tmpDir = os.tmpdir();
        tempGhHostsPath = path.join(tmpDir, `gh-hosts-${sessionId}.yml`);
        await fsPromises.writeFile(tempGhHostsPath, hostsYml, { mode: 0o600 });
      }

      // Files/directories to sync
      const itemsToSync: Array<{ local: string; remote: string; isDir: boolean }> = [
        { local: path.join(claudeDir, 'agents'), remote: '.claude/agents', isDir: true },
        { local: path.join(claudeDir, 'commands'), remote: '.claude/commands', isDir: true },
        { local: path.join(claudeDir, 'CLAUDE.md'), remote: '.claude/CLAUDE.md', isDir: false },
        { local: path.join(claudeDir, 'settings.json'), remote: '.claude/settings.json', isDir: false },
        // Git config for identity
        { local: path.join(homeDir, '.gitconfig'), remote: '.gitconfig', isDir: false },
      ];

      // Add GitHub hosts.yml - use temp file with embedded token if available, otherwise original
      if (tempGhHostsPath) {
        itemsToSync.push({ local: tempGhHostsPath, remote: '.config/gh/hosts.yml', isDir: false });
      } else {
        itemsToSync.push({ local: path.join(homeDir, '.config', 'gh', 'hosts.yml'), remote: '.config/gh/hosts.yml', isDir: false });
      }
      // Always sync gh config.yml
      itemsToSync.push({ local: path.join(homeDir, '.config', 'gh', 'config.yml'), remote: '.config/gh/config.yml', isDir: false });

      // Helper to upload a file via SFTP
      const uploadFile = (localPath: string, remotePath: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp!.fastPut(localPath, remotePath, (err) => {
            if (err) {
              console.error(`[SSH Service] Failed to upload ${localPath}:`, err.message);
              reject(err);
            } else {
              resolve();
            }
          });
        });
      };

      // Helper to recursively upload a directory
      const uploadDir = async (localDir: string, remoteDir: string): Promise<void> => {
        // Ensure remote dir exists
        await new Promise<void>((resolve) => {
          sftp!.mkdir(remoteDir, () => resolve()); // Ignore error if exists
        });

        let entries;
        try {
          entries = await fsPromises.readdir(localDir, { withFileTypes: true });
        } catch (e) {
          console.log(`[SSH Service] Cannot read directory ${localDir}, skipping`);
          return;
        }

        for (const entry of entries) {
          const localPath = path.join(localDir, entry.name);
          const remotePath = `${remoteDir}/${entry.name}`;

          try {
            if (entry.isDirectory()) {
              await uploadDir(localPath, remotePath);
            } else if (entry.isFile()) {
              console.log(`[SSH Service] Uploading ${localPath} -> ${remotePath}`);
              await uploadFile(localPath, remotePath);
            }
          } catch (e) {
            console.error(`[SSH Service] Failed to sync ${localPath}:`, e);
            // Continue with other files
          }
        }
      };

      // Get remote home directory
      const homeResult = await this.execCommand(client, 'echo $HOME');
      const remoteHome = homeResult.trim();

      if (hasClaudeDir) {
        // Sync each item
        for (const item of itemsToSync) {
          try {
            const stat = await fsPromises.stat(item.local);
            const remotePath = `${remoteHome}/${item.remote}`;

            if (item.isDir && stat.isDirectory()) {
              console.log(`[SSH Service] Syncing directory ${item.local} -> ${remotePath}`);
              await uploadDir(item.local, remotePath);
            } else if (!item.isDir && stat.isFile()) {
              console.log(`[SSH Service] Syncing file ${item.local} -> ${remotePath}`);
              await uploadFile(item.local, remotePath);
            }
          } catch (e) {
            // File/dir doesn't exist locally, skip
            console.log(`[SSH Service] Skipping ${item.local} (does not exist or error)`);
          }
        }
      }

      // Configure git to use gh as credential helper on remote
      if (ghToken) {
        console.log('[SSH Service] Configuring git credential helper on remote...');
        try {
          await this.execCommand(client, 'git config --global credential.helper "!gh auth git-credential"');
        } catch (e) {
          console.log('[SSH Service] Could not configure git credential helper (gh may not be installed on remote)');
        }
      }

      // Start stdio-to-HTTP bridges for native MCP servers before syncing configs
      let bridgePorts: Map<string, number> | undefined;
      try {
        const { mcpStdioBridgeService } = await import('./mcp-stdio-bridge.service');
        const { mcpService: mcpSvc } = await import('./mcp.service');
        const nativeStdio = mcpSvc.getNativeStdioServers();
        if (Object.keys(nativeStdio).length > 0) {
          bridgePorts = await mcpStdioBridgeService.startBridgesForSession(sessionId, nativeStdio);
          console.log('[SSH Service] MCP bridges started:', [...(bridgePorts || [])].map(([id, p]) => `${id}:${p}`).join(', '));
        }
      } catch (err) {
        console.warn('[SSH Service] Could not start MCP stdio bridges:', err);
      }

      await this.syncBuildMcpServersInternal(client, false, bridgePorts);
      await this.syncMcpAuthInternal(client);
      await this.syncHarnessMcpConfigsInternal(client, false, bridgePorts);
      await this.setupMcpReverseTunnelsForSession(sessionId, config);

      // Clean up temp file
      if (tempGhHostsPath) {
        try {
          await fsPromises.unlink(tempGhHostsPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      console.log('[SSH Service] Settings sync completed successfully');
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[SSH Service] Settings sync failed:', errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      // Always close SFTP session
      if (sftp) {
        try {
          sftp.end();
        } catch (e) {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Run a worktree setup script on the remote machine
   */
  async runWorktreeScript(
    sessionId: string,
    config: SSHConfig,
    script: string,
    onOutput?: (data: string) => void
  ): Promise<{ success: boolean; error?: string; output: string; workingDirectory?: string }> {
    try {
      const client = await this.getConnection(sessionId, config);

      return new Promise((resolve) => {
        // Run the script from HOME directory - the script is responsible for setting up the workdir
        // (e.g., creating a git worktree, cloning a repo, etc.)
        // We capture the LAST LINE of the script's stdout as the working directory
        // Convention: worktree scripts should output the target directory path as their last line
        // Source shell config files to get PATH set up properly for non-interactive SSH
        // Try multiple files since different systems use different configs
        const sourceCmd = `source ~/.bash_profile 2>/dev/null; source ~/.profile 2>/dev/null; source ~/.bashrc 2>/dev/null; true`;
        // Run script, then echo marker to separate script output from working directory
        // The working directory is captured BEFORE the marker by looking at the last line of script output
        const command = `${sourceCmd}; cd ~ && ${script} && echo "___WORKDIR_END___"`;
        console.log('[SSH Service] Running worktree script:', command);

        client.exec(command, (err, channel) => {
          if (err) {
            resolve({ success: false, error: err.message, output: '' });
            return;
          }

          let stdout = '';
          let stderr = '';

          channel.on('data', (data: Buffer) => {
            const str = data.toString();
            stdout += str;
            if (onOutput) onOutput(str);
          });

          channel.stderr.on('data', (data: Buffer) => {
            const str = data.toString();
            stderr += str;
            if (onOutput) onOutput(str);
          });

          channel.on('close', (code: number) => {
            const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
            if (code !== 0) {
              // Include stderr in error message for better debugging
              const errorDetail = stderr.trim() || stdout.trim() || 'No output';
              resolve({
                success: false,
                error: `Script exited with code ${code}: ${errorDetail}`,
                output,
              });
            } else {
              // Extract the working directory from the output (last non-empty line BEFORE the marker)
              // Convention: worktree scripts output the target directory path as their last line
              let workingDirectory: string | undefined;
              const markerIndex = stdout.indexOf('___WORKDIR_END___');
              if (markerIndex !== -1) {
                // Get everything before the marker
                const beforeMarker = stdout.substring(0, markerIndex).trim();
                // Split into lines, filter out empty lines and ANSI color codes
                const lines = beforeMarker.split('\n')
                  .map(l => l.replace(ANSI_COLOR_CODE_RE, '').trim()) // Strip ANSI codes
                  .filter(l => l.length > 0);
                if (lines.length > 0) {
                  // Get the last line - should be the working directory path
                  workingDirectory = lines[lines.length - 1];
                  console.log('[SSH Service] Captured working directory from script:', workingDirectory);
                }
              }
              console.log('[SSH Service] Worktree script completed successfully');
              resolve({ success: true, output, workingDirectory });
            }
          });
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg, output: '' };
    }
  }

  /**
   * Run pre-session setup: worktree script (if provided) and settings sync (if enabled)
   * Returns the working directory if the worktree script outputs one (via pwd at end)
   */
  async runPreSessionSetup(
    sessionId: string,
    config: SSHConfig,
    onProgress?: (message: string) => void
  ): Promise<{ success: boolean; error?: string; workingDirectory?: string; setupOutput?: string }> {
    try {
      let workingDirectory: string | undefined;
      let setupOutput: string | undefined;

      // 1. Run worktree script if provided
      if (config.worktreeScript) {
        onProgress?.('Running worktree setup script...');
        const result = await this.runWorktreeScript(
          sessionId,
          config,
          config.worktreeScript,
          (output) => onProgress?.(output)
        );
        if (!result.success) {
          return { success: false, error: `Worktree script failed: ${result.error}` };
        }
        // Capture the working directory and output from the script
        workingDirectory = result.workingDirectory;
        setupOutput = result.output;
      }

      // 2. Sync settings if enabled
      if (config.syncSettings !== false) { // Default to true
        onProgress?.('Syncing Claude settings to remote...');
        const syncResult = await this.syncSettings(sessionId, config);
        if (!syncResult.success) {
          // Don't fail the whole setup if sync fails, just log warning
          console.warn('[SSH Service] Settings sync failed, continuing anyway:', syncResult.error);
          onProgress?.(`Warning: Settings sync failed: ${syncResult.error}`);
        } else {
          onProgress?.('Settings synced successfully');
        }
      }

      return { success: true, workingDirectory, setupOutput };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Fetch a transcript file from the remote machine
   * Returns the content of the transcript file or null if not found
   */
  async fetchRemoteTranscript(
    sessionId: string,
    config: SSHConfig,
    sdkSessionId: string,
    remoteWorkdir: string,
    options?: { full?: boolean }
  ): Promise<string | null> {
    const cacheKey = `${config.host}:${sdkSessionId}:${options?.full ? 'full' : 'recent'}`;

    // Check cache first (performance optimization)
    const cached = this.sshTranscriptCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < this.SSH_CACHE_TTL) {
      console.log('[SSH Service] Using cached transcript for', sdkSessionId, `(age: ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s)`);
      return cached.content;
    }

    try {
      const perfStart = performance.now();

      // Construct the expected path to the transcript file
      // Claude Code stores transcripts in ~/.claude/projects/<escaped-path>/<session-id>.jsonl
      // The escaped path replaces / with - and uses the absolute workdir path
      const escapedPath = remoteWorkdir.replace(/\//g, '-').replace(/^-/, '-');
      const transcriptPath = `~/.claude/projects/${escapedPath}/${sdkSessionId}.jsonl`;

      console.log('[SSH Service] Fetching remote transcript:', transcriptPath);

      const readCommand = options?.full
        ? `cat "${transcriptPath}" 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`
        : `tail -n 500 "${transcriptPath}" 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`;
      // Reads are idempotent — use execWithRetry so we skip the liveness probe
      // but still survive a stale connection by auto-reconnecting once.
      const result = await this.execWithRetry(sessionId, config, readCommand);

      if (result.includes('___TRANSCRIPT_NOT_FOUND___')) {
        // Try alternative path format (just the directory name)
        const altPath = `~/.claude/projects/*/${sdkSessionId}.jsonl`;
        console.log('[SSH Service] Trying alternative transcript path:', altPath);

        const altReadCommand = options?.full
          ? `cat ${altPath} 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`
          : `tail -n 500 ${altPath} 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`;
        const altResult = await this.execWithRetry(sessionId, config, altReadCommand);

        if (altResult.includes('___TRANSCRIPT_NOT_FOUND___')) {
          console.log('[SSH Service] Transcript not found on remote');
          return null;
        }

        // Cache the result (performance optimization)
        this.sshTranscriptCache.set(cacheKey, {
          content: altResult,
          fetchedAt: Date.now(),
          sessionId: sdkSessionId,
        });
        console.log(`[Perf] SSH transcript fetch took ${performance.now() - perfStart}ms (${altResult.length} bytes)`);
        return altResult;
      }

      // Cache the result (performance optimization)
      this.sshTranscriptCache.set(cacheKey, {
        content: result,
        fetchedAt: Date.now(),
        sessionId: sdkSessionId,
      });
      console.log(`[Perf] SSH transcript fetch took ${performance.now() - perfStart}ms (${result.length} bytes)`);
      return result;
    } catch (error) {
      console.error('[SSH Service] Failed to fetch remote transcript:', error);
      return null;
    }
  }

  /**
   * List available transcript files on the remote machine for a given workdir
   * Returns array of {filename, mtime} sorted by most recent
   */
  async listRemoteTranscripts(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<Array<{ filename: string; sessionId: string; mtime: number }>> {
    try {
      // Construct the expected path to the transcripts directory
      const escapedPath = remoteWorkdir.replace(/\//g, '-').replace(/^-/, '-');
      const transcriptsDir = `~/.claude/projects/${escapedPath}`;

      console.log('[SSH Service] Listing remote transcripts in:', transcriptsDir);

      // List .jsonl files with their modification times, excluding agent files.
      // Reads are idempotent — execWithRetry skips the liveness probe but
      // reconnects once on failure, preserving correctness at lower RTT cost.
      const result = await this.execWithRetry(
        sessionId,
        config,
        `find ${transcriptsDir} -maxdepth 1 -name "*.jsonl" ! -name "agent-*" -printf "%T@ %f\\n" 2>/dev/null | sort -rn || echo ""`
      );

      if (!result.trim()) {
        return [];
      }

      const transcripts: Array<{ filename: string; sessionId: string; mtime: number }> = [];
      for (const line of result.trim().split('\n')) {
        const match = line.match(/^(\d+\.?\d*)\s+(.+\.jsonl)$/);
        if (match) {
          const mtime = parseFloat(match[1]);
          const filename = match[2];
          const sessionId = filename.replace('.jsonl', '');
          transcripts.push({ filename, sessionId, mtime });
        }
      }

      return transcripts;
    } catch (error) {
      console.error('[SSH Service] Failed to list remote transcripts:', error);
      return [];
    }
  }

  /**
   * Performance optimization: Invalidate cached transcript for a session
   * Pass the remote Claude SDK session ID when available to force a refetch on next load.
   */
  invalidateTranscriptCache(sessionId: string): void {
    let invalidatedCount = 0;
    for (const [key, value] of this.sshTranscriptCache.entries()) {
      if (value.sessionId === sessionId) {
        this.sshTranscriptCache.delete(key);
        invalidatedCount++;
      }
    }
    if (invalidatedCount > 0) {
      console.log('[SSH Service] Invalidated', invalidatedCount, 'cached transcripts for', sessionId);
    }
  }

  private getRemoteExtensionScanCacheKey(kind: string, config: SSHConfig, remoteWorkdir: string): string {
    return [
      kind,
      config.username || '',
      config.host || '',
      config.port || 22,
      remoteWorkdir || config.remoteWorkdir || '~',
    ].join('|');
  }

  private async cachedRemoteExtensionScan<T>(
    kind: string,
    config: SSHConfig,
    remoteWorkdir: string,
    loader: () => Promise<T>
  ): Promise<T> {
    const key = this.getRemoteExtensionScanCacheKey(kind, config, remoteWorkdir);
    const existing = this.remoteExtensionScanCache.get(key);
    const now = Date.now();
    if (existing?.value !== undefined && now - existing.fetchedAt < this.REMOTE_EXTENSION_SCAN_TTL_MS) {
      return existing.value as T;
    }
    if (existing?.promise) {
      return existing.promise as Promise<T>;
    }

    const promise = loader().then((value) => {
      this.remoteExtensionScanCache.set(key, { fetchedAt: Date.now(), value });
      return value;
    }).catch((error) => {
      this.remoteExtensionScanCache.delete(key);
      throw error;
    });
    this.remoteExtensionScanCache.set(key, { fetchedAt: now, promise });
    return promise;
  }

  /**
   * Scan for commands on a remote machine via SSH
   */
  async scanRemoteCommands(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<RemoteCommandItem[]> {
    return this.cachedRemoteExtensionScan('commands', config, remoteWorkdir, async () => {
    const commands: RemoteCommandItem[] = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user commands (~/.claude/commands)
      const userCommandsScript = `
        find "$HOME/.claude/commands" -maxdepth 4 -name "*.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userCommandsScript);
      commands.push(...this.parseRemoteCommands(userResult, 'user'));

      const quotedWorkdir = this.quoteForShell(remoteWorkdir || config.remoteWorkdir || '~');

      // Scan project commands in remoteWorkdir
      const projectCommandsScript = `
        ROOT=${quotedWorkdir}
        case "$ROOT" in
          "~") ROOT="$HOME" ;;
          "~/"*) ROOT="$HOME/\${ROOT#~/}" ;;
        esac
        find "$ROOT/.claude/commands" -maxdepth 4 -name "*.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectCommandsScript);
      commands.push(...this.parseRemoteCommands(projectResult, 'project'));

      return commands;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote commands:', error);
      return [];
    }
    });
  }

  /**
   * Parse remote command output into Command objects
   */
  private parseRemoteCommands(
    output: string,
    scope: 'user' | 'project'
  ): Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> {
    const commands: Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> = [];

    const files = output.split('___FILE_START___').filter(f => f.trim());
    for (const fileBlock of files) {
      const endIdx = fileBlock.indexOf('___FILE_END___');
      if (endIdx === -1) continue;

      const content = fileBlock.substring(0, endIdx);
      const lines = content.trim().split('\n');
      if (lines.length < 2) continue;

      const filePath = lines[0].trim();
      const fileContent = lines.slice(1).join('\n');

      // Extract command name from path (e.g., /path/to/commands/foo.md -> foo)
      const fileName = filePath.split('/').pop() || '';
      const name = fileName.replace('.md', '');

      // Extract description from first line if it's an HTML comment
      const firstLine = fileContent.split('\n')[0]?.trim() || '';
      const description = firstLine.startsWith('<!--') && firstLine.endsWith('-->')
        ? firstLine.replace(/^<!--\s*/, '').replace(/\s*-->$/, '')
        : undefined;

      commands.push({ name, path: filePath, content: fileContent, description, scope });
    }

    return commands;
  }

  /**
   * Scan for skills on a remote machine via SSH
   */
  async scanRemoteSkills(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<RemoteSkillItem[]> {
    return this.cachedRemoteExtensionScan('skills', config, remoteWorkdir, async () => {
    const skills: RemoteSkillItem[] = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user skills (~/.claude/skills/*/SKILL.md)
      const userSkillsScript = `
        find "$HOME/.claude/skills" -maxdepth 3 -name "SKILL.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userSkillsScript);
      skills.push(...this.parseRemoteSkills(userResult, 'user'));

      const quotedWorkdir = this.quoteForShell(remoteWorkdir || config.remoteWorkdir || '~');

      // Scan project skills
      const projectSkillsScript = `
        ROOT=${quotedWorkdir}
        case "$ROOT" in
          "~") ROOT="$HOME" ;;
          "~/"*) ROOT="$HOME/\${ROOT#~/}" ;;
        esac
        find "$ROOT/.claude/skills" -maxdepth 3 -name "SKILL.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectSkillsScript);
      skills.push(...this.parseRemoteSkills(projectResult, 'project'));

      return skills;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote skills:', error);
      return [];
    }
    });
  }

  /**
   * Parse remote skill output into Skill objects
   */
  private parseRemoteSkills(
    output: string,
    scope: 'user' | 'project'
  ): Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> {
    const skills: Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> = [];

    const files = output.split('___FILE_START___').filter(f => f.trim());
    for (const fileBlock of files) {
      const endIdx = fileBlock.indexOf('___FILE_END___');
      if (endIdx === -1) continue;

      const content = fileBlock.substring(0, endIdx);
      const lines = content.trim().split('\n');
      if (lines.length < 2) continue;

      const filePath = lines[0].trim();
      const fileContent = lines.slice(1).join('\n');

      // Extract skill name from path (e.g., /path/to/skills/my-skill/SKILL.md -> my-skill)
      const pathParts = filePath.split('/');
      const skillMdIndex = pathParts.findIndex(p => p === 'SKILL.md');
      const name = skillMdIndex > 0 ? pathParts[skillMdIndex - 1] : 'unknown';
      const skillDir = pathParts.slice(0, skillMdIndex).join('/');

      // Extract description from first heading
      const firstLine = fileContent.split('\n')[0]?.trim() || '';
      const description = firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : undefined;

      skills.push({ name, path: skillDir, content: fileContent, description, scope });
    }

    return skills;
  }

  /**
   * Scan for agents on a remote machine via SSH
   */
  async scanRemoteAgents(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<RemoteAgentItem[]> {
    return this.cachedRemoteExtensionScan('agents', config, remoteWorkdir, async () => {
    const agents: RemoteAgentItem[] = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user agents (~/.claude/agents/*.md)
      const userAgentsScript = `
        find "$HOME/.claude/agents" -maxdepth 2 -name "*.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userAgentsScript);
      agents.push(...this.parseRemoteAgents(userResult, 'user'));

      const quotedWorkdir = this.quoteForShell(remoteWorkdir || config.remoteWorkdir || '~');

      // Scan project agents
      const projectAgentsScript = `
        ROOT=${quotedWorkdir}
        case "$ROOT" in
          "~") ROOT="$HOME" ;;
          "~/"*) ROOT="$HOME/\${ROOT#~/}" ;;
        esac
        find "$ROOT/.claude/agents" -maxdepth 2 -name "*.md" -type f 2>/dev/null | head -500 | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectAgentsScript);
      agents.push(...this.parseRemoteAgents(projectResult, 'project'));

      return agents;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote agents:', error);
      return [];
    }
    });
  }

  /**
   * Collect remote project/user instruction files for cross-harness context.
   * This is intentionally broader than slash-command scans: it includes the
   * instruction and rule files that local harnesses usually auto-discover.
   */
  async scanRemoteHarnessContextFiles(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<Array<{ label: string; filePath: string; content: string }>> {
    try {
      const client = await this.getConnection(sessionId, config);
      const quotedWorkdir = this.quoteForShell(remoteWorkdir || config.remoteWorkdir || '~');
      const script = `
ROOT=${quotedWorkdir}
case "$ROOT" in
  "~") ROOT="$HOME" ;;
  "~/"*) ROOT="$HOME/$(printf '%s' "$ROOT" | cut -c3-)" ;;
esac
if [ -d "$ROOT" ]; then
  ROOT="$(cd "$ROOT" && pwd)"
fi

emit_context_file() {
  label="$1"
  file="$2"
  [ -f "$file" ] || return
  echo "___FILE_START___"
  printf '%s\\n' "$label"
  printf '%s\\n' "$file"
  head -c 18000 "$file" 2>/dev/null
  printf '\\n___FILE_END___\\n'
}

if [ -d "$ROOT" ]; then
  find "$ROOT" \\
    \\( -path "*/.git/*" -o -path "*/node_modules/*" -o -path "*/.webpack/*" -o -path "*/out/*" -o -path "*/dist/*" -o -path "*/build/*" -o -path "*/coverage/*" -o -path "*/.claudette-worktrees/*" -o -path "*/worktrees/*" \\) -prune -o \\
    -type f \\( -name "CLAUDE.md" -o -name "AGENTS.md" -o -name "AGENT.md" -o -name "Agent.md" -o -name "agent.md" -o -name "agents.md" -o -name "GEMINI.md" -o -name "OPENCODE.md" -o -name "MEMORY.md" -o -name ".cursorrules" -o -name ".windsurfrules" -o -path "*/.github/copilot-instructions.md" -o -path "*/.cursor/rules/*.md" -o -path "*/.cursor/rules/*.mdc" -o -path "*/.claude/agents/*.md" -o -path "*/.claude/commands/*.md" -o -path "*/.claude/skills/*/SKILL.md" \\) \\
    -print 2>/dev/null | head -n 64 | while IFS= read -r f; do
      rel="\${f#$ROOT/}"
      case "$f" in
        */.claude/skills/*/SKILL.md) label="remote project skill: $(basename "$(dirname "$f")")" ;;
        */.claude/agents/*.md) label="remote project agent: $(basename "$f")" ;;
        */.claude/commands/*.md) label="remote project command: $rel" ;;
        */.cursor/rules/*) label="remote project cursor rule: $rel" ;;
        */MEMORY.md) label="remote project memory: $rel" ;;
        *) label="remote project $rel" ;;
      esac
      emit_context_file "$label" "$f"
    done
fi

emit_context_file "remote user CLAUDE.md" "$HOME/.claude/CLAUDE.md"
emit_context_file "remote user MEMORY.md" "$HOME/.claude/MEMORY.md"
emit_context_file "remote user codex AGENTS.md" "$HOME/.codex/AGENTS.md"
emit_context_file "remote user codex AGENT.md" "$HOME/.codex/AGENT.md"
emit_context_file "remote user codex agent.md" "$HOME/.codex/agent.md"
emit_context_file "remote user GEMINI.md" "$HOME/.gemini/GEMINI.md"
emit_context_file "remote user OPENCODE.md" "$HOME/.config/opencode/OPENCODE.md"
emit_context_file "remote user opencode AGENTS.md" "$HOME/.config/opencode/AGENTS.md"

find "$HOME/.claude/agents" -maxdepth 1 -name "*.md" -type f 2>/dev/null | head -n 12 | while IFS= read -r f; do
  emit_context_file "remote user agent: $(basename "$f")" "$f"
done

find "$HOME/.claude/commands" -name "*.md" -type f 2>/dev/null | head -n 8 | while IFS= read -r f; do
  emit_context_file "remote user command: $(basename "$f")" "$f"
done

find "$HOME/.claude/skills" -path "*/SKILL.md" -type f 2>/dev/null | head -n 18 | while IFS= read -r f; do
  emit_context_file "remote user skill: $(basename "$(dirname "$f")")" "$f"
done
`;

      const result = await this.execCommand(client, script);
      const files = this.parseRemoteHarnessContextFiles(result);
      console.log('[SSH Service] Found', files.length, 'remote harness context files');
      return files;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote harness context files:', error);
      return [];
    }
  }

  private parseRemoteHarnessContextFiles(output: string): Array<{ label: string; filePath: string; content: string }> {
    const files: Array<{ label: string; filePath: string; content: string }> = [];

    for (const fileBlock of output.split('___FILE_START___').filter(f => f.trim())) {
      const endIdx = fileBlock.indexOf('___FILE_END___');
      if (endIdx === -1) continue;

      const block = fileBlock.substring(0, endIdx).replace(/^\s*\n/, '');
      const lines = block.split('\n');
      const label = lines.shift()?.trim();
      const filePath = lines.shift()?.trim();
      const content = lines.join('\n').trim();
      if (!label || !filePath || !content) continue;

      files.push({ label, filePath, content });
    }

    return files;
  }

  /**
   * Parse remote agent output into AgentDefinition objects
   */
  private parseRemoteAgents(
    output: string,
    scope: 'user' | 'project'
  ): Array<{ name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' }> {
    const agents: Array<{ name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' }> = [];

    const files = output.split('___FILE_START___').filter(f => f.trim());
    for (const fileBlock of files) {
      const endIdx = fileBlock.indexOf('___FILE_END___');
      if (endIdx === -1) continue;

      const content = fileBlock.substring(0, endIdx);
      const lines = content.trim().split('\n');
      if (lines.length < 2) continue;

      const filePath = lines[0].trim();
      const fileContent = lines.slice(1).join('\n');

      // Extract agent name from path
      const fileName = filePath.split('/').pop() || '';
      const name = fileName.replace('.md', '');

      // Parse the agent markdown
      const agent = this.parseAgentMarkdown(fileContent, name, scope);
      if (agent) {
        agents.push(agent);
      }
    }

    return agents;
  }

  /**
   * Parse agent markdown content
   */
  private parseAgentMarkdown(
    content: string,
    name: string,
    scope: 'user' | 'project'
  ): { name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' } | null {
    const lines = content.split('\n');
    let description = '';
    let systemPrompt = '';
    let currentSection = '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('# ')) {
        currentSection = 'description';
        continue;
      } else if (trimmed.startsWith('## System Prompt') || trimmed.startsWith('## Prompt')) {
        currentSection = 'systemPrompt';
        continue;
      }

      if (currentSection === 'description' && trimmed) {
        description += trimmed + ' ';
      } else if (currentSection === 'systemPrompt') {
        systemPrompt += line + '\n';
      }
    }

    if (!description || !systemPrompt) {
      return null;
    }

    return { name, description: description.trim(), systemPrompt: systemPrompt.trim(), scope };
  }

  /**
   * Install a skill on a remote machine via SSH
   * Runs npx skills add on the remote server
   */
  async installRemoteSkill(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string,
    source: string,
    options?: { global?: boolean; skills?: string[] }
  ): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      const client = await this.getConnection(sessionId, config);

      // Build the npx skills add command
      const args = ['skills', 'add', source];

      // Add --yes flag for non-interactive mode
      args.push('-y');

      // Add global flag if specified
      if (options?.global) {
        args.push('-g');
      }

      // Add specific skills if provided
      if (options?.skills && options.skills.length > 0) {
        for (const skill of options.skills) {
          args.push('--skill', skill);
        }
      }

      // Target claude-code agent
      args.push('-a', 'claude-code');

      // Escape arguments for shell
      const escapedArgs = args.map(arg => {
        // If arg contains spaces or special chars, quote it
        if (/[\s'"`$\\]/.test(arg)) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      });

      const command = `cd "${remoteWorkdir}" && npx ${escapedArgs.join(' ')}`;
      console.log('[SSH Service] Running remote install:', command);

      const output = await this.execCommand(client, command);
      console.log('[SSH Service] Install output:', output);

      return {
        success: true,
        output: output || 'Skill installed successfully on remote server',
      };
    } catch (error) {
      console.error('[SSH Service] Failed to install remote skill:', error);
      return {
        success: false,
        output: '',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Teleport a local session to a remote SSH host
   * Copies transcript files and syncs settings so Claude can resume with full context
   */
  async teleportSession(
    localProjectPath: string,
    sdkSessionId: string | undefined,
    destinationConfig: SSHConfig,
    onProgress?: (message: string) => void
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    const teleportId = `teleport-${Date.now()}`;

    try {
      onProgress?.('Connecting to remote host...');
      await this.connect(teleportId, destinationConfig);

      const connInfo = this.connections.get(teleportId);
      if (!connInfo) {
        return { success: false, error: 'Failed to establish connection' };
      }

      const client = connInfo.client;

      // 1. Create the remote project directory in Claude's format
      // Claude Code stores transcripts in ~/.claude/projects/{escaped-path}/
      const escapedRemotePath = destinationConfig.remoteWorkdir.replace(/\//g, '-').replace(/^-/, '');
      const remoteProjectDir = `~/.claude/projects/-${escapedRemotePath}`;

      onProgress?.('Creating remote project directory...');
      await this.execCommand(client, `mkdir -p ${remoteProjectDir}`);

      // IMPORTANT: Get the absolute path for SFTP operations
      // SFTP doesn't understand tilde (~) paths, so we need to expand it
      const remoteProjectDirAbsolute = (await this.execCommand(client, `echo ${remoteProjectDir}`)).trim();

      // 2. Find and upload transcript files
      const path = await import('path');
      const os = await import('os');
      const fsPromises = await import('fs/promises');

      // Escape the local project path in Claude's format
      const escapedLocalPath = localProjectPath.replace(/\//g, '-').replace(/^-/, '');
      const localClaudePath = path.join(os.homedir(), '.claude', 'projects', `-${escapedLocalPath}`);

      onProgress?.('Checking for session transcript...');

      // Check if local transcript directory exists
      let files: string[];
      try {
        files = await fsPromises.readdir(localClaudePath);
      } catch (err) {
        // If local claude directory doesn't exist, that's fine - fresh session
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'ENOENT') {
          console.log('[SSH Service] No local Claude project directory found:', localClaudePath);
          onProgress?.('No existing transcripts (starting fresh)');
        } else {
          // Unexpected error reading directory - log it but continue
          console.error('[SSH Service] Error reading transcript directory:', err);
          onProgress?.('Warning: Could not read local transcript directory');
        }
        // Continue without transcripts
        files = [];
      }

      // If we have an SDK session ID, only upload that specific transcript
      // This ensures we teleport the exact conversation, not other sessions from the same worktree
      const transcriptFiles = sdkSessionId
        ? files.filter(f => f === `${sdkSessionId}.jsonl`)
        : files.filter(f => f.endsWith('.jsonl'));

      if (transcriptFiles.length === 0) {
        const msg = sdkSessionId
          ? `No transcript found for session ${sdkSessionId} (starting fresh)`
          : 'No transcript files found (new session will start fresh)';
        onProgress?.(msg);
        console.log('[SSH Service] Teleport:', msg);
      } else {
        onProgress?.(`Found ${transcriptFiles.length} transcript file(s), transferring...`);

        // Upload each transcript file via SFTP
        // DON'T catch errors here - upload failures should propagate
        for (const filename of transcriptFiles) {
          const localFilePath = path.join(localClaudePath, filename);
          // Use absolute path for SFTP (SFTP doesn't understand tilde paths)
          const remoteFilePath = `${remoteProjectDirAbsolute}/${filename}`;

          onProgress?.(`Uploading ${filename}...`);
          await this.uploadFile(client, localFilePath, remoteFilePath);
          console.log('[SSH Service] Successfully uploaded:', filename);
        }
      }

      // 3. Sync settings if enabled
      if (destinationConfig.syncSettings !== false) {
        onProgress?.('Syncing Claude settings...');
        try {
          await this.syncSettingsInternal(client, destinationConfig);
        } catch (err) {
          console.warn('[SSH Service] Settings sync failed, continuing:', err);
        }
      }

      onProgress?.('Teleportation complete!');
      return { success: true };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SSH Service] Teleport failed:', error);
      console.error('[SSH Service] Error details:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[SSH Service] Stack trace:', error.stack);
      }
      return { success: false, error: errorMsg };
    } finally {
      this.disconnect(teleportId);
    }
  }

  /**
   * Upload a file to the remote via SFTP
   */
  private uploadFile(client: Client, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);

        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath);

        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });

        writeStream.on('error', (error: Error) => {
          sftp.end();
          reject(error);
        });

        readStream.on('error', (error: Error) => {
          sftp.end();
          reject(error);
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Download a file from the remote via SFTP.
   * Mirror of uploadFile() — streams from remote to local, ensuring parent directories exist.
   */
  async downloadFile(client: Client, remotePath: string, localPath: string): Promise<void> {
    const path = await import('path');
    const fsPromises = await import('fs/promises');

    // Ensure the local parent directory exists before writing
    await fsPromises.mkdir(path.dirname(localPath), { recursive: true });

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);

        writeStream.on('close', () => {
          sftp.end();
          resolve();
        });

        writeStream.on('error', (error: Error) => {
          sftp.end();
          reject(error);
        });

        readStream.on('error', (error: Error) => {
          sftp.end();
          // Clean up partial file on error
          fs.unlink(localPath, () => { /* ignore cleanup errors */ });
          reject(error);
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Get the path to a remote transcript file for a given working directory.
   * Searches the remote ~/.claude/projects/ directory for transcript files.
   *
   * @param client - Active SSH client connection
   * @param remoteWorkingDir - The remote working directory (e.g. /home/ubuntu/dev/repo)
   * @param sdkSessionId - Optional specific SDK session ID to look for
   * @returns Full remote path to the transcript file, or null if not found
   */
  async getRemoteTranscriptPath(
    client: Client,
    remoteWorkingDir: string,
    sdkSessionId?: string
  ): Promise<string | null> {
    try {
      // Claude Code stores transcripts in ~/.claude/projects/{escaped-path}/
      // where slashes become dashes, prefixed with a leading dash
      const escapedPath = remoteWorkingDir.replace(/\//g, '-').replace(/^-/, '-');
      const projectDir = `~/.claude/projects/${escapedPath}`;

      if (sdkSessionId) {
        // Look for a specific transcript file
        const targetPath = `${projectDir}/${sdkSessionId}.jsonl`;
        const checkResult = await this.execCommand(
          client,
          `test -f "${targetPath}" && echo "${targetPath}" || echo ""`
        );

        if (checkResult.trim()) {
          return checkResult.trim();
        }

        // Fallback: glob search across all project directories
        console.log('[SSH Service] Transcript not at primary path, trying glob fallback');
        const globResult = await this.execCommand(
          client,
          `find ~/.claude/projects -maxdepth 2 -name "${sdkSessionId}.jsonl" -type f 2>/dev/null | head -1`
        );

        return globResult.trim() || null;
      }

      // No specific session ID — check if the project directory exists
      const dirCheck = await this.execCommand(
        client,
        `test -d "${projectDir}" && echo "${projectDir}" || echo ""`
      );

      return dirCheck.trim() || null;
    } catch (error) {
      console.error('[SSH Service] Failed to get remote transcript path:', error);
      return null;
    }
  }

  private async syncBuildMcpServersInternal(client: Client, strict = false, bridgePorts?: Map<string, number>): Promise<void> {
    try {
      const { mcpService } = await import('./mcp.service');
      const { servers, serverIds, removeServerIds } = bridgePorts && bridgePorts.size > 0
        ? mcpService.getClaudeMcpSyncDataForSSH(bridgePorts)
        : mcpService.getClaudeMcpSyncData();

      console.log('[SSH Service] Syncing Claude MCP servers to remote:', serverIds);

      const existingContent = await this.execCommand(client, 'cat ~/.claude/config.json 2>/dev/null || true');
      const configJson = mcpService.buildMergedMcpJson(existingContent, servers, removeServerIds);
      await this.execCommand(client, `mkdir -p ~/.claude && cat > ~/.claude/config.json << 'CONFIG_EOF'
${configJson}
CONFIG_EOF`);

      console.log('[SSH Service] MCP servers synced to remote ~/.claude/config.json');
    } catch (err) {
      console.warn('[SSH Service] Could not sync MCP servers to remote:', err);
      if (strict) throw err;
    }
  }

  private async uploadDirectoryViaSftp(client: Client, localDir: string, remoteDir: string): Promise<void> {
    const path = await import('path');
    const fsPromises = await import('fs/promises');
    const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftpSession) => {
        if (err) reject(err);
        else resolve(sftpSession);
      });
    });

    const mkdirp = async (dir: string): Promise<void> => {
      const normalized = path.posix.normalize(dir);
      const parts = normalized.split('/').filter(Boolean);
      let current = normalized.startsWith('/') ? '/' : '';

      for (const part of parts) {
        current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part;
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => {
            if (!err) {
              resolve();
              return;
            }

            sftp.stat(current, (statErr, attrs) => {
              if (!statErr && attrs.isDirectory()) {
                resolve();
                return;
              }
              reject(err);
            });
          });
        });
      }
    };

    const uploadDir = async (sourceDir: string, targetDir: string): Promise<void> => {
      await mkdirp(targetDir);
      const entries = await fsPromises.readdir(sourceDir, { withFileTypes: true });

      for (const entry of entries) {
        const localPath = path.join(sourceDir, entry.name);
        const remotePath = path.posix.join(targetDir, entry.name);

        if (entry.isDirectory()) {
          await uploadDir(localPath, remotePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(localPath, remotePath, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    };

    try {
      await uploadDir(localDir, remoteDir);
    } finally {
      sftp.end();
    }
  }

  private async syncMcpAuthInternal(client: Client, strict = false): Promise<void> {
    const path = await import('path');
    const os = await import('os');
    const fsPromises = await import('fs/promises');

    try {
      const localMcpAuth = path.join(os.homedir(), '.mcp-auth');
      const localStats = await fsPromises.stat(localMcpAuth).catch(() => null);
      if (!localStats?.isDirectory()) {
        console.log('[SSH Service] No local ~/.mcp-auth directory, skipping MCP auth sync');
        return;
      }

      // Cache check: skip if we've recently synced and the local dir hasn't changed
      const cacheKey = `${(client as any).config?.host || (client as any)._host || 'default'}`;
      const cached = this.mcpAuthSyncCache.get(cacheKey);
      const localMtime = localStats.mtimeMs;

      if (cached &&
          Date.now() - cached.lastSyncedAt < this.MCP_AUTH_CACHE_TTL_MS &&
          cached.localMtime === localMtime) {
        console.log('[SSH Service] MCP auth tokens already synced (cached), skipping');
        return;
      }

      const remoteHome = (await this.execCommand(client, 'printf %s "$HOME"')).trim();
      const remoteMcpAuth = `${remoteHome || '~'}/.mcp-auth`;

      console.log('[SSH Service] Syncing MCP auth tokens to remote via SFTP...');
      await this.uploadDirectoryViaSftp(client, localMcpAuth, remoteMcpAuth);
      await this.execCommand(client, `chmod -R go-rwx ${this.quoteForShell(remoteMcpAuth)} 2>/dev/null || true`);

      // mcp-remote stores tokens per-version (e.g., mcp-remote-0.1.29/).
      // Local and remote may run different versions. Copy token files from
      // the newest local version into ALL remote version folders so tokens
      // are found regardless of which mcp-remote version the remote uses.
      try {
        await this.execCommand(client, `
          cd ${this.quoteForShell(remoteMcpAuth)} && \
          SRC=$(ls -d mcp-remote-* 2>/dev/null | sort -V | while read d; do \
            ls "$d"/*_tokens.json >/dev/null 2>&1 && echo "$d"; \
          done | tail -1) && \
          if [ -n "$SRC" ]; then \
            for DST in mcp-remote-*; do \
              [ "$DST" = "$SRC" ] && continue; \
              ls "$DST"/*_tokens.json >/dev/null 2>&1 && continue; \
              cp "$SRC"/*_tokens.json "$SRC"/*_client_info.json "$SRC"/*_code_verifier.txt "$DST/" 2>/dev/null; \
            done; \
          fi
        `);
      } catch {
        // Non-critical — tokens may already be in the right place
      }

      console.log('[SSH Service] MCP auth tokens synced to remote');
      this.mcpAuthSyncCache.set(cacheKey, { lastSyncedAt: Date.now(), localMtime });
    } catch (err) {
      console.warn('[SSH Service] Could not sync MCP auth tokens:', err);
      if (strict) throw err;
    }
  }

  private async readRemoteTextFileOrEmpty(client: Client, remotePath: string): Promise<string> {
    return this.execCommand(client, `cat ${this.quoteForShell(remotePath)} 2>/dev/null || true`);
  }

  private async writeRemoteTextFile(client: Client, remotePath: string, content: string): Promise<void> {
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    const marker = `BUILD_MCP_EOF_${Date.now()}`;
    await this.execCommand(client, `mkdir -p ${this.quoteForShell(dir)} && cat > ${this.quoteForShell(remotePath)} << '${marker}'
${content}
${marker}`);
  }

  private async syncHarnessMcpConfigsInternal(client: Client, strict = false, bridgePorts?: Map<string, number>): Promise<void> {
    try {
      // Cache check: skip if we've recently synced to this host
      const cacheKey = `${(client as any).config?.host || (client as any)._host || 'default'}`;
      const lastSynced = this.harnessMcpSyncCache.get(cacheKey);
      if (lastSynced && Date.now() - lastSynced < this.HARNESS_MCP_CACHE_TTL_MS) {
        console.log('[SSH Service] Harness MCP configs already synced (cached), skipping');
        return;
      }

      const { mcpService } = await import('./mcp.service');
      const { servers, serverIds, removeServerIds } = bridgePorts && bridgePorts.size > 0
        ? mcpService.getHarnessMcpSyncDataForSSH(bridgePorts)
        : mcpService.getHarnessMcpSyncData();

      if (serverIds.length === 0 && removeServerIds.length === 0) {
        console.log('[SSH Service] No harness MCP configs to sync');
        return;
      }

      const home = (await this.execCommand(client, 'printf %s "$HOME"')).trim() || '~';
      const cursorPath = `${home}/.cursor/mcp.json`;
      const geminiPath = `${home}/.gemini/settings.json`;
      const codexPath = `${home}/.codex/config.toml`;
      const opencodeDefaultPath = `${home}/.config/opencode/opencode.json`;
      const opencodeBuildPath = `${home}/.config/opencode/build-mcp.json`;

      const cursorJson = mcpService.buildMergedMcpJson(
        await this.readRemoteTextFileOrEmpty(client, cursorPath),
        servers,
        removeServerIds
      );
      await this.writeRemoteTextFile(client, cursorPath, cursorJson);

      const geminiJson = mcpService.buildMergedMcpJson(
        await this.readRemoteTextFileOrEmpty(client, geminiPath),
        servers,
        removeServerIds
      );
      await this.writeRemoteTextFile(client, geminiPath, geminiJson);

      const codexToml = mcpService.buildMergedCodexConfig(
        await this.readRemoteTextFileOrEmpty(client, codexPath),
        servers,
        removeServerIds
      );
      await this.writeRemoteTextFile(client, codexPath, codexToml);

      const opencodeJson = mcpService.buildMergedOpenCodeConfig(
        await this.readRemoteTextFileOrEmpty(client, opencodeDefaultPath),
        servers,
        removeServerIds,
        await this.readRemoteTextFileOrEmpty(client, opencodeBuildPath)
      );
      await this.writeRemoteTextFile(client, opencodeBuildPath, opencodeJson);

      console.log('[SSH Service] Harness MCP configs synced to remote Cursor/Gemini/Codex/OpenCode:', serverIds);
      this.harnessMcpSyncCache.set(cacheKey, Date.now());
    } catch (err) {
      console.warn('[SSH Service] Could not sync harness MCP configs to remote:', err);
      if (strict) throw err;
    }
  }

  private async setupMcpReverseTunnelsForSession(sessionId: string, config: SSHConfig, strict = false): Promise<void> {
    try {
      const { mcpService } = await import('./mcp.service');
      const localhostPorts = mcpService.getLocalhostMcpPorts();

      for (const { serverId, port, url } of localhostPorts) {
        await this.setupReverseTunnel(sessionId, config, port);
        console.log(`[SSH Service] Reverse tunnel for ${serverId} MCP (${url}): remote:${port} -> local:${port}`);
      }

      // Also tunnel stdio bridge ports (these are localhost HTTP servers
      // wrapping native stdio MCP processes for remote consumption)
      try {
        const { mcpStdioBridgeService } = await import('./mcp-stdio-bridge.service');
        const bridgePorts = mcpStdioBridgeService.getBridgePorts();
        for (const { serverId, port } of bridgePorts) {
          await this.setupReverseTunnel(sessionId, config, port);
          console.log(`[SSH Service] Reverse tunnel for ${serverId} MCP bridge: remote:${port} -> local:${port}`);
        }
      } catch (err) {
        console.warn('[SSH Service] Could not set up MCP bridge reverse tunnels:', err);
      }
    } catch (err) {
      console.warn('[SSH Service] Could not set up MCP reverse tunnels:', err);
      if (strict) throw err;
    }
  }

  /**
   * Internal method to sync settings without creating a new connection
   */
  private async syncSettingsInternal(client: Client, config: SSHConfig): Promise<void> {
    const path = await import('path');
    const os = await import('os');
    const fsPromises = await import('fs/promises');

    // Read local settings
    const localSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    try {
      const settingsContent = await fsPromises.readFile(localSettingsPath, 'utf-8');

      // Upload settings to remote
      await this.execCommand(client, 'mkdir -p ~/.claude');

      // Use a heredoc to write settings
      const escapedContent = settingsContent.replace(/'/g, "'\\''");
      await this.execCommand(client, `cat > ~/.claude/settings.json << 'SETTINGS_EOF'
${settingsContent}
SETTINGS_EOF`);

      console.log('[SSH Service] Settings synced to remote');
    } catch (err) {
      console.warn('[SSH Service] Could not read local settings:', err);
    }

    await this.syncBuildMcpServersInternal(client);

    // Sync skills to remote — rsync ~/.claude/skills/ (excluding binaries/node_modules)
    try {
      const localSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      const stats = await fsPromises.stat(localSkillsDir).catch(() => null);
      if (stats?.isDirectory()) {
        const { execSync } = await import('child_process');
        const host = config.host;
        const user = config.username;
        const port = config.port || 22;
        const keyPath = config.privateKeyPath;
        const keyFlag = keyPath ? `-e "ssh -i ${keyPath} -p ${port} -o StrictHostKeyChecking=no"` : `-e "ssh -p ${port} -o StrictHostKeyChecking=no"`;

        // Ensure remote directory exists
        await this.execCommand(client, 'mkdir -p ~/.claude/skills');

        // rsync skills, excluding heavy build artifacts
        const rsyncCmd = `rsync -az --delete ${keyFlag} --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='*.node' --exclude='chromium*' ${localSkillsDir}/ ${user}@${host}:~/.claude/skills/`;
        console.log('[SSH Service] Syncing skills to remote...');
        execSync(rsyncCmd, { timeout: 60000, stdio: 'pipe' });
        console.log('[SSH Service] Skills synced to remote');
      }
    } catch (err) {
      console.warn('[SSH Service] Could not sync skills to remote:', err);
    }

    await this.syncMcpAuthInternal(client);
    await this.syncHarnessMcpConfigsInternal(client);
  }

  /**
   * Sync MCP servers to a specific SSH session's remote machine
   * Used when MCP servers are installed while SSH session is active
   */
  async syncMcpServersToSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const connection = this.connections.get(sessionId);
      if (!connection) {
        return { success: false, error: 'Session not found' };
      }

      const client = connection.client;
      console.log('[SSH Service] Syncing MCP servers/auth to session:', sessionId);

      // Start/reconcile stdio bridges
      let bridgePorts: Map<string, number> | undefined;
      try {
        const { mcpStdioBridgeService } = await import('./mcp-stdio-bridge.service');
        const { mcpService: mcpSvc } = await import('./mcp.service');
        const nativeStdio = mcpSvc.getNativeStdioServers();
        if (Object.keys(nativeStdio).length > 0) {
          bridgePorts = await mcpStdioBridgeService.startBridgesForSession(sessionId, nativeStdio);
        }
      } catch (err) {
        console.warn('[SSH Service] Could not start MCP stdio bridges for session sync:', err);
      }

      await this.syncBuildMcpServersInternal(client, true, bridgePorts);
      await this.syncMcpAuthInternal(client, true);
      await this.syncHarnessMcpConfigsInternal(client, true, bridgePorts);
      await this.setupMcpReverseTunnelsForSession(sessionId, connection.config, true);
      console.log('[SSH Service] MCP servers synced to remote for session:', sessionId);
      return { success: true };
    } catch (error) {
      console.error('[SSH Service] Error syncing MCP servers:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async syncMcpConfigsToRemote(sessionId: string, config: SSHConfig): Promise<{ success: boolean; error?: string }> {
    const syncKey = this.getMcpConfigSyncKey(config);
    const inFlight = this.mcpConfigSyncInFlight.get(syncKey);
    if (inFlight) {
      console.log('[SSH Service] MCP config sync already running for remote, reusing promise:', syncKey);
      const result = await inFlight;
      if (result.success) {
        try {
          await this.setupMcpReverseTunnelsForSession(sessionId, config, true);
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }
      return result;
    }

    const syncPromise = this.syncMcpConfigsToRemoteInternal(sessionId, config);
    this.mcpConfigSyncInFlight.set(syncKey, syncPromise);

    try {
      return await syncPromise;
    } finally {
      this.mcpConfigSyncInFlight.delete(syncKey);
    }
  }

  private async syncMcpConfigsToRemoteInternal(sessionId: string, config: SSHConfig): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getConnection(sessionId, config);
      console.log('[SSH Service] Syncing MCP configs to remote:', sessionId);

      // Start/reconcile stdio bridges before syncing configs
      let bridgePorts: Map<string, number> | undefined;
      try {
        const { mcpStdioBridgeService } = await import('./mcp-stdio-bridge.service');
        const { mcpService: mcpSvc } = await import('./mcp.service');
        const nativeStdio = mcpSvc.getNativeStdioServers();
        if (Object.keys(nativeStdio).length > 0) {
          bridgePorts = await mcpStdioBridgeService.startBridgesForSession(sessionId, nativeStdio);
        }
      } catch (err) {
        console.warn('[SSH Service] Could not start MCP stdio bridges for sync:', err);
      }

      await this.syncBuildMcpServersInternal(client, true, bridgePorts);
      void this.syncMcpAuthInternal(client, false).catch((error) => {
        console.warn('[SSH Service] Background MCP auth token sync failed:', error);
      });
      console.log('[SSH Service] MCP auth token sync running in background');
      await this.syncHarnessMcpConfigsInternal(client, true, bridgePorts);
      await this.setupMcpReverseTunnelsForSession(sessionId, config, true);

      return { success: true };
    } catch (error) {
      console.error('[SSH Service] Error syncing MCP configs to remote:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  /**
   * Public accessor for getting/creating SSH connections (used by Codex service).
   */
  async getConnectionForCodex(sessionId: string, config: SSHConfig): Promise<Client> {
    return this.getConnection(sessionId, config);
  }

  /**
   * Set up a reverse SSH tunnel so a local port is accessible on the remote machine.
   * Used for localhost MCP servers — the remote `claude` process connects to 127.0.0.1:port
   * which gets tunneled back to the local machine.
   */
  async setupReverseTunnel(sessionId: string, config: SSHConfig, localPort: number): Promise<void> {
    const tunnelKey = `${sessionId}:${localPort}`;
    if (this.activeTunnels.has(tunnelKey)) return; // Already set up

    const client = await this.getConnection(sessionId, config);

    return new Promise((resolve, reject) => {
      // forwardIn tells the remote sshd to listen on the given port
      // and forward connections back through the SSH tunnel to our local machine
      client.forwardIn('127.0.0.1', localPort, (err) => {
        if (err) {
          // EADDRINUSE means the port is already forwarded (from a previous session)
          if (
            err.message?.includes('address already in use') ||
            err.message?.includes('EADDRINUSE') ||
            err.message?.includes('Unable to bind')
          ) {
            console.log(`[SSH Service] Reverse tunnel port ${localPort} already in use on remote — reusing`);
            this.activeTunnels.add(tunnelKey);
            resolve();
            return;
          }
          reject(err);
          return;
        }

        this.activeTunnels.add(tunnelKey);
        console.log(`[SSH Service] Reverse tunnel active: remote:${localPort} → local:${localPort}`);

        // Handle incoming connections on the tunnel
        client.on('tcp connection', (info, accept) => {
          if (info.destPort === localPort) {
            const channel = accept();
            // Connect to the local port
            const socket = net.connect(localPort, '127.0.0.1', () => {
              channel.pipe(socket);
              socket.pipe(channel);
            });
            socket.on('error', () => channel.close());
            channel.on('close', () => socket.destroy());
          }
        });

        resolve();
      });
    });
  }
}

// Export singleton instance
export const sshService = new SSHService();
