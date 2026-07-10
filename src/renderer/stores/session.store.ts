import { create } from 'zustand';
import type { Session, ChatMessage, ToolCall, ContentBlock, PermissionRequest, PermissionResponse, QuestionRequest, QuestionResponse, SetupProgressEvent, CompactionStatus, PlanApprovalRequest, PlanApprovalResponse, GStackMode, Harness, TaskTier } from '../../shared/types';
import { AGENT_COLORS } from '../../shared/types';
import { normalizeToolCall } from '../../shared/utils/tool-call-transformer';
import { contentBlockSignature, filterInternalPromptEchoes, hasRecoverableOutput, isCloseContentDuplicate, isCloseTimelineDuplicate, isExactLongAssistantDuplicate, isInterruptedSafetyNetDuplicate, isPrefixAssistantDuplicate, toolSignature } from '../../shared/utils/message-recovery';
import { buildCompletedStreamMessage } from '../../shared/utils/stream-finalization';
import { extractContentBlockText, stringifyToolResultForDisplay } from '../../shared/utils/content-block-text';
import { useAudioStore } from './audio.store';
import { getSessionDisplayName } from '../utils/session-display';

// Check if running in Electron environment
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;
const noop = () => undefined;
const MAX_LIVE_THINKING_CHARS = 20_000;
const MAX_LIVE_MONITOR_EVENT_CHARS = 4_000;
const MAX_LIVE_TOOL_RESULT_STREAM_CHARS = 12_000;
const MAX_MONITOR_EVENTS = 80;
const TOOL_EVENT_DEBUG_STORAGE_KEY = 'grep-debug-tool-events';

function capTextMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = maxChars - headChars;
  return [
    text.slice(0, headChars),
    `\n\n... truncated ${text.length - maxChars} chars for live UI ...\n\n`,
    text.slice(-tailChars),
  ].join('');
}

function capTextTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[older thinking truncated]\n${text.slice(-maxChars)}`;
}

function capLiveMonitorText(text: string): string {
  return capTextMiddle(text, MAX_LIVE_MONITOR_EVENT_CHARS);
}

function isToolEventDebugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TOOL_EVENT_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function logToolEvent(kind: string, toolCall?: ToolCall): void {
  if (!isToolEventDebugEnabled() || !toolCall) return;
  let inputPreview = '';
  try {
    inputPreview = capTextMiddle(JSON.stringify(toolCall.input || {}), 500);
  } catch {
    inputPreview = '[unserializable input]';
  }
  console.debug(`[SessionStore] ${kind}:`, toolCall.name, 'id:', toolCall.id, 'input:', inputPreview);
}

function collectSessionHtmlRenderModes(sessions: Session[]): Record<string, 'md' | 'html'> {
  const modes: Record<string, 'md' | 'html'> = {};
  for (const session of sessions) {
    if (session.htmlRenderMode === 'md' || session.htmlRenderMode === 'html') {
      modes[session.id] = session.htmlRenderMode;
    }
  }
  return modes;
}

export function isSessionNotFoundError(error: unknown, sessionId: string): boolean {
  const message = String((error as { message?: string } | undefined)?.message || error || '');
  return message.includes(`Session ${sessionId} not found`);
}

export async function withMaterializedSession<T>(
  sessionId: string,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!hasElectronAPI || !isSessionNotFoundError(error, sessionId)) {
      throw error;
    }

    await window.electronAPI.sessions.update(sessionId, {});
    return action();
  }
}

interface SystemInfo {
  tools: string[];
  model: string;
}

// Permission modes from Claude Agent SDK
export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

const ALL_PERMISSION_MODES: PermissionMode[] = ['auto', 'acceptEdits', 'default', 'bypassPermissions', 'plan', 'dontAsk'];
const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';
const CODEX_PERMISSION_MODES: PermissionMode[] = ALL_PERMISSION_MODES.filter(
  (mode): mode is PermissionMode => mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan',
);
const SUPPLEMENTAL_MESSAGES_STORAGE_PREFIX = 'grep-supplemental-messages-';
const AUTO_BUILD_SECTION_MARKERS = ['\n\n---\n\nFollow-up ', '\n\n---\n\nAuto Build '];
const UNANSWERED_DUPLICATE_USER_PROMPT_WINDOW_MS = 30_000;
const queueDrainSuppressedUntil: Record<string, number> = {};
const messageLoadGenerations = new Map<string, number>();
const consumedQueueMessageIds = new Map<string, Set<string>>();
const DEBUG_SESSION_SEND = false;
type HarnessSelectionTrigger = 'model-picker' | 'plan-nudge' | 'compaction-handoff' | 'api' | 'other';

function hasSameSessionListIdentity(current: Session[], next: Session[]): boolean {
  if (current.length !== next.length) return false;
  for (let i = 0; i < current.length; i++) {
    const a = current[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.updatedAt !== b.updatedAt ||
      a.branch !== b.branch ||
      a.name !== b.name ||
      a.manualName !== b.manualName ||
      a.manuallyRenamedAt !== b.manuallyRenamedAt ||
      a.forkName !== b.forkName ||
      a.aiGeneratedName !== b.aiGeneratedName ||
      a.lastBrowserUrl !== b.lastBrowserUrl
    ) {
      return false;
    }
  }
  return true;
}

type AutoRouteDecisionState = {
  tier: string;
  domain?: string;
  resolvedModel: string;
  resolvedHarness?: string;
  resolvedEffort?: string;
  resolvedSpeed?: string;
  workflow?: string;
  budgetUsd?: number;
  verification?: string;
  confidence: number;
  reason: string;
  method: string;
  goal?: {
    objective: string;
    source: 'slash-command' | 'ralph-loop';
  };
  orchestration?: {
    mode: string;
    leadHarness: string;
    leadModel: string;
    stages: Array<{ tier: string; harness: string; model: string; purpose: string; effort?: string; speed?: string; workflow?: string; budgetUsd?: number; verification?: string; fallbackModels?: string[]; required?: boolean; trigger?: string }>;
  };
};

type MetaGoalState = {
  objective: string;
  source: 'slash-command' | 'ralph-loop';
  status: 'active' | 'complete' | 'blocked';
  iterations: number;
  maxIterations: number;
  updatedAt: number;
};

const META_GOAL_MAX_ITERATIONS = 20;
const suppressQueueDrain = (sessionId: string, ms = 3000) => {
  queueDrainSuppressedUntil[sessionId] = Date.now() + ms;
};

const isQueueDrainSuppressed = (sessionId: string) => {
  return Date.now() < (queueDrainSuppressedUntil[sessionId] || 0);
};

function markQueueMessagesConsumed(sessionId: string, messageIds: string[]): void {
  const ids = messageIds.filter(Boolean);
  if (ids.length === 0) return;
  const existing = consumedQueueMessageIds.get(sessionId) || new Set<string>();
  for (const id of ids) existing.add(id);
  consumedQueueMessageIds.set(sessionId, existing);
  console.log(`[SessionStore] Marked ${ids.length} queued message id(s) consumed for hydration guard`);
}

function isConsumedQueueMessage(sessionId: string, message: ChatMessage): boolean {
  return message.role === 'user' && Boolean(consumedQueueMessageIds.get(sessionId)?.has(message.id));
}

function parseGoalSlashCommand(message: string): string | undefined {
  const match = message.match(/^\/goal(?:\s+([\s\S]*))?$/i);
  return match?.[1]?.trim() || undefined;
}

function goalCompletionStatus(content: string): 'complete' | 'blocked' | undefined {
  if (/<goal>\s*COMPLETE\s*<\/goal>|<promise>\s*COMPLETE\s*<\/promise>|goal completed|objective completed/i.test(content)) {
    return 'complete';
  }
  if (/<goal>\s*BLOCKED\s*<\/goal>|goal blocked|objective blocked|cannot make meaningful progress/i.test(content)) {
    return 'blocked';
  }
  return undefined;
}

function isFatalMetaGoalTurnFailure(message: ChatMessage, content: string): boolean {
  const trimmed = content.trim();
  if (message.interrupted) return true;
  return /^Error:/i.test(trimmed)
    || /Remote Claude process exited unexpectedly|Claude Code process exited|process exited with code|process terminated|no stdout|authentication|api key|rate limit|quota/i.test(trimmed);
}

function blockMetaGoalState(
  activeMetaGoals: Record<string, MetaGoalState | null>,
  sessionId: string,
): Record<string, MetaGoalState | null> {
  const activeGoal = activeMetaGoals[sessionId];
  if (activeGoal?.status !== 'active') return activeMetaGoals;
  return {
    ...activeMetaGoals,
    [sessionId]: {
      ...activeGoal,
      status: 'blocked',
      updatedAt: Date.now(),
    },
  };
}

function buildMetaGoalContinuationPrompt(goal: MetaGoalState): string {
  return `/goal ${goal.objective}`;
}

// Effort levels: maps to Claude API's effort parameter
// low = fast/efficient, medium = balanced, high = full capability (default), max = maximum (Opus only)
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Legacy: Keep ThinkingMode as alias for backward compatibility during migration
export type ThinkingMode = EffortLevel | 'off' | 'thinking' | 'ultrathink';

// Migration helper: convert old thinking modes to new effort levels
export const migrateThinkingMode = (mode: string | undefined): EffortLevel => {
  switch (mode) {
    case 'off': return 'low';
    case 'thinking': return 'medium';
    case 'ultrathink': return 'high';
    // New values pass through:
    case 'low': case 'medium': case 'high': case 'xhigh': case 'max': return mode as EffortLevel;
    default: return 'high'; // Default to high (full capability)
  }
};

// Background task for backgrounded Bash commands
export interface BackgroundTask {
  id: string;              // Tool call ID
  sessionId: string;       // Parent session
  command: string;         // The bash command
  outputFile?: string;     // Path from SDK result
  output: string;          // Accumulated output
  status: 'running' | 'completed' | 'error';
  startedAt: Date;
  completedAt?: Date;
}

// Chronological event for rendering in order
export interface StreamEvent {
  id: string;
  type: 'thinking' | 'tool' | 'text';
  timestamp: number;
  content?: string;
  toolCall?: ToolCall;
  agentId?: string; // parent_tool_use_id from SDK (null/undefined = lead agent)
}

// Model info type
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

export interface CompactionSwitchState {
  status: 'compacting' | 'complete';
  originalModel: string;
  fallbackModel?: string;
  recommendedModel?: string;
  autoSwitched: boolean;
  handoffSelected?: boolean;
  handoffModel?: string;
  startedAt: number;
  completedAt?: number;
  preTokens?: number;
  postTokens?: number;
}

// Streaming watchdog was removed — it fired too aggressively during long
// compactions, long tool runs, and slow SSH handshakes, cancelling live
// backend queries and causing sessions to mysteriously "stop". The backend's
// own error/exit events drive isStreaming state; if the UI feels stuck, the
// interrupt button is the user's direct control.

interface SessionState {
  sessions: Session[];
  activeSessionId: string | null;
  isLoadingSessions: boolean;
  messages: Record<string, ChatMessage[]>;
  isLoadingMessages: Record<string, boolean>;
  isStreaming: Record<string, boolean>;
  sessionActivity: Record<string, 'active' | 'waiting' | 'idle'>; // Activity state per session
  isProcessingQueue: Record<string, boolean>; // True during queue drain window to prevent race
  streamGeneration: Record<string, number>; // Incremented on interrupt/send to detect stale STREAM_END events
  streamStartTime: Record<string, number>; // Timestamp when current stream started — guards against stale events
  streamEvents: Record<string, StreamEvent[]>; // Chronological events
  currentStreamContent: Record<string, string>;
  currentThinkingContent: Record<string, string>;
  currentToolCalls: Record<string, ToolCall[]>;
  currentSystemInfo: Record<string, SystemInfo | null>;
  // Monitor tool instances per session (streaming background watches)
  monitorInstances: Record<string, Array<{
    id: string;
    aliases?: string[];
    description: string;
    events: Array<{ id: string; text: string; timestamp: number }>;
    active: boolean;
    kind?: 'monitor' | 'subagent';
    persistent?: boolean;
    startedAt: number;
  }>>;
  activeStreamModel: Record<string, string | undefined>;
  activeUserPrompt: Record<string, {
    id: string;
    message: string;
    attachments?: unknown[];
    timestamp: number;
    model?: string;
    suppressUserMessage?: boolean;
  } | null>;
  permissionMode: Record<string, PermissionMode>;
  thinkingMode: Record<string, ThinkingMode>;
  htmlRenderMode: Record<string, 'md' | 'html'>;
  selectedModel: Record<string, string>;
  availableModels: ModelInfo[];
  pendingPermission: Record<string, PermissionRequest | null>;
  pendingQuestion: Record<string, QuestionRequest | null>;
  pendingPlanApproval: Record<string, PlanApprovalRequest | null>;
  setupProgress: Record<string, SetupProgressEvent | null>;
  compactionStatus: Record<string, CompactionStatus | null>;
  compactionSwitch: Record<string, CompactionSwitchState | null>;
  contextUsage: Record<string, { inputTokens: number; contextWindowSize: number; percentage: number } | null>;
  messageQueue: Record<string, Array<{
    id: string;
    message: string;
    attachments?: unknown[];
    timestamp: number;
    suppressUserMessage?: boolean;
  }>>;
  backgroundTasks: Record<string, BackgroundTask[]>;
  // Secure keys tracking - API keys/tokens detected and secured
  securedKeys: Record<string, Array<{ id: string; type: string; description: string }>>;
  // Agent teams tracking — maps agentId to assigned colour index per session
  agentColorMap: Record<string, Record<string, number>>; // sessionId -> { agentId -> colorIndex }
  // GStack workflow mode per session
  gstackMode: Record<string, GStackMode | null>;
  // Global fast mode — when on, harnesses that support fast output use it
  fastMode: boolean;
  // Auto Build routing decisions per session
  autoRouteDecision: Record<string, AutoRouteDecisionState | null>;
  activeMetaGoals: Record<string, MetaGoalState | null>;

  // Codex (second opinion) state
  codexStreaming: Record<string, boolean>;
  codexContent: Record<string, string>;
  codexThinking: Record<string, string>;
  codexToolCalls: Record<string, ToolCall[]>;
  codexError: Record<string, string | null>;
  codexPrompt: Record<string, string>;

  // Ephemeral /btw side question state
  btw: Record<string, { question: string; response: string; isStreaming: boolean } | null>;
  // Remote control session state
  remoteControl: Record<string, { url: string; startedAt: Date } | null>;

  // Command Center — ordered list of sessions shown in the grid
  commandCenterSessionIds: string[];

  // Conversation fork tracking
  activeForkGroup: string | null; // Root session ID when viewing a fork group
  visibleForkIds: Record<string, string[]>; // rootId → array of visible fork IDs
  activeForkIndex: Record<string, number>; // rootId → selected tab index

  setActiveSession: (sessionId: string | null) => void;
  addSession: (session: Session) => void;
  loadSessions: () => Promise<void>;
  createSession: (config: {
    name: string;
    repoUrl: string;
    branch: string;
    setupScript?: string;
  }) => Promise<Session>;
  startSession: (sessionId: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  updateSession: (sessionId: string, updates: Partial<Session>) => Promise<void>;
  refreshSessionBranch: (sessionId: string) => Promise<string | null>;
  subscribeToSessionChanges: () => () => void;

  // Chat
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateStreamContent: (sessionId: string, content: string, agentId?: string) => void;
  updateThinkingContent: (sessionId: string, content: string) => void;
  addToolCall: (sessionId: string, toolCall: ToolCall) => void;
  getAgentColor: (sessionId: string, agentId: string) => string;
  updateToolCall: (sessionId: string, toolCallId: string, updates: Partial<ToolCall>) => void;
  setStreaming: (sessionId: string, isStreaming: boolean) => void;
  setSystemInfo: (sessionId: string, systemInfo: SystemInfo | null) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  cyclePermissionMode: (sessionId: string) => void;
  setThinkingMode: (sessionId: string, mode: ThinkingMode) => void;
  cycleThinkingMode: (sessionId: string) => void;
  setHtmlRenderMode: (sessionId: string, mode: 'md' | 'html') => void;
  cycleHtmlRenderMode: (sessionId: string) => void;
  setFastMode: (enabled: boolean) => void;
  toggleFastMode: () => void;
  setSelectedModel: (sessionId: string, model: string, trigger?: HarnessSelectionTrigger) => void;
  loadAvailableModels: () => Promise<void>;
  sendMessage: (sessionId: string, message: string, attachments?: unknown[], opts?: { existingMessageId?: string; suppressUserMessage?: boolean; fromQueueDrain?: boolean }) => Promise<void>;
  loadMessages: (sessionId: string, options?: LoadMessagesOptions) => Promise<void>;
  subscribeToClaude: () => () => void;
  // Permission handling
  setPendingPermission: (sessionId: string, request: PermissionRequest | null) => void;
  approvePermission: (sessionId: string, modifiedInput?: Record<string, unknown>, alwaysApprove?: boolean) => Promise<void>;
  approvePermissionAsBackground: (sessionId: string) => Promise<boolean>;
  denyPermission: (sessionId: string) => Promise<void>;
  // Question handling
  setPendingQuestion: (sessionId: string, request: QuestionRequest | null) => void;
  answerQuestion: (sessionId: string, answers: Record<string, string>) => Promise<void>;
  cancelQuestion: (sessionId: string) => Promise<void>;
  // Plan approval handling
  setPendingPlanApproval: (sessionId: string, request: PlanApprovalRequest | null) => void;
  approvePlan: (sessionId: string) => Promise<void>;
  rejectPlan: (sessionId: string, feedback?: string) => Promise<void>;
  // Queue management
  removeFromQueue: (sessionId: string, messageId: string) => void;
  editQueuedMessage: (sessionId: string, messageId: string, newMessage: string) => void;
  moveToFront: (sessionId: string, messageId: string) => void;
  clearQueue: (sessionId: string) => void;
  interruptAndSend: (sessionId: string, message: string, attachments?: unknown[]) => Promise<void>;
  cancelStream: (sessionId: string) => void;
  // Setup progress
  setSetupProgress: (sessionId: string, progress: SetupProgressEvent | null) => void;
  subscribeToSetupProgress: () => () => void;
  // Background tasks
  addBackgroundTask: (sessionId: string, task: BackgroundTask) => void;
  updateBackgroundTask: (sessionId: string, taskId: string, updates: Partial<BackgroundTask>) => void;
  removeBackgroundTask: (sessionId: string, taskId: string) => void;
  subscribeToBackgroundTasks: () => () => void;
  // Compaction status (Smart Compact feature)
  setCompactionStatus: (sessionId: string, status: CompactionStatus | null) => void;
  dismissCompactionSwitch: (sessionId: string) => void;
  handoffCompactionModel: (sessionId: string, model: string) => void;
  restoreCompactionModel: (sessionId: string) => void;
  subscribeToCompaction: () => () => void;
  // Auto-resume for Build It mode
  saveAutoResumeState: (sessionId: string) => Promise<void>;
  clearAutoResumeState: () => Promise<void>;
  checkAndAutoResume: () => Promise<void>;
  setupAutoResumeOnClose: () => () => void;
  // Rewind and fork
  rewindAndFork: (messageId: string) => Promise<void>;
  // Conversation fork management
  createForkFromCurrent: (userMessage: string) => Promise<void>;
  getForkSiblings: (sessionId: string) => Session[];
  getProjectSessions: (sessionId: string) => Session[];
  cycleForkTabs: (direction: 'next' | 'prev') => void;
  // Command Center management
  addToCommandCenter: (sessionId: string) => void;
  removeFromCommandCenter: (sessionId: string) => void;
  initCommandCenterFromStarred: () => void;

  // GStack workflow mode
  setGStackMode: (sessionId: string, mode: GStackMode | null) => void;
  // Codex (second opinion)
  startCodexRun: (sessionId: string, prompt: string) => Promise<void>;
  cancelCodexRun: (sessionId: string) => void;
  dismissCodex: (sessionId: string) => void;
  subscribeToCodex: () => () => void;

  // Ephemeral /btw side question
  askBtw: (sessionId: string, question: string) => Promise<void>;
  dismissBtw: (sessionId: string) => void;
  subscribeToBtw: () => () => void;
  // Remote control
  startRemoteControl: (sessionId: string) => Promise<void>;
  stopRemoteControl: (sessionId: string) => void;
  setRemoteControl: (sessionId: string, url: string) => void;
  clearRemoteControl: (sessionId: string) => void;
  subscribeToRemoteControl: () => () => void;
}

type MonitorEntry = SessionState['monitorInstances'][string][number];

function findMonitorIndex(monitors: MonitorEntry[], taskId?: string, toolUseId?: string): number {
  const ids = [taskId, toolUseId].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return -1;
  return monitors.findIndex((monitor) => (
    ids.includes(monitor.id) || monitor.aliases?.some((alias) => ids.includes(alias))
  ));
}

function makeMonitorEvent(prefix: string, text: string) {
  return {
    id: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: capLiveMonitorText(text),
    timestamp: Date.now(),
  };
}

function appendMonitorEvent(events: MonitorEntry['events'], event: MonitorEntry['events'][number]): MonitorEntry['events'] {
  return [...(events || []), event].slice(-MAX_MONITOR_EVENTS);
}

function taskStatusText(status?: string): string | undefined {
  if (!status) return undefined;
  if (status === 'running') return 'Running...';
  if (status === 'pending') return 'Pending...';
  if (status === 'paused') return 'Paused';
  return `Status: ${status}`;
}

function compactMonitorText(text: string, maxLength = 160): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}...` : compacted;
}

function asyncAgentDescription(toolCall: ToolCall): string {
  const input = (toolCall.input || {}) as {
    subagent_type?: string;
    prompt?: string;
    description?: string;
    task?: string;
    summary?: string;
  };
  const taskText = input.description || input.task || input.summary || compactMonitorText(input.prompt || '', 90);
  return input.subagent_type
    ? `${input.subagent_type}: ${taskText || 'background agent'}`
    : taskText || `${toolCall.name} background agent`;
}

function parseAsyncAgentLaunch(text: string): { agentId: string; summary?: string } | null {
  const agentMatch = text.match(/Async agent launched successfully\.\s*agentId:\s*([a-zA-Z0-9_-]+)/i);
  if (!agentMatch?.[1]) return null;
  const summaryMatch = text.match(/summary:\s*'([^']+)'/i) || text.match(/summary:\s*"([^"]+)"/i);
  return {
    agentId: agentMatch[1],
    summary: summaryMatch?.[1],
  };
}

function appendUniqueAlias(entry: MonitorEntry, alias?: string, nextId = entry.id): string[] | undefined {
  if (!alias || alias === nextId) return entry.aliases;
  const aliases = entry.aliases || [];
  return aliases.includes(alias) ? aliases : [...aliases, alias];
}

function nextMonitorId(entry: MonitorEntry, taskId?: string): string {
  if (!taskId || entry.aliases?.includes(taskId)) return entry.id;
  return taskId;
}

export function isCodexModel(model?: string | null): boolean {
  return model?.startsWith('codex:') ?? false;
}

export function isNonClaudeHarness(model?: string | null): boolean {
  if (!model) return false;
  return model.startsWith('codex:') || model.startsWith('cursor:') || model.startsWith('gemini:') || model.startsWith('opencode:');
}

export function harnessFromModel(model?: string | null): Harness {
  if (!model) return 'claude';
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('custom:')) return 'custom';
  return 'claude';
}

export function getSupportedPermissionModes(model?: string | null): PermissionMode[] {
  return isCodexModel(model) ? CODEX_PERMISSION_MODES : ALL_PERMISSION_MODES;
}

export function normalizePermissionModeForModel(model?: string | null, mode?: PermissionMode | null): PermissionMode {
  const supportedModes = getSupportedPermissionModes(model);
  if (mode && supportedModes.includes(mode)) {
    return mode;
  }
  return supportedModes.includes(DEFAULT_PERMISSION_MODE) ? DEFAULT_PERMISSION_MODE : supportedModes[0];
}

const PREFERRED_CLAUDE_FALLBACK_MODELS = [
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
];

const PREFERRED_CODEX_FALLBACK_MODELS = [
  'codex:gpt-5.6-sol',
  'codex:gpt-5.6-terra',
  'codex:gpt-5.6-luna',
  'codex:gpt-5.5',
  'codex:gpt-5.4',
  'codex:gpt-5.3-codex',
  'codex:o3',
  'codex:gpt-5.4-mini',
];

interface LoadMessagesOptions {
  replaceWhileStreaming?: boolean;
}

interface LoadedMessagesApplyOptions {
  requestedLimit?: number;
  replaceWhileStreaming?: boolean;
}

const remoteProcessPollers = new Set<string>();
const remoteProcessAttachRequests = new Set<string>();
const MAX_CONCURRENT_SSH_REATTACH_CHECKS = 1;
const SSH_STARTUP_REATTACH_WINDOW_MS = 24 * 60 * 60 * 1000;
const SSH_STARTUP_REATTACH_DELAY_MS = 15_000;
const SSH_STARTUP_REATTACH_STREAM_BACKOFF_MS = 2_000;

interface StartRemoteProcessMonitorOptions {
  recoverableKnown?: boolean;
  attachStream?: boolean;
}

function hasActiveStreamingSession(state: SessionState): boolean {
  return Object.values(state.isStreaming).some(Boolean);
}

function markRemoteProcessStreaming(
  sessionId: string,
  getState: () => SessionState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: any,
): void {
  setState((state: SessionState) => ({
    isStreaming: { ...state.isStreaming, [sessionId]: true },
    sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
    streamGeneration: {
      ...state.streamGeneration,
      [sessionId]: state.isStreaming[sessionId]
        ? (state.streamGeneration[sessionId] || 0)
        : (state.streamGeneration[sessionId] || 0) + 1,
    },
    streamStartTime: {
      ...state.streamStartTime,
      [sessionId]: state.streamStartTime[sessionId] || Date.now(),
    },
    activeStreamModel: {
      ...state.activeStreamModel,
      [sessionId]: state.activeStreamModel[sessionId] || getSessionModel(getState(), sessionId),
    },
  }));
}

async function hasLiveRemoteProcess(sessionId: string, state: SessionState): Promise<boolean> {
  if (!state.sessions.find((session) => session.id === sessionId)?.sshConfig) return false;
  return window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false);
}

async function waitForNoActiveStream(getState: () => SessionState): Promise<void> {
  while (hasActiveStreamingSession(getState())) {
    console.log('[SessionStore] Delaying SSH startup reattach probe while a stream is active');
    await new Promise(resolve => setTimeout(resolve, SSH_STARTUP_REATTACH_STREAM_BACKOFF_MS));
  }
}

function scheduleStartupRemoteProcessMonitor(
  sessionId: string,
  getState: () => SessionState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: any,
  loadMessages: (sessionId: string, options?: LoadMessagesOptions) => Promise<void>,
) {
  console.log('[SessionStore] Startup SSH reattach delayed for active session:', sessionId);
  setTimeout(() => {
    void (async () => {
      await waitForNoActiveStream(getState);
      // Active session: attach the live stream so a turn that survived an app
      // restart resumes visibly instead of freezing at the last snapshot.
      startRemoteProcessMonitor(sessionId, getState, setState, loadMessages);
    })();
  }, SSH_STARTUP_REATTACH_DELAY_MS);
}

function startRemoteProcessMonitor(
  sessionId: string,
  getState: () => SessionState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: any,
  loadMessages: (sessionId: string, options?: LoadMessagesOptions) => Promise<void>,
  options: StartRemoteProcessMonitorOptions = {},
) {
  const shouldAttachStream = options.attachStream !== false;
  if (shouldAttachStream) {
    remoteProcessAttachRequests.add(sessionId);
  }

  if (remoteProcessPollers.has(sessionId)) {
    if (shouldAttachStream) {
      console.log(`[SessionStore] Queued stream attach request for existing SSH process monitor: ${sessionId}`);
    }
    return;
  }
  remoteProcessPollers.add(sessionId);

  const hasRecoverableProcess = options.recoverableKnown
    ? Promise.resolve(true)
    : window.electronAPI.ssh.hasRecoverableRemoteProcess
      ? window.electronAPI.ssh.hasRecoverableRemoteProcess(sessionId, { closeAfter: true })
      : window.electronAPI.ssh.hasActiveRemoteProcess(sessionId);

  hasRecoverableProcess
    .then((recoverable) => {
      if (!recoverable) {
        remoteProcessPollers.delete(sessionId);
        return;
      }

      console.log(`[SessionStore] SSH session ${sessionId} has recoverable remote Claude process — attaching stream state`);
      markRemoteProcessStreaming(sessionId, getState, setState);

      void (async () => {
        try {
          // Only load initial messages if we don't have ANY yet
          const existingMessages = getState().messages[sessionId] || [];
          if (existingMessages.length === 0) {
            console.log(`[SessionStore] Loading initial SSH transcript for ${sessionId}`);
            await loadMessages(sessionId, { replaceWhileStreaming: true });
          }

          const attachRemoteStreamIfRequested = async (): Promise<'attached' | 'completed' | 'skipped'> => {
            if (!remoteProcessAttachRequests.has(sessionId)) {
              return 'skipped';
            }

            const backendAlreadyStreaming = await window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false);
            if (backendAlreadyStreaming) {
              remoteProcessAttachRequests.delete(sessionId);
              return 'attached';
            }

            remoteProcessAttachRequests.delete(sessionId);
            console.log(`[SessionStore] Reattaching to detached SSH turn for ${sessionId}`);
            await window.electronAPI.claude.resumeRemoteTurn(sessionId, getSessionModel(getState(), sessionId));
            await new Promise(resolve => setTimeout(resolve, 1000));
            const stillActive = await hasLiveRemoteProcess(sessionId, getState());
            if (stillActive) {
              console.warn(`[SessionStore] Reattach returned while remote Claude process is still active for ${sessionId}; keeping UI active`);
              markRemoteProcessStreaming(sessionId, getState, setState);
              return 'attached';
            } else {
              await loadMessages(sessionId);
              return 'completed';
            }
          };

          const initialAttachResult = await attachRemoteStreamIfRequested();
          if (initialAttachResult === 'completed') {
            return;
          }
          if (initialAttachResult === 'skipped') {
            console.log(`[SessionStore] Monitoring recoverable SSH session without stream attach: ${sessionId}`);
          }

          while (remoteProcessPollers.has(sessionId)) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const stillActive = await window.electronAPI.ssh.hasActiveRemoteProcess(sessionId);
            if (stillActive) {
              markRemoteProcessStreaming(sessionId, getState, setState);
              const attachResult = await attachRemoteStreamIfRequested();
              if (attachResult === 'completed') {
                break;
              }
              // DON'T reload messages while the process is running — the SDK
              // stream delivers content via IPC and loadMessages would replace
              // in-memory messages with a stale transcript snapshot.
              continue;
            }

            console.log(`[SessionStore] Remote Claude process finished for ${sessionId}; refreshing transcript`);
            // DON'T clear currentStreamContent here — onStreamEnd needs it
            // to add the final message. Only clear activity state.
            const latestState = getState();
            const keepActiveForRunningTools = hasUnfinishedToolCalls(latestState.currentToolCalls[sessionId]);
            setState((state: SessionState) => ({
              isStreaming: keepActiveForRunningTools
                ? state.isStreaming
                : { ...state.isStreaming, [sessionId]: false },
              sessionActivity: {
                ...state.sessionActivity,
                [sessionId]: keepActiveForRunningTools ? 'active' : 'idle',
              },
              activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
            }));
            // Wait for onStreamEnd to fire and add the final message before
            // reloading from transcript. Without this delay, loadMessages
            // replaces in-memory messages with stale transcript data, losing
            // the streamed content.
            await new Promise(resolve => setTimeout(resolve, 2000));
            await loadMessages(sessionId);
            break;
          }
        } catch (error) {
          console.warn('[SessionStore] Failed while polling remote SSH process:', error);
        } finally {
          remoteProcessPollers.delete(sessionId);
          remoteProcessAttachRequests.delete(sessionId);
        }
      })();
    })
    .catch((error) => {
      remoteProcessPollers.delete(sessionId);
      remoteProcessAttachRequests.delete(sessionId);
      console.warn('[SessionStore] Failed to check active remote SSH process:', error);
    });
}

function startRunningSshProcessMonitors(
  sessions: Session[],
  getState: () => SessionState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: any,
  loadMessages: (sessionId: string, options?: LoadMessagesOptions) => Promise<void>,
) {
  if (sessions.length === 0) return;

  console.log('[SessionStore] Auto-reattaching running SSH sessions on startup after delay:', sessions.map((session) => session.id));

  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_SSH_REATTACH_CHECKS, sessions.length);

  const runWorker = async () => {
    while (nextIndex < sessions.length) {
      const session = sessions[nextIndex++];
      if (remoteProcessPollers.has(session.id)) continue;

      try {
        await waitForNoActiveStream(getState);
        const recoverable = window.electronAPI.ssh.hasRecoverableRemoteProcess
          ? await window.electronAPI.ssh.hasRecoverableRemoteProcess(session.id, { closeAfter: true })
          : await window.electronAPI.ssh.hasActiveRemoteProcess(session.id);
        if (!recoverable) continue;

        startRemoteProcessMonitor(session.id, getState, setState, loadMessages, {
          recoverableKnown: true,
          // Background sessions poll without attaching; the active session
          // attaches so the surviving turn streams live in the visible chat.
          attachStream: session.id === getState().activeSessionId,
        });
      } catch (error) {
        console.warn('[SessionStore] Failed to check recoverable SSH process during startup reattach:', session.id, error);
      }
    }
  };

  for (let i = 0; i < workerCount; i += 1) {
    void runWorker();
  }
}

function isRecentRunningSshSession(session: Session): boolean {
  if (session.status !== 'running' || !(session as any).sshConfig) return false;
  const updatedAt = new Date(session.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt <= SSH_STARTUP_REATTACH_WINDOW_MS;
}

function getPreferredCompactionFallbackModel(availableModels: ModelInfo[], sourceModel?: string): string | undefined {
  const preferredModels = isCodexModel(sourceModel)
    ? PREFERRED_CLAUDE_FALLBACK_MODELS
    : PREFERRED_CODEX_FALLBACK_MODELS;

  if (availableModels.length === 0) {
    return preferredModels[0];
  }

  const availableIds = new Set(availableModels.map((model) => model.id));
  return preferredModels.find((modelId) => availableIds.has(modelId));
}

function persistModelSelection(sessionId: string, model: string, permissionMode: PermissionMode) {
  if (!hasElectronAPI) return;

  window.electronAPI.sessions.update(sessionId, { model, permissionMode } as any).catch((err: Error) => {
    console.error('[SessionStore] Failed to persist model selection:', err);
  });
  window.electronAPI.claude.setPermissionMode(sessionId, permissionMode).catch((err) => {
    console.error('[SessionStore] Failed to sync permission mode after model change:', err);
  });
}

function getSessionModel(state: Pick<SessionState, 'selectedModel' | 'sessions'>, sessionId: string): string | undefined {
  return state.selectedModel[sessionId] || state.sessions.find((session) => session.id === sessionId)?.model;
}

function persistPermissionMode(sessionId: string, mode: PermissionMode) {
  if (!hasElectronAPI) return;

  window.electronAPI.claude.setPermissionMode(sessionId, mode).catch((err) => {
    console.error('[SessionStore] Failed to set permission mode on backend:', err);
  });
  window.electronAPI.sessions.update(sessionId, { permissionMode: mode } as any).catch((err: Error) => {
    console.error('[SessionStore] Failed to persist permissionMode:', err);
  });
}

function hasActiveOrQueuedTurn(state: Pick<SessionState, 'isStreaming' | 'isProcessingQueue' | 'activeStreamModel' | 'activeUserPrompt' | 'messageQueue'>, sessionId: string): boolean {
  return Boolean(
    state.isStreaming[sessionId] ||
    state.isProcessingQueue[sessionId] ||
    state.activeStreamModel[sessionId] ||
    state.activeUserPrompt[sessionId] ||
    (state.messageQueue[sessionId]?.length ?? 0) > 0,
  );
}

function canChangePermissionModeDuringActiveTurn(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions';
}

function isUnfinishedToolCall(toolCall: ToolCall | undefined): boolean {
  if (!toolCall) return false;
  const status = normalizeToolCall(toolCall).status;
  return status === 'running' || status === 'pending';
}

function hasUnfinishedToolCalls(toolCalls: ToolCall[] | undefined): boolean {
  return (toolCalls || []).some(isUnfinishedToolCall);
}

function collectUnfinishedToolCalls(...toolCallGroups: Array<ToolCall[] | undefined>): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const toolCalls of toolCallGroups) {
    for (const toolCall of toolCalls || []) {
      const normalized = normalizeToolCall(toolCall);
      const existing = byId.get(normalized.id);
      const merged = existing ? mergeToolCall(existing, normalized) : normalized;
      byId.set(merged.id, merged);
    }
  }
  return [...byId.values()].filter(isUnfinishedToolCall);
}

function settleUnfinishedToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls;
  let changed = false;
  const settled = toolCalls.map((toolCall) => {
    const normalized = normalizeToolCall(toolCall);
    if (!isUnfinishedToolCall(normalized)) return normalized;
    changed = true;
    return {
      ...normalized,
      status: 'error' as const,
      error: normalized.error || 'Tool call ended before completion.',
      completedAt: normalized.completedAt || new Date(),
    };
  });
  return changed ? settled : toolCalls.map(normalizeToolCall);
}

type PersistedChatMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

export function getSupplementalStorageKey(sessionId: string): string {
  return `${SUPPLEMENTAL_MESSAGES_STORAGE_PREFIX}${sessionId}`;
}

function normalizeChatMessageTimestamp(message: ChatMessage): ChatMessage {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  return {
    ...message,
    timestamp,
    toolCalls: message.toolCalls?.map(normalizeToolCall),
  };
}

function isGenericToolName(name: string | undefined): boolean {
  const normalized = (name || '').trim().toLowerCase();
  return !normalized || normalized === 'tool' || normalized === 'unknown';
}

function hasToolInput(input: Record<string, unknown> | undefined): boolean {
  return !!input && Object.keys(input).length > 0;
}

function compactPlainStatusLabel(value: unknown, maxLength = 120): string | undefined {
  if (extractContentBlockText(value).matched || typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 3))}...` : compact;
}

function getToolCallStatusLabel(toolCall: ToolCall): string {
  const input = toolCall.input || {};
  const candidates = [
    input.description,
    input.command,
    input.file_path,
    input.path,
    input.pattern,
    input.query,
    input.prompt,
    toolCall.name,
  ];

  for (const candidate of candidates) {
    const label = compactPlainStatusLabel(candidate);
    if (label) return label;
  }

  return toolCall.name;
}

function isDevRendererRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'localhost' && window.location.port === '3000';
}

function mergeToolCall(existing: ToolCall, updates: Partial<ToolCall>): ToolCall {
  const normalized = normalizeToolCall({ ...existing, ...updates });
  if (isGenericToolName(normalized.name) && !isGenericToolName(existing.name)) {
    normalized.name = existing.name;
  }
  if (!hasToolInput(normalized.input) && hasToolInput(existing.input)) {
    normalized.input = existing.input;
  }
  return normalized;
}

function serializeChatMessage(message: ChatMessage): PersistedChatMessage {
  const normalized = normalizeChatMessageTimestamp(message);
  return {
    ...normalized,
    timestamp: normalized.timestamp.toISOString(),
  };
}

function deserializeChatMessage(message: PersistedChatMessage): ChatMessage | null {
  const timestamp = new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return {
    ...message,
    timestamp,
  };
}

function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const aTime = normalizeChatMessageTimestamp(a).timestamp.getTime();
  const bTime = normalizeChatMessageTimestamp(b).timestamp.getTime();
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  const roleOrder = { system: 0, user: 1, assistant: 2 };
  const roleDelta = roleOrder[a.role] - roleOrder[b.role];
  if (roleDelta !== 0) {
    return roleDelta;
  }

  return a.id.localeCompare(b.id);
}

function buildMessageFingerprint(message: ChatMessage): string {
  const normalized = normalizeChatMessageTimestamp(message);

  return [
    normalized.role,
    normalized.harness || '',
    normalized.timestamp.getTime(),
    normalized.content,
    toolSignature(normalized),
    contentBlockSignature(normalized),
    normalized.interrupted ? '1' : '0',
  ].join('::');
}

function mergeContentBlocks(existingBlocks?: ContentBlock[], incomingBlocks?: ContentBlock[]): ContentBlock[] | undefined {
  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  for (const block of [...(existingBlocks || []), ...(incomingBlocks || [])]) {
    const key = [
      block.type,
      block.text || '',
      block.toolCallId || '',
      block.agentId || '',
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }

  return merged.length > 0 ? merged : undefined;
}

function mergeToolCalls(existingToolCalls?: ToolCall[], incomingToolCalls?: ToolCall[]): ToolCall[] | undefined {
  const merged: ToolCall[] = [];
  const indexById = new Map<string, number>();

  for (const toolCall of [...(existingToolCalls || []), ...(incomingToolCalls || [])]) {
    const existingIndex = indexById.get(toolCall.id);
    if (existingIndex === undefined) {
      indexById.set(toolCall.id, merged.length);
      merged.push(normalizeToolCall(toolCall));
      continue;
    }
    merged[existingIndex] = mergeToolCall(merged[existingIndex], toolCall);
  }

  return merged.length > 0 ? merged : undefined;
}

function mergeDuplicateTimelineMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const existingContent = existing.content || '';
  const incomingContent = incoming.content || '';
  if (existingContent.length !== incomingContent.length) {
    console.debug('[SessionStore] preserving fuller duplicate message during hydration');
  }
  const content = incomingContent.length > existingContent.length
    ? incomingContent
    : existingContent;
  const existingTime = normalizeChatMessageTimestamp(existing).timestamp.getTime();
  const incomingTime = normalizeChatMessageTimestamp(incoming).timestamp.getTime();
  const safeExistingTime = Number.isFinite(existingTime) ? existingTime : 0;
  const safeIncomingTime = Number.isFinite(incomingTime) ? incomingTime : 0;
  const newestTime = Math.max(safeExistingTime, safeIncomingTime);
  const newerMessage = safeIncomingTime > safeExistingTime ? incoming : existing;

  return {
    ...existing,
    ...newerMessage,
    id: existing.id,
    role: existing.role,
    content,
    timestamp: newestTime > 0 ? new Date(newestTime) : normalizeChatMessageTimestamp(existing).timestamp,
    toolCalls: mergeToolCalls(existing.toolCalls, incoming.toolCalls),
    contentBlocks: mergeContentBlocks(existing.contentBlocks, incoming.contentBlocks),
    interrupted: existing.interrupted || incoming.interrupted,
  };
}

function normalizeContentForTimelineCompare(content?: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isCloseExactDuplicate(a: ChatMessage, b: ChatMessage): boolean {
  return isCloseTimelineDuplicate(
    normalizeChatMessageTimestamp(a),
    normalizeChatMessageTimestamp(b),
  );
}

function isCloseReloadDuplicate(a: ChatMessage, b: ChatMessage): boolean {
  const normalizedA = normalizeChatMessageTimestamp(a);
  const normalizedB = normalizeChatMessageTimestamp(b);
  return isCloseTimelineDuplicate(normalizedA, normalizedB)
    || isCloseContentDuplicate(normalizedA, normalizedB);
}

function latestMessageTime(messages: ChatMessage[]): number {
  return messages.reduce((latest, message) => {
    const timestamp = normalizeChatMessageTimestamp(message).timestamp.getTime();
    return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
  }, 0);
}

function mergeLoadedMessagesWithExisting(
  sessionId: string,
  loadedMessages: ChatMessage[],
  existingMessages: ChatMessage[],
  options: { authoritativeBuildTranscript?: boolean; partialTranscript?: boolean } = {}
): ChatMessage[] {
  const existing = filterInternalPromptEchoes(existingMessages || [])
    .filter((message) => !isConsumedQueueMessage(sessionId, message))
    .filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));
  if (existing.length === 0) return loadedMessages;

  const loadedLatest = latestMessageTime(loadedMessages);
  const preserved = existing.filter((message) => {
    const normalized = normalizeChatMessageTimestamp(message);
    const hasLoadedDuplicate = loadedMessages.some((loadedMessage) => isCloseReloadDuplicate(loadedMessage, message));
    if (options.authoritativeBuildTranscript) {
      if (options.partialTranscript && !hasLoadedDuplicate) {
        return true;
      }
      // Build transcript is authoritative for messages it contains, but
      // in-memory messages without a loaded duplicate may not have been
      // flushed to disk yet or may come from older history not yet
      // backfilled — preserve them regardless of role.
      if (!hasLoadedDuplicate) return true;
      // Duplicate exists in loaded set — let the transcript version win.
      // Exception: user messages newer than the transcript's latest
      // timestamp were sent after the read and must survive.
      return message.role !== 'assistant' && normalized.timestamp.getTime() > loadedLatest;
    }
    if (normalized.timestamp.getTime() > loadedLatest) return true;
    if (message.harness && message.harness !== 'claude') return true;
    if (options.partialTranscript && !hasLoadedDuplicate) return true;
    return !hasLoadedDuplicate;
  });

  // Diagnostic: detect assistant messages that exist in memory but are being dropped
  const existingAssistants = existing.filter(m => m.role === 'assistant');
  const preservedAssistants = preserved.filter(m => m.role === 'assistant');
  if (existingAssistants.length > 0 && preservedAssistants.length < existingAssistants.length) {
    const droppedAssistants = existingAssistants.filter(ea =>
      !preserved.some(p => p.id === ea.id)
    );
    for (const dropped of droppedAssistants) {
      const loadedMatch = loadedMessages.find(lm => isCloseReloadDuplicate(lm, dropped));
      console.warn(
        `[SessionStore] ⚠️ DIAGNOSTIC: assistant message ${dropped.id?.substring(0, 16)} being dropped from existing`
        + ` | contentLen=${(dropped.content || '').length}`
        + ` | loadedMatch=${loadedMatch ? `id=${loadedMatch.id?.substring(0, 16)} contentLen=${(loadedMatch.content || '').length}` : 'NONE'}`
        + ` | authoritativeBuildTranscript=${options.authoritativeBuildTranscript}`
        + ` | partialTranscript=${options.partialTranscript}`
        + ` | loadedCount=${loadedMessages.length} existingCount=${existing.length} preservedCount=${preserved.length}`
      );
    }
  }

  if (preserved.length === 0) return loadedMessages;

  const existingLatest = latestMessageTime(existing);
  console.warn(
    `[SessionStore] Preserving ${preserved.length} in-memory messages during transcript hydration`
    + ` (loaded=${loadedMessages.length}, existing=${existing.length}, loadedLatest=${loadedLatest}, existingLatest=${existingLatest})`
    + `${options.authoritativeBuildTranscript ? ' [authoritative Build transcript]' : ''}`
    + `${options.partialTranscript ? ' [partial transcript slice]' : ''}`
  );
  return mergeTimelineMessages(loadedMessages, preserved);
}

function isAutoBuildAssistantMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && AUTO_BUILD_SECTION_MARKERS.some((marker) =>
    (message.content || '').includes(marker)
  );
}

function isAutoBuildSuperset(base: ChatMessage, candidate: ChatMessage): boolean {
  if (base.role !== 'assistant' || !isAutoBuildAssistantMessage(candidate)) return false;

  const baseContent = normalizeContentForTimelineCompare(base.content);
  const candidateContent = normalizeContentForTimelineCompare(candidate.content);
  return baseContent.length > 0 && candidateContent.startsWith(baseContent);
}

function mergeTimelineMessages(primary: ChatMessage[], supplemental: ChatMessage[]): ChatMessage[] {
  const normalizedPrimary = primary.map(normalizeChatMessageTimestamp);
  const normalizedSupplemental = supplemental.map(normalizeChatMessageTimestamp);
  const autoBuildSupplemental = normalizedSupplemental.filter(isAutoBuildAssistantMessage);

  const filteredPrimary = normalizedPrimary.filter((message) => {
    if (autoBuildSupplemental.some((candidate) => isAutoBuildSuperset(message, candidate))) {
      return false;
    }
    return true;
  });

  const filteredSupplemental = normalizedSupplemental.filter((message) => {
    if (isAutoBuildAssistantMessage(message)) return true;
    return !normalizedPrimary.some((primaryMessage) => isCloseExactDuplicate(primaryMessage, message));
  });

  const merged = [...filteredPrimary, ...filteredSupplemental]
    .map(normalizeChatMessageTimestamp)
    .sort(compareChatMessages);

  const seenIds = new Set<string>();
  const indexById = new Map<string, number>();
  const seenFingerprints = new Set<string>();
  const deduped: ChatMessage[] = [];

  for (const message of merged) {
    if (seenIds.has(message.id)) {
      const existingIndex = indexById.get(message.id);
      if (existingIndex !== undefined) {
        deduped[existingIndex] = mergeDuplicateTimelineMessage(deduped[existingIndex], message);
      }
      continue;
    }

    const duplicateContentIndex = deduped.findIndex((existing) => {
      if (isExactLongAssistantDuplicate(existing, message)) {
        const delta = Math.abs(existing.timestamp.getTime() - message.timestamp.getTime());
        return delta < 300_000;
      }
      if (isPrefixAssistantDuplicate(existing, message)) return true;
      return false;
    });
    if (duplicateContentIndex >= 0) {
      deduped[duplicateContentIndex] = mergeDuplicateTimelineMessage(deduped[duplicateContentIndex], message);
      continue;
    }

    const fingerprint = buildMessageFingerprint(message);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenIds.add(message.id);
    indexById.set(message.id, deduped.length);
    seenFingerprints.add(fingerprint);
    deduped.push(message);
  }

  return deduped;
}

function extractAutoBuildHelperContent(content: string): string {
  const markerIndex = AUTO_BUILD_SECTION_MARKERS
    .map((marker) => content.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  if (markerIndex === undefined) return '';
  return content.slice(markerIndex).trim();
}

function autoBuildStageTitle(tier: string): string {
  switch (tier) {
    case 'plan':
      return 'Planning follow-up';
    case 'build':
      return 'Implementation follow-up';
    case 'verify':
      return 'Verification follow-up';
    case 'refine':
      return 'Refinement follow-up';
    default:
      return 'Follow-up';
  }
}

function extractAutoBuildSection(content: string, title: string): string {
  const marker = `\n\n---\n\n${title}`;
  const start = content.indexOf(marker);
  if (start === -1) return '';

  const next = content.indexOf('\n\n---\n\n', start + marker.length);
  return next === -1 ? content.slice(start) : content.slice(start, next);
}

type WorkflowFailuresMetadata = NonNullable<NonNullable<ChatMessage['metadata']>['workflowFailures']>;

function isHarnessValue(value: unknown): value is Harness {
  return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'gemini' || value === 'opencode' || value === 'custom';
}

function isTaskTierValue(value: unknown): value is TaskTier {
  return value === 'plan' || value === 'build' || value === 'verify' || value === 'refine';
}

function buildWorkflowFailureMetadata(
  decision: AutoRouteDecisionState | null | undefined,
  helperContent: string,
  leadError?: string,
): WorkflowFailuresMetadata {
  const failures: WorkflowFailuresMetadata = [];
  if (!decision) return failures;

  const resolvedHarness = isHarnessValue(decision.resolvedHarness) ? decision.resolvedHarness : undefined;
  if (leadError && resolvedHarness && decision.resolvedModel) {
    failures.push({
      harness: resolvedHarness,
      model: decision.resolvedModel,
      error: leadError.slice(0, 500),
    });
  }

  for (const stage of decision.orchestration?.stages || []) {
    if (stage.trigger === 'now') continue;
    const section = extractAutoBuildSection(helperContent, autoBuildStageTitle(stage.tier));
    const failureMatch = section.match(/Follow-up step (?:could not complete|skipped)(?:[:.]\s*)?([^\n]*)/i);
    if (!failureMatch) continue;
    const error = (failureMatch[1] || '').trim().replace(/^\.$/, '').slice(0, 500) || undefined;
    if (!isHarnessValue(stage.harness)) continue;
    failures.push({
      harness: stage.harness,
      model: stage.model,
      error,
    });
  }

  return failures;
}

function buildAutoBuildContextMessage(
  baseMessage: ChatMessage,
  decision: AutoRouteDecisionState | null | undefined,
  helperContent: string,
  leadError?: string,
): ChatMessage {
  const stages = decision?.orchestration?.stages || [];
  const stageSummary = stages.length > 0
    ? stages.map((stage, index) => {
      const fallbackSummary = stage.fallbackModels?.length ? ' with fallback available' : '';
      return `${index + 1}. planned ${stage.tier}${fallbackSummary} - ${stage.purpose}`;
    }).join('\n')
    : 'No stage plan was recorded.';
  const helperSummary = helperContent || (leadError
    ? 'No follow-up output was recorded because the lead step failed.'
    : 'No delegate output was recorded. The visible assistant response is the lead stage result for this turn.');
  const workflowFailures = buildWorkflowFailureMetadata(decision, helperContent, leadError);
  const decisionTier = decision?.tier;
  const workflowCompletedScope = !leadError && isTaskTierValue(decisionTier) ? decisionTier : undefined;

  return {
    id: `autobuild-context-${baseMessage.id}`,
    role: 'system',
    content: `<workflow_turn_result>
Completed scope: ${leadError ? 'none' : decision?.tier || 'unknown'}
Task domain: ${decision?.domain || 'unknown'}
Lead error: ${leadError || 'none'}
Planned scope:
${stageSummary}

Follow-up output:
${helperSummary}
</workflow_turn_result>`,
    timestamp: new Date(normalizeChatMessageTimestamp(baseMessage).timestamp.getTime() + 1),
    metadata: {
      workflowCompletedScope,
      ...(workflowFailures.length > 0 ? { workflowFailures } : {}),
    },
  };
}

function buildContentBlocksFromStreamEvents(events: StreamEvent[]): ContentBlock[] | undefined {
  if (events.length === 0) return undefined;

  const blocks: ContentBlock[] = [];
  for (const event of events) {
    if (event.type === 'text' && event.content) {
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === 'text' && lastBlock.agentId === event.agentId) {
        lastBlock.text = (lastBlock.text || '') + event.content;
      } else {
        blocks.push({ type: 'text', text: event.content, agentId: event.agentId });
      }
      continue;
    }

    if (event.type === 'tool' && event.toolCall?.id) {
      blocks.push({ type: 'tool_use', toolCallId: event.toolCall.id, agentId: event.toolCall.agentId || event.agentId });
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

function loadSupplementalMessages(sessionId: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(getSupplementalStorageKey(sessionId));
    if (!raw) return [];

    const parsed = JSON.parse(raw) as PersistedChatMessage[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(deserializeChatMessage)
      .filter((message): message is ChatMessage => !!message)
      .sort(compareChatMessages);
  } catch (error) {
    console.warn('[SessionStore] Failed to load supplemental messages:', error);
    return [];
  }
}

async function hasBuildTranscriptForHydration(sessionId: string): Promise<boolean> {
  if (!hasElectronAPI || !window.electronAPI.claude.hasBuildTranscript) {
    return false;
  }

  return window.electronAPI.claude.hasBuildTranscript(sessionId).catch(() => false);
}

const SUPPLEMENTAL_MAX_MESSAGES = 200;
const SUPPLEMENTAL_MAX_BYTES = 512 * 1024;
const SUPPLEMENTAL_RETRY_MAX_MESSAGES = 60;
const SUPPLEMENTAL_RETRY_MAX_BYTES = 128 * 1024;
const SUPPLEMENTAL_CONTEXT_MAX_MESSAGES = 40;
const SUPPLEMENTAL_CONTEXT_MAX_BYTES = 96 * 1024;

function serializeSupplementalMessages(messages: ChatMessage[], maxMessages: number, maxBytes: number): string {
  let serialized = messages
    .slice(-maxMessages)
    .map(serializeChatMessage)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  let json = JSON.stringify(serialized);

  while (json.length > maxBytes && serialized.length > 1) {
    serialized = serialized.slice(1);
    json = JSON.stringify(serialized);
  }

  return json;
}

function isStorageQuotaExceeded(error: unknown): boolean {
  const err = error as { name?: string; code?: number } | undefined;
  return err?.name === 'QuotaExceededError' || err?.code === 22 || err?.code === 1014;
}

function pruneSupplementalLocalStorageForQuota(currentSessionId: string): void {
  if (typeof window === 'undefined') return;

  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(SUPPLEMENTAL_MESSAGES_STORAGE_PREFIX)) continue;
    if (key === getSupplementalStorageKey(currentSessionId)) continue;

    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as PersistedChatMessage[];
      if (!Array.isArray(parsed)) {
        window.localStorage.removeItem(key);
        continue;
      }
      const messages = parsed
        .map(deserializeChatMessage)
        .filter((message): message is ChatMessage => !!message);
      window.localStorage.setItem(
        key,
        serializeSupplementalMessages(messages, SUPPLEMENTAL_RETRY_MAX_MESSAGES, SUPPLEMENTAL_RETRY_MAX_BYTES),
      );
    } catch {
      window.localStorage.removeItem(key);
    }
  }
}

function capMessagesForModelContext(messages: ChatMessage[]): ChatMessage[] {
  const capped: ChatMessage[] = [];
  let approxBytes = 0;

  for (let i = messages.length - 1; i >= 0 && capped.length < SUPPLEMENTAL_CONTEXT_MAX_MESSAGES; i--) {
    const message = messages[i];
    const serialized = JSON.stringify(serializeChatMessage(message));
    if (capped.length > 0 && approxBytes + serialized.length > SUPPLEMENTAL_CONTEXT_MAX_BYTES) break;
    approxBytes += serialized.length;
    capped.unshift(message);
  }

  return capped;
}

function loadSupplementalMessagesForModelContext(sessionId: string): ChatMessage[] {
  return capMessagesForModelContext(filterInternalPromptEchoes(loadSupplementalMessages(sessionId)));
}

function saveSupplementalMessages(sessionId: string, messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;

  const storageKey = getSupplementalStorageKey(sessionId);
  try {
    window.localStorage.setItem(
      storageKey,
      serializeSupplementalMessages(messages, SUPPLEMENTAL_MAX_MESSAGES, SUPPLEMENTAL_MAX_BYTES),
    );
  } catch (error) {
    if (isStorageQuotaExceeded(error)) {
      try {
        pruneSupplementalLocalStorageForQuota(sessionId);
        window.localStorage.setItem(
          storageKey,
          serializeSupplementalMessages(messages, SUPPLEMENTAL_RETRY_MAX_MESSAGES, SUPPLEMENTAL_RETRY_MAX_BYTES),
        );
        console.warn('[SessionStore] Pruned supplemental localStorage after quota pressure');
        return;
      } catch (retryError) {
        console.warn('[SessionStore] Failed to save pruned supplemental messages:', retryError);
      }
    }
    console.warn('[SessionStore] Failed to save supplemental messages:', error);
  }
}

function pruneSessionLocalStorage(validSessionIds: Set<string>): void {
  if (typeof window === 'undefined') return;

  const prefixes = ['grep-supplemental-messages-', 'grep-history-'];
  let freedBytes = 0;

  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const key = window.localStorage.key(i);
    if (!key) continue;

    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        const sid = key.slice(prefix.length);
        if (!validSessionIds.has(sid)) {
          const val = window.localStorage.getItem(key);
          freedBytes += val?.length || 0;
          window.localStorage.removeItem(key);
        }
      }
    }
  }

  if (freedBytes > 0) {
    console.log(`[SessionStore] Pruned ${(freedBytes / 1024).toFixed(0)}KB of orphaned localStorage entries`);
  }
}

function persistSupplementalMessage(sessionId: string, message: ChatMessage): void {
  const existing = loadSupplementalMessages(sessionId).filter((existingMessage) => existingMessage.id !== message.id);
  const merged = mergeTimelineMessages(existing, [message]);
  saveSupplementalMessages(sessionId, merged);
}

function hasVisibleAssistantActivity(state: SessionState, sessionId: string): boolean {
  if ((state.currentStreamContent[sessionId] || '').trim()) return true;
  if ((state.currentThinkingContent[sessionId] || '').trim()) return true;
  if ((state.currentToolCalls[sessionId] || []).length > 0) return true;
  if (state.pendingPermission[sessionId] || state.pendingQuestion[sessionId] || state.pendingPlanApproval[sessionId]) return true;

  return (state.streamEvents[sessionId] || []).some((event) => {
    if (event.type === 'text') return Boolean(event.content?.trim());
    if (event.type === 'tool') return true;
    return false;
  });
}

function hasRecentUnansweredDuplicateUserPrompt(state: SessionState, sessionId: string, message: string): boolean {
  const normalizedPrompt = normalizeContentForTimelineCompare(message);
  if (!normalizedPrompt) return false;

  const messages = state.messages[sessionId] || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const existingMessage = normalizeChatMessageTimestamp(messages[i]);
    if (existingMessage.role === 'assistant' && hasRecoverableOutput(existingMessage)) {
      return false;
    }
    if (existingMessage.role !== 'user') {
      continue;
    }

    const ageMs = Date.now() - existingMessage.timestamp.getTime();
    if (!Number.isFinite(ageMs) || ageMs > UNANSWERED_DUPLICATE_USER_PROMPT_WINDOW_MS) {
      return false;
    }
    return normalizeContentForTimelineCompare(existingMessage.content) === normalizedPrompt;
  }

  return false;
}

function combineUserPrompts(first: string, second: string): string {
  return [first.trimEnd(), second.trimStart()].filter(Boolean).join('\n\n');
}

export function cloneSupplementalMessages(fromSessionId: string, toSessionId: string): void {
  if (typeof window === 'undefined' || fromSessionId === toSessionId) return;

  try {
    const raw = window.localStorage.getItem(getSupplementalStorageKey(fromSessionId));
    if (!raw) {
      return;
    }
    window.localStorage.setItem(getSupplementalStorageKey(toSessionId), raw);
  } catch (error) {
    console.warn('[SessionStore] Failed to clone supplemental messages:', error);
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: true, // Start as loading
  messages: {},
  isLoadingMessages: {},
  isStreaming: {},
  sessionActivity: {},
  isProcessingQueue: {},
  streamGeneration: {},
  streamStartTime: {},
  streamEvents: {}, // Chronological event stream
  currentStreamContent: {},
  currentThinkingContent: {},
  currentToolCalls: {},
  currentSystemInfo: {},
  monitorInstances: {},
  activeStreamModel: {},
  activeUserPrompt: {},
  permissionMode: {},
  thinkingMode: {},
  htmlRenderMode: {},
  selectedModel: {},
  availableModels: [],
  pendingPermission: {},
  pendingQuestion: {},
  pendingPlanApproval: {},
  setupProgress: {},
  compactionStatus: {},
  compactionSwitch: {},
  contextUsage: {},
  messageQueue: {},
  backgroundTasks: {},
  securedKeys: {},
  agentColorMap: {},
  gstackMode: {},
  fastMode: JSON.parse(localStorage.getItem('grep-fast-mode') || 'false'),
  autoRouteDecision: {},
  activeMetaGoals: {},
  codexStreaming: {},
  codexContent: {},
  codexThinking: {},
  codexToolCalls: {},
  codexError: {},
  codexPrompt: {},

  // Ephemeral /btw and remote control state
  btw: {},
  remoteControl: {},

  // Command Center session list — persisted via localStorage
  commandCenterSessionIds: (() => {
    try {
      const stored = localStorage.getItem('grep-command-center-sessions');
      if (stored) return JSON.parse(stored);
    } catch (e) { /* ignore */ }
    return [];
  })(),

  // Fork tracking initialization
  activeForkGroup: null,
  visibleForkIds: {},
  activeForkIndex: {},

  setActiveSession: async (sessionId) => {
    const { loadMessages, startSession } = get();

    // 1. Synchronous state update FIRST (instant UI response)
    set((state) => {
      // Update the session's updatedAt timestamp when it becomes active
      const updatedSessions = sessionId
        ? state.sessions.map(session =>
            session.id === sessionId
              ? { ...session, updatedAt: new Date() }
              : session
          )
        : state.sessions;

      // Restore the session's model + permission mode from persisted session data
      const session = sessionId ? state.sessions.find(s => s.id === sessionId) : null;
      const sessionModel = session?.model;
      const restoredModel = (sessionModel && sessionId) ? { [sessionId]: sessionModel } : {};
      const normalizedPermissionMode = sessionId
        ? normalizePermissionModeForModel(sessionModel, (session as any)?.permissionMode)
        : undefined;
      const restoredPermission = sessionId && normalizedPermissionMode
        ? { [sessionId]: normalizedPermissionMode }
        : {};

      return {
        activeSessionId: sessionId,
        sessions: updatedSessions,
        selectedModel: {
          ...state.selectedModel,
          ...restoredModel,
        },
        permissionMode: {
          ...state.permissionMode,
          ...restoredPermission,
        },
      };
    });

    // Focus Mode guard: if switching away from the active task, confirm with user.
    // Runs AFTER the UI update so the tab switch feels instant; reverts if user cancels.
    if (sessionId) {
      try {
        const taskModule = await import('./task.store');
        const taskState = taskModule.useTaskStore.getState();
        if (taskState.focusModeEnabled && taskState.activeTaskId) {
          const activeTask = taskState.tasks.find(t => t.id === taskState.activeTaskId);
          if (activeTask?.sessionId) {
            const allowedRoot = activeTask.sessionId;
            const currentSessions = get().sessions;
            const targetSession = currentSessions.find(s => s.id === sessionId);
            const isAllowed = sessionId === allowedRoot ||
              targetSession?.parentSessionId === allowedRoot ||
              currentSessions.find(s => s.id === allowedRoot)?.childSessionIds?.includes(sessionId);

            if (!isAllowed) {
              const proceed = window.confirm(
                `Focus Mode is active.\n\nCurrent task: "${activeTask.title}"\n\nSwitch away from this task?`
              );
              if (!proceed) {
                // Revert to previous session
                const previousId = activeTask.sessionId;
                set({ activeSessionId: previousId });
                return;
              }
            }
          }
        }
      } catch {
        // task store not loaded yet — skip guard
      }
    }

    // Auto-open plan panel if switching to a session with pending plan approval
    if (sessionId && get().pendingPlanApproval[sessionId]) {
      import('./ui.store').then(({ useUIStore }) => {
        useUIStore.getState().showPlanPanel();
      });
    }

    // Persist active session and update timestamp in backend (only in Electron)
    if (hasElectronAPI && sessionId) {
      // 2. Fire-and-forget IPC operations (non-blocking, parallel)
      window.electronAPI.dev.setActiveSession(sessionId);
      window.electronAPI.sessions.update(sessionId, { updatedAt: new Date() });

      const session = get().sessions.find(s => s.id === sessionId);

      // 3. Start session if stopped (non-blocking)
      if (session && session.status === 'stopped') {
        startSession(sessionId); // Don't await
      }

      // 4. Load messages in background (non-blocking)
      // Skip if we already have messages cached — avoids expensive IPC/SSH reads
      // that block the main process and freeze the UI on every tab switch.
      const cachedMessages = get().messages[sessionId];
      if (!cachedMessages || cachedMessages.length === 0) {
        loadMessages(sessionId); // Don't await
      }

      // 5. If the app was closed while a detached SSH run continued remotely,
      // preserve streaming/queue semantics until that remote process exits.
      // Only start if not already monitoring (avoid duplicate monitors on tab switch).
      // The user is looking at this session — attach the live stream so an
      // in-flight remote turn streams visibly instead of freezing at the last
      // persisted snapshot. Attach only fires when a recoverable turn exists.
      if (session?.sshConfig && !get().isStreaming[sessionId]) {
        startRemoteProcessMonitor(sessionId, get, set, loadMessages);
      }

      // 6. Check if this session has worktree instructions that haven't been sent yet
      const currentSession = get().sessions.find(s => s.id === sessionId);
      if (currentSession?.worktreeInstructions && !currentSession.worktreeInstructionsSent) {
        console.log('[SessionStore] Session has worktree instructions, sending as first message');

        // Mark instructions as sent FIRST to prevent double-sending
        await window.electronAPI.sessions.update(sessionId, { worktreeInstructionsSent: true });
        set((state) => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId ? { ...s, worktreeInstructionsSent: true } : s
          ),
        }));

        // Send instructions as the first message to Claude
        const { sendMessage } = get();
        const instructionsMessage = `## Worktree Setup Instructions\n\nThis is a new worktree session. Please follow these setup instructions:\n\n${currentSession.worktreeInstructions}`;
        sendMessage(sessionId, instructionsMessage);
      }
    }
  },

  addSession: (session) => {
    set((state) => ({ sessions: [...state.sessions, session] }));
  },

  loadSessions: async () => {
    if (!hasElectronAPI) {
      set({ isLoadingSessions: false });
      return;
    }
    try {
      const allSessions = await window.electronAPI.sessions.list();
      const activeSessionId = await window.electronAPI.dev.getActiveSession();

      // Load ALL sessions - filtering for display happens in SessionList component
      const sessions = allSessions
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // Verify the active session still exists
      const sessionExists = sessions.some((s) => s.id === activeSessionId);
      let validActiveSessionId = sessionExists ? activeSessionId : null;
      let autoSelected = false;

      // Auto-select most recent session if no active session
      if (!validActiveSessionId && sessions.length > 0) {
        // Prefer running sessions, then most recent by updatedAt
        const runningSession = sessions
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

        const mostRecentSession = sessions
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

        validActiveSessionId = runningSession?.id || mostRecentSession?.id || null;
        autoSelected = true;
        console.log('[SessionStore] Auto-selected session:', validActiveSessionId);
      }

      // Restore the model for the active session
      const activeSession = validActiveSessionId
        ? sessions.find(s => s.id === validActiveSessionId)
        : null;
      const restoredModel = activeSession?.model
        ? { [validActiveSessionId!]: activeSession.model }
        : {};
      const restoredPermission = validActiveSessionId
        ? {
            [validActiveSessionId]: normalizePermissionModeForModel(
              activeSession?.model,
              (activeSession as any)?.permissionMode,
            ),
          }
        : {};
      const restoredHtmlRenderMode = collectSessionHtmlRenderModes(sessions);

      set({
        sessions,
        activeSessionId: validActiveSessionId,
        isLoadingSessions: false,
        selectedModel: restoredModel,
        permissionMode: restoredPermission,
        htmlRenderMode: restoredHtmlRenderMode,
      });

      // Persist auto-selected session
      if (autoSelected && validActiveSessionId) {
        window.electronAPI.dev.setActiveSession(validActiveSessionId);
      }

      // Prune orphaned localStorage entries for deleted sessions
      const validIds = new Set(sessions.map(s => s.id));
      pruneSessionLocalStorage(validIds);

      // Load messages for the active session
      if (validActiveSessionId) {
        const { loadMessages } = get();
        loadMessages(validActiveSessionId);
        if (activeSession?.sshConfig) {
          scheduleStartupRemoteProcessMonitor(validActiveSessionId, get, set, loadMessages);
        }
      }

      const runningSshSessions = sessions.filter(isRecentRunningSshSession);
      if (runningSshSessions.length > 0) {
        const { loadMessages } = get();
        setTimeout(() => {
          startRunningSshProcessMonitors(runningSshSessions, get, set, loadMessages);
        }, SSH_STARTUP_REATTACH_DELAY_MS);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
      set({ isLoadingSessions: false });
    }
  },

  createSession: async (config) => {
    if (!hasElectronAPI) throw new Error('Not running in Electron');
    const session = await window.electronAPI.sessions.create(config);
    set((state) => ({ sessions: [...state.sessions, session] }));
    return session;
  },

  startSession: async (sessionId) => {
    if (!hasElectronAPI) return;
    await window.electronAPI.sessions.start(sessionId);
  },

  stopSession: async (sessionId) => {
    if (!hasElectronAPI) return;
    await window.electronAPI.sessions.stop(sessionId);
  },

  deleteSession: async (sessionId) => {
    if (!hasElectronAPI) return;

    // Collect message IDs before purging (for audio TTS cleanup)
    const messageIds = (get().messages[sessionId] || []).map(m => m.id);

    // Clear secure keys for this session from memory
    await window.electronAPI.secureKeys.clearSession(sessionId);

    await window.electronAPI.sessions.delete(sessionId);
    set((state) => {
      const clean = <T,>(rec: Record<string, T>): Record<string, T> => {
        const { [sessionId]: _, ...rest } = rec;
        return rest;
      };
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
        messages: clean(state.messages),
        isLoadingMessages: clean(state.isLoadingMessages),
        isStreaming: clean(state.isStreaming),
        sessionActivity: clean(state.sessionActivity),
        isProcessingQueue: clean(state.isProcessingQueue),
        streamEvents: clean(state.streamEvents),
        currentStreamContent: clean(state.currentStreamContent),
        currentThinkingContent: clean(state.currentThinkingContent),
        currentToolCalls: clean(state.currentToolCalls),
        currentSystemInfo: clean(state.currentSystemInfo),
        activeUserPrompt: clean(state.activeUserPrompt),
        permissionMode: clean(state.permissionMode),
        thinkingMode: clean(state.thinkingMode),
        htmlRenderMode: clean(state.htmlRenderMode),
        selectedModel: clean(state.selectedModel),
        pendingPermission: clean(state.pendingPermission),
        pendingQuestion: clean(state.pendingQuestion),
        pendingPlanApproval: clean(state.pendingPlanApproval),
        setupProgress: clean(state.setupProgress),
        compactionStatus: clean(state.compactionStatus),
        compactionSwitch: clean(state.compactionSwitch),
        messageQueue: clean(state.messageQueue),
        backgroundTasks: clean(state.backgroundTasks),
        securedKeys: clean(state.securedKeys),
        agentColorMap: clean(state.agentColorMap),
        gstackMode: clean(state.gstackMode),
      };
    });

    // Clean up cross-store session data (dynamic imports to avoid circular deps)
    import('./ui.store').then(({ useUIStore }) => {
      useUIStore.getState().cleanupSessionBrowser(sessionId);
      useUIStore.getState().clearPlanContent(sessionId);
      useUIStore.getState().clearHtmlArtifact(sessionId);
    });

    // Clean up TTS audio chunks keyed by messageId
    if (messageIds.length > 0) {
      import('./audio.store').then(({ useAudioStore }) => {
        useAudioStore.getState().clearSessionTTS(messageIds);
      });
    }
  },

  updateSession: async (sessionId, updates) => {
    if (!hasElectronAPI) return;
    const session = await window.electronAPI.sessions.update(sessionId, updates);
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? session : s)),
    }));
  },

  refreshSessionBranch: async (sessionId) => {
    if (!hasElectronAPI) return null;
    try {
      const session = get().sessions.find(s => s.id === sessionId);
      if (!session) return null;

      // For SSH sessions, use the remote branch query
      let currentBranch: string | null = null;
      if (session.sshConfig) {
        currentBranch = await window.electronAPI.git.getRemoteBranch(sessionId);
      } else {
        const status = await withMaterializedSession(sessionId, () => window.electronAPI.git.getStatus(sessionId));
        currentBranch = status?.current || null;
      }
      if (!currentBranch) return null;

      // Check if branch changed
      if (session.branch !== currentBranch) {
        // Update the session with the new branch
        const updatedSession = await window.electronAPI.sessions.update(sessionId, { branch: currentBranch });
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? updatedSession : s)),
        }));
        console.log(`[SessionStore] Branch updated: ${session.branch} → ${currentBranch}`);
      }
      return currentBranch;
    } catch (error) {
      console.error('[SessionStore] Failed to refresh branch:', error);
      return null;
    }
  },

  subscribeToSessionChanges: () => {
    if (!hasElectronAPI) return noop;

    // Subscribe to individual session status changes
    const unsubscribeStatus = window.electronAPI.sessions.onStatusChanged((session) => {
      if (!session?.id) return;
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
        htmlRenderMode: session.htmlRenderMode === 'md' || session.htmlRenderMode === 'html'
          ? {
              ...state.htmlRenderMode,
              [session.id]: session.htmlRenderMode,
            }
          : state.htmlRenderMode,
      }));
    });

    // Subscribe to full session list updates (from background discovery)
    const unsubscribeList = window.electronAPI.sessions.onListUpdated((sessions) => {
      const current = get();
      if (hasSameSessionListIdentity(current.sessions, sessions)) {
        if (current.isLoadingSessions) {
          set({ isLoadingSessions: false });
        }
        return;
      }
      console.log('[SessionStore] Received sessions update from background discovery:', sessions.length);
      set({ sessions, isLoadingSessions: false, htmlRenderMode: collectSessionHtmlRenderModes(sessions) });
    });

    return () => {
      unsubscribeStatus();
      unsubscribeList();
    };
  },

  // Agent colour assignment — deterministic mapping of agentId to colour
  getAgentColor: (sessionId, agentId) => {
    const state = get();
    const sessionMap = state.agentColorMap[sessionId] || {};
    if (agentId in sessionMap) {
      return AGENT_COLORS[sessionMap[agentId] % AGENT_COLORS.length];
    }
    // Assign next colour index
    const nextIndex = Object.keys(sessionMap).length;
    set((s) => ({
      agentColorMap: {
        ...s.agentColorMap,
        [sessionId]: {
          ...(s.agentColorMap[sessionId] || {}),
          [agentId]: nextIndex,
        },
      },
    }));
    return AGENT_COLORS[nextIndex % AGENT_COLORS.length];
  },

  // Chat methods
  addMessage: (sessionId, message) => {
    const normalizedMessage = normalizeChatMessageTimestamp(message);
    set((state) => {
      const existingMessages = state.messages[sessionId] || [];
      const lastMessage = existingMessages[existingMessages.length - 1];
      const isDuplicateAssistantMessage =
        normalizedMessage.role === 'assistant' &&
        lastMessage?.role === 'assistant' &&
        lastMessage.id === normalizedMessage.id;

      if (isDuplicateAssistantMessage) {
        console.warn(
          `[SessionStore] Ignoring duplicate assistant message for ${sessionId}`
          + ` | id=${normalizedMessage.id} contentLen=${(normalizedMessage.content || '').length}`
          + ` toolCalls=${normalizedMessage.toolCalls?.length || 0}`
        );
        return state;
      }

      // Defense in depth against stale/resurrected stream finalizations
      // (deferred STREAM_END + resume races can re-finalize buffered content
      // under a NEW id): drop assistant messages whose content exactly
      // duplicates a recent existing message, regardless of id.
      if (normalizedMessage.role === 'assistant') {
        const isResurrectedDuplicate = existingMessages.some((existing) =>
          existing.role === 'assistant'
          && isExactLongAssistantDuplicate(existing, normalizedMessage)
          && Math.abs(
            normalizeChatMessageTimestamp(existing).timestamp.getTime()
            - normalizedMessage.timestamp.getTime()
          ) < 300_000
        );
        if (isResurrectedDuplicate) {
          console.warn(
            `[SessionStore] Ignoring content-duplicate assistant message for ${sessionId}`
            + ` | id=${normalizedMessage.id} contentLen=${(normalizedMessage.content || '').length}`
          );
          return state;
        }
      }

      return {
        messages: {
          ...state.messages,
          [sessionId]: [...existingMessages, normalizedMessage],
        },
      };
    });

    // Diagnostic: log addMessage result
    const afterMessages = get().messages[sessionId] || [];
    const afterAssistantCount = afterMessages.filter(m => m.role === 'assistant').length;
    if (normalizedMessage.role === 'assistant') {
      console.log(
        `[SessionStore] addMessage result for ${sessionId.substring(0, 8)}: ${afterAssistantCount} assistant messages total`
        + ` | added id=${normalizedMessage.id?.substring(0, 16)} contentLen=${(normalizedMessage.content || '').length}`
      );
    }
  },

  updateStreamContent: (sessionId, content, agentId?) => {
    set((state) => {
      const existingEvents = state.streamEvents[sessionId] || [];
      const lastEvent = existingEvents[existingEvents.length - 1];

      // If the last event is already a text event from the SAME agent, update it instead of creating a new one
      if (lastEvent && lastEvent.type === 'text' && lastEvent.agentId === agentId) {
        const updatedEvents = [...existingEvents];
        updatedEvents[updatedEvents.length - 1] = {
          ...lastEvent,
          content: (lastEvent.content || '') + content,
        };

        return {
          currentStreamContent: {
            ...state.currentStreamContent,
            [sessionId]: (state.currentStreamContent[sessionId] || '') + content,
          },
          streamEvents: {
            ...state.streamEvents,
            [sessionId]: updatedEvents,
          },
        };
      }

      // Otherwise, create a new text event (different agent or first event)
      return {
        currentStreamContent: {
          ...state.currentStreamContent,
          [sessionId]: (state.currentStreamContent[sessionId] || '') + content,
        },
        streamEvents: {
          ...state.streamEvents,
          [sessionId]: [
            ...existingEvents,
            { id: `text-${Date.now()}`, type: 'text', timestamp: Date.now(), content, agentId },
          ],
        },
      };
    });
  },

  updateThinkingContent: (sessionId, content) => {
    // Thinking is now displayed separately, not in the chronological stream
    set((state) => ({
      currentThinkingContent: {
        ...state.currentThinkingContent,
        [sessionId]: capTextTail((state.currentThinkingContent[sessionId] || '') + content, MAX_LIVE_THINKING_CHARS),
      },
    }));

    // Send thinking updates to ElevenLabs agent (if voice mode active)
    // Format as [THINKING] so agent knows to narrate it
    const audioState = useAudioStore.getState();
    const voiceModeEnabled = !!audioState.settings?.voiceModeEnabled;
    const voiceConnected = !!audioState.voiceModeStates[sessionId]?.isConnected;

    if (window.electronAPI?.voice && voiceModeEnabled && voiceConnected) {
      window.electronAPI.voice.sendContextUpdate(`[THINKING] ${content}`).catch((err: Error) => {
        console.error('[SessionStore] Failed to send thinking to voice:', err);
      });
    }
  },

  addToolCall: (sessionId, toolCall) => {
    const normalizedToolCall = normalizeToolCall(toolCall);
    set((state) => {
      const existingToolCalls = state.currentToolCalls[sessionId] || [];
      const existingIndex = existingToolCalls.findIndex(tc => tc.id === normalizedToolCall.id);
      const markActive = isUnfinishedToolCall(normalizedToolCall) && !isQueueDrainSuppressed(sessionId);
      const activeState = markActive
        ? {
            isStreaming: { ...state.isStreaming, [sessionId]: true },
            sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' as const },
            streamStartTime: {
              ...state.streamStartTime,
              [sessionId]: state.streamStartTime[sessionId] || Date.now(),
            },
            activeStreamModel: {
              ...state.activeStreamModel,
              [sessionId]: state.activeStreamModel[sessionId] || getSessionModel(state, sessionId),
            },
          }
        : {};

      // If tool call already exists, update it instead of adding duplicate
      if (existingIndex !== -1) {
        const updatedToolCalls = [...existingToolCalls];
        updatedToolCalls[existingIndex] = mergeToolCall(existingToolCalls[existingIndex], normalizedToolCall);
        return {
          ...activeState,
          currentToolCalls: {
            ...state.currentToolCalls,
            [sessionId]: updatedToolCalls,
          },
          // Don't add duplicate to streamEvents, just keep existing
          streamEvents: state.streamEvents,
        };
      }

      // New tool call - add to both arrays
      return {
        ...activeState,
        currentToolCalls: {
          ...state.currentToolCalls,
          [sessionId]: [...existingToolCalls, normalizedToolCall],
        },
        streamEvents: {
          ...state.streamEvents,
          [sessionId]: [
            ...(state.streamEvents[sessionId] || []),
            { id: normalizedToolCall.id, type: 'tool', timestamp: Date.now(), toolCall: normalizedToolCall, agentId: normalizedToolCall.agentId },
          ],
        },
      };
    });
  },

  updateToolCall: (sessionId, toolCallId, updates) => {
    set((state) => ({
      currentToolCalls: {
        ...state.currentToolCalls,
        [sessionId]: (state.currentToolCalls[sessionId] || []).map((tc) =>
          tc.id === toolCallId ? mergeToolCall(tc, updates) : tc
        ),
      },
      streamEvents: {
        ...state.streamEvents,
        [sessionId]: (state.streamEvents[sessionId] || []).map((event) =>
          event.toolCall?.id === toolCallId
            ? { ...event, toolCall: mergeToolCall(event.toolCall, updates) }
            : event
        ),
      },
    }));
  },

  setStreaming: (sessionId, isStreaming) => {
    console.log(`[SessionStore] setStreaming called for ${sessionId}: ${isStreaming}`);

    set((state) => ({
      isStreaming: { ...state.isStreaming, [sessionId]: isStreaming },
      sessionActivity: {
        ...state.sessionActivity,
        [sessionId]: isStreaming ? 'active' : 'waiting',
      },
      activeStreamModel: isStreaming
        ? state.activeStreamModel
        : { ...state.activeStreamModel, [sessionId]: undefined },
      activeUserPrompt: isStreaming
        ? state.activeUserPrompt
        : { ...state.activeUserPrompt, [sessionId]: null },
      // Keep the last routing decision across stream transitions — a new
      // decision will overwrite it when the next auto-route completes.
      // Clear stream state on BOTH transitions: starting (fresh slate) and
      // ending (content has been finalized into a message by onStreamEnd).
      // Without clearing on end, stale streamEvents linger and flash away
      // when the next stream starts.
      streamEvents: { ...state.streamEvents, [sessionId]: [] },
      currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
      currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
      currentToolCalls: isStreaming
        ? { ...state.currentToolCalls, [sessionId]: [] }
        : state.currentToolCalls,
      currentSystemInfo: isStreaming
        ? { ...state.currentSystemInfo, [sessionId]: null }
        : state.currentSystemInfo,
      // Reset agent colour assignments when starting a new streaming session
      agentColorMap: isStreaming
        ? { ...state.agentColorMap, [sessionId]: {} }
        : state.agentColorMap,
    }));

    // Queue draining is handled by STREAM_END/STREAM_ERROR after the terminal
    // event has been associated with a message. Doing it here races with stale
    // cancel events and can start a second CLI process while the first is alive.
  },

  setSystemInfo: (sessionId, systemInfo) => {
    set((state) => ({
      currentSystemInfo: {
        ...state.currentSystemInfo,
        [sessionId]: systemInfo,
      },
    }));
  },

  setPermissionMode: (sessionId, mode) => {
    const state = get();
    const model = getSessionModel(state, sessionId);
    const normalizedMode = normalizePermissionModeForModel(model, mode);
    const currentMode = normalizePermissionModeForModel(model, state.permissionMode[sessionId]);
    if (
      normalizedMode !== currentMode &&
      hasActiveOrQueuedTurn(state, sessionId) &&
      !canChangePermissionModeDuringActiveTurn(normalizedMode)
    ) {
      console.warn(`[SessionStore] Ignoring permission mode change to ${normalizedMode} while turn is active or queued for ${sessionId}`);
      return;
    }

    // Update local state
    set((state) => ({
      permissionMode: {
        ...state.permissionMode,
        [sessionId]: normalizedMode,
      },
    }));

    // Notify backend for active queries (JUST BUILD IT button mid-stream)
    persistPermissionMode(sessionId, normalizedMode);
  },

  // Command Center management
  addToCommandCenter: (sessionId) => {
    // Always resolve to root session ID so forks are grouped, not separate cells
    const { sessions } = get();
    let rootId = sessionId;
    let session = sessions.find(s => s.id === rootId);
    while (session?.parentSessionId) {
      rootId = session.parentSessionId;
      session = sessions.find(s => s.id === rootId);
    }
    set((state) => {
      if (state.commandCenterSessionIds.includes(rootId)) return state;
      const updated = [...state.commandCenterSessionIds, rootId];
      try { localStorage.setItem('grep-command-center-sessions', JSON.stringify(updated)); } catch (e) { /* ignore */ }
      return { commandCenterSessionIds: updated };
    });
  },

  removeFromCommandCenter: (sessionId) => {
    // Also resolve to root for consistency
    const { sessions } = get();
    let rootId = sessionId;
    let session = sessions.find(s => s.id === rootId);
    while (session?.parentSessionId) {
      rootId = session.parentSessionId;
      session = sessions.find(s => s.id === rootId);
    }
    set((state) => {
      const updated = state.commandCenterSessionIds.filter(id => id !== rootId);
      try { localStorage.setItem('grep-command-center-sessions', JSON.stringify(updated)); } catch (e) { /* ignore */ }
      return { commandCenterSessionIds: updated };
    });
  },

  initCommandCenterFromStarred: () => {
    const state = get();
    // Only initialise if the list is empty
    if (state.commandCenterSessionIds.length > 0) return;
    const starred = state.sessions
      .filter(s => s.isStarred)
      .sort((a, b) => {
        const aTime = a.starredAt ? new Date(a.starredAt).getTime() : 0;
        const bTime = b.starredAt ? new Date(b.starredAt).getTime() : 0;
        return aTime - bTime;
      })
      .map(s => s.id);
    if (starred.length > 0) {
      set({ commandCenterSessionIds: starred });
      try { localStorage.setItem('grep-command-center-sessions', JSON.stringify(starred)); } catch (e) { /* ignore */ }
    }
  },

  setGStackMode: (sessionId, mode) => {
    set((state) => ({
      gstackMode: { ...state.gstackMode, [sessionId]: mode },
    }));
    // Persist to session
    if (hasElectronAPI) {
      window.electronAPI.sessions.update(sessionId, { gstackMode: mode || undefined }).catch((err: Error) => {
        console.error('[SessionStore] Failed to persist gstackMode:', err);
      });
    }
  },

  cyclePermissionMode: (sessionId) => {
    const state = get();
    if (hasActiveOrQueuedTurn(state, sessionId)) {
      console.warn(`[SessionStore] Ignoring permission mode cycle while turn is active or queued for ${sessionId}`);
      return;
    }

    const model = getSessionModel(state, sessionId);
    const modes = getSupportedPermissionModes(model);
    const currentMode = normalizePermissionModeForModel(model, state.permissionMode[sessionId]);
    const currentIndex = modes.indexOf(currentMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];

    set((state) => ({
      permissionMode: {
        ...state.permissionMode,
        [sessionId]: nextMode,
      },
    }));

    persistPermissionMode(sessionId, nextMode);
  },

  setThinkingMode: (sessionId, mode) => {
    set((state) => ({
      thinkingMode: {
        ...state.thinkingMode,
        [sessionId]: mode,
      },
    }));
  },

  cycleThinkingMode: (sessionId) => {
    const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    set((state) => {
      const currentMode = state.thinkingMode[sessionId] || 'high';
      // Migrate old value if present
      const migratedMode = migrateThinkingMode(currentMode);
      const currentIndex = effortLevels.indexOf(migratedMode);
      const nextIndex = (currentIndex + 1) % effortLevels.length;
      return {
        thinkingMode: {
          ...state.thinkingMode,
          [sessionId]: effortLevels[nextIndex],
        },
      };
    });
  },

  setHtmlRenderMode: (sessionId, mode) => {
    set((state) => ({
      htmlRenderMode: {
        ...state.htmlRenderMode,
        [sessionId]: mode,
      },
    }));
    // Persist to session object so main process can read it
    get().updateSession(sessionId, { htmlRenderMode: mode });
  },

  cycleHtmlRenderMode: (sessionId) => {
    const current = get().htmlRenderMode[sessionId] || 'md';
    const next = current === 'md' ? 'html' : 'md';
    set((state) => ({
      htmlRenderMode: {
        ...state.htmlRenderMode,
        [sessionId]: next,
      },
    }));
    get().updateSession(sessionId, { htmlRenderMode: next });
  },

  setFastMode: (enabled) => {
    set({ fastMode: enabled });
    localStorage.setItem('grep-fast-mode', JSON.stringify(enabled));
  },
  toggleFastMode: () => {
    const next = !get().fastMode;
    set({ fastMode: next });
    localStorage.setItem('grep-fast-mode', JSON.stringify(next));
  },

  setSelectedModel: (sessionId, model, trigger = 'model-picker') => {
    const state = get();
    const previousModel = getSessionModel(state, sessionId);
    const isManualPickerChange = trigger === 'model-picker' && previousModel !== model;
    const hasLocalActiveWork = Boolean(
      state.isStreaming[sessionId] ||
      state.isProcessingQueue[sessionId] ||
      state.activeStreamModel[sessionId] ||
      state.activeUserPrompt[sessionId] ||
      (state.messageQueue[sessionId]?.length ?? 0) > 0,
    );

    // A manual picker change is a hard boundary: any previously routed Auto
    // harness must not keep running or drain queued prompts under the old model.
    if (isManualPickerChange && hasLocalActiveWork) {
      console.log(`[SessionStore] Model switch with active work — cancelling current stream for ${sessionId}`);
      state.cancelStream(sessionId);
    } else if (isManualPickerChange && hasElectronAPI) {
      void window.electronAPI.claude.cancel(sessionId).then(() => {
        console.log(`[SessionStore] Model switch sent backend cancel for ${sessionId}`);
      }).catch((err: Error) => {
        console.warn('[SessionStore] Failed to cancel backend work during model switch:', err);
      });
    }

    const normalizedPermissionMode = normalizePermissionModeForModel(model, state.permissionMode[sessionId]);

    set((state) => ({
      selectedModel: {
        ...state.selectedModel,
        [sessionId]: model,
      },
      permissionMode: {
        ...state.permissionMode,
        [sessionId]: normalizedPermissionMode,
      },
      autoRouteDecision: model === 'auto'
        ? state.autoRouteDecision
        : { ...state.autoRouteDecision, [sessionId]: null },
      activeStreamModel: model === 'auto'
        ? state.activeStreamModel
        : { ...state.activeStreamModel, [sessionId]: undefined },
      activeMetaGoals: model === 'auto'
        ? state.activeMetaGoals
        : { ...state.activeMetaGoals, [sessionId]: null },
      compactionSwitch: state.compactionSwitch[sessionId]
        ? { ...state.compactionSwitch, [sessionId]: null }
        : state.compactionSwitch,
    }));

    persistModelSelection(sessionId, model, normalizedPermissionMode);
    if (hasElectronAPI && previousModel !== model) {
      window.electronAPI.analytics.recordHarnessSelection?.({
        sessionId,
        timestamp: Date.now(),
        fromModel: previousModel,
        toModel: model,
        trigger,
        isManualSelection: model !== 'auto',
      }).catch((err: Error) => {
        console.warn('[SessionStore] Failed to record harness selection:', err);
      });
    }
  },

  loadAvailableModels: async () => {
    if (!hasElectronAPI) return;
    try {
      const models = await window.electronAPI.claude.getModels();
      set({ availableModels: models });

      // Migration: Fix any sessions using old incorrect Opus 4.6 ID
      const state = get();
      const fixedSelections: Record<string, string> = {};
      let needsUpdate = false;

      for (const [sessionId, modelId] of Object.entries(state.selectedModel)) {
        // Old wrong IDs to migrate
        if (modelId === 'claude-opus-4-6-20260125' || modelId === 'claude-opus-4-5-20251101') {
          fixedSelections[sessionId] = 'claude-opus-4-7';
          needsUpdate = true;
          console.log(`[SessionStore] Migrating session ${sessionId} from ${modelId} to Opus 4.7`);
        } else if (modelId === 'codex') {
          fixedSelections[sessionId] = 'codex:o3';
          needsUpdate = true;
          console.log(`[SessionStore] Migrating session ${sessionId} from 'codex' to 'codex:o3'`);
        } else if (modelId === 'codex:gpt-5.6') {
          fixedSelections[sessionId] = 'codex:gpt-5.6-sol';
          needsUpdate = true;
        } else if (modelId === 'codex:gpt-5.6-codex') {
          fixedSelections[sessionId] = 'codex:gpt-5.6-sol';
          needsUpdate = true;
        } else if (modelId === 'codex:gpt-5.6-mini') {
          fixedSelections[sessionId] = 'codex:gpt-5.6-luna';
          needsUpdate = true;
        } else {
          fixedSelections[sessionId] = modelId;
        }
      }

      if (needsUpdate) {
        set({ selectedModel: fixedSelections });
      }
    } catch (error) {
      console.error('[SessionStore] Failed to load available models:', error);
    }
  },

  sendMessage: async (sessionId, message, attachments, opts) => {
    if (!hasElectronAPI) return;
    let state = get();
    const suppressUserMessage = Boolean(opts?.suppressUserMessage);
    const fromQueueDrain = Boolean(opts?.fromQueueDrain);
    const goalObjective = parseGoalSlashCommand(message);
    if (!suppressUserMessage) {
      set((state) => ({
        activeMetaGoals: {
          ...state.activeMetaGoals,
          [sessionId]: goalObjective
            ? {
              objective: goalObjective,
              source: 'slash-command',
              status: 'active',
              iterations: 0,
              maxIterations: META_GOAL_MAX_ITERATIONS,
              updatedAt: Date.now(),
            }
            : null,
        },
      }));
    }
    const currentIsStreaming = state.isStreaming[sessionId];
    const currentQueueLength = (state.messageQueue[sessionId] || []).length;

    const currentIsProcessingQueue = state.isProcessingQueue[sessionId];

    if (DEBUG_SESSION_SEND) {
      console.log(`[SessionStore] sendMessage called for session ${sessionId}`);
      console.log(`[SessionStore] isStreaming: ${currentIsStreaming}, isProcessingQueue: ${currentIsProcessingQueue}, queueLength: ${currentQueueLength}`);
      console.log(`[SessionStore] Message: "${message.slice(0, 80)}..."`);
    }

    if (
      !fromQueueDrain &&
      !suppressUserMessage &&
      !opts?.existingMessageId &&
      hasRecentUnansweredDuplicateUserPrompt(state, sessionId, message)
    ) {
      console.warn(`[SessionStore] Suppressing duplicate unanswered user prompt for ${sessionId}`);
      return;
    }

    // If the user sends a quick follow-up before the agent has visibly started,
    // restart the turn with both prompts together instead of making the second
    // prompt wait behind a doomed first draft.
    if (
      !fromQueueDrain &&
      !suppressUserMessage &&
      state.isStreaming[sessionId] &&
      !state.isProcessingQueue[sessionId] &&
      currentQueueLength === 0 &&
      state.activeUserPrompt[sessionId] &&
      !state.activeUserPrompt[sessionId]?.suppressUserMessage &&
      !hasVisibleAssistantActivity(state, sessionId)
    ) {
      const activePrompt = state.activeUserPrompt[sessionId]!;
      const combinedMessage = combineUserPrompts(activePrompt.message, message);
      const combinedAttachments = [
        ...(activePrompt.attachments || []),
        ...(attachments || []),
      ];
      const combinedUserMessage: ChatMessage = {
        id: activePrompt.id,
        role: 'user',
        content: combinedMessage,
        attachments: combinedAttachments as ChatMessage['attachments'],
        timestamp: new Date(activePrompt.timestamp),
        harness: harnessFromModel(activePrompt.model || state.activeStreamModel[sessionId] || state.selectedModel[sessionId]),
      };

      console.log('[SessionStore] Coalescing early follow-up into active prompt:', {
        sessionId: sessionId.substring(0, 8),
        originalLength: activePrompt.message.length,
        followupLength: message.length,
        combinedLength: combinedMessage.length,
      });

      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: (state.messages[sessionId] || []).map((existingMessage) =>
            existingMessage.id === activePrompt.id ? combinedUserMessage : existingMessage
          ),
        },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
      }));

      if (isNonClaudeHarness(activePrompt.model) || activePrompt.model === 'auto') {
        persistSupplementalMessage(sessionId, combinedUserMessage);
      }

      await window.electronAPI.claude.cancel(sessionId);
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
        messageQueue: { ...state.messageQueue, [sessionId]: [] },
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
        streamGeneration: {
          ...state.streamGeneration,
          [sessionId]: (state.streamGeneration[sessionId] || 0) + 1,
        },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
        currentSystemInfo: { ...state.currentSystemInfo, [sessionId]: null },
      }));

      await new Promise((resolve) => setTimeout(resolve, 300));
      get().sendMessage(
        sessionId,
        combinedMessage,
        combinedAttachments.length > 0 ? combinedAttachments : undefined,
        { existingMessageId: activePrompt.id },
      );
      return;
    }

    let backendActiveQuery = false;
    let remoteActiveProcess = false;
    if (!fromQueueDrain && !state.isStreaming[sessionId] && !state.isProcessingQueue[sessionId]) {
      backendActiveQuery = await window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false);
      if (!backendActiveQuery) {
        const currentSession = state.sessions.find((session) => session.id === sessionId);
        remoteActiveProcess = currentSession?.sshConfig
          ? await window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false)
          : false;
      }
      if (backendActiveQuery || remoteActiveProcess) {
        console.warn(
          backendActiveQuery
            ? `[SessionStore] Backend still has active query for ${sessionId}; queueing instead of starting duplicate turn`
            : `[SessionStore] Remote Claude process still active for ${sessionId}; queueing before stream state reset`
        );
        state = get();
      }
    }

    // If already streaming, queue handoff is in progress, or the backend still
    // owns an active query after renderer state went stale, queue the message.
    if (!fromQueueDrain && (state.isStreaming[sessionId] || state.isProcessingQueue[sessionId] || backendActiveQuery || remoteActiveProcess)) {
      const normalizedMessage = message.trim();
      const existingQueue = state.messageQueue[sessionId] || [];
      const recentlyQueuedSame = normalizedMessage.length > 0 && existingQueue.some((queuedMessage) =>
        queuedMessage.message.trim() === normalizedMessage && Date.now() - queuedMessage.timestamp < 10_000
      );
      if (recentlyQueuedSame) {
        console.warn(`[SessionStore] Suppressing duplicate queued message for ${sessionId}`);
        return;
      }

      const queuedMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        message,
        attachments,
        timestamp: Date.now(),
        suppressUserMessage,
      };
      // Show the user message in chat IMMEDIATELY with a "queued" flag so the
      // user knows their input was received. Without this, the input clears
      // but nothing visible happens — users think the send silently failed
      // and re-type the same message.
      const userMessage: ChatMessage | undefined = suppressUserMessage ? undefined : {
        id: queuedMsg.id,
        role: 'user',
        content: message,
        timestamp: new Date(queuedMsg.timestamp),
        harness: harnessFromModel(state.selectedModel[sessionId]),
        attachments: (attachments as ChatMessage['attachments'])?.length ? attachments as ChatMessage['attachments'] : undefined,
      };
      const model = state.selectedModel[sessionId] || 'auto';
      set((state) => ({
        messages: userMessage ? {
          ...state.messages,
          [sessionId]: [...(state.messages[sessionId] || []), userMessage],
        } : state.messages,
        messageQueue: {
          ...state.messageQueue,
          [sessionId]: [
            ...(state.messageQueue[sessionId] || []),
            queuedMsg,
          ],
        },
        isProcessingQueue: remoteActiveProcess
          ? { ...state.isProcessingQueue, [sessionId]: true }
          : state.isProcessingQueue,
        sessionActivity: remoteActiveProcess
          ? { ...state.sessionActivity, [sessionId]: 'waiting' }
          : state.sessionActivity,
      }));
      console.log(`[SessionStore] Message queued${suppressUserMessage ? '' : ' + shown in chat'}. Queue length:`, (state.messageQueue[sessionId] || []).length + 1);
      console.log('[SessionStore] Queued message preview:', message.slice(0, 50));

      // Also enqueue in main process (source of truth for drain timing)
      window.electronAPI.queue?.enqueue(sessionId, message, attachments, {
        id: queuedMsg.id,
        model,
        suppressUserMessage,
        deferDrain: remoteActiveProcess || undefined,
      });

      if (remoteActiveProcess) {
        console.log(`[SessionStore] Remote Claude process still active for ${sessionId}; queued message and requesting reattach`);
        const { loadMessages } = get();
        startRemoteProcessMonitor(sessionId, get, set, loadMessages, {
          recoverableKnown: true,
          attachStream: true,
        });
      }

      return;
    }

    if (fromQueueDrain && (state.isStreaming[sessionId] || state.isProcessingQueue[sessionId])) {
      console.warn(`[SessionStore] queue drain forcing stale stream flags clear for ${sessionId}`);
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'waiting' },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
      }));
      state = get();
    }

    const { addMessage, setStreaming, permissionMode, thinkingMode, selectedModel, gstackMode } = state;
    const model = selectedModel[sessionId] || 'auto';
    const mode = normalizePermissionModeForModel(model, permissionMode[sessionId]);
    // Apply migration to handle old thinking mode values, default to 'high' (full capability)
    const thinking = migrateThinkingMode(thinkingMode[sessionId] || 'high');
    const activeGStackMode = gstackMode[sessionId] || undefined; // Pass GStack mode directly
    console.log('[SessionStore] sendMessage - sessionId:', sessionId, 'permissionMode:', mode, 'gstackMode:', activeGStackMode, 'raw:', permissionMode[sessionId]);

    // Update session's updatedAt timestamp for recent activity and mark as idle (user sent a message).
    // Persist to backend immediately (not after streaming completes) so the
    // timestamp survives app restarts during long-running queries.
    const now = new Date();
    set((state) => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? { ...session, updatedAt: now }
          : session
      ),
      sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
    }));
    window.electronAPI.sessions.update(sessionId, { updatedAt: now });

    // Add the user's message before slower async preprocessing so pressing
    // Enter always produces immediate visible feedback in the chat.
    const existingMessages = get().messages[sessionId] || [];
    const alreadyInChat =
      !!opts?.existingMessageId &&
      existingMessages.some((m) => m.id === opts!.existingMessageId);
    const userMessage: ChatMessage = {
      id: opts?.existingMessageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      role: 'user',
      content: message,
      timestamp: new Date(),
      harness: harnessFromModel(model),
      attachments: (attachments as ChatMessage['attachments'])?.length ? attachments as ChatMessage['attachments'] : undefined,
    };
    if (!suppressUserMessage && !alreadyInChat) {
      addMessage(sessionId, userMessage);
    }

    const previousStreamSnapshot = {
      events: get().streamEvents[sessionId] || [],
      content: get().currentStreamContent[sessionId] || '',
      thinking: get().currentThinkingContent[sessionId] || '',
      toolCalls: get().currentToolCalls[sessionId] || [],
    };
    const hasPreviousStreamSnapshot = Boolean(
      previousStreamSnapshot.events.length
      || previousStreamSnapshot.content.trim()
      || previousStreamSnapshot.thinking.trim()
      || previousStreamSnapshot.toolCalls.length
    );

    // Start streaming immediately so the input area moves into queued/send state
    // before remote probes, key scanning, or transcript checks complete.
    setStreaming(sessionId, true);
    set((state) => ({
      streamGeneration: {
        ...state.streamGeneration,
        [sessionId]: (state.streamGeneration[sessionId] || 0) + 1,
      },
      streamStartTime: {
        ...state.streamStartTime,
        [sessionId]: Date.now(),
      },
      activeStreamModel: {
        ...state.activeStreamModel,
        [sessionId]: model,
      },
      activeUserPrompt: {
        ...state.activeUserPrompt,
        [sessionId]: {
          id: userMessage.id,
          message,
          attachments,
          timestamp: userMessage.timestamp.getTime(),
          model,
          suppressUserMessage,
        },
      },
    }));

    if (!fromQueueDrain) {
      const currentSession = get().sessions.find((session) => session.id === sessionId);
      const remoteActive = currentSession?.sshConfig
        ? await window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false)
        : false;

      if (remoteActive) {
        const queuedMsg = {
          id: userMessage.id,
          message,
          attachments,
          timestamp: userMessage.timestamp.getTime(),
          suppressUserMessage,
        };

        set((state) => ({
          isStreaming: { ...state.isStreaming, [sessionId]: false },
          messageQueue: {
            ...state.messageQueue,
            [sessionId]: [
              ...(state.messageQueue[sessionId] || []),
              queuedMsg,
            ],
          },
          isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: true },
          sessionActivity: { ...state.sessionActivity, [sessionId]: 'waiting' },
          activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
          activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
          streamEvents: hasPreviousStreamSnapshot
            ? { ...state.streamEvents, [sessionId]: previousStreamSnapshot.events }
            : state.streamEvents,
          currentStreamContent: hasPreviousStreamSnapshot
            ? { ...state.currentStreamContent, [sessionId]: previousStreamSnapshot.content }
            : state.currentStreamContent,
          currentThinkingContent: hasPreviousStreamSnapshot
            ? { ...state.currentThinkingContent, [sessionId]: previousStreamSnapshot.thinking }
            : state.currentThinkingContent,
          currentToolCalls: hasPreviousStreamSnapshot
            ? { ...state.currentToolCalls, [sessionId]: previousStreamSnapshot.toolCalls }
            : state.currentToolCalls,
        }));

        window.electronAPI.queue?.enqueue(sessionId, message, attachments, {
          id: queuedMsg.id,
          model,
          suppressUserMessage,
          deferDrain: true,
        });
        console.log(`[SessionStore] Remote Claude process still active for ${sessionId}; queued message after optimistic send and requesting reattach`);
        const { loadMessages } = get();
        startRemoteProcessMonitor(sessionId, get, set, loadMessages, {
          recoverableKnown: true,
          attachStream: true,
        });
        return;
      }
    }

    // Intercept and secure any API keys/tokens in the message. The chat bubble
    // is already visible, so fall back to the original text if scanning fails.
    let modifiedText = message;
    let keysDetected: Array<{ id: string; type: string; description: string }> = [];
    try {
      const secureResult = await window.electronAPI.secureKeys.interceptAndReplace(sessionId, message);
      modifiedText = secureResult.modifiedText;
      keysDetected = secureResult.keysDetected || [];
    } catch (error) {
      console.warn('[SessionStore] Secure-key scan failed; sending original text:', error);
    }

    let outboundUserMessage = userMessage;
    if (modifiedText !== message) {
      outboundUserMessage = { ...userMessage, content: modifiedText };
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: (state.messages[sessionId] || []).map((existingMessage) =>
            existingMessage.id === userMessage.id ? outboundUserMessage : existingMessage
          ),
        },
        activeUserPrompt: {
          ...state.activeUserPrompt,
          [sessionId]: state.activeUserPrompt[sessionId]
            ? { ...state.activeUserPrompt[sessionId], message: modifiedText }
            : state.activeUserPrompt[sessionId],
        },
      }));
    }

    // Log if keys were detected (without revealing the actual keys)
    if (keysDetected.length > 0) {
      console.log(`[SessionStore] 🔒 Intercepted ${keysDetected.length} API key(s):`, keysDetected.map(k => k.description));
      // Show notification to user that keys were secured
      set((state) => ({
        securedKeys: {
          ...state.securedKeys,
          [sessionId]: keysDetected,
        },
      }));
    }

    const hasAuthoritativeBuildTranscript = await hasBuildTranscriptForHydration(sessionId);
    const supplementalMessagesForContext = hasAuthoritativeBuildTranscript
      ? []
      : loadSupplementalMessagesForModelContext(sessionId);
    if (hasAuthoritativeBuildTranscript && loadSupplementalMessages(sessionId).length > 0) {
      console.log(`[SessionStore] Build transcript exists for ${sessionId}; not sending supplemental local fallback as model context`);
    }

    if (!suppressUserMessage && (isNonClaudeHarness(model) || model === 'auto')) {
      persistSupplementalMessage(sessionId, outboundUserMessage);
    }

    try {
      console.log('[SessionStore] Calling electronAPI.claude.sendMessage with', attachments?.length || 0, 'attachments, model:', model);
      console.log('[SessionStore] sendMessage params:', { sessionId: sessionId.substring(0, 8), messageLen: message.length, mode, thinking, model });

      const result = await window.electronAPI.claude.sendMessage(
        sessionId,
        modifiedText,
        attachments,
        mode,
        thinking,
        model,
        activeGStackMode,
        supplementalMessagesForContext,
        get().fastMode,
        suppressUserMessage,
        userMessage.id
      );
      console.log('[SessionStore] sendMessage returned:', result);
    } catch (error) {
      setStreaming(sessionId, false);
      const errorText = error instanceof Error ? error.message : String(error);
      const errorMessage: ChatMessage = {
        id: `send-error-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${errorText}`,
        timestamp: new Date(),
        harness: harnessFromModel(model),
      };
      persistSupplementalMessage(sessionId, errorMessage);
      addMessage(sessionId, errorMessage);
      console.error('[SessionStore] Failed to send message:', error);
      console.error('[SessionStore] Error stack:', error instanceof Error ? error.stack : 'No stack');
    }
  },

  loadMessages: async (sessionId, options = {}) => {
    if (!hasElectronAPI) return;

    const perfStart = performance.now();
    const RECENT_MESSAGE_LIMIT = 100;
    const loadGeneration = (messageLoadGenerations.get(sessionId) || 0) + 1;
    messageLoadGenerations.set(sessionId, loadGeneration);
    const isCurrentLoad = () => messageLoadGenerations.get(sessionId) === loadGeneration;

    set((state) => ({
      isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: true },
    }));

    const hasAuthoritativeBuildTranscript = await hasBuildTranscriptForHydration(sessionId);
    if (!isCurrentLoad()) {
      console.log(`[SessionStore] loadMessages: Ignoring stale hydration for ${sessionId}`);
      return;
    }

    const startedAsEmptyActiveSession = Boolean(get().isStreaming[sessionId] && (get().messages[sessionId] || []).length === 0);
    const applyLoadedMessages = (transcriptMessages: ChatMessage[], applyOptions: LoadedMessagesApplyOptions = {}) => {
      if (!isCurrentLoad()) {
        console.log(`[SessionStore] loadMessages: Ignoring stale apply for ${sessionId}`);
        return [];
      }

      const supplementalMessages = hasAuthoritativeBuildTranscript
        ? []
        : loadSupplementalMessages(sessionId);
      const mergedMessages = filterInternalPromptEchoes(mergeTimelineMessages(transcriptMessages || [], supplementalMessages))
        .filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));
      console.log(`[Perf] Message load took ${performance.now() - perfStart}ms (${mergedMessages.length} ${hasAuthoritativeBuildTranscript ? 'Build transcript' : 'merged'} messages)`);

      if (mergedMessages.length > 0) {
        set((state) => {
          if (!isCurrentLoad()) {
            console.log(`[SessionStore] loadMessages: Stale state apply skipped for ${sessionId}`);
            return {};
          }

          // Normal live streams own their in-memory state. Reconnected SSH
          // sessions have no attached stream reader, so poll the transcript.
          const existingMessages = state.messages[sessionId] || [];
          const allowStreamingReplace = options.replaceWhileStreaming || applyOptions.replaceWhileStreaming;
          if (state.isStreaming[sessionId] && !allowStreamingReplace && existingMessages.length > 0) {
            console.log(`[SessionStore] loadMessages: Skipping replacement for ${sessionId} — currently streaming`);
            return { isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false } };
          }
          if (state.isStreaming[sessionId] && !allowStreamingReplace && existingMessages.length === 0) {
            console.log(`[SessionStore] loadMessages: Hydrating empty active session from transcript for ${sessionId}`);
          }

          // Use the transcript as the loaded base, but never let hydration
          // delete messages that arrived in memory after the read started, or
          // non-Claude harness messages that may not exist in Claude-native logs.
          const finalMessages = mergeLoadedMessagesWithExisting(
            sessionId,
            mergedMessages,
            existingMessages,
            {
              authoritativeBuildTranscript: hasAuthoritativeBuildTranscript,
              partialTranscript: Boolean(applyOptions.requestedLimit && mergedMessages.length >= applyOptions.requestedLimit),
            }
          );

          const totalInput = mergedMessages.length + existingMessages.length;
          if (finalMessages.length < totalInput) {
            const assistantsBefore = existingMessages.filter(m => m.role === 'assistant').length
              + mergedMessages.filter(m => m.role === 'assistant').length;
            const assistantsAfter = finalMessages.filter(m => m.role === 'assistant').length;
            console.warn(
              `[SessionStore] mergeLoadedMessages for ${sessionId}: ${totalInput} input → ${finalMessages.length} output`
              + ` (loaded=${mergedMessages.length} existing=${existingMessages.length})`
              + ` | assistants: ${assistantsBefore} → ${assistantsAfter}`
            );
          }

          // Monotonicity guard: transcript hydration must never DROP assistant
          // messages that are already visible in the UI. If the merge lost
          // assistants, recover them by appending the missing messages back and
          // re-sorting. This is a defensive safety net — the diagnostic logging
          // below helps us find the merge-logic root cause.
          const existingAssistantCount = existingMessages.filter(m => m.role === 'assistant').length;
          const finalAssistantCount = finalMessages.filter(m => m.role === 'assistant').length;
          let safeFinalMessages = finalMessages;
          if (existingAssistantCount > 0 && finalAssistantCount < existingAssistantCount) {
            const finalIds = new Set(finalMessages.map(m => m.id));
            const lostAssistants = existingMessages.filter(
              m => m.role === 'assistant' && !finalIds.has(m.id)
            );
            if (lostAssistants.length > 0) {
              safeFinalMessages = mergeTimelineMessages(finalMessages, lostAssistants);
              console.error(
                `[SessionStore] 🚨 RECOVERED ${lostAssistants.length} lost assistant message(s) during hydration for ${sessionId.substring(0, 8)}`
                + ` | before=${existingAssistantCount} merged=${finalAssistantCount} recovered=${safeFinalMessages.filter(m => m.role === 'assistant').length}`
                + ` | lostIds=${lostAssistants.map(m => m.id?.substring(0, 16)).join(',')}`
                + ` | loaded=${mergedMessages.length} existing=${existingMessages.length}`
                + ` | isStreaming=${state.isStreaming[sessionId]} authoritativeBuildTranscript=${hasAuthoritativeBuildTranscript}`
                + ` | partialTranscript=${Boolean(applyOptions.requestedLimit && mergedMessages.length >= applyOptions.requestedLimit)}`
              );
            }
          }

          return {
            messages: { ...state.messages, [sessionId]: safeFinalMessages },
            isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
          };
        });
      } else {
        // No messages returned — clear loading flag
        set((state) => ({
          isLoadingMessages: isCurrentLoad()
            ? { ...state.isLoadingMessages, [sessionId]: false }
            : state.isLoadingMessages,
        }));
      }

      return mergedMessages;
    };

    try {
      // Show the newest slice first so the latest messages appear immediately.
      const recentTranscriptMessages = await window.electronAPI.claude.getMessages(sessionId, RECENT_MESSAGE_LIMIT);
      if (!isCurrentLoad()) return;
      applyLoadedMessages(recentTranscriptMessages || [], { requestedLimit: RECENT_MESSAGE_LIMIT });

      // Then backfill older transcript history above the fold.
      // Cap at 500 messages — fetching unlimited (limit: 0) downloads entire
      // transcript files which can be 200MB+ for SSH sessions, freezing the app.
      const BACKFILL_LIMIT = 500;
      if ((recentTranscriptMessages?.length || 0) >= RECENT_MESSAGE_LIMIT) {
        set((state) => ({
          isLoadingMessages: isCurrentLoad()
            ? { ...state.isLoadingMessages, [sessionId]: true }
            : state.isLoadingMessages,
        }));
        const fullTranscriptMessages = await window.electronAPI.claude.getMessages(sessionId, BACKFILL_LIMIT);
        if (!isCurrentLoad()) return;
        if ((fullTranscriptMessages?.length || 0) > (recentTranscriptMessages?.length || 0)) {
          applyLoadedMessages(fullTranscriptMessages || [], {
            requestedLimit: BACKFILL_LIMIT,
            replaceWhileStreaming: startedAsEmptyActiveSession,
          });
        } else {
          set((state) => ({
            isLoadingMessages: isCurrentLoad()
              ? { ...state.isLoadingMessages, [sessionId]: false }
              : state.isLoadingMessages,
          }));
        }
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
      set((state) => ({
        isLoadingMessages: isCurrentLoad()
          ? { ...state.isLoadingMessages, [sessionId]: false }
          : state.isLoadingMessages,
      }));
    }
  },

  subscribeToClaude: () => {
    if (!hasElectronAPI) return noop;
    const { addMessage, updateStreamContent, updateThinkingContent, addToolCall, updateToolCall, setStreaming, setSystemInfo } = get();

    const unsubChunk = window.electronAPI.claude.onStreamChunk(({ sessionId, content, agentId }) => {
      updateStreamContent(sessionId, content, agentId);
    });

    const unsubThinking = window.electronAPI.claude.onThinkingChunk(({ sessionId, content }) => {

      updateThinkingContent(sessionId, content);
    });

    const unsubToolCall = window.electronAPI.claude.onToolCall(({ sessionId, toolCall }) => {

      const tc = normalizeToolCall(toolCall as ToolCall);
      logToolEvent('onToolCall received', tc);
      addToolCall(sessionId, tc);

      // Sub-agent tool activity: inject progress into chat stream so the user
      // sees what's happening. The SDK doesn't stream sub-agent text over SSH.
      if (tc.agentId && get().isStreaming[sessionId]) {
        updateStreamContent(sessionId, `\n> **Running:** ${getToolCallStatusLabel(tc)}\n\n`, tc.agentId);
      }

      // Track real backgrounded shells via Claude Code's native tool suite:
      // - `Bash` with `run_in_background: true` starts a shell, result includes shell_id
      // - `BashOutput` polls stdout/stderr for a shell_id
      // - `KillShell` stops a background shell_id
      // The MonitorBlock UI uses the tool_use id as a placeholder until the
      // Bash tool result comes back with the real shell_id (see onToolResult).
      if (tc?.name === 'Bash' && tc.id) {
        const input = (tc.input || {}) as { run_in_background?: boolean; command?: string; description?: string };
        if (input.run_in_background === true) {
          const description = input.description || input.command?.slice(0, 80) || 'background shell';
          set((state) => {
            const existing = state.monitorInstances[sessionId] || [];
            if (existing.some((m) => m.id === tc.id)) return state;
            return {
              monitorInstances: {
                ...state.monitorInstances,
                [sessionId]: [
                  ...existing,
                  {
                    id: tc.id,              // swapped for shell_id when Bash result arrives
                    description,
                    events: [makeMonitorEvent(tc.id, `Started: ${description}`)],
                    active: true,
                    kind: 'monitor',
                    startedAt: Date.now(),
                  },
                ],
              },
            };
          });
        }
      }

      if (tc?.name === 'Monitor' && tc.id) {
        const input = (tc.input || {}) as { task?: string; description?: string; summary?: string };
        const description = input.task || input.description || input.summary || 'monitor';
        set((state) => {
          const existing = state.monitorInstances[sessionId] || [];
          if (existing.some((m) => m.id === tc.id)) return state;
          return {
            monitorInstances: {
              ...state.monitorInstances,
              [sessionId]: [
                ...existing,
                {
                  id: tc.id,
                  description,
                  events: [makeMonitorEvent(tc.id, `Started: ${description}`)],
                  active: true,
                  kind: 'monitor',
                  startedAt: Date.now(),
                },
              ],
            },
          };
        });
      }

      // Teammate spawning (Agent Teams feature). The model invokes `Agent` /
      // `Task` to launch asynchronous agents. Some Claude Code builds omit
      // `subagent_type`, so treat every Agent/Task call as background work.
      if ((tc?.name === 'Agent' || tc?.name === 'Task') && tc.id) {
        const description = asyncAgentDescription(tc);
        set((state) => {
          const existing = state.monitorInstances[sessionId] || [];
          if (findMonitorIndex(existing, tc.id) >= 0) return state;
          return {
            monitorInstances: {
              ...state.monitorInstances,
              [sessionId]: [
                ...existing,
                {
                  id: tc.id,
                  description,
                  events: [makeMonitorEvent(tc.id, `Launching: ${description}`)],
                  active: true,
                  kind: 'subagent',
                  startedAt: Date.now(),
                },
              ],
            },
          };
        });
      }
    });

    const unsubToolResult = window.electronAPI.claude.onToolResult(async ({ sessionId, toolCall }) => {

      if (!toolCall) return;
      const tc = normalizeToolCall(toolCall as ToolCall);
      logToolEvent('onToolResult received', tc);
      // Update all fields that might have changed, including input which may have been streamed
      updateToolCall(sessionId, tc.id, {
        name: tc.name,
        input: tc.input,
        status: tc.status,
        result: tc.result,
        completedAt: tc.completedAt,
      });

      // Real backgrounded shells (Claude Code native):
      // 1. Bash(run_in_background=true) result → rekey monitor by shell_id + seed output
      // 2. BashOutput result → append lines to matching shell_id monitor
      // 3. KillShell result → mark that shell_id inactive
      if (tc.id && tc.result) {
        const resultText = stringifyToolResultForDisplay(tc.result);

        // Bash tool result — swap placeholder id for real shell_id
        if (tc.name === 'Bash') {
          const input = (tc.input || {}) as { run_in_background?: boolean };
          if (input.run_in_background === true) {
            // Claude Code prints the shell id in the result, typically as
            // "Shell ID: bash_<n>" or a JSON blob including shell_id.
            const shellMatch =
              resultText.match(/shell[_ ]id[":=\s]+([a-zA-Z0-9_-]+)/i) ||
              resultText.match(/bash[_-]\d+/i);
            const shellId = shellMatch ? (shellMatch[1] || shellMatch[0]) : null;
            if (shellId) {
              set((state) => {
                const existing = state.monitorInstances[sessionId] || [];
                const idx = existing.findIndex((m) => m.id === tc.id);
                if (idx < 0) return state;
                const updated = [...existing];
                updated[idx] = {
                  ...updated[idx],
                  id: shellId,
                  events: resultText
                    ? appendMonitorEvent(updated[idx].events, { id: `${shellId}-seed`, text: capLiveMonitorText(resultText), timestamp: Date.now() })
                    : updated[idx].events,
                };
                return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
              });
            }
          }
        }

        // BashOutput — append polled output to the matching shell's monitor.
        if (tc.name === 'BashOutput') {
          const input = (tc.input || {}) as { bash_id?: string; shell_id?: string };
          const shellId = input.bash_id || input.shell_id;
          if (shellId) {
            set((state) => {
              const existing = state.monitorInstances[sessionId] || [];
              const idx = existing.findIndex((m) => m.id === shellId);
              if (idx < 0) return state;
              const updated = [...existing];
              // Skip empty polls so the monitor doesn't flood with blanks.
              if (resultText.trim()) {
                updated[idx] = {
                  ...updated[idx],
                  events: appendMonitorEvent(
                    updated[idx].events,
                    { id: `${shellId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: capLiveMonitorText(resultText), timestamp: Date.now() },
                  ),
                };
              }
              // Completed status in the Bash process is reflected when the shell exits;
              // the CLI surfaces this via BashOutput returning exit info.
              if (/exit code|process exited|command finished/i.test(resultText)) {
                updated[idx] = { ...updated[idx], active: false };
              }
              return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
            });
          }
        }

        // KillShell — mark the targeted shell inactive.
        if (tc.name === 'KillShell' || tc.name === 'KillBash') {
          const input = (tc.input || {}) as { shell_id?: string; bash_id?: string };
          const shellId = input.shell_id || input.bash_id;
          if (shellId) {
            set((state) => {
              const existing = state.monitorInstances[sessionId] || [];
              const idx = existing.findIndex((m) => m.id === shellId);
              if (idx < 0) return state;
              const updated = [...existing];
              updated[idx] = { ...updated[idx], active: false };
              return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
            });
          }
        }

        // Agent/Task result can be either a final answer or just the async
        // launch receipt. The launch receipt means the agent is now running.
        if ((tc.name === 'Agent' || tc.name === 'Task') && tc.id) {
          const launch = parseAsyncAgentLaunch(resultText);
          const description = asyncAgentDescription(tc);
          const eventText = launch
            ? `Running in background: ${launch.summary || description}`
            : compactMonitorText(resultText, 240);
          const isDone = !launch && (tc.status === 'completed' || tc.status === 'error');

          set((state) => {
            const existing = state.monitorInstances[sessionId] || [];
            const idx = findMonitorIndex(existing, launch?.agentId, tc.id);
            if (idx < 0) {
              const newEntry: MonitorEntry = {
                id: launch?.agentId || tc.id,
                aliases: launch && launch.agentId !== tc.id ? [tc.id] : undefined,
                description,
                events: eventText ? [makeMonitorEvent(launch ? 'launch' : 'done', eventText)] : [],
                active: launch ? true : !isDone,
                kind: 'subagent',
                startedAt: Date.now(),
              };
              return {
                monitorInstances: {
                  ...state.monitorInstances,
                  [sessionId]: [...existing, newEntry],
                },
              };
            }

            const updated = [...existing];
            const entry = updated[idx];
            const previousEvents = entry.events || [];
            const lastEvent = previousEvents[previousEvents.length - 1];
            const nextEvents = eventText && lastEvent?.text !== eventText
              ? appendMonitorEvent(previousEvents, makeMonitorEvent(launch ? 'launch' : 'done', eventText))
              : previousEvents;
            updated[idx] = {
              ...entry,
              id: launch?.agentId || entry.id,
              aliases: launch ? appendUniqueAlias(entry, tc.id, launch.agentId) : entry.aliases,
              description: entry.description || description,
              events: nextEvents,
              active: launch ? true : !isDone,
              kind: 'subagent',
            };
            return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
          });

          if (launch) {
            if (get().isStreaming[sessionId]) {
              updateStreamContent(sessionId, `\n> **Background agent running:** ${description}\n\n`, launch.agentId);
            }
          } else if (resultText.trim() && get().isStreaming[sessionId]) {
            updateStreamContent(sessionId, capTextMiddle(resultText, MAX_LIVE_TOOL_RESULT_STREAM_CHARS), tc.id);
          }
        }

        // SendMessage to a teammate — add as a progress event on the relevant
        // teammate's monitor. The input.to field names the teammate; we match
        // on description-prefix since there's no shared id.
        if (tc.name === 'SendMessage' && tc.id) {
          const input = (tc.input || {}) as { to?: string; message?: string };
          const target = input.to;
          if (target) {
            set((state) => {
              const existing = state.monitorInstances[sessionId] || [];
              // Match by description prefix, e.g. "scaramanga: ..."
              const idx = existing.findIndex((m) =>
                m.id === target ||
                m.aliases?.includes(target) ||
                m.description.toLowerCase().startsWith(`${target.toLowerCase()}:`)
              );
              if (idx < 0) return state;
              const updated = [...existing];
              const preview = (input.message || '').slice(0, 120);
              updated[idx] = {
                ...updated[idx],
                events: [
                  ...updated[idx].events,
                  { id: `${tc.id}-msg`, text: `→ ${preview}`, timestamp: Date.now() },
                ],
              };
              if (resultText.trim()) {
                updated[idx].events = appendMonitorEvent(updated[idx].events, { id: `${tc.id}-reply`, text: capLiveMonitorText(resultText), timestamp: Date.now() });
              }
              return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
            });
          }
        }
      }

      // Handle Edit tool completion for text replacement feature
      if (tc.name === 'Edit' && tc.status === 'completed') {
        // Import UI store dynamically to avoid circular dependency
        import('./ui.store').then(({ useUIStore }) => {
          const uiStore = useUIStore.getState();

          // Check if this edit was triggered by text editing mode
          if (uiStore.sessionEditingText[sessionId]) {
            console.log('[SessionStore] Edit tool completed for text replacement, triggering reload...');

            // Clear editing state
            uiStore.setSessionEditingText(sessionId, false);

            // Trigger browser reload via custom event
            // BrowserPreview component will listen for this event
            window.dispatchEvent(new CustomEvent('grep-browser-reload', {
              detail: { sessionId }
            }));
          }
        });
      }

      // Queued message injection is owned by the main-process queue service.
      // The renderer only reflects queue:state-changed updates, which avoids
      // local dequeue state racing the main queue source of truth.
      const currentState = get();
      const queue = currentState.messageQueue[sessionId] || [];
      if (queue.length > 0) {
        const activeStreamModel = currentState.activeStreamModel[sessionId];
        if (isNonClaudeHarness(activeStreamModel) || queue[0]?.suppressUserMessage) {
          console.log('[SessionStore] Tool completed during non-Claude run - queued message will wait for stream end');
          return;
        }
        console.log(`[SessionStore] Tool completed with ${queue.length} queued message(s); main queue owns injection`);
      }
    });

    const unsubSystemInfo = window.electronAPI.claude.onSystemInfo(({ sessionId, systemInfo }) => {
      setSystemInfo(sessionId, systemInfo);
    });

    const unsubContextUsage = window.electronAPI.claude.onContextUsage(({ sessionId, inputTokens, contextWindowSize, percentage }) => {
      set((state) => ({
        contextUsage: { ...state.contextUsage, [sessionId]: { inputTokens, contextWindowSize, percentage } },
      }));
    });

    const unsubAutoRoute = window.electronAPI.claude.onAutoRouteDecision(({ sessionId, decision }) => {
      set((state) => {
        if ((state.selectedModel[sessionId] || 'auto') !== 'auto') {
          return {};
        }

        return {
          autoRouteDecision: { ...state.autoRouteDecision, [sessionId]: decision },
          activeStreamModel: decision.resolvedModel
            ? { ...state.activeStreamModel, [sessionId]: decision.resolvedModel }
            : state.activeStreamModel,
          activeMetaGoals: decision.goal?.objective && decision.goal.source === 'slash-command'
            ? {
              ...state.activeMetaGoals,
              [sessionId]: {
                objective: decision.goal.objective,
                source: decision.goal.source,
                status: 'active',
                iterations: state.activeMetaGoals[sessionId]?.objective === decision.goal.objective
                  ? state.activeMetaGoals[sessionId]?.iterations || 0
                  : 0,
                maxIterations: state.activeMetaGoals[sessionId]?.maxIterations || META_GOAL_MAX_ITERATIONS,
                updatedAt: Date.now(),
              },
            }
            : state.activeMetaGoals,
        };
      });
    });

    const unsubEnd = window.electronAPI.claude.onStreamEnd(async ({ sessionId, message }) => {
      const currentState = get();

      // Guard against stale STREAM_END from a cancelled stream racing in after a
      // new stream has started. If isStreaming is true but the stream started very
      // recently (< 1s ago), and this event has no content (safety-net cleanup),
      // it's almost certainly from the OLD cancelled stream — skip it.
      const streamAge = Date.now() - (currentState.streamStartTime[sessionId] || 0);
      const hasVisibleEndOutput = Boolean(
        message.content?.trim()
        || currentState.currentStreamContent[sessionId]?.trim()
        || message.toolCalls?.length
        || currentState.currentToolCalls[sessionId]?.length
        || message.contentBlocks?.length
        || currentState.streamEvents[sessionId]?.length
      );
      if (currentState.isStreaming[sessionId] && streamAge < 1000 && !hasVisibleEndOutput) {
        console.log(`[SessionStore] onStreamEnd SKIPPED for ${sessionId} — stale event (stream only ${streamAge}ms old, no visible output)`);
        return;
      }

      // Always process STREAM_END — even if isStreaming is already false.
      // Skipping caused silent failures where the assistant response was dropped.
      if (!currentState.isStreaming[sessionId]) {
        console.log(`[SessionStore] onStreamEnd for ${sessionId} — streaming was already false, processing anyway`);
      }

      const queueLength = (currentState.messageQueue[sessionId] || []).length;
      const streamModel = currentState.activeStreamModel[sessionId];

      // Get the accumulated stream content - this is what was actually streamed
      const streamedContent = currentState.currentStreamContent[sessionId] || '';

      console.log(`[SessionStore] onStreamEnd received for ${sessionId}. Backend message length: ${message.content?.length || 0}, streamed content length: ${streamedContent.length}`);
      console.log(`[SessionStore] onStreamEnd - Queue has ${queueLength} messages waiting`);

      const rawCurrentToolCalls = currentState.currentToolCalls[sessionId] || [];
      const unfinishedToolCalls = collectUnfinishedToolCalls(rawCurrentToolCalls, message.toolCalls);
      const hasUnfinishedVisibleTools = unfinishedToolCalls.length > 0;
      if (hasUnfinishedVisibleTools && currentState.isStreaming[sessionId] && !isQueueDrainSuppressed(sessionId)) {
        set((state) => ({
          isStreaming: { ...state.isStreaming, [sessionId]: true },
          sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
          streamStartTime: {
            ...state.streamStartTime,
            [sessionId]: state.streamStartTime[sessionId] || Date.now(),
          },
          activeStreamModel: {
            ...state.activeStreamModel,
            [sessionId]: state.activeStreamModel[sessionId] || getSessionModel(state, sessionId),
          },
        }));

        // STREAM_END can be a safety-net event while an SSH turn is still
        // recoverable. Give the generator a moment to unwind so normal final
        // events do not look active just because cleanup is still in-flight.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const [backendActive, remoteActive] = await Promise.all([
          window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false),
          window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false),
        ]);
        if (backendActive || remoteActive) {
          console.warn(
            `[SessionStore] Deferring STREAM_END for ${sessionId}; ` +
            `${unfinishedToolCalls.length} visible tool call(s) still running ` +
            `(backendActive=${backendActive ? 'yes' : 'no'}, remoteActive=${remoteActive ? 'yes' : 'no'})`
          );
          if (remoteActive) {
            // The turn produced visible output but we're deferring because the
            // remote process is still running with unfinished tools. Add the
            // message NOW so it doesn't vanish from the UI — later STREAM_ENDs
            // from the reattach will be deduped by alreadyRenderedFinal.
            const deferredStreamContent = get().currentStreamContent[sessionId] || '';
            if (deferredStreamContent.trim() || message.content?.trim()) {
              const autoBuildDecision1 = currentState.autoRouteDecision[sessionId];
              const resolvedStreamModel1 = streamModel === 'auto' ? autoBuildDecision1?.resolvedModel : streamModel;
              const deferredFinal = buildCompletedStreamMessage({
                message,
                content: deferredStreamContent,
                toolCalls: settleUnfinishedToolCalls(rawCurrentToolCalls),
                contentBlocks: buildContentBlocksFromStreamEvents(get().streamEvents[sessionId] || []),
                model: streamModel,
                resolvedModel: resolvedStreamModel1,
              });
              addMessage(sessionId, deferredFinal);
              console.warn(
                `[SessionStore] Deferred STREAM_END: added partial message for ${sessionId.substring(0, 8)}`
                + ` | contentLen=${(deferredFinal.content || '').length}`
              );
            }
            console.warn(
              `[SessionStore] DIAGNOSTIC: Deferred STREAM_END cleared stream buffer for ${sessionId.substring(0, 8)}`
              + ` | clearedContentLen=${(get().currentStreamContent[sessionId] || '').length}`
              + ` | existingMessages=${(get().messages[sessionId] || []).length}`
              + ` | existingAssistants=${(get().messages[sessionId] || []).filter(m => m.role === 'assistant').length}`
            );
            set((state) => ({
              currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
              currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
            }));
            const { loadMessages } = get();
            startRemoteProcessMonitor(sessionId, get, set, loadMessages, { recoverableKnown: true });
          }
          return;
        }
        console.warn(`[SessionStore] Settling ${unfinishedToolCalls.length} dangling tool call(s) before STREAM_END for inactive runtime`);
      }

      if (currentState.isStreaming[sessionId] && !isQueueDrainSuppressed(sessionId)) {
        const remoteActive = await hasLiveRemoteProcess(sessionId, currentState);
        if (remoteActive) {
          console.warn(`[SessionStore] Deferring STREAM_END for ${sessionId}; remote Claude process is still active`);
          // Add the message NOW before clearing the buffer — otherwise the
          // assistant response disappears from the UI until loadMessages
          // eventually picks it up from the transcript.
          const deferredStreamContent = get().currentStreamContent[sessionId] || '';
          if (deferredStreamContent.trim() || message.content?.trim()) {
            const autoBuildDecision2 = currentState.autoRouteDecision[sessionId];
            const resolvedStreamModel2 = streamModel === 'auto' ? autoBuildDecision2?.resolvedModel : streamModel;
            const deferredFinal = buildCompletedStreamMessage({
              message,
              content: deferredStreamContent,
              toolCalls: rawCurrentToolCalls,
              contentBlocks: buildContentBlocksFromStreamEvents(currentState.streamEvents[sessionId] || []),
              model: streamModel,
              resolvedModel: resolvedStreamModel2,
            });
            addMessage(sessionId, deferredFinal);
            console.warn(
              `[SessionStore] Deferred STREAM_END: added message for ${sessionId.substring(0, 8)}`
              + ` | contentLen=${(deferredFinal.content || '').length}`
            );
          }
          console.warn(
            `[SessionStore] DIAGNOSTIC: Deferred STREAM_END cleared stream buffer for ${sessionId.substring(0, 8)}`
            + ` | clearedContentLen=${(get().currentStreamContent[sessionId] || '').length}`
            + ` | existingMessages=${(get().messages[sessionId] || []).length}`
            + ` | existingAssistants=${(get().messages[sessionId] || []).filter(m => m.role === 'assistant').length}`
          );
          set((state) => ({
            currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
            currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
          }));
          markRemoteProcessStreaming(sessionId, get, set);
          const { loadMessages } = get();
          startRemoteProcessMonitor(sessionId, get, set, loadMessages, { recoverableKnown: true });
          return;
        }
      }

      setStreaming(sessionId, false);

      const autoBuildDecision = currentState.autoRouteDecision[sessionId];
      const resolvedStreamModel = streamModel === 'auto' ? autoBuildDecision?.resolvedModel : streamModel;
      const messageForFinal = hasUnfinishedVisibleTools && message.toolCalls?.length
        ? { ...message, toolCalls: settleUnfinishedToolCalls(message.toolCalls) }
        : message;
      const finalMessage = buildCompletedStreamMessage({
        message: messageForFinal,
        content: streamedContent,
        toolCalls: hasUnfinishedVisibleTools ? settleUnfinishedToolCalls(rawCurrentToolCalls) : rawCurrentToolCalls,
        contentBlocks: buildContentBlocksFromStreamEvents(currentState.streamEvents[sessionId] || []),
        model: streamModel,
        resolvedModel: resolvedStreamModel,
      });
      const finalToolCalls = finalMessage.toolCalls || [];
      const finalContentBlocks = finalMessage.contentBlocks;
      const finalHarness = finalMessage.harness;
      const finalContent = finalMessage.content || '';
      const autoBuildHelperContent = extractAutoBuildHelperContent(finalContent);
      const isAutoBuildTurn = Boolean(autoBuildDecision);
      const hasFinalContent = finalContent.trim().length > 0;
      const hasVisibleOutput = hasFinalContent || finalToolCalls.length > 0 || Boolean(finalContentBlocks?.length);
      const alreadyRenderedFinal = !currentState.isStreaming[sessionId]
        && (currentState.messages[sessionId] || []).some((existing) => isInterruptedSafetyNetDuplicate(
          normalizeChatMessageTimestamp(existing),
          normalizeChatMessageTimestamp(finalMessage),
        ));

      if (!alreadyRenderedFinal && hasVisibleOutput && (isNonClaudeHarness(resolvedStreamModel) || finalHarness !== 'claude' || Boolean(autoBuildHelperContent))) {
        persistSupplementalMessage(sessionId, finalMessage);
      }
      if (!alreadyRenderedFinal && isAutoBuildTurn && hasFinalContent) {
        persistSupplementalMessage(
          sessionId,
          buildAutoBuildContextMessage(finalMessage, autoBuildDecision, autoBuildHelperContent),
        );
      }

      if (hasVisibleOutput && !alreadyRenderedFinal) {
        addMessage(sessionId, finalMessage);
      } else if (alreadyRenderedFinal) {
        console.log(`[SessionStore] onStreamEnd skipped duplicate finalized output for ${sessionId}`);
      } else if (!hasVisibleOutput) {
        console.warn(
          `[SessionStore] onStreamEnd DROPPED message for ${sessionId} — no visible output`
          + ` | contentLen=${finalContent.length} toolCalls=${finalToolCalls.length}`
          + ` contentBlocks=${finalContentBlocks?.length || 0}`
          + ` streamedContentLen=${streamedContent.length}`
          + ` backendContentLen=${message.content?.length || 0}`
          + ` harness=${finalHarness || 'none'}`
          + ` model=${streamModel || 'none'}`
          + ` isAutoBuild=${isAutoBuildTurn}`
        );
      }

      // Clear stream content after adding to messages
      set((state) => ({
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
      }));

      // Desktop notification for non-active sessions when a turn completes
      if (finalMessage.role === 'assistant' && finalContent) {
        const activeId = get().activeSessionId;
        if (sessionId !== activeId) {
          const session = get().sessions.find(s => s.id === sessionId);
          const sessionName = session ? getSessionDisplayName(session) : 'Session';
          const preview = finalContent.replace(/\s+/g, ' ').trim().slice(0, 80);
          try {
            const notification = new Notification(sessionName, {
              body: preview || 'Turn complete',
              silent: true,
            });
            notification.onclick = () => {
              get().setActiveSession(sessionId);
              window.focus();
            };
          } catch (e) {
            // Notifications may not be available in all environments
            console.warn('[SessionStore] Desktop notification failed:', e);
          }
        }
      }

      // Auto-play TTS if audio mode is active and message has content
      if (finalContent && finalMessage.role === 'assistant') {
        // Import audio store and trigger auto-play
        import('./audio.store').then(({ useAudioStore }) => {
          useAudioStore.getState().triggerAutoPlayTTS(sessionId, finalMessage.id, finalContent);
        });
      }

      // Queue drain is now handled by the main-process MessageQueueService.
      // It will emit 'queue:send-next' when the next message should be sent.
      // Local queue state is synced via 'queue:state-changed' events.

      const activeGoal = get().activeMetaGoals[sessionId];
      if (activeGoal?.status === 'active') {
        const completion = goalCompletionStatus(finalContent);
        if (completion) {
          set((state) => ({
            activeMetaGoals: {
              ...state.activeMetaGoals,
              [sessionId]: {
                ...activeGoal,
                status: completion,
                updatedAt: Date.now(),
              },
            },
          }));
          console.log(`[SessionStore] Meta-goal ${completion} for ${sessionId}`);
          return;
        }

        if (isFatalMetaGoalTurnFailure(finalMessage, finalContent)) {
          set((state) => ({
            activeMetaGoals: blockMetaGoalState(state.activeMetaGoals, sessionId),
          }));
          console.log(`[SessionStore] Meta-goal blocked by fatal turn failure for ${sessionId}`);
          return;
        }

        if (activeGoal.iterations >= activeGoal.maxIterations) {
          set((state) => ({
            activeMetaGoals: {
              ...state.activeMetaGoals,
              [sessionId]: {
                ...activeGoal,
                status: 'blocked',
                updatedAt: Date.now(),
              },
            },
          }));
          console.log(`[SessionStore] Meta-goal reached iteration cap for ${sessionId}`);
          return;
        }

        const nextGoal = {
          ...activeGoal,
          iterations: activeGoal.iterations + 1,
          updatedAt: Date.now(),
        };
        set((state) => ({
          activeMetaGoals: {
            ...state.activeMetaGoals,
            [sessionId]: nextGoal,
          },
        }));
        setTimeout(() => {
          const latestState = get();
          const latestGoal = latestState.activeMetaGoals[sessionId];
          if (
            latestGoal?.status !== 'active'
            || latestGoal.objective !== nextGoal.objective
            || latestGoal.iterations !== nextGoal.iterations
            || latestGoal.updatedAt !== nextGoal.updatedAt
            || isQueueDrainSuppressed(sessionId)
          ) {
            console.log(`[SessionStore] Meta-goal continuation suppressed for ${sessionId}`);
            return;
          }
          if (latestState.isStreaming[sessionId] || (latestState.messageQueue[sessionId] || []).length > 0) return;
          latestState.sendMessage(sessionId, buildMetaGoalContinuationPrompt(nextGoal), undefined, {
            suppressUserMessage: true,
          });
        }, 250);
      }
    });

    const unsubError = window.electronAPI.claude.onStreamError(async ({ sessionId, error }) => {
      const currentState = get();

      // Guard against stale errors from a cancelled stream racing in after a
      // new stream has started. If the stream started very recently (< 1s),
      // this error is from the OLD cancelled query — don't kill the new stream.
      const streamAge = Date.now() - (currentState.streamStartTime[sessionId] || 0);
      const isImmediateFatalError = /unknown option|not found|authentication|api key|no stdout|exited|failed/i.test(error);
      if (currentState.isStreaming[sessionId] && streamAge < 1000 && !isImmediateFatalError) {
        console.log(`[SessionStore] onStreamError SKIPPED for ${sessionId} — stale error from previous stream (stream only ${streamAge}ms old): ${error}`);
        return;
      }

      // Ignore stale errors from a cancelled stream that race in after we've
      // already cleared the streaming flag (e.g. during interruptAndSend,
      // which cancels, clears state, then kicks off a new send). Without this
      // guard, the old query's STREAM_ERROR tears down the NEW stream's state
      // — exactly the "isStreaming still fucked" regression.
      if (!currentState.isStreaming[sessionId]) {
        console.log(`[SessionStore] onStreamError SKIPPED for ${sessionId} — streaming already false (stale event from cancelled stream)`);
        return;
      }

      const streamModel = currentState.activeStreamModel[sessionId];
      const autoBuildDecision = currentState.autoRouteDecision[sessionId];
      const resolvedStreamModel = streamModel === 'auto' ? autoBuildDecision?.resolvedModel : streamModel;

      // Get any streamed content before the error
      const streamedContent = currentState.currentStreamContent[sessionId] || '';

      const partialToolCalls = currentState.currentToolCalls[sessionId] || [];
      const partialContentBlocks = buildContentBlocksFromStreamEvents(currentState.streamEvents[sessionId] || []);
      const hasPartialOutput = Boolean(streamedContent.trim() || partialToolCalls.length || partialContentBlocks?.length);
      const unfinishedToolCalls = collectUnfinishedToolCalls(partialToolCalls);

      if (unfinishedToolCalls.length > 0 && !isQueueDrainSuppressed(sessionId)) {
        set((state) => ({
          isStreaming: { ...state.isStreaming, [sessionId]: true },
          sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
          streamStartTime: {
            ...state.streamStartTime,
            [sessionId]: state.streamStartTime[sessionId] || Date.now(),
          },
          activeStreamModel: {
            ...state.activeStreamModel,
            [sessionId]: state.activeStreamModel[sessionId] || getSessionModel(state, sessionId),
          },
        }));

        await new Promise((resolve) => setTimeout(resolve, 250));
        const [backendActive, remoteActive] = await Promise.all([
          window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false),
          window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false),
        ]);
        if (backendActive || remoteActive) {
          console.warn(
            `[SessionStore] Deferring STREAM_ERROR cleanup for ${sessionId}; ` +
            `${unfinishedToolCalls.length} visible tool call(s) still running ` +
            `(backendActive=${backendActive ? 'yes' : 'no'}, remoteActive=${remoteActive ? 'yes' : 'no'}): ${error}`
          );
          if (remoteActive) {
            const { loadMessages } = get();
            startRemoteProcessMonitor(sessionId, get, set, loadMessages, { recoverableKnown: true });
          }
          return;
        }
        console.warn(`[SessionStore] Settling ${unfinishedToolCalls.length} dangling tool call(s) before STREAM_ERROR for inactive runtime`);
      }

      if (!isQueueDrainSuppressed(sessionId)) {
        const remoteActive = await hasLiveRemoteProcess(sessionId, currentState);
        if (remoteActive) {
          console.warn(`[SessionStore] Deferring STREAM_ERROR cleanup for ${sessionId}; remote Claude process is still active: ${error}`);
          markRemoteProcessStreaming(sessionId, get, set);
          const { loadMessages } = get();
          startRemoteProcessMonitor(sessionId, get, set, loadMessages, { recoverableKnown: true });
          return;
        }
      }

      // If we have streamed output, save it as a partial message before showing error.
      // Tool-only harness turns still need a visible message; checking only text
      // dropped tool cards when the process errored before final prose.
      if (hasPartialOutput) {
        const settledPartialToolCalls = settleUnfinishedToolCalls(partialToolCalls);
        const partialMessage: ChatMessage = {
          id: `partial-${Date.now()}`,
          role: 'assistant',
          content: streamedContent,
          contentBlocks: partialContentBlocks,
          toolCalls: settledPartialToolCalls && settledPartialToolCalls.length > 0 ? settledPartialToolCalls : undefined,
          timestamp: new Date(),
          interrupted: true,
          harness: harnessFromModel(resolvedStreamModel),
        };
        persistSupplementalMessage(sessionId, partialMessage);
        addMessage(sessionId, partialMessage);
      }

      // On error, clear streaming flag WITHOUT processing queue.
      // Errors mean the query is dead — don't send queued messages into a broken state.
      // Set streaming to false directly without triggering queue drain.
      // Also clear stale pending permissions/questions — the process that requested
      // them is dead, so clicking Approve would be a no-op.
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
        activeMetaGoals: blockMetaGoalState(state.activeMetaGoals, sessionId),
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
        pendingPermission: { ...state.pendingPermission, [sessionId]: null },
        pendingQuestion: { ...state.pendingQuestion, [sessionId]: null },
      }));

      const errorMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: new Date(),
        harness: harnessFromModel(resolvedStreamModel),
      };
      const isAutoBuildTurn = Boolean(autoBuildDecision);
      persistSupplementalMessage(sessionId, errorMessage);
      if (isAutoBuildTurn) {
        persistSupplementalMessage(
          sessionId,
          buildAutoBuildContextMessage(errorMessage, autoBuildDecision, '', error),
        );
      }
      addMessage(sessionId, errorMessage);

      // Queue drain on error is now handled by the main-process MessageQueueService.
      // The onStreamEnd call in claude.ipc.ts finally block triggers drain timing.
    });

    // Subscribe to permission requests
    const unsubPermission = window.electronAPI.claude.onPermissionRequest((request) => {
      console.log('[Session Store] Permission request received:', request.toolName, 'sessionId:', request.sessionId);
      console.log('[Session Store] Full permission request:', JSON.stringify(request, null, 2));
      const { setPendingPermission } = get();
      setPendingPermission(request.sessionId, request);
      // Verify it was set
      setTimeout(() => {
        const state = get();
        console.log('[Session Store] pendingPermission after set:', state.pendingPermission);
      }, 100);
    });

    // Subscribe to question requests
    const unsubQuestion = window.electronAPI.claude.onQuestionRequest((request) => {
      console.log('[Session Store] Question request received:', request.questions.length, 'question(s)');
      const { setPendingQuestion } = get();
      setPendingQuestion(request.sessionId, request);
    });

    // Subscribe to plan content (when a plan file is written)
    const unsubPlanContent = window.electronAPI.claude.onPlanContent((data) => {
      console.log('[Session Store] Plan content received for session:', data.sessionId, 'length:', data.planContent?.length);
      // Import ui.store dynamically to avoid circular dependency
      import('./ui.store').then(({ useUIStore }) => {
        console.log('[Session Store] Setting plan content in UI store');
        useUIStore.getState().setPlanContent(data.sessionId, data.planContent);
        console.log('[Session Store] Plan content set, current content:', useUIStore.getState().sessionPlanContent[data.sessionId]?.substring(0, 100));
      });
    });

    // Subscribe to plan approval requests (when ExitPlanMode is called)
    const unsubPlanApproval = window.electronAPI.claude.onPlanApprovalRequest((request) => {
      console.log('[Session Store] Plan approval request received for session:', request.sessionId, 'planContent length:', request.planContent?.length);
      const { setPendingPlanApproval, activeSessionId } = get();
      setPendingPlanApproval(request.sessionId, request);
      // Also update the plan content in UI store for display
      import('./ui.store').then(({ useUIStore }) => {
        console.log('[Session Store] Setting plan content from approval request');
        useUIStore.getState().setPlanContent(request.sessionId, request.planContent);
        // Only auto-open plan panel if this is the active session
        if (request.sessionId === activeSessionId) {
          console.log('[Session Store] Plan content set in approval flow, opening panel');
          useUIStore.getState().showPlanPanel();
        } else {
          console.log('[Session Store] Plan approval for background session, not opening panel:', request.sessionId);
        }
      });
    });

    // Subscribe to permission mode changes from main process (e.g., after plan approval)
    const unsubPermissionModeChanged = window.electronAPI.claude.onPermissionModeChanged((data) => {
      console.log('[Session Store] Permission mode changed from main:', data.sessionId, data.mode);
      const currentState = get();
      const sessionModel = getSessionModel(currentState, data.sessionId);
      const normalizedMode = normalizePermissionModeForModel(sessionModel, data.mode as PermissionMode);
      set((state) => ({
        permissionMode: {
          ...state.permissionMode,
          [data.sessionId]: normalizedMode,
        },
      }));
      window.electronAPI.sessions.update(data.sessionId, { permissionMode: normalizedMode } as any).catch((err: Error) => {
        console.error('[SessionStore] Failed to persist permission mode changed from main:', err);
      });
    });

    // Listen for SSH connection lost events.
    // Detached SSH runs are expected to survive transport drops, so do not
    // tear down renderer stream state here. The backend will reconnect and
    // continue emitting chunks against the same in-flight turn.
    const unsubConnectionLost = window.electronAPI.ssh.onConnectionLost(({ sessionId, reason }) => {
      console.warn(`[SessionStore] SSH connection lost for ${sessionId}: ${reason}`);
      const currentState = get();
      const wasStreaming = currentState.isStreaming[sessionId];

      // Always clear pending permission/question dialogs — the SSH transport is
      // dead so clicking Approve would be a no-op. Dismiss immediately so the UI
      // isn't frozen while TCP keepalive takes minutes to detect the drop.
      if (currentState.pendingPermission[sessionId] || currentState.pendingQuestion[sessionId]) {
        console.warn(`[SessionStore] Clearing stale permission/question dialogs for disconnected SSH session ${sessionId}`);
        set((state) => ({
          pendingPermission: { ...state.pendingPermission, [sessionId]: null },
          pendingQuestion: { ...state.pendingQuestion, [sessionId]: null },
        }));
      }

      if (wasStreaming) {
        console.warn(`[SessionStore] Preserving active SSH stream for ${sessionId} while transport reconnects`);
        set((state) => ({
          sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
        }));
      }
      // For idle disconnects, stay silent — reconnection is automatic on next message.
    });

    // Main process detected a remote turn that survived a local stream error
    // or a queue stall — reattach so it keeps streaming to completion.
    const unsubRemoteTurnRecoverable = window.electronAPI.ssh.onRemoteTurnRecoverable?.(({ sessionId }: { sessionId: string }) => {
      console.log(`[SessionStore] Remote turn recoverable for ${sessionId}; starting reattach monitor`);
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: true },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
        streamStartTime: {
          ...state.streamStartTime,
          [sessionId]: state.streamStartTime[sessionId] || Date.now(),
        },
        activeStreamModel: {
          ...state.activeStreamModel,
          [sessionId]: state.activeStreamModel[sessionId] || getSessionModel(state, sessionId),
        },
      }));
      const { loadMessages } = get();
      startRemoteProcessMonitor(sessionId, get, set, loadMessages, { recoverableKnown: true });
    }) || noop;

    // On wake from sleep, SSH transports are dead but detached remote turns
    // kept working — sweep running SSH sessions and reattach.
    const unsubSystemResumed = window.electronAPI.ssh.onSystemResumed?.(() => {
      const runningSshSessions = get().sessions.filter(isRecentRunningSshSession);
      if (runningSshSessions.length === 0) return;
      console.log(`[SessionStore] System resumed from sleep; checking ${runningSshSessions.length} running SSH session(s) for detached turns`);
      const { loadMessages } = get();
      startRunningSshProcessMonitors(runningSshSessions, get, set, loadMessages);
    }) || noop;

    // Listen for wakeup timer fires — auto-send the prompt to the session
    const unsubWakeup = window.electronAPI.claude.onWakeupFired?.((data: { sessionId: string; prompt: string; reason: string }) => {
      console.log(`[SessionStore] Wakeup fired for ${data.sessionId}: ${data.reason}`);
      const { sendMessage } = get();
      sendMessage(data.sessionId, data.prompt);
    }) || noop;

    // Listen for queue:send-next from the main-process MessageQueueService.
    // When the main process decides it's time to send the next queued message,
    // remove it from the local queue display and send through the normal flow.
    const unsubQueueSendNext = window.electronAPI.claude.onQueueSendNext((sessionId: string, msg: any) => {
      const sourceIds = Array.isArray(msg.sourceIds) && msg.sourceIds.length > 0
        ? msg.sourceIds
        : [msg.id];
      console.log(`[SessionStore] queue:send-next received for ${sessionId}, ${sourceIds.length} queued message(s), prompt: "${(msg.text || '').slice(0, 50)}..."`);

      if (isQueueDrainSuppressed(sessionId)) {
        console.log(`[SessionStore] queue:send-next suppressed after cancel for ${sessionId}`);
        window.electronAPI.queue?.clear(sessionId);
        set((state) => ({
          isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
          messageQueue: { ...state.messageQueue, [sessionId]: [] },
        }));
        return;
      }

      const sendDrainedMessage = (attempt = 0) => {
        const latestState = get();
        if (latestState.isStreaming[sessionId] && attempt < 10) {
          setTimeout(() => sendDrainedMessage(attempt + 1), 50);
          return;
        }

        const existingMessages = latestState.messages[sessionId] || [];
        const existingMessageId = sourceIds.find((id: string) =>
          existingMessages.some((message) => message.id === id)
        );
        const hadVisibleQueuedMessage = Boolean(existingMessageId);
        markQueueMessagesConsumed(sessionId, sourceIds);

        // Remove every drained message from the local queue display and collapse
        // visible queued user bubbles into the single prompt we are about to send.
        set((state) => {
          const messages = state.messages[sessionId] || [];
          const collapsedMessages = msg.suppressUserMessage
            ? messages.filter((message) => !sourceIds.includes(message.id))
            : messages
                .filter((message) => message.id === existingMessageId || !sourceIds.includes(message.id))
                .map((message) => message.id === existingMessageId
                  ? {
                    ...message,
                    content: msg.text,
                    attachments: msg.attachments as ChatMessage['attachments'],
                  }
                  : message);

          return {
            messages: { ...state.messages, [sessionId]: collapsedMessages },
            messageQueue: {
              ...state.messageQueue,
              [sessionId]: (state.messageQueue[sessionId] || []).filter((m: any) => !sourceIds.includes(m.id)),
            },
            isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
          };
        });

        // Send the combined prompt through the normal flow. `fromQueueDrain`
        // prevents stale renderer stream flags from re-enqueuing this same turn.
        get().sendMessage(sessionId, msg.text, msg.attachments, {
          existingMessageId: existingMessageId || msg.id,
          suppressUserMessage: Boolean(msg.suppressUserMessage) || !hadVisibleQueuedMessage,
          fromQueueDrain: true,
        });
      };

      sendDrainedMessage();
    });

    // Listen for queue:state-changed to keep the renderer in sync with the
    // main-process queue (source of truth).
    const unsubQueueStateChanged = window.electronAPI.claude.onQueueStateChanged((sessionId: string, state: any) => {
      set((s) => ({
        ...(() => {
          const incomingMessages = Array.isArray(state.messages) ? state.messages : [];
          const previousQueue = s.messageQueue[sessionId] || [];
          if (
            previousQueue.length > 0 &&
            incomingMessages.length === 0 &&
            (s.isStreaming[sessionId] || Boolean(state.isProcessing))
          ) {
            markQueueMessagesConsumed(sessionId, previousQueue.map((message) => message.id));
          }
          return {};
        })(),
        isProcessingQueue: {
          ...s.isProcessingQueue,
          [sessionId]: Boolean(state.isProcessing),
        },
        messageQueue: {
          ...s.messageQueue,
          [sessionId]: (Array.isArray(state.messages) ? state.messages : []).map((m: any) => ({
            id: m.id,
            message: m.text,
            attachments: m.attachments,
            timestamp: m.timestamp,
            suppressUserMessage: m.suppressUserMessage,
          })),
        },
      }));
    });

    return () => {
      unsubChunk();
      unsubThinking();
      unsubToolCall();
      unsubToolResult();
      unsubSystemInfo();
      unsubContextUsage();
      unsubAutoRoute();
      unsubEnd();
      unsubError();
      unsubPermission();
      unsubQuestion();
      unsubPlanContent();
      unsubPlanApproval();
      unsubPermissionModeChanged();
      unsubConnectionLost();
      unsubRemoteTurnRecoverable();
      unsubSystemResumed();
      unsubWakeup();
      unsubQueueSendNext();
      unsubQueueStateChanged();
    };
  },

  // Permission handling methods
  setPendingPermission: (sessionId, request) => {
    set((state) => ({
      pendingPermission: {
        ...state.pendingPermission,
        [sessionId]: request,
      },
    }));
  },

  approvePermission: async (sessionId, modifiedInput, alwaysApprove) => {
    if (!hasElectronAPI) return;
    const { pendingPermission, setPendingPermission } = get();
    const request = pendingPermission[sessionId];

    if (!request) {
      console.warn('[Session Store] No pending permission to approve for session:', sessionId);
      return;
    }

    const response: PermissionResponse = {
      requestId: request.requestId,
      approved: true,
      modifiedInput,
      alwaysApprove,
    };

    console.log('[Session Store] Approving permission:', request.requestId, alwaysApprove ? '(always approve)' : '');
    try {
      await window.electronAPI.claude.respondToPermission(response);
    } catch (err) {
      console.warn('[Session Store] Permission response failed (process may have exited):', err);
    }
    setPendingPermission(sessionId, null);
  },

  /**
   * Clean-path backgrounding: when a Bash permission is pending, approve it
   * with `modifiedInput.run_in_background = true` so the SDK spawns the shell
   * detached instead of running it in-band. Returns true if a pending Bash
   * permission was found and approved; false otherwise (caller can fall back
   * to the blunt cancel+reprompt path).
   */
  approvePermissionAsBackground: async (sessionId: string): Promise<boolean> => {
    if (!hasElectronAPI) return false;
    const { pendingPermission, setPendingPermission } = get();
    const request = pendingPermission[sessionId];
    if (!request || request.toolName !== 'Bash') return false;

    const modifiedInput = { ...(request.toolInput || {}), run_in_background: true };
    const response: PermissionResponse = {
      requestId: request.requestId,
      approved: true,
      modifiedInput,
    };
    console.log('[Session Store] Approving Bash permission with run_in_background=true', request.requestId);
    await window.electronAPI.claude.respondToPermission(response);
    setPendingPermission(sessionId, null);
    return true;
  },

  denyPermission: async (sessionId) => {
    if (!hasElectronAPI) return;
    const { pendingPermission, setPendingPermission } = get();
    const request = pendingPermission[sessionId];

    if (!request) {
      console.warn('[Session Store] No pending permission to deny');
      return;
    }

    const response: PermissionResponse = {
      requestId: request.requestId,
      approved: false,
    };

    console.log('[Session Store] Denying permission:', request.requestId);
    try {
      await window.electronAPI.claude.respondToPermission(response);
    } catch (err) {
      console.warn('[Session Store] Permission deny failed (process may have exited):', err);
    }
    setPendingPermission(sessionId, null);
  },

  // Question handling methods
  setPendingQuestion: (sessionId, request) => {
    set((state) => ({
      pendingQuestion: {
        ...state.pendingQuestion,
        [sessionId]: request,
      },
    }));
  },

  answerQuestion: async (sessionId, answers) => {
    if (!hasElectronAPI) return;
    const { pendingQuestion, setPendingQuestion } = get();
    const request = pendingQuestion[sessionId];

    if (!request) {
      console.warn('[Session Store] No pending question to answer');
      return;
    }

    const response: QuestionResponse = {
      requestId: request.requestId,
      answers,
    };

    console.log('[Session Store] Answering question:', request.requestId, answers);
    await window.electronAPI.claude.respondToQuestion(response);
    setPendingQuestion(sessionId, null);
  },

  cancelQuestion: async (sessionId) => {
    if (!hasElectronAPI) return;
    const { pendingQuestion, setPendingQuestion } = get();
    const request = pendingQuestion[sessionId];

    if (!request) return;

    console.log('[Session Store] Cancelling question:', request.requestId);
    await window.electronAPI.claude.respondToQuestion({
      requestId: request.requestId,
      answers: {},
      cancelled: true,
    } as any);
    setPendingQuestion(sessionId, null);
  },

  // Plan approval handling methods
  setPendingPlanApproval: (sessionId, request) => {
    set((state) => ({
      pendingPlanApproval: {
        ...state.pendingPlanApproval,
        [sessionId]: request,
      },
    }));
  },

  approvePlan: async (sessionId) => {
    if (!hasElectronAPI) return;
    const { pendingPlanApproval, setPendingPlanApproval } = get();
    const request = pendingPlanApproval[sessionId];

    if (!request) {
      console.warn('[Session Store] No pending plan approval to approve');
      return;
    }

    const response: PlanApprovalResponse = {
      requestId: request.requestId,
      approved: true,
      sessionId: request.sessionId,
      planContent: request.planContent,
      planFilePath: request.planFilePath,
    };

    console.log('[Session Store] Approving plan:', request.requestId);
    await window.electronAPI.claude.respondToPlanApproval(response);
    setPendingPlanApproval(sessionId, null);
    // Note: Plan content is intentionally kept in UI store so user can still view it
  },

  rejectPlan: async (sessionId, feedback?: string) => {
    if (!hasElectronAPI) return;
    const { pendingPlanApproval, setPendingPlanApproval } = get();
    const request = pendingPlanApproval[sessionId];

    if (!request) {
      console.warn('[Session Store] No pending plan approval to reject');
      return;
    }

    const response: PlanApprovalResponse = {
      requestId: request.requestId,
      approved: false,
      sessionId: request.sessionId,
      planContent: request.planContent,
      planFilePath: request.planFilePath,
      feedback,
    };

    console.log('[Session Store] Rejecting plan:', request.requestId, feedback ? 'with feedback' : 'without feedback');
    await window.electronAPI.claude.respondToPlanApproval(response);
    setPendingPlanApproval(sessionId, null);
    // Note: Plan content is intentionally kept in UI store so user can still view it after rejection
  },

  // Queue management methods
  removeFromQueue: (sessionId, messageId) => {
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: (state.messageQueue[sessionId] || []).filter(m => m.id !== messageId),
      },
    }));
    console.log(`Message ${messageId} removed from queue`);
  },

  editQueuedMessage: (sessionId, messageId, newMessage) => {
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: (state.messageQueue[sessionId] || []).map(m =>
          m.id === messageId ? { ...m, message: newMessage } : m
        ),
      },
    }));
    console.log(`Message ${messageId} edited`);
  },

  moveToFront: (sessionId, messageId) => {
    set((state) => {
      const queue = state.messageQueue[sessionId] || [];
      const messageIndex = queue.findIndex(m => m.id === messageId);
      if (messageIndex === -1) return state;

      const message = queue[messageIndex];
      const newQueue = [message, ...queue.filter(m => m.id !== messageId)];

      return {
        messageQueue: {
          ...state.messageQueue,
          [sessionId]: newQueue,
        },
      };
    });
    console.log(`Message ${messageId} moved to front`);
  },

  clearQueue: (sessionId) => {
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: [],
      },
    }));
    console.log(`Queue cleared for session ${sessionId}`);
  },

  cancelStream: (sessionId) => {
    const state = get();
    suppressQueueDrain(sessionId);

    // Cancel current streaming
    window.electronAPI.claude.cancel(sessionId);

    // Clear the main-process queue
    window.electronAPI.queue?.clear(sessionId);

    // Save partial content as an interrupted message before clearing
    const partialContent = state.currentStreamContent[sessionId] || '';
    const partialToolCalls = state.currentToolCalls[sessionId] || [];
    const partialContentBlocks = buildContentBlocksFromStreamEvents(state.streamEvents[sessionId] || []);
    const streamModel = state.activeStreamModel[sessionId];

    if (partialContent || partialToolCalls.length > 0 || partialContentBlocks?.length) {
      // Create an interrupted message with whatever content we had
      const interruptedMessage: ChatMessage = {
        id: `interrupted-${Date.now()}`,
        role: 'assistant',
        content: partialContent || '(interrupted)',
        contentBlocks: partialContentBlocks,
        toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
        timestamp: new Date(),
        interrupted: true,
        harness: harnessFromModel(streamModel),
      };
      persistSupplementalMessage(sessionId, interruptedMessage);
      state.addMessage(sessionId, interruptedMessage);
      console.log(`[cancelStream] Saved interrupted message with ${partialContent.length} chars of content`);
    }

    // Clear current streaming state and bump generation to invalidate stale events
    set((state) => ({
      isStreaming: { ...state.isStreaming, [sessionId]: false },
      isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
      sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
      messageQueue: { ...state.messageQueue, [sessionId]: [] },
      activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
      activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
      streamGeneration: {
        ...state.streamGeneration,
        [sessionId]: (state.streamGeneration[sessionId] || 0) + 1,
      },
      streamEvents: { ...state.streamEvents, [sessionId]: [] },
      currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
      currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
      currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
      pendingPermission: { ...state.pendingPermission, [sessionId]: null },
      pendingQuestion: { ...state.pendingQuestion, [sessionId]: null },
      activeMetaGoals: { ...state.activeMetaGoals, [sessionId]: null },
    }));

    console.log(`Stream cancelled for session ${sessionId}`);
  },

  interruptAndSend: async (sessionId, message, attachments) => {
    const state = get();
    const isCurrentlyStreaming = state.isStreaming[sessionId] || false;
    const [backendActive, remoteActive] = await Promise.all([
      window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false),
      window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false),
    ]);
    const shouldInterrupt = isCurrentlyStreaming || backendActive || remoteActive;

    // Interrupt if either the renderer is streaming or the backend/remote
    // process is still unwinding after a manual stop.
    if (shouldInterrupt) {
      console.log(`[interruptAndSend] Cancelling current stream for session ${sessionId}`);
      suppressQueueDrain(sessionId, 2500);

      // Cancel current streaming and wait for confirmation
      await window.electronAPI.claude.cancel(sessionId).catch((error: unknown) => {
        console.warn('[interruptAndSend] Cancel failed before force-send:', error);
      });
      await (window.electronAPI.queue?.clear(sessionId) || Promise.resolve()).catch(() => undefined);
      console.log(`[interruptAndSend] Cancel confirmed by backend`);

      // Save partial content as an interrupted message before clearing
      const partialContent = state.currentStreamContent[sessionId] || '';
      const partialToolCalls = state.currentToolCalls[sessionId] || [];
      const partialContentBlocks = buildContentBlocksFromStreamEvents(state.streamEvents[sessionId] || []);
      const streamModel = state.activeStreamModel[sessionId];

      if (partialContent || partialToolCalls.length > 0 || partialContentBlocks?.length) {
        // Create an interrupted message with whatever content we had
        const interruptedMessage: ChatMessage = {
          id: `interrupted-${Date.now()}`,
          role: 'assistant',
          content: partialContent || '(interrupted)',
          contentBlocks: partialContentBlocks,
          toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
          timestamp: new Date(),
          interrupted: true,
          harness: harnessFromModel(streamModel),
        };
        persistSupplementalMessage(sessionId, interruptedMessage);
        state.addMessage(sessionId, interruptedMessage);
        console.log(`[interruptAndSend] Saved interrupted message with ${partialContent.length} chars of content`);
      }

      // Clear current streaming state
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
        messageQueue: { ...state.messageQueue, [sessionId]: [] },
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        activeUserPrompt: { ...state.activeUserPrompt, [sessionId]: null },
        streamGeneration: {
          ...state.streamGeneration,
          [sessionId]: (state.streamGeneration[sessionId] || 0) + 1,
        },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
        pendingPermission: { ...state.pendingPermission, [sessionId]: null },
        pendingQuestion: { ...state.pendingQuestion, [sessionId]: null },
        activeMetaGoals: { ...state.activeMetaGoals, [sessionId]: null },
      }));

      // CRITICAL: Wait for the stale STREAM_END/STREAM_ERROR from the cancelled
      // stream to arrive via IPC and be discarded by the isStreaming guards in
      // onStreamEnd / onStreamError. Without this drain window, sendMessage()
      // sets isStreaming=true immediately and the stale event arrives to find
      // isStreaming=true (from the NEW stream), bypassing the guard and killing
      // the new stream with "Claude Code process aborted by user".
      //
      // This was the v0.2.2 fix (commit c5601ec) that got lost in v0.3.x.
      console.log(`[interruptAndSend] Streaming state cleared, waiting for backend/remote idle`);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const [stillBackendActive, stillRemoteActive] = await Promise.all([
          window.electronAPI.claude.hasActiveQuery(sessionId).catch(() => false),
          window.electronAPI.ssh.hasActiveRemoteProcess(sessionId).catch(() => false),
        ]);
        if (!stillBackendActive && !stillRemoteActive) break;
        if (attempt === 5) {
          console.warn(`[interruptAndSend] Backend/remote still active after force-send wait for ${sessionId}`);
        }
      }
      console.log(`[interruptAndSend] Drain complete, sending new message`);
    }

    // Clear the main-process queue before sending the new message
    await (window.electronAPI.queue?.clear(sessionId) || Promise.resolve()).catch(() => undefined);

    // Send new message (use fresh state, not the stale closure from before cancel)
    await get().sendMessage(sessionId, message, attachments);
  },

  // Setup progress methods
  setSetupProgress: (sessionId, progress) => {
    set((state) => ({
      setupProgress: {
        ...state.setupProgress,
        [sessionId]: progress,
      },
    }));
  },

  subscribeToSetupProgress: () => {
    if (!hasElectronAPI) return noop;

    const handleProgress = (progress: { sessionId: string; status: 'running' | 'completed' | 'error'; message?: string; output?: string; error?: string }) => {
      const { setupProgress, setSetupProgress, addMessage } = get();
      console.log('[SessionStore] Setup progress received:', progress);

      // Get existing progress for this session to accumulate output
      const existing = setupProgress[progress.sessionId];

      // Accumulate output if we have existing output and new output
      let accumulatedOutput = progress.output || '';
      if (existing?.output && progress.output) {
        accumulatedOutput = existing.output + progress.output;
      } else if (existing?.output && !progress.output) {
        accumulatedOutput = existing.output;
      }

      setSetupProgress(progress.sessionId, {
        ...progress,
        output: accumulatedOutput,
      });

      // If setup completed or errored, add output as a system message in chat and clear progress
      if (progress.status === 'completed' || progress.status === 'error') {
        // Add setup output as a system message at the top of chat
        if (accumulatedOutput) {
          const statusEmoji = progress.status === 'completed' ? '✓' : '✗';
          const statusText = progress.status === 'completed' ? 'Setup completed' : 'Setup failed';
          addMessage(progress.sessionId, {
            id: `setup-${Date.now()}`,
            role: 'system',
            content: `**${statusEmoji} ${statusText}**\n\n\`\`\`\n${accumulatedOutput.trim()}\n\`\`\`${progress.error ? `\n\n**Error:** ${progress.error}` : ''}`,
            timestamp: new Date(),
          });
        }

        setTimeout(() => {
          setSetupProgress(progress.sessionId, null);
        }, progress.status === 'error' ? 10000 : 1000); // Shorter delay since we now show in chat
      }
    };

    // Subscribe to both dev and SSH setup progress
    const unsubscribeDev = window.electronAPI.dev.onSetupProgress(handleProgress);
    const unsubscribeSSH = window.electronAPI.ssh.onSetupProgress(handleProgress);

    return () => {
      unsubscribeDev();
      unsubscribeSSH();
    };
  },

  // Background task methods
  addBackgroundTask: (sessionId, task) => {
    set((state) => ({
      backgroundTasks: {
        ...state.backgroundTasks,
        [sessionId]: [...(state.backgroundTasks[sessionId] || []), task],
      },
    }));
    console.log('[SessionStore] Added background task:', task.id, task.command.slice(0, 50));
  },

  updateBackgroundTask: (sessionId, taskId, updates) => {
    set((state) => ({
      backgroundTasks: {
        ...state.backgroundTasks,
        [sessionId]: (state.backgroundTasks[sessionId] || []).map((task) =>
          task.id === taskId ? { ...task, ...updates } : task
        ),
      },
    }));
  },

  removeBackgroundTask: (sessionId, taskId) => {
    set((state) => ({
      backgroundTasks: {
        ...state.backgroundTasks,
        [sessionId]: (state.backgroundTasks[sessionId] || []).filter((task) => task.id !== taskId),
      },
    }));
    console.log('[SessionStore] Removed background task:', taskId);
  },

  subscribeToBackgroundTasks: () => {
    if (!hasElectronAPI) return noop;

    const { updateBackgroundTask } = get();

    // Subscribe to background task output updates
    const unsubscribeOutput = window.electronAPI.claude.onBackgroundTaskOutput?.((data) => {
      console.log('[SessionStore] Background task output received:', data.taskId);
      updateBackgroundTask(data.sessionId, data.taskId, {
        output: data.output,
        status: data.status,
        completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
      });
    });

    // Subscribe to SDK task_notification events (background task completed/failed/stopped).
    // Routes to MonitorBlock by matching task_id to an existing monitor entry,
    // and fires a desktop notification so the user knows a background task finished.
    const unsubTaskNotif = window.electronAPI.claude.onTaskNotification?.((data) => {
      console.log('[SessionStore] Task notification:', data.taskId, data.status, data.summary?.slice(0, 60));

      // Update MonitorBlock — mark matching task as inactive + append summary,
      // then auto-remove after 10 seconds so completed monitors don't accumulate.
      if (data.taskId || data.toolUseId) {
        set((state) => {
          const existing = state.monitorInstances[data.sessionId] || [];
          const idx = findMonitorIndex(existing, data.taskId, data.toolUseId);
          if (idx < 0) return state;
          const updated = [...existing];
          const text = data.summary || taskStatusText(data.status) || 'Task finished';
          updated[idx] = {
            ...updated[idx],
            id: nextMonitorId(updated[idx], data.taskId),
            active: false,
            events: appendMonitorEvent(
              updated[idx].events,
              makeMonitorEvent(data.taskId || data.toolUseId || 'task', `[${data.status || 'done'}] ${text}`),
            ),
          };
          return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: updated } };
        });

        // Auto-remove completed monitor after 10s
        setTimeout(() => {
          set((state) => {
            const existing = state.monitorInstances[data.sessionId] || [];
            const filtered = existing.filter((m) => findMonitorIndex([m], data.taskId, data.toolUseId) < 0);
            return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: filtered } };
          });
        }, 10000);
      }

      // Desktop notification when a background task finishes
      const activeId = get().activeSessionId;
      const session = get().sessions.find((s) => s.id === data.sessionId);
      const sessionName = session ? getSessionDisplayName(session) : 'Session';
      const statusEmoji = data.status === 'completed' ? '\u2705' : data.status === 'failed' ? '\u274c' : '\u23f9\ufe0f';
      try {
        const notification = new Notification(`${statusEmoji} ${sessionName}`, {
          body: data.summary || `Task ${data.status || 'finished'}`,
          silent: data.sessionId === activeId,
        });
        notification.onclick = () => {
          get().setActiveSession(data.sessionId);
          window.focus();
        };
      } catch {
        // Notifications may not be available
      }
    });

    // Subscribe to SDK task_progress / tool_progress events.
    // Appends progress descriptions to the MonitorBlock entry for live feedback.
    const unsubTaskProg = window.electronAPI.claude.onTaskProgress?.((data) => {
      if (!data.taskId && !data.toolUseId) return;
      const monitorId = data.taskId || data.toolUseId || 'task';
      const text = data.description || data.summary || (data.toolName ? `${data.toolName}...` : 'working...');
      set((state) => {
        const existing = state.monitorInstances[data.sessionId] || [];
        let idx = findMonitorIndex(existing, data.taskId, data.toolUseId);

        // Auto-create a monitor entry if one doesn't exist yet.
        // Monitor tool events arrive as SDK notifications with a key but
        // no prior onToolCall, so the entry wouldn't have been pre-created.
        if (idx < 0) {
          const newEntry = {
            id: monitorId,
            description: data.description || monitorId,
            events: [],
            active: true,
            kind: 'monitor' as const,
            startedAt: Date.now(),
          };
          const withNew = [...existing, newEntry];
          idx = withNew.length - 1;
          // Dedupe check
          const newEvent = makeMonitorEvent('prog', text);
          withNew[idx] = { ...withNew[idx], events: [newEvent] };
          return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: withNew } };
        }

        const updated = [...existing];
        // Dedupe consecutive identical progress messages
        const lastEvent = updated[idx].events[updated[idx].events.length - 1];
        if (lastEvent?.text === text) return state;
        updated[idx] = {
          ...updated[idx],
          id: nextMonitorId(updated[idx], data.taskId),
          description: data.description || updated[idx].description,
          events: appendMonitorEvent(updated[idx].events, makeMonitorEvent('prog', text)),
        };
        return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: updated } };
      });
    });

    // Subscribe to SDK task_updated events (real-time status delta patches).
    // This is the primary mechanism for tracking task lifecycle — task_notification
    // only fires on terminal states but task_updated fires on every transition.
    const unsubTaskUpdated = window.electronAPI.claude.onTaskUpdated?.((data) => {
      const { taskId, toolUseId, patch, sessionId: sid } = data;
      const terminalStatuses = ['completed', 'failed', 'killed'];
      const isTerminal = patch.status && terminalStatuses.includes(patch.status);
      const text = patch.description || patch.error || taskStatusText(patch.status);

      if (isTerminal) {
        console.log('[SessionStore] Task updated (terminal):', taskId, patch.status);
      }

      set((state) => {
        const existing = state.monitorInstances[sid] || [];
        const idx = findMonitorIndex(existing, taskId, toolUseId);

        // Auto-create monitor entry if we get an update for an unknown task
        if (idx < 0) {
          if (isTerminal) return state; // Don't create entries for already-done tasks
          const newEntry = {
            id: taskId,
            description: patch.description || taskId,
            events: text ? [makeMonitorEvent('upd', text)] : [],
            active: true,
            kind: 'monitor' as const,
            startedAt: Date.now(),
          };
          const withNew = [...existing, newEntry];
          return { monitorInstances: { ...state.monitorInstances, [sid]: withNew } };
        }

        const updated = [...existing];
        const previousEvents = updated[idx].events || [];
        const lastEvent = previousEvents[previousEvents.length - 1];
        const nextEvents = text && lastEvent?.text !== text
          ? appendMonitorEvent(previousEvents, makeMonitorEvent(patch.error ? 'err' : 'upd', patch.error ? `Error: ${patch.error}` : text))
          : previousEvents;
        updated[idx] = {
          ...updated[idx],
          id: nextMonitorId(updated[idx], taskId),
          description: patch.description || updated[idx].description,
          ...(isTerminal ? { active: false } : {}),
          events: nextEvents,
        };
        return { monitorInstances: { ...state.monitorInstances, [sid]: updated } };
      });

      // Auto-remove terminal tasks after 10s (same as task_notification)
      if (isTerminal) {
        setTimeout(() => {
          set((state) => {
            const existing = state.monitorInstances[sid] || [];
            return { monitorInstances: { ...state.monitorInstances, [sid]: existing.filter((m) => findMonitorIndex([m], taskId, toolUseId) < 0) } };
          });
        }, 10000);
      }
    });

    return () => {
      unsubscribeOutput?.();
      unsubTaskNotif?.();
      unsubTaskProg?.();
      unsubTaskUpdated?.();
    };
  },

  // Smart Compact / Compaction status methods
  setCompactionStatus: (sessionId, status) => {
    set((state) => {
      const currentStatus = state.compactionStatus[sessionId] as (CompactionStatus & { startTime?: number }) | null;

      // If compaction is starting, add start time
      if (status?.isCompacting && (!currentStatus || !currentStatus.isCompacting)) {
        return {
          compactionStatus: {
            ...state.compactionStatus,
            [sessionId]: {
              ...status,
              startTime: Date.now(),
            } as CompactionStatus & { startTime: number },
          },
        };
      }

      // If compaction is ending but still has data, preserve start time for display
      if (status && !status.isCompacting && currentStatus?.startTime) {
        return {
          compactionStatus: {
            ...state.compactionStatus,
            [sessionId]: {
              ...status,
              startTime: currentStatus.startTime,
            } as CompactionStatus & { startTime: number },
          },
        };
      }

      return {
        compactionStatus: {
          ...state.compactionStatus,
          [sessionId]: status,
        },
      };
    });
  },

  dismissCompactionSwitch: (sessionId) => {
    set((state) => ({
      compactionSwitch: state.compactionSwitch[sessionId]
        ? { ...state.compactionSwitch, [sessionId]: null }
        : state.compactionSwitch,
    }));
  },

  handoffCompactionModel: (sessionId, model) => {
    const currentState = get();
    const currentNotice = currentState.compactionSwitch[sessionId];
    if (!currentNotice) {
      return;
    }

    const previousModel = getSessionModel(currentState, sessionId);
    const normalizedPermissionMode = normalizePermissionModeForModel(
      model,
      currentState.permissionMode[sessionId],
    );

    set((state) => ({
      selectedModel: {
        ...state.selectedModel,
        [sessionId]: model,
      },
      permissionMode: {
        ...state.permissionMode,
        [sessionId]: normalizedPermissionMode,
      },
      compactionSwitch: {
        ...state.compactionSwitch,
        [sessionId]: {
          ...currentNotice,
          handoffSelected: true,
          handoffModel: model,
          autoSwitched: true,
        },
      },
    }));

    persistModelSelection(sessionId, model, normalizedPermissionMode);
    if (hasElectronAPI && previousModel !== model) {
      window.electronAPI.analytics.recordHarnessSelection?.({
        sessionId,
        timestamp: Date.now(),
        fromModel: previousModel,
        toModel: model,
        trigger: 'compaction-handoff',
        isManualSelection: model !== 'auto',
      }).catch((err: Error) => {
        console.warn('[SessionStore] Failed to record compaction handoff selection:', err);
      });
    }
  },

  restoreCompactionModel: (sessionId) => {
    const currentState = get();
    const currentNotice = currentState.compactionSwitch[sessionId];
    if (!currentNotice) {
      return;
    }

    const normalizedPermissionMode = normalizePermissionModeForModel(
      currentNotice.originalModel,
      currentState.permissionMode[sessionId],
    );

    set((state) => ({
      selectedModel: {
        ...state.selectedModel,
        [sessionId]: currentNotice.originalModel,
      },
      permissionMode: {
        ...state.permissionMode,
        [sessionId]: normalizedPermissionMode,
      },
      compactionSwitch: {
        ...state.compactionSwitch,
        [sessionId]: null,
      },
    }));

    persistModelSelection(sessionId, currentNotice.originalModel, normalizedPermissionMode);
  },

  subscribeToCompaction: () => {
    if (!hasElectronAPI) return noop;

    const { setCompactionStatus } = get();

    // Subscribe to compaction status changes
    const unsubscribeStatus = window.electronAPI.claude.onCompactionStatus((status) => {
      console.log('[SessionStore] Compaction status received:', status);

      if (status.isCompacting) {
        const currentState = get();
        const sourceModel = currentState.activeStreamModel[status.sessionId]
          || getSessionModel(currentState, status.sessionId)
          || 'claude-opus-4-6';
        const fallbackModel = getPreferredCompactionFallbackModel(currentState.availableModels, sourceModel);
        const hasAutoModel = currentState.availableModels.some((model) => model.id === 'auto');
        const recommendedModel = hasAutoModel ? 'auto' : fallbackModel;

        set((state) => {
          const existingNotice = state.compactionSwitch[status.sessionId];

          return {
            compactionSwitch: {
              ...state.compactionSwitch,
              [status.sessionId]: {
                status: 'compacting',
                originalModel: existingNotice?.originalModel || sourceModel,
                fallbackModel: fallbackModel || existingNotice?.fallbackModel,
                recommendedModel: recommendedModel || existingNotice?.recommendedModel,
                autoSwitched: existingNotice?.autoSwitched || false,
                handoffSelected: existingNotice?.handoffSelected,
                handoffModel: existingNotice?.handoffModel,
                startedAt: existingNotice?.status === 'compacting' ? existingNotice.startedAt : Date.now(),
                preTokens: status.preTokens ?? existingNotice?.preTokens,
                postTokens: existingNotice?.postTokens,
              },
            },
          };
        });
      }

      setCompactionStatus(status.sessionId, status as CompactionStatus);
    });

    // Subscribe to compaction complete events
    const unsubscribeComplete = window.electronAPI.claude.onCompactionComplete((complete) => {
      console.log('[SessionStore] Compaction complete received:', complete);

      // Update status with completion data (token reduction)
      const currentStatus = get().compactionStatus[complete.sessionId];
      if (currentStatus) {
        setCompactionStatus(complete.sessionId, {
          ...currentStatus,
          isCompacting: false,
          preTokens: complete.preTokens,
          postTokens: complete.postTokens,
        } as CompactionStatus & { startTime: number; postTokens: number });
      }

      const currentNotice = get().compactionSwitch[complete.sessionId];
      if (currentNotice) {
        set((state) => ({
          compactionSwitch: {
            ...state.compactionSwitch,
            [complete.sessionId]: {
              ...currentNotice,
              status: 'complete',
              completedAt: Date.now(),
              preTokens: complete.preTokens ?? currentNotice.preTokens,
              postTokens: complete.postTokens ?? currentNotice.postTokens,
            },
          },
        }));
      }

      // Clear compaction status after showing completion briefly
      setTimeout(() => {
        setCompactionStatus(complete.sessionId, null);
      }, 3000); // Increased to 3s to show the completion status
    });

    return () => {
      unsubscribeStatus();
      unsubscribeComplete();
    };
  },

  // Auto-resume methods for Build It mode
  saveAutoResumeState: async (sessionId) => {
    if (!hasElectronAPI) return;
    if (isDevRendererRuntime()) {
      return;
    }

    const state = get();
    const isStreaming = state.isStreaming[sessionId];
    const permissionMode = state.permissionMode[sessionId] || 'default';

    // Only save state if we're in Build It mode (bypassPermissions) and streaming
    if (permissionMode !== 'bypassPermissions' || !isStreaming) {
      return;
    }

    console.log('[SessionStore] Saving auto-resume state for Build It session:', sessionId);
    const session = state.sessions.find(s => s.id === sessionId);
    await window.electronAPI.claude.saveAutoResumeState({
      sessionId,
      wasStreaming: true,
      permissionMode,
      isSSH: !!session?.sshConfig,
    });
  },

  clearAutoResumeState: async () => {
    if (!hasElectronAPI) return;
    await window.electronAPI.claude.clearAutoResumeState();
  },

  checkAndAutoResume: async () => {
    if (!hasElectronAPI) return;
    if (isDevRendererRuntime()) {
      await window.electronAPI.claude.clearAutoResumeState();
      return;
    }

    try {
      const resumeState = await window.electronAPI.claude.getAutoResumeState();

      if (!resumeState) {
        return;
      }

      console.log('[SessionStore] Found auto-resume state:', resumeState);

      // Clear the state first to prevent re-triggering
      await window.electronAPI.claude.clearAutoResumeState();

      const { sessionId, wasStreaming, permissionMode } = resumeState;

      // Only auto-resume for Build It mode (bypassPermissions)
      if (permissionMode !== 'bypassPermissions' || !wasStreaming) {
        console.log('[SessionStore] Not auto-resuming - not Build It mode or was not streaming');
        return;
      }

      // Check if the session still exists
      const state = get();
      const session = state.sessions.find(s => s.id === sessionId);
      if (!session) {
        console.log('[SessionStore] Session not found for auto-resume:', sessionId);
        return;
      }

      if (session.sshConfig) {
        const hasRecoverable = window.electronAPI.ssh.hasRecoverableRemoteProcess
          ? await window.electronAPI.ssh.hasRecoverableRemoteProcess(sessionId, { closeAfter: true })
          : await window.electronAPI.ssh.hasActiveRemoteProcess(sessionId);

        if (!hasRecoverable) {
          console.log('[SessionStore] SSH auto-resume state found, but no recoverable remote turn exists:', sessionId);
          return;
        }

        set((s) => ({
          permissionMode: { ...s.permissionMode, [sessionId]: 'bypassPermissions' },
        }));
        markRemoteProcessStreaming(sessionId, get, set);
        console.log('[SessionStore] SSH Build It session is recoverable; reattaching to startup stream:', sessionId);
        void state.setActiveSession(sessionId);
        startRemoteProcessMonitor(sessionId, get, set, state.loadMessages, {
          recoverableKnown: true,
          attachStream: true,
        });
        return;
      }

      console.log('[SessionStore] Auto-resuming Build It session:', sessionId);

      // Set the session as active
      state.setActiveSession(sessionId);

      // Restore permission mode
      set((s) => ({
        permissionMode: { ...s.permissionMode, [sessionId]: 'bypassPermissions' },
      }));

      // Wait a moment for UI to settle, then send continuation message
      setTimeout(() => {
        const currentState = get();
        // Make sure we're not already streaming
        if (!currentState.isStreaming[sessionId]) {
          console.log('[SessionStore] Sending auto-resume continuation message');
          currentState.sendMessage(sessionId, 'Continue where you left off. The app was restarted mid-task. Please resume your work.');
        }
      }, 2000);

    } catch (error) {
      console.error('[SessionStore] Auto-resume check failed:', error);
    }
  },

  setupAutoResumeOnClose: () => {
    if (!hasElectronAPI || typeof window === 'undefined') return noop;
    if (isDevRendererRuntime()) return noop;

    const handleBeforeUnload = () => {
      const state = get();
      const activeSessionId = state.activeSessionId;

      if (activeSessionId) {
        // This is a sync-ish operation since we can't await in beforeunload
        // The save will happen in the background
        state.saveAutoResumeState(activeSessionId);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  },

  rewindAndFork: async (messageId: string) => {
    if (!hasElectronAPI) return;

    const { activeSessionId, loadSessions, setActiveSession, loadMessages } = get();
    if (!activeSessionId) {
      console.error('[SessionStore] No active session for rewind and fork');
      return;
    }

    try {
      console.log('[SessionStore] Rewinding and forking session at message:', messageId);

      // Call the backend to create the forked session
      const forkedSession = await window.electronAPI.sessions.rewindAndFork(
        activeSessionId,
        messageId
      );

      console.log('[SessionStore] Created forked session:', forkedSession.id);

      // Reload sessions to include the new fork
      await loadSessions();

      // Switch to the forked session
      await setActiveSession(forkedSession.id);

      // Load messages for the forked session
      await loadMessages(forkedSession.id);

      console.log('[SessionStore] Switched to forked session:', forkedSession.name);
    } catch (error) {
      console.error('[SessionStore] Failed to rewind and fork session:', error);
      throw error;
    }
  },

  /**
   * Create a conversation fork from the current session
   * Fork is created at the end of the current conversation
   * The user's message is sent only to the fork, not the parent
   */
  createForkFromCurrent: async (userMessage: string) => {
    if (!hasElectronAPI) return;

    const { activeSessionId, sessions, setActiveSession, sendMessage } = get();
    if (!activeSessionId) {
      console.error('[SessionStore] No active session to fork from');
      return;
    }

    try {
      console.log('[SessionStore] Creating conversation fork from:', activeSessionId);

      // Create fork via backend IPC (at 'end' of conversation)
      const forkedSession = await window.electronAPI.sessions.createFork(
        activeSessionId,
        'end',
        userMessage
      );

      console.log('[SessionStore] Created conversation fork:', forkedSession.id);

      // DON'T clear parent session's streaming state — let it keep running
      // The fork is a separate conversation that doesn't affect the parent

      // Update fork group tracking — re-parent under the root so
      // getForkSiblings (which collects direct children of root) finds it.
      const currentSession = sessions.find(s => s.id === activeSessionId);
      let rootId = activeSessionId;
      let walkSession = currentSession;
      while (walkSession?.parentSessionId) {
        rootId = walkSession.parentSessionId;
        walkSession = sessions.find(s => s.id === rootId);
      }

      // Add to session list, re-parented under root + added to root's children
      set(state => {
        if (state.sessions.some(s => s.id === forkedSession.id)) return state;
        return {
          sessions: [
            ...state.sessions.map(s => {
              if (s.id === rootId) {
                const children = [...(s.childSessionIds || [])];
                if (!children.includes(forkedSession.id)) children.push(forkedSession.id);
                return { ...s, childSessionIds: children, isRoot: true } as typeof s;
              }
              return s;
            }),
            { ...forkedSession, parentSessionId: rootId } as any,
          ],
        };
      });

      // Persist re-parenting to backend
      if (rootId !== activeSessionId) {
        window.electronAPI.sessions.update(forkedSession.id, {
          parentSessionId: rootId,
        } as any).catch(e => console.warn('[SessionStore] Failed to re-parent fork:', e));
        const rootSession = sessions.find(s => s.id === rootId);
        const rootChildren = [...(rootSession?.childSessionIds || [])];
        if (!rootChildren.includes(forkedSession.id)) {
          rootChildren.push(forkedSession.id);
          window.electronAPI.sessions.update(rootId, {
            childSessionIds: rootChildren,
            isRoot: true,
          } as any).catch(e => console.warn('[SessionStore] Failed to update root children:', e));
        }
      }

      // Switch to new fork
      await setActiveSession(forkedSession.id);

      // Send user message to new fork
      await sendMessage(forkedSession.id, userMessage);

      console.log('[SessionStore] Fork created and message sent:', forkedSession.name);
    } catch (error) {
      console.error('[SessionStore] Failed to create conversation fork:', error);
      throw error;
    }
  },

  /**
   * Get all sibling forks (parent + children) for a given session
   * Returns sessions sorted by creation order
   */
  getForkSiblings: (sessionId: string) => {
    const { sessions } = get();
    const currentSession = sessions.find(s => s.id === sessionId);
    if (!currentSession) return [];

    // Find root (walk up parentSessionId chain, with cycle + depth guard)
    let rootId = sessionId;
    let session: Session | undefined = currentSession;
    const seen = new Set<string>([sessionId]);
    let depth = 0;
    while (session?.parentSessionId && depth < 20) {
      if (seen.has(session.parentSessionId)) break;
      rootId = session.parentSessionId;
      seen.add(rootId);
      session = sessions.find(s => s.id === rootId);
      if (!session) break;
      depth++;
    }

    // Collect root + all descendants (shallow BFS capped at 3 passes to
    // avoid perf issues with very deep trees — should be 1 pass now that
    // createForkFromCurrent re-parents under root).
    const root = sessions.find(s => s.id === rootId);
    if (!root) return [];

    const forkGroup: Session[] = [root];
    const groupIds = new Set<string>([rootId]);
    let changed = true;
    let passes = 0;
    while (changed && passes < 3) {
      changed = false;
      passes++;
      for (const s of sessions) {
        if (!groupIds.has(s.id) && s.parentSessionId && groupIds.has(s.parentSessionId)) {
          groupIds.add(s.id);
          forkGroup.push(s);
          changed = true;
        }
      }
    }

    // Sort by creation order
    return forkGroup.sort((a, b) => {
      const aTime = a.forkCreatedAt || a.createdAt;
      const bTime = b.forkCreatedAt || b.createdAt;
      const aDate = typeof aTime === 'string' ? new Date(aTime) : aTime;
      const bDate = typeof bTime === 'string' ? new Date(bTime) : bTime;
      return aDate.getTime() - bDate.getTime();
    });
  },

  /**
   * Get all sessions sharing the same project directory as the given session.
   * Includes both stored and discovered sessions. For SSH sessions, matches
   * on host + remoteWorkdir. For local sessions, matches on worktreePath's
   * parent repo path. These appear in the overflow menu as "adoptable" tabs.
   */
  getProjectSessions: (sessionId: string) => {
    const { sessions } = get();
    const currentSession = sessions.find(s => s.id === sessionId);
    if (!currentSession) return [];

    const currentWorkdir = currentSession.worktreePath || currentSession.repoPath || '';
    const currentHost = (currentSession as any).sshConfig?.host;

    // Match sessions with the exact same worktreePath (same working directory).
    // For SSH: also requires same host.
    const matches = sessions.filter(s => {
      if (s.id === sessionId) return false;
      const sWorkdir = s.worktreePath || s.repoPath || '';
      if (!sWorkdir || !currentWorkdir) return false;

      if (currentHost) {
        const sHost = (s as any).sshConfig?.host;
        return sHost === currentHost && sWorkdir === currentWorkdir;
      } else {
        return sWorkdir === currentWorkdir;
      }
    });

    // Sort by most recently updated
    return matches.sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt;
      const bTime = b.updatedAt || b.createdAt;
      const aDate = typeof aTime === 'string' ? new Date(aTime) : (aTime || new Date(0));
      const bDate = typeof bTime === 'string' ? new Date(bTime) : (bTime || new Date(0));
      return bDate.getTime() - aDate.getTime();
    });
  },

  /**
   * Cycle through fork tabs
   * @param direction 'next' or 'prev'
   */
  cycleForkTabs: (direction: 'next' | 'prev') => {
    const { activeSessionId, getForkSiblings, setActiveSession } = get();
    if (!activeSessionId) return;

    const siblings = getForkSiblings(activeSessionId);
    if (siblings.length <= 1) return;

    const currentIndex = siblings.findIndex(s => s.id === activeSessionId);
    const delta = direction === 'next' ? 1 : -1;
    const nextIndex = (currentIndex + delta + siblings.length) % siblings.length;

    setActiveSession(siblings[nextIndex].id);
  },

  // --- /codex (second opinion) ---
  startCodexRun: async (sessionId: string, prompt: string) => {
    if (!hasElectronAPI) return;
    set((state) => ({
      codexStreaming: { ...state.codexStreaming, [sessionId]: true },
      codexContent: { ...state.codexContent, [sessionId]: '' },
      codexThinking: { ...state.codexThinking, [sessionId]: '' },
      codexToolCalls: { ...state.codexToolCalls, [sessionId]: [] },
      codexError: { ...state.codexError, [sessionId]: null },
      codexPrompt: { ...state.codexPrompt, [sessionId]: prompt },
    }));
    await window.electronAPI.codex.run(sessionId, prompt);
  },

  cancelCodexRun: (sessionId: string) => {
    if (!hasElectronAPI) return;
    window.electronAPI.codex.cancel(sessionId);
    set((state) => ({
      codexStreaming: { ...state.codexStreaming, [sessionId]: false },
    }));
  },

  dismissCodex: (sessionId: string) => {
    set((state) => ({
      codexStreaming: { ...state.codexStreaming, [sessionId]: false },
      codexContent: { ...state.codexContent, [sessionId]: '' },
      codexThinking: { ...state.codexThinking, [sessionId]: '' },
      codexToolCalls: { ...state.codexToolCalls, [sessionId]: [] },
      codexError: { ...state.codexError, [sessionId]: null },
      codexPrompt: { ...state.codexPrompt, [sessionId]: '' },
    }));
  },

  subscribeToCodex: () => {
    if (!hasElectronAPI) return noop;

    const unsubChunk = window.electronAPI.codex.onStreamChunk(({ sessionId, content }) => {
      set((state) => ({
        codexContent: {
          ...state.codexContent,
          [sessionId]: (state.codexContent[sessionId] || '') + content,
        },
      }));
    });

    const unsubThinking = window.electronAPI.codex.onThinking(({ sessionId, content }) => {
      set((state) => ({
        codexThinking: {
          ...state.codexThinking,
          [sessionId]: (state.codexThinking[sessionId] || '') + content,
        },
      }));
    });

    const unsubToolCall = window.electronAPI.codex.onToolCall(({ sessionId, toolCall }) => {
      const normalizedToolCall = normalizeToolCall(toolCall as ToolCall);
      set((state) => {
        const existing = state.codexToolCalls[sessionId] || [];
        // Update existing tool call or add new one
        const idx = existing.findIndex(tc => tc.id === normalizedToolCall.id);
        const updated = idx >= 0
          ? existing.map((tc, i) => i === idx ? normalizedToolCall : tc)
          : [...existing, normalizedToolCall];
        return {
          codexToolCalls: { ...state.codexToolCalls, [sessionId]: updated },
        };
      });
    });

    const unsubComplete = window.electronAPI.codex.onComplete(({ sessionId }) => {
      set((state) => ({
        codexStreaming: { ...state.codexStreaming, [sessionId]: false },
      }));
    });

    const unsubError = window.electronAPI.codex.onError(({ sessionId, error }) => {
      set((state) => ({
        codexStreaming: { ...state.codexStreaming, [sessionId]: false },
        codexError: { ...state.codexError, [sessionId]: error },
      }));
    });

    return () => {
      unsubChunk();
      unsubThinking();
      unsubToolCall();
      unsubComplete();
      unsubError();
    };
  },

  // --- /btw (ephemeral side question) ---
  askBtw: async (sessionId: string, question: string) => {
    if (!hasElectronAPI) return;
    // Set initial state — replaces any previous /btw for this session
    set((state) => ({
      btw: {
        ...state.btw,
        [sessionId]: { question, response: '', isStreaming: true },
      },
    }));
    await window.electronAPI.claude.askBtw(sessionId, question);
  },

  dismissBtw: (sessionId: string) => {
    set((state) => ({
      btw: { ...state.btw, [sessionId]: null },
    }));
  },

  subscribeToBtw: () => {
    if (!hasElectronAPI) return noop;
    const unsub = window.electronAPI.claude.onBtwResponse(({ sessionId, content, done }) => {
      set((state) => {
        const current = state.btw[sessionId];
        if (!current) return state;
        return {
          btw: {
            ...state.btw,
            [sessionId]: {
              ...current,
              response: current.response + content,
              isStreaming: !done,
            },
          },
        };
      });
    });
    return unsub;
  },

  // --- /rc (remote control) ---
  startRemoteControl: async (sessionId: string) => {
    if (!hasElectronAPI) return;
    await window.electronAPI.claude.startRc(sessionId);
  },

  stopRemoteControl: (sessionId: string) => {
    if (!hasElectronAPI) return;
    window.electronAPI.claude.stopRc(sessionId);
    get().clearRemoteControl(sessionId);
  },

  setRemoteControl: (sessionId: string, url: string) => {
    set((state) => ({
      remoteControl: {
        ...state.remoteControl,
        [sessionId]: { url, startedAt: new Date() },
      },
    }));
  },

  clearRemoteControl: (sessionId: string) => {
    set((state) => ({
      remoteControl: { ...state.remoteControl, [sessionId]: null },
    }));
  },

  subscribeToRemoteControl: () => {
    if (!hasElectronAPI) return noop;
    const unsubStarted = window.electronAPI.claude.onRcStarted(({ sessionId, url }) => {
      get().setRemoteControl(sessionId, url);
    });
    const unsubStopped = window.electronAPI.claude.onRcStopped(({ sessionId }) => {
      get().clearRemoteControl(sessionId);
    });
    return () => {
      unsubStarted();
      unsubStopped();
    };
  },
}));
