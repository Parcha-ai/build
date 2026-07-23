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
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const bridge = window.__GREP_TEST__;
    if (!bridge?.useSessionStore) throw new Error('Missing renderer test bridge');
    const store = bridge.useSessionStore;
    let sessionId = store.getState().activeSessionId;
    if (!sessionId) {
      await store.getState().loadSessions();
      sessionId = store.getState().sessions[0]?.id;
      if (!sessionId) throw new Error('No development session available for card rendering');
      await store.getState().setActiveSession(sessionId);
    }

    const originalMessages = store.getState().messages[sessionId] || [];
    const testId = 'codex-edit-card-' + Date.now();
    const testMessage = {
      id: testId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      harness: 'codex',
      toolCalls: [
        {
          id: testId + '-edit',
          name: 'Edit',
          input: {
            file_path: 'src/example.ts',
            unified_diff: '@@ -1 +1 @@\\n-const oldValue = 1;\\n+const newValue = 2;',
            changes: [{
              kind: 'update',
              path: 'src/example.ts',
              diff: '@@ -1 +1 @@\\n-const oldValue = 1;\\n+const newValue = 2;',
            }],
          },
          status: 'completed',
        },
        {
          id: testId + '-command',
          name: 'Command',
          input: { command: 'npm test' },
          status: 'completed',
          result: 'ok',
        },
      ],
    };

    try {
      store.setState((state) => ({
        messages: { ...state.messages, [sessionId]: [...originalMessages, testMessage] },
        isStreaming: { ...state.isStreaming, [sessionId]: false },
      }));
      await sleep(1200);

      const cards = [...document.querySelectorAll('div.font-mono.text-sm')];
      const editCard = cards.find((card) => card.textContent?.includes('src/example.ts'));
      const commandCard = cards.find((card) => card.textContent?.includes('npm test'));
      if (!editCard) throw new Error('Rendered Codex Edit card was not found');
      if (!commandCard) throw new Error('Rendered Codex Command card was not found');

      const editText = editCard.textContent || '';
      const commandText = commandCard.textContent || '';
      if (!editText.includes('PATCH')) throw new Error('Codex unified diff was not rendered');
      if (editText.includes('Preparing edit')) throw new Error('Completed Edit card is stuck preparing');
      if (editCard.querySelector('.animate-spin')) throw new Error('Completed Edit card still has a spinner');
      if (!commandText.includes('Command') || commandText.includes('Bash')) {
        throw new Error('Codex command execution has the wrong UI label');
      }

      return {
        sessionId,
        editSummary: editText.slice(0, 180),
        commandSummary: commandText.slice(0, 120),
      };
    } finally {
      store.setState((state) => ({
        messages: { ...state.messages, [sessionId]: originalMessages },
      }));
    }
  }`;

  const response = await send('Runtime.evaluate', {
    expression: `(${expression})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  socket.close();

  const exception = response.exceptionDetails;
  if (exception) throw new Error(exception.exception?.description || exception.text || 'Renderer evaluation failed');
  const value = response.result?.value;
  if (!value) throw new Error('Renderer verification returned no result');
  console.log(JSON.stringify(value, null, 2));
  console.log('Development Codex Edit/Command card verifier passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
