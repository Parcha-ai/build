import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const channels = read('src/shared/constants/channels.ts');
const browserIpc = read('src/main/ipc/browser.ipc.ts');
const preload = read('src/main/preload.ts');
const app = read('src/renderer/App.tsx');
const browserPreview = read('src/renderer/components/preview/BrowserPreview.tsx');
const inputArea = read('src/renderer/components/chat/InputArea.tsx');

assert.match(channels, /BROWSER_CHAT_INSERT: 'browser:chat-insert'/);
assert.match(browserIpc, /ipcMain\.on\(IPC_CHANNELS\.BROWSER_CHAT_INSERT/);
assert.match(browserIpc, /BrowserWindow\.getAllWindows\(\)/);
assert.match(browserIpc, /rendererUrl\.includes\('mode=browser'\)/);
assert.match(browserIpc, /win\.webContents\.send\(IPC_CHANNELS\.BROWSER_CHAT_INSERT, payload\)/);

assert.match(preload, /sendChatInsert: \(payload: BrowserChatInsertPayload\)/);
assert.match(preload, /onChatInsert: \(callback: \(payload: BrowserChatInsertPayload\) => void\)/);
assert.match(app, /window\.electronAPI\.browser\.onChatInsert/);
assert.match(app, /getBrowserPartitionId\(sourceSession\.id, sessionState\.sessions\)/);
assert.match(app, /getBrowserPartitionId\(visibleSession\.id, sessionState\.sessions\)/);
assert.match(app, /detail: \{ \.\.\.payload, sessionId: targetSessionId \}/);

const chatInsertCalls = browserPreview.match(/window\.electronAPI\.browser\.sendChatInsert\(/g) || [];
assert.equal(chatInsertCalls.length, 3, 'viewport, element, and region screenshots must use cross-window composer routing');
assert.doesNotMatch(
  browserPreview,
  /dispatchEvent\(new CustomEvent\('grep-insert-chat'/,
  'browser previews must not dispatch screenshot attachments only inside their own renderer window',
);
assert.match(browserPreview, /const image = await webview\.capturePage\(\)/);
assert.match(browserPreview, /screenshot: base64/);
assert.match(inputArea, /type: 'image',[\s\S]*?name: 'screenshot\.png',[\s\S]*?content: screenshot/);

console.log('browser screenshot routing verifier passed');
