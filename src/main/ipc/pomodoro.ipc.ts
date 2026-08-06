import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type { PomodoroStartRequest } from '../../shared/types';
import { pomodoroService } from '../services/pomodoro.service';

export function registerPomodoroHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.POMODORO_GET_STATE, () => pomodoroService.getState());
  ipcMain.handle(IPC_CHANNELS.POMODORO_START, (_event, request: PomodoroStartRequest) => pomodoroService.start(request));
  ipcMain.handle(IPC_CHANNELS.POMODORO_PAUSE, () => pomodoroService.pause());
  ipcMain.handle(IPC_CHANNELS.POMODORO_RESUME, () => pomodoroService.resume());
  ipcMain.handle(IPC_CHANNELS.POMODORO_STOP, () => pomodoroService.stop());
}
