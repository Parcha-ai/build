import { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { Session } from '../../shared/types';
import { SessionService } from '../services/session.service';
import { getMainWindow, broadcastToAll } from '../index';
import { browserService } from '../services/browser.service';
import { claudeService } from './claude.ipc';
import { sshService } from '../services/ssh.service';
import Store from 'electron-store';
import { v4 as uuid } from 'uuid';
import { getSessionStoreName } from '../store-names';
import { CachedStore } from '../cached-store';

const sessionService = new SessionService();

// Export sessionService for use by other IPC handlers that need session data
export { sessionService };

export function registerSessionHandlers(ipcMain: IpcMain): void {
  // Subscribe to session status changes
  sessionService.on('statusChanged', (session) => {
    broadcastToAll(IPC_CHANNELS.SESSION_STATUS_CHANGED, session);
  });

  sessionService.on('sessionsUpdated', (sessions) => {
    broadcastToAll(IPC_CHANNELS.SESSION_LIST_UPDATED, sessions);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_, config) => {
    return sessionService.createSession(config);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_START, async (_, sessionId: string) => {
    return sessionService.startSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_STOP, async (_, sessionId: string) => {
    return sessionService.stopSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionId: string) => {
    // Clean up service-level Maps before deleting the session data
    claudeService.cleanupSession(sessionId);
    browserService.cleanupSession(sessionId);
    return sessionService.deleteSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    return sessionService.listSessions();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_, sessionId: string) => {
    return sessionService.getSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_UPDATE, async (_, sessionId: string, updates) => {
    return sessionService.updateSession(sessionId, updates);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_REWIND_FORK, async (_, sessionId: string, rewindToMessageId: string) => {
    return sessionService.rewindAndForkSession(sessionId, rewindToMessageId);
  });

  // Conversation fork handlers
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE_FORK, async (
    _,
    parentSessionId: string,
    forkPoint: string,
    initialMessage?: string
  ) => {
    return sessionService.createForkFromInput(parentSessionId, forkPoint, initialMessage);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_FAST_STACK_FORK, async (_, sessionId: string) => {
    claudeService.prepareFastStack(sessionId);
    return sessionService.fastStackForkInPlace(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_FORK_GROUP, async (_, sessionId: string) => {
    const allSessions = await sessionService.listSessions();
    const currentSession = allSessions.find(s => s.id === sessionId);
    if (!currentSession) return [];

    // Find root session (walk up parentSessionId chain)
    let rootId = sessionId;
    let session: Session | undefined = currentSession;
    while (session?.parentSessionId) {
      rootId = session.parentSessionId;
      session = allSessions.find(s => s.id === rootId);
      if (!session) break; // Guard against missing parent
    }

    // Collect all sessions in fork group (root + all descendants)
    const root = allSessions.find(s => s.id === rootId);
    if (!root) return [];

    const forkGroup = [root, ...allSessions.filter(s => s.parentSessionId === rootId)];

    // Sort by creation order
    return forkGroup.sort((a, b) =>
      (a.forkCreatedAt || a.createdAt).getTime() - (b.forkCreatedAt || b.createdAt).getTime()
    );
  });

  /**
   * Scan remote transcripts for an SSH session's working directory.
   * Creates session records for any transcripts that don't already have one.
   * Returns the list of newly created sessions.
   */
  ipcMain.handle(IPC_CHANNELS.SESSION_SCAN_REMOTE, async (_, sessionId: string) => {
    const allSessions = await sessionService.listSessions();
    const session = allSessions.find(s => s.id === sessionId);
    if (!session?.sshConfig) return [];

    const workdir = session.sshConfig.remoteWorkdir || session.worktreePath || '';
    if (!workdir) return [];

    console.log(`[Session IPC] Scanning remote transcripts for ${sessionId.substring(0, 8)} at ${workdir}`);

    try {
      const probeId = `scan-${uuid().substring(0, 8)}`;
      const transcripts = await sshService.listRemoteTranscripts(probeId, session.sshConfig, workdir);

      // Build set of SDK session IDs we already know about
      const sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;
      const mappings = (sessionStore.get('sdkSessionMappings') || {}) as Record<string, string>;
      const knownSdkIds = new Set(Object.values(mappings));
      // Also include session IDs themselves (some map to themselves)
      for (const s of allSessions) {
        knownSdkIds.add(s.id);
        if (s.sdkSessionId) knownSdkIds.add(s.sdkSessionId);
      }

      const newSessions: Session[] = [];
      for (const t of transcripts) {
        if (knownSdkIds.has(t.sessionId)) continue;

        const newSession: Session = {
          ...session,
          id: t.sessionId,
          name: `Session ${t.sessionId.substring(0, 8)}`,
          sdkSessionId: t.sessionId,
          parentSessionId: sessionId,
          childSessionIds: [],
          isRoot: false,
          tabHidden: true, // Hide by default — user opens via overflow menu
          createdAt: new Date(t.mtime * 1000),
          updatedAt: new Date(t.mtime * 1000),
          forkCreatedAt: new Date(t.mtime * 1000),
          forkPoint: 'end',
          status: 'stopped' as any,
        };

        sessionStore.set(`sessions.${t.sessionId}`, newSession);
        sessionStore.set(`sdkSessionMappings.${t.sessionId}`, t.sessionId);
        newSessions.push(newSession);
        console.log(`[Session IPC] Created session record for orphan transcript: ${t.sessionId.substring(0, 8)}`);
      }

      // Add new sessions to parent's childSessionIds
      if (newSessions.length > 0) {
        const parentChildren = [...(session.childSessionIds || [])];
        for (const ns of newSessions) {
          if (!parentChildren.includes(ns.id)) {
            parentChildren.push(ns.id);
          }
        }
        sessionStore.set(`sessions.${sessionId}.childSessionIds`, parentChildren);
        sessionStore.set(`sessions.${sessionId}.isRoot`, true);
        console.log(`[Session IPC] Added ${newSessions.length} orphan(s) as children of ${sessionId.substring(0, 8)}`);
      }

      return newSessions;
    } catch (err) {
      console.error('[Session IPC] Remote scan failed:', err);
      return [];
    }
  });
}
