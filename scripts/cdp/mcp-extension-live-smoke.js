#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = {
    port: 9223,
    serverId: 'build-mcp-live-smoke',
    url: 'http://127.0.0.1:9/mcp',
    timeoutMs: 30000,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[++index]);
    } else if (arg.startsWith('--port=')) {
      args.port = Number(arg.slice('--port='.length));
    } else if (arg === '--server-id') {
      args.serverId = argv[++index];
    } else if (arg.startsWith('--server-id=')) {
      args.serverId = arg.slice('--server-id='.length);
    } else if (arg === '--url') {
      args.url = argv[++index];
    } else if (arg.startsWith('--url=')) {
      args.url = arg.slice('--url='.length);
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++index]);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/cdp/mcp-extension-live-smoke.js [options]',
        '',
        'Options:',
        '  --port PORT           Electron remote debugging port (default: 9223)',
        '  --server-id ID        Temporary MCP server id (default: build-mcp-live-smoke)',
        '  --url URL             Temporary remote MCP URL (default: http://127.0.0.1:9/mcp)',
        '  --timeout-ms MS       CDP timeout (default: 30000)',
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
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = createCdpSender(ws, timeoutMs);
  await send('Runtime.enable');
  return { send, ws, target };
}

async function evaluate(send, fn, args, timeoutMs) {
  const expression = `(${fn.toString()})(${JSON.stringify(args)})`;
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });

  const evaluation = result.result || {};

  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text || 'Renderer evaluation failed');
  }

  if (evaluation.result?.subtype === 'error') {
    throw new Error(evaluation.result.description || 'Renderer evaluation failed');
  }

  return evaluation.result?.value;
}

function harnessFiles() {
  const home = os.homedir();
  return [
    ['cursor', path.join(home, '.cursor/mcp.json')],
    ['gemini', path.join(home, '.gemini/settings.json')],
    ['codex', path.join(home, '.codex/config.toml')],
    ['opencode', path.join(home, '.config/opencode/build-mcp.json')],
  ];
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function snapshotHarnessFiles() {
  return harnessFiles().map(([name, filePath]) => ({
    name,
    filePath,
    existed: fs.existsSync(filePath),
    content: readIfExists(filePath),
  }));
}

function restoreHarnessFiles(snapshot) {
  for (const entry of snapshot) {
    if (entry.existed) {
      fs.mkdirSync(path.dirname(entry.filePath), { recursive: true });
      fs.writeFileSync(entry.filePath, entry.content, 'utf8');
    } else {
      fs.rmSync(entry.filePath, { force: true });
    }
  }
}

function assertInstalledInHarnessFiles(serverId, url) {
  for (const [name, filePath] of harnessFiles()) {
    const text = readIfExists(filePath);
    assert.ok(text.includes(serverId), `${name} config should include ${serverId}`);
    assert.ok(text.includes(url), `${name} config should include ${url}`);
    assert.ok(text.includes('mcp-remote@0.1.38'), `${name} config should pin mcp-remote`);
    if (url.startsWith('http://')) {
      assert.ok(text.includes('--allow-http'), `${name} config should allow HTTP remotes`);
    }
  }
}

function assertRemovedFromHarnessFiles(serverId) {
  for (const [name, filePath] of harnessFiles()) {
    const text = readIfExists(filePath);
    assert.ok(!text.includes(serverId), `${name} config should remove ${serverId}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const harnessSnapshot = snapshotHarnessFiles();
  const { send, ws, target } = await connectToRenderer(args.port, args.timeoutMs);
  console.log(`[mcp-live-smoke] Connected to ${target.title} on port ${args.port}`);

  const installExpression = async ({ serverId, url }) => {
    if (!window.electronAPI?.mcp?.installRaw) {
      throw new Error('window.electronAPI.mcp.installRaw is unavailable');
    }

    const install = await window.electronAPI.mcp.installRaw(serverId, {
      type: url.endsWith('/sse') ? 'sse' : 'http',
      url,
    });
    const raw = await window.electronAPI.mcp.getRawConfig(serverId);
    const servers = await window.electronAPI.mcp.getServers('mcp-live-smoke');
    return {
      install,
      raw,
      listed: servers.some((server) => server.id === serverId),
    };
  };

  const uninstallExpression = async ({ serverId }) => {
    if (!window.electronAPI?.mcp?.uninstall) {
      throw new Error('window.electronAPI.mcp.uninstall is unavailable');
    }

    const uninstall = await window.electronAPI.mcp.uninstall(serverId);
    const raw = await window.electronAPI.mcp.getRawConfig(serverId);
    const servers = await window.electronAPI.mcp.getServers('mcp-live-smoke');
    return {
      uninstall,
      raw,
      listed: servers.some((server) => server.id === serverId),
    };
  };

  try {
    const installed = await evaluate(send, installExpression, args, args.timeoutMs);
    assert.equal(installed.install.success, true, installed.install.error || 'installRaw failed');
    assert.deepEqual(installed.raw, {
      type: args.url.endsWith('/sse') ? 'sse' : 'http',
      url: args.url,
    });
    assert.equal(installed.listed, true, 'Installed MCP should be listed by getServers');
    assertInstalledInHarnessFiles(args.serverId, args.url);

    const removed = await evaluate(send, uninstallExpression, args, args.timeoutMs);
    assert.equal(removed.uninstall.success, true, removed.uninstall.error || 'uninstall failed');
    assert.equal(removed.raw, null);
    assert.equal(removed.listed, false, 'Uninstalled MCP should not be listed by getServers');
    assertRemovedFromHarnessFiles(args.serverId);

    console.log('mcp extension live smoke passed');
  } finally {
    try {
      const removed = await evaluate(send, uninstallExpression, args, args.timeoutMs);
      if (removed?.uninstall?.success) {
        assertRemovedFromHarnessFiles(args.serverId);
      }
    } catch {
      // The main assertion path reports failures. Cleanup here is best-effort.
    }
    restoreHarnessFiles(harnessSnapshot);
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
