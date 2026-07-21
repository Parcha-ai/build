import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { rankAutocompleteItems } from '../src/renderer/utils/autocomplete-ranking';

const ranked = rankAutocompleteItems([
  { name: 'pr-comments' },
  { name: 'pr-review' },
  { name: 'pr' },
  { name: 'git-pr' },
], 'pr');

assert.deepEqual(ranked.map((item) => item.name), ['pr', 'pr-comments', 'pr-review', 'git-pr']);
assert.equal(rankAutocompleteItems([{ name: 'review-pr' }, { name: 'pr' }], 'PR')[0].name, 'pr');

const root = path.resolve(__dirname, '..');
const autocomplete = fs.readFileSync(path.join(root, 'src/renderer/components/chat/CommandAutocomplete.tsx'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(root, 'src/renderer/stores/ui.store.ts'), 'utf8');
const browserPreview = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreview.tsx'), 'utf8');
const browserBoundary = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreviewBoundary.tsx'), 'utf8');

assert.match(autocomplete, /rankAutocompleteItems\(\[\.\.\.matchedCommands, \.\.\.matchedSkills\], lowerQuery\)/);
assert.doesNotMatch(browserPreview, /if \(isVisibleRef\.current\) webview\.focus\(\)/);
assert.doesNotMatch(browserPreview, /registerWebview\(session\.id, webContentsId, partitionName\);\s*webviewRef\.current\?\.focus\(\)/);
assert.match(browserPreview, /if \(webviewReady\) webviewRef\.current\?\.focus\(\)/);
assert.match(browserPreview, /if \(browserTabId \|\| !webviewReady\) return/);
assert.match(browserPreview, /isInspectorActive && webview && webviewReady/);
assert.match(browserBoundary, /getDerivedStateFromError/);
assert.match(browserBoundary, /Browser tab failed without crashing the app/);
assert.match(inputArea, /const composerTextDrafts = new Map<string, string>\(\)/);
assert.match(inputArea, /const \[message, setLocalMessage\] = useState/);
assert.match(inputArea, /lastIndexOf\('@'\)/);
assert.match(inputArea, /lastIndexOf\('\/'\)/);
assert.doesNotMatch(inputArea, /title="@ mention file"/);
assert.doesNotMatch(inputArea, /title="\/ slash commands/);
assert.doesNotMatch(inputArea, /title="Summarize & compact context"/);
assert.doesNotMatch(inputArea, /aria-label="Active background work"/);
assert.match(chatContainer, /<MonitorBlock/);
assert.doesNotMatch(inputArea, /state\.composerDrafts\[sessionId\]/);
assert.doesNotMatch(uiStore, /composerDrafts: Record<string, string>/);

console.log('input autocomplete verifier passed');
