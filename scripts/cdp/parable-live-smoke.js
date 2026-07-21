#!/usr/bin/env node

const http = require('http');

function parseArgs(argv) {
  const args = {
    branch: 'main',
    port: 9223,
    repoPath: '',
    timeoutMs: 300000,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--branch=')) args.branch = arg.slice('--branch='.length);
    else if (arg === '--branch') args.branch = argv[++index];
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg.startsWith('--repo-path=')) args.repoPath = arg.slice('--repo-path='.length);
    else if (arg === '--repo-path') args.repoPath = argv[++index];
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
  }

  if (!args.repoPath) throw new Error('--repo-path is required');
  return args;
}

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

function createCdpSender(ws, timeoutMs) {
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };

  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connectToRenderer(port, timeoutMs) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
  if (!target) throw new Error(`No Build renderer found on port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const send = createCdpSender(ws, timeoutMs);
  await send('Runtime.enable');
  return { send, ws };
}

function buildExpression(args) {
  const config = {
    brainModel: 'claude-opus-4-8',
    defaultExecutor: 'codex-math',
    defaultReviewer: 'sonnet-review',
    maxParallel: 2,
    repoNotes: 'Only edit math.js and format.js. Never edit test.js or package.json. Do not commit.',
    executors: [
      {
        id: 'codex-math',
        model: 'codex:gpt-5.5',
        enabled: true,
        effort: 'low',
        taskClasses: ['mechanical'],
        useFor: 'Fix only math.js from a self-contained plan.',
        avoidFor: 'Any other file.',
      },
      {
        id: 'codex-format',
        model: 'codex:gpt-5.5',
        enabled: true,
        effort: 'low',
        taskClasses: ['feature'],
        useFor: 'Fix only format.js from a self-contained plan.',
        avoidFor: 'Any other file.',
      },
      {
        id: 'sonnet-review',
        model: 'claude-sonnet-5',
        enabled: true,
        effort: 'high',
        taskClasses: ['review', 'smoke_test'],
        useFor: 'Adversarial read-only integrated review after checks pass.',
        avoidFor: 'Implementation.',
      },
    ],
    checks: [
      {
        id: 'fixture-tests',
        run: 'npm test',
        cwd: '.',
        when: ['post-implement', 'pre-commit'],
        timeoutMinutes: 2,
      },
    ],
  };

  return `async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label, predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const chipText = () => {
      const label = Array.from(document.querySelectorAll('button span'))
        .find((element) => (element.textContent || '').trim() === 'PARABLE');
      return (label?.closest('button')?.innerText || '').replace(/\\s+/g, ' ').trim();
    };

    const bridge = window.__GREP_TEST__;
    if (!bridge?.useSessionStore) throw new Error('Missing __GREP_TEST__.useSessionStore');
    if (!window.electronAPI?.settings) throw new Error('Missing Electron preload bridge');
    const store = bridge.useSessionStore;
    const originalSessionId = store.getState().activeSessionId;
    const originalSettings = await window.electronAPI.settings.get();
    let session;
    const result = {
      sessionId: null,
      repoPath: ${JSON.stringify(args.repoPath)},
      idleChipBefore: '',
      activeChipSamples: [],
      activeModelSamples: [],
      idleChipAfter: '',
      selectedAfter: '',
      activeAfter: null,
      systemModelAfter: null,
      assistantPreviews: [],
    };

    try {
      await window.electronAPI.settings.set({ parableConfig: ${JSON.stringify(config)} });
      await store.getState().loadSessions();
      await store.getState().loadAvailableModels();
      session = await window.electronAPI.dev.createSession({
        name: 'parable-live-smoke-' + String(Date.now()).slice(-8),
        repoPath: ${JSON.stringify(args.repoPath)},
        branch: ${JSON.stringify(args.branch)},
        createWorktree: false,
      });
      result.sessionId = session.id;
      await store.getState().loadSessions();
      await window.electronAPI.sessions.start(session.id);
      await store.getState().setActiveSession(session.id);
      await store.getState().loadMessages(session.id);
      store.getState().setSelectedModel(session.id, 'parable', 'api');
      store.getState().setPermissionMode(session.id, 'bypassPermissions');
      await sleep(300);
      result.idleChipBefore = chipText();

      const prompt = [
        'Use the Build-managed Parable playbook to fix the two independent fixture bugs.',
        'math.js add() must add; format.js shout() must uppercase.',
        'Create plans only under this repository .parable/plans directory.',
        'Dispatch codex-math and codex-format concurrently using exactly one foreground parable-batch.sh call.',
        'Do not use the Skill tool. Do not use shared /tmp plan files. Do not end while work is active.',
        'Run every configured post-implement check, perform a direct Agent review with sonnet-review,',
        'fix any findings, then run every pre-commit check. Do not commit. Summarize evidence.',
      ].join(' ');

      const sendPromise = store.getState().sendMessage(session.id, prompt, []);
      await waitFor('Parable streaming start', () => store.getState().isStreaming[session.id], 15000);
      while (store.getState().isStreaming[session.id]) {
        const chip = chipText();
        const activeModel = store.getState().activeStreamModel[session.id] || null;
        if (chip && !result.activeChipSamples.includes(chip)) result.activeChipSamples.push(chip);
        if (activeModel && !result.activeModelSamples.includes(activeModel)) result.activeModelSamples.push(activeModel);
        await sleep(100);
      }
      await sendPromise;
      await sleep(500);

      const state = store.getState();
      result.idleChipAfter = chipText();
      result.selectedAfter = state.selectedModel[session.id];
      result.activeAfter = state.activeStreamModel[session.id] || null;
      result.systemModelAfter = state.currentSystemInfo[session.id]?.model || null;
      result.assistantPreviews = (state.messages[session.id] || [])
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          content: (message.content || '').slice(0, 600),
          harness: message.harness || null,
          model: message.model || null,
          resolvedModel: message.resolvedModel || null,
          toolCount: (message.toolCalls || []).length,
        }));
      result.ok = result.idleChipBefore === 'PARABLE'
        && result.activeChipSamples.some((value) => /PARABLE.*Claude Opus 4\.8/i.test(value))
        && result.activeModelSamples.includes('claude-opus-4-8')
        && result.idleChipAfter === 'PARABLE'
        && result.selectedAfter === 'parable'
        && result.activeAfter === null
        && result.assistantPreviews.length > 0;
      return result;
    } finally {
      await window.electronAPI.settings.set({ parableConfig: originalSettings.parableConfig });
      if (originalSessionId) await store.getState().setActiveSession(originalSessionId);
    }
  }`;
}

async function main() {
  const args = parseArgs(process.argv);
  const { send, ws } = await connectToRenderer(args.port, args.timeoutMs);
  try {
    const response = await send('Runtime.evaluate', {
      expression: `(${buildExpression(args)})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
    }
    const result = response.result.result.value;
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
