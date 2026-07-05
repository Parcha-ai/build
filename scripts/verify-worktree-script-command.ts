import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Guards the worktree setup command construction: user scripts routinely end
// with a trailing newline (or a comment), and naive `${script} && echo MARKER`
// interpolation strands the `&& echo` on its own line — a bash syntax error
// that aborts AFTER the script ran, falsely reporting setup failure and losing
// the captured working directory.

const root = path.resolve(__dirname, '..');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

// 1. The script must be trimmed and wrapped in a brace group on its own lines.
assert.match(sshService, /const trimmedScript = script\.trim\(\);/);
assert.match(sshService, /Worktree setup script is empty/);
assert.match(sshService, /cd ~ && \{\\n\$\{trimmedScript\}\\n\} && echo "___WORKDIR_END___"/);
assert.doesNotMatch(
  sshService,
  /cd ~ && \$\{script\} && echo/,
  'raw script interpolation strands && echo after a trailing newline'
);

// 2. Behavioral proof of the construction, mirroring runWorktreeScript.
const buildCommand = (script: string) => `true; cd ~ && {\n${script.trim()}\n} && echo "___WORKDIR_END___"`;
const run = (script: string): { stdout: string; code: number } => {
  try {
    return { stdout: execFileSync('bash', ['-c', buildCommand(script)], { encoding: 'utf8' }), code: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    return { stdout: e.stdout || '', code: e.status ?? 1 };
  }
};

// Trailing newline — the original bug shape.
const trailing = run('echo setup_ok\n');
assert.strictEqual(trailing.code, 0, 'trailing-newline script must succeed');
assert.match(trailing.stdout, /setup_ok/);
assert.match(trailing.stdout, /___WORKDIR_END___/);

// Script ending with a comment line.
const comment = run('echo setup_ok\n# done\n');
assert.strictEqual(comment.code, 0, 'comment-terminated script must succeed');
assert.match(comment.stdout, /___WORKDIR_END___/);

// Failing script must still fail and must NOT emit the marker.
const failing = run('echo before_fail\nfalse\n');
assert.notStrictEqual(failing.code, 0, 'failing script must propagate failure');
assert.doesNotMatch(failing.stdout, /___WORKDIR_END___/);

console.log('verify-worktree-script-command: all checks passed');
