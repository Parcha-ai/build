import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const bridgeService = fs.readFileSync(path.join(root, 'src/main/services/mcp-stdio-bridge.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');

assert.match(
  codexService,
  /developerInstructions: nativeThread\.developerInstructions/,
  'native Codex thread start/resume must use the app-server developer-instruction layer',
);
assert.match(
  codexService,
  /codexDeveloperInstructions[\s\S]*?threadId[\s\S]*?CODEX_DEVELOPER_INSTRUCTIONS_VERSION/,
  'native Codex instruction seeding must be persisted and versioned per thread',
);
assert.match(
  codexService,
  /Reusing native thread developer instructions/,
  'resumed native Codex turns must reuse their seeded instruction layer',
);
assert.match(
  codexService,
  /if \(nativeThread\?\.persistThread\) \{[\s\S]*?void sshService\.syncMcpConfigsToRemote/,
  'persistent native Codex turns must schedule remote MCP sync without awaiting it',
);
assert.match(
  codexService,
  /else \{[\s\S]*?promptWithInstructions = await this\.prependCodexInstructionContext/,
  'one-off Codex calls must retain prompt-level project instructions',
);

assert.match(
  claudeService,
  /includeProjectInstructionContext: !usesNativeCodexThread/,
  'native Codex handoffs must omit project instructions from user-turn context',
);
assert.match(
  claudeService,
  /includeProjectContext: options\.includeProjectInstructionContext === false[\s\S]*?\? false/,
  'local and SSH native Codex handoffs must both omit duplicate prompt-level project context',
);
assert.match(
  claudeService,
  /includeDefaultOutputContext: !usesNativeCodexThread/,
  'native Codex handoffs must omit stable harness output instructions from user-turn context',
);
assert.match(
  claudeService,
  /stableCodexDeveloperInstructions[\s\S]*?developerInstructions: usesNativeCodexThread/,
  'stable app-owned harness instructions must be supplied as native developer instructions',
);

assert.match(
  claudeService,
  /sessionTurnLocks: Map<string, \{[^}]*owner: symbol/,
  'turn locks must identify the owning visible send, not only a shared holder label',
);
assert.match(
  claudeService,
  /while \(existing\)[\s\S]*?existing\.owner === owner[\s\S]*?existing = this\.sessionTurnLocks\.get\(sessionId\)/,
  'turn-lock waiters must re-check ownership after every prior release',
);
assert.doesNotMatch(
  claudeService,
  /existing\.holder === holder/,
  'two independent streamMessage calls must not be treated as reentrant merely because their labels match',
);
assert.match(
  claudeIpc,
  /const turnLockOwner = Symbol\('claude-ipc-send-message'\)/,
  'each IPC send must create a unique turn-lock owner',
);
assert.match(
  claudeIpc,
  /streamMessage\([^;]*turnLockOwner\)/s,
  'IPC retries for one visible send must reuse its turn-lock owner',
);

assert.match(
  bridgeService,
  /startupError\?: Error/,
  'stdio bridge state must retain failures emitted before readiness listeners attach',
);
assert.match(
  bridgeService,
  /if \(bridge\.startupError\) \{\s*throw bridge\.startupError;/,
  'stdio bridge readiness must fail immediately after an early spawn error',
);
assert.match(
  bridgeService,
  /removeListener\('exit', handleExit\)[\s\S]*?removeListener\('error', handleError\)/,
  'stdio bridge startup listeners must be cleaned up after settling',
);

console.log('agent fast-resume verifier passed');
