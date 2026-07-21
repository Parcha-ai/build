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
const browserSessionTab = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserSessionTab.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(root, 'src/renderer/stores/ui.store.ts'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const browserIpc = fs.readFileSync(path.join(root, 'src/main/ipc/browser.ipc.ts'), 'utf8');
const cdpProxy = fs.readFileSync(path.join(root, 'src/main/services/cdp-proxy.service.ts'), 'utf8');
const stagehand = fs.readFileSync(path.join(root, 'src/main/services/stagehand.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getBrowserPartitionId, getBrowserPartitionName } = require('../src/shared/utils/browser-partition') as typeof import('../src/shared/utils/browser-partition');

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
assert.match(browserService, /private sessionPartitions = new Map<string, string>\(\);/);
assert.match(browserService, /getPartitionName\(sessionId: string\): string/);
assert.match(browserService, /data\.partitionName \|\| `persist:browser-\$\{data\.sessionId\}`/);

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
assert.match(preload, /registerWebview: \(sessionId: string, webContentsId: number, partitionName\?: string\)/);
assert.match(preload, /\{ sessionId, webContentsId, partitionName \}/);

assert.match(mainIndex, /label: 'New Window',[\s\S]*?accelerator: 'CommandOrControl\+Shift\+N',[\s\S]*?createNewWindow\(\)/);
assert.match(mainIndex, /function createNewWindow\(\): void \{[\s\S]*?webviewTag: true,[\s\S]*?win\.loadURL\(MAIN_WINDOW_WEBPACK_ENTRY\)/);
const guestPopupHandlers = [...mainIndex.matchAll(/webviewContents\.setWindowOpenHandler\([\s\S]*?return \{ action: 'deny' \};/g)];
assert.equal(guestPopupHandlers.length, 2, 'both main-window variants must configure guest popup handling');
for (const [handler] of guestPopupHandlers) {
  assert.doesNotMatch(
    handler,
    /partition:\s*'persist:browser'/,
    'OAuth popups must inherit the originating Build-session partition',
  );
  assert.match(handler, /session:\s*webviewContents\.session/);
}
assert.match(mainIndex, /webviewContents\.session\.setPermissionRequestHandler/);

assert.match(mainContent, /const mountedBrowserTabs = useMemo/);
assert.match(mainContent, /const activeBrowserPartitionId = useMemo/);
assert.match(mainContent, /const browserTabsForPartition = useMemo\(\(\) => mountedBrowserTabs\.filter/);
assert.match(mainContent, /tab\.partitionId === activeBrowserPartitionId/);
assert.match(mainContent, /activeBrowserTabIdsByPartition\[activeBrowserPartitionId\]/);
assert.match(mainContent, /Each root Build session\/fork family owns an independent browser tab group/);
assert.doesNotMatch(mainContent, /conversationBrowserTabs|Browser tabs mirror the visible chat\/session tabs/);
assert.match(mainContent, /\{browserTabsForPartition\.map\(\(tab\) =>/);
assert.doesNotMatch(mainContent, /\{mountedBrowserTabs\.map\(\(tab\) =>/, 'the main window must not mount saved tabs from inactive sessions');
assert.match(mainContent, /\{activeBrowserTab && activeBrowserOwnerSession \? \(/);
assert.match(mainContent, /isVisible=\{true\}/);
assert.match(mainContent, /partitionId=\{activeBrowserTab\.partitionId\}/);
assert.match(mainContent, /browserTabId=\{activeBrowserTab\.id\}/);
assert.match(mainContent, /createBrowserTab\(session\.id, partitionId, url\)/);
assert.match(mainContent, /<BrowserSessionTab/);
assert.match(browserSessionTab, /tab\.name/);
assert.match(browserSessionTab, /Double-click to rename browser tab/);
assert.match(browserSessionTab, /renameBrowserTab\(tab\.id, draft\)/);
assert.match(browserSessionTab, /closeBrowserTab\(tab\.id\)/);

assert.match(rendererApp, /\{browserTabsForPartition\.map\(\(tab\) =>/);
assert.doesNotMatch(rendererApp, /\{mountedBrowserTabs\.map\(\(tab\) =>/, 'the pop-out window must not restore every saved tab as a live webview');
assert.match(rendererApp, /session=\{activeBrowserOwnerSession\}/);
assert.match(rendererApp, /isVisible=\{true\}/);
assert.match(rendererApp, /activeBrowserTabIdsByPartition\[activeBrowserPartitionId\]/);
assert.match(rendererApp, /partitionId=\{activeBrowserTab\.partitionId\}/);
assert.match(rendererApp, /<BrowserSessionTab/);

assert.match(uiStore, /export interface BrowserWorkspaceTab/);
assert.match(uiStore, /const BROWSER_WORKSPACE_KEY = 'grep-browser-workspace-v1'/);
assert.match(uiStore, /activeBrowserTabIdsByPartition: Record<string, string>/);
assert.match(uiStore, /activeTabIdsByPartition\[activeTab\.partitionId\] = activeTab\.id/);
assert.match(uiStore, /createBrowserTab: \(ownerSessionId, partitionId, url, name\) =>/);
assert.match(uiStore, /\[partitionId\]: id/);
assert.match(uiStore, /setActiveBrowserTab: \(tabId\) =>/);
assert.match(uiStore, /\[tab\.partitionId\]: tabId/);
assert.match(uiStore, /closeBrowserTab: \(tabId\) =>/);
assert.doesNotMatch(uiStore, /composerDrafts: Record<string, string>/);
assert.match(inputArea, /const composerTextDrafts = new Map<string, string>\(\)/);
assert.match(inputArea, /setLocalMessage\(\(current\) =>/);
assert.doesNotMatch(inputArea, /state\.composerDrafts\[sessionId\]/);
assert.match(inputArea, /const composerAttachmentDrafts = new Map<string, Attachment\[\]>\(\)/);
assert.match(inputArea, /composerAttachmentDrafts\.get\(sessionId\)/);
const historyLoadEffect = inputArea.match(/\/\/ Load message history for the active tab\/session\.[\s\S]*?\/\/ Close history dropdown/)?.[0] || '';
assert.doesNotMatch(historyLoadEffect, /setMessage\(''\)/, 'switching chat tabs must not clear composer drafts');

assert.match(browserPreview, /partitionId\?: string/);
assert.match(browserPreview, /browserTabId\?: string/);
assert.match(browserPreview, /onBrowserUrlChange\?: \(url: string\) => void/);
assert.match(browserPreview, /const partitionName = `persist:browser-\$\{partitionId \|\| session\.id\}`/);
assert.match(browserPreview, /partition=\{partitionName\}/);
assert.match(browserPreview, /registerWebview\(session\.id, webContentsId, partitionName\)/);
assert.match(browserPreview, /if \(!isVisible \|\| !webviewReady\) return/);
assert.match(browserPreview, /browserTabId && !isVisibleRef\.current/);

for (const [name, source] of [
  ['browser IPC', browserIpc],
  ['CDP proxy', cdpProxy],
  ['Stagehand', stagehand],
  ['Claude service', claudeService],
] as const) {
  assert.match(source, /browserService\.getPartitionName\(/, `${name} must use the registered family partition`);
}

const sessions = [
  { id: 'root', parentSessionId: undefined },
  { id: 'fork-a', parentSessionId: 'root' },
  { id: 'fork-b', parentSessionId: 'fork-a' },
  { id: 'other', parentSessionId: undefined },
] as import('../src/shared/types').Session[];
assert.equal(getBrowserPartitionId('root', sessions), 'root');
assert.equal(getBrowserPartitionId('fork-a', sessions), 'root');
assert.equal(getBrowserPartitionId('fork-b', sessions), 'root');
assert.equal(getBrowserPartitionId('other', sessions), 'other');
assert.equal(getBrowserPartitionName(getBrowserPartitionId('fork-a', sessions)), 'persist:browser-root');

console.log('multi-window browser verifier passed');
