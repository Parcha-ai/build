import { type IpcMain, session as electronSession } from 'electron';
import { browserService } from '../services/browser.service';
import { IPC_CHANNELS } from '../../shared/constants/channels';

export function registerBrowserHandlers(ipcMain: IpcMain): void {
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
      const partitionName = sessionId ? `persist:browser-${sessionId}` : 'persist:browser';
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
