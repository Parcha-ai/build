import type { Session, SSHConfig } from '../../shared/types';

/**
 * Recoverable process information returned by SSH transport
 */
export interface RecoverableProcess {
  active: boolean;
  recovered: boolean;
  pid?: number;
  jobDir?: string;
  logBytes?: number;
}

/**
 * Abstraction for where Claude Code turns execute — local or SSH remote.
 * Lets stream lifecycle code be identical regardless of transport.
 */
export interface HarnessTransport {
  readonly kind: 'local' | 'ssh';

  /**
   * Check if a remote turn is still alive (SSH only; local always returns false).
   */
  isRemoteTurnAlive(sessionId: string): Promise<boolean>;

  /**
   * Get the latest recoverable remote process info.
   * Returns null for local transport.
   */
  getRecoverableProcess(sessionId: string): Promise<RecoverableProcess | null>;

  /**
   * Push local files to remote working directory (SSH only; local is a no-op).
   * Not implemented yet — returns 0 for all transports.
   */
  pushFiles(localDir: string, remoteDir: string): Promise<number>;

  /**
   * Read a file from the working environment.
   * For local: reads from local filesystem.
   * For SSH: reads from remote via SSH.
   */
  readFile(path: string): Promise<string>;

  /**
   * Clean up detached processes for a new turn.
   * For local: no-op.
   * For SSH: cleans up bridge processes.
   */
  cleanupForNewTurn(sessionId: string, opts?: { killActive?: boolean }): Promise<void>;

  /**
   * Get the working directory for this transport.
   */
  getWorkdir(): string;

  /**
   * Get the SSH config if this is an SSH transport.
   */
  getSSHConfig(): SSHConfig | undefined;
}

/**
 * Local transport — all remote operations return safe defaults
 */
export class LocalTransport implements HarnessTransport {
  readonly kind = 'local' as const;

  constructor(private workdir: string) {}

  async isRemoteTurnAlive(): Promise<boolean> {
    return false;
  }

  async getRecoverableProcess(): Promise<null> {
    return null;
  }

  async pushFiles(): Promise<number> {
    return 0;
  }

  async readFile(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }

  async cleanupForNewTurn(): Promise<void> {
    // No-op for local
  }

  getWorkdir(): string {
    return this.workdir;
  }

  getSSHConfig(): undefined {
    return undefined;
  }
}

/**
 * SSH transport — delegates to sshService for remote operations
 */
export class SSHTransport implements HarnessTransport {
  readonly kind = 'ssh' as const;

  constructor(
    private sessionId: string,
    private sshConfig: SSHConfig,
    private workdir: string,
  ) {}

  async isRemoteTurnAlive(): Promise<boolean> {
    try {
      const { sshService } = await import('./ssh.service');
      return await sshService.hasActiveRemoteProcess(this.sessionId, this.sshConfig);
    } catch (error) {
      return false;
    }
  }

  async getRecoverableProcess(): Promise<RecoverableProcess | null> {
    try {
      const { sshService } = await import('./ssh.service');
      const job = await sshService.getLatestRecoverableRemoteProcess(this.sessionId, this.sshConfig);
      if (!job) return null;
      return {
        active: Boolean(job.active),
        recovered: Boolean(job.recovered),
        pid: job.pid ? Number(job.pid) : undefined,
        jobDir: job.jobDir,
        logBytes: job.logBytes,
      };
    } catch (error) {
      return null;
    }
  }

  async pushFiles(): Promise<number> {
    // Not implemented yet — uploadDirectoryViaSftp is private
    // Will need to expose a public method in sshService if this becomes needed
    return 0;
  }

  async readFile(filePath: string): Promise<string> {
    const { sshService } = await import('./ssh.service');
    return sshService.readRemoteFile(this.sessionId, this.sshConfig, filePath);
  }

  async cleanupForNewTurn(sessionId: string, opts?: { killActive?: boolean }): Promise<void> {
    try {
      const { sshService } = await import('./ssh.service');
      await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, this.sshConfig, opts || {});
    } catch (error) {
      // Silent fail — cleanup is best-effort
    }
  }

  getWorkdir(): string {
    return this.workdir;
  }

  getSSHConfig(): SSHConfig {
    return this.sshConfig;
  }
}

/**
 * Factory function: creates the appropriate transport based on session config
 */
export function createTransport(session: Session): HarnessTransport {
  if (session.sshConfig) {
    return new SSHTransport(
      session.id,
      session.sshConfig,
      session.sshConfig.remoteWorkdir,
    );
  }
  return new LocalTransport(session.worktreePath || session.repoPath || process.cwd());
}
