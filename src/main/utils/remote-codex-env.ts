const REMOTE_CODEX_ENV_KEYS = new Set([
  // Build-managed provider credentials. The remote process otherwise keeps
  // the SSH login's own environment and native Codex authentication.
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'CODEX_SDK_ORIGINATOR',
]);

/**
 * Keep local desktop identity and filesystem variables out of remote Codex.
 * In particular, forwarding HOME/CODEX_HOME/PATH/TMPDIR makes the Linux CLI
 * try to read macOS paths before app-server can create its stdin bridge.
 */
export function filterRemoteCodexEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => (
      value !== undefined
      && (REMOTE_CODEX_ENV_KEYS.has(key) || key.startsWith('BUILD_META_'))
    )),
  ) as Record<string, string>;
}
