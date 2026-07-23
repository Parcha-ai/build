export interface CodexFileChange {
  kind: string;
  path: string;
  diff?: string;
}

const MAX_CODEX_FILE_CHANGE_DIFF_CHARS = 42_000;

/** Normalize app-server's FileUpdateChange[] and Codex's path-keyed patch map. */
export function normalizeCodexFileChanges(rawChanges: unknown): CodexFileChange[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(rawChanges)
    ? rawChanges.map((change) => [undefined, change])
    : rawChanges && typeof rawChanges === 'object'
      ? Object.entries(rawChanges as Record<string, unknown>)
      : [];

  return entries.flatMap(([keyedPath, rawChange]) => {
    if (!rawChange || typeof rawChange !== 'object') return [];
    const change = rawChange as Record<string, unknown>;
    const path = typeof change.path === 'string' ? change.path : keyedPath;
    if (!path) return [];
    const rawKind = typeof change.kind === 'string'
      ? change.kind
      : typeof change.type === 'string'
        ? change.type
        : 'update';
    const kind = rawKind === 'add' || rawKind === 'delete' || rawKind === 'update'
      ? rawKind
      : 'update';
    const diff = typeof change.diff === 'string'
      ? change.diff
      : typeof change.unified_diff === 'string'
        ? change.unified_diff
        : typeof change.unifiedDiff === 'string'
          ? change.unifiedDiff
          : undefined;
    return [{ kind, path, ...(diff ? { diff } : {}) }];
  });
}

/** Build's Edit card understands this shape for both one-file and batch edits. */
export function codexFileChangeToolInput(changes: CodexFileChange[]): Record<string, unknown> {
  let remainingDiffChars = MAX_CODEX_FILE_CHANGE_DIFF_CHARS;
  const rendererChanges: CodexFileChange[] = changes.map((change) => {
    if (!change.diff || remainingDiffChars <= 0) {
      return { kind: change.kind, path: change.path };
    }
    const diff = change.diff.length <= remainingDiffChars
      ? change.diff
      : `${change.diff.slice(0, Math.max(0, remainingDiffChars - 36))}\n... diff truncated by Build ...\n`;
    remainingDiffChars -= diff.length;
    return { ...change, diff };
  });
  const onlyChange = rendererChanges.length === 1 ? rendererChanges[0] : undefined;
  return {
    changes: rendererChanges,
    ...(onlyChange ? { file_path: onlyChange.path } : {}),
    ...(onlyChange?.diff ? { unified_diff: onlyChange.diff } : {}),
  };
}
