import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { sessionTurnService } from './session-turn.service';
import type { QueuedMessage, QueueState } from '../../shared/types/message-queue';
import type { Harness } from '../../shared/types';
import { getHarnessCapabilities } from './harness-capabilities';

class QueueController extends EventEmitter {
  // Data storage (migrated from message-queue.service.ts)
  private queues = new Map<string, QueuedMessage[]>();
  private activeHarness = new Map<string, Harness>();

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

  // ========== Public API (data management) ==========

  enqueue(sessionId: string, text: string, attachments?: unknown[], opts?: {
    id?: string;
    model?: string;
    suppressUserMessage?: boolean;
  }): QueuedMessage {
    const existingQueue = this.queues.get(sessionId) || [];
    const normalizedText = text.trim();

    // Dedup by content within 10s
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
    this.emitStateChange(sessionId);

    // If IDLE, drain immediately. Otherwise arm safety timer.
    const state = sessionTurnService.getState(sessionId);
    if (state === 'IDLE') {
      const harness = this.activeHarness.get(sessionId);
      const caps = getHarnessCapabilities(harness);
      const delay = caps.minTurnGapMs || this.DEFAULT_DRAIN_DELAY_MS;
      this.scheduleDrain(sessionId, delay);
    } else {
      this.armSafetyTimer(sessionId);
    }

    return msg;
  }

  remove(sessionId: string, messageId: string): void {
    const queue = this.queues.get(sessionId) || [];
    this.queues.set(sessionId, queue.filter(m => m.id !== messageId));
    this.emitStateChange(sessionId);
  }

  edit(sessionId: string, messageId: string, newText: string): void {
    const queue = this.queues.get(sessionId) || [];
    const msg = queue.find(m => m.id === messageId);
    if (msg) {
      msg.text = newText;
      this.emitStateChange(sessionId);
    }
  }

  moveToFront(sessionId: string, messageId: string): void {
    const queue = this.queues.get(sessionId) || [];
    const idx = queue.findIndex(m => m.id === messageId);
    if (idx > 0) {
      const [msg] = queue.splice(idx, 1);
      queue.unshift(msg);
      this.emitStateChange(sessionId);
    }
  }

  clear(sessionId: string): void {
    this.queues.set(sessionId, []);
    this.clearSafetyTimer(sessionId);
    this.clearDrainTimer(sessionId);
    this.emitStateChange(sessionId);
  }

  getState(sessionId: string): QueueState {
    return {
      messages: this.queues.get(sessionId) || [],
      isProcessing: sessionTurnService.getState(sessionId) !== 'IDLE',
      activeHarness: this.activeHarness.get(sessionId),
    };
  }

  setActiveHarness(sessionId: string, harness?: string): void {
    if (!harness) {
      this.activeHarness.delete(sessionId);
    } else {
      this.activeHarness.set(sessionId, harness as Harness);
    }
    this.emitStateChange(sessionId);
  }

  peek(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    return queue[0];
  }

  dequeueForDrain(sessionId: string): QueuedMessage | undefined {
    const next = this.peekForDrain(sessionId);
    if (!next) return undefined;

    this.ackDrain(sessionId, next.sourceIds);
    return next;
  }

  peekForDrain(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId) || [];
    return this.buildDrainMessage(queue);
  }

  ackDrain(sessionId: string, sourceIds?: string[]): void {
    const queue = this.queues.get(sessionId) || [];
    const ids = new Set(sourceIds && sourceIds.length > 0
      ? sourceIds
      : queue.map((message) => message.id));

    this.queues.set(sessionId, queue.filter((message) => !ids.has(message.id)));
    this.emitStateChange(sessionId);
  }

  hasMessages(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length || 0) > 0;
  }

  length(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }

  cleanup(sessionId: string): void {
    this.queues.delete(sessionId);
    this.activeHarness.delete(sessionId);
    this.clearSafetyTimer(sessionId);
    this.clearDrainTimer(sessionId);
  }

  // ========== Private Methods ==========

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

  private clearDrainTimer(sessionId: string): void {
    const timer = this.drainTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.drainTimers.delete(sessionId);
    }
  }

  private armSafetyTimer(sessionId: string): void {
    if (this.safetyTimers.has(sessionId)) return;
    this.safetyTimers.set(sessionId, setTimeout(() => {
      this.safetyTimers.delete(sessionId);
      if (this.hasMessages(sessionId) && sessionTurnService.getState(sessionId) !== 'IDLE') {
        console.warn(`[Queue] Safety net: forcing IDLE for ${sessionId.slice(0, 8)} after ${this.SAFETY_NET_MS}ms`);
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

  private emitStateChange(sessionId: string): void {
    this.emit('state-changed', sessionId, this.getState(sessionId));
  }
}

export const queueController = new QueueController();
