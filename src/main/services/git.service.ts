import simpleGit, { SimpleGit, LogResult } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import type { Commit, Branch, FileChange, Session } from '../../shared/types';

interface BranchWatcher {
  watcher: fs.FSWatcher;
  lastBranch: string | null;
  headPath: string;
}

export type BranchChangeCallback = (sessionId: string, branch: string) => void;

export class GitService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private watchers: Map<string, BranchWatcher> = new Map();
  private branchChangeCallback: BranchChangeCallback | null = null;

  constructor() {
    this.store = new CachedStore({ name: getSessionStoreName() }) as any;
  }

  /**
   * Set callback for branch change events
   */
  onBranchChange(callback: BranchChangeCallback): void {
    this.branchChangeCallback = callback;
  }

  private getWorktreePath(sessionId: string): string {
    const session = (this.store.get(`sessions.${sessionId}`)
      || this.store.get(`discoveredSessions.${sessionId}`)) as Pick<Session, 'worktreePath' | 'repoPath'> | undefined;
    const worktreePath = session?.worktreePath || session?.repoPath;
    if (!worktreePath) throw new Error(`Session ${sessionId} not found`);
    return worktreePath;
  }

  private getGit(sessionId: string): SimpleGit {
    const worktreePath = this.getWorktreePath(sessionId);
    return simpleGit(worktreePath);
  }

  async clone(url: string, targetPath: string): Promise<void> {
    const git = simpleGit();
    await git.clone(url, targetPath);
  }

  async createWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    const git = simpleGit(repoPath);

    // Check if branch exists
    const branches = await git.branch();
    const branchExists = branches.all.includes(branch) ||
                         branches.all.includes(`remotes/origin/${branch}`);

    if (branchExists) {
      await git.raw(['worktree', 'add', worktreePath, branch]);
    } else {
      // Create new branch from current HEAD
      await git.raw(['worktree', 'add', '-b', branch, worktreePath]);
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    const git = simpleGit(repoPath);
    await git.raw(['worktree', 'remove', worktreePath, '--force']);
  }

  async getStatus(sessionId: string): Promise<{
    current: string | null;
    tracking: string | null;
    files: FileChange[];
    ahead: number;
    behind: number;
  }> {
    const session = (this.store.get(`sessions.${sessionId}`)
      || this.store.get(`discoveredSessions.${sessionId}`)) as Pick<Session, 'worktreePath' | 'repoPath' | 'branch'> | undefined;
    const worktreePath = session?.worktreePath || session?.repoPath;
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      return {
        current: session?.branch || null,
        tracking: null,
        files: [],
        ahead: 0,
        behind: 0,
      };
    }

    const git = simpleGit(worktreePath);
    const status = await git.status();

    return {
      current: status.current,
      tracking: status.tracking,
      files: [
        ...status.created.map(f => ({ path: f, status: 'added' as const, additions: 0, deletions: 0 })),
        ...status.modified.map(f => ({ path: f, status: 'modified' as const, additions: 0, deletions: 0 })),
        ...status.deleted.map(f => ({ path: f, status: 'deleted' as const, additions: 0, deletions: 0 })),
        ...status.renamed.map(r => ({ path: r.to, status: 'renamed' as const, additions: 0, deletions: 0 })),
      ],
      ahead: status.ahead,
      behind: status.behind,
    };
  }

  async getLog(sessionId: string, limit = 50): Promise<Commit[]> {
    const git = this.getGit(sessionId);
    const log = await git.log({ maxCount: limit });

    return log.all.map(entry => ({
      hash: entry.hash,
      message: entry.message,
      author: entry.author_name,
      authorEmail: entry.author_email,
      date: new Date(entry.date),
      parents: entry.refs.split(',').filter(Boolean),
    }));
  }

  async getBranches(sessionId: string): Promise<Branch[]> {
    const git = this.getGit(sessionId);
    const branches = await git.branch(['-a', '-v']);

    return branches.all.map(name => ({
      name: name.replace('remotes/origin/', ''),
      current: name === branches.current,
      remote: name.startsWith('remotes/') ? name.split('/')[1] : undefined,
      commit: branches.branches[name]?.commit || '',
    }));
  }

  async checkout(sessionId: string, branch: string): Promise<void> {
    const git = this.getGit(sessionId);
    await git.checkout(branch);
  }

  async getDiff(sessionId: string, commitHash?: string): Promise<string> {
    const git = this.getGit(sessionId);

    if (commitHash) {
      return git.diff([`${commitHash}^`, commitHash]);
    }

    // Get diff of working directory
    const staged = await git.diff(['--staged']);
    const unstaged = await git.diff();

    return `${staged}\n${unstaged}`.trim();
  }

  async commit(sessionId: string, message: string): Promise<string> {
    const git = this.getGit(sessionId);

    // Stage all changes
    await git.add('.');

    const result = await git.commit(message);
    return result.commit;
  }

  async push(sessionId: string): Promise<void> {
    const git = this.getGit(sessionId);
    const status = await git.status();

    if (status.tracking) {
      await git.push();
    } else if (status.current) {
      await git.push(['-u', 'origin', status.current]);
    }
  }

  async pull(sessionId: string): Promise<void> {
    const git = this.getGit(sessionId);
    await git.pull();
  }

  async stash(sessionId: string): Promise<void> {
    const git = this.getGit(sessionId);
    await git.stash();
  }

  async stashPop(sessionId: string): Promise<void> {
    const git = this.getGit(sessionId);
    await git.stash(['pop']);
  }

  /**
   * Get the .git/HEAD file path for a session
   * Handles both regular repos and worktrees
   */
  private getHeadPath(sessionId: string): string {
    const worktreePath = this.getWorktreePath(sessionId);
    const gitPath = path.join(worktreePath, '.git');

    // Check if .git is a file (worktree) or directory (regular repo)
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        // Worktree: .git file contains path to actual gitdir
        const gitFileContent = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = gitFileContent.match(/^gitdir: (.+)$/);
        if (match) {
          return path.join(match[1], 'HEAD');
        }
      }
    } catch {
      // Fall through to default
    }

    // Regular repo or fallback
    return path.join(gitPath, 'HEAD');
  }

  /**
   * Read current branch from HEAD file
   */
  private readCurrentBranch(headPath: string): string | null {
    try {
      const content = fs.readFileSync(headPath, 'utf-8').trim();
      // HEAD typically contains "ref: refs/heads/branch-name"
      const match = content.match(/^ref: refs\/heads\/(.+)$/);
      if (match) {
        return match[1];
      }
      // Detached HEAD - just return the commit hash (truncated)
      return content.substring(0, 8);
    } catch {
      return null;
    }
  }

  /**
   * Start watching for branch changes on a session
   */
  watchBranch(sessionId: string): { success: boolean; branch?: string; error?: string } {
    // Already watching
    if (this.watchers.has(sessionId)) {
      const existing = this.watchers.get(sessionId)!;
      return { success: true, branch: existing.lastBranch || undefined };
    }

    try {
      const headPath = this.getHeadPath(sessionId);
      const initialBranch = this.readCurrentBranch(headPath);

      // Watch the HEAD file
      const watcher = fs.watch(headPath, (eventType) => {
        if (eventType === 'change') {
          const newBranch = this.readCurrentBranch(headPath);
          const watcherData = this.watchers.get(sessionId);

          if (watcherData && newBranch && newBranch !== watcherData.lastBranch) {
            console.log(`[GitService] Branch changed: ${watcherData.lastBranch} → ${newBranch} (session: ${sessionId})`);
            watcherData.lastBranch = newBranch;

            if (this.branchChangeCallback) {
              this.branchChangeCallback(sessionId, newBranch);
            }
          }
        }
      });

      this.watchers.set(sessionId, {
        watcher,
        lastBranch: initialBranch,
        headPath,
      });

      console.log(`[GitService] Started watching branch for session ${sessionId}: ${initialBranch}`);
      return { success: true, branch: initialBranch || undefined };
    } catch (error) {
      console.error(`[GitService] Failed to watch branch for session ${sessionId}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Stop watching for branch changes on a session
   */
  unwatchBranch(sessionId: string): void {
    const watcherData = this.watchers.get(sessionId);
    if (watcherData) {
      watcherData.watcher.close();
      this.watchers.delete(sessionId);
      console.log(`[GitService] Stopped watching branch for session ${sessionId}`);
    }
  }

  /**
   * Clean up all watchers
   */
  dispose(): void {
    for (const [sessionId, watcherData] of this.watchers) {
      watcherData.watcher.close();
      console.log(`[GitService] Disposed watcher for session ${sessionId}`);
    }
    this.watchers.clear();
  }
}
