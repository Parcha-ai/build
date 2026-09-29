# Plan: Create RecoveryService

## Intent
Create a bounded SSH recovery service that replaces scattered reattach probe logic in the stream error handler, doomed-resume detector, and queue drain handler. One controller, bounded budget (3 attempts / 60s), clear escalation path.

## Scope
- **Create**: `src/main/services/recovery.service.ts`
- **Off-limits**: Do NOT modify any existing files.

## Conventions
- Electron main-process service in TypeScript
- Export singleton: `export const recoveryService = new RecoveryService()`
- Import `sessionTurnService` from `./session-turn.service` for state transitions
- Import types from `../../shared/types` for SSHConfig, Session
- Use lazy imports for sshService to avoid circular deps

## Read first
- `src/main/services/session-turn.service.ts` — the state machine this service controls
- `src/main/services/harness-transport.ts` — transport abstraction for SSH probing
- `src/shared/types/index.ts` — Session, SSHConfig types
- `src/main/ipc/claude.ipc.ts` lines 930-958 — the current reattach probe logic this replaces

## Specification

### Class: RecoveryService

```typescript
import { EventEmitter } from 'events';
import { sessionTurnService } from './session-turn.service';
import type { SSHConfig } from '../../shared/types';

export interface RecoveryResult {
  action: 'reattach' | 'idle' | 'exhausted';
  remotePid?: number;
  reason: string;
}

class RecoveryService extends EventEmitter {
  private readonly MAX_ATTEMPTS = 3;
  private readonly MAX_RECOVERY_MS = 60_000;

  /**
   * Handle a stream error. For SSH sessions, probes for surviving remote turns.
   * For non-SSH, transitions directly to IDLE.
   */
  async handleStreamError(
    sessionId: string,
    error: Error,
    sshConfig?: SSHConfig,
  ): Promise<RecoveryResult>

  /**
   * Handle reattach completion. If failed, re-enters recovery (budget permitting).
   */
  async handleReattachComplete(
    sessionId: string,
    result: { success: boolean; producedOutput: boolean; error?: Error },
    sshConfig?: SSHConfig,
  ): Promise<RecoveryResult>

  /**
   * Check if recovery is still possible for a session.
   */
  canRecover(sessionId: string): boolean

  /**
   * Force-end recovery for a session (user cancel).
   */
  cancelRecovery(sessionId: string): void
}
```

### handleStreamError logic
```
1. If no sshConfig → transition to IDLE, return { action: 'idle', reason: 'non-SSH session' }
2. Transition to RECOVERING
3. Check if state machine accepted it (it may have exhausted budget → forced to IDLE)
   - If state is now IDLE → return { action: 'exhausted', reason: 'recovery budget exhausted' }
4. Probe for surviving remote turn:
   - Import sshService lazily
   - Call sshService.getLatestRecoverableRemoteProcess(sessionId, sshConfig)
   - If job exists AND job.active AND NOT job.recovered:
     - Transition to REATTACHING
     - Emit 'reattach-needed' event with { sessionId, pid: job.pid }
     - Return { action: 'reattach', remotePid: job.pid, reason: 'remote turn alive' }
   - Else:
     - Transition to IDLE
     - Return { action: 'idle', reason: 'no recoverable remote turn' }
5. On probe error → transition to IDLE, return { action: 'idle', reason: error.message }
```

### handleReattachComplete logic
```
1. If result.success:
   - Transition to IDLE with reason 'reattach completed'
   - Return { action: 'idle', reason: 'reattach completed' }
2. If !result.success:
   - Re-enter handleStreamError with the error
   - Return whatever handleStreamError returns
```

### Events emitted
- `'reattach-needed'` with `{ sessionId: string; pid?: number }` — the IPC layer listens to send CLAUDE_REMOTE_TURN_RECOVERABLE to the renderer
- `'recovery-exhausted'` with `{ sessionId: string; attempts: number }` — for diagnostics

## Testing expectations
The file should compile cleanly. Lazy imports for sshService. No direct Electron imports.
