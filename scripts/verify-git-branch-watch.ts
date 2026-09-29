import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGitHeadPath } from '../src/main/services/git.service';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-git-watch-'));
try {
  const plainFolder = path.join(root, 'plain');
  fs.mkdirSync(plainFolder);
  assert.throws(() => resolveGitHeadPath(plainFolder), /not a Git repository/);

  const repository = path.join(root, 'repository');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(resolveGitHeadPath(repository), path.join(repository, '.git', 'HEAD'));

  const worktree = path.join(root, 'worktree');
  const worktreeGitDirectory = path.join(root, 'git-data', 'worktrees', 'feature');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(worktreeGitDirectory, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDirectory, 'HEAD'), 'ref: refs/heads/feature\n');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, worktreeGitDirectory)}\n`);
  assert.equal(resolveGitHeadPath(worktree), path.join(worktreeGitDirectory, 'HEAD'));

  console.log('Git branch watch verifier passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
