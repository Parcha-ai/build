#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const appPath = process.argv[2] || '/Applications/Build.app';
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'build');
const isInstalledProductionApp = path.resolve(appPath) === '/Applications/Build.app';

function fail(message) {
  console.error(`verify-installed-build-fixes failed: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited ${result.status}${output ? `\n${output}` : ''}`);
  }
  return output;
}

function readBundle(bundlePath) {
  try {
    return asar.extractFile(asarPath, bundlePath).toString('utf8');
  } catch (error) {
    fail(`could not read ${bundlePath} from ${asarPath}: ${error.message}`);
  }
}

function requireMarker(bundleName, bundleText, marker) {
  if (!bundleText.includes(marker)) {
    fail(`${bundleName} is missing marker: ${marker}`);
  }
  console.log(`ok ${bundleName}: ${marker}`);
}

function forbidMarker(bundleName, bundleText, marker) {
  if (bundleText.includes(marker)) {
    fail(`${bundleName} still contains forbidden marker: ${marker}`);
  }
  console.log(`ok ${bundleName} excludes: ${marker}`);
}

function parsePsLine(line) {
  const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) return null;
  const startedAtMs = Date.parse(match[2]);
  return {
    pid: Number(match[1]),
    startedAtText: match[2],
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    command: match[3],
    line: line.trim(),
  };
}

if (!fs.existsSync(asarPath)) {
  fail(`app.asar not found at ${asarPath}`);
}

const stat = fs.statSync(asarPath);
console.log(`checking ${asarPath}`);
console.log(`app.asar modified ${stat.mtime.toISOString()} (${stat.size} bytes)`);

const packageEntries = new Set(asar.listPackage(asarPath));
for (const requiredEntry of [
  '/.webpack/main/index.js',
  '/.webpack/renderer/main_window/index.js',
]) {
  if (!packageEntries.has(requiredEntry)) {
    fail(`asar missing ${requiredEntry}`);
  }
}

const mainBundle = readBundle('.webpack/main/index.js');
const rendererBundle = readBundle('.webpack/renderer/main_window/index.js');
const fastUriPackagePath = path.join(appPath, 'Contents', 'Resources', 'node_modules', 'fast-uri', 'package.json');
if (!fs.existsSync(fastUriPackagePath)) {
  fail(`packaged fast-uri dependency missing at ${fastUriPackagePath}`);
}
console.log(`ok packaged dependency: ${fastUriPackagePath}`);

const mainMarkers = [
  'Requested SDK transcript not found; refusing to load a different transcript',
  'Cache invalidated - transcript path changed',
  'Using freshest Build transcript alias',
  'Recent Build Session Context',
  'same Build session',
  '<build_session_continuity>',
  'authoritative over any earlier assistant message claiming missing context',
  'filterMessagesForBuildContinuityContext',
  'Resume reattach produced no visible output; suppressing queue drain',
  'Using prompt type:',
  'Injecting queued message via Query.streamInput',
  'Skipping SDK transcript fallback for foreground context',
  'claude-sonnet-5',
  'Sonnet 5',
  'claude-fable-5',
  'Fable 5',
  'SSH foreground Claude turn: resuming stored Claude SDK session without repair scan',
  'Manual Codex',
  'selected after',
  'resuming native thread',
  'Auto Build Codex',
  'Codex context includes current harness history because no native Codex thread is available',
  'Treat them as user input for the current request',
  'Prepared file attachments for Codex prompt',
  'Failed to prepare file attachments',
  'Remembered native Codex thread',
  'Resuming native SSH Codex thread',
  'Clearing stale active query before drain',
  'Clearing stale remote process before drain',
  'Foreground SSH cleanup scheduled in background',
  'Stream-end SSH cleanup scheduled in background',
  'Resume SSH cleanup scheduled in background',
  'Auto Build using assumed remote CLI capabilities',
  'Background remote CLI capability refresh failed',
  'Injecting queued message into active query',
  'leaving queued message pending for retry',
  'peekForDrain',
  'beginDrainAttempt',
  'ackDrain',
  'scheduleIfRemaining',
  'allowRemoteActiveDrain',
  'canDrainPastRemoteActive',
  'clearRemoteActiveDrainAllowance',
  'Draining queued turn for',
  'while remote bridge remains active',
  'Rechecked remote process after completed-stream bridge cleanup',
  'supportsActiveInjection=',
  'remote process is still active (localActive=yes',
  'lost its injectable Query object while remote process is still active',
  'clearLocalActiveQueryForRemoteReattach',
  'Rechecked remote process after completed bridge cleanup',
  'getDrainDeferredMs',
  'Browser partition cleanup',
  'Navigate queued until browser webview registers',
  'Storage cleared for partition',
  'persist:browser-',
  'buildSessionEnvProcessLoop',
  '].join("\\n")',
  'ps -p "$pid" -o args=',
  'label:"New Window",accelerator:"CommandOrControl+Shift+N"',
  'label:"New Session",accelerator:"CommandOrControl+N"',
  'Overrode stale Auto Build plan permission for direct model turn',
  'Auto Build plan route using turn-local plan permission',
  'Cleared Auto Build plan marker; session mode remains',
  'Late plan approval recorded for next harness handoff',
  'approved plan for handoff context',
  '<approved_plan_handoff>',
  'The user approved this plan for execution',
  'approvedPlan',
  'approved plan follow-up means execute the plan',
  'Continuing approved plan in',
  'Session already has a title; keeping the current name.',
  'Do not copy the user request or its first sentence verbatim',
  'sessionTitleAutoGeneratedAt',
  'first-user-message',
  'sdk-summary',
  'claude-tool',
  'Persisted restored permission mode',
  'Persisted Auto Build forced plan restore mode',
  'Retrieved SSH auto-resume state for remote reattach',
  'claude:{supportsAsyncInjection:!0,supportsMultiTurn:!0,minTurnGapMs:500',
  'Repaired SSH Claude SDK resume mapping',
  'repairSshSdkSessionIdFromBuildTranscript',
  'Closing one-shot recoverability probe connection',
  'recoverable-probe',
  'MCP config sync already running for remote, reusing promise',
  'MCP auth token sync running in background',
  'Background MCP auth token sync failed',
  'Waiting for MCP config sync before SSH agent start',
  'BUILD_HARNESS=cursor',
  'stopped after tool activity without returning a final text response',
  'Skipping SSH SDK resume repair scan',
  'cursor-agent --print <prompt:',
  '--stream-partial-output',
  'Collapsed duplicate assistant transcript row by content',
  'originalChars',
];

const rendererMarkers = [
  'Build transcript exists for',
  'not sending supplemental local fallback as model context',
  'grep-supplemental-messages-',
  'grep-history-',
  'persist:browser-',
  'Build transcript',
  'merged',
  'preserving fuller duplicate message during hydration',
  'authoritative Build transcript',
  'Failed to persist permission mode changed from main',
  'main queue owns injection',
  'queued message after optimistic send',
  'queued message after optimistic send and requesting reattach',
  'queued message id(s) consumed for hydration guard',
  'Suppressing duplicate unanswered user prompt',
  'Backend still has active query',
  'Hydrating empty active session from transcript',
  'partial transcript slice',
  'Text file pasted and attached',
  'normalized:',
  'Deferring STREAM_END for',
  'Deferring STREAM_ERROR cleanup for',
  'Tool call ended before completion.',
  'Suppressing stale submitted input echo',
  'github-new-session-stable-v1',
  'Use the attached file(s) as input for the current task.',
  'Secure-key scan failed; sending original text',
  'Ignoring permission mode change to',
  'Ignoring permission mode cycle while turn is active or queued',
  'Startup SSH reattach delayed for active session',
  'Auto-reattaching running SSH sessions on startup after delay',
  'Delaying SSH startup reattach probe while a stream is active',
  'Queued stream attach request for existing SSH process monitor',
  'Monitoring recoverable SSH session without stream attach',
  'SSH Build It session is recoverable; reattaching to startup stream',
  'Reattaching to detached SSH turn',
  'Failed to check recoverable SSH process during startup reattach',
  'Active background work',
  'Background agents and monitors',
  'closeAfter',
  'Syncing mounted preview to session URL',
  'html-response-artifact',
  'allowFragment',
  'sessionHtmlArtifacts',
  'HTML Response Preview',
  'Open Preview',
  'Toggle HTML Preview',
];

for (const marker of mainMarkers) {
  requireMarker('main bundle', mainBundle, marker);
}
for (const marker of rendererMarkers) {
  requireMarker('renderer bundle', rendererBundle, marker);
}
requireMarker('renderer bundle', rendererBundle, 'case"new-session"');
forbidMarker('main bundle', mainBundle, 'label:"New Window",accelerator:"CommandOrControl+N"');
forbidMarker('main bundle', mainBundle, '].join("; ")}buildKillSessionEnvProcessesCommand');
forbidMarker('main bundle', mainBundle, 'Auto-generate session name from task');
forbidMarker('main bundle', mainBundle, 'Could not auto-generate tab name');
forbidMarker('renderer bundle', rendererBundle, 'scanRemoteTranscripts');
forbidMarker('renderer bundle', rendererBundle, '[ForkTabs] Discovered');

if (process.platform === 'darwin' && isInstalledProductionApp) {
  run('codesign', ['--verify', '--deep', '--strict', appPath]);
  const spctlOutput = run('spctl', ['-a', '-vv', appPath]);
  if (!spctlOutput.includes('accepted')) {
    fail(`spctl output did not include accepted:\n${spctlOutput}`);
  }
  console.log(spctlOutput);
} else if (process.platform === 'darwin') {
  console.log('skipping notarization check for staged app bundle');
}

const processList = run('ps', ['-axo', 'pid,lstart,command']);
const running = processList
  .split('\n')
  .filter((line) => line.includes(executablePath))
  .map(parsePsLine)
  .filter(Boolean);
const buildExecutableProcesses = processList
  .split('\n')
  .map(parsePsLine)
  .filter(Boolean)
  .map((processInfo) => {
    const executableMatch = processInfo.command.match(/^(.*?Build\.app\/Contents\/MacOS\/build)(?:\s|$)/);
    if (!executableMatch) return null;
    return {
      ...processInfo,
      executablePath: path.resolve(executableMatch[1]),
    };
  })
  .filter(Boolean);

if (isInstalledProductionApp) {
  const expectedExecutablePath = path.resolve(executablePath);
  const staleBuildProcesses = buildExecutableProcesses.filter((processInfo) =>
    processInfo.executablePath !== expectedExecutablePath
  );
  if (staleBuildProcesses.length > 0) {
    console.error('stale Build.app processes:');
    for (const processInfo of staleBuildProcesses) {
      console.error(processInfo.line);
    }
    fail(
      'non-installed Build.app process is running; quit it and launch /Applications/Build.app before trusting runtime behavior'
    );
  }
}

if (running.length > 0) {
  console.log('running app processes:');
  for (const processInfo of running) {
    console.log(processInfo.line);
    if (processInfo.startedAtMs === null) {
      console.log(`activation state for pid ${processInfo.pid}: unknown start time`);
      continue;
    }
    if (processInfo.startedAtMs < stat.mtimeMs) {
      if (isInstalledProductionApp) {
        fail(`running installed Build.app pid ${processInfo.pid} predates installed app.asar; relaunch required to use installed fixes`);
      }
      console.log(`activation state for pid ${processInfo.pid}: running process predates checked app.asar; relaunch required to use checked fixes`);
    } else {
      console.log(`activation state for pid ${processInfo.pid}: running process started after installed app.asar`);
    }
  }
} else {
  console.log('no running installed Build.app process found');
}

console.log('installed Build.app fix verifier passed');
