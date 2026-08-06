import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { messageQueueService } from '../src/main/services/message-queue.service';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

async function verifyQueueHold(): Promise<void> {
  const sessionId = `verify-fast-stack-${Date.now()}`;
  let drainReadyCount = 0;
  const onDrainReady = (candidateSessionId: string) => {
    if (candidateSessionId === sessionId) drainReadyCount += 1;
  };
  messageQueueService.on('drain-ready', onDrainReady);

  try {
    messageQueueService.onStreamStart(sessionId, 'claude');
    const selected = messageQueueService.enqueue(sessionId, 'run me now', undefined, { id: 'selected' });
    messageQueueService.enqueue(sessionId, 'keep me queued', undefined, { id: 'sibling' });
    assert.equal(messageQueueService.length(sessionId), 2);

    messageQueueService.beginFastStack(sessionId);
    messageQueueService.remove(sessionId, selected.id);
    messageQueueService.onStreamEnd(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(drainReadyCount, 0, 'cancelled parent must not drain sibling prompts');
    assert.equal(messageQueueService.peek(sessionId)?.id, 'sibling');

    messageQueueService.markFastStackRunning(sessionId);
    messageQueueService.onStreamStart(sessionId, 'claude');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(drainReadyCount, 0, 'sibling prompts must remain held during the forked turn');

    messageQueueService.onStreamEnd(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(drainReadyCount, 0, 'replacement stream end stays held until renderer release');
    messageQueueService.abortFastStack(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(drainReadyCount, 1, 'normal queue drain must resume after the Fast Stack turn');
    assert.equal(messageQueueService.peek(sessionId)?.id, 'sibling');
  } finally {
    messageQueueService.removeListener('drain-ready', onDrainReady);
    messageQueueService.cleanup(sessionId);
  }
}

async function main(): Promise<void> {
  const channels = read('src/shared/constants/channels.ts');
  const preload = read('src/main/preload.ts');
  const sessionIpc = read('src/main/ipc/session.ipc.ts');
  const sessionService = read('src/main/services/session.service.ts');
  const claudeService = read('src/main/services/claude.service.ts');
  const queueService = read('src/main/services/message-queue.service.ts');
  const sessionStore = read('src/renderer/stores/session.store.ts');
  const inputArea = read('src/renderer/components/chat/InputArea.tsx');
  const queuePanel = read('src/renderer/components/chat/MessageQueuePanel.tsx');

  assert.match(channels, /SESSION_FAST_STACK_FORK: 'session:fast-stack-fork'/);
  assert.match(preload, /fastStackFork: \(sessionId: string\)/);
  assert.match(preload, /beginFastStack:[\s\S]*?markFastStackRunning:[\s\S]*?abortFastStack:/);
  assert.match(sessionIpc, /SESSION_FAST_STACK_FORK[\s\S]*?prepareFastStack\(sessionId\)[\s\S]*?fastStackForkInPlace\(sessionId\)/);
  assert.match(sessionService, /fastStackForkInPlace\(sessionId: string\)/);
  assert.match(sessionService, /forkSession\(parentSdkSessionId, forkOptions\)/);
  assert.match(sessionService, /this\.store\.set\(`sdkSessionMappings\.\$\{sessionId\}`, result\.sessionId\)/);
  assert.match(sessionService, /this\.store\.set\(`sessions\.\$\{sessionId\}`, updatedSession\)/);
  assert.match(claudeService, /prepareFastStack\(sessionId: string\)[\s\S]*?codexService\.clearThreadId\(sessionId\)[\s\S]*?clearChatId\(sessionId\)/);

  assert.match(queueService, /fastStackPhase = new Map<string, 'cancelling' \| 'running'>/);
  assert.match(queueService, /fastStackPhase === 'cancelling'[\s\S]*?return;/);
  assert.match(queueService, /fastStackPhase === 'running'[\s\S]*?this\.emitStateChange\(sessionId\);[\s\S]*?return;/);
  assert.match(queueService, /this\.fastStackPhase\.has\(sessionId\)/);

  assert.match(sessionStore, /fastStack: async \(sessionId, message, attachments, queuedMessageId/);
  assert.match(sessionStore, /queue\?\.beginFastStack\(sessionId\)/);
  assert.match(sessionStore, /for \(const queuedMessage of initialState\.messageQueue\[sessionId\] \|\| \[\]\)[\s\S]*?queue\?\.enqueue\(/);
  assert.match(sessionStore, /queue\?\.remove\(sessionId, effectiveQueuedMessageId\)/);
  assert.match(sessionStore, /sessions\.fastStackFork\(sessionId\)/);
  assert.match(sessionStore, /queue\?\.markFastStackRunning\(sessionId\)/);
  assert.match(sessionStore, /const effectiveQueuedMessageId = queuedMessageId \|\| matchingQueuedMessage\?\.id/);
  assert.match(sessionStore, /candidate\.message\.trim\(\) === message\.trim\(\)[\s\S]*?sameAttachments\(candidate\.attachments, attachments\)/);
  assert.match(sessionStore, /existingMessageId: fastStackMessageId/);
  assert.match(sessionStore, /existingMessageId: fastStackMessageId,[\s\S]*?fromQueueDrain: true/);
  assert.match(sessionStore, /const fastStackSiblings =/);
  assert.match(sessionStore, /if \(fastStackSiblings\.length > 0\)[\s\S]*?fromQueueDrain: true/);
  assert.doesNotMatch(
    sessionStore.match(/fastStack: async[\s\S]*?\n\s{2}\},\n\n\s{2}\/\/ Setup progress methods/)?.[0] || '',
    /queue\?\.clear\(sessionId\)/,
    'Fast Stack must not clear sibling queue items',
  );
  assert.doesNotMatch(
    sessionStore.match(/fastStack: async[\s\S]*?\n\s{2}\},\n\n\s{2}\/\/ Setup progress methods/)?.[0] || '',
    /suppressQueueDrain\(sessionId/,
    'Fast Stack queue phases replace generic cancellation drain suppression',
  );
  assert.match(
    sessionStore,
    /const sendDrainedMessage = async[\s\S]*?claude\.hasActiveQuery\(sessionId\)[\s\S]*?if \(backendActive && attempt < 12_000\)[\s\S]*?clearing stale renderer stream state/,
    'queue handoff must wait for backend ownership and reconcile stale renderer state',
  );

  assert.match(inputArea, /Cmd\/Ctrl\+Shift\+Enter: Fast Stack/);
  assert.match(inputArea, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey/);
  assert.match(queuePanel, /Fast Stack — fork now and run in this chat/);
  assert.match(queuePanel, /fastStack\(sessionId, message, attachments, id, suppressUserMessage\)/);

  await verifyQueueHold();
  console.log('Fast Stack verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
