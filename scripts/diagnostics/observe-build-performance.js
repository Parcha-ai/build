#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const intervalMs = Math.max(2_000, Number(process.env.BUILD_OBSERVER_INTERVAL_MS || 5_000));
const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'Build');
const buildLogPath = path.join(supportDir, 'main.log');
const outputDir = path.join(os.homedir(), 'Library', 'Logs', 'Build', 'perf-observer');
const startedAt = new Date();
const dateKey = startedAt.toLocaleDateString('en-CA');
const outputPath = path.join(outputDir, `${dateKey}.jsonl`);
const summaryPath = path.join(outputDir, `${dateKey}-summary.json`);

const midnight = new Date(startedAt);
midnight.setHours(24, 0, 0, 0);
const requestedDurationMs = Number(process.env.BUILD_OBSERVER_DURATION_MS || 0);
const stopAt = requestedDurationMs > 0
  ? new Date(startedAt.getTime() + requestedDurationMs)
  : midnight;

fs.mkdirSync(outputDir, { recursive: true });

let logOffset = fs.existsSync(buildLogPath) ? fs.statSync(buildLogPath).size : 0;
let lastRendererTaskDuration;
let lastRendererTaskTimestamp;
let lastDeepSampleAt = 0;
let lastMinuteSummaryAt = 0;
let stopping = false;

const totals = {
  samples: 0,
  cdpFailures: 0,
  deepSamples: 0,
  duplicateCollapses: 0,
  prefixDuplicateCollapses: 0,
  messageLoads: 0,
  sshTranscriptFetches: 0,
  webviewAttaches: 0,
  webviewUnregisters: 0,
  gstackDiscoveries: 0,
  mcpFailures: 0,
  remoteRecoveryEvents: 0,
  maxRendererCpu: 0,
  maxRendererRssKb: 0,
  maxCdpLatencyMs: 0,
  maxTaskBusyRatio: 0,
};

function append(record) {
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function readNewBuildLog() {
  if (!fs.existsSync(buildLogPath)) return '';
  const size = fs.statSync(buildLogPath).size;
  if (size < logOffset) logOffset = 0;
  if (size === logOffset) return '';

  const length = size - logOffset;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(buildLogPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, logOffset);
  } finally {
    fs.closeSync(fd);
  }
  logOffset = size;
  return buffer.toString('utf8');
}

function count(text, needle) {
  if (!text || !needle) return 0;
  let found = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    found += 1;
    offset += needle.length;
  }
  return found;
}

function parseLogEvents(text) {
  const events = {
    duplicateCollapses: count(text, 'Collapsed duplicate assistant transcript row by content'),
    prefixDuplicateCollapses: count(text, 'Collapsed prefix-duplicate assistant transcript row'),
    messageLoads: count(text, '[Perf] Message load took'),
    sshTranscriptFetches: count(text, '[Perf] SSH transcript fetch took'),
    webviewAttaches: count(text, '[Main] Attaching webview with partition:'),
    webviewUnregisters: count(text, '[Browser Service] Unregistering webview:'),
    gstackDiscoveries: count(text, '[GStack] Discovered'),
    mcpFailures: count(text, '[MCP Bridge] Failed to start bridge') + count(text, '[MCP Bridge] Posthog process error'),
    remoteRecoveryEvents: count(text, 'resumeRemoteTurn received') + count(text, 'Reattaching to detached SSH turn'),
  };
  for (const [key, value] of Object.entries(events)) totals[key] += value;
  return events;
}

function getProcesses() {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,state=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }

  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || !match[6].includes('/Applications/Build.app/Contents/')) return [];
    const command = match[6];
    const kind = command.includes('/MacOS/build')
      ? 'main'
      : command.includes('Build Helper (Renderer)')
        ? command.includes('--app-path=') && !command.includes('--type=renderer') ? 'unknown' : 'renderer'
        : command.includes('Build Helper (GPU)')
          ? 'gpu'
          : 'utility';
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      rssKb: Number(match[4]),
      state: match[5],
      kind,
      browserGuest: command.includes('--enable-experimental-web-platform-features'),
    }];
  });
}

async function fetchJson(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cdpCommand(webSocketDebuggerUrl, method, params = {}, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${method} timed out`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (message.error) reject(new Error(message.error.message || method));
      else resolve(message.result);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`${method} websocket failed`));
    });
  });
}

async function getRendererMetrics() {
  const started = Date.now();
  const targets = await fetchJson('http://127.0.0.1:9222/json/list');
  const page = targets.find((target) => target.type === 'page' && target.title === 'Build');
  if (!page?.webSocketDebuggerUrl) throw new Error('Build renderer target unavailable');

  const result = await cdpCommand(page.webSocketDebuggerUrl, 'Performance.getMetrics');
  const metrics = Object.fromEntries((result.metrics || []).map((metric) => [metric.name, metric.value]));
  const latencyMs = Date.now() - started;
  const now = Date.now();
  let taskBusyRatio;
  if (lastRendererTaskDuration !== undefined && lastRendererTaskTimestamp !== undefined) {
    const taskDelta = metrics.TaskDuration - lastRendererTaskDuration;
    const wallDelta = (now - lastRendererTaskTimestamp) / 1_000;
    if (wallDelta > 0) taskBusyRatio = Math.max(0, taskDelta / wallDelta);
  }
  lastRendererTaskDuration = metrics.TaskDuration;
  lastRendererTaskTimestamp = now;
  return {
    latencyMs,
    taskDuration: metrics.TaskDuration,
    taskBusyRatio,
    jsHeapUsedBytes: metrics.JSHeapUsedSize,
    jsHeapTotalBytes: metrics.JSHeapTotalSize,
    domNodes: metrics.Nodes,
    documents: metrics.Documents,
    frames: metrics.Frames,
    targetCount: targets.length,
    webviewTargets: targets.filter((target) => target.type === 'webview').length,
  };
}

function captureDeepSample(rendererPid, reason) {
  const now = Date.now();
  if (!rendererPid || now - lastDeepSampleAt < 5 * 60_000) return;
  lastDeepSampleAt = now;
  totals.deepSamples += 1;
  const samplePath = path.join(outputDir, `${dateKey}-${now}-${reason}.sample.txt`);
  execFile('sample', [String(rendererPid), '5', '1', '-mayDie', '-file', samplePath], () => {});
  append({ type: 'deep-sample', at: new Date(now).toISOString(), rendererPid, reason, samplePath });
}

async function sample() {
  const at = new Date();
  const processes = getProcesses();
  const renderers = processes.filter((process) => process.kind === 'renderer' && !process.browserGuest);
  const mainRenderer = renderers.sort((a, b) => b.cpu - a.cpu)[0];
  const logEvents = parseLogEvents(readNewBuildLog());
  let renderer;
  let cdpError;
  try {
    renderer = await getRendererMetrics();
  } catch (error) {
    totals.cdpFailures += 1;
    cdpError = error instanceof Error ? error.message : String(error);
  }

  totals.samples += 1;
  totals.maxRendererCpu = Math.max(totals.maxRendererCpu, mainRenderer?.cpu || 0);
  totals.maxRendererRssKb = Math.max(totals.maxRendererRssKb, mainRenderer?.rssKb || 0);
  totals.maxCdpLatencyMs = Math.max(totals.maxCdpLatencyMs, renderer?.latencyMs || 0);
  totals.maxTaskBusyRatio = Math.max(totals.maxTaskBusyRatio, renderer?.taskBusyRatio || 0);

  const record = {
    type: 'sample',
    at: at.toISOString(),
    processes,
    renderer,
    cdpError,
    logEvents,
  };
  append(record);

  const transcriptStorm = logEvents.duplicateCollapses + logEvents.prefixDuplicateCollapses >= 3;
  const rendererHot = (mainRenderer?.cpu || 0) >= 45;
  const rendererBlocked = !renderer || renderer.latencyMs >= 1_000 || (renderer.taskBusyRatio || 0) >= 0.75;
  if (transcriptStorm || rendererHot || rendererBlocked) {
    const reason = transcriptStorm ? 'transcript-storm' : rendererBlocked ? 'renderer-blocked' : 'renderer-hot';
    captureDeepSample(mainRenderer?.pid, reason);
  }

  if (Date.now() - lastMinuteSummaryAt >= 60_000) {
    lastMinuteSummaryAt = Date.now();
    console.log(JSON.stringify({
      at: at.toISOString(),
      rendererCpu: mainRenderer?.cpu,
      rendererRssMb: mainRenderer ? Math.round(mainRenderer.rssKb / 1024) : undefined,
      cdpLatencyMs: renderer?.latencyMs,
      taskBusyRatio: renderer?.taskBusyRatio,
      logEvents,
      outputPath,
    }));
  }
}

function finish(signal) {
  if (stopping) return;
  stopping = true;
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stopAt: stopAt.toISOString(),
    signal,
    intervalMs,
    outputPath,
    ...totals,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  append({ type: 'summary', ...summary });
  console.log(JSON.stringify(summary));
  process.exit(0);
}

process.on('SIGINT', () => finish('SIGINT'));
process.on('SIGTERM', () => finish('SIGTERM'));
process.on('uncaughtException', (error) => {
  append({ type: 'observer-error', at: new Date().toISOString(), error: error.stack || String(error) });
});
process.on('unhandledRejection', (error) => {
  append({ type: 'observer-error', at: new Date().toISOString(), error: error instanceof Error ? error.stack : String(error) });
});

append({
  type: 'start',
  startedAt: startedAt.toISOString(),
  stopAt: stopAt.toISOString(),
  intervalMs,
  buildLogPath,
  outputPath,
});
console.log(JSON.stringify({ startedAt: startedAt.toISOString(), stopAt: stopAt.toISOString(), outputPath }));

async function loop() {
  while (!stopping && Date.now() < stopAt.getTime()) {
    const iterationStartedAt = Date.now();
    await sample().catch((error) => {
      append({ type: 'observer-error', at: new Date().toISOString(), error: error.stack || String(error) });
    });
    const delay = Math.max(250, intervalMs - (Date.now() - iterationStartedAt));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  finish('completed');
}

void loop();
