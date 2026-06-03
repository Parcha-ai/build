import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const queueService = fs.readFileSync(path.join(root, 'src/main/services/message-queue.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');

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

const scheduleDrainMethod = queueService.match(/private scheduleDrain\(sessionId: string, delayMs: number\): void \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(scheduleDrainMethod, /if \(!this\.hasMessages\(sessionId\)\) return/);
assert.match(scheduleDrainMethod, /if \(!this\.streaming\.get\(sessionId\) && this\.hasMessages\(sessionId\)\) \{/);
assert.match(scheduleDrainMethod, /this\.emit\('drain-ready', sessionId\)/);

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
assert.ok((claudeIpc.match(/claudeService\.noteActiveQueryEvent\(sessionId\)/g) || []).length >= 2, 'stream and resume loops must refresh active query activity');

const drainHandler = claudeIpc.match(/messageQueueService\.on\('drain-ready'[\s\S]*?\n {2}\}\);/)?.[0] || '';
const activeStateIndex = drainHandler.indexOf('const activeState = claudeService.getActiveQueryState(sessionId)');
const deferredMsIndex = drainHandler.indexOf('const deferredMs = messageQueueService.getDrainDeferredMs(sessionId)');
const injectableIndex = drainHandler.indexOf('if (activeState.injectable) {');
const injectMessageIndex = drainHandler.indexOf('claudeService.injectMessage(');
const staleIndex = drainHandler.indexOf('const canTreatAsStale = !activeState.injectable && deferredMs >= STALE_QUEUE_DRAIN_ACTIVE_QUERY_GRACE_MS');
const deferActiveIndex = drainHandler.indexOf('messageQueueService.deferDrain(sessionId, 1000)');
const cancelIndex = drainHandler.indexOf('claudeService.cancelQuery(sessionId)');
const remoteActiveIndex = drainHandler.indexOf('const remoteActive = await sshService.hasActiveRemoteProcess');
const injectableDequeueIndex = drainHandler.indexOf('const next = messageQueueService.dequeueForDrain(sessionId)');
const newTurnDequeueIndex = drainHandler.lastIndexOf('const next = messageQueueService.dequeueForDrain(sessionId)');

assert.ok(activeStateIndex >= 0, 'drain handler must inspect active query state');
assert.ok(deferredMsIndex > activeStateIndex, 'deferred age must be read after active query state');
assert.ok(injectableIndex > deferredMsIndex, 'injectable active queries must be handled before stale cancellation');
assert.ok(injectableDequeueIndex > injectableIndex, 'injectable active queries must drain the queue before injection');
assert.ok(injectMessageIndex > injectableDequeueIndex, 'drain handler must inject queued messages into injectable active queries');
assert.ok(staleIndex > injectMessageIndex, 'stale decision must run after injectable active-query injection');
assert.ok(deferActiveIndex > staleIndex, 'active runtime must be deferred before cancellation');
assert.ok(cancelIndex > deferActiveIndex, 'stale active query must be cancelled only after non-stale deferral branch');
assert.ok(remoteActiveIndex > cancelIndex, 'remote process check must happen after stale local active-query handling');
assert.ok(newTurnDequeueIndex > remoteActiveIndex, 'new-turn queue drain must happen only after active and remote process checks');
assert.match(drainHandler, /if \(!canTreatAsStale\) \{[\s\S]*?return;[\s\S]*?\}/);
assert.match(drainHandler, /Clearing stale active query before drain/);
assert.match(drainHandler, /Deferring drain for \$\{sessionId\}; remote process is still active/);

console.log('queue stale active-query verifier passed');
