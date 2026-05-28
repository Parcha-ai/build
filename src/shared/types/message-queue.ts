import type { Harness } from './index';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  attachments?: unknown[];
  timestamp: number;
  model?: string;  // model at time of queueing
  suppressUserMessage?: boolean;  // don't show as user bubble (e.g., continue)
}

export interface QueueState {
  messages: QueuedMessage[];
  isProcessing: boolean;
  activeHarness?: Harness;
}

export interface HarnessCapabilities {
  supportsAsyncInjection: boolean;  // Can accept messages mid-stream (Claude Code only)
  supportsMultiTurn: boolean;       // Maintains conversation state across turns
  minTurnGapMs: number;             // Minimum delay between sequential messages
  maxCoalesceWindowMs: number;      // Time window for coalescing rapid messages
}
