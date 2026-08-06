const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_OSC_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\][^${ANSI_BELL}${ANSI_ESCAPE}]*(?:${ANSI_BELL}|${ANSI_ESCAPE}\\\\)`,
  'g',
);
const ANSI_CSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function stripTerminalControlSequences(value: string): string {
  return value.replace(ANSI_OSC_PATTERN, '').replace(ANSI_CSI_PATTERN, '');
}

/**
 * Worktree setup scripts sometimes print a human label on their final line
 * (for example `Worktree: /srv/repo`) instead of a bare `pwd`. Treating that
 * display string as a cwd makes every remote harness fail to launch.
 */
export function normalizeRemoteWorkdir(value: string | undefined): string {
  if (!value) return '';

  let normalized = stripTerminalControlSequences(value)
    .trim()
    .replace(/^(?:worktree|working\s+directory|work(?:ing)?\s*dir|cwd|directory)\s*:\s*/i, '')
    .trim();

  if (
    normalized.length >= 2
    && ((normalized.startsWith("'") && normalized.endsWith("'"))
      || (normalized.startsWith('"') && normalized.endsWith('"')))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}
