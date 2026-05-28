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

  // Enqueue a message for a session
  enqueue(sessionId: string, text: string, attachments?: unknown[], opts?: { model?: string; suppressUserMessage?: boolean }): QueuedMessage {
    const msg: QueuedMessage = {
      id: randomUUID(),
      sessionId,
      text,
      attachments,
      timestamp: Date.now(),
      model: opts?.model,
      suppressUserMessage: opts?.suppressUserMessage,
    };
    const queue = this.queues.get(sessionId) || [];
    queue.push(msg);
    this.queues.set(sessionId, queue);
    this.emitStateChange(sessionId);

    // If not streaming, drain immediately
    if (!this.streaming.get(sessionId)) {
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
    if (harness) this.activeHarness.set(sessionId, harness);
    this.emitStateChange(sessionId);
  }

  // Called when a stream ends for a session -- triggers drain
  onStreamEnd(sessionId: string): void {
    this.streaming.set(sessionId, false);
    this.processing.set(sessionId, false);
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
    const timer = this.drainTimers.get(sessionId);
    if (timer) { clearTimeout(timer); this.drainTimers.delete(sessionId); }
  }

  private scheduleDrain(sessionId: string, delayMs: number): void {
    const existing = this.drainTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    if (!this.hasMessages(sessionId)) return;

    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      if (!this.streaming.get(sessionId) && this.hasMessages(sessionId)) {
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
