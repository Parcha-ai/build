import { EventEmitter } from 'events';
import { sessionTurnService } from './session-turn.service';
import type { SSHConfig } from '../../shared/types';

export interface RecoveryResult {
  action: 'reattach' | 'idle' | 'exhausted';
  remotePid?: number;
  reason: string;
}

interface SSHService {
  getLatestRecoverableRemoteProcess(sessionId: string, sshConfig: SSHConfig): Promise<{ pid: number; active: boolean; recovered?: boolean } | null>;
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
  ): Promise<RecoveryResult> {
    // Non-SSH sessions: transition directly to IDLE
    if (!sshConfig) {
      sessionTurnService.transition(sessionId, 'IDLE', 'non-SSH stream error');
      return { action: 'idle', reason: 'non-SSH session' };
    }

    // SSH session: attempt recovery
    // Transition to RECOVERING (state machine will check budget)
    const newState = sessionTurnService.transition(sessionId, 'RECOVERING', error.message);

    // If state machine forced us to IDLE, budget is exhausted
    if (newState === 'IDLE') {
      const budget = sessionTurnService.getRecoveryBudget(sessionId);
      const reason = budget
        ? `recovery budget exhausted (${budget.attempts}/${this.MAX_ATTEMPTS} attempts)`
        : 'recovery budget exhausted';
      this.emit('recovery-exhausted', { sessionId, attempts: budget?.attempts ?? 0 });
      return { action: 'exhausted', reason };
    }

    // Probe for surviving remote turn
    try {
      // Lazy import to avoid circular dependency
      const { sshService } = await import('./ssh.service') as { sshService: SSHService };
      const job = await sshService.getLatestRecoverableRemoteProcess(sessionId, sshConfig);

      if (job?.active && !job.recovered) {
        // Remote turn is alive and not yet recovered
        sessionTurnService.transition(sessionId, 'REATTACHING', `remote pid ${job.pid} alive`);
        this.emit('reattach-needed', { sessionId, pid: job.pid });
        return { action: 'reattach', remotePid: job.pid, reason: 'remote turn alive' };
      } else {
        // No recoverable remote turn found
        sessionTurnService.transition(sessionId, 'IDLE', 'no recoverable remote turn');
        return { action: 'idle', reason: 'no recoverable remote turn' };
      }
    } catch (probeError) {
      // Probe failed - transition to IDLE
      const errorMsg = probeError instanceof Error ? probeError.message : String(probeError);
      console.warn(`[Recovery] Probe failed for ${sessionId.slice(0, 8)}:`, errorMsg);
      sessionTurnService.transition(sessionId, 'IDLE', `probe error: ${errorMsg}`);
      return { action: 'idle', reason: errorMsg };
    }
  }

  /**
   * Handle reattach completion. If failed, re-enters recovery (budget permitting).
   */
  async handleReattachComplete(
    sessionId: string,
    result: { success: boolean; producedOutput: boolean; error?: Error },
    sshConfig?: SSHConfig,
  ): Promise<RecoveryResult> {
    if (result.success) {
      // Successful reattach - transition to IDLE
      sessionTurnService.transition(sessionId, 'IDLE', 'reattach completed');
      return { action: 'idle', reason: 'reattach completed' };
    } else {
      // Failed reattach - re-enter recovery
      const error = result.error ?? new Error('Reattach failed without output');
      return this.handleStreamError(sessionId, error, sshConfig);
    }
  }

  /**
   * Check if recovery is still possible for a session.
   */
  canRecover(sessionId: string): boolean {
    return !sessionTurnService.isRecoveryExhausted(sessionId);
  }

  /**
   * Force-end recovery for a session (user cancel).
   */
  cancelRecovery(sessionId: string): void {
    sessionTurnService.forceIdle(sessionId, 'recovery cancelled by user');
  }
}

export const recoveryService = new RecoveryService();
