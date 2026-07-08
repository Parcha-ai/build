import { type IpcMain } from 'electron';
import { designService } from '../services/design.service';
import { SessionService } from '../services/session.service';
import { IPC_CHANNELS } from '../../shared/constants/channels';

const sessionService = new SessionService();

export function registerDesignHandlers(ipcMain: IpcMain): void {
  // Daemon + workspace status for a session (used by the design panel on mount)
  ipcMain.handle(IPC_CHANNELS.DESIGN_GET_STATUS, async (_event, sessionId: string) => {
    return {
      installed: designService.isInstalled(),
      daemonUrl: designService.getDaemonUrl(),
      workspace: designService.getWorkspaceForSession(sessionId),
    };
  });

  // Start the daemon and create/attach the session's design workspace.
  // Used when the user opens the design panel manually (agent-triggered
  // activation goes through the designMode MCP tool instead).
  ipcMain.handle(IPC_CHANNELS.DESIGN_ENSURE_WORKSPACE, async (_event, sessionId: string) => {
    const session = await sessionService.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const cwd = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir;
    if (!cwd) throw new Error('Session has no working directory');
    return designService.ensureDesignWorkspace(
      sessionId,
      cwd,
      session.name,
      session.sshConfig?.remoteWorkdir ? { config: session.sshConfig, remoteWorkdir: session.sshConfig.remoteWorkdir } : undefined
    );
  });

  // Manual "sync designs to remote now" (SSH sessions; no-op for local)
  ipcMain.handle(IPC_CHANNELS.DESIGN_PUSH_WORKSPACE, async (_event, sessionId: string) => {
    return { pushed: await designService.pushWorkspaceToRemote(sessionId) };
  });
}
