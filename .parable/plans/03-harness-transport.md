# Plan: Create HarnessTransport abstraction

## Intent
Create an interface and two implementations (LocalTransport, SSHTransport) that abstract away the "where does the turn run" question. Currently SSH-specific checks are scattered across IPC handlers, queue service, and claude.service.ts. This abstraction lets the stream lifecycle be identical regardless of transport.

## Scope
- **Create**: `src/main/services/harness-transport.ts`
- **Off-limits**: Do NOT modify any existing files. This plan creates a new standalone file only.

## Conventions
- This is an Electron main-process module
- Export the interface and both implementations
- Export a factory function: `createTransport(session: Session): HarnessTransport`
- Import types from `../../shared/types` for `Session`, `SSHConfig`

## Read first
Read `src/shared/types/index.ts` for the `Session` and `SSHConfig` interfaces.

## Specification

### Interface

```typescript
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

export interface RecoverableProcess {
  active: boolean;
  recovered: boolean;
  pid?: number;
  jobDir?: string;
  logBytes?: number;
}
```

### LocalTransport

```typescript
export class LocalTransport implements HarnessTransport {
  readonly kind = 'local' as const;

  constructor(private workdir: string) {}

  async isRemoteTurnAlive(): Promise<boolean> { return false; }
  async getRecoverableProcess(): Promise<null> { return null; }
  async pushFiles(): Promise<number> { return 0; }
  async readFile(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  async cleanupForNewTurn(): Promise<void> {}
  getWorkdir(): string { return this.workdir; }
  getSSHConfig(): undefined { return undefined; }
}
```

### SSHTransport

```typescript
export class SSHTransport implements HarnessTransport {
  readonly kind = 'ssh' as const;

  constructor(
    private sessionId: string,
    private sshConfig: SSHConfig,
    private workdir: string,
  ) {}

  async isRemoteTurnAlive(): Promise<boolean> {
    // Delegate to sshService.hasActiveRemoteProcess
    // Import sshService lazily to avoid circular deps
    const { sshService } = await import('./ssh.service');
    return sshService.hasActiveRemoteProcess(this.sessionId, this.sshConfig).catch(() => false);
  }

  async getRecoverableProcess(): Promise<RecoverableProcess | null> {
    const { sshService } = await import('./ssh.service');
    const job = await sshService.getLatestRecoverableRemoteProcess(this.sessionId, this.sshConfig).catch(() => null);
    if (!job) return null;
    return {
      active: Boolean(job.active),
      recovered: Boolean(job.recovered),
      pid: job.pid,
      jobDir: job.jobDir,
      logBytes: job.logBytes,
    };
  }

  async pushFiles(localDir: string, remoteDir: string): Promise<number> {
    const { sshService } = await import('./ssh.service');
    return sshService.pushDirectory(this.sessionId, this.sshConfig, localDir, remoteDir).catch(() => 0);
  }

  async readFile(filePath: string): Promise<string> {
    const { sshService } = await import('./ssh.service');
    return sshService.readRemoteFile(this.sessionId, this.sshConfig, filePath);
  }

  async cleanupForNewTurn(sessionId: string, opts?: { killActive?: boolean }): Promise<void> {
    const { sshService } = await import('./ssh.service');
    await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, this.sshConfig, opts || {});
  }

  getWorkdir(): string { return this.workdir; }
  getSSHConfig(): SSHConfig { return this.sshConfig; }
}
```

### Factory function

```typescript
export function createTransport(session: { sshConfig?: SSHConfig; repoPath?: string; worktreePath?: string }): HarnessTransport {
  if (session.sshConfig) {
    // For SSH, sessionId isn't known here — caller must use the sessionId-bearing methods
    // We use a placeholder; the real sessionId comes from the calling context
    return new SSHTransport('', session.sshConfig, session.sshConfig.remoteWorkdir);
  }
  return new LocalTransport(session.worktreePath || session.repoPath || process.cwd());
}
```

## Important notes
- Use lazy `await import()` for sshService to avoid circular dependency issues
- The SSHTransport methods that delegate to sshService should catch errors and return safe defaults
- sshService methods referenced here (`hasActiveRemoteProcess`, `getLatestRecoverableRemoteProcess`, `cleanupDetachedBridgeProcessesForNewTurn`) already exist — check their signatures by reading `src/main/services/ssh.service.ts`
- If sshService methods don't match exactly, adapt the delegation to match the actual signatures

## Testing expectations
The file should compile cleanly with strict TypeScript. The lazy imports mean it won't fail if sshService isn't available during type-checking.
