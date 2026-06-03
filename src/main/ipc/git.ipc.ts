import { IpcMain, BrowserWindow } from 'electron';
import { CachedStore } from '../cached-store';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { GitService } from '../services/git.service';
import { sshService } from '../services/ssh.service';
import { getSessionStoreName } from '../store-names';
import type { Session } from '../../shared/types';

const gitService = new GitService();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;

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
    try {
      return await gitService.getLog(sessionId, limit);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BRANCHES, async (_, sessionId: string) => {
    try {
      return await gitService.getBranches(sessionId);
    } catch {
      return { all: [], current: null };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHECKOUT, async (_, sessionId: string, branch: string) => {
    return gitService.checkout(sessionId, branch);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DIFF, async (_, sessionId: string, commitHash?: string) => {
    return gitService.getDiff(sessionId, commitHash);
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
}
