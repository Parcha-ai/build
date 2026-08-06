import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useVoiceConversationSDK } from '../../hooks/useVoiceConversationSDK';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { getSessionDisplayName } from '../../utils/session-display';
import {
  APP_VOICE_SESSION_ID,
  describeVoiceSessionDirectory,
  getVoiceEligibleTabs,
  getVoiceTabLocation,
  resolveVoiceDestination,
} from '../../utils/voice-session-directory';
import {
  describePendingQuestion,
  resolveVoiceQuestionAnswers,
  type VoiceQuestionResponseInput,
} from '../../utils/voice-question-response';
import { getBrowserPartitionId } from '../../../shared/utils/browser-partition';
import type { Attachment, ChatMessage, Session } from '../../../shared/types';
import type { RemoteVoiceToolCall } from '../../../shared/types/realtime-voice';

const EMPTY_MESSAGES: never[] = [];
const VOICE_SCREENSHOT_TTL_MS = 2 * 60 * 1_000;
const VOICE_ANNOUNCEMENT_COALESCE_MS = 650;
const VOICE_COMPLETION_SETTLE_DELAYS_MS = [250, 750, 1_500] as const;
const VOICE_UPDATE_REPLY_TARGET_TTL_MS = 15 * 60 * 1_000;

interface PendingVoiceVisualContext {
  attachments: Attachment[];
  capturedAt: number;
  sessionId: string;
  purpose: string;
  target: string;
}

interface VoiceSessionActivitySnapshot {
  isStreaming: boolean;
  permissionId: string | null;
  questionId: string | null;
  planApprovalId: string | null;
  status: Session['status'];
  turnBaselineAssistantId: string | null;
  turnBaselineAssistantOutcome: string;
}

interface PendingVoiceAnnouncement {
  text: string;
  tabId: string;
  type: string;
  location?: string;
}

interface VoiceUpdateReplyTarget {
  announcedAt: number;
  tabId: string;
  type: string;
  location?: string;
}

interface MicrophoneButtonProps {
  onTranscriptionComplete?: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
  disabled?: boolean;
}

export interface VoiceModeHandle {
  startPushToTalk: () => Promise<void>;
  stopPushToTalk: () => Promise<void>;
  toggleVoiceMode: () => Promise<void>;
  disconnectVoiceMode: () => Promise<void>;
  isConnected: boolean;
}

function textContent(content: unknown, maxLength: number): string {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  const text = typeof serialized === 'string' ? serialized : '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function getAssistantResponse(message: ChatMessage | undefined): string {
  if (!message) return '';
  const content = message.content?.trim() || (message.contentBlocks || [])
    .filter((block) => block.type === 'text' && block.text?.trim())
    .map((block) => block.text?.trim())
    .join('\n');
  if (content) return textContent(content, 1_200);

  const toolCallCount = message.toolCalls?.length || 0;
  return toolCallCount > 0
    ? `Completed ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}.`
    : '';
}

function getLatestAssistantResponse(messages: ChatMessage[]): { id: string; outcome: string } | null {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'assistant');
  return message ? { id: message.id, outcome: getAssistantResponse(message) } : null;
}

function describeBuildStatus(sessionId: string): string {
  const state = useSessionStore.getState();
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  const isStreaming = Boolean(state.isStreaming[sessionId]);
  const thinking = state.currentThinkingContent[sessionId] || '';
  const streamContent = state.currentStreamContent[sessionId] || '';
  const toolCalls = state.currentToolCalls[sessionId] || [];
  const messages = state.messages[sessionId] || [];
  const latestTool = toolCalls.at(-1);
  const latestMessage = messages.at(-1);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
  const location = getVoiceTabLocation(sessionId, state);
  const attention = state.pendingPermission[sessionId]
    ? 'permission'
    : state.pendingQuestion[sessionId]
      ? 'question'
      : state.pendingPlanApproval[sessionId]
        ? 'plan approval'
        : session?.status === 'error'
          ? 'error'
          : undefined;
  const pendingQuestion = state.pendingQuestion[sessionId];
  const pendingPlan = state.pendingPlanApproval[sessionId];

  return JSON.stringify({
    sidebarSessionId: location?.group.root.id,
    sidebarSessionName: location?.sessionName,
    tabId: sessionId,
    tabName: location?.tabName || (session ? getSessionDisplayName(session) : sessionId),
    location: location?.label,
    host: session?.sshConfig ? `${session.sshConfig.username}@${session.sshConfig.host}` : 'local',
    workspace: session?.sshConfig?.remoteWorkdir || session?.worktreePath || session?.repoPath,
    branch: session?.branch,
    model: state.activeStreamModel[sessionId] || state.selectedModel[sessionId] || session?.model,
    runtimeStatus: session?.status,
    status: isStreaming ? 'working' : 'idle',
    attention,
    pendingQuestion: pendingQuestion ? describePendingQuestion(pendingQuestion) : undefined,
    pendingPlan: pendingPlan ? {
      requestId: pendingPlan.requestId,
      planContent: textContent(pendingPlan.planContent, 16_000),
      originalCharacterCount: pendingPlan.planContent.length,
      truncated: pendingPlan.planContent.length > 16_000,
      allowedPrompts: pendingPlan.allowedPrompts,
    } : undefined,
    currentActivity: latestTool
      ? { name: latestTool.name, input: latestTool.input }
      : undefined,
    recentThinking: thinking.slice(-600),
    responseInProgress: streamContent.slice(-600),
    latestMessage: latestMessage
      ? { role: latestMessage.role, content: textContent(latestMessage.content, 1_000) }
      : undefined,
    latestUserRequest: latestUserMessage ? textContent(latestUserMessage.content, 1_000) : undefined,
    latestOutcome: latestAssistantMessage ? textContent(latestAssistantMessage.content, 1_200) : undefined,
  });
}

/** Build the same session snapshot for desktop and SSH-deployed voice clients. */
function buildVoiceSessionContext(sessionId: string | null): string {
  const liveState = useSessionStore.getState();
  const session = liveState.sessions.find((candidate) => candidate.id === sessionId);
  const messages = sessionId ? liveState.messages[sessionId] || EMPTY_MESSAGES : EMPTY_MESSAGES;
  const contextMessages = messages.length > 16 ? messages.slice(-16) : messages;
  const messageSummary = contextMessages.map((message, index) => {
    const isLatestAssistant = message.role === 'assistant' && index === contextMessages.length - 1;
    return `${message.role}: ${textContent(message.content, isLatestAssistant ? 1_600 : 300)}`;
  }).join('\n');
  const activeLocation = sessionId ? getVoiceTabLocation(sessionId, liveState) : null;
  const projectName = (session?.worktreePath || session?.repoPath || session?.sshConfig?.remoteWorkdir || '')
    .split('/')
    .filter(Boolean)
    .at(-1) || session?.name || 'unknown project';

  return `CURRENTLY VISIBLE BUILD LOCATION (live at snapshot time):
VISIBLE SIDEBAR SESSION: ${activeLocation?.sessionName || 'none'}
VISIBLE CONVERSATION TAB: ${activeLocation?.tabName || 'none'}
VISIBLE CONVERSATION TAB ID: ${sessionId || 'none'}
PROJECT: ${projectName}
HOST: ${session?.sshConfig ? `${session.sshConfig.username}@${session.sshConfig.host}` : 'local'}
WORKING DIRECTORY: ${session?.sshConfig?.remoteWorkdir || session?.worktreePath || session?.repoPath || 'unknown'}
BRANCH: ${session?.branch || 'unknown'}
MODEL: ${sessionId ? liveState.activeStreamModel[sessionId] || liveState.selectedModel[sessionId] || session?.model || 'unknown' : 'unknown'}
BUILD STATUS: ${sessionId && liveState.isStreaming[sessionId] ? 'working' : 'idle'}

VOICE-ACCESSIBLE BUILD SIDEBAR SESSIONS AND THEIR TABS:
${describeVoiceSessionDirectory(liveState, { maxGroups: 6, maxTabsPerGroup: 4 })}

RECENT BUILD CONVERSATION:
${messageSummary || 'No Build messages yet.'}`;
}

function normalizeVoiceBrowserUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) throw new Error('navigate_browser requires a URL.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(value)
    ? `http://${value}`
    : `https://${value}`;
}

function looksLikeAppTabNavigation(instruction: string): boolean {
  return /\b(?:open|switch|go|return|jump|show|take me|bring me)\b[\s\S]{0,140}\b(?:tab|session|conversation|we (?:were|have been) working on|switch back to working on)\b/i.test(instruction)
    || /\bswitch back to working on\b/i.test(instruction);
}

interface VoiceTabRenameResult {
  applied: boolean;
  tabId: string;
  previousName: string;
  tabName: string;
  reason?: 'unchanged' | 'user_title_preserved';
}

async function renameBuildTabForVoice(
  tabId: string,
  requestedName: string,
  userRequested: boolean,
): Promise<VoiceTabRenameResult> {
  const tabName = requestedName.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!tabName) throw new Error('A tab rename requires a non-empty title.');

  const state = useSessionStore.getState();
  const session = state.sessions.find((candidate) => candidate.id === tabId);
  if (!session) throw new Error(`Build tab ${tabId} is no longer available.`);
  const previousName = getSessionDisplayName(session);

  // A proactive voice title is housekeeping, not permission to replace the
  // user's chosen label. An explicit spoken rename is treated like the inline
  // tab rename UI and becomes the new protected manual title.
  if (!userRequested && (session.manualName?.trim() || session.manuallyRenamedAt)) {
    return { applied: false, tabId, previousName, tabName: previousName, reason: 'user_title_preserved' };
  }
  if (previousName.toLocaleLowerCase() === tabName.toLocaleLowerCase()) {
    return { applied: false, tabId, previousName, tabName: previousName, reason: 'unchanged' };
  }

  const updates: Partial<Session> = userRequested
    ? {
        name: tabName,
        manualName: tabName,
        manuallyRenamedAt: new Date().toISOString(),
        aiGeneratedName: tabName,
        ...(session.parentSessionId ? { forkName: tabName } : {}),
      }
    : {
        name: tabName,
        aiGeneratedName: tabName,
        ...(session.parentSessionId ? { forkName: tabName } : {}),
      };

  await state.updateSession(tabId, updates);
  try {
    await window.electronAPI.settings.set({ [`sessionNames.${tabId}`]: tabName });
  } catch (error) {
    console.warn('[VoiceRouting] Tab title settings sync failed:', error);
  }
  console.info('[VoiceRouting] Renamed Build tab', {
    tabId,
    previousName,
    tabName,
    userRequested,
  });
  return { applied: true, tabId, previousName, tabName };
}

async function createFreshVoiceBuildTab(
  sourceSessionId: string,
  instruction: string,
  requestedName: string,
  attachments?: Attachment[],
): Promise<Session> {
  // A fresh voice tab is created directly. Never leave the unrelated manual
  // New Session setup form covering the tab that was just created.
  useUIStore.getState().closeNewSessionDialog();
  const state = useSessionStore.getState();
  const sourceSession = state.sessions.find((candidate) => candidate.id === sourceSessionId);
  if (!sourceSession) throw new Error('The active Build session is no longer available.');

  let rootId = sourceSessionId;
  let walk: Session | undefined = sourceSession;
  while (walk?.parentSessionId) {
    rootId = walk.parentSessionId;
    walk = state.sessions.find((candidate) => candidate.id === rootId);
  }
  const rootSession = state.sessions.find((candidate) => candidate.id === rootId) || sourceSession;
  const workspaceSession = rootSession.sshConfig ? rootSession : sourceSession;
  const tabName = requestedName.trim().slice(0, 80) || `${workspaceSession.name} (parallel)`;

  let newSession: Session;
  if (workspaceSession.sshConfig) {
    const { worktreeScript: _, ...cleanConfig } = workspaceSession.sshConfig;
    newSession = await window.electronAPI.ssh.createSession({
      name: tabName,
      sshConfig: { ...cleanConfig, syncSettings: false },
      parentSessionId: rootId,
    });
  } else {
    const repoPath = workspaceSession.worktreePath || workspaceSession.repoPath;
    if (!repoPath) throw new Error('The active Build session has no reusable workspace path.');
    newSession = await window.electronAPI.dev.createSession({
      name: tabName,
      repoPath,
      branch: workspaceSession.branch || 'main',
      createWorktree: false,
    });
  }

  newSession = await window.electronAPI.sessions.update(newSession.id, {
    parentSessionId: rootId,
    isRoot: false,
    tabHidden: false,
  });
  const rootChildren = [...(rootSession.childSessionIds || [])];
  if (!rootChildren.includes(newSession.id)) rootChildren.push(newSession.id);
  await window.electronAPI.sessions.update(rootId, {
    childSessionIds: rootChildren,
    isRoot: true,
  });

  useSessionStore.setState((current) => ({
    sessions: [
      ...current.sessions
        .filter((candidate) => candidate.id !== newSession.id)
        .map((candidate) => candidate.id === rootId
          ? { ...candidate, childSessionIds: rootChildren, isRoot: true }
          : candidate),
      newSession,
    ],
  }));
  const nextState = useSessionStore.getState();
  const inheritedModel = nextState.selectedModel[sourceSessionId];
  if (inheritedModel) nextState.setSelectedModel(newSession.id, inheritedModel, 'api');
  await nextState.setActiveSession(newSession.id);
  useUIStore.getState().closeNewSessionDialog();
  if (useSessionStore.getState().activeSessionId !== newSession.id) {
    throw new Error('Build created the fresh tab but could not focus it.');
  }
  await useSessionStore.getState().sendMessage(newSession.id, instruction, attachments);
  return newSession;
}

/** Toggle Build's persistent first-person OpenAI Realtime voice conversation. */
export const MicrophoneButton = forwardRef<VoiceModeHandle, MicrophoneButtonProps>(({
  disabled = false,
}, ref) => {
  const audioSettings = useAudioStore((state) => state.settings);
  const storedConnected = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnected));
  const storedConnecting = useAudioStore((state) => Boolean(state.voiceModeStates[APP_VOICE_SESSION_ID]?.isConnecting));
  const setVoiceModeConnecting = useAudioStore((state) => state.setVoiceModeConnecting);
  const setVoiceModeConnected = useAudioStore((state) => state.setVoiceModeConnected);
  const setVoiceModeDisconnected = useAudioStore((state) => state.setVoiceModeDisconnected);
  const setVoiceModeSpeaking = useAudioStore((state) => state.setVoiceModeSpeaking);
  const setVoiceModeUserSpeaking = useAudioStore((state) => state.setVoiceModeUserSpeaking);
  const setVoiceModeAudioLevel = useAudioStore((state) => state.setVoiceModeAudioLevel);
  const setVoiceModeTranscript = useAudioStore((state) => state.setVoiceModeTranscript);
  const setVoiceModeAgentResponse = useAudioStore((state) => state.setVoiceModeAgentResponse);
  const setVoiceModeError = useAudioStore((state) => state.setVoiceModeError);

  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const messages = useSessionStore((state) => activeSessionId ? state.messages[activeSessionId] : undefined) || EMPTY_MESSAGES;
  const sessions = useSessionStore((state) => state.sessions);
  const session = useSessionStore((state) => state.sessions.find((candidate) => candidate.id === activeSessionId));
  const isStreaming = useSessionStore((state) => Boolean(activeSessionId && state.isStreaming[activeSessionId]));
  const pendingVoiceVisualContextRef = useRef<PendingVoiceVisualContext | null>(null);
  const voiceDispatchAdmissionTailsRef = useRef<Map<string, Promise<void>>>(new Map());
  const announcedUpdateReplyTargetsRef = useRef<Map<string, VoiceUpdateReplyTarget>>(new Map());

  const initialContext = useMemo(
    () => buildVoiceSessionContext(activeSessionId),
    [activeSessionId, isStreaming, messages, session, sessions],
  );

  const executeVoiceTool = useCallback(async (
    { toolName, parameters }: RemoteVoiceToolCall,
  ) => {
      const liveState = useSessionStore.getState();
      // Resolve the visible tab for every tool execution. Voice context can
      // outlive many tab switches, so earlier context is never authoritative
      // for a coding write.
      const targetSessionId = liveState.activeSessionId;
      const requestedTargetTabId = typeof parameters.target_tab_id === 'string'
        ? parameters.target_tab_id.trim()
        : '';
      const expectedVisibleTabId = typeof parameters.expected_visible_tab_id === 'string'
        ? parameters.expected_visible_tab_id.trim()
        : '';
      const resolveAddressedTab = () => {
        const tabId = requestedTargetTabId || targetSessionId;
        if (!tabId) throw new Error('No Build tab is available for this request.');
        const location = getVoiceTabLocation(tabId, liveState);
        if (!location) {
          throw new Error(`Build tab ${tabId} is not active, favorited, working, or recent enough for voice access.`);
        }
        return location;
      };
      const prepareVisualAttachments = (deliverySessionId = targetSessionId) => {
        const pendingVisualContext = pendingVoiceVisualContextRef.current;
        const visualContextIsFreshForSession = Boolean(
          pendingVisualContext
          && pendingVisualContext.sessionId === deliverySessionId
          && Date.now() - pendingVisualContext.capturedAt <= VOICE_SCREENSHOT_TTL_MS,
        );
        if (pendingVisualContext && !visualContextIsFreshForSession) {
          pendingVoiceVisualContextRef.current = null;
        }
        const visualAttachments = visualContextIsFreshForSession && pendingVisualContext
          ? pendingVisualContext.attachments
          : undefined;
        return { pendingVisualContext, visualAttachments };
      };
      const clearDeliveredVisual = (pendingVisualContext: PendingVoiceVisualContext | null) => {
        if (pendingVoiceVisualContextRef.current === pendingVisualContext) {
          pendingVoiceVisualContextRef.current = null;
        }
      };
      const focusAnnouncedUpdateReplyTarget = async () => {
        if (!requestedTargetTabId) {
          throw new Error('This reply needs the exact INTERNAL_REPLY_TARGET_TAB_ID from the proactive update.');
        }
        const announcedTarget = announcedUpdateReplyTargetsRef.current.get(requestedTargetTabId);
        if (
          !announcedTarget
          || Date.now() - announcedTarget.announcedAt > VOICE_UPDATE_REPLY_TARGET_TTL_MS
        ) {
          announcedUpdateReplyTargetsRef.current.delete(requestedTargetTabId);
          throw new Error(
            'That tab is not a recently announced update target. Use the visible tab, or explicitly switch tabs before acting.',
          );
        }
        const currentState = useSessionStore.getState();
        const location = getVoiceTabLocation(requestedTargetTabId, currentState);
        if (!location) {
          announcedUpdateReplyTargetsRef.current.delete(requestedTargetTabId);
          throw new Error(`The announced Build tab ${requestedTargetTabId} is no longer voice-accessible.`);
        }
        if (currentState.activeSessionId !== requestedTargetTabId) {
          pendingVoiceVisualContextRef.current = null;
          console.info('[VoiceRouting] Focusing announced update reply target', {
            fromTabId: currentState.activeSessionId,
            toTabId: requestedTargetTabId,
            sourceLocation: location.label,
            updateType: announcedTarget.type,
          });
          await Promise.resolve(currentState.setActiveSession(requestedTargetTabId));
          if (useSessionStore.getState().activeSessionId !== requestedTargetTabId) {
            throw new Error(`Build could not focus ${location.label} before acting on the update reply.`);
          }
        }
        return location;
      };

      if (toolName === 'list_build_sessions') {
        return describeVoiceSessionDirectory(liveState);
      }

      if (toolName === 'get_build_status') {
        const addressed = resolveAddressedTab();
        const visibleTabAtExecution = useSessionStore.getState().activeSessionId;
        console.info('[VoiceRouting] Reading tab status', {
          visibleTabId: visibleTabAtExecution,
          addressedTabId: addressed.tab.id,
          sourceLocation: addressed.label,
        });
        const status = JSON.parse(describeBuildStatus(addressed.tab.id)) as Record<string, unknown>;
        return JSON.stringify({
          reference: requestedTargetTabId ? 'explicit_source_tab' : 'currently_visible_build_location',
          visibleTabAtExecution,
          ...status,
          speakingHint: `Refer to this as sidebar session "${addressed.sessionName}", conversation tab "${addressed.tabName}".`,
        });
      }

      if (toolName === 'respond_to_build_question') {
        const addressed = requestedTargetTabId
          ? await focusAnnouncedUpdateReplyTarget()
          : resolveAddressedTab();
        const request = useSessionStore.getState().pendingQuestion[addressed.tab.id];
        if (!request) throw new Error(`${addressed.label} has no pending agent question.`);
        const responses = Array.isArray(parameters.responses)
          ? parameters.responses as VoiceQuestionResponseInput[]
          : [];
        if (responses.length === 0) {
          return JSON.stringify({ submitted: false, ...describePendingQuestion(request) });
        }
        const answers = resolveVoiceQuestionAnswers(request, responses);
        await useSessionStore.getState().answerQuestion(addressed.tab.id, answers);
        if (useSessionStore.getState().pendingQuestion[addressed.tab.id]?.requestId === request.requestId) {
          throw new Error('Build did not accept the spoken question response. The question is still pending.');
        }
        return JSON.stringify({
          submitted: true,
          requestId: request.requestId,
          location: addressed.label,
          answers,
        });
      }

      if (toolName === 'review_build_plan') {
        const addressed = requestedTargetTabId
          ? await focusAnnouncedUpdateReplyTarget()
          : resolveAddressedTab();
        const request = useSessionStore.getState().pendingPlanApproval[addressed.tab.id];
        if (!request) throw new Error(`${addressed.label} has no plan awaiting approval.`);
        const action = typeof parameters.action === 'string' ? parameters.action : '';
        if (action === 'read') {
          return JSON.stringify({
            action,
            requestId: request.requestId,
            location: addressed.label,
            planContent: textContent(request.planContent, 16_000),
            originalCharacterCount: request.planContent.length,
            truncated: request.planContent.length > 16_000,
            allowedPrompts: request.allowedPrompts,
          });
        }
        if (action === 'approve') {
          await useSessionStore.getState().approvePlan(addressed.tab.id);
        } else if (action === 'reject') {
          const feedback = typeof parameters.feedback === 'string' ? parameters.feedback.trim() : '';
          if (!feedback) throw new Error('Rejecting a plan by voice requires the user\'s requested changes as feedback.');
          await useSessionStore.getState().rejectPlan(addressed.tab.id, feedback);
        } else {
          throw new Error('review_build_plan action must be read, approve, or reject.');
        }
        if (useSessionStore.getState().pendingPlanApproval[addressed.tab.id]?.requestId === request.requestId) {
          throw new Error(`Build did not ${action} the plan. It is still awaiting approval.`);
        }
        return JSON.stringify({
          completed: true,
          action,
          requestId: request.requestId,
          location: addressed.label,
        });
      }

      if (toolName === 'rename_build_tab') {
        const addressed = resolveAddressedTab();
        const tabName = typeof parameters.tab_name === 'string'
          ? parameters.tab_name.trim()
          : '';
        if (!tabName) throw new Error('rename_build_tab requires a new tab name.');
        const renamed = await renameBuildTabForVoice(
          addressed.tab.id,
          tabName,
          parameters.user_requested === true,
        );
        return JSON.stringify({
          ...renamed,
          location: addressed.label,
        });
      }

      if (toolName === 'switch_build_session' || toolName === 'switch_build_tab') {
        const sessionName = typeof parameters.session_name === 'string'
          ? parameters.session_name.trim()
          : '';
        const tabName = typeof parameters.tab_name === 'string'
          ? parameters.tab_name.trim()
          : '';
        const targetTabId = typeof parameters.target_tab_id === 'string'
          ? parameters.target_tab_id.trim()
          : '';
        if (toolName === 'switch_build_session' && !sessionName) {
          throw new Error('switch_build_session requires a sidebar session name.');
        }
        if (toolName === 'switch_build_tab' && !tabName && !targetTabId) {
          throw new Error('switch_build_tab requires a tab name or target tab ID.');
        }
        const resolved = resolveVoiceDestination(liveState, sessionName, targetTabId || tabName);
        if (!resolved.match) {
          const choices = resolved.candidates.length > 0
            ? ` Possible matches: ${resolved.candidates.join(', ')}. Retry using target_tab_id with the desired candidate ID prefix.`
            : '';
          const requestedTab = targetTabId || tabName;
          const destination = requestedTab
            ? `tab "${requestedTab}"${sessionName ? ` in sidebar session "${sessionName}"` : ''}`
            : `sidebar session "${sessionName}"`;
          throw new Error(`I could not uniquely resolve the Build ${destination}.${choices}`);
        }
        if (targetSessionId !== resolved.match.tab.id) {
          pendingVoiceVisualContextRef.current = null;
        }
        console.info('[VoiceRouting] Switching visible tab', {
          fromTabId: targetSessionId,
          toTabId: resolved.match.tab.id,
          sidebarSessionId: resolved.match.group.root.id,
          sidebarSessionName: resolved.match.sessionName,
          tabName: resolved.match.tabName,
          targetTabId: targetTabId || undefined,
          requestedBy: toolName,
        });
        await Promise.resolve(liveState.setActiveSession(resolved.match.tab.id));
        if (useSessionStore.getState().activeSessionId !== resolved.match.tab.id) {
          throw new Error(`Build did not switch to ${resolved.match.label}; the UI kept the previous tab active.`);
        }
        return JSON.stringify({
          switched: true,
          sidebarSessionId: resolved.match.group.root.id,
          sidebarSessionName: resolved.match.sessionName,
          tabId: resolved.match.tab.id,
          tabName: resolved.match.tabName,
          location: resolved.match.label,
          buildStatus: JSON.parse(describeBuildStatus(resolved.match.tab.id)),
        });
      }

      if (toolName === 'control_build_ui') {
        const action = typeof parameters.action === 'string' ? parameters.action : '';
        const ui = useUIStore.getState();
        const activeSession = targetSessionId
          ? liveState.sessions.find((candidate) => candidate.id === targetSessionId)
          : undefined;
        const requireActiveSession = () => {
          if (!targetSessionId || !activeSession) {
            throw new Error(`The ${action || 'requested'} action requires an active Build session.`);
          }
          return { sessionId: targetSessionId, session: activeSession };
        };
        const setPanel = (panel: 'browser' | 'terminal' | 'git', open: boolean) => {
          const current = useUIStore.getState();
          if (panel === 'browser' && current.isBrowserPanelOpen !== open) current.toggleBrowserPanel();
          if (panel === 'terminal' && current.isTerminalPanelOpen !== open) current.toggleTerminalPanel();
          if (panel === 'git' && current.isGitPanelOpen !== open) current.toggleGitPanel();
        };

        switch (action) {
          case 'open_browser': {
            const { sessionId: ownerSessionId, session: owner } = requireActiveSession();
            const partitionId = getBrowserPartitionId(ownerSessionId, liveState.sessions);
            const current = useUIStore.getState();
            const existing = current.browserTabs.find((tab) => tab.partitionId === partitionId);
            if (existing) current.setActiveBrowserTab(existing.id);
            else current.createBrowserTab(
              ownerSessionId,
              partitionId,
              owner.lastBrowserUrl || `http://localhost:${owner.ports?.web || 3000}`,
            );
            current.enableSessionBrowser(ownerSessionId);
            setPanel('browser', true);
            return JSON.stringify({ completed: true, action, sessionId: ownerSessionId });
          }
          case 'close_browser':
            setPanel('browser', false);
            return JSON.stringify({ completed: true, action });
          case 'refresh_browser': {
            const { sessionId: ownerSessionId } = requireActiveSession();
            const partitionId = getBrowserPartitionId(ownerSessionId, liveState.sessions);
            const current = useUIStore.getState();
            const browserTabId = current.activeBrowserTabIdsByPartition[partitionId];
            const activeTab = current.browserTabs.find((tab) => tab.id === browserTabId);
            if (!activeTab) throw new Error('There is no browser tab to refresh for the active session.');
            setPanel('browser', true);
            window.dispatchEvent(new CustomEvent('grep-browser-refresh', {
              detail: { sessionId: activeTab.ownerSessionId, browserTabId: activeTab.id },
            }));
            return JSON.stringify({ completed: true, action, url: activeTab.url });
          }
          case 'navigate_browser': {
            const { sessionId: ownerSessionId, session: owner } = requireActiveSession();
            const url = normalizeVoiceBrowserUrl(typeof parameters.url === 'string' ? parameters.url : '');
            const partitionId = getBrowserPartitionId(ownerSessionId, liveState.sessions);
            const current = useUIStore.getState();
            const browserTabId = current.activeBrowserTabIdsByPartition[partitionId];
            const activeTab = current.browserTabs.find((tab) => tab.id === browserTabId);
            if (activeTab) {
              current.updateBrowserTabUrl(activeTab.id, url);
              current.setActiveBrowserTab(activeTab.id);
            } else {
              current.createBrowserTab(owner.id, partitionId, url);
            }
            current.enableSessionBrowser(ownerSessionId);
            setPanel('browser', true);
            await window.electronAPI.browser.navigateTo(ownerSessionId, url);
            return JSON.stringify({ completed: true, action, url });
          }
          case 'open_terminal':
            requireActiveSession();
            setPanel('terminal', true);
            return JSON.stringify({ completed: true, action });
          case 'close_terminal':
            setPanel('terminal', false);
            return JSON.stringify({ completed: true, action });
          case 'open_git':
            requireActiveSession();
            setPanel('git', true);
            return JSON.stringify({ completed: true, action });
          case 'close_git':
            setPanel('git', false);
            return JSON.stringify({ completed: true, action });
          case 'open_settings':
            ui.openSettings();
            return JSON.stringify({ completed: true, action });
          case 'open_command_center':
            if (!ui.isCommandCenterActive) ui.toggleCommandCenter();
            return JSON.stringify({ completed: true, action });
          case 'open_agent_view':
            if (!ui.isAgentViewActive) ui.toggleAgentView();
            return JSON.stringify({ completed: true, action });
          default:
            throw new Error(`Unsupported Build UI action: ${action || 'missing action'}.`);
        }
      }

      if (toolName === 'inspect_build_screen') {
        const purpose = typeof parameters.purpose === 'string'
          ? parameters.purpose.trim()
          : '';
        if (!purpose) throw new Error('inspect_build_screen requires a visual inspection purpose.');
        const sidePanel = document.querySelector<HTMLElement>('[data-voice-capture-region="side-panel"]');
        const terminalPanel = document.querySelector<HTMLElement>('[data-voice-capture-region="terminal-panel"]');
        const focusedRegion = sidePanel || terminalPanel;
        const bounds = focusedRegion?.getBoundingClientRect();
        const capture = await window.electronAPI.app.captureScreen(bounds ? {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          target: sidePanel ? 'open right-side panel' : 'open terminal panel',
        } : undefined);
        if (!capture.dataUrl.startsWith('data:image/')) {
          throw new Error('Build captured an invalid screen image.');
        }
        const ui = useUIStore.getState();
        const activeSession = targetSessionId
          ? liveState.sessions.find((candidate) => candidate.id === targetSessionId)
          : undefined;
        const partitionId = targetSessionId
          ? getBrowserPartitionId(targetSessionId, liveState.sessions)
          : null;
        const activeBrowserTabId = partitionId
          ? ui.activeBrowserTabIdsByPartition[partitionId]
          : null;
        const activeBrowserTab = ui.browserTabs.find((tab) => tab.id === activeBrowserTabId);
        const inspectorOwnerSessionId = activeBrowserTab?.ownerSessionId || targetSessionId;
        const inspectedElement = inspectorOwnerSessionId
          ? ui.sessionSelectedElement[inspectorOwnerSessionId] as {
              selector?: string;
              outerHTML?: string;
              tagName?: string;
              reactComponent?: string;
              screenshot?: string;
              textContent?: string;
              pageUrl?: string;
              selectedAt?: number;
            } | null | undefined
          : null;
        const capturedAt = Date.now();
        const browserUrl = activeBrowserTab?.url || activeSession?.lastBrowserUrl;
        const inspectedElementIsRelevant = Boolean(
          inspectedElement?.outerHTML
          && (!inspectedElement.pageUrl || !browserUrl || inspectedElement.pageUrl === browserUrl)
          && (!inspectedElement.selectedAt || capturedAt - inspectedElement.selectedAt <= VOICE_SCREENSHOT_TTL_MS),
        );
        const attachments: Attachment[] = [{
          type: 'image',
          name: 'voice-inspected-screen.jpg',
          content: capture.dataUrl,
          metadata: {
            source: 'voice-inspected-screen',
            capturedAt,
            purpose,
            target: capture.target,
            browserUrl,
          },
        }];
        if (inspectedElementIsRelevant && inspectedElement?.outerHTML) {
          const selector = inspectedElement.selector || inspectedElement.reactComponent || inspectedElement.tagName || 'selected element';
          attachments.push({
            type: 'dom_element',
            name: selector,
            content: [
              activeBrowserTab?.url ? `[Page: ${activeBrowserTab.url}]` : '',
              inspectedElement.textContent ? `[Visible text: ${inspectedElement.textContent.slice(0, 1_000)}]` : '',
              inspectedElement.outerHTML,
            ].filter(Boolean).join('\n\n'),
            screenshot: inspectedElement.screenshot || capture.dataUrl,
            metadata: {
              source: 'voice-browser-inspector',
              capturedAt,
              purpose,
              selector,
              browserUrl,
            },
          });
        }
        pendingVoiceVisualContextRef.current = targetSessionId ? {
          attachments,
          capturedAt,
          sessionId: targetSessionId,
          purpose,
          target: capture.target,
        } : null;
        return {
          output: JSON.stringify({
            captured: true,
            purpose,
            width: capture.width,
            height: capture.height,
            target: capture.target,
            browserUrl,
            inspectorContextIncluded: inspectedElementIsRelevant,
            inspectorSelector: inspectedElementIsRelevant ? inspectedElement?.selector : undefined,
            pendingCodingAttachments: attachments.length,
            note: 'The focused screenshot and any relevant retained browser inspector context will be attached to the next coding message.',
          }),
          inputImageDataUrl: capture.dataUrl,
        };
      }

      if (!targetSessionId) {
        throw new Error('No Build chat is active. Open a session before asking me to change or inspect it.');
      }

      if (toolName === 'fork_build_session') {
        const instruction = typeof parameters.instruction === 'string'
          ? parameters.instruction.trim()
          : '';
        const tabName = typeof parameters.tab_name === 'string'
          ? parameters.tab_name.trim()
          : '';
        if (!instruction) throw new Error('fork_build_session requires an instruction.');
        if (!tabName) throw new Error('fork_build_session requires a descriptive tab name.');
        const { pendingVisualContext, visualAttachments } = prepareVisualAttachments();
        const sourceWasStreaming = Boolean(liveState.isStreaming[targetSessionId]);
        const forkedSession = await liveState.createForkFromCurrent(instruction, visualAttachments);
        if (!forkedSession) throw new Error('Build could not create the conversation fork.');
        const tabRename = await renameBuildTabForVoice(forkedSession.id, tabName, false);
        clearDeliveredVisual(pendingVisualContext);
        return JSON.stringify({
          submitted: true,
          sourceSessionId: targetSessionId,
          sessionId: forkedSession.id,
          parallelTab: 'conversation_fork',
          parentContinuesRunning: sourceWasStreaming,
          tabName: tabRename.tabName,
          tabRename,
          visualContextAttached: Boolean(visualAttachments),
          attachmentCount: visualAttachments?.length || 0,
          instruction,
          voiceConversation: 'still_connected',
        });
      }

      if (toolName === 'start_new_build_tab') {
        const instruction = typeof parameters.instruction === 'string'
          ? parameters.instruction.trim()
          : '';
        const tabName = typeof parameters.tab_name === 'string'
          ? parameters.tab_name.trim()
          : '';
        if (!instruction) throw new Error('start_new_build_tab requires an instruction.');
        if (!tabName) throw new Error('start_new_build_tab requires a descriptive tab name.');
        const { pendingVisualContext, visualAttachments } = prepareVisualAttachments();
        const newSession = await createFreshVoiceBuildTab(
          targetSessionId,
          instruction,
          tabName,
          visualAttachments,
        );
        clearDeliveredVisual(pendingVisualContext);
        return JSON.stringify({
          submitted: true,
          sourceSessionId: targetSessionId,
          sessionId: newSession.id,
          sessionName: newSession.name,
          parallelTab: 'fresh_context',
          visualContextAttached: Boolean(visualAttachments),
          attachmentCount: visualAttachments?.length || 0,
          instruction,
          voiceConversation: 'still_connected',
        });
      }

      if (toolName === 'DesignMode') {
        const brief = typeof parameters.brief === 'string'
          ? parameters.brief.trim()
          : '';
        if (!brief) throw new Error('DesignMode requires a complete design brief.');
        const followsAnnouncedUpdate = parameters.follow_up_to_update === true;
        if (expectedVisibleTabId && followsAnnouncedUpdate) {
          throw new Error('expected_visible_tab_id cannot be combined with an announced-update target.');
        }
        if (expectedVisibleTabId && expectedVisibleTabId !== targetSessionId) {
          const expectedLocation = getVoiceTabLocation(expectedVisibleTabId, liveState);
          const currentLocation = targetSessionId ? getVoiceTabLocation(targetSessionId, liveState) : null;
          throw new Error(
            `The visible Build tab changed after "this session" was resolved: expected ${expectedLocation?.label || expectedVisibleTabId}, `
            + `but ${currentLocation?.label || targetSessionId || 'no tab'} is visible now. Re-read get_build_status before starting DesignMode.`,
          );
        }
        if (followsAnnouncedUpdate && !requestedTargetTabId) {
          throw new Error('A proactive-update design follow-up requires its exact INTERNAL_REPLY_TARGET_TAB_ID.');
        }
        if (!followsAnnouncedUpdate && requestedTargetTabId) {
          throw new Error('target_tab_id is only allowed when follow_up_to_update is true. Use the visible tab or switch explicitly.');
        }
        const addressed = followsAnnouncedUpdate
          ? await focusAnnouncedUpdateReplyTarget()
          : resolveAddressedTab();
        console.info('[VoiceRouting] Starting DesignMode directly', {
          visibleTabId: targetSessionId,
          addressedTabId: addressed.tab.id,
          sourceLocation: addressed.label,
          usedAnnouncedUpdateTarget: followsAnnouncedUpdate,
        });
        const design = await window.electronAPI.design.startRun(addressed.tab.id, brief);
        if (followsAnnouncedUpdate) announcedUpdateReplyTargetsRef.current.delete(addressed.tab.id);
        return JSON.stringify({
          started: true,
          action: 'design_mode',
          sidebarSessionId: addressed.group.root.id,
          sidebarSessionName: addressed.sessionName,
          tabId: addressed.tab.id,
          tabName: addressed.tabName,
          location: addressed.label,
          projectId: design.projectId,
          conversationId: design.conversationId,
          workspaceDir: design.workspaceDir,
          panelOpened: true,
          voiceConversation: 'still_connected',
        });
      }

      if (toolName === 'steer_build') {
        const instruction = typeof parameters.instruction === 'string'
          ? parameters.instruction.trim()
          : '';
        const tabName = typeof parameters.tab_name === 'string'
          ? parameters.tab_name.trim()
          : '';
        if (!instruction) throw new Error('steer_build requires an instruction.');
        if (!tabName) throw new Error('steer_build requires a descriptive tab name.');
        const followsAnnouncedUpdate = parameters.follow_up_to_update === true;
        if (expectedVisibleTabId && followsAnnouncedUpdate) {
          throw new Error('expected_visible_tab_id cannot be combined with an announced-update target.');
        }
        if (expectedVisibleTabId && expectedVisibleTabId !== targetSessionId) {
          const expectedLocation = getVoiceTabLocation(expectedVisibleTabId, liveState);
          const currentLocation = targetSessionId ? getVoiceTabLocation(targetSessionId, liveState) : null;
          throw new Error(
            `The visible Build tab changed after "this session" was resolved: expected ${expectedLocation?.label || expectedVisibleTabId}, `
            + `but ${currentLocation?.label || targetSessionId || 'no tab'} is visible now. Re-read get_build_status without a target before sending.`,
          );
        }
        if (followsAnnouncedUpdate && !requestedTargetTabId) {
          throw new Error('A proactive-update follow-up requires its exact INTERNAL_REPLY_TARGET_TAB_ID.');
        }
        if (!followsAnnouncedUpdate && requestedTargetTabId) {
          throw new Error('target_tab_id is only allowed when follow_up_to_update is true. Use the visible tab or switch explicitly.');
        }
        if (!requestedTargetTabId && looksLikeAppTabNavigation(instruction)) {
          throw new Error(
            'This is an app tab-navigation request, not a coding instruction. Call switch_build_tab or switch_build_session first; do not ask the visible coding tab to switch branches.',
          );
        }
        const addressed = followsAnnouncedUpdate
          ? await focusAnnouncedUpdateReplyTarget()
          : resolveAddressedTab();
        const addressedTabId = addressed.tab.id;

        const previousAdmission = voiceDispatchAdmissionTailsRef.current.get(addressedTabId)
          || Promise.resolve();
        const admission = previousAdmission.catch(() => undefined).then(async () => {
          // Re-read state after the previous utterance has been admitted. This
          // closes the idle->streaming race where two Realtime tool calls could
          // otherwise both observe an idle tab and start competing turns.
          const admissionState = useSessionStore.getState();
          const { pendingVisualContext, visualAttachments } = prepareVisualAttachments(addressedTabId);
          const tabRename = await renameBuildTabForVoice(addressedTabId, tabName, false);
          const wasBusy = Boolean(
            admissionState.isStreaming[addressedTabId]
            || admissionState.isProcessingQueue[addressedTabId]
            || (admissionState.messageQueue[addressedTabId] || []).length > 0
          );
          const voiceMessageId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          console.info('[VoiceRouting] Admitting coding instruction', {
            visibleTabId: targetSessionId,
            addressedTabId,
            sourceLocation: addressed.label,
            usedAnnouncedUpdateTarget: followsAnnouncedUpdate,
            expectedVisibleTabId: expectedVisibleTabId || undefined,
            visualContextAttached: Boolean(visualAttachments),
            wasBusy,
            voiceMessageId,
          });
          await admissionState.sendMessage(addressedTabId, instruction, visualAttachments, {
            existingMessageId: voiceMessageId,
            forceQueue: true,
            returnAfterAdmission: true,
          });
          clearDeliveredVisual(pendingVisualContext);
          const admittedState = useSessionStore.getState();
          const queue = admittedState.messageQueue[addressedTabId] || [];
          const queueIndex = queue.findIndex((queued) => queued.id === voiceMessageId);
          return JSON.stringify({
            submitted: true,
            sidebarSessionId: addressed.group.root.id,
            sidebarSessionName: addressed.sessionName,
            tabId: addressedTabId,
            tabName: addressed.tabName,
            currentTabName: tabRename.tabName,
            tabRename,
            location: addressed.label,
            delivery: queueIndex >= 0 || wasBusy ? 'queued_behind_active_turn' : 'started_new_build_turn',
            queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
            requestId: voiceMessageId,
            instruction,
            visualContextAttached: Boolean(visualAttachments),
            attachmentCount: visualAttachments?.length || 0,
            voiceConversation: 'still_connected',
          });
        });
        const admissionTail = admission.then(() => undefined, () => undefined);
        voiceDispatchAdmissionTailsRef.current.set(addressedTabId, admissionTail);
        try {
          const result = await admission;
          if (followsAnnouncedUpdate) announcedUpdateReplyTargetsRef.current.delete(addressedTabId);
          return result;
        } finally {
          if (voiceDispatchAdmissionTailsRef.current.get(addressedTabId) === admissionTail) {
            voiceDispatchAdmissionTailsRef.current.delete(addressedTabId);
          }
        }
      }

      throw new Error(`Unknown Build voice tool: ${toolName}`);
  }, []);

  const {
    isConnected,
    isConnecting,
    isSpeaking,
    isUserSpeaking,
    audioLevel,
    currentTranscript,
    error,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    updateContext,
    speak,
  } = useVoiceConversationSDK({
    sessionId: APP_VOICE_SESSION_ID,
    memorySessionId: activeSessionId || undefined,
    systemPrompt: initialContext,
    voice: audioSettings?.realtimeVoice || 'marin',
    reasoningEffort: audioSettings?.realtimeReasoningEffort || 'low',
    language: audioSettings?.transcriptionLanguage || 'en',
    onTranscript: (text, isFinal) => {
      setVoiceModeTranscript(APP_VOICE_SESSION_ID, text);
      if (!isFinal) return;
      const state = useSessionStore.getState();
      const memorySessionId = state.activeSessionId || undefined;
      const memorySession = state.sessions.find((candidate) => candidate.id === memorySessionId);
      void window.electronAPI.voice.appendMemory({
        role: 'user',
        content: text,
        sessionId: memorySessionId,
        sessionName: memorySession ? getSessionDisplayName(memorySession) : undefined,
        source: 'desktop',
      });
    },
    onAgentResponse: (text, isFinal) => {
      setVoiceModeAgentResponse(APP_VOICE_SESSION_ID, text);
      if (!isFinal) return;
      const state = useSessionStore.getState();
      const memorySessionId = state.activeSessionId || undefined;
      const memorySession = state.sessions.find((candidate) => candidate.id === memorySessionId);
      void window.electronAPI.voice.appendMemory({
        role: 'assistant',
        content: text,
        sessionId: memorySessionId,
        sessionName: memorySession ? getSessionDisplayName(memorySession) : undefined,
        source: 'desktop',
      });
    },
    onError: (message) => setVoiceModeError(APP_VOICE_SESSION_ID, message),
    onToolCall: executeVoiceTool,
  });

  const disconnectVoice = useCallback(async () => {
    pendingVoiceVisualContextRef.current = null;
    await disconnect();
    setVoiceModeDisconnected(APP_VOICE_SESSION_ID);
    setVoiceModeUserSpeaking(APP_VOICE_SESSION_ID, false);
  }, [disconnect, setVoiceModeDisconnected, setVoiceModeUserSpeaking]);

  const connectVoice = useCallback(async () => {
    if (isConnected || isConnecting) return;
    setVoiceModeConnecting(APP_VOICE_SESSION_ID);
    try {
      await connect();
      await startRecording();
    } catch (connectError) {
      setVoiceModeError(
        APP_VOICE_SESSION_ID,
        connectError instanceof Error ? connectError.message : 'Failed to connect voice mode.',
      );
    }
  }, [connect, isConnected, isConnecting, setVoiceModeConnecting, setVoiceModeError, startRecording]);

  useImperativeHandle(ref, () => ({
    startPushToTalk: async () => {
      if (!isConnected) await connectVoice();
      else await startRecording();
    },
    stopPushToTalk: stopRecording,
    toggleVoiceMode: async () => {
      if (isConnected) await disconnectVoice();
      else await connectVoice();
    },
    disconnectVoiceMode: disconnectVoice,
    isConnected,
  }), [connectVoice, disconnectVoice, isConnected, startRecording, stopRecording]);

  useEffect(() => {
    if (isConnecting && !storedConnecting) setVoiceModeConnecting(APP_VOICE_SESSION_ID);
  }, [isConnecting, setVoiceModeConnecting, storedConnecting]);

  useEffect(() => {
    if (isConnected && !storedConnected) {
      setVoiceModeConnected(APP_VOICE_SESSION_ID);
    } else if (!isConnected && storedConnected) {
      setVoiceModeDisconnected(APP_VOICE_SESSION_ID);
    }
  }, [isConnected, setVoiceModeConnected, setVoiceModeDisconnected, storedConnected]);

  useEffect(() => {
    setVoiceModeSpeaking(APP_VOICE_SESSION_ID, isSpeaking);
  }, [isSpeaking, setVoiceModeSpeaking]);

  useEffect(() => {
    setVoiceModeUserSpeaking(APP_VOICE_SESSION_ID, isUserSpeaking);
  }, [isUserSpeaking, setVoiceModeUserSpeaking]);

  useEffect(() => {
    setVoiceModeAudioLevel(APP_VOICE_SESSION_ID, audioLevel);
  }, [audioLevel, setVoiceModeAudioLevel]);

  useEffect(() => {
    if (currentTranscript) setVoiceModeTranscript(APP_VOICE_SESSION_ID, currentTranscript);
  }, [currentTranscript, setVoiceModeTranscript]);

  useEffect(() => {
    if (error) setVoiceModeError(APP_VOICE_SESSION_ID, error);
  }, [error, setVoiceModeError]);

  // The WebRTC conversation and its visible response history have one stable
  // app-level owner. Changing tabs updates context only; it never migrates the
  // connection or response state into the newly visible coding chat.
  const previousContextSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    const previousSessionId = previousContextSessionIdRef.current;
    if (previousSessionId === activeSessionId) return;

    if (isConnected) {
      console.info('[VoiceRouting] Active tab context changed', {
        fromTabId: previousSessionId,
        toTabId: activeSessionId,
        voiceStateId: APP_VOICE_SESSION_ID,
      });
      void updateContext(`[VISIBLE BUILD LOCATION CHANGED]
The user is now viewing conversation tab ${activeSessionId || 'none'}. The exact visible sidebar session and conversation-tab names are in the snapshot below. "This session", "the current session", "here", and "this tab" refer to this visible Build location, never to the app-wide voice conversation and never to a previously announced background tab. Previous visible-tab context is historical only. ${APP_VOICE_SESSION_ID} is only an internal voice-state ID; never present it as a user session.

${initialContext}`);
    }
    previousContextSessionIdRef.current = activeSessionId;
  }, [
    activeSessionId,
    initialContext,
    isConnected,
    updateContext,
  ]);

  // Keep the voice agent informed without subscribing this React component to
  // token-frequency thinking/response state. One store observer coalesces all
  // high-frequency Build deltas into a context update at most every 1.5s.
  useEffect(() => {
    if (!isConnected || !activeSessionId) return;
    const observedSessionId = activeSessionId;
    let contextTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = '';

    const scheduleContext = () => {
      if (contextTimer) return;
      contextTimer = setTimeout(() => {
        contextTimer = null;
        const state = useSessionStore.getState();
        const thinking = state.currentThinkingContent[observedSessionId] || '';
        const response = state.currentStreamContent[observedSessionId] || '';
        const tools = state.currentToolCalls[observedSessionId] || [];
        const signature = `${thinking.length}:${response.length}:${tools.length}`;
        if (signature === lastSignature) return;
        lastSignature = signature;
        void updateContext(JSON.stringify({
          type: 'build_progress',
          tabId: observedSessionId,
          status: state.isStreaming[observedSessionId] ? 'working' : 'idle',
          recentThinking: thinking.slice(-500),
          responseInProgress: response.slice(-500),
          recentTools: tools.slice(-2).map((tool) => ({ name: tool.name, input: tool.input })),
        }));
      }, 1_500);
    };

    const unsubscribe = useSessionStore.subscribe((next, previous) => {
      if (
        next.currentThinkingContent[observedSessionId] !== previous.currentThinkingContent[observedSessionId]
        || next.currentStreamContent[observedSessionId] !== previous.currentStreamContent[observedSessionId]
        || next.currentToolCalls[observedSessionId] !== previous.currentToolCalls[observedSessionId]
      ) scheduleContext();
    });

    return () => {
      unsubscribe();
      if (contextTimer) clearTimeout(contextTimer);
    };
  }, [activeSessionId, isConnected, updateContext]);

  const realtimeSpeakingRef = useRef(isSpeaking);
  const realtimeUserSpeakingRef = useRef(isUserSpeaking);
  realtimeSpeakingRef.current = isSpeaking;
  realtimeUserSpeakingRef.current = isUserSpeaking;

  // Voice watches tabs inside every favorited, currently working, active, or
  // 24-hour-recent sidebar session. It reacts only to lifecycle edges—not
  // streaming tokens—then coalesces simultaneous attention events.
  useEffect(() => {
    if (!isConnected) return;

    const initialState = useSessionStore.getState();
    const activity = new Map<string, VoiceSessionActivitySnapshot>();
    for (const candidate of getVoiceEligibleTabs(initialState)) {
      const latestAssistant = getLatestAssistantResponse(initialState.messages[candidate.id] || []);
      activity.set(candidate.id, {
        isStreaming: Boolean(initialState.isStreaming[candidate.id]),
        permissionId: initialState.pendingPermission[candidate.id]?.requestId || null,
        questionId: initialState.pendingQuestion[candidate.id]?.requestId || null,
        planApprovalId: initialState.pendingPlanApproval[candidate.id]?.requestId || null,
        status: candidate.status,
        turnBaselineAssistantId: latestAssistant?.id || null,
        turnBaselineAssistantOutcome: latestAssistant?.outcome || '',
      });
    }

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const pendingAnnouncements: PendingVoiceAnnouncement[] = [];
    const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let deliveryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleAnnouncementDelivery = (delay = 0) => {
      if (cancelled || deliveryTimer || pendingAnnouncements.length === 0) return;
      deliveryTimer = setTimeout(() => {
        deliveryTimer = null;
        if (cancelled || pendingAnnouncements.length === 0) return;
        if (realtimeSpeakingRef.current || realtimeUserSpeakingRef.current) {
          scheduleAnnouncementDelivery(700);
          return;
        }
        const announcements = pendingAnnouncements.splice(0, 4);
        const announcedAt = Date.now();
        for (const announcement of announcements) {
          announcedUpdateReplyTargetsRef.current.set(announcement.tabId, {
            announcedAt,
            tabId: announcement.tabId,
            type: announcement.type,
            location: announcement.location,
          });
        }
        for (const [tabId, target] of announcedUpdateReplyTargetsRef.current) {
          if (announcedAt - target.announcedAt > VOICE_UPDATE_REPLY_TARGET_TTL_MS) {
            announcedUpdateReplyTargetsRef.current.delete(tabId);
          }
        }
        void speak(
          'Give the user these concise proactive briefings in the first person. '
          + 'Name each Build session so the source is clear. Do not mention monitoring machinery and never read internal IDs aloud. '
          + 'Each item carries an INTERNAL_REPLY_TARGET_TAB_ID: if the user directly responds to that update, retain its exact ID for the guarded reply tool route. '
          + JSON.stringify(announcements.map((announcement) => ({
            INTERNAL_REPLY_TARGET_TAB_ID: announcement.tabId,
            updateType: announcement.type,
            location: announcement.location,
            briefing: announcement.text,
          }))),
        )
          .finally(() => {
            if (pendingAnnouncements.length > 0) scheduleAnnouncementDelivery(1_200);
          });
      }, delay);
    };

    const flushUpdates = () => {
      coalesceTimer = null;
      if (pendingUpdates.length === 0) return;
      const updates = pendingUpdates.splice(0);
      void updateContext(JSON.stringify({
        type: 'build_session_updates',
        generatedAt: new Date().toISOString(),
        updates,
      }));
      scheduleAnnouncementDelivery();
    };

    const queueUpdate = (update: Record<string, unknown>, announcement?: string) => {
      console.info('[VoiceRouting] Session lifecycle update', {
        type: update.type,
        sourceTabId: update.tabId,
        sourceSidebarSessionId: update.sidebarSessionId,
        sourceLocation: update.location,
        visibleTabId: useSessionStore.getState().activeSessionId,
        voiceStateId: APP_VOICE_SESSION_ID,
      });
      pendingUpdates.push(update);
      if (announcement && typeof update.tabId === 'string') {
        pendingAnnouncements.push({
          text: announcement,
          tabId: update.tabId,
          type: typeof update.type === 'string' ? update.type : 'session_update',
          location: typeof update.location === 'string' ? update.location : undefined,
        });
      }
      if (!coalesceTimer) coalesceTimer = setTimeout(flushUpdates, VOICE_ANNOUNCEMENT_COALESCE_MS);
    };

    const scheduleCompletedTurnUpdate = (
      tabId: string,
      baselineAssistantId: string | null,
      baselineAssistantOutcome: string,
      capturedStreamOutcome: string,
      attempt = 0,
    ) => {
      const delay = VOICE_COMPLETION_SETTLE_DELAYS_MS[attempt];
      const timer = setTimeout(() => {
        completionTimers.delete(tabId);
        if (cancelled) return;

        const liveState = useSessionStore.getState();
        // A queued follow-up may already have begun. Its completion edge will
        // produce a newer, authoritative notification, so do not misattribute
        // that turn's stream buffer to this one.
        if (liveState.isStreaming[tabId]) return;

        const latestAssistant = getLatestAssistantResponse(liveState.messages[tabId] || []);
        const hasNewAssistantResponse = Boolean(latestAssistant && (
          latestAssistant.id !== baselineAssistantId
          || latestAssistant.outcome !== baselineAssistantOutcome
        ));
        const liveStreamOutcome = textContent(liveState.currentStreamContent[tabId] || '', 1_200).trim();
        const outcome = hasNewAssistantResponse && latestAssistant?.outcome
          ? latestAssistant.outcome
          : liveStreamOutcome || capturedStreamOutcome;

        if (!outcome && attempt + 1 < VOICE_COMPLETION_SETTLE_DELAYS_MS.length) {
          scheduleCompletedTurnUpdate(
            tabId,
            baselineAssistantId,
            baselineAssistantOutcome,
            capturedStreamOutcome,
            attempt + 1,
          );
          return;
        }

        const location = getVoiceTabLocation(tabId, liveState);
        if (!location) return;
        const routing = {
          sidebarSessionId: location.group.root.id,
          sidebarSessionName: location.sessionName,
          tabId,
          tabName: location.tabName,
          location: location.label,
        };
        queueUpdate(
          { type: 'completed', ...routing, outcome: outcome || undefined },
          outcome ? `${location.label} finished. Outcome: ${outcome}` : `${location.label} finished.`,
        );
      }, delay);
      completionTimers.set(tabId, timer);
    };

    const unsubscribe = useSessionStore.subscribe((next, previousState) => {
      // Streaming text/thinking updates are extremely frequent. Ignore them in
      // this all-session observer unless lifecycle/attention topology changed.
      if (
        next.sessions === previousState.sessions
        && next.isStreaming === previousState.isStreaming
        && next.pendingPermission === previousState.pendingPermission
        && next.pendingQuestion === previousState.pendingQuestion
        && next.pendingPlanApproval === previousState.pendingPlanApproval
      ) return;

      const eligible = getVoiceEligibleTabs(next);
      const eligibleIds = new Set(eligible.map((candidate) => candidate.id));

      for (const candidate of eligible) {
        const previous = activity.get(candidate.id);
        const latestAssistant = getLatestAssistantResponse(next.messages[candidate.id] || []);
        const continuingTurn = Boolean(previous?.isStreaming);
        const current: VoiceSessionActivitySnapshot = {
          isStreaming: Boolean(next.isStreaming[candidate.id]),
          permissionId: next.pendingPermission[candidate.id]?.requestId || null,
          questionId: next.pendingQuestion[candidate.id]?.requestId || null,
          planApprovalId: next.pendingPlanApproval[candidate.id]?.requestId || null,
          status: candidate.status,
          turnBaselineAssistantId: continuingTurn
            ? previous?.turnBaselineAssistantId || null
            : latestAssistant?.id || null,
          turnBaselineAssistantOutcome: continuingTurn
            ? previous?.turnBaselineAssistantOutcome || ''
            : latestAssistant?.outcome || '',
        };
        activity.set(candidate.id, current);
        if (!previous) continue;

        const location = getVoiceTabLocation(candidate.id, next);
        if (!location) continue;
        const routing = {
          sidebarSessionId: location.group.root.id,
          sidebarSessionName: location.sessionName,
          tabId: candidate.id,
          tabName: location.tabName,
          location: location.label,
        };
        if (!previous.isStreaming && current.isStreaming) {
          const pendingCompletion = completionTimers.get(candidate.id);
          if (pendingCompletion) {
            clearTimeout(pendingCompletion);
            completionTimers.delete(candidate.id);
          }
          queueUpdate({ type: 'started_working', ...routing });
        }
        if (previous.isStreaming && !current.isStreaming) {
          const capturedStreamOutcome = textContent(
            next.currentStreamContent[candidate.id]
              || previousState.currentStreamContent[candidate.id]
              || '',
            1_200,
          ).trim();
          scheduleCompletedTurnUpdate(
            candidate.id,
            previous.turnBaselineAssistantId,
            previous.turnBaselineAssistantOutcome,
            capturedStreamOutcome,
          );
        }
        if (current.permissionId && current.permissionId !== previous.permissionId) {
          const toolName = next.pendingPermission[candidate.id]?.toolName || 'an action';
          queueUpdate(
            { type: 'permission_required', ...routing, toolName },
            `${location.label} needs the user's permission for ${toolName}. Ask them to approve or deny it in the app.`,
          );
        } else if (!current.permissionId && previous.permissionId) {
          queueUpdate({ type: 'permission_resolved', ...routing });
        }
        if (current.questionId && current.questionId !== previous.questionId) {
          const pendingQuestion = next.pendingQuestion[candidate.id];
          const question = pendingQuestion?.questions?.[0]?.question || 'The agent has a question for you.';
          const questionDetails = pendingQuestion ? describePendingQuestion(pendingQuestion) : undefined;
          queueUpdate(
            { type: 'question_required', ...routing, question, questionDetails },
            `${location.label} needs your answer: ${question} Use respond_to_build_question to read the choices and submit the user's selection.`,
          );
        } else if (!current.questionId && previous.questionId) {
          queueUpdate({ type: 'question_resolved', ...routing });
        }
        if (current.planApprovalId && current.planApprovalId !== previous.planApprovalId) {
          const planExcerpt = textContent(next.pendingPlanApproval[candidate.id]?.planContent || '', 500);
          queueUpdate(
            { type: 'plan_approval_required', ...routing, planExcerpt },
            `${location.label} has finished planning and needs your approval before it can continue. Use review_build_plan to read and summarize it; approve only after the user explicitly says to.`,
          );
        } else if (!current.planApprovalId && previous.planApprovalId) {
          queueUpdate({ type: 'plan_approval_resolved', ...routing });
        }
        if (current.status === 'error' && previous.status !== 'error') {
          queueUpdate(
            { type: 'session_error', ...routing, error: candidate.errorMessage },
            `${location.label} hit an error: ${candidate.errorMessage || 'no error detail was reported'}.`,
          );
        }
      }

      for (const trackedId of activity.keys()) {
        if (!eligibleIds.has(trackedId) && !next.isStreaming[trackedId]) activity.delete(trackedId);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (coalesceTimer) clearTimeout(coalesceTimer);
      if (deliveryTimer) clearTimeout(deliveryTimer);
      for (const timer of completionTimers.values()) clearTimeout(timer);
      completionTimers.clear();
      announcedUpdateReplyTargetsRef.current.clear();
    };
  }, [isConnected, speak, updateContext]);

  const previousMessageCountsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!activeSessionId) return;
    const previousCount = previousMessageCountsRef.current[activeSessionId] ?? messages.length;
    if (isConnected && messages.length > previousCount) {
      const latest = messages.at(-1);
      void updateContext(`${latest?.role || 'unknown'} message in active tab ${activeSessionId}: ${textContent(latest?.content, 1_000)}`);
    }
    previousMessageCountsRef.current[activeSessionId] = messages.length;
  }, [activeSessionId, isConnected, messages, updateContext]);

  // Realtime output voice is fixed for the lifetime of an OpenAI WebRTC
  // session once audio has started. Apply a changed setting immediately by
  // reconnecting the transport; the current Build session context is supplied
  // again by connect(), so the user does not need to toggle voice mode off/on.
  const selectedRealtimeVoice = audioSettings?.realtimeVoice || 'marin';
  const previousRealtimeVoiceRef = useRef(selectedRealtimeVoice);
  const voiceConnectedRef = useRef(isConnected);
  voiceConnectedRef.current = isConnected;
  useEffect(() => {
    if (previousRealtimeVoiceRef.current === selectedRealtimeVoice) return;
    previousRealtimeVoiceRef.current = selectedRealtimeVoice;
    if (!voiceConnectedRef.current) return;

    let cancelled = false;
    const reconnectWithSelectedVoice = async () => {
      await disconnect();
      if (cancelled) return;
      setVoiceModeConnecting(APP_VOICE_SESSION_ID);
      try {
        await connect();
        if (!cancelled) await startRecording();
      } catch (reconnectError) {
        if (!cancelled) {
          setVoiceModeError(
            APP_VOICE_SESSION_ID,
            reconnectError instanceof Error ? reconnectError.message : 'Failed to change realtime voice.',
          );
        }
      }
    };
    void reconnectWithSelectedVoice();
    return () => { cancelled = true; };
  }, [
    connect,
    disconnect,
    selectedRealtimeVoice,
    setVoiceModeConnecting,
    setVoiceModeError,
    startRecording,
  ]);

  const handleClick = useCallback(async () => {
    if (isConnected) await disconnectVoice();
    else await connectVoice();
  }, [connectVoice, disconnectVoice, isConnected]);

  const voiceEnabled = audioSettings?.voiceModeEnabled !== false;

  useEffect(() => {
    const handleAppVoiceToggle = () => {
      if (disabled || isConnecting || !voiceEnabled) return;
      void handleClick();
    };
    window.addEventListener('grep-voice-toggle', handleAppVoiceToggle);
    return () => window.removeEventListener('grep-voice-toggle', handleAppVoiceToggle);
  }, [disabled, handleClick, isConnecting, voiceEnabled]);

  // The controller stays mounted once at app level so split panes cannot open
  // duplicate realtime transports. VoiceComposerControl renders its state and
  // dispatches the same toggle event from the active composer.
  return null;
});

MicrophoneButton.displayName = 'MicrophoneButton';
