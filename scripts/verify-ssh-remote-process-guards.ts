import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const cursorCliService = fs.readFileSync(path.join(root, 'src/main/services/cursor-cli.service.ts'), 'utf8');
const remoteBridgeScript = fs.readFileSync(path.join(root, 'src/main/services/remote-bridge-script.ts'), 'utf8');

assert.match(cursorCliService, /private remoteWorkdirCheckForShell\(value: string\): string \{/);

const createSshChatMethod = cursorCliService.match(/async createSshChat\(sshConfig: SSHConfig, remoteDir: string\): Promise<string \| null> \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(createSshChatMethod, /this\.remoteWorkdirCheckForShell\(remoteDir\)/);
assert.ok(
  createSshChatMethod.indexOf('this.remoteWorkdirCheckForShell(remoteDir)') < createSshChatMethod.indexOf('Cursor Agent CLI not found on remote'),
  'Cursor SSH chat creation must validate the remote workdir before checking for cursor-agent'
);

const streamSshCommandBlock = cursorCliService.match(/const remoteCmd = \[[\s\S]*?Cursor Agent CLI not found on remote[\s\S]*?\]\.filter\(Boolean\)\.join\(' && '\);/)?.[0] || '';
assert.match(streamSshCommandBlock, /this\.remoteWorkdirCheckForShell\(remoteDir\)/);
assert.ok(
  streamSshCommandBlock.indexOf('this.remoteWorkdirCheckForShell(remoteDir)') < streamSshCommandBlock.indexOf('Cursor Agent CLI not found on remote'),
  'Cursor SSH streaming must report missing workdirs instead of masking them as missing cursor-agent'
);

assert.match(sshService, /private getRemoteWorkdirCdCommand\(remoteWorkdir: string\): string \{/);
assert.ok(
  sshService.includes('${workdir#\\\\~/}'),
  'SSH workdir preflight must strip literal ~/ before prefixing HOME',
);
assert.match(sshService, /Remote workdir not found:/);
assert.match(sshService, /private async assertRemoteWorkdirExists\(sessionId: string, config: SSHConfig, remoteWorkdir\?: string\): Promise<void> \{/);
assert.match(sshService, /await this\.assertRemoteWorkdirExists\(sessionId, config, bridge\.cwd\)/);

assert.match(remoteBridgeScript, /function normalizeCwd\(cwd\) \{/);
assert.match(remoteBridgeScript, /if \(cwd === '~'\) return home;/);
assert.match(remoteBridgeScript, /if \(cwd\.startsWith\('~\/'\)\) return path\.join\(home, cwd\.slice\(2\)\);/);
assert.match(remoteBridgeScript, /cwd: normalizeCwd\(config\.cwd\)/);

const directProcessMethod = sshService.match(/private createDirectCommandProcess\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(directProcessMethod, /options\.cwd \? this\.getRemoteWorkdirCdCommand\(options\.cwd\) : ''/);
assert.doesNotMatch(directProcessMethod, /cd \$\{this\.quoteForShell\(options\.cwd\)\} &&/);
assert.doesNotMatch(directProcessMethod, /exportCommand/);

assert.match(sshService, /private buildSessionEnvProcessLoop\(sessionId: string, body: string\): string \{/);
assert.match(sshService, /grep -azqx "CLAUDETTE_SESSION_ID=\$safe_session"/);
assert.match(sshService, /private buildKillSessionEnvProcessesCommand\(sessionId: string\): string \{/);

const sessionEnvProcessLoopMethod = sshService.match(/private buildSessionEnvProcessLoop\(sessionId: string, body: string\): string \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(sessionEnvProcessLoopMethod, /\.join\('\\n'\)/);
assert.doesNotMatch(
  sessionEnvProcessLoopMethod,
  /\.join\('; '\)/,
  'Session env process loop must not generate a shell "do;" token'
);

const hasActiveRemoteProcessMethod = sshService.match(/async hasActiveRemoteProcess\(sessionId: string, config: SSHConfig\): Promise<boolean> \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(hasActiveRemoteProcessMethod, /this\.buildSessionEnvProcessLoop\(sessionId/);
assert.match(hasActiveRemoteProcessMethod, /ps -p "\$pid" -o args=/);
assert.match(hasActiveRemoteProcessMethod, /@anthropic-ai\/claude-code/);
assert.doesNotMatch(hasActiveRemoteProcessMethod, /buildSessionEnvProcessLoop\(sessionId, 'kill -0 "\$pid"/);
assert.match(hasActiveRemoteProcessMethod, /active=1; break/);

const cleanupMethod = sshService.match(/async cleanupDetachedBridgeProcessesForNewTurn\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(cleanupMethod, /this\.buildKillSessionEnvProcessesCommand\(sessionId\)/);

const killMethod = sshService.match(/async killRemoteProcesses\(sessionId: string, config: SSHConfig\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(killMethod, /this\.buildKillSessionEnvProcessesCommand\(sessionId\)/);

console.log('ssh remote process guards verifier passed');
