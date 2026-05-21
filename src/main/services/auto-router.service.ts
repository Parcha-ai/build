import type { TaskTier, RoutingDecision, AutoRouterConfig, SessionPhase } from '../../shared/types';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';
import { analyticsService } from './analytics.service';
import Store from 'electron-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

const DEFAULT_CONFIG: AutoRouterConfig = {
  enabled: true,
  planModel: 'claude-opus-4-7',
  buildModel: 'codex:gpt-5.5',
  verifyModel: 'codex:gpt-5.5',
  refineModel: 'cursor:composer-2.5',
  fallbackModel: 'claude-opus-4-7',
  costAware: true,
  costThresholdPercent: 80,
  useLlmClassifier: true,
  llmConfidenceThreshold: 0.7,
};

// Per-session workflow phase tracking
const sessionPhases = new Map<string, SessionPhase>();

// Heuristic signal patterns
const PLAN_SIGNALS = [
  'plan', 'design', 'architect', 'think about', 'how should we',
  'review this', "what's the best approach", 'trade-offs', 'tradeoffs',
  'strategy', 'code review', 'review the', 'what do you think',
  'should we', 'pros and cons', 'evaluate', 'compare',
];

const BUILD_SIGNALS = [
  'implement', 'create', 'build', 'add feature', 'scaffold',
  'from the plan', 'execute the plan', 'write the code',
  'set up', 'integrate', 'develop', 'code this',
  'make a', 'make the', 'add a new', 'add the',
];

const VERIFY_SIGNALS = [
  'test', 'verify', 'qa', 'check', 'debug', 'why is this',
  'investigate', 'fix this bug', 'broken', 'failing',
  'not working', 'error', 'regression', 'diagnose',
  'what went wrong', 'stack trace',
];

const REFINE_SIGNALS = [
  'tweak', 'adjust', 'rename', 'format', 'style', 'small fix',
  'update the text', 'change the color', 'change the colour',
  'move this', 'cleanup', 'clean up', 'polish', 'typo',
  'spacing', 'padding', 'margin', 'font', 'wording',
  'swap', 'replace the', 'quick fix', 'minor',
];

// GStack modes that imply specific tiers
const GSTACK_PLAN_MODES = ['plan-ceo-review', 'plan-eng-review', 'autoplan', 'plan-design-review'];
const GSTACK_VERIFY_MODES = ['qa', 'investigate', 'review', 'qa-only'];

interface HeuristicResult {
  tier: TaskTier;
  confidence: number;
  reason: string;
}

function scoreSignals(message: string, signals: string[]): number {
  const lower = message.toLowerCase();
  let hits = 0;
  for (const signal of signals) {
    if (lower.includes(signal)) hits++;
  }
  return Math.min(1.0, hits * 0.25);
}

function classifyHeuristic(
  message: string,
  gstackMode?: string,
  permissionMode?: string,
  _phase?: SessionPhase,
): HeuristicResult {
  const msgLen = message.length;

  // GStack mode overrides
  if (gstackMode) {
    if (GSTACK_PLAN_MODES.includes(gstackMode)) {
      return { tier: 'plan', confidence: 0.95, reason: `GStack mode '${gstackMode}' implies planning` };
    }
    if (GSTACK_VERIFY_MODES.includes(gstackMode)) {
      return { tier: 'verify', confidence: 0.9, reason: `GStack mode '${gstackMode}' implies verification` };
    }
  }

  // Permission mode 'plan' strongly implies Plan tier
  if (permissionMode === 'plan') {
    return { tier: 'plan', confidence: 0.9, reason: 'Permission mode is plan — routing to Plan tier' };
  }

  const planScore = scoreSignals(message, PLAN_SIGNALS);
  const buildScore = scoreSignals(message, BUILD_SIGNALS);
  const verifyScore = scoreSignals(message, VERIFY_SIGNALS);
  const refineScore = scoreSignals(message, REFINE_SIGNALS);

  // Short messages with refine signals → almost certainly refinement
  if (msgLen < 100 && refineScore > 0) {
    return { tier: 'refine', confidence: Math.min(0.95, 0.7 + refineScore * 0.2), reason: 'Short message with refinement keywords' };
  }

  // Very short messages (<60 chars) with no strong signals → likely refinement
  if (msgLen < 60 && planScore === 0 && buildScore === 0 && verifyScore === 0) {
    return { tier: 'refine', confidence: 0.7, reason: 'Very short message with no strong signals' };
  }

  // Long detailed instructions → likely build
  if (msgLen > 500 && buildScore >= 0.25) {
    return { tier: 'build', confidence: Math.min(0.95, 0.6 + buildScore * 0.3), reason: 'Long detailed message with build keywords' };
  }

  // Questions about approach → plan
  const isQuestion = message.includes('?') || message.toLowerCase().startsWith('how') || message.toLowerCase().startsWith('what') || message.toLowerCase().startsWith('should');
  if (isQuestion && planScore > 0 && planScore >= buildScore) {
    return { tier: 'plan', confidence: Math.min(0.9, 0.5 + planScore * 0.3), reason: 'Question about approach or design' };
  }

  // Find the winner
  const scores: [TaskTier, number][] = [
    ['plan', planScore],
    ['build', buildScore],
    ['verify', verifyScore],
    ['refine', refineScore],
  ];
  scores.sort((a, b) => b[1] - a[1]);

  const [topTier, topScore] = scores[0];
  const [, runnerUpScore] = scores[1];

  // Clear winner
  if (topScore > 0 && topScore - runnerUpScore >= 0.25) {
    return { tier: topTier, confidence: Math.min(0.9, 0.5 + topScore * 0.3), reason: `Strong ${topTier} signal match` };
  }

  // Moderate winner
  if (topScore > 0) {
    return { tier: topTier, confidence: Math.min(0.7, 0.4 + topScore * 0.2), reason: `Moderate ${topTier} signal match` };
  }

  // No signals — default based on message length and context
  if (msgLen > 300) {
    return { tier: 'build', confidence: 0.4, reason: 'Long message with no clear signals — defaulting to build' };
  }

  return { tier: 'refine', confidence: 0.4, reason: 'No clear signals — defaulting to refine' };
}

function applyWorkflowAwareness(
  heuristic: HeuristicResult,
  phase: SessionPhase,
): HeuristicResult {
  // Build without prior plan → route to Plan first
  if (heuristic.tier === 'build' && !phase.hasPlanContext && heuristic.confidence >= 0.6) {
    return {
      tier: 'plan',
      confidence: heuristic.confidence * 0.85,
      reason: 'Complex task without prior plan — routing to Plan tier first',
    };
  }

  // Verify without prior build → route to Build
  if (heuristic.tier === 'verify' && !phase.hasBuildContext) {
    return {
      tier: 'build',
      confidence: heuristic.confidence * 0.7,
      reason: 'Verification requested but no build context — routing to Build first',
    };
  }

  // "OK build it" / "go ahead" after a Plan turn
  if (phase.lastTierUsed === 'plan' && heuristic.tier !== 'plan' && heuristic.confidence < 0.6) {
    return {
      tier: 'build',
      confidence: 0.8,
      reason: 'Follow-up after Plan tier — executing the plan',
    };
  }

  return heuristic;
}

function getConfig(): AutoRouterConfig {
  const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
  const saved = settings.autoRouterConfig as Record<string, unknown> | undefined;

  const config = { ...DEFAULT_CONFIG };
  if (saved) {
    if (saved.costAware !== undefined) config.costAware = saved.costAware as boolean;
    if (saved.costThresholdPercent !== undefined) config.costThresholdPercent = saved.costThresholdPercent as number;
    if (saved.useLlmClassifier !== undefined) config.useLlmClassifier = saved.useLlmClassifier as boolean;
    if (saved.llmConfidenceThreshold !== undefined) config.llmConfidenceThreshold = saved.llmConfidenceThreshold as number;

    // Map categories array to flat model config
    const categories = saved.categories as Array<{ id: string; model: string }> | undefined;
    if (categories) {
      for (const cat of categories) {
        if (cat.id === 'plan') config.planModel = cat.model;
        else if (cat.id === 'build') config.buildModel = cat.model;
        else if (cat.id === 'verify') config.verifyModel = cat.model;
        else if (cat.id === 'refine') config.refineModel = cat.model;
      }
    }
  }

  return config;
}

function resolveModelForTier(tier: TaskTier, config: AutoRouterConfig): string {
  switch (tier) {
    case 'plan': return config.planModel;
    case 'build': return config.buildModel;
    case 'verify': return config.verifyModel;
    case 'refine': return config.refineModel;
  }
}

function applyCostAwareDowngrade(
  tier: TaskTier,
  config: AutoRouterConfig,
): string {
  const spendPct = analyticsService.getMonthSpendPercentage();

  if (spendPct > 95) {
    // Emergency mode — everything goes cheap
    switch (tier) {
      case 'plan': return 'claude-sonnet-4-6';
      case 'build': return config.refineModel;
      case 'verify': return config.refineModel;
      case 'refine': return 'gemini:gemini-3.5-flash';
    }
  }

  if (spendPct > 80) {
    switch (tier) {
      case 'plan': return 'claude-sonnet-4-6';
      case 'build': return 'codex:gpt-5.3-codex';
      case 'verify': return config.refineModel;
      case 'refine': return 'gemini:gemini-3.5-flash';
    }
  }

  if (spendPct > 60) {
    switch (tier) {
      case 'plan': return config.planModel;
      case 'build': return config.buildModel;
      case 'verify': return 'codex:gpt-5.4-mini';
      case 'refine': return config.refineModel;
    }
  }

  // Under 60% — use configured models
  switch (tier) {
    case 'plan': return config.planModel;
    case 'build': return config.buildModel;
    case 'verify': return config.verifyModel;
    case 'refine': return config.refineModel;
  }
}

async function classifyWithLlm(
  message: string,
  cerebrasKey: string,
): Promise<{ tier: TaskTier; confidence: number; reason: string } | null> {
  // Cerebras gpt-oss-120b: 92.5% accuracy, 216ms p50, ~free
  // Benchmarked against Haiku 4.5 and GPT-4o-mini — clear winner
  try {
    const prompt = `Classify this developer query into exactly one tier. Reply ONLY with JSON: {"tier":"plan"|"build"|"verify"|"refine","confidence":0.0-1.0,"reason":"..."}

Tiers:
- plan: architecture, design, reasoning, code review, "how should we", trade-offs
- build: new feature implementation, "implement X", "create X", long detailed instructions
- verify: testing, QA, debugging, "fix this bug", "why is this broken", investigation
- refine: small tweaks, rename, formatting, style changes, "change the color", short fixes

Query: "${message.slice(0, 500)}"`;

    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${cerebrasKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!['plan', 'build', 'verify', 'refine'].includes(parsed.tier)) return null;

    return {
      tier: parsed.tier as TaskTier,
      confidence: Math.min(1.0, Math.max(0, parsed.confidence || 0.5)),
      reason: parsed.reason || 'LLM classification',
    };
  } catch (e) {
    console.warn('[AutoRouter] LLM classification failed:', e);
    return null;
  }
}

function getSessionPhase(sessionId: string): SessionPhase {
  return sessionPhases.get(sessionId) || {
    hasPlanContext: false,
    hasBuildContext: false,
    recentTiers: [],
  };
}

function updateSessionPhase(sessionId: string, tier: TaskTier): void {
  const phase = getSessionPhase(sessionId);
  phase.lastTierUsed = tier;
  if (tier === 'plan') phase.hasPlanContext = true;
  if (tier === 'build') phase.hasBuildContext = true;
  phase.recentTiers = [...phase.recentTiers.slice(-9), tier];
  sessionPhases.set(sessionId, phase);
}

class AutoRouterService {
  async classifyAndRoute(
    sessionId: string,
    message: string,
    options?: {
      gstackMode?: string;
      permissionMode?: string;
      isSSH?: boolean;
    },
  ): Promise<RoutingDecision> {
    const config = getConfig();
    const phase = getSessionPhase(sessionId);

    // Step 1: Heuristic classification
    let result = classifyHeuristic(message, options?.gstackMode, options?.permissionMode, phase);

    // Step 2: Apply workflow awareness
    result = applyWorkflowAwareness(result, phase);

    let method: 'heuristic' | 'llm' = 'heuristic';

    // Step 3: If heuristic confidence is low, try LLM classifier
    if (result.confidence < config.llmConfidenceThreshold && config.useLlmClassifier) {
      const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
      const cerebrasKey = (settings.cerebrasApiKey as string) || EMBEDDED_KEYS.cerebras || process.env.CEREBRAS_API_KEY || '';
      if (cerebrasKey) {
        const llmResult = await classifyWithLlm(message, cerebrasKey);
        if (llmResult && llmResult.confidence > result.confidence) {
          result = llmResult;
          method = 'llm';
          // Re-apply workflow awareness to LLM result
          result = applyWorkflowAwareness(result, phase);
        }
      }
    }

    // Step 4: Resolve model for tier
    const resolvedModel = config.costAware
      ? applyCostAwareDowngrade(result.tier, config)
      : resolveModelForTier(result.tier, config);

    // Step 5: Update session phase
    updateSessionPhase(sessionId, result.tier);

    const decision: RoutingDecision = {
      tier: result.tier,
      resolvedModel,
      confidence: result.confidence,
      reason: result.reason,
      method,
      enableGoals: result.tier === 'verify',
    };

    console.log(`[AutoRouter] ${sessionId}: ${result.tier.toUpperCase()} → ${resolvedModel} (${(result.confidence * 100).toFixed(0)}% confidence, ${method})`);

    return decision;
  }

  getPhase(sessionId: string): SessionPhase {
    return getSessionPhase(sessionId);
  }

  getConfig(): AutoRouterConfig {
    return getConfig();
  }

  setConfig(config: Partial<AutoRouterConfig>): void {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    const current = getConfig();
    settings.autoRouterConfig = { ...current, ...config };
    settingsStore.set('settings', settings);
  }

  resetPhase(sessionId: string): void {
    sessionPhases.delete(sessionId);
  }
}

export const autoRouterService = new AutoRouterService();
