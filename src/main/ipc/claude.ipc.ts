import { app, BrowserWindow, IpcMain } from 'electron';
import Store from 'electron-store';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { ClaudeService } from '../services/claude.service';
import { getMainWindow } from '../index';
import type { QuestionResponse, Attachment, PlanApprovalResponse, ChatMessage, ToolCall, ContentBlock } from '../../shared/types';
import {
  hasRecoverableOutput,
  mergeRecoveredStreamMessages,
  normalizeCompletedStreamMessage,
  serializeCompletedStreamMessage,
  harnessFromModel,
  filterInternalPromptEchoes,
  type PersistedChatMessage,
} from '../../shared/utils/message-recovery';
import { buildCompletedStreamMessage } from '../../shared/utils/stream-finalization';
import { transcriptService, type TranscriptEntry } from '../services/transcript.service';
import { sessionService } from './session.ipc';
import { DEFAULT_AUDIO_SETTINGS } from '../../shared/types/audio';
import { messageQueueService } from '../services/message-queue.service';
import { sshService } from '../services/ssh.service';
import { updateDynamicSessionTitle } from '../services/session-title.service';
import { sessionTurnService, type TurnTransition } from '../services/session-turn.service';
import { recoveryService } from '../services/recovery.service';
import { queueController } from '../services/queue-controller.service';
import { slashWorkflowService } from '../services/slash-workflow.service';

// Settings store for Ralph Loop check
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;
const COMPLETED_STREAM_MESSAGE_LIMIT = 100;
const STALE_QUEUE_DRAIN_ACTIVE_QUERY_GRACE_MS = 30_000;
const STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS = 30_000;
// A live remote turn is only "stale" when its log stops growing for this long.
// Progressing turns are never killed — the renderer reattaches to them instead.
const STALE_QUEUE_DRAIN_REMOTE_STUCK_MS = 5 * 60_000;

// Per-session progress watermark for the latest active detached job, used to
// distinguish a working remote turn from a genuinely hung one during drains.
const drainRemoteJobProgress = new Map<string, { jobDir: string; logBytes: number; lastProgressAt: number }>();
// Consecutive injection failures per session. After MAX_INJECTION_RETRIES the
// drain falls back to sending the queued message as a new turn (old behavior).
const drainInjectionFailures = new Map<string, number>();
const MAX_INJECTION_RETRIES = 3;

async function resolveCrossHarnessWorkflowMessage(
  sessionId: string,
  message: string,
  session?: Awaited<ReturnType<typeof sessionService.getSession>>,
): Promise<string> {
  try {
    const activeSession = session === undefined
      ? await sessionService.getSession(sessionId).catch(() => null)
      : session;
    const resolved = await slashWorkflowService.resolveInvocation(sessionId, message, activeSession);
    if (!resolved) return message;

    console.log(
      `[Slash Workflow] Resolved /${resolved.invocation.name} from ${resolved.definition.path} ` +
      `for shared harness execution (${resolved.referencedDefinitions.length} referenced workflows)`
    );
    return resolved.prompt;
  } catch (error) {
    // A missing or temporarily unreachable extension source must not make the
    // send button fail. Native harness handling remains the safe fallback.
    console.warn(`[Slash Workflow] Failed to resolve workflow for ${sessionId}:`, error);
    return message;
  }
}

// Durable buffer for harness responses that are not backed by a Claude transcript.
// Keep this out of electron-store: that store rewrites the whole JSON file
// synchronously, and this cache has grown into hundreds of MB in real profiles.
class CompletedStreamRecoveryStore {
  private data: Record<string, PersistedChatMessage[]> | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly filePath = path.join(app.getPath('userData'), 'claudette-completed-stream-messages.json');
  private readonly maxBytes = 25 * 1024 * 1024;
  private readonly maxSessions = 200;

  get(sessionId: string): PersistedChatMessage[] {
    return this.load()[sessionId] || [];
  }

  set(sessionId: string, messages: PersistedChatMessage[]): void {
    const data = this.load();
    data[sessionId] = messages;
    this.prune(data);
    this.scheduleFlush();
  }

  private load(): Record<string, PersistedChatMessage[]> {
    if (this.data) return this.data;

    try {
      const stat = fs.existsSync(this.filePath) ? fs.statSync(this.filePath) : null;
      if (stat && stat.size > this.maxBytes) {
        fs.renameSync(this.filePath, `${this.filePath}.oversized-${Date.now()}.bak`);
        this.data = {};
        return this.data;
      }

      if (stat) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = parsed && typeof parsed === 'object' ? parsed : {};
      } else {
        this.data = {};
      }
    } catch (error) {
      console.warn('[Claude IPC] Failed to load completed stream recovery store; starting fresh:', error);
      this.data = {};
    }

    const data = this.data || {};
    this.data = data;
    this.prune(data);
    return data;
  }

  private prune(data: Record<string, PersistedChatMessage[]>): void {
    const entries = Object.entries(data)
      .filter((entry): entry is [string, PersistedChatMessage[]] => Array.isArray(entry[1]))
      .map(([sessionId, messages]) => {
        const capped = messages.slice(-COMPLETED_STREAM_MESSAGE_LIMIT);
        const latest = capped.reduce((max, message) => {
          const time = message.timestamp ? new Date(message.timestamp).getTime() : 0;
          return Number.isFinite(time) ? Math.max(max, time) : max;
        }, 0);
        return { sessionId, messages: capped, latest };
      })
      .sort((a, b) => b.latest - a.latest)
      .slice(0, this.maxSessions);

    for (const key of Object.keys(data)) {
      delete data[key];
    }
    for (const entry of entries) {
      data[entry.sessionId] = entry.messages;
    }
  }

  private scheduleFlush(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 2000);
  }

  private flush(): void {
    if (!this.data) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch (error) {
      console.warn('[Claude IPC] Failed to flush completed stream recovery store:', error);
    }
  }
}

const completedStreamStore = new CompletedStreamRecoveryStore();
const STREAM_DEBUG = process.env.GREP_DEBUG_STREAMING === '1';
const MAX_RENDERER_TOOL_PAYLOAD_CHARS = 50_000;

// Ralph Loop completion marker
// Ralph Loop uses Stop hook in claude.service.ts (Anthropic SDK pattern)
// Completion marker checked by the Stop hook
const RALPH_LOOP_COMPLETION_MARKER = '<promise>COMPLETE</promise>';

const claudeService = new ClaudeService();
claudeService.setOnSessionNameChanged(() => sessionService.refreshSessionList());

const completedStreamMessages = new Map<string, ChatMessage[]>();
const RENDERER_FULL_DETAIL_TAIL_MESSAGES = 12;

function loadCompletedStreamMessages(sessionId: string): ChatMessage[] {
  const cached = completedStreamMessages.get(sessionId);
  if (cached) return cached;

  const stored = completedStreamStore.get(sessionId);
  const normalized = (Array.isArray(stored) ? stored : [])
    .map(normalizeCompletedStreamMessage)
    .filter((message): message is ChatMessage => Boolean(message));
  completedStreamMessages.set(sessionId, normalized);
  return normalized;
}

function saveCompletedStreamMessages(sessionId: string, messages: ChatMessage[]): void {
  const capped = messages.slice(-COMPLETED_STREAM_MESSAGE_LIMIT);
  completedStreamMessages.set(sessionId, capped);
  completedStreamStore.set(sessionId, capped.map(serializeCompletedStreamMessage));
}

function recordCompletedStreamMessage(sessionId: string, message: ChatMessage): void {
  if (claudeService.hasBuildTranscriptForSession(sessionId)) return;
  if (!hasRecoverableOutput(message)) return;

  const normalizedMessage = normalizeCompletedStreamMessage(message);
  if (!normalizedMessage) return;

  const existing = loadCompletedStreamMessages(sessionId);
  const withoutDuplicate = existing.filter((item) => item.id !== message.id);
  saveCompletedStreamMessages(sessionId, [...withoutDuplicate, normalizedMessage]);
}

function mergeCompletedStreamMessages(transcriptMessages: ChatMessage[], sessionId: string, limit?: number): ChatMessage[] {
  return mergeRecoveredStreamMessages(transcriptMessages, loadCompletedStreamMessages(sessionId), limit);
}

function countMessageToolActivity(message: ChatMessage): number {
  const toolCallCount = message.toolCalls?.length || 0;
  const blockToolCount = (message.contentBlocks || [])
    .filter((block) => block.type === 'tool_use' && block.toolCallId)
    .length;
  return Math.max(toolCallCount, blockToolCount);
}

function slimHistoricalMessageForRenderer(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message;

  const toolCount = countMessageToolActivity(message);
  if (toolCount === 0 && !message.contentBlocks?.length) return message;

  return {
    ...message,
    content: message.content || `Completed ${toolCount} historical tool call${toolCount === 1 ? '' : 's'}.`,
    toolCalls: undefined,
    contentBlocks: undefined,
    metadata: {
      ...message.metadata,
      historicalToolCallCount: toolCount,
    },
  } as ChatMessage;
}

function slimMessagesForRenderer(messages: ChatMessage[], limit?: number): ChatMessage[] {
  // Full transcript reads are used by history/export style views. Normal chat
  // hydration asks for a positive limit and should not structured-clone old
  // multi-MB tool payloads into the renderer on startup or tab switches.
  if (!limit || limit <= 0 || messages.length <= RENDERER_FULL_DETAIL_TAIL_MESSAGES) {
    return messages;
  }

  const fullDetailStart = Math.max(0, messages.length - RENDERER_FULL_DETAIL_TAIL_MESSAGES);
  return messages.map((message, index) => (
    index < fullDetailStart ? slimHistoricalMessageForRenderer(message) : message
  ));
}

function truncateRendererString(value: string): string {
  if (value.length <= MAX_RENDERER_TOOL_PAYLOAD_CHARS) return value;
  const headChars = Math.floor(MAX_RENDERER_TOOL_PAYLOAD_CHARS * 0.65);
  const tailChars = MAX_RENDERER_TOOL_PAYLOAD_CHARS - headChars;
  return [
    value.slice(0, headChars),
    `\n\n... truncated ${value.length - MAX_RENDERER_TOOL_PAYLOAD_CHARS} chars for live UI ...\n\n`,
    value.slice(-tailChars),
  ].join('');
}

function slimPayloadForRenderer(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateRendererString(value);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return value;
  }

  if (!serialized || serialized.length <= MAX_RENDERER_TOOL_PAYLOAD_CHARS) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, MAX_RENDERER_TOOL_PAYLOAD_CHARS),
  };
}

function slimRecordPayloadForRenderer(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const slimmed = slimPayloadForRenderer(value || {});
  return slimmed && typeof slimmed === 'object' && !Array.isArray(slimmed)
    ? slimmed as Record<string, unknown>
    : { value: slimmed };
}

function slimToolCallForRenderer(toolCall: ToolCall | undefined): ToolCall | undefined {
  if (!toolCall) return undefined;
  return {
    ...toolCall,
    input: slimRecordPayloadForRenderer(toolCall.input),
    result: slimPayloadForRenderer(toolCall.result),
  };
}

function slimMessageForRenderer(message: ChatMessage): ChatMessage {
  if (!message.toolCalls?.length) return message;
  return {
    ...message,
    toolCalls: message.toolCalls.map(tc => slimToolCallForRenderer(tc) || tc),
  };
}

/** Serialize accumulated tool calls to the compact transcript format. */
const MAX_TRANSCRIPT_TOOL_PAYLOAD_CHARS = 50_000;

function serializeTranscriptPayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  if (serialized.length <= MAX_TRANSCRIPT_TOOL_PAYLOAD_CHARS) return serialized;
  return JSON.stringify({
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, MAX_TRANSCRIPT_TOOL_PAYLOAD_CHARS),
  });
}

function serializeToolCallsForTranscript(toolCalls?: ToolCall[]): TranscriptEntry['toolCalls'] | undefined {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map(tc => ({
    id: tc.id,
    name: tc.name,
    input: serializeTranscriptPayload(tc.input),
    result: serializeTranscriptPayload(tc.result),
  }));
}

/** Write the completed assistant message to the canonical transcript store. */
function writeAssistantToTranscript(
  sessionId: string,
  finalMessage: ChatMessage,
  opts: {
    accumulatedThinking?: string;
    model?: string | null;
    resolvedModel?: string | null;
  } = {},
): string {
  if (!hasRecoverableOutput(finalMessage)) return finalMessage.id;

  const harness = finalMessage.harness || harnessFromModel(opts.model || opts.resolvedModel);
  const result = transcriptService.upsertMessage(sessionId, {
    id: finalMessage.id || randomUUID(),
    role: 'assistant',
    content: finalMessage.content || '',
    timestamp: (finalMessage.timestamp instanceof Date ? finalMessage.timestamp : new Date()).toISOString(),
    harness,
    model: opts.resolvedModel || opts.model || undefined,
    toolCalls: serializeToolCallsForTranscript(finalMessage.toolCalls),
    thinking: opts.accumulatedThinking || undefined,
    interrupted: finalMessage.interrupted || undefined,
    contentBlocks: finalMessage.contentBlocks,
  });
  return result.canonicalId;
}

function createTranscriptSnapshotWriter(sessionId: string, model?: string | null, overrideId?: string) {
  let id = overrideId || randomUUID();
  const startedAt = new Date();
  let lastWriteAt = 0;
  let lastWrittenSignature = '';
  let pendingTimer: NodeJS.Timeout | null = null;
  let latestSnapshot: {
    content: string;
    toolCalls: ToolCall[];
    contentBlocks: ContentBlock[];
    accumulatedThinking?: string;
    resolvedModel?: string | null;
    interrupted?: boolean;
  } | null = null;

  const write = (): void => {
    if (!latestSnapshot) return;
    const signature = JSON.stringify(latestSnapshot);
    if (signature === lastWrittenSignature) return;
    lastWriteAt = Date.now();
    const snapshotMessage: ChatMessage = {
      id,
      role: 'assistant',
      content: latestSnapshot.content,
      timestamp: startedAt,
      toolCalls: latestSnapshot.toolCalls.length > 0 ? latestSnapshot.toolCalls : undefined,
      contentBlocks: latestSnapshot.contentBlocks.length > 0 ? latestSnapshot.contentBlocks : undefined,
      interrupted: latestSnapshot.interrupted,
      harness: harnessFromModel(latestSnapshot.resolvedModel || model),
    };
    id = writeAssistantToTranscript(sessionId, snapshotMessage, {
      accumulatedThinking: latestSnapshot.accumulatedThinking,
      model,
      resolvedModel: latestSnapshot.resolvedModel,
    });
    lastWrittenSignature = signature;
  };

  const schedule = (force = false): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (force || Date.now() - lastWriteAt >= 750) {
      write();
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      write();
    }, 750);
  };

  return {
    update(snapshot: NonNullable<typeof latestSnapshot>, force = false): void {
      latestSnapshot = snapshot;
      if (!snapshot.content.trim() && snapshot.toolCalls.length === 0 && snapshot.contentBlocks.length === 0) {
        return;
      }
      schedule(force);
    },
    finalize(finalMessage: ChatMessage, opts: {
      accumulatedThinking?: string;
      resolvedModel?: string | null;
      interrupted?: boolean;
    } = {}): ChatMessage {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      const finalizedMessage: ChatMessage = {
        ...finalMessage,
        id,
        timestamp: new Date(),
        interrupted: opts.interrupted || finalMessage.interrupted,
        harness: finalMessage.harness || harnessFromModel(opts.resolvedModel || model),
      };
      latestSnapshot = {
        content: finalizedMessage.content || '',
        toolCalls: finalizedMessage.toolCalls || [],
        contentBlocks: finalizedMessage.contentBlocks || [],
        accumulatedThinking: opts.accumulatedThinking,
        resolvedModel: opts.resolvedModel,
        interrupted: finalizedMessage.interrupted,
      };
      id = writeAssistantToTranscript(sessionId, finalizedMessage, {
        accumulatedThinking: opts.accumulatedThinking,
        model,
        resolvedModel: opts.resolvedModel,
      });
      finalizedMessage.id = id;
      lastWrittenSignature = JSON.stringify(latestSnapshot);
      return finalizedMessage;
    },
  };
}

// Batching helper to reduce IPC overhead
class ChunkBatcher {
  private textBuffer = '';
  private thinkingBuffer = '';
  private textTimer: NodeJS.Timeout | null = null;
  private thinkingTimer: NodeJS.Timeout | null = null;
  private currentAgentId: string | undefined = undefined;
  private readonly TEXT_BATCH_DELAY = 250;
  private readonly THINKING_BATCH_DELAY = 750;

  constructor(
    private sessionId: string,
    private sendText: (content: string, agentId?: string) => void,
    private sendThinking: (content: string) => void
  ) {}

  addText(content: string, agentId?: string) {
    // If agent changed mid-buffer, flush the old agent's text first
    if (this.textBuffer && this.currentAgentId !== agentId) {
      this.flushText();
    }
    this.currentAgentId = agentId;
    this.textBuffer += content;
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => this.flushText(), this.TEXT_BATCH_DELAY);
    }
  }

  addThinking(content: string) {
    this.thinkingBuffer += content;
    if (!this.thinkingTimer) {
      this.thinkingTimer = setTimeout(() => this.flushThinking(), this.THINKING_BATCH_DELAY);
    }
  }

  flushText() {
    if (this.textBuffer) {
      this.sendText(this.textBuffer, this.currentAgentId);
      this.textBuffer = '';
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
  }

  flushThinking() {
    if (this.thinkingBuffer) {
      this.sendThinking(this.thinkingBuffer);
      this.thinkingBuffer = '';
    }
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  flush() {
    this.flushText();
    this.flushThinking();
  }
}

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // NOTE: mainWindow reference is set directly in index.ts after window creation
  // Don't try to set it here as the window doesn't exist yet during IPC registration

  // Handler to get available models
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_MODELS, async () => {
    return claudeService.getAvailableModels();
  });

  // Fire-and-forget so a model-picker click is ordered ahead of the next send
  // IPC even when the user submits immediately after switching harnesses.
  ipcMain.on(IPC_CHANNELS.CLAUDE_NOTE_HARNESS_SWITCH, (_event, data: { sessionId: string; fromModel: string; toModel: string }) => {
    claudeService.noteHarnessSwitch(data.sessionId, data.fromModel, data.toModel);
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_SEND_MESSAGE,
    async (event, sessionId: string, message: string, attachments?: Attachment[], permissionMode?: string, thinkingMode?: string, model?: string, gstackMode?: string, supplementalMessages?: ChatMessage[], fastMode?: boolean, suppressUserMessage?: boolean, userMessageId?: string, cascadeMode?: boolean) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      // Send stream events to the SENDER window. If the sender is destroyed
      // (window closed/reloaded mid-stream), fall back to any live window.
      const senderContents = event.sender;
      claudeService.setSessionRenderer(sessionId, senderContents);
      const sendToSender = (channel: string, ...args: unknown[]) => {
        if (!senderContents.isDestroyed()) {
          senderContents.send(channel, ...args);
          return;
        }
        // Sender destroyed mid-stream — fall back to any live window
        console.warn(`[Claude IPC] Sender destroyed, falling back for ${channel}`);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send(channel, ...args);
            return;
          }
        }
        console.error(`[Claude IPC] No live windows to send ${channel} — event dropped!`);
      };

      // Ensure claudeService has the mainWindow reference for browser updates
      claudeService.setMainWindow(mainWindow);

      console.log('[Claude IPC] sendMessage received with attachments:', attachments?.length || 0, 'model:', model, 'permissionMode:', permissionMode, 'gstackMode:', gstackMode, 'cascadeMode:', Boolean(cascadeMode), 'supplementalMessages:', supplementalMessages?.length || 0);
      if (attachments) {
        attachments.forEach((a, i) => {
          console.log(`[Claude IPC] Attachment ${i}: type=${a?.type}, name=${a?.name}, content length=${a?.content?.length || 0}`);
        });
      }

      // Resolve project/user .claude commands and skills before routing. The
      // original invocation stays in the canonical transcript, while every
      // harness receives the same authoritative workflow definition.
      const streamSession = await sessionService.getSession(sessionId).catch(() => null);
      const modelMessage = await resolveCrossHarnessWorkflowMessage(sessionId, message, streamSession);

      // Create batcher for this session
      const batcher = new ChunkBatcher(
        sessionId,
        (content, agentId) => sendToSender(IPC_CHANNELS.CLAUDE_STREAM_CHUNK, { sessionId, content, agentId }),
        (content) => sendToSender(IPC_CHANNELS.CLAUDE_THINKING_CHUNK, { sessionId, content })
      );

      // Write visible user messages to the canonical transcript. Internal
      // continuations such as Ralph Loop /goal prompts are model input, but
      // should not come back as user-authored transcript rows after reload.
      if (!suppressUserMessage) {
        transcriptService.appendMessage(sessionId, {
          id: userMessageId || randomUUID(),
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
          harness: harnessFromModel(model),
        });
      }

      let fullMessageContent = '';
      let accumulatedThinking = '';
      let hadError = false;
      let pendingSshStreamError: string | undefined;
      let terminalProviderFailure = false;
      let sentStreamEnd = false;
      let turnCompleted = false;
      let notifiedQueueStreamEnd = false;
      let needsCompactionRetry = false;
      let latestResolvedModel: string | undefined;
      let activeQueueHarness = harnessFromModel(model);
      const turnLockOwner = Symbol('claude-ipc-send-message');
      const accumulatedToolCalls: ToolCall[] = [];
      const accumulatedContentBlocks: ContentBlock[] = [];
      const transcriptSnapshot = createTranscriptSnapshotWriter(sessionId, model);
      const persistTranscriptSnapshot = (force = false, interrupted = false): void => {
        transcriptSnapshot.update({
          content: fullMessageContent,
          toolCalls: accumulatedToolCalls,
          contentBlocks: accumulatedContentBlocks,
          accumulatedThinking,
          resolvedModel: latestResolvedModel,
          interrupted,
        }, force);
      };
      const upsertAccumulatedToolCall = (toolCall: ToolCall | undefined): void => {
        if (!toolCall) return;
        const idx = accumulatedToolCalls.findIndex(tc => tc.id === toolCall.id);
        if (idx >= 0) {
          accumulatedToolCalls[idx] = toolCall;
        } else {
          accumulatedToolCalls.push(toolCall);
        }
      };
      const appendTextContentBlock = (content: string | undefined, agentId?: string): void => {
        if (!content) return;
        const lastBlock = accumulatedContentBlocks[accumulatedContentBlocks.length - 1];
        if (lastBlock?.type === 'text' && lastBlock.agentId === agentId) {
          lastBlock.text = (lastBlock.text || '') + content;
        } else {
          accumulatedContentBlocks.push({ type: 'text', text: content, agentId });
        }
      };
      const appendToolContentBlock = (toolCall: ToolCall | undefined, agentId?: string): void => {
        if (!toolCall?.id) return;
        if (accumulatedContentBlocks.some(block => block.type === 'tool_use' && block.toolCallId === toolCall.id)) return;
        accumulatedContentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: toolCall.agentId || agentId });
      };
      const notifyQueueStreamEnd = (allowRemoteActiveDrain: boolean): void => {
        if (notifiedQueueStreamEnd) return;
        notifiedQueueStreamEnd = true;
        messageQueueService.onStreamEnd(sessionId, {
          drain: true,
          allowRemoteActiveDrain,
        });
      };

        try {
          // Notify queue service that streaming has started
          messageQueueService.onStreamStart(sessionId, harnessFromModel(model));
          drainInjectionFailures.delete(sessionId);

          // Parallel state machine tracking (Phase 6 - diagnostic only)
          sessionTurnService.transition(sessionId, 'STREAMING', 'send-message');

          // Stream the response (Stop hook handles Ralph Loop iteration)
          let eventCount = 0;
          let lastEventType = '';
          let lastEventTime = Date.now();
          const streamStartTime = Date.now();
          for await (const event of claudeService.streamMessage(sessionId, modelMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages, fastMode, cascadeMode, turnLockOwner)) {
            claudeService.noteActiveQueryEvent(sessionId);
            eventCount++;
            lastEventType = event.type;
            lastEventTime = Date.now();
            latestResolvedModel = event.resolvedModel || latestResolvedModel;
            if (event.resolvedModel) {
              const resolvedHarness = harnessFromModel(event.resolvedModel);
              if (resolvedHarness !== activeQueueHarness) {
                activeQueueHarness = resolvedHarness;
                messageQueueService.setActiveHarness(sessionId, resolvedHarness);
              }
            }
            if (STREAM_DEBUG && event.type !== 'text_delta' && event.type !== 'thinking_delta') {
              console.log(`[Claude IPC] Event #${eventCount} type=${event.type} for ${sessionId.substring(0, 8)} (+${Date.now() - streamStartTime}ms)`);
            }
            switch (event.type) {
              case 'text_delta':
                batcher.addText(event.content || '', event.agentId);
                appendTextContentBlock(event.content, event.agentId);
                fullMessageContent += event.content || '';
                persistTranscriptSnapshot();
                break;

              case 'thinking_delta':
                batcher.addThinking(event.content || '');
                accumulatedThinking += event.content || '';
                break;

              case 'tool_use':
                upsertAccumulatedToolCall(event.toolCall as ToolCall | undefined);
                appendToolContentBlock(event.toolCall as ToolCall | undefined, event.agentId);
                persistTranscriptSnapshot(true);
                sendToSender(IPC_CHANNELS.CLAUDE_TOOL_CALL, {
                  sessionId,
                  toolCall: slimToolCallForRenderer(event.toolCall as ToolCall | undefined),
                  agentId: event.agentId,
                });
                break;

              case 'tool_result':
                // Update the accumulated tool call with result
                upsertAccumulatedToolCall(event.toolCall as ToolCall | undefined);
                appendToolContentBlock(event.toolCall as ToolCall | undefined, event.agentId);
                persistTranscriptSnapshot(true);
                sendToSender(IPC_CHANNELS.CLAUDE_TOOL_RESULT, {
                  sessionId,
                  toolCall: slimToolCallForRenderer(event.toolCall as ToolCall | undefined),
                  agentId: event.agentId,
                });
                break;

              case 'system':
                sendToSender(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                  sessionId,
                  systemInfo: event.systemInfo,
                });
                break;

              case 'permission_request':
                sendToSender(IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, {
                  ...event,
                  sessionId,
                });
                break;

              case 'context_usage':
                // Forward context usage info to renderer for progress display
                // Includes rich breakdown from SDK getContextUsage() when available (v0.2.86+)
                sendToSender(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, {
                  sessionId,
                  inputTokens: (event as any).inputTokens,
                  contextWindowSize: (event as any).contextWindowSize,
                  percentage: (event as any).percentage,
                  ...((event as any).contextUsageBreakdown ? { breakdown: (event as any).contextUsageBreakdown } : {}),
                });
                break;

              case 'compaction_status':
                // Forward compaction status to renderer
                sendToSender(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, event.compactionStatus);
                break;

              case 'compaction_complete':
                // Forward compaction complete to renderer
                sendToSender(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, event.compactionComplete);

                // If we're waiting to retry after compaction, do it now
                if (needsCompactionRetry) {
                  console.log('[Claude IPC] Compaction complete - auto-retrying message');
                  needsCompactionRetry = false;

                  // Wait a moment for SDK to fully settle
                  await new Promise(resolve => setTimeout(resolve, 1000));

                  // Show retrying message to user
                  sendToSender(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                    sessionId,
                    systemInfo: { message: 'Compaction complete - retrying your message...' },
                  });

                  // Retry by starting a new stream with the same message
                  console.log('[Claude IPC] Starting retry stream after compaction');
                  try {
                    for await (const retryEvent of claudeService.streamMessage(sessionId, modelMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages, fastMode, cascadeMode, turnLockOwner)) {
                      latestResolvedModel = retryEvent.resolvedModel || latestResolvedModel;
                      if (retryEvent.resolvedModel) {
                        const resolvedHarness = harnessFromModel(retryEvent.resolvedModel);
                        if (resolvedHarness !== activeQueueHarness) {
                          activeQueueHarness = resolvedHarness;
                          messageQueueService.setActiveHarness(sessionId, resolvedHarness);
                        }
                      }
                      // Process retry events the same way
                      switch (retryEvent.type) {
                        case 'text_delta':
                          batcher.addText(retryEvent.content || '', retryEvent.agentId);
                          appendTextContentBlock(retryEvent.content, retryEvent.agentId);
                          fullMessageContent += retryEvent.content || '';
                          persistTranscriptSnapshot();
                          break;
                        case 'thinking_delta':
                          batcher.addThinking(retryEvent.content || '');
                          accumulatedThinking += retryEvent.content || '';
                          break;
                        case 'tool_use':
                          upsertAccumulatedToolCall(retryEvent.toolCall as ToolCall | undefined);
                          appendToolContentBlock(retryEvent.toolCall as ToolCall | undefined, retryEvent.agentId);
                          persistTranscriptSnapshot(true);
                          sendToSender(IPC_CHANNELS.CLAUDE_TOOL_CALL, {
                            sessionId,
                            toolCall: slimToolCallForRenderer(retryEvent.toolCall as ToolCall | undefined),
                            agentId: retryEvent.agentId,
                          });
                          break;
                        case 'tool_result':
                          upsertAccumulatedToolCall(retryEvent.toolCall as ToolCall | undefined);
                          appendToolContentBlock(retryEvent.toolCall as ToolCall | undefined, retryEvent.agentId);
                          persistTranscriptSnapshot(true);
                          sendToSender(IPC_CHANNELS.CLAUDE_TOOL_RESULT, {
                            sessionId,
                            toolCall: slimToolCallForRenderer(retryEvent.toolCall as ToolCall | undefined),
                            agentId: retryEvent.agentId,
                          });
                          break;
                        case 'system':
                          sendToSender(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                            sessionId,
                            systemInfo: retryEvent.systemInfo,
                          });
                          break;
                        case 'context_usage':
                          sendToSender(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, {
                            sessionId,
                            inputTokens: (retryEvent as any).inputTokens,
                            contextWindowSize: (retryEvent as any).contextWindowSize,
                            percentage: (retryEvent as any).percentage,
                            ...((retryEvent as any).contextUsageBreakdown ? { breakdown: (retryEvent as any).contextUsageBreakdown } : {}),
                          });
                          break;
                        case 'message_complete': {
                          batcher.flush();
                          turnCompleted = true;
                          const finalRetryMessage = buildCompletedStreamMessage({
                            message: retryEvent.message,
                            content: fullMessageContent,
                            toolCalls: accumulatedToolCalls,
                            contentBlocks: accumulatedContentBlocks,
                            model,
                            resolvedModel: retryEvent.resolvedModel || latestResolvedModel,
                          });
                          const finalizedRetryMessage = transcriptSnapshot.finalize(finalRetryMessage, {
                            accumulatedThinking,
                            resolvedModel: retryEvent.resolvedModel || latestResolvedModel,
                          });
                          recordCompletedStreamMessage(sessionId, finalizedRetryMessage);
                          sentStreamEnd = true;
                          sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, {
                            sessionId,
                            message: slimMessageForRenderer(finalizedRetryMessage),
                          });
                          notifyQueueStreamEnd(true);
                          break;
                        }
                        case 'error':
                          batcher.flush();
                          sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                            sessionId,
                            error: retryEvent.error,
                          });
                          break;
                        // Handle other event types as needed
                      }
                    }
                  } catch (retryError) {
                    console.error('[Claude IPC] Retry after compaction failed:', retryError);
                    sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                      sessionId,
                      error: 'Failed to retry after compaction',
                    });
                  }
                  return; // Exit after successful retry
                }
                break;

              case 'message_complete': {
                // Flush any remaining batched content
                batcher.flush();
                turnCompleted = true;
                console.log(`[Claude IPC] message_complete for ${sessionId}. fullMessageContent length: ${fullMessageContent.length}, sentStreamEnd was: ${sentStreamEnd}`);

                // Send STREAM_END (Stop hook handles Ralph Loop iteration)
                const finalMessage = buildCompletedStreamMessage({
                  message: event.message,
                  content: fullMessageContent,
                  toolCalls: accumulatedToolCalls,
                  contentBlocks: accumulatedContentBlocks,
                  model,
                  resolvedModel: event.resolvedModel || latestResolvedModel,
                });
                const finalizedMessage = transcriptSnapshot.finalize(finalMessage, {
                  accumulatedThinking,
                  resolvedModel: event.resolvedModel || latestResolvedModel,
                });
                recordCompletedStreamMessage(sessionId, finalizedMessage);
                sentStreamEnd = true;
                sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, {
                  sessionId,
                  message: slimMessageForRenderer(finalizedMessage),
                  // Surface terminal_reason from SDK result (v0.2.91+)
                  // Tells the UI why the query loop ended (e.g. 'completed', 'max_turns', 'aborted_tools')
                  ...((event as any).terminalReason ? { terminalReason: (event as any).terminalReason } : {}),
                });
                notifyQueueStreamEnd(true);
                break;
              }

              case 'error': {
                // Check if this is a compaction error (prompt too long)
                const isCompactionError = event.error?.includes('conversation history is being compacted');

                if (isCompactionError) {
                  console.log('[Claude IPC] Compaction error detected - will auto-retry after compaction');
                  needsCompactionRetry = true;

                  // Show user-friendly compaction message
                  batcher.flush();
                  sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                    sessionId,
                    error: event.error,
                  });

                  // Don't mark as hadError since we'll retry
                  // Continue processing events to catch compaction_complete
                  break;
                }

                // Regular error handling
                batcher.flush();
                terminalProviderFailure = terminalProviderFailure || event.terminalFailure === true;
                if (streamSession?.sshConfig) {
                  pendingSshStreamError = event.error;
                } else {
                  sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                    sessionId,
                    error: event.error,
                  });
                }
                hadError = true;
                break;
              }
            }
          }
        } catch (error) {
          // Flush any remaining batched content before error
          batcher.flush();
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          if (streamSession?.sshConfig) {
            pendingSshStreamError = errorMessage;
          } else {
            sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
              sessionId,
              error: errorMessage,
            });
          }
          hadError = true;
        } finally {
          claudeService.clearSessionRenderer(sessionId, senderContents);
          const completedSession = streamSession || await sessionService.getSession(sessionId).catch(() => null);
          let recoverableRemoteTurn = false;
          let remoteRecoveryProbeUnavailable = false;

          // An SSH transport ending is not the same thing as the agent turn
          // ending. Probe the detached bridge before publishing a terminal
          // event; otherwise the renderer persists a fake final response and
          // may tear down the bridge while the remote agent is still working.
          if (!sentStreamEnd && hadError && completedSession?.sshConfig && !terminalProviderFailure) {
            try {
              recoverableRemoteTurn = Boolean(await sshService.getLatestRecoverableRemoteProcess(
                sessionId,
                completedSession.sshConfig,
                { throwOnError: true },
              ));
            } catch (probeError) {
              // A failed probe usually means the same transport is still down.
              // Keep the turn recoverable until reconnect instead of converting
              // uncertainty into a false completion.
              remoteRecoveryProbeUnavailable = true;
              console.warn('[Claude IPC] Post-error remote turn probe unavailable; deferring finalization:', probeError);
            }
          }

          const deferFinalizationForRemoteRecovery = recoverableRemoteTurn || remoteRecoveryProbeUnavailable;

          if (pendingSshStreamError && !deferFinalizationForRemoteRecovery) {
            sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
              sessionId,
              error: pendingSshStreamError,
            });
          }

          // Safety net for turns that really ended. Recoverable SSH turns keep
          // their partial transcript snapshot but deliberately do not emit
          // STREAM_END; the reattach handler owns their eventual final event.
          if (!sentStreamEnd && deferFinalizationForRemoteRecovery) {
            persistTranscriptSnapshot(true, true);
            console.log(
              `[Claude IPC] Deferring STREAM_END for recoverable SSH turn ${sessionId} ` +
              `(job=${recoverableRemoteTurn ? 'found' : 'unknown'}, contentLength=${fullMessageContent.length})`
            );
          } else if (!sentStreamEnd) {
            console.log('[Claude IPC] Safety net: sending STREAM_END for', sessionId, 'hadError:', hadError, 'contentLength:', fullMessageContent.length);
            const finalMessage: ChatMessage = buildCompletedStreamMessage({
              content: fullMessageContent || '',
              toolCalls: accumulatedToolCalls,
              contentBlocks: accumulatedContentBlocks,
              model,
              resolvedModel: latestResolvedModel,
            });
            if (hadError) {
              finalMessage.interrupted = true;
            }
            const finalizedMessage = transcriptSnapshot.finalize(finalMessage, {
              accumulatedThinking,
              resolvedModel: latestResolvedModel,
              interrupted: hadError,
            });
            recordCompletedStreamMessage(sessionId, finalizedMessage);
            sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, {
              sessionId,
              message: slimMessageForRenderer(finalizedMessage),
            });
          }

          // Parallel state machine tracking (Phase 6 - diagnostic only)
          if (hadError && completedSession?.sshConfig && !terminalProviderFailure) {
            void recoveryService.handleStreamError(sessionId, new Error('stream error'), completedSession.sshConfig)
              .catch(err => console.warn('[Turn] Recovery error:', err));
          } else {
            sessionTurnService.transition(
              sessionId,
              'IDLE',
              terminalProviderFailure
                ? 'terminal provider failure'
                : hadError
                  ? 'stream error (non-SSH)'
                  : 'stream completed',
            );
          }

          if (completedSession?.sshConfig) {
            // A local stream error does NOT mean the remote turn died — lid
            // close and transport drops error the local stream while the
            // detached remote turn keeps working. Never kill active remote
            // work here; instead, if a live job survives the error, ask the
            // renderer to reattach so the turn streams to completion.
            void sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, completedSession.sshConfig, {
              killActive: false,
            }).catch((error) => {
              console.warn('[Claude IPC] Background stream-end SSH cleanup failed:', error);
            });
            console.log(`[Claude IPC] Stream-end SSH cleanup scheduled in background for ${sessionId}`);

            if (hadError) {
              if (deferFinalizationForRemoteRecovery) {
                console.log(
                  `[Claude IPC] Remote turn survived or may have survived local stream error for ${sessionId}; ` +
                  'requesting renderer reattach (queue drain suppressed)'
                );
                sendToSender(IPC_CHANNELS.CLAUDE_REMOTE_TURN_RECOVERABLE, { sessionId });
              } else {
                notifyQueueStreamEnd(false);
              }
              // When recovery is deferred: the reattach handler (CLAUDE_RESUME_REMOTE_TURN)
              // fires its own notifyQueueStreamEnd on completion — no drain needed here.
            } else {
              notifyQueueStreamEnd(turnCompleted);
            }
          } else {
            // Non-SSH session: drain immediately
            notifyQueueStreamEnd(!hadError && turnCompleted);
          }

          if (!hadError && !suppressUserMessage && fullMessageContent.trim()) {
            void updateDynamicSessionTitle({
              sessionId,
              session: completedSession,
              userMessage: message,
              assistantMessage: fullMessageContent,
              updateSession: (id, updates) => sessionService.updateSession(id, updates),
            }).catch((error) => {
              console.warn('[Claude IPC] Failed to update dynamic session title:', error);
            });
          }
        }

    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RESUME_REMOTE_TURN,
    async (event, sessionId: string, model?: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const senderContents = event.sender;
      claudeService.setSessionRenderer(sessionId, senderContents);
      const sendToSender = (channel: string, ...args: unknown[]) => {
        if (!senderContents.isDestroyed()) {
          senderContents.send(channel, ...args);
          return;
        }

        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send(channel, ...args);
            return;
          }
        }
      };

      claudeService.setMainWindow(mainWindow);

      // Derive a deterministic transcript id from the bridge job directory so
      // replaying the same remote job twice overwrites instead of appending.
      let recoveryTranscriptId: string | undefined;
      try {
        const recoverySession = await sessionService.getSession(sessionId);
        if (recoverySession?.sshConfig) {
          const latestJob = await sshService.getLatestRecoverableRemoteProcess(sessionId, recoverySession.sshConfig);
          if (latestJob?.jobDir) {
            const jobId = path.basename(latestJob.jobDir.replace(/\/+$/, ''));
            if (jobId) recoveryTranscriptId = `recovered-${jobId}`;
          }
        }
      } catch {
        // Non-fatal — fall back to random UUID
      }

      const batcher = new ChunkBatcher(
        sessionId,
        (content, agentId) => sendToSender(IPC_CHANNELS.CLAUDE_STREAM_CHUNK, { sessionId, content, agentId }),
        (content) => sendToSender(IPC_CHANNELS.CLAUDE_THINKING_CHUNK, { sessionId, content })
      );

      let fullMessageContent = '';
      let accumulatedThinkingResume = '';
      let hadError = false;
      let sentStreamEnd = false;
      let resumeProducedVisibleOutput = false;
      let resumeCompletedWithResult = false;
      let notifiedQueueStreamEnd = false;
      let latestResolvedModel: string | undefined = model;
      const accumulatedToolCalls: ToolCall[] = [];
      const accumulatedContentBlocks: ContentBlock[] = [];
      const transcriptSnapshot = createTranscriptSnapshotWriter(sessionId, model, recoveryTranscriptId);
      const persistTranscriptSnapshot = (force = false, interrupted = false): void => {
        transcriptSnapshot.update({
          content: fullMessageContent,
          toolCalls: accumulatedToolCalls,
          contentBlocks: accumulatedContentBlocks,
          accumulatedThinking: accumulatedThinkingResume,
          resolvedModel: latestResolvedModel,
          interrupted,
        }, force);
      };

      const upsertAccumulatedToolCall = (toolCall: ToolCall | undefined): void => {
        if (!toolCall) return;
        const idx = accumulatedToolCalls.findIndex(tc => tc.id === toolCall.id);
        if (idx >= 0) {
          accumulatedToolCalls[idx] = toolCall;
        } else {
          accumulatedToolCalls.push(toolCall);
        }
      };
      const appendTextContentBlock = (content: string | undefined, agentId?: string): void => {
        if (!content) return;
        const lastBlock = accumulatedContentBlocks[accumulatedContentBlocks.length - 1];
        if (lastBlock?.type === 'text' && lastBlock.agentId === agentId) {
          lastBlock.text = (lastBlock.text || '') + content;
        } else {
          accumulatedContentBlocks.push({ type: 'text', text: content, agentId });
        }
      };
      const appendToolContentBlock = (toolCall: ToolCall | undefined, agentId?: string): void => {
        if (!toolCall?.id) return;
        if (accumulatedContentBlocks.some(block => block.type === 'tool_use' && block.toolCallId === toolCall.id)) return;
        accumulatedContentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: toolCall.agentId || agentId });
      };
      const notifyQueueStreamEnd = (drain: boolean, allowRemoteActiveDrain: boolean): void => {
        if (notifiedQueueStreamEnd) return;
        notifiedQueueStreamEnd = true;
        if (!drain) {
          console.log(`[Claude IPC] Resume reattach produced no visible output; suppressing queue drain for ${sessionId}`);
        }
        messageQueueService.onStreamEnd(sessionId, {
          drain,
          allowRemoteActiveDrain,
        });
      };

      try {
        // Notify queue service that streaming has started (resume)
        messageQueueService.onStreamStart(sessionId, harnessFromModel(model));
        drainInjectionFailures.delete(sessionId);

        console.log('[Claude IPC] resumeRemoteTurn received for:', sessionId, 'model:', model);

        // Parallel state machine tracking (Phase 6 - diagnostic only)
        sessionTurnService.transition(sessionId, 'REATTACHING', 'resume-remote-turn');

        for await (const streamEvent of claudeService.resumeRemoteTurn(sessionId, model)) {
          claudeService.noteActiveQueryEvent(sessionId);
          latestResolvedModel = streamEvent.resolvedModel || latestResolvedModel;

          switch (streamEvent.type) {
            case 'text_delta':
              batcher.addText(streamEvent.content || '', streamEvent.agentId);
              appendTextContentBlock(streamEvent.content, streamEvent.agentId);
              fullMessageContent += streamEvent.content || '';
              if ((streamEvent.content || '').trim()) {
                resumeProducedVisibleOutput = true;
              }
              persistTranscriptSnapshot();
              break;

            case 'thinking_delta':
              batcher.addThinking(streamEvent.content || '');
              accumulatedThinkingResume += streamEvent.content || '';
              break;

            case 'tool_use':
              upsertAccumulatedToolCall(streamEvent.toolCall as ToolCall | undefined);
              appendToolContentBlock(streamEvent.toolCall as ToolCall | undefined, streamEvent.agentId);
              resumeProducedVisibleOutput = true;
              persistTranscriptSnapshot(true);
              sendToSender(IPC_CHANNELS.CLAUDE_TOOL_CALL, {
                sessionId,
                toolCall: slimToolCallForRenderer(streamEvent.toolCall as ToolCall | undefined),
                agentId: streamEvent.agentId,
              });
              break;

            case 'tool_result':
              upsertAccumulatedToolCall(streamEvent.toolCall as ToolCall | undefined);
              appendToolContentBlock(streamEvent.toolCall as ToolCall | undefined, streamEvent.agentId);
              resumeProducedVisibleOutput = true;
              persistTranscriptSnapshot(true);
              sendToSender(IPC_CHANNELS.CLAUDE_TOOL_RESULT, {
                sessionId,
                toolCall: slimToolCallForRenderer(streamEvent.toolCall as ToolCall | undefined),
                agentId: streamEvent.agentId,
              });
              break;

            case 'system':
              sendToSender(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                sessionId,
                systemInfo: streamEvent.systemInfo,
              });
              break;

            case 'context_usage':
              sendToSender(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, {
                sessionId,
                inputTokens: (streamEvent as any).inputTokens,
                contextWindowSize: (streamEvent as any).contextWindowSize,
                percentage: (streamEvent as any).percentage,
                ...((streamEvent as any).contextUsageBreakdown ? { breakdown: (streamEvent as any).contextUsageBreakdown } : {}),
              });
              break;

            case 'compaction_status':
              sendToSender(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, streamEvent.compactionStatus);
              break;

            case 'compaction_complete':
              sendToSender(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, streamEvent.compactionComplete);
              break;

            case 'message_complete': {
              batcher.flush();
              resumeCompletedWithResult = true;
              const finalMessage = buildCompletedStreamMessage({
                message: streamEvent.message,
                content: fullMessageContent,
                toolCalls: accumulatedToolCalls,
                contentBlocks: accumulatedContentBlocks,
                model,
                resolvedModel: streamEvent.resolvedModel || latestResolvedModel,
              });
              const finalizedMessage = transcriptSnapshot.finalize(finalMessage, {
                accumulatedThinking: accumulatedThinkingResume,
                resolvedModel: streamEvent.resolvedModel || latestResolvedModel,
              });
              resumeProducedVisibleOutput = Boolean(
                (finalizedMessage.content || '').trim()
                || finalizedMessage.toolCalls?.length
                || finalizedMessage.contentBlocks?.length
              );
              if (resumeProducedVisibleOutput) {
                recordCompletedStreamMessage(sessionId, finalizedMessage);
              }
              sentStreamEnd = true;
              sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, {
                sessionId,
                message: slimMessageForRenderer(finalizedMessage),
                ...((streamEvent as any).terminalReason ? { terminalReason: (streamEvent as any).terminalReason } : {}),
              });
              notifyQueueStreamEnd(resumeProducedVisibleOutput, resumeProducedVisibleOutput);
              break;
            }

            case 'error':
              batcher.flush();
              sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                sessionId,
                error: streamEvent.error,
              });
              hadError = true;
              break;
          }
        }
      } catch (error) {
        batcher.flush();
        sendToSender(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        hadError = true;
      } finally {
        claudeService.clearSessionRenderer(sessionId, senderContents);
        if (!sentStreamEnd) {
          const finalMessage: ChatMessage = buildCompletedStreamMessage({
            content: fullMessageContent || '',
            toolCalls: accumulatedToolCalls,
            contentBlocks: accumulatedContentBlocks,
            model,
            resolvedModel: latestResolvedModel,
          });
          if (hadError) {
            finalMessage.interrupted = true;
          }
          const finalizedMessage = transcriptSnapshot.finalize(finalMessage, {
            accumulatedThinking: accumulatedThinkingResume,
            resolvedModel: latestResolvedModel,
            interrupted: hadError,
          });
          resumeProducedVisibleOutput = Boolean(
            (finalizedMessage.content || '').trim()
            || finalizedMessage.toolCalls?.length
            || finalizedMessage.contentBlocks?.length
          );
          if (resumeProducedVisibleOutput) {
            recordCompletedStreamMessage(sessionId, finalizedMessage);
          }
          sendToSender(IPC_CHANNELS.CLAUDE_STREAM_END, {
            sessionId,
            message: slimMessageForRenderer(finalizedMessage),
          });
        }

        const completedSession = await sessionService.getSession(sessionId).catch(() => null);
        if (completedSession?.sshConfig) {
          // Never kill active remote work because a reattach failed — reattach
          // errors are usually local/transport problems while the remote turn
          // is still making progress. Only explicit user cancel kills it.
          void sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, completedSession.sshConfig, {
            killActive: false,
          }).catch((error) => {
            console.warn('[Claude IPC] Background resume SSH cleanup failed:', error);
          });
          console.log(`[Claude IPC] Resume SSH cleanup scheduled in background for ${sessionId}`);
        }

        // Notify queue service that streaming has ended (resume).
        const shouldDrainAfterResume = !hadError && resumeProducedVisibleOutput;
        notifyQueueStreamEnd(shouldDrainAfterResume, shouldDrainAfterResume && resumeCompletedWithResult);

        // Safety net: if the resume suppressed drain but the queue still has
        // messages (e.g. a race-rescheduled injection), allow drain to bypass
        // the remote-active gate. The race handler proved the query completed —
        // the lingering remote process is cleanup, not an active turn. Without
        // this, onStreamStart resets drainDeferredSince every resume cycle,
        // preventing the 30s stale-remote escalation from ever triggering.
        if (!shouldDrainAfterResume && messageQueueService.length(sessionId) > 0) {
          console.log(`[Claude IPC] Resume suppressed drain but queue has ${messageQueueService.length(sessionId)} pending message(s) for ${sessionId}; allowing remote-active bypass drain`);
          messageQueueService.allowRemoteActiveDrain(sessionId);
          messageQueueService.deferDrain(sessionId, 500);
        }

        // Parallel state machine tracking (Phase 6 - diagnostic only)
        sessionTurnService.transition(sessionId, 'IDLE', 'reattach completed');
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.CLAUDE_CANCEL, async (_, sessionId: string) => {
    messageQueueService.clear(sessionId);
    await claudeService.cancelQuery(sessionId);
    // Wait for the abort signal to propagate through the SDK generator and
    // the generator to yield its final STREAM_END/error event. 200ms gives
    // the async generator time to unwind, preventing stale events from
    // arriving after the renderer has already started a new stream.
    // (Restored from v0.2.2 commit c5601ec — regressed in v0.3.x.)
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_MESSAGES, async (_, sessionId: string, limit?: number) => {
    // Build's canonical per-session transcript is the primary source for app
    // hydration. Claude SDK transcripts are legacy/backfill only inside
    // getCanonicalMessages(), so non-Claude harness messages survive reloads.
    const canonicalMessages = await claudeService.getCanonicalMessages(sessionId, limit);
    // completedStreamStore is Build-owned local recovery, not a Claude transcript.
    // Keep merging it for older sessions until all historical rows have been
    // migrated into ~/.build/transcripts.
    return slimMessagesForRenderer(mergeCompletedStreamMessages(canonicalMessages, sessionId, limit), limit);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_HAS_BUILD_TRANSCRIPT, async (_, sessionId: string) => {
    return claudeService.hasBuildTranscriptForSession(sessionId);
  });

  // Handle permission responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PERMISSION_RESPONSE, async (_, response: { requestId: string; approved: boolean; modifiedInput?: Record<string, unknown>; alwaysApprove?: boolean }) => {
    console.log('[Claude IPC] Permission response received:', response.requestId, 'approved:', response.approved, 'alwaysApprove:', response.alwaysApprove);
    claudeService.handlePermissionResponse(response);
  });

  // Handle question responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_QUESTION_RESPONSE, async (_, response: QuestionResponse) => {
    console.log('[Claude IPC] Question response:', response);
    claudeService.handleQuestionResponse(response);
  });

  // Auto-resume handlers for Build It mode
  // Save streaming state before app closes (called by renderer)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_SAVE_STATE, async (_, state: {
    sessionId: string;
    wasStreaming: boolean;
    permissionMode: string;
    lastMessage?: string;
    isSSH?: boolean;
  }) => {
    console.log('[Claude IPC] Saving auto-resume state:', state.sessionId, 'wasStreaming:', state.wasStreaming);
    settingsStore.set('autoResumeState', {
      ...state,
      timestamp: Date.now(),
    });
    return { success: true };
  });

  // Get saved auto-resume state (called by renderer on startup)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_GET_STATE, async () => {
    const state = settingsStore.get('autoResumeState') as {
      sessionId: string;
      wasStreaming: boolean;
      permissionMode: string;
      lastMessage?: string;
      isSSH?: boolean;
      timestamp: number;
    } | undefined;

    if (!state) {
      return null;
    }

    if (state.isSSH) {
      console.log('[Claude IPC] Retrieved SSH auto-resume state for remote reattach:', state.sessionId);
      return state;
    }

    // Local renderer-only auto-resume gets stale quickly.
    const staleAfterMs = 5 * 60 * 1000;
    if (state.timestamp < Date.now() - staleAfterMs) {
      console.log('[Claude IPC] Auto-resume state is stale, ignoring');
      settingsStore.delete('autoResumeState');
      return null;
    }

    console.log('[Claude IPC] Retrieved auto-resume state:', state.sessionId);
    return state;
  });

  // Clear auto-resume state (called when session completes normally)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_CLEAR_STATE, async () => {
    console.log('[Claude IPC] Clearing auto-resume state');
    settingsStore.delete('autoResumeState');
    return { success: true };
  });

  // Handle plan approval responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_RESPONSE, async (_, response: PlanApprovalResponse) => {
    console.log('[Claude IPC] Plan approval response:', response);
    claudeService.handlePlanApprovalResponse(response);
  });

  // Inject message into active query (for async queue processing)
  ipcMain.handle(IPC_CHANNELS.CLAUDE_INJECT_MESSAGE, async (_, sessionId: string, message: string, attachments?: Attachment[]) => {
    console.log('[Claude IPC] Inject message request for session:', sessionId);
    return claudeService.injectMessage(sessionId, message, attachments);
  });

  // Check if session has an active query
  ipcMain.handle(IPC_CHANNELS.CLAUDE_HAS_ACTIVE_QUERY, async (_, sessionId: string) => {
    return claudeService.hasActiveQuery(sessionId);
  });

  // Update permission mode for an active session (used by GREP IT! button)
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SET_PERMISSION_MODE, async (_, sessionId: string, mode: string) => {
    console.log(`[Claude IPC] Setting permission mode for ${sessionId}: ${mode}`);
    claudeService.setSessionPermissionMode(sessionId, mode);
  });

  // Ephemeral side question (/btw) — direct API call, no history pollution
  ipcMain.handle(IPC_CHANNELS.CLAUDE_BTW_ASK, async (_, sessionId: string, question: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    claudeService.setMainWindow(mainWindow);
    await claudeService.askBtw(sessionId, question);
  });

  // Remote control — spawn `claude remote-control` as a child process
  ipcMain.handle(IPC_CHANNELS.CLAUDE_RC_START, async (_, sessionId: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    claudeService.setMainWindow(mainWindow);
    await claudeService.startRemoteControl(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_RC_STOP, async (_, sessionId: string) => {
    claudeService.stopRemoteControl(sessionId);
  });

  // Rewind preview — dry-run to see what files would change
  ipcMain.handle(IPC_CHANNELS.CLAUDE_REWIND_PREVIEW, async (_, sessionId: string, messageId: string) => {
    const queryObj = claudeService.getActiveQuery(sessionId);
    if (!queryObj) {
      return { canRewind: false, filesChanged: [], insertions: 0, deletions: 0, error: 'No active query for session' };
    }
    try {
      const result = await (queryObj as any).rewindFiles(messageId, { dryRun: true });
      return result;
    } catch (error: any) {
      console.error('[Claude IPC] rewindPreview error:', error);
      return { canRewind: false, filesChanged: [], insertions: 0, deletions: 0, error: error.message || 'Unknown error' };
    }
  });

  // Rewind execute — actually rewind files and fork session
  ipcMain.handle(IPC_CHANNELS.CLAUDE_REWIND_EXECUTE, async (_, sessionId: string, messageId: string) => {
    const queryObj = claudeService.getActiveQuery(sessionId);
    if (!queryObj) {
      return { canRewind: false, filesChanged: [], insertions: 0, deletions: 0, error: 'No active query for session' };
    }
    try {
      const result = await (queryObj as any).rewindFiles(messageId);

      // Create a fork from the rewind point
      const forkedSession = await sessionService.createForkFromInput(sessionId, messageId);

      return { ...result, forkedSessionId: forkedSession.id };
    } catch (error: any) {
      console.error('[Claude IPC] rewindExecute error:', error);
      return { canRewind: false, filesChanged: [], insertions: 0, deletions: 0, error: error.message || 'Unknown error' };
    }
  });

  // Handle drain-ready events from the message queue service.
  // When the queue decides it's time to send the next turn, drain all pending
  // messages into one ordered prompt and forward it through the normal flow.
  messageQueueService.on('drain-ready', async (sessionId: string) => {
    const session = await sessionService.getSession(sessionId).catch(() => null);
    const readRemoteActive = async () => session?.sshConfig
      ? sshService.hasActiveRemoteProcess(sessionId, session.sshConfig).catch(() => false)
      : false;
    let remoteActive = await readRemoteActive();
    const activeState = claudeService.getActiveQueryState(sessionId);
    const deferredMs = messageQueueService.getDrainDeferredMs(sessionId);
    const supportsActiveInjection = messageQueueService.supportsActiveInjection(sessionId);
    const canDrainPastRemoteActive = messageQueueService.canDrainPastRemoteActive(sessionId);
    if (activeState.active) {
      if (activeState.injectable && supportsActiveInjection) {
        const failures = drainInjectionFailures.get(sessionId) || 0;
        if (failures >= MAX_INJECTION_RETRIES) {
          console.warn(
            `[Queue] Injection failed ${failures} times for ${sessionId}; ` +
            `waiting for STREAM_END to drain naturally`
          );
          // Don't clear the failure counter — keep it at max so re-entry
          // from a spurious scheduleDrain doesn't restart injection attempts.
          // Counter is cleared on the next stream start (SEND_MESSAGE / RESUME_REMOTE_TURN).
          // Don't schedule another drain; onStreamEnd will trigger it when
          // the current turn finishes.
          messageQueueService.finishDrainAttempt(sessionId);
          return;
        } else {
          const next = messageQueueService.peekForDrain(sessionId);
          if (!next) return;

          if ((next.sourceCount || 0) > 1) {
            console.log(`[Queue] Injecting ${next.sourceCount} queued messages into active query for ${sessionId}`);
          } else {
            console.log(`[Queue] Injecting queued message into active query for ${sessionId}`);
          }

          messageQueueService.beginDrainAttempt(sessionId);
          const injectStartMs = Date.now();
          const injectedText = await resolveCrossHarnessWorkflowMessage(sessionId, next.text, session);
          const injected = await claudeService.injectMessage(
            sessionId,
            injectedText,
            next.attachments as Attachment[] | undefined
          );
          const injectElapsedMs = Date.now() - injectStartMs;
          console.log(`[Queue] Injection ${injected ? 'succeeded' : 'FAILED'} for ${sessionId} in ${injectElapsedMs}ms | sourceIds=${JSON.stringify(next.sourceIds)} queueLen=${messageQueueService.length(sessionId)}`);
          if (injected) {
            // streamInput can resolve exactly as the query completes (observed
            // resolving after a 7-minute wait in the same millisecond as
            // "Terminal reason: completed") — the exiting query never processes
            // the message and acking it here silently loses it. Give the
            // stream a moment to settle, then only ack if the query is still
            // alive to actually consume the injected message.
            await new Promise((resolve) => setTimeout(resolve, 400));
            const postInjectState = claudeService.getActiveQueryState(sessionId);
            if (!postInjectState.active) {
              console.warn(
                `[Queue] Injection for ${sessionId} raced query completion (${injectElapsedMs}ms) — ` +
                'keeping message queued to send as a fresh turn instead of losing it'
              );
              messageQueueService.finishDrainAttempt(sessionId);
              messageQueueService.deferDrain(sessionId, 500);
              return;
            }
            drainInjectionFailures.delete(sessionId);
            const hasRemaining = messageQueueService.length(sessionId) > (next.sourceIds?.length || 1);
            messageQueueService.ackDrain(sessionId, next.sourceIds, { keepProcessing: hasRemaining, scheduleIfRemaining: true });
            console.log(`[Queue] Post-ackDrain queueLen=${messageQueueService.length(sessionId)} processing=${messageQueueService.getState(sessionId).isProcessing}`);
            return;
          }

          drainInjectionFailures.set(sessionId, failures + 1);
          console.warn(`[Queue] Injection failed for ${sessionId} (attempt ${failures + 1}/${MAX_INJECTION_RETRIES}); deferring`);
          messageQueueService.finishDrainAttempt(sessionId);
          messageQueueService.deferDrain(sessionId, 1000);
          return;
        }
      }

      if (canDrainPastRemoteActive) {
        console.warn(
          `[Queue] Draining queued turn for ${sessionId} after completed stream while active runtime remains ` +
          `(injectable=${activeState.injectable ? 'yes' : 'no'}, ` +
          `supportsActiveInjection=${supportsActiveInjection ? 'yes' : 'no'}, ` +
          `remoteActive=${remoteActive ? 'yes' : 'no'}, deferredMs=${deferredMs}, idleMs=${activeState.idleMs})`
        );
      } else {
        if (remoteActive) {
          if (!activeState.injectable && supportsActiveInjection && deferredMs >= STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS) {
            console.warn(
              `[Queue] Active query for ${sessionId} lost its injectable Query object while remote process is still active; ` +
              `preserving the remote turn, requesting reattach, and deferring drain ` +
              `(deferredMs=${deferredMs}, idleMs=${activeState.idleMs})`
            );
            // A recovered SSH turn now retains its stdin bridge, so the
            // reattach wrapper is injectable. Never abort that wrapper here:
            // aborting it used to kill the live remote question/turn.
            const mainWindow = getMainWindow();
            mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_REMOTE_TURN_RECOVERABLE, { sessionId });
            messageQueueService.deferDrain(sessionId, 5000);
            return;
          }

          console.warn(
            `[Queue] Deferring drain for ${sessionId}; remote process is still active ` +
            `(localActive=yes, injectable=${activeState.injectable ? 'yes' : 'no'}, ` +
            `supportsActiveInjection=${supportsActiveInjection ? 'yes' : 'no'}, ` +
            `deferredMs=${deferredMs}, idleMs=${activeState.idleMs})`
          );
          messageQueueService.deferDrain(sessionId, 1000);
          return;
        }

        const canTreatAsStale = (!activeState.injectable || !supportsActiveInjection)
          && deferredMs >= STALE_QUEUE_DRAIN_ACTIVE_QUERY_GRACE_MS;
        if (!canTreatAsStale) {
          console.warn(
            `[Queue] Deferring drain for ${sessionId}; runtime is still active ` +
            `(injectable=${activeState.injectable ? 'yes' : 'no'}, ` +
            `supportsActiveInjection=${supportsActiveInjection ? 'yes' : 'no'}, ` +
            `deferredMs=${deferredMs}, idleMs=${activeState.idleMs})`
          );
          messageQueueService.deferDrain(sessionId, 1000);
          return;
        }

        console.warn(
          `[Queue] Clearing stale active query before drain for ${sessionId}; ` +
          `deferredMs=${deferredMs}, ageMs=${activeState.ageMs}, idleMs=${activeState.idleMs}`
        );
        await claudeService.cancelQuery(sessionId);
      }
    }

    if (remoteActive && canDrainPastRemoteActive) {
      console.warn(`[Queue] Draining queued turn for ${sessionId} after completed stream while remote bridge remains active`);
      if (session?.sshConfig) {
        await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig, {
          killActive: false,
        });
        remoteActive = await readRemoteActive();
        console.log(
          `[Queue] Rechecked remote process after completed-stream bridge cleanup for ${sessionId}; ` +
          `remoteActive=${remoteActive ? 'yes' : 'no'}`
        );
      }
    } else if (remoteActive) {
      if (session?.sshConfig && deferredMs === 0) {
        await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig, {
          killActive: false,
        });
        remoteActive = await readRemoteActive();
        console.log(
          `[Queue] Rechecked remote process after completed bridge cleanup for ${sessionId}; ` +
          `remoteActive=${remoteActive ? 'yes' : 'no'}`
        );
      }
    }

    if (remoteActive && !canDrainPastRemoteActive && session?.sshConfig && deferredMs >= STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS) {
      // The remote process outlived the local stream (laptop sleep, app
      // restart, transport drop). If its log is still growing it is a live
      // working turn — reattach and let it finish; never kill it for a drain.
      const jobs = await sshService.listDetachedBridgeJobs(sessionId, session.sshConfig).catch(() => []);
      const activeJob = jobs.find((job) => job.active);
      const previousProgress = drainRemoteJobProgress.get(sessionId);
      const progressed = !!activeJob
        && (!previousProgress || previousProgress.jobDir !== activeJob.jobDir || activeJob.logBytes > previousProgress.logBytes);
      if (activeJob && progressed) {
        drainRemoteJobProgress.set(sessionId, {
          jobDir: activeJob.jobDir,
          logBytes: activeJob.logBytes,
          lastProgressAt: Date.now(),
        });
      }
      const stuckMs = activeJob && previousProgress && previousProgress.jobDir === activeJob.jobDir && !progressed
        ? Date.now() - previousProgress.lastProgressAt
        : 0;

      if (activeJob && stuckMs < STALE_QUEUE_DRAIN_REMOTE_STUCK_MS) {
        console.warn(
          `[Queue] Remote turn still progressing for ${sessionId} ` +
          `(logBytes=${activeJob.logBytes}, stuckMs=${stuckMs}); requesting reattach and deferring drain`
        );
        const mainWindow = getMainWindow();
        mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_REMOTE_TURN_RECOVERABLE, { sessionId });
        messageQueueService.deferDrain(sessionId, 5000);
        return;
      }

      console.warn(
        `[Queue] Clearing stale remote process before drain for ${sessionId}; ` +
        `deferredMs=${deferredMs}, stuckMs=${stuckMs}`
      );
      drainRemoteJobProgress.delete(sessionId);
      await sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig, {
        killActive: true,
      });
      remoteActive = await readRemoteActive();
      console.log(
        `[Queue] Rechecked remote process after stale remote cleanup for ${sessionId}; ` +
        `remoteActive=${remoteActive ? 'yes' : 'no'}`
      );
    }

    if (remoteActive && !canDrainPastRemoteActive) {
      console.warn(`[Queue] Deferring drain for ${sessionId}; remote process is still active`);
      messageQueueService.deferDrain(sessionId, 1000);
      return;
    }

    // Both authoritative runtime probes are idle. Clear any stale processing
    // bit left by a disconnect before transferring queue ownership to renderer.
    messageQueueService.markRuntimeIdle(sessionId, { scheduleDrain: false });

    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    const next = messageQueueService.dequeueForDrain(sessionId);
    if (!next) return;
    messageQueueService.clearRemoteActiveDrainAllowance(sessionId);

    if ((next.sourceCount || 0) > 1) {
      console.log(`[Queue] Draining ${next.sourceCount} queued messages as one turn for ${sessionId}`);
    }

    // Tell the renderer to send this prompt through the normal flow
    mainWindow.webContents.send('queue:send-next', sessionId, next);
  });

  // Transition logging handled by sessionTurnService.logAndEmitTransition —
  // no duplicate listener needed here.

  // Diagnostic: log queue controller drain-ready events (parallel run)
  queueController.on('drain-ready', (sessionId: string) => {
    console.log(`[Queue Controller] drain-ready for ${sessionId.substring(0, 8)} (parallel run — not yet active)`);
  });
}

// Export the claude service instance so it can be updated with mainWindow reference
export { claudeService };
