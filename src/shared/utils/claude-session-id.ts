// Claude Code conversation ids emitted by the Agent SDK are UUIDs. Build also
// persists the string "new" as a UI/storage sentinel for an SSH session that
// has not started a native conversation yet. Keep that sentinel (and any other
// malformed value) out of every --resume / forkSession boundary.
const CLAUDE_SDK_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeClaudeSdkSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return CLAUDE_SDK_SESSION_ID_RE.test(normalized) ? normalized : undefined;
}

export function isClaudeSdkSessionId(value: unknown): value is string {
  return normalizeClaudeSdkSessionId(value) !== undefined;
}
