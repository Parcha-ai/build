import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { QueuedMessage, QueueState } from '../../shared/types/message-queue';
import type { Harness } from '../../shared/types';
import { getHarnessCapabilities } from './harness-capabilities';

class MessageQueueService extends EventEmitter {
  // Per-session queues
  private queues = new Map<string, QueuedMessage[]>();
  // Per-session processing state
  private processing = new Map<string, boolean>();
  // Per-session active harness
  private activeHarness = new Map<string, string>();
  // Per-session streaming state
  private streaming = new Map<string, boolean>();
  // Drain timers
  private drainTimers = new Map<string, NodeJS.Timeout>();
  // When a drain is being deferred because another runtime still appears active.
  private drainDeferredSince = new Map<string, number>();
  // Set after a completed stream result. SSH bridge processes can remain alive
  // briefly for background task events; one queued drain may pass that bridge.
  private remoteActiveDrainAllowed = new Set<string>();
  // Fast Stack holds every non-selected queued prompt across the cancellation
  // gap and through the one-shot forked turn. The first stream end belongs to
  // the cancelled parent; the second belongs to the Fast Stack run.
  private fastStackPhase = new Map<string, 'cancelling' | 'running'>();

  // Enqueue a message for a session
  enqueue(sessionId: string, text: string, attachments?: unknown[], opts?: { id?: string; model?: string; suppressUserMessage?: boolean; deferDrain?: boolean }): QueuedMessage {
    const existingQueue = this.queues.get(sessionId) || [];
    const normalizedText = text.trim();
    // A caller-supplied ID is the authoritative idempotency key. Distinct
    // voice requests may intentionally repeat the same words and must remain
    // distinct queue entries; transport retries reuse the same ID.
    const existing = opts?.id
      ? existingQueue.find((message) => message.id === opts.id)
      : existingQueue.find((message) =>
        normalizedText.length > 0
        && message.text.trim() === normalizedText
        && Date.now() - message.timestamp < 10_000
      );
    if (existing) {
      return existing;
    }

    const msg: QueuedMessage = {
      id: opts?.id || randomUUID(),
      sessionId,
      text,
      attachments,
      timestamp: Date.now(),
      model: opts?.model,
      suppressUserMessage: opts?.suppressUserMessage,
    };
    const queue = existingQueue;
    queue.push(msg);
    this.queues.set(sessionId, queue);
    if (opts?.deferDrain) {
      // "Remote may still be active" is a deferred probe, not a drain in
      // progress. Marking it processing can permanently suppress the only
      // timer that would discover the runtime is actually idle.
      this.processing.set(sessionId, false);
      this.emitStateChange(sessionId);
      this.scheduleDrain(sessionId, 250);
      return msg;
    }
    this.emitStateChange(sessionId);

    // If not streaming, drain immediately. Harnesses that explicitly support
    // active-turn injection can also drain mid-stream from main, keeping queue
    // state and injection updated atomically.
    this.scheduleDrain(sessionId, 0);
    return msg;
  }

  // Remove a message from the queue
  remove(sessionId: string, messageId: string): void {
    const queue = this.queues.get(sessionId) || [];
    this.queues.set(sessionId, queue.filter(m => m.id !== messageId));
    this.emitStateChange(sessionId);
  }

  // Edit a queued message
  edit(sessionId: string, messageId: string, newText: string): void {
    const queue = this.queues.get(sessionId) || [];
    const msg = queue.find(m => m.id === messageId);
    if (msg) {
      msg.text = newText;
      this.emitStateChange(sessionId);
    }
  }

  // Move a message to the front of the queue
  moveToFront(sessionId: string, messageId: string): void {
    const queue = this.queues.get(sessionId) || [];
    const idx = queue.findIndex(m => m.id === messageId);
    if (idx > 0) {
      const [msg] = queue.splice(idx, 1);
      queue.unshift(msg);
      this.emitStateChange(sessionId);
    }
  }

  // Clear the entire queue for a session
  clear(sessionId: string): void {
    this.queues.set(sessionId, []);
    this.processing.set(sessionId, false);
    this.drainDeferredSince.delete(sessionId);
    this.remoteActiveDrainAllowed.delete(sessionId);
    this.fastStackPhase.delete(sessionId);
    const timer = this.drainTimers.get(sessionId);
    if (timer) { clearTimeout(timer); this.drainTimers.delete(sessionId); }
    this.emitStateChange(sessionId);
  }

  // Get current queue state for a session
  getState(sessionId: string): QueueState {
    return {
      messages: this.queues.get(sessionId) || [],
      isProcessing: this.processing.get(sessionId) || false,
      activeHarness: this.activeHarness.get(sessionId) as Harness | undefined,
    };
  }

  // Called when a stream starts for a session
  onStreamStart(sessionId: string, harness?: string): void {
    this.streaming.set(sessionId, true);
    this.processing.set(sessionId, false);
    this.drainDeferredSince.delete(sessionId);
    this.remoteActiveDrainAllowed.delete(sessionId);
    if (harness) this.activeHarness.set(sessionId, harness);
    this.emitStateChange(sessionId);
  }

  setActiveHarness(sessionId: string, harness?: string): void {
    if (!harness) return;
    this.activeHarness.set(sessionId, harness);
    this.emitStateChange(sessionId);
  }

  // Called when a stream ends for a session -- triggers drain by default.
  onStreamEnd(sessionId: string, opts?: { drain?: boolean; allowRemoteActiveDrain?: boolean }): void {
    this.streaming.set(sessionId, false);
    this.processing.set(sessionId, false);
    const fastStackPhase = this.fastStackPhase.get(sessionId);
    if (fastStackPhase === 'cancelling') {
      // The parent was intentionally interrupted. Keep the queue frozen until
      // the renderer marks the forked replacement turn as running.
      this.emitStateChange(sessionId);
      return;
    }
    if (fastStackPhase === 'running') {
      // The replacement turn is complete, but its renderer STREAM_END may not
      // have been reduced yet. Keep siblings held until the renderer finishes
      // its send promise and explicitly releases the Fast Stack phase.
      this.emitStateChange(sessionId);
      return;
    }
    if (opts?.allowRemoteActiveDrain) {
      this.remoteActiveDrainAllowed.add(sessionId);
    } else {
      this.remoteActiveDrainAllowed.delete(sessionId);
    }
    if (opts?.drain === false) {
      const timer = this.drainTimers.get(sessionId);
      if (timer) { clearTimeout(timer); this.drainTimers.delete(sessionId); }
      this.emitStateChange(sessionId);
      return;
    }
    const harness = this.activeHarness.get(sessionId);
    const caps = getHarnessCapabilities(harness);
    const delay = caps.minTurnGapMs || 100;
    this.scheduleDrain(sessionId, delay);
    this.emitStateChange(sessionId);
  }

  // Peek at the next message without removing it
  peek(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    return queue[0];
  }

  // Dequeue the next message (removes from queue)
  dequeue(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    const msg = queue.shift();
    if (msg) {
      this.processing.set(sessionId, true);
      this.emitStateChange(sessionId);
    }
    return msg;
  }

  // Build the next drain turn without mutating queue state.
  private buildDrainMessage(queue: QueuedMessage[]): QueuedMessage | undefined {
    if (queue.length === 0) return undefined;

    if (queue.length === 1) {
      return {
        ...queue[0],
        sourceIds: [queue[0].id],
        sourceCount: 1,
      };
    }

    const firstVisible = queue.find((message) => !message.suppressUserMessage);
    const primary = firstVisible || queue[0];
    const attachments = queue.flatMap((message) => message.attachments || []);
    const text = queue
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join('\n\n');

    return {
      ...primary,
      id: primary.id,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: queue[0].timestamp,
      model: queue[queue.length - 1].model || primary.model,
      suppressUserMessage: queue.every((message) => message.suppressUserMessage),
      sourceIds: queue.map((message) => message.id),
      sourceCount: queue.length,
    };
  }

  // Drain every pending message as a single ordered turn.
  dequeueForDrain(sessionId: string): QueuedMessage | undefined {
    const next = this.peekForDrain(sessionId);
    if (!next) return undefined;

    this.ackDrain(sessionId, next.sourceIds, { keepProcessing: true });
    return next;
  }

  // Peek at the next drain batch without removing it. Active-query injection
  // uses this so queued prompts are only removed after Query.streamInput acks.
  peekForDrain(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    return this.buildDrainMessage(queue);
  }

  beginDrainAttempt(sessionId: string): void {
    if (!this.hasMessages(sessionId)) return;
    this.processing.set(sessionId, true);
    this.emitStateChange(sessionId);
  }

  finishDrainAttempt(sessionId: string): void {
    this.processing.set(sessionId, false);
    this.emitStateChange(sessionId);
  }

  /** Reconcile stale renderer/runtime flags after main has proved there is no
   * local query and no remote process. The queue itself remains intact. */
  markRuntimeIdle(sessionId: string, opts?: { scheduleDrain?: boolean }): void {
    this.streaming.set(sessionId, false);
    this.processing.set(sessionId, false);
    this.remoteActiveDrainAllowed.delete(sessionId);
    this.emitStateChange(sessionId);
    if (opts?.scheduleDrain !== false && this.hasMessages(sessionId)) this.scheduleDrain(sessionId, 0);
  }

  ackDrain(sessionId: string, sourceIds?: string[], opts?: { keepProcessing?: boolean; scheduleIfRemaining?: boolean }): void {
    const queue = this.queues.get(sessionId) || [];
    const ids = new Set(sourceIds && sourceIds.length > 0
      ? sourceIds
      : queue.map((message) => message.id));

    this.queues.set(sessionId, queue.filter((message) => !ids.has(message.id)));
    this.processing.set(sessionId, Boolean(opts?.keepProcessing));
    this.drainDeferredSince.delete(sessionId);
    if (!this.hasMessages(sessionId)) {
      this.remoteActiveDrainAllowed.delete(sessionId);
    }
    this.emitStateChange(sessionId);

    if (!opts?.keepProcessing && opts?.scheduleIfRemaining && this.hasMessages(sessionId)) {
      this.scheduleDrain(sessionId, 0);
    }
  }

  // Check if there are queued messages
  hasMessages(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length || 0) > 0;
  }

  // Get queue length
  length(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }

  // Clean up when a session is removed
  cleanup(sessionId: string): void {
    this.queues.delete(sessionId);
    this.processing.delete(sessionId);
    this.activeHarness.delete(sessionId);
    this.streaming.delete(sessionId);
    this.drainDeferredSince.delete(sessionId);
    this.remoteActiveDrainAllowed.delete(sessionId);
    this.fastStackPhase.delete(sessionId);
    const timer = this.drainTimers.get(sessionId);
    if (timer) { clearTimeout(timer); this.drainTimers.delete(sessionId); }
  }

  deferDrain(sessionId: string, delayMs: number): void {
    if (!this.drainDeferredSince.has(sessionId)) {
      this.drainDeferredSince.set(sessionId, Date.now());
    }
    this.scheduleDrain(sessionId, delayMs);
  }

  getDrainDeferredMs(sessionId: string): number {
    const startedAt = this.drainDeferredSince.get(sessionId);
    return startedAt ? Date.now() - startedAt : 0;
  }

  canDrainPastRemoteActive(sessionId: string): boolean {
    return this.remoteActiveDrainAllowed.has(sessionId);
  }

  allowRemoteActiveDrain(sessionId: string): void {
    this.remoteActiveDrainAllowed.add(sessionId);
  }

  clearRemoteActiveDrainAllowance(sessionId: string): void {
    this.remoteActiveDrainAllowed.delete(sessionId);
  }

  beginFastStack(sessionId: string): void {
    this.fastStackPhase.set(sessionId, 'cancelling');
    this.processing.set(sessionId, false);
    const timer = this.drainTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.drainTimers.delete(sessionId);
    }
    this.emitStateChange(sessionId);
  }

  markFastStackRunning(sessionId: string): void {
    this.fastStackPhase.set(sessionId, 'running');
    this.processing.set(sessionId, false);
    this.emitStateChange(sessionId);
  }

  abortFastStack(sessionId: string): void {
    this.fastStackPhase.delete(sessionId);
    this.processing.set(sessionId, false);
    if (this.hasMessages(sessionId)) this.scheduleDrain(sessionId, 100);
    this.emitStateChange(sessionId);
  }

  supportsActiveInjection(sessionId: string): boolean {
    const harness = this.activeHarness.get(sessionId);
    if (!harness) return false;
    return getHarnessCapabilities(harness).supportsAsyncInjection;
  }

  private scheduleDrain(sessionId: string, delayMs: number): void {
    const existing = this.drainTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    if (!this.hasMessages(sessionId)) return;
    if (this.fastStackPhase.has(sessionId)) return;

    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      if (!this.hasMessages(sessionId) || this.fastStackPhase.has(sessionId)) return;
      if (this.processing.get(sessionId)) {
        this.scheduleDrain(sessionId, 250);
        return;
      }
      // Always ask main to reconcile. It owns the authoritative local-query
      // and remote-process probes and will inject, defer, or start a new turn.
      // Suppressing this event based on cached streaming/processing flags is
      // what left queues stuck forever after reconnects.
      this.emit('drain-ready', sessionId);
    }, delayMs);
    this.drainTimers.set(sessionId, timer);
  }

  private emitStateChange(sessionId: string): void {
    this.emit('state-changed', sessionId, this.getState(sessionId));
  }
}

export const messageQueueService = new MessageQueueService();
