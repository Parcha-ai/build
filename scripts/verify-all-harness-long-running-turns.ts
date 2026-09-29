import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const ssh = read('src/main/services/ssh.service.ts');
const claude = read('src/main/services/claude.service.ts');
const codex = read('src/main/services/codex.service.ts');
const cursorSdk = read('src/main/services/cursor.service.ts');
const cursorCli = read('src/main/services/cursor-cli.service.ts');
const gemini = read('src/main/services/gemini.service.ts');
const opencode = read('src/main/services/opencode.service.ts');

for (const harness of ['claude', 'codex', 'cursor', 'gemini', 'opencode']) {
  assert.match(
    ssh,
    new RegExp(`RECOVERABLE_BRIDGE_COMMANDS[^;]+['"]${harness}['"]`),
    `${harness} must be registered for detached SSH recovery`,
  );
}

for (const [name, source] of [
  ['Cursor CLI', cursorCli],
  ['Gemini', gemini],
  ['OpenCode', opencode],
] as const) {
  assert.doesNotMatch(source, /spawn\(['"]ssh['"]/, `${name} must not use connection-owned raw SSH`);
  assert.match(source, /createDetachedCommandProcess\(/, `${name} SSH turns must use the detached bridge`);
  assert.match(source, /requireDetached:\s*true/, `${name} must fail closed instead of degrading to raw SSH`);
  assert.match(source, /replayDetachedAsChat\(/, `${name} must provide a recovery log parser`);
}

for (const command of ['cursor', 'gemini', 'opencode']) {
  assert.match(
    claude,
    new RegExp(`bridgeCommand === ['"]${command}['"]`),
    `${command} recovery must be dispatched by the shared remote-turn resume path`,
  );
}

assert.match(
  codex,
  /responseTurnId[\s\S]*rootTurnId[\s\S]*notificationTurnId !== rootTurnId/,
  'Codex recovery must ignore delegated child-turn terminal events just like the live stream',
);

assert.match(cursorSdk, /Agent\.resume\(persisted\.agentId/, 'Cursor SDK agents must resume after app restart');
assert.match(cursorSdk, /Agent\.getRun\(persisted\.activeRunId/, 'Cursor SDK must recover the persisted active run');
assert.match(cursorSdk, /await recoveredRun\.wait\(\)/, 'Cursor SDK must wait for the real run terminal state');
assert.match(cursorSdk, /activeRunId:\s*state\.activeRun\.id/, 'Cursor SDK active run IDs must be persisted');
assert.match(
  cursorSdk,
  /if \(!state\.activeRun \|\| state\.activeRun\.status !== ['"]running['"]\) state\.agent\.close\(\)/,
  'app shutdown must not explicitly close an active recoverable Cursor SDK run',
);

assert.match(
  ssh,
  /recoveryCommand:\s*options\.recoveryCommand/,
  'bridge config must retain recovery identity separately from its executable',
);
assert.match(
  ssh,
  /command:\s*bridge\.recoveryCommand \|\| bridge\.command/,
  'safe bridge metadata must expose the harness recovery identity',
);

console.log('All-harness long-running turn verifier passed');
