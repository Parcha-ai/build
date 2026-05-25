#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch {
        // Keep polling until timeout.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function extractBridgeScript() {
  const sourcePath = path.join(__dirname, '..', 'src', 'main', 'services', 'remote-bridge-script.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/String\.raw`([\s\S]*)`;\s*$/);
  if (!match) {
    throw new Error('Could not extract REMOTE_DETACHED_BRIDGE_SCRIPT');
  }
  return match[1];
}

function parseRecoveredText(logContent) {
  let text = '';
  let sawResult = false;

  for (const line of logContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    const message = JSON.parse(trimmed);
    if (message.type === 'stream_event' && message.event?.type === 'content_block_delta') {
      const delta = message.event.delta;
      if (delta?.type === 'text_delta') {
        text += delta.text || '';
      }
    }
    if (message.type === 'result') {
      sawResult = true;
    }
  }

  return { text, sawResult };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudette-bridge-verify-'));
  const bridgePath = path.join(tmp, 'bridge.js');
  const childPath = path.join(tmp, 'child.js');
  const jobDir = path.join(tmp, 'job');
  const configPath = path.join(jobDir, 'config.json');

  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(bridgePath, extractBridgeScript(), { mode: 0o700 });
  fs.writeFileSync(childPath, `
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  write({ type: 'system', session_id: 'verify-sdk-session', tools: [], model: 'claude-test' });
  write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } } });
  await sleep(400);
  write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after disconnect' } } });
  await sleep(100);
  write({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 }, model: 'claude-test' });
})();
`);

  const config = {
    jobDir,
    socketPath: path.join(jobDir, 'stdin.sock'),
    logPath: path.join(jobDir, 'stdout.log'),
    exitPath: path.join(jobDir, 'exit.json'),
    eofPath: path.join(jobDir, 'stdin.eof'),
    pidPath: path.join(jobDir, 'pid'),
    command: process.execPath,
    args: [childPath],
    cwd: tmp,
    env: {},
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const bridge = spawn(process.execPath, [bridgePath, 'spawn', configPath], {
    cwd: tmp,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgeExit = new Promise(resolve => bridge.once('exit', resolve));

  let bridgeStderr = '';
  bridge.stderr.on('data', chunk => {
    bridgeStderr += chunk.toString('utf8');
  });

  await waitFor(() => fs.existsSync(config.logPath) && fs.existsSync(config.pidPath), 'bridge log and pid');
  await waitFor(() => fs.readFileSync(config.logPath, 'utf8').includes('hello '), 'first streamed delta');

  const pid = fs.readFileSync(config.pidPath, 'utf8').trim();
  process.kill(Number(pid), 0);

  const midRun = parseRecoveredText(fs.readFileSync(config.logPath, 'utf8'));
  if (midRun.text !== 'hello ') {
    throw new Error(`Expected mid-run recovery text "hello ", got ${JSON.stringify(midRun.text)}`);
  }

  await waitFor(() => fs.existsSync(config.exitPath), 'bridge exit marker');
  await sleep(50);

  const finalLog = fs.readFileSync(config.logPath, 'utf8');
  const recovered = parseRecoveredText(finalLog);
  if (recovered.text !== 'hello after disconnect') {
    throw new Error(`Expected full recovered text, got ${JSON.stringify(recovered.text)}`);
  }
  if (!recovered.sawResult) {
    throw new Error('Expected recovered log to include result message');
  }

  const exit = JSON.parse(fs.readFileSync(config.exitPath, 'utf8'));
  if (exit.code !== 0) {
    throw new Error(`Expected child exit code 0, got ${JSON.stringify(exit)} stderr=${bridgeStderr}`);
  }

  await bridgeExit;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Detached SSH bridge resume simulation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
