import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  MCP_REMOTE_AUTH_DIR_NAME,
  MCP_REMOTE_PACKAGE,
  MCP_REMOTE_PACKAGE_VERSION,
  MCP_REMOTE_RUNTIME_AUTH_VERSION,
  ensurePinnedMcpRemoteAuthDirectory,
  hasCompletedMcpRemoteAuth,
} from '../src/main/utils/mcp-remote-auth';

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'build-mcp-auth-'));
  try {
    const packageAuth = path.join(tempRoot, 'mcp-remote-0.1.38');
    const olderAuth = path.join(tempRoot, 'mcp-remote-0.1.36');
    await fs.mkdir(packageAuth, { recursive: true });
    await fs.mkdir(olderAuth, { recursive: true });

    const completePrefix = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_';
    const partialPrefix = 'cb42d1a06ae8db4e5585a26f2e5ca947_';
    await fs.writeFile(path.join(olderAuth, `${completePrefix}tokens.json`), '{"source":"older"}');
    await fs.writeFile(path.join(packageAuth, `${completePrefix}tokens.json`), '{"source":"newest"}');
    await fs.writeFile(path.join(packageAuth, `${completePrefix}client_info.json`), '{"client":"ok"}');
    await fs.writeFile(path.join(packageAuth, `${partialPrefix}client_info.json`), '{"client":"partial"}');
    await fs.writeFile(path.join(packageAuth, `${partialPrefix}code_verifier.txt`), 'partial-verifier');
    await fs.writeFile(path.join(packageAuth, `${partialPrefix}lock.json`), '{}');

    const prepared = await ensurePinnedMcpRemoteAuthDirectory(tempRoot);
    assert.equal(MCP_REMOTE_PACKAGE, 'mcp-remote@0.1.38');
    assert.equal(MCP_REMOTE_PACKAGE_VERSION, '0.1.38');
    assert.equal(MCP_REMOTE_RUNTIME_AUTH_VERSION, '0.1.37');
    assert.equal(path.basename(prepared.authDir), MCP_REMOTE_AUTH_DIR_NAME);
    assert.equal(
      await fs.readFile(path.join(prepared.authDir, `${completePrefix}tokens.json`), 'utf8'),
      '{"source":"newest"}',
      'the newest completed OAuth record should be migrated',
    );
    assert.equal(
      await fs.readFile(path.join(prepared.authDir, `${completePrefix}client_info.json`), 'utf8'),
      '{"client":"ok"}',
    );
    await assert.rejects(fs.access(path.join(prepared.authDir, `${partialPrefix}client_info.json`)));
    await assert.rejects(fs.access(path.join(prepared.authDir, `${partialPrefix}code_verifier.txt`)));
    await assert.rejects(fs.access(path.join(prepared.authDir, `${partialPrefix}lock.json`)));

    assert.equal((await fs.stat(tempRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(prepared.authDir)).mode & 0o777, 0o700);
    assert.equal(
      (await fs.stat(path.join(prepared.authDir, `${completePrefix}tokens.json`))).mode & 0o777,
      0o600,
    );

    const notionUrl = 'https://mcp.notion.com/mcp';
    const notionPrefix = 'cb42d1a06ae8db4e5585a26f2e5ca947';
    await fs.writeFile(
      path.join(prepared.authDir, `${notionPrefix}_tokens.json`),
      '{"access_token":"access","refresh_token":"refresh"}',
    );
    await fs.writeFile(
      path.join(prepared.authDir, `${notionPrefix}_client_info.json`),
      '{"client_id":"client"}',
    );
    assert.equal(await hasCompletedMcpRemoteAuth(notionUrl, tempRoot), true);
    assert.equal(await hasCompletedMcpRemoteAuth('https://missing.example/mcp', tempRoot), false);

    const root = path.resolve(__dirname, '..');
    const mcpService = await fs.readFile(path.join(root, 'src/main/services/mcp.service.ts'), 'utf8');
    const mcpIpc = await fs.readFile(path.join(root, 'src/main/ipc/mcp.ipc.ts'), 'utf8');
    const sshService = await fs.readFile(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
    const codexService = await fs.readFile(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');

    assert.match(mcpIpc, /mcpService\.prepareConfiguredRemoteAuth\(\)/);
    assert.doesNotMatch(mcpIpc, /mcpService\.ensureConfiguredRemoteAuth\(\)/);
    assert.match(mcpService, /if \(lastAttempt\) \{\s*return Promise\.resolve\(lastAttempt\);/);
    assert.match(mcpService, /this\.remoteAuthReadiness\.get\(serverId\) !== true/);
    assert.match(mcpService, /hasCompletedMcpRemoteAuth\(remoteUrl\)/);
    assert.match(mcpService, /mergeMcpJsonFile\(path\.join\(homeDir, '\.cursor', 'mcp\.json'\), \{\}, removeServerIdSet\)/);
    assert.doesNotMatch(sshService, /await mcpSvc\.ensureConfiguredRemoteAuth\(\)/);
    assert.match(sshService, /await mcpSvc\.prepareConfiguredRemoteAuth\(\)/);
    assert.match(sshService, /MCP_REMOTE_AUTH_DIR_NAME/);
    assert.match(sshService, /getClaudeMcpSyncDataForSSH\(/);
    assert.match(sshService, /getHarnessMcpSyncDataForSSH\(/);
    assert.match(sshService, /cached\.fingerprint === fingerprint/);
    assert.doesNotMatch(codexService, /sshService\.(?:sync|schedule)Mcp(?:Auth|Configs)ToRemote/);
    assert.doesNotMatch(sshService, /versionEntries\.at\(-1\)/);

    console.log('MCP auth prewarm verification passed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
