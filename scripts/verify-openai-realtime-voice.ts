import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  buildRealtimeClientSecretRequest,
  REALTIME_VOICE_TOOLS,
} from '../src/main/services/openai-realtime-voice.service';
import type { QuestionRequest, Session } from '../src/shared/types';
import {
  APP_VOICE_SESSION_ID,
  describeVoiceSessionDirectory,
  getVoiceSessionGroups,
  getVoiceTabLocation,
  resolveVoiceDestination,
  type VoiceDirectoryState,
} from '../src/renderer/utils/voice-session-directory';
import {
  describePendingQuestion,
  resolveVoiceQuestionAnswers,
} from '../src/renderer/utils/voice-question-response';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const request = buildRealtimeClientSecretRequest({
  sessionId: 'verify-session',
  instructions: 'Project: verification fixture',
  voice: 'cedar',
  reasoningEffort: 'medium',
  language: 'en',
});

assert.strictEqual(request.session.type, 'realtime');
assert.strictEqual(request.session.model, 'gpt-realtime-2.1');
assert.deepStrictEqual(request.session.output_modalities, ['audio']);
assert.strictEqual(request.session.reasoning.effort, 'medium');
assert.strictEqual(request.session.audio.output.voice, 'cedar');
assert.strictEqual(request.session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
assert.deepStrictEqual(request.session.audio.input.turn_detection, {
  type: 'semantic_vad',
  eagerness: 'auto',
  create_response: true,
  interrupt_response: true,
});
assert.ok(request.session.instructions.includes('You are the same Build agent the user sees in the active chat.'));
assert.ok(request.session.instructions.includes('Speak in the first person about your work'));
assert.ok(request.session.instructions.includes('do not describe it as delegation or a handoff'));
assert.ok(request.session.instructions.includes('retained browser inspector DOM context'));
assert.ok(request.session.instructions.includes('session updated in the last 24 hours'));
assert.ok(request.session.instructions.includes('Proactively brief the user'));
assert.ok(request.session.instructions.includes('agent question, plan approval request'));
assert.ok(request.session.instructions.includes('a "sidebar session" is the project/workspace group'));
assert.ok(request.session.instructions.includes('"This session", "the current session", "here", or "this tab"'));
assert.ok(request.session.instructions.includes('call get_build_status with no target_tab_id'));
assert.ok(request.session.instructions.includes('copy its tabId into steer_build.expected_visible_tab_id'));
assert.ok(request.session.instructions.includes('The only exception is a direct user reply to a proactive update'));
assert.ok(request.session.instructions.includes('focuses that tab before sending any coding work'));
assert.ok(request.session.instructions.includes('An unrelated next request still belongs to the visibly open tab'));
assert.ok(request.session.instructions.includes('open the last Orb tab we were working on'));
assert.ok(request.session.instructions.includes('Navigation is an app action, never a coding instruction'));
assert.ok(request.session.instructions.includes('never ask the coding runtime to switch branches'));
assert.ok(request.session.instructions.includes('Every successful call is independently persisted in Build\'s queue'));
assert.ok(request.session.instructions.includes('Never collapse, merely acknowledge, defer in your own memory, or discard a later request'));
assert.ok(request.session.instructions.includes('provide a specific two-to-five-word tab_name'));
assert.ok(request.session.instructions.includes('Use rename_build_tab when the user asks to rename a tab'));
assert.ok(request.session.instructions.includes('must never overwrite a user-named title'));
assert.ok(request.session.instructions.includes('Use fork_build_session when a substantial task can run independently in parallel'));
assert.ok(request.session.instructions.includes('Use start_new_build_tab only when the user explicitly asks for a new/parallel tab'));
assert.ok(request.session.instructions.includes('never also open the New Session dialog'));
assert.ok(request.session.instructions.includes('It cannot open the New Session dialog or create a tab'));
assert.ok(request.session.instructions.includes('create and focus a new conversation tab directly'));
assert.ok(request.session.instructions.includes('work likely to conflict in the same files'));
assert.ok(request.session.instructions.includes('use respond_to_build_question with no responses'));
assert.ok(request.session.instructions.includes('use review_build_plan with action "read"'));
assert.ok(request.session.instructions.includes('Never approve merely because they asked what is in the plan'));
assert.ok(request.session.instructions.includes('DesignMode is an app action, not coding work'));
assert.ok(request.session.instructions.includes('call the DesignMode function with the complete brief'));
assert.ok(request.session.instructions.includes('Design, DesignSync, open-design, and generic design tools are different capabilities'));
assert.ok(request.session.instructions.includes('Never send a DesignMode request through steer_build'));
assert.ok(!request.session.instructions.includes('You and the Build coding harness are separate agents.'));
assert.ok(request.session.instructions.includes('Project: verification fixture'));

const remembered = buildRealtimeClientSecretRequest({
  sessionId: 'verify-memory',
  instructions: 'Current Build context',
}, 'DURABLE VOICE MEMORY FROM PRIOR VOICE CONNECTIONS:\nuser: Remember my preference.');
assert.ok(remembered.session.instructions.includes('DURABLE VOICE MEMORY'));
assert.ok(remembered.session.instructions.includes('Remember my preference.'));

const toolNames = REALTIME_VOICE_TOOLS.map((tool) => tool.name);
assert.deepStrictEqual(toolNames, [
  'steer_build',
  'DesignMode',
  'get_build_status',
  'respond_to_build_question',
  'review_build_plan',
  'list_build_sessions',
  'switch_build_session',
  'switch_build_tab',
  'rename_build_tab',
  'fork_build_session',
  'start_new_build_tab',
  'inspect_build_screen',
  'control_build_ui',
]);
assert.ok(REALTIME_VOICE_TOOLS[0].description.includes('speak about the work in the first person'));
assert.ok(REALTIME_VOICE_TOOLS[1].description.includes('exact DesignMode capability'));
assert.ok(REALTIME_VOICE_TOOLS[2].description.includes('report it in the first person'));
assert.ok('target_tab_id' in REALTIME_VOICE_TOOLS[0].parameters.properties);
assert.ok('follow_up_to_update' in REALTIME_VOICE_TOOLS[0].parameters.properties);
assert.ok('expected_visible_tab_id' in REALTIME_VOICE_TOOLS[0].parameters.properties);
assert.ok('target_tab_id' in REALTIME_VOICE_TOOLS[1].parameters.properties);
assert.ok('expected_visible_tab_id' in REALTIME_VOICE_TOOLS[1].parameters.properties);
assert.ok('target_tab_id' in REALTIME_VOICE_TOOLS[2].parameters.properties);
const steerTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'steer_build');
const designTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'DesignMode');
const questionTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'respond_to_build_question');
const planTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'review_build_plan');
const renameTabTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'rename_build_tab');
const forkTool = REALTIME_VOICE_TOOLS.find((tool) => tool.name === 'fork_build_session');
assert.ok(steerTool?.parameters.required.includes('tab_name'));
assert.ok(steerTool?.parameters.required.includes('follow_up_to_update'));
assert.ok(designTool?.parameters.required.includes('brief'));
assert.ok(designTool?.parameters.required.includes('follow_up_to_update'));
assert.ok(questionTool && 'target_tab_id' in questionTool.parameters.properties);
assert.ok(planTool && 'target_tab_id' in planTool.parameters.properties);
assert.ok(renameTabTool);
assert.ok(renameTabTool?.parameters.required.includes('tab_name'));
assert.ok(renameTabTool?.parameters.required.includes('user_requested'));
assert.ok(forkTool?.parameters.required.includes('tab_name'));

const questionRequest: QuestionRequest = {
  sessionId: 'verify-session',
  requestId: 'question-1',
  questions: [{
    header: 'First slice',
    question: 'Which first slice should I implement?',
    multiSelect: false,
    options: [
      { label: 'A: Canonical skill template (Recommended)', description: 'Bake a fixed template.' },
      { label: 'B: FE-enforced stylesheet', description: 'Inject a stylesheet.' },
      { label: 'C: Reference CSS only', description: 'Document the design.' },
    ],
  }],
};
assert.strictEqual(describePendingQuestion(questionRequest).questions[0].options[0].recommended, true);
assert.deepStrictEqual(
  resolveVoiceQuestionAnswers(questionRequest, [{ selections: ['the recommended one'] }]),
  { 'Which first slice should I implement?': 'A: Canonical skill template (Recommended)' },
);
assert.deepStrictEqual(
  resolveVoiceQuestionAnswers(questionRequest, [{ question_number: 1, selections: ['option B'] }]),
  { 'Which first slice should I implement?': 'B: FE-enforced stylesheet' },
);
assert.deepStrictEqual(
  resolveVoiceQuestionAnswers(questionRequest, [{ selections: ['the third option'] }]),
  { 'Which first slice should I implement?': 'C: Reference CSS only' },
);

const normalized = buildRealtimeClientSecretRequest({
  sessionId: 'verify-fallbacks',
  instructions: `context\0${'x'.repeat(30_000)}`,
  voice: 'not-a-voice' as never,
  reasoningEffort: 'not-an-effort' as never,
});
assert.strictEqual(normalized.session.audio.output.voice, 'marin');
assert.strictEqual(normalized.session.reasoning.effort, 'low');
assert.ok(!normalized.session.instructions.includes('\0'));
assert.ok(normalized.session.instructions.length < 27_000);

const mPersona = buildRealtimeClientSecretRequest({
  sessionId: 'verify-m-persona',
  instructions: 'Active Build context',
  voice: 'M',
  reasoningEffort: 'low',
});
assert.strictEqual(mPersona.session.audio.output.voice, 'marin');
assert.ok(mPersona.session.instructions.includes('[MONEYPENNY VOICE PERSONA]'));
assert.ok(mPersona.session.instructions.includes("Keep Marin's clear, warm, natural timbre"));
assert.ok(mPersona.session.instructions.includes('modern Received Pronunciation'));
assert.ok(mPersona.session.instructions.includes('never with an American accent'));
assert.ok(mPersona.session.instructions.includes('Avoid caricature'));
assert.ok(mPersona.session.instructions.includes('Queen and country'));

const hookSource = read('src/renderer/hooks/useVoiceConversationSDK.ts');
assert.ok(hookSource.includes('new RTCPeerConnection()'));
assert.ok(hookSource.includes("createDataChannel('oai-events')"));
assert.ok(hookSource.includes('https://api.openai.com/v1/realtime/calls'));
assert.ok(hookSource.includes("type: 'function_call_output'"));
assert.ok(hookSource.includes("type: 'input_image'"));
assert.ok(hookSource.includes('result.inputImageDataUrl'));
assert.ok(hookSource.includes('memorySessionId: memorySessionIdRef.current'));
assert.ok(hookSource.includes('flushAgentResponse(true)'));
assert.ok(hookSource.includes("type: 'response.create'"));
assert.ok(!hookSource.includes('previousSessionIdRef'));
assert.ok(!hookSource.includes('voiceActiveSessionsRef'));

const buttonSource = read('src/renderer/components/chat/MicrophoneButton.tsx');
const messageListSource = read('src/renderer/components/chat/MessageList.tsx');
const voiceServiceSource = read('src/main/services/openai-realtime-voice.service.ts');
assert.ok(buttonSource.includes("toolName === 'steer_build'"));
assert.ok(buttonSource.includes("toolName === 'DesignMode'"));
assert.ok(buttonSource.includes('window.electronAPI.design.startRun(addressed.tab.id, brief)'));
assert.ok(buttonSource.includes("action: 'design_mode'"));
assert.ok(buttonSource.includes('panelOpened: true'));
assert.ok(buttonSource.includes("toolName === 'respond_to_build_question'"));
assert.ok(buttonSource.includes("toolName === 'review_build_plan'"));
assert.ok(buttonSource.includes('answerQuestion(addressed.tab.id, answers)'));
assert.ok(buttonSource.includes('approvePlan(addressed.tab.id)'));
assert.ok(buttonSource.includes('rejectPlan(addressed.tab.id, feedback)'));
assert.ok(buttonSource.includes("toolName === 'switch_build_session'"));
assert.ok(buttonSource.includes("toolName === 'switch_build_tab'"));
assert.ok(buttonSource.includes("toolName === 'rename_build_tab'"));
assert.ok(buttonSource.includes('renameBuildTabForVoice'));
assert.ok(buttonSource.includes("reason: 'user_title_preserved'"));
assert.ok(buttonSource.includes('session.manualName?.trim() || session.manuallyRenamedAt'));
assert.ok(buttonSource.includes("[`sessionNames.${tabId}`]: tabName"));
assert.ok(buttonSource.includes('parameters.user_requested === true'));
assert.ok(buttonSource.includes('const tabRename = await renameBuildTabForVoice(addressedTabId, tabName, false)'));
assert.ok(buttonSource.includes("toolName === 'list_build_sessions'"));
assert.ok(buttonSource.includes('requestedTargetTabId'));
assert.ok(buttonSource.includes('const targetSessionId = liveState.activeSessionId'));
assert.ok(buttonSource.includes('focusAnnouncedUpdateReplyTarget'));
assert.ok(buttonSource.includes("console.info('[VoiceRouting] Focusing announced update reply target'"));
assert.ok(buttonSource.includes('announcedUpdateReplyTargetsRef.current.get(requestedTargetTabId)'));
assert.ok(buttonSource.includes('target_tab_id is only allowed when follow_up_to_update is true'));
assert.ok(buttonSource.includes('usedAnnouncedUpdateTarget: followsAnnouncedUpdate'));
assert.ok(buttonSource.includes('INTERNAL_REPLY_TARGET_TAB_ID: announcement.tabId'));
assert.ok(buttonSource.includes('CURRENTLY VISIBLE BUILD LOCATION (live at snapshot time)'));
assert.ok(buttonSource.includes("reference: requestedTargetTabId ? 'explicit_source_tab' : 'currently_visible_build_location'"));
assert.ok(buttonSource.includes('expectedVisibleTabId !== targetSessionId'));
assert.ok(buttonSource.includes('The visible Build tab changed after "this session" was resolved'));
assert.ok(buttonSource.includes('is only an internal voice-state ID; never present it as a user session'));
assert.ok(buttonSource.includes('looksLikeAppTabNavigation'));
assert.ok(buttonSource.includes('This is an app tab-navigation request, not a coding instruction.'));
assert.ok(buttonSource.includes('resolveAddressedTab'));
assert.ok(buttonSource.includes('addressedTabId'));
assert.ok(buttonSource.includes("console.info('[VoiceRouting] Admitting coding instruction'"));
assert.ok(buttonSource.includes('liveState.setActiveSession'));
assert.ok(buttonSource.includes('getSessionDisplayName'));
assert.ok(buttonSource.includes("toolName === 'control_build_ui'"));
assert.ok(buttonSource.includes("toolName === 'inspect_build_screen'"));
assert.ok(messageListSource.includes('QueuedAttachmentChips'));
assert.ok(messageListSource.includes('data-testid="queued-attachment-chips"'));
assert.ok(messageListSource.includes('attachmentImageSource(attachment)'));
assert.ok(voiceServiceSource.includes('inspect_build_screen only captures visual context; it does not send or queue coding work'));
const designPreloadSource = read('src/main/preload.ts');
const designIpcSource = read('src/main/ipc/design.ipc.ts');
const designServiceSource = read('src/main/services/design.service.ts');
assert.ok(designPreloadSource.includes('IPC_CHANNELS.DESIGN_START_RUN'));
assert.ok(designIpcSource.includes('designService.activateDesignMode'));
assert.ok(designIpcSource.includes('event.sender.send(IPC_CHANNELS.DESIGN_OPEN_PANEL'));
assert.ok(designServiceSource.includes('async activateDesignMode('));
assert.ok(buttonSource.includes("toolName === 'fork_build_session'"));
assert.ok(buttonSource.includes("toolName === 'start_new_build_tab'"));
assert.ok(buttonSource.includes('createForkFromCurrent(instruction, visualAttachments)'));
assert.ok(buttonSource.includes('createFreshVoiceBuildTab'));
const freshTabHelperSource = buttonSource.slice(
  buttonSource.indexOf('async function createFreshVoiceBuildTab'),
  buttonSource.indexOf('/** Toggle Build\'s persistent first-person OpenAI Realtime voice conversation. */'),
);
assert.ok(freshTabHelperSource.includes('closeNewSessionDialog()'));
assert.ok(freshTabHelperSource.includes('await nextState.setActiveSession(newSession.id)'));
assert.ok(freshTabHelperSource.includes('activeSessionId !== newSession.id'));
assert.ok(!freshTabHelperSource.includes('openNewSessionDialog()'));
assert.ok(!buttonSource.includes("case 'open_new_session'"));
assert.ok(!voiceServiceSource.includes("'open_new_session_dialog'"));
assert.ok(buttonSource.includes("parallelTab: 'conversation_fork'"));
assert.ok(buttonSource.includes("parallelTab: 'fresh_context'"));
assert.ok(buttonSource.includes("'[data-voice-capture-region=\"side-panel\"]'"));
assert.ok(buttonSource.includes('window.electronAPI.app.captureScreen'));
assert.ok(buttonSource.includes("case 'refresh_browser'"));
assert.ok(buttonSource.includes("case 'navigate_browser'"));
assert.ok(buttonSource.includes("new CustomEvent('grep-browser-refresh'"));
assert.ok(buttonSource.includes('pendingVoiceVisualContextRef'));
assert.ok(buttonSource.includes('VOICE_SCREENSHOT_TTL_MS'));
assert.ok(buttonSource.includes('describeVoiceSessionDirectory'));
assert.ok(buttonSource.includes('APP_VOICE_SESSION_ID'));
assert.ok(buttonSource.includes("sessionId: APP_VOICE_SESSION_ID"));
assert.ok(buttonSource.includes('window.electronAPI.voice.appendMemory'));
assert.ok(buttonSource.includes("source: 'desktop'"));
assert.ok(!buttonSource.includes('setVoiceModeDisconnected(previousSessionId)'));
assert.ok(buttonSource.includes("console.info('[VoiceRouting] Session lifecycle update'"));
assert.ok(buttonSource.includes("name: 'voice-inspected-screen.jpg'"));
assert.ok(buttonSource.includes("source: 'voice-inspected-screen'"));
assert.ok(buttonSource.includes("source: 'voice-browser-inspector'"));
assert.ok(buttonSource.includes('ui.sessionSelectedElement[inspectorOwnerSessionId]'));
assert.ok(buttonSource.includes('inspectedElementIsRelevant'));
assert.ok(buttonSource.includes("type: 'dom_element'"));
assert.ok(buttonSource.includes('pendingVisualContext.sessionId === deliverySessionId'));
assert.ok(buttonSource.includes('voiceDispatchAdmissionTailsRef'));
assert.ok(buttonSource.includes('returnAfterAdmission: true'));
assert.ok(buttonSource.includes('forceQueue: true'));
assert.ok(buttonSource.includes("delivery: queueIndex >= 0 || wasBusy ? 'queued_behind_active_turn' : 'started_new_build_turn'"));
assert.ok(buttonSource.includes('visualContextAttached: Boolean(visualAttachments)'));
assert.ok(buttonSource.includes("voiceConversation: 'still_connected'"));
assert.ok(buttonSource.includes("type: 'build_session_updates'"));
assert.ok(buttonSource.includes("type: 'permission_required'"));
assert.ok(buttonSource.includes("type: 'question_required'"));
assert.ok(buttonSource.includes("type: 'plan_approval_required'"));
assert.ok(buttonSource.includes("type: 'session_error'"));
assert.ok(buttonSource.includes('VOICE_ANNOUNCEMENT_COALESCE_MS'));
assert.ok(buttonSource.includes('VOICE_COMPLETION_SETTLE_DELAYS_MS'));
assert.ok(buttonSource.includes('scheduleCompletedTurnUpdate'));
assert.ok(buttonSource.includes('getLatestAssistantResponse(liveState.messages[tabId] || [])'));
assert.ok(buttonSource.includes('previous.turnBaselineAssistantId'));
assert.ok(!buttonSource.includes('The turn ended without a final assistant response.'));
assert.ok(buttonSource.includes('Name each Build session so the source is clear'));
assert.ok(buttonSource.includes('useSessionStore.subscribe'));
assert.ok(buttonSource.includes('1_500'));
assert.ok(buttonSource.includes('[VISIBLE BUILD LOCATION CHANGED]'));
assert.ok(buttonSource.includes('reconnectWithSelectedVoice'));
assert.ok(buttonSource.includes("audioSettings?.realtimeVoice || 'marin'"));
assert.ok(buttonSource.includes("window.addEventListener('grep-voice-toggle'"));
assert.ok(buttonSource.includes('return null'));
assert.ok(!buttonSource.includes('build-voice-fab'));

const inputAreaSource = read('src/renderer/components/chat/InputArea.tsx');
assert.ok(!inputAreaSource.includes('setWaveTime'));
assert.ok(!inputAreaSource.includes('waveTime'));
assert.ok(!inputAreaSource.includes('<MicrophoneButton'));
assert.ok(!inputAreaSource.includes('<VoiceModeStatusBar'));
assert.ok(inputAreaSource.includes('<VoiceComposerControl'));
assert.ok(inputAreaSource.includes('build-composer-voice-active'));
assert.ok(inputAreaSource.includes('voiceComposerExpanded'));
const voiceComposerSource = read('src/renderer/components/chat/VoiceComposerControl.tsx');
assert.ok(voiceComposerSource.includes('data-testid="app-voice-control"'));
assert.ok(voiceComposerSource.includes('data-testid="voice-composer-presence"'));
assert.ok(voiceComposerSource.includes('build-voice-composer-orb'));
assert.ok(voiceComposerSource.includes('build-voice-composer-bars'));
assert.ok(voiceComposerSource.includes('Build is speaking'));
assert.ok(voiceComposerSource.includes('aria-label="Realtime voice"'));
assert.ok(voiceComposerSource.includes('data-testid="app-voice-picker"'));
assert.ok(voiceComposerSource.includes('REALTIME_VOICE_OPTIONS.map'));
assert.ok(voiceComposerSource.includes('updateSettings({ realtimeVoice })'));
assert.ok(voiceComposerSource.includes('getRealtimeVoiceLabel(voice)'));
assert.ok(voiceComposerSource.includes("new CustomEvent('grep-voice-toggle')"));
assert.ok(voiceComposerSource.includes('⌘⇧Y'));
const settingsDialogSource = read('src/renderer/components/settings/SettingsDialog.tsx');
assert.ok(settingsDialogSource.includes('REALTIME_VOICE_OPTIONS.map'));
assert.ok(settingsDialogSource.includes("value === 'M' ? 'marin' : value"));
assert.ok(settingsDialogSource.includes("Moneypenny keeps Marin's timbre"));
const audioTypesSource = read('src/shared/types/audio.ts');
assert.ok(audioTypesSource.includes("voice === 'M' ? 'Moneypenny' : voice"));
const appStatusBarSource = read('src/renderer/components/layout/StatusBar.tsx');
assert.ok(appStatusBarSource.includes('<MicrophoneButton />'));
assert.ok(!appStatusBarSource.includes('VoiceModeStatusBar'));
const appSource = read('src/renderer/App.tsx');
assert.ok(appSource.includes("case 'toggle-voice-mode'"));
assert.ok(appSource.includes("new CustomEvent('grep-voice-toggle')"));
assert.ok(appSource.includes("e.code === 'KeyY'"));
const globalStylesSource = read('src/renderer/styles/globals.css');
assert.ok(globalStylesSource.includes('@keyframes build-voice-orb-breathe'));
assert.ok(globalStylesSource.includes('.build-composer-shell.build-composer-voice-active'));
assert.ok(globalStylesSource.includes('.build-voice-composer-stage'));
assert.ok(globalStylesSource.includes('contain: strict'));
assert.ok(globalStylesSource.includes('will-change: transform, opacity'));
assert.ok(globalStylesSource.includes('.build-voice-presence:not(.is-idle) .build-voice-orb-glow'));
const mainIndexSource = read('src/main/index.ts');
assert.ok(mainIndexSource.includes("label: 'Toggle Voice Mode'"));
assert.ok(mainIndexSource.includes("accelerator: 'CommandOrControl+Shift+Y'"));
assert.ok(mainIndexSource.includes("sendShortcutToRenderer('toggle-voice-mode')"));
const mainContentSource = read('src/renderer/components/layout/MainContent.tsx');
assert.ok(mainContentSource.includes('data-voice-capture-region="side-panel"'));
assert.ok(mainContentSource.includes('data-voice-capture-region="terminal-panel"'));
const browserPreviewSource = read('src/renderer/components/preview/BrowserPreview.tsx');
assert.ok(browserPreviewSource.includes('pageUrl: url'));
assert.ok(browserPreviewSource.includes('selectedAt: Date.now()'));
const sessionStoreSource = read('src/renderer/stores/session.store.ts');
assert.ok(sessionStoreSource.includes('createForkFromCurrent: async (userMessage: string, attachments?: unknown[])'));
assert.ok(sessionStoreSource.includes('sendMessage(forkedSession.id, userMessage, attachments)'));
assert.ok(sessionStoreSource.includes('!opts?.forceQueue'));
assert.match(sessionStoreSource, /const recentlyQueuedSame = !fromQueueDrain\s+&& !opts\?\.forceQueue/);
assert.ok(sessionStoreSource.includes('opts?.existingMessageId || `msg-${submittedAt.getTime()}'));
assert.ok(sessionStoreSource.includes('if (opts?.returnAfterAdmission)'));
assert.ok(sessionStoreSource.includes("console.log('[SessionStore] Background sendMessage returned:', result)"));

const remoteCliSource = read('src/main/services/remote-build-cli-source.ts');
assert.ok(remoteCliSource.includes('Each successful call is independently persisted in the server queue'));

const messageQueueSource = read('src/main/services/message-queue.service.ts');
assert.ok(messageQueueSource.includes('A caller-supplied ID is the authoritative idempotency key'));
assert.ok(messageQueueSource.includes('? existingQueue.find((message) => message.id === opts.id)'));

const now = new Date('2026-07-24T16:00:00.000Z');
const makeSession = (id: string, name: string, updates: Partial<Session> = {}): Session => ({
  id,
  name,
  repoPath: '/home/ubuntu/worktrees/pool/parcha',
  worktreePath: '/home/ubuntu/worktrees/pool/parcha',
  branch: 'main',
  status: 'running',
  ports: { web: 3000, api: 3001, debug: 3002 },
  createdAt: now,
  updatedAt: now,
  setupScript: '',
  ...updates,
});
const agentBuilder = makeSession('agent-builder', 'Agent Builder', {
  manualName: 'Agent Builder',
  isRoot: true,
  isStarred: true,
  childSessionIds: ['orb'],
});
const orb = makeSession('orb', 'Orb (fork)', {
  manualName: 'Orb',
  parentSessionId: 'agent-builder',
  // Reproduce the persisted legacy inconsistency that previously flattened Orb.
  isRoot: true,
});
const changelog = makeSession('changelog', 'Seeing bad gateway frontend', {
  manualName: 'Seeing bad gateway frontend',
  branch: 'aj/changelog-v3',
});
const staleRoot = makeSession('stale-root', 'Stale root', {
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});
const staleLegacyStar = makeSession('stale-child', 'Legacy starred child', {
  parentSessionId: 'stale-root',
  isStarred: true,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});
const directoryState: VoiceDirectoryState = {
  sessions: [agentBuilder, orb, changelog, staleRoot, staleLegacyStar],
  activeSessionId: 'changelog',
  messages: {
    orb: [{
      id: 'orb-result',
      role: 'assistant',
      content: 'Orb work finished.',
      timestamp: now,
      harness: 'claude',
    }],
  },
  isStreaming: {},
  currentThinkingContent: {},
  currentStreamContent: {},
  currentToolCalls: {},
  activeStreamModel: {},
  selectedModel: { orb: 'claude-fable-3' },
  pendingPermission: {},
  pendingQuestion: {},
  pendingPlanApproval: {},
};
const groups = getVoiceSessionGroups(directoryState, now.getTime());
assert.deepStrictEqual(groups.map((group) => group.root.id), ['changelog', 'agent-builder']);
assert.ok(!groups.some((group) => group.root.id === 'stale-root'), 'a stale child star must not create a fake favorite');
assert.strictEqual(getVoiceTabLocation('orb', directoryState, now.getTime())?.label, 'Orb tab in Agent Builder');
assert.strictEqual(resolveVoiceDestination(directoryState, 'Agent Builder', 'Orb', now.getTime()).match?.tab.id, 'orb');
assert.strictEqual(resolveVoiceDestination(directoryState, '', 'Orb', now.getTime()).match?.tab.id, 'orb');

const olderOrb = makeSession('older-orb', 'Orb', {
  manualName: 'Orb',
  parentSessionId: 'agent-builder',
  updatedAt: new Date('2026-07-24T14:00:00.000Z'),
});
// Restored production stores can contain epoch timestamps even though fresh
// renderer sessions use Date/string values. The resolver must tolerate both.
(olderOrb as unknown as { updatedAt: number }).updatedAt = new Date('2026-07-24T14:00:00.000Z').getTime();
const duplicateOrbState: VoiceDirectoryState = {
  ...directoryState,
  sessions: [agentBuilder, olderOrb, orb, changelog],
};
assert.strictEqual(
  resolveVoiceDestination(
    duplicateOrbState,
    '',
    'Open the last Orb tab we were working on',
    now.getTime(),
  ).match?.tab.id,
  'orb',
  'recency wording must select the latest duplicate tab instead of failing as ambiguous',
);
assert.strictEqual(
  resolveVoiceDestination(duplicateOrbState, '', 'Orb', now.getTime()).match?.tab.id,
  'orb',
  'an exact duplicate tab name must default to the newest tab for reversible voice navigation',
);
assert.strictEqual(
  resolveVoiceDestination(duplicateOrbState, 'Agent Builder', 'Orb tab updated 2026-07-24T15:59:00.000Z', now.getTime()).match?.tab.id,
  'orb',
  'a model retry that includes an updated timestamp must still resolve the newest matching tab',
);
assert.strictEqual(
  resolveVoiceDestination(duplicateOrbState, 'Agent Builder', 'older-or', now.getTime()).match?.tab.id,
  'older-orb',
  'a candidate tab ID prefix must select a specific older duplicate',
);

const renamedChangelog = makeSession('renamed-changelog', 'Homepage copy', {
  branch: 'aj/marketing-copy-updates',
  updatedAt: new Date('2026-07-24T15:59:00.000Z'),
});
const topicState: VoiceDirectoryState = {
  ...directoryState,
  sessions: [renamedChangelog],
  activeSessionId: 'renamed-changelog',
  messages: {
    'renamed-changelog': [{
      id: 'changelog-request',
      role: 'user',
      content: 'Implement the changelog manifest and seven-day what is new link.',
      timestamp: now,
      harness: 'claude',
    }],
  },
};
assert.strictEqual(
  resolveVoiceDestination(
    topicState,
    '',
    'Open the last changelog tab we were working on',
    now.getTime(),
  ).match?.tab.id,
  'renamed-changelog',
  'recent conversation topics must remain searchable after a tab is renamed',
);
const directory = JSON.parse(describeVoiceSessionDirectory(directoryState));
assert.strictEqual(directory.activeTabId, 'changelog');
assert.ok(directory.sessions
  .find((entry: { sessionId: string }) => entry.sessionId === 'agent-builder')
  .tabs.some((tab: { tabName: string }) => tab.tabName === 'Orb'));
assert.strictEqual(APP_VOICE_SESSION_ID, 'build-app');

const mainServiceSource = read('src/main/services/openai-realtime-voice.service.ts');
assert.ok(mainServiceSource.includes('/v1/realtime/client_secrets'));
assert.ok(mainServiceSource.includes("'OpenAI-Safety-Identifier'"));
assert.ok(mainServiceSource.includes("if (voice === 'M') return 'marin'"));
assert.ok(mainServiceSource.includes('The tab visibly open in Build at the instant a coding tool executes is the authoritative default target'));
assert.ok(mainServiceSource.includes('ask one short clarification before calling any coding tool'));
assert.ok(mainServiceSource.includes('direct user response to that update authorizes the matching guarded reply route'));
assert.ok(mainServiceSource.includes('An unrelated request by itself is not permission to choose or create a tab'));
const forgeSource = read('forge.config.ts');
assert.ok(forgeSource.includes("ensureFile(path.join(appPath, 'Contents', 'CodeResources'))"));
const preloadSource = read('src/main/preload.ts');
assert.ok(preloadSource.includes('createRealtimeSession'));
assert.ok(preloadSource.includes('logRoutingEvent'));
assert.ok(preloadSource.includes('APP_CAPTURE_SCREEN'));
assert.ok(!preloadSource.includes('conversationToken'));
const settingsIpcSource = read('src/main/ipc/settings.ipc.ts');
assert.ok(settingsIpcSource.includes('sourceWindow.webContents.capturePage(captureRect)'));
assert.ok(settingsIpcSource.includes("target: captureRect ? (requestedRegion?.target || 'open panel')"));
const voiceIpcSource = read('src/main/ipc/voice.ipc.ts');
assert.ok(voiceIpcSource.includes("console.log(`[VoiceRouting] ${eventName}"));
assert.ok(hookSource.includes("logVoiceRouting('transcript.completed'"));
assert.ok(hookSource.includes("logVoiceRouting('tool.request'"));
assert.ok(hookSource.includes('responseActiveRef'));
assert.ok(hookSource.includes('responseCreatePendingRef'));
assert.ok(hookSource.includes("code === 'conversation_already_has_active_response'"));
assert.ok(hookSource.includes("logVoiceRouting('response.create.deferred'"));
assert.ok(hookSource.includes('queueMicrotask(requestResponse)'));

const transcriptionSource = read('src/main/services/realtime.service.ts');
assert.ok(transcriptionSource.includes('intent=transcription'));
assert.ok(transcriptionSource.includes("model: 'gpt-realtime-whisper'"));
assert.ok(!transcriptionSource.includes('realtime-preview'));
assert.ok(!transcriptionSource.includes('OpenAI-Beta'));

const sourceFiles = [
  ...fs.readdirSync(path.join(root, 'src/main/services')).map((name) => `src/main/services/${name}`),
  ...fs.readdirSync(path.join(root, 'src/renderer/hooks')).map((name) => `src/renderer/hooks/${name}`),
  ...fs.readdirSync(path.join(root, 'src/renderer/components/chat')).map((name) => `src/renderer/components/chat/${name}`),
].filter((relativePath) => fs.statSync(path.join(root, relativePath)).isFile());
for (const relativePath of sourceFiles) {
  assert.ok(!/elevenlabs/i.test(read(relativePath)), `${relativePath} still references ElevenLabs`);
}
const packageJson = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
assert.ok(!packageJson.dependencies?.['@elevenlabs/client']);
assert.ok(!packageJson.dependencies?.elevenlabs);

console.log('OpenAI Realtime voice verification passed.');
