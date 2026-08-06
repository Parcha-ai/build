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

const normalSendStart = sendMessageMethod.indexOf('// Echo the submitted message before any backend or SSH probe.');
const optimisticComment = normalSendStart;
const addUserMessageIndex = sendMessageMethod.indexOf('state.addMessage(sessionId, userMessage);');
const firstBackendProbeIndex = sendMessageMethod.indexOf('window.electronAPI.claude.hasActiveQuery(sessionId)');
const firstRemoteProbeIndex = sendMessageMethod.indexOf('window.electronAPI.ssh.hasActiveRemoteProcess(sessionId)');
const postVisibleRemoteProbeIndex = sendMessageMethod.indexOf('window.electronAPI.ssh.hasActiveRemoteProcess(sessionId)', addUserMessageIndex);
const setStreamingIndex = sendMessageMethod.indexOf('setStreaming(sessionId, true);');
const awaitRemoteProbeIndex = sendMessageMethod.indexOf('await remoteActiveProcessPromise');
const secureScanIndex = sendMessageMethod.indexOf('window.electronAPI.secureKeys.interceptAndReplace');
const sanitizedUpdateIndex = sendMessageMethod.indexOf('if (modifiedText !== message) {');
const supplementalPersistIndex = sendMessageMethod.indexOf('persistSupplementalMessage(sessionId, outboundUserMessage)');
const ipcSendIndex = sendMessageMethod.indexOf('window.electronAPI.claude.sendMessage(');

assert.ok(normalSendStart >= 0, 'must locate normal send branch');
assert.ok(optimisticComment >= normalSendStart, 'normal send branch must document immediate feedback behavior');
assert.ok(addUserMessageIndex > normalSendStart, 'normal send branch must add a user message');
assert.ok(firstBackendProbeIndex > addUserMessageIndex, 'backend-active probing must happen after the user message is visible');
assert.ok(firstRemoteProbeIndex > addUserMessageIndex, 'remote-active probing must happen after the user message is visible');
assert.ok(postVisibleRemoteProbeIndex > addUserMessageIndex, 'remote-active queue fallback must run only after the user message is visible');
assert.ok(addUserMessageIndex < secureScanIndex, 'user message must be shown before secure-key scanning');
assert.ok(setStreamingIndex > addUserMessageIndex, 'streaming state must start after the user message is visible');
assert.ok(awaitRemoteProbeIndex > setStreamingIndex, 'remote ownership must be awaited only after streaming state is visible');
assert.equal(
  (sendMessageMethod.match(/window\.electronAPI\.ssh\.hasActiveRemoteProcess\(sessionId\)/g) || []).length,
  1,
  'normal send must perform exactly one remote ownership probe',
);
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
