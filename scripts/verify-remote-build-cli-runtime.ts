import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { REMOTE_BUILD_CLI_SOURCE } from '../src/main/services/remote-build-cli-source';

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a runtime test port.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function health(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

function requestJson(
  port: number,
  method: 'GET' | 'POST',
  requestPath: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const encoded = body ? Buffer.from(JSON.stringify(body)) : null;
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encoded ? {
        'Content-Type': 'application/json',
        'Content-Length': encoded.length,
      } : {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if ((response.statusCode || 500) >= 400) reject(new Error(String(payload.error || 'request failed')));
          else resolve(payload);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function waitForServer(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await health(port)) return;
    if (child.exitCode !== null) throw new Error(`Remote Build CLI exited before startup (${child.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out starting the Remote Build CLI test server.');
}

async function main(): Promise<void> {
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cli-runtime-'));
  const codexRuntimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cli-codex-context-'));
  const port = await availablePort();
  const serverPath = path.join(runtimeDirectory, 'server.js');
  const harnessPath = path.join(runtimeDirectory, 'fake-claude.js');
  const desktopJobRoot = path.join('/tmp/claudette-ssh-bridge', 'runtime-test-session');
  let server: ChildProcess | null = null;

  try {
    fs.writeFileSync(serverPath, REMOTE_BUILD_CLI_SOURCE, { mode: 0o600 });
    fs.writeFileSync(path.join(runtimeDirectory, 'index.html'), '<!doctype html><title>Build CLI test</title>', { mode: 0o600 });
    fs.writeFileSync(harnessPath, [
      '#!/usr/bin/env node',
      "setTimeout(() => {",
      "  console.log(JSON.stringify({ type: 'assistant', session_id: 'fake-resume-id', message: { content: [{ type: 'text', text: 'REMOTE_BUILD_CLI_TEST_OK' }] } }));",
      "  console.log(JSON.stringify({ type: 'result', session_id: 'fake-resume-id', result: 'REMOTE_BUILD_CLI_TEST_OK' }));",
      '}, 250);',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(path.join(runtimeDirectory, 'config.json'), JSON.stringify({
      version: 1,
      serverPort: port,
      sessionId: 'runtime-test-session',
      sessionName: 'Runtime test',
      host: 'test@localhost',
      branch: 'test',
      workingDirectory: runtimeDirectory,
      harness: 'claude',
      harnessCommand: harnessPath,
      permissionMode: 'acceptEdits',
      openAiApiKey: 'not-used-by-this-test',
      realtimeModel: 'gpt-realtime-test',
      tailscaleCommand: '',
      voiceMemory: {
        version: 1,
        entries: [{
          id: 'desktop-memory',
          role: 'user',
          content: 'Remember the desktop preference.',
          createdAt: '2026-07-26T12:00:00.000Z',
          sessionId: 'runtime-test-session',
          sessionName: 'Runtime test',
          source: 'desktop',
        }],
      },
    }, null, 2), { mode: 0o600 });

    server = spawn(process.execPath, [serverPath, 'serve'], {
      cwd: runtimeDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(port, server);

    const seededMemory = await requestJson(port, 'GET', '/api/memory') as { entries?: Array<{ id?: string }> };
    if (!seededMemory.entries?.some((entry) => entry.id === 'desktop-memory')) {
      throw new Error('Remote runtime did not seed durable desktop voice memory.');
    }
    const mergedMemory = await requestJson(port, 'POST', '/api/memory', {
      entries: [{
        id: 'remote-memory',
        role: 'assistant',
        content: 'I remember the earlier preference.',
        createdAt: '2026-07-26T12:01:00.000Z',
        sessionId: 'runtime-test-session',
        sessionName: 'Runtime test',
        source: 'remote',
      }],
    }) as { entries?: Array<{ id?: string }> };
    if (!mergedMemory.entries?.some((entry) => entry.id === 'desktop-memory')
      || !mergedMemory.entries.some((entry) => entry.id === 'remote-memory')) {
      throw new Error('Remote runtime did not merge desktop and remote voice memory.');
    }
    const persistedMemory = JSON.parse(fs.readFileSync(
      path.join(runtimeDirectory, 'voice-memory.json'),
      'utf8',
    )) as { entries?: Array<{ id?: string }> };
    if (!persistedMemory.entries?.some((entry) => entry.id === 'remote-memory')) {
      throw new Error('Remote runtime did not persist voice memory to disk.');
    }

    const submitted = JSON.parse(execFileSync(process.execPath, [serverPath, 'send', 'run the test'], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
    })) as { submitted?: boolean; queued?: boolean };
    if (!submitted.submitted || submitted.queued) throw new Error('The fake harness turn did not start immediately.');

    const startedAt = Date.now();
    const completed = JSON.parse(execFileSync(process.execPath, [serverPath, 'wait', '15'], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
      timeout: 20_000,
    })) as { status?: string; latestOutcome?: string; resumeId?: string };
    const elapsed = Date.now() - startedAt;
    if (completed.status !== 'idle') throw new Error(`Expected idle status, received ${completed.status}.`);
    if (completed.latestOutcome !== 'REMOTE_BUILD_CLI_TEST_OK') throw new Error('Wait returned a stale or missing harness outcome.');
    if (completed.resumeId !== 'fake-resume-id') throw new Error('The native resume ID was not persisted.');
    if (elapsed < 1_500) throw new Error('Wait returned before the detached harness log settled.');

    const desktopJobDirectory = path.join(desktopJobRoot, `${Date.now()}-desktop-test`);
    fs.mkdirSync(desktopJobDirectory, { recursive: true });
    fs.writeFileSync(path.join(desktopJobDirectory, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(desktopJobDirectory, 'metadata.json'), JSON.stringify({ command: 'claude' }));
    fs.writeFileSync(path.join(desktopJobDirectory, 'stdout.log'), `${JSON.stringify({
      type: 'thread.started',
      session_id: 'desktop-native-resume-id',
    })}\n`);
    const newerWrongHarnessDirectory = path.join(desktopJobRoot, `${Date.now() + 1}-wrong-harness`);
    fs.mkdirSync(newerWrongHarnessDirectory, { recursive: true });
    fs.writeFileSync(path.join(newerWrongHarnessDirectory, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(newerWrongHarnessDirectory, 'metadata.json'), JSON.stringify({ command: 'codex' }));
    fs.writeFileSync(path.join(newerWrongHarnessDirectory, 'stdout.log'), `${JSON.stringify({
      type: 'thread.started',
      thread_id: 'wrong-harness-resume-id',
    })}\n`);
    const desktopStatus = JSON.parse(execFileSync(process.execPath, [serverPath, 'status'], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
    })) as { status?: string; resumeId?: string; activeRun?: { source?: string } };
    if (desktopStatus.status !== 'working' || desktopStatus.activeRun?.source !== 'desktop-detached-runner') {
      throw new Error('The fake desktop harness job was not detected as active.');
    }
    if (desktopStatus.resumeId !== 'desktop-native-resume-id') {
      throw new Error('The runtime did not adopt the matching-harness resume ID from the active desktop job.');
    }

    const codexHome = path.join(codexRuntimeDirectory, 'home');
    const codexTranscriptDirectory = path.join(codexHome, '.codex', 'sessions', '2026', '07', '28');
    const codexTranscriptId = 'codex-native-transcript-id';
    fs.mkdirSync(codexTranscriptDirectory, { recursive: true });
    fs.writeFileSync(path.join(codexRuntimeDirectory, 'server.js'), REMOTE_BUILD_CLI_SOURCE, { mode: 0o600 });
    fs.writeFileSync(path.join(codexRuntimeDirectory, 'index.html'), '<!doctype html>', { mode: 0o600 });
    fs.writeFileSync(path.join(codexRuntimeDirectory, 'config.json'), JSON.stringify({
      version: 1,
      serverPort: await availablePort(),
      sessionId: 'codex-context-session',
      sessionName: 'Codex context test',
      host: 'test@localhost',
      branch: 'test',
      workingDirectory: codexRuntimeDirectory,
      harness: 'codex',
      harnessCommand: process.execPath,
      resumeId: 'codex-app-server-thread-id',
      transcriptId: codexTranscriptId,
      permissionMode: 'acceptEdits',
      openAiApiKey: 'not-used-by-this-test',
      realtimeModel: 'gpt-realtime-test',
      tailscaleCommand: '',
    }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(codexRuntimeDirectory, 'state.json'), JSON.stringify({
      version: 2,
      sessionId: 'codex-context-session',
      harness: 'codex',
      resumeId: 'codex-app-server-thread-id',
      activeRun: null,
      queue: [],
      lastOutcome: 'OK',
      lastError: '',
      updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    fs.writeFileSync(
      path.join(codexTranscriptDirectory, `rollout-2026-07-28T12-00-00-${codexTranscriptId}.jsonl`),
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<mission_control_policy>internal routing metadata</mission_control_policy>\nWhat is the current fix?',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'I fixed the substantive remote context pipeline and verified it.',
          },
        }),
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    const codexContext = execFileSync(process.execPath, [path.join(codexRuntimeDirectory, 'server.js'), 'context'], {
      cwd: codexRuntimeDirectory,
      encoding: 'utf8',
      env: { ...process.env, HOME: codexHome },
    });
    if (!codexContext.includes('What is the current fix?')
      || !codexContext.includes('I fixed the substantive remote context pipeline and verified it.')) {
      throw new Error('Remote voice context did not include the native Codex conversation.');
    }
    if (codexContext.includes('internal routing metadata') || codexContext.includes('mission_control_policy')) {
      throw new Error('Remote voice context leaked Build routing metadata into the user conversation.');
    }
    if (!codexContext.includes('Latest completed Build response:\nOK')) {
      throw new Error('Remote voice context did not include the live Build CLI outcome.');
    }

    console.log(`Remote Build CLI runtime verifier passed (${elapsed}ms completion wait, native Codex context loaded).`);
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    fs.rmSync(codexRuntimeDirectory, { recursive: true, force: true });
    fs.rmSync(desktopJobRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
