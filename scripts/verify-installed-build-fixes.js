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

const mainMarkers = [
  'Requested SDK transcript not found; refusing to load a different transcript',
  'Cache invalidated - transcript path changed',
  'Clearing stale active query before drain',
  'Injecting queued message into active query',
  'getDrainDeferredMs',
  'Browser partition cleanup',
  'Storage cleared for partition',
  'persist:browser-',
  'buildSessionEnvProcessLoop',
  '].join("\\n")',
  'ps -p "$pid" -o args=',
  'label:"New Session",accelerator:"CommandOrControl+N"',
  'Overrode stale Auto Build plan permission for direct model turn',
  'Persisted restored permission mode',
];

const rendererMarkers = [
  'Build transcript exists for',
  'not sending supplemental local fallback as model context',
  'grep-supplemental-messages-',
  'grep-history-',
  'persist:browser-',
  'Build transcript',
  'merged',
  'Failed to persist permission mode changed from main',
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
if (running.length > 0) {
  console.log('running app processes:');
  for (const processInfo of running) {
    console.log(processInfo.line);
    if (processInfo.startedAtMs === null) {
      console.log(`activation state for pid ${processInfo.pid}: unknown start time`);
      continue;
    }
    if (processInfo.startedAtMs < stat.mtimeMs) {
      console.log(`activation state for pid ${processInfo.pid}: running process predates installed app.asar; relaunch required to use installed fixes`);
    } else {
      console.log(`activation state for pid ${processInfo.pid}: running process started after installed app.asar`);
    }
  }
} else {
  console.log('no running installed Build.app process found');
}

console.log('installed Build.app fix verifier passed');
