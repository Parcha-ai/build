import type {
  TaskTier,
  TaskDomain,
  RoutingDecision,
  AutoRouterConfig,
  SessionPhase,
  Harness,
  OrchestrationPlan,
  OrchestrationStage,
  ChatMessage,
  MetaHarnessPolicy,
  MetaHarnessSpeed,
  MetaWorkflowMode,
  MetaVerificationMode,
  PlanningGateChangeKind,
  PlanningGateDecision,
} from '../../shared/types';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';
import { analyticsService } from './analytics.service';
import { flueMetaRouterService } from './flue-meta-router.service';
import type { FlueMetaRouteDecision, FlueMetaStageDecision } from './flue-meta-router.service';
import Store from 'electron-store';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { findUsableLocalExecutable, hasUsableLocalExecutable } from '../utils/local-executable';
import {
  ZAI_GLM_CLAUDE_MODEL_PICKER_ID,
  isZaiGlmCodexModel,
} from '../../shared/config/zai-glm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;
let codexCliAvailableCache: boolean | undefined;
let cursorCliAvailableCache: boolean | undefined;
let cursorCliAuthCache: { checkedAt: number; loggedIn: boolean } | undefined;
let geminiCliAvailableCache: boolean | undefined;
let openCodeCliAvailableCache: boolean | undefined;
let settingsObjectCache: { expiresAt: number; value: Record<string, unknown> } | undefined;

const DEFAULT_CONFIG: AutoRouterConfig = {
  enabled: true,
  prePlanEnabled: true,
  prePlanModel: 'claude-fable-5',
  planModel: 'claude-sonnet-4-6',
  buildModel: 'codex:gpt-5.6-sol',
  verifyModel: 'codex:gpt-5.6-sol',
  refineModel: 'cursor:composer-2.5',
  fallbackModel: 'claude-sonnet-4-6',
  costAware: true,
  costThresholdPercent: 80,
};
const META_MIN_CONFIDENCE = 0.55;

interface FailureCooldown {
  count: number;
  cooldownUntil: number;
  lastError?: string;
  model?: string;
}

// Per-session workflow phase tracking
const sessionPhases = new Map<string, SessionPhase>();
const sessionHarnessFailures = new Map<string, Map<Harness, FailureCooldown>>();
const sessionModelFailures = new Map<string, Map<string, FailureCooldown>>();
const EXTERNAL_HARNESS_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const EXTERNAL_HARNESS_FAILURE_COOLDOWN_MAX_MS = 60 * 60 * 1000;

// Heuristic signal patterns
const PLAN_SIGNALS = [
  'plan', 'design', 'architect', 'think about', 'how should we',
  'review this', "what's the best approach", 'trade-offs', 'tradeoffs',
  'strategy', 'code review', 'review the', 'what do you think',
  'should we', 'pros and cons', 'evaluate', 'compare',
  'risk', 'risks', 'rollout path', 'safe rollout', 'before editing',
  'before changing', 'decide if', 'map the',
];

const BUILD_SIGNALS = [
  'implement', 'create', 'build', 'add feature', 'scaffold',
  'from the plan', 'execute the plan', 'write the code',
  'set up', 'integrate', 'develop', 'code this', 'wire',
  'api', 'endpoint',
  'make a', 'make the', 'make it', 'add a new', 'add the',
  'improve', 'enhance', 'strengthen', 'tune', 'upgrade',
  'fix', 'finish',
];

const VERIFY_SIGNALS = [
  'test', 'verify', 'qa', 'check', 'debug', 'why is this',
  'investigate', 'fix this bug', 'broken', 'failing',
  'not working', 'error', 'regression', 'diagnose',
  'what went wrong', 'stack trace', 'reproduce', 'isolate',
  'flaky', 'intermittent', 'intermittently', 'root cause', 'exact cause',
  'checks', 'lint', 'typecheck',
];

const CAPABILITY_ESCALATION_SIGNALS = [
  'look harder', 'think harder', 'try harder', 'dig deeper',
  'go deeper', 'look closer',
  'think deeper', 'reason harder', 'reason deeper',
  'more careful', 'more carefully', 'think carefully',
  'use a stronger model',
  'use a more powerful model', 'stronger model', 'more powerful model',
  'powerful model', 'smarter model', 'use opus', 'switch to opus',
  'stronger reasoning', 'more reasoning', 'deeper reasoning',
];

const REFINE_SIGNALS = [
  'tweak', 'adjust', 'rename', 'format', 'style', 'small fix',
  'update the text', 'change the color', 'change the colour',
  'move this', 'cleanup', 'clean up', 'polish', 'typo',
  'spacing', 'padding', 'margin', 'font', 'wording',
  'button text', 'label', 'shorter', 'longer',
  'swap', 'replace the', 'quick fix', 'minor',
];

const MUTATING_WORKFLOW_NAMES = '(?:pr|git-pr|pr-tests|pr-loop|release|deploy|ship)';

/** Explicit execution workflows are phase boundaries, not planning requests.
 * The resolved cross-harness prompt contains an invoked_workflow tag; the
 * prose form covers a turn before slash expansion or a direct router call. */
function isExplicitMutatingWorkflowExecution(message: string): boolean {
  if (new RegExp(`<invoked_workflow\\b[^>]*\\bname=["']/${MUTATING_WORKFLOW_NAMES}["']`, 'i').test(message)) {
    return true;
  }

  const trimmed = message.trim();
  if (new RegExp(`^/${MUTATING_WORKFLOW_NAMES}(?:\\s|$)`, 'i').test(trimmed)) return true;
  if (new RegExp(`\\b(?:don'?t|do not|never)\\s+(?:(?:run|execute|invoke|start|do)\\s+)?(?:the\\s+)?/${MUTATING_WORKFLOW_NAMES}\\b`, 'i').test(trimmed)) {
    return false;
  }
  return new RegExp(`\\b(?:run|execute|invoke|start|do|finish|continue|resume)\\b[\\s\\S]{0,80}?/${MUTATING_WORKFLOW_NAMES}\\b`, 'i').test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesSignal(lowerMessage: string, signal: string): boolean {
  const normalizedSignal = signal.toLowerCase();
  if (/^[a-z0-9]+$/.test(normalizedSignal)) {
    return new RegExp(`\\b${escapeRegExp(normalizedSignal)}\\b`).test(lowerMessage);
  }
  return lowerMessage.includes(normalizedSignal);
}

// GStack modes that imply specific tiers
const GSTACK_PLAN_MODES = ['plan-ceo-review', 'plan-eng-review', 'autoplan', 'plan-design-review'];
const GSTACK_VERIFY_MODES = ['qa', 'investigate', 'review', 'qa-only'];

interface HeuristicResult {
  tier: TaskTier;
  confidence: number;
  reason: string;
}

interface TaskSignals {
  domain: TaskDomain;
  short: boolean;
  large: boolean;
  needsBrowser: boolean;
  hasErrorLog: boolean;
  hasAttachments: boolean;
  hasImageAttachments: boolean;
  hasDomAttachments: boolean;
  asksForImplementation: boolean;
  asksForVerification: boolean;
  asksForReview: boolean;
  asksForArchitecture: boolean;
  asksForMultiHarness: boolean;
  asksForCapabilityEscalation: boolean;
  asksForCopy: boolean;
  asksForFrontend: boolean;
  asksForBackend: boolean;
  likelyNeedsProjectContext: boolean;
}

interface ModelChoice {
  model: string;
  harness: Harness;
  reason: string;
}

interface AutoRouterCategoryConfig extends MetaHarnessPolicy {
  id: string;
  label?: string;
  description?: string;
  model?: string;
  tier?: TaskTier | 'fallback';
  keywords?: string[] | string;
  domains?: TaskDomain[];
}

type ResolvedAutoRouterCategory = AutoRouterCategoryConfig & {
  tier: TaskTier;
  model: string;
  keywords: string[];
};

interface RemoteCliCapabilities {
  claude?: boolean;
  codex?: boolean;
  cursor?: boolean;
  gemini?: boolean;
  opencode?: boolean;
}

interface ModelAvailabilityOptions {
  isSSH?: boolean;
  sessionId?: string;
  remoteCliCapabilities?: RemoteCliCapabilities;
  continuationHarness?: Harness;
  continuationModel?: string;
  approvedPlanContinuation?: boolean;
}

interface RouteOptions extends ModelAvailabilityOptions {
  gstackMode?: string;
  permissionMode?: string;
  attachmentCount?: number;
  attachmentTypes?: string[];
  recentMessages?: ChatMessage[];
  skipMetaController?: boolean;
  goalObjective?: string;
  goalSource?: 'slash-command' | 'ralph-loop';
  prePlanActive?: boolean;
  prePlanBypassed?: boolean;
  prePlanForced?: boolean;
}

function scoreSignals(message: string, signals: string[]): number {
  const lower = message.toLowerCase();
  let hits = 0;
  for (const signal of signals) {
    if (matchesSignal(lower, signal)) hits++;
  }
  return Math.min(1.0, hits * 0.25);
}

function hasCapabilityEscalationSignal(message: string): boolean {
  return scoreSignals(message, CAPABILITY_ESCALATION_SIGNALS) > 0;
}

function classifyTaskDomain(message: string, attachmentTypes: string[] = []): TaskDomain {
  const lower = message.toLowerCase();
  const hasImage = attachmentTypes.includes('image');
  const copy = /\b(copy|rewrite|headline|tagline|value prop|messaging|positioning|landing page|hero|cta|microcopy|tone|voice|pitch|website copy|content|more impactful|punchier|compelling)\b/.test(lower);
  const frontend = hasImage || /\b(frontend|front-end|ui|ux|css|tailwind|react|component|layout|responsive|mobile|browser|dom|visual|screenshot|animation|monaco|webview)\b|\.(tsx|jsx|css|scss|html)\b/.test(lower);
  const backend = /\b(backend|back-end|api|database|db|schema|migration|server|worker|queue|auth|endpoint|ipc|service|controller|resolver|sql|postgres|redis)\b/.test(lower);
  if (frontend && backend) return 'fullstack';
  if (copy) return 'copy';
  if (frontend) return 'frontend';
  if (backend) return 'backend';
  if (/\b(debug|broken|error|exception|stack trace|traceback|crash|failing|not working|regression)\b/.test(lower)) return 'debug';
  if (/\b(ci|deploy|docker|kubernetes|infra|env|build script|workflow|github actions|release|package|bundle)\b/.test(lower)) return 'ops';
  if (/\b(data|analytics|posthog|metric|dataset|eval|fine[- ]?tune|embedding|vector|report|dashboard)\b/.test(lower)) return 'data';
  if (/\b(docs|documentation|readme|changelog|release notes|guide|manual)\b/.test(lower)) return 'docs';
  return 'general';
}

function extractTaskSignals(message: string, attachmentCount = 0, attachmentTypes: string[] = []): TaskSignals {
  const lower = message.toLowerCase();
  const hasImageAttachments = attachmentTypes.includes('image');
  const hasDomAttachments = attachmentTypes.includes('dom_element');
  const asksForCopy = /\b(copy|rewrite|headline|tagline|value prop|messaging|positioning|landing page|hero|cta|microcopy|tone|voice|pitch|website copy|content|more impactful|punchier|compelling)\b/.test(lower);
  const asksForFrontend = hasImageAttachments || hasDomAttachments || /\b(frontend|front-end|ui|ux|css|tailwind|react|component|layout|responsive|mobile|browser|dom|visual|screenshot|animation|monaco|webview)\b/.test(lower);
  const asksForBackend = /\b(backend|back-end|api|database|db|schema|migration|server|worker|queue|auth|endpoint|ipc|service|controller|resolver|sql|postgres|redis)\b/.test(lower);
  const asksForCapabilityEscalation = hasCapabilityEscalationSignal(message);
  return {
    domain: classifyTaskDomain(message, attachmentTypes),
    short: message.trim().length < 120,
    large: message.length > 900 || /\b(full|entire|end[- ]to[- ]end|orchestr|multiplex|across all|everything|architecture|system)\b/.test(lower),
    needsBrowser: hasImageAttachments || hasDomAttachments || /\b(browser|visual|screenshot|dom|frontend|ui|playwright|stagehand|webview|localhost)\b/.test(lower),
    hasErrorLog: /\b(error|stack trace|exception|failed|failing|regression|crash|timeout|lint|typecheck|test failure|flaky|intermittent|intermittently|root cause|exact cause)\b/.test(lower),
    hasAttachments: attachmentCount > 0,
    hasImageAttachments,
    hasDomAttachments,
    asksForImplementation: /\b(implement|create|build|add|write|wire|integrate|ship|make|improve|enhance|strengthen|tune|upgrade|fix|finish|update|repair)\b/.test(lower),
    asksForVerification: /\b(test|tests|verify|verification|qa|check|checks|validate|validation|prove|confirm|audit|reproduce|isolate|diagnose|root cause|exact cause)\b/.test(lower),
    asksForReview: /\b(review|critique|second opinion|compare|risks?|regression)\b/.test(lower),
    asksForArchitecture: /\b(plan|design|architect|approach|trade[- ]?off|strategy|proposal)\b/.test(lower),
    asksForMultiHarness: /\b(harness|multiplex|orchestrat|delegate|agents|codex|cursor|gemini|claude)\b|\b(?:ai|llm|language)\s+models?\b|\bmodels?\s+(?:available|choice|selection|routing|harness)\b/.test(lower),
    asksForCapabilityEscalation,
    asksForCopy,
    asksForFrontend,
    asksForBackend,
    likelyNeedsProjectContext: /\b(project|repo|codebase|session|transcript|claude\.md|agents?\.md|skills?|settings|mcp)\b/.test(lower),
  };
}

function classifyPlanningGateHeuristic(
  message: string,
  signals: TaskSignals,
  options: RouteOptions,
): PlanningGateDecision {
  const lower = message.toLowerCase();
  const migration = /\b(migrat(?:e|ion)|replace|rewrite|move from|move to|deprecat|rollout|backfill)\b/.test(lower);
  const feature = /\b(new feature|feature|introduce|launch|create a new|build a new|add a new|new system|new flow|new mode|new integration|new capability)\b/.test(lower);
  const bug = /\b(bug|broken|regression|race condition|data loss|corrupt|intermittent|flaky|root cause|doesn'?t work|does not work)\b/.test(lower);
  const broadUpdate = /\b(overhaul|redesign|rework|across|end[- ]to[- ]end|architecture|workflow|lifecycle|routing|harness|remote and local|local and remote)\b/.test(lower);
  const explicitlySmall = /\b(tiny|small|minor|quick|one[- ]line|typo|copy only|rename only|just change|localized)\b/.test(lower);
  const hasPlanningScope = signals.asksForImplementation
    || (signals.asksForArchitecture && (feature || migration || broadUpdate));
  if (
    options.prePlanActive
    || options.prePlanForced
    || options.prePlanBypassed
    || options.approvedPlanContinuation
    || !hasPlanningScope
    || /^(?:\/build-now|build now anyway)\b/i.test(message.trim())
  ) {
    return {
      action: options.prePlanActive || options.prePlanForced ? 'start' : 'none',
      confidence: options.prePlanActive || options.prePlanForced ? 1 : 0,
      reason: options.prePlanActive
        ? 'Continue the active pre-build 80/20 scope pass'
        : options.prePlanForced
          ? 'The user explicitly requested the pre-build 80/20 scope pass'
        : options.prePlanBypassed
          ? 'The user explicitly bypassed the pre-build 80/20 scope pass'
        : 'No new substantial implementation scope detected',
      changeKind: 'general',
    };
  }

  let score = 0;
  if (signals.large && (message.length > 250 || feature || migration || broadUpdate)) score += 0.3;
  if (feature) score += 0.35;
  if (migration) score += 0.4;
  if (bug && broadUpdate) score += 0.4;
  else if (bug) score += 0.15;
  if (broadUpdate) score += 0.25;
  if (signals.asksForArchitecture || signals.asksForMultiHarness) score += 0.15;
  if (signals.asksForFrontend && signals.asksForBackend) score += 0.15;
  if (explicitlySmall) score -= 0.5;
  const confidence = Math.max(0, Math.min(0.95, 0.35 + score));
  const changeKind: PlanningGateChangeKind = migration
    ? 'migration'
    : feature
      ? 'feature'
      : bug
        ? 'bug'
        : broadUpdate
          ? 'update'
          : 'general';

  return {
    action: confidence >= 0.75 ? 'start' : confidence >= 0.55 ? 'suggest' : 'none',
    confidence,
    reason: confidence >= 0.55
      ? `Substantial ${changeKind} scope would benefit from a quick 80/20 first-slice choice`
      : 'Scope appears focused enough to execute without an 80/20 scope pass',
    changeKind,
  };
}

function isComposerFriendlyBugFix(message: string, signals: TaskSignals): boolean {
  const lower = message.toLowerCase();
  const localizedBugFix = /\b(fix|repair|correct|patch|resolve|address)\b.{0,120}\b(bug|broken|wrong|missing|misaligned|overflow|clipped|truncated|stuck|glitch|not showing|doesn'?t show|does not show|isn'?t showing|is not showing|off by|janky)\b|\b(bug|broken|wrong|missing|misaligned|overflow|clipped|truncated|stuck|glitch|not showing|doesn'?t show|does not show|isn'?t showing|is not showing|off by|janky)\b.{0,120}\b(fix|repair|correct|patch|resolve|address)\b/.test(lower);
  if (!localizedBugFix) return false;

  const composerSurface = signals.asksForFrontend
    || signals.asksForCopy
    || signals.domain === 'docs'
    || /\b(ui|ux|frontend|front-end|visual|layout|css|style|button|modal|dialog|popover|screen|page|component|form|copy|text|label|wording|docs|readme|markdown|dom|screenshot|spacing|alignment|responsive|mobile)\b|\.(tsx|jsx|css|scss|html|md|mdx)\b/.test(lower);
  if (!composerSurface) return false;

  const heavyBugFix = /\b(failing tests?|tests?\s+(?:are\s+)?failing|ci|stack trace|traceback|exception|crash|migration|database|schema|backend|server|api|auth|worker|queue|resolver|sql|postgres|redis|root cause|diagnose|investigate|reproduce|flaky|intermittent|race condition)\b/.test(lower);
  if (heavyBugFix) return false;

  return signals.short || signals.hasAttachments || message.trim().length < 260;
}

function isTaskTier(value: unknown): value is TaskTier {
  return value === 'plan' || value === 'build' || value === 'verify' || value === 'refine';
}

function isMetaHarnessSpeed(value: unknown): value is MetaHarnessSpeed {
  return value === 'auto' || value === 'standard' || value === 'fast';
}

function isMetaWorkflowMode(value: unknown): value is MetaWorkflowMode {
  return value === 'auto' || value === 'single' || value === 'lead-with-delegates' || value === 'sequential' || value === 'dynamic';
}

function isMetaVerificationMode(value: unknown): value is MetaVerificationMode {
  return value === 'auto' || value === 'none' || value === 'optional' || value === 'required';
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function cleanPolicy(policy: MetaHarnessPolicy): MetaHarnessPolicy {
  return {
    ...(policy.effort ? { effort: policy.effort } : {}),
    ...(isMetaHarnessSpeed(policy.speed) && policy.speed !== 'auto' ? { speed: policy.speed } : {}),
    ...(isMetaWorkflowMode(policy.workflow) && policy.workflow !== 'auto' ? { workflow: policy.workflow } : {}),
    ...(policy.budgetUsd !== undefined ? { budgetUsd: policy.budgetUsd } : {}),
    ...(isMetaVerificationMode(policy.verification) && policy.verification !== 'auto' ? { verification: policy.verification } : {}),
  };
}

function isFixedAutoRouterCategoryId(value: string): boolean {
  return value === 'plan' || value === 'build' || value === 'verify' || value === 'refine' || value === 'fallback';
}

function isCurrentCustomAutoRouterCategory(category: AutoRouterCategoryConfig): boolean {
  if (isFixedAutoRouterCategoryId(category.id)) return false;
  if (isTaskTier(category.tier)) return true;
  if (typeof category.description === 'string' && category.description.trim()) return true;
  if (Array.isArray(category.keywords) && category.keywords.some((keyword) => typeof keyword === 'string' && keyword.trim())) return true;
  if (typeof category.keywords === 'string' && category.keywords.trim()) return true;
  return /^custom-\d{10,}$/.test(category.id);
}

function normalizeCategoryText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

function inferCategoryTier(category: AutoRouterCategoryConfig): TaskTier | undefined {
  if (isTaskTier(category.tier)) return category.tier;
  if (isTaskTier(category.id)) return category.id;

  const text = normalizeCategoryText([
    category.id,
    category.label || '',
    category.description || '',
    Array.isArray(category.keywords) ? category.keywords.join(' ') : category.keywords || '',
    category.model || '',
  ].join(' '));

  if (/\b(plan|planning|architect|architecture|design|strategy|review|risk|tradeoffs?)\b/.test(text)) return 'plan';
  if (/\b(verify|verification|test|tests|qa|check|debug|diagnose|investigate|reproduce)\b/.test(text)) return 'verify';
  if (/\b(refine|refinement|tweak|polish|copy|docs|readme|ui|ux|visual|style|css|frontend|front end|composer)\b/.test(text)) return 'refine';
  if (/\b(build|execute|execution|implement|code|coding|fix|bug|agent|codex)\b/.test(text)) return 'build';

  const model = category.model || '';
  if (model.startsWith('cursor:')) return 'refine';
  if (model.startsWith('gemini:')) return 'verify';
  if (model.startsWith('codex:')) return 'build';
  if (model.startsWith('claude-')) return 'plan';
  return undefined;
}

function categoryKeywords(category: AutoRouterCategoryConfig): string[] {
  const explicitKeywords = Array.isArray(category.keywords)
    ? category.keywords
    : typeof category.keywords === 'string'
      ? category.keywords.split(/[,;\n]/)
      : [];
  const baseText = [
    category.id,
    category.label || '',
    category.description || '',
    ...explicitKeywords,
  ].map(normalizeCategoryText).join(' ');
  const phrases = explicitKeywords
    .map((keyword) => normalizeCategoryText(keyword).trim())
    .filter((keyword) => keyword.length >= 3);
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'work', 'task',
    'category', 'custom', 'auto', 'build', 'settings', 'route', 'routing',
  ]);
  const tokens = baseText
    .split(/[^a-z0-9.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  return Array.from(new Set([...phrases, ...tokens]));
}

function customCategoriesForController(options?: ModelAvailabilityOptions): ResolvedAutoRouterCategory[] {
  return getConfiguredAutoRouterCategories()
    .filter(isCurrentCustomAutoRouterCategory)
    .reduce<ResolvedAutoRouterCategory[]>((acc, category) => {
      const tier = inferCategoryTier(category);
      if (!tier || !category.model || !hasConfiguredCredentialForModel(category.model, options)) return acc;
      acc.push({
        ...category,
        tier,
        model: category.model,
        keywords: categoryKeywords(category).slice(0, 12),
      });
      return acc;
    }, []);
}

function matchedCustomCategoryLead(
  matchedCategoryId: string | undefined,
  leadTier: TaskTier,
  categories: ResolvedAutoRouterCategory[],
): ModelChoice | undefined {
  const category = matchedCustomCategory(matchedCategoryId, leadTier, categories);
  if (!category || category.tier !== leadTier) return undefined;
  const categoryName = category.label || category.id;
  return {
    model: category.model,
    harness: harnessFromModel(category.model),
    reason: `Custom settings category "${categoryName}" selected ${category.model}`,
  };
}

function matchedCustomCategory(
  matchedCategoryId: string | undefined,
  leadTier: TaskTier,
  categories: ResolvedAutoRouterCategory[],
): ResolvedAutoRouterCategory | undefined {
  if (!matchedCategoryId) return undefined;
  const category = categories.find((candidate) => candidate.id === matchedCategoryId);
  if (!category || category.tier !== leadTier) return undefined;
  return category;
}

function harnessFromModel(model: string): Harness {
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('custom:')) return 'custom';
  return 'claude';
}

function getSettingsObject(): Record<string, unknown> {
  const now = Date.now();
  if (settingsObjectCache && settingsObjectCache.expiresAt > now) {
    return settingsObjectCache.value;
  }
  const value = settingsStore.get('settings', {}) as Record<string, unknown>;
  settingsObjectCache = { expiresAt: now + 2_000, value };
  return value;
}

function getConfiguredCustomModels(): Array<{ id: string; name?: string; modelId?: string; description?: string; apiKey?: string; baseUrl?: string }> {
  const settings = getSettingsObject();
  return ((settings.customModels || []) as Array<{ id: string; name?: string; modelId?: string; description?: string; apiKey?: string; baseUrl?: string }>)
    .filter((model) => !!(model.id && model.apiKey && model.baseUrl && model.modelId));
}

function customModelCandidatesForTier(tier: TaskTier): string[] {
  const models = getConfiguredCustomModels();
  if (models.length === 0) return [];

  const scoreModel = (model: typeof models[number]): number => {
    const text = `${model.id} ${model.name || ''} ${model.modelId || ''} ${model.description || ''}`.toLowerCase();
    const fast = /\b(haiku|mini|flash|fast|small|lite)\b/.test(text);
    const strong = /\b(opus|pro|reason|thinking|k2|kimi|deepseek|large|max)\b/.test(text);
    const coding = /\b(code|codex|agent|dev|build|coder)\b/.test(text);

    switch (tier) {
      case 'plan':
        return (strong ? 30 : 0) + (coding ? 10 : 0) - (fast ? 20 : 0);
      case 'build':
        return (coding ? 30 : 0) + (strong ? 12 : 0) - (fast ? 8 : 0);
      case 'verify':
        return (strong ? 22 : 0) + (coding ? 15 : 0) + (fast ? 4 : 0);
      case 'refine':
        return (fast ? 25 : 0) + (coding ? 12 : 0) - (strong ? 4 : 0);
    }
  };

  return models
    .slice()
    .sort((a, b) => scoreModel(b) - scoreModel(a))
    .map((model) => `custom:${model.id}`);
}

function getConfiguredAutoRouterCategories(): AutoRouterCategoryConfig[] {
  const settings = getSettingsObject();
  const autoRouterConfig = settings.autoRouterConfig as Record<string, unknown> | undefined;
  const categories = autoRouterConfig?.categories;
  if (!Array.isArray(categories)) return [];
  return categories.reduce<AutoRouterCategoryConfig[]>((acc, rawCategory) => {
    if (!rawCategory || typeof rawCategory !== 'object') return acc;
    const category = rawCategory as Record<string, unknown>;
    if (typeof category.id !== 'string' || typeof category.model !== 'string') return acc;

    const tier = isTaskTier(category.tier) || category.tier === 'fallback'
      ? category.tier
      : undefined;
    acc.push({
      id: category.id,
      ...(typeof category.label === 'string' ? { label: category.label } : {}),
      ...(typeof category.description === 'string' ? { description: category.description } : {}),
      model: category.model,
      ...(tier ? { tier } : {}),
      ...(Array.isArray(category.keywords) ? { keywords: category.keywords.filter((keyword): keyword is string => typeof keyword === 'string') } : {}),
      ...(typeof category.keywords === 'string' ? { keywords: category.keywords } : {}),
      ...(typeof category.effort === 'string' && category.effort ? { effort: category.effort } : {}),
      ...(isMetaHarnessSpeed(category.speed) ? { speed: category.speed } : {}),
      ...(isMetaWorkflowMode(category.workflow) ? { workflow: category.workflow } : {}),
      ...(numberOrUndefined(category.budgetUsd) !== undefined ? { budgetUsd: numberOrUndefined(category.budgetUsd) } : {}),
      ...(isMetaVerificationMode(category.verification) ? { verification: category.verification } : {}),
    });
    return acc;
  }, []);
}

function binaryExistsInPath(binaryNames: string[], extraCandidates: string[]): boolean {
  return hasUsableLocalExecutable(binaryNames, extraCandidates);
}

function getCodexPackageCandidates(): string[] {
  const platform = process.platform;
  const arch = process.arch;
  let targetTriple = '';
  if (platform === 'darwin' && arch === 'arm64') targetTriple = 'aarch64-apple-darwin';
  else if (platform === 'darwin' && arch === 'x64') targetTriple = 'x86_64-apple-darwin';
  else if (platform === 'linux' && arch === 'x64') targetTriple = 'x86_64-unknown-linux-gnu';
  else if (platform === 'linux' && arch === 'arm64') targetTriple = 'aarch64-unknown-linux-gnu';
  if (!targetTriple) return [];

  const platformPkg = path.join('@openai', `codex-${platform}-${arch}`);
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const binaryRels = [
    path.join('vendor', targetTriple, 'bin', binaryName),
    path.join('vendor', targetTriple, 'codex', binaryName),
  ];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '';
  const candidateBases = [
    path.join(resourcesPath, 'node_modules', platformPkg),
    path.resolve(process.cwd(), 'node_modules', platformPkg),
    path.resolve(__dirname, '..', '..', 'node_modules', platformPkg),
  ];
  return candidateBases.flatMap((base) => binaryRels.map((binaryRel) => path.join(base, binaryRel)));
}

function hasCodexCli(): boolean {
  if (codexCliAvailableCache !== undefined) return codexCliAvailableCache;
  codexCliAvailableCache = binaryExistsInPath(['codex'], getCodexPackageCandidates());
  return codexCliAvailableCache;
}

function hasCursorCli(): boolean {
  if (cursorCliAvailableCache !== undefined) return cursorCliAvailableCache;
  const home = os.homedir();
  cursorCliAvailableCache = binaryExistsInPath(
    ['cursor-agent', 'agent'],
    [
      `${home}/.local/bin/cursor-agent`,
      `${home}/.cursor/bin/cursor-agent`,
      '/usr/local/bin/cursor-agent',
      '/opt/homebrew/bin/cursor-agent',
      `${home}/.local/bin/agent`,
      `${home}/.cursor/bin/agent`,
      '/usr/local/bin/agent',
      '/opt/homebrew/bin/agent',
    ],
  );
  return cursorCliAvailableCache;
}

function findCursorCliBinary(): string | null {
  const home = os.homedir();
  return findUsableLocalExecutable(
    ['cursor-agent', 'agent'],
    [
    `${home}/.local/bin/cursor-agent`,
    `${home}/.cursor/bin/cursor-agent`,
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent',
    `${home}/.local/bin/agent`,
    `${home}/.cursor/bin/agent`,
    '/usr/local/bin/agent',
    '/opt/homebrew/bin/agent',
    ],
  );
}

function isCursorAuthFailure(error?: string): boolean {
  return !!error && /not authenticated|authenticat|api key|sign in|logged in|login|press any key/i.test(error);
}

function isCursorCliLoggedIn(): boolean {
  const now = Date.now();
  if (cursorCliAuthCache && now - cursorCliAuthCache.checkedAt < 30_000) {
    return cursorCliAuthCache.loggedIn;
  }

  const binary = findCursorCliBinary();
  if (!binary) {
    cursorCliAuthCache = { checkedAt: now, loggedIn: false };
    return false;
  }

  try {
    const output = execFileSync(binary, ['status'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const loggedIn = /logged in/i.test(output) && !/not logged in/i.test(output);
    cursorCliAuthCache = { checkedAt: now, loggedIn };
    return loggedIn;
  } catch {
    cursorCliAuthCache = { checkedAt: now, loggedIn: false };
    return false;
  }
}

function clearRecoveredCursorAuthCooldown(sessionId: string | undefined): void {
  if (!sessionId) return;

  const harnessFailures = sessionHarnessFailures.get(sessionId);
  const harnessFailure = harnessFailures?.get('cursor');
  const modelFailures = sessionModelFailures.get(sessionId);
  const hasCursorAuthCooldown = !!(harnessFailure && isCursorAuthFailure(harnessFailure.lastError))
    || !!Array.from(modelFailures?.entries() || []).some(([model, failure]) =>
      model.startsWith('cursor:') && isCursorAuthFailure(failure.lastError)
    );
  if (!hasCursorAuthCooldown || !isCursorCliLoggedIn()) return;

  if (harnessFailure && isCursorAuthFailure(harnessFailure.lastError)) {
    harnessFailures?.delete('cursor');
    if (harnessFailures?.size === 0) sessionHarnessFailures.delete(sessionId);
  }

  if (!modelFailures) return;
  for (const [model, failure] of modelFailures) {
    if (model.startsWith('cursor:') && isCursorAuthFailure(failure.lastError)) {
      modelFailures.delete(model);
    }
  }
  if (modelFailures.size === 0) {
    sessionModelFailures.delete(sessionId);
  }
}

function hasGeminiCli(): boolean {
  if (geminiCliAvailableCache !== undefined) return geminiCliAvailableCache;
  const home = os.homedir();
  geminiCliAvailableCache = binaryExistsInPath(
    ['gemini'],
    [
      '/usr/local/bin/gemini',
      `${home}/.local/bin/gemini`,
      `${home}/.npm-global/bin/gemini`,
      '/opt/homebrew/bin/gemini',
    ],
  );
  return geminiCliAvailableCache;
}

function hasOpenCodeRunner(): boolean {
  if (openCodeCliAvailableCache !== undefined) return openCodeCliAvailableCache;
  const home = os.homedir();
  openCodeCliAvailableCache = binaryExistsInPath(
    ['opencode', 'npx'],
    [
      `${home}/.local/bin/opencode`,
      `${home}/.bun/bin/opencode`,
      `${home}/.npm-global/bin/opencode`,
      '/usr/local/bin/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/npx',
      '/opt/homebrew/bin/npx',
    ],
  );
  return openCodeCliAvailableCache;
}

function hasRemoteCliForModel(model: string, capabilities?: RemoteCliCapabilities): boolean {
  if (model.startsWith('codex:')) return capabilities?.codex === true;
  if (model.startsWith('cursor:')) return capabilities?.cursor === true;
  if (model.startsWith('gemini:')) return capabilities?.gemini === true;
  if (model.startsWith('opencode:')) return capabilities?.opencode === true;
  if (model.startsWith('custom:')) return true;
  if (model.startsWith('claude:') || model.startsWith('claude-') || !model.includes(':')) {
    return capabilities?.claude === true;
  }
  return true;
}

function getHarnessCooldown(sessionId: string | undefined, harness: Harness): FailureCooldown | undefined {
  if (!sessionId || harness === 'claude' || harness === 'custom') return undefined;
  const failure = sessionHarnessFailures.get(sessionId)?.get(harness);
  if (!failure) return undefined;
  if (failure.cooldownUntil <= Date.now()) {
    sessionHarnessFailures.get(sessionId)?.delete(harness);
    return undefined;
  }
  return failure;
}

function getModelCooldown(sessionId: string | undefined, model: string): FailureCooldown | undefined {
  if (!sessionId) return undefined;
  const failure = sessionModelFailures.get(sessionId)?.get(model);
  if (!failure) return undefined;
  if (failure.cooldownUntil <= Date.now()) {
    sessionModelFailures.get(sessionId)?.delete(model);
    return undefined;
  }
  return failure;
}

function isHarnessTemporarilyUnavailable(model: string, options?: ModelAvailabilityOptions): boolean {
  return !!getModelCooldown(options?.sessionId, model) || !!getHarnessCooldown(options?.sessionId, harnessFromModel(model));
}

function hasConfiguredCredentialForModel(model: string, options?: ModelAvailabilityOptions): boolean {
  const settings = getSettingsObject();
  const hasZaiKey = !!(
    settings.zaiApiKey
    || settingsStore.get('zaiApiKey')
    || process.env.ZAI_API_KEY
    || process.env.Z_AI_API_KEY
  );

  if (isHarnessTemporarilyUnavailable(model, options)) {
    return false;
  }

  if (options?.isSSH && !hasRemoteCliForModel(model, options.remoteCliCapabilities)) {
    return false;
  }

  if (model.startsWith('codex:')) {
    if (isZaiGlmCodexModel(model)) {
      return hasZaiKey && (options?.isSSH ? true : hasCodexCli());
    }

    return !!(
      settingsStore.get('openAiApiKey') ||
      settingsStore.get('openaiApiKey') ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY
    ) && (options?.isSSH ? true : hasCodexCli());
  }

  if (model.startsWith('gemini:')) {
    return !!(
      settings.geminiApiKey ||
      settingsStore.get('googleApiKey') ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY
    ) && (options?.isSSH ? true : hasGeminiCli());
  }

  if (model.startsWith('cursor:')) {
    // Cursor supports both logged-in CLI installs and API-key auth. Let the CLI
    // wrapper validate auth at execution time so either setup can work.
    return options?.isSSH ? true : hasCursorCli();
  }

  if (model.startsWith('opencode:')) {
    return !!(settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY) && (options?.isSSH ? true : hasOpenCodeRunner());
  }

  if (model.startsWith('custom:')) {
    if (model === ZAI_GLM_CLAUDE_MODEL_PICKER_ID) {
      return hasZaiKey;
    }

    const customId = model.replace('custom:', '');
    const customModels = (settings.customModels || []) as Array<{ id: string; apiKey?: string; baseUrl?: string; modelId?: string }>;
    const match = customModels.find((candidate) => candidate.id === customId);
    return !!(match?.apiKey && match.baseUrl && match.modelId);
  }

  // Claude can use either API key or an existing Claude Code login, so do not
  // block routing on a key check here.
  return true;
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
  const capabilityEscalationScore = scoreSignals(message, CAPABILITY_ESCALATION_SIGNALS);
  const lower = message.toLowerCase();
  const asksBeforeMutation = /\bbefore\s+(?:editing|changing|touching|modifying|writing|implementing)\b|\bbefore\s+(?:we|you)\s+(?:edit|change|touch|modify|write|implement)\b/.test(lower);
  const asksForRootCause = /\b(reproduce|isolate|diagnose|investigate|exact cause|root cause|what went wrong|why)\b|\bflaky\b|\bintermittent(?:ly)?\b/.test(lower);
  const asksForRiskDecision = /\b(map|assess|evaluate|review|decide|determine|compare)\b.{0,80}\b(risks?|race condition|schema|approach|strategy|rollout|trade[- ]?offs?)\b|\b(risks?|race condition|schema|rollout path|safe rollout)\b.{0,80}\b(before|decide|determine|map|assess|evaluate)\b/.test(lower);
  const asksToFixFailure = /\b(fix|repair|update|make|turn|push)\b.{0,100}\b(fail(?:ing|ed)?|tests?|ci|red|pass|green|code updates?)\b|\b(fail(?:ing|ed)?|tests?|ci|red)\b.{0,100}\b(fix|repair|update|pass|green|code updates?|push)\b/.test(lower);
  const asksToCompleteKnownWork = /\b(finish|complete)\b.{0,80}\b(todos?|implementation|feature|flow|task|work)\b|\b(todos?)\b.{0,80}\b(finish|complete)\b/.test(lower);
  const explicitMutationVerb = /\b(implement|create|build|add|write|wire|integrate|ship|make|fix|finish|update|repair)\b/.test(lower);
  const asksForCarefulMigration = /\bmigration\b.{0,140}\b(affects|touches|spans|across|impacts)\b.{0,180}\b(auth|billing|audit|logs?|careful|carefully|risk|rollout)\b|\b(careful|carefully|risk|rollout)\b.{0,180}\bmigration\b/.test(lower);

  if (capabilityEscalationScore > 0) {
    return {
      tier: 'plan',
      confidence: Math.min(0.95, 0.75 + capabilityEscalationScore * 0.2),
      reason: 'User asked for deeper reasoning or a stronger model',
    };
  }

  if (asksBeforeMutation && asksForRootCause && verifyScore > 0) {
    return {
      tier: 'verify',
      confidence: Math.max(0.82, verifyScore),
      reason: 'User asked for root-cause investigation before changing files',
    };
  }

  if ((asksBeforeMutation && asksForRiskDecision) || (asksForRiskDecision && planScore > 0)) {
    return {
      tier: 'plan',
      confidence: Math.max(0.82, planScore),
      reason: 'User asked for risk/decision planning before edits',
    };
  }

  if (asksForCarefulMigration && !explicitMutationVerb) {
    return {
      tier: 'plan',
      confidence: Math.max(0.82, planScore),
      reason: 'Risk-sensitive migration should be planned before execution',
    };
  }

  if (asksToFixFailure && !asksBeforeMutation && !/\b(why|diagnose|investigate|root cause|exact cause|figure out)\b/.test(lower)) {
    return {
      tier: 'build',
      confidence: Math.max(0.82, buildScore, verifyScore),
      reason: 'User asked to fix failing code or CI, not just investigate it',
    };
  }

  if (asksToCompleteKnownWork) {
    return {
      tier: 'build',
      confidence: Math.max(0.82, buildScore),
      reason: 'User asked to complete known implementation work',
    };
  }

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
  signals: TaskSignals,
  message: string,
): HeuristicResult {
  const lower = message.trim().toLowerCase();
  const isPlanContinuation = /^(yes|yep|yeah|ok|okay|sure|sounds good|go ahead|do it|do that|let'?s do it|proceed|continue|ship it|build it|implement it|execute it|make it so)[.!?]*$/.test(lower);
  const referencesExistingPlan = /\b(from|based on|using|execute|implement|build|ship)\b.{0,60}\b(the\s+)?plan\b|\b(the\s+)?plan\b.{0,60}\b(go ahead|do it|build it|implement it|execute it)\b/.test(lower);
  const asksToDiagnoseExistingFailure = signals.hasErrorLog
    || /\b(why|what happened|went wrong|figure out|diagnose|investigate|debug|broken|not working|reproduce)\b/.test(lower);
  const asksToFixExistingFailure = /\b(fix|repair|update|make|turn|push)\b.{0,100}\b(fail(?:ing|ed)?|tests?|ci|red|pass|green|code updates?)\b|\b(fail(?:ing|ed)?|tests?|ci|red)\b.{0,100}\b(fix|repair|update|pass|green|code updates?|push)\b/.test(lower);
  const copyStrategyRequest = signals.asksForCopy
    && (signals.large || signals.asksForArchitecture || /\b(research|strategy|positioning|website|landing page|pitch|value prop|messaging|plan)\b/.test(lower));

  if (heuristic.tier === 'refine' && copyStrategyRequest) {
    return {
      tier: 'plan',
      confidence: Math.max(0.72, heuristic.confidence),
      reason: 'Copy and positioning request needs planning before execution',
    };
  }

  if (isComposerFriendlyBugFix(message, signals)) {
    return {
      tier: 'refine',
      confidence: Math.max(0.82, heuristic.confidence),
      reason: 'Localized UI/copy/docs bug fix fits refinement',
    };
  }

  // Complex build without prior plan → route to Plan first. Direct, bounded
  // implementation requests can start with the configured build harness.
  if (
    heuristic.tier === 'build' &&
    !phase.hasPlanContext &&
    !referencesExistingPlan &&
    (signals.large || signals.asksForArchitecture || signals.asksForMultiHarness)
  ) {
    return {
      tier: 'plan',
      confidence: heuristic.confidence * 0.85,
      reason: 'Complex task without prior plan — routing to Plan tier first',
    };
  }

  // Mixed "implement and test" requests need a build stage first, but pure
  // failure investigation should stay in Verify even without prior app context.
  if (heuristic.tier === 'verify' && !phase.hasBuildContext && signals.asksForImplementation && !asksToDiagnoseExistingFailure) {
    return {
      tier: 'build',
      confidence: heuristic.confidence * 0.7,
      reason: 'Implementation plus verification requested without build context — routing to Build first',
    };
  }

  if (heuristic.tier === 'verify' && signals.asksForImplementation && asksToFixExistingFailure && !/\b(before editing|before changing|why|diagnose|investigate|root cause|exact cause|figure out)\b/.test(lower)) {
    return {
      tier: 'build',
      confidence: Math.max(0.8, heuristic.confidence),
      reason: 'Failure fix requested — routing to Build tier with verification handoff when available',
    };
  }

  // "OK build it" / "go ahead" after a Plan turn
  if (phase.hasPlanContext && !phase.hasBuildContext && heuristic.tier !== 'plan' && (phase.lastTierUsed === 'plan' || isPlanContinuation || heuristic.confidence < 0.6)) {
    return {
      tier: 'build',
      confidence: 0.8,
      reason: 'Follow-up after Plan tier — executing the plan',
    };
  }

  return heuristic;
}

function enforcePermissionMode(
  result: HeuristicResult,
  permissionMode?: string,
): HeuristicResult {
  if (canRunMutatingStages(permissionMode) || (result.tier !== 'build' && result.tier !== 'refine')) {
    return result;
  }

  return {
    tier: 'plan',
    confidence: Math.max(result.confidence, 0.9),
    reason: `${result.reason}; permission mode '${permissionMode}' requires a non-mutating Plan lead`,
  };
}

function getConfig(): AutoRouterConfig {
  const settings = getSettingsObject();
  const saved = settings.autoRouterConfig as Record<string, unknown> | undefined;

  const config = { ...DEFAULT_CONFIG };
  if (saved) {
    if (saved.prePlanEnabled !== undefined) config.prePlanEnabled = saved.prePlanEnabled as boolean;
    if (typeof saved.prePlanModel === 'string') config.prePlanModel = saved.prePlanModel;
    if (saved.costAware !== undefined) config.costAware = saved.costAware as boolean;
    if (saved.costThresholdPercent !== undefined) config.costThresholdPercent = saved.costThresholdPercent as number;
    const categories = saved.categories as Array<{ id: string; model: string }> | undefined;
    if (categories) {
      for (const cat of categories) {
        if (cat.id === 'plan') config.planModel = cat.model;
        else if (cat.id === 'build') config.buildModel = cat.model;
        else if (cat.id === 'verify') config.verifyModel = cat.model;
        else if (cat.id === 'refine') config.refineModel = cat.model;
        else if (cat.id === 'fallback') config.fallbackModel = cat.model;
      }
    }

    if (typeof saved.planModel === 'string') config.planModel = saved.planModel;
    if (typeof saved.buildModel === 'string') config.buildModel = saved.buildModel;
    if (typeof saved.verifyModel === 'string') config.verifyModel = saved.verifyModel;
    if (typeof saved.refineModel === 'string') config.refineModel = saved.refineModel;
    if (typeof saved.fallbackModel === 'string') config.fallbackModel = saved.fallbackModel;

    if (typeof saved.planEffort === 'string') config.planEffort = saved.planEffort;
    if (typeof saved.buildEffort === 'string') config.buildEffort = saved.buildEffort;
    if (typeof saved.verifyEffort === 'string') config.verifyEffort = saved.verifyEffort;
    if (typeof saved.refineEffort === 'string') config.refineEffort = saved.refineEffort;
    if (typeof saved.fallbackEffort === 'string') config.fallbackEffort = saved.fallbackEffort;

    if (isMetaHarnessSpeed(saved.planSpeed)) config.planSpeed = saved.planSpeed;
    if (isMetaHarnessSpeed(saved.buildSpeed)) config.buildSpeed = saved.buildSpeed;
    if (isMetaHarnessSpeed(saved.verifySpeed)) config.verifySpeed = saved.verifySpeed;
    if (isMetaHarnessSpeed(saved.refineSpeed)) config.refineSpeed = saved.refineSpeed;
    if (isMetaHarnessSpeed(saved.fallbackSpeed)) config.fallbackSpeed = saved.fallbackSpeed;

    if (isMetaWorkflowMode(saved.planWorkflow)) config.planWorkflow = saved.planWorkflow;
    if (isMetaWorkflowMode(saved.buildWorkflow)) config.buildWorkflow = saved.buildWorkflow;
    if (isMetaWorkflowMode(saved.verifyWorkflow)) config.verifyWorkflow = saved.verifyWorkflow;
    if (isMetaWorkflowMode(saved.refineWorkflow)) config.refineWorkflow = saved.refineWorkflow;
    if (isMetaWorkflowMode(saved.fallbackWorkflow)) config.fallbackWorkflow = saved.fallbackWorkflow;

    const planBudgetUsd = numberOrUndefined(saved.planBudgetUsd);
    const buildBudgetUsd = numberOrUndefined(saved.buildBudgetUsd);
    const verifyBudgetUsd = numberOrUndefined(saved.verifyBudgetUsd);
    const refineBudgetUsd = numberOrUndefined(saved.refineBudgetUsd);
    const fallbackBudgetUsd = numberOrUndefined(saved.fallbackBudgetUsd);
    if (planBudgetUsd !== undefined) config.planBudgetUsd = planBudgetUsd;
    if (buildBudgetUsd !== undefined) config.buildBudgetUsd = buildBudgetUsd;
    if (verifyBudgetUsd !== undefined) config.verifyBudgetUsd = verifyBudgetUsd;
    if (refineBudgetUsd !== undefined) config.refineBudgetUsd = refineBudgetUsd;
    if (fallbackBudgetUsd !== undefined) config.fallbackBudgetUsd = fallbackBudgetUsd;

    if (isMetaVerificationMode(saved.planVerification)) config.planVerification = saved.planVerification;
    if (isMetaVerificationMode(saved.buildVerification)) config.buildVerification = saved.buildVerification;
    if (isMetaVerificationMode(saved.verifyVerification)) config.verifyVerification = saved.verifyVerification;
    if (isMetaVerificationMode(saved.refineVerification)) config.refineVerification = saved.refineVerification;
    if (isMetaVerificationMode(saved.fallbackVerification)) config.fallbackVerification = saved.fallbackVerification;

    const customCategories = getConfiguredAutoRouterCategories()
      .filter(isCurrentCustomAutoRouterCategory)
      .map((category) => {
        const tier = inferCategoryTier(category);
        return {
          id: category.id,
          ...(category.label ? { label: category.label } : {}),
          ...(category.description ? { description: category.description } : {}),
          model: category.model || resolveModelForTier(tier || 'build', config),
          ...(tier ? { tier } : {}),
          keywords: categoryKeywords(category),
          ...categoryPolicy(category as ResolvedAutoRouterCategory),
        };
      });
    if (customCategories.length > 0) {
      config.categories = customCategories;
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

function resolveEffortForTier(tier: TaskTier, config: AutoRouterConfig): string | undefined {
  switch (tier) {
    case 'plan': return config.planEffort;
    case 'build': return config.buildEffort;
    case 'verify': return config.verifyEffort;
    case 'refine': return config.refineEffort;
    default: return config.fallbackEffort;
  }
}

function resolveSpeedForTier(tier: TaskTier, config: AutoRouterConfig): MetaHarnessSpeed | undefined {
  switch (tier) {
    case 'plan': return config.planSpeed;
    case 'build': return config.buildSpeed;
    case 'verify': return config.verifySpeed;
    case 'refine': return config.refineSpeed;
    default: return config.fallbackSpeed;
  }
}

function resolveWorkflowForTier(tier: TaskTier, config: AutoRouterConfig): MetaWorkflowMode | undefined {
  switch (tier) {
    case 'plan': return config.planWorkflow;
    case 'build': return config.buildWorkflow;
    case 'verify': return config.verifyWorkflow;
    case 'refine': return config.refineWorkflow;
    default: return config.fallbackWorkflow;
  }
}

function resolveBudgetForTier(tier: TaskTier, config: AutoRouterConfig): number | undefined {
  switch (tier) {
    case 'plan': return config.planBudgetUsd;
    case 'build': return config.buildBudgetUsd;
    case 'verify': return config.verifyBudgetUsd;
    case 'refine': return config.refineBudgetUsd;
    default: return config.fallbackBudgetUsd;
  }
}

function resolveVerificationForTier(tier: TaskTier, config: AutoRouterConfig): MetaVerificationMode | undefined {
  switch (tier) {
    case 'plan': return config.planVerification;
    case 'build': return config.buildVerification;
    case 'verify': return config.verifyVerification;
    case 'refine': return config.refineVerification;
    default: return config.fallbackVerification;
  }
}

function tierPolicy(tier: TaskTier, config: AutoRouterConfig): MetaHarnessPolicy {
  return cleanPolicy({
    effort: resolveEffortForTier(tier, config),
    speed: resolveSpeedForTier(tier, config),
    workflow: resolveWorkflowForTier(tier, config),
    budgetUsd: resolveBudgetForTier(tier, config),
    verification: resolveVerificationForTier(tier, config),
  });
}

function categoryPolicy(category: ResolvedAutoRouterCategory | undefined): MetaHarnessPolicy {
  if (!category) return {};
  return cleanPolicy({
    effort: category.effort,
    speed: category.speed,
    workflow: category.workflow,
    budgetUsd: category.budgetUsd,
    verification: category.verification,
  });
}

function resolveRoutePolicy(
  tier: TaskTier,
  config: AutoRouterConfig,
  matchedCategory?: ResolvedAutoRouterCategory,
): MetaHarnessPolicy {
  return cleanPolicy({
    ...tierPolicy(tier, config),
    ...categoryPolicy(matchedCategory),
  });
}

function configuredModelsForTier(tier: TaskTier, config: AutoRouterConfig): string[] {
  return Array.from(new Set([
    resolveModelForTier(tier, config),
    config.planModel,
    config.buildModel,
    config.verifyModel,
    config.refineModel,
    config.fallbackModel,
    ...customModelCandidatesForTier(tier),
  ].filter(Boolean)));
}

/**
 * Returns true when the user has explicitly set a model for the given tier
 * in the Auto Build settings UI (as opposed to relying on the default config).
 * Checks both the `categories` array and the direct `{tier}Model` fields.
 */
function isUserConfiguredModel(tier: TaskTier): boolean {
  const settings = getSettingsObject();
  const saved = settings.autoRouterConfig as Record<string, unknown> | undefined;
  if (!saved) return false;

  const categories = saved.categories as Array<{ id: string; model: string }> | undefined;
  if (categories?.some(cat => cat.id === tier && cat.model)) return true;

  const key = `${tier}Model`;
  return typeof saved[key] === 'string';
}

function applyCostAwareDowngrade(
  tier: TaskTier,
  config: AutoRouterConfig,
): string {
  const configured = resolveModelForTier(tier, config);
  // Planning turns are frequent and usually do not need frontier Claude. Keep the same
  // Claude harness, but use Sonnet when cost-aware routing is enabled —
  // unless the user has explicitly chosen Fable/Opus for this tier.
  if (tier === 'plan' && /^claude-(?:fable|opus)/i.test(configured)) {
    if (isUserConfiguredModel('plan')) return configured;
    return 'claude-sonnet-5';
  }
  return configured;
}

function firstAvailable(candidates: string[], fallbackModel: string, options?: ModelAvailabilityOptions): string {
  for (const candidate of candidates) {
    if (hasConfiguredCredentialForModel(candidate, options)) return candidate;
  }
  return hasConfiguredCredentialForModel(fallbackModel, options) ? fallbackModel : 'claude-sonnet-5';
}

const HARNESS_REQUEST_PATTERNS: Record<Harness, RegExp> = {
  claude: /\bclaude(?:\s+code)?\b/i,
  codex: /\bcodex\b/i,
  cursor: /\bcursor(?:\s+(?:agent|composer))?\b/i,
  gemini: /\bgemini\b/i,
  opencode: /\bopen\s*code\b|\bopencode\b/i,
  custom: /\bcustom\s+(?:model|harness|agent)\b/i,
};

// Harness name fragments for directive detection ("use codex", "switch to
// gemini"). Stricter than HARNESS_REQUEST_PATTERNS: a bare mention ("update
// CLAUDE.md") must not count as a routing request.
const HARNESS_NAME_PATTERN_SOURCES: Record<Harness, string> = {
  claude: 'claude(?:\\s+code)?',
  codex: 'codex',
  cursor: 'cursor(?:\\s+(?:agent|composer))?',
  gemini: 'gemini',
  opencode: '(?:open\\s*code|opencode)',
  custom: 'custom\\s+(?:model|harness|agent)',
};

const HARNESS_DIRECTIVE_CONTEXT = '(?:use|using|with|via|through|ask|have|let|try|prefer|switch(?:ing)?\\s+to|route\\s+(?:this\\s+)?(?:to|through)|hand(?:\\s+this)?\\s+(?:off\\s+)?to|delegate\\s+to)';

function harnessesInDirectivePosition(message: string): Harness[] {
  return (Object.keys(HARNESS_NAME_PATTERN_SOURCES) as Harness[]).filter((harness) =>
    new RegExp(`\\b${HARNESS_DIRECTIVE_CONTEXT}\\s+(?:the\\s+)?${HARNESS_NAME_PATTERN_SOURCES[harness]}(?!\\.|\\w)`, 'i').test(message)
  );
}

/**
 * Detects an unambiguous, user-typed directive to run this turn on a specific
 * harness ("use codex to fix it", "switch to gemini"). Returns undefined when
 * no harness — or more than one — is named in directive position.
 */
function explicitlyRequestedHarness(message: string): Harness | undefined {
  const matches = harnessesInDirectivePosition(message);
  return matches.length === 1 ? matches[0] : undefined;
}

// A different harness named in directive position ("use codex") breaks
// continuity; a bare mention (file path, question about past work) does not.
function userRequestedDifferentHarness(message: string, continuationHarness: Harness): boolean {
  return harnessesInDirectivePosition(message).some((harness) => harness !== continuationHarness);
}

// Follow-up cues at the start of a message: approvals, continuations, and
// incremental asks that build on the previous turn's work.
const CONTINUATION_OPENER_RE = /^(?:ok(?:ay)?|yes|yep|yeah|sure|great|nice|good|perfect|lgtm|thanks?|thank you)?[,.!\s]*(?:now\s+|please\s+)?(?:continue|keep (?:going|at it)|go on|carry on|resume|proceed|next|retry|try again|run it again|one more|go ahead|do it|finish|wrap up|ship it|and\b|also\b|then\b|same\b)/i;

// References to the previous turn's output without introducing a new subject.
const ANAPHORIC_REFERENCE_RE = /\b(?:it|that|this|those|these|them|the same|the above|your (?:change|fix|plan|approach|version)|what you (?:did|made|wrote|suggested|proposed))\b/i;

// Explicit signals that the user is starting something unrelated.
const NEW_TASK_CUE_RE = /\b(?:new (?:task|feature|project|bug|issue|topic|request)|different (?:task|problem|issue|topic)|unrelated|separate(?:ly)? (?:task|issue|thing)|switch(?:ing)? (?:gears|topics?|to)|next (?:task|project|feature)|moving on|instead of that|forget (?:that|it)|something else (?:entirely|now)?)\b/i;

/**
 * A continuation intent builds on the previous turn's work, so staying on the
 * previous harness is both cheaper (native resume preserves context instead of
 * rebuilding it from transcripts) and more accurate. New, self-contained
 * intents must NOT match — they re-route freely.
 */
function isContinuationIntentMessage(message: string, signals: TaskSignals): boolean {
  const trimmed = message.trim();
  if (NEW_TASK_CUE_RE.test(trimmed)) return false;
  if (isApprovedPlanExecutionFollowup(trimmed)) return true;
  if (CONTINUATION_OPENER_RE.test(trimmed)) return true;
  // Short messages mid-session are nearly always follow-ups on the work in
  // flight ("fix the lint too", "make it purple", "why did that fail?").
  if (signals.short) return true;
  // Medium-length messages that lean on the previous turn's output.
  if (trimmed.length < 400 && ANAPHORIC_REFERENCE_RE.test(trimmed)) return true;
  return false;
}

// Asks for cross-harness orchestration — never pin those to one harness.
// Deliberately narrower than signals.asksForMultiHarness, which also fires on
// bare harness-name mentions like "CLAUDE.md" or "what did codex do?".
const ORCHESTRATION_ASK_RE = /\b(?:multiplex|orchestrat\w*|multi[- ]?harness|multiple (?:agents|models|harnesses)|in parallel across)\b/i;

function shouldPreferContinuationHarness(
  message: string,
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): boolean {
  if (!options?.continuationHarness) return false;
  // Planning escalations deserve a fresh frontier-model choice regardless of
  // which harness ran the last turn.
  if (tier === 'plan') return false;
  if (signals.asksForCapabilityEscalation || ORCHESTRATION_ASK_RE.test(message)) return false;
  if (userRequestedDifferentHarness(message, options.continuationHarness)) return false;
  // Plan approval is an intentional phase boundary. The approved plan is
  // transferred as an artifact, while the configured Build model takes over.
  if (options.approvedPlanContinuation && isApprovedPlanExecutionFollowup(message)) return false;
  if (!isContinuationIntentMessage(message, signals)) return false;

  // Native-session reuse is only an optimization after settings have chosen
  // the model for this tier. Never keep the previous harness when doing so
  // would override the user's fixed Planning/Execution/Verification/Refinement
  // selection.
  const configured = config.costAware
    ? applyCostAwareDowngrade(tier, config)
    : resolveModelForTier(tier, config);
  return harnessFromModel(configured) === options.continuationHarness
    && hasConfiguredCredentialForModel(configured, options);
}

function isApprovedPlanExecutionFollowup(message: string): boolean {
  return /\b(?:go ahead|go do it|do it|fire it up|execute(?: the)? (?:approved )?plan|implement(?: the)? (?:approved )?plan|proceed|ship it|pr this)\b/i.test(message);
}

function chooseContinuationModelForTier(
  tier: TaskTier,
  config: AutoRouterConfig,
  options?: ModelAvailabilityOptions,
): ModelChoice | undefined {
  const continuationHarness = options?.continuationHarness;
  if (!continuationHarness) return undefined;

  const configured = config.costAware
    ? applyCostAwareDowngrade(tier, config)
    : resolveModelForTier(tier, config);
  if (
    harnessFromModel(configured) !== continuationHarness
    || !hasConfiguredCredentialForModel(configured, options)
  ) return undefined;

  return {
    model: configured,
    harness: continuationHarness,
    reason: `Configured ${tier} model ${configured} matches the previous ${continuationHarness} harness; reusing native session context`,
  };
}

function chooseModelForExplicitHarness(
  tier: TaskTier,
  requestedHarness: Harness,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): ModelChoice | undefined {
  const candidates = [
    ...candidateModelsForTier(tier, config, signals, options),
    ...configuredModelsForTier(tier, config),
    config.fallbackModel,
    'claude-sonnet-5',
    'claude-sonnet-4-6',
  ];
  const chosen = candidates.find((model) => (
    harnessFromModel(model) === requestedHarness
    && hasConfiguredCredentialForModel(model, options)
  ));
  if (!chosen) return undefined;
  return {
    model: chosen,
    harness: requestedHarness,
    reason: `User explicitly requested ${requestedHarness}; selected ${chosen}`,
  };
}

function needsFrontierReasoning(tier: TaskTier, signals: TaskSignals): boolean {
  if (signals.asksForCapabilityEscalation) return true;
  if (tier !== 'plan') return false;

  const complexDomain = signals.domain === 'backend'
    || signals.domain === 'fullstack'
    || signals.domain === 'data'
    || signals.domain === 'ops'
    || signals.domain === 'debug';

  return signals.large
    || (signals.asksForArchitecture && (complexDomain || signals.likelyNeedsProjectContext))
    || (signals.asksForReview && (signals.hasErrorLog || signals.large || signals.likelyNeedsProjectContext))
    || (signals.asksForMultiHarness && signals.likelyNeedsProjectContext);
}

function isFableModel(model?: string): boolean {
  return /^claude-fable-5$/i.test(model || '');
}

function frontierClaudeCandidatesForTier(tier: TaskTier, config: AutoRouterConfig): string[] {
  const configured = resolveModelForTier(tier, config);
  const customTierModels = getConfiguredAutoRouterCategories()
    .filter((category) => inferCategoryTier(category) === tier)
    .map((category) => category.model)
    .filter((model): model is string => Boolean(model));
  return Array.from(new Set([
    configured,
    config.fallbackModel,
    ...customTierModels,
  ].filter((model) => /^(?:claude-fable|claude-opus)/i.test(model))));
}

function isFableAllowedForAutoTier(
  tier: TaskTier,
  config: AutoRouterConfig,
  options?: ModelAvailabilityOptions,
): boolean {
  if (isFableModel(resolveModelForTier(tier, config))) return true;
  return customCategoriesForController(options).some((category) => (
    category.tier === tier && isFableModel(category.model)
  ));
}

function researchPriorModelCandidates(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
): string[] {
  const candidates: string[] = [];
  const addFrontierClaude = () => candidates.push(...frontierClaudeCandidatesForTier(tier, config));

  if (signals.asksForCapabilityEscalation) {
    addFrontierClaude();
  }

  switch (tier) {
    case 'plan':
      if (needsFrontierReasoning(tier, signals)) {
        addFrontierClaude();
        candidates.push(config.planModel, 'claude-sonnet-5', 'claude-sonnet-4-6');
      }
      break;
    case 'build':
      candidates.push(config.buildModel, 'codex:gpt-5.6-sol');
      if (signals.large || signals.asksForArchitecture || signals.asksForMultiHarness) {
        candidates.push(...frontierClaudeCandidatesForTier(tier, config));
      }
      break;
    case 'verify':
      candidates.push(config.verifyModel, 'codex:gpt-5.6-sol');
      if (signals.asksForCapabilityEscalation || (signals.hasErrorLog && (signals.large || signals.likelyNeedsProjectContext))) {
        addFrontierClaude();
      }
      break;
    case 'refine':
      candidates.push(config.refineModel);
      if (signals.domain === 'frontend' || signals.domain === 'copy') {
        candidates.push('cursor:composer-2.5');
      }
      if (signals.hasErrorLog) {
        candidates.push(config.verifyModel);
      }
      break;
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function candidateModelsForTier(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): string[] {
  const configured = config.costAware
    ? applyCostAwareDowngrade(tier, config)
    : resolveModelForTier(tier, config);
  const configuredCandidates = configuredModelsForTier(tier, config);
  const domainCandidates = domainModelCandidates(tier, config, signals);
  const priorCandidates = researchPriorModelCandidates(tier, config, signals);
  const allowedModels = new Set([configured, ...configuredCandidates, ...domainCandidates, ...priorCandidates]);
  const allowFable = isFableAllowedForAutoTier(tier, config, options);

  const candidates: string[] = priorCandidates.length > 0
    ? [...priorCandidates, configured]
    : [configured];
  try {
    const learnedModels = analyticsService.getHarnessInsightsForTier(tier, signals.domain)
      .filter((insight) => {
        const tierStats = insight.byTier[tier];
        const overrideCount = tierStats?.overrideCount ?? insight.overrideCount;
        const successRate = tierStats?.successRate ?? insight.successRate;
        return overrideCount > 0 || successRate >= 0.7;
      })
      .filter((insight) => {
        const tierStats = insight.byTier[tier];
        const runs = tierStats?.runs ?? insight.runs;
        const failures = tierStats?.failures ?? insight.failures;
        const successes = tierStats?.successes ?? insight.successes;
        return runs < 2 || failures <= successes;
      })
      .map((insight) => insight.model)
      .filter((model, index, models) => models.indexOf(model) === index)
      .filter((model) => allowFable || !isFableModel(model))
      .filter((model) => {
        if (allowedModels.has(model)) return true;
        const insight = analyticsService.getHarnessInsights().find((candidate) => candidate.model === model);
        const tierStats = insight?.byTier[tier];
        const domainStats = insight?.byDomain[signals.domain];
        return Boolean(tierStats?.overrideCount || domainStats?.overrideCount || insight?.overrideCount);
      })
      .slice(0, 4);
    candidates.push(...learnedModels);
  } catch {
    // Analytics should never block routing.
  }

  candidates.push(...domainCandidates);
  candidates.push(...configuredCandidates);

  return Array.from(new Set(candidates.filter((model) => (
    !!model && (allowFable || !isFableModel(model))
  ))));
}

function domainModelCandidates(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
): string[] {
  const candidates: string[] = [];
  if (signals.domain === 'copy') {
    candidates.push('claude-sonnet-5', 'claude-sonnet-4-6');
    if (tier === 'build' || tier === 'refine') {
      candidates.push(config.refineModel, 'cursor:composer-2.5');
    }
  } else if (signals.domain === 'frontend') {
    candidates.push(config.refineModel, 'cursor:composer-2.5', config.buildModel);
  } else if (signals.domain === 'backend' || signals.domain === 'fullstack') {
    candidates.push(config.buildModel, config.verifyModel, 'codex:gpt-5.6-sol');
  } else if (signals.domain === 'ops' || signals.domain === 'debug') {
    candidates.push(config.verifyModel, config.buildModel);
  }
  if (tier === 'plan') {
    candidates.unshift(config.planModel, 'claude-sonnet-5', 'claude-sonnet-4-6');
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function chooseModelForTier(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): ModelChoice {
  const configured = config.costAware
    ? applyCostAwareDowngrade(tier, config)
    : resolveModelForTier(tier, config);
  if (
    !signals.asksForCapabilityEscalation &&
    hasConfiguredCredentialForModel(configured, options)
  ) {
    return {
      model: configured,
      harness: harnessFromModel(configured),
      reason: `Configured ${tier} model is user-selected; using ${configured} without silent fallback`,
    };
  }

  const candidates = candidateModelsForTier(tier, config, signals, options);
  const priorCandidates = researchPriorModelCandidates(tier, config, signals);
  if (signals.asksForCapabilityEscalation) {
    candidates.unshift(...frontierClaudeCandidatesForTier(tier, config), config.planModel, config.fallbackModel);
  }
  if (signals.asksForMultiHarness && signals.large && tier !== 'refine') {
    candidates.unshift(...configuredModelsForTier(tier, config).filter((model) => harnessFromModel(model) === 'claude'));
  }
  if (configured !== resolveModelForTier(tier, config) && priorCandidates.length === 0 && !signals.asksForCapabilityEscalation) {
    candidates.unshift(configured);
  }
  const chosen = firstAvailable(candidates, config.fallbackModel, options);
  const harness = harnessFromModel(chosen);
  const usedResearchPrior = priorCandidates.includes(chosen) && chosen !== configured;
  const reason = signals.asksForCapabilityEscalation && (chosen.includes('fable') || chosen.includes('opus'))
    ? `User asked for deeper reasoning or a stronger model; selected ${chosen}`
    : usedResearchPrior
    ? `Task complexity/model-harness routing priors selected ${chosen}`
    : chosen === configured
    ? `Configured ${tier} model is available`
    : `Configured ${tier} model was not usable for this environment; selected ${chosen}`;

  return { model: chosen, harness, reason };
}

function canRunMutatingStages(permissionMode?: string): boolean {
  return permissionMode !== 'plan' && permissionMode !== 'dontAsk';
}

function isExecutableDelegateHarness(harness: Harness): boolean {
  return harness === 'codex' || harness === 'cursor' || harness === 'gemini' || harness === 'opencode';
}

function pickDelegateStageModel(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
  excludeModel?: string,
): string | undefined {
  return pickDelegateStageModels(tier, config, signals, options, [excludeModel])[0];
}

function pickDelegateStageModels(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
  excludeModels: Array<string | undefined> = [],
): string[] {
  const excluded = new Set(excludeModels.filter((model): model is string => !!model));
  const candidates = candidateModelsForTier(tier, config, signals, options)
    .filter((model) => !excluded.has(model))
    .filter((model) => isExecutableDelegateHarness(harnessFromModel(model)))
    .filter((model) => hasConfiguredCredentialForModel(model, options));

  return Array.from(new Set(candidates));
}

function buildOrchestrationHandoff(
  leadTier: TaskTier,
  requestedTier: TaskTier,
  signals: TaskSignals,
  stages: OrchestrationStage[],
  leadDuties: string[] = [],
  goalObjective?: string,
): string {
  const stageLines = stages
    .map((stage, index) => `${index + 1}. ${stage.tier.toUpperCase()} - ${stage.purpose}${stage.required ? '' : ' (optional)'}`)
    .join('\n');

  const extraGuidance = [
    leadTier === 'plan' && stages.some((stage) => stage.trigger === 'after-plan')
      ? '- Planning scope: stop at the plan. Do not edit files, run mutating commands, or continue into execution; follow-up execution can run after this response.'
      : '',
    signals.needsBrowser ? '- Browser/UI work: use browser or screenshot tools for verification when available.' : '',
    signals.likelyNeedsProjectContext ? '- Project context matters: follow injected CLAUDE.md, AGENTS.md, agents, and skills as if native to this environment.' : '',
    signals.hasErrorLog ? '- Failure/debugging work: reproduce or inspect the failure before changing code, then verify the fix.' : '',
    signals.asksForMultiHarness ? '- The user asked to compare available execution options: handle that directly and summarize tradeoffs.' : '',
    '- Context switches are expensive. Carry the current scope as far as practical in the lead harness, and use later stages only at the listed phase boundaries.',
    '- For handoffs, prefer artifact references over copied history: transcript file references let the next harness search its own context, and plan-to-execution handoffs should point at the plan file path when available.',
    goalObjective
      ? `- Goal-driven turn: objective is "${goalObjective.slice(0, 600)}". Keep a concrete internal checklist, complete only the current routed scope, and report <goal>COMPLETE</goal> when the objective is fully achieved or <goal>BLOCKED</goal> when external input or unavailable services prevent meaningful progress.`
      : '',
    ...leadDuties.map((duty) => `- ${duty}`),
  ].filter(Boolean).join('\n');

  return [
    'Operate as the user-facing Build agent for this turn.',
    'This internal scope exists only to coordinate work. Do not mention internal coordination, sequencing, or follow-up handoffs unless the user explicitly asks.',
    requestedTier !== leadTier ? `The user asked for ${requestedTier.toUpperCase()} work; begin with ${leadTier.toUpperCase()} scope first.` : '',
    '',
    stageLines,
    extraGuidance ? `\nAdditional execution guidance:\n${extraGuidance}` : '',
    '',
    'When this turn starts in Claude and the plan includes a verification or second-opinion step, use CodexSecondOpinion at the natural decision point instead of asking the user to choose.',
    'In CLI-backed execution, treat the injected transcript, project instructions, agents, and skills as your own current context.',
  ].filter(Boolean).join('\n');
}

function buildOrchestrationPlan(
  leadTier: TaskTier,
  requestedTier: TaskTier,
  lead: ModelChoice,
  config: AutoRouterConfig,
  signals: TaskSignals,
  phase: SessionPhase,
  options?: ModelAvailabilityOptions & { permissionMode?: string; goalObjective?: string },
): OrchestrationPlan {
  const stages: OrchestrationStage[] = [];
  const leadDuties: string[] = [];
  const addStage = (
    stageTier: TaskTier,
    model: string,
    purpose: string,
    trigger: OrchestrationStage['trigger'],
    required: boolean,
  ) => {
    const fallbackModels = trigger === 'now'
      ? []
      : pickDelegateStageModels(stageTier, config, signals, options, [model, lead.model])
        .sort((a, b) => Number(harnessFromModel(a) === harnessFromModel(model)) - Number(harnessFromModel(b) === harnessFromModel(model)))
        .slice(0, 2);
    stages.push({
      tier: stageTier,
      harness: harnessFromModel(model),
      model,
      ...tierPolicy(stageTier, config),
      fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
      purpose,
      trigger,
      required,
    });
  };

  const canMutate = canRunMutatingStages(options?.permissionMode);
  const verificationPolicy = resolveVerificationForTier(leadTier, config);
  const requestedVerification = verificationPolicy === 'required'
    || (verificationPolicy !== 'none' && (requestedTier === 'verify' || signals.asksForVerification || signals.hasErrorLog));
  const verificationRequired = verificationPolicy !== 'optional';
  addStage(leadTier, lead.model, `Lead ${leadTier} work`, 'now', true);

  const requestedBuildAfterLeadPlan = leadTier === 'plan' && requestedTier === 'build' && canMutate;
  if (requestedBuildAfterLeadPlan) {
    const buildDelegate = pickDelegateStageModel('build', config, signals, options, lead.model);
    if (buildDelegate) {
      addStage('build', buildDelegate, 'Implement the planned change after the lead plan', 'after-plan', true);
      if (requestedVerification) {
        const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, buildDelegate)
          || pickDelegateStageModel('verify', config, signals, options, lead.model);
        if (verifyDelegate) {
          addStage('verify', verifyDelegate, 'Run the requested checks after implementation', 'after-build', verificationRequired);
        }
      }
    }
  }

  if (leadTier === 'plan' && requestedTier === 'verify') {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested verification after the lead plan', 'after-plan', verificationRequired);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead stage must cover the requested verification itself.');
    }
  }

  if (leadTier === 'plan' && !requestedBuildAfterLeadPlan && requestedVerification) {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested verification after the lead plan', 'after-plan', verificationRequired);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead stage should cover the requested verification itself.');
    }
  }

  if (leadTier === 'build' && requestedVerification) {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested checks after the build', 'after-build', verificationRequired);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead stage should cover the requested checks itself.');
    }
  }

  if (leadTier === 'verify' && signals.hasErrorLog) {
    const refineDelegate = pickDelegateStageModel('refine', config, signals, options, lead.model);
    if (refineDelegate) {
      addStage('refine', refineDelegate, 'Apply small fixes after the failure is isolated', 'on-failure', false);
    } else {
      leadDuties.push('No executable refine delegate is available; if the failure is isolated, the lead stage should either fix it directly or state the precise next edit.');
    }
  }

  if (leadTier === 'refine' && requestedVerification) {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested checks after refinement', 'after-build', verificationRequired);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead refinement should cover the requested checks itself.');
    }
  }

  const uniqueStages = stages.filter((stage, index) =>
    stages.findIndex((candidate) =>
      candidate.tier === stage.tier &&
      candidate.model === stage.model &&
      candidate.trigger === stage.trigger
    ) === index
  );

  const uniqueHarnesses = new Set(uniqueStages.map((stage) => stage.harness));
  const mode: OrchestrationPlan['mode'] = uniqueStages.length === 1
    ? 'single'
    : uniqueHarnesses.size > 1
      ? 'lead-with-delegates'
      : 'sequential';

  return {
    mode,
    leadHarness: lead.harness,
    leadModel: lead.model,
    stages: uniqueStages,
    contextPolicy: {
      includeTranscript: true,
      includeTranscriptReferences: true,
      includePlanFileReference: true,
      avoidBulkContextOnHandoff: true,
      maxHandoffConversationChars: 24000,
      includeProjectInstructions: true,
      includeSkills: true,
      includeAgents: true,
      includeMemories: true,
    },
    handoffPrompt: buildOrchestrationHandoff(leadTier, requestedTier, signals, uniqueStages, leadDuties, options?.goalObjective),
  };
}

function metaCandidateModelsForTier(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): string[] {
  const configured = resolveModelForTier(tier, config);
  const costAdjusted = config.costAware
    ? applyCostAwareDowngrade(tier, config)
    : configured;
  const candidates = config.costAware && !signals.asksForCapabilityEscalation
    ? [costAdjusted, configured]
    : [configured, costAdjusted];

  if (signals.asksForCapabilityEscalation) {
    candidates.push(...researchPriorModelCandidates(tier, config, signals));
  }

  candidates.push(
    ...customCategoriesForController(options)
      .filter((category) => category.tier === tier)
      .map((category) => category.model),
  );
  candidates.push(config.fallbackModel);

  const allowFable = isFableAllowedForAutoTier(tier, config, options);
  return Array.from(new Set(candidates.filter((model) =>
    !!model && (allowFable || !isFableModel(model)) && hasConfiguredCredentialForModel(model, options)
  )));
}

function candidateModelsByTierForMeta(
  config: AutoRouterConfig,
  signals: TaskSignals,
  options?: ModelAvailabilityOptions,
): Record<TaskTier, string[]> {
  const result = {} as Record<TaskTier, string[]>;
  for (const tier of ['plan', 'build', 'verify', 'refine'] as TaskTier[]) {
    result[tier] = metaCandidateModelsForTier(tier, config, signals, options);
  }
  return result;
}

function getCerebrasKey(): string {
  const settings = getSettingsObject();
  return (settings.cerebrasApiKey as string) || EMBEDDED_KEYS.cerebras || process.env.CEREBRAS_API_KEY || '';
}

function isMetaModelAllowedForTier(
  tier: TaskTier,
  model: string,
  candidateModelsByTier: Record<TaskTier, string[]>,
  options?: ModelAvailabilityOptions,
): boolean {
  return candidateModelsByTier[tier].includes(model) && hasConfiguredCredentialForModel(model, options);
}

function redactMetaControllerTerms(reason: string): string {
  return reason
    .replace(/\bAuto Build\b/gi, 'workflow')
    .replace(/\bFlue\s+meta[- ]harness\b/gi, 'workflow routing')
    .replace(/\bflue\s+controller\b/gi, 'workflow routing')
    .replace(/\bflue\b/gi, 'workflow routing')
    .replace(/\bmeta[- ]harness\b/gi, 'workflow routing')
    .replace(/\bcontroller\b/gi, 'routing')
    .replace(/\borchestration plan\b/gi, 'follow-up plan')
    .replace(/\bmodel selection\b/gi, 'routing choice')
    .slice(0, 500);
}

function hasRoutingOverrideAttempt(message: string): boolean {
  return [
    /\bignore\b.{0,100}\b(?:router|routing|system|developer|previous|above|instructions?|prompt)\b/i,
    /\b(?:leadTier|requestedTier|candidateModelsByTier)\b/i,
    /\breturn\b.{0,80}\bjson\b.{0,80}\b(?:tier|category|harness|model)\b/i,
    /\b(?:force|set)\s+(?:the\s+)?(?:lead\s*)?(?:tier|category)\s*(?:to|=)/i,
    /\bchoose\s+(?:the\s+)?(?:plan|build|verify|refine)\s+(?:tier|category)\b/i,
  ].some((pattern) => pattern.test(message));
}

function getMetaRouteRejectionReason(
  meta: FlueMetaRouteDecision,
  proposedResult: HeuristicResult,
  deterministicResult: HeuristicResult,
  message: string,
): string | undefined {
  if (proposedResult.tier === deterministicResult.tier) return undefined;

  if (hasRoutingOverrideAttempt(message)) {
    return `controller route contradicted deterministic ${deterministicResult.tier} route under routing-override text`;
  }

  return undefined;
}

function shouldUseDeterministicFastPath(
  _message: string,
  _result: HeuristicResult,
  _phase: SessionPhase,
  _signals: TaskSignals,
  _options: RouteOptions,
): boolean {
  // Heuristics are now fallback-only. The Cerebras-backed meta-controller is
  // the primary routing decision maker. Deterministic fast-path is disabled so
  // that every request flows through the meta-controller first; the heuristic
  // classifier is only consulted when the meta-controller is unavailable or
  // returns an invalid result.
  return false;
}

function sanitizeMetaLead(
  meta: FlueMetaRouteDecision,
  config: AutoRouterConfig,
  signals: TaskSignals,
  candidateModelsByTier: Record<TaskTier, string[]>,
  options?: ModelAvailabilityOptions,
): ModelChoice {
  const leadTier = meta.leadTier;
  const preferredLeadModel = candidateModelsByTier[leadTier]?.[0];
  if (
    preferredLeadModel &&
    !signals.asksForCapabilityEscalation &&
    preferredLeadModel !== meta.leadModel &&
    isMetaModelAllowedForTier(leadTier, preferredLeadModel, candidateModelsByTier, options)
  ) {
    return {
      model: preferredLeadModel,
      harness: harnessFromModel(preferredLeadModel),
      reason: `Selected ${preferredLeadModel}`,
    };
  }

  if (isMetaModelAllowedForTier(leadTier, meta.leadModel, candidateModelsByTier, options)) {
    return {
      model: meta.leadModel,
      harness: harnessFromModel(meta.leadModel),
      reason: `Selected ${meta.leadModel}`,
    };
  }

  const fallback = chooseModelForTier(leadTier, config, signals, options);
  return {
    ...fallback,
    reason: `Selected route model was unavailable; ${fallback.reason}`,
  };
}

function sanitizeMetaStageModel(
  stage: FlueMetaStageDecision,
  lead: ModelChoice,
  config: AutoRouterConfig,
  signals: TaskSignals,
  candidateModelsByTier: Record<TaskTier, string[]>,
  options?: ModelAvailabilityOptions,
): string | undefined {
  if (isMetaModelAllowedForTier(stage.tier, stage.model, candidateModelsByTier, options)) {
    return stage.model;
  }
  return pickDelegateStageModel(stage.tier, config, signals, options, lead.model);
}

function normalizeMetaStageTrigger(
  stage: FlueMetaStageDecision,
  meta: FlueMetaRouteDecision,
  existingStages: OrchestrationStage[],
  deterministicPlan: OrchestrationPlan,
): OrchestrationStage['trigger'] | undefined {
  const deterministicStage = deterministicPlan.stages
    .slice(1)
    .find((candidate) => candidate.tier === stage.tier);
  if (deterministicStage) return deterministicStage.trigger;

  if (stage.trigger === 'after-plan') {
    return meta.leadTier === 'plan' ? 'after-plan' : undefined;
  }

  if (stage.trigger === 'after-build') {
    const hasBuildBefore = meta.leadTier === 'build'
      || existingStages.some((candidate) => candidate.tier === 'build')
      || deterministicPlan.stages.some((candidate) => candidate.tier === 'build');
    return hasBuildBefore ? 'after-build' : undefined;
  }

  if (stage.trigger === 'on-failure') {
    return stage.tier === 'refine' ? 'on-failure' : undefined;
  }

  return undefined;
}

function buildOrchestrationPlanFromMeta(
  meta: FlueMetaRouteDecision,
  lead: ModelChoice,
  config: AutoRouterConfig,
  signals: TaskSignals,
  phase: SessionPhase,
  options: ModelAvailabilityOptions & { permissionMode?: string; goalObjective?: string },
  candidateModelsByTier: Record<TaskTier, string[]>,
): OrchestrationPlan {
  const deterministicPlan = buildOrchestrationPlan(meta.leadTier, meta.requestedTier, lead, config, signals, phase, options);
  const stages: OrchestrationStage[] = [{
    tier: meta.leadTier,
    harness: lead.harness,
    model: lead.model,
    ...tierPolicy(meta.leadTier, config),
    purpose: `Lead ${meta.leadTier} work`,
    trigger: 'now',
    required: true,
  }];

  const canMutate = canRunMutatingStages(options.permissionMode);
  for (const rawStage of meta.stages) {
    if (rawStage.trigger === 'now' || rawStage.trigger === 'manual-follow-up') continue;
    if ((rawStage.tier === 'build' || rawStage.tier === 'refine') && !canMutate) continue;
    const rawStagePolicy = tierPolicy(rawStage.tier, config);
    if (rawStage.tier === 'verify' && rawStagePolicy.verification === 'none') continue;

    const model = sanitizeMetaStageModel(rawStage, lead, config, signals, candidateModelsByTier, options);
    if (!model || model === lead.model) continue;

    const harness = harnessFromModel(model);
    if (!isExecutableDelegateHarness(harness)) continue;

    const trigger = normalizeMetaStageTrigger(rawStage, meta, stages, deterministicPlan);
    if (!trigger) continue;

    const fallbackModels = pickDelegateStageModels(rawStage.tier, config, signals, options, [model, lead.model])
      .slice(0, 2);

    stages.push({
      tier: rawStage.tier,
      harness,
      model,
      ...rawStagePolicy,
      fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
      purpose: redactMetaControllerTerms(rawStage.purpose || `${rawStage.tier} follow-up`),
      trigger,
      required: rawStagePolicy.verification === 'optional' && rawStage.tier === 'verify' ? false : rawStage.required,
    });
  }

  for (const defaultStage of deterministicPlan.stages.slice(1)) {
    const alreadyCovered = stages.some((stage) =>
      stage.tier === defaultStage.tier &&
      stage.trigger === defaultStage.trigger
    );
    if (!alreadyCovered) {
      stages.push({
        ...defaultStage,
        purpose: `Required follow-up: ${defaultStage.purpose}`,
      });
    }
  }

  const uniqueStages = stages.filter((stage, index) =>
    stages.findIndex((candidate) =>
      candidate.tier === stage.tier &&
      candidate.model === stage.model &&
      candidate.trigger === stage.trigger
    ) === index
  );

  const uniqueHarnesses = new Set(uniqueStages.map((stage) => stage.harness));
  const mode: OrchestrationPlan['mode'] = uniqueStages.length === 1
    ? 'single'
    : uniqueHarnesses.size > 1
      ? 'lead-with-delegates'
      : 'sequential';

  return {
    mode,
    leadHarness: lead.harness,
    leadModel: lead.model,
    stages: uniqueStages,
    contextPolicy: {
      includeTranscript: true,
      includeTranscriptReferences: true,
      includePlanFileReference: true,
      avoidBulkContextOnHandoff: true,
      maxHandoffConversationChars: 24000,
      includeProjectInstructions: true,
      includeSkills: true,
      includeAgents: true,
      includeMemories: true,
    },
    handoffPrompt: buildOrchestrationHandoff(meta.leadTier, meta.requestedTier, signals, uniqueStages, [
      'Execute only the scope assigned to this turn.',
      'Required follow-up work may be added when necessary execution or verification scope was omitted.',
    ], options.goalObjective),
  };
}

function getSessionPhase(sessionId: string): SessionPhase {
  return sessionPhases.get(sessionId) || {
    hasPlanContext: false,
    hasBuildContext: false,
    recentTiers: [],
  };
}

function normalizeMessageTimestamp(message: ChatMessage): ChatMessage {
  return {
    ...message,
    timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
  };
}

function extractRecordedTiersFromContent(content?: string): TaskTier[] {
  if (!content) return [];

  const tiers: TaskTier[] = [];
  const addTier = (value: string | undefined) => {
    const normalized = value?.toLowerCase();
    if (normalized === 'plan' || normalized === 'build' || normalized === 'verify' || normalized === 'refine') {
      tiers.push(normalized);
    }
  };

  const completedLeadMatch = content.match(/Completed (?:lead tier|scope):\s*(plan|build|verify|refine)\b/i);
  addTier(completedLeadMatch?.[1]);

  const helperOutputIndex = content.search(/(?:Helper|Follow-up) output:/i);
  const hasStructuredTurnResult = /<(?:auto_build|workflow)_turn_result>/i.test(content);
  const helperOnlyContent = hasStructuredTurnResult
    ? helperOutputIndex === -1 ? '' : content.slice(helperOutputIndex)
    : content;

  for (const match of helperOnlyContent.matchAll(/Auto Build\s+(PLAN|BUILD|VERIFY|REFINE)\b/gi)) {
    addTier(match[1]);
  }
  for (const match of helperOnlyContent.matchAll(/\b(PLAN|BUILD|VERIFY|REFINE)\s+follow-up\b/gi)) {
    addTier(match[1]);
  }
  for (const match of helperOnlyContent.matchAll(/^\s*\d+\.\s+(plan|build|verify|refine)\s*:/gim)) {
    addTier(match[1]);
  }
  for (const match of helperOnlyContent.matchAll(/\bStage:\s*(PLAN|BUILD|VERIFY|REFINE)\b/gi)) {
    addTier(match[1]);
  }

  return tiers;
}

function restoreWorkflowFailuresFromMetadata(sessionId: string, message: ChatMessage): void {
  const failures = message.metadata?.workflowFailures || [];
  for (const failure of failures) {
    if (
      failure.harness === 'claude' ||
      failure.harness === 'codex' ||
      failure.harness === 'cursor' ||
      failure.harness === 'gemini' ||
      failure.harness === 'opencode' ||
      failure.harness === 'custom'
    ) {
      restoreHarnessFailure(
        sessionId,
        failure.harness,
        failure.model,
        failure.error,
        message.timestamp,
      );
    }
  }
}

function inferPhaseFromMessages(messages?: ChatMessage[]): SessionPhase {
  const phase: SessionPhase = {
    hasPlanContext: false,
    hasBuildContext: false,
    recentTiers: [],
  };
  if (!messages?.length) return phase;

  const sorted = messages
    .map(normalizeMessageTimestamp)
    .filter((message) => !Number.isNaN(message.timestamp.getTime()))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-80);

  for (const message of sorted) {
    if (message.role !== 'assistant' && message.role !== 'system') continue;
    const tiers = extractRecordedTiersFromContent(message.content);
    for (const tier of tiers) {
      if (tier === 'plan') phase.hasPlanContext = true;
      if (tier === 'build' || tier === 'refine') phase.hasBuildContext = true;
      phase.lastTierUsed = tier;
      phase.recentTiers = [...phase.recentTiers.slice(-9), tier];
    }
  }

  return phase;
}

function mergeSessionPhase(stored: SessionPhase, inferred: SessionPhase): SessionPhase {
  const storedRecent = stored.recentTiers || [];
  const inferredRecent = inferred.recentTiers || [];
  return {
    hasPlanContext: stored.hasPlanContext || inferred.hasPlanContext,
    hasBuildContext: stored.hasBuildContext || inferred.hasBuildContext,
    lastTierUsed: stored.lastTierUsed || inferred.lastTierUsed,
    recentTiers: (storedRecent.length > 0 ? storedRecent : inferredRecent).slice(-10),
  };
}

function recordTierCompletion(sessionId: string, tier: TaskTier): void {
  const phase = getSessionPhase(sessionId);
  phase.lastTierUsed = tier;
  if (tier === 'plan') phase.hasPlanContext = true;
  if (tier === 'build') phase.hasBuildContext = true;
  phase.recentTiers = [...phase.recentTiers.slice(-9), tier];
  sessionPhases.set(sessionId, phase);
}

function recordModelFailure(sessionId: string, model: string, error?: string): void {
  const failures = sessionModelFailures.get(sessionId) || new Map<string, FailureCooldown>();
  const previous = failures.get(model);
  const count = (previous?.count || 0) + 1;
  const cooldownMs = Math.min(
    EXTERNAL_HARNESS_FAILURE_COOLDOWN_MS * count,
    EXTERNAL_HARNESS_FAILURE_COOLDOWN_MAX_MS,
  );
  failures.set(model, {
    count,
    cooldownUntil: Date.now() + cooldownMs,
    lastError: error?.slice(0, 500),
    model,
  });
  sessionModelFailures.set(sessionId, failures);
  console.warn(`[AutoRouter] ${sessionId}: cooling down ${model} for ${Math.round(cooldownMs / 60000)}m after model failure`);
}

function recordHarnessFailure(sessionId: string, harness: Harness, model?: string, error?: string): void {
  if (harness === 'custom' && model) {
    recordModelFailure(sessionId, model, error);
    return;
  }
  if (harness === 'claude') return;
  const failures = sessionHarnessFailures.get(sessionId) || new Map<Harness, FailureCooldown>();
  const previous = failures.get(harness);
  const count = (previous?.count || 0) + 1;
  const cooldownMs = Math.min(
    EXTERNAL_HARNESS_FAILURE_COOLDOWN_MS * count,
    EXTERNAL_HARNESS_FAILURE_COOLDOWN_MAX_MS,
  );
  const failure = {
    count,
    cooldownUntil: Date.now() + cooldownMs,
    lastError: error?.slice(0, 500),
    model,
  };
  failures.set(harness, failure);
  sessionHarnessFailures.set(sessionId, failures);
  console.warn(`[AutoRouter] ${sessionId}: cooling down ${harness}${model ? `:${model}` : ''} for ${Math.round(cooldownMs / 60000)}m after helper failure`);
}

function recordHarnessSuccess(sessionId: string, harness: Harness, model?: string): void {
  if (model) {
    const modelFailures = sessionModelFailures.get(sessionId);
    if (modelFailures?.has(model)) {
      modelFailures.delete(model);
      if (modelFailures.size === 0) {
        sessionModelFailures.delete(sessionId);
      }
    }
  }

  const failures = sessionHarnessFailures.get(sessionId);
  if (!failures?.has(harness)) return;
  failures.delete(harness);
  if (failures.size === 0) {
    sessionHarnessFailures.delete(sessionId);
  }
}

function restoreModelFailure(sessionId: string, model: string, error: string | undefined, timestamp: Date): void {
  const cooldownUntil = timestamp.getTime() + EXTERNAL_HARNESS_FAILURE_COOLDOWN_MS;
  if (cooldownUntil <= Date.now()) return;

  const failures = sessionModelFailures.get(sessionId) || new Map<string, FailureCooldown>();
  const previous = failures.get(model);
  if (previous && previous.cooldownUntil >= cooldownUntil) return;

  failures.set(model, {
    count: Math.max(previous?.count || 0, 1),
    cooldownUntil,
    lastError: error?.slice(0, 500),
    model,
  });
  sessionModelFailures.set(sessionId, failures);
}

function restoreHarnessFailure(
  sessionId: string,
  harness: Harness,
  model: string | undefined,
  error: string | undefined,
  timestamp: Date,
): void {
  if (harness === 'custom' && model) {
    restoreModelFailure(sessionId, model, error, timestamp);
    return;
  }
  if (harness === 'claude') return;
  const cooldownUntil = timestamp.getTime() + EXTERNAL_HARNESS_FAILURE_COOLDOWN_MS;
  if (cooldownUntil <= Date.now()) return;

  const failures = sessionHarnessFailures.get(sessionId) || new Map<Harness, FailureCooldown>();
  const previous = failures.get(harness);
  if (previous && previous.cooldownUntil >= cooldownUntil) return;

  failures.set(harness, {
    count: Math.max(previous?.count || 0, 1),
    cooldownUntil,
    lastError: error?.slice(0, 500),
    model,
  });
  sessionHarnessFailures.set(sessionId, failures);
}

function inferHarnessFailuresFromMessages(sessionId: string, messages?: ChatMessage[]): void {
  if (!messages?.length) return;

  const recentMessages = messages
    .map(normalizeMessageTimestamp)
    .filter((message) => !Number.isNaN(message.timestamp.getTime()))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-40);

  for (const message of recentMessages) {
    if (message.role !== 'assistant' && message.role !== 'system') continue;
    restoreWorkflowFailuresFromMetadata(sessionId, message);
    const content = message.content || '';

    const leadFailurePattern = /Lead error:\s*(codex|cursor|gemini|opencode|custom):([^\n]+?)\s+-\s*([^\n]*)/gi;
    for (const match of content.matchAll(leadFailurePattern)) {
      restoreHarnessFailure(
        sessionId,
        match[1] as Harness,
        match[2]?.trim(),
        match[3]?.trim(),
        message.timestamp,
      );
    }

    if (!/Auto Build helper (?:could not complete|skipped)/i.test(content)) continue;

    const stageFailurePattern = /Auto Build\s+(?:PLAN|BUILD|VERIFY|REFINE)\s+via\s+(codex|cursor|gemini|opencode|custom):([^\n]+)[\s\S]{0,2500}?Auto Build helper (?:could not complete|skipped):?\s*([^\n]*)/gi;
    for (const match of content.matchAll(stageFailurePattern)) {
      restoreHarnessFailure(
        sessionId,
        match[1] as Harness,
        match[2]?.trim(),
        match[3]?.trim(),
        message.timestamp,
      );
    }
  }
}

function formatActiveHarnessCooldowns(sessionId: string): string {
  const failures = sessionHarnessFailures.get(sessionId);
  const active: string[] = [];
  if (failures) {
    for (const failure of failures.values()) {
      if (failure.cooldownUntil <= Date.now()) continue;
      const remainingMinutes = Math.max(1, Math.ceil((failure.cooldownUntil - Date.now()) / 60000));
      active.push(`recently failed helper cooling down ${remainingMinutes}m`);
    }
  }

  const modelFailures = sessionModelFailures.get(sessionId);
  if (modelFailures) {
    for (const failure of modelFailures.values()) {
      if (failure.cooldownUntil <= Date.now()) continue;
      const remainingMinutes = Math.max(1, Math.ceil((failure.cooldownUntil - Date.now()) / 60000));
      active.push(`recently failed helper cooling down ${remainingMinutes}m`);
    }
  }

  return Array.from(new Set(active)).join(', ');
}

class AutoRouterService {
  async classifyAndRoute(
    sessionId: string,
    message: string,
    options?: RouteOptions,
  ): Promise<RoutingDecision> {
    const routeOptions: RouteOptions = { ...options, sessionId };
    const config = getConfig();
    clearRecoveredCursorAuthCooldown(sessionId);
    inferHarnessFailuresFromMessages(sessionId, routeOptions.recentMessages);
    const storedPhase = getSessionPhase(sessionId);
    const inferredPhase = inferPhaseFromMessages(routeOptions.recentMessages);
    const phase = mergeSessionPhase(storedPhase, inferredPhase);
    sessionPhases.set(sessionId, phase);
    const signals = extractTaskSignals(message, routeOptions.attachmentCount || 0, routeOptions.attachmentTypes || []);
    const explicitWorkflowExecution = isExplicitMutatingWorkflowExecution(message)
      && canRunMutatingStages(routeOptions.permissionMode);
    let planningGate = explicitWorkflowExecution
      ? {
        action: 'none' as const,
        confidence: 1,
        reason: 'Explicit mutating workflow invocation must execute immediately',
        changeKind: 'general' as const,
      }
      : classifyPlanningGateHeuristic(message, signals, routeOptions);
    if (!config.prePlanEnabled) {
      planningGate = {
        action: 'none',
        confidence: 0,
        reason: 'Pre-build 80/20 scope passes are disabled in Auto Build settings',
        changeKind: planningGate.changeKind,
      };
    }

    // Step 1: Heuristic classification
    let requestedResult: HeuristicResult = explicitWorkflowExecution
      ? {
        tier: 'build',
        confidence: 1,
        reason: 'User explicitly invoked a mutating execution workflow',
      }
      : classifyHeuristic(message, routeOptions.gstackMode, routeOptions.permissionMode, phase);

    // Step 2: Apply workflow awareness
    let result = explicitWorkflowExecution
      ? requestedResult
      : applyWorkflowAwareness(requestedResult, phase, signals, message);
    result = enforcePermissionMode(result, routeOptions.permissionMode);
    const approvedPlanExecution = Boolean(
      routeOptions.approvedPlanContinuation
      && isApprovedPlanExecutionFollowup(message)
      && canRunMutatingStages(routeOptions.permissionMode)
    );
    if (approvedPlanExecution && result.tier !== 'build') {
      requestedResult = {
        tier: 'build',
        confidence: Math.max(requestedResult.confidence, 0.9),
        reason: `${requestedResult.reason}; approved plan follow-up means execute the plan`,
      };
      result = {
        tier: 'build',
        confidence: Math.max(result.confidence, 0.9),
        reason: `${result.reason}; approved plan follow-up means execute the plan`,
      };
    }

    const customCategories = customCategoriesForController(routeOptions);
    let customCategoryLead: ModelChoice | undefined;
    let customCategoryForPolicy: ResolvedAutoRouterCategory | undefined;

    let method: RoutingDecision['method'] = 'heuristic';
    let metaLead: ModelChoice | undefined;
    let metaOrchestration: OrchestrationPlan | undefined;
    const deterministicResult = result;
    const useDeterministicFastPath = shouldUseDeterministicFastPath(message, result, phase, signals, routeOptions);

    // Step 3: Let the Cerebras-backed controller classify the route. Execution
    // is still delegated through existing harnesses.
    if (
      !useDeterministicFastPath
      && !explicitWorkflowExecution
      && !routeOptions.skipMetaController
      && !routeOptions.prePlanActive
      && !routeOptions.prePlanForced
    ) {
      const cerebrasKey = getCerebrasKey();
      if (cerebrasKey) {
        const candidateModelsByTier = candidateModelsByTierForMeta(config, signals, routeOptions);
        const meta = await flueMetaRouterService.route({
          sessionId,
          message,
          domain: signals.domain,
          config,
          phase,
          heuristicTier: requestedResult.tier,
          workflowTier: result.tier,
          permissionMode: routeOptions.permissionMode,
          gstackMode: routeOptions.gstackMode,
          attachmentCount: routeOptions.attachmentCount || 0,
          attachmentTypes: routeOptions.attachmentTypes || [],
          candidateModelsByTier,
          customCategories,
          recentMessages: routeOptions.recentMessages,
          continuationHarness: routeOptions.continuationHarness,
          continuationModel: routeOptions.continuationModel,
          approvedPlanContinuation: routeOptions.approvedPlanContinuation,
          goalObjective: routeOptions.goalObjective,
          goalSource: routeOptions.goalSource,
          cerebrasKey,
        });

        if (meta && meta.confidence >= META_MIN_CONFIDENCE) {
          if (
            config.prePlanEnabled
            && !routeOptions.prePlanActive
            && !routeOptions.prePlanBypassed
            && !routeOptions.approvedPlanContinuation
          ) {
            const metaGateConfidence = typeof meta.planningGateConfidence === 'number'
              ? meta.planningGateConfidence
              : 0;
            const metaGateAction = meta.planningGateAction || 'none';
            planningGate = {
              action: metaGateConfidence >= 0.75 && metaGateAction === 'start'
                ? 'start'
                : metaGateConfidence >= 0.55 && metaGateAction !== 'none'
                  ? 'suggest'
                  : 'none',
              confidence: metaGateConfidence,
              reason: meta.planningGateReason
                ? redactMetaControllerTerms(meta.planningGateReason)
                : 'Controller did not request a pre-build 80/20 scope pass',
              changeKind: meta.planningGateChangeKind || 'general',
            };
          }
          const proposedRequestedResult: HeuristicResult = {
            tier: meta.requestedTier,
            confidence: meta.confidence,
            reason: redactMetaControllerTerms(meta.reason),
          };
          let proposedResult: HeuristicResult = {
            tier: meta.leadTier,
            confidence: meta.confidence,
            reason: redactMetaControllerTerms(meta.reason),
          };
          proposedResult = enforcePermissionMode(proposedResult, routeOptions.permissionMode);

          const rejectionReason = getMetaRouteRejectionReason(meta, proposedResult, deterministicResult, message);
          if (rejectionReason) {
            console.log(`[AutoRouter] Ignoring controller route: ${rejectionReason}`);
          } else {
            requestedResult = proposedRequestedResult;
            result = proposedResult;
            method = 'controller';
            metaLead = sanitizeMetaLead(
              { ...meta, leadTier: result.tier },
              config,
              signals,
              candidateModelsByTier,
              routeOptions,
            );
            customCategoryForPolicy = matchedCustomCategory(meta.matchedCategoryId, result.tier, customCategories);
            customCategoryLead = matchedCustomCategoryLead(meta.matchedCategoryId, result.tier, customCategories);
            if (customCategoryLead) {
              metaLead = customCategoryLead;
            }
            metaOrchestration = buildOrchestrationPlanFromMeta(
              { ...meta, leadTier: result.tier, leadModel: metaLead.model },
              metaLead,
              config,
              signals,
              phase,
              routeOptions,
              candidateModelsByTier,
            );
          }
        } else if (meta) {
          console.log(`[AutoRouter] Ignoring low-confidence controller route (${(meta.confidence * 100).toFixed(0)}%)`);
        }
      }
    }

    // The meta-controller may prefer continuity, but approval is a hard
    // planning→execution boundary. Reassert Build after controller routing and
    // let the configured Execution model resolve the new lead.
    if (approvedPlanExecution && result.tier !== 'build') {
      requestedResult = {
        tier: 'build',
        confidence: Math.max(requestedResult.confidence, 0.9),
        reason: `${requestedResult.reason}; approved plan is ready for execution`,
      };
      result = {
        tier: 'build',
        confidence: Math.max(result.confidence, 0.9),
        reason: `${result.reason}; approved plan is ready for execution`,
      };
      metaLead = undefined;
      metaOrchestration = undefined;
      customCategoryLead = undefined;
      customCategoryForPolicy = undefined;
      method = 'heuristic';
    }
    if (approvedPlanExecution) {
      planningGate = {
        action: 'none',
        confidence: 1,
        reason: 'Approved plan is already ready for execution',
        changeKind: planningGate.changeKind,
      };
    }

    // If a build request was staged through planning but no executable helper can
    // take the build handoff, keep the turn productive by routing directly to the
    // best available build model instead of producing a plan-only response.
    if (
      result.tier === 'plan' &&
      requestedResult.tier === 'build' &&
      canRunMutatingStages(routeOptions.permissionMode) &&
      !pickDelegateStageModel('build', config, signals, routeOptions)
    ) {
      result = {
        ...requestedResult,
        reason: `${requestedResult.reason}; no executable build delegate available, routing directly to Build tier`,
      };
      metaLead = undefined;
      metaOrchestration = undefined;
    }

    // An unambiguous user directive ("use codex", "switch to gemini") wins over
    // every other lead source — the clearest possible switch intent.
    const requestedHarness = explicitlyRequestedHarness(message);
    let explicitHarnessLead: ModelChoice | undefined;
    if (requestedHarness && requestedHarness !== 'custom') {
      const choice = chooseModelForExplicitHarness(result.tier, requestedHarness, config, signals, routeOptions);
      if (choice) {
        explicitHarnessLead = choice;
      } else {
        console.log(`[AutoRouter] ${sessionId}: user requested ${requestedHarness} but no usable model found; routing normally`);
      }
    }
    if (explicitHarnessLead) {
      metaLead = undefined;
      metaOrchestration = undefined;
      customCategoryLead = undefined;
      customCategoryForPolicy = undefined;
      console.log(`[AutoRouter] ${sessionId}: honoring explicit harness request for ${explicitHarnessLead.harness}`);
    }

    const continuationLead = !explicitHarnessLead && !metaLead && !customCategoryLead
      && shouldPreferContinuationHarness(message, result.tier, config, signals, routeOptions)
      ? chooseContinuationModelForTier(result.tier, config, routeOptions)
      : undefined;
    if (continuationLead) {
      console.log(
        `[AutoRouter] ${sessionId}: follow-up reusing ${continuationLead.harness} because it matches the configured ${result.tier} model`
      );
    }

    // Step 4: Resolve the lead harness/model and build an orchestration plan.
    // A high-confidence pre-build brake is authoritative over ordinary model
    // continuity and explicit execution-harness requests. The user can still
    // leave it deliberately through /build-now.
    const prePlanLead: ModelChoice | undefined = planningGate.action === 'start'
      ? {
        model: config.prePlanModel,
        harness: harnessFromModel(config.prePlanModel),
        reason: 'Selected the configured pre-build 80/20 model',
      }
      : undefined;
    if (prePlanLead) {
      result = {
        tier: 'plan',
        confidence: Math.max(result.confidence, planningGate.confidence),
        reason: `${result.reason}; pre-build 80/20 scope choice required`,
      };
      metaOrchestration = undefined;
    }
    const approvedExecutionLead: ModelChoice | undefined = approvedPlanExecution
      && hasConfiguredCredentialForModel(config.buildModel, { ...routeOptions, sessionId: undefined })
      ? {
        model: config.buildModel,
        harness: harnessFromModel(config.buildModel),
        reason: `Approved plan handoff uses the configured Execution model ${config.buildModel}`,
      }
      : undefined;
    const lead = prePlanLead || explicitHarnessLead || approvedExecutionLead || customCategoryLead || metaLead || continuationLead || chooseModelForTier(result.tier, config, signals, routeOptions);
    const resolvedModel = lead.model;
    const routePolicy = resolveRoutePolicy(result.tier, config, prePlanLead ? undefined : customCategoryForPolicy);
    const orchestration: OrchestrationPlan = prePlanLead
      ? {
        mode: 'single',
        leadHarness: prePlanLead.harness,
        leadModel: prePlanLead.model,
        stages: [{
          tier: 'plan',
          harness: prePlanLead.harness,
          model: prePlanLead.model,
          ...routePolicy,
          purpose: 'Run the pre-build 80/20 first-slice choice',
          required: true,
          trigger: 'now',
        }],
        contextPolicy: {
          includeTranscript: true,
          includeTranscriptReferences: true,
          includePlanFileReference: true,
          avoidBulkContextOnHandoff: true,
          maxHandoffConversationChars: 24000,
          includeProjectInstructions: true,
          includeSkills: true,
          includeAgents: true,
          includeMemories: true,
        },
        handoffPrompt: [
          'A lightweight pre-build 80/20 scope pass is active.',
          'Remain read-only except for design and plan artifacts.',
          'Do not run implementation or helper build stages before explicit plan approval.',
        ].join(' '),
      }
      : metaOrchestration || buildOrchestrationPlan(result.tier, requestedResult.tier, lead, config, signals, phase, routeOptions);
    if (orchestration.stages[0]) {
      orchestration.stages[0] = {
        ...orchestration.stages[0],
        ...routePolicy,
      };
    }
    const goalObjective = routeOptions.goalObjective?.trim();

    const cooldownSummary = formatActiveHarnessCooldowns(sessionId);
    const decision: RoutingDecision = {
      tier: result.tier,
      domain: signals.domain,
      resolvedModel,
      resolvedHarness: lead.harness,
      resolvedEffort: routePolicy.effort,
      resolvedSpeed: routePolicy.speed,
      workflow: routePolicy.workflow || orchestration.mode,
      budgetUsd: routePolicy.budgetUsd,
      verification: routePolicy.verification,
      confidence: result.confidence,
      reason: `${result.reason}${requestedResult.tier !== result.tier ? `; requested ${requestedResult.tier} continues through helper stages when available` : ''}; ${lead.reason}${cooldownSummary ? `; temporarily avoiding ${cooldownSummary}` : ''}`,
      method,
      enableGoals: result.tier === 'verify' || Boolean(goalObjective),
      planningGate,
      ...(goalObjective ? {
        goal: {
          objective: goalObjective,
          source: routeOptions.goalSource || 'slash-command',
        },
      } : {}),
      missionControl: {
        controllerHarness: 'meta',
        requestedTier: requestedResult.tier,
        leadTier: result.tier,
        leadHarness: lead.harness,
        leadModel: lead.model,
        ...(customCategoryForPolicy ? {
          categoryId: customCategoryForPolicy.id,
          categoryLabel: customCategoryForPolicy.label || customCategoryForPolicy.id,
        } : {}),
        ...routePolicy,
      },
      orchestration,
    };

    console.log(`[AutoRouter] ${sessionId}: ${result.tier.toUpperCase()}/${signals.domain} → ${lead.harness}:${resolvedModel} (${(result.confidence * 100).toFixed(0)}% confidence, ${method}, ${orchestration.mode})`);

    return decision;
  }

  getPhase(sessionId: string): SessionPhase {
    return getSessionPhase(sessionId);
  }

  getConfig(): AutoRouterConfig {
    return getConfig();
  }

  setConfig(config: Partial<AutoRouterConfig>): void {
    const settings = getSettingsObject();
    const current = getConfig();
    settings.autoRouterConfig = { ...current, ...config };
    settingsStore.set('settings', settings);
    settingsObjectCache = { expiresAt: Date.now() + 2_000, value: settings };
  }

  resetPhase(sessionId: string): void {
    sessionPhases.delete(sessionId);
    sessionHarnessFailures.delete(sessionId);
    sessionModelFailures.delete(sessionId);
  }

  recordTierCompletion(sessionId: string, tier: TaskTier): void {
    recordTierCompletion(sessionId, tier);
  }

  recordHarnessFailure(sessionId: string, harness: Harness, model?: string, error?: string): void {
    recordHarnessFailure(sessionId, harness, model, error);
  }

  recordHarnessSuccess(sessionId: string, harness: Harness, model?: string): void {
    recordHarnessSuccess(sessionId, harness, model);
  }
}

export const autoRouterService = new AutoRouterService();
