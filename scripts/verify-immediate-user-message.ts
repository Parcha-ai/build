import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

const sendMessageStart = sessionStore.indexOf('sendMessage: async (sessionId, message, attachments, opts) => {');
const loadMessagesStart = sessionStore.indexOf('\n  loadMessages:', sendMessageStart);
const sendMessageMethod = sendMessageStart >= 0 && loadMessagesStart > sendMessageStart
  ? sessionStore.slice(sendMessageStart, loadMessagesStart)
  : '';

assert.ok(sendMessageMethod, 'must find renderer sendMessage implementation');
assert.doesNotMatch(
  sendMessageMethod,
  /hasActiveRemoteProcess|hasActiveQuery/,
  'renderer sendMessage must not block on backend or remote active-process probes',
);

const normalSendStart = sendMessageMethod.indexOf('const { addMessage, setStreaming, permissionMode, thinkingMode, selectedModel, gstackMode } = state;');
const optimisticComment = sendMessageMethod.indexOf('pressing\n    // Enter always produces immediate visible feedback');
const addUserMessageIndex = sendMessageMethod.indexOf('addMessage(sessionId, userMessage);');
const setStreamingIndex = sendMessageMethod.indexOf('setStreaming(sessionId, true);');
const secureScanIndex = sendMessageMethod.indexOf('window.electronAPI.secureKeys.interceptAndReplace');
const sanitizedUpdateIndex = sendMessageMethod.indexOf('if (modifiedText !== message) {');
const supplementalPersistIndex = sendMessageMethod.indexOf('persistSupplementalMessage(sessionId, outboundUserMessage)');
const ipcSendIndex = sendMessageMethod.indexOf('window.electronAPI.claude.sendMessage(');

assert.ok(normalSendStart >= 0, 'must locate normal send branch');
assert.ok(optimisticComment > normalSendStart, 'normal send branch must document immediate feedback behavior');
assert.ok(addUserMessageIndex > normalSendStart, 'normal send branch must add a user message');
assert.ok(addUserMessageIndex < secureScanIndex, 'user message must be shown before secure-key scanning');
assert.ok(setStreamingIndex > addUserMessageIndex, 'streaming state must start after the user message is visible');
assert.ok(setStreamingIndex < secureScanIndex, 'streaming state must start before secure-key scanning');
assert.ok(sanitizedUpdateIndex > secureScanIndex, 'sanitized text must update the optimistic bubble after scanning');
assert.ok(supplementalPersistIndex > sanitizedUpdateIndex, 'supplemental persistence must use the sanitized outbound user message');
assert.ok(ipcSendIndex > supplementalPersistIndex, 'Claude IPC send must run after sanitized message preparation');
assert.match(
  sendMessageMethod,
  /catch \(error\) \{\s*console\.warn\('\[SessionStore\] Secure-key scan failed; sending original text:', error\);/,
  'secure-key scanning must not strand the optimistic send state on failure',
);

console.log('immediate user message verifier passed');
