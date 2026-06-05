import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const cursorCliService = fs.readFileSync(path.join(root, 'src/main/services/cursor-cli.service.ts'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

const sshBranchStart = cursorCliService.indexOf('if (sshConfig) {');
const localBranchStart = cursorCliService.indexOf('} else {', sshBranchStart);
assert.ok(sshBranchStart >= 0, 'Cursor CLI must have an SSH branch');
assert.ok(localBranchStart > sshBranchStart, 'Cursor CLI SSH branch must be bounded before local branch');

const sshBranch = cursorCliService.slice(sshBranchStart, localBranchStart);
const syncIndex = sshBranch.indexOf('void sshService.syncMcpConfigsToRemote(sessionId, sshConfig)');
const spawnIndex = sshBranch.indexOf("child = spawn('ssh'");
assert.ok(syncIndex >= 0, 'Cursor SSH MCP sync must be a background warmup');
assert.ok(spawnIndex > syncIndex, 'Cursor SSH command must still spawn after scheduling background sync');
assert.doesNotMatch(
  sshBranch,
  /await sshService\.syncMcpConfigsToRemote\(sessionId, sshConfig\)/,
  'Cursor SSH startup must not block on MCP sync before spawning cursor-agent',
);
assert.match(sshBranch, /Background MCP sync failed/);
assert.match(sshBranch, /SSH exec on/);
assert.match(sshBranch, /'--print'/, 'Cursor SSH must use --print as a boolean flag');
assert.match(sshBranch, /'--stream-partial-output'/, 'Cursor SSH must request partial output streaming');
assert.match(sshBranch, /'prompt="\$\(cat\)"'/, 'Cursor SSH must read the prompt from stdin into a remote shell variable');
assert.match(sshBranch, /\`"\$agent_bin" \$\{remoteArgs\.join\(' '\)\} "\$prompt"\`/, 'Cursor SSH must pass the prompt as a positional argument');
assert.doesNotMatch(sshBranch, /'-p',\s*"''"/, 'Cursor SSH must not pass an empty prompt after -p');

assert.match(sshService, /mcpConfigSyncInFlight/);
assert.match(sshService, /MCP config sync already running for session, reusing promise/);
assert.match(sshService, /syncMcpConfigsToRemoteInternal/);
assert.match(sshService, /this\.mcpConfigSyncInFlight\.delete\(sessionId\)/);

console.log('cursor ssh fast-start verifier passed');
