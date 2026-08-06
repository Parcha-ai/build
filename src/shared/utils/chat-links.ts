export type ChatLinkKind = 'anchor' | 'external' | 'local-editor' | 'local-artifact';

const EDITOR_EXTENSIONS = new Set([
  'bash', 'bmp', 'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'dockerfile', 'env',
  'gif', 'go', 'gql', 'graphql', 'h', 'hpp', 'htm', 'html', 'ico', 'ini',
  'java', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'less', 'log', 'md',
  'mdx', 'php', 'png', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql',
  'svg', 'svelte', 'swift', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue', 'webp',
  'xml', 'yaml', 'yml', 'zsh',
]);

function decodedHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

export function chatFilePathFromHref(href: string): string {
  const decoded = decodedHref(href.trim());
  if (!decoded.toLowerCase().startsWith('file://')) return decoded;
  try {
    const url = new URL(decoded);
    return decodeURIComponent(url.pathname);
  } catch {
    return decoded.replace(/^file:\/\//i, '');
  }
}

function extensionOf(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0].replace(/:\d+(?::\d+)?$/, '');
  const name = withoutQuery.split(/[\\/]/).pop() || withoutQuery;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function looksLikeLocalPath(value: string): boolean {
  return /^(?:file:\/\/|\/|\.\.?[\\/]|~[\\/]|[a-z]:[\\/])/i.test(value)
    || /[\\/]/.test(value)
    || Boolean(extensionOf(value));
}

export function classifyChatLink(href = '', linkText = ''): ChatLinkKind {
  const target = href.trim();
  if (target.startsWith('#')) return 'anchor';
  if (/^(?:https?:|mailto:|tel:)/i.test(target)) return 'external';
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(target)) return 'external';
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.toLowerCase().startsWith('file:')) {
    return 'external';
  }

  const fileCandidate = target || linkText.trim();
  if (!looksLikeLocalPath(fileCandidate)) return 'external';
  return EDITOR_EXTENSIONS.has(extensionOf(fileCandidate))
    ? 'local-editor'
    : 'local-artifact';
}
