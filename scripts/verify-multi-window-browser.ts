import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const browserService = fs.readFileSync(path.join(root, 'src/main/services/browser.service.ts'), 'utf8');
const browserPreview = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreview.tsx'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const mainContent = fs.readFileSync(path.join(root, 'src/renderer/components/layout/MainContent.tsx'), 'utf8');
const rendererApp = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');

assert.match(
  browserService,
  /private sessionWebContents = new Map<string, number\[\]>\(\);/,
  'BrowserService must track multiple webviews per session for multi-window previews',
);
assert.match(browserService, /private getActiveWebContentsId\(sessionId: string\): number \| undefined \{/);
assert.match(browserService, /private rememberWebview\(sessionId: string, webContentsId: number, wc: Electron\.WebContents\): void \{/);
assert.match(browserService, /private forgetWebview\(sessionId: string, webContentsId\?: number\): void \{/);
assert.match(browserService, /ids\.push\(webContentsId\)/, 'new registrations must become the active webview for a session');
assert.match(browserService, /ids\.filter\(\(id\) => id !== webContentsId\)/, 'unregistering one webview must leave sibling window webviews registered');
assert.match(browserService, /const hadSessionBrowser = this\.hasSessionWebContents\(data\.sessionId\)/);
assert.match(browserService, /if \(!hadSessionBrowser\) \{[\s\S]*?cdpProxyService\.notifyNewTarget\(data\.sessionId\)/);
assert.match(browserService, /Notify CDP proxy only when the session has no visible browser left/);
assert.match(browserService, /cdpProxyService\.unregisterWebview\(sessionId, targetDestroyedId\)/);

const unregisterHandler = browserService.match(/ipcMain\.on\('browser:unregister-webview'[\s\S]*?\n {4}\}\);/)?.[0] || '';
assert.match(unregisterHandler, /webContentsId\?: number/);
assert.match(unregisterHandler, /this\.forgetWebview\(data\.sessionId, data\.webContentsId\)/);

assert.match(browserPreview, /const registeredWebContentsIdRef = useRef<number \| null>\(null\)/);
assert.match(browserPreview, /registeredWebContentsIdRef\.current = webContentsId/);
assert.match(browserPreview, /window\.electronAPI\.browser\.unregisterWebview\(session\.id, registeredWebContentsId \?\? undefined\)/);
assert.match(
  preload,
  /unregisterWebview: \(sessionId: string, webContentsId\?: number\) => \{[\s\S]*?ipcRenderer\.send\('browser:unregister-webview', \{ sessionId, webContentsId \}\);/,
  'preload must pass the mounted webContentsId when unregistering a browser preview',
);

assert.match(mainIndex, /label: 'New Window',[\s\S]*?accelerator: 'CommandOrControl\+Shift\+N',[\s\S]*?createNewWindow\(\)/);
assert.match(mainIndex, /function createNewWindow\(\): void \{[\s\S]*?webviewTag: true,[\s\S]*?win\.loadURL\(MAIN_WINDOW_WEBPACK_ENTRY\)/);

const mainContentBrowserPreviewRenders = mainContent.match(/<BrowserPreview key=\{browserTargetSession\.id\} session=\{browserTargetSession\} isVisible=\{true\} \/>/g) || [];
assert.equal(mainContentBrowserPreviewRenders.length, 1, 'full app windows must mount only the active related browser preview');
assert.match(mainContent, /const browserTargetSessionId = isCommandCenterActive/);
assert.match(mainContent, /enableSessionBrowser\(browserTargetSessionId\)/);

const browserOnlyPreviewRenders = rendererApp.match(/<BrowserPreview key=\{activeSessionForBrowser\.id\} session=\{activeSessionForBrowser\} isVisible=\{true\} \/>/g) || [];
assert.equal(browserOnlyPreviewRenders.length, 1, 'browser-only windows must also mount one active browser preview');

console.log('multi-window browser verifier passed');
