#!/usr/bin/env node
const http = require('http');

const port = Number(process.argv[2] || 9333);
const mode = process.argv[3] || 'inspect';

function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((candidate) => candidate.type === 'page' && /main_window/.test(candidate.url));
  if (!target?.webSocketDebuggerUrl) throw new Error(`Build renderer unavailable on ${port}`);
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
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  await evaluate(`window.__GREP_TEST__.useUIStore.getState().closeSettings()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await evaluate(`window.__GREP_TEST__.useUIStore.getState().openSettings('parable')`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const inspect = () => evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], .fixed')].find((node) => node.textContent.includes('Subscription pools'));
    const root = dialog || document.body;
    return {
      text: root.innerText.slice(-12000),
      buttons: [...root.querySelectorAll('button')].map((button) => button.innerText.trim()).filter(Boolean),
    };
  })()`);
  if (mode === 'inspect') {
    console.log(JSON.stringify(await inspect(), null, 2));
    socket.close();
    return;
  }
  if (mode === 'native') {
    const layout = await evaluate(`(() => {
      const content = [...document.querySelectorAll('div')].find((node) => node.textContent.includes('Subscription pools') && node.classList.contains('overflow-x-hidden'));
      const connect = [...document.querySelectorAll('button')].find((node) => node.innerText.trim() === 'Connect');
      const row = connect?.closest('.border');
      return {
        viewportWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
        contentClientWidth: content?.clientWidth || 0,
        contentScrollWidth: content?.scrollWidth || 0,
        connectVisible: Boolean(connect && connect.getBoundingClientRect().right <= window.innerWidth && connect.getBoundingClientRect().left >= 0),
        provider: row?.innerText || '',
      };
    })()`);
    console.log(JSON.stringify({ layout }));
    if (!layout.connectVisible || layout.bodyScrollWidth > layout.viewportWidth || layout.contentScrollWidth > layout.contentClientWidth + 1) {
      throw new Error(`Parable layout overflows: ${JSON.stringify(layout)}`);
    }
    const clickedConnect = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.innerText.trim() === 'Connect');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clickedConnect) throw new Error('Missing provider Connect button');
    const deadline = Date.now() + 30_000;
    let auth = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      auth = await evaluate(`(() => {
        const open = [...document.querySelectorAll('button')].find((node) => node.innerText.includes('Open authorization page'));
        const codeLabel = [...document.querySelectorAll('span')].find((node) => node.innerText.trim() === 'Device code');
        const code = codeLabel?.parentElement?.querySelector('button');
        return {
          openVisible: Boolean(open && open.getBoundingClientRect().right <= window.innerWidth),
          url: window.electronAPI.parable.getAuthRun().then((state) => state.authorizationUrl || ''),
          code: code?.innerText.trim() || '',
          text: document.body.innerText.slice(-4000),
        };
      })()`);
      auth.url = await evaluate(`window.electronAPI.parable.getAuthRun().then((state) => state.authorizationUrl || '')`);
      if (auth.url || /error/i.test(auth.text)) break;
    }
    console.log(JSON.stringify({ auth }));
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.innerText.trim() === 'Cancel');
      if (button) button.click();
    })()`);
    if (!auth?.url) throw new Error('Provider authorization URL was not surfaced in the app');
    if (!auth.openVisible) throw new Error('Authorization button is not visible');
    socket.close();
    return;
  }
  if (mode === 'config') {
    const before = await evaluate(`window.electronAPI.parable.getConfigData()`);
    const clickedCreate = await evaluate(`(() => {
      const create = [...document.querySelectorAll('button')].find((node) => node.innerText.includes('Create agent'));
      if (!create) return false;
      create.click();
      return true;
    })()`);
    if (!clickedCreate) throw new Error('Create agent missing');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exercised = await evaluate(`(() => {
      const create = [...document.querySelectorAll('button')].find((node) => node.innerText.includes('Create agent'));
      const headings = [...document.querySelectorAll('summary')].map((node) => node.innerText.trim());
      const modelInputs = [...document.querySelectorAll('label')].filter((node) => node.innerText.trim().startsWith('MODEL')).map((node) => node.querySelector('input')).filter(Boolean);
      const lastModel = modelInputs[modelInputs.length - 1];
      if (lastModel) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(lastModel, 'test-model-not-saved');
        lastModel.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return {
        headings,
        createVisible: create.getBoundingClientRect().right <= window.innerWidth,
        agentCountText: headings.find((value) => value.startsWith('AGENTS AND EXECUTORS')) || '',
        modelValue: lastModel?.value || '',
        hasDefaults: headings.some((value) => value.includes('DEFAULTS AND PARENT MODEL')),
        hasProviders: headings.some((value) => value.startsWith('PROVIDERS')),
        hasRouting: headings.includes('ROUTING'),
        hasChecks: headings.some((value) => value.startsWith('VERIFICATION CHECKS')),
        hasAdvanced: headings.includes('ADVANCED TOML'),
      };
    })()`);
    const after = await evaluate(`window.electronAPI.parable.getConfigData()`);
    console.log(JSON.stringify({ exercised }));
    const expectedCount = Object.keys(before.executors || {}).length + 1;
    if (exercised.error || !exercised.createVisible || !exercised.agentCountText.includes(String(expectedCount)) || exercised.modelValue !== 'test-model-not-saved' || !exercised.hasDefaults || !exercised.hasProviders || !exercised.hasRouting || !exercised.hasChecks || !exercised.hasAdvanced) {
      throw new Error(`Structured config UI failed: ${JSON.stringify(exercised)}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Editing the UI wrote config before Save settings');
    socket.close();
    return;
  }
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (
      node.innerText.includes('Set up and connect') || node.innerText.includes('Connect subscriptions')
    ));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Parable onboarding button not found');

  const started = Date.now();
  let last = '';
  while (Date.now() - started < 180_000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await inspect();
    if (state.text !== last) {
      last = state.text;
      console.log(JSON.stringify(state));
    }
    if (/starting native .* authorization/i.test(state.text)) {
      console.log('CDP_REACHED_OAUTH_HANDOFF');
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.innerText.trim() === 'Cancel');
        if (button) button.click();
      })()`);
      socket.close();
      return;
    }
    if (/Setup failed|error:|completed\./i.test(state.text) && !/Setting up Parable/i.test(state.text)) {
      socket.close();
      if (/error:|Setup failed/i.test(state.text)) process.exitCode = 2;
      return;
    }
  }
  throw new Error('Timed out waiting for Parable onboarding');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
