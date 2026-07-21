import { EventEmitter } from 'events';

export type TurnState = 'IDLE' | 'STREAMING' | 'RECOVERING' | 'REATTACHING' | 'DRAINING';

export interface TurnTransition {
  sessionId: string;
  from: TurnState;
  to: TurnState;
  reason?: string;
  timestamp: number;
}

export interface RecoveryBudget {
  attempts: number;
  startedAt: number;
}

export interface TurnContext {
  state: TurnState;
  sessionId: string;
  startedAt: number;
  recovery: RecoveryBudget | null;
  streamAbort: AbortController | null;
}

class SessionTurnService extends EventEmitter {
  private turns = new Map<string, TurnContext>();

  private readonly MAX_RECOVERY_ATTEMPTS = 3;
  private readonly MAX_RECOVERY_MS = 60_000;

  getState(sessionId: string): TurnState {
    const context = this.turns.get(sessionId);
    return context?.state ?? 'IDLE';
  }

  getContext(sessionId: string): TurnContext | undefined {
    return this.turns.get(sessionId);
  }

  isActive(sessionId: string): boolean {
    const state = this.getState(sessionId);
    return state !== 'IDLE';
  }

  transition(sessionId: string, to: TurnState, reason?: string): TurnState {
    const current = this.turns.get(sessionId);
    const from = current?.state ?? 'IDLE';

    // Validate the transition
    if (!this.isValidTransition(from, to)) {
      console.warn(`[Turn] ${sessionId.slice(0, 8)}: Invalid transition ${from} → ${to} (${reason || 'no reason'})`);
      return from;
    }

    // Handle recovery budget when transitioning TO RECOVERING
    if (to === 'RECOVERING') {
      const recovery = current?.recovery;

      if (!recovery) {
        // Initialize recovery budget
        const newContext: TurnContext = current
          ? { ...current, state: to, recovery: { attempts: 1, startedAt: Date.now() } }
          : this.newContext(sessionId, to, { attempts: 1, startedAt: Date.now() });
        this.turns.set(sessionId, newContext);
        this.logAndEmitTransition(sessionId, from, to, reason);
        return to;
      } else {
        // Check if budget is exhausted
        const elapsed = Date.now() - recovery.startedAt;
        const attemptsExhausted = recovery.attempts >= this.MAX_RECOVERY_ATTEMPTS;
        const timeExhausted = elapsed >= this.MAX_RECOVERY_MS;

        if (attemptsExhausted || timeExhausted) {
          // Budget exhausted - force to IDLE and clear recovery
          const newContext: TurnContext = { ...current, state: 'IDLE', recovery: null };
          this.turns.set(sessionId, newContext);
          const budgetReason = attemptsExhausted
            ? `recovery attempts exhausted (${recovery.attempts}/${this.MAX_RECOVERY_ATTEMPTS})`
            : `recovery time exhausted (${elapsed}ms/${this.MAX_RECOVERY_MS}ms)`;
          this.logAndEmitTransition(sessionId, from, 'IDLE', budgetReason);
          return 'IDLE';
        } else {
          // Increment recovery budget
          const newContext: TurnContext = {
            ...current,
            state: to,
            recovery: { ...recovery, attempts: recovery.attempts + 1 }
          };
          this.turns.set(sessionId, newContext);
          this.logAndEmitTransition(sessionId, from, to, reason);
          return to;
        }
      }
    }

    // Clear recovery budget when transitioning TO IDLE
    let newContext: TurnContext;
    if (to === 'IDLE') {
      newContext = current
        ? { ...current, state: to, recovery: null }
        : this.newContext(sessionId, to, null);
    } else {
      newContext = current
        ? { ...current, state: to }
        : this.newContext(sessionId, to, null);
    }

    this.turns.set(sessionId, newContext);
    this.logAndEmitTransition(sessionId, from, to, reason);
    return to;
  }

  forceIdle(sessionId: string, reason?: string): void {
    const current = this.turns.get(sessionId);
    const from = current?.state ?? 'IDLE';

    if (from === 'IDLE') {
      return; // Already idle, nothing to do
    }

    const newContext: TurnContext = current
      ? { ...current, state: 'IDLE', recovery: null }
      : this.newContext(sessionId, 'IDLE', null);

    this.turns.set(sessionId, newContext);
    this.logAndEmitTransition(sessionId, from, 'IDLE', reason || 'forced');
  }

  cleanup(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  getRecoveryBudget(sessionId: string): RecoveryBudget | null {
    const context = this.turns.get(sessionId);
    return context?.recovery ?? null;
  }

  isRecoveryExhausted(sessionId: string): boolean {
    const context = this.turns.get(sessionId);
    if (!context?.recovery) {
      return false;
    }

    const elapsed = Date.now() - context.recovery.startedAt;
    const attemptsExhausted = context.recovery.attempts >= this.MAX_RECOVERY_ATTEMPTS;
    const timeExhausted = elapsed >= this.MAX_RECOVERY_MS;

    return attemptsExhausted || timeExhausted;
  }

  private newContext(sessionId: string, state: TurnState, recovery: RecoveryBudget | null): TurnContext {
    return {
      state,
      sessionId,
      startedAt: Date.now(),
      recovery,
      streamAbort: null,
    };
  }

  private isValidTransition(from: TurnState, to: TurnState): boolean {
    // Any → IDLE is always valid (user cancel / safety net)
    if (to === 'IDLE') {
      return true;
    }

    // Valid transitions per the spec
    switch (from) {
      case 'IDLE':
        return to === 'STREAMING' || to === 'DRAINING';

      case 'DRAINING':
        return to === 'STREAMING';

      case 'STREAMING':
        return to === 'RECOVERING';

      case 'RECOVERING':
        return to === 'REATTACHING';

      case 'REATTACHING':
        return to === 'RECOVERING';

      default:
        return false;
    }
  }

  private logAndEmitTransition(sessionId: string, from: TurnState, to: TurnState, reason?: string): void {
    const reasonStr = reason ? ` (${reason})` : '';
    console.log(`[Turn] ${sessionId.slice(0, 8)}: ${from} → ${to}${reasonStr}`);

    const transition: TurnTransition = {
      sessionId,
      from,
      to,
      reason,
      timestamp: Date.now(),
    };

    this.emit('transition', transition);
  }
}

export const sessionTurnService = new SessionTurnService();
