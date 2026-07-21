import { IpcMain, BrowserWindow } from 'electron';
import { CachedStore } from '../cached-store';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { GitService } from '../services/git.service';
import { sshService } from '../services/ssh.service';
import { getSessionStoreName } from '../store-names';
import type { PullRequestStatus, PullRequestStatusResult, Session } from '../../shared/types';
import { normalizeGitHubRepository, parsePullRequestStatus } from '../../shared/utils/pull-request-status';

const gitService = new GitService();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;
const pullRequestStatusCache = new Map<string, { value: PullRequestStatusResult; expiresAt: number }>();
const pullRequestStatusPending = new Map<string, Promise<PullRequestStatusResult>>();
const MAX_CONCURRENT_REMOTE_PULL_REQUEST_LOOKUPS = 2;
let activeRemotePullRequestLookups = 0;
const remotePullRequestLookupWaiters: Array<() => void> = [];

async function withRemotePullRequestLookupSlot<T>(lookup: () => Promise<T>): Promise<T> {
  if (activeRemotePullRequestLookups >= MAX_CONCURRENT_REMOTE_PULL_REQUEST_LOOKUPS) {
    await new Promise<void>((resolve) => remotePullRequestLookupWaiters.push(resolve));
  }
  activeRemotePullRequestLookups += 1;
  try {
    return await lookup();
  } finally {
    activeRemotePullRequestLookups = Math.max(0, activeRemotePullRequestLookups - 1);
    remotePullRequestLookupWaiters.shift()?.();
  }
}

function getRemotePullRequestLookupSessionId(session: Session): string {
  const config = session.sshConfig!;
  return `pr-status:${config.username}@${config.host}:${config.port || 22}:${config.privateKeyPath || ''}`;
}

const getStoredSession = (sessionId: string): Session | undefined => {
  return (sessionStore.get(`sessions.${sessionId}`)
    || sessionStore.get(`discoveredSessions.${sessionId}`)) as Session | undefined;
};

// Set up branch change callback to emit to all windows
gitService.onBranchChange((sessionId, branch) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.GIT_BRANCH_CHANGED, { sessionId, branch });
  });
});

export function registerGitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_, sessionId: string) => {
    const session = getStoredSession(sessionId);
    if (session?.sshConfig) {
      const branch = await sshService.getRemoteBranch(sessionId, session.sshConfig).catch(() => null);
      return {
        current: branch || session.branch || null,
        tracking: null,
        files: [],
        ahead: 0,
        behind: 0,
      };
    }

    try {
      return await gitService.getStatus(sessionId);
    } catch {
      // Session directory doesn't exist or session not found — return safe default
      return { current: null, tracking: null, files: [], ahead: 0, behind: 0 };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LOG, async (_, sessionId: string, limit?: number) => {
    // SSH sessions have no local worktree — local git would always fail
    if (getStoredSession(sessionId)?.sshConfig) return [];
    try {
      return await gitService.getLog(sessionId, limit);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BRANCHES, async (_, sessionId: string) => {
    if (getStoredSession(sessionId)?.sshConfig) return [];
    try {
      return await gitService.getBranches(sessionId);
    } catch {
      // Must stay an array — the renderer maps/filters this directly
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHECKOUT, async (_, sessionId: string, branch: string) => {
    return gitService.checkout(sessionId, branch);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DIFF, async (_, sessionId: string, commitHash?: string) => {
    if (getStoredSession(sessionId)?.sshConfig) return '';
    try {
      return await gitService.getDiff(sessionId, commitHash);
    } catch {
      return '';
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, async (_, sessionId: string, message: string) => {
    return gitService.commit(sessionId, message);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, async (_, sessionId: string) => {
    return gitService.push(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PULL, async (_, sessionId: string) => {
    return gitService.pull(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CLONE, async (_, url: string, targetPath: string) => {
    return gitService.clone(url, targetPath);
  });

  // Get current branch for SSH sessions (runs git rev-parse on the remote)
  ipcMain.handle(IPC_CHANNELS.GIT_REMOTE_BRANCH, async (_, sessionId: string) => {
    const session = getStoredSession(sessionId);
    if (!session?.sshConfig) return null;
    return sshService.getRemoteBranch(sessionId, session.sshConfig);
  });

  // Branch watching handlers
  ipcMain.handle(IPC_CHANNELS.GIT_WATCH_BRANCH, async (_, sessionId: string) => {
    const session = getStoredSession(sessionId);
    if (session?.sshConfig) {
      const branch = await sshService.getRemoteBranch(sessionId, session.sshConfig).catch(() => null);
      return { success: true, branch: branch || undefined };
    }

    return gitService.watchBranch(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNWATCH_BRANCH, async (_, sessionId: string) => {
    gitService.unwatchBranch(sessionId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PULL_REQUEST_STATUS, async (_, sessionId: string) => {
    const session = getStoredSession(sessionId);
    if (!session) return { available: false, status: null } satisfies PullRequestStatusResult;
    const cacheKey = `${sessionId}:${session.branch}`;
    const cached = pullRequestStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const pending = pullRequestStatusPending.get(cacheKey);
    if (pending) return pending;

    const lookup = (async (): Promise<PullRequestStatusResult> => {
      try {
        let value: PullRequestStatus | null;
        if (session.sshConfig) {
          value = await withRemotePullRequestLookupSlot(async () => {
            const remoteWorkdir = session.worktreePath || session.sshConfig!.remoteWorkdir;
            const lookupSessionId = getRemotePullRequestLookupSessionId(session);
            try {
              return parsePullRequestStatus(await sshService.getRemotePullRequestJson(
                lookupSessionId,
                session.sshConfig!,
                session.branch,
                remoteWorkdir,
              ));
            } catch {
              const remoteUrl = await sshService.getRemoteOriginUrl(
                lookupSessionId,
                session.sshConfig!,
                remoteWorkdir,
              );
              const repository = remoteUrl ? normalizeGitHubRepository(remoteUrl) : null;
              return repository
                ? gitService.getPullRequestStatusForRepository(session.branch, { repository })
                : null;
            }
          });
        } else {
          value = await gitService.getPullRequestStatus(sessionId);
        }
        const result = { available: true, status: value } satisfies PullRequestStatusResult;
        pullRequestStatusCache.set(cacheKey, { value: result, expiresAt: Date.now() + 45_000 });
        return result;
      } catch {
        // A missing gh CLI, absent auth, or a repository without a GitHub remote
        // should not add noise to the UI or production logs. Retry after a
        // longer cooldown so configuring auth later recovers automatically.
        const result = { available: false, status: null } satisfies PullRequestStatusResult;
        pullRequestStatusCache.set(cacheKey, { value: result, expiresAt: Date.now() + 5 * 60_000 });
        return result;
      } finally {
        pullRequestStatusPending.delete(cacheKey);
      }
    })();
    pullRequestStatusPending.set(cacheKey, lookup);
    return lookup;
  });
}
