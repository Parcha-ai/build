import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage, Query, SpawnedProcess, TerminalReason } from '@anthropic-ai/claude-agent-sdk';
import type { ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { z } from 'zod';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type {
  ChatMessage,
  ToolCall,
  Session,
  QuestionRequest,
  QuestionResponse,
  Attachment,
  ContentBlock,
  CompactionStatus,
  CompactionComplete,
  PlanApprovalRequest,
  PlanApprovalResponse,
  OrchestrationPlan,
  OrchestrationStage,
  Harness,
  TaskTier,
  TaskDomain,
  RoutingDecision,
  MetaHarnessPolicy,
  AutoPlanningState,
  PlanningGateDecision,
} from '../../shared/types';
import { powerService } from './power.service';
import { BrowserWindow, nativeImage, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { browserService } from './browser.service';
import { cdpProxyService } from './cdp-proxy.service';
import { stagehandService } from './stagehand.service';
import { computerUseService } from './computer-use.service';
import { documentService } from './document.service';
import { sshService } from './ssh.service';
import type { RemoteCliCapabilities } from './ssh.service';
import { memoryService, MemoryCategory } from './memory.service';
import { qmdService } from './qmd.service';
import { mcpService } from './mcp.service';
import { codexService } from './codex.service';
import { designService } from './design.service';
import { openclawService } from './openclaw.service';
import { getCursorCliService } from './cursor-cli.service';
import { getCursorService } from './cursor.service';
import { getGeminiService } from './gemini.service';
import { getOpenCodeService } from './opencode.service';
import { autoRouterService } from './auto-router.service';
import { parableService, type PreparedParableRuntime } from './parable.service';
import { cascadeService, type PreparedCascadeRuntime } from './cascade.service';
import { eightyTwentyService } from './eighty-twenty.service';
import { adhdOutputService } from './adhd-output.service';
import { formatConversationContext, mergeConversationMessages, buildCrossHarnessContext, buildUnifiedHarnessContext, formatProjectInstructionContextFiles } from './codex-context';
import { secureKeysService } from './secure-keys.service';
import { analyticsService, estimateBaselineCost, estimateCost } from './analytics.service';
import { truncateMiddlePreservingTail } from '../../shared/utils/prompt-truncation';
import { findUsableLocalExecutable } from '../utils/local-executable';
import { transcriptEntriesToChatMessages, transcriptService, type TranscriptEntry } from './transcript.service';
import { filterInternalPromptEchoes, hasRecoverableOutput, mergeRecoveredStreamMessages } from '../../shared/utils/message-recovery';
import { translateHarnessPolicy } from './harness-policy.service';
import {
  ZAI_ANTHROPIC_BASE_URL,
  ZAI_GLM_CLAUDE_MODEL_ID,
  ZAI_GLM_CLAUDE_MODEL_PICKER_ID,
  ZAI_GLM_CODEX_MODEL_PICKER_ID,
  ZAI_GLM_CONTEXT_WINDOW,
  ZAI_GLM_FAST_MODEL_ID,
  isZaiGlmClaudePickerModel,
} from '../../shared/config/zai-glm';
import { hasExistingSessionTitle, rememberAutoSessionTitle, sanitizeSessionTitle } from './session-title.service';
import { hasFileAttachments, prepareFileAttachmentsForHarness } from './attachment-file-assets';
import { PARABLE_MODE_ID } from '../../shared/config/parable';
import { shouldResetNativeHarnessThread } from '../../shared/utils/harness-switch';
import { normalizeClaudeSdkSessionId } from '../../shared/utils/claude-session-id';

const STREAM_DEBUG = process.env.GREP_DEBUG_STREAMING === '1';
const ATTACHMENT_ONLY_PROMPT = 'Use the attached file(s) as input for the current task. Continue from the existing session context and the latest user request instead of asking me to restate the task.';
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_COLOR_CODE_RE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');
const ANSI_M_CODE_RE = new RegExp(`${ANSI_ESCAPE}\\[[^m]*m`, 'g');
const OSC8_LINK_RE = new RegExp(`${ANSI_ESCAPE}\\]8;;[^${ANSI_BELL}${ANSI_ESCAPE}]*(${ANSI_BELL}|${ANSI_ESCAPE}\\\\)`, 'g');
const NOISY_SDK_SYSTEM_SUBTYPES = new Set(['thinking_tokens', 'status']);
const QUIET_IGNORED_SDK_SESSION_ID_SUBTYPES = new Set([
  ...NOISY_SDK_SYSTEM_SUBTYPES,
  'commands_changed',
  'hook_started',
  'hook_response',
  'task_notification',
  'task_progress',
  'task_started',
  'task_updated',
]);
const SDK_STATUS_NOTICE_INTERVAL_MS = 15_000;
const TASK_PROGRESS_EMIT_INTERVAL_MS = 2_000;
const TASK_PROGRESS_TEXT_CHANGE_INTERVAL_MS = 5_000;
const AUTO_PLANNING_MIN_DISCOVERY_TURNS = 1;
const AUTO_PLANNING_MAX_PLAN_WORDS = 500;

interface HarnessContextLimits {
  maxConversationChars?: number;
  maxProjectContextChars?: number;
  maxProjectContextFiles?: number;
  maxFinalChars?: number;
}

/** Recent transcript slice used for Auto Build routing and harness context (not full history). */
const ROUTING_TRANSCRIPT_LIMIT = 40;
const SUPPLEMENTAL_CONTEXT_MAX_MESSAGES = 80;
const SUPPLEMENTAL_CONTEXT_MAX_BYTES = 160 * 1024;
const ASSUMED_REMOTE_CLI_CAPABILITIES: RemoteCliCapabilities = {
  claude: true,
  codex: true,
  cursor: true,
  gemini: true,
  opencode: true,
};

const CLI_HARNESS_CONTEXT_LIMITS: Partial<Record<Harness, HarnessContextLimits>> = {
  // Keep the assembled handoff below Codex's 240K initial-prompt safety budget
  // while preserving materially more recent history than the old 50K guard.
  // The remaining headroom covers the current user turn, local/remote project
  // instructions, execution policy, and Codex's own runtime context.
  codex: {
    maxConversationChars: 120000,
    maxProjectContextChars: 50000,
    maxProjectContextFiles: 24,
    maxFinalChars: 180000,
  },
  cursor: {
    maxConversationChars: 60000,
    maxProjectContextChars: 30000,
    maxProjectContextFiles: 16,
    maxFinalChars: 90000,
  },
  gemini: {
    maxConversationChars: 80000,
    maxProjectContextChars: 40000,
    maxProjectContextFiles: 18,
    maxFinalChars: 120000,
  },
  opencode: {
    maxConversationChars: 80000,
    maxProjectContextChars: 40000,
    maxProjectContextFiles: 18,
    maxFinalChars: 120000,
  },
};

interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'message_complete' | 'error' | 'system' | 'permission_request' | 'compaction_status' | 'compaction_complete' | 'plan_content' | 'context_usage';
  content?: string;
  toolCall?: ToolCall;
  result?: unknown;
  message?: ChatMessage;
  error?: string;
  terminalFailure?: boolean;
  systemInfo?: {
    tools: string[];
    model: string;
  };
  // Permission request fields
  sessionId?: string;
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  approvalMessage?: string; // Message about why approval is needed
  // Compaction fields
  compactionStatus?: CompactionStatus;
  compactionComplete?: CompactionComplete;
  // Plan content fields
  planContent?: string;
  planFilePath?: string;
  // Agent teams fields
  agentId?: string; // parent_tool_use_id from SDK (null = lead agent)
  agentName?: string; // Descriptive name for the agent/teammate
  // Terminal reason from SDK result message (v0.2.91+)
  terminalReason?: string;
  // Rich context usage breakdown from SDK getContextUsage() (v0.2.86+)
  contextUsageBreakdown?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
    costUsd?: number;
  };
  resolvedModel?: string;
}

const CLAUDE_SDK_RESUME_CONTEXT_LIMIT_PERCENT = 95;

interface PendingQuestion {
  sessionId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
}

type ClaudeToolPermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface PendingPermission {
  resolve: (response: { approved: boolean; modifiedInput?: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface PendingPlanApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  sessionId: string;
}

interface PlanApprovalRecord {
  sessionId: string;
  planContent: string;
  planFilePath?: string;
}

interface ApprovedPlanArtifact {
  content: string;
  filePath: string;
  pendingExecution?: boolean;
  updatedAt?: string;
}

interface PendingAutoPlanExecutionHandoff {
  approvedAt: number;
  retirePlanningSession?: boolean;
}

interface PendingHarnessSwitch {
  fromModel: string;
  toModel: string;
  fromHarness: Harness;
  toHarness: Harness;
  timestamp: number;
}

export class ClaudeService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private messageCacheStore: any;
  private activeQueries: Map<string, AbortController> = new Map();
  private sessionTurnLocks: Map<string, { promise: Promise<void>; release: () => void; holder: string }> = new Map();
  private activeQueryStartedAt: Map<string, number> = new Map();
  private activeQueryLastEventAt: Map<string, number> = new Map();
  private activeQueryObjects: Map<string, Query> = new Map(); // Store Query objects for streamInput
  // A recovered detached Claude process has no SDK Query object, but it still
  // owns a live stream-json stdin socket. Keep that writable here so queued
  // steering and control responses work after app restart / SSH reconnect.
  private recoveredQueryInputs: Map<string, SpawnedProcess['stdin']> = new Map();
  // Explicit cancellation must finish killing the prior remote bridge before
  // a replacement turn can spawn, otherwise delayed cleanup can reap the new
  // process (the Fast Stack race seen in production).
  private remoteCancellationCleanup: Map<string, Promise<void>> = new Map();
  private sessionPermissionModes: Map<string, string> = new Map(); // Track current permission mode per session
  private prePlanPermissionModes: Map<string, string> = new Map(); // Track pre-plan mode for restoration after plan approval
  private autoBuildForcedPlanSessions: Set<string> = new Set(); // Track Auto Build's temporary plan-mode handoffs
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private pendingPlanApprovals: Map<string, PendingPlanApproval> = new Map();
  private planApprovalRecords: Map<string, PlanApprovalRecord> = new Map();
  private sessionPlanFiles: Map<string, { content: string; filePath: string }> = new Map(); // Cache plan content per session
  private sessionApprovedPlanFiles: Map<string, ApprovedPlanArtifact> = new Map(); // Last approved plan artifact per session
  private pendingAutoPlanExecutionHandoffs: Map<string, PendingAutoPlanExecutionHandoff> = new Map();
  private lastPlanFeedback: Map<string, string> = new Map(); // Stores feedback from last plan rejection per session
  private mainWindow: BrowserWindow | null = null;
  private sessionRenderers: Map<string, WebContents> = new Map();
  private onSessionNameChanged: (() => void) | null = null;
  private browserMcpServers: Map<string, any> = new Map();

  // Track Claude SDK context usage so over-full native transcripts are not resumed.
  private sessionContextPercentage: Map<string, number> = new Map();
  private sshSdkResumeRepairChecks: Map<string, { sdkSessionId?: string; checkedAt: number }> = new Map();
  private ignoredSdkSessionIdLogState: Map<string, { count: number; lastLoggedAt: number }> = new Map();
  private sdkStatusNoticeAt: Map<string, number> = new Map();
  // Tracks the last time an empty zero-token resume result triggered a
  // resume-intact retry, so a second strike within the window escalates to a
  // fresh restart instead of retrying forever.
  private resumeEmptyRetryAt: Map<string, number> = new Map();
  private taskProgressEmitState: Map<string, { lastText: string; lastEmittedAt: number; suppressed: number }> = new Map();
  private readonly SSH_SDK_RESUME_REPAIR_TTL_MS = 30 * 60 * 1000;

  // Performance optimization: Cache parsed messages and transcript paths
  private messageCache = new Map<string, {
    messages: ChatMessage[];
    loadedAt: number;
    fileHash: string;
    transcriptPath: string;
  }>();
  private transcriptPathCache = new Map<string, { sdkSessionId: string; transcriptPath: string }>();
  private remoteProjectContextCache = new Map<string, {
    context: string;
    loadedAt: number;
  }>();
  private readonly REMOTE_PROJECT_CONTEXT_TTL = 3 * 60 * 1000;

  constructor() {
    this.store = new Store({ name: 'claudette-settings' });
    this.sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;
    this.messageCacheStore = new CachedStore({ name: 'claudette-message-cache' }) as any;
  }

  private formatRemoteClaudeProcessExitError(
    errorMessage: string,
    session: Session | undefined,
    canReattach: boolean,
  ): string {
    if (canReattach) {
      return `Connection to the remote Claude turn was interrupted (${errorMessage}). If the turn is still running on the remote, Build will reattach automatically and continue streaming.`;
    }

    if (/process exited with code\s+66\b/i.test(errorMessage)) {
      const remoteWorkdir = session?.sshConfig?.remoteWorkdir;
      const workdirDetail = remoteWorkdir ? ` Configured remote workdir: ${remoteWorkdir}.` : '';
      return `Remote Claude failed to start because the SSH remote workdir was not found or is not accessible.${workdirDetail} Update the session's remote directory or recreate the worktree, then retry. (${errorMessage})`;
    }

    return `Remote Claude exited before completing (${errorMessage}). It is not running anymore, so there is nothing to reattach to.`;
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  setSessionRenderer(sessionId: string, renderer: WebContents): void {
    if (renderer.isDestroyed()) return;
    this.sessionRenderers.set(sessionId, renderer);
  }

  clearSessionRenderer(sessionId: string, renderer?: WebContents): void {
    const current = this.sessionRenderers.get(sessionId);
    if (!current || (renderer && current.id !== renderer.id)) return;
    this.sessionRenderers.delete(sessionId);
  }

  private sendInteractiveRendererEvent(sessionId: string, channel: string, payload: unknown): boolean {
    const sessionRenderer = this.sessionRenderers.get(sessionId);
    if (sessionRenderer && !sessionRenderer.isDestroyed()) {
      sessionRenderer.send(channel, payload);
      return true;
    }
    if (sessionRenderer?.isDestroyed()) {
      this.sessionRenderers.delete(sessionId);
    }

    const liveWindows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    for (const window of liveWindows) {
      window.webContents.send(channel, payload);
    }
    return liveWindows.length > 0;
  }

  private updateStoredSession(sessionId: string, updater: (session: Session) => Session): boolean {
    for (const prefix of ['sessions', 'discoveredSessions'] as const) {
      const key = `${prefix}.${sessionId}`;
      const session = this.sessionStore.get(key) as Session | undefined;
      if (!session) continue;
      this.sessionStore.set(key, updater(session));
      return true;
    }
    return false;
  }

  private getPersistedAutoBuildPrePlanMode(sessionId: string): string | undefined {
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);
    if (!session?.autoBuildForcedPlanMode) return undefined;
    return session.autoBuildPrePlanPermissionMode || 'acceptEdits';
  }

  private persistAutoBuildForcedPlanMode(sessionId: string, prePlanMode: string): void {
    const updated = this.updateStoredSession(sessionId, (session) => ({
      ...session,
      autoBuildForcedPlanMode: true,
      autoBuildPrePlanPermissionMode: prePlanMode,
    }));
    if (updated) {
      console.log(`[Claude Service] Persisted Auto Build forced plan restore mode for ${sessionId}: ${prePlanMode}`);
    }
  }

  private clearPersistedAutoBuildForcedPlanMode(sessionId: string): void {
    this.updateStoredSession(sessionId, (session) => {
      const {
        autoBuildForcedPlanMode: _autoBuildForcedPlanMode,
        autoBuildPrePlanPermissionMode: _autoBuildPrePlanPermissionMode,
        ...cleanSession
      } = session;
      return cleanSession as Session;
    });
  }

  private persistSessionPermissionMode(sessionId: string, mode: string): void {
    const updated = this.updateStoredSession(sessionId, (session) => {
      const {
        autoBuildForcedPlanMode: _autoBuildForcedPlanMode,
        autoBuildPrePlanPermissionMode: _autoBuildPrePlanPermissionMode,
        ...cleanSession
      } = session;
      return { ...cleanSession, permissionMode: mode } as Session;
    });
    if (updated) {
      console.log(`[Claude Service] Persisted restored permission mode for ${sessionId}: ${mode}`);
    }
  }

  setOnSessionNameChanged(callback: () => void): void {
    this.onSessionNameChanged = callback;
  }

  /**
   * Get Foundry environment variables from settings (when Foundry is enabled)
   */
  /**
   * When a custom:* model is selected, override ANTHROPIC_BASE_URL and
   * ANTHROPIC_API_KEY to route through the custom model's API proxy.
   * The model name is resolved separately in streamMessage.
   */
  private getCustomModelEnvVars(selectedModel?: string): Record<string, string> {
    if (!selectedModel?.startsWith('custom:')) return {};
    if (isZaiGlmClaudePickerModel(selectedModel)) {
      return this.getZaiGlmClaudeEnvVars();
    }
    const customId = selectedModel.replace('custom:', '');
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const customModels = (settings.customModels || []) as Array<{ id: string; modelId: string; baseUrl: string; apiKey: string }>;
    const config = customModels.find(m => m.id === customId);
    if (!config) return {};

    const vars: Record<string, string> = {};
    if (config.baseUrl) vars.ANTHROPIC_BASE_URL = config.baseUrl.trim();
    if (config.apiKey) {
      // Set BOTH auth env vars — ANTHROPIC_AUTH_TOKEN is used by third-party
      // providers (Fireworks, etc) as a passthrough token, while ANTHROPIC_API_KEY
      // is the standard Anthropic auth. The SDK/CLI picks the right one.
      vars.ANTHROPIC_API_KEY = config.apiKey.trim();
      vars.ANTHROPIC_AUTH_TOKEN = config.apiKey.trim();
    }
    if (config.modelId) {
      const modelId = config.modelId.trim();
      vars.ANTHROPIC_MODEL = modelId;
      vars.ANTHROPIC_SMALL_FAST_MODEL = modelId;
      // Replace Sonnet tier — custom models typically match Sonnet's
      // context/capability level. Leave Opus and Haiku as Claude defaults
      // so sub-agents and compaction use the right models.
      vars.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    }
    return vars;
  }

  private getZaiApiKey(): string | undefined {
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const storedKey = typeof settings.zaiApiKey === 'string' ? settings.zaiApiKey.trim() : '';
    const topLevelKey = this.store.get('zaiApiKey') as string | undefined;
    return storedKey || topLevelKey?.trim() || process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || undefined;
  }

  private getZaiGlmClaudeEnvVars(): Record<string, string> {
    const apiKey = this.getZaiApiKey();
    const vars: Record<string, string> = {
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: ZAI_GLM_CLAUDE_MODEL_ID,
      ANTHROPIC_SMALL_FAST_MODEL: ZAI_GLM_FAST_MODEL_ID,
      ANTHROPIC_DEFAULT_SONNET_MODEL: ZAI_GLM_CLAUDE_MODEL_ID,
      ANTHROPIC_DEFAULT_OPUS_MODEL: ZAI_GLM_CLAUDE_MODEL_ID,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ZAI_GLM_FAST_MODEL_ID,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(ZAI_GLM_CONTEXT_WINDOW),
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    };

    if (apiKey) {
      vars.ANTHROPIC_API_KEY = apiKey;
      vars.ANTHROPIC_AUTH_TOKEN = apiKey;
    }

    return vars;
  }

  /**
   * Resolve a custom:* model ID to the actual model name to send to the API.
   */
  private resolveCustomModelId(selectedModel: string): string {
    if (isZaiGlmClaudePickerModel(selectedModel)) return ZAI_GLM_CLAUDE_MODEL_ID;
    if (!selectedModel.startsWith('custom:')) return selectedModel;
    const customId = selectedModel.replace('custom:', '');
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const customModels = (settings.customModels || []) as Array<{ id: string; modelId: string }>;
    const config = customModels.find(m => m.id === customId);
    return config?.modelId || selectedModel;
  }

  private getFoundryEnvVars(): Record<string, string> {
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    if (!settings.foundryEnabled) return {};

    const vars: Record<string, string> = {
      CLAUDE_CODE_USE_FOUNDRY: '1',
    };
    if (settings.foundryBaseUrl) {
      vars.ANTHROPIC_FOUNDRY_BASE_URL = (settings.foundryBaseUrl as string).trim();
    }
    if (settings.foundryApiKey) {
      vars.ANTHROPIC_FOUNDRY_API_KEY = (settings.foundryApiKey as string).trim();
    }
    if (settings.foundryDefaultSonnetModel) {
      vars.ANTHROPIC_DEFAULT_SONNET_MODEL = (settings.foundryDefaultSonnetModel as string).trim();
    }
    if (settings.foundryDefaultHaikuModel) {
      vars.ANTHROPIC_DEFAULT_HAIKU_MODEL = (settings.foundryDefaultHaikuModel as string).trim();
    }
    if (settings.foundryDefaultOpusModel) {
      vars.ANTHROPIC_DEFAULT_OPUS_MODEL = (settings.foundryDefaultOpusModel as string).trim();
    }
    return vars;
  }

  /**
   * Update the permission mode for an active session
   * This allows changing from 'default' to 'bypassPermissions' mid-stream
   */
  setSessionPermissionMode(sessionId: string, mode: string): void {
    console.log(`[Claude Service] Setting permission mode for ${sessionId}: ${mode}`);
    this.autoBuildForcedPlanSessions.delete(sessionId);
    this.clearPersistedAutoBuildForcedPlanMode(sessionId);
    // When entering plan mode, store the previous mode for restoration after plan approval
    if (mode === 'plan') {
      const currentMode = this.sessionPermissionModes.get(sessionId) || 'acceptEdits';
      if (currentMode !== 'plan') {
        this.prePlanPermissionModes.set(sessionId, currentMode);
        console.log(`[Claude Service] Stored pre-plan mode for ${sessionId}: ${currentMode}`);
      }
    }
    this.sessionPermissionModes.set(sessionId, mode);
  }

  /**
   * Get the current permission mode for a session
   */
  getSessionPermissionMode(sessionId: string): string | undefined {
    return this.sessionPermissionModes.get(sessionId);
  }

  /**
   * Get the active Query object for a session (used by rewind/history features)
   */
  getActiveQuery(sessionId: string): any | undefined {
    return this.activeQueryObjects.get(sessionId);
  }

  private setActiveQuery(sessionId: string, abortController: AbortController): void {
    const now = Date.now();
    this.activeQueries.set(sessionId, abortController);
    this.activeQueryStartedAt.set(sessionId, now);
    this.activeQueryLastEventAt.set(sessionId, now);
  }

  private clearActiveQuery(sessionId: string, abortController?: AbortController): boolean {
    if (abortController && this.activeQueries.get(sessionId) !== abortController) {
      return false;
    }
    const hadActiveQuery = this.activeQueries.delete(sessionId);
    this.activeQueryStartedAt.delete(sessionId);
    this.activeQueryLastEventAt.delete(sessionId);
    this.activeQueryObjects.delete(sessionId);
    this.recoveredQueryInputs.delete(sessionId);
    return hadActiveQuery;
  }

  async acquireSessionTurnLock(sessionId: string, holder: string): Promise<() => void> {
    const existing = this.sessionTurnLocks.get(sessionId);
    if (existing) {
      if (existing.holder === holder) {
        // Reentrant: recursive retry (e.g. streamMessage → yield* this.streamMessage)
        // inherits the outer caller's lock — return a no-op release.
        return () => undefined;
      }
      console.log(`[Claude Service] Turn lock for ${sessionId.substring(0, 8)} held by "${existing.holder}"; "${holder}" waiting`);
      await existing.promise;
    }
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.sessionTurnLocks.set(sessionId, { promise, release, holder });
    console.log(`[Claude Service] Turn lock acquired for ${sessionId.substring(0, 8)} by "${holder}"`);
    return () => {
      if (this.sessionTurnLocks.get(sessionId)?.release === release) {
        this.sessionTurnLocks.delete(sessionId);
        console.log(`[Claude Service] Turn lock released for ${sessionId.substring(0, 8)} by "${holder}"`);
      }
      release();
    };
  }

  noteActiveQueryEvent(sessionId: string): void {
    if (this.activeQueries.has(sessionId)) {
      this.activeQueryLastEventAt.set(sessionId, Date.now());
    }
  }

  getActiveQueryState(sessionId: string): {
    active: boolean;
    aborted: boolean;
    injectable: boolean;
    ageMs: number;
    idleMs: number;
  } {
    const controller = this.activeQueries.get(sessionId);
    if (!controller) {
      return { active: false, aborted: false, injectable: false, ageMs: 0, idleMs: 0 };
    }

    const now = Date.now();
    const startedAt = this.activeQueryStartedAt.get(sessionId) || now;
    const lastEventAt = this.activeQueryLastEventAt.get(sessionId) || startedAt;
    if (controller.signal.aborted) {
      this.clearActiveQuery(sessionId, controller);
      return {
        active: false,
        aborted: true,
        injectable: false,
        ageMs: now - startedAt,
        idleMs: now - lastEventAt,
      };
    }

    return {
      active: true,
      aborted: false,
      injectable: this.activeQueryObjects.has(sessionId)
        || this.recoveredQueryInputs.has(sessionId)
        || codexService.canSteer(sessionId),
      ageMs: now - startedAt,
      idleMs: now - lastEventAt,
    };
  }

  /**
   * Trigger manual compaction for a session by sending /compact command
   * This proactively compacts the conversation history before it gets too large
   */
  async triggerManualCompaction(sessionId: string): Promise<boolean> {
    const queryObj = this.activeQueryObjects.get(sessionId);
    if (!queryObj) {
      console.log('[Claude Service] Cannot compact - no active query for session:', sessionId);
      return false;
    }

    try {
      console.log('[Claude Service] Triggering manual compaction for session:', sessionId);

      // Send /compact command via streamInput
      const compactCommand: AsyncIterable<any> = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: '/compact',
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      };

      await queryObj.streamInput(compactCommand);
      console.log('[Claude Service] Manual compaction triggered successfully');
      return true;
    } catch (error) {
      console.error('[Claude Service] Failed to trigger compaction:', error);
      return false;
    }
  }

  /**
   * Emit browser update event to renderer for UI synchronization
   * Sends screenshot and URL to update the browser preview panel
   */
  private emitBrowserUpdate(sessionId: string, screenshot: string, url?: string): void {
    console.log('[Claude Service] emitBrowserUpdate called, mainWindow:', !!this.mainWindow, 'sessionId:', sessionId, 'url:', url);
    if (this.mainWindow) {
      console.log('[Claude Service] Sending BROWSER_UPDATE to renderer');
      this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_UPDATE, {
        sessionId,
        screenshot,
        url,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log('[Claude Service] WARNING: mainWindow is null, cannot emit browser update');
    }
  }

  /**
   * Ensure browser panel is open and webview is registered before Stagehand operations
   * This solves the chicken-and-egg problem where Stagehand needs a webview to connect to
   */
  private async ensureBrowserPanelOpen(sessionId: string): Promise<boolean> {
    // Check if webview is already registered
    if (browserService.getRegisteredSessions().length > 0) {
      console.log('[Claude Service] Webview already registered');
      return true;
    }

    // Request renderer to open browser panel
    if (this.mainWindow) {
      console.log('[Claude Service] Requesting browser panel to open for session:', sessionId);
      this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_OPEN_PANEL, { sessionId });

      // Wait for webview to register (poll with timeout)
      const maxWait = 5000; // 5 seconds
      const pollInterval = 200; // 200ms
      let waited = 0;

      while (waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;

        if (browserService.getRegisteredSessions().length > 0) {
          console.log('[Claude Service] Webview registered after', waited, 'ms');
          return true;
        }
      }

      console.log('[Claude Service] Timeout waiting for webview registration');
    }

    return false;
  }

  getApiKey(): string | undefined {
    const key = this.store.get('anthropicApiKey') as string | undefined;
    return key?.trim() || undefined; // Treat empty string as no key
  }

  // Get available Claude models - use Foundry models if configured
  async getAvailableModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    // Check if Anthropic Foundry (Azure) is configured
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const foundryEnabled = settings.foundryEnabled as boolean | undefined;

    if (foundryEnabled) {
      const sonnetModel = settings.foundryDefaultSonnetModel as string | undefined;
      const haikuModel = settings.foundryDefaultHaikuModel as string | undefined;
      const opusModel = settings.foundryDefaultOpusModel as string | undefined;

      const foundryModels = [];

      // Add configured Foundry models
      if (opusModel) {
        foundryModels.push({
          id: opusModel,
          name: 'Opus (Foundry)',
          description: 'Most capable model'
        });
      }
      if (sonnetModel) {
        foundryModels.push({
          id: sonnetModel,
          name: 'Sonnet (Foundry)',
          description: 'Balanced performance'
        });
      }
      if (haikuModel) {
        foundryModels.push({
          id: haikuModel,
          name: 'Haiku (Foundry)',
          description: 'Fastest model'
        });
      }

      if (foundryModels.length > 0) {
        console.log('[Claude Service] Using Foundry models:', foundryModels.map(m => m.id).join(', '));
        return [
          { id: 'auto', name: 'Auto Build', description: 'Application-owned harness orchestration and helper stages' },
          { id: PARABLE_MODE_ID, name: 'Parable', description: 'Claude Code meta-harness — plans, casts executors, verifies, and reviews' },
          ...foundryModels,
        ];
      }
    }

    // Fallback to default Anthropic models
    console.log('[Claude Service] Using default Anthropic model list');
    const models: Array<{ id: string; name: string; description: string }> = [
      { id: 'auto', name: 'Auto Build', description: 'Harness orchestration — picks the lead model, helper handoffs, and shared context per task' },
      { id: PARABLE_MODE_ID, name: 'Parable', description: 'Claude Code meta-harness — plans, casts executors, verifies, and reviews' },
      { id: 'claude-sonnet-5', name: 'Sonnet 5', description: 'Latest Claude Sonnet - strong coding and agentic work with Sonnet-tier speed' },
      { id: 'claude-fable-5', name: 'Fable 5', description: 'Most capable Claude model - best for demanding coding and long-horizon agentic work' },
      { id: 'claude-opus-4-8', name: 'Opus 4.8', description: 'Latest and most capable model - best for complex tasks' },
      { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Highly capable model' },
      { id: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Highly capable model' },
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', description: 'Previous generation Opus' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Latest Sonnet - excellent balance of speed and capability' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', description: 'Balanced performance and speed' },
      { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4', description: 'Fast and capable' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: 'Fastest model - best for simple tasks' },
      { id: ZAI_GLM_CLAUDE_MODEL_PICKER_ID, name: 'GLM 5.2 [1M] (Claude Code)', description: 'Z.AI GLM-5.2 via Claude Code Anthropic-compatible endpoint' },
      { id: 'codex:gpt-5.6-sol', name: 'GPT-5.6 Sol (Codex)', description: 'OpenAI flagship — hardest problems, complex coding, deep reasoning' },
      { id: 'codex:gpt-5.6-terra', name: 'GPT-5.6 Terra (Codex)', description: 'OpenAI balanced — competitive capability at lower cost' },
      { id: 'codex:gpt-5.6-luna', name: 'GPT-5.6 Luna (Codex)', description: 'OpenAI fast — speed-optimised, most cost-efficient' },
      { id: 'codex:gpt-5.5', name: 'GPT-5.5 (Codex)', description: 'OpenAI previous flagship — best for complex coding tasks' },
      { id: 'codex:gpt-5.4', name: 'GPT-5.4 (Codex)', description: 'OpenAI previous generation — best for complex coding tasks' },
      { id: 'codex:gpt-5.4-mini', name: 'GPT-5.4 Mini (Codex)', description: 'OpenAI fast — good balance of speed and capability' },
      { id: 'codex:gpt-5.3-codex', name: 'GPT-5.3 Codex (Codex)', description: 'OpenAI coding-optimised — purpose-built for agents' },
      { id: 'codex:o3', name: 'o3 (Codex)', description: 'OpenAI o3 — deep reasoning model' },
      { id: ZAI_GLM_CODEX_MODEL_PICKER_ID, name: 'GLM 5.2 (Codex)', description: 'Z.AI GLM-5.2 via Codex CLI OpenAI-compatible endpoint' },
    ];

    // Append custom models from settings (Kimi, Gemini, etc via API proxy)
    const customModels = (settings.customModels || []) as Array<{ id: string; name: string; modelId: string; description?: string }>;
    for (const cm of customModels) {
      if (cm.id && cm.name) {
        models.push({
          id: `custom:${cm.id}`,
          name: cm.name,
          description: cm.description || 'Custom model via API proxy',
        });
      }
    }

    // Cursor models — CLI-based, no API key required for model listing.
    // Try dynamic fetch with API key; otherwise show hardcoded defaults.
    const cursorKey = (settings.cursorApiKey as string) || '';
    let cursorModelsFetched = false;
    if (cursorKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Cursor } = require('@cursor/sdk');
        const cursorModels = await Cursor.models.list({ apiKey: cursorKey });
        if (cursorModels?.length) {
          for (const m of cursorModels) {
            models.push({
              id: `cursor:${m.id}`,
              name: `${m.displayName || m.id} (Cursor)`,
              description: m.description || 'Cursor model',
            });
          }
          cursorModelsFetched = true;
          console.log(`[Claude Service] Loaded ${cursorModels.length} Cursor models dynamically`);
        }
      } catch (err) {
        console.warn('[Claude Service] Failed to fetch Cursor models dynamically:', err);
      }
    }
    if (!cursorModelsFetched) {
      models.push(
        { id: 'cursor:composer-2.5', name: 'Composer 2.5', description: 'Cursor latest — Composer 2.5' },
        { id: 'cursor:claude-3.5-sonnet', name: 'Cursor (Sonnet 3.5)', description: 'Cursor with Claude Sonnet 3.5' },
        { id: 'cursor:gpt-4o', name: 'Cursor (GPT-4o)', description: 'Cursor with GPT-4o' },
        { id: 'cursor:gemini-3.5-flash', name: 'Gemini 3.5 Flash (Cursor)', description: 'Cursor model' },
        { id: 'cursor:o3', name: 'o3 (Cursor)', description: 'Cursor model' },
      );
    }

    // DeepSeek models via OpenCode (requires API key)
    const deepseekKey = (settings.deepseekApiKey as string) || '';
    if (deepseekKey) {
      models.push(
        { id: 'opencode:deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'DeepSeek via OpenCode agent' },
        { id: 'opencode:deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast DeepSeek via OpenCode' },
        { id: 'opencode:deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', description: 'Reasoning model via OpenCode' },
      );
    }

    // Gemini models via CLI — always show, CLI uses GEMINI_API_KEY env var or settings
    models.push(
      { id: 'gemini:gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'Latest Gemini — 4x faster, frontier-level coding & agents' },
      { id: 'gemini:gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via CLI' },
      { id: 'gemini:gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Google Gemini 2.5 Flash via CLI' },
    );

    return models;
  }

  /**
   * Check if model supports Computer Use API
   */
  private supportsComputerUse(model: string): boolean {
    const supportedModels = [
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet',
      'claude-sonnet-4',
    ];

    return supportedModels.some(m => model.includes(m));
  }

  /**
   * Get Computer Use beta header for the model
   */
  private getComputerUseBetaHeader(model: string): string {
    // Sonnet 5, Fable 5, Opus 4.6/4.5, and Sonnet 4.6 use newer beta version
    if (model.includes('sonnet-5') || model.includes('fable-5') || model.includes('opus-4-6') || model.includes('opus-4-5') || model.includes('sonnet-4-6')) {
      return 'computer-use-2025-11-24';
    }
    // Other models use older beta version
    return 'computer-use-2025-01-24';
  }

  /**
   * Build the system prompt append section based on session type
   * Includes SSH context for remote sessions and agent memories
   */
  // Static portion of system prompt — cached as a constant to maximize prompt cache hits.
  // The Anthropic API caches from the start of the prompt, so keeping this prefix
  // byte-identical across messages avoids cache misses.
  private static readonly STATIC_SYSTEM_PROMPT = `
## Build Agent

You are the Build agent, an AI development assistant running inside the Build desktop application. You have access to a browser preview panel via MCP tools (claudette-browser) that allows you to test changes you make to web applications in real-time.

### Browser Testing Capabilities

When you make changes to frontend code or start development servers, you can:
- Navigate to localhost URLs to test the application
- Take screenshots to verify UI changes
- Inspect the DOM and check element states
- Monitor network requests and console output

### Proactive Testing

At the start of each session, ask the user: "Would you like me to help test your changes in the browser as we work?"

If the user agrees:
- After making UI changes, navigate to the appropriate URL and take a screenshot to verify the changes
- When starting dev servers, wait for them to be ready then navigate to test the application
- Report any visual issues, console errors, or unexpected behavior you observe
- Be proactive about suggesting which URLs to test based on the files being modified

You are intelligent enough to determine what URLs to test based on the project structure, development server configuration, and the specific files being modified.

### Design Mode

When the user asks you to DESIGN something visual — a landing page, UI mockup, slide deck, poster, dashboard concept, brand exploration, or similar — call the DesignMode tool (claudette-design) with a complete design brief, then END YOUR TURN with a one-line handoff message. A dedicated design session (Open Design) takes over the view and its design-specialized agent does the designing — you do not write design files yourself, and you do not open the browser to preview designs. Design files land in a workspace folder inside this session and the design conversation syncs back to you automatically, so when the user returns you have full context to integrate the designs into code. Regular coding tasks do NOT need design mode.
`;

  private buildSystemPromptAppend(
    session: Session,
    memoriesPrompt?: string,
    gstackMode?: string,
    secureEnvContext?: string,
    supplementalConversationContext?: string,
    autoOrchestrationContext?: string,
    supplementalConversationContextLabel = 'Recent Session Context',
  ): string {
    // Start with static content (cached by the API) then append dynamic context
    let append = ClaudeService.STATIC_SYSTEM_PROMPT;

    // Default-on presentation contract for every native Claude turn. The
    // contract also tells lead agents to preserve it when delegating work.
    append += `\n\n${adhdOutputService.getSystemContext()}`;

    if (secureEnvContext) {
      append += `\n\n${secureEnvContext}`;
    }

    if (autoOrchestrationContext && autoOrchestrationContext.trim()) {
      append += `

## Turn Scope

${autoOrchestrationContext}
`;
    }

    // Add SSH remote execution context if this is an SSH session
    if (session.sshConfig) {
      append += `

## Remote Execution Context

You are executing commands on a REMOTE machine via SSH. All file operations, bash commands, and tool executions happen on the remote server, not locally.

### Remote Connection Details
- **Host**: ${session.sshConfig.host}
- **Username**: ${session.sshConfig.username}
- **Working Directory**: ${session.worktreePath || session.sshConfig.remoteWorkdir}
${session.branch ? `- **Git Branch**: ${session.branch}` : ''}

### Important Notes
- All paths are relative to the remote working directory
- The browser preview tools run LOCALLY but your code changes are on the remote machine
- If you need to test a web application, remember it's running on the remote server (you may need to use the remote server's hostname or IP)

### Browser Cookies
Cookies from the user's local browser session are synced to \`/tmp/grep-build-cookies.json\` on this machine. If you need to browse an authenticated site using chrome-devtools, read that file and use \`mcp__chrome-devtools__set_cookies\` to inject them, or pass cookies to the browser via JavaScript.
`;

      // Add worktree setup output if available
      if (session.setupOutput) {
        // Clean up ANSI codes from the output
        const cleanOutput = session.setupOutput
          .replace(ANSI_COLOR_CODE_RE, '') // Remove ANSI color codes
          .replace(/___WORKDIR_END___/g, '') // Remove our internal marker
          .trim();

        if (cleanOutput) {
          append += `
### Worktree Setup Output

The following is the output from the worktree setup script that ran when this session was created. This provides context about the environment setup:

\`\`\`
${cleanOutput}
\`\`\`
`;
        }
      }
    }

    // Inject GStack skill routing if gstack is enabled in settings
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const gstackEnabled = settings.gstackEnabled as boolean | undefined;
    if (gstackEnabled) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getGStackRoutingPrompt } = require('./gstack.service');
      const routingPrompt = getGStackRoutingPrompt();
      if (routingPrompt) {
        append += '\n\n' + routingPrompt;
      }
    }

    // Add agent memories if available
    if (memoriesPrompt && memoriesPrompt.trim()) {
      append += `
## Your Memories

The following are facts, preferences, and knowledge you have remembered about this project. Use these to provide more relevant and context-aware assistance.

${memoriesPrompt}

**Note**: You can use the \`remember\`, \`recall\`, and \`forget\` tools to manage your memories.
`;
    }

    if (supplementalConversationContext && supplementalConversationContext.trim()) {
      append += `

## ${supplementalConversationContextLabel}

CRITICAL: The following turns happened earlier in this SAME session. They may be missing from your
current transcript because the session was restarted, resumed on another machine, or handled by a
different AI coding agent (Codex, Cursor, etc.). Either way this is YOUR prior work and context.
Do NOT ask the user to repeat what was discussed. Do NOT say "I don't have context", "this is the
start of our conversation", or "you have me at a disadvantage". Resolve short follow-ups like
"the evals" or "that job" against this history, and continue seamlessly from where it left off.

${supplementalConversationContext}
`;
    }

    if (session.htmlRenderMode === 'html') {
      append += `

## HTML Response Mode

For substantive responses (more than ~500 characters of content), respond with a complete, self-contained HTML document instead of Markdown. Output the HTML directly — do NOT wrap it in code fences or markdown blocks. Just output the raw HTML starting with <!DOCTYPE html>:

<!DOCTYPE html>
<html>
<head><style>/* your styles */</style></head>
<body>/* your content */</body>
</html>

### HTML Response Guidelines
- Use a dark theme: background #1a1a2e, text #e0e0e0, accent #7c3aed
- Use SVG for diagrams and visualizations (inline, no external deps)
- Use HTML tables for data (styled, not plain)
- Use collapsible \`<details>\` sections for lengthy content
- Use syntax-highlighted \`<pre><code>\` blocks for code
- NO external dependencies (no CDN links, no external CSS/JS)
- Make it visually rich: use color, spacing, borders, shadows
- For short responses (quick answers, confirmations), respond in plain text — no HTML wrapper needed
- Always include \`<meta charset="utf-8">\` in the head
`;
    }

    return append;
  }

  private getSecureEnvFilePath(sessionId: string, session: Session): string {
    return session.sshConfig
      ? `/tmp/g-build-secure-env-${sessionId}.sh`
      : path.join(os.tmpdir(), `g-build-secure-env-${sessionId}.sh`);
  }

  private isJavaScriptEntrypoint(commandOrArg: string | undefined): boolean {
    return !!commandOrArg && /\.(?:cjs|mjs|js|jsx|ts|tsx)$/i.test(commandOrArg);
  }

  private resolveLocalClaudeLaunch(
    nodeExecutable: string | undefined,
    options: { command: string; args: string[] }
  ): { command: string; args: string[]; mode: 'node-override' | 'node-script' | 'sdk-command' } {
    if (!nodeExecutable) {
      return { command: options.command, args: options.args, mode: 'sdk-command' };
    }

    const commandName = path.basename(options.command).replace(/\.exe$/i, '').toLowerCase();
    const commandIsNode = commandName === 'node' || commandName === 'nodejs';

    if (commandIsNode || this.isJavaScriptEntrypoint(options.args[0])) {
      return { command: nodeExecutable, args: options.args, mode: 'node-override' };
    }

    if (this.isJavaScriptEntrypoint(options.command)) {
      return { command: nodeExecutable, args: [options.command, ...options.args], mode: 'node-script' };
    }

    return { command: options.command, args: options.args, mode: 'sdk-command' };
  }

  private createLocalClaudeCodeProcess(
    nodeExecutable: string | undefined,
    options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }
  ): SpawnedProcess {
    const launch = this.resolveLocalClaudeLaunch(nodeExecutable, options);
    const safeCwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : process.cwd();
    if (safeCwd !== options.cwd) {
      console.warn(`[Claude Service] Spawn cwd does not exist: ${options.cwd}, using: ${safeCwd}`);
    }
    console.log('[Claude Service] Spawning local Claude Code:', {
      command: launch.command,
      mode: launch.mode,
      sdkCommand: options.command,
      firstArg: launch.args[0],
    });

    const child = spawn(launch.command, launch.args, {
      cwd: safeCwd,
      env: options.env,
      stdio: ['pipe', 'pipe', options.env.DEBUG_CLAUDE_AGENT_SDK ? 'pipe' : 'ignore'],
      signal: options.signal,
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create local Claude Code process stdio');
    }

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      kill: child.kill.bind(child),
      on: child.on.bind(child) as SpawnedProcess['on'],
      once: child.once.bind(child) as SpawnedProcess['once'],
      off: child.off.bind(child) as SpawnedProcess['off'],
    };
  }

  private resolveLocalNodeExecutable(): string | undefined {
    const homeDir = os.homedir();
    const candidates = new Set<string>();
    const addCandidate = (candidate?: string | null) => {
      if (!candidate) return;
      const trimmed = candidate.trim();
      if (!trimmed) return;
      candidates.add(trimmed);
    };

    addCandidate(process.env.CLAUDE_CODE_NODE_PATH);
    addCandidate(process.env.NODE);
    addCandidate(process.env.npm_node_execpath);

    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      addCandidate(path.join(dir, 'node'));
    }

    addCandidate('/opt/homebrew/bin/node');
    addCandidate('/usr/local/bin/node');
    addCandidate('/opt/local/bin/node');
    addCandidate(path.join(homeDir, '.nodenv', 'shims', 'node'));
    addCandidate(path.join(homeDir, '.asdf', 'shims', 'node'));
    addCandidate(path.join(homeDir, '.volta', 'bin', 'node'));

    const nvmVersionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      const versionDirs = fs.readdirSync(nvmVersionsDir)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const versionDir of versionDirs) {
        addCandidate(path.join(nvmVersionsDir, versionDir, 'bin', 'node'));
      }
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore invalid candidates and continue scanning.
      }
    }

    return undefined;
  }

  private resolveValidCwd(session: Session): string {
    const candidates = [
      session.worktreePath,
      session.repoPath,
      session.sshConfig?.remoteWorkdir,
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }

    if (session.worktreePath || session.repoPath) {
      const missing = session.worktreePath || session.repoPath;
      console.warn(`[Claude Service] Session working directory no longer exists: ${missing}, falling back to home directory`);
    }

    return process.cwd();
  }

  private formatSecureEnvFileContent(sessionId: string): string {
    const envVars = secureKeysService.getSessionEnvVars(sessionId);
    const lines = [
      `# Temporary secure environment variables for Build session ${sessionId}`,
      ...envVars.map(({ name, value }) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`),
      '',
    ];

    return lines.join('\n');
  }

  private async prepareSecureEnvContext(sessionId: string, session: Session): Promise<string | undefined> {
    const envVars = secureKeysService.getSessionEnvVars(sessionId);
    if (envVars.length === 0) {
      return undefined;
    }

    const envFilePath = this.getSecureEnvFilePath(sessionId, session);
    const envFileContent = this.formatSecureEnvFileContent(sessionId);

    if (session.sshConfig) {
      await sshService.writeRemoteFile(sessionId, session.sshConfig, envFilePath, envFileContent);
    } else {
      fs.writeFileSync(envFilePath, envFileContent, { mode: 0o600 });
      try {
        fs.chmodSync(envFilePath, 0o600);
      } catch {
        // best-effort permission tightening
      }
    }

    const envVarNames = envVars.map(({ name }) => `- ${name}`).join('\n');

    return `## Secure Environment Variables

The user provided sensitive environment variables. They are available in a temporary shell file at \`${envFilePath}\`.

Available variable names:
${envVarNames}

Read or source that file if you need the actual values. Do not print secret values into chat, logs, diffs, or committed files unless the user explicitly asks for that.`;
  }

  private normalizeConversationMessages(messages?: ChatMessage[]): ChatMessage[] {
    if (!messages || messages.length === 0) {
      return [];
    }

    const normalized = messages
      .map((message) => ({
        ...message,
        timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      }))
      .filter((message) => !Number.isNaN(message.timestamp.getTime()))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return this.capSupplementalMessagesForContext(normalized);
  }

  private capSupplementalMessagesForContext(messages: ChatMessage[]): ChatMessage[] {
    const capped: ChatMessage[] = [];
    let approxBytes = 0;

    for (let i = messages.length - 1; i >= 0 && capped.length < SUPPLEMENTAL_CONTEXT_MAX_MESSAGES; i--) {
      const message = messages[i];
      const approxMessageBytes = (
        (message.content || '').length
        + JSON.stringify(message.toolCalls || []).length
        + JSON.stringify(message.contentBlocks || []).length
        + 256
      );
      if (capped.length > 0 && approxBytes + approxMessageBytes > SUPPLEMENTAL_CONTEXT_MAX_BYTES) break;
      approxBytes += approxMessageBytes;
      capped.unshift(message);
    }

    if (messages.length > capped.length) {
      console.log(`[Claude Service] Capped supplemental model context from ${messages.length} to ${capped.length} messages`);
    }

    return capped;
  }

  private buildSupplementalClaudeContext(transcriptMessages: ChatMessage[], supplementalMessages: ChatMessage[], userMessage: string): string {
    if (supplementalMessages.length === 0) {
      return '';
    }

    const lastTranscriptTimestamp = transcriptMessages.length > 0
      ? Math.max(...transcriptMessages.map((message) => message.timestamp.getTime()))
      : -Infinity;

    const deltaMessages = supplementalMessages.filter((message) => message.timestamp.getTime() > lastTranscriptTimestamp);
    const relevantMessages = transcriptMessages.length === 0 ? supplementalMessages : deltaMessages;
    if (relevantMessages.length === 0) {
      return '';
    }

    const CLAUDE_CONTEXT_MAX_CHARS = 20000;
    const promptBudget = userMessage.length + 2000;
    const contextBudget = Math.min(14000, CLAUDE_CONTEXT_MAX_CHARS - promptBudget);

    if (contextBudget <= 1000) {
      return '';
    }

    return formatConversationContext(relevantMessages, contextBudget);
  }

  private getHarnessFromModel(model: string): Harness {
    if (model.startsWith('codex:')) return 'codex';
    if (model.startsWith('cursor:')) return 'cursor';
    if (model.startsWith('gemini:')) return 'gemini';
    if (model.startsWith('opencode:')) return 'opencode';
    if (model.startsWith('custom:')) return 'custom';
    return 'claude';
  }

  private recordHarnessOverride(sessionId: string, fromModel: string | undefined, toModel: string, taskTier?: TaskTier, taskDomain?: TaskDomain): void {
    if (!toModel || toModel === 'auto') return;
    try {
      analyticsService.recordHarnessOverride({
        sessionId,
        timestamp: Date.now(),
        fromModel,
        toModel,
        harness: this.getHarnessFromModel(toModel),
        taskTier,
        taskDomain,
      });
    } catch (error) {
      console.warn('[Claude Service] Could not record harness override:', error);
    }
  }

  private recordHarnessCompletion(
    sessionId: string,
    session: Session | undefined,
    model: string | undefined,
    event: StreamEvent | undefined,
    success: boolean,
    error?: string,
    taskTier?: TaskTier,
    taskDomain?: TaskDomain,
  ): void {
    if (!model) return;
    const resolvedModel = model === 'auto' ? event?.usage?.model : model;
    if (!resolvedModel) return;
    const harness = this.getHarnessFromModel(resolvedModel);
    if (success) {
      this.rememberLastAssistantHarness(sessionId, harness, resolvedModel);
    }
    const usage = event?.usage;
    const inputTokens = usage?.inputTokens ?? Math.max(0, (usage?.totalTokens || 0) - (usage?.outputTokens || 0));
    const outputTokens = usage?.outputTokens || 0;
    const cacheReadTokens = usage?.cacheReadTokens || 0;
    const cacheWriteTokens = usage?.cacheWriteTokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const analyticsModel = usage?.model || model;
    const cost = usage
      ? usage.costUsd ?? estimateCost(analyticsModel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
      : 0;

    try {
      if (usage && totalTokens > 0) {
        const baselineCost = estimateBaselineCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
        const tokenEvent = {
          sessionId,
          sessionName: session?.name || sessionId,
          timestamp: Date.now(),
          model: analyticsModel,
          harness,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          estimatedCostUsd: cost,
          baselineCostUsd: baselineCost,
          savingsVsBaselineUsd: Math.max(0, baselineCost - cost),
          costMethod: 'estimated' as const,
        };
        analyticsService.recordTokenEvent(tokenEvent);
        if (this.mainWindow) {
          this.mainWindow.webContents.send(IPC_CHANNELS.ANALYTICS_TOKEN_EVENT, tokenEvent);
        }
      }

      analyticsService.recordHarnessOutcome({
        sessionId,
        timestamp: Date.now(),
        harness,
        model: analyticsModel,
        success,
        taskTier,
        taskDomain,
        tokens: totalTokens,
        costUsd: cost,
        error,
      });
    } catch (analyticsError) {
      console.warn('[Claude Service] Could not record harness completion:', analyticsError);
    }
  }

  private async buildRemoteProjectInstructionContext(
    sessionId: string,
    session: Session,
    projectPath: string,
    contextLimits?: HarnessContextLimits,
  ): Promise<string> {
    if (!session.sshConfig) return '';

    const remoteWorkdir = session.worktreePath || session.sshConfig.remoteWorkdir || projectPath;
    const cacheKey = `${sessionId}:${remoteWorkdir}`;
    const cached = this.remoteProjectContextCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.REMOTE_PROJECT_CONTEXT_TTL) {
      return cached.context;
    }

    try {
      const files = await sshService.scanRemoteHarnessContextFiles(sessionId, session.sshConfig, remoteWorkdir);
      const context = formatProjectInstructionContextFiles(files, {
        maxChars: contextLimits?.maxProjectContextChars,
        maxFiles: contextLimits?.maxProjectContextFiles,
      });
      this.remoteProjectContextCache.set(cacheKey, { context, loadedAt: Date.now() });
      return context;
    } catch (error) {
      console.warn('[Claude Service] Could not collect remote project instruction context:', error);
      if (cached) return cached.context;
      return '';
    }
  }

  private getMemoryProjectPath(session: Session, fallbackPath?: string): string | undefined {
    if (session.sshConfig) {
      const remotePath = session.worktreePath || session.repoPath || session.sshConfig.remoteWorkdir;
      if (!remotePath) return undefined;
      const normalizedRemotePath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
      return `ssh://${session.sshConfig.username}@${session.sshConfig.host}:${session.sshConfig.port || 22}${normalizedRemotePath}`;
    }

    return session.worktreePath || session.repoPath || fallbackPath;
  }

  private getResolvedSdkSessionId(sessionId: string): string | undefined {
    const rawSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
      || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;
    return normalizeClaudeSdkSessionId(rawSdkSessionId);
  }

  private getSshSdkResumeRepairCacheKey(sessionId: string, rawSdkSessionId: string | undefined): string {
    return `${sessionId}:${normalizeClaudeSdkSessionId(rawSdkSessionId) || 'none'}`;
  }

  private normalizeSdkResumeMatchText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private isSignificantBuildUserPromptForSdkResume(value: string): boolean {
    const normalized = this.normalizeSdkResumeMatchText(value);
    if (normalized.length < 24) return false;
    if (normalized.startsWith('<')) return false;
    return !/^(status|status\?|cwd\??|what is your cwd\??|the working tree)$/i.test(normalized);
  }

  private getBuildUserPromptsForSdkResumeRepair(sessionId: string, currentUserMessage: string): string[] {
    const currentMessage = this.normalizeSdkResumeMatchText(currentUserMessage);
    const buildTranscript = this.loadBuildTranscriptForSession(sessionId);
    if (!buildTranscript.exists) return [];

    const prompts: string[] = [];
    const seen = new Set<string>();
    for (let i = buildTranscript.entries.length - 1; i >= 0 && prompts.length < 6; i--) {
      const entry = buildTranscript.entries[i];
      if (entry.role !== 'user') continue;

      const normalized = this.normalizeSdkResumeMatchText(entry.content || '');
      if (!this.isSignificantBuildUserPromptForSdkResume(normalized)) continue;
      if (currentMessage && normalized === currentMessage) continue;
      if (seen.has(normalized)) continue;

      seen.add(normalized);
      prompts.push(normalized.slice(0, 500));
    }

    return prompts;
  }

  private getSdkTranscriptPromptMatches(content: string, prompts: string[]): Set<number> {
    const matches = new Set<number>();
    if (!content || prompts.length === 0) return matches;

    const transcriptUserText = this.parseTranscriptContent(content)
      .filter((message) => message.role === 'user')
      .map((message) => this.normalizeSdkResumeMatchText(message.content || ''))
      .join('\n');
    if (!transcriptUserText) return matches;

    prompts.forEach((prompt, index) => {
      const needle = prompt.length > 180 ? prompt.slice(0, 180) : prompt;
      if (needle && transcriptUserText.includes(needle)) {
        matches.add(index);
      }
    });

    return matches;
  }

  private countContiguousRecentPromptMatches(matches: Set<number>, promptCount: number): number {
    let count = 0;
    while (count < promptCount && matches.has(count)) {
      count++;
    }
    return count;
  }

  private async repairSshSdkSessionIdFromBuildTranscript(
    sessionId: string,
    session: Session,
    rawSdkSessionId: string | undefined,
    currentUserMessage: string,
  ): Promise<string | undefined> {
    const currentSdkSessionId = normalizeClaudeSdkSessionId(rawSdkSessionId);
    if (!session.sshConfig) return currentSdkSessionId;

    const prompts = this.getBuildUserPromptsForSdkResumeRepair(sessionId, currentUserMessage);
    if (prompts.length === 0) return currentSdkSessionId;

    let requiredScore = Math.min(2, prompts.length);
    const requiredRecentPrefix = Math.min(3, prompts.length);
    const remoteWorkdir = session.worktreePath || session.sshConfig.remoteWorkdir || session.repoPath || '';
    let currentScore = 0;
    let currentRecentPrefix = 0;
    let currentTranscriptFound = false;

    if (currentSdkSessionId) {
      const currentContent = await sshService.fetchRemoteTranscript(
        sessionId,
        session.sshConfig,
        currentSdkSessionId,
        remoteWorkdir,
        { full: false },
      );
      if (currentContent) {
        currentTranscriptFound = true;
        const currentMatches = this.getSdkTranscriptPromptMatches(currentContent, prompts);
        currentScore = currentMatches.size;
        currentRecentPrefix = this.countContiguousRecentPromptMatches(currentMatches, prompts.length);
      }
      if (currentRecentPrefix >= requiredRecentPrefix) {
        return currentSdkSessionId;
      }
    }
    if (currentSdkSessionId && !currentTranscriptFound) {
      requiredScore = 1;
    }

    const transcripts = await sshService.listRemoteTranscripts(sessionId, session.sshConfig, remoteWorkdir);
    let bestSdkSessionId: string | undefined;
    let bestScore = currentScore;
    let bestMatchedMissingRecentPrompt = false;
    const missingRecentPromptIndex = currentRecentPrefix < prompts.length ? currentRecentPrefix : undefined;

    for (const transcript of transcripts.slice(0, 12)) {
      if (transcript.sessionId === currentSdkSessionId) continue;
      const content = await sshService.fetchRemoteTranscript(
        sessionId,
        session.sshConfig,
        transcript.sessionId,
        remoteWorkdir,
        { full: false },
      );
      if (!content) continue;

      const matches = this.getSdkTranscriptPromptMatches(content, prompts);
      const score = matches.size;
      const matchedMissingRecentPrompt = typeof missingRecentPromptIndex === 'number'
        && matches.has(missingRecentPromptIndex);
      if (matchedMissingRecentPrompt) {
        bestScore = score;
        bestSdkSessionId = transcript.sessionId;
        bestMatchedMissingRecentPrompt = true;
        break;
      }
      if (!bestMatchedMissingRecentPrompt && score > bestScore && score >= requiredScore) {
        bestScore = score;
        bestSdkSessionId = transcript.sessionId;
      }
    }

    if (bestSdkSessionId && (bestMatchedMissingRecentPrompt || bestScore >= requiredScore)) {
      console.warn(
        `[Claude Service] Repaired SSH Claude SDK resume mapping for ${sessionId.substring(0, 8)}: ` +
        `${currentSdkSessionId || rawSdkSessionId || 'none'} -> ${bestSdkSessionId} ` +
        `(Build transcript match ${bestScore}/${prompts.length}, recent prefix ${currentRecentPrefix}/${prompts.length}, ` +
        `current transcript ${currentTranscriptFound ? 'found' : 'missing'})`
      );
      this.sessionStore.set(`sdkSessionMappings.${sessionId}`, bestSdkSessionId);
      return bestSdkSessionId;
    }

    if (currentSdkSessionId) {
      console.warn(
        `[Claude Service] SSH Claude SDK resume mapping for ${sessionId.substring(0, 8)} matched only ` +
        `${currentScore}/${prompts.length} significant Build prompts and ${currentRecentPrefix}/${prompts.length} ` +
        'recent-prefix prompts; no better remote transcript found'
      );
    }
    return currentSdkSessionId;
  }

  private async repairSshSdkSessionIdFromBuildTranscriptOnce(
    sessionId: string,
    session: Session,
    rawSdkSessionId: string | undefined,
    currentUserMessage: string,
  ): Promise<string | undefined> {
    const currentSdkSessionId = rawSdkSessionId && rawSdkSessionId !== 'new' ? rawSdkSessionId : undefined;
    if (!session.sshConfig) return currentSdkSessionId;

    const cacheKey = this.getSshSdkResumeRepairCacheKey(sessionId, rawSdkSessionId);
    const cached = this.sshSdkResumeRepairChecks.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.checkedAt < this.SSH_SDK_RESUME_REPAIR_TTL_MS) {
      console.log(`[Claude Service] Skipping SSH SDK resume repair scan for ${sessionId.substring(0, 8)}; mapping checked recently`);
      return cached.sdkSessionId;
    }

    const repairedSdkSessionId = await this.repairSshSdkSessionIdFromBuildTranscript(
      sessionId,
      session,
      rawSdkSessionId,
      currentUserMessage,
    );
    this.sshSdkResumeRepairChecks.set(cacheKey, {
      sdkSessionId: repairedSdkSessionId,
      checkedAt: now,
    });
    if (repairedSdkSessionId && repairedSdkSessionId !== currentSdkSessionId) {
      this.sshSdkResumeRepairChecks.set(this.getSshSdkResumeRepairCacheKey(sessionId, repairedSdkSessionId), {
        sdkSessionId: repairedSdkSessionId,
        checkedAt: now,
      });
    }
    return repairedSdkSessionId;
  }

  private isCanonicalSdkSessionSystemMessage(systemMsg: { subtype?: string; session_id?: string }): boolean {
    return !!normalizeClaudeSdkSessionId(systemMsg.session_id)
      && (!systemMsg.subtype || systemMsg.subtype === 'init');
  }

  private logIgnoredSdkSessionId(sessionId: string, source: string, subtype: string): void {
    const key = `${sessionId}:${source}:${subtype}`;
    const now = Date.now();
    const state = this.ignoredSdkSessionIdLogState.get(key) || { count: 0, lastLoggedAt: 0 };
    state.count += 1;

    if (QUIET_IGNORED_SDK_SESSION_ID_SUBTYPES.has(subtype)) {
      if (STREAM_DEBUG && now - state.lastLoggedAt > 10_000) {
        console.log(
          `[Claude SDK] Ignored ${state.count} non-conversation ${subtype} session_id event(s) from ${source} for ${sessionId}`
        );
        state.count = 0;
        state.lastLoggedAt = now;
      }
      this.ignoredSdkSessionIdLogState.set(key, state);
      return;
    }

    if (state.count === 1 || now - state.lastLoggedAt > 60_000) {
      const suffix = state.count > 1 ? ` (${state.count}x since last log)` : '';
      console.log(`[Claude SDK] Ignoring non-conversation session_id from ${source}:${subtype} for ${sessionId}${suffix}`);
      state.count = 0;
      state.lastLoggedAt = now;
    }
    this.ignoredSdkSessionIdLogState.set(key, state);
  }

  private shouldForwardTaskProgress(
    sessionId: string,
    taskId: string | undefined,
    toolUseId: string | undefined,
    text: string
  ): boolean {
    const key = `${sessionId}:${taskId || toolUseId || 'task'}`;
    const now = Date.now();
    const state = this.taskProgressEmitState.get(key) || { lastText: '', lastEmittedAt: 0, suppressed: 0 };
    const textChanged = text !== state.lastText;
    const elapsed = now - state.lastEmittedAt;

    if (
      state.lastEmittedAt === 0
      || elapsed >= TASK_PROGRESS_EMIT_INTERVAL_MS
      || (textChanged && elapsed >= TASK_PROGRESS_TEXT_CHANGE_INTERVAL_MS)
    ) {
      this.taskProgressEmitState.set(key, {
        lastText: text,
        lastEmittedAt: now,
        suppressed: 0,
      });
      return true;
    }

    state.suppressed += 1;
    this.taskProgressEmitState.set(key, state);
    return false;
  }

  private shouldEmitSdkStatusNotice(sessionId: string, status: string): boolean {
    const key = `${sessionId}:${status}`;
    const now = Date.now();
    const last = this.sdkStatusNoticeAt.get(key) || 0;
    if (now - last < SDK_STATUS_NOTICE_INTERVAL_MS) return false;
    this.sdkStatusNoticeAt.set(key, now);
    return true;
  }

  private rememberCanonicalSdkSessionId(
    sessionId: string,
    systemMsg: { subtype?: string; session_id?: string },
    source: string
  ): string | undefined {
    const canonicalSdkSessionId = normalizeClaudeSdkSessionId(systemMsg.session_id);
    if (!canonicalSdkSessionId) return undefined;

    if (!this.isCanonicalSdkSessionSystemMessage(systemMsg)) {
      this.logIgnoredSdkSessionId(sessionId, source, systemMsg.subtype || 'unknown');
      return undefined;
    }

    // When the native SDK session ID CHANGES (fresh session started
    // mid-conversation, e.g. after a stale-session restart), record a baseline
    // timestamp. Build transcript messages older than this baseline are NOT in
    // the native session's history — any context injected at the fresh start
    // lived in a per-spawn system prompt that does not persist across resumes.
    // Resume turns must re-inject pre-baseline history every turn.
    const previousSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined;
    const hasBaseline = typeof this.sessionStore.get(`sdkSessionBaseline.${sessionId}`) === 'number';
    if (previousSdkSessionId !== canonicalSdkSessionId || !hasBaseline) {
      // Same-ID-but-no-baseline covers sessions from before baseline tracking
      // existed: we cannot know how much history their native session holds,
      // so mark "now" and re-inject everything older on subsequent turns.
      // Worst case for a healthy legacy session is bounded duplicate context;
      // worst case without this is permanent amnesia after an old restart.
      this.sessionStore.set(`sdkSessionBaseline.${sessionId}`, Date.now());
      console.log(`[Claude SDK] Native session ${canonicalSdkSessionId.substring(0, 8)} for ${sessionId.substring(0, 8)} — baseline ${previousSdkSessionId !== canonicalSdkSessionId ? 'set (new session)' : 'backfilled (legacy)'} for pre-restart context re-injection`);
    }
    this.sessionStore.set(`sdkSessionMappings.${sessionId}`, canonicalSdkSessionId);
    return canonicalSdkSessionId;
  }

  /** Normalized comparable text for cross-transcript message matching. */
  private comparableMessageText(m: ChatMessage): string {
    const raw = (m.content || '').trim()
      || (m.contentBlocks || []).map((b) => (b as { text?: string }).text || '').join(' ').trim();
    return raw.replace(/\s+/g, ' ').toLowerCase().slice(0, 240);
  }

  /**
   * Same-conversation-message match across transcripts (Build vs native SDK).
   * Ids/harness tags differ between stores, so match on role + normalized
   * content prefix. Contentless (tool-only) messages never match — callers
   * must filter those out of delta computations.
   */
  private isSameConversationMessage(a: ChatMessage, b: ChatMessage): boolean {
    if (a.role !== b.role) return false;
    const na = this.comparableMessageText(a);
    if (!na) return false;
    return na === this.comparableMessageText(b);
  }

  private getSdkSessionBaseline(sessionId: string): number | undefined {
    const baseline = this.sessionStore.get(`sdkSessionBaseline.${sessionId}`) as number | undefined;
    return typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : undefined;
  }

  private clearSdkSessionId(sessionId: string): void {
    this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
    this.sessionStore.delete(`sdkSessionMappings.${sessionId}`);
  }

  private getSessionContextPercentage(sessionId: string): number | undefined {
    const livePercentage = this.sessionContextPercentage.get(sessionId);
    if (typeof livePercentage === 'number') return livePercentage;

    const stored = this.sessionStore.get(`contextUsage.${sessionId}`) as { percentage?: unknown } | undefined;
    return typeof stored?.percentage === 'number' ? stored.percentage : undefined;
  }

  private getContextWindowSize(model?: string): number {
    const currentModel = model || '';
    const hasLargeContext = currentModel.includes('fable-5')
      || currentModel.includes('sonnet-5')
      || currentModel.includes('opus-4-8')
      || currentModel.includes('opus-4-7')
      || currentModel.includes('opus-4-6')
      || currentModel.includes('sonnet-4-6')
      || currentModel.includes('sonnet-4-5');
    return hasLargeContext ? 1000000 : 200000;
  }

  private extractContextUsageFromTranscriptContent(content: string, fallbackModel?: string): {
    inputTokens: number;
    contextWindowSize: number;
    percentage: number;
  } | undefined {
    const lines = content.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as {
          model?: string;
          isSidechain?: boolean;
          usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          message?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
        };
        // Subagent (sidechain) calls run in their own context window and
        // don't reflect the main conversation's occupancy.
        if (entry.isSidechain) continue;
        const usage = entry.usage || entry.message?.usage;
        if (!usage) continue;

        const inputTokens = (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
        if (inputTokens <= 0) continue;

        const contextWindowSize = this.getContextWindowSize(entry.model || entry.message?.model || fallbackModel);
        return {
          inputTokens,
          contextWindowSize,
          percentage: Math.round((inputTokens / contextWindowSize) * 100),
        };
      } catch {
        // Skip malformed transcript lines.
      }
    }
    return undefined;
  }

  private readLocalTranscriptTail(transcriptPath: string, maxBytes = 512 * 1024): string {
    const stats = fs.statSync(transcriptPath);
    const bytesToRead = Math.min(stats.size, maxBytes);
    const start = Math.max(0, stats.size - bytesToRead);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  private async inferSessionContextPercentageFromSdkTranscript(
    sessionId: string,
    session: Session,
    sdkSessionId: string,
    model?: string,
  ): Promise<number | undefined> {
    try {
      let content: string | null = null;
      if (session.sshConfig) {
        const remoteWorkdir = session.worktreePath || session.sshConfig.remoteWorkdir || session.repoPath || '';
        content = await sshService.fetchRemoteTranscript(
          sessionId,
          session.sshConfig,
          sdkSessionId,
          remoteWorkdir,
          { full: false },
        );
      } else {
        const transcriptPath = this.findTranscriptPath(sessionId, sdkSessionId);
        if (transcriptPath) {
          content = this.readLocalTranscriptTail(transcriptPath);
        }
      }

      if (!content) return undefined;
      const usage = this.extractContextUsageFromTranscriptContent(content, model);
      if (!usage) return undefined;

      this.rememberSessionContextUsage(sessionId, usage.inputTokens, usage.contextWindowSize, usage.percentage);
      console.log(
        `[Claude Service] Inferred SDK transcript context for ${sessionId.substring(0, 8)}: ` +
        `${usage.inputTokens}/${usage.contextWindowSize} (${usage.percentage}%)`
      );
      return usage.percentage;
    } catch (error) {
      console.warn('[Claude Service] Could not infer SDK transcript context usage:', error);
      return undefined;
    }
  }

  private async resolveSessionContextPercentage(
    sessionId: string,
    session: Session,
    sdkSessionId: string,
    model?: string,
  ): Promise<number | undefined> {
    const storedPercentage = this.getSessionContextPercentage(sessionId);
    // Context occupancy can never exceed 100% — readings above that were
    // computed from cumulative turn usage by older builds and must not be
    // trusted to gate resume. Drop them and re-measure from the transcript.
    if (typeof storedPercentage === 'number' && storedPercentage <= 100) return storedPercentage;
    if (typeof storedPercentage === 'number') {
      console.warn(`[Claude Service] Discarding impossible stored context reading (${storedPercentage}%) for ${sessionId.substring(0, 8)}; re-measuring from transcript`);
      this.sessionContextPercentage.delete(sessionId);
      this.sessionStore.delete(`contextUsage.${sessionId}`);
    }
    return this.inferSessionContextPercentageFromSdkTranscript(sessionId, session, sdkSessionId, model);
  }

  private rememberSessionContextUsage(
    sessionId: string,
    inputTokens: number,
    contextWindowSize: number,
    percentage: number,
  ): void {
    this.sessionContextPercentage.set(sessionId, percentage);
    this.sessionStore.set(`contextUsage.${sessionId}`, {
      inputTokens,
      contextWindowSize,
      percentage,
      updatedAt: new Date().toISOString(),
    });
  }

  private buildAutoBuildHandoffReferences(
    sessionId: string,
    session: Session,
    projectPath: string,
  ): string[] {
    const references: string[] = [];
    // Approved artifacts are injected only for an explicit execution follow-up.
    // Keeping them in every unrelated handoff resurrects stale plan instructions
    // long after the user has moved on to a different task.
    const planFile = this.sessionPlanFiles.get(sessionId);
    if (planFile?.filePath) {
      references.push(`Plan file path: ${planFile.filePath}`);
    }

    const sdkSessionId = this.getResolvedSdkSessionId(sessionId);
    if (sdkSessionId) {
      if (session.sshConfig) {
        const remoteWorkdir = session.worktreePath || session.sshConfig.remoteWorkdir || projectPath;
        const escapedPath = remoteWorkdir.replace(/\//g, '-').replace(/^-/, '-');
        references.push(`Claude transcript file on remote: ~/.claude/projects/${escapedPath}/${sdkSessionId}.jsonl`);
        references.push(`Fallback transcript search on remote: ~/.claude/projects/*/${sdkSessionId}.jsonl`);
      } else {
        const transcriptPath = this.findTranscriptPath(sessionId, sdkSessionId);
        references.push(transcriptPath
          ? `Claude transcript file: ${transcriptPath}`
          : `Claude transcript file search: ~/.claude/projects/*/${sdkSessionId}.jsonl`);
      }
    } else {
      references.push(`Session transcript reference: current session ${sessionId}; resolve the concrete transcript path before broad context requests.`);
    }

    return references;
  }

  private buildApprovedPlanHandoffContext(sessionId: string): string {
    const planFile = this.sessionApprovedPlanFiles.get(sessionId)
      || this.sessionStore.get(`harnessState.${sessionId}.approvedPlan`) as { content?: string; filePath?: string } | undefined;
    const planContent = planFile?.content?.trim();
    if (!planContent) return '';

    const planReference = planFile?.filePath
      ? `Plan file path: ${planFile.filePath}\n`
      : '';

    return `<approved_plan_handoff>
The user approved this plan for execution. If the current user message asks to proceed, execute this plan before starting a different investigation.
${planReference}
${planContent}
</approved_plan_handoff>`;
  }

  private isFalseNoContextAssistantMessage(message: ChatMessage): boolean {
    if (message.role !== 'assistant') return false;

    const normalized = this.normalizeSdkResumeMatchText(message.content || '').toLowerCase();
    if (!normalized) return false;

    return [
      'fresh conversation',
      'without the earlier thread',
      'without the earlier context',
      'without the dossier',
      'without a full briefing',
      'no briefing carried over',
      'no record of which',
      'no record of what',
      "don't yet have the",
      'which jobs you',
      'which mission',
      'what would you like me to do with the evals',
      'leaves rather a lot to the imagination',
      "haven't run anything yet",
      'start of our conversation',
      'no eval run to report',
      'no context from previous',
      'this is a new session',
      "i don't have visibility into",
      "i don't have access to previous",
    ].some((needle) => normalized.includes(needle));
  }

  private getBuildContinuityMessageContent(message: ChatMessage, maxChars: number): string {
    let content = message.content || '';
    if (!content.trim() && message.contentBlocks?.length) {
      content = message.contentBlocks
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text || '')
        .join('');
    }

    if (maxChars > 0 && content.length > maxChars) {
      return `${content.slice(0, maxChars)}\n[...truncated]`;
    }
    return content;
  }

  private filterMessagesForBuildContinuityContext(messages: ChatMessage[]): ChatMessage[] {
    let hasPriorContext = false;

    return messages.filter((message) => {
      const content = this.getBuildContinuityMessageContent(message, 1).trim();
      if (message.role === 'assistant' && hasPriorContext && this.isFalseNoContextAssistantMessage(message)) {
        return false;
      }

      if (content.length > 0 || (message.toolCalls?.length || 0) > 0 || (message.contentBlocks?.length || 0) > 0) {
        hasPriorContext = true;
      }

      return true;
    });
  }

  private extractBuildContinuityReferences(messages: ChatMessage[]): string[] {
    const references: string[] = [];
    const seen = new Set<string>();
    const add = (value: string): void => {
      const cleaned = value
        .replace(/[),.;:]+$/g, '')
        .replace(/^['"`]+|['"`]+$/g, '')
        .trim();
      if (cleaned.length < 3 || seen.has(cleaned)) return;
      seen.add(cleaned);
      references.push(cleaned);
    };

    const text = messages
      .slice(-30)
      .map((message) => this.getBuildContinuityMessageContent(message, 4000))
      .join('\n');

    const patterns = [
      /\/[A-Za-z0-9._~@%+=:,/-]+/g,
      /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|py|json|jsonl|md|sql|txt|toml|ya?ml|sh|tsx|css|html)\b/g,
      /\b_[A-Za-z0-9_.-]+\.(?:json|jsonl|md|txt|psv|csv)\b/g,
      /\b[A-Za-z0-9_.-]+\.(?:py|json|jsonl|md|sql|toml|ya?ml|sh)\b/g,
      /\b(?:port|localhost:)\s*\d{2,5}\b/gi,
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        add(match[0]);
        if (references.length >= 24) return references;
      }
    }

    return references;
  }

  private buildBuildSessionContinuityContext(
    sessionId: string,
    session: Session,
    messages: ChatMessage[],
  ): string {
    const filteredMessages = this.filterMessagesForBuildContinuityContext(messages);
    if (filteredMessages.length === 0) return '';

    const sessionName = session.name || session.aiGeneratedName || sessionId;
    const remotePath = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir;
    const recentUsers = filteredMessages
      .filter((message) => message.role === 'user')
      .slice(-6)
      .map((message) => `- ${this.getBuildContinuityMessageContent(message, 900).trim()}`)
      .filter((line) => line.length > 2);
    const workingNotes = filteredMessages
      .filter((message) => message.role === 'assistant' && !this.isFalseNoContextAssistantMessage(message))
      .slice(-4)
      .map((message) => {
        const content = this.getBuildContinuityMessageContent(message, 1200).trim();
        return content ? `- ${content}` : '';
      })
      .filter(Boolean);
    const references = this.extractBuildContinuityReferences(filteredMessages);

    const parts = [
      '<build_session_continuity>',
      'This is the same Build session, not a new conversation. Treat this block as authoritative over any earlier assistant message claiming missing context, no briefing, or no prior thread.',
      `Session: ${sessionName}`,
      session.branch ? `Branch: ${session.branch}` : '',
      remotePath ? `Working directory: ${remotePath}` : '',
      recentUsers.length > 0 ? `Recent user requests:\n${recentUsers.join('\n')}` : '',
      references.length > 0 ? `Relevant files, job artifacts, or ids mentioned:\n${references.map((reference) => `- ${reference}`).join('\n')}` : '',
      workingNotes.length > 0 ? `Recent working notes from prior assistant turns:\n${workingNotes.join('\n')}` : '',
      'Continue from these facts directly. If the user asks a short follow-up like "the evals" or "what happened to those jobs", resolve it against the recent requests and artifacts above before asking them to restate context.',
      '</build_session_continuity>',
    ].filter(Boolean).join('\n\n');

    return parts.length > 18000
      ? truncateMiddlePreservingTail(parts, 18000, {
        marker: '\n\n[... middle of Build session continuity context truncated ...]\n\n',
        tailRatio: 0.4,
      })
      : parts;
  }

  private async buildUnifiedContextForHarness(
    sessionId: string,
    session: Session,
    currentHarness: Harness,
    normalizedSupplementalMessages: ChatMessage[],
    projectPath: string,
    autoOrchestrationContext: string,
    prefetchedTranscriptMessages?: ChatMessage[],
    options: { includeCurrentHarnessMessages?: boolean } = {},
  ): Promise<string> {
    const transcriptMessages = prefetchedTranscriptMessages
      ?? await this.getCanonicalMessages(sessionId, ROUTING_TRANSCRIPT_LIMIT, { allowSdkFallback: false });
    const mergedMessages = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
    const memoryProjectPath = this.getMemoryProjectPath(session, projectPath);
    const memoriesContext = memoryProjectPath
      ? await memoryService.getMemoriesForPrompt(memoryProjectPath).catch((error) => {
        console.warn(`[Claude Service] Could not load memories for ${currentHarness} context:`, error);
        return '';
      })
      : '';
    const contextLimits = CLI_HARNESS_CONTEXT_LIMITS[currentHarness];
    const remoteProjectContext = await this.buildRemoteProjectInstructionContext(sessionId, session, projectPath, contextLimits);
    const handoffReferences = this.buildAutoBuildHandoffReferences(sessionId, session, projectPath);
    // CLI harnesses do not share Claude's system prompt. Embed the same
    // app-owned default in their unified handoff, including Auto helper stages.
    const orchestrationAndPlanContext = [
      adhdOutputService.getSystemContext(),
      autoOrchestrationContext,
    ].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
    const pinnedBuildContinuityContext = currentHarness === 'codex'
      ? this.buildBuildSessionContinuityContext(sessionId, session, mergedMessages)
      : '';
    const maxConversationChars = contextLimits?.maxConversationChars;

    let context = buildUnifiedHarnessContext({
      messages: mergedMessages,
      currentHarness: options.includeCurrentHarnessMessages ? undefined : currentHarness,
      projectPath,
      additionalProjectContext: remoteProjectContext,
      orchestrationContext: orchestrationAndPlanContext,
      continuityContext: pinnedBuildContinuityContext,
      handoffReferences,
      memoriesContext,
      includeProjectContext: session.sshConfig ? false : true,
      maxConversationChars,
      maxProjectContextChars: contextLimits?.maxProjectContextChars,
      maxProjectContextFiles: contextLimits?.maxProjectContextFiles,
    });

    if (contextLimits?.maxFinalChars && context.length > contextLimits.maxFinalChars) {
      console.warn(
        `[Claude Service] ${currentHarness} unified context too long (${context.length} chars), truncating to ${contextLimits.maxFinalChars}`,
      );
      context = truncateMiddlePreservingTail(context, contextLimits.maxFinalChars, {
        marker: `\n\n[... middle of shared ${currentHarness} context truncated for responsiveness ...]\n\n`,
        tailRatio: 0.35,
      });
    }

    if (currentHarness === 'codex') {
      console.log(
        `[Claude Service] Codex handoff budget: project=${remoteProjectContext.length} chars conversation<=${maxConversationChars ?? 'default'} final=${context.length}/${contextLimits?.maxFinalChars ?? 'unbounded'} chars`,
      );
    }

    return context;
  }

  private rememberLastAssistantHarness(sessionId: string, harness: Harness, model?: string): void {
    this.sessionStore.set(`harnessState.${sessionId}.lastAssistantHarness`, harness);
    if (model) {
      this.sessionStore.set(`harnessState.${sessionId}.lastAssistantModel`, model);
    }
  }

  noteHarnessSwitch(sessionId: string, fromModel: string, toModel: string): void {
    if (!sessionId || !fromModel || !toModel || fromModel === toModel) return;
    const key = `harnessState.${sessionId}.pendingHarnessSwitch`;
    if (toModel === 'auto') {
      this.sessionStore.delete(key);
      return;
    }
    const marker: PendingHarnessSwitch = {
      fromModel,
      toModel,
      fromHarness: this.getHarnessFromModel(fromModel),
      toHarness: this.getHarnessFromModel(toModel),
      timestamp: Date.now(),
    };
    this.sessionStore.set(key, marker);
    console.log(
      `[Claude Service] Recorded explicit harness switch ${marker.fromHarness}:${fromModel} -> ${marker.toHarness}:${toModel} for ${sessionId.substring(0, 8)}`,
    );
  }

  private consumePendingHarnessSwitch(sessionId: string, selectedModel: string): PendingHarnessSwitch | undefined {
    const key = `harnessState.${sessionId}.pendingHarnessSwitch`;
    const marker = this.sessionStore.get(key) as PendingHarnessSwitch | undefined;
    if (!marker) return undefined;

    const isExpired = !Number.isFinite(marker.timestamp) || Date.now() - marker.timestamp > 60 * 60 * 1000;
    const selectedHarness = this.getHarnessFromModel(selectedModel);
    const targetsThisTurn = marker.toModel === selectedModel || marker.toHarness === selectedHarness;
    if (isExpired) {
      this.sessionStore.delete(key);
      return undefined;
    }
    if (!targetsThisTurn) return undefined;

    this.sessionStore.delete(key);
    console.log(
      `[Claude Service] Consuming explicit harness switch ${marker.fromHarness} -> ${marker.toHarness} for ${sessionId.substring(0, 8)}`,
    );
    return marker;
  }

  private getLastAssistantRoute(
    supplementalMessages: ChatMessage[],
    transcriptMessages: ChatMessage[] = [],
  ): { harness?: Harness; model?: string } {
    const merged = mergeConversationMessages(transcriptMessages, supplementalMessages);
    const lastAssistant = [...merged].reverse().find((message) => message.role === 'assistant' && message.harness);
    return {
      harness: lastAssistant?.harness,
      model: typeof (lastAssistant as ChatMessage & { model?: unknown; resolvedModel?: unknown } | undefined)?.model === 'string'
        ? (lastAssistant as ChatMessage & { model: string }).model
        : typeof (lastAssistant as ChatMessage & { resolvedModel?: unknown } | undefined)?.resolvedModel === 'string'
          ? (lastAssistant as ChatMessage & { resolvedModel: string }).resolvedModel
          : undefined,
    };
  }

  private getLastAssistantHarness(
    supplementalMessages: ChatMessage[],
    transcriptMessages: ChatMessage[] = [],
  ): Harness | undefined {
    return this.getLastAssistantRoute(supplementalMessages, transcriptMessages).harness;
  }

  private async resolveLastAssistantRoute(
    sessionId: string,
    supplementalMessages: ChatMessage[],
    prefetchedTranscriptMessages?: ChatMessage[],
  ): Promise<{ harness?: Harness; model?: string }> {
    const fromSupplemental = this.getLastAssistantRoute(supplementalMessages);
    if (fromSupplemental.harness) return fromSupplemental;

    if (prefetchedTranscriptMessages) {
      const fromPrefetched = this.getLastAssistantRoute(supplementalMessages, prefetchedTranscriptMessages);
      if (fromPrefetched.harness) return fromPrefetched;
    } else {
      try {
        const transcriptPeek = await this.getCanonicalMessages(sessionId, ROUTING_TRANSCRIPT_LIMIT, { allowSdkFallback: false });
        const fromTranscript = this.getLastAssistantRoute(supplementalMessages, transcriptPeek);
        if (fromTranscript.harness) return fromTranscript;
      } catch (error) {
        console.warn('[Claude Service] Could not peek transcript for last assistant harness:', error);
      }
    }

    return {
      harness: this.sessionStore.get(`harnessState.${sessionId}.lastAssistantHarness`) as Harness | undefined,
      model: this.sessionStore.get(`harnessState.${sessionId}.lastAssistantModel`) as string | undefined,
    };
  }

  private async resolveLastAssistantHarness(
    sessionId: string,
    supplementalMessages: ChatMessage[],
    prefetchedTranscriptMessages?: ChatMessage[],
  ): Promise<Harness | undefined> {
    return (await this.resolveLastAssistantRoute(sessionId, supplementalMessages, prefetchedTranscriptMessages)).harness;
  }

  private canAutoBuildStageEdit(stage: OrchestrationStage, sdkPermissionMode?: string): boolean {
    if (stage.tier !== 'build' && stage.tier !== 'refine') return false;
    return sdkPermissionMode !== 'plan' && sdkPermissionMode !== 'dontAsk';
  }

  private getAutoBuildCodexPermissionMode(stage: OrchestrationStage, sdkPermissionMode?: string): string {
    if (!this.canAutoBuildStageEdit(stage, sdkPermissionMode)) {
      // A read-only follow-up still needs to execute tests and inspection
      // commands. Preserve an explicit user-selected bypass mode instead of
      // silently forcing Codex back through a remote Bubblewrap sandbox that
      // may not be supported on the SSH host.
      return sdkPermissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'dontAsk';
    }
    return sdkPermissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
  }

  private shouldRunAutoBuildStage(stage: OrchestrationStage, orchestration: OrchestrationPlan, leadContent: string, sdkPermissionMode?: string): boolean {
    if (stage.model === orchestration.leadModel && stage.trigger === 'now') return false;
    if (stage.trigger === 'now' || stage.trigger === 'manual-follow-up') return false;
    if (stage.harness === 'claude' || stage.harness === 'custom') return false;
    if ((stage.tier === 'build' || stage.tier === 'refine') && !this.canAutoBuildStageEdit(stage, sdkPermissionMode)) return false;

    if (stage.trigger === 'on-failure') {
      return /\b(error|failed|failing|failure|regression|exception|cannot|can't|unable|blocked)\b/i.test(leadContent);
    }

    return stage.required || orchestration.mode === 'lead-with-delegates';
  }

  private recordAutoBuildLeadSuccess(sessionId: string, orchestration?: OrchestrationPlan): void {
    if (!orchestration) return;
    try {
      autoRouterService.recordHarnessSuccess(sessionId, orchestration.leadHarness, orchestration.leadModel);
      // Keep the approved artifact pending until the execution lead actually
      // completes. A spawn/auth/transport failure must retry the configured
      // Execution model on the next "go" instead of falling back to planning.
      if (this.isApprovedPlanExecutionPending(sessionId)) {
        this.markApprovedPlanExecutionCompleted(sessionId);
      }
      const leadStage = orchestration.stages.find((stage) => stage.model === orchestration.leadModel && stage.trigger === 'now')
        || orchestration.stages[0];
      if (leadStage) {
        autoRouterService.recordTierCompletion(sessionId, leadStage.tier);
      }
    } catch (error) {
      console.warn('[Claude Service] Could not record Auto Build lead harness success:', error);
    }
  }

  private recordAutoBuildLeadFailure(sessionId: string, orchestration: OrchestrationPlan | undefined, errorMessage: string): void {
    if (!orchestration) return;
    try {
      autoRouterService.recordHarnessFailure(sessionId, orchestration.leadHarness, orchestration.leadModel, errorMessage);
    } catch (error) {
      console.warn('[Claude Service] Could not record Auto Build lead harness failure:', error);
    }
  }

  private parseGoalCommand(message: string): { objective: string; source: 'slash-command' } | undefined {
    const match = message.match(/^\/goal(?:\s+([\s\S]*))?$/i);
    const objective = match?.[1]?.trim();
    return objective ? { objective, source: 'slash-command' } : undefined;
  }

  private ensureCodexGoalsEnabled(context: string): void {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      const configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
      if (!configContent.includes('goals = true')) {
        const goalsSection = configContent.includes('[features]')
          ? configContent.replace('[features]', '[features]\ngoals = true')
          : configContent + '\n\n[features]\ngoals = true\n';
        fs.writeFileSync(configPath, goalsSection);
        console.log(`[Claude Service] Enabled Codex goals for ${context}`);
      }
    } catch (error) {
      console.warn(`[Claude Service] Could not enable Codex goals for ${context}:`, error);
    }
  }

  private getAutoBuildStageDisplayTitle(stage: OrchestrationStage): string {
    switch (stage.tier) {
      case 'plan':
        return 'Planning follow-up';
      case 'build':
        return 'Implementation follow-up';
      case 'verify':
        return 'Verification follow-up';
      case 'refine':
        return 'Refinement follow-up';
    }
  }

  private formatAutoBuildStageFailure(): string {
    return 'Follow-up step could not complete.\n';
  }

  private formatAutoBuildStageSkipped(): string {
    return 'Follow-up step skipped: this step is not available yet.\n';
  }

  private isAutoBuildStageFailureText(content: string): boolean {
    return /(?:Follow-up step|Auto Build helper) (?:could not complete|skipped)/i.test(content);
  }

  private buildAutoBuildStagePrompt(stage: OrchestrationStage, userMessage: string, leadContent: string, canEdit: boolean): string {
    const stageInstruction = !canEdit || stage.tier === 'verify' || stage.tier === 'plan'
      ? 'Do not modify files. Inspect, test, reason, and report findings only.'
      : stage.tier === 'build'
        ? 'Modify files as needed to implement this build stage. Keep edits scoped to the original request and the lead plan.'
        : 'Modify files only if needed to apply the requested refinement. Keep edits minimal and verify the result when practical.';
    const leadContextLimit = stage.trigger === 'after-plan' ? 12000 : 24000;

    return `You are continuing a Build agent turn for a scoped ${stage.tier} follow-up.

Before starting work, read all CLAUDE.md files in the project — the root CLAUDE.md, ~/.claude/CLAUDE.md (user instructions), and any .claude/ directory files. These contain critical project conventions, build commands, and constraints you must follow.

Scope: ${stage.tier.toUpperCase()}
Purpose: ${stage.purpose}

${stageInstruction}
Use any transcript file reference or plan file path in the handoff context before asking for copied history. Keep this handoff focused; context switching is expensive.
Do not mention internal coordination, routing, model selection, or this scope note unless the user explicitly asks.
Keep the response concise and directly useful to the lead result. If you run checks, say exactly what passed or failed. If you find an issue, include the file/path or command evidence needed to fix it.

Original user request:
${userMessage}

Lead result excerpt:
${leadContent.slice(0, leadContextLimit)}
`;
  }

  private async buildAutoBuildStageContext(
    sessionId: string,
    session: Session,
    currentHarness: Harness,
    normalizedSupplementalMessages: ChatMessage[],
    projectPath: string,
    autoOrchestrationContext: string,
  ): Promise<string> {
    return this.buildUnifiedContextForHarness(
      sessionId,
      session,
      currentHarness,
      normalizedSupplementalMessages,
      projectPath,
      autoOrchestrationContext,
    );
  }

  private isQueryCancelled(sessionId: string, signal?: AbortSignal): boolean {
    return !!signal?.aborted || !this.activeQueries.has(sessionId);
  }

  private async *streamAutoBuildStage(
    sessionId: string,
    session: Session,
    stage: OrchestrationStage,
    userMessage: string,
    leadContent: string,
    projectPath: string,
    normalizedSupplementalMessages: ChatMessage[],
    autoOrchestrationContext: string,
    sdkPermissionMode?: string,
    secureEnvContext?: string,
    abortSignal?: AbortSignal,
    taskDomain?: TaskDomain,
  ): AsyncGenerator<StreamEvent> {
    const stageHarness = this.getHarnessFromModel(stage.model);
    const stageLabel = `${stage.tier.toUpperCase()} via ${stageHarness}:${stage.model}`;
    const stageAgentId = `autobuild:${stage.tier}:${stageHarness}`;
    const stageAgentName = this.getAutoBuildStageDisplayTitle(stage);
    const stagePolicy = translateHarnessPolicy({
      harness: stageHarness,
      model: stage.model,
      policy: stage,
      permissionMode: sdkPermissionMode,
    });
    const withStageSource = (event: StreamEvent): StreamEvent => {
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_use' || event.type === 'tool_result') {
        const sourcedEvent: StreamEvent = {
          ...event,
          agentId: event.agentId || stageAgentId,
          agentName: event.agentName || stageAgentName,
        };
        if (sourcedEvent.toolCall && !sourcedEvent.toolCall.agentId) {
          sourcedEvent.toolCall = { ...sourcedEvent.toolCall, agentId: sourcedEvent.agentId };
        }
        return sourcedEvent;
      }
      return event;
    };

    if (this.isQueryCancelled(sessionId, abortSignal)) return;
    yield withStageSource({ type: 'text_delta', content: `\n\n---\n\n${this.getAutoBuildStageDisplayTitle(stage)}\n\n` });

    let stageContext = '';
    try {
      stageContext = await this.buildAutoBuildStageContext(
        sessionId,
        session,
        stageHarness,
        normalizedSupplementalMessages,
        projectPath,
        autoOrchestrationContext,
      );
    } catch (error) {
      console.warn(`[Claude Service] Auto Build ${stageLabel}: context build failed:`, error);
    }
    if (this.isQueryCancelled(sessionId, abortSignal)) return;

    const canEdit = this.canAutoBuildStageEdit(stage, sdkPermissionMode);
    const prompt = this.buildAutoBuildStagePrompt(stage, userMessage, leadContent, canEdit);
    const context = [secureEnvContext, stageContext].filter(Boolean).join('\n\n');
    let emittedStageContent = '';
    const getMissingFinalStageContent = (event: StreamEvent): string => {
      const finalContent = event.message?.content || '';
      const missing = finalContent && finalContent.startsWith(emittedStageContent)
        ? finalContent.slice(emittedStageContent.length)
        : (!emittedStageContent.trim() ? finalContent : '');
      emittedStageContent += missing;
      return missing;
    };

    try {
      if (this.isQueryCancelled(sessionId, abortSignal)) return;
      if (stageHarness === 'codex') {
        const codexModel = stage.model.split(':')[1];
        const codexPermissionMode = this.getAutoBuildCodexPermissionMode(stage, sdkPermissionMode);
        if (session.sshConfig && codexPermissionMode === 'dontAsk') {
          const sandbox = await sshService.detectRemoteCodexSandbox(sessionId, session.sshConfig);
          if (!sandbox.supported) {
            const detail = sandbox.reason
              ? `Remote Codex read-only sandbox is unavailable: ${sandbox.reason}`
              : 'Remote Codex read-only sandbox is unavailable.';
            console.warn(`[Claude Service] Auto Build ${stageLabel}: ${detail}`);
            this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, detail, stage.tier, taskDomain);
            yield withStageSource({
              type: 'text_delta',
              content: `${this.formatAutoBuildStageFailure()}${detail}\n`,
            });
            return;
          }
        }
        const codexPolicy = translateHarnessPolicy({
          harness: stageHarness,
          model: stage.model,
          policy: stage,
          permissionMode: codexPermissionMode,
        });
        for await (const event of codexService.streamAsChat(sessionId, prompt, projectPath, session.sshConfig, context, codexModel, undefined, codexPermissionMode, codexPolicy)) {
          if (this.isQueryCancelled(sessionId, abortSignal)) return;
          if (event.type === 'text_delta') {
            emittedStageContent += event.content || '';
          }
          if (event.type === 'message_complete') {
            const missing = getMissingFinalStageContent(event as StreamEvent);
            if (missing) {
              yield withStageSource({ type: 'text_delta', content: missing });
            }
            this.recordHarnessCompletion(sessionId, session, stage.model, event as StreamEvent, true, undefined, stage.tier, taskDomain);
            return;
          }
          if (event.type === 'error') {
            this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, event.error, stage.tier, taskDomain);
            yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageFailure() });
            return;
          }
          yield withStageSource(event as StreamEvent);
        }
        return;
      }

      if (stageHarness === 'cursor') {
        const cursorCliService = getCursorCliService();
        const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
        const workDir = session.worktreePath || session.repoPath || projectPath;
        for await (const event of cursorCliService.streamMessage(sessionId, fullPrompt, workDir, stage.model, session.sshConfig, undefined, stagePolicy)) {
          if (this.isQueryCancelled(sessionId, abortSignal)) return;
          if (event.type === 'text_delta') {
            emittedStageContent += event.content || '';
          }
          if (event.type === 'message_complete') {
            const missing = getMissingFinalStageContent(event as StreamEvent);
            if (missing) {
              yield withStageSource({ type: 'text_delta', content: missing });
            }
            this.recordHarnessCompletion(sessionId, session, stage.model, event as StreamEvent, true, undefined, stage.tier, taskDomain);
            return;
          }
          if (event.type === 'error') {
            this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, event.error, stage.tier, taskDomain);
            yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageFailure() });
            return;
          }
          yield withStageSource(event as StreamEvent);
        }
        return;
      }

      if (stageHarness === 'gemini') {
        const geminiService = getGeminiService();
        const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
        const workDir = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || projectPath;
        for await (const event of geminiService.streamMessage(sessionId, fullPrompt, workDir, stage.model, session.sshConfig, stagePolicy)) {
          if (this.isQueryCancelled(sessionId, abortSignal)) return;
          if (event.type === 'text_delta') {
            emittedStageContent += event.content || '';
          }
          if (event.type === 'message_complete') {
            const missing = getMissingFinalStageContent(event as StreamEvent);
            if (missing) {
              yield withStageSource({ type: 'text_delta', content: missing });
            }
            this.recordHarnessCompletion(sessionId, session, stage.model, event as StreamEvent, true, undefined, stage.tier, taskDomain);
            return;
          }
          if (event.type === 'error') {
            this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, event.error, stage.tier, taskDomain);
            yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageFailure() });
            return;
          }
          yield withStageSource(event as StreamEvent);
        }
        return;
      }

      if (stageHarness === 'opencode') {
        const openCodeService = getOpenCodeService();
        const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
        const workDir = session.worktreePath || session.repoPath || projectPath;
        for await (const event of openCodeService.streamMessage(sessionId, fullPrompt, workDir, stage.model, session.sshConfig, sdkPermissionMode, stagePolicy)) {
          if (this.isQueryCancelled(sessionId, abortSignal)) return;
          if (event.type === 'text_delta') {
            emittedStageContent += event.content || '';
          }
          if (event.type === 'message_complete') {
            const missing = getMissingFinalStageContent(event as StreamEvent);
            if (missing) {
              yield withStageSource({ type: 'text_delta', content: missing });
            }
            this.recordHarnessCompletion(sessionId, session, stage.model, event as StreamEvent, true, undefined, stage.tier, taskDomain);
            return;
          }
          if (event.type === 'error') {
            this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, event.error, stage.tier, taskDomain);
            yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageFailure() });
            return;
          }
          yield withStageSource(event as StreamEvent);
        }
        return;
      }

      this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, `${stageHarness} helper stages are not executable yet`, stage.tier, taskDomain);
      yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageSkipped() });
    } catch (error) {
      if (this.isQueryCancelled(sessionId, abortSignal)) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.recordHarnessCompletion(sessionId, session, stage.model, undefined, false, errorMessage, stage.tier, taskDomain);
      yield withStageSource({ type: 'text_delta', content: this.formatAutoBuildStageFailure() });
    }
  }

  private async *streamAutoBuildStages(
    sessionId: string,
    session: Session,
    orchestration: OrchestrationPlan | undefined,
    userMessage: string,
    leadContent: string,
    projectPath: string,
    normalizedSupplementalMessages: ChatMessage[],
    autoOrchestrationContext: string,
    sdkPermissionMode?: string,
    secureEnvContext?: string,
    abortSignal?: AbortSignal,
    taskDomain?: TaskDomain,
  ): AsyncGenerator<StreamEvent> {
    if (!orchestration || orchestration.stages.length <= 1) return;
    if (this.isQueryCancelled(sessionId, abortSignal)) return;

    let accumulatedStageContext = leadContent;
    for (const stage of orchestration.stages) {
      if (this.isQueryCancelled(sessionId, abortSignal)) return;
      if (!this.shouldRunAutoBuildStage(stage, orchestration, accumulatedStageContext, sdkPermissionMode)) continue;

      const fallbackStages = (stage.fallbackModels || []).map((model) => ({
        ...stage,
        model,
        harness: this.getHarnessFromModel(model),
        fallbackModels: undefined,
        purpose: stage.purpose,
      }));
      const attempts = [stage, ...fallbackStages];
      let stageSucceeded = false;
      let stageOutputs = '';

      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
        if (this.isQueryCancelled(sessionId, abortSignal)) return;
        const attempt = attempts[attemptIndex];

        console.log(`[Claude Service] Auto Build stage starting: ${attempt.tier} via ${attempt.model}`);
        let stageContent = '';
        let stageFailed = false;
        for await (const event of this.streamAutoBuildStage(
          sessionId,
          session,
          attempt,
          userMessage,
          accumulatedStageContext,
          projectPath,
          normalizedSupplementalMessages,
          autoOrchestrationContext,
          sdkPermissionMode,
          secureEnvContext,
          abortSignal,
          taskDomain,
        )) {
          if (this.isQueryCancelled(sessionId, abortSignal)) return;
          if (event.type === 'text_delta') {
            const content = event.content || '';
            stageContent += content;
            if (this.isAutoBuildStageFailureText(content)) {
              stageFailed = true;
            }
          }
          yield event;
        }
        if (this.isQueryCancelled(sessionId, abortSignal)) return;

        if (stageFailed) {
          try {
            autoRouterService.recordHarnessFailure(sessionId, attempt.harness, attempt.model, stageContent);
          } catch (error) {
            console.warn(`[Claude Service] Could not record Auto Build ${attempt.harness} failure:`, error);
          }
          accumulatedStageContext += `\n\n${attempt.tier.toUpperCase()} follow-up failed:\n${stageContent}`;
          continue;
        }

        if (stageContent.trim()) {
          stageOutputs += `\n\n${attempt.tier.toUpperCase()} follow-up result:\n${stageContent}`;
        }

        try {
          autoRouterService.recordHarnessSuccess(sessionId, attempt.harness, attempt.model);
          autoRouterService.recordTierCompletion(sessionId, attempt.tier);
        } catch (error) {
          console.warn(`[Claude Service] Could not record Auto Build ${attempt.tier} completion:`, error);
        }

        stageSucceeded = true;
        break;
      }

      if (stageOutputs.trim()) {
        accumulatedStageContext += stageOutputs;
      }

      if (!stageSucceeded && stage.required) {
        if (this.isQueryCancelled(sessionId, abortSignal)) return;
        yield { type: 'text_delta', content: '\nRequired follow-up step could not complete; skipping dependent follow-up work.\n' };
        break;
      }
    }
  }

  private async *streamLeadWithAutoBuildStages(
    leadEvents: AsyncIterable<StreamEvent>,
    sessionId: string,
    session: Session,
    orchestration: OrchestrationPlan | undefined,
    userMessage: string,
    projectPath: string,
    normalizedSupplementalMessages: ChatMessage[],
    autoOrchestrationContext: string,
    sdkPermissionMode?: string,
    secureEnvContext?: string,
    leadModelOverride?: string,
    abortSignal?: AbortSignal,
    taskDomain?: TaskDomain,
  ): AsyncGenerator<StreamEvent> {
    let leadContent = '';
    let leadError = '';
    let sawComplete = false;
    let completionEvent: StreamEvent | undefined;

    for await (const event of leadEvents) {
      if (this.isQueryCancelled(sessionId, abortSignal)) return;
      if (event.type === 'text_delta') {
        leadContent += event.content || '';
      }
      if (event.type === 'error') {
        leadError = event.error || 'Lead harness reported an error';
      }

      if (event.type === 'message_complete') {
        const finalContent = event.message?.content || '';
        const missingFinalContent = finalContent && finalContent.startsWith(leadContent)
          ? finalContent.slice(leadContent.length)
          : (!leadContent.trim() ? finalContent : '');
        if (missingFinalContent) {
          leadContent += missingFinalContent;
          yield { type: 'text_delta', content: missingFinalContent };
        }
        sawComplete = true;
        completionEvent = event;
        break;
      }

      yield event;
    }
    if (this.isQueryCancelled(sessionId, abortSignal)) return;

    if (sawComplete) {
      this.recordHarnessCompletion(sessionId, session, leadModelOverride || orchestration?.leadModel, completionEvent, true, undefined, orchestration?.stages[0]?.tier, taskDomain);
      this.recordAutoBuildLeadSuccess(sessionId, orchestration);

      for await (const event of this.streamAutoBuildStages(
        sessionId,
        session,
        orchestration,
        userMessage,
        leadContent,
        projectPath,
        normalizedSupplementalMessages,
        autoOrchestrationContext,
        sdkPermissionMode,
        secureEnvContext,
        abortSignal,
        taskDomain,
      )) {
        if (this.isQueryCancelled(sessionId, abortSignal)) return;
        yield event;
      }

      if (this.isQueryCancelled(sessionId, abortSignal)) return;
      yield { type: 'message_complete', resolvedModel: leadModelOverride || orchestration?.leadModel };
    } else if (orchestration && leadError) {
      this.recordAutoBuildLeadFailure(sessionId, orchestration, leadError);
      this.recordHarnessCompletion(sessionId, session, leadModelOverride || orchestration?.leadModel, undefined, false, leadError, orchestration.stages[0]?.tier, taskDomain);
    }
  }

  private getDesignMcpServer(sessionId: string) {
    const designModeTool = tool(
      'DesignMode',
      'Hand off to a design session (powered by Open Design). Call this whenever the user asks to design something visual: a landing page, UI mockup, slide deck, poster, dashboard, brand exploration, or similar. The app switches to a dedicated design canvas with its own design-specialized agent that does the designing — you do NOT create the design yourself. Pass the full design brief; it seeds the design session. Design files land in a workspace folder inside this session, and the design conversation syncs back to you automatically.',
      {
        brief: z.string().describe('The complete design brief to hand to the design agent — what to design, style direction, content, constraints. Be specific; this becomes the design session\'s opening prompt.'),
      },
      async (args) => {
        try {
          const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
          const sshConfig = currentSession?.sshConfig;
          const cwd = currentSession?.worktreePath || currentSession?.repoPath || sshConfig?.remoteWorkdir;
          if (!cwd) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Design mode requires a session working directory and none was found.',
              }],
              isError: true,
            };
          }
          const workspace = await designService.ensureDesignWorkspace(
            sessionId,
            cwd,
            currentSession?.name || args.brief.slice(0, 60),
            sshConfig?.remoteWorkdir ? { config: sshConfig, remoteWorkdir: sshConfig.remoteWorkdir } : undefined
          );
          await mcpService.syncLocalHarnessConfigs(workspace.daemonUrl).catch((error) => {
            console.warn('[Claude Service] OpenDesign MCP cross-harness sync failed:', error);
          });
          const run = await designService.startDesignRun(sessionId, args.brief);

          // Switch the session view to the design session (full takeover)
          if (this.mainWindow) {
            this.mainWindow.webContents.send(IPC_CHANNELS.DESIGN_OPEN_PANEL, {
              sessionId,
              url: run.conversationUrl,
              workspaceDir: workspace.workspaceDir,
              takeover: true,
            });
          }

          return {
            content: [{
              type: 'text' as const,
              text: [
                'Design session opened — the app has switched to the design canvas and the brief has been handed to the design agent, which will do the designing.',
                '',
                'Do NOT design or write design files yourself. End your turn now with a single short sentence telling the user the design session is ready and the brief has been handed over.',
                `Design files will appear in ${workspace.workspaceDir} and the design conversation syncs back to you automatically, so you will have full context when the user returns.`,
              ].join('\n'),
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DesignMode error:', error);
          return {
            content: [{
              type: 'text' as const,
              text: `Failed to activate design mode: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    return createSdkMcpServer({
      name: 'claudette-design',
      version: '1.0.0',
      tools: [designModeTool],
    });
  }

  // Get or create MCP server with browser snapshot tool for session
  private getBrowserMcpServer(sessionId: string) {
    // Create a fresh MCP server for each query — the SDK connects a transport
    // that can't be reused across queries ("Already connected to a transport" error)

    // Initialize Stagehand with API keys
    const apiKey = this.getApiKey();
    if (apiKey) {
      stagehandService.setApiKey(apiKey);
      console.log('[Claude Service] Set Anthropic API key for Stagehand');
    }
    // Pass Google API key for Gemini models (from store or environment)
    const googleApiKey = this.getGoogleApiKey() || process.env.GOOGLE_API_KEY;
    console.log('[Claude Service] Google API key check:', googleApiKey ? 'PRESENT' : 'MISSING', 'from store:', !!this.getGoogleApiKey(), 'from env:', !!process.env.GOOGLE_API_KEY);
    if (googleApiKey) {
      stagehandService.setGoogleApiKey(googleApiKey);
      console.log('[Claude Service] Set Google API key for Stagehand');
    } else {
      console.warn('[Claude Service] No Google API key available - Stagehand AI features will not work!');
    }

    // ============ STAGEHAND-POWERED BROWSER TOOLS ============
    // These tools use AI-powered browser automation via Stagehand

    const browserSnapshotTool = tool(
      'BrowserSnapshot',
      'Capture a snapshot of a webpage in the browser preview. Takes a screenshot and extracts the HTML content. Use this to inspect web pages, debug UI issues, or verify how pages render.',
      {
        url: z.string().describe('The URL to navigate to and capture'),
        waitForLoad: z.boolean().optional().describe('Wait for page to fully load before capturing (default: true)'),
        waitTime: z.number().optional().describe('Time to wait in milliseconds after navigation (default: 2000ms)'),
      },
      async (args) => {
        try {
          const { url, waitForLoad = true, waitTime = 2000 } = args;

          console.log('[Claude Service] Capturing browser snapshot via Stagehand:', url);

          // Also navigate the app's webview to keep it in sync
          browserService.navigate(sessionId, url).catch(err => {
            console.log('[Claude Service] Could not sync webview navigation:', err);
          });

          // Navigate using Stagehand
          const navResult = await stagehandService.navigate(url, sessionId);
          if (!navResult.success) {
            return {
              content: [{
                type: 'text',
                text: `Failed to navigate to ${url}: ${navResult.error}`,
              }],
              isError: true,
            };
          }

          // Additional wait if requested
          if (waitForLoad && waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 10000)));
          }

          // Capture full snapshot
          const snapshot = await stagehandService.captureSnapshot();
          if (!snapshot) {
            return {
              content: [{
                type: 'text',
                text: `Failed to capture snapshot of ${url}`,
              }],
              isError: true,
            };
          }

          // Emit navigation event to update UI
          this.emitBrowserUpdate(sessionId, snapshot.screenshot, snapshot.url);

          // Return snapshot info with image (MCP format)
          return {
            content: [
              {
                type: 'text',
                text: `Captured snapshot of ${snapshot.url} (${snapshot.title})\n\nHTML Preview:\n${snapshot.html.slice(0, 10000)}${snapshot.html.length > 10000 ? '...(truncated)' : ''}`,
              },
              {
                type: 'image',
                data: snapshot.screenshot,
                mimeType: 'image/png',
              },
            ],
          };
        } catch (error) {
          console.error('[Claude Service] Browser snapshot error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to capture browser snapshot: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserNavigate tool - simpler navigation without snapshot
    const browserNavigateTool = tool(
      'BrowserNavigate',
      'Navigate the browser preview to a URL without capturing a snapshot. Use this when you just want to go to a page.',
      {
        url: z.string().describe('The URL to navigate to'),
      },
      async (args) => {
        try {
          const { url } = args;

          // Ensure browser panel is open before Stagehand operations
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Navigating browser via Stagehand to:', url);
          const result = await stagehandService.navigate(url, sessionId);

          // Always sync the webview to the target URL.
          // If Stagehand connected to its own headless browser (fallback), the webview
          // won't have navigated. This ensures the visible browser preview stays in sync.
          if (result.success) {
            browserService.navigate(sessionId, url);
          }

          if (result.success && result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot, url);
          }

          return {
            content: [{
              type: 'text',
              text: result.success ? `Navigated to ${url}` : `Failed to navigate: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to navigate: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // ============ COMPUTER USE API TOOL ============
    // Claude-powered visual browser automation using screenshot-based interaction

    const computerUseTool = tool(
      'computer',
      'Interact with the browser using visual coordination. Takes screenshots and performs mouse/keyboard actions based on pixel coordinates. Use this for precise browser automation when you need to interact with visual elements. Coordinate space is 1024x768 virtual pixels.',
      {
        action: z.string().describe('Action to perform: screenshot, left_click, type, key, mouse_move, scroll, left_click_drag, right_click, middle_click, double_click, triple_click, left_mouse_down, left_mouse_up, hold_key, wait'),
        coordinate: z.tuple([z.number(), z.number()]).optional().describe('Pixel coordinates [x, y] for mouse actions (in 1024x768 virtual space)'),
        coordinate_end: z.tuple([z.number(), z.number()]).optional().describe('End coordinates for drag actions'),
        text: z.string().optional().describe('Text to type or key name to press'),
        scroll_direction: z.string().optional().describe('Scroll direction: up, down, left, right'),
        scroll_amount: z.number().optional().describe('Scroll amount (default: 5)'),
        duration: z.number().optional().describe('Duration in seconds for hold_key or wait'),
      },
      async (args) => {
        try {
          // Ensure browser panel is open
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Computer Use action:', args.action);
          const result = await computerUseService.executeAction(sessionId, args as any);

          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [
            { type: 'text', text: result.message }
          ];

          if (result.screenshot) {
            content.push({
              type: 'image',
              data: result.screenshot,
              mimeType: 'image/png',
            });

            // Emit browser update with screenshot
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return { content, isError: !result.success };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: `Computer use error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          };
        }
      }
    );

    // BrowserAct tool - AI-powered natural language actions (NEW - Stagehand feature!)
    const browserActTool = tool(
      'BrowserAct',
      'Execute a natural language action in the browser. This is the PRIMARY way to interact with web pages - use natural language like "click the login button", "fill in the email field with test@example.com", "scroll down to see more products". Much more reliable than CSS selectors!',
      {
        instruction: z.string().describe('Natural language instruction for what to do, e.g., "click the login button", "type hello in the search box", "scroll down"'),
      },
      async (args) => {
        try {
          const { instruction } = args;

          // Ensure browser panel is open before Stagehand operations
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Browser act:', instruction);
          const result = await stagehandService.act(instruction, sessionId);

          if (result.success && result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [
              {
                type: 'text',
                text: result.success ? `✓ ${result.message}` : `✗ Failed: ${result.error}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserObserve tool - Discover available actions (NEW - Stagehand feature!)
    const browserObserveTool = tool(
      'BrowserObserve',
      'Analyze the current page to discover available actions and interactive elements. Returns a list of things you can do on the page. Use this when you need to understand what actions are possible.',
      {
        instruction: z.string().optional().describe('Optional: Focus on specific types of elements, e.g., "buttons for submitting forms" or "navigation links"'),
      },
      async (args) => {
        try {
          const { instruction } = args;
          console.log('[Claude Service] Browser observe:', instruction || 'all');
          const result = await stagehandService.observe(instruction, sessionId);

          if (!result.success) {
            return {
              content: [{
                type: 'text',
                text: `Failed to observe page: ${result.error}`,
              }],
              isError: true,
            };
          }

          const actionsText = result.actions?.map((a, i) =>
            `${i + 1}. ${a.description}\n   Action: ${a.suggestedAction}\n   Selector: ${a.selector}`
          ).join('\n\n') || 'No actions found';

          return {
            content: [
              {
                type: 'text',
                text: `Available actions on page:\n\n${actionsText}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to observe page: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserAgent tool - Autonomous multi-step workflows (NEW - Stagehand feature!)
    const browserAgentTool = tool(
      'BrowserAgent',
      'Execute a complex multi-step task autonomously. The agent will figure out the necessary steps and execute them. Use this for complex workflows like "log in to the website and navigate to settings".',
      {
        task: z.string().describe('The task to accomplish, e.g., "navigate to the pricing page and extract all plan names and prices"'),
      },
      async (args) => {
        try {
          const { task } = args;
          console.log('[Claude Service] Browser agent task:', task);
          const result = await stagehandService.agent(task, sessionId);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          const actionsLog = result.actions?.map((a, i) =>
            `${i + 1}. ${a.description}`
          ).join('\n') || 'No actions recorded';

          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? `✓ Task completed: ${result.message}\n\nActions taken:\n${actionsLog}`
                  : `✗ Task failed: ${result.error}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to execute agent task: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserClick tool - click on elements (fallback when CSS selector is needed)
    const browserClickTool = tool(
      'BrowserClick',
      'Click on an element using a CSS selector. NOTE: Prefer using BrowserAct with natural language (e.g., "click the login button") as it is more reliable and self-healing.',
      {
        selector: z.string().describe('CSS selector for the element to click (e.g., "button.submit", "#login-btn")'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] BrowserClick ENTRY - selector:', selector);
          console.log('[Claude Service] stagehandService:', typeof stagehandService, Object.keys(stagehandService));
          const result = await stagehandService.click(selector);
          console.log('[Claude Service] BrowserClick result:', result);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [{
              type: 'text',
              text: result.success ? `Clicked element: ${selector}` : `Failed to click: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to click: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserType tool - type text into inputs (fallback when CSS selector is needed)
    const browserTypeTool = tool(
      'BrowserType',
      'Type text into an input field using a CSS selector. NOTE: Prefer using BrowserAct with natural language (e.g., "type hello@example.com in the email field") as it is more reliable.',
      {
        selector: z.string().describe('CSS selector for the input element (e.g., "input[name=\'email\']", "#search-box")'),
        text: z.string().describe('The text to type into the element'),
      },
      async (args) => {
        try {
          const { selector, text } = args;
          console.log('[Claude Service] Typing into element via Stagehand:', selector);
          const result = await stagehandService.type(selector, text);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [{
              type: 'text',
              text: result.success
                ? `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" into ${selector}`
                : `Failed to type: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to type: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserExtract tool - extract text from page
    const browserExtractTool = tool(
      'BrowserExtract',
      'Extract text content from the browser. Can extract from the whole page or a specific element. For structured data extraction, consider using BrowserExtractData instead.',
      {
        selector: z.string().optional().describe('Optional CSS selector to extract from specific element. If not provided, extracts all page text.'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] Extracting text via Stagehand:', selector || 'full page');
          const result = await stagehandService.extractText(selector);

          if (result.success && result.text !== undefined) {
            const truncated = result.text.length > 5000;
            return {
              content: [{
                type: 'text',
                text: `Extracted text${selector ? ` from ${selector}` : ''}:\n\n${result.text.slice(0, 5000)}${truncated ? '\n\n...(truncated)' : ''}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Failed to extract: ${result.error}`,
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to extract: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserExtractData tool - AI-powered structured data extraction (NEW - Stagehand feature!)
    const browserExtractDataTool = tool(
      'BrowserExtractData',
      'Extract structured data from the page using AI. Describe what data you want and it will be extracted intelligently. Returns JSON data.',
      {
        instruction: z.string().describe('What to extract, e.g., "the product name, price, and rating", "all navigation menu items", "the main article title and author"'),
      },
      async (args) => {
        try {
          const { instruction } = args;
          console.log('[Claude Service] AI data extraction:', instruction);

          // Use a simple schema compatible with Gemini's structured output API.
          // z.record() doesn't produce valid Gemini schema (missing items field),
          // so we use explicit object properties instead.
          const flexibleSchema = z.object({
            items: z.array(z.object({
              label: z.string().describe('Label or key for the extracted item'),
              value: z.string().describe('Value or content of the extracted item'),
            })).describe('Extracted items as label-value pairs'),
          });

          const result = await stagehandService.extract<{ items: Array<{ label: string; value: string }> }>(instruction, flexibleSchema);

          if (result.success && result.data) {
            return {
              content: [{
                type: 'text',
                text: `Extracted data:\n\n${JSON.stringify(result.data, null, 2)}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Failed to extract data: ${result.error}`,
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to extract data: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserGetInfo tool - get current page info
    const browserGetInfoTool = tool(
      'BrowserGetInfo',
      'Get information about the current page in the browser preview (URL, title).',
      {},
      async () => {
        try {
          console.log('[Claude Service] Getting page info via Stagehand');
          const info = await stagehandService.getPageInfo();

          if (info) {
            return {
              content: [{
                type: 'text',
                text: `Current page:\nURL: ${info.url}\nTitle: ${info.title}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: 'Browser not initialized. Navigate to a page first.',
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to get page info: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserGetDOM tool - get full DOM without truncation
    const browserGetDOMTool = tool(
      'BrowserGetDOM',
      'Get the complete HTML DOM of the current page. Use this when you need to find elements that may not be visible in the initial snapshot preview.',
      {
        selector: z.string().optional().describe('Optional CSS selector to get HTML of specific element instead of whole document'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] Getting DOM via Stagehand:', selector || 'full page');

          const html = await stagehandService.getHTML();
          if (!html) {
            return {
              content: [{
                type: 'text',
                text: 'Browser not initialized. Navigate to a page first.',
              }],
              isError: true,
            };
          }

          // If selector provided, we could filter but Stagehand doesn't have direct script execution
          // For now, return full HTML - user can use BrowserExtract for specific elements
          if (selector) {
            // Note: Stagehand's page.evaluate could be used here if needed
            console.log('[Claude Service] Note: selector filtering not implemented, returning full DOM');
          }

          // Cap at reasonable limit to avoid overwhelming Claude
          const maxLength = 50000;
          const truncated = html.length > maxLength;

          return {
            content: [{
              type: 'text',
              text: `DOM HTML:\n\n${html.slice(0, maxLength)}${truncated ? '\n\n...(truncated - use BrowserExtract for specific content)' : ''}`,
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to get DOM: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // Note: CDP-based debugging tools (console logs, network requests) are not available with Stagehand
    // Stagehand provides AI-powered automation instead of low-level CDP access

    // UpdateSessionName tool - allow Claude to set descriptive session names
    const updateSessionNameTool = tool(
      'UpdateSessionName',
      'Set the current session name once with a descriptive title. Only call this when the session does not already have a useful name. Do not rename an already titled session. Use concise, descriptive titles (3-5 words).',
      {
        name: z.string().describe('A concise descriptive name for this session (e.g., "Video Processing Workflow", "Entity Research Integration")'),
      },
      async (args) => {
        try {
          const { name } = args;
          const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
          if (hasExistingSessionTitle(sessionId, currentSession)) {
            return {
              content: [{
                type: 'text',
                text: 'Session already has a title; keeping the current name.',
              }],
            };
          }
          const sanitizedName = sanitizeSessionTitle(name);
          if (!sanitizedName) {
            console.warn('[Claude Service] Rejected vague session name:', sessionId, '→', name);
            return {
              content: [{
                type: 'text',
                text: `Session name "${name}" was too vague; keeping the current name.`,
              }],
            };
          }
          console.log('[Claude Service] Updating session name:', sessionId, '→', sanitizedName);

          // Store the auto name once. Future automatic title writers must not replace it.
          const storedName = rememberAutoSessionTitle(sessionId, sanitizedName, 'claude-tool');
          if (currentSession && storedName) {
            this.sessionStore.set(`sessions.${sessionId}`, {
              ...currentSession,
              name: storedName,
              aiGeneratedName: storedName,
              autoTitleGeneratedAt: new Date().toISOString(),
            });
          }
          this.onSessionNameChanged?.();

          return {
            content: [{
              type: 'text',
              text: `Session name updated to: "${sanitizedName}"`,
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to update session name: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentCreate tool - create DOCX, XLSX, or presentation files
    const documentCreateTool = tool(
      'DocumentCreate',
      'Create a new document (Word, Excel spreadsheet, or HTML slide presentation). Use this to generate office documents for reports, data exports, or presentations.',
      {
        type: z.string().describe('Document type - must be one of: "docx" for Word, "xlsx" for Excel, "slides" for reveal.js presentation'),
        path: z.string().describe('Full file path where to save the document'),
        title: z.string().optional().describe('Document title (used for DOCX title or presentation title)'),
        content: z.any().describe('Document content - structure depends on type. For docx: array of {type, text, level?, rows?, items?}. For xlsx: {sheets: [{name, data: 2D array}]}. For slides: {slides: [{title?, content, notes?, background?, transition?}]}'),
      },
      async (args) => {
        try {
          const { type, path: docPath, title, content } = args;
          console.log('[Claude Service] Creating document:', type, docPath);

          let resultPath: string;

          switch (type) {
            case 'docx':
              resultPath = await documentService.createDocx({
                path: docPath,
                title: title,
                content: content as any,
              });
              break;
            case 'xlsx':
              resultPath = await documentService.createXlsx({
                path: docPath,
                sheets: content?.sheets || [{ name: 'Sheet1', data: content?.data || [[]] }],
              });
              break;
            case 'slides':
              resultPath = await documentService.createPresentation({
                path: docPath,
                title: title || 'Presentation',
                theme: content?.theme,
                slides: content?.slides || [],
              });
              break;
            default:
              return {
                content: [{ type: 'text', text: `Unsupported document type: ${type}` }],
                isError: true,
              };
          }

          return {
            content: [{
              type: 'text',
              text: `Created ${type.toUpperCase()} document at: ${resultPath}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentCreate error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to create document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentRead tool - read document content
    const documentReadTool = tool(
      'DocumentRead',
      'Read the content of a document (Word or Excel). Returns the text content or spreadsheet data.',
      {
        path: z.string().describe('Full file path of the document to read'),
      },
      async (args) => {
        try {
          const { path: docPath } = args;
          console.log('[Claude Service] Reading document:', docPath);

          const docType = documentService.getDocumentType(docPath);

          switch (docType) {
            case 'xlsx': {
              const data = await documentService.readXlsx(docPath);
              let summary = '';
              for (const sheet of data.sheets) {
                summary += `\n## Sheet: ${sheet.name}\n`;
                if (sheet.data.length > 0) {
                  const maxRows = Math.min(sheet.data.length, 50);
                  for (let i = 0; i < maxRows; i++) {
                    const row = sheet.data[i];
                    if (row && row.length > 0) {
                      summary += row.map(cell => cell?.value ?? '').join('\t') + '\n';
                    }
                  }
                  if (sheet.data.length > maxRows) {
                    summary += `\n... and ${sheet.data.length - maxRows} more rows`;
                  }
                }
              }
              return {
                content: [{
                  type: 'text',
                  text: `Spreadsheet content from ${docPath}:${summary}`,
                }],
              };
            }
            case 'docx': {
              const rendered = await documentService.renderDocx(docPath);
              const textContent = rendered.html
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, '\n')
                .replace(/\n\s*\n/g, '\n\n')
                .trim()
                .slice(0, 10000);
              return {
                content: [{
                  type: 'text',
                  text: `Word document content from ${docPath}:\n\n${textContent}${textContent.length >= 10000 ? '\n...(truncated)' : ''}`,
                }],
              };
            }
            default:
              return {
                content: [{
                  type: 'text',
                  text: `Cannot read document type: ${docType}. Supported types: docx, xlsx`,
                }],
                isError: true,
              };
          }
        } catch (error) {
          console.error('[Claude Service] DocumentRead error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to read document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentEdit tool - edit Excel cells
    const documentEditTool = tool(
      'DocumentEdit',
      'Edit cells in an Excel spreadsheet. Can update values or formulas in specific cells.',
      {
        path: z.string().describe('Full file path of the Excel file to edit'),
        updates: z.array(z.object({
          sheet: z.string().or(z.number()).describe('Sheet name or index (0-based)'),
          cell: z.string().describe('Cell reference (e.g., "A1", "B2", "C10")'),
          value: z.string().or(z.number()).or(z.boolean()).or(z.null()).optional().describe('New cell value'),
          formula: z.string().optional().describe('Excel formula (without leading =)'),
        })).describe('Array of cell updates'),
      },
      async (args) => {
        try {
          const { path: docPath, updates } = args;
          console.log('[Claude Service] Editing document:', docPath, updates.length, 'updates');

          await documentService.updateXlsxCells(docPath, updates as any);

          return {
            content: [{
              type: 'text',
              text: `Updated ${updates.length} cell(s) in ${docPath}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentEdit error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to edit document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentPreview tool - preview document in browser panel
    const documentPreviewTool = tool(
      'DocumentPreview',
      'Preview a document (Word, Excel, or presentation) in the browser panel. Converts the document to HTML and displays it.',
      {
        path: z.string().describe('Full file path of the document to preview'),
      },
      async (args) => {
        try {
          const { path: docPath } = args;
          console.log('[Claude Service] Previewing document:', docPath);

          const content = await documentService.renderDocument(docPath);
          const previewPath = await documentService.saveForPreview(content, docPath);
          const fileUrl = `file://${previewPath}`;
          await browserService.navigate(sessionId, fileUrl);

          return {
            content: [{
              type: 'text',
              text: `Previewing ${docPath} in browser panel`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentPreview error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to preview document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // ============ MEMORY TOOLS ============
    // These tools allow the agent to persist knowledge across sessions

    // Get project path from session for memory operations
    const getFilesystemProjectPath = (): string | undefined => {
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      return session?.worktreePath || session?.repoPath || session?.sshConfig?.remoteWorkdir;
    };

    const getMemoryPath = (): string | undefined => {
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      return session ? this.getMemoryProjectPath(session, getFilesystemProjectPath()) : undefined;
    };

    const memoryRememberTool = tool(
      'remember',
      'Store an important fact, preference, or discovery for future reference. Use this when you learn something valuable that should persist across sessions. Categories: preference (user preferences), codebase (code structure facts), architecture (design decisions), path (useful file paths), context (current work context).',
      {
        category: z.string().describe('Category: preference, codebase, architecture, path, or context'),
        content: z.string().describe('The fact or information to remember'),
      },
      async (args) => {
        try {
          const { category, content } = args;
          const projectPath = getMemoryPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot remember: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Remembering fact:', category, content.substring(0, 50));

          const fact = await memoryService.remember(
            { category: category as MemoryCategory, content, source: 'agent' },
            projectPath
          );

          return {
            content: [{
              type: 'text',
              text: `Remembered [${fact.category}]: "${fact.content}" (id: ${fact.id})`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory remember error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to remember: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryRecallTool = tool(
      'recall',
      'Search your memories for relevant information. Use this before searching the codebase to check if you already know the answer.',
      {
        query: z.string().describe('What to search for in memories'),
        category: z.string().optional().describe('Optional filter: preference, codebase, architecture, path, or context'),
        limit: z.number().optional().describe('Maximum number of results (default: 10)'),
      },
      async (args) => {
        try {
          const { query, category, limit } = args;
          const projectPath = getMemoryPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot recall: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Recalling memories for query:', query);

          const facts = await memoryService.recall(query, projectPath, {
            category: category as MemoryCategory | undefined,
            limit,
          });

          if (facts.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No memories found matching: "${query}"`,
              }],
            };
          }

          const formattedFacts = facts.map(f =>
            `- [${f.category}] ${f.content} (id: ${f.id})`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `Found ${facts.length} memories:\n\n${formattedFacts}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory recall error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to recall: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryForgetTool = tool(
      'forget',
      'Remove a memory that is no longer accurate or relevant.',
      {
        factId: z.string().describe('ID of the memory to forget'),
      },
      async (args) => {
        try {
          const { factId } = args;
          const projectPath = getMemoryPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot forget: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Forgetting fact:', factId);

          const success = await memoryService.forget(factId, projectPath);

          if (success) {
            return {
              content: [{
                type: 'text',
                text: `Forgot memory with id: ${factId}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Memory not found with id: ${factId}`,
              }],
            };
          }
        } catch (error) {
          console.error('[Claude Service] Memory forget error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to forget: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryListTool = tool(
      'listMemories',
      'List all memories for the current project. Useful for reviewing what has been remembered.',
      {},
      async () => {
        try {
          const projectPath = getMemoryPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot list memories: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Listing all memories');

          const facts = await memoryService.listMemories(projectPath);

          if (facts.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No memories stored for this project yet.',
              }],
            };
          }

          // Group by category
          const byCategory: Record<string, typeof facts> = {};
          for (const fact of facts) {
            if (!byCategory[fact.category]) {
              byCategory[fact.category] = [];
            }
            byCategory[fact.category].push(fact);
          }

          let output = `Found ${facts.length} memories:\n\n`;
          for (const [category, categoryFacts] of Object.entries(byCategory)) {
            output += `### ${category}\n`;
            for (const f of categoryFacts) {
              output += `- ${f.content} (id: ${f.id})\n`;
            }
            output += '\n';
          }

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory list error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // Codex second opinion tool (OpenAI Codex SDK)
    const codexSecondOpinionTool = tool(
      'CodexSecondOpinion',
      'Get a second opinion from OpenAI Codex on a specific coding task. Codex will analyze the codebase and provide its perspective. Use this when you want to validate your approach, get an alternative solution, or need a fresh perspective on a problem.',
      {
        prompt: z.string().describe('The task or question to ask Codex about'),
        context: z.string().optional().describe('Additional context about what you are working on'),
      },
      async (args) => {
        try {
          const fullPrompt = args.context
            ? `Context: ${args.context}\n\nTask: ${args.prompt}`
            : args.prompt;

          const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
          const cwd = session?.sshConfig
            ? session.worktreePath || session.sshConfig.remoteWorkdir || getFilesystemProjectPath() || process.cwd()
            : getFilesystemProjectPath() || process.cwd();
          const result = await codexService.runForTool(sessionId, fullPrompt, cwd, session?.sshConfig);

          let responseText = result.summary;
          if (result.toolCalls.length > 0) {
            responseText += '\n\n--- Actions taken ---\n';
            for (const tc of result.toolCalls) {
              responseText += `[${tc.type}] ${tc.detail}\n`;
            }
          }
          if (result.reasoning) {
            responseText += `\n\n--- Reasoning ---\n${result.reasoning}`;
          }

          return {
            content: [{
              type: 'text' as const,
              text: responseText,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] CodexSecondOpinion error:', error);
          return {
            content: [{
              type: 'text' as const,
              text: `Failed to get Codex second opinion: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const mcpServer = createSdkMcpServer({
      name: 'claudette-browser',
      version: '2.0.0', // Upgraded to Stagehand-powered automation
      tools: [
        // ============ COMPUTER USE API TOOL ============
        // Claude-powered visual automation
        computerUseTool,          // Screenshot-based interaction (CLAUDE NATIVE)

        // ============ STAGEHAND AI-POWERED TOOLS ONLY ============
        // These use Stagehand's AI for browser automation
        browserActTool,           // Natural language actions (PRIMARY)
        browserObserveTool,       // Discover available actions
        browserAgentTool,         // Autonomous multi-step workflows
        browserExtractDataTool,   // AI-powered data extraction

        // Navigation (uses Stagehand)
        browserNavigateTool,

        // ============ NON-BROWSER TOOLS ============
        // Utility tools
        updateSessionNameTool,
        // Document tools
        documentCreateTool,
        documentReadTool,
        documentEditTool,
        documentPreviewTool,
        // Memory tools
        memoryRememberTool,
        memoryRecallTool,
        memoryForgetTool,
        memoryListTool,

        // ============ CODEX SECOND OPINION ============
        codexSecondOpinionTool,

        // ============ SELECTOR-BASED BROWSER TOOLS ============
        browserSnapshotTool,
        browserClickTool,
        browserTypeTool,
        browserExtractTool,
        browserGetInfoTool,
        browserGetDOMTool,
      ],
    });

    return mcpServer;
  }

  /**
   * Execute browser tools locally (used for SSH sessions where browser is local)
   */
  private async executeLocalBrowserTool(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<any> {
    console.log('[Claude Service] Executing browser tool locally:', toolName, input);

    // Ensure browser panel is open
    await this.ensureBrowserPanelOpen(sessionId);

    // Sync cookies from webview into Stagehand before any browser tool execution
    try {
      await stagehandService.syncCookiesFromWebview(sessionId);
    } catch (error) {
      console.warn('[Claude Service] Cookie sync failed (non-fatal):', error);
    }

    switch (toolName) {
      case 'BrowserNavigate': {
        const result = await stagehandService.navigate(input.url as string, sessionId);
        // Also sync the webview in case Stagehand is using its own browser
        if (result.success) {
          browserService.navigate(sessionId, input.url as string);
        }
        return result;
      }

      case 'BrowserAct':
        return stagehandService.act(input.instruction as string, sessionId);

      case 'BrowserObserve':
        return stagehandService.observe(input.instruction as string | undefined, sessionId);

      case 'BrowserAgent':
        return stagehandService.agent(input.task as string, sessionId);

      case 'BrowserExtractData':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return stagehandService.extract(input.instruction as string, input.schema as any);

      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  }

  /**
   * Execute chrome-devtools MCP tool calls locally against the CDP proxy.
   * Used for SSH sessions where the remote machine has no Chrome browser.
   */
  private async executeLocalChromeDevtool(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<any> {
    console.log('[Claude Service] Executing chrome-devtools tool locally:', toolName, input);

    // Ensure browser panel is open
    await this.ensureBrowserPanelOpen(sessionId);

    switch (toolName) {
      case 'list_pages':
      case 'listPages': {
        const targets = cdpProxyService.getTargets();
        return {
          pages: targets.map(t => ({
            id: t.id,
            url: t.url,
            title: t.title || '',
            type: t.type,
          })),
        };
      }

      case 'execute_javascript':
      case 'executeJavascript': {
        const expression = input.expression as string || input.javascript as string;
        if (!expression) throw new Error('expression or javascript parameter required');

        const targetSessionId = browserService.getFirstSessionId();
        if (!targetSessionId) throw new Error('No webview available');

        const wcId = browserService.getWebContentsId(targetSessionId);
        if (!wcId) throw new Error('No webview webContents available');

        const { webContents } = await import('electron');
        const wc = webContents.fromId(wcId);
        if (!wc) throw new Error('WebContents not found');

        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }
        const result = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return { result: result.result?.value, type: result.result?.type };
      }

      case 'navigate': {
        const url = input.url as string;
        if (!url) throw new Error('url parameter required');
        const result = await stagehandService.navigate(url, sessionId);
        if (result.success) {
          browserService.navigate(sessionId, url);
        }
        return result;
      }

      case 'screenshot': {
        const screenshot = await stagehandService.captureScreenshot();
        return { screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null };
      }

      case 'get_console_logs':
      case 'getConsoleLogs': {
        const logs = browserService.getConsoleLogs(sessionId);
        return { logs: logs || [] };
      }

      case 'get_cookies':
      case 'getCookies': {
        const { session: electronSession } = await import('electron');
        const targetSid = browserService.getFirstSessionId() || sessionId;
        const partitionName = browserService.getPartitionName(targetSid);
        const ses = electronSession.fromPartition(partitionName);
        const filter: Electron.CookiesGetFilter = input.url ? { url: input.url as string } : {};
        const cookies = await ses.cookies.get(filter);
        return { cookies };
      }

      case 'set_cookies':
      case 'setCookies': {
        const { session: electronSession } = await import('electron');
        const targetSid = browserService.getFirstSessionId() || sessionId;
        const partitionName = browserService.getPartitionName(targetSid);
        const ses = electronSession.fromPartition(partitionName);
        const cookiesToSet = (input.cookies as Array<{ url: string; name: string; value: string; domain?: string; path?: string }>) || [];
        for (const cookie of cookiesToSet) {
          await ses.cookies.set(cookie);
        }
        return { success: true, count: cookiesToSet.length };
      }

      default:
        throw new Error(`Unknown chrome-devtools tool: ${toolName}`);
    }
  }

  /**
   * Create a local in-process MCP server for chrome-devtools.
   * Used for SSH sessions so the agent can see the same tools without npx on the remote.
   */
  private getChromeDevtoolsMcpServer(sessionId: string) {
    return createSdkMcpServer({
      name: 'chrome-devtools',
      version: '1.0.0',
      tools: [
        tool('list_pages', 'List all available browser pages/tabs', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'list_pages', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('execute_javascript', 'Execute JavaScript in the browser page', {
          expression: z.string().describe('JavaScript expression to evaluate'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'execute_javascript', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('navigate', 'Navigate the browser to a URL', {
          url: z.string().describe('URL to navigate to'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'navigate', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('screenshot', 'Take a screenshot of the current page', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'screenshot', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('get_console_logs', 'Get console logs from the browser page', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'get_console_logs', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('get_cookies', 'Get cookies from the browser', {
          url: z.string().optional().describe('Optional URL to filter cookies'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'get_cookies', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('set_cookies', 'Set cookies in the browser', {
          cookies: z.array(z.object({
            url: z.string(),
            name: z.string(),
            value: z.string(),
            domain: z.string().optional(),
            path: z.string().optional(),
          })).describe('Array of cookies to set'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'set_cookies', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
      ],
    });
  }

  setApiKey(apiKey: string): void {
    this.store.set('anthropicApiKey', apiKey);
  }

  getGoogleApiKey(): string | undefined {
    return this.store.get('googleApiKey') as string | undefined;
  }

  setGoogleApiKey(apiKey: string): void {
    this.store.set('googleApiKey', apiKey);
  }

  // Handle question responses from the renderer
  handleQuestionResponse(response: QuestionResponse & { cancelled?: boolean }): void {
    const pending = this.pendingQuestions.get(response.requestId);
    if (pending) {
      if (response.cancelled) {
        pending.reject(new Error('User dismissed the question'));
      } else {
        pending.resolve(response.answers);
      }
      this.pendingQuestions.delete(response.requestId);
    }
  }

  // Handle permission responses from the renderer
  handlePermissionResponse(response: { requestId: string; approved: boolean; modifiedInput?: Record<string, unknown>; alwaysApprove?: boolean }): void {
    console.log('[Claude Service] handlePermissionResponse called:', response.requestId, 'approved:', response.approved, 'alwaysApprove:', response.alwaysApprove);
    const pending = this.pendingPermissions.get(response.requestId);
    if (pending) {
      console.log('[Claude Service] Found pending permission, resolving...');

      // If "always approve" was selected, save the permission pattern
      if (response.approved && response.alwaysApprove && pending.toolName === 'Bash') {
        this.savePermissionPattern(pending.sessionId, pending.toolName, pending.input);
      }

      pending.resolve({ approved: response.approved, modifiedInput: response.modifiedInput });
      this.pendingPermissions.delete(response.requestId);
    } else {
      console.warn('[Claude Service] No pending permission found for requestId:', response.requestId);
    }
  }

  // Save a permission pattern to the project's .claude/settings.local.json
  private async savePermissionPattern(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<void> {
    try {
      // Get the session to find the worktree path
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      if (!session) {
        console.warn('[Claude Service] Could not find session for permission pattern save:', sessionId);
        return;
      }

      const projectPath = session.worktreePath || session.repoPath;
      if (!projectPath) {
        console.warn('[Claude Service] No project path found for session:', sessionId);
        return;
      }

      // Extract the command pattern for Bash tool
      const command = input.command as string;
      if (!command) {
        console.warn('[Claude Service] No command found in Bash input');
        return;
      }

      // Extract wildcard pattern: "gh pr list main" -> "gh pr *"
      const parts = command.trim().split(/\s+/);
      let pattern: string;
      if (parts.length <= 2) {
        pattern = parts[0] + ' *';
      } else {
        pattern = parts.slice(0, 2).join(' ') + ' *';
      }

      // Read existing settings.local.json or create new one
      const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
      const claudeDir = path.dirname(settingsPath);

      // Ensure .claude directory exists
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      let settings: { allowedTools?: string[] } = {};
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      }

      // Initialize allowedTools array if not present
      if (!settings.allowedTools) {
        settings.allowedTools = [];
      }

      // Add the pattern if not already present (format: "Bash(pattern)")
      const permissionEntry = `Bash(${pattern})`;
      if (!settings.allowedTools.includes(permissionEntry)) {
        settings.allowedTools.push(permissionEntry);
        console.log('[Claude Service] Adding permission pattern:', permissionEntry);

        // Write back to settings.local.json
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('[Claude Service] Saved permission to:', settingsPath);
      } else {
        console.log('[Claude Service] Permission pattern already exists:', permissionEntry);
      }
    } catch (error) {
      console.error('[Claude Service] Failed to save permission pattern:', error);
    }
  }

  // Ask user for permission via the renderer
  private async askUserPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ approved: boolean; modifiedInput?: Record<string, unknown> }> {
    const requestId = `permission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingPermissions.set(requestId, { resolve, reject, sessionId, toolName, input });

      // Send permission request to renderer
      const request = {
        sessionId,
        requestId,
        toolName,
        toolInput: input,  // Use toolInput to match PermissionRequest type
      };
      if (this.sendInteractiveRendererEvent(sessionId, IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, request)) {
        console.log('[Claude Service] Sending permission request to renderer:', toolName, 'sessionId:', sessionId, 'requestId:', requestId, 'input:', JSON.stringify(input));
      } else {
        this.pendingPermissions.delete(requestId);
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds
      setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          reject(new Error('Permission response timeout'));
        }
      }, 5 * 60 * 1000); // 5 minute timeout
    });
  }

  private getAutoPlanningState(sessionId: string): AutoPlanningState | undefined {
    const value = this.sessionStore.get(`harnessState.${sessionId}.autoPlanning`) as AutoPlanningState | undefined;
    if (!value || (value.status !== 'interview' && value.status !== 'awaiting-approval')) return undefined;
    if (!value.originalRequest?.trim() || !value.model) return undefined;
    return value;
  }

  private persistAutoPlanningState(sessionId: string, state: AutoPlanningState): void {
    this.sessionStore.set(`harnessState.${sessionId}.autoPlanning`, state);
  }

  private clearAutoPlanningState(sessionId: string, reason: string): void {
    if (this.getAutoPlanningState(sessionId)) {
      console.log(`[Claude Service] Cleared Auto Build pre-flight state for ${sessionId.substring(0, 8)}: ${reason}`);
    }
    this.sessionStore.delete(`harnessState.${sessionId}.autoPlanning`);
  }

  private startAutoPlanningState(
    sessionId: string,
    originalRequest: string,
    model: string,
    gate: PlanningGateDecision,
  ): AutoPlanningState {
    const now = Date.now();
    const state: AutoPlanningState = {
      status: 'interview',
      originalRequest,
      model,
      confidence: gate.confidence,
      reason: gate.reason,
      changeKind: gate.changeKind,
      startedAt: now,
      updatedAt: now,
      questionCount: 0,
      scopeChoiceConfirmed: false,
    };
    this.persistAutoPlanningState(sessionId, state);
    analyticsService.recordAutoPlanningEvent({
      sessionId,
      timestamp: now,
      outcome: 'started',
      plannerModel: model,
      changeKind: gate.changeKind,
      confidence: gate.confidence,
      questionCount: 0,
    });
    console.log(
      `[Claude Service] Started Auto Build 80/20 scope choice for ${sessionId.substring(0, 8)} ` +
      `with ${model} (${Math.round(gate.confidence * 100)}%: ${gate.changeKind})`,
    );
    return state;
  }

  private updateAutoPlanningState(
    sessionId: string,
    updates: Partial<AutoPlanningState>,
  ): AutoPlanningState | undefined {
    const state = this.getAutoPlanningState(sessionId);
    if (!state) return undefined;
    const updated: AutoPlanningState = {
      ...state,
      ...updates,
      updatedAt: Date.now(),
    };
    this.persistAutoPlanningState(sessionId, updated);
    return updated;
  }

  private isAutoPlanningBypass(message: string): boolean {
    return /^(?:\/build-now|build now anyway)(?:\s+|$)/i.test(message.trim());
  }

  private isAutoPlanningFirstSliceQuestion(questions: unknown[]): boolean {
    return questions.some((question) => {
      if (!question || typeof question !== 'object') return false;
      const candidate = question as { question?: unknown; options?: unknown };
      const text = typeof candidate.question === 'string' ? candidate.question.trim() : '';
      const optionCount = Array.isArray(candidate.options) ? candidate.options.length : 0;
      if (!text || optionCount < 2 || optionCount > 3) return false;

      return /(?:80\/20|first\s+(?:slice|step|feature)|highest[-\s]impact|narrowest\s+(?:wedge|slice)|start\s+with|do\s+first|ship\s+first|choose\s+one)/i.test(text);
    });
  }

  private getAutoPlanningExitBlocker(
    state: AutoPlanningState,
    planContent?: string,
  ): string | undefined {
    const completedTurns = state.questionCount || 0;
    if (completedTurns < AUTO_PLANNING_MIN_DISCOVERY_TURNS) {
      return 'Auto Build 80/20 choice incomplete: present 2-3 plausible first slices, recommend one, and ask the user to choose in a single AskUserQuestion turn.';
    }
    if (!state.scopeChoiceConfirmed) {
      return 'Auto Build 80/20 choice incomplete: present 2-3 plausible first slices in AskUserQuestion and make the user choose the single highest-impact slice to build first.';
    }
    if (planContent === undefined) return undefined;

    if (!/^#{1,3}\s+80\/20 First Slice\s*$/im.test(planContent)
      || !/^#{1,3}\s+Smallest Implementation\s*$/im.test(planContent)
      || !/^#{1,3}\s+Not Now\s*$/im.test(planContent)
      || !/^#{1,3}\s+Execution Handoff\s*$/im.test(planContent)) {
      return 'Auto Build plan is not focused enough: use the four required 80/20 handoff sections, with exactly one user-selected feature in the first slice.';
    }

    const wordCount = planContent.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > AUTO_PLANNING_MAX_PLAN_WORDS) {
      return `Auto Build plan is too broad (${wordCount} words). Reduce it below ${AUTO_PLANNING_MAX_PLAN_WORDS} words and plan only the one selected first slice; move all follow-on work to Not Now.`;
    }

    return undefined;
  }

  private buildAutoPlanningSystemContext(state: AutoPlanningState, firstTurn: boolean): string {
    const completedTurns = state.questionCount || 0;
    let bundledPlaybook = '';
    try {
      bundledPlaybook = eightyTwentyService.loadPlaybook().systemContext;
    } catch (error) {
      console.error('[Claude Service] Failed to load bundled 80/20 planning skill:', error);
    }
    return `<auto_build_preflight_spec>
Auto Build has paused implementation for one lightweight 80/20 scope decision.

Original request:
${state.originalRequest}

${firstTurn
    ? 'Follow the embedded Build 80/20 playbook. Present 2-3 credible first slices with one recommendation, then end this turn with exactly one AskUserQuestion choice. Do not run a discovery interview first.'
    : 'The user has answered the 80/20 choice. Stop interviewing, preserve that selection, and produce the compact execution handoff now.'}

Choice progress: ${completedTurns}/${AUTO_PLANNING_MIN_DISCOVERY_TURNS}. First slice confirmed: ${state.scopeChoiceConfirmed ? 'yes' : 'no'}.

Requirements:
- Stay in plan mode. Do not edit implementation files, run mutating commands, or start build/refine helpers.
- Make one user decision, not a multi-round interview: the first question must itself offer 2-3 meaningfully different narrow slices and recommend the highest-impact option.
- Once the user answers, do not ask another planning question unless their answer explicitly rejects every option without choosing or correcting one.
- Optimize impact divided by effort and learning time. The chosen slice should deliver one observable user outcome through the thinnest viable vertical path and fit in one small implementation/PR. Do not propose a platform, generalized framework, multi-workstream roadmap, or exhaustive cleanup unless that one slice literally cannot work without it.
- Treat every other attractive feature, hardening pass, migration, automation, and follow-up as "Not Now." Do not schedule or task them in this plan.
- Keep the final approval document under ${AUTO_PLANNING_MAX_PLAN_WORDS} words and use exactly these top-level sections:
  1. "80/20 First Slice" — name exactly one user-selected feature, why it wins, and one success signal.
  2. "Smallest Implementation" — no more than three implementation steps for only that slice.
  3. "Not Now" — everything deliberately deferred, without implementation tasks.
  4. "Execution Handoff" — only the minimal touchpoints, main risk, and focused verification needed for the first slice.
- Build's ExitPlanMode/Plan Panel is the single final approval gate. Do not ask for a second final approval inside the skill; call ExitPlanMode with the complete reviewed document.
- Never invoke office-hours, secondary strategy reviews, or a separate /spec workflow from this automatic gate.
</auto_build_preflight_spec>

${bundledPlaybook}`;
  }

  private isAutoPlanningArtifactPath(value: unknown): boolean {
    if (typeof value !== 'string' || !value.trim()) return false;
    const normalized = value.replace(/\\/g, '/');
    return normalized.startsWith('/tmp/')
      || normalized === '/tmp'
      || normalized.startsWith('~/.claude/plans/')
      || normalized.startsWith('$HOME/.claude/plans/')
      || normalized.includes('/.claude/plans/');
  }

  private isAutoPlanningSafeToolUse(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
      const candidatePath = input.file_path || input.path || input.notebook_path;
      return this.isAutoPlanningArtifactPath(candidatePath);
    }

    if (toolName !== 'Bash') return false;
    const command = typeof input.command === 'string'
      ? input.command
      : typeof input.cmd === 'string'
        ? input.cmd
        : '';
    if (!command.trim()) return false;

    const forbidden = [
      /\bapply_patch\b/i,
      /\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|merge|rebase|cherry-pick|apply|am|tag)\b/i,
      /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|publish)\b/i,
      /\b(?:sed|perl)\s+-i\b/i,
      /\b(?:truncate|chmod|chown)\b/i,
      /\b(?:python(?:3)?|node|ruby|php)\b/i,
      /\b(?:patch|dd|install|make|cmake)\b/i,
    ];
    if (forbidden.some((pattern) => pattern.test(command))) return false;

    const mutationCommand = command
      .replace(/\d*>{1,2}\s*\/dev\/null/g, '')
      .replace(/\d*>\s*&\d/g, '');
    const genericMutationPattern = /\b(?:mkdir|touch|rm|rmdir|cp|mv|tee)\b|(?:^|[^<])>{1,2}(?!=)/i;
    if (!genericMutationPattern.test(mutationCommand)) return true;

    // The lightweight 80/20 pass may only maintain the normal Claude plan file
    // or temporary prompt state. It has no separate workflow artifact tree.
    const safeRootPattern = /(?:~|\$HOME|\/[^ \n"'`]+)?\/?\.claude\/plans(?:\/|$)|\/tmp(?:\/|$)/;
    const projectMutationPattern = /(?:^|[\s"'`])(?:\.\/|src\/|app\/|packages?\/|scripts?\/|resources?\/|package(?:-lock)?\.json|forge\.config|tsconfig|README|CLAUDE\.md|AGENTS\.md)/i;
    const mutationSegments = mutationCommand
      .split(/(?:&&|\|\||;|\n)/)
      .filter((segment) => genericMutationPattern.test(segment));
    return mutationSegments.length > 0 && mutationSegments.every((segment) => (
      safeRootPattern.test(segment) && !projectMutationPattern.test(segment)
    ));
  }

  private rememberApprovedPlan(
    sessionId: string,
    planContent: string | undefined,
    planFilePath: string | undefined,
    source: 'live' | 'late',
  ): void {
    const content = (planContent || '').trim();
    if (!content) return;

    this.sessionApprovedPlanFiles.set(sessionId, {
      content,
      filePath: planFilePath || '',
      pendingExecution: true,
    });
    this.sessionStore.set(`harnessState.${sessionId}.approvedPlan`, {
      content,
      filePath: planFilePath || '',
      pendingExecution: true,
      updatedAt: new Date().toISOString(),
    });
    this.sessionPlanFiles.delete(sessionId);
    console.log(
      `[Claude Service] Recorded ${source} approved plan for handoff context: ` +
      `${sessionId.substring(0, 8)} (${content.length} chars${planFilePath ? `, ${planFilePath}` : ''})`
    );
  }

  private isApprovedPlanExecutionPending(sessionId: string): boolean {
    const plan = this.sessionApprovedPlanFiles.get(sessionId)
      || this.sessionStore.get(`harnessState.${sessionId}.approvedPlan`) as ApprovedPlanArtifact | undefined;
    return Boolean(plan?.content?.trim() && plan.pendingExecution !== false);
  }

  private markApprovedPlanExecutionCompleted(sessionId: string): void {
    const plan = this.sessionApprovedPlanFiles.get(sessionId)
      || this.sessionStore.get(`harnessState.${sessionId}.approvedPlan`) as ApprovedPlanArtifact | undefined;
    if (!plan?.content?.trim()) return;
    const updated: ApprovedPlanArtifact = {
      ...plan,
      pendingExecution: false,
      updatedAt: new Date().toISOString(),
    };
    this.sessionApprovedPlanFiles.set(sessionId, updated);
    this.sessionStore.set(`harnessState.${sessionId}.approvedPlan`, updated);
    console.log(`[Claude Service] Approved plan execution lead completed for ${sessionId.substring(0, 8)}`);
  }

  private isApprovedPlanExecutionRequest(message: string): boolean {
    return /\b(?:go ahead|go do it|do it|fire it up|execute(?: the)? (?:approved )?plan|implement(?: the)? (?:approved )?plan|proceed|ship it|pr this)\b/i.test(message);
  }

  private scheduleAutoPlanExecutionHandoff(sessionId: string, retirePlanningSession = false): void {
    if (this.pendingAutoPlanExecutionHandoffs.has(sessionId)) return;
    this.pendingAutoPlanExecutionHandoffs.set(sessionId, {
      approvedAt: Date.now(),
      retirePlanningSession,
    });

    // The permission response must reach Claude Code before interrupt() is
    // sent, otherwise the pending ExitPlanMode control request can remain
    // unresolved. The next macrotask gives the SDK time to write that response.
    setTimeout(() => {
      const query = this.activeQueryObjects.get(sessionId);
      if (query) {
        console.log(`[Claude Service] Plan approved — interrupting planning harness for Auto execution handoff (${sessionId.substring(0, 8)})`);
        void query.interrupt().catch((error) => {
          console.warn('[Claude Service] Could not interrupt approved Auto planning query:', error);
        });
        return;
      }

      // After an app restart the SDK Query object is gone, but the detached
      // Claude CLI is still connected through its recovered stdin socket. Use
      // the same stream-json interrupt request that Query.interrupt() sends so
      // approval remains an atomic planner -> executor boundary after SSH
      // reconnects too.
      const recoveredInput = this.recoveredQueryInputs.get(sessionId);
      if (!recoveredInput) {
        console.warn(`[Claude Service] Approved Auto plan has no live or recovered query to interrupt for ${sessionId.substring(0, 8)}; execution will start on the next Auto turn`);
        return;
      }

      const requestId = `build-plan-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      recoveredInput.write(`${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      })}\n`, (error?: Error | null) => {
        if (error) {
          console.warn('[Claude Service] Could not interrupt recovered Auto planning query:', error);
          return;
        }
        console.log(`[Claude Service] Plan approved — interrupted recovered planning harness for Auto execution handoff (${sessionId.substring(0, 8)})`);
      });
    }, 0);
  }

  private async consumeAutoPlanExecutionHandoff(
    sessionId: string,
    abortController: AbortController,
  ): Promise<boolean> {
    const handoff = this.pendingAutoPlanExecutionHandoffs.get(sessionId);
    if (!handoff) return false;

    this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
    console.log(
      `[Claude Service] Planning harness stopped ${Date.now() - handoff.approvedAt}ms after approval; re-entering Auto Build for execution`
    );

    if (handoff.retirePlanningSession) {
      // Approval is a real agent boundary, not merely a model parameter
      // change on the planning transcript. Retire Claude's native planning
      // thread even when the configured execution model is another Claude.
      this.clearSdkSessionId(sessionId);
      // A persistent Codex thread can also contain an earlier PLAN-mode
      // preamble. The execution model must start from the approved artifact,
      // not resume a native thread whose first instruction still forbids edits.
      codexService.clearThreadId(sessionId);
      this.sessionContextPercentage.delete(sessionId);
      this.sessionStore.delete(`contextUsage.${sessionId}`);
      console.log(`[Claude Service] Retired native planning session before Auto Build execution for ${sessionId.substring(0, 8)}`);
    }

    // Ask the interrupted iterator to close, but never let an unresponsive
    // planning runtime block the execution handoff indefinitely.
    const planningQuery = this.activeQueryObjects.get(sessionId);
    if (planningQuery) {
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          planningQuery.return(undefined).then(() => undefined),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(resolve, 2_000);
          }),
        ]);
      } catch (error) {
        console.warn('[Claude Service] Could not close interrupted planning query cleanly:', error);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
    }

    abortController.abort();
    if (this.clearActiveQuery(sessionId, abortController)) {
      powerService.sessionEnded();
    }
    this.backgroundListeners.get(sessionId)?.abort();
    this.backgroundListeners.delete(sessionId);
    return true;
  }

  private applyPlanApprovalExecutionMode(sessionId: string): void {
    this.sessionPermissionModes.set(sessionId, 'bypassPermissions');
    this.prePlanPermissionModes.delete(sessionId);
    this.autoBuildForcedPlanSessions.delete(sessionId);
    this.persistSessionPermissionMode(sessionId, 'bypassPermissions');

    this.sendInteractiveRendererEvent(sessionId, IPC_CHANNELS.CLAUDE_PERMISSION_MODE_CHANGED, {
        sessionId,
        mode: 'bypassPermissions',
    });
  }

  // Handle plan approval responses from the renderer
  handlePlanApprovalResponse(response: PlanApprovalResponse): void {
    const pending = this.pendingPlanApprovals.get(response.requestId);
    const record = this.planApprovalRecords.get(response.requestId);
    const sessionId = pending?.sessionId || response.sessionId || record?.sessionId;

    if (!sessionId) {
      console.warn('[Claude Service] Ignoring plan approval response without session context:', response.requestId);
      return;
    }

    const activePlanningState = this.getAutoPlanningState(sessionId);
    if (response.approved && activePlanningState) {
      const planContent = record?.planContent || response.planContent;
      const approvalBlocker = planContent
        ? this.getAutoPlanningExitBlocker(activePlanningState, planContent)
        : 'Auto Build could not validate this plan. Continue the interview and submit the focused 80/20 plan again.';
      if (approvalBlocker) {
        console.warn(`[Claude Service] Ignoring invalid Auto Build plan approval: ${approvalBlocker}`);
        this.lastPlanFeedback.set(sessionId, approvalBlocker);
        this.updateAutoPlanningState(sessionId, { status: 'interview' });
        if (pending) {
          pending.resolve(false);
          this.pendingPlanApprovals.delete(response.requestId);
        }
        this.planApprovalRecords.delete(response.requestId);
        return;
      }
    }

    if (!response.approved && response.feedback) {
      this.lastPlanFeedback.set(sessionId, response.feedback);
    }

    if (response.approved) {
      const planContent = record?.planContent || response.planContent;
      const planFilePath = record?.planFilePath || response.planFilePath;
      this.rememberApprovedPlan(sessionId, planContent, planFilePath, pending ? 'live' : 'late');
      const planningState = this.getAutoPlanningState(sessionId);
      if (planningState) {
        analyticsService.recordAutoPlanningEvent({
          sessionId,
          timestamp: Date.now(),
          outcome: 'approved',
          plannerModel: planningState.model,
          changeKind: planningState.changeKind,
          confidence: planningState.confidence,
          durationMs: Date.now() - planningState.startedAt,
          questionCount: planningState.questionCount,
        });
      }
      this.clearAutoPlanningState(sessionId, 'plan approved');
      if (!pending) {
        this.clearSdkSessionId(sessionId);
        this.applyPlanApprovalExecutionMode(sessionId);
        console.log('[Claude Service] Late plan approval recorded for next harness handoff:', response.requestId);
      }
    } else {
      const planningState = this.getAutoPlanningState(sessionId);
      if (planningState) {
        analyticsService.recordAutoPlanningEvent({
          sessionId,
          timestamp: Date.now(),
          outcome: 'rejected',
          plannerModel: planningState.model,
          changeKind: planningState.changeKind,
          confidence: planningState.confidence,
          durationMs: Date.now() - planningState.startedAt,
          questionCount: planningState.questionCount,
        });
      }
      this.updateAutoPlanningState(sessionId, { status: 'interview' });
    }

    if (pending) {
      pending.resolve(response.approved);
      this.pendingPlanApprovals.delete(response.requestId);
    }

    this.planApprovalRecords.delete(response.requestId);
  }

  // Ask user to approve a plan via the renderer
  private async askPlanApproval(
    sessionId: string,
    planContent: string,
    planFilePath?: string,
    allowedPrompts?: Array<{ tool: string; prompt: string }>
  ): Promise<boolean> {
    const requestId = `plan-approval-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingPlanApprovals.set(requestId, { resolve, reject, sessionId });
      this.planApprovalRecords.set(requestId, {
        sessionId,
        planContent,
        planFilePath,
      });

      // Send plan approval request to renderer
      const request: PlanApprovalRequest = {
        sessionId,
        requestId,
        planContent,
        planFilePath,
        allowedPrompts,
      };
      if (this.sendInteractiveRendererEvent(sessionId, IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_REQUEST, request)) {
        console.log('[Claude Service] Sent plan approval request to originating renderer:', sessionId, requestId);
      } else {
        this.pendingPlanApprovals.delete(requestId);
        this.planApprovalRecords.delete(requestId);
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds (10 minute timeout for plans)
      setTimeout(() => {
        if (this.pendingPlanApprovals.has(requestId)) {
          this.pendingPlanApprovals.delete(requestId);
          reject(new Error('Plan approval response timeout'));
        }
      }, 10 * 60 * 1000); // 10 minute timeout
    });
  }

  // Ask user a question via the renderer
  private async askUserQuestion(sessionId: string, questions: unknown[]): Promise<Record<string, string>> {
    const requestId = `question-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingQuestions.set(requestId, { sessionId, resolve, reject });

      // Send question request to renderer
      const request: QuestionRequest = {
        sessionId,
        requestId,
        questions: questions as any, // SDK types match our Question type
      };
      if (this.sendInteractiveRendererEvent(sessionId, IPC_CHANNELS.CLAUDE_QUESTION_REQUEST, request)) {
        console.log('[Claude Service] Sent question request to originating renderer:', sessionId, requestId, 'questions:', questions.length);
      } else {
        this.pendingQuestions.delete(requestId);
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds
      setTimeout(() => {
        if (this.pendingQuestions.has(requestId)) {
          this.pendingQuestions.delete(requestId);
          reject(new Error('Question response timeout'));
        }
      }, 5 * 60 * 1000); // 5 minute timeout
    });
  }

  private async handleAskUserQuestionTool(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<ClaudeToolPermissionDecision> {
    try {
      const planningState = this.getAutoPlanningState(sessionId);
      const questions = Array.isArray(input.questions) ? input.questions : [];
      if (planningState && questions.length !== 1) {
        return {
          behavior: 'deny',
          message: 'The Auto Build 80/20 gate requires one first-slice choice question. Offer 2-3 narrow options with one recommendation, then wait for the answer.',
        };
      }

      const confirmsFirstSlice = planningState
        ? this.isAutoPlanningFirstSliceQuestion(questions)
        : false;
      const answers = await this.askUserQuestion(sessionId, questions);
      const hasAnswer = Object.values(answers).some((answer) => answer.trim().length > 0);
      const currentPlanningState = this.getAutoPlanningState(sessionId);
      if (currentPlanningState && hasAnswer) {
        const updatedState = this.updateAutoPlanningState(sessionId, {
          status: 'interview',
          questionCount: (currentPlanningState.questionCount || 0) + 1,
          scopeChoiceConfirmed: currentPlanningState.scopeChoiceConfirmed || confirmsFirstSlice,
        });
        console.log(
          `[Claude Service] Auto Build 80/20 choice progress for ${sessionId.substring(0, 8)}: `
          + `${updatedState?.questionCount || 0}/${AUTO_PLANNING_MIN_DISCOVERY_TURNS}, `
          + `first-slice=${updatedState?.scopeChoiceConfirmed ? 'confirmed' : 'pending'}`,
        );
      }

      return {
        behavior: 'allow',
        updatedInput: { ...input, answers },
      };
    } catch (error) {
      console.error('[Claude Service] Error asking user question:', error);
      return {
        behavior: 'deny',
        message: error instanceof Error ? error.message : 'Failed to get user response',
      };
    }
  }

  /** Reconstruct the SDK canUseTool contract for a detached Claude process.
   * The SDK callback lived in the renderer process that disconnected, while
   * the remote CLI keeps waiting on its stream-json control request. */
  private async handleRecoveredCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ClaudeToolPermissionDecision> {
    const normalizedToolName = toolName.toLowerCase().replace(/[_-]/g, '');
    if ((normalizedToolName === 'askuserquestion' || normalizedToolName === 'askquestion') && input.questions) {
      return this.handleAskUserQuestionTool(sessionId, input);
    }

    if (normalizedToolName === 'exitplanmode') {
      try {
        const planningState = this.getAutoPlanningState(sessionId);
        if (planningState) {
          const interviewBlocker = this.getAutoPlanningExitBlocker(planningState);
          if (interviewBlocker) {
            this.updateAutoPlanningState(sessionId, { status: 'interview' });
            return { behavior: 'deny', message: interviewBlocker };
          }
        }

        const cachedPlan = this.sessionPlanFiles.get(sessionId);
        const planContent = typeof input.plan === 'string' && input.plan.trim()
          ? input.plan
          : cachedPlan?.content || 'The assistant wants to leave plan mode and begin implementation.';
        const planFilePath = cachedPlan?.filePath || '';
        if (planningState) {
          const planBlocker = this.getAutoPlanningExitBlocker(planningState, planContent);
          if (planBlocker) {
            this.updateAutoPlanningState(sessionId, { status: 'interview' });
            return { behavior: 'deny', message: planBlocker };
          }
        }

        this.updateAutoPlanningState(sessionId, {
          status: 'awaiting-approval',
          planFilePath: planFilePath || undefined,
        });
        const approved = await this.askPlanApproval(
          sessionId,
          planContent,
          planFilePath,
          input.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined,
        );
        if (!approved) {
          this.updateAutoPlanningState(sessionId, { status: 'interview' });
          return {
            behavior: 'deny',
            message: this.lastPlanFeedback.get(sessionId)
              ? `Plan was not approved. User feedback: ${this.lastPlanFeedback.get(sessionId)}`
              : 'Plan was not approved by the user. Please revise it based on user feedback.',
          };
        }

        this.rememberApprovedPlan(sessionId, planContent, planFilePath, 'late');
        this.applyPlanApprovalExecutionMode(sessionId);
        if (planningState) {
          this.scheduleAutoPlanExecutionHandoff(sessionId, true);
        }
        return { behavior: 'allow', updatedInput: input };
      } catch (error) {
        if (this.getAutoPlanningState(sessionId)) {
          this.updateAutoPlanningState(sessionId, { status: 'interview' });
        }
        return {
          behavior: 'deny',
          message: error instanceof Error ? error.message : 'Failed to get plan approval',
        };
      }
    }

    const session = (this.sessionStore.get(`sessions.${sessionId}`) as (Session & { permissionMode?: string }) | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as (Session & { permissionMode?: string }) | undefined);
    const currentPermissionMode = this.getSessionPermissionMode(sessionId)
      || session?.permissionMode
      || (session?.autoBuildForcedPlanMode ? 'plan' : 'acceptEdits');
    const modifyingTools = ['Write', 'Edit', 'Bash', 'NotebookEdit', 'MultiEdit', 'TodoWrite'];

    if (currentPermissionMode === 'plan' && modifyingTools.includes(toolName)) {
      if (this.getAutoPlanningState(sessionId) && this.isAutoPlanningSafeToolUse(toolName, input)) {
        return { behavior: 'allow', updatedInput: input };
      }
      return {
        behavior: 'deny',
        message: 'In plan mode, write operations are not permitted. Please exit plan mode to make changes.',
      };
    }
    if (currentPermissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }

    const shouldAsk = currentPermissionMode === 'default'
      ? modifyingTools.includes(toolName)
      : currentPermissionMode === 'acceptEdits' && toolName === 'Bash';
    if (shouldAsk) {
      try {
        const response = await this.askUserPermission(sessionId, toolName, input);
        return response.approved
          ? { behavior: 'allow', updatedInput: response.modifiedInput || input }
          : { behavior: 'deny', message: 'User denied permission for this tool' };
      } catch (error) {
        return {
          behavior: 'deny',
          message: error instanceof Error ? error.message : 'Failed to get permission response',
        };
      }
    }

    return { behavior: 'allow', updatedInput: input };
  }

  /**
   * Ephemeral side question (/btw) — makes a direct Anthropic API call with
   * conversation context but does NOT add anything to the session history.
   * Streams response chunks back via IPC.
   */
  // Remote control child processes — one per session
  private rcProcesses = new Map<string, import('child_process').ChildProcess>();

  /**
   * Start a remote control session by spawning `claude remote-control` as a child process.
   * Parses the URL from stdout and emits CLAUDE_RC_STARTED.
   */
  async startRemoteControl(sessionId: string): Promise<void> {
    // If already running, just re-emit the URL
    if (this.rcProcesses.has(sessionId)) {
      console.log('[Claude Service] Remote control already active for session:', sessionId);
      return;
    }

    // Check both manual sessions and discovered sessions (discovered sessions may not be in sessions.*)
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);
    const sessionName = session?.name || 'Build';
    console.log('[Claude Service] startRemoteControl for:', sessionId, 'found:', !!session, 'ssh:', !!session?.sshConfig);

    // For SSH sessions, run remote-control on the remote machine via SSH
    if (session?.sshConfig) {
      await this.startRemoteControlSSH(sessionId, session.sshConfig, sessionName);
      return;
    }

    const cwd = session?.repoPath || process.cwd();
    const claudeCli = findUsableLocalExecutable(['claude'], [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    ]);
    if (!claudeCli) {
      const message = 'Claude Code CLI is not installed or is blocked by macOS quarantine.';
      console.error('[Claude Service] Cannot start remote control:', message);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
      throw new Error(message);
    }

    // Remote control is now a standalone subcommand (no longer combinable with --resume).
    // It creates a persistent server that accepts sessions from claude.ai/code.
    console.log('[Claude Service] Starting remote-control server for session:', sessionId, 'name:', sessionName);
    const child = spawn(claudeCli, ['remote-control', '--name', sessionName], {
      cwd,
      shell: false,
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rcProcesses.set(sessionId, child);

    // Auto-confirm the "Enable Remote Control? (y/n)" prompt
    child.stdin?.write('y\n');

    this.attachRcOutputHandlers(sessionId, child);
  }

  private attachRcOutputHandlers(sessionId: string, child: import('child_process').ChildProcess): void {
    let outputBuffer = '';
    let urlEmitted = false;

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;
      console.log('[Claude Service] RC stdout:', text.replace(ANSI_M_CODE_RE, '').trim());

      // Look for the URL in the output (strip ANSI escape sequences first)
      if (!urlEmitted) {
        const cleanBuffer = outputBuffer.replace(OSC8_LINK_RE, '').replace(ANSI_M_CODE_RE, '');
        const urlMatch = cleanBuffer.match(/https:\/\/claude\.ai\/code\?environment=[^\s]+/)
          || cleanBuffer.match(/https:\/\/claude\.ai\/code\?bridge=[^\s]+/)
          || cleanBuffer.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
        if (urlMatch) {
          urlEmitted = true;
          const url = urlMatch[0];
          console.log('[Claude Service] Remote control URL detected:', url);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STARTED, {
            sessionId,
            url,
          });
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.log('[Claude Service] RC stderr:', data.toString().trim());
    });

    child.on('close', (code) => {
      console.log('[Claude Service] Remote control process exited with code:', code);
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    });

    child.on('error', (err) => {
      console.error('[Claude Service] Remote control process error:', err);
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    });
  }

  /**
   * Start remote control on an SSH session by running `claude remote-control` on the remote machine.
   */
  private async startRemoteControlSSH(sessionId: string, sshConfig: import('../../shared/types').SSHConfig, sessionName: string): Promise<void> {
    try {
      const client = await sshService['getConnection'](sessionId, sshConfig);
      const claudePaths = `/home/${sshConfig.username}/.local/bin:/home/${sshConfig.username}/bin:/usr/local/bin:/usr/bin`;

      // Remote control is now a standalone subcommand (no longer combinable with --resume).
      console.log('[Claude Service] SSH RC: starting remote-control server for:', sessionName);
      const command = `export PATH="${claudePaths}:$PATH" && cd "${sshConfig.remoteWorkdir}" && echo y | claude remote-control --name "${sessionName}"`;

      console.log('[Claude Service] Starting remote control on SSH:', command);

      // Allocate a PTY so `claude remote-control` (an interactive CLI) flushes
      // its stdout promptly. Without pty:true the ssh2 channel's `data` event
      // never fires for line-buffered, TTY-aware CLIs — the output stays
      // stuck in the remote process's stdout buffer. This was the silent
      // stall: command launched, log line "Starting remote control on SSH"
      // printed, then nothing ever came back.
      client.exec(command, { pty: true }, (err, channel) => {
        if (err) {
          console.error('[Claude Service] SSH RC exec error:', err);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
          return;
        }

        console.log('[Claude Service] SSH RC channel opened with PTY for session:', sessionId);

        // Store the channel so we can kill it later (wrap as a fake ChildProcess)
        const fakeProcess = {
          kill: () => { channel.close(); },
          stdout: channel,
          stderr: channel.stderr,
          stdin: channel,
        } as any;
        this.rcProcesses.set(sessionId, fakeProcess);

        let outputBuffer = '';
        let urlEmitted = false;

        channel.on('data', (data: Buffer) => {
          const text = data.toString();
          outputBuffer += text;
          const clean = text.replace(ANSI_M_CODE_RE, '').replace(/\[\d+[A-Z]/g, '').trim();
          if (clean) console.log('[Claude Service] SSH RC stdout:', clean);

          if (!urlEmitted) {
            const cleanBuffer = outputBuffer.replace(OSC8_LINK_RE, '').replace(ANSI_M_CODE_RE, '');
            const urlMatch = cleanBuffer.match(/https:\/\/claude\.ai\/code\?environment=[^\s]+/)
              || cleanBuffer.match(/https:\/\/claude\.ai\/code\?bridge=[^\s]+/)
              || cleanBuffer.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
            if (urlMatch) {
              urlEmitted = true;
              console.log('[Claude Service] SSH Remote control URL detected:', urlMatch[0]);
              this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STARTED, {
                sessionId,
                url: urlMatch[0],
              });
            }
          }
        });

        channel.stderr.on('data', (data: Buffer) => {
          console.log('[Claude Service] SSH RC stderr:', data.toString().trim());
        });

        channel.on('close', () => {
          console.log('[Claude Service] SSH Remote control channel closed');
          this.rcProcesses.delete(sessionId);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
        });
      });
    } catch (error) {
      console.error('[Claude Service] Failed to start SSH remote control:', error);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    }
  }

  /**
   * Stop a running remote control session.
   */
  stopRemoteControl(sessionId: string): void {
    const child = this.rcProcesses.get(sessionId);
    if (child) {
      child.kill('SIGTERM');
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    }
  }

  async askBtw(sessionId: string, question: string): Promise<void> {
    // Preferred path: the session has a live SDK Query — use the native
    // `askSideQuestion` control so the side answer runs against the running
    // claude's in-memory context. No duplicate API call, no history rebuild,
    // no role-sanitising.
    const liveQuery = this.activeQueryObjects.get(sessionId);
    const liveQueryAny = liveQuery as unknown as { askSideQuestion?: (q: string) => Promise<{ response: string; synthetic: boolean } | null> } | undefined;
    if (liveQueryAny?.askSideQuestion) {
      try {
        console.log('[Claude Service] /btw via SDK askSideQuestion (live query)');
        const answer = await liveQueryAny.askSideQuestion(question);
        const answerText = answer?.response || '';
        if (answerText) {
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
            sessionId,
            content: answerText,
            done: false,
          });
        }
        this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
          sessionId,
          content: '',
          done: true,
        });
        return;
      } catch (err) {
        console.warn('[Claude Service] askSideQuestion failed, falling back to CLI:', err);
      }
    }

    // Fallback: no active query (session is idle between turns). Use `claude -p`
    // which authenticates through Claude Code's own credentials (OAuth/keychain) —
    // no separate API key required from Build's settings.
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);

    try {
      const cliArgs = ['-p', question, '--bare', '--no-session-persistence'];
      let child: import('child_process').ChildProcess;

      if (session?.sshConfig) {
        // SSH session: run claude -p on the remote server
        const remoteCmd = `claude ${cliArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
        const remoteProcess = await sshService.createRemoteProcess(sessionId, session.sshConfig, {
          command: 'bash',
          args: ['-c', remoteCmd],
          cwd: session.sshConfig.remoteWorkdir || '/home/' + session.sshConfig.username,
          env: {},
          signal: new AbortController().signal,
        });
        child = remoteProcess as unknown as import('child_process').ChildProcess;
      } else {
        const cwd = session?.repoPath || process.cwd();
        const claudeCli = findUsableLocalExecutable(['claude'], [
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          path.join(os.homedir(), '.local', 'bin', 'claude'),
          path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
        ]);
        if (!claudeCli) {
          throw new Error('Claude Code CLI is not installed or is blocked by macOS quarantine.');
        }
        child = spawn(claudeCli, cliArgs, {
          cwd,
          shell: false,
          env: { ...process.env, CLAUDECODE: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      let fullResponse = '';
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        fullResponse += text;
        this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
          sessionId,
          content: text,
          done: false,
        });
      });

      child.stderr?.on('data', (data: Buffer) => {
        console.warn('[Claude Service] /btw CLI stderr:', data.toString().trim());
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code !== 0 && !fullResponse) {
            reject(new Error(`claude -p exited with code ${code}`));
          } else {
            resolve();
          }
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('/btw timeout (60s)')), 60000);
      });

      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
        sessionId,
        content: '',
        done: true,
      });
    } catch (error) {
      console.error('[Claude Service] /btw error:', error);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
        sessionId,
        content: `\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}`,
        done: true,
      });
    }
  }

  async *streamMessage(
    sessionId: string,
    userMessage: string,
    attachments?: Attachment[],
    permissionMode?: string,
    thinkingMode?: string,
    model?: string,
    gstackMode?: string,
    supplementalMessages?: ChatMessage[],
    fastMode?: boolean,
    cascadeMode?: boolean,
  ): AsyncGenerator<StreamEvent> {
    const apiKey = this.getApiKey();

    // Get session for working directory (check both manual and discovered sessions)
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);

    // Validate message is not empty to prevent API error "text content blocks must be non-empty"
    if (!userMessage || userMessage.trim() === '') {
      // Check if we have image attachments - if so, use a placeholder message
      const hasImages = attachments?.some(a => a.type === 'image');
      const hasFiles = hasFileAttachments(attachments);
      const hasDomElements = attachments?.some(a => a.type === 'dom_element');
      if (!hasImages && !hasFiles && !hasDomElements) {
        yield { type: 'error', error: 'Please enter a message before sending.' };
        return;
      }
      userMessage = hasFiles
        ? ATTACHMENT_ONLY_PROMPT
        : hasDomElements
          ? 'Use the attached browser/DOM context as input for the current task.'
          : 'Please analyze this image.';
    }
    if (!session) {
      yield { type: 'error', error: 'Session not found' };
      return;
    }

    // A cancel IPC is not complete until its remote bridge cleanup is done.
    // Waiting here closes the race where a replacement Fast Stack / plan
    // execution process was spawned and then killed by the prior cleanup.
    const pendingCancellation = this.remoteCancellationCleanup.get(sessionId);
    if (pendingCancellation) {
      console.log(`[Claude Service] Waiting for prior remote cancellation before starting ${sessionId.substring(0, 8)}`);
      await pendingCancellation;
    }

    // Do not compact other sessions from a foreground send. That made the app
    // start hidden Claude work in unrelated tabs, and it can steal/abort the
    // visible stream when a user switches back to that tab.

    // Cancel any existing runtime for this session before starting a new
    // foreground turn. `activeQueries` is cleared after Claude emits a result,
    // but a background task listener can keep the same remote Claude process
    // alive. If we do not cancel that listener here, the next user turn can
    // start a second remote Claude against the same worktree.
    const existingController = this.activeQueries.get(sessionId);
    const existingBackgroundListener = this.backgroundListeners.get(sessionId);
    const hadPriorRuntime = Boolean(existingController || existingBackgroundListener);
    if (hadPriorRuntime) {
      this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
      console.log(`[Claude Service] Aborting existing runtime for session ${sessionId.substring(0, 8)} before starting new one`);
      existingController?.abort();
      this.backgroundListeners.get(sessionId)?.abort();
      this.backgroundListeners.delete(sessionId);
      codexService.cancel(sessionId);
      openclawService.cancel(sessionId);
      getCursorService().cancel(sessionId);
      getCursorCliService().cancel(sessionId);
      getGeminiService().cancel(sessionId);
      getOpenCodeService().cancel(sessionId);
    }

    // Serialize remote process spawns per session to prevent reattach+drain races
    const releaseTurnLock = session.sshConfig
      ? await this.acquireSessionTurnLock(sessionId, 'streamMessage')
      : undefined;

    if (session.sshConfig) {
      // Cleanup belongs inside the turn lock and must settle before spawning.
      // A background scan can otherwise observe and reap the replacement job.
      try {
        await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig, {
          killActive: false,
        });
      } catch (error) {
        console.warn('[Claude Service] Foreground SSH cleanup failed:', error);
      }
    }

    // Rate limit auto-retry flag — set in rate_limit_event, checked in result handler
    let pendingRateLimitRetry = false;

    // Create abort controller for cancellation
    const abortController = new AbortController();
    this.setActiveQuery(sessionId, abortController);
    if (!existingController) powerService.sessionStarted(); // Only increment if not replacing

    // Resolve the currently stored SDK session ID cheaply. Expensive SSH repair
    // scans are guarded and run only on native Claude resume paths below.
    const rawSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
      || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;
    const sdkSessionId = normalizeClaudeSdkSessionId(rawSdkSessionId);
    const rawForkFromSdkSessionId = session.forkFromSdkSessionId;
    const forkFromSdkSessionId = normalizeClaudeSdkSessionId(rawForkFromSdkSessionId);
    if (rawForkFromSdkSessionId && !forkFromSdkSessionId) {
      const { forkFromSdkSessionId: _, ...cleanSession } = session;
      this.sessionStore.set(`sessions.${sessionId}`, cleanSession);
      console.warn(
        `[Claude Service] Dropped invalid native fork source for ${sessionId.substring(0, 8)}; `
        + 'starting fresh with the cloned Build transcript'
      );
    }

    // Invalidate message cache - new message being sent (performance optimization)
    this.invalidateMessageCache(sessionId);
    if (session.sshConfig) {
      sshService.invalidateTranscriptCache(sdkSessionId || sessionId);
    }

    let selectedModel = model;
    let selectionMode: 'auto' | 'manual' | 'default' = model === 'auto' ? 'auto' : model ? 'manual' : 'default';
    let selectionSource: 'request' | 'session' | 'default' = model ? 'request' : 'default';
    let effectivePermissionMode = permissionMode;

    // Clear Auto Build's forced plan permission mode when user switches to a
    // direct model. Without this, plan mode persists and blocks Bash/writes
    // even after the user switches away from Auto Build.
    if (model && model !== 'auto') {
      this.clearAutoPlanningState(sessionId, 'user selected a direct model');
      const storedPlanMode = this.sessionPermissionModes.get(sessionId);
      const persistedAutoBuildPrePlanMode = this.getPersistedAutoBuildPrePlanMode(sessionId);
      const autoBuildForcedPlanMode = this.autoBuildForcedPlanSessions.has(sessionId) || Boolean(persistedAutoBuildPrePlanMode);
      if (autoBuildForcedPlanMode) {
        const shouldRestoreAutoBuildPlanMode = storedPlanMode === 'plan' || effectivePermissionMode === 'plan';
        const restored = this.prePlanPermissionModes.get(sessionId) || persistedAutoBuildPrePlanMode || 'acceptEdits';
        if (shouldRestoreAutoBuildPlanMode) {
          this.sessionPermissionModes.set(sessionId, restored);
        }
        this.prePlanPermissionModes.delete(sessionId);
        this.autoBuildForcedPlanSessions.delete(sessionId);
        if (shouldRestoreAutoBuildPlanMode && effectivePermissionMode === 'plan') {
          effectivePermissionMode = restored;
          console.log(`[Claude Service] Overrode stale Auto Build plan permission for direct model turn, restored to ${restored}`);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_PERMISSION_MODE_CHANGED, {
            sessionId,
            mode: restored,
          });
        }
        if (shouldRestoreAutoBuildPlanMode) {
          console.log(`[Claude Service] Cleared Auto Build plan mode, restored to ${restored}`);
          this.persistSessionPermissionMode(sessionId, restored);
        } else {
          this.clearPersistedAutoBuildForcedPlanMode(sessionId);
          console.log(`[Claude Service] Cleared Auto Build plan marker; session mode remains ${effectivePermissionMode}`);
        }
      }
    }

    let autoOrchestrationContext = '';
    let autoOrchestrationPlan: OrchestrationPlan | undefined;
    let autoRoutedTier: TaskTier | undefined;
    let autoRoutedDomain: TaskDomain | undefined;
    let routingDecisionForAnalytics: RoutingDecision | undefined;
    let parableRuntime: PreparedParableRuntime | undefined;
    let cascadeRuntime: PreparedCascadeRuntime | undefined;
    const defaultOutputContext = adhdOutputService.getSystemContext();
    const withCascadeContext = (context?: string): string => (
      [context, cascadeRuntime?.systemContext].filter((value): value is string => Boolean(value?.trim())).join('\n\n')
    );
    const ensureCascadeContext = (context?: string): string => {
      const current = context || '';
      const withOutputContract = current.includes('<build_default_output_contract')
        ? current
        : [defaultOutputContext, current].filter(Boolean).join('\n\n');
      if (!cascadeRuntime || withOutputContract.includes('<cascade_mode>')) return withOutputContract;
      return withCascadeContext(withOutputContract);
    };
    const normalizedSupplementalMessages = this.normalizeConversationMessages(supplementalMessages);
    let autoPlanningState = this.getAutoPlanningState(sessionId);
    let autoPlanningBypassed = false;
    const autoPlanningForced = /^\/(?:80-20-first|spec-first)(?:\s+|$)/i.test(userMessage.trim());
    if (autoPlanningState && this.isAutoPlanningBypass(userMessage)) {
      const bypassRequest = autoPlanningState.originalRequest;
      analyticsService.recordAutoPlanningEvent({
        sessionId,
        timestamp: Date.now(),
        outcome: 'bypassed',
        plannerModel: autoPlanningState.model,
        changeKind: autoPlanningState.changeKind,
        confidence: autoPlanningState.confidence,
        durationMs: Date.now() - autoPlanningState.startedAt,
        questionCount: autoPlanningState.questionCount,
      });
      this.clearAutoPlanningState(sessionId, 'explicit build-now override');
      this.clearSdkSessionId(sessionId);
      autoPlanningState = undefined;
      autoPlanningBypassed = true;
      userMessage = `Build the following request now. The user explicitly bypassed the pre-build 80/20 scope pass:\n\n${bypassRequest}`;
      console.log(`[Claude Service] Auto Build pre-flight bypassed for ${sessionId.substring(0, 8)}`);
    }
    const explicitGoalCommand = this.parseGoalCommand(userMessage);
    const goalOrchestration: { objective: string; source: 'slash-command' } | undefined = explicitGoalCommand;
    if (explicitGoalCommand) {
      userMessage = explicitGoalCommand.objective;
      selectedModel = 'auto';
      selectionMode = 'auto';
      selectionSource = 'request';
    }

    try {
      // Validate and cast permission mode to SDK type
      const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'] as const;
      type SDKPermissionMode = typeof validModes[number];
      const sdkPermissionMode: SDKPermissionMode = validModes.includes(effectivePermissionMode as SDKPermissionMode)
        ? (effectivePermissionMode as SDKPermissionMode)
        : 'acceptEdits';
      let autoBuildLeadPermissionMode: SDKPermissionMode = sdkPermissionMode;

      // Store the initial permission mode for this session (can be updated mid-stream via GREP IT!)
      this.sessionPermissionModes.set(sessionId, sdkPermissionMode);

      // If starting in plan mode, store a default pre-plan mode for restoration after approval
      if (sdkPermissionMode === 'plan' && !this.prePlanPermissionModes.has(sessionId)) {
        this.prePlanPermissionModes.set(sessionId, 'acceptEdits');
        console.log(`[Claude Service] Starting in plan mode, stored default pre-plan mode: acceptEdits`);
      }

      if (session.sshConfig) {
        // Fire-and-forget: MCP sync runs in background, never blocks the turn
        sshService.syncMcpConfigsToRemote(sessionId, session.sshConfig).catch((err) => {
          console.warn('[Claude Service] Background MCP sync failed (non-blocking):', err);
        });
      }

      // Map thinking mode to effort levels (via maxThinkingTokens)
      // The Claude Agent SDK uses maxThinkingTokens, which maps to Claude 4.6's effort parameter:
      //   - off = undefined (no extended thinking) ~ effort: null
      //   - thinking = medium effort ~ effort: "medium"
      //   - ultrathink = high effort ~ effort: "high"
      //
      // NOTE: When the SDK adds support for output_config.effort, we can migrate to:
      //   thinking: { type: "adaptive" }
      //   output_config: { effort: "medium" | "high" }
      //
      // For now, we use token budgets that approximate effort levels:
      //   - medium (thinking): 10,000 tokens
      //   - high (ultrathink): 60,000-100,000 tokens (model-dependent)
      //
      // IMPORTANT: Opus models have a max output token limit of 64,000
      // The thinking tokens count towards this limit, so we cap ultrathink at 60,000
      // to leave room for the actual response (~4,000 tokens buffer)
      // Model selection priority:
      // 1. Explicit model parameter (from UI selector)
      // Model resolution priority:
      // 1. Explicit model from UI (passed as parameter)
      // 2. Session's saved model (session.model)
      // 3. Foundry default (if Foundry enabled)
      // 4. First model in the available models list (always the top/latest)
      if (!selectedModel && session.model) {
        selectedModel = session.model;
        selectionMode = selectedModel === 'auto' ? 'auto' : 'manual';
        selectionSource = 'session';
        console.log('[Claude Service] Using session model:', selectedModel);
      }

      if (!selectedModel) {
        const settings = this.store.get('settings', {}) as Record<string, unknown>;
        const foundryEnabled = settings.foundryEnabled as boolean | undefined;
        if (foundryEnabled) {
          const foundrySonnet = settings.foundryDefaultSonnetModel as string | undefined;
          if (foundrySonnet) {
            selectedModel = foundrySonnet;
            selectionMode = 'default';
            selectionSource = 'default';
            console.log('[Claude Service] Using Foundry default sonnet:', selectedModel);
          }
        }
      }

      if (!selectedModel) {
        // Use the first model in the available list — always the latest/best
        const available = await this.getAvailableModels();
        selectedModel = available[0]?.id || 'auto';
        selectionMode = 'default';
        selectionSource = 'default';
        console.log('[Claude Service] Using top available model:', selectedModel);
      }

      if (selectedModel !== 'auto' && autoPlanningState) {
        this.clearAutoPlanningState(sessionId, 'resolved selection is not Auto Build');
        autoPlanningState = undefined;
      }

      // Cascade is a workflow overlay, not a pseudo-model. Install/embed the
      // exact playbook while leaving the selected model and execution strategy
      // untouched, so it works with every direct harness, Auto Build, and
      // Parable.
      if (cascadeMode) {
        cascadeRuntime = cascadeService.prepareRuntime();
        if (session.sshConfig) {
          const remoteSkillDir = await sshService.syncLocalDirectoryToRemote(
            sessionId,
            session.sshConfig,
            cascadeRuntime.skillDir,
            '~/.build/workflows/cascade',
          );
          cascadeRuntime = {
            ...cascadeRuntime,
            skillDir: remoteSkillDir,
            skillFile: `${remoteSkillDir}/SKILL.md`,
            templatesFile: `${remoteSkillDir}/references/templates.md`,
            systemContext: cascadeService.buildSystemContext(
              remoteSkillDir,
              cascadeRuntime.skillContent,
              cascadeRuntime.templatesContent,
            ),
          };
        }
        autoOrchestrationContext = cascadeRuntime.systemContext;
        console.log(`[Claude Service] Cascade workflow active — selected model remains ${selectedModel} skill=${cascadeRuntime.skillDir}`);
      }

      // Parable mode — Claude Code itself is the meta-harness. Resolve the
      // pseudo-model to the configured Claude brain, install/load the upstream
      // skill, and expose the Settings cast through a real parable.toml. Unlike
      // Auto Build, no application router or helper-stage plan is created.
      if (selectedModel === PARABLE_MODE_ID) {
        parableRuntime = parableService.prepareRuntime(sessionId);
        if (session.sshConfig) {
          const remoteConfigPath = `/tmp/build-parable-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}.toml`;
          const remoteSkillDir = await sshService.syncLocalDirectoryToRemote(
            sessionId,
            session.sshConfig,
            parableRuntime.skillDir,
            '~/.claude/skills/parable-build',
          );
          await sshService.writeRemoteFile(sessionId, session.sshConfig, remoteConfigPath, parableRuntime.configToml);
          parableRuntime = {
            ...parableRuntime,
            configPath: remoteConfigPath,
            skillDir: remoteSkillDir,
            skillFile: `${remoteSkillDir}/SKILL.md`,
            systemContext: parableService.buildSystemContext(parableRuntime.config, remoteSkillDir, remoteConfigPath, parableRuntime.skillContent),
            env: {
              ...parableRuntime.env,
              PARABLE_CONFIG: remoteConfigPath,
              PARABLE_SKILL_DIR: remoteSkillDir,
            },
          };
        }
        selectedModel = parableRuntime.brainModel;
        autoOrchestrationContext = withCascadeContext(parableRuntime.systemContext);
        selectionMode = 'manual';
        selectionSource = 'request';
        console.log(`[Claude Service] Parable mode active — Claude Code meta-harness brain=${selectedModel} config=${parableRuntime.configPath}`);
        // Surface the concrete Claude brain immediately. The renderer keeps
        // Parable selected, but uses this resolved model while the turn is
        // active so its mode chip can mirror Auto Build's live model display.
        yield {
          type: 'system',
          systemInfo: { tools: [], model: selectedModel },
          resolvedModel: selectedModel,
        };
      }

      // Auto Build mode — resolve 'auto' to a concrete model via the router
      let prefetchedRoutingMessages: ChatMessage[] | undefined;
      if (selectedModel === 'auto') {
        try {
          let recentRoutingMessages = normalizedSupplementalMessages;
          try {
            const transcriptMessages = await this.getCanonicalMessages(sessionId, ROUTING_TRANSCRIPT_LIMIT, { allowSdkFallback: false });
            recentRoutingMessages = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
            prefetchedRoutingMessages = recentRoutingMessages;
          } catch (error) {
            console.warn('[Claude Service] Auto Build: Could not load recent messages for routing phase inference:', error);
          }

          if (autoPlanningForced && !autoPlanningState) {
            const sourceRequest = [...recentRoutingMessages].reverse().find((message) => (
              message.role === 'user'
              && Boolean(message.content?.trim())
              && !/^\/(?:80-20-first|spec-first)(?:\s+|$)/i.test(message.content.trim())
            ));
            if (sourceRequest?.content?.trim()) {
              userMessage = sourceRequest.content.trim();
            }
          }

          let remoteCliCapabilities: RemoteCliCapabilities | undefined;
          if (session.sshConfig) {
            remoteCliCapabilities = sshService.getCachedRemoteCliCapabilities(session.sshConfig);
            if (!remoteCliCapabilities) {
              remoteCliCapabilities = ASSUMED_REMOTE_CLI_CAPABILITIES;
              void sshService.detectRemoteCliCapabilities(sessionId, session.sshConfig).catch((error) => {
                console.warn('[Claude Service] Background remote CLI capability refresh failed:', error);
              });
              console.log('[Claude Service] Auto Build using assumed remote CLI capabilities; refresh scheduled in background');
            }
          }

          const approvedPlanPending = this.isApprovedPlanExecutionPending(sessionId);
          const approvedPlanContinuation = approvedPlanPending
            && this.isApprovedPlanExecutionRequest(userMessage);
          if (approvedPlanPending && !approvedPlanContinuation) {
            console.log(`[Claude Service] Ignoring pending approved plan for unrelated Auto turn ${sessionId.substring(0, 8)}`);
          }
          const approvedPlanHandoffContext = approvedPlanContinuation
            ? this.buildApprovedPlanHandoffContext(sessionId)
            : '';
          // Resolve the previous turn's harness/model on every Auto Build turn:
          // the router biases follow-up messages toward the same harness (native
          // resume is cheaper than rebuilding context) and switches only on
          // genuinely new intents.
          const continuationRoute = await this.resolveLastAssistantRoute(sessionId, normalizedSupplementalMessages, recentRoutingMessages);

          const routingDecision = await autoRouterService.classifyAndRoute(sessionId, userMessage, {
            gstackMode: gstackMode || undefined,
            permissionMode: sdkPermissionMode,
            isSSH: !!session.sshConfig,
            remoteCliCapabilities,
            approvedPlanContinuation,
            continuationHarness: continuationRoute.harness,
            continuationModel: continuationRoute.model,
            attachmentCount: attachments?.length || 0,
            attachmentTypes: attachments?.map((attachment) => attachment.type) || [],
            recentMessages: recentRoutingMessages,
            goalObjective: goalOrchestration?.objective,
            goalSource: goalOrchestration?.source,
            prePlanActive: Boolean(autoPlanningState),
            prePlanBypassed: autoPlanningBypassed,
            prePlanForced: autoPlanningForced,
          });
          const routedModel = routingDecision.resolvedModel;
          selectedModel = routedModel;
          routingDecisionForAnalytics = routingDecision;
          autoOrchestrationContext = withCascadeContext([
            approvedPlanHandoffContext,
            routingDecision.orchestration?.handoffPrompt,
          ].filter(Boolean).join('\n\n'));
          autoOrchestrationPlan = routingDecision.orchestration;
          autoRoutedTier = routingDecision.tier;
          autoRoutedDomain = routingDecision.domain;
          if (routingDecision.planningGate?.action === 'start') {
            const firstTurn = !autoPlanningState;
            autoPlanningState = autoPlanningState || this.startAutoPlanningState(
              sessionId,
              userMessage,
              routedModel,
              routingDecision.planningGate,
            );
            autoOrchestrationContext = withCascadeContext([
              approvedPlanHandoffContext,
              routingDecision.orchestration?.handoffPrompt,
              this.buildAutoPlanningSystemContext(autoPlanningState, firstTurn),
            ].filter(Boolean).join('\n\n'));
          }
          if (routingDecision.tier === 'plan') {
            autoBuildLeadPermissionMode = 'plan';
            if (sdkPermissionMode !== 'plan') {
              const prePlanMode = this.prePlanPermissionModes.get(sessionId)
                || (sdkPermissionMode === 'dontAsk' ? 'acceptEdits' : sdkPermissionMode);
              this.autoBuildForcedPlanSessions.add(sessionId);
              if (!this.prePlanPermissionModes.has(sessionId)) {
                this.prePlanPermissionModes.set(sessionId, prePlanMode);
              }
              this.persistAutoBuildForcedPlanMode(sessionId, prePlanMode);
            }
            console.log(`[Claude Service] Auto Build plan route using turn-local plan permission; session mode remains ${sdkPermissionMode}`);
          }
          if (routingDecision.resolvedEffort) {
            thinkingMode = routingDecision.resolvedEffort;
          }
          console.log(`[Claude Service] Auto Build resolved: ${routingDecision.tier.toUpperCase()} → ${selectedModel}`);

          // Emit routing decision to renderer for UI display
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC_CHANNELS.CLAUDE_AUTO_ROUTE_DECISION, {
              sessionId,
              decision: routingDecision,
            });
          }
          yield {
            type: 'system',
            systemInfo: { tools: [], model: selectedModel },
            resolvedModel: selectedModel,
          };

          // Enable Codex goals for routes that delegate native goal tracking to Codex.
          if (routingDecision.enableGoals && routedModel.startsWith('codex:')) {
            this.ensureCodexGoalsEnabled('Auto Build route');
          }

        } catch (e) {
          console.warn('[Claude Service] Auto Build router failed, falling back to Sonnet:', e);
          selectedModel = 'claude-sonnet-4-6';
          selectionMode = 'default';
          selectionSource = 'default';
        }
      }
      selectedModel = selectedModel || 'claude-sonnet-4-6';
      const missionPolicy = routingDecisionForAnalytics?.missionControl;
      const turnPolicy: MetaHarnessPolicy = {
        ...(missionPolicy || {}),
        ...(thinkingMode ? { effort: thinkingMode } : {}),
        ...(fastMode ? { speed: 'fast' as const } : {}),
      };
      const leadHarnessPolicy = translateHarnessPolicy({
        harness: this.getHarnessFromModel(selectedModel),
        model: selectedModel,
        policy: turnPolicy,
        permissionMode: autoBuildLeadPermissionMode,
      });
      if (leadHarnessPolicy.effort) {
        thinkingMode = leadHarnessPolicy.effort;
      }
      const effectiveFastMode = Boolean(fastMode || leadHarnessPolicy.claude?.fastMode);

      try {
        analyticsService.recordRoutingTrainingExample({
          sessionId,
          sessionName: session.name,
          timestamp: Date.now(),
          prompt: userMessage,
          requestedModel: model,
          selectedModel,
          selectedHarness: this.getHarnessFromModel(selectedModel),
          selectionMode,
          selectionSource,
          manualSelection: selectionMode === 'manual',
          taskTier: autoRoutedTier,
          taskDomain: autoRoutedDomain,
          routingDecision: routingDecisionForAnalytics,
          permissionMode: sdkPermissionMode,
          thinkingMode,
          gstackMode,
          isSSH: !!session.sshConfig,
          attachmentCount: attachments?.length || 0,
          attachmentTypes: attachments?.map((attachment) => attachment.type) || [],
        });
      } catch (analyticsError) {
        console.warn('[Claude Service] Could not record routing training example:', analyticsError);
      }

      const explicitlySelectedModel = model && model !== 'auto'
        ? model
        : !model && session.model && session.model !== 'auto'
          ? session.model
          : undefined;
      if (explicitlySelectedModel && selectedModel === explicitlySelectedModel) {
        this.recordHarnessOverride(sessionId, 'auto', selectedModel, autoRoutedTier, autoRoutedDomain);
      }

      let secureEnvContext: string | undefined;
      try {
        secureEnvContext = await this.prepareSecureEnvContext(sessionId, session);
      } catch (error) {
        console.warn('[Claude Service] Failed to prepare secure environment variable handoff:', error);
      }

      // The renderer records explicit model-picker switches before the send
      // IPC. This marker is authoritative when native transcript metadata is
      // stale or missing: never resume an old native harness thread across a
      // real harness boundary.
      const pendingHarnessSwitch = this.consumePendingHarnessSwitch(sessionId, selectedModel);

      // Route to OpenClaw when session has openclawConfig
      if (session.openclawConfig) {
        console.log(`[Claude Service] Routing to OpenClaw gateway: ${session.openclawConfig.gatewayUrl}`);
        const openClawMessage = `${ensureCascadeContext()}\n\n${userMessage}`;
        for await (const event of openclawService.streamAsChat(
          sessionId,
          openClawMessage,
          session.openclawConfig.gatewayUrl,
          session.openclawConfig.gatewayPassword
        )) {
          yield event as StreamEvent;
        }
        return;
      }

      // Route to Codex when a codex:* model is selected
      if (selectedModel?.startsWith('codex:')) {
        const codexModel = selectedModel.split(':')[1];
        console.log(`[Claude Service] Routing to Codex model=${codexModel} ssh=${!!session.sshConfig}`);
        const projectPath = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || process.cwd();

        const nativeCodexGoalObjective = routingDecisionForAnalytics?.goal?.source === 'slash-command'
          ? routingDecisionForAnalytics.goal.objective
          : undefined;
        if (nativeCodexGoalObjective) {
          this.ensureCodexGoalsEnabled('explicit /goal');
        }

        const isManualCodexSelection = selectionMode === 'manual';
        const isAutoBuildCodexSelection = selectionMode === 'auto';
        const usesNativeCodexThread = isManualCodexSelection || isAutoBuildCodexSelection;
        const codexSelectionLabel = isAutoBuildCodexSelection ? 'Auto Build Codex' : 'Manual Codex';
        const lastHarnessForCodex = usesNativeCodexThread
          ? await this.resolveLastAssistantHarness(
            sessionId,
            normalizedSupplementalMessages,
            prefetchedRoutingMessages,
          )
          : undefined;
        let codexThreadId = usesNativeCodexThread ? codexService.getThreadId(sessionId) : undefined;
        let shouldBuildCodexContext = true;

        if (usesNativeCodexThread) {
          if (shouldResetNativeHarnessThread('codex', lastHarnessForCodex, pendingHarnessSwitch)) {
            console.log(`[Claude Service] ${codexSelectionLabel} selected after ${lastHarnessForCodex}; starting fresh native Codex thread with Build handoff context`);
            codexService.clearThreadId(sessionId);
            codexThreadId = undefined;
          } else if (codexThreadId) {
            console.log(`[Claude Service] ${codexSelectionLabel} resuming native thread ${codexThreadId} for session ${sessionId.substring(0, 8)}`);
            shouldBuildCodexContext = false;
          } else {
            console.log(`[Claude Service] ${codexSelectionLabel} has no native thread yet; seeding a new native thread from Build context`);
          }
        }

        let conversationContext = '';
        if (shouldBuildCodexContext) {
          const includeCurrentCodexHistory = !codexThreadId;
          if (includeCurrentCodexHistory) {
            console.log('[Claude Service] Codex context includes current harness history because no native Codex thread is available');
          }
          try {
            conversationContext = await this.buildUnifiedContextForHarness(
              sessionId,
              session,
              'codex',
              normalizedSupplementalMessages,
              projectPath,
              autoOrchestrationContext,
              prefetchedRoutingMessages,
              { includeCurrentHarnessMessages: includeCurrentCodexHistory },
            );
            if (conversationContext) {
              console.log(`[Claude Service] Codex unified harness context: ${conversationContext.length} chars`);
            }
          } catch (e) {
            console.warn('[Claude Service] Could not load messages for Codex context:', e);
          }
        }

        // Native Codex/Cursor threads may resume without rebuilding unified
        // context. Re-apply active workflow overlays on every turn so toggling
        // Cascade takes effect immediately in an existing model session.
        const codexContext = [secureEnvContext, ensureCascadeContext(conversationContext)].filter(Boolean).join('\n\n');

        const codexPrompt = nativeCodexGoalObjective
          ? `/goal ${nativeCodexGoalObjective}`
          : userMessage;

        const codexEvents = codexService.streamAsChat(
          sessionId,
          codexPrompt,
          projectPath,
          session.sshConfig,
          codexContext,
          codexModel,
          attachments,
          autoBuildLeadPermissionMode,
          leadHarnessPolicy,
          { resumeThreadId: codexThreadId, persistThread: usesNativeCodexThread },
        ) as AsyncIterable<StreamEvent>;
        for await (const event of this.streamLeadWithAutoBuildStages(
          codexEvents,
          sessionId,
          session,
          autoOrchestrationPlan,
          userMessage,
          projectPath,
          normalizedSupplementalMessages,
          autoOrchestrationContext,
          sdkPermissionMode,
          secureEnvContext,
          selectedModel,
          abortController.signal,
          autoRoutedDomain,
        )) {
          yield event;
        }
        return;
      }

      // Route to Cursor for cursor:* models
      if (selectedModel?.startsWith('cursor:')) {
        const cursorCliService = getCursorCliService();
        const cursorApiKey = ((this.store.get('settings', {}) as Record<string, unknown>).cursorApiKey as string) || '';

        // Resume existing Cursor chat only if the last turn was also Cursor.
        // If another harness ran in between, start a fresh chat with cross-harness
        // context so Cursor knows what happened while it was away.
        let chatId: string | null | undefined = cursorCliService.getChatId(sessionId);
        let cursorContext = '';
        let needsFreshChat = !chatId;
        const workDir = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || process.cwd();

        if (chatId) {
          const lastHarness = await this.resolveLastAssistantHarness(
            sessionId,
            normalizedSupplementalMessages,
            prefetchedRoutingMessages,
          );
          if (shouldResetNativeHarnessThread('cursor', lastHarness, pendingHarnessSwitch)) {
            console.log(`[Claude Service] Last turn was ${lastHarness}, not Cursor — starting fresh chat with context`);
            cursorCliService.clearChatId(sessionId);
            chatId = null;
            needsFreshChat = true;
          }
        }

        if (needsFreshChat) {
          if (session.sshConfig) {
            const remoteDir = session.worktreePath || session.sshConfig.remoteWorkdir || '~';
            chatId = await cursorCliService.createSshChat(session.sshConfig, remoteDir);
          } else {
            chatId = await cursorCliService.createChat(workDir);
          }

          if (chatId) {
            cursorCliService.setChatId(sessionId, chatId);
            console.log(`[Claude Service] Cursor new chat ${chatId} for session ${sessionId.substring(0, 8)}`);
          } else {
            console.warn('[Claude Service] Failed to create Cursor chat — each turn will be stateless');
          }

          try {
            cursorContext = await this.buildUnifiedContextForHarness(
              sessionId,
              session,
              'cursor',
              normalizedSupplementalMessages,
              workDir,
              autoOrchestrationContext,
              prefetchedRoutingMessages,
            );
            if (cursorContext) {
              console.log(`[Claude Service] Cursor unified harness context: ${cursorContext.length} chars`);
            }
          } catch (e) {
            console.warn('[Claude Service] Could not load messages for Cursor context:', e);
          }
        } else {
          console.log(`[Claude Service] Cursor resuming chat ${chatId} for session ${sessionId.substring(0, 8)}`);
        }

        const effectiveCursorContext = ensureCascadeContext(cursorContext);
        const baseMessage = effectiveCursorContext ? `${effectiveCursorContext}\n\n${userMessage}` : userMessage;
        const { message: fullMessage, cleanup: cursorCleanup } = await this.prepareCliAttachments(sessionId, baseMessage, workDir, attachments, session.sshConfig);

        try {
          if (session.sshConfig) {
            const remoteDir = session.worktreePath || session.sshConfig.remoteWorkdir || '~';
            console.log(`[Claude Service] Cursor SSH → CLI on remote ${session.sshConfig.host}:${remoteDir}`);
            const cursorEvents = cursorCliService.streamMessage(sessionId, fullMessage, remoteDir, selectedModel, session.sshConfig, chatId || undefined, leadHarnessPolicy) as AsyncIterable<StreamEvent>;
            for await (const event of this.streamLeadWithAutoBuildStages(
              cursorEvents,
              sessionId,
              session,
              autoOrchestrationPlan,
              userMessage,
              remoteDir,
              normalizedSupplementalMessages,
              autoOrchestrationContext,
              sdkPermissionMode,
              secureEnvContext,
              selectedModel,
              abortController.signal,
              autoRoutedDomain,
            )) {
              yield event;
            }
            return;
          }

          // Local: SDK path (multi-turn) or CLI path
          if (cursorApiKey && !chatId) {
            const cursorService = getCursorService();
            const workDir = session.repoPath || process.cwd();
            const cursorSdkEvents = cursorService.streamMessage(sessionId, fullMessage, workDir, selectedModel, leadHarnessPolicy) as AsyncIterable<StreamEvent>;
            for await (const event of this.streamLeadWithAutoBuildStages(
              cursorSdkEvents,
              sessionId,
              session,
              autoOrchestrationPlan,
              userMessage,
              workDir,
              normalizedSupplementalMessages,
              autoOrchestrationContext,
              sdkPermissionMode,
              secureEnvContext,
              selectedModel,
              abortController.signal,
              autoRoutedDomain,
            )) {
              yield event;
            }
          } else {
            const workDir = session.repoPath || process.cwd();
            console.log(`[Claude Service] Cursor local → CLI${chatId ? ` (resume ${chatId})` : ' (new chat)'}`);
            const cursorEvents = cursorCliService.streamMessage(sessionId, fullMessage, workDir, selectedModel, undefined, chatId || undefined, leadHarnessPolicy) as AsyncIterable<StreamEvent>;
            for await (const event of this.streamLeadWithAutoBuildStages(
              cursorEvents,
              sessionId,
              session,
              autoOrchestrationPlan,
              userMessage,
              workDir,
              normalizedSupplementalMessages,
              autoOrchestrationContext,
              sdkPermissionMode,
              secureEnvContext,
              selectedModel,
              abortController.signal,
              autoRoutedDomain,
            )) {
              yield event;
            }
          }
        } finally {
          await cursorCleanup();
        }
        return;
      }

      // Route to Gemini CLI for gemini:* models
      if (selectedModel?.startsWith('gemini:')) {
        const geminiService = getGeminiService();
        const workDir = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || process.cwd();

        // Only build cross-harness context if Claude transcript has messages.
        let geminiContext = '';
        try {
          geminiContext = await this.buildUnifiedContextForHarness(
            sessionId,
            session,
            'gemini',
            normalizedSupplementalMessages,
            workDir,
            autoOrchestrationContext,
            prefetchedRoutingMessages,
          );
          if (geminiContext) {
            console.log(`[Claude Service] Gemini unified harness context: ${geminiContext.length} chars`);
          }
        } catch (e) {
          console.warn('[Claude Service] Could not load messages for Gemini context:', e);
        }

        const effectiveGeminiContext = ensureCascadeContext(geminiContext);
        const baseGeminiMessage = effectiveGeminiContext ? `${effectiveGeminiContext}\n\n${userMessage}` : userMessage;
        const { message: fullMessage, cleanup: geminiCleanup } = await this.prepareCliAttachments(sessionId, baseGeminiMessage, workDir, attachments, session.sshConfig);
        try {
          const geminiEvents = geminiService.streamMessage(sessionId, fullMessage, workDir, selectedModel, session.sshConfig, leadHarnessPolicy) as AsyncIterable<StreamEvent>;
          for await (const event of this.streamLeadWithAutoBuildStages(
            geminiEvents,
            sessionId,
            session,
            autoOrchestrationPlan,
            userMessage,
            workDir,
            normalizedSupplementalMessages,
            autoOrchestrationContext,
            sdkPermissionMode,
            secureEnvContext,
            selectedModel,
            abortController.signal,
            autoRoutedDomain,
          )) {
            yield event;
          }
        } finally {
          await geminiCleanup();
        }
        return;
      }

      // Route to OpenCode for opencode:* models
      if (selectedModel?.startsWith('opencode:')) {
        const openCodeService = getOpenCodeService();
        const workDir = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || process.cwd();

        let openCodeContext = '';
        try {
          openCodeContext = await this.buildUnifiedContextForHarness(
            sessionId,
            session,
            'opencode',
            normalizedSupplementalMessages,
            workDir,
            autoOrchestrationContext,
            prefetchedRoutingMessages,
          );
          if (openCodeContext) {
            console.log(`[Claude Service] OpenCode unified harness context: ${openCodeContext.length} chars`);
          }
        } catch (e) {
          console.warn('[Claude Service] Could not load messages for OpenCode context:', e);
        }

        const openCodeHandoffContext = [secureEnvContext, ensureCascadeContext(openCodeContext)].filter(Boolean).join('\n\n');
        const baseOpenCodeMessage = openCodeHandoffContext ? `${openCodeHandoffContext}\n\n${userMessage}` : userMessage;
        const { message: fullMessage, cleanup: openCodeCleanup } = await this.prepareCliAttachments(sessionId, baseOpenCodeMessage, workDir, attachments, session.sshConfig);
        try {
          const openCodeEvents = openCodeService.streamMessage(sessionId, fullMessage, workDir, selectedModel, session.sshConfig, autoBuildLeadPermissionMode, leadHarnessPolicy) as AsyncIterable<StreamEvent>;
          for await (const event of this.streamLeadWithAutoBuildStages(
            openCodeEvents,
            sessionId,
            session,
            autoOrchestrationPlan,
            userMessage,
            workDir,
            normalizedSupplementalMessages,
            autoOrchestrationContext,
            sdkPermissionMode,
            secureEnvContext,
            selectedModel,
            abortController.signal,
            autoRoutedDomain,
          )) {
            yield event;
          }
        } finally {
          await openCodeCleanup();
        }
        return;
      }

      // Always resume the Claude SDK session when available. Even if the last
      // turn was handled by a non-Claude harness (Codex, Cursor), the SDK
      // session carries Claude's own prior turns — dropping it loses all native
      // conversation context and forces Claude to rely on Build transcript
      // summaries alone, which causes "you have me at a disadvantage" responses.
      // Non-Claude harness turns are captured in Build transcript supplemental
      // context and injected alongside the SDK resume.
      let effectiveSdkSessionId = sdkSessionId;
      if (sdkSessionId && session.sshConfig) {
        console.log('[Claude Service] SSH foreground Claude turn: resuming stored Claude SDK session without repair scan');
        // A live remote Claude process can still own this SDK session —
        // background tasks/monitors keep the process alive after its turn
        // completes. Spawning a second process with --resume on that same
        // session returns an empty zero-token result every time (observed
        // systematically in prod). Skip resume for this turn and rely on the
        // full Build transcript context injection below; the baseline
        // mechanism keeps this lossless.
        try {
          // Probe BOTH ownership signals: bridge job registry (fast, but only
          // sees bridge-spawned processes whose command matched) and the
          // remote process probe (catches survivors the registry filter
          // misses). The 2026-07-08 cc87079c incident raced a live owner the
          // bridge-jobs filter did not report — the resume then returned an
          // empty zero-token "success" (reproduced deterministically: two
          // concurrent --resume spawns on one session always empty out).
          const [jobs, remoteProcessActive] = await Promise.all([
            sshService.listDetachedBridgeJobs(sessionId, session.sshConfig).catch(() => []),
            sshService.hasActiveRemoteProcess(sessionId, session.sshConfig).catch(() => false),
          ]);
          const liveClaudeJob = jobs.find((job) => job.active && !job.recovered && job.command === 'claude');
          if (liveClaudeJob || remoteProcessActive) {
            console.warn(
              `[Claude Service] Live remote Claude process (${liveClaudeJob ? `pid ${liveClaudeJob.pid || '?'}` : 'remote-process probe'}) still owns SDK session ` +
              `${sdkSessionId.substring(0, 8)} — starting fresh turn with full Build transcript context instead of a doomed resume`
            );
            effectiveSdkSessionId = undefined;
          }
        } catch (probeError) {
          console.warn('[Claude Service] Could not probe live remote Claude processes before resume:', probeError);
        }
      }
      if (effectiveSdkSessionId) {
        const contextPercentage = await this.resolveSessionContextPercentage(
          sessionId,
          session,
          effectiveSdkSessionId,
          selectedModel,
        );
        if (typeof contextPercentage === 'number' && contextPercentage >= CLAUDE_SDK_RESUME_CONTEXT_LIMIT_PERCENT) {
          console.warn(
            `[Claude Service] Claude SDK context is ${contextPercentage}% for ${sessionId.substring(0, 8)}; ` +
            'clearing SDK resume and using Build transcript context'
          );
          this.clearSdkSessionId(sessionId);
          effectiveSdkSessionId = undefined;
        }
      }

      // When resuming the same Claude harness in Auto Build, skip the
      // orchestration handoff for the lead stage — the model already has
      // full context and will continue naturally. Re-injecting tier-scoped
      // instructions causes it to redo completed work. Preserve the
      // context for delegate stages (Codex/Cursor after-plan handoffs).
      const delegateOrchestrationContext = autoOrchestrationContext;
      if (effectiveSdkSessionId && model === 'auto' && autoOrchestrationContext && !autoPlanningState) {
        console.log('[Claude Service] Same Claude harness resuming — clearing lead orchestration context');
        // Auto's route handoff can be dropped on native resume, but active
        // workflow overlays must be re-applied on every turn.
        autoOrchestrationContext = cascadeRuntime?.systemContext || '';
      }

      // If native Claude resume is unavailable, the Build transcript becomes
      // the continuity source and must include prior Claude turns too.
      let supplementalConversationContext = '';
      let supplementalConversationContextLabel = 'Recent Session Context From Other Models';
      // Native-delta sync: messages missing from the resumed native transcript,
      // delivered INSIDE the user message (models treat in-conversation sync
      // blocks as events of THIS conversation; system-prompt context reads as
      // metadata about "some other conversation" and gets dismissed).
      let conversationSyncBlock = '';
      try {
        const transcriptMessages = await this.getCanonicalMessages(sessionId, 200, { allowSdkFallback: false });
        const merged = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
        const harnessBreakdown: Record<string, number> = {};
        for (const m of merged) { harnessBreakdown[m.harness || 'unknown'] = (harnessBreakdown[m.harness || 'unknown'] || 0) + 1; }
        console.log(
          `[Claude Service] Cross-harness context inputs: transcript=${transcriptMessages.length} supplemental=${normalizedSupplementalMessages.length} merged=${merged.length}` +
          ` sdkSession=${effectiveSdkSessionId ? 'yes' : 'NO'} harnesses=${JSON.stringify(harnessBreakdown)}`
        );
        if (merged.length > 0) {
          const includeCurrentClaudeHarness = !effectiveSdkSessionId;
          const continuityMessages = includeCurrentClaudeHarness
            ? this.filterMessagesForBuildContinuityContext(merged)
            : merged;

          // The native SDK session only contains messages exchanged since it
          // was created. If it was created mid-conversation (fresh restart
          // after a stale session), everything before that baseline lived in a
          // per-spawn system prompt that does NOT persist across resumes.
          // Re-inject pre-baseline history on every resume turn, or Claude is
          // amnesiac about the entire pre-restart conversation.
          const messageTime = (m: ChatMessage): number => {
            const t = m.timestamp instanceof Date ? m.timestamp.getTime() : Date.parse(String(m.timestamp || ''));
            return Number.isFinite(t) ? t : 0;
          };
          // Preferred path when resuming a native SDK session: compute the TRUE
          // delta — which Build-transcript messages are absent from the native
          // session's own transcript — and inject only those, framed as one
          // merged timeline. The baseline-time approximation below remains the
          // fallback; it over-injects (whole-history dumps when baseline is
          // missing) and presents the model with a second, conflicting
          // "conversation" after harness switches or recovery forks
          // (2026-07-08 8d00908d incident: Sonnet trusted its diverged native
          // thread and dismissed the injected real history).
          let nativeDeltaMessages: ChatMessage[] | undefined;
          if (!includeCurrentClaudeHarness) {
            try {
              const nativeMessages = await Promise.race([
                this.getMessages(sessionId, 200),
                new Promise<ChatMessage[]>((_, reject) => setTimeout(() => reject(new Error('native transcript fetch timeout')), 6000)),
              ]);
              if (nativeMessages.length > 0) {
                nativeDeltaMessages = this.filterMessagesForBuildContinuityContext(
                  merged.filter((m) =>
                    this.comparableMessageText(m).length > 0
                    && !nativeMessages.some((n) => this.isSameConversationMessage(m, n)))
                );
                console.log(
                  `[Claude Service] Native-delta context: native=${nativeMessages.length} merged=${merged.length} missing=${nativeDeltaMessages.length}`
                );
                if (nativeDeltaMessages.length > 0) {
                  const deltaBody = buildCrossHarnessContext(nativeDeltaMessages, [], undefined, 120000, { withMeta: true });
                  conversationSyncBlock = [
                    '<conversation_sync>',
                    'Your transcript for this session is MISSING the messages below — they are part of THIS SAME conversation but ran under a different model/harness or in a parallel recovery turn. Merge them chronologically with the history you already have: the combined timeline is ONE continuous session. Where they conflict with your memory, these are authoritative.',
                    '',
                    deltaBody,
                    '</conversation_sync>',
                  ].join('\n');
                }
              }
            } catch (deltaError) {
              console.warn('[Claude Service] Native transcript delta unavailable, falling back to baseline split:', deltaError instanceof Error ? deltaError.message : deltaError);
            }
          }

          const sdkBaseline = !includeCurrentClaudeHarness ? this.getSdkSessionBaseline(sessionId) : undefined;
          // No baseline on an existing SDK session = legacy session from before
          // baseline tracking: we cannot know how much history the native
          // session actually holds (it may be a post-restart fragment), so
          // treat ALL history as potentially missing and inject it. Bounded
          // duplicate context for one healthy turn beats permanent amnesia.
          const preBaselineMessages = !includeCurrentClaudeHarness && nativeDeltaMessages === undefined
            ? this.filterMessagesForBuildContinuityContext(
              sdkBaseline ? merged.filter((m) => messageTime(m) < sdkBaseline) : merged,
            )
            : [];
          const postBaselineMessages = includeCurrentClaudeHarness
            ? continuityMessages
            : nativeDeltaMessages !== undefined || !sdkBaseline
              ? []
              : merged.filter((m) => messageTime(m) >= sdkBaseline);

          // Pre-restart history: all harnesses (the native session has none of it).
          const preBaselineContext = preBaselineMessages.length > 0
            ? buildCrossHarnessContext(preBaselineMessages, [], undefined, 150000)
            : '';
          // Post-baseline / no-baseline: native resume covers Claude's own turns,
          // so filter to other harnesses only. When there is no SDK session at
          // all, include everything (original behaviour).
          const transcriptConversationContext = buildCrossHarnessContext(
            postBaselineMessages,
            [],
            includeCurrentClaudeHarness ? undefined : 'claude',
          );
          // Pinned continuity block on EVERY turn (compact, ~5-18KB): recent
          // user asks, artifacts, working notes. Cheap insurance against any
          // resume path that silently loses history.
          const pinnedBuildContinuityContext = this.buildBuildSessionContinuityContext(
            sessionId,
            session,
            includeCurrentClaudeHarness ? continuityMessages : this.filterMessagesForBuildContinuityContext(merged),
          );
          // Fresh start (no SDK resume): deliver the full Build transcript as
          // a <conversation_sync> block INSIDE the user message so the model
          // treats it as its own conversation history, not as a system-prompt
          // metadata appendix it can dismiss. This is the same mechanism used
          // for cross-harness delta sync, extended to cover doomed-resume
          // fresh restarts where the model would otherwise say "I don't have
          // context from earlier in the conversation."
          if (includeCurrentClaudeHarness && continuityMessages.length > 0 && !conversationSyncBlock) {
            const freshSyncBody = buildCrossHarnessContext(continuityMessages, [], undefined, 120000, { withMeta: true });
            if (freshSyncBody) {
              conversationSyncBlock = [
                '<conversation_sync>',
                'You are CONTINUING an existing conversation. The messages below are YOUR prior conversation history from this session. They are authoritative — treat them as your own memory of what happened, not as external context.',
                '',
                freshSyncBody,
                '</conversation_sync>',
              ].join('\n');
              console.log(`[Claude Service] Fresh-start conversation sync: ${conversationSyncBlock.length} chars from ${continuityMessages.length} messages`);
            }
          }

          supplementalConversationContext = [
            pinnedBuildContinuityContext,
            preBaselineContext,
            transcriptConversationContext,
          ].filter(Boolean).join('\n\n');
          supplementalConversationContextLabel = includeCurrentClaudeHarness
            ? 'Recent Build Session Context'
            : 'Session Context (history not in your current transcript)';
          console.log(
            `[Claude Service] Claude ${includeCurrentClaudeHarness ? 'Build transcript' : 'cross-harness'} context: ` +
            `${supplementalConversationContext.length} chars from ${merged.length} messages` +
            ` | includeClaudeHarness=${includeCurrentClaudeHarness} pinned=${pinnedBuildContinuityContext.length}ch` +
            ` preBaseline=${preBaselineContext.length}ch(${preBaselineMessages.length}msgs) crossHarness=${transcriptConversationContext.length}ch` +
            ` baseline=${sdkBaseline ? new Date(sdkBaseline).toISOString() : 'none'}`
          );
          if (!supplementalConversationContext && merged.length > 0) {
            console.warn(`[Claude Service] WARNING: ${merged.length} messages in transcript but cross-harness context is EMPTY — all filtered out?`);
          }
        } else {
          console.warn(`[Claude Service] WARNING: No messages available for Claude cross-harness context (transcript=${transcriptMessages.length} supplemental=${normalizedSupplementalMessages.length})`);
        }
      } catch (error) {
        console.warn('[Claude Service] Could not load transcript messages for Claude continuity context:', error);
      }

      // Design session sync-back: if this session has an Open Design workspace,
      // pull the design conversation so the coding agent knows what was
      // designed (files are already on disk in the workspace).
      try {
        const designContext = await designService.fetchDesignSessionContext(sessionId);
        if (designContext) {
          supplementalConversationContext = [supplementalConversationContext, designContext]
            .filter(Boolean)
            .join('\n\n');
          console.log(`[Claude Service] Design session context injected: ${designContext.length} chars`);
        }
      } catch (error) {
        console.warn('[Claude Service] Design session context fetch failed:', error);
      }

      const claudePolicy = leadHarnessPolicy.claude;
      if (thinkingMode || claudePolicy?.effort) {
        console.log(`[Claude Service] Effort level: ${thinkingMode || claudePolicy?.effort || 'default'} -> ${claudePolicy?.thinking?.type || (claudePolicy?.maxThinkingTokens ? `maxThinkingTokens:${claudePolicy.maxThinkingTokens}` : 'default')}`);
      }

      // Build prompt with attachments
      const imageAttachments = this.getImageAttachmentsForHarness(attachments);
      const domElementAttachments = attachments?.filter(a => a.type === 'dom_element') || [];
      const hasImages = imageAttachments.length > 0;
      const hasDomElements = domElementAttachments.length > 0;

      console.log('[Claude Service] streamMessage - Attachments received:', attachments?.length || 0);
      console.log('[Claude Service] streamMessage - Image attachments:', imageAttachments.length);
      console.log('[Claude Service] streamMessage - DOM element attachments:', domElementAttachments.length);
      if (attachments) {
        attachments.forEach((a, i) => {
          console.log(`[Claude Service] Attachment ${i}: type=${a.type}, name=${a.name}, content exists=${!!a.content}, content length=${a.content?.length || 0}`);
        });
      }

      // Resolve [SECURE_KEY:key_xxx] placeholders back to real values before
      // sending to the model. The renderer replaced detected API keys with
      // placeholders to keep them out of the transcript/UI, but the model
      // needs the actual values to function (e.g. curl -H "Authorization: <key>").
      const resolvedMessage = userMessage.replace(
        /\[SECURE_KEY:([^\]]+)\]/g,
        (_match, keyId) => {
          const realValue = secureKeysService.getKey(keyId);
          if (realValue) return realValue;
          console.warn(`[Claude Service] Could not resolve SECURE_KEY placeholder: ${keyId}`);
          return _match;
        }
      );

      const attachmentWorkingDir = session.sshConfig
        ? session.worktreePath || session.repoPath || session.sshConfig.remoteWorkdir || process.cwd()
        : this.resolveValidCwd(session);
      let fileAttachmentPrompt = '';
      if (hasFileAttachments(attachments)) {
        try {
          const preparedFiles = await prepareFileAttachmentsForHarness(
            sessionId,
            attachments,
            attachmentWorkingDir,
            session.sshConfig,
          );
          fileAttachmentPrompt = preparedFiles.promptBlock;
          if (preparedFiles.files.length > 0) {
            console.log(`[Claude Service] Prepared ${preparedFiles.files.length} file attachment(s) for harness input`);
          }
        } catch (error) {
          console.error('[Claude Service] Failed to prepare file attachments:', error);
          yield {
            type: 'error',
            error: `Failed to prepare file attachments: ${error instanceof Error ? error.message : String(error)}`,
          };
          return;
        }
      }

      // Parable has an additional turn-local control block. Claude Code can
      // treat a dynamic system-prompt appendix as background metadata, while
      // executor paths and completion rules are operational instructions for
      // this exact turn. Put the compact runtime contract next to the user's
      // request as well as keeping the full playbook in the system prompt.
      const parableTurnControl = parableRuntime
        ? [
            '<parable_runtime_control priority="authoritative">',
            'Parable mode is already installed and configured for this turn. Do not search for, locate, rediscover, or invoke a Parable skill or playbook.',
            `Managed skill directory: ${parableRuntime.skillDir}`,
            `Managed config: ${parableRuntime.configPath}`,
            `Load cast/config exactly once with: bash ${path.join(parableRuntime.skillDir, 'scripts', 'parable-config.sh')}`,
            `For 2+ disjoint external runs, use one foreground call only: bash ${path.join(parableRuntime.skillDir, 'scripts', 'parable-batch.sh')} <workdir> <executor> <plan.md> <executor> <plan.md> ...`,
            `Run configured checks with: bash ${path.join(parableRuntime.skillDir, 'scripts', 'parable-verify.sh')} --when <post-implement|pre-commit>`,
            'Plans belong under <workdir>/.parable/plans/. Never use /tmp/parable-plans.',
            'Claude subagent reviewers run directly with the Agent tool; do not call parable-review.sh for them.',
            'Do not end the turn until the foreground batch, checks, integrated review, fixups, and final checks are all complete.',
            '</parable_runtime_control>',
          ].join('\n')
        : '';

      const cascadeTurnControl = cascadeRuntime
        ? [
            '<cascade_runtime_control priority="authoritative">',
            'Cascade workflow is already embedded for this turn. Do not search for, rediscover, or invoke another Cascade skill.',
            `Managed skill: ${cascadeRuntime.skillFile}`,
            `Managed templates: ${cascadeRuntime.templatesFile}`,
            'Cascade does not replace the selected model or execution strategy. Keep using the model, Auto Build route, or Parable strategy selected by the user.',
            'Inspect HEAD and docs/LOOP_CHAIN_*.md plus docs/evidence/ first, then choose PLAN, ADVANCE, or TAKEOVER.',
            'For a new task, create the chain doc and task graph before BUILD. Default to autonomous pacing unless the user explicitly requests checkpointed pacing.',
            'Do not advance without an evidence-backed EXIT.md. Stop honestly at AT_BOUND and all human gates.',
            'A “Parallel track” inside a chain document is dependency bookkeeping only; it is separate from Cascade and does not implicitly change execution strategy.',
            '</cascade_runtime_control>',
          ].join('\n')
        : '';

      // GStack mode is injected via system prompt append only (buildSystemPromptAppend)
      let fullTextMessage = [parableTurnControl, cascadeTurnControl, resolvedMessage].filter(Boolean).join('\n\n');
      if (conversationSyncBlock) {
        fullTextMessage = `${conversationSyncBlock}\n\n${fullTextMessage}`;
      }
      if (fileAttachmentPrompt) {
        fullTextMessage = `${fileAttachmentPrompt}\n\n${fullTextMessage || ATTACHMENT_ONLY_PROMPT}`;
      }
      if (hasDomElements) {
        const domContext = domElementAttachments.map((el, i) => {
          return `<selected-element index="${i + 1}" selector="${el.name}">\n${el.content}\n</selected-element>`;
        }).join('\n\n');
        fullTextMessage = `${domContext}\n\n${fullTextMessage}`;
        console.log('[Claude Service] Added DOM element context to message');
      }

      if (hasImages) {
        console.log('[Claude Service] Will use multimodal prompt with images');
        imageAttachments.forEach((a, i) => {
          console.log(`[Claude Service] Image ${i}: name=${a.name}, base64 length=${a.content?.length || 0}, first 50 chars=${a.content?.slice(0, 50)}`);
        });
      }

      // Use the stable Claude SDK prompt shape for the initial turn. Keeping a
      // long-lived AsyncIterable open here can leave the SDK waiting forever.
      const resizeImage = this.resizeImageIfNeeded.bind(this);
      const normalizeBase64ImageData = this.normalizeBase64ImageData.bind(this);
      const createPromptWithImages = async function* (): AsyncIterable<SDKUserMessage> {
        const content: (TextBlockParam | ImageBlockParam)[] = [
          { type: 'text', text: fullTextMessage }
        ];

        for (const attachment of imageAttachments) {
          const ext = attachment.name.split('.').pop()?.toLowerCase();
          const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
                : 'image/png';

          const resizedData = await resizeImage(normalizeBase64ImageData(attachment.content), mediaType);

          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: resizedData,
            },
          });
        }

        yield {
          type: 'user',
          message: {
            role: 'user',
            content,
          },
          parent_tool_use_id: null,
          session_id: effectiveSdkSessionId || '',
        } as SDKUserMessage;
      };

      const prompt = hasImages ? createPromptWithImages() : fullTextMessage;
      console.log('[Claude Service] Using prompt type:', hasImages ? 'multimodal (async generator)' : 'text string');
      if (hasDomElements && !hasImages) {
        console.log('[Claude Service] DOM element context included in text prompt');
      }

      // Pre-fetch agent memories to inject into system prompt.
      const projectPath = this.resolveValidCwd(session);
      const memoryProjectPath = this.getMemoryProjectPath(session, projectPath);
      let memoriesPrompt: string | undefined;
      if (memoryProjectPath) {
        try {
          memoriesPrompt = await memoryService.getMemoriesForPrompt(memoryProjectPath);
          if (memoriesPrompt) {
            console.log('[Claude Service] Loaded memories for session, length:', memoriesPrompt.length);
          }
        } catch (error) {
          console.error('[Claude Service] Failed to load memories:', error);
          // Continue without memories - non-critical failure
        }
      }

      // Build MCP servers configuration
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpServersConfig: Record<string, any> = {};

      // For SSH sessions, transfer local webview cookies to the remote machine
      // so the remote chrome-devtools-mcp Chrome can use them
      if (session.sshConfig) {
        try {
          const { session: electronSession } = await import('electron');
          const targetSid = browserService.getFirstSessionId() || sessionId;
          const partitionName = browserService.getPartitionName(targetSid);
          const ses = electronSession.fromPartition(partitionName);
          const cookies = await ses.cookies.get({});

          if (cookies.length > 0) {
            const cookieJson = JSON.stringify(cookies, null, 2);
            // Use /tmp as a reliable writable path (tilde doesn't expand in single-quoted paths)
            await sshService.writeRemoteFile(
              sessionId,
              session.sshConfig,
              '/tmp/grep-build-cookies.json',
              cookieJson
            );
            console.log(`[Claude Service] Transferred ${cookies.length} cookies to remote machine`);
          }
        } catch (error) {
          console.warn('[Claude Service] Cookie transfer to remote failed (non-fatal):', error);
        }
      }

      // DesignMode is separate from browser automation and must always be
      // available so design requests can hand off to Build's embedded OD flow.
      mcpServersConfig['claudette-design'] = this.getDesignMcpServer(sessionId);
      console.log('[Claude Service] Design MCP tool enabled', session.sshConfig ? '(SSH session)' : '(local session)');

      // Browser tools are still conditional for SSH sessions to avoid loading
      // browser automation when the session has never used the browser panel.
      const sessionHasBrowserHistory = session.sshConfig ? !!(session as any).lastBrowserUrl : true;
      if (sessionHasBrowserHistory) {
        mcpServersConfig['claudette-browser'] = this.getBrowserMcpServer(sessionId);
        console.log('[Claude Service] Browser MCP tools enabled', session.sshConfig ? '(SSH session)' : '(local session)');
      } else {
        console.log('[Claude Service] Browser MCP tools skipped — SSH session with no browser history');
      }

      // Load user-installed MCP servers from Claudette's electron-store
      // This runs on EVERY message, so new MCP servers are picked up automatically
      try {
        let userMcpServers: Record<string, any>;

        if (session.sshConfig) {
          // SSH session: replace native stdio MCP servers with HTTP bridge URLs
          const { mcpStdioBridgeService } = await import('./mcp-stdio-bridge.service');
          const bridgePorts = mcpStdioBridgeService.getSessionBridgePorts(sessionId);
          userMcpServers = mcpService.getClaudeMcpServersConfigForSSH(bridgePorts);
        } else {
          userMcpServers = mcpService.getClaudeMcpServersConfig();
        }

        // For SSH sessions, remove chrome-devtools stdio config (can't run npx on remote)
        // The PreToolUse hook will intercept all chrome-devtools calls and run them locally
        if (session.sshConfig && userMcpServers['chrome-devtools']) {
          console.log('[Claude Service] SSH session: replacing remote chrome-devtools with local MCP server');
          delete userMcpServers['chrome-devtools'];
          // Register a local in-process chrome-devtools MCP server so tools are still visible to the agent
          mcpServersConfig['chrome-devtools'] = this.getChromeDevtoolsMcpServer(sessionId);
        }

        Object.assign(mcpServersConfig, userMcpServers);
        console.log('[Claude Service] Loaded user MCP servers:', Object.keys(userMcpServers));
      } catch (error) {
        console.error('[Claude Service] Error loading user MCP servers:', error);
      }

      // Check if QMD is available for semantic codebase search
      // Only add for local sessions (not SSH) since QMD runs locally
      // Requires: 1) Global setting enabled, 2) Project preference enabled
      if (!session.sshConfig) {
        const qmdGlobalEnabled = this.store.get('qmdEnabled', false) as boolean;
        const qmdProjectEnabled = qmdService.isEnabledForProject(projectPath, qmdGlobalEnabled);

        if (qmdProjectEnabled) {
          const qmdConfig = qmdService.getMcpServerConfig();
          if (qmdConfig) {
            mcpServersConfig['qmd'] = {
              type: 'stdio',
              command: qmdConfig.command,
              args: qmdConfig.args,
            };
            console.log('[Claude Service] QMD MCP server enabled for semantic search');

            // Ensure project is indexed for QMD (runs in background, doesn't block)
            qmdService.ensureProjectIndexed(projectPath, (message) => {
              console.log('[Claude Service] QMD indexing:', message);
            }).catch((error) => {
              console.error('[Claude Service] QMD indexing error:', error);
            });
          }
        } else if (qmdGlobalEnabled) {
          // Global is enabled but project preference is unknown - check if we should prompt
          qmdService.shouldPromptForProject(projectPath).then((shouldPrompt) => {
            if (shouldPrompt && this.mainWindow) {
              console.log('[Claude Service] QMD available - prompting user for project preference');
              this.mainWindow.webContents.send(IPC_CHANNELS.QMD_PROMPT_RESPONSE, {
                sessionId,
                projectPath,
              });
            }
          });
        } else {
          // QMD globally disabled - log for debugging
          console.log('[Claude Service] QMD disabled globally (enable in settings to use semantic search)');
        }
      }

      // Ultra Plan Mode: Configure PostToolUse hook to auto-generate tasks after plan approval
      // This hook fires only when ExitPlanMode succeeds and ultraPlanMode setting is enabled
      const settings = this.store.get('settings', {}) as any;
      const ultraPlanEnabled = settings.ultraPlanMode || false;

      // Build hooks object
      const hooks: any = {};

      // PreToolUse hook for SSH sessions: intercept browser tools and execute locally
      if (session.sshConfig) {
        hooks.PreToolUse = [
          {
            matcher: 'mcp__claudette-browser__Browser*', // Match all MCP browser tools
            hooks: [async (input: any, toolUseID: string | undefined, options: any) => {
              console.log('[SSH Browser Intercept] PreToolUse hook called with:', JSON.stringify({ input, toolUseID, optionsKeys: Object.keys(options || {}) }));
              const fullToolName = input?.tool_name || input?.toolName || '';
              const toolName = fullToolName.replace('mcp__claudette-browser__', '');
              console.log('[SSH Browser Intercept] Extracted tool name:', fullToolName, '->', toolName);

              if (toolName.startsWith('Browser')) {
                console.log('[SSH Browser Intercept] Executing browser tool locally:', toolName);
                try {
                  const toolInput = input?.tool_input || {};
                  const result = await this.executeLocalBrowserTool(sessionId, toolName, toolInput);
                  console.log('[SSH Browser Intercept] Local execution completed:', { success: result.success });
                  return {
                    continue: false,
                    toolResult: result,
                  };
                } catch (error) {
                  console.error('[SSH Browser Intercept] Local execution failed:', error);
                  return {
                    continue: false,
                    toolResult: {
                      success: false,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  };
                }
              }
              return { continue: true };
            }]
          },
          {
            matcher: 'mcp__chrome-devtools__*', // Match all chrome-devtools MCP tools
            hooks: [async (input: any) => {
              const fullToolName = input?.tool_name || input?.toolName || '';
              const toolName = fullToolName.replace('mcp__chrome-devtools__', '');
              console.log('[SSH Chrome DevTools Intercept] Routing locally:', fullToolName, '->', toolName);

              try {
                const toolInput = input?.tool_input || {};
                const result = await this.executeLocalChromeDevtool(sessionId, toolName, toolInput);
                console.log('[SSH Chrome DevTools Intercept] Local execution completed');
                return {
                  continue: false,
                  toolResult: result,
                };
              } catch (error) {
                console.error('[SSH Chrome DevTools Intercept] Local execution failed:', error);
                return {
                  continue: false,
                  toolResult: {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  },
                };
              }
            }]
          },
        ];
      }

      // Ralph Loop: Add Stop hook for Build It mode (bypassPermissions)
      // This intercepts session exit to continue iteration until task is complete
      // Based on Anthropic's official Ralph Wiggum plugin pattern with safety improvements
      const audioSettings = this.store.get('audioSettings') as any;
      const ralphLoopEnabled = audioSettings?.ralphLoopEnabled ?? false;
      const computerUseEnabled = audioSettings?.computerUseEnabled ?? false;
      const maxRalphIterations = audioSettings?.maxRalphIterations ?? 50;
      const maxComputerUseIterations = audioSettings?.maxComputerUseIterations ?? 20;

      if (autoBuildLeadPermissionMode === 'bypassPermissions' && (ralphLoopEnabled || computerUseEnabled)) {
        let iterationCount = 0;
        const maxIterations = computerUseEnabled ? maxComputerUseIterations : maxRalphIterations;
        const loopName = computerUseEnabled ? 'Computer Use' : 'Ralph Loop';

        hooks.Stop = [async (options: { fullContent: string; signal: AbortSignal; stopHookActive?: boolean }) => {
          // Check for explicit completion markers
          const completionMarkers = [
            '<promise>COMPLETE</promise>',
            'Task completed successfully',
            'I have finished'
          ];
          const hasCompletion = completionMarkers.some(marker =>
            options.fullContent.toLowerCase().includes(marker.toLowerCase())
          );

          if (hasCompletion) {
            console.log(`[${loopName}] Completion marker found after ${iterationCount} iterations, allowing exit`);
            return { decision: 'allow' as const };
          }

          // If Claude stopped without using any tools, it's likely stuck or done
          const hasToolUse = options.fullContent.includes('tool_use') || options.fullContent.includes('Tool');
          if (!hasToolUse && iterationCount > 0) {
            console.log(`[${loopName}] No tool use detected at iteration ${iterationCount}, allowing exit (likely stuck or complete)`);
            return { decision: 'allow' as const };
          }

          // Increment and check iteration limit
          iterationCount++;
          console.log(`[${loopName}] Iteration ${iterationCount}/${maxIterations}`);

          if (iterationCount >= maxIterations) {
            console.log(`[${loopName}] Max iterations reached (${maxIterations}), allowing exit`);
            return { decision: 'allow' as const };
          }

          // Build continuation prompt with progressive context
          let continuationPrompt: string;
          if (iterationCount <= 3) {
            continuationPrompt = `Continue working on the task. Review your previous changes and assess progress. Output <promise>COMPLETE</promise> when the task is fully done.`;
          } else if (iterationCount <= 10) {
            continuationPrompt = `Continue working on the task (iteration ${iterationCount}/${maxIterations}). Check git status and your file changes to avoid redoing work. Output <promise>COMPLETE</promise> when done.`;
          } else {
            continuationPrompt = `You've been iterating for ${iterationCount} cycles (max ${maxIterations}). Critically assess whether you're making progress or stuck in a loop. If stuck, document what's blocking you and output <promise>COMPLETE</promise>. If making progress, continue.`;
          }

          return {
            decision: 'block' as const,
            prompt: continuationPrompt,
          };
        }];
      }

      // Add ultra plan mode hooks if enabled
      if (ultraPlanEnabled) {
        hooks.PostToolUse = [{
          matcher: 'ExitPlanMode',  // Only trigger after ExitPlanMode succeeds
          hooks: [async (input: any, toolUseID: string | undefined, { signal }: { signal: AbortSignal }) => {
            try {
              console.log('[Ultra Plan] PostToolUse hook triggered after ExitPlanMode');

              // Read the approved plan content from cache
              const cachedPlan = this.sessionPlanFiles.get(sessionId);
              const planContent = cachedPlan?.content || '';

              if (!planContent) {
                console.log('[Ultra Plan] No plan content available, skipping task generation');
                return { continue: true };
              }

              // Inject system message prompting structured task creation
              const taskCreationPrompt = `
# Task Decomposition Required

Your plan has been approved. Before beginning implementation, you must decompose this plan into structured, executable tasks using the TaskCreate tool.

## Approved Plan Summary

${planContent.substring(0, 2000)}

## Instructions

1. **Analyze the plan** and identify discrete, actionable implementation steps
2. **Create tasks** using the TaskCreate tool with:
   - Clear, imperative subjects (e.g., "Add rewind button UI", "Implement fork backend logic")
   - Detailed descriptions with acceptance criteria
   - activeForm for progress display (e.g., "Adding rewind button")
3. **Set up dependencies** using TaskUpdate with addBlockedBy for tasks that must wait
4. **Use TaskList** to verify the complete task structure
5. **Mark first task as in_progress** using TaskUpdate before starting work

## Task Guidelines

- Create granular, atomic tasks - each task should accomplish ONE clear, testable objective
- Prefer more smaller tasks over fewer large tasks (e.g., separate tasks for "Add type definition", "Add service method", "Add IPC handler")
- Each task should be independently verifiable and take no more than a few focused steps
- Order tasks by natural execution flow
- Use blockedBy for strict dependencies (e.g., "Add backend service" blocks "Add IPC handler")
- Include a final "End-to-end verification" task
- Start work immediately after task structure is confirmed

## Example Task Structure

Task 1: "Set up service layer" (no blockers)
Task 2: "Add IPC handlers" (blocked by Task 1)
Task 3: "Expose preload API" (blocked by Task 2)
Task 4: "Implement UI component" (blocked by Task 3)
Task 5: "End-to-end verification" (blocked by Task 4)

Begin by creating the task structure now.
`;

              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse' as const,
                  additionalContext: taskCreationPrompt,
                }
              };
            } catch (error) {
              console.error('[Ultra Plan] Error in PostToolUse hook:', error);
              return { continue: true };
            }
          }]
        }];
      }

      // Use the Claude Agent SDK query function with Claude Code's system prompt
      console.log('[Claude Service] Starting query, session has sshConfig:', !!session.sshConfig);
      if (session.sshConfig) {
        console.log('[Claude Service] SSH config:', { host: session.sshConfig.host, user: session.sshConfig.username, remoteWorkdir: session.sshConfig.remoteWorkdir });
      }
      const sshConfig = session.sshConfig;
      // Mark this session as actively streaming so its SSH connection gets health checks.
      // Idle sessions (128+ of them) skip health checks to avoid saturating the remote.
      if (sshConfig) sshService.markSessionActive(sessionId);
      const localNodeExecutable = session.sshConfig ? undefined : this.resolveLocalNodeExecutable();
      if (!session.sshConfig) {
        if (localNodeExecutable) {
          console.log('[Claude Service] Resolved local Node executable candidate for Claude Code:', localNodeExecutable);
        } else {
          console.warn('[Claude Service] Could not resolve a local Node executable explicitly; falling back to PATH lookup');
        }
      }
      // Sync showClearContextOnPlanAccept to ~/.claude/settings.json
      try {
        const userClaudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
        let claudeSettings: Record<string, unknown> = {};
        if (fs.existsSync(userClaudeSettings)) {
          claudeSettings = JSON.parse(fs.readFileSync(userClaudeSettings, 'utf-8'));
        }
        const wantClear = !!(settings as any).showClearContextOnPlanAccept;
        if (claudeSettings.showClearContextOnPlanAccept !== wantClear) {
          claudeSettings.showClearContextOnPlanAccept = wantClear;
          fs.writeFileSync(userClaudeSettings, JSON.stringify(claudeSettings, null, 2));
        }
      } catch (e) {
        console.warn('[Claude Service] Could not sync showClearContextOnPlanAccept:', e);
      }

      // Pass the user's permission mode through to the CLI. When bypass is
      // active, also set allowDangerouslySkipPermissions so the CLI auto-allows
      // ALL tools without pausing. This prevents partial-message spam from
      // permission-prompt round-trips that cause triple-output rendering bugs.
      // Trade-off: AskUserQuestion won't fire in bypass mode (the CLI never
      // sends can_use_tool events), but that's acceptable — bypass means bypass.
      const cliPermissionMode = autoBuildLeadPermissionMode;
      const requiresDangerFlag = autoBuildLeadPermissionMode === 'bypassPermissions';

      // Resolve the native CLI binary path explicitly.
      // The SDK's own resolution uses import.meta.url which breaks when webpack
      // externalises the module as commonjs — the URL doesn't point at the real
      // node_modules location in packaged Electron apps.
      let resolvedCliBinaryPath: string | undefined;
      try {
        const sdkPlatformPkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
        resolvedCliBinaryPath = path.join(path.dirname(sdkPlatformPkg), 'claude');
        // In the dev webpack build require.resolve can return a repo-relative
        // path; the SDK spawns from the session cwd, so a relative path only
        // works when the session happens to live in this repo. Anchor it to
        // the process cwd (which is what existsSync validated against).
        if (!path.isAbsolute(resolvedCliBinaryPath)) {
          resolvedCliBinaryPath = path.resolve(process.cwd(), resolvedCliBinaryPath);
        }
        if (!fs.existsSync(resolvedCliBinaryPath)) {
          console.warn('[Claude Service] Resolved CLI binary path does not exist:', resolvedCliBinaryPath);
          resolvedCliBinaryPath = undefined;
        } else {
          console.log('[Claude Service] Resolved native CLI binary:', resolvedCliBinaryPath);
        }
      } catch (e) {
        console.warn('[Claude Service] Could not resolve native CLI binary path:', e);
      }

      const messages = query({
        prompt,
        options: {
          cwd: projectPath,
          ...(resolvedCliBinaryPath ? { pathToClaudeCodeExecutable: resolvedCliBinaryPath } : {}),
          abortController,
          permissionMode: cliPermissionMode,
          ...(requiresDangerFlag ? { allowDangerouslySkipPermissions: true } : {}),
          includePartialMessages: true,
          // Use computed model — resolve custom:* IDs to actual API model names
          model: this.resolveCustomModelId(selectedModel),
          // 1M context is native for Sonnet 5, Fable 5, Opus 4.6, and Sonnet 4.6.
          // Legacy models (Sonnet 4.5, Sonnet 4) still need the beta until Apr 30 2026
          // Skip betas for Foundry and third-party Claude-compatible proxies.
          ...(!settings.foundryEnabled && !selectedModel.startsWith('custom:') && !selectedModel.includes('sonnet-5') && !selectedModel.includes('fable-5') && !selectedModel.includes('opus-4-6') && !selectedModel.includes('sonnet-4-6')
            ? { betas: ['context-1m-2025-08-07' as const] }
            : {}),
          ...(claudePolicy?.thinking ? { thinking: claudePolicy.thinking } : {}),
          ...(claudePolicy?.effort ? { effort: claudePolicy.effort } : {}),
          ...(claudePolicy?.maxThinkingTokens ? { maxThinkingTokens: claudePolicy.maxThinkingTokens } : {}),
          ...(effectiveFastMode ? { fastMode: true } : {}),
          // Ultra Plan Mode: Add hooks if enabled
          ...(hooks ? { hooks } : {}),
          // Use Claude Code's system prompt preset with Build agent context
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: this.buildSystemPromptAppend(
              session,
              memoriesPrompt,
              gstackMode,
              secureEnvContext,
              supplementalConversationContext,
              autoOrchestrationContext,
              supplementalConversationContextLabel,
            ),
          },
          // Enable CLAUDE.md and Skills from both user (~/.claude/) and project (.claude/)
          // Skills are discovered automatically by the SDK from these filesystem locations
          // User skills: ~/.claude/skills/, Project skills: .claude/skills/
          enableFileCheckpointing: true,
          settingSources: ['user', 'project'],
          // Pass environment with API key and enable agent teams
          env: (() => {
            // Start with process.env but STRIP any stale custom model vars
            const { ANTHROPIC_BASE_URL: _, ANTHROPIC_MODEL: _m, ANTHROPIC_SMALL_FAST_MODEL: _s, ANTHROPIC_AUTH_TOKEN: _t, ...cleanEnv } = process.env;
            const customVars = this.getCustomModelEnvVars(selectedModel);
            const foundryVars = this.getFoundryEnvVars();
            const finalEnv = {
              ...cleanEnv,
              ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
              ...(parableRuntime?.env || {}),
              ...(parableRuntime && settings.cursorApiKey ? { CURSOR_API_KEY: String(settings.cursorApiKey) } : {}),
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || 'true',
              ...foundryVars,
              ...customVars,
            };
            if (Object.keys(customVars).length > 0) {
              console.log('[Claude Service] Custom model env:', { baseUrl: customVars.ANTHROPIC_BASE_URL, model: customVars.ANTHROPIC_MODEL, hasKey: !!customVars.ANTHROPIC_API_KEY });
            }
            return finalEnv;
          })(),
          // Resume previous conversation if we have an SDK session ID.
          // For SSH forks: resume from the parent's SDK session + forkSession: true
          // so the remote transcript gets forked on the first query.
          ...(effectiveSdkSessionId ? { resume: effectiveSdkSessionId } : {}),
          ...(forkFromSdkSessionId ? { resume: forkFromSdkSessionId, forkSession: true } : {}),
          // Add MCP servers (browser tools + QMD semantic search if available)
          mcpServers: mcpServersConfig,
          // Spawn Claude Code either locally via a resolved Node binary or remotely over SSH.
          spawnClaudeCodeProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            if (sshConfig) {
              console.log('[Claude Service] Creating SSH remote process for session:', sessionId);
              console.log('[Claude Service] SDK spawn options:', { command: options.command, args: options.args, cwd: options.cwd });
              return sshService.createRemoteProcess(
                sessionId,
                sshConfig,
                options
              );
            }

            return this.createLocalClaudeCodeProcess(localNodeExecutable, options);
          },
          // Handle tool permission requests
          canUseTool: async (toolName: string, input: Record<string, unknown>, _options: any) => {
            console.log(`[Claude Service] canUseTool called for: ${toolName}, mode: ${autoBuildLeadPermissionMode}`);

            // Handle AskUserQuestion tool (name may vary across SDK versions)
            const normalizedToolName = toolName.toLowerCase().replace(/[_-]/g, '');
            if ((normalizedToolName === 'askuserquestion' || normalizedToolName === 'askquestion') && input.questions) {
              return this.handleAskUserQuestionTool(sessionId, input);
            }

            // Handle ExitPlanMode - require user approval before proceeding
            if (normalizedToolName === 'exitplanmode') {
              try {
                const planningState = this.getAutoPlanningState(sessionId);
                if (planningState) {
                  const interviewBlocker = this.getAutoPlanningExitBlocker(planningState);
                  if (interviewBlocker) {
                    this.updateAutoPlanningState(sessionId, { status: 'interview' });
                    console.warn(`[Claude Service] Blocked premature Auto Build plan exit: ${interviewBlocker}`);
                    return {
                      behavior: 'deny' as const,
                      message: interviewBlocker,
                    };
                  }
                }
                console.log('[Claude Service] ExitPlanMode called, requesting user approval');

                let planContent = '';
                let planFilePath = '';

                // First priority: Check if plan content is provided in the tool input (common for remote sessions)
                if (input.plan && typeof input.plan === 'string') {
                  planContent = input.plan;
                  planFilePath = ''; // No file path when plan is in input
                  console.log('[Claude Service] Using plan from tool input, length:', planContent.length);
                }
                // Second priority: Use the cached plan content for this session (set when plan file was written locally)
                else {
                  const cachedPlan = this.sessionPlanFiles.get(sessionId);

                  if (cachedPlan) {
                    planContent = cachedPlan.content;
                    planFilePath = cachedPlan.filePath;
                    console.log('[Claude Service] Using cached plan from:', planFilePath);
                  } else {
                  // Check if this is a remote SSH session
                  const session = this.sessionStore.get(`sessions.${sessionId}`) as any;

                  if (session?.sshConfig) {
                    // Remote session: read plan file from remote server
                    console.log('[Claude Service] No cached plan for remote session - fetching from remote server');
                    try {
                      // Find the most recent plan file on the remote server
                      const remotePlansDir = '$HOME/.claude/plans';
                      const findCommand = `ls -t ${remotePlansDir}/*.md 2>/dev/null | head -1`;

                      const connectionInfo = sshService['connections'].get(sessionId);
                      if (!connectionInfo?.client) {
                        console.error('[Claude Service] No SSH connection available for session');
                        return {
                          behavior: 'deny' as const,
                          message: 'Plan approval failed: SSH connection not available to fetch remote plan.',
                        };
                      }

                      // Execute command to find most recent plan file
                      const findResult = await new Promise<string>((resolve, reject) => {
                        connectionInfo.client.exec(findCommand, (err: Error | undefined, stream: any) => {
                          if (err) {
                            reject(err);
                            return;
                          }

                          let output = '';
                          stream.on('data', (data: Buffer) => {
                            output += data.toString();
                          });
                          stream.on('close', () => {
                            resolve(output.trim());
                          });
                          stream.stderr.on('data', (data: Buffer) => {
                            console.error('[Claude Service] Remote find stderr:', data.toString());
                          });
                        });
                      });

                      if (!findResult) {
                        console.error('[Claude Service] No plan files found on remote server');
                        return {
                          behavior: 'deny' as const,
                          message: 'Plan approval failed: No plan files found on remote server.',
                        };
                      }

                      planFilePath = findResult;
                      console.log('[Claude Service] Found remote plan file:', planFilePath);

                      // Read the remote plan file
                      planContent = await sshService.readRemoteFile(sessionId, session.sshConfig, planFilePath);
                      console.log('[Claude Service] Successfully read remote plan, length:', planContent.length);
                    } catch (error) {
                      console.error('[Claude Service] Failed to read remote plan file:', error);
                      return {
                        behavior: 'deny' as const,
                        message: `Plan approval failed: Could not read remote plan file: ${error instanceof Error ? error.message : String(error)}`,
                      };
                    }
                  } else {
                    // Local session: Find the plan file that was written most recently
                    console.log('[Claude Service] No cached plan found for local session, scanning directory (this should not happen)');
                    const plansDir = path.join(os.homedir(), '.claude', 'plans');

                    if (fs.existsSync(plansDir)) {
                      const planFiles = fs.readdirSync(plansDir)
                        .filter(f => f.endsWith('.md'))
                        .map(f => ({
                          name: f,
                          path: path.join(plansDir, f),
                          mtime: fs.statSync(path.join(plansDir, f)).mtime.getTime(),
                        }))
                        .sort((a, b) => b.mtime - a.mtime);

                      if (planFiles.length > 0) {
                        planFilePath = planFiles[0].path;
                        planContent = fs.readFileSync(planFilePath, 'utf-8');
                      }
                    }
                  }
                  }
                }

                // If still no plan content, use a placeholder message
                if (!planContent) {
                  planContent = 'Plan content not found. The assistant wants to proceed with the implementation.';
                }

                if (planningState) {
                  const planBlocker = this.getAutoPlanningExitBlocker(planningState, planContent);
                  if (planBlocker) {
                    this.updateAutoPlanningState(sessionId, { status: 'interview' });
                    console.warn(`[Claude Service] Blocked broad Auto Build plan: ${planBlocker}`);
                    return {
                      behavior: 'deny' as const,
                      message: planBlocker,
                    };
                  }
                }

                // Get allowedPrompts from input if present
                const allowedPrompts = input.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined;

                // Ask user for approval
                this.updateAutoPlanningState(sessionId, {
                  status: 'awaiting-approval',
                  planFilePath: planFilePath || undefined,
                });
                const approved = await this.askPlanApproval(sessionId, planContent, planFilePath, allowedPrompts);

                if (approved) {
                  console.log('[Claude Service] Plan approved by user');
                  this.rememberApprovedPlan(sessionId, planContent, planFilePath, 'live');
                  this.applyPlanApprovalExecutionMode(sessionId);
                  if (selectionMode === 'auto') {
                    this.scheduleAutoPlanExecutionHandoff(sessionId, true);
                    console.log('[Claude Service] Plan approved — Auto will interrupt planning and re-route to the configured Execution model');
                  } else {
                    console.log('[Claude Service] Plan approved — switching to bypassPermissions mode for execution');
                  }

                  return { behavior: 'allow' as const, updatedInput: input };
                } else {
                  console.log('[Claude Service] Plan rejected by user');
                  this.updateAutoPlanningState(sessionId, { status: 'interview' });
                  // Clean up cached plan content
                  this.sessionPlanFiles.delete(sessionId);
                  this.sessionApprovedPlanFiles.delete(sessionId);
                  this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
                  this.sessionStore.delete(`harnessState.${sessionId}.approvedPlan`);

                  // Use custom feedback if provided, otherwise use default message
                  const planFeedback = this.lastPlanFeedback.get(sessionId);
                  const rejectionMessage = planFeedback
                    ? `Plan was not approved. User feedback: ${planFeedback}`
                    : 'Plan was not approved by the user. Please revise the plan based on user feedback.';

                  // Clear the feedback after using it
                  this.lastPlanFeedback.delete(sessionId);

                  return {
                    behavior: 'deny' as const,
                    message: rejectionMessage,
                  };
                }
              } catch (error) {
                console.error('[Claude Service] Error requesting plan approval:', error);
                if (this.getAutoPlanningState(sessionId)) {
                  this.updateAutoPlanningState(sessionId, { status: 'interview' });
                }
                return {
                  behavior: 'deny' as const,
                  message: error instanceof Error ? error.message : 'Failed to get plan approval',
                };
              }
            }

            // Check the CURRENT permission mode (may have changed via GREP IT! button)
            const currentPermissionMode = this.getSessionPermissionMode(sessionId) || autoBuildLeadPermissionMode;
            console.log(`[Claude Service] Permission check - initial mode: ${autoBuildLeadPermissionMode}, current mode: ${currentPermissionMode}`);

            // In plan mode, deny write operations
            if (currentPermissionMode === 'plan') {
              const writeTools = ['Write', 'Edit', 'Bash', 'NotebookEdit', 'TodoWrite'];
              if (writeTools.includes(toolName)) {
                if (this.getAutoPlanningState(sessionId) && this.isAutoPlanningSafeToolUse(toolName, input)) {
                  console.log(`[Claude Service] Auto pre-flight allowing scoped planning tool: ${toolName}`);
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                console.log(`[Claude Service] Plan mode - denying write tool: ${toolName}`);
                return {
                  behavior: 'deny' as const,
                  message: 'In plan mode, write operations are not permitted. Please exit plan mode to make changes.',
                };
              }
            }

            // In 'bypassPermissions' mode, allow everything without asking
            if (currentPermissionMode === 'bypassPermissions') {
              console.log(`[Claude Service] Bypass permissions mode - auto-allowing: ${toolName}`);
              return { behavior: 'allow' as const, updatedInput: input };
            }

            // In 'default' mode, ask user for permission on tools that modify filesystem
            // In 'acceptEdits' mode, only ask for Bash commands (edits are auto-approved)
            if (currentPermissionMode === 'default') {
              // Default mode: ask for permission on all modifying tools
              const modifyingTools = ['Write', 'Edit', 'Bash', 'NotebookEdit', 'MultiEdit'];
              if (modifyingTools.includes(toolName)) {
                try {
                  console.log(`[Claude Service] Asking user permission for: ${toolName}`);
                  const response = await this.askUserPermission(sessionId, toolName, input);
                  if (response.approved) {
                    return {
                      behavior: 'allow' as const,
                      updatedInput: response.modifiedInput || input,
                    };
                  } else {
                    return {
                      behavior: 'deny' as const,
                      message: 'User denied permission for this tool',
                    };
                  }
                } catch (error) {
                  console.error('[Claude Service] Error getting permission:', error);
                  return {
                    behavior: 'deny' as const,
                    message: error instanceof Error ? error.message : 'Failed to get permission response',
                  };
                }
              }
            } else if (currentPermissionMode === 'acceptEdits') {
              // Accept edits mode: only ask for Bash commands
              if (toolName === 'Bash') {
                try {
                  console.log(`[Claude Service] Asking user permission for Bash command`);
                  const response = await this.askUserPermission(sessionId, toolName, input);
                  if (response.approved) {
                    return {
                      behavior: 'allow' as const,
                      updatedInput: response.modifiedInput || input,
                    };
                  } else {
                    return {
                      behavior: 'deny' as const,
                      message: 'User denied permission for this command',
                    };
                  }
                } catch (error) {
                  console.error('[Claude Service] Error getting permission:', error);
                  return {
                    behavior: 'deny' as const,
                    message: error instanceof Error ? error.message : 'Failed to get permission response',
                  };
                }
              }
            }

            // ScheduleWakeup, CronCreate/Delete/List, RemoteTrigger, PushNotification:
            // Let the SDK handle these natively. The CLI manages its own timers,
            // cron jobs, and loop state. Intercepting them with 'deny' prevented
            // the SDK's internal loop from functioning (wakeups never fired).

            // For other tools or bypassPermissions mode, allow them
            // Must include updatedInput when allowing - SDK requires it
            return { behavior: 'allow' as const, updatedInput: input };
          },
        },
      });

      // Store the Query object so we can inject messages via streamInput
      this.activeQueryObjects.set(sessionId, messages);

      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      const contentBlocks: ContentBlock[] = []; // Track content blocks in order

      // Agent teams tracking — parent_tool_use_id identifies which agent is producing content
      // null = lead agent, string = a teammate spawned via TeammateTool
      let currentAgentId: string | undefined = undefined;
      const agentNames = new Map<string, string>(); // agentId -> descriptive name

      // Batching for stream events to reduce render overhead
      let textBuffer = '';
      let textBufferAgentId: string | undefined = undefined;
      let thinkingBuffer = '';
      let lastFlush = Date.now();
      const FLUSH_INTERVAL_MS = 100; // Batch updates every 100ms for smoother rendering

      const flushBuffers = (): StreamEvent[] => {
        const events: StreamEvent[] = [];

        if (textBuffer) {
          const agentId = textBufferAgentId;
          fullContent += textBuffer;
          const content = textBuffer;
          textBuffer = '';
          textBufferAgentId = undefined;

          // Add or extend text block in contentBlocks (only merge if same agent)
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock && lastBlock.type === 'text' && lastBlock.agentId === agentId) {
            lastBlock.text = (lastBlock.text || '') + content;
          } else {
            contentBlocks.push({ type: 'text', text: content, agentId });
          }

          events.push({ type: 'text_delta', content, agentId });
        }
        if (thinkingBuffer) {
          const content = thinkingBuffer;
          thinkingBuffer = '';
          events.push({ type: 'thinking_delta', content });
        }
        return events;
      };

      let queryComplete = false;
      let lastTerminalReason: string | undefined; // From SDK result message (v0.2.91+)
      let lastToolName: string | undefined; // Track last tool for analytics attribution
      // Context occupancy = input tokens of the LAST single API call. The result
      // message's usage is cumulative across every API call in the turn (cache
      // reads re-count the context on each call), so it cannot measure context.
      let lastApiCallContextTokens: number | undefined;
      // Use manual iterator instead of `for await` to avoid auto-closing the
      // iterator on break. The background task listener needs the iterator to
      // stay open so it can keep reading task events after the turn ends.
      const msgIterator = messages[Symbol.asyncIterator]();
      let iterResult = await msgIterator.next();
      while (!iterResult.done) {
        const msg = iterResult.value;
        if (abortController.signal.aborted) {
          yield { type: 'error', error: 'Query cancelled' };
          return;
        }

        if (STREAM_DEBUG) {
          console.log('[Claude SDK] Message:', msg.type, JSON.stringify(msg).slice(0, 200));
        }

        if (msg.type !== 'stream_event') {
          for (const event of flushBuffers()) {
            yield event;
          }
        }

        // Handle different message types from the SDK
        switch (msg.type) {
          case 'system': {
            // System messages can have different subtypes
            const subtype = (msg as any).subtype;
            if (subtype && subtype !== 'status' && !NOISY_SDK_SYSTEM_SUBTYPES.has(subtype)) {
              console.log('[Claude SDK] System message subtype:', subtype, JSON.stringify(msg).slice(0, 300));
            } else if (STREAM_DEBUG && subtype) {
              console.log('[Claude SDK] System message subtype:', subtype, JSON.stringify(msg).slice(0, 300));
            }
            const systemMsg = msg as SDKMessage & {
              subtype?: string;
              session_id?: string;
              tools?: string[];
              model?: string;
              status?: string | null;
              attempt?: number;
              max_retries?: number;
              retry_delay_ms?: number;
              error?: string;
              error_status?: string | number;
              compact_metadata?: {
                trigger: 'manual' | 'auto';
                pre_tokens: number;
              };
            };

            // Claude SDK emits api_retry while it is waiting on 529/rate-limit
            // backoff. Surface it through the visible thinking stream; systemInfo
            // messages are not rendered in chat.
            if (systemMsg.subtype === 'api_retry') {
              const retryDelaySeconds = typeof systemMsg.retry_delay_ms === 'number'
                ? Math.ceil(systemMsg.retry_delay_ms / 1000)
                : undefined;
              const attemptLabel = systemMsg.attempt && systemMsg.max_retries
                ? `${systemMsg.attempt}/${systemMsg.max_retries}`
                : systemMsg.attempt
                  ? `${systemMsg.attempt}`
                  : 'pending';
              const cause = systemMsg.error_status || systemMsg.error || 'API retry';
              const wait = retryDelaySeconds ? `; retrying in ${retryDelaySeconds}s` : '';
              const retryMessage = `Claude API retry ${attemptLabel} (${cause})${wait}.\n`;
              console.warn(`[Claude SDK] ${retryMessage.trim()}`);
              yield { type: 'thinking_delta', content: retryMessage };
              break;
            }

            // Handle compaction status changes (subtype: 'status')
            if (systemMsg.subtype === 'status') {
              // "requesting" = waiting for API slot (rate limited or queued)
              if (systemMsg.status === 'requesting') {
                if (this.shouldEmitSdkStatusNotice(sessionId, 'requesting')) {
                  console.log('[Claude SDK] Status: requesting (waiting for API)');
                  yield { type: 'thinking_delta', content: 'Claude is waiting for an API slot.\n' };
                }
                break;
              }
              const isCompacting = systemMsg.status === 'compacting';
              if (this.shouldEmitSdkStatusNotice(sessionId, `compaction:${isCompacting ? 'on' : 'off'}`)) {
                console.log('[Claude SDK] Compaction status:', isCompacting ? 'COMPACTING' : 'idle');
              }

              const compactionStatus: CompactionStatus = {
                sessionId,
                isCompacting,
              };

              // Emit to renderer via IPC
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, compactionStatus);
              }

              yield {
                type: 'compaction_status',
                compactionStatus,
              };
              break;
            }

            // Handle compaction complete (subtype: 'compact_boundary')
            if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
              console.log('[Claude SDK] Compaction complete:', systemMsg.compact_metadata);

              // Clear the cached context percentage so future turns do not skip
              // SDK resume based on stale pre-compaction values. The real
              // percentage will be set on the next turn's result message.
              this.sessionContextPercentage.delete(sessionId);
              this.sessionStore.delete(`contextUsage.${sessionId}`);
              console.log(`[Claude SDK] Cleared context percentage for ${sessionId.substring(0, 8)} after compaction`);

              const compactionComplete: CompactionComplete = {
                sessionId,
                preTokens: systemMsg.compact_metadata.pre_tokens,
              };

              // Emit to renderer via IPC
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, compactionComplete);
              }

              yield {
                type: 'compaction_complete',
                compactionComplete,
              };
              break;
            }

            if (this.forwardTaskSystemMessage(sessionId, systemMsg)) {
              break;
            }

            // Default system message handling (tool/model info)
            // Store the SDK session ID for future resume calls in separate mappings object
            const canonicalSdkSessionId = this.rememberCanonicalSdkSessionId(sessionId, systemMsg, 'stream');
            if (canonicalSdkSessionId) {

              // Fetch session summary from SDK and use as display name.
              // Fire-and-forget — NEVER await inside the streaming generator or it
              // blocks the entire real-time pipeline while reading remote state.
              (async () => {
                try {
                  const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
                  if (hasExistingSessionTitle(sessionId, currentSession)) {
                    return;
                  }
                  // eslint-disable-next-line @typescript-eslint/no-var-requires
                  const { getSessionInfo } = require('@anthropic-ai/claude-agent-sdk') as { getSessionInfo: (id: string, opts?: { dir?: string }) => Promise<{ summary?: string } | undefined> };
                  const info = await getSessionInfo(canonicalSdkSessionId, { dir: projectPath || process.cwd() });
                  const summary = sanitizeSessionTitle(info?.summary);
                  if (hasExistingSessionTitle(sessionId, currentSession)) {
                    return;
                  }
                  if (summary) {
                    const storedSummary = rememberAutoSessionTitle(sessionId, summary, 'sdk-summary');
                    if (!storedSummary) return;
                    if (currentSession) {
                      this.sessionStore.set(`sessions.${sessionId}`, {
                        ...currentSession,
                        name: storedSummary,
                        aiGeneratedName: storedSummary,
                        autoTitleGeneratedAt: new Date().toISOString(),
                      });
                    }
                    console.log(`[Claude SDK] Session name from SDK: "${summary}"`);
                    this.onSessionNameChanged?.();
                  }
                } catch { /* non-fatal */ }
              })();

              // After an SSH fork query, clear the forkFromSdkSessionId flag so
              // subsequent messages don't keep passing --fork-session. Also update
              // the session object so getMessages() uses the new SDK session ID.
              const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
              if (currentSession && (currentSession as any).forkFromSdkSessionId) {
                const { forkFromSdkSessionId: _, ...cleanSession } = currentSession as any;
                this.sessionStore.set(`sessions.${sessionId}`, { ...cleanSession, sdkSessionId: canonicalSdkSessionId });
                console.log(`[Claude SDK] SSH fork complete — cleared forkFromSdkSessionId, new SDK ID: ${canonicalSdkSessionId}`);
              }
            }

            yield {
              type: 'system',
              systemInfo: {
                tools: systemMsg.tools || [],
                model: systemMsg.model || '',
              },
            };
            break;
          }

          case 'assistant': {
            // Full assistant message - only process tool_use blocks here
            // Text and thinking are handled via stream_event for real-time streaming
            const assistantMsg = msg as SDKMessage & { parent_tool_use_id?: string | null; message?: { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown> }>; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } };

            // Track which agent is producing this content
            currentAgentId = assistantMsg.parent_tool_use_id || undefined;

            // Top-level assistant calls carry per-API-call usage: the context
            // this single call read. Subagent calls have their own contexts.
            if (!assistantMsg.parent_tool_use_id && assistantMsg.message?.usage) {
              const callUsage = assistantMsg.message.usage;
              const callTokens = (callUsage.input_tokens || 0)
                + (callUsage.cache_creation_input_tokens || 0)
                + (callUsage.cache_read_input_tokens || 0);
              if (callTokens > 0) {
                lastApiCallContextTokens = callTokens;
              }
            }

            if (assistantMsg.message?.content) {
              // Log all block types to debug tool detection
              if (STREAM_DEBUG) {
                const blockTypes = assistantMsg.message.content.map(b => `${b.type}${b.type === 'tool_use' ? ':' + (b.name || '?') : ''}`).join(', ');
                console.log('[Claude SDK] Assistant content blocks:', blockTypes);
              }

              for (const block of assistantMsg.message.content) {
                if (block.type === 'text' && block.text) {
                  // Only use assistant message text if we somehow missed it in stream_event
                  // This can happen if includePartialMessages doesn't capture everything
                  if (block.text.length > fullContent.length) {
                    const newContent = block.text.slice(fullContent.length);
                    fullContent = block.text;
                    yield { type: 'text_delta', content: newContent };
                  }
                } else if (block.type === 'tool_use') {
                  // Only create tool call if we have a valid name and haven't seen it
                  if (!block.name) {
                    continue;
                  }

                  // Check if we already have this tool call (from stream_event)
                  const existingTool = toolCalls.find(tc => tc.id === block.id);
                  if (!existingTool) {
                    const toolCall: ToolCall = {
                      id: block.id || '',
                      name: block.name,
                      input: block.input || {},
                      status: 'running',
                      startedAt: new Date(),
                      agentId: currentAgentId,
                    };
                    toolCalls.push(toolCall);
                    lastToolName = toolCall.name;
                    // Add tool_use content block to track order
                    contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                    yield { type: 'tool_use', toolCall, agentId: currentAgentId };
                  } else {
                    // Update existing tool call with complete input from full assistant message
                    // stream_event often fires with empty input, this has the complete data
                    if (block.input && Object.keys(block.input).length > 0) {
                      existingTool.input = block.input;
                      // Emit tool_use again to trigger UI update with complete input
                      yield { type: 'tool_use', toolCall: existingTool, agentId: currentAgentId };
                    }
                  }
                }
                // Note: thinking blocks from assistant message are ignored here
                // They should already have been streamed via stream_event thinking_delta
              }
            }
            break;
          }

          case 'stream_event': {
            // Partial/streaming message events - includes thinking deltas and tool use starts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const streamMsg = msg as SDKMessage & { event?: any; parent_tool_use_id?: string | null };

            // Track which agent is producing this stream content
            currentAgentId = streamMsg.parent_tool_use_id || undefined;

            if (streamMsg.event) {
              const event = streamMsg.event;

              if (event.type === 'content_block_delta' && event.delta) {
                if (event.delta.type === 'text_delta' && event.delta.text) {
                  if (textBuffer && textBufferAgentId !== currentAgentId) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = Date.now();
                  }
                  // Buffer text deltas for batching
                  textBufferAgentId = currentAgentId;
                  textBuffer += event.delta.text;

                  // Flush if enough time has passed or buffer is large
                  const now = Date.now();
                  if (now - lastFlush >= FLUSH_INTERVAL_MS || textBuffer.length >= 100) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = now;
                  }
                } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                  // Buffer thinking deltas for batching
                  thinkingBuffer += event.delta.thinking;

                  // Flush if enough time has passed or buffer is large
                  const now = Date.now();
                  if (now - lastFlush >= FLUSH_INTERVAL_MS || thinkingBuffer.length >= 100) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = now;
                  }
                } else {
                  // Tool input JSON deltas can run for a long time without text.
                  // Flush any visible text/thinking before those otherwise-invisible
                  // events so SSH sessions don't appear stalled until the final result.
                  for (const flushed of flushBuffers()) {
                    yield flushed;
                  }
                }
              } else if (event.type === 'content_block_start' && event.content_block) {
                for (const flushed of flushBuffers()) {
                  yield flushed;
                }

                // Handle tool use start events from streaming
                if (event.content_block.type === 'tool_use' && event.content_block.name) {
                  // Check if we already have this tool call (from assistant message)
                  const existingTool = toolCalls.find(tc => tc.id === event.content_block.id);
                  if (!existingTool) {
                    if (STREAM_DEBUG) {
                      console.log('[Claude SDK] Tool start:', event.content_block.name, currentAgentId ? `(agent: ${currentAgentId.slice(0, 8)})` : '(lead)');
                    }
                    const toolCall: ToolCall = {
                      id: event.content_block.id || `tool-${Date.now()}`,
                      name: event.content_block.name,
                      input: event.content_block.input || {},
                      status: 'running',
                      startedAt: new Date(),
                      agentId: currentAgentId,
                    };
                    toolCalls.push(toolCall);
                    // Add tool_use content block to track order
                    contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                    yield { type: 'tool_use', toolCall, agentId: currentAgentId };
                  }
                }
              } else if (
                event.type === 'content_block_stop'
                || event.type === 'message_delta'
                || event.type === 'message_stop'
              ) {
                for (const flushed of flushBuffers()) {
                  yield flushed;
                }
              }
            }
            break;
          }

          case 'tool_progress': {
            // Tool execution progress - may contain tool details we need
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const progressMsg = msg as SDKMessage & { tool_use_id?: string; tool_name?: string; parent_tool_use_id?: string | null; content?: any; elapsed_time_seconds?: number; task_id?: string };
            if (STREAM_DEBUG) {
              console.log('[Claude SDK] Tool progress:', JSON.stringify(progressMsg).slice(0, 300));
            }

            // Emit tool progress to renderer for MonitorBlock + BackgroundTasksBlock
            if (this.mainWindow && progressMsg.tool_use_id) {
              this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
                sessionId,
                taskId: progressMsg.task_id,
                toolUseId: progressMsg.tool_use_id,
                toolName: progressMsg.tool_name,
                elapsedSeconds: progressMsg.elapsed_time_seconds,
              });
            }

            // Track agent from tool_progress messages too
            const progressAgentId = progressMsg.parent_tool_use_id || undefined;

            // Check if this has tool information we should capture
            if (progressMsg.tool_name && progressMsg.tool_use_id) {
              const existingTool = toolCalls.find(tc => tc.id === progressMsg.tool_use_id);
              if (!existingTool) {
                if (STREAM_DEBUG) {
                  console.log('[Claude SDK] Tool from progress:', progressMsg.tool_name, progressAgentId ? `(agent: ${progressAgentId.slice(0, 8)})` : '(lead)');
                }
                const toolCall: ToolCall = {
                  id: progressMsg.tool_use_id,
                  name: progressMsg.tool_name,
                  input: {},
                  status: 'running',
                  startedAt: new Date(),
                  agentId: progressAgentId,
                };
                toolCalls.push(toolCall);
                // Add tool_use content block to track order
                contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: progressAgentId });
                yield { type: 'tool_use', toolCall, agentId: progressAgentId };
              }
            }
            break;
          }

          case 'user': {
            // User message (tool results)
            const userMsg = msg as SDKMessage & { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string }> } };
            if (userMsg.message?.content) {
              for (const block of userMsg.message.content) {
                if (block.type === 'tool_result') {
                  const content = block.content || '';

                  // Check if tool requires approval
                  if (typeof content === 'string' && content.includes('requires approval')) {
                    const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                    if (toolCall) {
                      // Emit permission request to renderer
                      yield {
                        type: 'permission_request',
                        sessionId,
                        requestId: block.tool_use_id || '',
                        toolName: toolCall.name,
                        toolInput: toolCall.input,
                        approvalMessage: content,
                      };
                      continue;
                    }
                  }

                  // Find and update the corresponding tool call
                  const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                  if (toolCall) {
                    const normalizedCompletedTool = toolCall.name.toLowerCase().replace(/[_-]/g, '');
                    const approvedExecutionHandoff = normalizedCompletedTool === 'exitplanmode'
                      && this.pendingAutoPlanExecutionHandoffs.has(sessionId);
                    toolCall.status = 'completed';
                    // Interrupting the planner immediately after approval makes
                    // Claude emit a stock "tool rejected" result even though
                    // the user approved it. Preserve the true state in the UI.
                    toolCall.result = approvedExecutionHandoff
                      ? 'Plan approved. Handing off to the configured Execution model.'
                      : content;
                    toolCall.completedAt = new Date();
                    yield { type: 'tool_result', toolCall, result: toolCall.result };

                    // Check if this is a Write tool call to a plan file
                    if (toolCall.name === 'Write') {
                      const filePath = toolCall.input?.file_path as string;
                      const plansDir = path.join(os.homedir(), '.claude', 'plans');
                      if (filePath && filePath.startsWith(plansDir) && filePath.endsWith('.md')) {
                        // Read the plan file and emit plan_content event
                        try {
                          const planContent = fs.readFileSync(filePath, 'utf-8');
                          console.log(`[Claude Service] Plan file written: ${filePath}`);

                          // Cache the plan content for this session (for later ExitPlanMode use)
                          this.sessionPlanFiles.set(sessionId, { content: planContent, filePath });
                          this.sessionApprovedPlanFiles.delete(sessionId);
                          this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
                          this.sessionStore.delete(`harnessState.${sessionId}.approvedPlan`);

                          // Emit to renderer via IPC
                          if (this.mainWindow) {
                            this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PLAN_CONTENT, {
                              sessionId,
                              planContent,
                              planFilePath: filePath,
                            });
                          }

                          yield { type: 'plan_content', sessionId, planContent, planFilePath: filePath };
                        } catch (err) {
                          console.error(`[Claude Service] Failed to read plan file: ${err}`);
                        }
                      }
                    }
                  }
                }
              }
            }
            break;
          }

          case 'rate_limit_event': {
            const rlMsg = msg as SDKMessage & { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } };
            const info = rlMsg.rate_limit_info;
            if (info?.status === 'rejected') {
              console.warn(`[Claude SDK] Rate limited (${info?.rateLimitType}) — will auto-retry in 10s`);
              pendingRateLimitRetry = true;
              yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
            }
            break;
          }

          case 'result': {
            // Result message may contain errors from the API
            const resultMsg = msg as SDKMessage & { is_error?: boolean; result?: string };
            const autoPlanExecutionHandoffPending = this.pendingAutoPlanExecutionHandoffs.has(sessionId);

            // Check for empty text content blocks error
            if (resultMsg.is_error && resultMsg.result?.includes('text content blocks must be non-empty')) {
              console.error('[Claude SDK] Empty text content blocks detected in transcript for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              // Attempt to repair the transcript by removing entries with empty text
              const repaired = await this.repairEmptyTextBlocks(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ Empty text content was found in the session transcript. The transcript has been repaired - please try sending your message again.'
                };
              } else {
                // If repair failed, clear SDK session ID to start fresh
                this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
                yield {
                  type: 'error',
                  error: 'Session transcript was corrupted with empty content. Please try sending your message again - a fresh session will be started.'
                };
              }
              return;
            }

            // Check for thinking blocks corruption error
            if (resultMsg.is_error && resultMsg.result?.includes('thinking or redacted_thinking blocks')) {
              console.error('[Claude SDK] Thinking blocks corrupted in transcript for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              // Attempt to repair the transcript
              const repaired = await this.repairCorruptedTranscript(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ Thinking blocks were corrupted in the session transcript. The transcript has been repaired by removing the corrupted entries. Please try sending your message again.'
                };
              } else {
                // If repair failed, clear SDK session ID to start fresh
                this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
                yield {
                  type: 'error',
                  error: '⚠️ Thinking blocks were corrupted in the session transcript. Could not repair automatically - starting a fresh session. Please try sending your message again.'
                };
              }
              return;
            }

            // Check for "Prompt is too long" error - this means conversation is ALREADY too long
            // By this point, compaction will also fail. We need to ask user to rewind.
            if (resultMsg.is_error && resultMsg.result?.toLowerCase().includes('prompt is too long')) {
              console.error('[Claude SDK] Conversation too long - compaction will also fail at this point');

              yield {
                type: 'error',
                error: '❌ Your conversation history has exceeded the maximum length. Compaction cannot run at this point. Please use the /rewind command to go back a few messages and try again, or start a new session.'
              };
              return;
            }

            // Check for compaction failure error (conversation already too long for compaction)
            if (resultMsg.is_error && resultMsg.result?.toLowerCase().includes('conversation too long')) {
              console.error('[Claude SDK] Conversation too long for compaction');

              yield {
                type: 'error',
                error: '❌ Your conversation history is too long to compact. Please use the /rewind command to go back a few messages, or start a new session.'
              };
              return;
            }

            // Check for image size errors - auto-rewind past the problematic message
            if (resultMsg.is_error && (resultMsg.result?.includes('exceed max allowed size') || resultMsg.result?.includes('exceeds the dimension limit'))) {
              console.error('[Claude SDK] Image size error detected, attempting auto-repair for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              const repaired = await this.repairOversizedImages(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ An image in the conversation was too large. The problematic message has been removed. Please try again.'
                };
              } else {
                // Repair failed (e.g. SSH session where transcript is remote) — clear SDK session to start fresh
                console.log('[Claude SDK] Repair failed, clearing SDK session to start fresh for:', sessionId);
                this.clearSdkSessionId(sessionId);
                yield {
                  type: 'error',
                  error: '⚠️ An image in the conversation history was too large. Starting fresh conversation — please try your message again.'
                };
              }
              return;
            }

            // Stale session ID — remote conversation was lost (OOM/crash/cleanup).
            // Auto-heal: clear the dead ID and retry the message immediately as a
            // fresh session so the user never sees a failure.
            if (resultMsg.is_error && resultMsg.result?.includes('No conversation found with session ID')) {
              console.error('[Claude SDK] Stale session ID — auto-healing:', resultMsg.result);
              this.clearSdkSessionId(sessionId);
              yield { type: 'text_delta', content: '⚠️ Remote session expired — reconnecting automatically...\n\n' };
              // Pass selectedModel to skip re-routing on retry (same fix as stale-zero-token path)
              yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, selectedModel, gstackMode, supplementalMessages, fastMode, cascadeMode);
              return;
            }

            // Rate limit auto-retry: wait 10s then resend
            if (resultMsg.is_error && (pendingRateLimitRetry || resultMsg.result?.match(/rate.?limit|429|too many requests|overloaded/i))) {
              console.log('[Claude SDK] Rate limit auto-retry: waiting 10s');
              if (!pendingRateLimitRetry) {
                yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
              }
              await new Promise(r => setTimeout(r, 10000));
              if (abortController.signal.aborted) return;
              yield { type: 'text_delta', content: '🔄 Retrying...\n\n' };
              yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, selectedModel, gstackMode, supplementalMessages, fastMode, cascadeMode);
              return;
            }

            // Check for other API errors
            if (resultMsg.is_error && resultMsg.result && !autoPlanExecutionHandoffPending) {
              this.recordAutoBuildLeadFailure(sessionId, autoOrchestrationPlan, resultMsg.result);
              yield { type: 'error', error: resultMsg.result };
              return;
            }

            // Final result message with cost info - this marks end of query
            // Flush any remaining buffered content
            for (const flushed of flushBuffers()) {
              yield flushed;
            }

            // Extract terminal_reason from result message (SDK v0.2.91+)
            // Indicates why the query loop terminated (e.g. 'completed', 'max_turns', 'aborted_tools', etc.)
            const resultWithReason = resultMsg as SDKMessage & { terminal_reason?: TerminalReason };
            if (resultWithReason.terminal_reason) {
              console.log(`[Claude SDK] Terminal reason: ${resultWithReason.terminal_reason}`);
            }

            // Track token usage and send to renderer
            // Total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
            const successResult = resultMsg as SDKMessage & { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; model?: string };
            if (successResult.usage) {
              const inputTokens = (successResult.usage.input_tokens || 0)
                + (successResult.usage.cache_creation_input_tokens || 0)
                + (successResult.usage.cache_read_input_tokens || 0);
              const outputTokens = successResult.usage.output_tokens || 0;
              const currentModel = successResult.model || selectedModel || 'claude-opus-4-6';
              const contextWindowSize = this.getContextWindowSize(currentModel);

              if (
                effectiveSdkSessionId
                && inputTokens === 0
                && outputTokens === 0
                && !fullContent.trim()
                && toolCalls.length === 0
                && !autoPlanExecutionHandoffPending
              ) {
                // An aborted/superseded turn (queue drain, rapid re-send) also
                // surfaces as an empty zero-token result. That is NOT a stale
                // session — clearing it would orphan a healthy conversation.
                if (abortController.signal.aborted) {
                  console.warn(`[Claude SDK] Resume ${effectiveSdkSessionId} returned empty result but turn was aborted/superseded — keeping SDK session`);
                  return;
                }
                // First strike: retry the resume as-is. Transient failures
                // (bridge races, pool-slot recycling mid-turn) recover here
                // without losing the native conversation chain.
                const lastEmptyRetryAt = this.resumeEmptyRetryAt.get(sessionId) || 0;
                if (Date.now() - lastEmptyRetryAt > 120000) {
                  this.resumeEmptyRetryAt.set(sessionId, Date.now());
                  console.warn(`[Claude SDK] Resume ${effectiveSdkSessionId} completed with empty zero-token result — retrying resume once before declaring stale`);
                  yield { type: 'text_delta', content: '⚠️ Remote session hiccup — retrying...\n\n' };
                  yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, selectedModel, gstackMode, supplementalMessages, fastMode, cascadeMode);
                  return;
                }
                // Second strike within 2 minutes: genuinely stale. Clear and
                // restart fresh — the baseline mechanism re-injects the full
                // Build transcript so no context is lost.
                this.resumeEmptyRetryAt.delete(sessionId);
                console.warn(`[Claude SDK] Resume ${effectiveSdkSessionId} empty twice — clearing stale SDK session and retrying fresh`);
                this.clearSdkSessionId(sessionId);
                yield { type: 'text_delta', content: '⚠️ Remote session handle was stale — reconnecting automatically...\n\n' };
                // Pass selectedModel (the auto-router's resolved model) instead of
                // 'auto' to skip re-routing on retry. The auto-router already chose
                // Claude; re-running it wastes time and, critically, means the retry
                // goes through a different code path that can lose cross-harness
                // context vs the explicit-model path (which always works).
                yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, selectedModel, gstackMode, supplementalMessages, fastMode, cascadeMode);
                return;
              }

              // Turn produced real output — clear the empty-result strike so a
              // later hiccup gets its resume-intact retry instead of escalating
              // straight to a fresh restart.
              this.resumeEmptyRetryAt.delete(sessionId);

              // Context occupancy comes from the last single API call, NOT the
              // cumulative result usage (which re-counts cache reads per call
              // and can exceed the window several times over).
              const contextTokens = lastApiCallContextTokens ?? inputTokens;
              const percentage = Math.round((contextTokens / contextWindowSize) * 100);
              console.log(`[Claude SDK] Context tokens: ${contextTokens}/${contextWindowSize} (${percentage}%), cumulative turn tokens: ${inputTokens}`);
              this.rememberSessionContextUsage(sessionId, contextTokens, contextWindowSize, percentage);

              if (contextTokens >= contextWindowSize * 0.75) {
                console.warn(`[Claude SDK] ⚠️ Conversation approaching context limit: ${percentage}%`);
              }

              // Fetch rich context usage breakdown from SDK (v0.2.86+)
              // Provides per-category token counts (system prompt, tools, messages, MCP, etc.)
              // Fetch rich context usage breakdown — but NOT on SSH sessions.
              // getContextUsage() sends a request to the Claude Code process over
              // stdin/stdout. On SSH, this hangs indefinitely (the response gets
              // lost in the transport), blocking the entire stream pipeline.
              let contextUsageBreakdown: Record<string, unknown> | undefined;
              if (!session?.sshConfig) {
                try {
                  const queryObj = this.activeQueryObjects.get(sessionId);
                  if (queryObj) {
                    const richUsage = await Promise.race([
                      queryObj.getContextUsage(),
                      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getContextUsage timeout')), 5000)),
                    ]);
                    contextUsageBreakdown = richUsage as unknown as Record<string, unknown>;
                    console.log(`[Claude SDK] Rich context usage: ${richUsage.totalTokens}/${richUsage.maxTokens} (${richUsage.percentage}%) across ${richUsage.categories.length} categories`);
                    // Most accurate context reading available — prefer it over
                    // the per-call estimate for resume gating.
                    if (typeof richUsage.totalTokens === 'number' && typeof richUsage.maxTokens === 'number' && richUsage.maxTokens > 0) {
                      this.rememberSessionContextUsage(
                        sessionId,
                        richUsage.totalTokens,
                        richUsage.maxTokens,
                        Math.round(typeof richUsage.percentage === 'number' ? richUsage.percentage : (richUsage.totalTokens / richUsage.maxTokens) * 100),
                      );
                    }
                  }
                } catch (ctxErr) {
                  console.warn('[Claude SDK] getContextUsage() failed, using basic token counts:', ctxErr);
                }
              }

              // Record analytics event for cost tracking
              const cacheReadTokens = successResult.usage.cache_read_input_tokens || 0;
              const cacheWriteTokens = successResult.usage.cache_creation_input_tokens || 0;
              const cost = estimateCost(currentModel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
              const baselineCost = estimateBaselineCost(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
              const tokenEvent = {
                sessionId,
                sessionName: session?.name || sessionId,
                timestamp: Date.now(),
                model: currentModel,
                harness: this.getHarnessFromModel(currentModel),
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                toolName: lastToolName,
                estimatedCostUsd: cost,
                baselineCostUsd: baselineCost,
                savingsVsBaselineUsd: Math.max(0, baselineCost - cost),
                costMethod: 'estimated' as const,
              };
              analyticsService.recordTokenEvent(tokenEvent);
              analyticsService.recordHarnessOutcome({
                sessionId,
                timestamp: Date.now(),
                harness: this.getHarnessFromModel(currentModel),
                model: currentModel,
                success: true,
                taskTier: autoRoutedTier,
                taskDomain: autoRoutedDomain,
                tokens: inputTokens + outputTokens,
                costUsd: cost,
              });
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.ANALYTICS_TOKEN_EVENT, tokenEvent);
              }

              // Send context usage to renderer for display (enhanced with rich breakdown when available)
              yield {
                type: 'context_usage',
                inputTokens,
                outputTokens,
                contextWindowSize,
                percentage,
                estimatedCostUsd: cost,
                ...(contextUsageBreakdown ? { contextUsageBreakdown } : {}),
              } as StreamEvent & { inputTokens: number; outputTokens?: number; contextWindowSize: number; percentage: number; estimatedCostUsd?: number; contextUsageBreakdown?: Record<string, unknown> };
            }

            // Store terminal_reason for inclusion in the message_complete event
            if (resultWithReason.terminal_reason) {
              lastTerminalReason = resultWithReason.terminal_reason;
            }

            // Mark query as complete so we exit the loop
            // (For SSH sessions, the process stays alive for next query, so iterator won't close naturally)
            queryComplete = true;
            break;
          }

          default:
            if (this.forwardTaskSystemMessage(sessionId, msg)) {
              break;
            }
            // Log unhandled types so we can catch notifications/monitors we're missing
            if (STREAM_DEBUG || (msg as any).subtype === 'notification' || (msg as any).subtype === 'task_notification' || (msg as any).subtype === 'task_progress' || (msg as any).subtype === 'task_started') {
              console.log('[Claude SDK] Unhandled message type:', msg.type, 'subtype:', (msg as any).subtype, JSON.stringify(msg).slice(0, 200));
            }
            break;
        }

        // If query is complete (result message received), exit the main loop
        // but start a background listener for task events from running monitors/agents
        if (queryComplete) {
          console.log('[Claude SDK] Query complete, exiting message loop');
          // Keep the Query object available while the iterator remains alive.
          // Background task events can continue after the result message, and
          // queued user follow-ups should still be able to enter Claude Code via
          // Query.streamInput instead of waiting behind the monitor/agent loop.

          // Keep reading from the iterator in the background for task lifecycle events.
          // The CC process stays alive between turns (especially SSH sessions), so
          // background tasks (Monitor, Agent) continue producing task_updated,
          // task_notification, and task_progress events after the assistant's turn ends.
          // Pass the raw iterator (NOT the Query) so it stays open.
          if (!this.pendingAutoPlanExecutionHandoffs.has(sessionId)) {
            this.startBackgroundTaskListener(sessionId, msgIterator, abortController.signal);
          }
          break;
        }
        iterResult = await msgIterator.next();
      }

      if (await this.consumeAutoPlanExecutionHandoff(sessionId, abortController)) {
        // Retire the planning Query before recursively entering Auto. The turn
        // lock is re-entrant for streamMessage, while controller identity keeps
        // the outer finally block from clearing the new execution query.
        yield* this.streamMessage(
          sessionId,
          'Execute the approved plan now.',
          attachments,
          'bypassPermissions',
          undefined,
          'auto',
          gstackMode,
          supplementalMessages,
          fastMode,
          cascadeMode,
        );
        return;
      }

      // Detect abnormal stream termination (e.g., remote process killed externally)
      // If the message loop exits without receiving a 'result' message, the remote
      // process likely died. Emit an error so the UI doesn't hang on "thinking...".
      if (!queryComplete && session?.sshConfig) {
        console.error('[Claude SDK] Stream ended without result message — remote process may have died');
        this.recordAutoBuildLeadFailure(sessionId, autoOrchestrationPlan, 'Remote session disconnected before Claude SDK returned a result message.');
        yield { type: 'error', error: 'Remote session disconnected. The remote process may have stopped. Try sending your message again to reconnect.' };
        return;
      }

      // Final flush before creating message
      for (const flushed of flushBuffers()) {
        yield flushed;
      }

      this.recordAutoBuildLeadSuccess(sessionId, autoOrchestrationPlan);
      this.rememberLastAssistantHarness(sessionId, this.getHarnessFromModel(selectedModel), selectedModel);

      const projectPathForStages = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || process.cwd();
      for await (const stageEvent of this.streamAutoBuildStages(
        sessionId,
        session,
        autoOrchestrationPlan,
        userMessage,
        fullContent,
        projectPathForStages,
        normalizedSupplementalMessages,
        delegateOrchestrationContext,
        sdkPermissionMode,
        secureEnvContext,
        abortController.signal,
        autoRoutedDomain,
      )) {
        if (stageEvent.type === 'text_delta') {
          const content = stageEvent.content || '';
          fullContent += content;
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock && lastBlock.type === 'text' && lastBlock.agentId === stageEvent.agentId) {
            lastBlock.text = (lastBlock.text || '') + content;
          } else {
            contentBlocks.push({ type: 'text', text: content, agentId: stageEvent.agentId });
          }
        } else if (stageEvent.type === 'tool_use' && stageEvent.toolCall) {
          const existingTool = toolCalls.find(tc => tc.id === stageEvent.toolCall?.id);
          if (!existingTool) {
            toolCalls.push(stageEvent.toolCall);
            contentBlocks.push({ type: 'tool_use', toolCallId: stageEvent.toolCall.id, agentId: stageEvent.agentId });
          }
        } else if (stageEvent.type === 'tool_result' && stageEvent.toolCall) {
          const existingTool = toolCalls.find(tc => tc.id === stageEvent.toolCall?.id);
          if (existingTool) {
            Object.assign(existingTool, stageEvent.toolCall);
          } else {
            toolCalls.push(stageEvent.toolCall);
          }
        }

        yield stageEvent;
      }

      // Post-process content blocks to merge adjacent text blocks only
      // We keep text and tool_use blocks in their natural order, just combining
      // consecutive text blocks that might have been split during streaming
      const mergedBlocks: ContentBlock[] = [];
      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];
        const lastMerged = mergedBlocks[mergedBlocks.length - 1];

        if (block.type === 'text') {
          const text = block.text || '';

          // Only merge with immediately preceding text block from the SAME agent (not across tools or agent boundaries)
          if (lastMerged?.type === 'text' && lastMerged.agentId === block.agentId) {
            lastMerged.text = (lastMerged.text || '') + text;
          } else {
            mergedBlocks.push({ ...block });
          }
        } else {
          // tool_use block - add as-is
          mergedBlocks.push({ ...block });
        }
      }

      // Create final message with contentBlocks for interleaved rendering
      const message: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: fullContent,
        contentBlocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: new Date(),
        harness: this.getHarnessFromModel(selectedModel),
      };

      yield { type: 'message_complete', message, resolvedModel: selectedModel, ...(lastTerminalReason ? { terminalReason: lastTerminalReason } : {}) };
    } catch (error) {
      // Some SDK versions end interrupt() by rejecting the iterator instead of
      // returning a terminal result. Approval is still authoritative: retire
      // the planning runtime and continue the same visible stream in Auto Build.
      if (await this.consumeAutoPlanExecutionHandoff(sessionId, abortController)) {
        yield* this.streamMessage(
          sessionId,
          'Execute the approved plan now.',
          attachments,
          'bypassPermissions',
          undefined,
          'auto',
          gstackMode,
          supplementalMessages,
          fastMode,
          cascadeMode,
        );
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Claude SDK] streamMessage error caught:', errorMessage);

      // Check if this is the thinking blocks corruption error
      if (errorMessage.includes('thinking or redacted_thinking blocks') ||
          errorMessage.includes('cannot be modified')) {
        console.error('[Claude SDK] Thinking blocks corrupted (caught in exception):', sessionId);
        const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

        // Attempt to repair the transcript
        const repaired = await this.repairCorruptedTranscript(sessionId, sdkSessionId);

        if (repaired) {
          yield {
            type: 'error',
            error: '⚠️ Session had corrupted thinking data. The transcript has been repaired - please try your message again.'
          };
        } else {
          // If repair failed, clear SDK session ID to start fresh
          this.clearSdkSessionId(sessionId);
          yield {
            type: 'error',
            error: '⚠️ Session had corrupted thinking data. Starting fresh session - please try your message again.'
          };
        }
      } else if (errorMessage.includes('No conversation found with session ID')) {
        console.error('[Claude SDK] Stale session ID (exception) — auto-healing:', errorMessage);
        this.clearSdkSessionId(sessionId);
        yield { type: 'text_delta', content: '⚠️ Remote session expired — reconnecting automatically...\n\n' };
        // Pass selectedModel to skip re-routing on retry (same fix as stale-zero-token path)
        yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, selectedModel, gstackMode, supplementalMessages, fastMode, cascadeMode);
        return;
      } else if (errorMessage.match(/process exited with code|process terminated by signal/) && session?.sshConfig) {
        console.error('[Claude SDK] SSH process exit caught:', errorMessage);
        this.recordAutoBuildLeadFailure(sessionId, autoOrchestrationPlan, errorMessage);
        const recoverableJob = await sshService.getLatestRecoverableRemoteProcess(sessionId, session.sshConfig).catch((probeError) => {
          console.warn('[Claude SDK] Failed to probe remote Claude recovery after process exit:', probeError);
          return null;
        });
        yield {
          type: 'error',
          error: this.formatRemoteClaudeProcessExitError(errorMessage, session, Boolean(recoverableJob?.active)),
        };
      } else if (errorMessage.match(/unauthorized|api.?key.*invalid|invalid.*api.?key|not authenticated|login required|authentication_error/i)) {
        console.error('[Claude SDK] Auth error caught:', errorMessage);
        this.recordAutoBuildLeadFailure(sessionId, autoOrchestrationPlan, errorMessage);
        yield {
          type: 'error',
          error: 'Authentication failed. Either set your Anthropic API key in Settings → API Keys, or run `claude login` in your terminal to authenticate via OAuth.'
        };
      } else if (errorMessage.match(/rate.?limit|429|too many requests|overloaded/i)) {
        console.log('[Claude SDK] Rate limit exception — auto-retry in 10s');
        yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
        await new Promise(r => setTimeout(r, 10000));
        if (abortController.signal.aborted) return;
        yield { type: 'text_delta', content: '🔄 Retrying...\n\n' };
        yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages, fastMode, cascadeMode);
        return;
      } else {
        this.recordAutoBuildLeadFailure(sessionId, autoOrchestrationPlan, errorMessage);
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      if (this.clearActiveQuery(sessionId, abortController)) {
        // Stop health-checking this session's SSH connection now that it's idle.
        const sess = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
        if (sess?.sshConfig) sshService.markSessionInactive(sessionId);
        powerService.sessionEnded();
      }
      releaseTurnLock?.();
    }
  }

  async *resumeRemoteTurn(
    sessionId: string,
    model?: string,
  ): AsyncGenerator<StreamEvent> {
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);

    if (!session?.sshConfig) {
      yield { type: 'error', error: 'Session is not an SSH session.' };
      return;
    }

    if (this.activeQueries.has(sessionId)) {
      yield { type: 'error', error: 'A stream is already active for this session.' };
      return;
    }

    const releaseTurnLock = await this.acquireSessionTurnLock(sessionId, 'resumeRemoteTurn');

    const abortController = new AbortController();
    this.setActiveQuery(sessionId, abortController);
    powerService.sessionStarted();
    sshService.markSessionActive(sessionId);

    let attachedJobDir: string | undefined;
    let recoveredCompletely = false;

    try {
      let attached: Awaited<ReturnType<typeof sshService.attachLatestDetachedCommandProcess>> = null;
      while (!abortController.signal.aborted) {
        try {
          attached = await sshService.attachLatestDetachedCommandProcess(
            sessionId,
            session.sshConfig,
            abortController.signal
          );
          break;
        } catch (error) {
          // The detached turn continues on the remote host while this machine
          // is asleep or offline. Keep the reattach generator alive and retry
          // the transport instead of returning an empty terminal response.
          console.warn(`[Claude Service] SSH reattach unavailable for ${sessionId}; retrying:`, error);
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              abortController.signal.removeEventListener('abort', finish);
              resolve();
            };
            if (abortController.signal.aborted) {
              resolve();
              return;
            }
            const timer = setTimeout(finish, 2000);
            abortController.signal.addEventListener('abort', finish, { once: true });
          });
        }
      }

      if (abortController.signal.aborted) {
        return;
      }

      if (!attached) {
        yield { type: 'error', error: 'No recoverable remote Claude turn was found for this SSH session.' };
        return;
      }

      attachedJobDir = attached.job.jobDir;

      // Dispatch replay by the harness that owns the bridge job. Every
      // harness spawned through the detached bridge survives disconnects;
      // each recoverable command has its own stdout parser here.
      const bridgeCommand = attached.job.command || 'claude';
      if (bridgeCommand === 'codex') {
        for await (const chatEvent of codexService.replayDetachedAsChat(attached.process, session.model) as AsyncIterable<StreamEvent>) {
          if (chatEvent.type === 'message_complete') {
            recoveredCompletely = true;
          }
          yield chatEvent;
        }
        if (attachedJobDir && recoveredCompletely) {
          // The spawning app may have died before closing the job's stdin —
          // signal EOF so the remote process exits instead of idling forever.
          await sshService.signalDetachedBridgeJobStdinEof(sessionId, session.sshConfig, attachedJobDir);
          await sshService.markDetachedBridgeJobRecovered(sessionId, session.sshConfig, attachedJobDir);
        } else if (!recoveredCompletely) {
          yield { type: 'error', error: 'Recovered remote Codex turn ended without a result.' };
        }
        return;
      }

      const recoveredInput = attached.process.stdin;
      this.recoveredQueryInputs.set(sessionId, recoveredInput);

      const writeRecoveredControlResponse = async (payload: Record<string, unknown>): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          recoveredInput.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
      };

      const handleRecoveredControlMessage = async (rawMessage: Record<string, any>): Promise<boolean> => {
        if (rawMessage.type === 'control_cancel_request') {
          // The remote CLI cancelled a control request. The corresponding app
          // dialog promise will either be replaced or expire; no response is
          // required by the Claude stream-json protocol.
          return true;
        }
        if (rawMessage.type !== 'control_request') return false;

        const requestId = String(rawMessage.request_id || '');
        const request = rawMessage.request || {};
        try {
          if (request.subtype !== 'can_use_tool') {
            throw new Error(`Cannot restore unsupported control request subtype: ${String(request.subtype || 'unknown')}`);
          }
          const decision = await this.handleRecoveredCanUseTool(
            sessionId,
            String(request.tool_name || ''),
            (request.input || {}) as Record<string, unknown>,
          );
          await writeRecoveredControlResponse({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: {
                ...decision,
                toolUseID: request.tool_use_id,
              },
            },
          });
          console.log(`[Claude Service] Answered recovered ${String(request.tool_name || 'tool')} control request for ${sessionId.substring(0, 8)}`);
        } catch (error) {
          await writeRecoveredControlResponse({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return true;
      };

      let selectedModel = model || session.model || 'claude-sonnet-4-6';
      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      const contentBlocks: ContentBlock[] = [];
      let currentAgentId: string | undefined;
      let textBuffer = '';
      let textBufferAgentId: string | undefined;
      let thinkingBuffer = '';
      let queryComplete = false;
      let lastTerminalReason: string | undefined;
      // Last single API call's input tokens — true context occupancy. The
      // result message's usage is cumulative across the turn and unusable
      // for context measurement.
      let lastApiCallContextTokens: number | undefined;

      const flushBuffers = (): StreamEvent[] => {
        const events: StreamEvent[] = [];

        if (textBuffer) {
          const agentId = textBufferAgentId;
          const content = textBuffer;
          textBuffer = '';
          textBufferAgentId = undefined;
          fullContent += content;

          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock?.type === 'text' && lastBlock.agentId === agentId) {
            lastBlock.text = (lastBlock.text || '') + content;
          } else {
            contentBlocks.push({ type: 'text', text: content, agentId });
          }

          events.push({ type: 'text_delta', content, agentId });
        }

        if (thinkingBuffer) {
          const content = thinkingBuffer;
          thinkingBuffer = '';
          events.push({ type: 'thinking_delta', content });
        }

        return events;
      };

      const mergeTextContentBlock = (content: string, agentId?: string): void => {
        if (!content) return;
        const lastBlock = contentBlocks[contentBlocks.length - 1];
        if (lastBlock?.type === 'text' && lastBlock.agentId === agentId) {
          lastBlock.text = (lastBlock.text || '') + content;
        } else {
          contentBlocks.push({ type: 'text', text: content, agentId });
        }
      };

      const buildFinalMessage = (interrupted = false): ChatMessage => {
        const mergedBlocks: ContentBlock[] = [];
        for (const block of contentBlocks) {
          const lastMerged = mergedBlocks[mergedBlocks.length - 1];
          if (block.type === 'text' && lastMerged?.type === 'text' && lastMerged.agentId === block.agentId) {
            lastMerged.text = (lastMerged.text || '') + (block.text || '');
          } else {
            mergedBlocks.push({ ...block });
          }
        }

        return {
          id: Date.now().toString(),
          role: 'assistant',
          content: fullContent,
          contentBlocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: new Date(),
          interrupted,
          harness: this.getHarnessFromModel(selectedModel),
        };
      };

      const handleRecoveredMessage = (msg: SDKMessage): StreamEvent[] => {
        const events: StreamEvent[] = [];
        const flushIntoEvents = () => {
          events.push(...flushBuffers());
        };

        if (msg.type !== 'stream_event') {
          flushIntoEvents();
        }

        switch (msg.type) {
          case 'system': {
            const systemMsg = msg as SDKMessage & {
              subtype?: string;
              session_id?: string;
              tools?: string[];
              model?: string;
              status?: string | null;
              compact_metadata?: {
                trigger: 'manual' | 'auto';
                pre_tokens: number;
              };
            };

            const canonicalSdkSessionId = this.rememberCanonicalSdkSessionId(sessionId, systemMsg, 'resume');
            if (canonicalSdkSessionId) {
              const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
              if (currentSession && (currentSession as any).forkFromSdkSessionId) {
                const { forkFromSdkSessionId: _, ...cleanSession } = currentSession as any;
                this.sessionStore.set(`sessions.${sessionId}`, { ...cleanSession, sdkSessionId: canonicalSdkSessionId });
              }
            }

            if (systemMsg.model) {
              selectedModel = systemMsg.model;
            }

            if (systemMsg.subtype === 'status') {
              const compactionStatus: CompactionStatus = {
                sessionId,
                isCompacting: systemMsg.status === 'compacting',
              };
              events.push({ type: 'compaction_status', compactionStatus });
              break;
            }

            if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
              this.sessionContextPercentage.delete(sessionId);
              this.sessionStore.delete(`contextUsage.${sessionId}`);
              events.push({
                type: 'compaction_complete',
                compactionComplete: {
                  sessionId,
                  preTokens: systemMsg.compact_metadata.pre_tokens,
                },
              });
              break;
            }

            events.push({
              type: 'system',
              systemInfo: {
                tools: systemMsg.tools || [],
                model: systemMsg.model || selectedModel || '',
              },
            });
            break;
          }

          case 'assistant': {
            const assistantMsg = msg as SDKMessage & {
              parent_tool_use_id?: string | null;
              message?: {
                content?: Array<{
                  type: string;
                  text?: string;
                  name?: string;
                  id?: string;
                  input?: Record<string, unknown>;
                }>;
                usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
              };
            };
            currentAgentId = assistantMsg.parent_tool_use_id || undefined;

            // Per-API-call usage = true context occupancy (see live stream loop).
            if (!assistantMsg.parent_tool_use_id && assistantMsg.message?.usage) {
              const callUsage = assistantMsg.message.usage;
              const callTokens = (callUsage.input_tokens || 0)
                + (callUsage.cache_creation_input_tokens || 0)
                + (callUsage.cache_read_input_tokens || 0);
              if (callTokens > 0) {
                lastApiCallContextTokens = callTokens;
              }
            }

            for (const block of assistantMsg.message?.content || []) {
              if (block.type === 'text' && block.text && block.text.length > fullContent.length) {
                const newContent = block.text.slice(fullContent.length);
                fullContent = block.text;
                mergeTextContentBlock(newContent, currentAgentId);
                events.push({ type: 'text_delta', content: newContent, agentId: currentAgentId });
              } else if (block.type === 'tool_use' && block.name) {
                const existingTool = toolCalls.find(tc => tc.id === block.id);
                if (!existingTool) {
                  const toolCall: ToolCall = {
                    id: block.id || `tool-${Date.now()}`,
                    name: block.name,
                    input: block.input || {},
                    status: 'running',
                    startedAt: new Date(),
                    agentId: currentAgentId,
                  };
                  toolCalls.push(toolCall);
                  contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                  events.push({ type: 'tool_use', toolCall, agentId: currentAgentId });
                } else if (block.input && Object.keys(block.input).length > 0) {
                  existingTool.input = block.input;
                  events.push({ type: 'tool_use', toolCall: existingTool, agentId: currentAgentId });
                }
              }
            }
            break;
          }

          case 'stream_event': {
            const streamMsg = msg as SDKMessage & { event?: any; parent_tool_use_id?: string | null };
            currentAgentId = streamMsg.parent_tool_use_id || undefined;
            const event = streamMsg.event;

            if (event?.type === 'content_block_delta' && event.delta) {
              if (event.delta.type === 'text_delta' && event.delta.text) {
                if (textBuffer && textBufferAgentId !== currentAgentId) {
                  flushIntoEvents();
                }
                textBufferAgentId = currentAgentId;
                textBuffer += event.delta.text;
                if (textBuffer.length >= 100) {
                  flushIntoEvents();
                }
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                thinkingBuffer += event.delta.thinking;
                if (thinkingBuffer.length >= 100) {
                  flushIntoEvents();
                }
              } else {
                flushIntoEvents();
              }
            } else if (event?.type === 'content_block_start' && event.content_block) {
              flushIntoEvents();
              if (event.content_block.type === 'tool_use' && event.content_block.name) {
                const existingTool = toolCalls.find(tc => tc.id === event.content_block.id);
                if (!existingTool) {
                  const toolCall: ToolCall = {
                    id: event.content_block.id || `tool-${Date.now()}`,
                    name: event.content_block.name,
                    input: event.content_block.input || {},
                    status: 'running',
                    startedAt: new Date(),
                    agentId: currentAgentId,
                  };
                  toolCalls.push(toolCall);
                  contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                  events.push({ type: 'tool_use', toolCall, agentId: currentAgentId });
                }
              }
            } else if (
              event?.type === 'content_block_stop'
              || event?.type === 'message_delta'
              || event?.type === 'message_stop'
            ) {
              flushIntoEvents();
            }
            break;
          }

          case 'tool_progress': {
            const progressMsg = msg as SDKMessage & {
              tool_use_id?: string;
              tool_name?: string;
              parent_tool_use_id?: string | null;
            };
            const progressAgentId = progressMsg.parent_tool_use_id || undefined;
            if (progressMsg.tool_name && progressMsg.tool_use_id) {
              const existingTool = toolCalls.find(tc => tc.id === progressMsg.tool_use_id);
              if (!existingTool) {
                const toolCall: ToolCall = {
                  id: progressMsg.tool_use_id,
                  name: progressMsg.tool_name,
                  input: {},
                  status: 'running',
                  startedAt: new Date(),
                  agentId: progressAgentId,
                };
                toolCalls.push(toolCall);
                contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: progressAgentId });
                events.push({ type: 'tool_use', toolCall, agentId: progressAgentId });
              }
            }
            break;
          }

          case 'user': {
            const userMsg = msg as SDKMessage & {
              message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string }> };
            };
            for (const block of userMsg.message?.content || []) {
              if (block.type !== 'tool_result') continue;
              const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
              if (!toolCall) continue;
              const normalizedCompletedTool = toolCall.name.toLowerCase().replace(/[_-]/g, '');
              const approvedExecutionHandoff = normalizedCompletedTool === 'exitplanmode'
                && this.pendingAutoPlanExecutionHandoffs.has(sessionId);
              toolCall.status = 'completed';
              // Claude emits a stock rejection result when the host interrupts
              // immediately after an approved ExitPlanMode request. The user
              // approved it; keep the recovered transcript truthful.
              toolCall.result = approvedExecutionHandoff
                ? 'Plan approved. Handing off to the configured Execution model.'
                : block.content || '';
              toolCall.completedAt = new Date();
              events.push({ type: 'tool_result', toolCall, result: toolCall.result });
            }
            break;
          }

          case 'result': {
            const resultMsg = msg as SDKMessage & {
              is_error?: boolean;
              result?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
              model?: string;
              terminal_reason?: TerminalReason;
            };

            flushIntoEvents();

            if (resultMsg.model) {
              selectedModel = resultMsg.model;
            }

            if (resultMsg.is_error && resultMsg.result) {
              queryComplete = true;
              recoveredCompletely = true;
              if (!this.pendingAutoPlanExecutionHandoffs.has(sessionId)) {
                events.push({ type: 'error', error: resultMsg.result });
              }
              break;
            }

            if (resultMsg.usage) {
              const inputTokens = (resultMsg.usage.input_tokens || 0)
                + (resultMsg.usage.cache_creation_input_tokens || 0)
                + (resultMsg.usage.cache_read_input_tokens || 0);
              const outputTokens = resultMsg.usage.output_tokens || 0;
              const currentModel = resultMsg.model || selectedModel || 'claude-sonnet-4-6';
              const contextWindowSize = this.getContextWindowSize(currentModel);
              // Context occupancy from the last single API call, not the
              // cumulative turn usage (see live stream loop).
              const contextTokens = lastApiCallContextTokens ?? inputTokens;
              const percentage = Math.round((contextTokens / contextWindowSize) * 100);
              const cacheReadTokens = resultMsg.usage.cache_read_input_tokens || 0;
              const cacheWriteTokens = resultMsg.usage.cache_creation_input_tokens || 0;
              const cost = estimateCost(currentModel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

              this.rememberSessionContextUsage(sessionId, contextTokens, contextWindowSize, percentage);
              events.push({
                type: 'context_usage',
                inputTokens,
                outputTokens,
                contextWindowSize,
                percentage,
                estimatedCostUsd: cost,
              } as StreamEvent & { inputTokens: number; outputTokens: number; contextWindowSize: number; percentage: number; estimatedCostUsd?: number });
            }

            if (resultMsg.terminal_reason) {
              lastTerminalReason = resultMsg.terminal_reason;
            }

            queryComplete = true;
            recoveredCompletely = true;
            // An approved Auto plan continues in the same visible stream with
            // the configured execution harness below. Do not publish a false
            // terminal response for the interrupted planner.
            if (!this.pendingAutoPlanExecutionHandoffs.has(sessionId)) {
              events.push({
                type: 'message_complete',
                message: buildFinalMessage(false),
                resolvedModel: selectedModel,
                ...(lastTerminalReason ? { terminalReason: lastTerminalReason } : {}),
              });
            }
            break;
          }

          default:
            break;
        }

        return events;
      };

      let pending = '';
      for await (const chunk of attached.process.stdout as AsyncIterable<Buffer | string>) {
        pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex >= 0) {
          const rawLine = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          newlineIndex = pending.indexOf('\n');

          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          const jsonStart = trimmed.indexOf('{');
          if (jsonStart < 0) continue;

          try {
            const rawMessage = JSON.parse(trimmed.slice(jsonStart)) as Record<string, any>;
            if (await handleRecoveredControlMessage(rawMessage)) continue;
            const msg = rawMessage as SDKMessage;
            for (const event of handleRecoveredMessage(msg)) {
              yield event;
            }
          } catch (error) {
            if (STREAM_DEBUG) {
              console.warn('[Claude Service] Skipping non-JSON recovered bridge line:', trimmed.slice(0, 200), error);
            }
          }

          // The result message is the turn's terminal event. Stop replaying —
          // a process whose stdin was orphaned by an app close never exits on
          // its own, and tailing it would pin this stream open forever.
          if (queryComplete) break;
        }
        if (queryComplete) break;
      }

      const trailing = pending.trim();
      if (!queryComplete && trailing) {
        const jsonStart = trailing.indexOf('{');
        if (jsonStart >= 0) {
          try {
            const rawMessage = JSON.parse(trailing.slice(jsonStart)) as Record<string, any>;
            if (await handleRecoveredControlMessage(rawMessage)) {
              return;
            }
            const msg = rawMessage as SDKMessage;
            for (const event of handleRecoveredMessage(msg)) {
              yield event;
            }
          } catch {
            // Ignore trailing partial/non-JSON bridge output.
          }
        }
      }

      if (!queryComplete) {
        for (const event of flushBuffers()) {
          yield event;
        }

        if (fullContent.trim() || toolCalls.length > 0) {
          yield {
            type: 'message_complete',
            message: buildFinalMessage(true),
            resolvedModel: selectedModel,
          };
        } else {
          yield { type: 'error', error: 'Recovered remote turn ended without a Claude result.' };
        }
      }

      if (attachedJobDir && recoveredCompletely) {
        // The spawning app may have died before closing the job's stdin —
        // signal EOF so claude (--input-format stream-json) exits instead of
        // idling for a next message that will never arrive.
        await sshService.signalDetachedBridgeJobStdinEof(sessionId, session.sshConfig, attachedJobDir);
        await sshService.markDetachedBridgeJobRecovered(sessionId, session.sshConfig, attachedJobDir);
      }

      if (await this.consumeAutoPlanExecutionHandoff(sessionId, abortController)) {
        // The recovered reader owns a different lock holder than streamMessage.
        // Release it before re-entering Auto or the execution turn would wait
        // forever behind the completed planner reattach.
        releaseTurnLock();
        yield* this.streamMessage(
          sessionId,
          'Execute the approved plan now.',
          undefined,
          'bypassPermissions',
          undefined,
          'auto',
        );
        return;
      }
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.clearActiveQuery(sessionId, abortController)) {
        sshService.markSessionInactive(sessionId);
        powerService.sessionEnded();
      }
      releaseTurnLock();
    }
  }

  // Active background task listeners — one per session, cancelled on next query or cleanup
  private backgroundListeners = new Map<string, AbortController>();

  private forwardTaskSystemMessage(sessionId: string, msg: SDKMessage | (SDKMessage & { subtype?: string })): boolean {
    const taskSubtypes = new Set(['notification', 'task_updated', 'task_notification', 'task_progress', 'task_started']);
    const raw = msg as SDKMessage & {
      subtype?: string;
      key?: string;
      text?: string;
      priority?: string;
      task_id?: string;
      tool_use_id?: string;
      status?: string;
      output_file?: string;
      summary?: string;
      description?: string;
      task_type?: string;
      subagent_type?: string;
      workflow_name?: string;
      last_tool_name?: string;
      patch?: {
        status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
        description?: string;
        end_time?: number;
        total_paused_ms?: number;
        error?: string;
        is_backgrounded?: boolean;
      };
    };
    const subtype = raw.subtype || (taskSubtypes.has(String((msg as SDKMessage).type)) ? String((msg as SDKMessage).type) : undefined);
    if (!subtype || !taskSubtypes.has(subtype)) return false;

    if (subtype === 'notification') {
      console.log('[Claude SDK] Notification:', raw.key, raw.text?.slice(0, 100));
      if (this.mainWindow && raw.text) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
          sessionId,
          taskId: raw.key,
          description: raw.text,
        });
      }
      return true;
    }

    if (subtype === 'task_started') {
      const label = raw.description || raw.subagent_type || raw.workflow_name || raw.task_type || 'task';
      console.log('[Claude SDK] Task started:', raw.task_id, label.slice(0, 80));
      if (this.mainWindow) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
          sessionId,
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id,
          description: `Started: ${label}`,
          summary: raw.summary,
          lastToolName: raw.last_tool_name,
        });
      }
      return true;
    }

    if (subtype === 'task_notification') {
      console.log('[Claude SDK] Task notification:', raw.task_id, raw.status, raw.summary?.slice(0, 80));
      if (this.mainWindow) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, {
          sessionId,
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id,
          status: raw.status,
          outputFile: raw.output_file,
          summary: raw.summary,
        });
      }
      return true;
    }

    if (subtype === 'task_progress') {
      const progressText = raw.description || raw.summary || raw.last_tool_name || '';
      if (!this.shouldForwardTaskProgress(sessionId, raw.task_id, raw.tool_use_id, progressText)) {
        return true;
      }
      if (STREAM_DEBUG) {
        console.log('[Claude SDK] Task progress:', raw.task_id, raw.description?.slice(0, 80));
      }
      if (this.mainWindow) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
          sessionId,
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id,
          description: raw.description,
          summary: raw.summary,
          lastToolName: raw.last_tool_name,
        });
      }
      return true;
    }

    if (subtype === 'task_updated') {
      if (raw.patch?.status === 'completed' || raw.patch?.status === 'failed' || raw.patch?.status === 'killed') {
        console.log('[Claude SDK] Task updated:', raw.task_id, raw.patch.status);
      } else if (STREAM_DEBUG) {
        console.log('[Claude SDK] Task updated:', raw.task_id, JSON.stringify(raw.patch));
      }
      if (this.mainWindow && raw.task_id && raw.patch) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_UPDATED, {
          sessionId,
          taskId: raw.task_id,
          toolUseId: raw.tool_use_id,
          patch: raw.patch,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Continue reading the SDK message iterator after a query turn completes.
   * Background tasks (Monitor, Agent) keep producing events on the same process
   * between turns. Without this, task_updated/task_notification events are lost.
   * Accepts the raw AsyncIterator (not the Query) so the iterator stays open —
   * `for await` auto-closes iterators on break, which would kill the stream.
   */
  private startBackgroundTaskListener(sessionId: string, iterator: AsyncIterator<SDKMessage>, parentSignal: AbortSignal): void {
    // Cancel any existing listener for this session (e.g., from a previous turn)
    this.backgroundListeners.get(sessionId)?.abort();

    const controller = new AbortController();
    this.backgroundListeners.set(sessionId, controller);

    const taskSubtypes = new Set(['notification', 'task_updated', 'task_notification', 'task_progress', 'task_started']);

    (async () => {
      try {
        let result = await iterator.next();
        while (!result.done) {
          if (controller.signal.aborted || parentSignal.aborted) break;
          const msg = result.value;

          if (msg.type === 'system') {
            const systemMsg = msg as typeof msg & { subtype?: string };
            if (systemMsg.subtype && taskSubtypes.has(systemMsg.subtype)) {
              if (STREAM_DEBUG) {
                console.log(`[Claude SDK] Background listener (${sessionId.slice(0, 8)}): ${systemMsg.subtype}`);
              }
              this.forwardTaskSystemMessage(sessionId, systemMsg);
            }
          } else {
            this.forwardTaskSystemMessage(sessionId, msg);
          }

          result = await iterator.next();
        }
      } catch (err) {
        if (!controller.signal.aborted && !parentSignal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('No conversation found with session ID')) {
            this.clearSdkSessionId(sessionId);
          }
          console.warn(`[Claude SDK] Background listener error (${sessionId.slice(0, 8)}):`, err);
        }
      } finally {
        this.backgroundListeners.delete(sessionId);
        console.log(`[Claude SDK] Background listener ended (${sessionId.slice(0, 8)})`);
      }
    })();
  }

  /**
   * Clean up all data associated with a deleted session.
   * Called from SESSION_DELETE handler only — never during streaming lifecycle.
   */
  cleanupSession(sessionId: string): void {
    // Abort active query if any
    const controller = this.activeQueries.get(sessionId);
    if (controller) {
      controller.abort();
      powerService.sessionEnded();
    }
    this.clearActiveQuery(sessionId);
    this.backgroundListeners.get(sessionId)?.abort();
    this.backgroundListeners.delete(sessionId);

    // Kill remote processes if this is an SSH session
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined);
    if (session?.sshConfig) {
      sshService.killRemoteProcesses(sessionId, session.sshConfig).catch(() => undefined);
    }

    // Clear OpenClaw conversation history
    openclawService.clearHistory(sessionId);

    // Session-keyed maps
    this.sessionPermissionModes.delete(sessionId);
    this.prePlanPermissionModes.delete(sessionId);
    this.autoBuildForcedPlanSessions.delete(sessionId);
    this.sessionContextPercentage.delete(sessionId);
    this.sessionStore.delete(`contextUsage.${sessionId}`);
    this.sessionPlanFiles.delete(sessionId);
    this.sessionApprovedPlanFiles.delete(sessionId);
    this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
    this.clearAutoPlanningState(sessionId, 'session deleted');
    this.browserMcpServers.delete(sessionId);

    // requestId-keyed maps — iterate and find matching sessionId
    for (const [reqId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Session deleted'));
        this.pendingPermissions.delete(reqId);
      }
    }
    for (const [reqId, pending] of this.pendingQuestions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Session deleted'));
        this.pendingQuestions.delete(reqId);
      }
    }
    // pendingPlanApprovals self-clean through the existing timeout.
  }

  /** Clear harness-native continuation handles before an in-place Fast Stack
   * turn. Claude's SDK mapping is replaced by SessionService; other harnesses
   * start a fresh native thread and receive the merged Build transcript. */
  prepareFastStack(sessionId: string): void {
    codexService.clearThreadId(sessionId);
    getCursorCliService().clearChatId(sessionId);
    this.resumeEmptyRetryAt.delete(sessionId);
    this.backgroundListeners.get(sessionId)?.abort();
    this.backgroundListeners.delete(sessionId);
    console.log(`[Claude Service] Cleared native continuation handles for Fast Stack ${sessionId.substring(0, 8)}`);
  }

  async cancelQuery(sessionId: string): Promise<void> {
    this.pendingAutoPlanExecutionHandoffs.delete(sessionId);
    const controller = this.activeQueries.get(sessionId);
    const backgroundListener = this.backgroundListeners.get(sessionId);
    if (controller) {
      controller.abort();
      this.clearActiveQuery(sessionId, controller);
      powerService.sessionEnded();
    }
    // Stop background task listener
    backgroundListener?.abort();
    this.backgroundListeners.delete(sessionId);
    // Also kill any active external harness process for this session.
    codexService.cancel(sessionId);
    openclawService.cancel(sessionId);
    getCursorService().cancel(sessionId);
    getCursorCliService().cancel(sessionId);
    getGeminiService().cancel(sessionId);
    getOpenCodeService().cancel(sessionId);

    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);
    // Reject pending permissions — the query that requested them is dead
    for (const [reqId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Query cancelled'));
        this.pendingPermissions.delete(reqId);
      }
    }
    for (const [reqId, pending] of this.pendingQuestions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Query cancelled'));
        this.pendingQuestions.delete(reqId);
      }
    }

    if (session?.sshConfig) {
      const existingCleanup = this.remoteCancellationCleanup.get(sessionId);
      if (existingCleanup) {
        await existingCleanup;
        return;
      }

      const cleanupPromise = sshService.cleanupDetachedBridgeProcessesForNewTurn(
        sessionId,
        session.sshConfig,
        { killActive: true },
      ).catch((error) => {
        console.warn(`[Claude Service] Remote cancellation cleanup failed for ${sessionId.substring(0, 8)}:`, error);
      }).finally(() => {
        if (this.remoteCancellationCleanup.get(sessionId) === cleanupPromise) {
          this.remoteCancellationCleanup.delete(sessionId);
        }
      });
      this.remoteCancellationCleanup.set(sessionId, cleanupPromise);
      await cleanupPromise;
    }
  }

  /**
   * Inject a message into the active harness turn. Claude uses
   * Query.streamInput; persistent Codex chat turns use app-server turn/steer.
   */
  async injectMessage(sessionId: string, message: string, attachments?: Attachment[]): Promise<boolean> {
    if (codexService.canSteer(sessionId)) {
      return codexService.steer(sessionId, message, attachments);
    }

    const queryObj = this.activeQueryObjects.get(sessionId);
    const recoveredInput = this.recoveredQueryInputs.get(sessionId);
    if (!queryObj && !recoveredInput) {
      console.log('[Claude Service] injectMessage: No active query for session', sessionId);
      return false;
    }

    // Validate message is not empty to prevent API error
    let safeMessage = message;
    const hasImages = attachments?.some(a => a.type === 'image');
    const hasFiles = hasFileAttachments(attachments);
    if (!message || message.trim() === '') {
      if (!hasImages && !hasFiles) {
        console.log('[Claude Service] injectMessage: Empty message with no images, skipping');
        return false;
      }
      safeMessage = hasFiles ? ATTACHMENT_ONLY_PROMPT : 'Please analyze this image.';
    }

    if (hasFiles) {
      const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
        || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);
      if (!session) {
        console.warn('[Claude Service] injectMessage: Cannot prepare file attachments; session not found', sessionId);
        return false;
      }
      const attachmentWorkingDir = session.sshConfig
        ? session.worktreePath || session.repoPath || session.sshConfig.remoteWorkdir || process.cwd()
        : this.resolveValidCwd(session);
      try {
        const preparedFiles = await prepareFileAttachmentsForHarness(
          sessionId,
          attachments,
          attachmentWorkingDir,
          session.sshConfig,
        );
        if (preparedFiles.promptBlock) {
          safeMessage = `${preparedFiles.promptBlock}\n\n${safeMessage || ATTACHMENT_ONLY_PROMPT}`;
          console.log(`[Claude Service] injectMessage: Prepared ${preparedFiles.files.length} file attachment(s)`);
        }
      } catch (error) {
        console.error('[Claude Service] injectMessage: Failed to prepare file attachments:', error);
        return false;
      }
    }

    console.log(
      `[Claude Service] injectMessage: Injecting queued message via ${recoveredInput ? 'recovered SSH stdin' : 'Query.streamInput'} for session`,
      sessionId,
    );

    try {
      const resizeImage = this.resizeImageIfNeeded.bind(this);
      const normalizeBase64ImageData = this.normalizeBase64ImageData.bind(this);
      if (recoveredInput) {
        const imageAttachments = attachments?.filter(a => a.type === 'image') || [];
        let content: string | Array<
          { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        > = safeMessage;

        if (imageAttachments.length > 0) {
          content = [{ type: 'text', text: safeMessage }];
          for (const attachment of imageAttachments) {
            const ext = attachment.name.split('.').pop()?.toLowerCase();
            const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'gif' ? 'image/gif'
                : ext === 'webp' ? 'image/webp'
                  : 'image/png';
            const resizedData = await resizeImage(normalizeBase64ImageData(attachment.content), mediaType);
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: resizedData },
            });
          }
        }

        await new Promise<void>((resolve, reject) => {
          recoveredInput.write(`${JSON.stringify({
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            session_id: '',
          })}\n`, (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
        console.log('[Claude Service] injectMessage: Message injected successfully via recovered SSH stdin');
        return true;
      }

      let markInputWritten!: () => void;
      let inputWritten = false;
      const inputWrittenPromise = new Promise<void>((resolve) => {
        markInputWritten = () => {
          if (inputWritten) return;
          inputWritten = true;
          resolve();
        };
      });

      const createMessageStream = async function* (): AsyncIterable<SDKUserMessage> {
        const imageAttachments = attachments?.filter(a => a.type === 'image') || [];
        const hasImagesLocal = imageAttachments.length > 0;

        if (hasImagesLocal) {
          const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
            { type: 'text', text: safeMessage }
          ];

          for (const attachment of imageAttachments) {
            const ext = attachment.name.split('.').pop()?.toLowerCase();
            const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'gif' ? 'image/gif'
                : ext === 'webp' ? 'image/webp'
                  : 'image/png';

            const resizedData = await resizeImage(normalizeBase64ImageData(attachment.content), mediaType);

            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: resizedData,
              },
            });
          }

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: content as any,
            },
            parent_tool_use_id: null,
            session_id: '',
          } as SDKUserMessage;
        } else {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: safeMessage,
            },
            parent_tool_use_id: null,
            session_id: '',
          } as SDKUserMessage;
        }

        // The SDK's streamInput() writes each yielded message before asking the
        // iterator for the next item. Reaching here therefore means transport.write
        // accepted this message. streamInput itself can remain pending in
        // waitForFirstResult for the rest of an active turn, which is not a
        // delivery acknowledgement and must not hold the queue row indefinitely.
        markInputWritten();
      };

      const streamInputPromise = queryObj!.streamInput(createMessageStream());
      const deliveryOutcome = await Promise.race([
        inputWrittenPromise.then(() => 'written' as const),
        streamInputPromise.then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
      ]);

      if (deliveryOutcome === 'timeout') {
        void streamInputPromise.catch((error) => {
          console.error('[Claude Service] injectMessage: Timed-out streamInput later failed:', error);
        });
        console.warn('[Claude Service] injectMessage: Query.streamInput did not accept input within 5000ms');
        return false;
      }
      if (!inputWritten) {
        console.warn('[Claude Service] injectMessage: Query.streamInput settled before writing the queued message');
        return false;
      }

      // Observe eventual SDK settlement without awaiting waitForFirstResult.
      void streamInputPromise.catch((error) => {
        console.error('[Claude Service] injectMessage: Query.streamInput failed after accepting input:', error);
      });
      console.log('[Claude Service] injectMessage: Message accepted by Query.streamInput transport');
      return true;
    } catch (error) {
      console.error('[Claude Service] injectMessage: Failed to inject message:', error);
      return false;
    }
  }

  /**
   * Check if there's an active query for the given session.
   * Uses activeQueries (AbortController map) which covers the full lifetime
   * of streamMessage, including before the SDK Query object is created.
   */
  hasActiveQuery(sessionId: string): boolean {
    return this.getActiveQueryState(sessionId).active;
  }

  /**
   * Get project slug from path - matches SDK's convention
   * The SDK uses: leading dash, preserve case, replace / with -
   */
  private getProjectSlug(projectPath: string): string {
    // SDK uses a slug that starts with dash and preserves case
    // /home/user/dev/project -> -home-user-dev-project
    return projectPath.replace(/\//g, '-');
  }

  private normalizeBase64ImageData(data: string): string {
    const match = data.match(/^data:image\/[^;]+;base64,(.*)$/i);
    return match ? match[1] : data;
  }

  private getImageAttachmentsForHarness(attachments?: Attachment[]): Array<{ name: string; content: string }> {
    if (!attachments || attachments.length === 0) return [];

    const images: Array<{ name: string; content: string }> = [];
    for (const attachment of attachments) {
      if (attachment.type === 'image' && attachment.content) {
        images.push({
          name: attachment.name,
          content: this.normalizeBase64ImageData(attachment.content),
        });
        continue;
      }

      if (attachment.type === 'dom_element' && attachment.screenshot) {
        images.push({
          name: `${attachment.name || 'selected-element'}-screenshot.png`,
          content: this.normalizeBase64ImageData(attachment.screenshot),
        });
      }
    }

    return images;
  }

  /**
   * Prepare attachments for CLI-based harnesses (Cursor, Gemini, etc.) that take
   * a plain-text prompt. DOM elements are embedded as XML text blocks. Images are
   * written to temp files and referenced by path in the prompt.
   *
   * For SSH sessions, images are uploaded to the remote host via SFTP so the
   * remote CLI can actually access them.
   */
  private async prepareCliAttachments(
    sessionId: string,
    message: string,
    workingDir: string,
    attachments?: Attachment[],
    sshConfig?: import('../../shared/types').SSHConfig,
  ): Promise<{ message: string; cleanup: () => Promise<void> }> {
    const noop = async () => undefined;
    if (!attachments || attachments.length === 0) return { message, cleanup: noop };

    let result = message;

    const domElements = attachments.filter(a => a.type === 'dom_element');
    if (domElements.length > 0) {
      const domContext = domElements.map((el, i) =>
        `<selected-element index="${i + 1}" selector="${el.name}">\n${el.content}\n</selected-element>`
      ).join('\n\n');
      result = `${domContext}\n\n${result}`;
    }

    if (hasFileAttachments(attachments)) {
      const preparedFiles = await prepareFileAttachmentsForHarness(sessionId, attachments, workingDir, sshConfig);
      if (preparedFiles.promptBlock) {
        result = `${preparedFiles.promptBlock}\n\n${result || ATTACHMENT_ONLY_PROMPT}`;
        console.log(`[Claude Service] Prepared ${preparedFiles.files.length} file attachment(s) for CLI harness`);
      }
    }

    const images = this.getImageAttachmentsForHarness(attachments);
    if (images.length > 0) {
      const localTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `build-cli-${sessionId}-`));
      const localPaths: string[] = [];
      for (const [idx, img] of images.entries()) {
        const ext = img.name.match(/\.(jpe?g)$/i) ? '.jpg' : '.png';
        const imgPath = path.join(localTempDir, `screenshot-${idx}${ext}`);
        await fs.promises.writeFile(imgPath, this.normalizeBase64ImageData(img.content), 'base64');
        localPaths.push(imgPath);
      }

      if (sshConfig) {
        return this.uploadCliImagesToRemote(sessionId, result, localPaths, localTempDir, sshConfig);
      }

      const imageRef = localPaths.map((p, i) => `[Attached screenshot ${i + 1}: ${p}]`).join('\n');
      result = `${imageRef}\n\n${result}`;
      console.log(`[Claude Service] Wrote ${localPaths.length} image(s) to ${localTempDir} for CLI harness`);
      return {
        message: result,
        cleanup: async () => {
          await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    }

    return { message: result, cleanup: noop };
  }

  private async uploadCliImagesToRemote(
    sessionId: string,
    message: string,
    localPaths: string[],
    localTempDir: string,
    sshConfig: import('../../shared/types').SSHConfig,
  ): Promise<{ message: string; cleanup: () => Promise<void> }> {
    const remoteDir = `/tmp/build-cli-${sessionId}-${Date.now()}`;
    const escapedRemoteDir = remoteDir.replace(/'/g, "'\\''");

    try {
      const client = await sshService['getConnection'](sessionId, sshConfig);
      await new Promise<void>((resolve, reject) => {
        client.exec(`mkdir -p '${escapedRemoteDir}'`, (err, ch) => {
          if (err) return reject(err);
          ch.on('close', () => resolve());
          ch.resume();
        });
      });

      const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
        client.sftp((err, s) => err ? reject(err) : resolve(s));
      });

      const remotePaths: string[] = [];
      try {
        const uploaded = await Promise.all(localPaths.map((localPath, idx) => {
          const remotePath = `${remoteDir}/screenshot-${idx}${path.extname(localPath) || '.png'}`;
          return new Promise<string>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve(remotePath));
          });
        }));
        remotePaths.push(...uploaded);
      } finally {
        try { sftp.end(); } catch { /* ignore */ }
        await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => undefined);
      }

      const imageRef = remotePaths.map((p, i) => `[Attached screenshot ${i + 1}: ${p}]`).join('\n');
      console.log(`[Claude Service] Uploaded ${remotePaths.length} image(s) to ${sshConfig.host}:${remoteDir}`);

      return {
        message: `${imageRef}\n\n${message}`,
        cleanup: async () => {
          try {
            const c = await sshService['getConnection'](sessionId, sshConfig);
            await new Promise<void>((resolve) => {
              c.exec(`rm -rf '${escapedRemoteDir}'`, (err, ch) => {
                if (err) return resolve();
                ch.on('close', () => resolve());
                ch.resume();
              });
            });
          } catch { /* best-effort remote cleanup */ }
        },
      };
    } catch (err) {
      await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => undefined);
      console.error(`[Claude Service] Failed to upload images to remote ${sshConfig.host}:`, err);
      return { message, cleanup: async () => undefined };
    }
  }

  /**
   * Resize a base64-encoded image if either dimension exceeds the max allowed size.
   * Uses Electron's built-in nativeImage — no external native dependencies needed.
   * Anthropic recommends 1568px max for multi-image requests (hard limit is 2000px).
   */
  private async resizeImageIfNeeded(base64Data: string, mediaType: string): Promise<string> {
    const MAX_DIMENSION = 1568; // Anthropic recommended max (fits well under 2000px limit)

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const image = nativeImage.createFromBuffer(buffer);

      if (image.isEmpty()) return base64Data;

      const { width, height } = image.getSize();
      if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) return base64Data;

      console.log(`[Claude Service] Resizing image from ${width}x${height} (max ${MAX_DIMENSION}px)`);

      // Calculate new dimensions maintaining aspect ratio
      const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      const newWidth = Math.round(width * scale);
      const newHeight = Math.round(height * scale);

      const resized = image.resize({ width: newWidth, height: newHeight });

      // Convert back to the appropriate format
      const resizedBuffer = mediaType.includes('png') ? resized.toPNG() : resized.toJPEG(90);

      console.log(`[Claude Service] Image resized to ${newWidth}x${newHeight}, ${resizedBuffer.length} bytes`);
      return resizedBuffer.toString('base64');
    } catch (error) {
      console.error('[Claude Service] Failed to resize image, using original:', error);
      return base64Data;
    }
  }

  /**
   * Repair a transcript by removing the last user turn that contains oversized images.
   * Follows the same pattern as repairCorruptedTranscript().
   */
  private async repairOversizedImages(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair oversized images');
        return false;
      }

      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      let content: string | null = null;
      let transcriptPath: string | null = null;
      let isRemote = false;

      if (session?.sshConfig) {
        // SSH session — find and read transcript on remote machine
        isRemote = true;
        console.log('[Claude] Searching for remote transcript:', transcriptFilename);
        try {
          // Construct the expected path: ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl
          // Claude encodes the workdir by replacing / with - (keeping leading -)
          const workdir = session.sshConfig.remoteWorkdir || '/tmp';
          const encodedDir = workdir.replace(/\//g, '-');
          transcriptPath = `~/.claude/projects/${encodedDir}/${transcriptFilename}`;
          console.log('[Claude] Trying remote transcript path:', transcriptPath);
          content = await sshService.readRemoteFile(sessionId, session.sshConfig, transcriptPath);
        } catch (e) {
          console.error('[Claude] Failed to read remote transcript:', e);
          return false;
        }
      } else {
        // Local session — find transcript in ~/.claude/projects/
        const claudeDir = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(claudeDir)) {
          console.log('[Claude] Claude projects directory not found:', claudeDir);
          return false;
        }
        const projectDirs = fs.readdirSync(claudeDir);
        for (const projectDir of projectDirs) {
          const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
          if (fs.existsSync(candidatePath)) {
            transcriptPath = candidatePath;
            break;
          }
        }
        if (!transcriptPath) {
          console.log('[Claude] Transcript file not found:', transcriptFilename);
          return false;
        }
        content = fs.readFileSync(transcriptPath, 'utf-8');
      }

      if (!content || !transcriptPath) {
        console.log('[Claude] No transcript content to repair');
        return false;
      }

      console.log('[Claude] Repairing oversized images in transcript:', transcriptPath);

      const lines = content.trim().split('\n');
      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      const entries: Array<{ line: string; parsed: Record<string, unknown> }> = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            entries.push({ line, parsed });
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Walk backwards to find the last user turn containing image blocks
      let lastUserTurnStart = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i].parsed;
        const message = entry.message as Record<string, unknown> | undefined;
        if (entry.type === 'user' || (message && message.role === 'user')) {
          const lineStr = entries[i].line;
          const msgContent = message?.content;
          if (lineStr.includes('"type":"image"') || lineStr.includes('"type": "image"') ||
              (Array.isArray(msgContent) && (msgContent as Array<Record<string, unknown>>).some(b => b.type === 'image'))) {
            lastUserTurnStart = i;
            break;
          }
        }
      }

      if (lastUserTurnStart === -1) {
        console.log('[Claude] Could not find user turn with images to remove');
        return false;
      }

      // Remove entries from the last user turn with images onwards
      const repairedEntries = entries.slice(0, lastUserTurnStart);
      const repairedContent = repairedEntries.map(e => e.line).join('\n') + '\n';

      if (isRemote && session?.sshConfig) {
        // Write repaired transcript back to remote machine
        await sshService.writeRemoteFile(sessionId, session.sshConfig, transcriptPath, repairedContent);
      } else {
        // Local backup and write
        const backupPath = transcriptPath + '.backup.' + Date.now();
        fs.copyFileSync(transcriptPath, backupPath);
        console.log('[Claude] Created transcript backup:', backupPath);
        fs.writeFileSync(transcriptPath, repairedContent);
      }

      console.log('[Claude] Transcript repaired - removed', entries.length - lastUserTurnStart, 'entries (oversized image turn)');
      console.log('[Claude] Original entries:', entries.length, '-> Repaired entries:', repairedEntries.length);

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing oversized images:', error);
      return false;
    }
  }

  /**
   * Repair a corrupted transcript by removing the last assistant message entries
   * that contain corrupted thinking blocks.
   *
   * The error "thinking or redacted_thinking blocks in the latest assistant message
   * cannot be modified" means the last assistant turn's thinking was corrupted.
   * We repair this by removing those entries from the transcript.
   */
  private async repairCorruptedTranscript(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      // Resolve the SDK session ID
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair transcript');
        return false;
      }

      // Find the transcript file
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;

      if (!fs.existsSync(claudeDir)) {
        console.log('[Claude] Claude projects directory not found:', claudeDir);
        return false;
      }

      // Search for the transcript file
      let transcriptPath: string | null = null;
      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(candidatePath)) {
          transcriptPath = candidatePath;
          break;
        }
      }

      if (!transcriptPath) {
        console.log('[Claude] Transcript file not found:', transcriptFilename);
        return false;
      }

      console.log('[Claude] Repairing transcript:', transcriptPath);

      // Read the transcript file
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      // Parse lines to find the last assistant message and remove it
      // We need to find entries that are part of the corrupted assistant turn
      const entries: Array<{ line: string; parsed: Record<string, unknown> }> = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            entries.push({ line, parsed });
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Find the last assistant turn start and remove everything from there
      // Look for message types that indicate an assistant response
      let lastAssistantTurnStart = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i].parsed;
        // SDK transcript entries have various types
        // Look for 'assistant' type or message with role 'assistant'
        if (entry.type === 'assistant' ||
            (entry.message && (entry.message as Record<string, unknown>).role === 'assistant')) {
          lastAssistantTurnStart = i;
          break;
        }
      }

      if (lastAssistantTurnStart === -1) {
        console.log('[Claude] Could not find last assistant turn to remove');
        return false;
      }

      // Create backup before modifying
      const backupPath = transcriptPath + '.backup.' + Date.now();
      fs.copyFileSync(transcriptPath, backupPath);
      console.log('[Claude] Created transcript backup:', backupPath);

      // Remove entries from the last assistant turn onwards
      const repairedEntries = entries.slice(0, lastAssistantTurnStart);
      const repairedContent = repairedEntries.map(e => e.line).join('\n') + '\n';

      // Write repaired transcript
      fs.writeFileSync(transcriptPath, repairedContent);
      console.log('[Claude] Transcript repaired - removed', entries.length - lastAssistantTurnStart, 'entries');
      console.log('[Claude] Original entries:', entries.length, '-> Repaired entries:', repairedEntries.length);

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing transcript:', error);
      return false;
    }
  }

  /**
   * Repair a transcript that contains empty text content blocks.
   *
   * The error "text content blocks must be non-empty" means the transcript
   * contains entries with empty text. We repair by either:
   * 1. Removing entries with empty text content
   * 2. Fixing the empty text by replacing with a placeholder
   */
  private async repairEmptyTextBlocks(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      // Resolve the SDK session ID
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair empty text blocks');
        return false;
      }

      // Find the transcript file
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;

      if (!fs.existsSync(claudeDir)) {
        console.log('[Claude] Claude projects directory not found:', claudeDir);
        return false;
      }

      // Search for the transcript file
      let transcriptPath: string | null = null;
      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(candidatePath)) {
          transcriptPath = candidatePath;
          break;
        }
      }

      if (!transcriptPath) {
        console.log('[Claude] Transcript file not found:', transcriptFilename);
        return false;
      }

      console.log('[Claude] Repairing empty text blocks in transcript:', transcriptPath);

      // Read the transcript file
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      // Helper to check if an entry has empty text content
      const hasEmptyTextContent = (entry: Record<string, unknown>): boolean => {
        // Check message.content array for empty text blocks
        const message = entry.message as Record<string, unknown> | undefined;
        if (message?.content) {
          const contentArray = message.content as Array<{ type?: string; text?: string }>;
          if (Array.isArray(contentArray)) {
            for (const block of contentArray) {
              if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
                return true;
              }
            }
          }
        }
        // Check direct content property
        if (entry.content) {
          const contentArray = entry.content as Array<{ type?: string; text?: string }>;
          if (Array.isArray(contentArray)) {
            for (const block of contentArray) {
              if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
                return true;
              }
            }
          }
        }
        return false;
      };

      // Helper to fix empty text content by replacing with placeholder
      const fixEmptyTextContent = (entry: Record<string, unknown>): Record<string, unknown> => {
        const fixed = JSON.parse(JSON.stringify(entry)); // Deep clone

        const fixContent = (content: Array<{ type?: string; text?: string }>) => {
          for (const block of content) {
            if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
              block.text = '[empty]'; // Replace with placeholder
            }
          }
        };

        if (fixed.message?.content && Array.isArray(fixed.message.content)) {
          fixContent(fixed.message.content);
        }
        if (fixed.content && Array.isArray(fixed.content)) {
          fixContent(fixed.content);
        }

        return fixed;
      };

      // Parse and fix entries
      let modified = false;
      const repairedLines: string[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          if (hasEmptyTextContent(parsed)) {
            console.log('[Claude] Found entry with empty text content, fixing...');
            const fixed = fixEmptyTextContent(parsed);
            repairedLines.push(JSON.stringify(fixed));
            modified = true;
          } else {
            repairedLines.push(line);
          }
        } catch {
          // Keep unparseable lines as-is
          repairedLines.push(line);
        }
      }

      if (!modified) {
        console.log('[Claude] No empty text blocks found in transcript');
        // Fall back to removing last assistant turn as a more aggressive fix
        return this.repairCorruptedTranscript(sessionId, sdkSessionId);
      }

      // Create backup before modifying
      const backupPath = transcriptPath + '.backup.' + Date.now();
      fs.copyFileSync(transcriptPath, backupPath);
      console.log('[Claude] Created transcript backup:', backupPath);

      // Write repaired transcript
      const repairedContent = repairedLines.join('\n') + '\n';
      fs.writeFileSync(transcriptPath, repairedContent);
      console.log('[Claude] Transcript repaired - fixed empty text blocks');

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing empty text blocks:', error);
      return false;
    }
  }

  /**
   * Performance optimization: Check if we have cached messages for a session
   * Validates cache by comparing file hash (mtime + size)
   */
  private async getCachedMessages(
    sessionId: string,
    transcriptPath: string
  ): Promise<ChatMessage[] | null> {
    const cached = this.messageCache.get(sessionId);
    if (!cached) return null;
    if (cached.transcriptPath !== transcriptPath) {
      console.log('[Claude] Cache invalidated - transcript path changed:', sessionId);
      return null;
    }

    // Check if file changed (compare mtime + size for quick hash)
    try {
      const stats = await fs.promises.stat(transcriptPath);
      const currentHash = `${stats.mtime.getTime()}-${stats.size}`;

      if (cached.fileHash === currentHash) {
        console.log('[Claude] Using cached messages for', sessionId, `(${cached.messages.length} messages)`);
        return cached.messages;
      } else {
        console.log('[Claude] Cache invalidated - file changed:', sessionId);
      }
    } catch {
      // File doesn't exist or changed, invalidate cache
      console.log('[Claude] Cache invalidated - file not found:', sessionId);
    }

    return null;
  }

  /**
   * Performance optimization: Cache parsed messages with file hash
   */
  private setCachedMessages(
    sessionId: string,
    transcriptPath: string,
    messages: ChatMessage[]
  ): void {
    try {
      const stats = fs.statSync(transcriptPath);
      const fileHash = `${stats.mtime.getTime()}-${stats.size}`;

      this.messageCache.set(sessionId, {
        messages,
        loadedAt: Date.now(),
        fileHash,
        transcriptPath,
      });
      console.log('[Claude] Cached messages for', sessionId, `(${messages.length} messages)`);
    } catch (error) {
      console.warn('[Claude] Failed to cache messages:', error);
    }
  }

  /**
   * Performance optimization: Find and cache transcript file path
   */
  private findTranscriptPath(sessionId: string, sdkSessionId: string): string | null {
    // Check cache first
    if (this.transcriptPathCache.has(sessionId)) {
      const cached = this.transcriptPathCache.get(sessionId)!;
      if (cached.sdkSessionId === sdkSessionId && path.basename(cached.transcriptPath) === `${sdkSessionId}.jsonl` && fs.existsSync(cached.transcriptPath)) {
        return cached.transcriptPath;
      }
      // Path no longer valid, or belongs to a different SDK session.
      this.transcriptPathCache.delete(sessionId);
      console.log('[Claude] Transcript path cache invalidated:', sessionId);
    }

    // Search for transcript
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const transcriptFilename = `${sdkSessionId}.jsonl`;

    try {
      if (!fs.existsSync(claudeDir)) {
        return null;
      }

      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const transcriptPath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(transcriptPath)) {
          // Cache for next time
          this.transcriptPathCache.set(sessionId, { sdkSessionId, transcriptPath });
          console.log('[Claude] Cached transcript path for', sessionId);
          return transcriptPath;
        }
      }
    } catch (error) {
      console.error('[Claude] Error searching for transcript:', error);
    }

    return null;
  }

  /**
   * Public API: Invalidate message cache for a session (call when new message sent)
   */
  invalidateMessageCache(sessionId: string): void {
    if (this.messageCache.delete(sessionId)) {
      console.log('[Claude] Invalidated message cache for', sessionId);
    }
  }

  private getCanonicalTranscriptCandidateIds(sessionId: string): string[] {
    const preferredIds = new Set<string>();
    const candidateIds = new Set<string>();
    const add = (id: unknown, target = candidateIds): void => {
      if (typeof id === 'string' && id.trim()) {
        target.add(id);
      }
    };
    const prefer = (id: unknown): void => add(id, preferredIds);
    const collectFromSession = (session: Session | undefined): void => {
      if (!session) return;
      add(session.id);
      add(session.sdkSessionId);
      add(session.continuedFromSessionId);
      (session.relatedSessionIds || []).forEach((id) => add(id));
    };

    add(sessionId);

    const sdkSessionMappings = (this.sessionStore.get('sdkSessionMappings') || {}) as Record<string, string>;
    add(sdkSessionMappings[sessionId]);
    Object.entries(sdkSessionMappings).forEach(([localSessionId, sdkSessionId]) => {
      if (localSessionId === sessionId) {
        prefer(localSessionId);
        add(localSessionId);
        add(sdkSessionId);
      }
      if (sdkSessionId === sessionId) {
        prefer(localSessionId);
        add(localSessionId);
        add(sdkSessionId);
      }
    });

    const storedSessions = (this.sessionStore.get('sessions') || {}) as Record<string, Session>;
    const discoveredSessions = (this.sessionStore.get('discoveredSessions') || {}) as Record<string, Session>;
    collectFromSession(storedSessions[sessionId]);
    collectFromSession(discoveredSessions[sessionId]);
    Object.values({ ...storedSessions, ...discoveredSessions }).forEach((session) => {
      if (
        session.id === sessionId
        || session.sdkSessionId === sessionId
        || session.continuedFromSessionId === sessionId
        || (session.relatedSessionIds || []).includes(sessionId)
      ) {
        prefer(session.id);
        collectFromSession(session);
      }
    });

    return Array.from(new Set([sessionId, ...preferredIds, ...candidateIds]));
  }

  private getBuildTranscriptLatestTime(candidateId: string, entries: TranscriptEntry[]): number {
    const latestEntryTime = entries.reduce((latest, entry) => {
      const time = Date.parse(entry.timestamp);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, 0);
    if (latestEntryTime > 0) return latestEntryTime;

    try {
      const stat = fs.statSync(transcriptService.getTranscriptPath(candidateId));
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }

  private loadBuildTranscriptForSession(sessionId: string): { sessionId: string; entries: TranscriptEntry[]; exists: boolean } {
    const candidateIds = this.getCanonicalTranscriptCandidateIds(sessionId);
    const fallbackId = sessionId;
    const transcripts: Array<{
      sessionId: string;
      entries: TranscriptEntry[];
      exists: true;
      hasAssistant: boolean;
      latestTime: number;
      candidateIndex: number;
    }> = [];

    for (const [candidateIndex, candidateId] of candidateIds.entries()) {
      if (!transcriptService.hasTranscript(candidateId)) continue;
      const entries = transcriptService.loadMessages(candidateId);
      const messages = transcriptEntriesToChatMessages(entries)
        .filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));
      transcripts.push({
        sessionId: candidateId,
        entries,
        exists: true,
        hasAssistant: messages.some((message) => message.role === 'assistant'),
        latestTime: this.getBuildTranscriptLatestTime(candidateId, entries),
        candidateIndex,
      });
    }

    const usableTranscripts = transcripts.filter((transcript) => transcript.entries.length > 0);
    if (usableTranscripts.length > 0) {
      const withAssistant = usableTranscripts.filter((transcript) => transcript.hasAssistant);
      const candidates = withAssistant.length > 0 ? withAssistant : usableTranscripts;
      const selected = [...candidates].sort((a, b) => {
        const timeDelta = b.latestTime - a.latestTime;
        if (timeDelta !== 0) return timeDelta;
        if (a.sessionId === sessionId && b.sessionId !== sessionId) return -1;
        if (b.sessionId === sessionId && a.sessionId !== sessionId) return 1;
        return a.candidateIndex - b.candidateIndex;
      })[0];

      if (selected.sessionId !== sessionId) {
        console.log(
          `[Claude] Using freshest Build transcript alias ${selected.sessionId} for session ${sessionId}`
          + ` (${new Date(selected.latestTime || Date.now()).toISOString()})`
        );
      }
      return { sessionId: selected.sessionId, entries: selected.entries, exists: true };
    }

    return { sessionId: fallbackId, entries: [], exists: false };
  }

  hasBuildTranscriptForSession(sessionId: string): boolean {
    return this.loadBuildTranscriptForSession(sessionId).exists;
  }

  async getCanonicalMessages(
    sessionId: string,
    limit = 200,
    options: { allowSdkFallback?: boolean } = {},
  ): Promise<ChatMessage[]> {
    const buildTranscript = this.loadBuildTranscriptForSession(sessionId);
    const buildTranscriptEntries = buildTranscript.entries;
    const buildMessages = transcriptEntriesToChatMessages(buildTranscriptEntries);
    const usableBuildMessages = buildMessages
      .filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));
    if (buildTranscript.exists) {
      // Self-merge deduplicates near-duplicate assistant entries that accumulate
      // from parallel stream + recovery writes (e.g. a "Remote session hiccup"
      // version paired with the clean recovered version of the same turn).
      const deduped = mergeRecoveredStreamMessages([], usableBuildMessages, undefined);
      return filterInternalPromptEchoes(limit && limit > 0
        ? deduped.slice(-limit)
        : deduped);
    }

    if (options.allowSdkFallback === false) {
      // Latency guard: foreground turns normally skip the (possibly remote)
      // SDK transcript fetch. EXCEPTION: a continuing session with a thin
      // local Build transcript means the real history lives in the SDK
      // transcript and has never been backfilled (e.g. first turn after an
      // app restart, before the session was opened in the UI). Serving 4
      // messages of context for a 140-message conversation causes turn-level
      // amnesia (2026-07-08 cc87079c incident) — pay the one-time fetch.
      const isContinuingSession = Boolean(this.sessionStore.get(`sdkSessionMappings.${sessionId}`));
      const thinTranscript = usableBuildMessages.length < 10;
      if (!(isContinuingSession && thinTranscript)) {
        console.log(`[Claude] Skipping SDK transcript fallback for foreground context: ${sessionId.substring(0, 8)}`);
        return filterInternalPromptEchoes(limit && limit > 0
          ? usableBuildMessages.slice(-limit)
          : usableBuildMessages);
      }
      console.warn(
        `[Claude] Build transcript is thin (${usableBuildMessages.length} msgs) for continuing session ${sessionId.substring(0, 8)} — ` +
        'fetching SDK transcript despite foreground context to avoid turn amnesia'
      );
    }

    const claudeMessages = await this.getMessages(sessionId, limit).catch((error) => {
      console.warn('[Claude] Could not load Claude transcript for canonical history:', error);
      return [] as ChatMessage[];
    });
    const usableClaudeMessages = claudeMessages
      .filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));

    if (usableClaudeMessages.length > 0) {
      const upsert = transcriptService.upsertMessages(buildTranscript.sessionId, usableClaudeMessages, {
        existingEntries: buildTranscriptEntries,
      });
      if (upsert.changed) {
        console.log(`[Claude] Backfilled Build transcript for ${buildTranscript.sessionId} (${upsert.written} canonical entries)`);
      }
    }

    return filterInternalPromptEchoes(mergeRecoveredStreamMessages(
      usableBuildMessages,
      usableClaudeMessages,
      limit
    ));
  }

  /**
   * Get messages from SDK transcript files for a session
   * @param limit - Optional limit on number of messages to return (most recent). Default 200 for performance.
   */
  // limit: positive = most recent N, 0 or negative = full transcript (cat instead of tail)
  async getMessages(sessionId: string, limit = 200): Promise<ChatMessage[]> {
    const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
    console.log(`[Claude] getMessages called for ${sessionId.substring(0, 8)}, hasSSH: ${!!session?.sshConfig}, hasTeleport: ${!!session?.isTeleported}`);
    if (session?.isTeleported) {
      console.log('[Claude] Teleported session - no local transcript, will resume from remote:', sessionId);
      return [];
    }

    // Get the stored SDK session ID for this session
    // Try new location first, then fall back to old location for backwards compatibility
    // 'new' is a sentinel for brand-new sessions that have never had a conversation —
    // these must NOT inherit old transcripts from the same remote directory.
    const storedSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
      || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;
    const isNewSession = storedSdkSessionId === 'new';
    const hasStoredSdkSessionId = !!storedSdkSessionId && !isNewSession;
    const sdkSessionId = hasStoredSdkSessionId ? storedSdkSessionId : sessionId;

    // For SSH sessions, fetch transcript from the remote machine
    if (session?.sshConfig) {
      // Brand-new session — start fresh, don't search for old transcripts
      if (isNewSession) {
        console.log('[Claude] Brand-new SSH session — starting fresh (no transcript search)');
        return [];
      }

      // Only invalidate cache for full fetches (limit <= 0, used by HistoryPanel).
      // Normal loads use the 5-minute cache to avoid hammering SSH on every tab switch.
      if (limit <= 0) {
        sshService.invalidateTranscriptCache(sdkSessionId);
        sshService.invalidateTranscriptCache(sessionId);
      }

      // If no stored SDK ID, try to find the most recent transcript on the remote.
      // This handles the case where the mapping was lost (repair, migration, etc.)
      // but the conversation still exists on the remote.
      if (!hasStoredSdkSessionId) {
        console.log('[Claude] SSH session without stored SDK ID — searching for latest transcript');
        try {
          const transcripts = await sshService.listRemoteTranscripts(
            sessionId,
            session.sshConfig,
            session.sshConfig.remoteWorkdir
          );
          if (transcripts.length > 0) {
            // Use the most recent transcript (last modified)
            const latest = transcripts[0];
            console.log('[Claude] Found orphaned transcript, restoring mapping:', latest.sessionId);
            // Restore the mapping so future loads don't need to search
            this.sessionStore.set(`sdkSessionMappings.${sessionId}`, latest.sessionId);
            const content = await sshService.fetchRemoteTranscript(
              sessionId,
              session.sshConfig,
              latest.sessionId,
              session.sshConfig.remoteWorkdir,
              { full: limit <= 0 }
            );
            if (content) {
              const messages = this.parseTranscriptContent(content);
              const limited = limit > 0 ? messages.slice(-limit) : messages;
              console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages (restored mapping)`);
              this.messageCacheStore.set(sessionId, limited);
              return limited;
            }
          }
          console.log('[Claude] No transcripts found on remote — starting fresh');
          return [];
        } catch (error) {
          console.error('[Claude] Error searching for orphaned transcripts:', error);
          const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
          if (cached?.length) {
            console.log(`[Claude] Orphan search failed — returning ${cached.length} locally cached messages`);
            return cached;
          }
          return [];
        }
      }

      console.log('[Claude] SSH session - fetching transcript from remote:', sdkSessionId);
      try {
        const remoteContent = await sshService.fetchRemoteTranscript(
          sessionId,
          session.sshConfig,
          sdkSessionId,
          session.sshConfig.remoteWorkdir,
          { full: limit <= 0 }
        );

        if (remoteContent) {
          console.log('[Claude] Parsing remote transcript, length:', remoteContent.length);
          const messages = this.parseTranscriptContent(remoteContent);
          const limited = limit > 0 ? messages.slice(-limit) : messages;
          console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages`);
          // Cache locally for resilience against SSH disconnects
          this.messageCacheStore.set(sessionId, limited);
          return limited;
        }

        // Only fall back to listing transcripts if we have a stored SDK ID
        // This prevents new SSH sessions from picking up old conversations
        console.log('[Claude] Stored SDK ID not found directly, listing available transcripts...');
        const transcripts = await sshService.listRemoteTranscripts(
          sessionId,
          session.sshConfig,
          session.sshConfig.remoteWorkdir
        );

        if (transcripts.length > 0) {
          // Only use transcripts that match our stored SDK session ID
          const matching = transcripts.find(t => t.sessionId === storedSdkSessionId);
          if (matching) {
            console.log('[Claude] Found matching transcript:', matching.filename);
            const content = await sshService.fetchRemoteTranscript(
              sessionId,
              session.sshConfig,
              matching.sessionId,
              session.sshConfig.remoteWorkdir,
              { full: limit <= 0 }
            );
            if (content) {
              const messages = this.parseTranscriptContent(content);
              const limited = limit > 0 ? messages.slice(-limit) : messages;
              console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages`);
              this.messageCacheStore.set(sessionId, limited);
              return limited;
            }
          } else {
            console.log('[Claude] No transcript matching stored SDK ID:', storedSdkSessionId);
          }
        }

        console.log('[Claude] No matching remote transcript found');
        // Return local cache if available
        const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
        if (cached?.length) {
          console.log(`[Claude] Returning ${cached.length} locally cached messages (no remote match)`);
          return cached;
        }
        return [];
      } catch (error) {
        console.error('[Claude] Error fetching remote transcript:', error);
        // SSH is down — return locally cached messages so the UI doesn't lose history
        const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
        if (cached?.length) {
          console.log(`[Claude] SSH fetch failed — returning ${cached.length} locally cached messages`);
          return cached;
        }
        return [];
      }
    }

    // Look for transcript files in ~/.claude/projects/ - use cached path if available
    const perfStart = performance.now();
    const transcriptPath = this.findTranscriptPath(sessionId, sdkSessionId);

    if (!transcriptPath) {
      console.log('[Claude] Transcript not found:', sdkSessionId);
      return [];
    }

    // Check cache first (performance optimization)
    const cached = await this.getCachedMessages(sessionId, transcriptPath);
    if (cached) {
      const limited = limit > 0 ? cached.slice(-limit) : cached;
      console.log(`[Perf] Message load (cached) took ${performance.now() - perfStart}ms - returning ${limited.length}/${cached.length} messages`);
      return limited;
    }

    try {
      console.log('[Claude] Loading transcript:', path.basename(transcriptPath));
      const projectDir = path.dirname(transcriptPath);
      const messages = this.parseTranscriptsFromDir(projectDir, sdkSessionId);

      // Cache for next time (performance optimization)
      this.setCachedMessages(sessionId, transcriptPath, messages);

      const limited = limit > 0 ? messages.slice(-limit) : messages;
      console.log(`[Perf] Message load (uncached) took ${performance.now() - perfStart}ms - returning ${limited.length}/${messages.length} messages`);
      return limited;
    } catch (error) {
      console.error('[Claude] Error reading transcripts:', error);
      return [];
    }
  }

  /**
   * Parse transcript content (JSONL string) into ChatMessages
   */
  private parseTranscriptContent(content: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const seenIds = new Set<string>();
    const messageMap = new Map<string, ChatMessage>();
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const result = this.parseTranscriptEntry(entry);
        if (!result) continue;

        // parseTranscriptEntry returns { msg, messageId }
        const { msg, messageId } = result;

        // Check if we already have a message with this Claude message ID
        const existing = messageMap.get(messageId);
        if (existing) {
          this.mergeTranscriptMessage(existing, msg);
        } else {
          // New message
          messageMap.set(messageId, msg);
          seenIds.add(msg.id);
          messages.push(msg);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  /**
   * Parse JSONL transcript files from a directory into ChatMessages
   * If sdkSessionId is provided, only load that specific session's transcript
   * Otherwise, load the most recently modified transcript
   */
  private parseTranscriptsFromDir(dir: string, sdkSessionId?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const seenIds = new Set<string>();

    try {
      let targetFile: string | null = null;

      if (sdkSessionId) {
        // Look for the specific session's transcript file
        const sessionFile = `${sdkSessionId}.jsonl`;
        const sessionFilePath = path.join(dir, sessionFile);
        if (fs.existsSync(sessionFilePath)) {
          targetFile = sessionFile;
          console.log('[Claude] Loading specific session transcript:', sessionFile);
        } else {
          console.warn('[Claude] Requested SDK transcript not found; refusing to load a different transcript:', sdkSessionId);
          return [];
        }
      }

      if (!targetFile) {
        // Fall back to most recently modified transcript (not agent files)
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
          .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(dir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.mtime - a.mtime); // Sort by most recent first

        if (files.length > 0) {
          targetFile = files[0].name;
          console.log('[Claude] Loading most recent transcript:', targetFile);
        }
      }

      if (!targetFile) {
        console.log('[Claude] No transcript files found in:', dir);
        return [];
      }

      const filePath = path.join(dir, targetFile);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Map to track messages by their Claude message ID for merging partial messages
      const messageMap = new Map<string, ChatMessage>();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const result = this.parseTranscriptEntry(entry);
          if (!result) continue;

          const { msg, messageId } = result;

          // Check if we already have a message with this Claude message ID
          const existing = messageMap.get(messageId);
          if (existing) {
            this.mergeTranscriptMessage(existing, msg);
          } else {
            // New message
            messageMap.set(messageId, msg);
            seenIds.add(msg.id);
            messages.push(msg);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      console.error('Error parsing transcripts from dir:', dir, error);
    }

    return messages;
  }

  private contentBlockKey(block: ContentBlock): string {
    return `${block.type}:${block.text || ''}:${block.toolCallId || ''}:${block.agentId || ''}`;
  }

  private mergeTranscriptMessage(existing: ChatMessage, msg: ChatMessage): void {
    // Merge content: SDK may write multiple rows for the same message as it
    // streams; keep the fullest text rather than concatenating duplicates.
    if (msg.content && msg.content !== existing.content) {
      if (!existing.content || msg.content.length > existing.content.length) {
        existing.content = msg.content;
      }
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      if (!existing.toolCalls) {
        existing.toolCalls = [...msg.toolCalls];
      } else {
        const existingIds = new Set(existing.toolCalls.map(tc => tc.id));
        for (const tc of msg.toolCalls) {
          if (!existingIds.has(tc.id)) {
            existing.toolCalls.push(tc);
            existingIds.add(tc.id);
          }
        }
      }
    }

    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      if (!existing.contentBlocks) {
        existing.contentBlocks = [...msg.contentBlocks];
      } else {
        const existingKeys = new Set(existing.contentBlocks.map(block => this.contentBlockKey(block)));
        for (const block of msg.contentBlocks) {
          const key = this.contentBlockKey(block);
          if (!existingKeys.has(key)) {
            existing.contentBlocks.push(block);
            existingKeys.add(key);
          }
        }
      }
    }
  }

  /**
   * Parse a single transcript entry into a ChatMessage
   * Returns the message ID for deduplication (may differ from the ChatMessage.id)
   */
  private parseTranscriptEntry(entry: Record<string, unknown>): { msg: ChatMessage; messageId: string } | null {
    // SDK transcript format varies - handle different message types
    const type = entry.type as string;

    // Extract the actual Claude message ID for deduplication
    // SDK writes multiple JSONL lines per message (thinking, text, tool_use blocks)
    // entry.uuid is unique per line, but entry.message.id is the actual message ID
    const message = entry.message as Record<string, unknown> | undefined;
    const claudeMessageId = (message?.id as string) || (entry.uuid as string) || (entry.id as string);

    if (type === 'user' || type === 'human') {
      const content = this.extractContent(entry);
      if (!content) return null;

      // Filter out system notifications injected as user messages by the CLI
      // (e.g. <task-notification>, <system-reminder>, compaction summaries).
      // These are internal bookkeeping, not actual user input.
      const trimmed = content.trim();
      if (trimmed.startsWith('<task-notification') ||
          trimmed.startsWith('<system-reminder') ||
          trimmed.startsWith('<command-name>') ||
          trimmed.startsWith('<local-command')) {
        return null;
      }

      return {
        msg: {
          id: (entry.uuid as string) || `user-${Date.now()}-${Math.random()}`,
          role: 'user',
          content,
          timestamp: entry.timestamp ? new Date(entry.timestamp as string) : new Date(),
          harness: 'claude' as const,
        },
        messageId: claudeMessageId,
      };
    }

    if (type === 'assistant') {
      const content = this.extractContent(entry);
      const toolCalls = this.extractToolCalls(entry);
      const contentBlocks = this.extractContentBlocks(entry);
      return {
        msg: {
          id: (entry.uuid as string) || `assistant-${Date.now()}-${Math.random()}`,
          role: 'assistant',
          content: content || '',
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
          timestamp: entry.timestamp ? new Date(entry.timestamp as string) : new Date(),
          harness: 'claude' as const,
        },
        messageId: claudeMessageId,
      };
    }

    return null;
  }

  /**
   * Extract text content from various message formats
   */
  private extractContent(entry: Record<string, unknown>): string {
    // Direct content string
    if (typeof entry.content === 'string') {
      return entry.content;
    }

    // Content array (Claude API format)
    if (Array.isArray(entry.content)) {
      return entry.content
        .filter((block: { type?: string; text?: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text || '')
        .join('\n');
    }

    // Message wrapper
    if (entry.message && typeof entry.message === 'object') {
      return this.extractContent(entry.message as Record<string, unknown>);
    }

    return '';
  }

  /**
   * Extract tool calls from message content
   */
  private extractToolCalls(entry: Record<string, unknown>): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    const content = entry.content || (entry.message as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) return toolCalls;

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
          status: 'completed',
          result: block.result,
          startedAt: new Date(),
          completedAt: new Date(),
        });
      }
    }

    return toolCalls;
  }

  private extractContentBlocks(entry: Record<string, unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const content = entry.content || (entry.message as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) return blocks;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const contentBlock = block as Record<string, unknown>;
      if (contentBlock.type === 'text' && typeof contentBlock.text === 'string' && contentBlock.text.trim()) {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === 'text') {
          lastBlock.text = (lastBlock.text || '') + contentBlock.text;
        } else {
          blocks.push({ type: 'text', text: contentBlock.text });
        }
      } else if (contentBlock.type === 'tool_use' && typeof contentBlock.id === 'string') {
        blocks.push({ type: 'tool_use', toolCallId: contentBlock.id });
      }
    }

    return blocks;
  }
}
