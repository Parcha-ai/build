import type { HarnessCapabilities } from '../../shared/types/message-queue';

const CAPABILITIES: Record<string, HarnessCapabilities> = {
  claude:   { supportsAsyncInjection: true,  supportsMultiTurn: true,  minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
  codex:    { supportsAsyncInjection: false, supportsMultiTurn: true,  minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
  cursor:   { supportsAsyncInjection: false, supportsMultiTurn: true,  minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
  gemini:   { supportsAsyncInjection: false, supportsMultiTurn: false, minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
  opencode: { supportsAsyncInjection: false, supportsMultiTurn: false, minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
  custom:   { supportsAsyncInjection: false, supportsMultiTurn: false, minTurnGapMs: 500, maxCoalesceWindowMs: 3000 },
};

const DEFAULT: HarnessCapabilities = {
  supportsAsyncInjection: false,
  supportsMultiTurn: false,
  minTurnGapMs: 500,
  maxCoalesceWindowMs: 3000,
};

export function getHarnessCapabilities(harness?: string): HarnessCapabilities {
  return CAPABILITIES[harness || 'claude'] || DEFAULT;
}
