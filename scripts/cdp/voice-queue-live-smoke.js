#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2] || 9333);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
  if (!target?.webSocketDebuggerUrl) throw new Error(`Build renderer is unavailable on CDP port ${port}`);

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
    handler(message);
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message || method));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const expression = `async () => {
    const bridge = window.__GREP_TEST__;
    if (!bridge?.useSessionStore) throw new Error('Missing renderer test bridge');
    const store = bridge.useSessionStore;
    const original = store.getState();
    const sessionId = 'voice-queue-smoke-' + Date.now();
    const firstId = sessionId + '-first';
    const secondId = sessionId + '-second';
    const now = new Date();
    const fakeSession = {
      id: sessionId,
      name: 'Voice queue smoke',
      repoPath: '/tmp/voice-queue-smoke',
      worktreePath: '/tmp/voice-queue-smoke',
      branch: 'smoke',
      status: 'running',
      ports: { web: 0, api: 0, debug: 0 },
      createdAt: now,
      updatedAt: now,
      setupScript: '',
    };

    store.setState((state) => ({
      sessions: [...state.sessions, fakeSession],
      messages: { ...state.messages, [sessionId]: [] },
      messageQueue: { ...state.messageQueue, [sessionId]: [] },
      isStreaming: { ...state.isStreaming, [sessionId]: true },
      isProcessingQueue: { ...state.isProcessingQueue, [sessionId]: false },
      selectedModel: { ...state.selectedModel, [sessionId]: 'claude-sonnet-5' },
    }));

    try {
      // Freeze main-process draining so the smoke exercises admission only and
      // never launches a real harness turn for the ephemeral test session.
      await window.electronAPI.queue.beginFastStack(sessionId);
      const startedAt = performance.now();
      await Promise.all([
        store.getState().sendMessage(sessionId, 'Repeat this exact voice follow-up', undefined, {
          existingMessageId: firstId,
          forceQueue: true,
          returnAfterAdmission: true,
        }),
        store.getState().sendMessage(sessionId, 'Repeat this exact voice follow-up', undefined, {
          existingMessageId: secondId,
          forceQueue: true,
          returnAfterAdmission: true,
        }),
      ]);
      const elapsedMs = performance.now() - startedAt;
      const state = store.getState();
      const queue = state.messageQueue[sessionId] || [];
      const visible = state.messages[sessionId] || [];
      const queuedIds = queue.map((item) => item.id);
      const visibleIds = visible.map((item) => item.id);
      const mainQueueState = await window.electronAPI.queue.getState(sessionId);
      const mainQueuedIds = (mainQueueState.messages || []).map((item) => item.id);
      if (elapsedMs > 1_000) throw new Error('Voice queue admission blocked for ' + Math.round(elapsedMs) + 'ms');
      if (queue.length !== 2) throw new Error('Expected two queued voice requests, got ' + queue.length);
      if (!queuedIds.includes(firstId) || !queuedIds.includes(secondId)) {
        throw new Error('Voice queue did not preserve both request IDs: ' + queuedIds.join(', '));
      }
      if (!visibleIds.includes(firstId) || !visibleIds.includes(secondId)) {
        throw new Error('Voice queue did not render both accepted requests: ' + visibleIds.join(', '));
      }
      if (!mainQueuedIds.includes(firstId) || !mainQueuedIds.includes(secondId)) {
        throw new Error('Main queue collapsed distinct request IDs: ' + mainQueuedIds.join(', '));
      }
      return { elapsedMs: Math.round(elapsedMs), queuedIds, visibleIds, mainQueuedIds };
    } finally {
      await window.electronAPI.queue.clear(sessionId).catch(() => undefined);
      store.setState((state) => ({
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        messages: Object.fromEntries(Object.entries(state.messages).filter(([id]) => id !== sessionId)),
        messageQueue: Object.fromEntries(Object.entries(state.messageQueue).filter(([id]) => id !== sessionId)),
        isStreaming: Object.fromEntries(Object.entries(state.isStreaming).filter(([id]) => id !== sessionId)),
        isProcessingQueue: Object.fromEntries(Object.entries(state.isProcessingQueue).filter(([id]) => id !== sessionId)),
        selectedModel: Object.fromEntries(Object.entries(state.selectedModel).filter(([id]) => id !== sessionId)),
      }));
    }
  }`;

  const result = await send('Runtime.evaluate', {
    expression: `(${expression})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  socket.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer smoke failed');
  }
  console.log('Voice queue live smoke passed:', JSON.stringify(result.result.value));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
