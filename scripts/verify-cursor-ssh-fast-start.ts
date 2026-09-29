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
const spawnIndex = sshBranch.indexOf('child = sshService.createDetachedCommandProcess');
assert.ok(spawnIndex >= 0, 'Cursor SSH command must launch through the detached bridge');
assert.doesNotMatch(sshBranch, /syncMcp(?:Auth|Configs)ToRemote|scheduleMcpConfigsToRemote/);
assert.match(sshBranch, /CLAUDETTE_SESSION_ID/);
assert.match(sshBranch, /BUILD_HARNESS:\s*'cursor'/);
assert.match(sshBranch, /recoveryCommand:\s*'cursor'/);
assert.match(sshBranch, /requireDetached:\s*true/);
assert.match(sshBranch, /SSH exec on/);
assert.match(sshBranch, /'--print'/, 'Cursor SSH must use --print as a boolean flag');
assert.match(sshBranch, /'--stream-partial-output'/, 'Cursor SSH must request partial output streaming');
assert.match(sshBranch, /'prompt="\$\(cat\)"'/, 'Cursor SSH must read the prompt from stdin into a remote shell variable');
assert.match(sshBranch, /`"\$agent_bin" \$\{remoteArgs\.join\(' '\)\} "\$prompt"`/, 'Cursor SSH must pass the prompt as a positional argument');
assert.doesNotMatch(sshBranch, /'-p',\s*"''"/, 'Cursor SSH must not pass an empty prompt after -p');

assert.match(sshService, /mcpConfigSyncInFlight/);
assert.match(sshService, /getMcpConfigSyncKey/);
assert.match(sshService, /MCP config sync already running for remote, reusing promise/);
assert.match(sshService, /MCP auth token sync completed before harness start/);
assert.match(sshService, /localFingerprint/);
assert.match(sshService, /syncMcpAuthToRemote/);
assert.doesNotMatch(sshService, /MCP auth token sync running in background/);
assert.match(sshService, /setupMcpReverseTunnelsForSession\(sessionId, config, true\)/);
assert.match(sshService, /syncMcpConfigsToRemoteInternal/);
assert.match(sshService, /this\.mcpConfigSyncInFlight\.delete\(syncKey\)/);

console.log('cursor ssh fast-start verifier passed');
