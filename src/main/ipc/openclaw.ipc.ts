import { IpcMain } from 'electron';
import { v4 as uuid } from 'uuid';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type { Session, OpenClawConfig } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStore: any = new CachedStore({ name: getSessionStoreName() });

export function registerOpenClawHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.OPENCLAW_CREATE_SESSION,
    async (
      _event,
      data: {
        name: string;
        openclawConfig: OpenClawConfig;
      }
    ) => {
      console.log('[OpenClaw IPC] Creating OpenClaw session:', data.name);

      try {
        const sessionId = uuid();

        const session: Session = {
          id: sessionId,
          name: data.name || 'OpenClaw',
          repoPath: '',
          worktreePath: '',
          branch: '',
          openclawConfig: data.openclawConfig,
          status: 'running',
          ports: { web: 0, api: 0, debug: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
          setupScript: '',
          isDevMode: true,
        };

        // Persist to electron-store
        sessionStore.set(`sessions.${sessionId}`, session);
        // Mark as new so getMessages() won't search for old transcripts
        sessionStore.set(`sdkSessionMappings.${sessionId}`, 'new');

        console.log('[OpenClaw IPC] Session created:', sessionId);
        return session;
      } catch (error) {
        console.error('[OpenClaw IPC] Failed to create session:', error);
        throw error;
      }
    }
  );
}
