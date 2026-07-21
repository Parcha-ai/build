import assert from 'assert';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '../src/shared/types';
import {
  buildUnifiedHarnessContext,
  formatProjectInstructionContextFiles,
} from '../src/main/services/codex-context';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const terminalService = fs.readFileSync(path.join(root, 'src/main/services/terminal.service.ts'), 'utf8');
const harnessCapabilities = fs.readFileSync(path.join(root, 'src/main/services/harness-capabilities.ts'), 'utf8');
const messageQueueService = fs.readFileSync(path.join(root, 'src/main/services/message-queue.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');

assert.match(
  claudeService,
  /isManualCodexSelection = selectionMode === 'manual'/,
  'Codex route must identify manual Codex selection',
);
assert.match(
  claudeService,
  /isAutoBuildCodexSelection = selectionMode === 'auto'/,
  'Auto Build Codex must participate in native Codex thread continuity',
);
assert.match(
  claudeService,
  /usesNativeCodexThread = isManualCodexSelection \|\| isAutoBuildCodexSelection/,
  'native Codex thread continuity must cover both manual and Auto Build Codex',
);
assert.match(
  claudeService,
  /\$\{codexSelectionLabel\} selected after \$\{lastHarnessForCodex\}; starting fresh native Codex thread with Build handoff context/,
  'Codex must create a fresh native thread when switching from another harness',
);
assert.match(
  claudeService,
  /codexService\.clearThreadId\(sessionId\)/,
  'Codex handoff must clear any stale Codex thread before seeding a new one',
);
assert.match(
  claudeService,
  /\$\{codexSelectionLabel\} resuming native thread \$\{codexThreadId\}/,
  'Codex follow-ups must resume the native Codex thread',
);
assert.match(
  claudeService,
  /shouldBuildCodexContext = false/,
  'Codex native resume must not paste Build transcript context on every follow-up',
);
assert.match(
  claudeService,
  /includeCurrentCodexHistory = !codexThreadId/,
  'fresh Codex native threads must include prior Codex messages from the Build transcript',
);
assert.match(
  claudeService,
  /includeCurrentHarnessMessages: includeCurrentCodexHistory/,
  'Codex context builder must be told when to include current-harness history',
);
assert.match(
  claudeService,
  /currentHarness: options\.includeCurrentHarnessMessages \? undefined : currentHarness/,
  'unified context must stop excluding current-harness messages when no native thread is available',
);
assert.match(
  claudeService,
  /\{ resumeThreadId: codexThreadId, persistThread: usesNativeCodexThread \}/,
  'Codex must pass the native thread id and persist new native threads for manual and Auto Build routes',
);
assert.match(
  claudeService,
  /Auto Build Codex/,
  'Auto Build Codex continuity logs must be present for installed-build verification',
);
assert.match(
  claudeService,
  /codex:\s*\{\s*maxConversationChars: 120000,\s*maxProjectContextChars: 50000,\s*maxProjectContextFiles: 24,\s*maxFinalChars: 180000,/s,
  'Codex handoffs must preserve substantial recent context below the initial prompt safety budget',
);
assert.match(
  claudeService,
  /continuityContext: pinnedBuildContinuityContext/,
  'Codex handoffs must pin an extractive continuity checkpoint alongside raw history',
);

assert.match(
  codexService,
  /interface CodexNativeThreadOptions/,
  'Codex service must expose native thread options',
);
assert.match(
  codexService,
  /thread_id\?: string/,
  'Codex JSON event type must capture thread.started thread_id',
);
assert.match(
  codexService,
  /getThreadId\(sessionId: string\): string \| undefined/,
  'Codex service must allow callers to load a stored native thread id',
);
assert.match(
  codexService,
  /harnessState\.\$\{sessionId\}\.codexThreadId/,
  'Codex native thread id must be persisted in the session store',
);
assert.match(
  codexService,
  /args\.push\('resume', nativeThread\.resumeThreadId\)/,
  'local Codex CLI must use codex exec resume for native continuation',
);
assert.match(
  codexService,
  /codexArgs\.push\('resume', nativeThread\.resumeThreadId\)/,
  'remote Codex CLI must use codex exec resume for native continuation',
);
assert.match(
  codexService,
  /event\.type === 'thread\.started' && event\.thread_id/,
  'Codex service must observe thread.started events',
);
assert.match(
  codexService,
  /this\.rememberThreadId\(options\.sessionId, event\.thread_id\)/,
  'Codex service must persist the emitted native thread id',
);

assert.match(
  harnessCapabilities,
  /codex:\s+\{\s*supportsAsyncInjection: true,\s*supportsMultiTurn: true,/,
  'Codex must support live steering and persisted native thread continuation',
);
assert.match(
  messageQueueService,
  /setActiveHarness\(sessionId: string, harness\?: string\): void/,
  'queue service must allow Auto Build to replace the provisional auto/Claude harness with the resolved harness',
);
assert.match(
  claudeIpc,
  /messageQueueService\.setActiveHarness\(sessionId, resolvedHarness\)/,
  'IPC stream handling must update queue harness when Auto Build emits a resolved model',
);
assert.match(
  terminalService,
  /this\.store\.get\(`discoveredSessions\.\$\{sessionId\}`\)/,
  'Terminal creation must work for forked/discovered sessions, not only sessions stored under sessions',
);

const recentParableState = 'RECENT_PARABLE_STATE_MUST_SURVIVE_CODEX_HANDOFF';
const remoteProjectContext = formatProjectInstructionContextFiles([
  {
    label: 'project CLAUDE.md',
    filePath: '/repo/CLAUDE.md',
    content: `Important repository rules\n${'project instruction '.repeat(780)}`,
  },
  {
    label: 'user command: pr.md',
    filePath: '/home/test/.claude/commands/pr.md',
    content: 'secondary command context '.repeat(500),
  },
], { maxChars: 16000, maxFiles: 12 });
const parableMessages: ChatMessage[] = [
  {
    id: 'older-parable-work',
    role: 'assistant',
    content: `Earlier implementation details\n${'older working note '.repeat(1200)}`,
    timestamp: new Date('2026-07-13T23:30:00Z'),
    harness: 'claude',
  },
  {
    id: 'latest-parable-work',
    role: 'assistant',
    content: `${recentParableState}: fixes are staged and frontend tsc is still running.`,
    timestamp: new Date('2026-07-13T23:36:00Z'),
    harness: 'claude',
  },
];
const codexHandoff = buildUnifiedHarnessContext({
  messages: parableMessages,
  currentHarness: 'codex',
  additionalProjectContext: remoteProjectContext,
  includeProjectContext: false,
  maxConversationChars: 24000,
});
const firstManualCodexPrompt = `${codexHandoff}\n\nContinue from Parable and finish the work.`;
assert.ok(firstManualCodexPrompt.length < 240000, 'Parable -> Codex handoff must fit the expanded initial prompt budget');
assert.match(firstManualCodexPrompt, new RegExp(recentParableState));
assert.ok(
  firstManualCodexPrompt.indexOf('<project_harness_context>') < firstManualCodexPrompt.indexOf(recentParableState),
  'Recent Parable state must sit after broad project context so tail-preserving safety caps keep it',
);

console.log('manual native harness resume verifier passed');
