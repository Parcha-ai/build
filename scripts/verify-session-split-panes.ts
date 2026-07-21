import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const forkTabs = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ForkTabs.tsx'), 'utf8');
const mainContent = fs.readFileSync(path.join(root, 'src/renderer/components/layout/MainContent.tsx'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(root, 'src/renderer/stores/ui.store.ts'), 'utf8');

assert.match(forkTabs, /export const SESSION_TAB_DRAG_TYPE = 'application\/x-build-session-tab'/);
assert.match(forkTabs, /e\.dataTransfer\.setData\(SESSION_TAB_DRAG_TYPE, id\)/);

assert.match(uiStore, /const SESSION_SPLIT_PANES_KEY = 'grep-session-split-panes-v1'/);
assert.match(uiStore, /sessionSplitPaneIds: Record<string, string>/);
assert.match(uiStore, /setSessionSplitPane: \(groupId: string, sessionId: string \| null\) => void/);
assert.match(uiStore, /persistSessionSplitPanes\(sessionSplitPaneIds\)/);

assert.match(mainContent, /event\.clientX >= bounds\.left \+ bounds\.width \* 0\.55/);
assert.match(mainContent, /event\.dataTransfer\.getData\(SESSION_TAB_DRAG_TYPE\)/);
assert.match(mainContent, /getBrowserPartitionId\(droppedSession\.id, sessions\) !== activeSessionGroupId/);
assert.match(mainContent, /setSessionSplitPane\(activeSessionGroupId, droppedSession\.id\)/);
assert.match(mainContent, /Split right/);
assert.match(mainContent, /<ChatContainer session=\{activeSession\} \/>/);
assert.match(mainContent, /session=\{splitSession\}/);
assert.match(mainContent, /onClosePane=\{\(\) =>/);
assert.match(mainContent, /configuredSplitSessionId === activeSession\.id/);

assert.match(chatContainer, /onClosePane\?: \(\) => void/);
assert.match(chatContainer, /title="Close split pane"/);

console.log('session split pane verifier passed');
