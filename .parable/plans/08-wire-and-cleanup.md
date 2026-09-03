# Plan: Wire new services into existing code + cleanup

## Intent
Wire the new SessionTurnService, RecoveryService, and QueueController into the existing IPC handlers. This is Phase 6 of the refactoring — the gnarly part that touches the 1652-line claude.ipc.ts and the 6000+ line claude.service.ts.

**IMPORTANT**: This phase runs ALONGSIDE the existing code initially. The state machine logs transitions in parallel with the existing behavior. Only after verification passes do we remove the old code paths.

## Scope
- **Modify**: `src/main/ipc/claude.ipc.ts`
- **Modify**: `src/main/services/claude.service.ts` (minimal — just import + call sessionTurnService)
- **Off-limits**: Do NOT delete the existing message-queue.service.ts yet. Add the new wiring alongside.

## Approach: Parallel run first

### Step 1: Import new services at the top of claude.ipc.ts
```typescript
import { sessionTurnService } from '../services/session-turn.service';
import { recoveryService } from '../services/recovery.service';
import { queueController } from '../services/queue-controller.service';
```

### Step 2: Add state machine transitions alongside existing code

In the SEND_MESSAGE handler (~line 603):
- After `messageQueueService.onStreamStart(sessionId, ...)`, add:
  `sessionTurnService.transition(sessionId, 'STREAMING', 'send-message');`

In the stream completion block (~line 912-958):
- After `sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, ...)`, add:
  ```typescript
  if (hadError && session?.sshConfig) {
    // Let recovery service handle it (parallel with existing reattach probe)
    void recoveryService.handleStreamError(sessionId, new Error('stream error'), session.sshConfig);
  } else {
    sessionTurnService.transition(sessionId, 'IDLE', hadError ? 'stream error (non-SSH)' : 'stream completed');
  }
  ```

In the RESUME_REMOTE_TURN handler (~line 976):
- After streaming starts, add:
  `sessionTurnService.transition(sessionId, 'REATTACHING', 'resume-remote-turn');`
- On completion, add:
  `sessionTurnService.transition(sessionId, 'IDLE', 'reattach completed');`

### Step 3: Wire queue controller alongside existing queue

The `queueController` listens to `sessionTurnService.on('transition')` automatically.
Add a parallel drain-ready listener:
```typescript
queueController.on('drain-ready', (sessionId: string) => {
  console.log(`[Queue Controller] drain-ready for ${sessionId.slice(0,8)} (parallel run — not yet active)`);
  // TODO: Phase 6b — replace the messageQueueService drain-ready handler with this one
});
```

### Step 4: Add diagnostic logging
```typescript
sessionTurnService.on('transition', ({ sessionId, from, to, reason }: TurnTransition) => {
  console.log(`[Turn] ${sessionId.slice(0,8)}: ${from} → ${to} (${reason || 'unknown'})`);
});
```

## What NOT to do yet
- Do NOT remove messageQueueService calls — they run in parallel
- Do NOT remove notifyQueueStreamEnd calls — they still drive the real drain
- Do NOT remove the 220-line drain decision tree — it's still active
- Do NOT change any renderer code

## Testing expectations
After wiring, the app should work exactly as before (existing code drives behavior), but transition logs should appear showing clean IDLE→STREAMING→IDLE cycles. Any "Invalid transition" warnings indicate a bug in the wiring.
