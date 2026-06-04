import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const sshIpc = fs.readFileSync(path.join(root, 'src/main/ipc/ssh.ipc.ts'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');

const startRemoteProcessMonitorReferences = sessionStore.match(/startRemoteProcessMonitor\(/g) || [];
assert.ok(
  startRemoteProcessMonitorReferences.length >= 4,
  'startup, session selection, and SSH auto-resume must use startRemoteProcessMonitor',
);

assert.match(sessionStore, /if \(remoteProcessPollers\.has\(sessionId\)\) return;\s+remoteProcessPollers\.add\(sessionId\);/);
assert.match(sessionStore, /remoteProcessPollers\.delete\(sessionId\);\s+return;/);
assert.match(sessionStore, /startRemoteProcessMonitor\(sessionId, get, set, loadMessages\);/);
assert.match(sessionStore, /startRemoteProcessMonitor\(validActiveSessionId, get, set, loadMessages\);/);
assert.match(sessionStore, /Auto-reattaching running SSH sessions on startup/);
assert.match(sessionStore, /MAX_CONCURRENT_SSH_REATTACH_CHECKS = 3/);
assert.match(sessionStore, /SSH_STARTUP_REATTACH_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
assert.match(sessionStore, /startRunningSshProcessMonitors/);
assert.match(sessionStore, /isRecentRunningSshSession/);
assert.match(sessionStore, /Date\.now\(\) - updatedAt <= SSH_STARTUP_REATTACH_WINDOW_MS/);
assert.match(sessionStore, /workerCount = Math\.min\(MAX_CONCURRENT_SSH_REATTACH_CHECKS, sessions\.length\)/);
assert.match(sessionStore, /recoverableKnown: true/);
assert.match(sessionStore, /hasRecoverableRemoteProcess\(sessionId, \{ closeAfter: true \}\)/);
assert.match(sessionStore, /hasRecoverableRemoteProcess\(session\.id, \{ closeAfter: true \}\)/);
assert.match(sessionStore, /Auto-resuming SSH Build It session by reattaching/);
assert.doesNotMatch(sessionStore, /SSH remote reattach skipped on session selection/);
assert.doesNotMatch(sessionStore, /SSH remote reattach skipped on startup/);
assert.doesNotMatch(sessionStore, /SSH auto-resume suppressed on startup/);
assert.doesNotMatch(sessionStore, /isPersistedSshRunning/);

const checkAndAutoResumeStart = sessionStore.indexOf('checkAndAutoResume: async () => {');
assert.ok(checkAndAutoResumeStart >= 0, 'session store must define checkAndAutoResume');

const sshAutoResumeStart = sessionStore.indexOf('if (session.sshConfig) {', checkAndAutoResumeStart);
const localAutoResumeStart = sessionStore.indexOf("console.log('[SessionStore] Auto-resuming Build It session:'", sshAutoResumeStart);
assert.ok(sshAutoResumeStart >= 0, 'checkAndAutoResume must handle SSH sessions explicitly');
assert.ok(localAutoResumeStart > sshAutoResumeStart, 'local auto-resume branch must follow SSH reattach branch');

const sshAutoResumeBranch = sessionStore.slice(sshAutoResumeStart, localAutoResumeStart);
assert.match(sshAutoResumeBranch, /hasRecoverableRemoteProcess/);
assert.match(sshAutoResumeBranch, /closeAfter: true/);
assert.match(sshAutoResumeBranch, /recoverableKnown: true/);
assert.match(sshAutoResumeBranch, /hasActiveRemoteProcess/);
assert.doesNotMatch(sshAutoResumeBranch, /resumeRemoteTurn/);
assert.match(sshAutoResumeBranch, /startRemoteProcessMonitor/);
assert.match(sshAutoResumeBranch, /state\.setActiveSession/);

assert.match(sshIpc, /SSH_HAS_RECOVERABLE_REMOTE_PROCESS,[\s\S]*options\?: \{ closeAfter\?: boolean \}/);
assert.match(sshIpc, /hasRecoverableRemoteProcess\(sessionId, session\.sshConfig, options\)/);
assert.match(preload, /hasRecoverableRemoteProcess: \(sessionId: string, options\?: \{ closeAfter\?: boolean \}\)/);
assert.match(sshService, /interface RecoverableRemoteProcessOptions/);
assert.match(sshService, /closeAfter\?: boolean/);
assert.match(sshService, /interface RemoteBridgeLookupOptions/);
assert.match(sshService, /connectionSessionId\?: string/);
assert.match(sshService, /this\.getConnection\(options\.connectionSessionId \|\| sessionId, config\)/);
assert.match(sshService, /const recoverabilityProbeSessionId = \[/);
assert.match(sshService, /connectionSessionId: recoverabilityProbeSessionId/);
assert.match(sshService, /Closing one-shot recoverability probe connection/);
assert.match(sshService, /this\.closeSshConnection\(recoverabilityProbeSessionId\)/);

const getAutoResumeStart = claudeIpc.indexOf('ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_GET_STATE');
const clearAutoResumeStart = claudeIpc.indexOf('// Clear auto-resume state', getAutoResumeStart);
assert.ok(getAutoResumeStart >= 0, 'main process must expose auto-resume state handler');
assert.ok(clearAutoResumeStart > getAutoResumeStart, 'auto-resume get handler must be bounded before clear handler');

const getAutoResumeHandler = claudeIpc.slice(getAutoResumeStart, clearAutoResumeStart);
assert.match(getAutoResumeHandler, /if \(state\.isSSH\) \{/);
assert.match(getAutoResumeHandler, /Retrieved SSH auto-resume state for remote reattach/);
assert.doesNotMatch(getAutoResumeHandler, /24 \* 60 \* 60 \* 1000/);
assert.doesNotMatch(getAutoResumeHandler, /Ignoring SSH auto-resume state/);
assert.ok(
  getAutoResumeHandler.indexOf('if (state.isSSH) {') < getAutoResumeHandler.indexOf('const staleAfterMs = 5 * 60 * 1000'),
  'SSH auto-resume state must bypass stale local auto-resume handling',
);

const sshAutoResumeBranchInMain = getAutoResumeHandler.slice(
  getAutoResumeHandler.indexOf('if (state.isSSH) {'),
  getAutoResumeHandler.indexOf('const staleAfterMs = 5 * 60 * 1000'),
);
assert.match(sshAutoResumeBranchInMain, /return state;/);
assert.doesNotMatch(sshAutoResumeBranchInMain, /settingsStore\.delete\('autoResumeState'\)/);
assert.doesNotMatch(sshAutoResumeBranchInMain, /return null;/);

console.log('SSH auto reattach verifier passed');
