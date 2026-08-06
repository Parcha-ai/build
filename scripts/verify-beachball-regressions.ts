import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionMessageCacheStore } from '../src/main/session-message-cache-store';

const root = path.resolve(__dirname, '..');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const messageList = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageList.tsx'), 'utf8');
const messageBubble = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageBubble.tsx'), 'utf8');
const lazyMonacoEditor = fs.readFileSync(path.join(root, 'src/renderer/components/chat/LazyMonacoEditor.tsx'), 'utf8');
const globalStyles = fs.readFileSync(path.join(root, 'src/renderer/styles/globals.css'), 'utf8');
const cachedStore = fs.readFileSync(path.join(root, 'src/main/cached-store.ts'), 'utf8');
const analyticsService = fs.readFileSync(path.join(root, 'src/main/services/analytics.service.ts'), 'utf8');
const transcriptService = fs.readFileSync(path.join(root, 'src/main/services/transcript.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');

const pollMethods = [...sshService.matchAll(/const pollForExit = async \(\): Promise<void> => \{([\s\S]*?)\n {4}\};/g)];
assert.equal(pollMethods.length, 2, 'both detached SSH exit pollers must be guarded');
for (const [, method] of pollMethods) {
  assert.match(method, /exitPollInFlight/);
  assert.match(method, /exitPollInFlight = true/);
  assert.match(method, /finally \{\s*exitPollInFlight = false/);
  assert.match(method, /now - lastExitPollWarningAt >= 30_000/);
}

assert.match(claudeService, /new SessionMessageCacheStore<ChatMessage\[]>\(app\.getPath\('userData'\)\)/);
assert.doesNotMatch(claudeService, /new CachedStore\(\{ name: 'claudette-message-cache' \}\)/);
assert.match(mainIndex, /SessionMessageCacheStore\.flushAll\(\)/);
assert.match(chatContainer, /toolCallCount >= 24/);
assert.match(chatContainer, /sessionMessages\.length >= 80/);
assert.match(chatContainer, /reduceContinuousMotion \? 'reduce-continuous-motion'/);
assert.match(globalStyles, /\.reduce-continuous-motion \.animate-spin/);
assert.match(globalStyles, /\.reduce-continuous-motion \[style\*='infinite'\]:not\(\.live-thinking-indicator\)/);
assert.match(globalStyles, /\.live-thinking-cluster \{[\s\S]*?contain: layout paint;[\s\S]*?isolation: isolate;/);
assert.match(globalStyles, /\.live-thinking-indicator \{[\s\S]*?will-change: opacity;/);
assert.match(messageList, /live-thinking-cluster[^"']*flex gap-0\.5/);
assert.match(messageList, /live-thinking-indicator[^"']*w-2 h-2/);
assert.match(messageList, /key=\{`\$\{message\.id\}:\$\{isLatestMessage \? 'latest' : 'history'\}`\}/);
assert.match(messageBubble, /const DENSE_TOOL_CALL_THRESHOLD = 24/);
assert.match(messageBubble, /collapseToolCardsByDefault = isOldMessage[\s\S]*?toolCalls\.length >= DENSE_TOOL_CALL_THRESHOLD/);
assert.match(messageBubble, /defaultCollapsed=\{collapseToolCardsByDefault\}/);
assert.match(messageBubble, /const shouldOfferReader = assistantTextContent\.length >= READER_PANEL_CHAR_THRESHOLD[\s\S]*?Boolean\(sessionId\)/);
assert.doesNotMatch(
  messageBubble,
  /!historicalCollapsed && assistantTextContent\.length >= READER_PANEL_CHAR_THRESHOLD/,
  'historical collapsing must not hide the Markdown Reader action for a large response',
);
assert.match(cachedStore, /get\(key\?: string, defaultValue\?: unknown\)/);
assert.match(analyticsService, /this\.store = new CachedStore\(\{ name: 'claudette-analytics' \}\)/);
assert.match(transcriptService, /writeInProgressMessage\(sessionId: string, entry: TranscriptEntry\)/);
assert.match(transcriptService, /promoteInProgressMessage\(sessionId: string\)/);
assert.match(claudeIpc, /transcriptService\.writeInProgressMessage\(sessionId, snapshotEntry\)/);
assert.doesNotMatch(claudeIpc, /const signature = JSON\.stringify\(latestSnapshot\)/);
assert.match(chatContainer, /streaming \? \(reduceContinuousMotion \? 120 : 50\) : 100/);
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
assert.match(inputArea, /export default React\.memo\(InputArea\);/);
assert.doesNotMatch(
  lazyMonacoEditor,
  /Never been visible - loading state[\s\S]*?animate-spin/,
  'offscreen editor placeholders must never run perpetual loading animations',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-message-cache-'));
let legacyReads = 0;
const legacyFactory = () => ({
  get(key: string): unknown {
    legacyReads += 1;
    return key === 'legacy-session' ? [{ id: 'legacy-message' }] : undefined;
  },
});

try {
  const store = new SessionMessageCacheStore<unknown[]>(tempDir, legacyFactory);
  store.set('session-a', [{ id: 'a' }]);
  store.set('session-b', [{ id: 'b' }]);
  SessionMessageCacheStore.flushAll();

  const shardDir = path.join(tempDir, 'claudette-message-cache');
  assert.equal(fs.readdirSync(shardDir).filter(name => name.endsWith('.json')).length, 2);

  const reloaded = new SessionMessageCacheStore<unknown[]>(tempDir, legacyFactory);
  assert.deepEqual(reloaded.get('session-a'), [{ id: 'a' }]);
  assert.equal(legacyReads, 0, 'new cache shards must not open the large legacy store');

  assert.deepEqual(reloaded.get('legacy-session'), [{ id: 'legacy-message' }]);
  assert.equal(legacyReads, 1);
  SessionMessageCacheStore.flushAll();

  const migrated = new SessionMessageCacheStore<unknown[]>(tempDir, () => {
    throw new Error('legacy cache should not be needed after migration');
  });
  assert.deepEqual(migrated.get('legacy-session'), [{ id: 'legacy-message' }]);

  console.log('beachball regression verifier passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
