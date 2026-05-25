import type { TaskTier, TaskDomain, RoutingDecision, AutoRouterConfig, SessionPhase, Harness, OrchestrationPlan, OrchestrationStage, ChatMessage } from '../../shared/types';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';
import { analyticsService } from './analytics.service';
import Store from 'electron-store';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  planModel: 'claude-sonnet-4-6',
  buildModel: 'codex:gpt-5.5',
  verifyModel: 'codex:gpt-5.5',
  refineModel: 'cursor:composer-2.5',
  fallbackModel: 'claude-sonnet-4-6',
  costAware: true,
  costThresholdPercent: 80,
  useLlmClassifier: true,
  llmConfidenceThreshold: 0.7,
};

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
];

const BUILD_SIGNALS = [
  'implement', 'create', 'build', 'add feature', 'scaffold',
  'from the plan', 'execute the plan', 'write the code',
  'set up', 'integrate', 'develop', 'code this',
  'make a', 'make the', 'make it', 'add a new', 'add the',
  'improve', 'enhance', 'strengthen', 'tune', 'upgrade',
];

const VERIFY_SIGNALS = [
  'test', 'verify', 'qa', 'check', 'debug', 'why is this',
  'investigate', 'fix this bug', 'broken', 'failing',
  'not working', 'error', 'regression', 'diagnose',
  'what went wrong', 'stack trace',
];

const CAPABILITY_ESCALATION_SIGNALS = [
  'look harder', 'think harder', 'try harder', 'dig deeper',
  'go deeper', 'harder look', 'closer look', 'look closer',
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
}

interface RouteOptions extends ModelAvailabilityOptions {
  gstackMode?: string;
  permissionMode?: string;
  attachmentCount?: number;
  attachmentTypes?: string[];
  recentMessages?: ChatMessage[];
  skipLlmClassifier?: boolean;
}

function scoreSignals(message: string, signals: string[]): number {
  const lower = message.toLowerCase();
  let hits = 0;
  for (const signal of signals) {
    if (lower.includes(signal)) hits++;
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
    hasErrorLog: /\b(error|stack trace|exception|failed|failing|regression|crash|timeout|lint|typecheck|test failure)\b/.test(lower),
    hasAttachments: attachmentCount > 0,
    hasImageAttachments,
    hasDomAttachments,
    asksForImplementation: /\b(implement|create|build|add|write|wire|integrate|ship|make|improve|enhance|strengthen|tune|upgrade)\b/.test(lower),
    asksForVerification: /\b(test|verify|qa|check|validate|prove|confirm|audit)\b/.test(lower),
    asksForReview: /\b(review|critique|second opinion|risk|regression)\b/.test(lower),
    asksForArchitecture: /\b(plan|design|architect|approach|trade[- ]?off|strategy|proposal)\b/.test(lower),
    asksForMultiHarness: /\b(harness|model|multiplex|orchestrat|delegate|agents|codex|cursor|gemini|claude)\b/.test(lower),
    asksForCapabilityEscalation,
    asksForCopy,
    asksForFrontend,
    asksForBackend,
    likelyNeedsProjectContext: /\b(project|repo|codebase|session|transcript|claude\.md|agents?\.md|skills?|settings|mcp)\b/.test(lower),
  };
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

function binaryExistsInPath(binaryNames: string[], extraCandidates: string[]): boolean {
  for (const candidate of extraCandidates) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch {
      // Ignore invalid paths.
    }
  }

  for (const dir of (process.env.PATH || '').split(pathDelimiterSafe())) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      try {
        if (fs.existsSync(`${dir}/${binaryName}`)) return true;
      } catch {
        // Ignore invalid PATH entries.
      }
    }
  }

  return false;
}

function pathDelimiterSafe(): string {
  return process.platform === 'win32' ? ';' : ':';
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
  const binaryRel = path.join('vendor', targetTriple, 'codex', platform === 'win32' ? 'codex.exe' : 'codex');
  return [
    path.join(process.resourcesPath || '', 'node_modules', platformPkg, binaryRel),
    path.resolve(process.cwd(), 'node_modules', platformPkg, binaryRel),
    path.resolve(__dirname, '..', '..', 'node_modules', platformPkg, binaryRel),
  ];
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
  const candidates = [
    `${home}/.local/bin/cursor-agent`,
    `${home}/.cursor/bin/cursor-agent`,
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent',
    `${home}/.local/bin/agent`,
    `${home}/.cursor/bin/agent`,
    '/usr/local/bin/agent',
    '/opt/homebrew/bin/agent',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore invalid paths.
    }
  }

  for (const dir of (process.env.PATH || '').split(pathDelimiterSafe())) {
    if (!dir) continue;
    for (const binaryName of ['cursor-agent', 'agent']) {
      const candidate = path.join(dir, binaryName);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Ignore invalid PATH entries.
      }
    }
  }
  return null;
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
  if (!sessionId || !isCursorCliLoggedIn()) return;

  const harnessFailures = sessionHarnessFailures.get(sessionId);
  const harnessFailure = harnessFailures?.get('cursor');
  if (harnessFailure && isCursorAuthFailure(harnessFailure.lastError)) {
    harnessFailures?.delete('cursor');
    if (harnessFailures?.size === 0) sessionHarnessFailures.delete(sessionId);
  }

  const modelFailures = sessionModelFailures.get(sessionId);
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

  if (model.startsWith('cursor:')) {
    clearRecoveredCursorAuthCooldown(options?.sessionId);
  }

  if (isHarnessTemporarilyUnavailable(model, options)) {
    return false;
  }

  if (options?.isSSH && !hasRemoteCliForModel(model, options.remoteCliCapabilities)) {
    return false;
  }

  if (model.startsWith('codex:')) {
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

  if (capabilityEscalationScore > 0) {
    return {
      tier: 'plan',
      confidence: Math.min(0.95, 0.75 + capabilityEscalationScore * 0.2),
      reason: 'User asked for deeper reasoning or a stronger model',
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
  const copyStrategyRequest = signals.asksForCopy
    && (signals.large || signals.asksForArchitecture || /\b(research|strategy|positioning|website|landing page|pitch|value prop|messaging|plan)\b/.test(lower));

  if (heuristic.tier === 'refine' && copyStrategyRequest) {
    return {
      tier: 'plan',
      confidence: Math.max(0.72, heuristic.confidence),
      reason: 'Copy and positioning request needs planning before execution',
    };
  }

  // Build without prior plan → route to Plan first
  if (heuristic.tier === 'build' && !phase.hasPlanContext && !referencesExistingPlan && (heuristic.confidence >= 0.6 || signals.large)) {
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

function getConfig(): AutoRouterConfig {
  const settings = getSettingsObject();
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

function applyCostAwareDowngrade(
  tier: TaskTier,
  config: AutoRouterConfig,
): string {
  const configured = resolveModelForTier(tier, config);
  // Planning turns are frequent and usually do not need Opus. Keep the same
  // Claude harness, but use Sonnet when cost-aware routing is enabled.
  if (tier === 'plan' && /^claude-opus/i.test(configured)) {
    return 'claude-sonnet-4-6';
  }
  return configured;
}

function firstAvailable(candidates: string[], fallbackModel: string, options?: ModelAvailabilityOptions): string {
  for (const candidate of candidates) {
    if (hasConfiguredCredentialForModel(candidate, options)) return candidate;
  }
  return hasConfiguredCredentialForModel(fallbackModel, options) ? fallbackModel : 'claude-sonnet-4-6';
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

function researchPriorModelCandidates(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
): string[] {
  const candidates: string[] = [];
  const addFrontierClaude = () => candidates.push('claude-opus-4-7', 'claude-opus-4-6');

  if (signals.asksForCapabilityEscalation) {
    addFrontierClaude();
  }

  switch (tier) {
    case 'plan':
      if (needsFrontierReasoning(tier, signals)) {
        addFrontierClaude();
        candidates.push(config.planModel, 'claude-sonnet-4-6');
      }
      break;
    case 'build':
      candidates.push(config.buildModel, 'codex:gpt-5.5');
      if (signals.large || signals.asksForArchitecture || signals.asksForMultiHarness) {
        candidates.push('claude-opus-4-7');
      }
      break;
    case 'verify':
      candidates.push(config.verifyModel, 'codex:gpt-5.5');
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

  return Array.from(new Set(candidates.filter(Boolean)));
}

function domainModelCandidates(
  tier: TaskTier,
  config: AutoRouterConfig,
  signals: TaskSignals,
): string[] {
  const candidates: string[] = [];
  if (signals.domain === 'copy') {
    candidates.push('claude-sonnet-4-6');
    if (tier === 'build' || tier === 'refine') {
      candidates.push(config.refineModel, 'cursor:composer-2.5');
    }
  } else if (signals.domain === 'frontend') {
    candidates.push(config.refineModel, 'cursor:composer-2.5', config.buildModel);
  } else if (signals.domain === 'backend' || signals.domain === 'fullstack') {
    candidates.push(config.buildModel, config.verifyModel, 'codex:gpt-5.5');
  } else if (signals.domain === 'ops' || signals.domain === 'debug') {
    candidates.push(config.verifyModel, config.buildModel);
  }
  if (tier === 'plan') {
    candidates.unshift(config.planModel, 'claude-sonnet-4-6');
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
  const configuredHarness = harnessFromModel(configured);

  if (!signals.asksForCapabilityEscalation && configuredHarness !== 'claude') {
    return {
      model: configured,
      harness: configuredHarness,
      reason: `Configured ${tier} model is user-selected; using ${configured} without silent fallback`,
    };
  }

  const candidates = candidateModelsForTier(tier, config, signals, options);
  const priorCandidates = researchPriorModelCandidates(tier, config, signals);
  if (signals.asksForCapabilityEscalation) {
    candidates.unshift('claude-opus-4-7', 'claude-opus-4-6', config.planModel, config.fallbackModel);
  }
  if (signals.hasImageAttachments) {
    candidates.unshift(...configuredModelsForTier(tier, config).filter((model) => harnessFromModel(model) === 'claude' || harnessFromModel(model) === 'codex'));
  }
  if ((signals.needsBrowser || signals.hasAttachments) && tier !== 'verify') {
    candidates.unshift(...configuredModelsForTier(tier, config).filter((model) => harnessFromModel(model) === 'claude'));
  }
  if (signals.asksForMultiHarness && signals.large) {
    candidates.unshift(...configuredModelsForTier(tier, config).filter((model) => harnessFromModel(model) === 'claude'));
  }
  if (configured !== resolveModelForTier(tier, config) && priorCandidates.length === 0 && !signals.asksForCapabilityEscalation) {
    candidates.unshift(configured);
  }
  const chosen = firstAvailable(candidates, config.fallbackModel, options);
  const harness = harnessFromModel(chosen);
  const usedResearchPrior = priorCandidates.includes(chosen) && chosen !== configured;
  const reason = signals.asksForCapabilityEscalation && chosen.includes('opus')
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
): string {
  const stageLines = stages
    .map((stage, index) => `${index + 1}. ${stage.tier.toUpperCase()} via ${stage.harness}:${stage.model} - ${stage.purpose}${stage.required ? '' : ' (optional)'}`)
    .join('\n');

  const extraGuidance = [
    leadTier === 'plan' && stages.some((stage) => stage.trigger === 'after-plan')
      ? '- Lead Claude stage: stop at the plan. Do not edit files, run mutating commands, or continue into execution; Auto Build will start the execution stage after this message completes.'
      : '',
    signals.needsBrowser ? '- Browser/UI work: use browser or screenshot tools for verification when available.' : '',
    signals.likelyNeedsProjectContext ? '- Project context matters: follow injected CLAUDE.md, AGENTS.md, agents, and skills as if native to this harness.' : '',
    signals.hasErrorLog ? '- Failure/debugging work: reproduce or inspect the failure before changing code, then verify the fix.' : '',
    signals.asksForMultiHarness ? '- The user asked for harness/model orchestration: delegate deliberately and summarize any handoffs.' : '',
    ...leadDuties.map((duty) => `- ${duty}`),
  ].filter(Boolean).join('\n');

  return [
    'Auto Build Ultra selected an orchestration plan for this turn.',
    'Operate as one seamless Build agent even if the underlying harness changes.',
    requestedTier !== leadTier ? `The user asked for ${requestedTier.toUpperCase()} work; ${leadTier.toUpperCase()} is the lead stage for workflow sequencing.` : '',
    '',
    stageLines,
    extraGuidance ? `\nAdditional routing guidance:\n${extraGuidance}` : '',
    '',
    'When you are the lead Claude harness and the plan includes a Codex verification or second-opinion stage, use CodexSecondOpinion at the natural decision point instead of asking the user to choose a model.',
    'When you are Codex, Cursor, Gemini, or another CLI harness, treat the injected transcript, project instructions, agents, and skills as your own current context.',
  ].filter(Boolean).join('\n');
}

function buildOrchestrationPlan(
  leadTier: TaskTier,
  requestedTier: TaskTier,
  lead: ModelChoice,
  config: AutoRouterConfig,
  signals: TaskSignals,
  phase: SessionPhase,
  options?: ModelAvailabilityOptions & { permissionMode?: string },
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
      fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
      purpose,
      trigger,
      required,
    });
  };

  const canMutate = canRunMutatingStages(options?.permissionMode);
  const requestedVerification = requestedTier === 'verify' || signals.asksForVerification || signals.hasErrorLog;
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
          addStage('verify', verifyDelegate, 'Run the requested checks after implementation', 'after-build', true);
        }
      }
    }
  }

  if (leadTier === 'plan' && requestedTier === 'verify') {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested verification after the lead plan', 'after-plan', true);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead stage must cover the requested verification itself.');
    }
  }

  if (leadTier === 'plan' && !requestedBuildAfterLeadPlan && requestedVerification) {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested verification after the lead plan', 'after-plan', true);
    } else {
      leadDuties.push('No executable verification delegate is available; the lead stage should cover the requested verification itself.');
    }
  }

  if (leadTier === 'build' && requestedVerification) {
    const verifyDelegate = pickDelegateStageModel('verify', config, signals, options, lead.model);
    if (verifyDelegate) {
      addStage('verify', verifyDelegate, 'Run the requested checks after the build', 'after-build', true);
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
      addStage('verify', verifyDelegate, 'Run the requested checks after refinement', 'after-build', true);
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
      includeProjectInstructions: true,
      includeSkills: true,
      includeAgents: true,
      includeMemories: true,
    },
    handoffPrompt: buildOrchestrationHandoff(leadTier, requestedTier, signals, uniqueStages, leadDuties),
  };
}

async function classifyWithLlm(
  message: string,
  cerebrasKey: string,
): Promise<{ tier: TaskTier; confidence: number; reason: string } | null> {
  // Cerebras gpt-oss-120b: 92.5% accuracy, 216ms p50, ~free
  // Benchmarked against Haiku 4.5 and GPT-4o-mini — clear winner
  try {
    const prompt = `You are the Auto Build router for an AI developer tool. Classify the user's latest developer query by intended work mode, not by surface keywords. Reply ONLY with compact JSON: {"tier":"plan"|"build"|"verify"|"refine","confidence":0.0-1.0,"reason":"..."}

Routing tiers:
- plan: deeper reasoning before action. Use for architecture/design, tradeoffs, approach questions, code review, second opinions, ambiguous/high-risk requests, requests to "look harder", "think harder", "dig deeper", "be more careful", or use a stronger/more powerful/smarter model.
- build: create or modify code/files. Use for implementation, wiring, scaffolding, "do it", "build it", "ship it", "execute the plan", or clear requested edits that are not just cosmetic.
- verify: inspect whether something works. Use for tests, QA, CI, debugging, regressions, failures, stack traces, "why is this broken", reproduction, investigation, validation, and requests to check correctness.
- refine: small local tweaks. Use for copy edits, rename, formatting, cosmetic UI/style adjustments, typo fixes, tiny wording changes, or low-risk follow-up edits.

Disambiguation rules:
1. If the user asks for more reasoning/care/model strength ("look harder", "think deeper", "use Opus", "stronger model"), choose plan with high confidence. This is not refine even if short.
2. If the user says "ok", "go ahead", "do it", or "build it" after a plan, choose build.
3. If the query contains an error/failure and asks what happened, choose verify. If it asks to implement the fix after diagnosis, choose build.
4. If the task is a one-line cosmetic/local change, choose refine unless it asks for broader design reasoning.
5. When uncertain between plan and build for a complex task, choose plan. When uncertain between verify and build for a failure, choose verify.

Confidence:
- 0.90-1.00: explicit mode signal.
- 0.70-0.89: clear implied intent.
- 0.50-0.69: mixed or ambiguous.
- below 0.50: weak evidence.

Examples:
User: "look harder at this problem" -> {"tier":"plan","confidence":0.95,"reason":"Explicit deeper reasoning/model-strength request"}
User: "implement the auth flow from the plan" -> {"tier":"build","confidence":0.92,"reason":"Explicit implementation request"}
User: "tests are failing, figure out why" -> {"tier":"verify","confidence":0.9,"reason":"Failure investigation request"}
User: "make the button text shorter" -> {"tier":"refine","confidence":0.86,"reason":"Small copy tweak"}

Query: ${JSON.stringify(message.slice(0, 1200))}`;

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

  const completedLeadMatch = content.match(/Completed lead tier:\s*(plan|build|verify|refine)\b/i);
  addTier(completedLeadMatch?.[1]);

  const helperOutputIndex = content.indexOf('Helper output:');
  const helperOnlyContent = content.includes('<auto_build_turn_result>')
    ? helperOutputIndex === -1 ? '' : content.slice(helperOutputIndex)
    : content;

  for (const match of helperOnlyContent.matchAll(/Auto Build\s+(PLAN|BUILD|VERIFY|REFINE)\b/gi)) {
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
    for (const [harness, failure] of failures) {
      if (failure.cooldownUntil <= Date.now()) continue;
      const remainingMinutes = Math.max(1, Math.ceil((failure.cooldownUntil - Date.now()) / 60000));
      active.push(`${harness}${failure.model ? ` (${failure.model})` : ''} cooling down ${remainingMinutes}m`);
    }
  }

  const modelFailures = sessionModelFailures.get(sessionId);
  if (modelFailures) {
    for (const [model, failure] of modelFailures) {
      if (failure.cooldownUntil <= Date.now()) continue;
      const remainingMinutes = Math.max(1, Math.ceil((failure.cooldownUntil - Date.now()) / 60000));
      active.push(`${model} cooling down ${remainingMinutes}m`);
    }
  }

  return active.join(', ');
}

class AutoRouterService {
  async classifyAndRoute(
    sessionId: string,
    message: string,
    options?: RouteOptions,
  ): Promise<RoutingDecision> {
    const routeOptions: RouteOptions = { ...options, sessionId };
    const config = getConfig();
    inferHarnessFailuresFromMessages(sessionId, routeOptions.recentMessages);
    const storedPhase = getSessionPhase(sessionId);
    const inferredPhase = inferPhaseFromMessages(routeOptions.recentMessages);
    const phase = mergeSessionPhase(storedPhase, inferredPhase);
    sessionPhases.set(sessionId, phase);
    const signals = extractTaskSignals(message, routeOptions.attachmentCount || 0, routeOptions.attachmentTypes || []);

    // Step 1: Heuristic classification
    let requestedResult = classifyHeuristic(message, routeOptions.gstackMode, routeOptions.permissionMode, phase);

    // Step 2: Apply workflow awareness
    let result = applyWorkflowAwareness(requestedResult, phase, signals, message);

    let method: 'heuristic' | 'llm' = 'heuristic';

    // Step 3: If heuristic confidence is low, try LLM classifier
    if (result.confidence < config.llmConfidenceThreshold && config.useLlmClassifier && !routeOptions.skipLlmClassifier) {
      const settings = getSettingsObject();
      const cerebrasKey = (settings.cerebrasApiKey as string) || EMBEDDED_KEYS.cerebras || process.env.CEREBRAS_API_KEY || '';
      if (cerebrasKey) {
        const llmResult = await classifyWithLlm(message, cerebrasKey);
        if (llmResult && llmResult.confidence > result.confidence) {
          requestedResult = llmResult;
          method = 'llm';
          // Re-apply workflow awareness to LLM result
          result = applyWorkflowAwareness(requestedResult, phase, signals, message);
        }
      }
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
    }

    // Step 4: Resolve the lead harness/model and build an orchestration plan.
    const lead = chooseModelForTier(result.tier, config, signals, routeOptions);
    const resolvedModel = lead.model;
    const orchestration = buildOrchestrationPlan(result.tier, requestedResult.tier, lead, config, signals, phase, routeOptions);

    const cooldownSummary = formatActiveHarnessCooldowns(sessionId);
    const decision: RoutingDecision = {
      tier: result.tier,
      domain: signals.domain,
      resolvedModel,
      resolvedHarness: lead.harness,
      confidence: result.confidence,
      reason: `${result.reason}${requestedResult.tier !== result.tier ? `; requested ${requestedResult.tier} continues through helper stages when available` : ''}; ${lead.reason}${cooldownSummary ? `; temporarily avoiding ${cooldownSummary}` : ''}`,
      method,
      enableGoals: result.tier === 'verify',
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
