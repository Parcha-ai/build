import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const installedVerifier = fs.readFileSync(path.join(root, 'scripts/verify-installed-build-fixes.js'), 'utf8');

assert.match(
  inputArea,
  /const isProcessingQueueState = useSessionStore/,
  'input area must subscribe to per-session queue-processing state',
);
assert.match(
  inputArea,
  /const isSending = isStreamingState \|\| isProcessingQueueState \|\| \(isStreamingProp \?\? false\);/,
  'input area busy state must include queue processing, not only streaming',
);

assert.match(
  sessionStore,
  /function hasUnfinishedToolCalls\(toolCalls: ToolCall\[\] \| undefined\): boolean/,
  'session store must detect pending/running tool calls',
);
assert.match(
  sessionStore,
  /function settleUnfinishedToolCalls\(toolCalls: ToolCall\[\] \| undefined\)/,
  'session store must settle dangling running tool cards when the runtime is inactive',
);
assert.match(
  sessionStore,
  /Deferring STREAM_END for \$\{sessionId\};/,
  'stream end must defer when visible tool calls are still running and runtime is active',
);
assert.match(
  sessionStore,
  /Deferring STREAM_ERROR cleanup for \$\{sessionId\};/,
  'stream error cleanup must defer when visible tool calls are still running and runtime is active',
);
assert.match(
  sessionStore,
  /startRemoteProcessMonitor\(sessionId, get, set, loadMessages, \{ recoverableKnown: true \}\)/,
  'recoverable remote work must immediately reattach the renderer stream state',
);
assert.match(
  sessionStore,
  /const keepActiveForRunningTools = hasUnfinishedToolCalls\(latestState\.currentToolCalls\[sessionId\]\);/,
  'SSH remote monitor must not mark the UI idle while visible tool calls are still running',
);
assert.match(
  installedVerifier,
  /Deferring STREAM_END for/,
  'installed app verifier must assert running-tool stream-state marker',
);

console.log('streaming running tool state verifier passed');
