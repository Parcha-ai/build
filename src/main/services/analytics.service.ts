import Store from 'electron-store';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import type { Harness, RoutingDecision, TaskDomain, TaskTier } from '../../shared/types';

export interface TokenEvent {
  eventId?: string;
  source?: 'live' | 'transcript' | 'import';
  sessionId: string;
  sessionName: string;
  timestamp: number;
  model: string;
  harness?: Harness;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolName?: string;
  estimatedCostUsd: number;
  baselineCostUsd?: number;
  savingsVsBaselineUsd?: number;
  costMethod?: 'estimated' | 'reported' | 'unknown';
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
    baselineCost: number;
    savings: number;
  }>;
  byHarness: Array<{
    harness: string;
    cost: number;
    baselineCost: number;
    savings: number;
    tokenCount: number;
    turnCount: number;
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
  baselineCost: number;
  savingsVsBaseline: number;
  baselineModel: string;
  byHarness: Array<{
    harness: string;
    cost: number;
    baselineCost: number;
    savings: number;
    tokenCount: number;
    turnCount: number;
  }>;
}

export interface HarnessOutcomeEvent {
  eventId?: string;
  source?: 'live' | 'transcript' | 'import';
  sessionId: string;
  timestamp: number;
  harness: Harness;
  model: string;
  success: boolean;
  taskTier?: string;
  tokens?: number;
  costUsd?: number;
  error?: string;
  taskDomain?: string;
}

export interface HarnessOverrideEvent {
  eventId?: string;
  source?: 'live' | 'transcript' | 'import';
  sessionId: string;
  timestamp: number;
  fromModel?: string;
  toModel: string;
  harness: Harness;
  taskTier?: string;
  taskDomain?: string;
}

export interface HarnessSelectionEvent {
  eventId?: string;
  source?: 'live' | 'renderer' | 'import';
  sessionId: string;
  timestamp: number;
  fromModel?: string;
  toModel: string;
  fromHarness?: Harness;
  toHarness?: Harness;
  trigger: 'model-picker' | 'plan-nudge' | 'api' | 'other';
  isManualSelection?: boolean;
}

export interface PromptRoutingFeatures {
  charCount: number;
  wordCount: number;
  lineCount: number;
  questionCount: number;
  attachmentCount: number;
  attachmentTypes: string[];
  codeFenceCount: number;
  inlineCodeCount: number;
  diffLineCount: number;
  stackTraceLineCount: number;
  longLineCount: number;
  urlCount: number;
  filePathCount: number;
  hasCode: boolean;
  hasError: boolean;
  hasScreenshot: boolean;
  likelyDomain: TaskDomain;
  intentSignals: string[];
}

export interface RoutingTrainingEvent {
  eventId?: string;
  source?: 'live' | 'import';
  sessionId: string;
  sessionName?: string;
  timestamp: number;
  // Transient raw input only. This field is converted into sanitizedPrompt and
  // PromptRoutingFeatures, then dropped before local storage or PostHog capture.
  prompt?: string;
  sanitizedPrompt?: string;
  sanitizedPromptCharCount?: number;
  sanitizationVersion?: string;
  promptCharCount?: number;
  promptFeatures?: PromptRoutingFeatures;
  attachmentCount?: number;
  attachmentTypes?: string[];
  requestedModel?: string;
  selectedModel: string;
  selectedHarness?: Harness;
  selectionMode: 'auto' | 'manual' | 'default';
  selectionSource?: 'request' | 'session' | 'default';
  manualSelection: boolean;
  taskTier?: TaskTier;
  taskDomain?: TaskDomain;
  routingDecision?: Pick<RoutingDecision, 'tier' | 'domain' | 'resolvedModel' | 'resolvedHarness' | 'confidence' | 'method'>;
  permissionMode?: string;
  thinkingMode?: string;
  gstackMode?: string;
  isSSH?: boolean;
}

export interface HarnessInsight {
  harness: Harness;
  model: string;
  runs: number;
  successes: number;
  failures: number;
  successRate: number;
  overrideCount: number;
  totalTokens: number;
  totalCost: number;
  lastUsedAt: number;
  score: number;
  bestTier?: TaskTier;
  bestDomain?: TaskDomain;
  byTier: Partial<Record<TaskTier, HarnessTierInsight>>;
  byDomain: Partial<Record<TaskDomain, HarnessDomainInsight>>;
}

export interface HarnessTierInsight {
  taskTier: TaskTier;
  runs: number;
  successes: number;
  failures: number;
  successRate: number;
  overrideCount: number;
  totalTokens: number;
  totalCost: number;
  lastUsedAt: number;
}

export interface HarnessDomainInsight {
  taskDomain: TaskDomain;
  runs: number;
  successes: number;
  failures: number;
  successRate: number;
  overrideCount: number;
  totalTokens: number;
  totalCost: number;
  lastUsedAt: number;
}

export interface HistoricalRoutingCase {
  caseId: string;
  source: 'transcript';
  sessionId: string;
  sessionName: string;
  timestamp: number;
  message: string;
  expectedTier: TaskTier;
  expectedReason: string;
  actualModel?: string;
  actualHarness?: Harness;
  actualCostUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface HistoricalImportSummary {
  scannedFiles: number;
  changedFiles: number;
  importedTokenEvents: number;
  importedOutcomes: number;
  importedOverrides: number;
  importedCases: number;
  skippedFiles: number;
}

// Pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.50 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-0': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-3-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.50, cacheWrite: 5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4': { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 2.50 },
  'gpt-5.3-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'o3': { input: 2, output: 8, cacheRead: 0.50, cacheWrite: 2 },
  'composer-2.5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3 },
  'gemini-3.5-flash': { input: 1.50, output: 9, cacheRead: 0.15, cacheWrite: 1.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, cacheRead: 0.03, cacheWrite: 0.30 },
  'deepseek-v4-flash': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-v4-pro': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  'deepseek-v3.2': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
};

const DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };
const BASELINE_MODEL = 'codex:gpt-5.5';
const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';
const SANITIZATION_VERSION = 'routing-intent-v1';
const SANITIZED_PROMPT_CHAR_LIMIT = 4_000;

// Default usage tiers (Anthropic API plans)
const DEFAULT_TIER: UsageTierConfig = {
  monthlyIncludedUsd: 100, // Pro plan ~$100 effective included usage
  planName: 'Pro',
};

function getPricingForModel(modelId: string): typeof DEFAULT_PRICING {
  const normalized = modelId.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalized.includes(key) || normalized.includes(key.replace('claude-', ''))) {
      return pricing;
    }
  }
  if (normalized.includes('fable')) return MODEL_PRICING['claude-fable-5'];
  if (normalized.includes('opus')) return MODEL_PRICING['claude-opus-4-7'];
  if (normalized.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (normalized.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  if (normalized.includes('composer')) return MODEL_PRICING['composer-2.5'];
  if (normalized.includes('gemini') && normalized.includes('flash')) return MODEL_PRICING['gemini-2.5-flash'];
  if (normalized.includes('gemini') && normalized.includes('pro')) return MODEL_PRICING['gemini-2.5-pro'];
  if (normalized.includes('deepseek')) return MODEL_PRICING['deepseek-chat'];
  return DEFAULT_PRICING;
}

function harnessFromModel(model: string): Harness {
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('custom:')) return 'custom';
  return 'claude';
}

function transcriptSessionName(filePath: string): string {
  return path.basename(path.dirname(filePath)).replace(/^-/, '').replace(/-/g, '/').slice(0, 120) || 'Transcript session';
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      if (typeof record.name === 'string') return record.name;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeModelForAnalytics(model: string | undefined): string {
  if (!model) return 'claude-opus-4-7';
  if (model.startsWith('claude-') || model.includes(':')) return model;
  return model;
}

function transcriptUsageToTokens(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheCreation = usage?.cache_creation as Record<string, unknown> | undefined;
  const cacheWriteTokens = Number(usage?.cache_creation_input_tokens || 0)
    || Number(cacheCreation?.ephemeral_5m_input_tokens || 0)
    + Number(cacheCreation?.ephemeral_1h_input_tokens || 0);

  return {
    inputTokens: Number(usage?.input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
    cacheReadTokens: Number(usage?.cache_read_input_tokens || 0),
    cacheWriteTokens,
  };
}

function classifyHistoricalTaskTier(message: string): { tier: TaskTier; reason: string } {
  const lower = message.toLowerCase();
  if (/\b(test|verify|check|validate|qa|regression|lint|typecheck|failing|failed|error|exception|stack trace|debug|review)\b/.test(lower)) {
    return { tier: 'verify', reason: 'Historical prompt asks for validation, debugging, or review' };
  }
  if (/\b(plan|design|architect|approach|strategy|proposal|trade[- ]?off|think through|how should|research)\b/.test(lower)) {
    return { tier: 'plan', reason: 'Historical prompt asks for planning or design reasoning' };
  }
  if (/\b(implement|create|build|add|wire|integrate|ship|make|write|scaffold|refactor)\b/.test(lower) || message.length > 900) {
    return { tier: 'build', reason: 'Historical prompt asks for implementation or is a large build request' };
  }
  return { tier: 'refine', reason: 'Historical prompt is short or incremental' };
}

function inferOverrideModelFromUserMessage(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (/\b(cursor|cursor agent|composer)\b/.test(lower)) return 'cursor:composer-2.5';
  if (/\b(codex|openai)\b/.test(lower)) return 'codex:gpt-5.5';
  if (/\b(gemini)\b/.test(lower)) return 'gemini:gemini-3.5-flash';
  if (/\b(opencode|deepseek)\b/.test(lower)) return 'opencode:deepseek-v4-pro';
  if (/\b(fable)\b/.test(lower)) return 'claude-fable-5';
  if (/\b(haiku)\b/.test(lower)) return 'claude-haiku-4-5';
  if (/\b(sonnet)\b/.test(lower)) return 'claude-sonnet-4-6';
  if (/\b(opus)\b/.test(lower)) return 'claude-opus-4-7';
  return undefined;
}

function isExternalUserPrompt(entry: Record<string, unknown>, text: string): boolean {
  const message = entry.message as Record<string, unknown> | undefined;
  if (entry.type !== 'user' || message?.role !== 'user') return false;
  if (entry.userType && entry.userType !== 'external') return false;
  if (!text.trim()) return false;
  if (text.includes('<command-message>')) return false;
  if (/^The file .+ has been updated successfully\./.test(text.trim())) return false;
  if (/^Task #\d+ created successfully:/.test(text.trim())) return false;
  return true;
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

export function estimateBaselineCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  return estimateCost(BASELINE_MODEL, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
}

function withDerivedCostFields(event: TokenEvent): TokenEvent {
  const baselineCostUsd = event.baselineCostUsd ?? estimateBaselineCost(
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
  );
  return {
    ...event,
    harness: event.harness || harnessFromModel(event.model),
    baselineCostUsd,
    savingsVsBaselineUsd: event.savingsVsBaselineUsd ?? Math.max(0, baselineCostUsd - event.estimatedCostUsd),
    costMethod: event.costMethod || 'estimated',
  };
}

function addHarnessAggregate(
  map: Map<string, { cost: number; baselineCost: number; savings: number; tokenCount: number; turnCount: number }>,
  event: TokenEvent,
): void {
  const harness = event.harness || harnessFromModel(event.model);
  const existing = map.get(harness) || { cost: 0, baselineCost: 0, savings: 0, tokenCount: 0, turnCount: 0 };
  existing.cost += event.estimatedCostUsd;
  existing.baselineCost += event.baselineCostUsd || 0;
  existing.savings += event.savingsVsBaselineUsd || 0;
  existing.tokenCount += event.inputTokens + event.outputTokens;
  existing.turnCount += 1;
  map.set(harness, existing);
}

function normalizeTaskTier(tier?: string): TaskTier | undefined {
  if (tier === 'plan' || tier === 'build' || tier === 'verify' || tier === 'refine') return tier;
  return undefined;
}

function normalizeTaskDomain(domain?: string): TaskDomain | undefined {
  if (
    domain === 'copy' ||
    domain === 'frontend' ||
    domain === 'backend' ||
    domain === 'fullstack' ||
    domain === 'debug' ||
    domain === 'ops' ||
    domain === 'docs' ||
    domain === 'data' ||
    domain === 'general'
  ) {
    return domain;
  }
  return undefined;
}

function normalizePostHogHost(host: string | undefined): string {
  const normalized = (host || POSTHOG_DEFAULT_HOST).trim().replace(/\/+$/, '');
  return normalized || POSTHOG_DEFAULT_HOST;
}

function sanitizeCodeLanguage(language: string | undefined): string {
  const normalized = (language || '').trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 24);
  return normalized ? `:${normalized}` : '';
}

function filePathPlaceholder(filePath: string): string {
  const extension = path.extname(filePath).replace(/^\./, '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
  return extension ? `[FILE_PATH:${extension}]` : '[FILE_PATH]';
}

function collapsePlaceholderLines(text: string): string {
  const lines = text.split('\n');
  const collapsed: string[] = [];
  let previous = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[A-Z_]+(?::[a-z0-9+#.-]+)?\]$/.test(trimmed) && trimmed === previous) {
      continue;
    }
    collapsed.push(line);
    previous = trimmed;
  }

  return collapsed.join('\n');
}

function sanitizePromptForRouting(prompt: string): string {
  let sanitized = prompt
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[PRIVATE_KEY]')
    .replace(/```([A-Za-z0-9+#.-]*)[\s\S]*?```/g, (_match, language: string) => `[CODE_BLOCK${sanitizeCodeLanguage(language)}]`)
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[API_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{25,}\b/g, '[API_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [TOKEN]')
    .replace(/https?:\/\/[^\s"'<>)]*/gi, '[URL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP_ADDRESS]')
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/gi, '[IP_ADDRESS]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]');

  sanitized = sanitized.replace(
    /(^|[\s"'(])((?:[A-Za-z]:)?(?:[.~]?\/|\/)[^\s"'()<>]+|(?:[\w.-]+\/)+[\w.-]+\.\w{1,8})(?=$|[\s"',).:;!?])/g,
    (_match, prefix: string, filePath: string) => `${prefix}${filePathPlaceholder(filePath)}`,
  );

  sanitized = sanitized
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^(?:[+-]\s|@@\s)/.test(trimmed)) return '[DIFF_LINE]';
      if (/\bat\s+\S+\s+\(|Traceback \(most recent call last\)|^\s*File ".+", line \d+/i.test(line)) return '[STACK_TRACE_LINE]';
      if (/(api[_-]?key|token|secret|password|authorization)\s*[:=]/i.test(line)) return '[SECRET_LINE]';
      if (
        line.length > 140 &&
        (/[{};]/.test(line) || /\b(function|class|interface|const|let|var|import|export|return|async|await)\b/.test(line))
      ) {
        return '[CODE_LINE]';
      }
      return line;
    })
    .join('\n');

  sanitized = sanitized
    .replace(/`[^`\n]*`/g, '[INLINE_CODE]')
    .replace(/(["'])(?:(?!\1).){100,}\1/g, '[TEXT_LITERAL]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[HASH_OR_TOKEN]')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  sanitized = collapsePlaceholderLines(sanitized);
  if (sanitized.length > SANITIZED_PROMPT_CHAR_LIMIT) {
    sanitized = `${sanitized.slice(0, SANITIZED_PROMPT_CHAR_LIMIT)}\n[TRUNCATED]`;
  }
  return sanitized;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length || 0;
}

function extractIntentSignals(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const signals: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ['plan', /\b(plan|strategy|approach|architect|design|trade[- ]?off|research)\b/],
    ['build', /\b(implement|create|build|add|wire|integrate|ship|make|scaffold)\b/],
    ['verify', /\b(test|verify|check|validate|qa|debug|bug|broken|failing|error|regression)\b/],
    ['refine', /\b(copy|rewrite|rename|format|style|polish|tweak|change|adjust)\b/],
    ['review', /\b(review|audit|critique|inspect)\b/],
    ['onboarding', /\b(onboard|setup|install|login|auth|authenticated)\b/],
    ['routing', /\b(route|router|harness|model|agent|claude|codex|cursor|gemini|opencode)\b/],
    ['cost', /\b(cost|price|pricing|spend|cheap|savings|tokens)\b/],
    ['ui', /\b(ui|ux|modal|button|screen|page|website|frontend|copy)\b/],
  ];

  for (const [signal, pattern] of checks) {
    if (pattern.test(lower)) signals.push(signal);
  }

  return signals;
}

function classifyTaskDomain(prompt: string, attachmentTypes: string[] = []): TaskDomain {
  const lower = prompt.toLowerCase();
  const hasImage = attachmentTypes.includes('image');
  const copyScore = [
    /\b(copy|rewrite|headline|tagline|value prop|messaging|positioning|landing page|hero|cta|pricing copy|microcopy|tone|voice|pitch|website copy|content)\b/,
    /\b(make .+ (clearer|sharper|more impactful|punchier|concise|compelling))\b/,
  ].reduce((score, pattern) => score + (pattern.test(lower) ? 1 : 0), 0);
  const frontendScore = [
    /\b(frontend|front-end|ui|ux|css|tailwind|react|component|layout|responsive|mobile|browser|dom|visual|screenshot|animation|monaco|webview)\b/,
    /\.(tsx|jsx|css|scss|html)\b/,
  ].reduce((score, pattern) => score + (pattern.test(lower) ? 1 : 0), hasImage ? 1 : 0);
  const backendScore = [
    /\b(backend|back-end|api|database|db|schema|migration|server|worker|queue|auth|endpoint|ipc|service|controller|resolver|sql|postgres|redis)\b/,
    /\.(ts|js|py|go|rs|java|rb)\b/,
  ].reduce((score, pattern) => score + (pattern.test(lower) ? 1 : 0), 0);
  const opsScore = /\b(ci|deploy|docker|kubernetes|infra|env|build script|workflow|github actions|release|package|bundle)\b/.test(lower) ? 1 : 0;
  const dataScore = /\b(data|analytics|posthog|metric|dataset|eval|fine[- ]?tune|embedding|vector|report|dashboard)\b/.test(lower) ? 1 : 0;
  const docsScore = /\b(docs|documentation|readme|changelog|release notes|guide|manual)\b/.test(lower) ? 1 : 0;
  const debugScore = /\b(debug|broken|error|exception|stack trace|traceback|crash|failing|not working|regression)\b/.test(lower) ? 1 : 0;

  if (frontendScore > 0 && backendScore > 0) return 'fullstack';
  const scored: Array<[TaskDomain, number]> = [
    ['copy', copyScore],
    ['frontend', frontendScore],
    ['backend', backendScore],
    ['ops', opsScore],
    ['data', dataScore],
    ['docs', docsScore],
    ['debug', debugScore],
  ];
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0][1] > 0 ? scored[0][0] : 'general';
}

function extractPromptRoutingFeatures(prompt: string, attachmentCount = 0, attachmentTypes: string[] = []): PromptRoutingFeatures {
  const lines = prompt.split(/\r?\n/);
  const codeFenceCount = countMatches(prompt, /```/g);
  const inlineCodeCount = countMatches(prompt, /`[^`\n]{1,120}`/g);
  const diffLineCount = lines.filter((line) => /^[+-]\s/.test(line) || /^@@\s/.test(line)).length;
  const stackTraceLineCount = lines.filter((line) => /\bat\s+\S+\s+\(|Traceback \(most recent call last\)|^\s*File ".+", line \d+/i.test(line)).length;
  const longLineCount = lines.filter((line) => line.length > 180).length;
  const urlCount = countMatches(prompt, /https?:\/\/\S+/gi);
  const filePathCount = countMatches(prompt, /(?:^|\s)(?:[.~]?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,8}(?=\s|$|:)/g);
  const hasCode = codeFenceCount > 0
    || inlineCodeCount > 2
    || diffLineCount > 0
    || /\b(function|class|interface|const|let|var|import|export|return|async|await)\b/.test(prompt);

  return {
    charCount: prompt.length,
    wordCount: prompt.trim() ? prompt.trim().split(/\s+/).length : 0,
    lineCount: lines.length,
    questionCount: countMatches(prompt, /\?/g),
    attachmentCount,
    attachmentTypes: attachmentTypes.slice(0, 12),
    codeFenceCount,
    inlineCodeCount,
    diffLineCount,
    stackTraceLineCount,
    longLineCount,
    urlCount,
    filePathCount,
    hasCode,
    hasError: /\b(error|exception|failed|failing|crash|stack trace|traceback|unauthorized|authenticated)\b/i.test(prompt),
    hasScreenshot: attachmentTypes.includes('image') || /\b(screenshot|image|screen|console logs?)\b/i.test(prompt),
    likelyDomain: classifyTaskDomain(prompt, attachmentTypes),
    intentSignals: extractIntentSignals(prompt),
  };
}

function compactRoutingDecision(decision?: RoutingTrainingEvent['routingDecision']): RoutingTrainingEvent['routingDecision'] | undefined {
  if (!decision) return undefined;
  return {
    tier: decision.tier,
    resolvedModel: decision.resolvedModel,
    resolvedHarness: decision.resolvedHarness,
    confidence: decision.confidence,
    method: decision.method,
    domain: decision.domain,
  };
}

function sanitizePostHogProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (key === 'prompt' || key === 'sessionName' || key === 'error') continue;
    if (key === 'routingDecision' && value && typeof value === 'object') {
      const decision = value as Record<string, unknown>;
      safe.routingDecision = {
        tier: decision.tier,
        domain: decision.domain,
        resolvedModel: decision.resolvedModel,
        resolvedHarness: decision.resolvedHarness,
        confidence: decision.confidence,
        method: decision.method,
      };
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function createHarnessInsight(harness: Harness, model: string): HarnessInsight {
  return {
    harness,
    model,
    runs: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    overrideCount: 0,
    totalTokens: 0,
    totalCost: 0,
    lastUsedAt: 0,
    score: 0,
    byTier: {},
    byDomain: {},
  };
}

function createHarnessTierInsight(taskTier: TaskTier): HarnessTierInsight {
  return {
    taskTier,
    runs: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    overrideCount: 0,
    totalTokens: 0,
    totalCost: 0,
    lastUsedAt: 0,
  };
}

function createHarnessDomainInsight(taskDomain: TaskDomain): HarnessDomainInsight {
  return {
    taskDomain,
    runs: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
    overrideCount: 0,
    totalTokens: 0,
    totalCost: 0,
    lastUsedAt: 0,
  };
}

function applyHarnessOutcomeToStats(
  stats: HarnessInsight | HarnessTierInsight | HarnessDomainInsight,
  outcome: HarnessOutcomeEvent,
): void {
  stats.runs += 1;
  if (outcome.success) stats.successes += 1;
  else stats.failures += 1;
  stats.totalTokens += outcome.tokens || 0;
  stats.totalCost += outcome.costUsd || 0;
  stats.lastUsedAt = Math.max(stats.lastUsedAt, outcome.timestamp);
  stats.successRate = stats.runs > 0 ? stats.successes / stats.runs : 0;
}

function applyHarnessOverrideToStats(
  stats: HarnessInsight | HarnessTierInsight | HarnessDomainInsight,
  override: HarnessOverrideEvent,
): void {
  stats.overrideCount += 1;
  stats.lastUsedAt = Math.max(stats.lastUsedAt, override.timestamp);
}

function scoreHarnessStats(stats: HarnessInsight | HarnessTierInsight | HarnessDomainInsight): number {
  const reliability = stats.runs > 0
    ? (stats.successes * 2) - (stats.failures * 3) + (stats.successRate * 2)
    : 0;
  const overrideSignal = stats.overrideCount * 4;
  const usageSignal = Math.log1p(stats.runs + stats.totalTokens / 100_000);
  const recencySignal = stats.lastUsedAt > 0
    ? Math.max(0, 2 - ((Date.now() - stats.lastUsedAt) / (14 * 24 * 3600_000)))
    : 0;
  return reliability + overrideSignal + usageSignal + recencySignal;
}

class AnalyticsService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private settingsStore: any;
  private tierConfig: UsageTierConfig;
  private harnessInsightsCache?: { expiresAt: number; insights: HarnessInsight[] };

  constructor() {
    this.store = new Store({ name: 'claudette-analytics' });
    this.settingsStore = new Store({ name: 'claudette-settings' });
    this.tierConfig = this.store.get('tierConfig', DEFAULT_TIER) as UsageTierConfig;
    this.ensureDistinctId();
    this.pruneOldEvents();
    setTimeout(() => {
      this.refreshHistoricalUsageFromTranscripts({ maxFiles: 1 }).catch((error) => {
        console.warn('[Analytics] Historical transcript import failed:', error);
      });
    }, 60_000).unref?.();
  }

  setTierConfig(config: UsageTierConfig): void {
    this.tierConfig = config;
    this.store.set('tierConfig', config);
  }

  getTierConfig(): UsageTierConfig {
    return this.tierConfig;
  }

  recordTokenEvent(event: TokenEvent): boolean {
    const dayKey = this.getDayKey(event.timestamp);
    const normalizedEvent = withDerivedCostFields(event);
    const events = this.store.get(`events.${dayKey}`, []) as TokenEvent[];
    if (normalizedEvent.eventId && events.some((existing) => existing.eventId === normalizedEvent.eventId)) {
      return false;
    }
    events.push(normalizedEvent);
    this.store.set(`events.${dayKey}`, events);
    return true;
  }

  recordHarnessOutcome(event: HarnessOutcomeEvent): boolean {
    const key = `harnessOutcomes.${this.getDayKey(event.timestamp)}`;
    const events = this.store.get(key, []) as HarnessOutcomeEvent[];
    if (event.eventId && events.some((existing) => existing.eventId === event.eventId)) {
      return false;
    }
    events.push({
      ...event,
      error: event.error?.slice(0, 500),
    });
    this.store.set(key, events);
    this.harnessInsightsCache = undefined;
    return true;
  }

  recordHarnessOverride(event: HarnessOverrideEvent): boolean {
    const key = `harnessOverrides.${this.getDayKey(event.timestamp)}`;
    const events = this.store.get(key, []) as HarnessOverrideEvent[];
    if (event.eventId && events.some((candidate) => candidate.eventId === event.eventId)) {
      return false;
    }
    const recentDuplicate = events.find((candidate) =>
      candidate.sessionId === event.sessionId &&
      candidate.toModel === event.toModel &&
      Math.abs(candidate.timestamp - event.timestamp) < 60_000
    );
    if (recentDuplicate) return false;
    events.push(event);
    this.store.set(key, events);
    this.harnessInsightsCache = undefined;
    return true;
  }

  recordHarnessSelection(event: HarnessSelectionEvent): boolean {
    const key = `harnessSelections.${this.getDayKey(event.timestamp)}`;
    const events = this.store.get(key, []) as HarnessSelectionEvent[];
    if (event.eventId && events.some((candidate) => candidate.eventId === event.eventId)) {
      return false;
    }

    const normalizedEvent: HarnessSelectionEvent = {
      ...event,
      eventId: event.eventId || randomUUID(),
      source: event.source || 'renderer',
      timestamp: event.timestamp || Date.now(),
      fromHarness: event.fromHarness || (event.fromModel ? harnessFromModel(event.fromModel) : undefined),
      toHarness: event.toHarness || harnessFromModel(event.toModel),
      isManualSelection: event.isManualSelection ?? event.toModel !== 'auto',
    };

    events.push(normalizedEvent);
    this.store.set(key, events);
    this.harnessInsightsCache = undefined;
    this.capturePostHog('build_harness_selection', { ...normalizedEvent });
    return true;
  }

  recordRoutingTrainingExample(event: RoutingTrainingEvent): boolean {
    const key = `routingTraining.${this.getDayKey(event.timestamp)}`;
    const events = this.store.get(key, []) as RoutingTrainingEvent[];
    if (event.eventId && events.some((candidate) => candidate.eventId === event.eventId)) {
      return false;
    }

    const prompt = event.prompt || '';
    const { prompt: _transientPrompt, sessionName: _sessionName, ...persistableEvent } = event;
    const sanitizedPrompt = event.sanitizedPrompt || sanitizePromptForRouting(prompt);
    const normalizedEvent: RoutingTrainingEvent = {
      ...persistableEvent,
      eventId: event.eventId || randomUUID(),
      source: event.source || 'live',
      timestamp: event.timestamp || Date.now(),
      sanitizedPrompt,
      sanitizedPromptCharCount: sanitizedPrompt.length,
      sanitizationVersion: SANITIZATION_VERSION,
      promptCharCount: event.promptCharCount ?? prompt.length,
      promptFeatures: event.promptFeatures || extractPromptRoutingFeatures(prompt, event.attachmentCount || 0, event.attachmentTypes || []),
      selectedHarness: event.selectedHarness || harnessFromModel(event.selectedModel),
      manualSelection: event.manualSelection,
      taskDomain: event.taskDomain || event.routingDecision?.domain || classifyTaskDomain(prompt, event.attachmentTypes || []),
      routingDecision: compactRoutingDecision(event.routingDecision),
      attachmentTypes: event.attachmentTypes?.slice(0, 12),
    };

    events.push(normalizedEvent);
    this.store.set(key, events);
    this.capturePostHog('build_routing_training_example', { ...normalizedEvent });
    return true;
  }

  async refreshHistoricalUsageFromTranscripts(options?: { includeSubagents?: boolean; maxFiles?: number }): Promise<HistoricalImportSummary> {
    const files = await this.findTranscriptFiles({ ...options, maxFiles: options?.maxFiles ?? 6 });
    const fileState = this.store.get('historicalUsage.files', {}) as Record<string, { mtimeMs: number; size: number; importedAt: number }>;
    const summary: HistoricalImportSummary = {
      scannedFiles: files.length,
      changedFiles: 0,
      importedTokenEvents: 0,
      importedOutcomes: 0,
      importedOverrides: 0,
      importedCases: 0,
      skippedFiles: 0,
    };

    for (const filePath of files) {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        summary.skippedFiles += 1;
        continue;
      }

      const previous = fileState[filePath];
      if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        summary.skippedFiles += 1;
        continue;
      }

      summary.changedFiles += 1;
      try {
        const imported = await this.importTranscriptFile(filePath);
        summary.importedTokenEvents += imported.tokenEvents;
        summary.importedOutcomes += imported.outcomes;
        summary.importedOverrides += imported.overrides;
        summary.importedCases += imported.cases;
        fileState[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, importedAt: Date.now() };
      } catch (error) {
        summary.skippedFiles += 1;
        console.warn('[Analytics] Failed to import transcript usage:', filePath, error);
      }
    }

    this.store.set('historicalUsage.files', fileState);
    this.store.set('historicalUsage.lastSummary', summary);
    this.store.set('historicalUsage.lastImportedAt', Date.now());
    return summary;
  }

  async getHistoricalRoutingDataset(options?: { limit?: number; includeSubagents?: boolean }): Promise<HistoricalRoutingCase[]> {
    const limit = Math.max(1, options?.limit || 300);
    const files = await this.findTranscriptFiles({ includeSubagents: options?.includeSubagents });
    const cases: HistoricalRoutingCase[] = [];
    for (const filePath of files) {
      if (cases.length >= limit) break;
      try {
        cases.push(...await this.extractRoutingCasesFromTranscript(filePath, limit - cases.length));
      } catch {
        // Ignore unreadable or partially-written transcripts.
      }
    }

    return cases
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  getHarnessInsights(): HarnessInsight[] {
    if (this.harnessInsightsCache && this.harnessInsightsCache.expiresAt > Date.now()) {
      return this.harnessInsightsCache.insights;
    }

    const outcomes = this.getAllEvents<HarnessOutcomeEvent>('harnessOutcomes');
    const overrides = this.getAllEvents<HarnessOverrideEvent>('harnessOverrides');
    const map = new Map<string, HarnessInsight>();

    for (const outcome of outcomes) {
      const key = `${outcome.harness}:${outcome.model}`;
      const existing = map.get(key) || createHarnessInsight(outcome.harness, outcome.model);
      applyHarnessOutcomeToStats(existing, outcome);
      const taskTier = normalizeTaskTier(outcome.taskTier);
      if (taskTier) {
        const tierStats = existing.byTier[taskTier] || createHarnessTierInsight(taskTier);
        applyHarnessOutcomeToStats(tierStats, outcome);
        existing.byTier[taskTier] = tierStats;
      }
      const taskDomain = normalizeTaskDomain(outcome.taskDomain);
      if (taskDomain) {
        const domainStats = existing.byDomain[taskDomain] || createHarnessDomainInsight(taskDomain);
        applyHarnessOutcomeToStats(domainStats, outcome);
        existing.byDomain[taskDomain] = domainStats;
      }
      map.set(key, existing);
    }

    for (const override of overrides) {
      const key = `${override.harness}:${override.toModel}`;
      const existing = map.get(key) || createHarnessInsight(override.harness, override.toModel);
      applyHarnessOverrideToStats(existing, override);
      const taskTier = normalizeTaskTier(override.taskTier);
      if (taskTier) {
        const tierStats = existing.byTier[taskTier] || createHarnessTierInsight(taskTier);
        applyHarnessOverrideToStats(tierStats, override);
        existing.byTier[taskTier] = tierStats;
      }
      const taskDomain = normalizeTaskDomain(override.taskDomain);
      if (taskDomain) {
        const domainStats = existing.byDomain[taskDomain] || createHarnessDomainInsight(taskDomain);
        applyHarnessOverrideToStats(domainStats, override);
        existing.byDomain[taskDomain] = domainStats;
      }
      map.set(key, existing);
    }

    const insights = Array.from(map.values())
      .map((insight) => {
        const tierScores = Object.entries(insight.byTier).map(([tier, stats]) => ({
          tier: tier as TaskTier,
          score: stats ? scoreHarnessStats(stats) : 0,
        }));
        const bestTier = tierScores.sort((a, b) => b.score - a.score)[0]?.tier;
        const domainScores = Object.entries(insight.byDomain).map(([domain, stats]) => ({
          domain: domain as TaskDomain,
          score: stats ? scoreHarnessStats(stats) : 0,
        }));
        const bestDomain = domainScores.sort((a, b) => b.score - a.score)[0]?.domain;
        return {
          ...insight,
          score: scoreHarnessStats(insight),
          bestTier,
          bestDomain,
        };
      })
      .sort((a, b) => b.score - a.score);
    this.harnessInsightsCache = { expiresAt: Date.now() + 30_000, insights };
    return insights;
  }

  getHarnessInsightsForTier(tier: TaskTier, domain?: TaskDomain): HarnessInsight[] {
    return this.getHarnessInsights()
      .slice()
      .sort((a, b) => {
        const aTierStats = a.byTier[tier];
        const bTierStats = b.byTier[tier];
        const aTierScore = aTierStats ? scoreHarnessStats(aTierStats) + 3 : 0;
        const bTierScore = bTierStats ? scoreHarnessStats(bTierStats) + 3 : 0;
        const aDomainStats = domain ? a.byDomain[domain] : undefined;
        const bDomainStats = domain ? b.byDomain[domain] : undefined;
        const aDomainScore = aDomainStats ? scoreHarnessStats(aDomainStats) + 4 : 0;
        const bDomainScore = bDomainStats ? scoreHarnessStats(bDomainStats) + 4 : 0;
        return (bTierScore + bDomainScore + b.score * 0.25) - (aTierScore + aDomainScore + a.score * 0.25);
      });
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
    let baselineCost = 0;
    let savingsVsBaseline = 0;
    const harnessMap = new Map<string, { cost: number; baselineCost: number; savings: number; tokenCount: number; turnCount: number }>();

    for (const dayKey of allDayKeys) {
      const events = this.store.get(`events.${dayKey}`, []) as TokenEvent[];
      for (const rawEvent of events) {
        const event = withDerivedCostFields(rawEvent);
        if (event.sessionId === sessionId) {
          totalCost += event.estimatedCostUsd;
          totalTokens += event.inputTokens + event.outputTokens;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          cacheReadTokens += event.cacheReadTokens;
          cacheWriteTokens += event.cacheWriteTokens;
          baselineCost += event.baselineCostUsd || 0;
          savingsVsBaseline += event.savingsVsBaselineUsd || 0;
          addHarnessAggregate(harnessMap, event);
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
      baselineCost,
      savingsVsBaseline,
      baselineModel: BASELINE_MODEL,
      byHarness: Array.from(harnessMap.entries())
        .map(([harness, data]) => ({ harness, ...data }))
        .sort((a, b) => b.cost - a.cost),
    };
  }

  getSummary(): AnalyticsSummary {
    const todayEvents = this.getEventsForDay();
    const monthEvents = this.getEventsForMonth();

    const normalizedTodayEvents = todayEvents.map(withDerivedCostFields);
    const normalizedMonthEvents = monthEvents.map(withDerivedCostFields);

    const todayTotalCost = normalizedTodayEvents.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    const todayTotalTokens = normalizedTodayEvents.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    const todayCacheRead = normalizedTodayEvents.reduce((sum, e) => sum + e.cacheReadTokens, 0);
    const todayTotalInput = normalizedTodayEvents.reduce((sum, e) => sum + e.inputTokens, 0);
    const todayCacheHitRate = todayTotalInput > 0 ? (todayCacheRead / todayTotalInput) * 100 : 0;

    const monthTotalCost = normalizedMonthEvents.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
    const monthExtraUsageCost = Math.max(0, monthTotalCost - this.tierConfig.monthlyIncludedUsd);
    const isOverIncludedUsage = monthTotalCost > this.tierConfig.monthlyIncludedUsd;
    const percentOfIncluded = (monthTotalCost / this.tierConfig.monthlyIncludedUsd) * 100;

    // By session
    const sessionMap = new Map<string, { sessionName: string; model: string; totalTokens: number; cost: number; baselineCost: number; savings: number }>();
    for (const e of normalizedTodayEvents) {
      const existing = sessionMap.get(e.sessionId) || { sessionName: e.sessionName, model: e.model, totalTokens: 0, cost: 0, baselineCost: 0, savings: 0 };
      existing.totalTokens += e.inputTokens + e.outputTokens;
      existing.cost += e.estimatedCostUsd;
      existing.baselineCost += e.baselineCostUsd || 0;
      existing.savings += e.savingsVsBaselineUsd || 0;
      existing.model = e.model;
      sessionMap.set(e.sessionId, existing);
    }
    const bySession = Array.from(sessionMap.entries())
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.cost - a.cost);

    const harnessMap = new Map<string, { cost: number; baselineCost: number; savings: number; tokenCount: number; turnCount: number }>();
    for (const e of normalizedTodayEvents) {
      addHarnessAggregate(harnessMap, e);
    }
    const byHarness = Array.from(harnessMap.entries())
      .map(([harness, data]) => ({ harness, ...data }))
      .sort((a, b) => b.cost - a.cost);

    // By model
    const modelMap = new Map<string, { cost: number; tokenCount: number }>();
    for (const e of normalizedTodayEvents) {
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
    for (const e of normalizedTodayEvents) {
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
    for (const e of normalizedTodayEvents) {
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
      byHarness,
      byModel,
      byTool,
      hourlyTimeline,
    };
  }

  private getMonthTotalCost(): number {
    return this.getEventsForMonth().reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  getMonthSpendPercentage(): number {
    const monthCost = this.getMonthTotalCost();
    return (monthCost / this.tierConfig.monthlyIncludedUsd) * 100;
  }

  private ensureDistinctId(): string {
    const existing = this.store.get('posthog.distinctId') as string | undefined;
    if (existing) return existing;
    const created = randomUUID();
    this.store.set('posthog.distinctId', created);
    return created;
  }

  private getPostHogConfig(): { apiKey: string; host: string } {
    const settings = this.settingsStore.get('settings', {}) as Record<string, unknown>;
    const apiKey = String(
      settings.posthogApiKey
        || process.env.BUILD_POSTHOG_API_KEY
        || process.env.POSTHOG_PROJECT_API_KEY
        || process.env.POSTHOG_API_KEY
        || ''
    ).trim();
    const host = normalizePostHogHost(String(settings.posthogHost || process.env.POSTHOG_HOST || ''));
    return { apiKey, host };
  }

  private capturePostHog(event: string, properties: Record<string, unknown>): void {
    const { apiKey, host } = this.getPostHogConfig();
    if (!apiKey || typeof fetch !== 'function') return;
    const safeProperties = sanitizePostHogProperties(properties);

    const payload = {
      api_key: apiKey,
      event,
      distinct_id: this.ensureDistinctId(),
      properties: {
        ...safeProperties,
        $ip: null,
        $geoip_disable: true,
        $process_person_profile: false,
        app: 'build',
        app_version: process.env.npm_package_version,
        environment: process.env.NODE_ENV || 'production',
      },
    };

    fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((response) => {
      if (!response.ok) {
        console.warn(`[Analytics] PostHog capture failed for ${event}: ${response.status} ${response.statusText}`);
      }
    }).catch((error) => {
      console.warn(`[Analytics] PostHog capture failed for ${event}:`, error);
    });
  }

  private getDayKey(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private getAllDayKeys(): string[] {
    const events = this.store.get('events', {}) as Record<string, unknown>;
    return Object.keys(events);
  }

  private getAllEvents<T>(bucket: string): T[] {
    const events = this.store.get(bucket, {}) as Record<string, T[]>;
    return Object.values(events).flat();
  }

  private async findTranscriptFiles(options?: { includeSubagents?: boolean; maxFiles?: number }): Promise<string[]> {
    const root = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    const includeSubagents = options?.includeSubagents === true;
    const maxFiles = options?.maxFiles || 2_000;

    const walk = async (dir: string): Promise<void> => {
      if (files.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!includeSubagents && entry.name === 'subagents') continue;
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = await fsp.stat(fullPath);
            files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
          } catch {
            // Ignore files deleted during scanning.
          }
        }
      }
    };

    await walk(root);
    return files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles)
      .map((file) => file.filePath);
  }

  private async importTranscriptFile(filePath: string): Promise<{ tokenEvents: number; outcomes: number; overrides: number; cases: number }> {
    const sessionName = transcriptSessionName(filePath);
    let sessionId = path.basename(filePath, '.jsonl');
    let tokenEvents = 0;
    let outcomes = 0;
    let overrides = 0;
    let cases = 0;
    let lastUserTier: TaskTier | undefined;
    let lastUserDomain: TaskDomain | undefined;
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof entry.sessionId === 'string') {
        sessionId = entry.sessionId;
      }

      const message = entry.message as Record<string, unknown> | undefined;
      const timestamp = Date.parse(String(entry.timestamp || '')) || Date.now();

      if (entry.type === 'user') {
        const text = extractTextContent(message?.content);
        if (isExternalUserPrompt(entry, text)) {
          const classified = classifyHistoricalTaskTier(text);
          const taskDomain = classifyTaskDomain(text);
          const overrideModel = inferOverrideModelFromUserMessage(text);
          lastUserTier = classified.tier;
          lastUserDomain = taskDomain;
          cases += 1;
          if (overrideModel) {
            const didRecord = this.recordHarnessOverride({
              eventId: `transcript-override:${sessionId}:${entry.uuid || entry.promptId || timestamp}:${overrideModel}`,
              source: 'transcript',
              sessionId,
              timestamp,
              fromModel: 'auto',
              toModel: overrideModel,
              harness: harnessFromModel(overrideModel),
              taskTier: classified.tier,
              taskDomain,
            });
            if (didRecord) overrides += 1;
          }
        }
        continue;
      }

      if (entry.type !== 'assistant' || !message) continue;
      const model = normalizeModelForAnalytics(String(message.model || ''));
      const usage = message.usage as Record<string, unknown> | undefined;
      const tokens = transcriptUsageToTokens(usage);
      const totalTokens = tokens.inputTokens + tokens.outputTokens;
      const eventId = `transcript-token:${sessionId}:${entry.uuid || message.id || timestamp}`;
      const costUsd = estimateCost(model, tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens);

      if (totalTokens > 0) {
        const didRecord = this.recordTokenEvent({
          eventId,
          source: 'transcript',
          sessionId,
          sessionName,
          timestamp,
          model,
          harness: harnessFromModel(model),
          ...tokens,
          estimatedCostUsd: costUsd,
          costMethod: 'estimated',
        });
        if (didRecord) tokenEvents += 1;
      }

      const assistantText = extractAssistantText(message.content);
      const failed = /authentication failed|not authenticated|error:|could not complete|failed after|tool use failed/i.test(assistantText);
      const didRecordOutcome = this.recordHarnessOutcome({
        eventId: `transcript-outcome:${sessionId}:${entry.uuid || message.id || timestamp}`,
        source: 'transcript',
        sessionId,
        timestamp,
        harness: harnessFromModel(model),
        model,
        success: !failed,
        taskTier: lastUserTier,
        taskDomain: lastUserDomain,
        tokens: totalTokens,
        costUsd,
        error: failed ? assistantText.slice(0, 500) : undefined,
      });
      if (didRecordOutcome) outcomes += 1;
    }

    return { tokenEvents, outcomes, overrides, cases };
  }

  private async extractRoutingCasesFromTranscript(filePath: string, limit: number): Promise<HistoricalRoutingCase[]> {
    const text = await this.readTranscriptTail(filePath);
    const lines = text.split('\n');
    const sessionName = transcriptSessionName(filePath);
    let sessionId = path.basename(filePath, '.jsonl');
    const cases: HistoricalRoutingCase[] = [];
    let pendingCase: HistoricalRoutingCase | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof entry.sessionId === 'string') {
        sessionId = entry.sessionId;
      }

      const message = entry.message as Record<string, unknown> | undefined;
      const timestamp = Date.parse(String(entry.timestamp || '')) || Date.now();

      if (entry.type === 'user') {
        const text = extractTextContent(message?.content);
        if (!isExternalUserPrompt(entry, text)) continue;
        const classified = classifyHistoricalTaskTier(text);
        pendingCase = {
          caseId: `${sessionId}:${entry.uuid || entry.promptId || timestamp}`,
          source: 'transcript',
          sessionId,
          sessionName,
          timestamp,
          message: text.slice(0, 8_000),
          expectedTier: classified.tier,
          expectedReason: classified.reason,
          inputTokens: Math.max(1, Math.ceil(text.length / 4)),
          outputTokens: 800,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        cases.push(pendingCase);
        if (cases.length >= limit) {
          pendingCase = undefined;
          break;
        }
        continue;
      }

      if (entry.type === 'assistant' && pendingCase && message) {
        const model = normalizeModelForAnalytics(String(message.model || ''));
        const tokens = transcriptUsageToTokens(message.usage as Record<string, unknown> | undefined);
        const hasRealUsage = tokens.inputTokens + tokens.outputTokens > 0;
        pendingCase.actualModel = model;
        pendingCase.actualHarness = harnessFromModel(model);
        if (hasRealUsage) {
          pendingCase.inputTokens = tokens.inputTokens;
          pendingCase.outputTokens = tokens.outputTokens;
          pendingCase.cacheReadTokens = tokens.cacheReadTokens;
          pendingCase.cacheWriteTokens = tokens.cacheWriteTokens;
          pendingCase.actualCostUsd = estimateCost(model, tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens);
        }
        pendingCase = undefined;
      }
    }

    return cases;
  }

  private async readTranscriptTail(filePath: string): Promise<string> {
    const maxBytes = 2 * 1024 * 1024;
    const stat = await fsp.stat(filePath);
    if (stat.size <= maxBytes) {
      return fsp.readFile(filePath, 'utf8');
    }

    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, stat.size - maxBytes);
      const text = buffer.toString('utf8');
      const firstNewline = text.indexOf('\n');
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    } finally {
      await handle.close();
    }
  }

  private pruneOldEvents(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    const buckets = ['events', 'harnessOutcomes', 'harnessOverrides', 'routingTraining', 'harnessSelections'];
    let pruned = false;

    for (const bucket of buckets) {
      const events = this.store.get(bucket, {}) as Record<string, unknown[]>;
      for (const dayKey of Object.keys(events)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const dayDate = new Date(year, month - 1, day);
        if (dayDate.getTime() < cutoff) {
          this.store.delete(`${bucket}.${dayKey}` as any);
          pruned = true;
        }
      }
    }

    if (pruned) {
      console.log('[Analytics] Pruned events older than 30 days');
    }
  }
}

export const analyticsService = new AnalyticsService();
