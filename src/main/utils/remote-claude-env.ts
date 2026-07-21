const REMOTE_CLAUDE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'ENABLE_TOOL_SEARCH',
  'TERM',
  'LANG',
  // Parable is prepared locally, then its skill/config are copied to the SSH
  // host. These variables are the bridge between that prepared runtime and
  // the remote Claude Code meta-harness/executor scripts.
  'BUILD_PARABLE_MODE',
  'PARABLE_CONFIG',
  'PARABLE_SKILL_DIR',
  'CURSOR_API_KEY',
]);

export function filterRemoteClaudeEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => (
      value !== undefined && (REMOTE_CLAUDE_ENV_KEYS.has(key) || key.startsWith('PARABLE_'))
    )),
  ) as Record<string, string>;
}
