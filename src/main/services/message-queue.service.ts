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

  // Enqueue a message for a session
  enqueue(sessionId: string, text: string, attachments?: unknown[], opts?: { id?: string; model?: string; suppressUserMessage?: boolean; deferDrain?: boolean }): QueuedMessage {
    const existingQueue = this.queues.get(sessionId) || [];
    const normalizedText = text.trim();
    const existing = existingQueue.find(m =>
      (opts?.id && m.id === opts.id) ||
      (normalizedText.length > 0 && m.text.trim() === normalizedText && Date.now() - m.timestamp < 10_000)
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
      this.processing.set(sessionId, true);
      this.emitStateChange(sessionId);
      this.scheduleDrain(sessionId, 250);
      return msg;
    }
    this.emitStateChange(sessionId);

    // If not streaming, drain immediately. Claude can also accept queued input
    // mid-stream via streamInput; keep that drain in main so queue state and
    // injection are updated atomically.
    const isStreaming = this.streaming.get(sessionId) || false;
    const harness = this.activeHarness.get(sessionId);
    const caps = getHarnessCapabilities(harness);
    const canDrainActiveStream = isStreaming && Boolean(harness) && caps.supportsAsyncInjection;
    if ((!isStreaming || canDrainActiveStream) && !this.processing.get(sessionId)) {
      this.scheduleDrain(sessionId, 0);
    }
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
    if (harness) this.activeHarness.set(sessionId, harness);
    this.emitStateChange(sessionId);
  }

  // Called when a stream ends for a session -- triggers drain by default.
  onStreamEnd(sessionId: string, opts?: { drain?: boolean }): void {
    this.streaming.set(sessionId, false);
    this.processing.set(sessionId, false);
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

  // Drain every pending message as a single ordered turn.
  dequeueForDrain(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    if (queue.length === 0) return undefined;

    this.queues.set(sessionId, []);
    this.processing.set(sessionId, true);
    this.drainDeferredSince.delete(sessionId);
    this.emitStateChange(sessionId);

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

  private scheduleDrain(sessionId: string, delayMs: number): void {
    const existing = this.drainTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    if (!this.hasMessages(sessionId)) return;

    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      const isStreaming = this.streaming.get(sessionId) || false;
      const harness = this.activeHarness.get(sessionId);
      const caps = getHarnessCapabilities(harness);
      const canDrainActiveStream = isStreaming && Boolean(harness) && caps.supportsAsyncInjection;
      if ((!isStreaming || canDrainActiveStream) && this.hasMessages(sessionId)) {
        // Emit drain-ready event -- the IPC handler will dequeue and send
        this.emit('drain-ready', sessionId);
      }
    }, delayMs);
    this.drainTimers.set(sessionId, timer);
  }

  private emitStateChange(sessionId: string): void {
    this.emit('state-changed', sessionId, this.getState(sessionId));
  }
}

export const messageQueueService = new MessageQueueService();
