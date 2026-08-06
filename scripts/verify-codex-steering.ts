import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PassThrough } from 'stream';
import {
  CodexAppServerConnection,
  getCodexAppServerMessageTurnId,
} from '../src/main/services/codex-app-server-connection';
import { getHarnessCapabilities } from '../src/main/services/harness-capabilities';
import { messageQueueService } from '../src/main/services/message-queue.service';
import { filterRemoteCodexEnvironment } from '../src/main/utils/remote-codex-env';

async function verifyProtocolAcknowledgement(): Promise<void> {
  const clientInput = new PassThrough();
  const serverOutput = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const reader = readline.createInterface({ input: clientInput });

  reader.on('line', (line) => {
    const request = JSON.parse(line) as Record<string, unknown>;
    requests.push(request);
    if (request.method === 'initialize') {
      serverOutput.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'fake' } })}\n`);
    }
    if (request.method === 'turn/steer') {
      const params = request.params as Record<string, unknown>;
      assert.strictEqual(params.threadId, 'thread-1');
      assert.strictEqual(params.expectedTurnId, 'turn-1');
      serverOutput.write(`${JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } })}\n`);
    }
  });

  const connection = new CodexAppServerConnection(clientInput, serverOutput);
  await connection.initialize();
  serverOutput.write('remote startup diagnostic\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(connection.getDiagnostics(), 'remote startup diagnostic');
  const response = await connection.request('turn/steer', {
    threadId: 'thread-1',
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'steer this turn', text_elements: [] }],
  });

  assert.strictEqual(response.turnId, 'turn-1');
  assert.ok(requests.some((request) => request.method === 'initialized'));
  connection.endInput();
  connection.dispose();
  reader.close();
}

function verifyDelegatedTurnCorrelation(): void {
  assert.strictEqual(getCodexAppServerMessageTurnId({
    method: 'item/completed',
    params: {
      turnId: 'child-turn',
      item: { type: 'agentMessage', text: 'sent to lead' },
    },
  }), 'child-turn');
  assert.strictEqual(getCodexAppServerMessageTurnId({
    method: 'turn/completed',
    params: { turn: { id: 'child-turn', status: 'completed' } },
  }), 'child-turn');
  assert.strictEqual(getCodexAppServerMessageTurnId({
    method: 'thread/started',
    params: { thread: { id: 'thread-1' } },
  }), undefined);
}

async function verifyCodexQueueDrainsDuringStreaming(): Promise<void> {
  const sessionId = `verify-codex-steer-${Date.now()}`;
  assert.strictEqual(getHarnessCapabilities('codex').supportsAsyncInjection, true);

  const drained = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Codex queue did not schedule an active-turn drain')), 1_000);
    const onDrain = (drainedSessionId: string) => {
      if (drainedSessionId !== sessionId) return;
      clearTimeout(timeout);
      messageQueueService.off('drain-ready', onDrain);
      resolve(drainedSessionId);
    };
    messageQueueService.on('drain-ready', onDrain);
  });

  messageQueueService.onStreamStart(sessionId, 'codex');
  const queued = messageQueueService.enqueue(sessionId, 'steer the active Codex turn');
  assert.strictEqual(await drained, sessionId);

  messageQueueService.beginDrainAttempt(sessionId);
  assert.strictEqual(messageQueueService.length(sessionId), 1, 'in-flight steer must remain queued until acknowledged');
  messageQueueService.ackDrain(sessionId, [queued.id]);
  assert.strictEqual(messageQueueService.length(sessionId), 0, 'acknowledged steer must leave the queue');
  messageQueueService.cleanup(sessionId);
}

function verifyWiringAndCopy(): void {
  const root = path.resolve(__dirname, '..');
  const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
  const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
  const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
  const messageList = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageList.tsx'), 'utf8');
  const queuePanel = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageQueuePanel.tsx'), 'utf8');

  assert.ok(codexService.includes("connection.request('turn/steer'"));
  assert.ok(codexService.includes('preparedNativeThread?.persistThread\n      ? this.spawnCodexAppServer'));
  assert.ok(claudeService.includes('codexService.canSteer(sessionId)'));
  assert.ok(claudeService.includes('return codexService.steer(sessionId, message, attachments);'));
  assert.ok(codexService.includes("const args = ['app-server'];"));
  assert.ok(!codexService.includes("const args = ['app-server', '--stdio'];"));
  assert.ok(messageList.includes('Will steer current response'));
  assert.ok(queuePanel.includes("queueWillSteer ? 'Steering' : 'Queue'"));
  assert.ok(!queuePanel.includes('queue.length === 0 || (isProcessingQueue && isStreaming)'));
  assert.ok(codexService.includes("if (event.type === 'error') {\n          pendingAppServerError"));
  assert.ok(codexService.includes('terminalFailure: true'));
  assert.ok(codexService.includes('getCodexAppServerMessageTurnId(message)'));
  assert.ok(codexService.includes("Ignoring non-root ${message.method || 'notification'}"));
  assert.ok(codexService.includes('notificationTurnId !== activeState.turnId'));
  assert.ok(!codexService.includes('activeState.turnId = notificationTurnId'));
  assert.ok(codexService.includes("case 'item/agentMessage/delta':"));
  assert.ok(codexService.includes("event.item.phase === 'final_answer' ? 'text_delta' : 'thinking_delta'"));
  assert.ok(codexService.includes('streamedAgentMessageIds.has(event.item.id)'));
  assert.ok(codexService.includes("content: nativeThread?.resumeThreadId ? 'Resuming Codex thread…\\n' : 'Starting Codex thread…\\n'"));
  assert.ok(codexService.includes('/app-server (?:output|connection) closed|app-server is not writable/i'));
  assert.ok(codexService.includes('CODEX_DEVELOPER_INSTRUCTIONS_VERSION = 2'));
  assert.ok(codexService.includes('Retired pre-v${this.CODEX_DEVELOPER_INSTRUCTIONS_VERSION} native thread'));
  assert.ok(claudeIpc.includes('completedSession?.sshConfig && !terminalProviderFailure'));
  assert.ok(claudeIpc.includes("'terminal provider failure'"));
}

function verifyRemoteCodexEnvironmentIsolation(): void {
  const filtered = filterRemoteCodexEnvironment({
    HOME: '/Users/local-user',
    USER: 'local-user',
    LOGNAME: 'local-user',
    PATH: '/opt/homebrew/bin:/usr/bin',
    TMPDIR: '/var/folders/local',
    PWD: '/Users/local-user/project',
    SSH_AUTH_SOCK: '/private/tmp/local-agent.sock',
    CODEX_HOME: '/Users/local-user/.codex',
    CODEX_MANAGED_PACKAGE_ROOT: '/opt/homebrew/lib/node_modules/@openai/codex',
    CODEX_THREAD_ID: 'local-thread',
    CODEX_API_KEY: 'codex-key',
    OPENAI_API_KEY: 'openai-key',
    ZAI_API_KEY: 'zai-key',
    CODEX_SDK_ORIGINATOR: 'grep-build',
    BUILD_META_EFFORT: 'xhigh',
  });

  assert.deepStrictEqual(filtered, {
    CODEX_API_KEY: 'codex-key',
    OPENAI_API_KEY: 'openai-key',
    ZAI_API_KEY: 'zai-key',
    CODEX_SDK_ORIGINATOR: 'grep-build',
    BUILD_META_EFFORT: 'xhigh',
  });
}

async function main(): Promise<void> {
  await verifyProtocolAcknowledgement();
  verifyDelegatedTurnCorrelation();
  await verifyCodexQueueDrainsDuringStreaming();
  verifyWiringAndCopy();
  verifyRemoteCodexEnvironmentIsolation();
  console.log('Codex steering verification passed.');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
