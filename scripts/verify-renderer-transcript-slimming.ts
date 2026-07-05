import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const messageBubble = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageBubble.tsx'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.ts'), 'utf8');

assert.match(
  claudeIpc,
  /const RENDERER_FULL_DETAIL_TAIL_MESSAGES = 12;/,
  'renderer hydration must keep only a small full-detail tail',
);
assert.match(
  claudeIpc,
  /function slimHistoricalMessageForRenderer\(message: ChatMessage\): ChatMessage \{/,
  'main process must slim historical transcript rows before IPC cloning',
);
assert.match(
  claudeIpc,
  /toolCalls: undefined,[\s\S]*?contentBlocks: undefined,[\s\S]*?historicalToolCallCount: toolCount/,
  'historical message slimming must drop heavy tool arrays while preserving a count',
);
assert.match(
  claudeIpc,
  /function slimMessagesForRenderer\(messages: ChatMessage\[\], limit\?: number\): ChatMessage\[\] \{/,
  'main process must expose a bounded renderer payload helper',
);
assert.match(
  claudeIpc,
  /if \(!limit \|\| limit <= 0 \|\| messages\.length <= RENDERER_FULL_DETAIL_TAIL_MESSAGES\)[\s\S]*?return messages;/,
  'full transcript reads must remain unslimmed for export/history paths',
);
assert.match(
  claudeIpc,
  /return slimMessagesForRenderer\(mergeCompletedStreamMessages\(canonicalMessages, sessionId, limit\), limit\);/,
  'CLAUDE_GET_MESSAGES must apply slimming after recovery merge and before IPC return',
);

assert.match(
  messageBubble,
  /message\.metadata\?\.historicalToolCallCount/,
  'renderer collapsed summaries must read historical tool counts from slimmed metadata',
);
assert.match(
  messageBubble,
  /const RECENT_TOOL_CARD_LIMIT = 80;/,
  'renderer must cap non-historical tool card rendering',
);
assert.match(
  messageBubble,
  /HistoricalAssistantSummary/,
  'renderer must collapse old assistant messages instead of rendering full markdown and tools',
);

assert.match(
  chatContainer,
  /const recentMessages = sessionMessages\.slice\(-40\);/,
  'task extraction must not scan the entire transcript on every render',
);
assert.doesNotMatch(
  chatContainer,
  /\[TasksBlock\] Found task tool calls in messages/,
  'task extraction must not console-log large historical tool payloads',
);

assert.match(
  forgeConfig,
  /GREP_SKIP_INSTALL === '1'[\s\S]*?Skipping \/Applications install because GREP_SKIP_INSTALL=1/,
  'packaging must support skipping /Applications install for local verification',
);

console.log('renderer transcript slimming verifier passed');
