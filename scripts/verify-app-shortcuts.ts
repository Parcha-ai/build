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

const fileMenuPomodoroItem = mainIndex.match(
  /label: 'Start Pomodoro',[\s\S]*?accelerator: 'CommandOrControl\+P',[\s\S]*?click: \(\) => pomodoroService\.show\(\),/
)?.[0] || '';
assert.ok(fileMenuPomodoroItem, 'Cmd+P menu item must open the Pomodoro workflow');

const viewMenuVoiceItem = mainIndex.match(
  /label: 'Toggle Voice Mode',[\s\S]*?accelerator: 'CommandOrControl\+Shift\+Y',[\s\S]*?sendAppShortcutToFocusedWindow\('toggle-voice-mode'\),/
)?.[0] || '';
assert.ok(viewMenuVoiceItem, 'Cmd+Shift+Y menu item must toggle app-level voice mode');

const mainShortcutBlock = mainIndex.match(/mainWindow\.webContents\.on\('before-input-event'[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(mainShortcutBlock, /key === 'y'[\s\S]*action = 'toggle-voice-mode'/);
assert.match(mainShortcutBlock, /input\.shift && key === 'n'[\s\S]*createNewWindow\(\)/);
assert.match(mainShortcutBlock, /key === 'n'[\s\S]*action = 'new-session'/);
assert.match(mainShortcutBlock, /key === 'p'[\s\S]*pomodoroService\.show\(\)/);

const secondaryWindowShortcutBlock = mainIndex.match(/win\.webContents\.on\('before-input-event'[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(secondaryWindowShortcutBlock, /key === 'y'[\s\S]*action = 'toggle-voice-mode'/);
assert.match(secondaryWindowShortcutBlock, /input\.shift && key === 'n'[\s\S]*createNewWindow\(\)/);
assert.match(secondaryWindowShortcutBlock, /key === 'n'[\s\S]*action = 'new-session'/);
assert.match(secondaryWindowShortcutBlock, /key === 'p'[\s\S]*pomodoroService\.show\(\)/);

const webviewShortcutBlocks = Array.from(
  mainIndex.matchAll(/webviewContents\.on\('before-input-event'[\s\S]*?webviewContents\.on\('did-finish-load'/g),
  (match) => match[0],
);
assert.ok(webviewShortcutBlocks.length >= 2, 'main and secondary windows must both forward webview-focused shortcuts');
for (const block of webviewShortcutBlocks) {
  assert.match(block, /keyDown'[\s\S]*k === 'y'[\s\S]*sendShortcutToRenderer\('toggle-voice-mode'\)/);
  assert.match(block, /primaryModifier && input\.shift && !input\.alt && k === 'n'[\s\S]*createNewWindow\(\)/);
  assert.match(block, /primaryModifier && !input\.shift && !input\.alt && k === 'p'[\s\S]*pomodoroService\.show\(\)/);
}

assert.match(rendererApp, /case 'new-session':[\s\S]*openNewSessionDialog\(\)/);
assert.match(rendererApp, /case 'toggle-voice-mode':[\s\S]*new CustomEvent\('grep-voice-toggle'\)/);
assert.match(rendererApp, /e\.code === 'KeyY'[\s\S]*new CustomEvent\('grep-voice-toggle'\)/);

console.log('app shortcuts verifier passed');
