import Store from 'electron-store';

export interface TokenEvent {
  sessionId: string;
  sessionName: string;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolName?: string;
  estimatedCostUsd: number;
}

export interface UsageTierConfig {
  monthlyIncludedUsd: number;
  planName: string;
}

export interface AnalyticsSummary {
  todayTotalCost: number;
  todayTotalTokens: number;
  todayCacheHitRate: number;
  monthTotalCost: number;
  monthIncludedUsd: number;
  monthExtraUsageCost: number;
  isOverIncludedUsage: boolean;
  percentOfIncluded: number;
  bySession: Array<{
    sessionId: string;
    sessionName: string;
    model: string;
    totalTokens: number;
    cost: number;
  }>;
  byModel: Array<{
    model: string;
    cost: number;
    tokenCount: number;
  }>;
  byTool: Array<{
    tool: string;
    cost: number;
    callCount: number;
  }>;
  hourlyTimeline: Array<{
    hour: string;
    tokens: number;
    cost: number;
  }>;
}

export interface SessionCostSummary {
  sessionId: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  extraUsageCost: number;
  isOverIncludedUsage: boolean;
  percentOfIncluded: number;
  turnCount: number;
}

// Pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-5': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-0': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-haiku-3-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

const DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };

// Default usage tiers (Anthropic API plans)
const DEFAULT_TIER: UsageTierConfig = {
  monthlyIncludedUsd: 100, // Pro plan ~$100 effective included usage
  planName: 'Pro',
};

function getPricingForModel(modelId: string): typeof DEFAULT_PRICING {
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.includes(key) || modelId.includes(key.replace('claude-', ''))) {
      return pricing;
    }
  }
  if (modelId.includes('opus')) return MODEL_PRICING['claude-opus-4-7'];
  if (modelId.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (modelId.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  return DEFAULT_PRICING;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const pricing = getPricingForModel(model);
  const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return (
    (freshInputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
  );
}

class AnalyticsService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private tierConfig: UsageTierConfig;

  constructor() {
    this.store = new Store({ name: 'claudette-analytics' });
    this.tierConfig = this.store.get('tierConfig', DEFAULT_TIER) as UsageTierConfig;
    this.pruneOldEvents();
  }

  setTierConfig(config: UsageTierConfig): void {
    this.tierConfig = config;
    this.store.set('tierConfig', config);
  }

  getTierConfig(): UsageTierConfig {
    return this.tierConfig;
  }

  recordTokenEvent(event: TokenEvent): void {
    const dayKey = this.getDayKey(event.timestamp);
    const events = this.store.get(`events.${dayKey}`, []) as TokenEvent[];
    events.push(event);
    this.store.set(`events.${dayKey}`, events);
  }

  getEventsForDay(timestamp?: number): TokenEvent[] {
    const dayKey = this.getDayKey(timestamp || Date.now());
    return this.store.get(`events.${dayKey}`, []) as TokenEvent[];
  }

  getEventsForMonth(): TokenEvent[] {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const allEvents: TokenEvent[] = [];

    for (let day = 1; day <= 31; day++) {
      const date = new Date(year, month, day);
      if (date.getMonth() !== month) break;
      const dayKey = this.getDayKey(date.getTime());
      const dayEvents = this.store.get(`events.${dayKey}`, []) as TokenEvent[];
      allEvents.push(...dayEvents);
    }
    return allEvents;
  }

  getSessionCost(sessionId: string): SessionCostSummary {
    const allDayKeys = this.getAllDayKeys();
    let totalCost = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let turnCount = 0;

    for (const dayKey of allDayKeys) {
      const events = this.store.get(`events.${dayKey}`, []) as TokenEvent[];
      for (const event of events) {
        if (event.sessionId === sessionId) {
          totalCost += event.estimatedCostUsd;
          totalTokens += event.inputTokens + event.outputTokens;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          cacheReadTokens += event.cacheReadTokens;
          cacheWriteTokens += event.cacheWriteTokens;
          turnCount++;
        }
      }
    }

    const monthCost = this.getMonthTotalCost();
    const extraUsageCost = Math.max(0, monthCost - this.tierConfig.monthlyIncludedUsd);
    const sessionShareOfExtra = monthCost > 0 ? (totalCost / monthCost) * extraUsageCost : 0;

    return {
      sessionId,
      totalCost,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      extraUsageCost: sessionShareOfExtra,
      isOverIncludedUsage: monthCost > this.tierConfig.monthlyIncludedUsd,
      percentOfIncluded: (monthCost / this.tierConfig.monthlyIncludedUsd) * 100,
      turnCount,
    };
  }

  getSummary(): AnalyticsSummary {
    const todayEvents = this.getEventsForDay();
    const monthEvents = this.getEventsForMonth();

    const todayTotalCost = todayEvents.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    const todayTotalTokens = todayEvents.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    const todayCacheRead = todayEvents.reduce((sum, e) => sum + e.cacheReadTokens, 0);
    const todayTotalInput = todayEvents.reduce((sum, e) => sum + e.inputTokens, 0);
    const todayCacheHitRate = todayTotalInput > 0 ? (todayCacheRead / todayTotalInput) * 100 : 0;

    const monthTotalCost = monthEvents.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    const monthExtraUsageCost = Math.max(0, monthTotalCost - this.tierConfig.monthlyIncludedUsd);
    const isOverIncludedUsage = monthTotalCost > this.tierConfig.monthlyIncludedUsd;
    const percentOfIncluded = (monthTotalCost / this.tierConfig.monthlyIncludedUsd) * 100;

    // By session
    const sessionMap = new Map<string, { sessionName: string; model: string; totalTokens: number; cost: number }>();
    for (const e of todayEvents) {
      const existing = sessionMap.get(e.sessionId) || { sessionName: e.sessionName, model: e.model, totalTokens: 0, cost: 0 };
      existing.totalTokens += e.inputTokens + e.outputTokens;
      existing.cost += e.estimatedCostUsd;
      existing.model = e.model;
      sessionMap.set(e.sessionId, existing);
    }
    const bySession = Array.from(sessionMap.entries())
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.cost - a.cost);

    // By model
    const modelMap = new Map<string, { cost: number; tokenCount: number }>();
    for (const e of todayEvents) {
      const existing = modelMap.get(e.model) || { cost: 0, tokenCount: 0 };
      existing.cost += e.estimatedCostUsd;
      existing.tokenCount += e.inputTokens + e.outputTokens;
      modelMap.set(e.model, existing);
    }
    const byModel = Array.from(modelMap.entries())
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.cost - a.cost);

    // By tool
    const toolMap = new Map<string, { cost: number; callCount: number }>();
    for (const e of todayEvents) {
      const tool = e.toolName || 'conversation';
      const existing = toolMap.get(tool) || { cost: 0, callCount: 0 };
      existing.cost += e.estimatedCostUsd;
      existing.callCount += 1;
      toolMap.set(tool, existing);
    }
    const byTool = Array.from(toolMap.entries())
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.cost - a.cost);

    // Hourly timeline (last 24h)
    const hourlyMap = new Map<string, { tokens: number; cost: number }>();
    const now = Date.now();
    for (let h = 23; h >= 0; h--) {
      const hourStart = now - h * 3600_000;
      const hourLabel = new Date(hourStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      hourlyMap.set(hourLabel, { tokens: 0, cost: 0 });
    }
    for (const e of todayEvents) {
      const hourLabel = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const existing = hourlyMap.get(hourLabel);
      if (existing) {
        existing.tokens += e.inputTokens + e.outputTokens;
        existing.cost += e.estimatedCostUsd;
      }
    }
    const hourlyTimeline = Array.from(hourlyMap.entries())
      .map(([hour, data]) => ({ hour, ...data }));

    return {
      todayTotalCost,
      todayTotalTokens,
      todayCacheHitRate,
      monthTotalCost,
      monthIncludedUsd: this.tierConfig.monthlyIncludedUsd,
      monthExtraUsageCost,
      isOverIncludedUsage,
      percentOfIncluded,
      bySession,
      byModel,
      byTool,
      hourlyTimeline,
    };
  }

  private getMonthTotalCost(): number {
    return this.getEventsForMonth().reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  private getDayKey(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private getAllDayKeys(): string[] {
    const events = this.store.get('events', {}) as Record<string, unknown>;
    return Object.keys(events);
  }

  private pruneOldEvents(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    const events = this.store.get('events', {}) as Record<string, TokenEvent[]>;
    let pruned = false;
    for (const dayKey of Object.keys(events)) {
      const [year, month, day] = dayKey.split('-').map(Number);
      const dayDate = new Date(year, month - 1, day);
      if (dayDate.getTime() < cutoff) {
        this.store.delete(`events.${dayKey}` as any);
        pruned = true;
      }
    }
    if (pruned) {
      console.log('[Analytics] Pruned events older than 30 days');
    }
  }
}

export const analyticsService = new AnalyticsService();
