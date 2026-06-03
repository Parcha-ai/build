import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const rendererApp = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');

const fileMenuNewSessionItem = mainIndex.match(
  /label: 'New Session',[\s\S]*?accelerator: 'CommandOrControl\+N',[\s\S]*?click: \(\) => sendAppShortcutToFocusedWindow\('new-session'\),/
)?.[0] || '';
assert.ok(fileMenuNewSessionItem, 'Cmd+N menu item must open the New Session dialog through the renderer shortcut bridge');
assert.doesNotMatch(fileMenuNewSessionItem, /createNewWindow\(/);

const fileMenuNewWindowItem = mainIndex.match(
  /label: 'New Window',[\s\S]*?accelerator: 'CommandOrControl\+Shift\+N',[\s\S]*?click: \(\) => createNewWindow\(\),/
)?.[0] || '';
assert.ok(fileMenuNewWindowItem, 'Cmd+Shift+N menu item must create a new app window');

const mainShortcutBlock = mainIndex.match(/mainWindow\.webContents\.on\('before-input-event'[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(mainShortcutBlock, /input\.shift && key === 'n'[\s\S]*createNewWindow\(\)/);
assert.match(mainShortcutBlock, /key === 'n'[\s\S]*action = 'new-session'/);

const secondaryWindowShortcutBlock = mainIndex.match(/win\.webContents\.on\('before-input-event'[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(secondaryWindowShortcutBlock, /input\.shift && key === 'n'[\s\S]*createNewWindow\(\)/);
assert.match(secondaryWindowShortcutBlock, /key === 'n'[\s\S]*action = 'new-session'/);

const webviewShortcutBlocks = Array.from(
  mainIndex.matchAll(/webviewContents\.on\('before-input-event'[\s\S]*?webviewContents\.on\('did-finish-load'/g),
  (match) => match[0],
);
assert.ok(webviewShortcutBlocks.length >= 2, 'main and secondary windows must both forward webview-focused shortcuts');
for (const block of webviewShortcutBlocks) {
  assert.match(block, /primaryModifier && input\.shift && !input\.alt && k === 'n'[\s\S]*createNewWindow\(\)/);
}

assert.match(rendererApp, /case 'new-session':[\s\S]*openNewSessionDialog\(\)/);

console.log('app shortcuts verifier passed');
