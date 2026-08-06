import assert from 'assert';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import type { SpawnedProcess } from '../src/main/services/ssh.service';
import { SSHService } from '../src/main/services/ssh.service';
import type { SSHConfig } from '../src/shared/types';

const target = process.env.BUILD_LIVE_SSH_TARGET || 'ubuntu@m';
const host = process.env.BUILD_LIVE_SSH_HOST || 'm';
const username = process.env.BUILD_LIVE_SSH_USER || 'ubuntu';
const privateKeyPath = process.env.BUILD_LIVE_SSH_KEY_PATH
  || path.join(os.homedir(), '.ssh', 'id_ed25519_2026');
const stableBridgePath = `/home/${username}/.build/bridge/claudette-remote-bridge.js`;
const sessionId = `dev-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
assert.match(sessionId, /^dev-live-\d+-[a-z0-9]+$/);

function remote(command: string): string {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, command], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function capture(processHandle: SpawnedProcess): {
  output: () => string;
  done: Promise<{ output: string; code: number | null }>;
} {
  let output = '';
  const done = new Promise<{ output: string; code: number | null }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for remote child; output=${JSON.stringify(output)}`)), 20_000);
    processHandle.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    processHandle.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    processHandle.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ output, code });
    });
  });
  return { output: () => output, done };
}

async function waitForOutput(getOutput: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!getOutput().includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${JSON.stringify(expected)}; output=${JSON.stringify(getOutput())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const service = new SSHService();
  const config: SSHConfig = {
    host,
    port: 22,
    username,
    privateKeyPath,
    remoteWorkdir: '/tmp',
  };

  try {
    await service.connect(sessionId, config);
    const firstProcess = service.createDetachedCommandProcess(sessionId, config, {
      command: '/usr/bin/node',
      args: ['-e', "setTimeout(() => { console.log('phase-one-start'); setTimeout(() => console.log('phase-one-after-disconnect'), 1500); }, 500)"],
      cwd: '/tmp',
      requireDetached: true,
    });
    const first = capture(firstProcess);
    await waitForOutput(first.output, 'phase-one-start');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Drop the owning SSH connection while the child is still running. The
    // bridge and child must remain alive and the service must recover the tail.
    service.disconnect(sessionId);
    const firstResult = await first.done;
    assert.equal(firstResult.code, 0);
    assert.match(firstResult.output, /phase-one-after-disconnect/);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reproduce the original stale-cache failure: the app still has a cached
    // install promise, while the remote file disappears between turns.
    remote(`rm -f -- '${stableBridgePath}'`);
    await service.connect(sessionId, config);
    const secondProcess = service.createDetachedCommandProcess(sessionId, config, {
      command: '/usr/bin/node',
      recoveryCommand: 'gemini',
      args: ['-e', "console.log('phase-two-after-reinstall'); setTimeout(() => {}, 2000)"],
      cwd: '/tmp',
      requireDetached: true,
    });
    const second = capture(secondProcess);
    const secondResult = await second.done;
    assert.equal(secondResult.code, 0);
    assert.match(secondResult.output, /phase-two-after-reinstall/);
    assert.equal(remote(`test -s '${stableBridgePath}' && printf ready`).trim(), 'ready');
    const jobs = await service.listDetachedBridgeJobs(sessionId, config);
    assert.equal(
      jobs.some((job) => job.command === 'gemini'),
      true,
      'detached bridge discovery must report the recovery harness, not its wrapper executable',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log('Live ubuntu@m detached SSH persistence verifier passed');
  } finally {
    service.disconnect(sessionId);
    remote(`rm -rf -- '/tmp/claudette-ssh-bridge/${sessionId}'`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
