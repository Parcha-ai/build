import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const queueService = fs.readFileSync(path.join(root, 'src/main/services/message-queue.service.ts'), 'utf8');
const harnessCapabilities = fs.readFileSync(path.join(root, 'src/main/services/harness-capabilities.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.match(
  harnessCapabilities,
  /claude:\s+\{\s*supportsAsyncInjection: false,\s*supportsMultiTurn: true,\s*minTurnGapMs: 500,/,
  'Claude queueing must wait for the active turn to finish instead of using streamInput mid-turn',
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

const dequeueForDrainMethod = queueService.match(/dequeueForDrain\(sessionId: string\): QueuedMessage \| undefined \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(dequeueForDrainMethod, /this\.queues\.set\(sessionId, \[\]\)/);
assert.match(dequeueForDrainMethod, /this\.processing\.set\(sessionId, true\)/);
assert.match(dequeueForDrainMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);
assert.match(dequeueForDrainMethod, /sourceCount: queue\.length/);

const cleanupMethod = queueService.match(/cleanup\(sessionId: string\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(cleanupMethod, /this\.drainDeferredSince\.delete\(sessionId\)/);

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

const hasActiveQueryMethod = claudeService.match(/hasActiveQuery\(sessionId: string\): boolean \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(hasActiveQueryMethod, /return this\.getActiveQueryState\(sessionId\)\.active/);

assert.match(claudeIpc, /const STALE_QUEUE_DRAIN_ACTIVE_QUERY_GRACE_MS = 30_000;/);
assert.match(claudeIpc, /const STALE_QUEUE_DRAIN_REMOTE_PROCESS_GRACE_MS = 30_000;/);
assert.ok((claudeIpc.match(/claudeService\.noteActiveQueryEvent\(sessionId\)/g) || []).length >= 2, 'stream and resume loops must refresh active query activity');

const drainHandler = claudeIpc.match(/messageQueueService\.on\('drain-ready'[\s\S]*?\n {2}\}\);/)?.[0] || '';
const sessionIndex = drainHandler.indexOf('const session = await sessionService.getSession(sessionId)');
const remoteReaderIndex = drainHandler.indexOf('const readRemoteActive = async () => session?.sshConfig');
const remoteProbeIndex = drainHandler.indexOf('let remoteActive = await readRemoteActive()');
const activeStateIndex = drainHandler.indexOf('const activeState = claudeService.getActiveQueryState(sessionId)');
const deferredMsIndex = drainHandler.indexOf('const deferredMs = messageQueueService.getDrainDeferredMs(sessionId)');
const supportsActiveInjectionIndex = drainHandler.indexOf('const supportsActiveInjection = messageQueueService.supportsActiveInjection(sessionId)');
const injectableIndex = drainHandler.indexOf('if (activeState.injectable && supportsActiveInjection) {');
const injectMessageIndex = drainHandler.indexOf('claudeService.injectMessage(');
const activeRemoteDeferralIndex = drainHandler.indexOf('if (remoteActive) {', injectableIndex);
const staleIndex = drainHandler.indexOf('const canTreatAsStale = (!activeState.injectable || !supportsActiveInjection)');
const deferActiveIndex = drainHandler.indexOf('messageQueueService.deferDrain(sessionId, 1000)', staleIndex);
const cancelIndex = drainHandler.indexOf('claudeService.cancelQuery(sessionId)');
const cleanupCompletedIndex = drainHandler.indexOf('sshService.cleanupDetachedBridgeProcessesForNewTurn(sessionId, session.sshConfig');
const remoteRecheckIndex = drainHandler.indexOf('remoteActive = await readRemoteActive()', cleanupCompletedIndex);
const staleRemoteCleanupIndex = drainHandler.indexOf('Clearing stale remote process before drain');
const killStaleRemoteIndex = drainHandler.indexOf('killActive: true', staleRemoteCleanupIndex);
const staleRemoteRecheckIndex = drainHandler.indexOf('remoteActive = await readRemoteActive()', killStaleRemoteIndex);
const finalRemoteActiveIndex = drainHandler.lastIndexOf('if (remoteActive) {');
const injectableDequeueIndex = drainHandler.indexOf('const next = messageQueueService.dequeueForDrain(sessionId)');
const newTurnDequeueIndex = drainHandler.lastIndexOf('const next = messageQueueService.dequeueForDrain(sessionId)');

assert.ok(sessionIndex >= 0, 'drain handler must load the session before active-query decisions');
assert.ok(remoteReaderIndex > sessionIndex, 'drain handler must define a remote process state reader early');
assert.ok(remoteProbeIndex > remoteReaderIndex, 'drain handler must check remote process state early');
assert.ok(activeStateIndex >= 0, 'drain handler must inspect active query state');
assert.ok(activeStateIndex > remoteProbeIndex, 'remote process state must be known before active-query stale handling');
assert.ok(deferredMsIndex > activeStateIndex, 'deferred age must be read after active query state');
assert.ok(supportsActiveInjectionIndex > deferredMsIndex, 'active injection must be gated by harness capabilities');
assert.ok(injectableIndex > supportsActiveInjectionIndex, 'injectable active queries must be handled only when harness capabilities allow it');
assert.ok(injectableDequeueIndex > injectableIndex, 'injectable active queries must drain the queue before injection');
assert.ok(injectMessageIndex > injectableDequeueIndex, 'drain handler must inject queued messages into injectable active queries');
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
assert.ok(newTurnDequeueIndex > finalRemoteActiveIndex, 'new-turn queue drain must happen only after active and remote process checks');
assert.match(drainHandler, /if \(!canTreatAsStale\) \{[\s\S]*?return;[\s\S]*?\}/);
assert.match(drainHandler, /Clearing stale active query before drain/);
assert.match(drainHandler, /Clearing stale remote process before drain/);
assert.match(drainHandler, /Deferring drain for \$\{sessionId\}; remote process is still active/);
assert.match(drainHandler, /supportsActiveInjection=\$\{supportsActiveInjection \? 'yes' : 'no'\}/);

assert.doesNotMatch(sessionStore, /window\.electronAPI\.claude\.injectMessage\(\s*sessionId,\s*nextMessage\.message/);
assert.match(sessionStore, /main queue owns injection/);

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
