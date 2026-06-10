import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const compactInputArea = fs.readFileSync(path.join(root, 'src/renderer/components/command-center/CompactInputArea.tsx'), 'utf8');
const browserPreview = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreview.tsx'), 'utf8');
const browserIpc = fs.readFileSync(path.join(root, 'src/main/ipc/browser.ipc.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const gitService = fs.readFileSync(path.join(root, 'src/main/services/git.service.ts'), 'utf8');
const sessionServiceMain = fs.readFileSync(path.join(root, 'src/main/services/session.service.ts'), 'utf8');
const sessionTitleService = fs.readFileSync(path.join(root, 'src/main/services/session-title.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sessionDisplay = fs.readFileSync(path.join(root, 'src/renderer/utils/session-display.ts'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const sessionCard = fs.readFileSync(path.join(root, 'src/renderer/components/session/SessionCard.tsx'), 'utf8');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/components/session/SessionList.tsx'), 'utf8');

const inputSessionEffect = inputArea.match(/\/\/ Load message history for the active tab\/session\.[\s\S]*?\n {2}\}, \[sessionId\]\);/)?.[0] || '';
assert.match(inputSessionEffect, /localStorage\.getItem\(`grep-history-\$\{sessionId\}`\)/);
assert.match(inputSessionEffect, /setMessage\(''\)/);
assert.match(inputSessionEffect, /setAttachments\(\[\]\)/);
assert.match(inputSessionEffect, /setShowMentions\(false\)/);
assert.match(inputSessionEffect, /setMentionQuery\(''\)/);
assert.match(inputSessionEffect, /setMentionStartIndex\(-1\)/);
assert.match(inputSessionEffect, /setShowCommands\(false\)/);
assert.match(inputSessionEffect, /setCommandQuery\(''\)/);
assert.match(inputSessionEffect, /setCommandStartIndex\(-1\)/);
assert.match(inputSessionEffect, /setShowHistory\(false\)/);
assert.match(inputSessionEffect, /setHistoryIndex\(-1\)/);

const compactResetEffect = compactInputArea.match(/useEffect\(\(\) => \{[\s\S]*?setInput\(''\);[\s\S]*?\n {2}\}, \[sessionId\]\);/)?.[0] || '';
assert.match(compactResetEffect, /setInput\(''\)/);
assert.match(compactResetEffect, /setShowCommands\(false\)/);
assert.match(compactResetEffect, /setCommandQuery\(''\)/);
assert.match(compactResetEffect, /setCommandStartIndex\(-1\)/);
assert.match(compactResetEffect, /textareaRef\.current\.style\.height = 'auto'/);

assert.match(browserPreview, /partition=\{`persist:browser-\$\{session\.id\}`\}/);
assert.match(browserPreview, /window\.electronAPI\.browser\.clearStorage\(session\.id\)/);
assert.match(preload, /clearStorage: \(sessionId\?: string\): Promise<\{ success: boolean \}> =>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.BROWSER_CLEAR_STORAGE, sessionId\)/);

const clearStorageHandler = browserIpc.match(/ipcMain\.handle\(IPC_CHANNELS\.BROWSER_CLEAR_STORAGE[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(clearStorageHandler, /sessionId\?: string/);
assert.match(clearStorageHandler, /sessionId \? `persist:browser-\$\{sessionId\}` : 'persist:browser'/);
assert.match(clearStorageHandler, /electronSession\.fromPartition\(partitionName\)/);
assert.match(clearStorageHandler, /storages: \['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'\]/);
assert.doesNotMatch(clearStorageHandler, /sessionstorage/);

const browserCleanup = mainIndex.match(/const BROWSER_PARTITION_PREFIX[\s\S]*?async function cleanupOldBrowserPartitions\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] || '';
assert.match(browserCleanup, /const BROWSER_PARTITION_PREFIX = 'browser-'/);
assert.match(browserCleanup, /const BROWSER_PARTITION_KEEP_COUNT = 32/);
assert.match(browserCleanup, /const BROWSER_PARTITION_RECENT_MS = 6 \* 60 \* 60 \* 1000/);
assert.match(browserCleanup, /setTimeout\(\(\) => \{[\s\S]*?void cleanupOldBrowserPartitions\(\);[\s\S]*?\}, 30_000\)/);
assert.match(browserCleanup, /entry\.name\.startsWith\(BROWSER_PARTITION_PREFIX\)/);
assert.match(browserCleanup, /sorted\.slice\(0, BROWSER_PARTITION_KEEP_COUNT\)/);
assert.match(browserCleanup, /now - entry\.mtimeMs < BROWSER_PARTITION_RECENT_MS/);
assert.match(browserCleanup, /fs\.promises\.rm\(entry\.fullPath, \{ recursive: true, force: true \}\)/);
assert.match(mainIndex, /createWindow\(\);[\s\S]*?scheduleBrowserPartitionCleanup\(\);/);

const getStatusMethod = gitService.match(/async getStatus\(sessionId: string\): Promise<\{[\s\S]*?\n {2}async getLog/)?.[0] || '';
assert.match(getStatusMethod, /const worktreePath = session\?\.worktreePath \|\| session\?\.repoPath/);
assert.match(getStatusMethod, /if \(!worktreePath \|\| !fs\.existsSync\(worktreePath\)\) \{/);
assert.match(getStatusMethod, /current: session\?\.branch \|\| null/);
assert.match(getStatusMethod, /files: \[\]/);
assert.match(getStatusMethod, /ahead: 0/);
assert.match(getStatusMethod, /behind: 0/);
assert.match(getStatusMethod, /const git = simpleGit\(worktreePath\)/);

assert.match(sessionDisplay, /const BAD_SESSION_NAMES = new Set/);
assert.match(sessionDisplay, /'this'/);
assert.match(sessionDisplay, /function fallbackNameFromPath\(session: Session\): string \| null/);
assert.match(sessionDisplay, /session\.worktreePath \|\| session\.repoPath/);
assert.match(sessionDisplay, /return candidates\.find\(\(candidate\) => candidate && !isBadSessionName\(candidate\)\)\s*\|\| session\.id\.slice\(0, 8\)/);
assert.match(chatContainer, /getSessionDisplayName\(session\)/);
assert.match(sessionCard, /displayName \|\| getSessionDisplayName\(session\)/);
assert.match(sessionList, /getSidebarSessionDisplayName/);

assert.match(sessionTitleService, /export function hasExistingSessionTitle\(sessionId: string, session\?: Session \| null\): boolean/);
assert.match(sessionTitleService, /export function rememberAutoSessionTitle\(sessionId: string, title: string, source: string\): string \| null/);
assert.match(sessionTitleService, /CONTINUATION_ONLY_MESSAGE_RE/);
assert.match(sessionTitleService, /Do not copy the user request or its first sentence verbatim/);
assert.match(sessionTitleService, /new CachedStore\(\{ name: getSessionStoreName\(\) \}\)/);
assert.match(sessionServiceMain, /pendingNameGenerationSessionIds = new Set<string>\(\)/);
assert.match(sessionServiceMain, /hasExistingSessionTitle\(sessionId\)/);
assert.match(sessionServiceMain, /rememberAutoSessionTitle\(sessionId, title, 'first-user-message'\)/);
assert.match(claudeService, /Only call this when the session does not already have a useful name/);
assert.match(claudeService, /hasExistingSessionTitle\(sessionId, currentSession\)/);
assert.match(claudeService, /rememberAutoSessionTitle\(sessionId, sanitizedName, 'claude-tool'\)/);
assert.match(claudeService, /rememberAutoSessionTitle\(sessionId, summary, 'sdk-summary'\)/);
assert.doesNotMatch(claudeService, /Auto-generate session name from task/);
assert.doesNotMatch(claudeService, /Could not auto-generate tab name/);

console.log('session hygiene verifier passed');
