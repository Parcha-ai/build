import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const terminalService = fs.readFileSync(path.join(root, 'src/main/services/terminal.service.ts'), 'utf8');
const harnessCapabilities = fs.readFileSync(path.join(root, 'src/main/services/harness-capabilities.ts'), 'utf8');

assert.match(
  claudeService,
  /isManualCodexSelection = selectionMode === 'manual'/,
  'Codex native thread mode must be limited to manual Codex selection',
);
assert.match(
  claudeService,
  /Manual Codex selected after \$\{lastHarnessForCodex\}; starting fresh native Codex thread with Build handoff context/,
  'manual Codex must create a fresh native thread when switching from another harness',
);
assert.match(
  claudeService,
  /codexService\.clearThreadId\(sessionId\)/,
  'manual Codex handoff must clear any stale Codex thread before seeding a new one',
);
assert.match(
  claudeService,
  /Manual Codex resuming native thread \$\{codexThreadId\}/,
  'manual Codex follow-ups must resume the native Codex thread',
);
assert.match(
  claudeService,
  /shouldBuildCodexContext = false/,
  'manual Codex native resume must not paste Build transcript context on every follow-up',
);
assert.match(
  claudeService,
  /\{ resumeThreadId: codexThreadId, persistThread: isManualCodexSelection \}/,
  'manual Codex must pass the native thread id and persist new native threads',
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
  /this\.rememberThreadId\(sessionId, event\.thread_id\)/,
  'Codex service must persist the emitted native thread id',
);

assert.match(
  harnessCapabilities,
  /codex:\s+\{\s*supportsAsyncInjection: false,\s*supportsMultiTurn: true,/,
  'Codex must be modeled as sequentially multi-turn now that native thread resume is persisted',
);
assert.match(
  terminalService,
  /this\.store\.get\(`discoveredSessions\.\$\{sessionId\}`\)/,
  'Terminal creation must work for forked/discovered sessions, not only sessions stored under sessions',
);

console.log('manual native harness resume verifier passed');
