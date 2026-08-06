import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { filterRemoteClaudeArguments } from '../src/main/services/ssh.service';
import { normalizeRemoteWorkdir } from '../src/shared/utils/remote-workdir';

const root = path.resolve(__dirname, '..');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const terminalService = fs.readFileSync(path.join(root, 'src/main/services/terminal.service.ts'), 'utf8');
const cursorCliService = fs.readFileSync(path.join(root, 'src/main/services/cursor-cli.service.ts'), 'utf8');
const remoteBridgeScript = fs.readFileSync(path.join(root, 'src/main/services/remote-bridge-script.ts'), 'utf8');
const devScript = fs.readFileSync(path.join(root, 'scripts/dev.sh'), 'utf8');

assert.match(
  devScript,
  /\[ ! -f "\$GREP_DEV_USER_DATA\/claudette-sessions\.json" \] && \[ -f "\$PROD_DIR\/claudette-sessions\.json" \] && cp/,
  'dev startup must preserve its own SSH session database across app restarts',
);

assert.deepEqual(
  filterRemoteClaudeArguments([
    '/local/node_modules/@anthropic-ai/claude-agent-sdk/claude',
    '--output-format',
    'stream-json',
    '--mcp-config',
    '{"mcpServers":{"local":{"command":"/local/node_modules/tool"}}}',
    '--setting-sources=user,project',
  ]),
  ['--output-format', 'stream-json', '--setting-sources=user,project'],
  'remote Claude argument filtering must remove --mcp-config with its local-only value',
);
assert.equal(normalizeRemoteWorkdir('Worktree: /home/ubuntu/worktrees/example'), '/home/ubuntu/worktrees/example');
assert.equal(normalizeRemoteWorkdir('CWD: "~/project"'), '~/project');
assert.equal(normalizeRemoteWorkdir('/home/ubuntu/project'), '/home/ubuntu/project');
assert.deepEqual(
  filterRemoteClaudeArguments(['--verbose', '--mcp-config={"mcpServers":{}}', '--effort', 'low']),
  ['--verbose', '--effort', 'low'],
  'remote Claude argument filtering must remove inline --mcp-config values',
);

assert.match(cursorCliService, /private remoteWorkdirCheckForShell\(value: string\): string \{/);

assert.match(terminalService, /const sshConnectionId = `\$\{sessionId\}:terminal:\$\{terminalId\}`;/);
assert.match(terminalService, /sshService\.createShell\(sshConnectionId, sshConfig\)/);
assert.doesNotMatch(
  terminalService,
  /sshService\.createShell\(sessionId, sshConfig\)/,
  'interactive SSH terminals must not share the active agent session connection key',
);
assert.match(terminalService, /sshTerminal\.disposeConnection\(\)/);
assert.match(terminalService, /sshService\.disconnect\(sshConnectionId\)/);
assert.match(terminalService, /if \(!terminal\) return;/);

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
assert.doesNotMatch(
  sshService,
  /setTimeout\(\(\) => \{\s*this\.killAllRemoteProcesses\(\)/,
  'opening the first SSH connection must never schedule remote process termination',
);
assert.match(
  sshService,
  /\[ "\$active" = "0" \] && \[ "\$stale" = "1" \]/,
  'age-based bridge cleanup must never terminate a live remote agent',
);
assert.ok(
  sshService.includes('${workdir#\\\\~/}'),
  'SSH workdir preflight must strip literal ~/ before prefixing HOME',
);
assert.match(sshService, /Remote workdir not found:/);
assert.match(sshService, /private async assertRemoteWorkdirExists\(sessionId: string, config: SSHConfig, remoteWorkdir\?: string\): Promise<void> \{/);
assert.match(sshService, /await this\.assertRemoteWorkdirExists\(sessionId, config, bridge\.cwd\)/);
assert.match(sshService, /cwd: normalizeRemoteWorkdir\(options\.cwd\) \|\| '\.'/);
assert.match(sshService, /hasExitFile: boolean;/);
assert.match(sshService, /exitCode\?: number \| null;/);
assert.match(sshService, /hasexit=0; test -f "\$exitfile" && hasexit=1/);
assert.match(sshService, /exitcode=""; test "\$hasexit" = "1" && exitcode=/);
assert.match(sshService, /job\.hasExitFile && job\.exitCode !== 0/);
assert.match(sshService, /await finalize\(job\.hasExitFile \? job\.exitCode \?\? 1 : 0, null, true\)/);
assert.doesNotMatch(
  sshService,
  /await finalize\(66, null, false\)/,
  'Missing SSH workdirs must surface as spawn errors, not generic Claude exit code 66'
);

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
assert.doesNotMatch(
  hasActiveRemoteProcessMethod,
  /buildSessionEnvProcessLoop|\/proc\/\[0-9\]/,
  'normal turn admission must not scan every remote process environment',
);
assert.match(hasActiveRemoteProcessMethod, /active=1; break/);
assert.match(hasActiveRemoteProcessMethod, /bridge_dir=/);
assert.match(hasActiveRemoteProcessMethod, /test -f "\$jobdir\/recovered\.json" && continue/);
assert.doesNotMatch(
  hasActiveRemoteProcessMethod,
  /listDetachedBridgeJobs/,
  'active process admission must inspect bridge jobs and legacy owners in one SSH round trip',
);
assert.doesNotMatch(
  hasActiveRemoteProcessMethod,
  /job\.active && !job\.completed/,
  'active detached bridge jobs must count as active even after Claude emits a result event'
);

const listDetachedBridgeJobsMethod = sshService.match(/async listDetachedBridgeJobs\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(listDetachedBridgeJobsMethod, /active=0; test -n "\$pid" && kill -0 "\$pid"/);
assert.ok(
  listDetachedBridgeJobsMethod.includes(
    'elif test "$active" = "0" && test -f "$log" && grep -q \\\'"type":"result"\\\' "$log"'
  ),
  'stdout result should only complete inactive detached bridge jobs'
);

const attachDetachedStart = sshService.indexOf('private attachDetachedCommandProcess');
const launchDetachedStart = sshService.indexOf('private async launchDetachedRemoteBridge', attachDetachedStart);
const attachDetachedMethod = sshService.slice(attachDetachedStart, launchDetachedStart);
const resultPollIndex = attachDetachedMethod.indexOf('echo __RESULT__');
assert.ok(resultPollIndex > 0, 'recovered attach poller must still handle inactive result fallback');
assert.ok(
  attachDetachedMethod.indexOf('kill -0 "$pid"', attachDetachedMethod.indexOf('const pollForExit')) < resultPollIndex,
  'recovered attach poller must check PID liveness before accepting a stdout result as completion'
);

const cleanupMethod = sshService.match(/async cleanupDetachedBridgeProcessesForNewTurn\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(cleanupMethod, /this\.buildKillSessionEnvProcessesCommand\(sessionId\)/);
assert.ok(
  cleanupMethod.includes(
    'elif test "$active" = "0" && test -f "$jobdir/stdout.log" && grep -q \\\'"type":"result"\\\' "$jobdir/stdout.log"'
  ),
  'new-turn cleanup must not treat active async-agent jobs as completed just because stdout has a result event'
);
assert.match(
  cleanupMethod,
  /completedTurn\?: boolean[\s\S]*?if test "\$completed_turn" = "1"[\s\S]*?"type":"result"/,
  'an explicitly completed foreground turn must retire its still-unwinding result bridge',
);
assert.match(
  cleanupMethod,
  /completedTurnCleanupGuards\.set/,
  'completed-turn cleanup must synchronously guard against renderer reattach races',
);
assert.match(
  sshService,
  /hasRecoverableRemoteProcess\([\s\S]*?hasCompletedTurnCleanupGuard\(sessionId\)/,
  'recoverability probes must ignore a terminal bridge while completed-turn cleanup is in flight',
);

const killMethod = sshService.match(/async killRemoteProcesses\(sessionId: string, config: SSHConfig\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(killMethod, /this\.buildKillSessionEnvProcessesCommand\(sessionId\)/);

console.log('ssh remote process guards verifier passed');
