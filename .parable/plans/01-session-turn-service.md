# Plan: Create SessionTurnService (state machine)

## Intent
Create the foundational session turn state machine that replaces 15+ scattered boolean/map state variables with a single 5-state enum per session. This is Phase 1 of the session continuity refactoring.

## Scope
- **Create**: `src/main/services/session-turn.service.ts`
- **Off-limits**: Do NOT modify any existing files. This plan creates a new standalone file only.

## Conventions
- This is an Electron main-process service in TypeScript
- Export a singleton instance like other services in this directory (e.g., `export const sessionTurnService = new SessionTurnService()`)
- Use Node.js `EventEmitter` for transition events (same pattern as `message-queue.service.ts`)
- Use `Map<string, TurnContext>` for per-session state (keyed by sessionId)

## Specification

### Types to export

```typescript
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
```

### Valid transitions (enforce in code)

```
IDLE → STREAMING        (user sends message or drain forwards)
IDLE → DRAINING         (queue has messages)
DRAINING → STREAMING    (drain message sent to harness)
STREAMING → IDLE        (stream completed successfully)
STREAMING → RECOVERING  (stream errored, SSH session)
STREAMING → IDLE        (stream errored, non-SSH)
RECOVERING → REATTACHING (remote turn found alive)
RECOVERING → IDLE       (no remote turn / budget exhausted)
REATTACHING → IDLE      (reattach completed successfully)
REATTACHING → RECOVERING (reattach errored, retry budget remaining)
Any → IDLE              (user cancels)
```

### Class: SessionTurnService

```typescript
class SessionTurnService extends EventEmitter {
  private turns = new Map<string, TurnContext>();

  // Recovery budget constants
  private readonly MAX_RECOVERY_ATTEMPTS = 3;
  private readonly MAX_RECOVERY_MS = 60_000;

  getState(sessionId: string): TurnState
  getContext(sessionId: string): TurnContext | undefined
  isActive(sessionId: string): boolean  // true if not IDLE

  transition(sessionId: string, to: TurnState, reason?: string): TurnState
    // Returns the actual state transitioned to (may differ if budget exhausted)
    // - Validate transition is legal (log warning + return current state if not)
    // - If transitioning to RECOVERING: init or increment recovery budget
    //   - If budget exhausted (attempts > 3 OR elapsed > 60s): force to IDLE, clear recovery
    // - If transitioning to IDLE: clear recovery budget
    // - Update state, emit 'transition' event with TurnTransition payload
    // - Log: `[Turn] ${sessionId.slice(0,8)}: ${from} → ${to} (${reason})`

  forceIdle(sessionId: string, reason?: string): void
    // Force to IDLE from any state (user cancel, safety net)

  cleanup(sessionId: string): void
    // Remove all state for a session

  getRecoveryBudget(sessionId: string): RecoveryBudget | null

  isRecoveryExhausted(sessionId: string): boolean
    // Check without transitioning

  // Private helpers
  private newContext(sessionId: string): TurnContext
  private isValidTransition(from: TurnState, to: TurnState): boolean
    // Encode the transition table above. Any → IDLE is always valid.
}
```

### Events emitted
- `'transition'` with `TurnTransition` payload — emitted on every state change
- The queue controller (created separately) will listen to this event

### Key behaviors
1. Invalid transitions log a warning but do NOT throw — the system must be resilient
2. Recovery budget is tracked per-session: `{ attempts: number, startedAt: number }`
3. When recovery budget is exhausted, `transition(id, 'RECOVERING')` silently redirects to IDLE
4. `forceIdle` works from ANY state — it's the user-cancel escape hatch
5. State defaults to IDLE for unknown sessions (getState returns 'IDLE' for missing entries)
6. The AbortController in TurnContext is stored but NOT managed by this service — callers set it

## Testing expectations
The file should be self-contained with no imports from the project except Node.js built-ins (EventEmitter, crypto for nothing). It should compile cleanly with strict TypeScript.
