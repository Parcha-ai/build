#!/usr/bin/env node

const http = require('http');

const port = Number(process.argv[2] || 9222);

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getTargets();
  const target = targets.find((item) => item.type === 'page' && /main_window/.test(item.url));
  if (!target) throw new Error(`No Build renderer appeared on CDP port ${port}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const result = await new Promise((resolve) => {
    socket.onmessage = (event) => resolve(JSON.parse(event.data));
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `JSON.stringify((() => {
          const toolbar = document.querySelector('[data-testid="browser-toolbar"]');
          if (!toolbar) return { visible: false };
          return {
            visible: true,
            width: Math.round(toolbar.getBoundingClientRect().width),
            actions: [...toolbar.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
            overflowVisible: Boolean(toolbar.querySelector('[aria-label="More browser actions"]')),
          };
        })())`,
        returnByValue: true,
      },
    }));
  });
  socket.close();
  const value = result.result?.result?.value;
  if (!value) throw new Error(JSON.stringify(result));
  console.log(value);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
