#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2] || 9355);
const repoPath = process.argv[3];
if (!repoPath) throw new Error('Repository path argument is required.');

function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function connect() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
      if (target?.webSocketDebuggerUrl) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', reject, { once: true });
        });
        let nextId = 0;
        const pending = new Map();
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          const handler = pending.get(message.id);
          if (!handler) return;
          pending.delete(message.id);
          message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
        return { socket, send };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Build renderer unavailable on ${port}`);
}

async function main() {
  const { socket, send } = await connect();
  try {
    const response = await send('Runtime.evaluate', {
      expression: `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const store = window.__GREP_TEST__?.useSessionStore;
        if (!store) throw new Error('Missing Build test bridge.');
        const session = await window.electronAPI.dev.createSession({
          name: 'prime-agent-live-smoke',
          repoPath: ${JSON.stringify(repoPath)},
          branch: 'main',
          createWorktree: false,
        });
        await store.getState().loadSessions();
        await window.electronAPI.sessions.start(session.id);
        await store.getState().setActiveSession(session.id);
        store.getState().setSelectedModel(session.id, 'prime:default', 'api');
        store.getState().setPermissionMode(session.id, 'bypassPermissions');
        await store.getState().sendMessage(session.id, 'PRIME_LIVE_SMOKE_PROMPT', []);
        const deadline = Date.now() + 30_000;
        while (store.getState().isStreaming[session.id] && Date.now() < deadline) await sleep(50);
        const messages = store.getState().messages[session.id] || [];
        const assistant = messages.filter((message) => message.role === 'assistant').at(-1);
        return {
          sessionId: session.id,
          content: assistant?.content || '',
          harness: assistant?.harness || '',
          toolCalls: (assistant?.toolCalls || []).map((tool) => ({ name: tool.name, status: tool.status, result: tool.result })),
          streaming: Boolean(store.getState().isStreaming[session.id]),
          selectedModel: store.getState().selectedModel[session.id],
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    const result = response.result.value;
    console.log(JSON.stringify(result, null, 2));
    if (result.content !== 'Prime Agent live smoke passed.' || result.harness !== 'prime' || result.streaming || result.selectedModel !== 'prime:default') {
      throw new Error(`Prime Agent result mismatch: ${JSON.stringify(result)}`);
    }
    const tool = result.toolCalls.find((candidate) => candidate.name === 'Read' || candidate.name === 'read_file');
    if (!tool || tool.status !== 'completed' || tool.result !== 'fixture-ok') {
      throw new Error(`Prime Agent tool event mismatch: ${JSON.stringify(result.toolCalls)}`);
    }
    console.log('Prime Agent packaged-app live smoke passed');
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
