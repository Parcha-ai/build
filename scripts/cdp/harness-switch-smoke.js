#!/usr/bin/env node

const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = {
    branch: 'master',
    includeCodex: true,
    port: 9323,
    repoPath: process.cwd(),
    timeoutMs: 180000,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--skip-codex') {
      args.includeCodex = false;
    } else if (arg === '--include-codex') {
      args.includeCodex = true;
    } else if (arg.startsWith('--branch=')) {
      args.branch = arg.slice('--branch='.length);
    } else if (arg === '--branch') {
      args.branch = argv[++index];
    } else if (arg.startsWith('--repo-path=')) {
      args.repoPath = arg.slice('--repo-path='.length);
    } else if (arg === '--repo-path') {
      args.repoPath = argv[++index];
    } else if (arg.startsWith('--port=')) {
      args.port = Number(arg.slice('--port='.length));
    } else if (arg === '--port') {
      args.port = Number(argv[++index]);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/cdp/harness-switch-smoke.js [options]',
        '',
        'Options:',
        '  --repo-path PATH       Repo/worktree path for the throwaway dev session',
        '  --branch NAME          Branch for the throwaway dev session',
        '  --port PORT            Electron remote debugging port (default: 9323)',
        '  --skip-codex           Skip Codex when the running main process is stale or auth is unavailable',
        '  --include-codex        Include Codex (default)',
        '  --timeout-ms MS        CDP evaluation timeout (default: 180000)',
      ].join('\n'));
      process.exit(0);
    }
  }

  return args;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
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
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url))
    || targets.find((candidate) => candidate.type === 'page');
  if (!target) {
    throw new Error(`No Electron renderer target found on port ${port}`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await opened;

  const send = createCdpSender(ws, timeoutMs);
  await send('Runtime.enable');
  return { send, ws };
}

function buildRendererExpression({ branch, includeCodex, repoPath }) {
  return `async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label, fn, timeoutMs = 90000) => {
      const deadline = Date.now() + timeoutMs;
      let lastValue;
      while (Date.now() < deadline) {
        lastValue = await fn();
        if (lastValue) return lastValue;
        await sleep(250);
      }
      throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(lastValue));
    };

    const bridge = window.__GREP_TEST__;
    if (!bridge?.useSessionStore) throw new Error('Missing __GREP_TEST__.useSessionStore');

    const store = bridge.useSessionStore;
    const originalSessionId = store.getState().activeSessionId;
    const originalModel = originalSessionId ? store.getState().selectedModel[originalSessionId] : undefined;
    const originalPermissionMode = originalSessionId ? store.getState().permissionMode[originalSessionId] : undefined;
    const runId = String(Date.now()).slice(-8);
    const runs = [
      { harness: 'claude', model: 'claude-haiku-4-5-20251001', phrase: 'smoke claude ' + runId, permissionMode: 'default' },
      { harness: 'gemini', model: 'gemini:gemini-3.5-flash', phrase: 'smoke gemini ' + runId, permissionMode: 'default' },
      { harness: 'cursor', model: 'cursor:gemini-3.5-flash', phrase: 'smoke cursor ' + runId, permissionMode: 'default' },
      ${includeCodex ? "{ harness: 'codex', model: 'codex:gpt-5.4-mini', phrase: 'smoke codex ' + runId, permissionMode: 'dontAsk' }," : ''}
    ];

    let session = null;
    const result = {
      runId,
      originalSessionId,
      originalModel,
      originalPermissionMode,
      sessionId: null,
      steps: [],
      reloadMarkers: [],
      phrases: runs.map((run) => run.phrase),
      cleaned: false,
    };

    try {
      await store.getState().loadSessions();
      await store.getState().loadAvailableModels();
      session = await window.electronAPI.dev.createSession({
        name: 'harness-switch-smoke-' + runId,
        repoPath: ${JSON.stringify(repoPath)},
        branch: ${JSON.stringify(branch)},
        createWorktree: false,
      });
      result.sessionId = session.id;

      await store.getState().loadSessions();
      await window.electronAPI.sessions.start(session.id);
      await store.getState().setActiveSession(session.id);
      await store.getState().loadMessages(session.id);
      await sleep(300);

      for (const run of runs) {
        const beforeMessages = store.getState().messages[session.id] || [];
        const beforeAssistantCount = beforeMessages.filter((message) => message.role === 'assistant').length;
        store.getState().setSelectedModel(session.id, run.model, 'api');
        store.getState().setPermissionMode(session.id, run.permissionMode);

        const prompt = 'Harness render smoke test. Do not inspect files. Do not use tools. Do not modify files. Reply with this exact short phrase and nothing else: ' + run.phrase;
        const startedAt = Date.now();
        await store.getState().sendMessage(session.id, prompt, []);
        await waitFor('idle after ' + run.model, () => !store.getState().isStreaming[session.id], 15000);
        await sleep(500);

        const afterMessages = store.getState().messages[session.id] || [];
        const assistantMessages = afterMessages.filter((message) => message.role === 'assistant');
        const newAssistantMessages = assistantMessages.slice(beforeAssistantCount);
        const phraseMatches = assistantMessages.filter((message) => (message.content || '').toLowerCase().includes(run.phrase));
        const body = document.body.innerText || '';
        const visibleOutputs = newAssistantMessages.filter((message) => {
          const content = (message.content || '').trim();
          if (content && body.toLowerCase().includes(content.toLowerCase())) return true;
          return (message.toolCalls || []).length > 0 || (message.contentBlocks || []).length > 0;
        });

        result.steps.push({
          harness: run.harness,
          model: run.model,
          phrase: run.phrase,
          durationMs: Date.now() - startedAt,
          selectedAfter: store.getState().selectedModel[session.id],
          newAssistantCount: newAssistantMessages.length,
          phraseAssistantCount: phraseMatches.length,
          phraseVisibleInDom: body.toLowerCase().includes(run.phrase),
          outputVisibleInDom: visibleOutputs.length > 0,
          sawOldApiKeyError: newAssistantMessages.some((message) => (message.content || '').includes('No OpenAI API key configured')),
          newAssistantPreviews: newAssistantMessages.map((message) => ({
            harness: message.harness || null,
            content: (message.content || '').slice(0, 200),
            tools: (message.toolCalls || []).length,
            blocks: (message.contentBlocks || []).length,
          })),
        });
      }

      await store.getState().loadMessages(session.id, { replaceWhileStreaming: true });
      await sleep(750);

      const reloadedMessages = store.getState().messages[session.id] || [];
      const reloadedAssistant = reloadedMessages.filter((message) => message.role === 'assistant');
      const reloadedBody = document.body.innerText || '';
      result.reloadMarkers = runs.map((run) => {
        const step = result.steps.find((candidate) => candidate.harness === run.harness);
        const observedContents = (step?.newAssistantPreviews || [])
          .map((preview) => (preview.content || '').trim())
          .filter(Boolean);
        const phraseMatches = reloadedAssistant.filter((message) => (message.content || '').toLowerCase().includes(run.phrase));
        const outputMatches = observedContents.length > 0
          ? reloadedAssistant.filter((message) => observedContents.some((content) => (message.content || '').trim() === content))
          : [];
        return {
          harness: run.harness,
          phrase: run.phrase,
          phraseCount: phraseMatches.length,
          phraseHarnesses: phraseMatches.map((message) => message.harness || null),
          phraseVisibleInDom: reloadedBody.toLowerCase().includes(run.phrase),
          outputCount: outputMatches.length,
          outputHarnesses: outputMatches.map((message) => message.harness || null),
          outputVisibleInDom: observedContents.some((content) => reloadedBody.toLowerCase().includes(content.toLowerCase())),
        };
      });

      result.ok = result.steps.every((step) =>
        step.newAssistantCount >= 1
        && step.outputVisibleInDom
        && !step.sawOldApiKeyError
      ) && result.reloadMarkers.every((marker) =>
        (marker.phraseCount >= 1 || marker.outputCount >= 1)
        && (marker.phraseVisibleInDom || marker.outputVisibleInDom)
      );

      return result;
    } finally {
      if (session?.id) {
        try { await window.electronAPI.claude.cancel(session.id); } catch (error) {}
        try { localStorage.removeItem('grep-supplemental-messages-' + session.id); } catch (error) {}
        try { await store.getState().deleteSession(session.id); } catch (error) { result.cleanupError = String(error?.message || error); }
      }

      if (originalSessionId) {
        try { await store.getState().setActiveSession(originalSessionId); } catch (error) {}
        if (originalModel) {
          try { store.getState().setSelectedModel(originalSessionId, originalModel, 'api'); } catch (error) {}
        }
        if (originalPermissionMode) {
          try { store.getState().setPermissionMode(originalSessionId, originalPermissionMode); } catch (error) {}
        }
      }

      result.cleaned = !!session?.id && !(store.getState().sessions || []).some((candidate) => candidate.id === session.id);
    }
  }`;
}

async function walkJsonlFiles(root) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function cleanupSmokeArtifacts(phrases) {
  const roots = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.codex', 'sessions'),
  ];
  const removed = [];

  for (const root of roots) {
    const files = await walkJsonlFiles(root);
    for (const file of files) {
      let content = '';
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (!phrases.some((phrase) => content.toLowerCase().includes(phrase))) continue;
      await fs.rm(file, { force: true });
      removed.push(file);
    }
  }

  return removed;
}

async function main() {
  const args = parseArgs(process.argv);
  const { send, ws } = await connectToRenderer(args.port, args.timeoutMs);

  try {
    const expression = `(${buildRendererExpression(args)})()`;
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (response.result.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
    }

    const result = response.result.result.value;
    result.removedArtifacts = await cleanupSmokeArtifacts(result.phrases || []);
    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
