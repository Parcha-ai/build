# Plan: Create QueueController

## Intent
Create an active queue controller that observes the session turn state machine and self-drains when the state reaches IDLE. This replaces the passive queue with 7 external suppression points, the 220-line drain decision tree, and the `notifyQueueStreamEnd` pattern.

## Scope
- **Create**: `src/main/services/queue-controller.service.ts`
- **Off-limits**: Do NOT modify any existing files. This is a new standalone file.

## Conventions
- Electron main-process service in TypeScript
- Export singleton: `export const queueController = new QueueController()`
- Import `sessionTurnService` from `./session-turn.service`
- Import queue data types from `../../shared/types/message-queue`
- Use EventEmitter for drain-ready events

## Read first
- `src/main/services/session-turn.service.ts` — the state machine this controller observes
- `src/main/services/message-queue.service.ts` — the current queue service being replaced
- `src/shared/types/message-queue.ts` — QueuedMessage and QueueState types
- `src/main/services/harness-capabilities.ts` — getHarnessCapabilities for minTurnGapMs

## Specification

### Class: QueueController

```typescript
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { sessionTurnService } from './session-turn.service';
import type { QueuedMessage, QueueState } from '../../shared/types/message-queue';
import type { Harness } from '../../shared/types';
import { getHarnessCapabilities } from './harness-capabilities';

class QueueController extends EventEmitter {
  // Data storage (migrated from message-queue.service.ts)
  private queues = new Map<string, QueuedMessage[]>();
  private activeHarness = new Map<string, string>();

  // Safety net timers
  private safetyTimers = new Map<string, NodeJS.Timeout>();
  private drainTimers = new Map<string, NodeJS.Timeout>();

  // Constants
  private readonly SAFETY_NET_MS = 90_000;  // Force IDLE after 90s stuck
  private readonly DEFAULT_DRAIN_DELAY_MS = 100;

  constructor() {
    super();
    // Core: react to state machine transitions
    sessionTurnService.on('transition', ({ sessionId, from, to }) => {
      if (to === 'IDLE' && this.hasMessages(sessionId)) {
        const harness = this.activeHarness.get(sessionId);
        const caps = getHarnessCapabilities(harness);
        const delay = caps.minTurnGapMs || this.DEFAULT_DRAIN_DELAY_MS;
        this.scheduleDrain(sessionId, delay);
      }
      // Clear safety timer when making progress
      if (to === 'STREAMING' || to === 'REATTACHING') {
        this.clearSafetyTimer(sessionId);
      }
    });
  }
```

### Public API (data management — same as message-queue.service.ts)

```typescript
  // Enqueue a message
  enqueue(sessionId: string, text: string, attachments?: unknown[], opts?: {
    id?: string;
    model?: string;
    suppressUserMessage?: boolean;
  }): QueuedMessage
    // Dedup by content within 10s
    // If IDLE, drain immediately. Otherwise arm safety timer.

  // Remove a message from queue
  remove(sessionId: string, messageId: string): void

  // Edit a queued message
  edit(sessionId: string, messageId: string, newText: string): void

  // Move to front
  moveToFront(sessionId: string, messageId: string): void

  // Clear queue
  clear(sessionId: string): void

  // Get current state
  getState(sessionId: string): QueueState

  // Set active harness
  setActiveHarness(sessionId: string, harness?: string): void

  // Peek at next message
  peek(sessionId: string): QueuedMessage | undefined

  // Dequeue for drain (removes from queue, builds combined message)
  dequeueForDrain(sessionId: string): QueuedMessage | undefined

  // Peek at drain batch without removing
  peekForDrain(sessionId: string): QueuedMessage | undefined

  // Acknowledge a drain (remove source messages)
  ackDrain(sessionId: string, sourceIds?: string[]): void

  // Query
  hasMessages(sessionId: string): boolean
  length(sessionId: string): number

  // Cleanup
  cleanup(sessionId: string): void
```

### Key differences from message-queue.service.ts

1. **NO onStreamStart/onStreamEnd** — the state machine handles this
2. **NO streaming/processing/drainDeferredSince/remoteActiveDrainAllowed maps** — state machine replaces all of these
3. **NO external drain suppression** — the queue decides based on state machine state
4. **Safety timer** — if messages are queued > 90s with no IDLE transition, force IDLE

### Safety timer logic

```typescript
  private armSafetyTimer(sessionId: string): void {
    if (this.safetyTimers.has(sessionId)) return;
    this.safetyTimers.set(sessionId, setTimeout(() => {
      this.safetyTimers.delete(sessionId);
      if (this.hasMessages(sessionId) && sessionTurnService.getState(sessionId) !== 'IDLE') {
        console.warn(`[Queue] Safety net: forcing IDLE for ${sessionId.slice(0,8)} after ${this.SAFETY_NET_MS}ms`);
        sessionTurnService.forceIdle(sessionId, 'queue safety net');
        // The transition handler will trigger drain
      }
    }, this.SAFETY_NET_MS));
  }

  private clearSafetyTimer(sessionId: string): void {
    const timer = this.safetyTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.safetyTimers.delete(sessionId);
    }
  }
```

### scheduleDrain (private)

```typescript
  private scheduleDrain(sessionId: string, delayMs: number): void {
    const existing = this.drainTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    if (!this.hasMessages(sessionId)) return;

    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      const state = sessionTurnService.getState(sessionId);
      if (state === 'IDLE' && this.hasMessages(sessionId)) {
        this.emit('drain-ready', sessionId);
      }
    }, delayMs);
    this.drainTimers.set(sessionId, timer);
  }
```

### buildDrainMessage (private)
Same logic as current message-queue.service.ts `buildDrainMessage`:
- Single message: return as-is with sourceIds/sourceCount
- Multiple: combine text with `\n\n`, flatten attachments, use last model

### Events emitted
- `'drain-ready'` with sessionId — the IPC layer listens to dequeue and send
- `'state-changed'` with sessionId and QueueState — for renderer updates

## Testing expectations
File compiles cleanly. No Electron imports. Only imports from session-turn.service, harness-capabilities, and shared types.
