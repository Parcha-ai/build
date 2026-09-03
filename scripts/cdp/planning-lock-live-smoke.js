#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2] || 9223);
const timeoutMs = 60_000;

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

async function connect() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find((item) => item.type === 'page' && /main_window/.test(item.url));
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          const done = pending.get(message.id);
          if (done) { pending.delete(message.id); done(message); }
        };
        const send = (method, params = {}) => new Promise((resolve) => {
          const requestId = ++id;
          pending.set(requestId, resolve);
          ws.send(JSON.stringify({ id: requestId, method, params }));
        });
        await send('Runtime.enable');
        return { ws, send };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No Build renderer appeared on CDP port ${port}`);
}

async function evaluate(send, expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
}

async function waitFor(label, fn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Reload replaces the execution context and briefly removes document.body.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickButton(send, label) {
  const point = await evaluate(send, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled: button.disabled };
  })()`);
  if (!point || point.disabled) throw new Error(`${label} is missing or disabled`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

(async () => {
  const { ws, send } = await connect();
  try {
    await evaluate(send, `(async () => {
      const settings = await window.electronAPI.settings.get();
      await window.electronAPI.settings.set({ ...settings, eveningPlanningLockEnabled: true, eveningPlanningLockTime: '00:00', eveningPlanningCalendarUrl: '' });
      localStorage.removeItem('evening-planning-date');
      localStorage.setItem('planning-session-start-' + new Date().toDateString(), String(Date.now()));
      location.reload();
      return true;
    })()`);
    await waitFor('planning modal', () => evaluate(send, `document.body.innerText.includes('PLAN TOMORROW')`));
    await evaluate(send, `(() => {
      const guest = document.createElement('webview');
      guest.id = 'planning-lock-smoke-webview';
      guest.style.cssText = 'position:fixed;inset:0;z-index:999999';
      document.querySelector('.planning-lock-active').prepend(guest);
      return getComputedStyle(guest).visibility === 'hidden' && getComputedStyle(guest).pointerEvents === 'none';
    })()`).then((hidden) => { if (!hidden) throw new Error('Planning lock did not suspend webview input'); });
    await evaluate(send, `(() => {
      const input = document.querySelector('input[placeholder="Add task..."]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Smoke-test tomorrow plan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickButton(send, 'Add');
    await waitFor('calendar drop zone', () => evaluate(send, `Boolean(document.querySelector('[data-planning-calendar-drop-zone]'))`));
    const selectedForScheduling = await evaluate(send, `(() => {
      const taskRow = [...document.querySelectorAll('.group')].find((item) => item.querySelector('input')?.value === 'Smoke-test tomorrow plan' && item.querySelector('[draggable="true"]'));
      const schedule = [...(taskRow?.querySelectorAll('button') || [])].find((button) => ['Schedule', 'Move'].includes(button.textContent.trim()));
      if (!schedule) return false;
      schedule.click();
      return true;
    })()`);
    if (!selectedForScheduling) throw new Error('Could not locate task Schedule action');
    await waitFor('calendar time selection mode', () => evaluate(send, `document.body.innerText.toUpperCase().includes('CHOOSE AN HOUR BELOW.')`));
    const selectedTime = await evaluate(send, `(() => {
      const slot = document.querySelector('[data-planning-calendar-hour="10"]');
      if (!slot) return false;
      slot.click();
      return true;
    })()`);
    if (!selectedTime) throw new Error('Could not locate 10 AM calendar slot');
    await waitFor('scheduled task time controls', () => evaluate(send, `document.querySelector('input[aria-label="Time for Smoke-test tomorrow plan"]')?.value === '10:00'`));
    await waitFor('enabled Set Intention button', () => evaluate(send, `Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Set Intention' && !b.disabled))`));
    await clickButton(send, 'Set Intention');
    await waitFor('commit step', () => evaluate(send, `document.body.innerText.includes('WHAT WOULD MAKE TODAY SUCCESSFUL?')`));
    const finishState = await evaluate(send, `(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Finish Planning');
      const countdown = [...document.querySelectorAll('[title="Optional planning guide"]')][0]?.textContent?.trim() || '';
      return { present: Boolean(button), disabled: button?.disabled, countdown };
    })()`);
    if (!finishState.present || finishState.disabled || finishState.countdown === '00:00') {
      throw new Error(`Finish Planning was not immediately available: ${JSON.stringify(finishState)}`);
    }
    await clickButton(send, 'Finish Planning');
    await waitFor('planning modal dismissal', () => evaluate(send, `!document.body.innerText.includes('PLAN TOMORROW')`));
    await waitFor('calendar event tab', () => evaluate(send, `document.body.innerText.toUpperCase().includes('PLAN: SMOKE-TEST TOMORROW PLAN')`));
    const completed = await evaluate(send, `localStorage.getItem('evening-planning-date') === new Date().toDateString()`);
    if (!completed) throw new Error('Planning completion was not saved');
    console.log('Planning lock live smoke passed');
  } finally {
    ws.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
