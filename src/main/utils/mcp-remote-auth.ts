import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

export const MCP_REMOTE_PACKAGE_VERSION = '0.1.38';
export const MCP_REMOTE_PACKAGE = `mcp-remote@${MCP_REMOTE_PACKAGE_VERSION}`;
// The published 0.1.38 bundle still hard-codes `version2 = "0.1.37"` in its
// auth storage implementation. Keep this separate from the npm package pin so
// Build migrates and uploads credentials to the directory the proxy reads.
export const MCP_REMOTE_RUNTIME_AUTH_VERSION = '0.1.37';
export const MCP_REMOTE_AUTH_DIR_NAME = `mcp-remote-${MCP_REMOTE_RUNTIME_AUTH_VERSION}`;

function compareVersionDirectories(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

export async function hasCompletedMcpRemoteAuth(
  remoteUrl: string,
  authRoot = path.join(os.homedir(), '.mcp-auth'),
): Promise<boolean> {
  const prefix = createHash('md5').update(remoteUrl).digest('hex');
  const authDir = path.join(authRoot, MCP_REMOTE_AUTH_DIR_NAME);
  try {
    const [tokens, clientInfo] = await Promise.all([
      fs.readFile(path.join(authDir, `${prefix}_tokens.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.join(authDir, `${prefix}_client_info.json`), 'utf8').then(JSON.parse),
    ]);
    return Boolean(
      tokens
      && typeof tokens === 'object'
      && typeof tokens.access_token === 'string'
      && tokens.access_token.length > 0
      && clientInfo
      && typeof clientInfo === 'object'
      && typeof clientInfo.client_id === 'string'
      && clientInfo.client_id.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * mcp-remote isolates credentials by package version. Preserve completed OAuth
 * records across a pinned patch upgrade, but never copy lock files or partial
 * PKCE state that could resurrect an abandoned browser flow.
 */
export async function ensurePinnedMcpRemoteAuthDirectory(
  authRoot = path.join(os.homedir(), '.mcp-auth'),
): Promise<{ authDir: string; migratedFiles: number }> {
  const authDir = path.join(authRoot, MCP_REMOTE_AUTH_DIR_NAME);
  await fs.mkdir(authRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(authRoot, 0o700).catch(() => undefined);
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700).catch(() => undefined);

  const versions = (await fs.readdir(authRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^mcp-remote-\d/.test(entry.name) && entry.name !== MCP_REMOTE_AUTH_DIR_NAME)
    .map((entry) => entry.name)
    .sort(compareVersionDirectories)
    .reverse();

  let migratedFiles = 0;
  const migratedTokenPrefixes = new Set<string>();
  for (const version of versions) {
    const sourceDir = path.join(authRoot, version);
    const files = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
    const tokenFiles = files
      .filter((entry) => entry.isFile() && /^[0-9a-f]{32}_tokens\.json$/.test(entry.name))
      .map((entry) => entry.name);

    for (const tokenFile of tokenFiles) {
      const prefix = tokenFile.slice(0, -'tokens.json'.length);
      if (migratedTokenPrefixes.has(prefix)) continue;
      migratedTokenPrefixes.add(prefix);
      for (const suffix of ['tokens.json', 'client_info.json', 'scopes.json']) {
        const fileName = `${prefix}${suffix}`;
        const source = path.join(sourceDir, fileName);
        const destination = path.join(authDir, fileName);
        if (!(await pathExists(source)) || await pathExists(destination)) continue;
        await fs.copyFile(source, destination);
        await fs.chmod(destination, 0o600).catch(() => undefined);
        migratedFiles += 1;
      }
    }
  }

  return { authDir, migratedFiles };
}
