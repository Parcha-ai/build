#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2] || 9333);
const sessionId = process.argv[3];
if (!sessionId) throw new Error('Usage: codex-remote-turn-live-smoke.js [port] <session-id>');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function createSender(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    callback(message);
  };
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(send, expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
}

async function waitFor(label, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
  if (!target) throw new Error(`No Build renderer found on ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = createSender(ws);
  await send('Runtime.enable');

  const id = JSON.stringify(sessionId);
  const state = 'window.__GREP_TEST__.useSessionStore.getState()';
  const marker = `the violet badger checked ${String(Date.now()).slice(-5)}`;
  const prompt = `Run pwd, then briefly report the working directory and end with exactly ${marker}`;
  await evaluate(send, `${state}.loadSessions().then(() => ${state}.setActiveSession(${id})).then(() => ${state}.loadMessages(${id})).then(() => true)`);
  const before = await evaluate(send, `(() => { const s = ${state}.sessions.find((item) => item.id === ${id}); return { name: s?.name, cwd: s?.worktreePath, remoteWorkdir: s?.sshConfig?.remoteWorkdir }; })()`);
  const baseline = await evaluate(send, `(${state}.messages[${id}] || []).length`);
  await evaluate(send, `window.electronAPI.secureKeys.clearSession(${id}).then(() => true)`);
  const startedAt = Date.now();

  await evaluate(send, `(() => { const s = ${state}; s.setPermissionMode(${id}, 'bypassPermissions'); s.setSelectedModel(${id}, 'codex:gpt-5.6-luna', 'api'); void s.sendMessage(${id}, ${JSON.stringify(prompt)}, []); return true; })()`);

  const userVisibleAt = await waitFor('user message', async () => {
    const visible = await evaluate(send, `(${state}.messages[${id}] || []).slice(${baseline}).some((message) => message.role === 'user' && message.content.includes(${JSON.stringify(marker)}))`);
    return visible ? Date.now() : 0;
  }, 10000);
  const firstProgress = await waitFor('visible startup/progress', async () => {
    const thinking = await evaluate(send, `${state}.currentThinkingContent[${id}] || ''`);
    return thinking ? { at: Date.now(), text: thinking } : null;
  }, 30000);
  const repaired = await waitFor('working-directory repair', async () => {
    const value = await evaluate(send, `(() => { const s = ${state}.sessions.find((item) => item.id === ${id}); return { cwd: s?.worktreePath, remoteWorkdir: s?.sshConfig?.remoteWorkdir }; })()`);
    return value.cwd && !/^(?:Worktree|CWD)\s*:/i.test(value.cwd) ? value : null;
  }, 30000);
  await waitFor('turn completion', () => evaluate(send, `!${state}.isStreaming[${id}]`), 180000);

  const after = await evaluate(send, `(() => { const messages = (${state}.messages[${id}] || []).slice(${baseline}); return { messages: messages.map((message) => ({ role: message.role, content: message.content })), thinking: ${state}.currentThinkingContent[${id}] || '' }; })()`);
  ws.close();

  const assistant = after.messages.filter((message) => message.role === 'assistant').at(-1)?.content || '';
  console.log(JSON.stringify({
    before,
    repaired,
    userVisibleMs: userVisibleAt - startedAt,
    firstProgressMs: firstProgress.at - startedAt,
    firstProgressText: firstProgress.text.slice(0, 240),
    totalMs: Date.now() - startedAt,
    assistant,
    markerPresent: assistant.includes(marker),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
