import assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import Module from 'module';

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const originalLoad = moduleLoader._load;
const realOs = originalLoad.call(moduleLoader, 'os', module, false) as typeof import('os');
const realChildProcess = originalLoad.call(moduleLoader, 'child_process', module, false) as typeof import('child_process');
const tempHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'build-mcp-e2e-'));
const stores = new Map<string, Record<string, unknown>>();

class MockStore {
  private readonly name: string;

  constructor(options: { name?: string } = {}) {
    this.name = options.name || 'default';
    if (!stores.has(this.name)) {
      stores.set(this.name, {});
    }
  }

  get store(): Record<string, unknown> {
    return stores.get(this.name) || {};
  }

  set store(value: Record<string, unknown>) {
    stores.set(this.name, value);
  }

  get(key: string, defaultValue?: unknown): unknown {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : defaultValue;
  }

  set(key: string, value: unknown): void {
    this.store = { ...this.store, [key]: value };
  }
}

function createFakeSpawn(): typeof realChildProcess.spawn {
  return ((_command: string, _args?: readonly string[]) => {
    const child = new EventEmitter() as import('child_process').ChildProcess;
    child.stdout = new EventEmitter() as import('stream').Readable;
    child.stderr = new EventEmitter() as import('stream').Readable;
    child.stdin = null;
    child.kill = () => true;
    Object.defineProperty(child, 'killed', { value: false });
    Object.defineProperty(child, 'exitCode', { value: null });
    Object.defineProperty(child, 'signalCode', { value: null });

    process.nextTick(() => {
      child.stdout?.emit('data', Buffer.from('Local STDIO server running\n'));
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });

    return child;
  }) as typeof realChildProcess.spawn;
}

moduleLoader._load = function loadWithMocks(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron-store') {
    return MockStore;
  }
  if (request === 'os') {
    return {
      ...realOs,
      homedir: () => tempHome,
    };
  }
  if (request === 'child_process') {
    return {
      ...realChildProcess,
      spawn: createFakeSpawn(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function readTempHome(relativePath: string): string {
  return fs.readFileSync(path.join(tempHome, relativePath), 'utf8');
}

function assertBuildWrapped(fileName: string, text: string, serverId: string): void {
  assert.ok(text.includes(serverId), `${fileName} should include ${serverId}`);
  assert.ok(text.includes('https://mcp.linear.app/sse'), `${fileName} should include the Linear URL`);
  assert.ok(text.includes('mcp-remote@0.1.38'), `${fileName} should pin mcp-remote`);
  assert.ok(!/\bmcp-remote\b(?!@0\.1\.38)/.test(text), `${fileName} should not include unpinned mcp-remote`);
  assert.ok(text.includes('BUILD_MCP_LINEAR_UI_SMOKE_AUTHORIZATION'), `${fileName} should use an env-backed Authorization header`);
}

async function main(): Promise<void> {
  const { mcpService } = await import('../src/main/services/mcp.service');
  const serverId = 'linear-ui-smoke';

  const authEvent = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP auth prewarm event')), 1000);
    mcpService.onRemoteAuthPrewarmFinished((event) => {
      if (event.serverId !== serverId) return;
      clearTimeout(timeout);
      resolve(event);
    });
  });

  const installResult = await mcpService.installServerRaw(serverId, {
    type: 'sse',
    url: 'https://mcp.linear.app/sse',
    headers: {
      Authorization: 'Bearer smoke-token',
    },
  });
  assert.deepEqual(installResult, { success: true });
  assert.deepEqual(await authEvent, {
    serverId,
    remoteUrl: 'https://mcp.linear.app/sse',
    reason: 'authenticated',
    authenticated: true,
  });

  const rawConfig = mcpService.getRawConfig(serverId);
  assert.deepEqual(rawConfig, {
    type: 'sse',
    url: 'https://mcp.linear.app/sse',
    headers: {
      Authorization: 'Bearer smoke-token',
    },
  });

  const activeServers = await mcpService.getActiveServers();
  assert.ok(activeServers.some((server: { id: string; type: string }) => server.id === serverId && server.type === 'http'));

  const claudeConfig = mcpService.getClaudeMcpServersConfig()[serverId];
  assert.equal(claudeConfig.command, 'npx');
  assert.deepEqual(claudeConfig.args, [
    '-y',
    'mcp-remote@0.1.38',
    'https://mcp.linear.app/sse',
    '--header',
    'Authorization: ${BUILD_MCP_LINEAR_UI_SMOKE_AUTHORIZATION}',
  ]);
  assert.equal(claudeConfig.env?.BUILD_MCP_LINEAR_UI_SMOKE_AUTHORIZATION, 'Bearer smoke-token');

  const localSync = await mcpService.syncLocalHarnessConfigs();
  assert.deepEqual(localSync.errors, {});

  assertBuildWrapped('Cursor MCP config', readTempHome('.cursor/mcp.json'), serverId);
  assertBuildWrapped('Gemini MCP config', readTempHome('.gemini/settings.json'), serverId);
  assertBuildWrapped('Codex MCP config', readTempHome('.codex/config.toml'), serverId);
  assertBuildWrapped('OpenCode MCP config', readTempHome('.config/opencode/build-mcp.json'), serverId);

  const uninstallResult = await mcpService.uninstallServer(serverId);
  assert.deepEqual(uninstallResult, { success: true });
  const uninstallSync = await mcpService.syncLocalHarnessConfigs();
  assert.deepEqual(uninstallSync.errors, {});

  assert.ok(!readTempHome('.cursor/mcp.json').includes(serverId));
  assert.ok(!readTempHome('.gemini/settings.json').includes(serverId));
  assert.ok(!readTempHome('.codex/config.toml').includes(serverId));
  assert.ok(!readTempHome('.config/opencode/build-mcp.json').includes(serverId));

  console.log('mcp extension e2e verifier passed');
}

main()
  .finally(async () => {
    await fsPromises.rm(tempHome, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
