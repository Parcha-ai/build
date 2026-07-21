import { BrowserWindow, type IpcMain, session as electronSession } from 'electron';
import { browserService } from '../services/browser.service';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type { BrowserChatInsertPayload } from '../../shared/types';

export function registerBrowserHandlers(ipcMain: IpcMain): void {
  // Browser previews also render in a detached window. DOM CustomEvents are
  // window-local, so relay captured screenshots/element context to every full
  // app renderer; the renderer that owns the target session accepts it.
  ipcMain.on(IPC_CHANNELS.BROWSER_CHAT_INSERT, (_event, payload: BrowserChatInsertPayload) => {
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.content !== 'string') {
      console.warn('[Browser IPC] Ignoring malformed browser chat insert');
      return;
    }

    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      const rendererUrl = win.webContents.getURL();
      if (rendererUrl.includes('mode=browser')) continue;
      win.webContents.send(IPC_CHANNELS.BROWSER_CHAT_INSERT, payload);
    }
  });

  // Capture snapshot
  ipcMain.handle(IPC_CHANNELS.BROWSER_CAPTURE_SNAPSHOT, async (_event, sessionId: string, url: string) => {
    try {
      const snapshot = await browserService.captureSnapshot(sessionId, url);
      return snapshot;
    } catch (error) {
      console.error('[Browser IPC] Error capturing snapshot:', error);
      throw error;
    }
  });

  // Navigate to URL
  ipcMain.handle(IPC_CHANNELS.BROWSER_NAVIGATE_TO, async (_event, sessionId: string, url: string) => {
    try {
      await browserService.navigate(sessionId, url);
      return { success: true };
    } catch (error) {
      console.error('[Browser IPC] Error navigating:', error);
      throw error;
    }
  });

  // Get last snapshot
  ipcMain.handle(IPC_CHANNELS.BROWSER_GET_SNAPSHOT, async (_event, sessionId: string) => {
    try {
      const snapshot = browserService.getSnapshot(sessionId);
      return snapshot;
    } catch (error) {
      console.error('[Browser IPC] Error getting snapshot:', error);
      throw error;
    }
  });

  // Clear all storage (cookies, localStorage, etc.) for the active browser profile.
  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_STORAGE, async (_event, sessionId?: string) => {
    try {
      const partitionName = sessionId ? browserService.getPartitionName(sessionId) : 'persist:browser';
      const webviewSession = electronSession.fromPartition(partitionName);

      // Clear all cookies
      await webviewSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
      });

      console.log('[Browser IPC] Storage cleared for partition:', partitionName);
      return { success: true };
    } catch (error) {
      console.error('[Browser IPC] Error clearing storage:', error);
      throw error;
    }
  });
}
