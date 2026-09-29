#!/usr/bin/env node

const http = require('http');

function parseArgs(argv) {
  const args = { branch: 'main', port: 9223, repoPath: '', timeoutMs: 300000, implicitQueuedTarget: false };
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
    else if (arg === '--implicit-queued-target') args.implicitQueuedTarget = true;
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

async function connect(port, timeoutMs) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
  if (!target) throw new Error(`No Build renderer found on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = createCdpSender(ws, timeoutMs);
  await send('Runtime.enable');
  return { send, ws };
}

async function evaluate(send, expression, awaitPromise = true) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.result.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails, null, 2));
  }
  return response.result.result.value;
}

async function waitFor(label, predicate, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const { send, ws } = await connect(args.port, args.timeoutMs);
  const runId = String(Date.now()).slice(-8);
  const phrases = {
    base: `The lilac sparrow said base ${runId}.`,
    active: `The lilac sparrow said parent ${runId}.`,
    target: `The lilac sparrow said target ${runId}.`,
    sibling: `The lilac sparrow said sibling ${runId}.`,
  };
  const activeModel = args.implicitQueuedTarget
    ? 'claude-haiku-4-5-20251001'
    : 'codex:gpt-5.5';
  const state = `window.__GREP_TEST__.useSessionStore.getState()`;
  let originalSessionId;
  let sessionId;

  try {
    originalSessionId = await evaluate(send, `${state}.activeSessionId`);
    await evaluate(send, `Promise.all([${state}.loadSessions(), ${state}.loadAvailableModels()]).then(() => true)`);
    const session = await evaluate(send, `window.electronAPI.dev.createSession(${JSON.stringify({
      name: `fast-stack-smoke-${runId}`,
      repoPath: args.repoPath,
      branch: args.branch,
      createWorktree: false,
    })})`);
    sessionId = session.id;
    const id = JSON.stringify(sessionId);

    await evaluate(send, `${state}.loadSessions().then(() => window.electronAPI.sessions.start(${id})).then(() => ${state}.setActiveSession(${id})).then(() => ${state}.loadMessages(${id})).then(() => true)`);
    await evaluate(send, `(() => { const s = ${state}; s.setPermissionMode(${id}, 'bypassPermissions'); s.setSelectedModel(${id}, 'claude-haiku-4-5-20251001', 'api'); void s.sendMessage(${id}, ${JSON.stringify(`Do not use tools. Reply with this exact phrase and nothing else: ${phrases.base}`)}, []); return true; })()`);
    await waitFor('base turn start', () => evaluate(send, `Boolean(${state}.isStreaming[${id}])`), 15000);
    await waitFor('base turn completion', () => evaluate(send, `!${state}.isStreaming[${id}]`));

    await evaluate(send, `(() => { const s = ${state}; s.setSelectedModel(${id}, ${JSON.stringify(activeModel)}, 'api'); void s.sendMessage(${id}, ${JSON.stringify(`Use the shell to run sleep 30. After it finishes, reply with this exact phrase: ${phrases.active}`)}, []); return true; })()`);
    await waitFor('parent turn start', () => evaluate(send, `Promise.all([Promise.resolve(Boolean(${state}.isStreaming[${id}])), window.electronAPI.claude.hasActiveQuery(${id}).catch(() => false)]).then(([renderer, backend]) => renderer || backend)`), 15000);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The product coalesces an immediate follow-up while a turn has no visible
    // activity yet. Clear that one early-follow-up marker so this smoke can
    // deterministically construct the queued state that the Stack button uses.
    await evaluate(send, `(() => { const hook = window.__GREP_TEST__.useSessionStore; hook.setState((s) => ({ activeUserPrompt: { ...s.activeUserPrompt, [${id}]: null } })); return true; })()`);
    const targetPrompt = `Do not use tools. Reply with this exact phrase and nothing else: ${phrases.target}`;
    const siblingPrompt = `Do not use tools. Reply with this exact phrase and nothing else: ${phrases.sibling}`;
    if (args.implicitQueuedTarget) {
      // Hold a deterministic queue before invoking the keyboard/no-id Fast
      // Stack path. Codex can normally steer queued prompts into an active
      // turn immediately, which would make this race impossible to exercise.
      await evaluate(send, `(async () => {
        const hook = window.__GREP_TEST__.useSessionStore;
        const target = { id: 'implicit-target-${runId}', message: ${JSON.stringify(targetPrompt)}, attachments: [], timestamp: Date.now(), suppressUserMessage: false };
        const sibling = { id: 'implicit-sibling-${runId}', message: ${JSON.stringify(siblingPrompt)}, attachments: [], timestamp: Date.now() + 1, suppressUserMessage: false };
        await window.electronAPI.queue.beginFastStack(${id});
        await window.electronAPI.queue.enqueue(${id}, target.message, [], { id: target.id, model: ${JSON.stringify(activeModel)} });
        await window.electronAPI.queue.enqueue(${id}, sibling.message, [], { id: sibling.id, model: ${JSON.stringify(activeModel)} });
        hook.setState((s) => ({
          messageQueue: { ...s.messageQueue, [${id}]: [target, sibling] },
          messages: {
            ...s.messages,
            [${id}]: [
              ...(s.messages[${id}] || []),
              { id: target.id, role: 'user', content: target.message, timestamp: new Date(target.timestamp), harness: 'codex' },
              { id: sibling.id, role: 'user', content: sibling.message, timestamp: new Date(sibling.timestamp), harness: 'codex' },
            ],
          },
        }));
        return true;
      })()`);
    } else {
      await evaluate(send, `${state}.sendMessage(${id}, ${JSON.stringify(targetPrompt)}, []).then(() => true)`);
      await evaluate(send, `${state}.sendMessage(${id}, ${JSON.stringify(siblingPrompt)}, []).then(() => true)`);
    }
    const queue = await waitFor('two queued prompts', () => evaluate(send, `(() => { const q = ${state}.messageQueue[${id}] || []; return q.length >= 2 ? q : null; })()`), 15000);
    const sessionCountBefore = await evaluate(send, `${state}.sessions.length`);
    const stackButtonVisible = await evaluate(send, `(document.body.innerText || '').toUpperCase().includes('STACK')`);
    const target = queue.find((item) => item.message.includes(phrases.target));
    if (!target) throw new Error('Target queued prompt not found');

    const fastStackInvocation = args.implicitQueuedTarget
      ? `void s.fastStack(${id}, ${JSON.stringify(target.message)}, ${JSON.stringify(target.attachments || [])})`
      : `void s.fastStack(${id}, ${JSON.stringify(target.message)}, ${JSON.stringify(target.attachments || [])}, ${JSON.stringify(target.id)}, ${Boolean(target.suppressUserMessage)})`;
    await evaluate(send, `(() => { const s = ${state}; ${fastStackInvocation}; return true; })()`);
    await waitFor('in-place fork metadata', () => evaluate(send, `window.electronAPI.sessions.get(${id}).then((session) => (session?.fastStackCount || 0) >= 1 ? session : null)`), 30000);
    await waitFor('target assistant output', () => evaluate(send, `(${state}.messages[${id}] || []).some((message) => message.role === 'assistant' && (message.content || '').includes(${JSON.stringify(phrases.target)}))`));
    const queueAfterTarget = await evaluate(send, `(${state}.messageQueue[${id}] || []).map((item) => ({ id: item.id, message: item.message }))`);
    await waitFor('sibling assistant output', () => evaluate(send, `(${state}.messages[${id}] || []).some((message) => message.role === 'assistant' && (message.content || '').includes(${JSON.stringify(phrases.sibling)}))`));
    await waitFor('queue empty', () => evaluate(send, `(${state}.messageQueue[${id}] || []).length === 0`), 30000);

    const final = await evaluate(send, `Promise.all([window.electronAPI.sessions.get(${id}), Promise.resolve(${state})]).then(([session, s]) => ({
      session,
      activeSessionId: s.activeSessionId,
      sessionCount: s.sessions.length,
      queue: (s.messageQueue[${id}] || []).map((item) => ({ id: item.id, message: item.message })),
      messages: (s.messages[${id}] || []).map((message) => ({ role: message.role, content: message.content || '', interrupted: Boolean(message.interrupted), harness: message.harness || null })),
    }))`);
    const targetUserCount = final.messages.filter((message) => message.role === 'user' && message.content.includes(phrases.target)).length;
    const siblingUserCount = final.messages.filter((message) => message.role === 'user' && message.content.includes(phrases.sibling)).length;
    const result = {
      runId,
      implicitQueuedTarget: args.implicitQueuedTarget,
      sessionId,
      originalSessionId,
      ...phrases,
      queueBefore: queue.map((item) => ({ id: item.id, message: item.message })),
      queueAfterTarget,
      queueAfterAll: final.queue,
      stackButtonVisible,
      sessionCountBefore,
      sessionCountAfter: final.sessionCount,
      activeSessionStayedSame: final.activeSessionId === sessionId,
      fastStackCount: final.session?.fastStackCount || 0,
      sdkSessionId: final.session?.sdkSessionId || null,
      messageOrder: final.messages.filter((message) => Object.values(phrases).some((phrase) => message.content.includes(phrase))),
      assistantPreviews: final.messages.filter((message) => message.role === 'assistant').map((message) => ({ ...message, content: message.content.slice(0, 240) })),
    };
    result.ok = result.stackButtonVisible
      && result.sessionCountAfter === result.sessionCountBefore
      && result.activeSessionStayedSame
      && result.fastStackCount === 1
      && Boolean(result.sdkSessionId)
      && targetUserCount === 1
      && siblingUserCount === 1
      && result.queueAfterAll.length === 0
      && result.assistantPreviews.some((message) => message.content.includes(phrases.target))
      && result.assistantPreviews.some((message) => message.content.includes(phrases.sibling));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (originalSessionId) {
      await evaluate(send, `${state}.setActiveSession(${JSON.stringify(originalSessionId)}).then(() => true)`).catch(() => undefined);
    }
    if (sessionId) {
      await evaluate(send, `window.electronAPI.claude.cancel(${JSON.stringify(sessionId)}).catch(() => undefined)`).catch(() => undefined);
    }
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
