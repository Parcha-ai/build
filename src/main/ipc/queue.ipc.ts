import { IpcMain, BrowserWindow } from 'electron';
import { messageQueueService } from '../services/message-queue.service';

export function registerQueueHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('queue:enqueue', (_e, sessionId: string, text: string, attachments?: unknown[], opts?: { id?: string; model?: string; suppressUserMessage?: boolean; deferDrain?: boolean }) => {
    return messageQueueService.enqueue(sessionId, text, attachments, opts);
  });

  ipcMain.handle('queue:remove', (_e, sessionId: string, messageId: string) => {
    messageQueueService.remove(sessionId, messageId);
  });

  ipcMain.handle('queue:edit', (_e, sessionId: string, messageId: string, newText: string) => {
    messageQueueService.edit(sessionId, messageId, newText);
  });

  ipcMain.handle('queue:moveToFront', (_e, sessionId: string, messageId: string) => {
    messageQueueService.moveToFront(sessionId, messageId);
  });

  ipcMain.handle('queue:clear', (_e, sessionId: string) => {
    messageQueueService.clear(sessionId);
  });

  ipcMain.handle('queue:getState', (_e, sessionId: string) => {
    return messageQueueService.getState(sessionId);
  });

  // Forward state changes to renderer
  messageQueueService.on('state-changed', (sessionId: string, state: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('queue:state-changed', sessionId, state);
      }
    }
  });
}
