import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const browserService = fs.readFileSync(path.join(root, 'src/main/services/browser.service.ts'), 'utf8');
const browserPreview = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreview.tsx'), 'utf8');

assert.match(
  browserService,
  /private pendingNavigations = new Map<string, string>\(\);/,
  'BrowserService must retain navigation requests that arrive before a webview registers',
);
assert.match(
  browserService,
  /const pendingUrl = this\.pendingNavigations\.get\(data\.sessionId\);[\s\S]*?this\.pendingNavigations\.delete\(data\.sessionId\);[\s\S]*?this\.navigate\(data\.sessionId, pendingUrl\)/,
  'webview registration must replay the pending URL for that session',
);
assert.match(
  browserService,
  /if \(!this\.hasSessionWebContents\(sessionId\)\) \{[\s\S]*?this\.pendingNavigations\.set\(sessionId, url\);[\s\S]*?win\.webContents\.send\('browser:navigate', \{ sessionId, url \}\);[\s\S]*?return;/,
  'navigate must queue session-scoped URLs instead of dropping or routing them to another session',
);
assert.doesNotMatch(
  browserService,
  /Navigate called but no browser panels registered yet\. Ignoring\./,
  'navigate must not silently ignore URLs before browser registration',
);

assert.match(
  browserPreview,
  /function normalizeBrowserUrl\(targetUrl: string\): string \{/,
  'BrowserPreview must normalize user and IPC URLs consistently',
);
assert.match(
  browserPreview,
  /if \(!session\.lastBrowserUrl\) return;[\s\S]*?const nextUrl = normalizeBrowserUrl\(session\.lastBrowserUrl\);[\s\S]*?navigate\(nextUrl\);/,
  'BrowserPreview must react to lastBrowserUrl changes while mounted',
);
assert.match(
  browserPreview,
  /const currentUrlRef = useRef<string>\(url\);/,
  'BrowserPreview must keep current URL in a ref for external URL sync checks',
);
assert.match(
  browserPreview,
  /if \(!nextUrl \|\| nextUrl === currentUrlRef\.current\) return;/,
  'BrowserPreview external URL sync must compare against currentUrlRef',
);
assert.match(
  browserPreview,
  /}, \[session\.id, session\.lastBrowserUrl\]\);/,
  'BrowserPreview external URL sync must not depend on local url changes',
);

console.log('browser pending navigation verifier passed');
