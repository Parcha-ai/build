import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CodexAgentMessageBuffer } from '../src/main/services/codex-agent-message-buffer';

const root = path.resolve(__dirname, '..');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

assert.match(
  codexService,
  /const agentMessages = new CodexAgentMessageBuffer\(\);/,
  'Codex adapter must buffer agent messages until turn completion',
);
assert.match(
  codexService,
  /const progressMessage = agentMessages\.accept\(event\.item\.text\);/,
  'Earlier Codex agent messages must become progress instead of permanent answer text',
);
assert.match(
  codexService,
  /if \(translated\.type === 'complete'\) \{\s*const finalMessage = agentMessages\.finalize\(\);/s,
  'Only the last Codex agent message must be finalized as assistant output',
);
assert.match(
  claudeService,
  /return sdkPermissionMode === 'bypassPermissions' \? 'bypassPermissions' : 'dontAsk';/,
  'Read-only Auto Build stages must preserve explicit bypass permission',
);
assert.match(
  claudeService,
  /detectRemoteCodexSandbox\(sessionId, session\.sshConfig\)/,
  'Sandboxed SSH verification must preflight Codex command execution',
);
assert.match(
  sshService,
  /codex sandbox -- \/bin\/true/,
  'Remote sandbox preflight must exercise Codex without making a model request',
);
assert.match(
  sshService,
  /REMOTE_CODEX_SANDBOX_TTL/,
  'Remote sandbox capability must be cached',
);

const messageBuffer = new CodexAgentMessageBuffer();
assert.equal(messageBuffer.accept('first progress update'), undefined);
assert.equal(messageBuffer.accept('second progress update'), 'first progress update');
assert.equal(messageBuffer.accept('final answer'), '\n\nsecond progress update');
assert.equal(messageBuffer.finalize(), 'final answer');
assert.equal(messageBuffer.finalize(), undefined);

console.log('Codex output and sandbox verifier passed');
