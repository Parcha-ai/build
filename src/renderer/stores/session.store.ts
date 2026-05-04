import { create } from 'zustand';
import type { Session, ChatMessage, ToolCall, PermissionRequest, PermissionResponse, QuestionRequest, QuestionResponse, SetupProgressEvent, CompactionStatus, PlanApprovalRequest, PlanApprovalResponse, GStackMode } from '../../shared/types';
import { AGENT_COLORS } from '../../shared/types';
import { useAudioStore } from './audio.store';

// Check if running in Electron environment
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

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
  autoSwitched: boolean;
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
  streamGeneration: Record<string, number>; // Incremented on interrupt to detect stale STREAM_END events
  streamEvents: Record<string, StreamEvent[]>; // Chronological events
  currentStreamContent: Record<string, string>;
  currentThinkingContent: Record<string, string>;
  currentToolCalls: Record<string, ToolCall[]>;
  currentSystemInfo: Record<string, SystemInfo | null>;
  // Monitor tool instances per session (streaming background watches)
  monitorInstances: Record<string, Array<{
    id: string;
    description: string;
    events: Array<{ id: string; text: string; timestamp: number }>;
    active: boolean;
    persistent?: boolean;
    startedAt: number;
  }>>;
  activeStreamModel: Record<string, string | undefined>;
  permissionMode: Record<string, PermissionMode>;
  thinkingMode: Record<string, ThinkingMode>;
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
  }>>;
  backgroundTasks: Record<string, BackgroundTask[]>;
  // Secure keys tracking - API keys/tokens detected and secured
  securedKeys: Record<string, Array<{ id: string; type: string; description: string }>>;
  // Agent teams tracking — maps agentId to assigned colour index per session
  agentColorMap: Record<string, Record<string, number>>; // sessionId -> { agentId -> colorIndex }
  // GStack workflow mode per session
  gstackMode: Record<string, GStackMode | null>;

  // Codex (second opinion) state
  codexStreaming: Record<string, boolean>;
  codexContent: Record<string, string>;
  codexThinking: Record<string, string>;
  codexToolCalls: Record<string, Array<{ id: string; name: string; input: Record<string, unknown>; status: string; result?: string }>>;
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
  setSelectedModel: (sessionId: string, model: string) => void;
  loadAvailableModels: () => Promise<void>;
  sendMessage: (sessionId: string, message: string, attachments?: unknown[], opts?: { existingMessageId?: string }) => Promise<void>;
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

export function isCodexModel(model?: string | null): boolean {
  return model?.startsWith('codex:') ?? false;
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
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
];

const PREFERRED_CODEX_FALLBACK_MODELS = [
  'codex:gpt-5.4',
  'codex:gpt-5.3-codex',
  'codex:o3',
  'codex:gpt-5.4-mini',
];

interface LoadMessagesOptions {
  replaceWhileStreaming?: boolean;
}

const remoteProcessPollers = new Set<string>();

function startRemoteProcessMonitor(
  sessionId: string,
  getState: () => SessionState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: any,
  loadMessages: (sessionId: string, options?: LoadMessagesOptions) => Promise<void>,
) {
  window.electronAPI.ssh.hasActiveRemoteProcess(sessionId)
    .then((hasActiveRemoteProcess) => {
      if (!hasActiveRemoteProcess) return;

      const hasLocalLiveStream = () => {
        const state = getState();
        return Boolean(
          (state.currentStreamContent[sessionId] || '').trim()
          || (state.currentThinkingContent[sessionId] || '').trim()
          || (state.currentToolCalls[sessionId] || []).length
          || (state.streamEvents[sessionId] || []).length
        );
      };

      console.log(`[SessionStore] SSH session ${sessionId} has active remote Claude process — preserving queue state`);
      setState((state: SessionState) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: true },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
      }));

      if (remoteProcessPollers.has(sessionId)) return;
      remoteProcessPollers.add(sessionId);

      void (async () => {
        try {
          // Only load initial messages if we don't have ANY yet
          const existingMessages = getState().messages[sessionId] || [];
          if (existingMessages.length === 0) {
            console.log(`[SessionStore] Loading initial SSH transcript for ${sessionId}`);
            await loadMessages(sessionId, { replaceWhileStreaming: true });
          }

          while (remoteProcessPollers.has(sessionId)) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const stillActive = await window.electronAPI.ssh.hasActiveRemoteProcess(sessionId);
            if (stillActive) {
              // DON'T reload messages while the process is running — the SDK
              // stream delivers content via IPC and loadMessages would replace
              // in-memory messages with a stale transcript snapshot.
              continue;
            }

            console.log(`[SessionStore] Remote Claude process finished for ${sessionId}; refreshing transcript`);
            // DON'T clear currentStreamContent here — onStreamEnd needs it
            // to add the final message. Only clear activity state.
            setState((state: SessionState) => ({
              isStreaming: { ...state.isStreaming, [sessionId]: false },
              sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
            }));
            // Wait for onStreamEnd to fire and add the final message before
            // reloading from transcript. Without this delay, loadMessages
            // replaces in-memory messages with stale transcript data, losing
            // the streamed content.
            await new Promise(resolve => setTimeout(resolve, 2000));
            await loadMessages(sessionId);

            const queue = getState().messageQueue[sessionId] || [];
            if (queue.length > 0) {
              const nextMsg = queue[0];
              setState((state: SessionState) => ({
                messageQueue: {
                  ...state.messageQueue,
                  [sessionId]: (state.messageQueue[sessionId] || []).slice(1),
                },
              }));
              setTimeout(() => {
                getState().sendMessage(sessionId, nextMsg.message, nextMsg.attachments, { existingMessageId: nextMsg.id });
              }, 100);
            }
            break;
          }
        } catch (error) {
          console.warn('[SessionStore] Failed while polling remote SSH process:', error);
        } finally {
          remoteProcessPollers.delete(sessionId);
        }
      })();
    })
    .catch((error) => {
      console.warn('[SessionStore] Failed to check active remote SSH process:', error);
    });
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

type PersistedChatMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

export function getSupplementalStorageKey(sessionId: string): string {
  return `${SUPPLEMENTAL_MESSAGES_STORAGE_PREFIX}${sessionId}`;
}

function normalizeChatMessageTimestamp(message: ChatMessage): ChatMessage {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  return {
    ...message,
    timestamp,
  };
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
  const toolFingerprint = (normalized.toolCalls || [])
    .map((toolCall) => `${toolCall.id}:${toolCall.name}:${toolCall.status}:${toolCall.result || ''}`)
    .join('|');

  return [
    normalized.role,
    normalized.timestamp.getTime(),
    normalized.content,
    toolFingerprint,
    normalized.interrupted ? '1' : '0',
  ].join('::');
}

function mergeTimelineMessages(primary: ChatMessage[], supplemental: ChatMessage[]): ChatMessage[] {
  const merged = [...primary, ...supplemental]
    .map(normalizeChatMessageTimestamp)
    .sort(compareChatMessages);

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: ChatMessage[] = [];

  for (const message of merged) {
    if (seenIds.has(message.id)) {
      continue;
    }

    const fingerprint = buildMessageFingerprint(message);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenIds.add(message.id);
    seenFingerprints.add(fingerprint);
    deduped.push(message);
  }

  return deduped;
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

function saveSupplementalMessages(sessionId: string, messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;

  try {
    const serialized = messages
      .map(serializeChatMessage)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    window.localStorage.setItem(getSupplementalStorageKey(sessionId), JSON.stringify(serialized));
  } catch (error) {
    console.warn('[SessionStore] Failed to save supplemental messages:', error);
  }
}

function persistSupplementalMessage(sessionId: string, message: ChatMessage): void {
  const merged = mergeTimelineMessages(loadSupplementalMessages(sessionId), [message]);
  saveSupplementalMessages(sessionId, merged);
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
  streamEvents: {}, // Chronological event stream
  currentStreamContent: {},
  currentThinkingContent: {},
  currentToolCalls: {},
  currentSystemInfo: {},
  monitorInstances: {},
  activeStreamModel: {},
  permissionMode: {},
  thinkingMode: {},
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
        const { useTaskStore } = await import('./task.store');
        const taskState = useTaskStore.getState();
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
      loadMessages(sessionId); // Don't await

      // 5. If the app was closed while a detached SSH run continued remotely,
      // preserve streaming/queue semantics until that remote process exits.
      if (session?.sshConfig) {
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

      set({
        sessions,
        activeSessionId: validActiveSessionId,
        isLoadingSessions: false,
        selectedModel: restoredModel,
        permissionMode: restoredPermission,
      });

      // Persist auto-selected session
      if (autoSelected && validActiveSessionId) {
        window.electronAPI.dev.setActiveSession(validActiveSessionId);
      }

      // Load messages for the active session
      if (validActiveSessionId) {
        const { loadMessages } = get();
        loadMessages(validActiveSessionId);
        if (activeSession?.sshConfig) {
          startRemoteProcessMonitor(validActiveSessionId, get, set, loadMessages);
        }
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
        permissionMode: clean(state.permissionMode),
        thinkingMode: clean(state.thinkingMode),
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
        const status = await window.electronAPI.git.getStatus(sessionId);
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
    if (!hasElectronAPI) return () => {};

    // Subscribe to individual session status changes
    const unsubscribeStatus = window.electronAPI.sessions.onStatusChanged((session) => {
      if (!session?.id) return;
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
      }));
    });

    // Subscribe to full session list updates (from background discovery)
    const unsubscribeList = window.electronAPI.sessions.onListUpdated((sessions) => {
      console.log('[SessionStore] Received sessions update from background discovery:', sessions.length);
      set({ sessions, isLoadingSessions: false });
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
    set((state) => {
      const existingMessages = state.messages[sessionId] || [];
      const lastMessage = existingMessages[existingMessages.length - 1];
      const isDuplicateAssistantMessage =
        message.role === 'assistant' &&
        lastMessage?.role === 'assistant' &&
        (lastMessage.id === message.id || lastMessage.content === message.content);

      if (isDuplicateAssistantMessage) {
        console.warn(`[SessionStore] Ignoring duplicate assistant message for ${sessionId}`);
        return state;
      }

      return {
        messages: {
          ...state.messages,
          [sessionId]: [...existingMessages, message],
        },
      };
    });
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
        [sessionId]: (state.currentThinkingContent[sessionId] || '') + content,
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
    set((state) => {
      const existingToolCalls = state.currentToolCalls[sessionId] || [];
      const existingIndex = existingToolCalls.findIndex(tc => tc.id === toolCall.id);

      // If tool call already exists, update it instead of adding duplicate
      if (existingIndex !== -1) {
        const updatedToolCalls = [...existingToolCalls];
        updatedToolCalls[existingIndex] = { ...existingToolCalls[existingIndex], ...toolCall };
        return {
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
        currentToolCalls: {
          ...state.currentToolCalls,
          [sessionId]: [...existingToolCalls, toolCall],
        },
        streamEvents: {
          ...state.streamEvents,
          [sessionId]: [
            ...(state.streamEvents[sessionId] || []),
            { id: toolCall.id, type: 'tool', timestamp: Date.now(), toolCall, agentId: toolCall.agentId },
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
          tc.id === toolCallId ? { ...tc, ...updates } : tc
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
      streamEvents: isStreaming
        ? { ...state.streamEvents, [sessionId]: [] }
        : state.streamEvents,
      currentStreamContent: isStreaming
        ? { ...state.currentStreamContent, [sessionId]: '' }
        : state.currentStreamContent,
      currentThinkingContent: isStreaming
        ? { ...state.currentThinkingContent, [sessionId]: '' }
        : state.currentThinkingContent,
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

    // Process queued messages when streaming ends
    if (!isStreaming) {
      // Use a microtask to ensure state has propagated
      Promise.resolve().then(() => {
        const state = get();
        const queue = state.messageQueue[sessionId] || [];
        console.log(`[SessionStore] Stream ended. Checking queue for ${sessionId}. Queue length: ${queue.length}`);

        if (queue.length > 0) {
          const nextMessage = queue[0];
          console.log(`[SessionStore] Processing next queued message: "${nextMessage.message.slice(0, 50)}..."`);

          // Lock the queue so new messages from the user don't bypass during the processing window
          set((state) => ({
            isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: true },
          }));

          // Atomically remove message from queue and verify we're not streaming
          set((state) => {
            // Double-check we're still not streaming before removing from queue
            if (state.isStreaming[sessionId]) {
              console.warn(`[SessionStore] Streaming started again before queue could be processed. Aborting.`);
              return { isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false } };
            }

            const currentQueue = state.messageQueue[sessionId] || [];
            if (currentQueue.length === 0) {
              console.warn(`[SessionStore] Queue became empty before processing. Race condition avoided.`);
              return { isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false } };
            }

            const [, ...remainingQueue] = currentQueue;
            console.log(`[SessionStore] Removed message from queue. Remaining: ${remainingQueue.length}`);

            return {
              messageQueue: {
                ...state.messageQueue,
                [sessionId]: remainingQueue,
              },
            };
          });

          // Send the message after a small delay to ensure state updates have propagated
          setTimeout(() => {
            // Clear the processing lock before sending (sendMessage will set isStreaming=true)
            set((state) => ({
              isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
            }));

            const currentState = get();
            const stillStreaming = currentState.isStreaming[sessionId];
            console.log(`[SessionStore] About to send queued message. Currently streaming: ${stillStreaming}`);

            if (!stillStreaming) {
              console.log(`[SessionStore] Sending queued message now`);
              currentState.sendMessage(sessionId, nextMessage.message, nextMessage.attachments);
            } else {
              console.warn(`[SessionStore] Cannot send queued message - streaming started again. Re-queueing.`);
              // Re-add to front of queue
              set((s) => ({
                messageQueue: {
                  ...s.messageQueue,
                  [sessionId]: [nextMessage, ...(s.messageQueue[sessionId] || [])],
                },
              }));
            }
          }, 150); // Slightly longer delay for reliability
        } else {
          console.log(`[SessionStore] No messages in queue for ${sessionId}`);
        }
      });
    }
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

  setSelectedModel: (sessionId, model) => {
    const state = get();

    // If currently streaming, cancel the active stream before switching models
    // This prevents Codex processes from running orphaned after switching to Claude
    if (state.isStreaming[sessionId]) {
      console.log(`[SessionStore] Model switch while streaming — cancelling current stream for ${sessionId}`);
      state.cancelStream(sessionId);
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
      compactionSwitch: state.compactionSwitch[sessionId]
        ? { ...state.compactionSwitch, [sessionId]: null }
        : state.compactionSwitch,
    }));

    persistModelSelection(sessionId, model, normalizedPermissionMode);
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
    const state = get();
    const currentIsStreaming = state.isStreaming[sessionId];
    const currentQueueLength = (state.messageQueue[sessionId] || []).length;

    const currentIsProcessingQueue = state.isProcessingQueue[sessionId];

    console.log(`[SessionStore] sendMessage called for session ${sessionId}`);
    console.log(`[SessionStore] isStreaming: ${currentIsStreaming}, isProcessingQueue: ${currentIsProcessingQueue}, queueLength: ${currentQueueLength}`);
    console.log(`[SessionStore] Message: "${message.slice(0, 80)}..."`);

    if (!currentIsStreaming) {
      console.warn(`[SessionStore] ⚠️ isStreaming is FALSE — message will be sent as NEW query instead of queued!`);
      console.warn(`[SessionStore] Stack trace:`, new Error().stack);
    }

    // If already streaming, queue the message
    if (state.isStreaming[sessionId]) {
      const queuedMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        message,
        attachments,
        timestamp: Date.now(),
      };
      // Show the user message in chat IMMEDIATELY with a "queued" flag so the
      // user knows their input was received. Without this, the input clears
      // but nothing visible happens — users think the send silently failed
      // and re-type the same message.
      const userMessage: ChatMessage = {
        id: queuedMsg.id,
        role: 'user',
        content: message,
        timestamp: new Date(queuedMsg.timestamp),
      };
      set((state) => ({
        messages: {
          ...state.messages,
          [sessionId]: [...(state.messages[sessionId] || []), userMessage],
        },
        messageQueue: {
          ...state.messageQueue,
          [sessionId]: [
            ...(state.messageQueue[sessionId] || []),
            queuedMsg,
          ],
        },
      }));
      console.log('[SessionStore] Message queued + shown in chat. Queue length:', (state.messageQueue[sessionId] || []).length + 1);
      console.log('[SessionStore] Queued message preview:', message.slice(0, 50));
      return;
    }

    const { addMessage, setStreaming, permissionMode, thinkingMode, selectedModel, gstackMode } = state;
    const model = selectedModel[sessionId]; // undefined = use default
    const mode = normalizePermissionModeForModel(model, permissionMode[sessionId]);
    // Apply migration to handle old thinking mode values, default to 'high' (full capability)
    const thinking = migrateThinkingMode(thinkingMode[sessionId] || 'high');
    const activeGStackMode = gstackMode[sessionId] || undefined; // Pass GStack mode directly
    console.log('[SessionStore] sendMessage - sessionId:', sessionId, 'permissionMode:', mode, 'gstackMode:', activeGStackMode, 'raw:', permissionMode[sessionId]);

    // Update session's updatedAt timestamp for recent activity and mark as idle (user sent a message)
    set((state) => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? { ...session, updatedAt: new Date() }
          : session
      ),
      sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
    }));

    // Intercept and secure any API keys/tokens in the message
    const { modifiedText, keysDetected } = await window.electronAPI.secureKeys.interceptAndReplace(sessionId, message);

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

    const supplementalMessagesForContext = loadSupplementalMessages(sessionId);

    // Add user message (with keys replaced by placeholders).
    // If the caller passed `existingMessageId` (e.g. we're re-sending a queued
    // message that was already shown in the chat when it was enqueued), skip
    // adding so the message doesn't appear twice.
    const existingMessages = get().messages[sessionId] || [];
    const alreadyInChat =
      !!opts?.existingMessageId &&
      existingMessages.some((m) => m.id === opts!.existingMessageId);
    const userMessage: ChatMessage = {
      id: opts?.existingMessageId || Date.now().toString(),
      role: 'user',
      content: modifiedText, // Use the secured version
      timestamp: new Date(),
    };
    if (!alreadyInChat) {
      addMessage(sessionId, userMessage);
    }
    if (isCodexModel(model)) {
      persistSupplementalMessage(sessionId, userMessage);
    }

    // Start streaming
    setStreaming(sessionId, true);
    set((state) => ({
      activeStreamModel: {
        ...state.activeStreamModel,
        [sessionId]: model,
      },
    }));

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
        supplementalMessagesForContext
      );
      console.log('[SessionStore] sendMessage returned:', result);

      // Update timestamp in backend as well
      window.electronAPI.sessions.update(sessionId, { updatedAt: new Date() });
    } catch (error) {
      setStreaming(sessionId, false);
      console.error('[SessionStore] Failed to send message:', error);
      console.error('[SessionStore] Error stack:', error instanceof Error ? error.stack : 'No stack');
    }
  },

  loadMessages: async (sessionId, options = {}) => {
    if (!hasElectronAPI) return;

    const perfStart = performance.now();
    const RECENT_MESSAGE_LIMIT = 100;

    const applyLoadedMessages = (transcriptMessages: ChatMessage[]) => {
      const supplementalMessages = loadSupplementalMessages(sessionId);
      const mergedMessages = mergeTimelineMessages(transcriptMessages || [], supplementalMessages);
      console.log(`[Perf] Message load took ${performance.now() - perfStart}ms (${mergedMessages.length} merged messages)`);

      if (mergedMessages.length > 0) {
        set((state) => {
          // Normal live streams own their in-memory state. Reconnected SSH
          // sessions have no attached stream reader, so poll the transcript.
          if (state.isStreaming[sessionId] && !options.replaceWhileStreaming) {
            console.log(`[SessionStore] loadMessages: Skipping replacement for ${sessionId} — currently streaming`);
            return { isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false } };
          }

          // Merge: use transcript as base but keep any in-memory messages
          // that are newer (added by onStreamEnd after the transcript was read).
          // Simply replacing caused data loss when loadMessages raced with
          // onStreamEnd — the freshly added response got wiped.
          const existing = state.messages[sessionId] || [];
          if (existing.length > 0 && mergedMessages.length > 0) {
            // Find messages in memory that aren't in the transcript (by ID)
            const transcriptIds = new Set(mergedMessages.map(m => m.id));
            const extraInMemory = existing.filter(m => !transcriptIds.has(m.id));

            // If we have extra in-memory messages (from streaming), append them
            const finalMessages = extraInMemory.length > 0
              ? [...mergedMessages, ...extraInMemory]
              : mergedMessages;

            return {
              messages: { ...state.messages, [sessionId]: finalMessages },
              isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
            };
          }

          return {
            messages: { ...state.messages, [sessionId]: mergedMessages },
            isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
          };
        });
      } else {
        // No messages returned — clear loading flag
        set((state) => ({
          isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
        }));
      }

      return mergedMessages;
    };

    set((state) => ({
      isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: true },
    }));

    try {
      // Show the newest slice first so the latest messages appear immediately.
      const recentTranscriptMessages = await window.electronAPI.claude.getMessages(sessionId, RECENT_MESSAGE_LIMIT);
      applyLoadedMessages(recentTranscriptMessages || []);

      // Then backfill older transcript history above the fold.
      // Cap at 500 messages — fetching unlimited (limit: 0) downloads entire
      // transcript files which can be 200MB+ for SSH sessions, freezing the app.
      const BACKFILL_LIMIT = 500;
      if ((recentTranscriptMessages?.length || 0) >= RECENT_MESSAGE_LIMIT) {
        set((state) => ({
          isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: true },
        }));
        const fullTranscriptMessages = await window.electronAPI.claude.getMessages(sessionId, BACKFILL_LIMIT);
        if ((fullTranscriptMessages?.length || 0) > (recentTranscriptMessages?.length || 0)) {
          applyLoadedMessages(fullTranscriptMessages || []);
        } else {
          set((state) => ({
            isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
          }));
        }
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
      set((state) => ({
        isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
      }));
    }
  },

  subscribeToClaude: () => {
    if (!hasElectronAPI) return () => {};
    const { addMessage, updateStreamContent, updateThinkingContent, addToolCall, updateToolCall, setStreaming, setSystemInfo } = get();

    const unsubChunk = window.electronAPI.claude.onStreamChunk(({ sessionId, content, agentId }) => {
      updateStreamContent(sessionId, content, agentId);
    });

    const unsubThinking = window.electronAPI.claude.onThinkingChunk(({ sessionId, content }) => {
      updateThinkingContent(sessionId, content);
    });

    const unsubToolCall = window.electronAPI.claude.onToolCall(({ sessionId, toolCall }) => {
      const tc = toolCall as ToolCall;
      console.log('[SessionStore] onToolCall received:', tc?.name, 'input:', JSON.stringify(tc?.input || {}));
      addToolCall(sessionId, tc);

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
                    events: [],
                    active: true,
                    startedAt: Date.now(),
                  },
                ],
              },
            };
          });
        }
      }

      // Teammate spawning (Agent Teams feature). The model invokes `Agent` /
      // `Task` with a `subagent_type` to run a named teammate asynchronously
      // (Scaramanga, Q, Moneypenny, etc). Track the lifecycle so the Monitor
      // pane shows which teammates are in-flight. Result completion arrives
      // via onToolResult below.
      if ((tc?.name === 'Agent' || tc?.name === 'Task') && tc.id) {
        const input = (tc.input || {}) as { subagent_type?: string; prompt?: string; description?: string };
        if (input.subagent_type) {
          const description = `${input.subagent_type}: ${input.description || (input.prompt || '').slice(0, 60) || 'teammate'}`;
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
                    events: [],
                    active: true,
                    startedAt: Date.now(),
                  },
                ],
              },
            };
          });
        }
      }
    });

    const unsubToolResult = window.electronAPI.claude.onToolResult(async ({ sessionId, toolCall }) => {
      if (!toolCall) return;
      const tc = toolCall as ToolCall;
      console.log('[SessionStore] onToolResult received:', tc.name, 'input:', JSON.stringify(tc.input || {}));
      // Update all fields that might have changed, including input which may have been streamed
      updateToolCall(sessionId, tc.id, {
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
        const resultText = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);

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
                    ? [...updated[idx].events, { id: `${shellId}-seed`, text: resultText, timestamp: Date.now() }]
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
                  events: [
                    ...updated[idx].events,
                    { id: `${shellId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: resultText, timestamp: Date.now() },
                  ],
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

        // Teammate (Agent/Task) result — append the teammate's final message
        // and mark inactive. This captures when Scaramanga/Q/etc finish.
        if ((tc.name === 'Agent' || tc.name === 'Task') && tc.id) {
          set((state) => {
            const existing = state.monitorInstances[sessionId] || [];
            const idx = existing.findIndex((m) => m.id === tc.id);
            if (idx < 0) return state;
            const isDone = tc.status === 'completed' || tc.status === 'error';
            const updated = [...existing];
            updated[idx] = {
              ...updated[idx],
              events: resultText.trim()
                ? [...updated[idx].events, { id: `${tc.id}-done`, text: resultText, timestamp: Date.now() }]
                : updated[idx].events,
              active: !isDone,
            };
            return { monitorInstances: { ...state.monitorInstances, [sessionId]: updated } };
          });
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
                updated[idx].events.push({ id: `${tc.id}-reply`, text: resultText, timestamp: Date.now() });
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

      // Check if there are queued messages to inject after this tool completes
      const currentState = get();
      const queue = currentState.messageQueue[sessionId] || [];
      if (queue.length > 0) {
        const activeStreamModel = currentState.activeStreamModel[sessionId];
        if (isCodexModel(activeStreamModel)) {
          console.log('[SessionStore] Tool completed during Codex run - queued message will wait for stream end');
          return;
        }

        const nextMessage = queue[0];
        console.log(`[SessionStore] Tool completed, injecting queued message: "${nextMessage.message.slice(0, 50)}..."`);

        // The user message was already added to the chat when queued (sendMessage
        // line ~1395). We just need to remove it from the queue here. If for some
        // reason the message isn't already in the chat (legacy state), add it.
        set((state) => {
          const existing = state.messages[sessionId] || [];
          const alreadyShown = existing.some((m) => m.id === nextMessage.id);
          const userMessage: ChatMessage = {
            id: nextMessage.id,
            role: 'user',
            content: nextMessage.message,
            timestamp: new Date(nextMessage.timestamp),
          };
          return {
            messages: alreadyShown
              ? state.messages
              : {
                  ...state.messages,
                  [sessionId]: [...existing, userMessage],
                },
            messageQueue: {
              ...state.messageQueue,
              [sessionId]: (state.messageQueue[sessionId] || []).slice(1),
            },
          };
        });

        console.log(`[SessionStore] Queued message dequeued for inject: "${nextMessage.message.slice(0, 50)}..."`);

        // Inject into the active query via streamInput
        try {
          const success = await window.electronAPI.claude.injectMessage(
            sessionId,
            nextMessage.message,
            nextMessage.attachments as any[]
          );
          console.log(`[SessionStore] Message injection result:`, success);
          if (!success) {
            console.warn('[SessionStore] Message injection returned false - query may have ended');
            set((state) => ({
              messages: {
                ...state.messages,
                [sessionId]: (state.messages[sessionId] || []).filter((message) => message.id !== nextMessage.id),
              },
              messageQueue: {
                ...state.messageQueue,
                [sessionId]: [nextMessage, ...(state.messageQueue[sessionId] || [])],
              },
            }));

            if (!get().isStreaming[sessionId]) {
              console.log('[SessionStore] Active query ended before injection completed - sending queued message as a new turn');
              set((state) => ({
                messageQueue: {
                  ...state.messageQueue,
                  [sessionId]: (state.messageQueue[sessionId] || []).slice(1),
                },
              }));
              setTimeout(() => {
                get().sendMessage(sessionId, nextMessage.message, nextMessage.attachments);
              }, 0);
            }
          }
        } catch (error) {
          console.error('[SessionStore] Failed to inject message:', error);
          set((state) => ({
            messages: {
              ...state.messages,
              [sessionId]: (state.messages[sessionId] || []).filter((message) => message.id !== nextMessage.id),
            },
            messageQueue: {
              ...state.messageQueue,
              [sessionId]: [nextMessage, ...(state.messageQueue[sessionId] || [])],
            },
          }));

          if (!get().isStreaming[sessionId]) {
            console.log('[SessionStore] Stream already ended after injection error - sending queued message as a new turn');
            set((state) => ({
              messageQueue: {
                ...state.messageQueue,
                [sessionId]: (state.messageQueue[sessionId] || []).slice(1),
              },
            }));
            setTimeout(() => {
              get().sendMessage(sessionId, nextMessage.message, nextMessage.attachments);
            }, 0);
          }
        }
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

    const unsubEnd = window.electronAPI.claude.onStreamEnd(({ sessionId, message }) => {
      const currentState = get();

      // If streaming is already false, this is a late-arriving STREAM_END.
      // Still add the message if it has content — don't drop the turn.
      // Only skip if a NEW stream has started (generation counter changed).
      if (!currentState.isStreaming[sessionId]) {
        const hasContent = (message.content && message.content.length > 0) ||
          (currentState.currentStreamContent[sessionId] || '').length > 0;
        if (!hasContent) {
          console.log(`[SessionStore] onStreamEnd SKIPPED for ${sessionId} — streaming false, no content`);
          return;
        }
        console.log(`[SessionStore] onStreamEnd for ${sessionId} — streaming was false but message has content, adding anyway`);
      }

      const queueLength = (currentState.messageQueue[sessionId] || []).length;
      const streamModel = currentState.activeStreamModel[sessionId];

      // Get the accumulated stream content - this is what was actually streamed
      const streamedContent = currentState.currentStreamContent[sessionId] || '';
      const messageContent = message.content || streamedContent;

      console.log(`[SessionStore] onStreamEnd received for ${sessionId}. Backend message length: ${message.content?.length || 0}, streamed content length: ${streamedContent.length}`);
      console.log(`[SessionStore] onStreamEnd - Queue has ${queueLength} messages waiting`);

      setStreaming(sessionId, false);

      // Use the streamed content if the backend message is empty (e.g., interrupted)
      const finalMessage: ChatMessage = {
        ...message,
        content: messageContent,
      };

      if (isCodexModel(streamModel)) {
        persistSupplementalMessage(sessionId, finalMessage);
      }

      addMessage(sessionId, finalMessage);

      // Clear stream content after adding to messages
      set((state) => ({
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
      }));

      // Desktop notification for non-active sessions when a turn completes
      if (finalMessage.role === 'assistant' && messageContent) {
        const activeId = get().activeSessionId;
        if (sessionId !== activeId) {
          const session = get().sessions.find(s => s.id === sessionId);
          const sessionName = session?.forkName || session?.name || 'Session';
          const preview = messageContent.replace(/\s+/g, ' ').trim().slice(0, 80);
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
      if (messageContent && finalMessage.role === 'assistant') {
        // Import audio store and trigger auto-play
        import('./audio.store').then(({ useAudioStore }) => {
          useAudioStore.getState().triggerAutoPlayTTS(sessionId, finalMessage.id, messageContent);
        });
      }

      // Process next queued message if any
      const queue = get().messageQueue[sessionId] || [];
      if (queue.length > 0) {
        console.log(`[SessionStore] Stream ended, processing next queued message (${queue.length} in queue)`);
        const nextMsg = queue[0];

        // Remove from queue
        set((state) => ({
          messageQueue: {
            ...state.messageQueue,
            [sessionId]: state.messageQueue[sessionId].slice(1),
          },
        }));

        // Send the next message. Pass the queued message's ID so sendMessage
        // knows the user bubble is already on screen (added when it was queued)
        // and skips re-adding it — otherwise each dequeued message duplicates
        // in the chat.
        setTimeout(() => {
          get().sendMessage(sessionId, nextMsg.message, nextMsg.attachments, { existingMessageId: nextMsg.id });
        }, 100);
      }
    });

    const unsubError = window.electronAPI.claude.onStreamError(({ sessionId, error }) => {
      const currentState = get();

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

      // Get any streamed content before the error
      const streamedContent = currentState.currentStreamContent[sessionId] || '';

      // If we have streamed content, save it as a partial message before showing error
      if (streamedContent.trim()) {
        const partialMessage: ChatMessage = {
          id: `partial-${Date.now()}`,
          role: 'assistant',
          content: streamedContent,
          timestamp: new Date(),
          interrupted: true,
        };
        if (isCodexModel(streamModel)) {
          persistSupplementalMessage(sessionId, partialMessage);
        }
        addMessage(sessionId, partialMessage);
      }

      // On error, clear streaming flag WITHOUT processing queue.
      // Errors mean the query is dead — don't send queued messages into a broken state.
      // Set streaming to false directly without triggering queue drain.
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        activeStreamModel: { ...state.activeStreamModel, [sessionId]: undefined },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
      }));

      const errorMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: new Date(),
      };
      if (isCodexModel(streamModel)) {
        persistSupplementalMessage(sessionId, errorMessage);
      }
      addMessage(sessionId, errorMessage);

      // Clear the queue — errored sessions shouldn't continue processing queued messages
      const queueLength = (currentState.messageQueue[sessionId] || []).length;
      if (queueLength > 0) {
        console.warn(`[SessionStore] Stream error — clearing ${queueLength} queued messages`);
        set((state) => ({
          messageQueue: { ...state.messageQueue, [sessionId]: [] },
        }));
      }
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
      set((state) => {
        const sessionModel = getSessionModel(state, data.sessionId);
        return {
          permissionMode: {
            ...state.permissionMode,
            [data.sessionId]: normalizePermissionModeForModel(sessionModel, data.mode as PermissionMode),
          },
        };
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

      if (wasStreaming) {
        console.warn(`[SessionStore] Preserving active SSH stream for ${sessionId} while transport reconnects`);
        set((state) => ({
          sessionActivity: { ...state.sessionActivity, [sessionId]: 'active' },
        }));
      }
      // For idle disconnects, stay silent — reconnection is automatic on next message.
    });

    return () => {
      unsubChunk();
      unsubThinking();
      unsubToolCall();
      unsubToolResult();
      unsubSystemInfo();
      unsubContextUsage();
      unsubEnd();
      unsubError();
      unsubPermission();
      unsubQuestion();
      unsubPlanContent();
      unsubPlanApproval();
      unsubPermissionModeChanged();
      unsubConnectionLost();
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
      console.warn('[Session Store] No pending permission to approve');
      return;
    }

    const response: PermissionResponse = {
      requestId: request.requestId,
      approved: true,
      modifiedInput,
      alwaysApprove,
    };

    console.log('[Session Store] Approving permission:', request.requestId, alwaysApprove ? '(always approve)' : '');
    await window.electronAPI.claude.respondToPermission(response);
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
    await window.electronAPI.claude.respondToPermission(response);
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

    // Cancel current streaming
    window.electronAPI.claude.cancel(sessionId);

    // Save partial content as an interrupted message before clearing
    const partialContent = state.currentStreamContent[sessionId] || '';
    const partialToolCalls = state.currentToolCalls[sessionId] || [];

    if (partialContent || partialToolCalls.length > 0) {
      // Create an interrupted message with whatever content we had
      const interruptedMessage: ChatMessage = {
        id: `interrupted-${Date.now()}`,
        role: 'assistant',
        content: partialContent || '(interrupted)',
        toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
        timestamp: new Date(),
        interrupted: true,
      };
      state.addMessage(sessionId, interruptedMessage);
      console.log(`[cancelStream] Saved interrupted message with ${partialContent.length} chars of content`);
    }

    // Clear current streaming state
    set((state) => ({
      isStreaming: { ...state.isStreaming, [sessionId]: false },
      streamEvents: { ...state.streamEvents, [sessionId]: [] },
      currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
      currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
      currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
    }));

    console.log(`Stream cancelled for session ${sessionId}`);
  },

  interruptAndSend: async (sessionId, message, attachments) => {
    const state = get();
    const isCurrentlyStreaming = state.isStreaming[sessionId] || false;

    // Only interrupt if actually streaming
    if (isCurrentlyStreaming) {
      console.log(`[interruptAndSend] Cancelling current stream for session ${sessionId}`);

      // Cancel current streaming and wait for confirmation
      await window.electronAPI.claude.cancel(sessionId);
      console.log(`[interruptAndSend] Cancel confirmed by backend`);

      // Save partial content as an interrupted message before clearing
      const partialContent = state.currentStreamContent[sessionId] || '';
      const partialToolCalls = state.currentToolCalls[sessionId] || [];

      if (partialContent || partialToolCalls.length > 0) {
        // Create an interrupted message with whatever content we had
        const interruptedMessage: ChatMessage = {
          id: `interrupted-${Date.now()}`,
          role: 'assistant',
          content: partialContent || '(interrupted)',
          toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
          timestamp: new Date(),
          interrupted: true,
        };
        state.addMessage(sessionId, interruptedMessage);
        console.log(`[interruptAndSend] Saved interrupted message with ${partialContent.length} chars of content`);
      }

      // Clear current streaming state
      set((state) => ({
        isStreaming: { ...state.isStreaming, [sessionId]: false },
        streamEvents: { ...state.streamEvents, [sessionId]: [] },
        currentStreamContent: { ...state.currentStreamContent, [sessionId]: '' },
        currentThinkingContent: { ...state.currentThinkingContent, [sessionId]: '' },
        currentToolCalls: { ...state.currentToolCalls, [sessionId]: [] },
      }));

      // CRITICAL: Wait for the stale STREAM_END/STREAM_ERROR from the cancelled
      // stream to arrive via IPC and be discarded by the isStreaming guards in
      // onStreamEnd / onStreamError. Without this drain window, sendMessage()
      // sets isStreaming=true immediately and the stale event arrives to find
      // isStreaming=true (from the NEW stream), bypassing the guard and killing
      // the new stream with "Claude Code process aborted by user".
      //
      // This was the v0.2.2 fix (commit c5601ec) that got lost in v0.3.x.
      // 300ms is enough for the backend generator to unwind and the IPC to deliver.
      console.log(`[interruptAndSend] Streaming state cleared, draining stale events for 300ms`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      console.log(`[interruptAndSend] Drain complete, sending new message`);
    }

    // Send new message (use fresh state, not the stale closure from before cancel)
    get().sendMessage(sessionId, message, attachments);
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
    if (!hasElectronAPI) return () => {};

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
    if (!hasElectronAPI) return () => {};

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
      if (data.taskId) {
        set((state) => {
          const existing = state.monitorInstances[data.sessionId] || [];
          const idx = existing.findIndex((m) => m.id === data.taskId);
          if (idx < 0) return state;
          const updated = [...existing];
          updated[idx] = {
            ...updated[idx],
            active: false,
            events: data.summary
              ? [...updated[idx].events, { id: `${data.taskId}-done`, text: `[${data.status}] ${data.summary}`, timestamp: Date.now() }]
              : updated[idx].events,
          };
          return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: updated } };
        });

        // Auto-remove completed monitor after 10s
        setTimeout(() => {
          set((state) => {
            const existing = state.monitorInstances[data.sessionId] || [];
            const filtered = existing.filter((m) => m.id !== data.taskId);
            return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: filtered } };
          });
        }, 10000);
      }

      // Desktop notification when a background task finishes
      const activeId = get().activeSessionId;
      const session = get().sessions.find((s) => s.id === data.sessionId);
      const sessionName = session?.forkName || session?.name || 'Session';
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
      const monitorId = data.taskId || data.toolUseId!;
      const text = data.description || data.summary || (data.toolName ? `${data.toolName}...` : 'working...');
      set((state) => {
        const existing = state.monitorInstances[data.sessionId] || [];
        let idx = existing.findIndex((m) => m.id === monitorId);

        // Auto-create a monitor entry if one doesn't exist yet.
        // Monitor tool events arrive as SDK notifications with a key but
        // no prior onToolCall, so the entry wouldn't have been pre-created.
        if (idx < 0) {
          const newEntry = {
            id: monitorId,
            description: data.description || monitorId,
            events: [],
            active: true,
            startedAt: Date.now(),
          };
          const withNew = [...existing, newEntry];
          idx = withNew.length - 1;
          // Dedupe check
          const newEvent = { id: `prog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, timestamp: Date.now() };
          withNew[idx] = { ...withNew[idx], events: [newEvent] };
          return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: withNew } };
        }

        const updated = [...existing];
        // Dedupe consecutive identical progress messages
        const lastEvent = updated[idx].events[updated[idx].events.length - 1];
        if (lastEvent?.text === text) return state;
        updated[idx] = {
          ...updated[idx],
          events: [...updated[idx].events, { id: `prog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, timestamp: Date.now() }],
        };
        return { monitorInstances: { ...state.monitorInstances, [data.sessionId]: updated } };
      });
    });

    return () => {
      unsubscribeOutput?.();
      unsubTaskNotif?.();
      unsubTaskProg?.();
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

  restoreCompactionModel: (sessionId) => {
    const currentState = get();
    const currentNotice = currentState.compactionSwitch[sessionId];
    if (!currentNotice?.autoSwitched) {
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
    if (!hasElectronAPI) return () => {};

    const { setCompactionStatus } = get();

    // Subscribe to compaction status changes
    const unsubscribeStatus = window.electronAPI.claude.onCompactionStatus((status) => {
      console.log('[SessionStore] Compaction status received:', status);

      if (status.isCompacting) {
        const currentState = get();
        const sourceModel = currentState.activeStreamModel[status.sessionId]
          || getSessionModel(currentState, status.sessionId)
          || 'claude-opus-4-6';
        // Disabled: auto-switching to Codex during compaction broke SSH sessions
        // and confused users when model changed unexpectedly
        const fallbackModel = undefined;
        const normalizedPermissionMode = currentState.permissionMode[status.sessionId];
        const shouldAutoSwitch = false;

        set((state) => {
          const existingNotice = state.compactionSwitch[status.sessionId];

          return {
            selectedModel: shouldAutoSwitch && fallbackModel
              ? { ...state.selectedModel, [status.sessionId]: fallbackModel }
              : state.selectedModel,
            permissionMode: shouldAutoSwitch
              ? { ...state.permissionMode, [status.sessionId]: normalizedPermissionMode }
              : state.permissionMode,
            compactionSwitch: {
              ...state.compactionSwitch,
              [status.sessionId]: {
                status: 'compacting',
                originalModel: existingNotice?.originalModel || sourceModel,
                fallbackModel: fallbackModel || existingNotice?.fallbackModel,
                autoSwitched: existingNotice?.autoSwitched || shouldAutoSwitch,
                startedAt: existingNotice?.status === 'compacting' ? existingNotice.startedAt : Date.now(),
                preTokens: status.preTokens ?? existingNotice?.preTokens,
                postTokens: existingNotice?.postTokens,
              },
            },
          };
        });

        if (shouldAutoSwitch && fallbackModel) {
          persistModelSelection(status.sessionId, fallbackModel, normalizedPermissionMode);
        }
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

    const state = get();
    const isStreaming = state.isStreaming[sessionId];
    const permissionMode = state.permissionMode[sessionId] || 'default';

    // Only save state if we're in Build It mode (bypassPermissions) and streaming
    if (permissionMode !== 'bypassPermissions' || !isStreaming) {
      return;
    }

    console.log('[SessionStore] Saving auto-resume state for Build It session:', sessionId);
    await window.electronAPI.claude.saveAutoResumeState({
      sessionId,
      wasStreaming: true,
      permissionMode,
    });
  },

  clearAutoResumeState: async () => {
    if (!hasElectronAPI) return;
    await window.electronAPI.claude.clearAutoResumeState();
  },

  checkAndAutoResume: async () => {
    if (!hasElectronAPI) return;

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

      // Skip auto-resume for SSH sessions - no local process to resume
      if (session.sshConfig) {
        console.log('[SessionStore] Skipping auto-resume for SSH session:', sessionId);
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
    if (!hasElectronAPI || typeof window === 'undefined') return () => {};

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

      // Add to session list (guard against duplicate from sessionsUpdated event race)
      set(state => {
        if (state.sessions.some(s => s.id === forkedSession.id)) return state;
        return { sessions: [...state.sessions, forkedSession] };
      });

      // Update fork group tracking
      // Find root session (walk up parentSessionId chain)
      const currentSession = sessions.find(s => s.id === activeSessionId);
      let rootId = activeSessionId;
      let session = currentSession;
      while (session?.parentSessionId) {
        rootId = session.parentSessionId;
        session = sessions.find(s => s.id === rootId);
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

    // Find root (walk up parentSessionId chain)
    let rootId = sessionId;
    let session: Session | undefined = currentSession;
    while (session?.parentSessionId) {
      rootId = session.parentSessionId;
      session = sessions.find(s => s.id === rootId);
      if (!session) break; // Guard against missing parent
    }

    // Collect root + all descendants
    const root = sessions.find(s => s.id === rootId);
    if (!root) return [];

    const forkGroup = [root, ...sessions.filter(s => s.parentSessionId === rootId)];

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
    if (!hasElectronAPI) return () => {};

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
      set((state) => {
        const existing = state.codexToolCalls[sessionId] || [];
        // Update existing tool call or add new one
        const idx = existing.findIndex(tc => tc.id === toolCall.id);
        const updated = idx >= 0
          ? existing.map((tc, i) => i === idx ? toolCall : tc)
          : [...existing, toolCall];
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
    if (!hasElectronAPI) return () => {};
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
    if (!hasElectronAPI) return () => {};
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
