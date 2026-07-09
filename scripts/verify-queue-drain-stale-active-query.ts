import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const queueService = fs.readFileSync(path.join(root, 'src/main/services/message-queue.service.ts'), 'utf8');
const harnessCapabilities = fs.readFileSync(path.join(root, 'src/main/services/harness-capabilities.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const messageList = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageList.tsx'), 'utf8');

assert.match(
  harnessCapabilities,
  /claude:\s+\{\s*supportsAsyncInjection: true,\s*supportsMultiTurn: true,\s*minTurnGapMs: 500,/,
  'Claude queueing must use streamInput so queued turns dequeue while the active turn is still running',
);

assert.match(queueService, /private drainDeferredSince = new Map<string, number>\(\);/);
assert.match(queueService, /opts\?\.deferDrain/);
assert.match(queueService, /this\.processing\.set\(sessionId, true\);[\s\S]*?this\.scheduleDrain\(sessionId, 250\);/);

const clearMethod = queueService.match(/clear\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(clearMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);

const onStreamStartMethod = queueService.match(/onStreamStart\(sessionId: string, harness\?: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(onStreamStartMethod, /this\.streaming\.set\(sessionId, true\)/);
assert.match(onStreamStartMethod, /this\.processing\.set\(sessionId, false\)/);
assert.match(onStreamStartMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);
assert.match(onStreamStartMethod, /this\.remoteActiveDrainAllowed\.delete\(sessionId\)/);

const onStreamEndMethod = queueService.match(/onStreamEnd\(sessionId: string, opts\?: \{ drain\?: boolean; allowRemoteActiveDrain\?: boolean \}\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(onStreamEndMethod, /opts\?\.allowRemoteActiveDrain/);
assert.match(onStreamEndMethod, /this\.remoteActiveDrainAllowed\.add\(sessionId\)/);
assert.match(onStreamEndMethod, /this\.remoteActiveDrainAllowed\.delete\(sessionId\)/);

const buildDrainMessageMethod = queueService.match(/private buildDrainMessage\(queue: QueuedMessage\[\]\): QueuedMessage \| undefined \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(buildDrainMessageMethod, /sourceIds: queue\.map\(\(message\) => message\.id\)/);
assert.match(buildDrainMessageMethod, /sourceCount: queue\.length/);
assert.doesNotMatch(buildDrainMessageMethod, /this\.queues\.set\(/, 'building a drain batch must not mutate the queue');

const dequeueForDrainMethod = queueService.match(/dequeueForDrain\(sessionId: string\): QueuedMessage \| undefined \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(dequeueForDrainMethod, /const next = this\.peekForDrain\(sessionId\)/);
assert.match(dequeueForDrainMethod, /this\.ackDrain\(sessionId, next\.sourceIds, \{ keepProcessing: true \}\)/);

const peekForDrainMethod = queueService.match(/peekForDrain\(sessionId: string\): QueuedMessage \| undefined \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(peekForDrainMethod, /return this\.buildDrainMessage\(queue\)/);
assert.doesNotMatch(peekForDrainMethod, /this\.queues\.set\(/, 'active injection must be able to inspect a drain batch without consuming it');

const beginDrainAttemptMethod = queueService.match(/beginDrainAttempt\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(beginDrainAttemptMethod, /this\.processing\.set\(sessionId, true\)/);
assert.match(beginDrainAttemptMethod, /this\.emitStateChange\(sessionId\)/);

const finishDrainAttemptMethod = queueService.match(/finishDrainAttempt\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(finishDrainAttemptMethod, /this\.processing\.set\(sessionId, false\)/);
assert.match(finishDrainAttemptMethod, /this\.emitStateChange\(sessionId\)/);

const ackDrainMethod = queueService.match(/ackDrain\(sessionId: string, sourceIds\?: string\[\], opts\?: \{ keepProcessing\?: boolean; scheduleIfRemaining\?: boolean \}\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(ackDrainMethod, /queue\.filter\(\(message\) => !ids\.has\(message\.id\)\)/);
assert.match(ackDrainMethod, /this\.processing\.set\(sessionId, Boolean\(opts\?\.keepProcessing\)\)/);
assert.match(ackDrainMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);
assert.match(ackDrainMethod, /this\.remoteActiveDrainAllowed\.delete\(sessionId\)/);
assert.match(ackDrainMethod, /opts\?\.scheduleIfRemaining/);

const cleanupMethod = queueService.match(/cleanup\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(cleanupMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);
assert.match(cleanupMethod, /this\.remoteActiveDrainAllowed\.delete\(sessionId\)/);

const deferDrainMethod = queueService.match(/deferDrain\(sessionId: string, delayMs: number\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(deferDrainMethod, /if \(!this\.drainDeferredSince\.has\(sessionId\)\) \{/);
assert.match(deferDrainMethod, /this\.drainDeferredSince\.set\(sessionId, Date\.now\(\)\)/);
assert.match(deferDrainMethod, /this\.scheduleDrain\(sessionId, delayMs\)/);

const getDrainDeferredMsMethod = queueService.match(/getDrainDeferredMs\(sessionId: string\): number \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(getDrainDeferredMsMethod, /const startedAt = this\.drainDeferredSince\.get\(sessionId\)/);
assert.match(getDrainDeferredMsMethod, /return startedAt \? Date\.now\(\) - startedAt : 0/);

const supportsActiveInjectionMethod = queueService.match(/supportsActiveInjection\(sessionId: string\): boolean \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(supportsActiveInjectionMethod, /const harness = this\.activeHarness\.get\(sessionId\)/);
assert.match(supportsActiveInjectionMethod, /if \(!harness\) return false/);
assert.match(supportsActiveInjectionMethod, /return getHarnessCapabilities\(harness\)\.supportsAsyncInjection/);

const canDrainPastRemoteActiveMethod = queueService.match(/canDrainPastRemoteActive\(sessionId: string\): boolean \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(canDrainPastRemoteActiveMethod, /return this\.remoteActiveDrainAllowed\.has\(sessionId\)/);

const clearRemoteActiveDrainAllowanceMethod = queueService.match(/clearRemoteActiveDrainAllowance\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(clearRemoteActiveDrainAllowanceMethod, /this\.remoteActiveDrainAllowed\.delete\(sessionId\)/);

const scheduleDrainMethod = queueService.match(/private scheduleDrain\(sessionId: string, delayMs: number\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(scheduleDrainMethod, /if \(!this\.hasMessages\(sessionId\)\) return/);
assert.match(scheduleDrainMethod, /const isStreaming = this\.streaming\.get\(sessionId\) \|\| false/);
assert.match(scheduleDrainMethod, /const canDrainActiveStream = isStreaming && this\.supportsActiveInjection\(sessionId\)/);
assert.match(scheduleDrainMethod, /if \(\(!isStreaming \|\| canDrainActiveStream\) && this\.hasMessages\(sessionId\)\) \{/);
assert.match(scheduleDrainMethod, /this\.emit\('drain-ready', sessionId\)/);

const enqueueMethod = queueService.match(/enqueue\(sessionId: string, text: string, attachments\?: unknown\[\], opts\?: \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(enqueueMethod, /const canDrainActiveStream = isStreaming && this\.supportsActiveInjection\(sessionId\)/);
assert.match(enqueueMethod, /if \(\(!isStreaming \|\| canDrainActiveStream\) && !this\.processing\.get\(sessionId\)\) \{/);

assert.match(claudeService, /private activeQueryStartedAt: Map<string, number> = new Map\(\);/);
assert.match(claudeService, /private activeQueryLastEventAt: Map<string, number> = new Map\(\);/);
assert.doesNotMatch(
  claudeService,
  /class SdkUserInputStream implements AsyncIterable<SDKUserMessage>/,
  'initial Claude turns must not use a long-lived SDK input stream; it can leave the query waiting forever',
);
assert.doesNotMatch(claudeService, /activeQueryInputStreams/);
assert.match(claudeService, /const prompt = hasImages \? createPromptWithImages\(\) : fullTextMessage;/);
assert.match(claudeService, /Injecting queued message via Query\.streamInput/);
assert.match(
  claudeService,
  /queued user follow-ups should still be able to enter Claude Code via[\s\S]*?Query\.streamInput/,
  'Claude Code must keep the SDK Query object available for queued follow-ups while background task events keep the iterator alive',
);

const setActiveQueryMethod = claudeService.match(/private setActiveQuery\(sessionId: string, abortController: AbortController\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(setActiveQueryMethod, /const now = Date\.now\(\)/);
assert.match(setActiveQueryMethod, /this\.activeQueries\.set\(sessionId, abortController\)/);
assert.match(setActiveQueryMethod, /this\.activeQueryStartedAt\.set\(sessionId, now\)/);
assert.match(setActiveQueryMethod, /this\.activeQueryLastEventAt\.set\(sessionId, now\)/);

const clearActiveQueryMethod = claudeService.match(/private clearActiveQuery\(sessionId: string, abortController\?: AbortController\): boolean \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(clearActiveQueryMethod, /this\.activeQueries\.delete\(sessionId\)/);
assert.match(clearActiveQueryMethod, /this\.activeQueryStartedAt\.delete\(sessionId\)/);
assert.match(clearActiveQueryMethod, /this\.activeQueryLastEventAt\.delete\(sessionId\)/);
assert.match(clearActiveQueryMethod, /this\.activeQueryObjects\.delete\(sessionId\)/);

const noteActiveQueryEventMethod = claudeService.match(/noteActiveQueryEvent\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(noteActiveQueryEventMethod, /if \(this\.activeQueries\.has\(sessionId\)\) \{/);
assert.match(noteActiveQueryEventMethod, /this\.activeQueryLastEventAt\.set\(sessionId, Date\.now\(\)\)/);

const getActiveQueryStateMethod = claudeService.match(/getActiveQueryState\(sessionId: string\): \{[\s\S]*?\n {2}\} \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(getActiveQueryStateMethod, /active: boolean/);
assert.match(getActiveQueryStateMethod, /injectable: boolean/);
assert.match(getActiveQueryStateMethod, /ageMs: number/);
assert.match(getActiveQueryStateMethod, /idleMs: number/);
assert.match(getActiveQueryStateMethod, /if \(controller\.signal\.aborted\) \{/);
assert.match(getActiveQueryStateMethod, /this\.clearActiveQuery\(sessionId, controller\)/);
assert.match(getActiveQueryStateMethod, /injectable: this\.activeQueryObjects\.has\(sessionId\)/);

const queryCompleteBranch = claudeService.slice(
  claudeService.indexOf('if (queryComplete) {'),
  claudeService.indexOf('iterResult = await msgIterator.next();', claudeService.indexOf('if (queryComplete) {')),
);
assert.doesNotMatch(
  queryCompleteBranch,
  /activeQueryObjects\.delete\(sessionId\)/,
  'result-message transition must not drop the Query object before queued follow-ups can inject',
);

const hasActiveQueryMethod = claudeService.match(/hasActiveQuery\(sessionId: string\): boolean \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(hasActiveQueryMethod, /return this\.getActiveQueryState\(sessionId\)\.active/);

assert.match(claudeIpc, /const STALE_QUEUE_DRAIN_ACTIVE_QUERY_GRACE_MS = 30_000;/);
assert.match(claudeIpc, /const STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS = 30_000;/);
assert.ok((claudeIpc.match(/claudeService\.noteActiveQueryEvent\(sessionId\)/g) || []).length >= 2, 'stream and resume loops must refresh active query activity');

const transcriptSnapshotWriter = claudeIpc.match(/function createTranscriptSnapshotWriter\(sessionId: string, model\?: string \| null(?:, overrideId\?: string)?\) \{[\s\S]*?\n\}/)?.[0] || '';
assert.match(
  transcriptSnapshotWriter,
  /const startedAt = new Date\(\);/,
  'live transcript snapshots may use stream start time for stable partial rows',
);
assert.match(
  transcriptSnapshotWriter,
  /timestamp: startedAt,/,
  'partial assistant snapshots should keep their original stream-start timestamp',
);
assert.match(
  transcriptSnapshotWriter,
  /finalizedMessage: ChatMessage = \{[\s\S]*?timestamp: new Date\(\),/,
  'final assistant transcript row must use completion time so queued follow-up prompts stay before the output',
);

assert.match(
  messageList,
  /const MESSAGE_ROLE_ORDER: Record<ChatMessage\['role'\], number> = \{[\s\S]*?user: 1,[\s\S]*?assistant: 2,/,
  'message list must tie-break equal timestamps by role so user prompts render before assistant output',
);
assert.match(
  messageList,
  /function compareVisibleMessages\(a: ChatMessage, b: ChatMessage\): number \{[\s\S]*?const roleDelta = MESSAGE_ROLE_ORDER\[a\.role\] - MESSAGE_ROLE_ORDER\[b\.role\];/,
  'message list must use canonical visible message ordering',
);
assert.match(
  messageList,
  /\.sort\(compareVisibleMessages\)/,
  'message list must not sort chat rows by timestamp alone',
);

const resumeHandler = claudeIpc.match(/IPC_CHANNELS\.CLAUDE_RESUME_REMOTE_TURN[\s\S]*?\n {4}\}\n {2}\);/)?.[0] || '';
assert.match(
  resumeHandler,
  /let resumeProducedVisibleOutput = false;/,
  'resume reattach must track whether it recovered visible assistant output',
);
assert.match(
  resumeHandler,
  /let resumeCompletedWithResult = false;/,
  'resume reattach must track whether it saw a real completion result',
);
assert.match(
  resumeHandler,
  /let notifiedQueueStreamEnd = false;/,
  'resume reattach must notify queue drain once at message completion',
);
assert.match(
  resumeHandler,
  /if \(resumeProducedVisibleOutput\) \{\s*recordCompletedStreamMessage\(sessionId, finalizedMessage\);/,
  'failed or empty resume reattach must not persist a blank assistant turn',
);
assert.match(
  resumeHandler,
  /const shouldDrainAfterResume = !hadError && resumeProducedVisibleOutput;/,
  'resume reattach must compute queue drain from both success and visible recovered output',
);
assert.match(
  resumeHandler,
  /Resume reattach produced no visible output; suppressing queue drain/,
  'failed or empty resume reattach must leave an installed-bundle marker for queue drain suppression',
);
assert.match(
  resumeHandler,
  /notifyQueueStreamEnd\(resumeProducedVisibleOutput, resumeProducedVisibleOutput\);/,
  'resume reattach must release the queue at message_complete instead of waiting for remote bridge teardown',
);
assert.match(
  resumeHandler,
  /notifyQueueStreamEnd\(shouldDrainAfterResume, shouldDrainAfterResume && resumeCompletedWithResult\);/,
  'failed or empty resume reattach must not drain queued prompts as if a turn completed',
);

assert.match(
  claudeIpc,
  /const notifyQueueStreamEnd = \(allowRemoteActiveDrain: boolean\): void => \{[\s\S]*?messageQueueService\.onStreamEnd\(sessionId, \{[\s\S]*?allowRemoteActiveDrain,/,
  'normal Claude streams must release queued drains at message_complete and allow completed remote bridge handoff',
);

const drainHandler = claudeIpc.match(/messageQueueService\.on\('drain-ready'[\s\S]*?\n {2}\}\);/)?.[0] || '';
const sessionIndex = drainHandler.indexOf('const session = await sessionService.getSession(sessionId)');
const remoteReaderIndex = drainHandler.indexOf('const readRemoteActive = async () => session?.sshConfig');
const remoteProbeIndex = drainHandler.indexOf('let remoteActive = await readRemoteActive()');
const activeStateIndex = drainHandler.indexOf('const activeState = claudeService.getActiveQueryState(sessionId)');
const deferredMsIndex = drainHandler.indexOf('const deferredMs = messageQueueService.getDrainDeferredMs(sessionId)');
const supportsActiveInjectionIndex = drainHandler.indexOf('const supportsActiveInjection = messageQueueService.supportsActiveInjection(sessionId)');
const canDrainPastRemoteActiveIndex = drainHandler.indexOf('const canDrainPastRemoteActive = messageQueueService.canDrainPastRemoteActive(sessionId)');
const injectableIndex = drainHandler.indexOf('if (activeState.injectable && supportsActiveInjection) {');
const injectMessageIndex = drainHandler.indexOf('claudeService.injectMessage(');
const activeRemoteDeferralIndex = drainHandler.indexOf('if (remoteActive) {', injectableIndex);
const injectableBranch = drainHandler.slice(injectableIndex, activeRemoteDeferralIndex);
const injectablePeekIndex = drainHandler.indexOf('const next = messageQueueService.peekForDrain(sessionId)', injectableIndex);
const beginDrainAttemptIndex = drainHandler.indexOf('messageQueueService.beginDrainAttempt(sessionId)', injectableIndex);
const activeAckDrainIndex = drainHandler.indexOf('messageQueueService.ackDrain(sessionId, next.sourceIds,', injectMessageIndex);
const activeFinishAttemptIndex = drainHandler.indexOf('messageQueueService.finishDrainAttempt(sessionId)', activeAckDrainIndex);
const activeRetryDeferIndex = drainHandler.indexOf('messageQueueService.deferDrain(sessionId, 1000)', activeFinishAttemptIndex);
const staleIndex = drainHandler.indexOf('const canTreatAsStale = (!activeState.injectable || !supportsActiveInjection)');
const deferActiveIndex = drainHandler.indexOf('messageQueueService.deferDrain(sessionId, 1000)', staleIndex);
const cancelIndex = drainHandler.indexOf('claudeService.cancelQuery(sessionId)');
const cleanupCompletedIndex = drainHandler.indexOf('sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig');
const remoteRecheckIndex = drainHandler.indexOf('remoteActive = await readRemoteActive()', cleanupCompletedIndex);
const staleRemoteCleanupIndex = drainHandler.indexOf('Clearing stale remote process before drain');
const killStaleRemoteIndex = drainHandler.indexOf('killActive: true', staleRemoteCleanupIndex);
const staleRemoteRecheckIndex = drainHandler.indexOf('remoteActive = await readRemoteActive()', killStaleRemoteIndex);
const finalRemoteActiveIndex = drainHandler.indexOf('if (remoteActive && !canDrainPastRemoteActive) {');
const mainWindowBeforeDequeueIndex = drainHandler.indexOf('const mainWindow = getMainWindow()', finalRemoteActiveIndex);
const newTurnDequeueIndex = drainHandler.lastIndexOf('const next = messageQueueService.dequeueForDrain(sessionId)');
const clearRemoteAllowanceIndex = drainHandler.indexOf('messageQueueService.clearRemoteActiveDrainAllowance(sessionId)', newTurnDequeueIndex);

assert.ok(sessionIndex >= 0, 'drain handler must load the session before active-query decisions');
assert.ok(remoteReaderIndex > sessionIndex, 'drain handler must define a remote process state reader early');
assert.ok(remoteProbeIndex > remoteReaderIndex, 'drain handler must check remote process state early');
assert.ok(activeStateIndex >= 0, 'drain handler must inspect active query state');
assert.ok(activeStateIndex > remoteProbeIndex, 'remote process state must be known before active-query stale handling');
assert.ok(deferredMsIndex > activeStateIndex, 'deferred age must be read after active query state');
assert.ok(supportsActiveInjectionIndex > deferredMsIndex, 'active injection must be gated by harness capabilities');
assert.ok(canDrainPastRemoteActiveIndex > supportsActiveInjectionIndex, 'completed-stream remote-active handoff must be read before active deferrals');
assert.ok(injectableIndex > canDrainPastRemoteActiveIndex, 'injectable active queries must be handled only when harness capabilities allow it');
assert.ok(injectablePeekIndex > injectableIndex, 'injectable active queries must peek at queued messages before injection');
assert.doesNotMatch(injectableBranch, /dequeueForDrain/, 'injectable active-query delivery must not consume the queue before streamInput succeeds');
assert.ok(beginDrainAttemptIndex > injectablePeekIndex, 'injectable active queries must mark a drain attempt without removing messages');
assert.ok(beginDrainAttemptIndex < injectMessageIndex, 'active injection must mark processing before awaiting streamInput');
assert.ok(injectMessageIndex > beginDrainAttemptIndex, 'drain handler must inject queued messages into injectable active queries');
assert.ok(activeAckDrainIndex > injectMessageIndex, 'active injection must ack/remove queue messages only after streamInput succeeds');
assert.ok(activeFinishAttemptIndex > activeAckDrainIndex, 'failed active injection must clear processing without consuming the queue');
assert.ok(activeRetryDeferIndex > activeFinishAttemptIndex && activeRetryDeferIndex < activeRemoteDeferralIndex, 'failed active injection must retry via the queue instead of sending a duplicate new turn');
assert.ok(activeRemoteDeferralIndex > injectMessageIndex, 'active remote sessions must be deferred after any supported injection branch');
assert.ok(activeRemoteDeferralIndex < staleIndex, 'remote liveness must prevent stale active-query cancellation');
assert.ok(staleIndex > activeRemoteDeferralIndex, 'stale decision must run only after remote-active deferral');
assert.ok(deferActiveIndex > staleIndex, 'active runtime must be deferred before cancellation');
assert.ok(cancelIndex > deferActiveIndex, 'stale active query must be cancelled only after non-stale deferral branch');
assert.ok(cleanupCompletedIndex > cancelIndex, 'completed remote bridge cleanup must run before final remote-active deferral');
assert.ok(remoteRecheckIndex > cleanupCompletedIndex, 'remote process state must be rechecked after completed bridge cleanup');
assert.ok(staleRemoteCleanupIndex > remoteRecheckIndex, 'stale remote cleanup must run only after completed bridge cleanup cannot clear the remote process');
assert.ok(killStaleRemoteIndex > staleRemoteCleanupIndex, 'stale remote cleanup must be allowed to kill the stale active process');
assert.ok(staleRemoteRecheckIndex > killStaleRemoteIndex, 'remote process state must be rechecked after stale remote cleanup');
assert.ok(finalRemoteActiveIndex > staleRemoteRecheckIndex, 'remote process check must run again before new-turn drain');
assert.ok(mainWindowBeforeDequeueIndex > finalRemoteActiveIndex, 'drain handler must find a renderer window before consuming queued messages');
assert.ok(newTurnDequeueIndex > mainWindowBeforeDequeueIndex, 'new-turn queue drain must happen only after active and remote process checks');
assert.ok(clearRemoteAllowanceIndex > newTurnDequeueIndex, 'one-shot completed-stream bypass must be cleared when the queued turn is consumed');
assert.match(drainHandler, /if \(!canTreatAsStale\) \{[\s\S]*?return;[\s\S]*?\}/);
assert.match(drainHandler, /Clearing stale active query before drain/);
assert.match(drainHandler, /Clearing stale remote process before drain/);
assert.match(drainHandler, /Draining queued turn for \$\{sessionId\} after completed stream while active runtime remains/);
assert.match(drainHandler, /Draining queued turn for \$\{sessionId\} after completed stream while remote bridge remains active/);
assert.match(drainHandler, /Rechecked remote process after completed-stream bridge cleanup/);
assert.match(drainHandler, /remoteActive && !canDrainPastRemoteActive && session\?\.sshConfig && deferredMs >= STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS/);
assert.match(drainHandler, /Deferring drain for \$\{sessionId\}; remote process is still active/);
assert.match(drainHandler, /supportsActiveInjection=\$\{supportsActiveInjection \? 'yes' : 'no'\}/);

assert.doesNotMatch(sessionStore, /window\.electronAPI\.claude\.injectMessage\(\s*sessionId,\s*nextMessage\.message/);
assert.match(sessionStore, /main queue owns injection/);
assert.match(
  sessionStore,
  /const consumedQueueMessageIds = new Map<string, Set<string>>\(\);/,
  'renderer must remember drained queue ids so hydration cannot resurrect consumed prompts',
);
assert.match(
  sessionStore,
  /function markQueueMessagesConsumed\(sessionId: string, messageIds: string\[\]\): void \{/,
  'renderer must expose a consumed queue marker',
);
assert.match(
  sessionStore,
  /function isConsumedQueueMessage\(sessionId: string, message: ChatMessage\): boolean \{/,
  'renderer must detect consumed queued user bubbles during transcript hydration',
);
assert.match(
  sessionStore.slice(
    sessionStore.indexOf('function mergeLoadedMessagesWithExisting('),
    sessionStore.indexOf('function isAutoBuildAssistantMessage('),
  ),
  /filter\(\(message\) => !isConsumedQueueMessage\(sessionId, message\)\)/,
  'transcript hydration must not preserve consumed queued user bubbles',
);
assert.match(
  sessionStore,
  /markQueueMessagesConsumed\(sessionId, sourceIds\);/,
  'queue:send-next must mark drained source ids as consumed',
);
assert.match(
  sessionStore,
  /suppressUserMessage: Boolean\(msg\.suppressUserMessage\) \|\| !hadVisibleQueuedMessage/,
  'queue-drained turns must not create a new user bubble if the visible queued bubble is already gone',
);
assert.match(
  sessionStore,
  /incomingMessages\.length === 0[\s\S]*?markQueueMessagesConsumed\(sessionId, previousQueue\.map\(\(message\) => message\.id\)\)/,
  'queue state sync must mark ids consumed when active injection clears the main-process queue',
);

const optimisticMessageIndex = sessionStore.indexOf('addMessage(sessionId, userMessage)');
const rendererStreamStartIndex = sessionStore.indexOf('setStreaming(sessionId, true)', optimisticMessageIndex);
const rendererRemoteProbeIndex = sessionStore.indexOf('window.electronAPI.ssh.hasActiveRemoteProcess(sessionId)', optimisticMessageIndex);
const rendererQueueIndex = sessionStore.indexOf('window.electronAPI.queue?.enqueue(sessionId, message, attachments', rendererRemoteProbeIndex);
assert.ok(optimisticMessageIndex >= 0, 'renderer send path must add the user message optimistically');
assert.ok(rendererStreamStartIndex > optimisticMessageIndex, 'renderer send path must enter submitted state after the visible user message');
assert.ok(rendererStreamStartIndex < rendererRemoteProbeIndex, 'renderer send path must not block submitted state on the remote-active probe');
assert.ok(rendererRemoteProbeIndex > optimisticMessageIndex, 'renderer remote-active probe must happen after the visible user message');
assert.ok(rendererQueueIndex > rendererRemoteProbeIndex, 'renderer must enqueue instead of direct-sending when remote Claude is active');
assert.match(sessionStore, /isStreaming: \{ \.\.\.state\.isStreaming, \[sessionId\]: false \}/);
assert.match(sessionStore, /deferDrain: true/);
assert.match(sessionStore, /queued message after optimistic send/);

console.log('queue stale active-query verifier passed');
