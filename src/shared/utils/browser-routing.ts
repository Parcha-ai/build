export const DEFAULT_IN_APP_BROWSER_URL_PATTERNS = [
  '*.m.parcha.dev*',
  'localhost:*',
  '127.0.0.1:*',
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Match a URL against user-friendly, scheme-optional wildcard patterns. */
export function shouldOpenUrlInAppBrowser(
  rawUrl: string,
  patterns: string[] = DEFAULT_IN_APP_BROWSER_URL_PATTERNS,
): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  const normalized = /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(trimmed)
    ? `http://${trimmed}`
    : trimmed;

  let candidates = [trimmed, normalized];
  try {
    const url = new URL(normalized);
    const schemeLess = `${url.host}${url.pathname}${url.search}${url.hash}`;
    candidates = [...candidates, url.href, schemeLess, `${url.hostname}${url.pathname}${url.search}${url.hash}`];
  } catch {
    return false;
  }

  return patterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .some((pattern) => {
      try {
        const matcher = globToRegExp(pattern);
        return candidates.some((candidate) => matcher.test(candidate));
      } catch {
        return false;
      }
    });
}
