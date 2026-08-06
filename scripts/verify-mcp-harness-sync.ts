import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import Module from 'module';

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

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

const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithElectronStoreMock(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron-store') {
    return MockStore;
  }
  if (request === '@cursor/sdk') {
    return {
      Agent: {
        create: async () => {
          throw new Error('Cursor SDK is not used by this verifier');
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function store(name: string): Record<string, unknown> {
  const value = stores.get(name);
  assert.ok(value, `expected store ${name}`);
  return value;
}

async function main(): Promise<void> {
  const {
    mcpService,
    normalizeMcpServerForClaude,
  } = await import('../src/main/services/mcp.service');
  const { toCursorSdkMcpServers } = await import('../src/main/services/cursor.service');

  const serverStore = store('claudette-mcp-servers');
  Object.assign(serverStore, {
    linear: {
      type: 'sse',
      url: 'https://mcp.linear.app/sse',
      headers: {
        Authorization: 'Bearer linear-token',
      },
    },
    Paper: {
      type: 'http',
      url: 'http://127.0.0.1:29979/mcp',
    },
    LocalWrapped: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'http://localhost:9988/mcp', '--allow-http'],
    },
    LocalWrappedMissingAllow: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'http://localhost:9989/mcp'],
    },
    shell: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {
        SHELL_TOKEN: 'abc',
      },
    },
  });

  Object.assign(store('claudette-mcp-harness-sync'), {
    managedServerIds: ['linear', 'removed-by-build'],
    removedServerIds: ['removed-by-build'],
  });
  // This verifier supplies a completed bearer credential directly; mark the
  // mocked remote-auth cache ready so transport-shape assertions are isolated
  // from the developer machine's real ~/.mcp-auth contents.
  (mcpService as unknown as { remoteAuthReadiness: Map<string, boolean> })
    .remoteAuthReadiness.set('linear', true);

  const nativeLinear = normalizeMcpServerForClaude(
    { type: 'sse', url: 'https://mcp.linear.app/sse' },
    { preferNativeRemoteTransports: true },
    'linear',
  );
  assert.equal(nativeLinear.type, 'sse');
  assert.equal(nativeLinear.url, 'https://mcp.linear.app/mcp');

  const claudeSync = mcpService.getClaudeMcpSyncData();
  assert.deepEqual(claudeSync.serverIds.sort(), ['LocalWrapped', 'LocalWrappedMissingAllow', 'Paper', 'linear', 'shell'].sort());
  assert.ok(claudeSync.removeServerIds.includes('removed-by-build'));

  const linearClaude = claudeSync.servers.linear;
  assert.equal(linearClaude.command, 'npx');
  assert.deepEqual(linearClaude.args?.slice(0, 3), ['-y', 'mcp-remote@0.1.38', 'https://mcp.linear.app/mcp']);
  assert.ok(linearClaude.args?.includes('--header'));
  assert.ok(linearClaude.args?.includes('Authorization: ${BUILD_MCP_LINEAR_AUTHORIZATION}'));
  assert.equal(linearClaude.env?.BUILD_MCP_LINEAR_AUTHORIZATION, 'Bearer linear-token');

  const paperClaude = claudeSync.servers.Paper;
  assert.equal(paperClaude.command, 'npx');
  assert.ok(paperClaude.args?.includes('http://127.0.0.1:29979/mcp'));
  assert.ok(paperClaude.args?.includes('--allow-http'));

  assert.ok(claudeSync.servers.LocalWrapped.args?.includes('mcp-remote@0.1.38'));
  assert.ok(!claudeSync.servers.LocalWrapped.args?.includes('mcp-remote'));
  assert.ok(claudeSync.servers.LocalWrappedMissingAllow.args?.includes('mcp-remote@0.1.38'));
  assert.ok(claudeSync.servers.LocalWrappedMissingAllow.args?.includes('--allow-http'));
  assert.ok(!claudeSync.servers.LocalWrappedMissingAllow.args?.includes('mcp-remote'));

  const migratedStore = store('claudette-mcp-servers') as Record<string, { args?: string[] }>;
  assert.ok(migratedStore.LocalWrapped.args?.includes('mcp-remote@0.1.38'));
  assert.ok(!migratedStore.LocalWrapped.args?.includes('mcp-remote'));
  assert.ok(migratedStore.LocalWrappedMissingAllow.args?.includes('mcp-remote@0.1.38'));
  assert.ok(migratedStore.LocalWrappedMissingAllow.args?.includes('--allow-http'));
  assert.ok(!migratedStore.LocalWrappedMissingAllow.args?.includes('mcp-remote'));

  const harnessSync = mcpService.getHarnessMcpSyncData();
  assert.deepEqual(harnessSync.servers.linear, linearClaude);
  assert.deepEqual(harnessSync.servers.Paper, paperClaude);
  assert.deepEqual(harnessSync.servers.shell, {
    command: 'node',
    args: ['server.js'],
    env: { SHELL_TOKEN: 'abc' },
  });

  const activeServers = await mcpService.getActiveServers();
  assert.equal(activeServers.find(server => server.id === 'build-browser')?.name, 'Build Browser');
  assert.equal(activeServers.find(server => server.id === 'claudette-design')?.name, 'Design Mode');
  assert.ok(!activeServers.some(server => server.name.startsWith('Claudette ')));
  assert.deepEqual(
    activeServers.filter(server => server.id.startsWith('claudette-')).map(server => server.id),
    ['claudette-design'],
  );

  const mergedClaude = JSON.parse(mcpService.buildMergedMcpJson(JSON.stringify({
    otherSetting: true,
    mcpServers: {
      customRemoteOnly: { command: 'custom', args: [] },
      linear: { command: 'old-linear' },
      'removed-by-build': { command: 'old-removed' },
    },
  }), claudeSync.servers, claudeSync.removeServerIds));
  assert.equal(mergedClaude.otherSetting, true);
  assert.deepEqual(mergedClaude.mcpServers.customRemoteOnly, { command: 'custom', args: [] });
  assert.equal(mergedClaude.mcpServers.linear.command, 'npx');
  assert.equal(mergedClaude.mcpServers['removed-by-build'], undefined);

  const mergedCursor = JSON.parse(mcpService.buildMergedMcpJson(JSON.stringify({
    mcpServers: {
      customCursorOnly: { command: 'custom-cursor' },
      Paper: { command: 'old-paper' },
    },
  }), harnessSync.servers, harnessSync.removeServerIds));
  assert.deepEqual(mergedCursor.mcpServers.customCursorOnly, { command: 'custom-cursor' });
  assert.equal(mergedCursor.mcpServers.Paper.command, 'npx');

  const codexToml = mcpService.buildMergedCodexConfig(`
model = "gpt-5"

[mcp_servers.custom]
command = "custom"

[mcp_servers.linear]
command = "old"

[mcp_servers.removed-by-build]
command = "old"
`, harnessSync.servers, harnessSync.removeServerIds);
  assert.ok(codexToml.includes('model = "gpt-5"'));
  assert.ok(codexToml.includes('[mcp_servers.custom]'));
  assert.ok(codexToml.includes('[mcp_servers.linear]'));
  assert.ok(codexToml.includes('Authorization: ${BUILD_MCP_LINEAR_AUTHORIZATION}'));
  assert.ok(!codexToml.includes('[mcp_servers.removed-by-build]'));

  const openCodeConfig = JSON.parse(mcpService.buildMergedOpenCodeConfig(JSON.stringify({
    provider: { keep: true },
    theme: 'base',
    mcp: {
      baseOpenCodeOnly: { type: 'local', command: ['base-custom'] },
      linear: { type: 'local', command: ['base-old'] },
    },
  }), harnessSync.servers, harnessSync.removeServerIds, JSON.stringify({
    theme: 'stale-build',
    mcp: {
      customOpenCodeOnly: { type: 'local', command: ['custom'] },
      linear: { type: 'local', command: ['old'] },
      'removed-by-build': { type: 'local', command: ['removed'] },
    },
  })));
  assert.deepEqual(openCodeConfig.provider, { keep: true });
  assert.equal(openCodeConfig.theme, 'base');
  assert.deepEqual(openCodeConfig.mcp.baseOpenCodeOnly, { type: 'local', command: ['base-custom'] });
  assert.deepEqual(openCodeConfig.mcp.customOpenCodeOnly, { type: 'local', command: ['custom'] });
  assert.equal(openCodeConfig.mcp.linear.type, 'local');
  assert.deepEqual(openCodeConfig.mcp.linear.command.slice(0, 3), ['npx', '-y', 'mcp-remote@0.1.38']);
  assert.equal(openCodeConfig.mcp.linear.environment.BUILD_MCP_LINEAR_AUTHORIZATION, 'Bearer linear-token');
  assert.equal(openCodeConfig.mcp['removed-by-build'], undefined);

  const localhostPorts = mcpService.getLocalhostMcpPorts()
    .map(({ serverId, port }) => `${serverId}:${port}`)
    .sort();
  assert.deepEqual(localhostPorts, ['LocalWrapped:9988', 'LocalWrappedMissingAllow:9989', 'Paper:29979']);

  const cursorSdkServers = toCursorSdkMcpServers(harnessSync.servers);
  assert.deepEqual(cursorSdkServers.linear, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.linear.app/mcp', '--header', 'Authorization: ${BUILD_MCP_LINEAR_AUTHORIZATION}'],
    env: { BUILD_MCP_LINEAR_AUTHORIZATION: 'Bearer linear-token' },
  });

  Object.assign(store('claudette-mcp-servers'), {
    'open-design': {
      type: 'stdio',
      command: 'node',
      args: ['/legacy/open-design/cli.js', 'mcp'],
    },
  });
  Object.assign(store('claudette-mcp-harness-sync'), {
    managedServerIds: ['linear', 'open-design', 'removed-by-build'],
  });
  assert.equal(await mcpService.removeLegacyOpenDesignMcpServer(), true);
  assert.equal(store('claudette-mcp-servers')['open-design'], undefined);
  assert.ok((store('claudette-mcp-harness-sync').removedServerIds as string[]).includes('open-design'));

  const cursorCliSource = fs.readFileSync(path.join(__dirname, '../src/main/services/cursor-cli.service.ts'), 'utf8');
  assert.ok(cursorCliSource.includes("'--approve-mcps'"), 'Cursor CLI launches should auto-approve synced MCPs');

  const mcpIpcSource = fs.readFileSync(path.join(__dirname, '../src/main/ipc/mcp.ipc.ts'), 'utf8');
  const retireLegacyIndex = mcpIpcSource.indexOf('mcpService.removeLegacyOpenDesignMcpServer()');
  const authPreparationIndex = mcpIpcSource.indexOf('.then(() => mcpService.prepareConfiguredRemoteAuth())');
  const localHarnessSyncIndex = mcpIpcSource.indexOf('.then(() => syncHarnessesAndSshSessions())');
  assert.ok(retireLegacyIndex >= 0, 'Build startup should retire the legacy open-design MCP');
  assert.ok(
    authPreparationIndex > retireLegacyIndex && localHarnessSyncIndex > authPreparationIndex,
    'Build startup should remove the legacy design MCP before auth preparation and the single harness sync',
  );
  assert.ok(!mcpIpcSource.includes('ensureOpenDesignMcpServer'), 'Build must not silently restore an uninstalled open-design MCP');

  const claudeSource = fs.readFileSync(path.join(__dirname, '../src/main/services/claude.service.ts'), 'utf8');
  assert.ok(
    !claudeSource.includes('const designDaemon = await designService.ensureDaemon()'),
    'Claude turns must not rerun Open Design MCP setup',
  );
  assert.ok(
    !claudeSource.includes('syncLocalHarnessConfigs(workspace.daemonUrl)'),
    'DesignMode activation must not mutate global harness MCP configuration',
  );
  assert.ok(
    claudeSource.includes("disallowedTools: ['DesignSync']"),
    'Claude must not substitute DesignSync for Build\'s DesignMode capability',
  );
  assert.ok(
    !claudeSource.includes('sshService.scheduleMcpConfigsToRemote(sessionId, session.sshConfig)')
      && !claudeSource.includes('const mcpSyncResult = await sshService.syncMcpConfigsToRemote(sessionId, session.sshConfig)'),
    'SSH Claude turns must not trigger MCP bridge/config synchronization',
  );

  console.log('mcp harness sync verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
