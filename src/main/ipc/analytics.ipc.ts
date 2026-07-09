import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { analyticsService, estimateBaselineCost, estimateCost } from '../services/analytics.service';
import type { HarnessSelectionEvent, HistoricalRoutingCase, UsageTierConfig } from '../services/analytics.service';
import { autoRouterService } from '../services/auto-router.service';
import type { ChatMessage, Harness, OrchestrationStage, RoutingDecision, TaskTier } from '../../shared/types';

type RouterEvalOptions = {
  limit?: number;
  includeSubagents?: boolean;
  useMetaController?: boolean;
};

const TIERS: TaskTier[] = ['plan', 'build', 'verify', 'refine'];
const CEREBRAS_GPT_OSS_120B_PRICING_PER_MILLION = { input: 0.35, output: 0.75 };

type RouterEvalCase = Omit<HistoricalRoutingCase, 'source'> & {
  source: HistoricalRoutingCase['source'] | 'regression';
  expectedModelIncludes?: string;
  expectedHarness?: Harness;
};

const ROUTER_REGRESSION_BASE_TS = Date.UTC(2026, 4, 24, 12, 0, 0);

function regressionCase(
  index: number,
  caseId: string,
  sessionId: string,
  message: string,
  expectedTier: TaskTier,
  expectedReason: string,
  expectedModelIncludes?: string,
): RouterEvalCase {
  return {
    caseId: `regression:${caseId}`,
    source: 'regression',
    sessionId,
    sessionName: 'Router regression cases',
    timestamp: ROUTER_REGRESSION_BASE_TS + index,
    message,
    expectedTier,
    expectedReason,
    expectedModelIncludes,
    actualModel: expectedModelIncludes ? `claude-${expectedModelIncludes}-4-7` : undefined,
    inputTokens: Math.max(1, Math.ceil(message.length / 4)),
    outputTokens: expectedTier === 'refine' ? 300 : 900,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

const ROUTER_REGRESSION_CASES: RouterEvalCase[] = [
  regressionCase(
    1,
    'capability-look-harder',
    'regression-capability',
    'look harder at the problem before changing code',
    'plan',
    'Explicit deeper reasoning request should route to planning and a frontier model',
    'opus',
  ),
  regressionCase(
    2,
    'capability-more-powerful',
    'regression-capability',
    'use a more powerful model for this; the last answer missed the core issue',
    'plan',
    'Explicit stronger-model request should not be treated as a small refinement',
    'opus',
  ),
  regressionCase(
    3,
    'architecture-review',
    'regression-followup',
    'review the architecture tradeoffs before we touch code',
    'plan',
    'Architecture and tradeoff review belongs in planning',
  ),
  regressionCase(
    4,
    'followup-build',
    'regression-followup',
    'ok build it from the plan',
    'build',
    'Plan continuation should execute rather than re-plan',
  ),
  regressionCase(
    5,
    'explicit-from-plan',
    'regression-implementation',
    'implement the auth flow from the plan',
    'build',
    'Explicit implementation from an existing plan belongs in build',
  ),
  regressionCase(
    6,
    'failure-investigation',
    'regression-debug',
    'tests are failing, figure out why',
    'verify',
    'Failure investigation belongs in verify even without prior build context',
  ),
  regressionCase(
    7,
    'small-copy',
    'regression-refine',
    'make the button text shorter',
    'refine',
    'Small copy/UI tweak belongs in refine',
  ),
  regressionCase(
    8,
    'rename-typo',
    'regression-refine',
    'just rename this component and fix the typo',
    'refine',
    'Low-risk rename and typo fix belongs in refine',
  ),
];

function emptyTierStats() {
  return Object.fromEntries(TIERS.map((tier) => [tier, {
    total: 0,
    matches: 0,
    projectedCost: 0,
    historicalCost: 0,
    savingsVsHistorical: 0,
    savingsVsBaseline: 0,
  }])) as Record<TaskTier, {
    total: number;
    matches: number;
    projectedCost: number;
    historicalCost: number;
    savingsVsHistorical: number;
    savingsVsBaseline: number;
  }>;
}

function addModelCount(map: Record<string, number>, model: string): void {
  map[model] = (map[model] || 0) + 1;
}

function topModel(map: Record<string, number>, fallback: string): string {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function estimateFlueControllerCost(message: string, recentMessages: ChatMessage[]): number {
  const messageTokens = Math.ceil(Math.min(message.length, 1800) / 4);
  const recentTokens = recentMessages
    .slice(-5)
    .reduce((sum, recent) => sum + Math.ceil(Math.min((recent.content || '').length, 360) / 4), 0);
  const inputTokens = 850 + messageTokens + recentTokens;
  const outputTokens = 220;
  return (
    (inputTokens / 1_000_000) * CEREBRAS_GPT_OSS_120B_PRICING_PER_MILLION.input +
    (outputTokens / 1_000_000) * CEREBRAS_GPT_OSS_120B_PRICING_PER_MILLION.output
  );
}

function stageTokenScale(stage: Pick<OrchestrationStage, 'tier' | 'trigger'>): { input: number; output: number } {
  if (stage.trigger === 'now') return { input: 1, output: 1 };
  switch (stage.tier) {
    case 'build':
      return { input: 0.95, output: 0.9 };
    case 'verify':
      return { input: 0.7, output: 0.45 };
    case 'refine':
      return { input: 0.55, output: 0.45 };
    case 'plan':
      return { input: 0.85, output: 0.75 };
  }
}

function uniqueCostedStages(decision: RoutingDecision): Array<Pick<OrchestrationStage, 'tier' | 'model' | 'trigger'>> {
  const stages = decision.orchestration?.stages || [];
  if (stages.length === 0) {
    return [{ tier: decision.tier, model: decision.resolvedModel, trigger: 'now' }];
  }

  const seen = new Set<string>();
  return stages.filter((stage) => {
    const key = `${stage.tier}:${stage.model}:${stage.trigger}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function estimateDecisionExecutionCost(decision: RoutingDecision, evalCase: RouterEvalCase): number {
  return uniqueCostedStages(decision).reduce((sum, stage) => {
    const scale = stageTokenScale(stage);
    return sum + estimateCost(
      stage.model,
      Math.ceil(evalCase.inputTokens * scale.input),
      Math.ceil(evalCase.outputTokens * scale.output),
      Math.ceil(evalCase.cacheReadTokens * scale.input),
      Math.ceil(evalCase.cacheWriteTokens * scale.input),
    );
  }, 0);
}

async function runRouterEval(options?: RouterEvalOptions) {
  const historicalCases = await analyticsService.getHistoricalRoutingDataset({
    limit: Math.min(Math.max(1, options?.limit || 120), 300),
    includeSubagents: options?.includeSubagents,
  });
  const cases: RouterEvalCase[] = [
    ...ROUTER_REGRESSION_CASES,
    ...historicalCases,
  ];
  const recentBySession = new Map<string, ChatMessage[]>();
  const syntheticSessionIds = new Set<string>();
  const byTier = emptyTierStats();
  const byHarness: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const selectedByTier: Record<TaskTier, Record<string, number>> = {
    plan: {},
    build: {},
    verify: {},
    refine: {},
  };
  const mismatches: Array<{
    caseId: string;
    source: RouterEvalCase['source'];
    message: string;
    expectedTier: TaskTier;
    routedTier: TaskTier;
    resolvedModel: string;
    reason: string;
  }> = [];
  const modelMismatches: Array<{
    caseId: string;
    source: RouterEvalCase['source'];
    message: string;
    expectedModelIncludes: string;
    resolvedModel: string;
    reason: string;
  }> = [];
  const harnessMismatches: Array<{
    caseId: string;
    source: RouterEvalCase['source'];
    message: string;
    expectedHarness: Harness;
    resolvedHarness?: Harness;
    reason: string;
  }> = [];

  let matches = 0;
  let modelExpectations = 0;
  let modelMatches = 0;
  let harnessExpectations = 0;
  let harnessMatches = 0;
  let projectedCost = 0;
  let projectedLeadOnlyCost = 0;
  let projectedControllerCost = 0;
  let historicalCost = 0;
  let baselineCost = 0;
  const routeLatenciesMs: number[] = [];

  for (const evalCase of cases) {
    const evalSessionId = `router-eval:${evalCase.sessionId}`;
    syntheticSessionIds.add(evalSessionId);
    const recentMessages = recentBySession.get(evalSessionId) || [];
    const routeStartedAt = Date.now();
    const decision = await autoRouterService.classifyAndRoute(evalSessionId, evalCase.message, {
      recentMessages,
      attachmentCount: 0,
      attachmentTypes: [],
      skipMetaController: options?.useMetaController !== true,
    });
    routeLatenciesMs.push(Date.now() - routeStartedAt);

    const caseProjectedCost = estimateDecisionExecutionCost(decision, evalCase);
    const caseLeadOnlyCost = estimateCost(
      decision.resolvedModel,
      evalCase.inputTokens,
      evalCase.outputTokens,
      evalCase.cacheReadTokens,
      evalCase.cacheWriteTokens,
    );
    const caseControllerCost = decision.method === 'controller'
      ? estimateFlueControllerCost(evalCase.message, recentMessages)
      : 0;
    const caseHistoricalCost = evalCase.actualCostUsd ?? estimateCost(
      evalCase.actualModel || 'claude-opus-4-7',
      evalCase.inputTokens,
      evalCase.outputTokens,
      evalCase.cacheReadTokens,
      evalCase.cacheWriteTokens,
    );
    const caseBaselineCost = estimateBaselineCost(
      evalCase.inputTokens,
      evalCase.outputTokens,
      evalCase.cacheReadTokens,
      evalCase.cacheWriteTokens,
    );
    const didMatch = decision.tier === evalCase.expectedTier;
    if (didMatch) matches += 1;
    else if (mismatches.length < 12) {
      mismatches.push({
        caseId: evalCase.caseId,
        source: evalCase.source,
        message: evalCase.message.slice(0, 280),
        expectedTier: evalCase.expectedTier,
        routedTier: decision.tier,
        resolvedModel: decision.resolvedModel,
        reason: decision.reason,
      });
    }

    if (evalCase.expectedModelIncludes) {
      modelExpectations += 1;
      if (decision.resolvedModel.toLowerCase().includes(evalCase.expectedModelIncludes.toLowerCase())) {
        modelMatches += 1;
      } else if (modelMismatches.length < 12) {
        modelMismatches.push({
          caseId: evalCase.caseId,
          source: evalCase.source,
          message: evalCase.message.slice(0, 280),
          expectedModelIncludes: evalCase.expectedModelIncludes,
          resolvedModel: decision.resolvedModel,
          reason: decision.reason,
        });
      }
    }

    if (evalCase.expectedHarness) {
      harnessExpectations += 1;
      if (decision.resolvedHarness === evalCase.expectedHarness) {
        harnessMatches += 1;
      } else if (harnessMismatches.length < 12) {
        harnessMismatches.push({
          caseId: evalCase.caseId,
          source: evalCase.source,
          message: evalCase.message.slice(0, 280),
          expectedHarness: evalCase.expectedHarness,
          resolvedHarness: decision.resolvedHarness,
          reason: decision.reason,
        });
      }
    }

    projectedCost += caseProjectedCost;
    projectedLeadOnlyCost += caseLeadOnlyCost;
    projectedControllerCost += caseControllerCost;
    historicalCost += caseHistoricalCost;
    baselineCost += caseBaselineCost;
    addModelCount(byHarness, decision.resolvedHarness || 'claude');
    addModelCount(byMethod, decision.method);
    addModelCount(selectedByTier[evalCase.expectedTier], decision.resolvedModel);

    const tierStat = byTier[evalCase.expectedTier];
    tierStat.total += 1;
    tierStat.matches += didMatch ? 1 : 0;
    tierStat.projectedCost += caseProjectedCost + caseControllerCost;
    tierStat.historicalCost += caseHistoricalCost;
    tierStat.savingsVsHistorical += Math.max(0, caseHistoricalCost - caseProjectedCost - caseControllerCost);
    tierStat.savingsVsBaseline += Math.max(0, caseBaselineCost - caseProjectedCost - caseControllerCost);

    const userMessage: ChatMessage = {
      id: `${evalCase.caseId}:user`,
      role: 'user',
      content: evalCase.message,
      timestamp: new Date(evalCase.timestamp),
    };
    const assistantMessage: ChatMessage = {
      id: `${evalCase.caseId}:assistant`,
      role: 'assistant',
      content: `<workflow_turn_result>\nCompleted scope: ${decision.tier}\n</workflow_turn_result>`,
      timestamp: new Date(evalCase.timestamp + 1),
      harness: decision.resolvedHarness,
    };
    recentMessages.push(userMessage, assistantMessage);
    recentBySession.set(evalSessionId, recentMessages.slice(-24));
    autoRouterService.recordTierCompletion(evalSessionId, decision.tier);
  }

  for (const sessionId of syntheticSessionIds) {
    autoRouterService.resetPhase(sessionId);
  }

  const recommendedConfig = {
    planModel: topModel(selectedByTier.plan, 'claude-opus-4-7'),
    buildModel: topModel(selectedByTier.build, 'codex:gpt-5.6-sol'),
    verifyModel: topModel(selectedByTier.verify, 'codex:gpt-5.6-sol'),
    refineModel: topModel(selectedByTier.refine, 'cursor:composer-2.5'),
  };

  return {
    generatedAt: Date.now(),
    cases: cases.length,
    regressionCases: ROUTER_REGRESSION_CASES.length,
    historicalCases: historicalCases.length,
    accuracy: cases.length > 0 ? matches / cases.length : 0,
    matches,
    modelExpectations,
    modelAccuracy: modelExpectations > 0 ? modelMatches / modelExpectations : 0,
    modelMatches,
    harnessExpectations,
    harnessAccuracy: harnessExpectations > 0 ? harnessMatches / harnessExpectations : 0,
    harnessMatches,
    projectedCost,
    projectedLeadOnlyCost,
    projectedHelperCost: Math.max(0, projectedCost - projectedLeadOnlyCost),
    projectedControllerCost,
    projectedTotalCost: projectedCost + projectedControllerCost,
    historicalCost,
    baselineCost,
    projectedSavingsVsHistorical: Math.max(0, historicalCost - projectedCost - projectedControllerCost),
    projectedSavingsVsBaseline: Math.max(0, baselineCost - projectedCost - projectedControllerCost),
    meanRouteLatencyMs: routeLatenciesMs.length > 0
      ? routeLatenciesMs.reduce((sum, value) => sum + value, 0) / routeLatenciesMs.length
      : 0,
    p50RouteLatencyMs: percentile(routeLatenciesMs, 50),
    p95RouteLatencyMs: percentile(routeLatenciesMs, 95),
    byTier,
    byHarness,
    byMethod,
    selectedByTier,
    recommendedConfig,
    mismatches,
    modelMismatches,
    harnessMismatches,
  };
}

export function registerAnalyticsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SUMMARY, async () => {
    return analyticsService.getSummary();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SESSION_COST, async (_, sessionId: string) => {
    return analyticsService.getSessionCost(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TIER_CONFIG, async () => {
    return analyticsService.getTierConfig();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SET_TIER_CONFIG, async (_, config: UsageTierConfig) => {
    analyticsService.setTierConfig(config);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_HARNESS_INSIGHTS, async () => {
    return analyticsService.getHarnessInsights();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_REFRESH_HISTORICAL_USAGE, async (_, options?: { includeSubagents?: boolean; maxFiles?: number }) => {
    return analyticsService.refreshHistoricalUsageFromTranscripts(options);
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_RUN_ROUTER_EVAL, async (_, options?: RouterEvalOptions) => {
    const result = await runRouterEval(options);
    return {
      success: true,
      ...result,
    };
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_RECORD_HARNESS_SELECTION, async (_, event: HarnessSelectionEvent) => {
    analyticsService.recordHarnessSelection({
      ...event,
      timestamp: event.timestamp || Date.now(),
    });
    return { success: true };
  });
}
