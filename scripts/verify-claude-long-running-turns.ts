import assert from 'assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudePersistentInput } from '../src/main/services/claude-persistent-input';

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');

const userMessage = (content: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  session_id: '',
}) as SDKUserMessage;

async function verifyPersistentInputLifecycle(): Promise<void> {
  const input = new ClaudePersistentInput(userMessage('initial'));
  const iterator = input[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false, 'persistent input must yield its initial user message');
  assert.equal((first.value.message.content as string), 'initial');

  const pendingRead = iterator.next();
  const prematureEnd = await Promise.race([
    pendingRead.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(
    prematureEnd,
    false,
    'persistent input must remain open after the initial prompt instead of ending SDK stdin',
  );

  assert.equal(input.enqueue(userMessage('continue')), true, 'an active turn must accept steering');
  const followUp = await pendingRead;
  assert.equal(followUp.done, false);
  assert.equal((followUp.value.message.content as string), 'continue');

  input.close();
  assert.equal(input.enqueue(userMessage('too late')), false, 'a finalized turn must reject late input');
  const done = await iterator.next();
  assert.equal(done.done, true, 'explicit finalization must close SDK stdin');
}

async function verifyAgentSdkKeepsProcessAliveAcrossResults(): Promise<void> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let exitCode: number | null = null;
  let inputBuffer = '';
  let userMessageCount = 0;

  const writeSdkMessage = (message: Record<string, unknown>): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  stdin.on('data', (chunk: Buffer) => {
    inputBuffer += chunk.toString('utf8');
    let newline = inputBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = inputBuffer.slice(0, newline);
      inputBuffer = inputBuffer.slice(newline + 1);
      newline = inputBuffer.indexOf('\n');
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { type?: string };
      if (message.type !== 'user') continue;

      userMessageCount += 1;
      if (userMessageCount === 1) {
        writeSdkMessage({
          type: 'system',
          subtype: 'init',
          session_id: '00000000-0000-4000-8000-000000000001',
          tools: [],
          mcp_servers: [],
          model: 'fake-long-running-model',
        });
        writeSdkMessage({
          type: 'system',
          subtype: 'task_started',
          task_id: 'long-task-1',
          task_type: 'local_bash',
          description: 'long-running verification',
          session_id: '00000000-0000-4000-8000-000000000001',
        });
      }
      writeSdkMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: userMessageCount === 1 ? 'interim' : 'final',
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        session_id: '00000000-0000-4000-8000-000000000001',
      });
    }
  });

  stdin.on('end', () => {
    exitCode = 0;
    stdout.end();
    events.emit('exit', 0, null);
  });

  const fakeProcess = {
    stdin,
    stdout,
    get killed() { return false; },
    get exitCode() { return exitCode; },
    kill() { return true; },
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
  } as SpawnedProcess;

  const persistentInput = new ClaudePersistentInput(userMessage('start long work'));
  const sdkQuery = query({
    prompt: persistentInput,
    options: {
      spawnClaudeCodeProcess: () => fakeProcess,
    },
  });
  const iterator = sdkQuery[Symbol.asyncIterator]();
  const nextResult = async (): Promise<SDKMessage & { result?: string }> => {
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, 'fake SDK process must not end before its result');
      if (next.value && next.value.type === 'result') {
        return next.value as SDKMessage & { result?: string };
      }
    }
  };

  const interim = await nextResult();
  assert.equal(interim.result, 'interim');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    stdin.writableEnded,
    false,
    'the real Agent SDK must keep CLI stdin open after an interim result',
  );

  assert.equal(persistentInput.enqueue(userMessage('synthesize final results')), true);
  const final = await nextResult();
  assert.equal(final.result, 'final');
  assert.equal(userMessageCount, 2, 'the same SDK process must receive the continuation');
  assert.equal(stdin.writableEnded, false, 'even a result must wait for Build to decide it is final');

  persistentInput.close();
  await Promise.race([
    new Promise<void>((resolve) => stdin.once('end', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SDK did not close stdin')), 500)),
  ]);
  assert.equal(stdin.writableEnded, true, 'explicit finalization must make the Agent SDK close CLI stdin');
}

assert.match(
  service,
  /const persistentPromptInput = new ClaudePersistentInput\(initialSdkInput\);[\s\S]{0,300}prompt: persistentPromptInput,/,
  'every new Claude SDK turn must use the persistent input stream',
);
assert.match(
  service,
  /this\.persistentQueryInputs\.set\(sessionId, persistentPromptInput\)/,
  'the active turn must retain its original persistent input for steering',
);
assert.match(
  service,
  /if \(persistentInput\) \{[\s\S]*persistentInput\.enqueue\(/,
  'follow-ups must enqueue on the original input instead of opening a finite stream',
);
assert.match(
  service,
  /Final synthesis is the only point where the persistent SDK[\s\S]*persistentQueryInputs\.get\(sessionId\)\?\.close\(\)/,
  'SDK stdin must close only after final synthesis',
);
assert.match(
  service,
  /subtype === 'background_tasks_changed'[\s\S]*authoritative snapshot/,
  'background task snapshots must authoritatively hold the parent turn open',
);
assert.match(
  service,
  /Recovered interim result[\s\S]*background task\(s\) still running/,
  'reattach must not treat an interim result as a finished remote turn',
);
assert.match(
  service,
  /maybeContinueRecoveredBackgroundWork[\s\S]*queued final synthesis on the original SSH stdin/,
  'reattach must synthesize task results on the original detached process',
);
assert.match(
  service,
  /Only a result observed with no live background work is terminal/,
  'remote replay must have an explicit task-aware terminal condition',
);

void Promise.all([
  verifyPersistentInputLifecycle(),
  verifyAgentSdkKeepsProcessAliveAcrossResults(),
])
  .then(() => console.log('Claude long-running turn verifier passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
