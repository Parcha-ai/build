import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Guards SSH remote turn survival: a turn that is still running on the remote
// must NEVER be killed because of a local stream error, a failed reattach, or
// a queued-message drain — and the app must reattach automatically after
// laptop sleep, app restart, or transport drops, until the turn ends.

const root = path.resolve(__dirname, '..');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const powerService = fs.readFileSync(path.join(root, 'src/main/services/power.service.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const channels = fs.readFileSync(path.join(root, 'src/shared/constants/channels.ts'), 'utf8');

// 1. Channels exist for wake + recoverable-turn signals.
assert.match(channels, /SSH_SYSTEM_RESUMED: 'ssh:system-resumed'/);
assert.match(channels, /CLAUDE_REMOTE_TURN_RECOVERABLE: 'claude:remote-turn-recoverable'/);

// 2. Stream errors and failed reattaches never kill active remote work.
// killActive: hadError was the lid-close assassin — it must not return.
assert.doesNotMatch(claudeIpc, /killActive: hadError/, 'stream errors must never kill active remote turns');
// The ONLY remaining killActive: true is the stale-drain path, gated on a
// genuinely stuck job (no log growth).
const killActiveTrueCount = (claudeIpc.match(/killActive: true/g) || []).length;
assert.strictEqual(killActiveTrueCount, 1, 'exactly one killActive: true site in claude.ipc (gated stale-drain)');

// 3. Post-error probe happens before the safety-net STREAM_END. A surviving
// job — or a probe made uncertain by the same transport outage — defers final
// text/persistence and asks the renderer to reattach.
assert.match(claudeIpc, /Remote turn survived or may have survived local stream error/);
assert.match(claudeIpc, /\{ throwOnError: true \}/);
assert.match(claudeIpc, /deferFinalizationForRemoteRecovery/);
assert.match(claudeIpc, /Deferring STREAM_END for recoverable SSH turn/);
assert.match(claudeIpc, /pendingSshStreamError && !deferFinalizationForRemoteRecovery/);
const remoteProbeIndex = claudeIpc.indexOf('getLatestRecoverableRemoteProcess(\n                sessionId');
const safetyNetIndex = claudeIpc.indexOf('Safety net: sending STREAM_END for');
assert.ok(remoteProbeIndex > 0 && safetyNetIndex > remoteProbeIndex,
  'recoverability must be established before the IPC safety net publishes STREAM_END');
assert.match(claudeIpc, /CLAUDE_REMOTE_TURN_RECOVERABLE, \{ sessionId \}/);

// Reattach itself remains open while SSH is unavailable instead of producing
// an empty terminal response. Once attached, renderer liveness is based on an
// unreplayed bridge job, not an unrelated/stale session process.
assert.match(claudeService, /SSH reattach unavailable for .*; retrying:/);
assert.match(claudeService, /while \(!abortController\.signal\.aborted\)/);
assert.match(sessionStore, /async function hasRecoverableRemoteProcess/);
assert.doesNotMatch(sessionStore, /async function hasLiveRemoteProcess/);
assert.match(sessionStore, /if \(message\.interrupted && hasUnfinishedVisibleTools/);
assert.match(sessionStore, /if \(message\.interrupted && currentState\.isStreaming\[sessionId\]/);

// 4. Drain stale-kill is progress-aware: a live, progressing remote turn is
// reattached and the drain deferred; only a job whose log stopped growing for
// STALE_QUEUE_DRAIN_REMOTE_STUCK_MS may be cleared.
assert.match(claudeIpc, /const STALE_QUEUE_DRAIN_REMOTE_STUCK_MS = 5 \* 60_000;/);
assert.match(claudeIpc, /drainRemoteJobProgress/);
assert.match(claudeIpc, /Remote turn still progressing for/);
const progressGuardIndex = claudeIpc.indexOf('Remote turn still progressing for');
const staleKillIndex = claudeIpc.indexOf('Clearing stale remote process before drain');
assert.ok(progressGuardIndex > 0 && staleKillIndex > progressGuardIndex,
  'progress guard must run before the stale remote kill');
assert.match(claudeIpc, /stuckMs < STALE_QUEUE_DRAIN_REMOTE_STUCK_MS/);

// 5. Wake-from-sleep: power service exposes a resume hook, main broadcasts it,
// preload exposes it, and the renderer sweeps running SSH sessions.
assert.match(powerService, /powerMonitor\.on\('resume'/);
assert.match(powerService, /onSystemResume\(listener: \(\) => void\)/);
assert.match(mainIndex, /powerService\.onSystemResume\(/);
assert.match(mainIndex, /IPC_CHANNELS\.SSH_SYSTEM_RESUMED/);
assert.match(preload, /onSystemResumed: \(callback: \(\) => void\)/);
assert.match(preload, /onRemoteTurnRecoverable: \(callback: \(data: \{ sessionId: string \}\) => void\)/);
assert.match(sessionStore, /onSystemResumed\?\.\(/);
assert.match(sessionStore, /onRemoteTurnRecoverable\?\.\(/);
assert.match(sessionStore, /System resumed from sleep; checking/);
assert.match(sessionStore, /startRunningSshProcessMonitors\(runningSshSessions, get, set, loadMessages\);/);
assert.match(sessionStore, /startRemoteProcessMonitor\(sessionId, get, set, loadMessages, \{ recoverableKnown: true \}\)/);

// 6. Startup cleanup must never delete completed-but-unrecovered job output —
// a turn that finished while the app was closed is what the reattach probe
// replays. Only (completed AND recovered) or 6h-stale jobs may be removed.
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
assert.match(sshService, /\{ \[ "\$completed" = "1" \] && \[ "\$recovered" = "1" \]; \} \|\| \[ "\$stale" = "1" \]/);
assert.match(sshService, /never delete completed output that has not been replayed/);
assert.ok(
  sshService.includes(
    'elif test "$active" = "0" && test -f "$log" && grep -q \\\'"type":"result"\\\' "$log"'
  ),
  'Claude stdout result must not mark an active detached bridge job completed'
);
assert.match(
  sshService,
  /job\.active && !job\.recovered/,
  'active detached bridge jobs must remain active even after Claude emits a lead result'
);
assert.doesNotMatch(
  sshService,
  /job\.active && !job\.completed && !job\.recovered/,
  'active detached bridge jobs must not depend on the completed flag'
);
assert.match(sshService, /Recovered remote stdin bridge ready/);
assert.match(
  sshService,
  /Aborting a recovered reader is a local detach, not user intent to kill/,
  'losing the local reattach wrapper must not kill the surviving remote turn',
);

// 7. The SSH-exit stream error tells the user reattachment is automatic, and
// explicit user cancel still kills remote work (the one intentional kill).
assert.match(claudeService, /Build will reattach automatically and continue streaming/);
assert.match(claudeService, /formatRemoteClaudeProcessExitError/);
assert.match(claudeService, /Boolean\(recoverableJob\?\.active\)/);
assert.match(claudeService, /Remote Claude failed to start because the SSH remote workdir was not found or is not accessible/);
const cancelQueryStart = claudeService.indexOf('cancelQuery(sessionId: string)');
const cancelQueryBlock = claudeService.slice(cancelQueryStart, cancelQueryStart + 3200);
assert.match(cancelQueryBlock, /killActive: true/, 'explicit cancel must still kill remote work');
assert.match(cancelQueryBlock, /this\.remoteCancellationCleanup\.set\(sessionId, cleanupPromise\)/);
assert.match(claudeIpc, /await claudeService\.cancelQuery\(sessionId\)/);
assert.match(claudeService, /Waiting for prior remote cancellation before starting/);

console.log('verify-ssh-turn-survival: all checks passed');
