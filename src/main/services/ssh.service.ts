import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { Readable, Writable, PassThrough } from 'stream';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { SSHConfig } from '../../shared/types';
import { REMOTE_DETACHED_BRIDGE_SCRIPT } from './remote-bridge-script';

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

interface RemoteBridgeInstall {
  bridgePath: string;
  nodeCommand: string;
}


export interface SSHConnectionTestResult {
  success: boolean;
  error?: string;
  claudeCodeVersion?: string;
  hostname?: string;
}

export interface SSHConnectionInfo {
  client: Client;
  config: SSHConfig;
}

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
  private remoteBridgeReady = new Map<string, Promise<RemoteBridgeInstall>>();

  /**
   * Test an SSH connection and verify Claude Code is installed on the remote
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
          // Test by checking Claude Code version
          // Check common installation paths since non-interactive SSH doesn't load shell profile
          const versionResult = await this.execCommand(
            client,
            'export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/*/bin:/usr/local/bin:$PATH" && claude --version 2>/dev/null || echo "NOT_FOUND"'
          );

          if (versionResult.includes('NOT_FOUND') || !versionResult.trim()) {
            client.end();
            resolve({
              success: false,
              error: 'Claude Code CLI is not installed on the remote machine. Install it with: npm install -g @anthropic-ai/claude-code',
            });
            return;
          }

          // Get hostname for display
          const hostnameResult = await this.execCommand(client, 'hostname');
          const hostname = hostnameResult.trim();

          client.end();
          resolve({
            success: true,
            claudeCodeVersion: versionResult.trim(),
            hostname,
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
        const fs = require('fs');
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
   * Get the current git branch on the remote for an SSH session.
   * Returns the branch name or null if not a git repo / connection failed.
   */
  async getRemoteBranch(sessionId: string, config: SSHConfig): Promise<string | null> {
    try {
      const client = await this.getConnection(sessionId, config);
      const result = await this.execCommand(client, `git -C "${config.remoteWorkdir}" rev-parse --abbrev-ref HEAD`);
      const branch = result.trim();
      return branch || null;
    } catch (error) {
      console.error(`[SSH Service] Failed to get remote branch for ${sessionId}:`, error);
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
        resolve();
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.on('close', () => {
        this.connections.delete(sessionId);
        console.log(`[SSH Service] Connection closed for session ${sessionId}`);

        // Stop health checks for this connection
        this.stopHealthCheck(sessionId);

        // Notify renderer of connection loss for immediate UI feedback
        try {
          const { BrowserWindow } = require('electron');
          const { IPC_CHANNELS: channels } = require('../../shared/constants/channels');
          const windows = BrowserWindow.getAllWindows();
          for (const win of windows) {
            win.webContents.send(channels.SSH_CONNECTION_LOST, { sessionId, reason: 'SSH connection closed unexpectedly' });
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
  private async getConnection(sessionId: string, config: SSHConfig): Promise<Client> {
    const existing = this.connections.get(sessionId);
    if (existing) {
      // Verify the connection is still alive — half-dead TCP connections
      // may linger in the map without triggering the 'close' event
      const socket = (existing.client as any)._sock;
      if (socket && (socket.destroyed || !socket.writable)) {
        console.warn(`[SSH Service] Cached connection for ${sessionId} has a dead socket — removing stale entry`);
        this.connections.delete(sessionId);
        this.stopHealthCheck(sessionId);
        // Fall through to create a new connection
      } else {
        // Active liveness probe — run a trivial command to confirm the connection
        // actually works. Tailscale can keep the TCP socket alive while blocking SSH.
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('SSH ping timeout')), 5000);
            existing.client.exec('echo ok', (err, channel) => {
              clearTimeout(timeout);
              if (err) return reject(err);
              channel.on('close', () => resolve());
              channel.on('data', () => {}); // drain
              channel.stderr.on('data', () => {}); // drain
            });
          });
          return existing.client;
        } catch (err) {
          console.warn(`[SSH Service] Cached connection for ${sessionId} failed liveness probe: ${err} — reconnecting`);
          existing.client.end();
          this.connections.delete(sessionId);
          this.stopHealthCheck(sessionId);
          // Fall through to create a new connection
        }
      }
    }

    await this.connect(sessionId, config);
    const conn = this.connections.get(sessionId);
    if (!conn) {
      throw new Error('Failed to establish connection');
    }
    return conn.client;
  }

  private getRemoteBridgeInstallKey(config: SSHConfig): string {
    return `${config.username}@${config.host}:${config.port || 22}`;
  }

  private quoteForShell(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private getRemoteCommandPathPrefix(config: SSHConfig): string {
    return `export PATH="/home/${config.username}/.local/bin:/home/${config.username}/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"`;
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
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const jobDir = `/tmp/claudette-ssh-bridge/${safeSessionId}/${jobId}`;
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

    const envExports = Object.entries(options.env || {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `export ${key}="${value?.replace(/"/g, '\\"')}"`)
      .join('; ');

    const escapedArgs = options.args.map((arg) => {
      if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('{')) {
        return this.quoteForShell(arg);
      }
      return arg;
    }).join(' ');

    const cwdCommand = options.cwd ? `cd ${this.quoteForShell(options.cwd)} && ` : '';
    const exportCommand = envExports ? `${envExports}; ` : '';
    const command = `${this.getRemoteCommandPathPrefix(config)} && ${cwdCommand}${exportCommand}exec ${options.command} ${escapedArgs}`;

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

          ch.on('data', (data: Buffer) => {
            passThrough.stdout.write(data);
          });

          ch.stderr.on('data', (data: Buffer) => {
            passThrough.stdout.write(data);
          });

          ch.on('close', (code: number, signal: string) => {
            exitCode = code;
            emitter.emit('exit', code, signal as NodeJS.Signals | null);
            passThrough.stdout.end();
            options.signal?.removeEventListener('abort', abortHandler);
          });

          ch.on('exit', (code: number, signal: string) => {
            exitCode = code;
            emitter.emit('exit', code, signal as NodeJS.Signals | null);
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
    let stdinBridgeReady = false;
    let stdinEnded = false;
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

    const openStdinBridge = async (): Promise<void> => {
      if (finalized || killed || fallbackProcess || stdinBridgeReady || stdinBridgeChannel) return;
      const install = await this.ensureDetachedRemoteBridge(sessionId, config);
      const client = await this.getConnection(sessionId, config);
      const command = `${this.getRemoteCommandPathPrefix(config)} && ${install.nodeCommand} ${this.quoteForShell(install.bridgePath)} stdin ${this.quoteForShell(bridge.socketPath)}`;

      await new Promise<void>((resolve, reject) => {
        client.exec(command, (err, channel) => {
          if (err) {
            reject(err);
            return;
          }

          stdinBridgeChannel = channel;
          stdinBridgeReady = true;

          channel.on('close', () => {
            stdinBridgeReady = false;
            stdinBridgeChannel = null;
          });
          channel.on('error', () => {
            stdinBridgeReady = false;
            stdinBridgeChannel = null;
          });
          channel.stderr.on('data', () => {
            // Ignore bridge helper stderr. Connection errors are surfaced via close/error.
          });

          for (const chunk of pendingData) {
            channel.stdin.write(chunk);
          }
          pendingData.length = 0;

          if (stdinEnded && closeStdinOnEnd) {
            this.execCommand(client, `touch ${this.quoteForShell(bridge.eofPath)}`).catch((error) => {
              console.warn('[SSH Service] Failed to signal remote stdin EOF:', error);
            });
          }

          resolve();
        });
      });
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
      if (stdinBridgeReady && stdinBridgeChannel) {
        stdinBridgeChannel.stdin.write(data);
      } else {
        pendingData.push(data);
        void openStdinBridge().catch((error) => {
          console.warn('[SSH Service] Failed to attach remote stdin bridge:', error);
        });
      }
    });

    passThrough.stdin.on('end', () => {
      stdinEnded = true;
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

  private async launchDetachedRemoteBridge(
    sessionId: string,
    config: SSHConfig,
    bridge: DetachedRemoteBridgeConfig
  ): Promise<void> {
    const install = await this.ensureDetachedRemoteBridge(sessionId, config);
    const client = await this.getConnection(sessionId, config);

    await this.execCommand(client, `mkdir -p ${this.quoteForShell(bridge.jobDir)}`);
    await this.writeRemoteFile(sessionId, config, `${bridge.jobDir}/config.json`, JSON.stringify(bridge, null, 2));

    const startCommand = `${this.getRemoteCommandPathPrefix(config)} && nohup ${install.nodeCommand} ${this.quoteForShell(install.bridgePath)} spawn ${this.quoteForShell(`${bridge.jobDir}/config.json`)} >/dev/null 2>&1 </dev/null &`;
    await this.execCommand(client, startCommand);

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
    // Build environment exports - only include essential variables for Claude
    // We explicitly whitelist rather than blacklist to avoid sending local machine paths/configs
    // NOTE: ANTHROPIC_API_KEY is NOT sent — the remote machine should use its own OAuth login.
    // Sending the local API key would override the remote's auth and bill to the API account.
    const includeVars = [
      'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CODE_ENTRYPOINT',
      'TERM',
      'LANG',
    ];
    const filteredEnv = Object.fromEntries(Object.entries(sdkOptions.env)
      .filter(([key, value]) => value !== undefined && includeVars.includes(key))
    ) as Record<string, string | undefined>;

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

    // Use direct SSH exec — the detached bridge is unreliable and causes
    // orphaned processes, channel conflicts, and reconnection failures.
    // TODO: Replace with tmux-based persistence when implemented.
    return this.createDirectCommandProcess(sessionId, config, {
      command: 'claude',
      args: filteredArgs,
      cwd: config.remoteWorkdir,
      env: filteredEnv,
      signal: sdkOptions.signal,
      closeStdinOnEnd: false,
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
    // Stop health check first
    this.stopHealthCheck(sessionId);

    const conn = this.connections.get(sessionId);
    if (conn) {
      try {
        conn.client.end();
      } catch (error) {
        console.error('[SSH Service] Error disconnecting:', error);
      }
      this.connections.delete(sessionId);
    }
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
  private startHealthCheck(sessionId: string): void {
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

    // Check if local .claude directory exists
    try {
      await fsPromises.access(claudeDir);
    } catch {
      console.log('[SSH Service] No local ~/.claude directory, skipping sync');
      return { success: true }; // Nothing to sync, but not an error
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

      // Configure git to use gh as credential helper on remote
      if (ghToken) {
        console.log('[SSH Service] Configuring git credential helper on remote...');
        try {
          await this.execCommand(client, 'git config --global credential.helper "!gh auth git-credential"');
        } catch (e) {
          console.log('[SSH Service] Could not configure git credential helper (gh may not be installed on remote)');
        }
      }

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
                  .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()) // Strip ANSI codes
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
      const client = await this.getConnection(sessionId, config);

      // Construct the expected path to the transcript file
      // Claude Code stores transcripts in ~/.claude/projects/<escaped-path>/<session-id>.jsonl
      // The escaped path replaces / with - and uses the absolute workdir path
      const escapedPath = remoteWorkdir.replace(/\//g, '-').replace(/^-/, '-');
      const transcriptPath = `~/.claude/projects/${escapedPath}/${sdkSessionId}.jsonl`;

      console.log('[SSH Service] Fetching remote transcript:', transcriptPath);

      const readCommand = options?.full
        ? `cat "${transcriptPath}" 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`
        : `tail -n 500 "${transcriptPath}" 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`;
      const result = await this.execCommand(
        client,
        readCommand
      );

      if (result.includes('___TRANSCRIPT_NOT_FOUND___')) {
        // Try alternative path format (just the directory name)
        const altPath = `~/.claude/projects/*/${sdkSessionId}.jsonl`;
        console.log('[SSH Service] Trying alternative transcript path:', altPath);

        const altReadCommand = options?.full
          ? `cat ${altPath} 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`
          : `tail -n 500 ${altPath} 2>/dev/null || echo "___TRANSCRIPT_NOT_FOUND___"`;
        const altResult = await this.execCommand(
          client,
          altReadCommand
        );

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
      const client = await this.getConnection(sessionId, config);

      // Construct the expected path to the transcripts directory
      const escapedPath = remoteWorkdir.replace(/\//g, '-').replace(/^-/, '-');
      const transcriptsDir = `~/.claude/projects/${escapedPath}`;

      console.log('[SSH Service] Listing remote transcripts in:', transcriptsDir);

      // List .jsonl files with their modification times, excluding agent files
      const result = await this.execCommand(
        client,
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

  /**
   * Scan for commands on a remote machine via SSH
   */
  async scanRemoteCommands(
    sessionId: string,
    config: SSHConfig,
    remoteWorkdir: string
  ): Promise<Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }>> {
    const commands: Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user commands (~/.claude/commands)
      const userCommandsScript = `
        find ~/.claude/commands -name "*.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userCommandsScript);
      commands.push(...this.parseRemoteCommands(userResult, 'user'));

      // Scan project commands in remoteWorkdir
      const projectCommandsScript = `
        find "${remoteWorkdir}" -path "*/.claude/commands/*.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectCommandsScript);
      commands.push(...this.parseRemoteCommands(projectResult, 'project'));

      console.log('[SSH Service] Found', commands.length, 'remote commands');
      return commands;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote commands:', error);
      return [];
    }
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
  ): Promise<Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }>> {
    const skills: Array<{ name: string; path: string; content: string; description?: string; scope: 'user' | 'project' }> = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user skills (~/.claude/skills/*/SKILL.md)
      const userSkillsScript = `
        find ~/.claude/skills -name "SKILL.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userSkillsScript);
      skills.push(...this.parseRemoteSkills(userResult, 'user'));

      // Scan project skills
      const projectSkillsScript = `
        find "${remoteWorkdir}" -path "*/.claude/skills/*/SKILL.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectSkillsScript);
      skills.push(...this.parseRemoteSkills(projectResult, 'project'));

      console.log('[SSH Service] Found', skills.length, 'remote skills');
      return skills;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote skills:', error);
      return [];
    }
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
  ): Promise<Array<{ name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' }>> {
    const agents: Array<{ name: string; description: string; systemPrompt: string; disallowedTools?: string[]; scope: 'user' | 'project' }> = [];

    try {
      const client = await this.getConnection(sessionId, config);

      // Scan user agents (~/.claude/agents/*.md)
      const userAgentsScript = `
        find ~/.claude/agents -name "*.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const userResult = await this.execCommand(client, userAgentsScript);
      agents.push(...this.parseRemoteAgents(userResult, 'user'));

      // Scan project agents
      const projectAgentsScript = `
        find "${remoteWorkdir}" -path "*/.claude/agents/*.md" -type f 2>/dev/null | while read f; do
          echo "___FILE_START___"
          echo "$f"
          cat "$f"
          echo "___FILE_END___"
        done
      `;
      const projectResult = await this.execCommand(client, projectAgentsScript);
      agents.push(...this.parseRemoteAgents(projectResult, 'project'));

      console.log('[SSH Service] Found', agents.length, 'remote agents');
      return agents;
    } catch (error) {
      console.error('[SSH Service] Failed to scan remote agents:', error);
      return [];
    }
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

    // Sync MCP server configs to remote ~/.claude/config.json
    try {
      const { mcpService } = await import('./mcp.service');
      const mcpServers = mcpService.getUserMcpServersConfig();

      if (Object.keys(mcpServers).length > 0) {
        console.log('[SSH Service] Syncing MCP servers to remote:', Object.keys(mcpServers));

        // Read existing remote config or create new one
        let remoteConfig: any = {};
        try {
          const stdout = await this.execCommand(client, 'cat ~/.claude/config.json 2>/dev/null || echo "{}"');
          remoteConfig = JSON.parse(stdout.trim() || '{}');
        } catch {
          remoteConfig = {};
        }

        // Merge MCP servers into remote config
        remoteConfig.mcpServers = mcpServers;

        // Write config to remote
        const configJson = JSON.stringify(remoteConfig, null, 2);
        const escapedConfig = configJson.replace(/'/g, "'\\''");
        await this.execCommand(client, `cat > ~/.claude/config.json << 'CONFIG_EOF'
${configJson}
CONFIG_EOF`);

        console.log('[SSH Service] MCP servers synced to remote ~/.claude/config.json');
      }
    } catch (err) {
      console.warn('[SSH Service] Could not sync MCP servers to remote:', err);
    }

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
      const { mcpService } = await import('./mcp.service');
      const mcpServers = mcpService.getUserMcpServersConfig();

      if (Object.keys(mcpServers).length === 0) {
        console.log('[SSH Service] No MCP servers to sync');
        return { success: true };
      }

      console.log('[SSH Service] Syncing MCP servers to session:', sessionId, Object.keys(mcpServers));

      // Read existing remote config or create new one
      let remoteConfig: any = {};
      try {
        const stdout = await this.execCommand(client, 'cat ~/.claude/config.json 2>/dev/null || echo "{}"');
        remoteConfig = JSON.parse(stdout.trim() || '{}');
      } catch {
        remoteConfig = {};
      }

      // Merge MCP servers into remote config
      remoteConfig.mcpServers = mcpServers;

      // Write config to remote
      const configJson = JSON.stringify(remoteConfig, null, 2);
      await this.execCommand(client, `cat > ~/.claude/config.json << 'CONFIG_EOF'
${configJson}
CONFIG_EOF`);

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
  private activeTunnels: Set<string> = new Set();

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
          if (err.message?.includes('address already in use') || err.message?.includes('EADDRINUSE')) {
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
            const net = require('net');
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
