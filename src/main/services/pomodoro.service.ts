import { BrowserWindow, Menu, nativeImage, Notification as ElectronNotification, Tray } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type { PomodoroStartRequest, PomodoroState, PomodoroUIRequest } from '../../shared/types';
import { DEFAULT_POMODORO_MINUTES, formatPomodoroTime } from '../../shared/utils/pomodoro';
import buildIconPath from '../../../assets/build-icon.png';

const DEFAULT_DURATION_SECONDS = DEFAULT_POMODORO_MINUTES * 60;

const IDLE_STATE: PomodoroState = {
  status: 'idle',
  external: false,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  remainingSeconds: DEFAULT_DURATION_SECONDS,
};

interface PomodoroStore {
  get(key: 'state', defaultValue: PomodoroState): PomodoroState;
  set(key: 'state', value: PomodoroState): void;
}

class PomodoroService {
  private readonly store = new Store({
    name: 'claudette-pomodoro',
    defaults: { state: IDLE_STATE },
  }) as unknown as PomodoroStore;
  private state: PomodoroState = { ...IDLE_STATE };
  private tray: Tray | null = null;
  private timer: NodeJS.Timeout | null = null;
  private createWindow: (() => void) | null = null;

  initialize(createWindow: () => void): void {
    this.createWindow = createWindow;
    this.state = this.store.get('state', IDLE_STATE);
    this.createTray();

    if (this.state.status === 'running') {
      this.refreshRemaining();
      if (this.state.status === 'running') this.startTicker();
    }
    this.updateTray();
  }

  getState(): PomodoroState {
    this.refreshRemaining();
    return { ...this.state };
  }

  isActive(): boolean {
    return this.state.status !== 'idle';
  }

  show(): void {
    this.openBuild({
      action: this.state.status === 'idle' ? 'start-first' : 'open-active',
      taskId: this.state.taskId,
      sessionId: this.state.sessionId,
    });
  }

  start(request: PomodoroStartRequest): PomodoroState {
    const durationSeconds = Math.max(60, Math.round((request.durationMinutes || 25) * 60));
    const now = Date.now();
    this.state = {
      status: 'running',
      taskId: request.taskId,
      taskTitle: request.taskTitle.trim(),
      subtaskId: request.subtaskId,
      subtaskTitle: request.subtaskTitle.trim(),
      sessionId: request.external ? undefined : request.sessionId,
      external: Boolean(request.external),
      durationSeconds,
      remainingSeconds: durationSeconds,
      startedAt: now,
      endsAt: now + durationSeconds * 1000,
    };
    this.persistAndBroadcast();
    this.startTicker();
    return this.getState();
  }

  pause(): PomodoroState {
    if (this.state.status !== 'running') return this.getState();
    this.refreshRemaining();
    if (this.state.status !== 'running') return this.getState();
    this.state = {
      ...this.state,
      status: 'paused',
      endsAt: undefined,
    };
    this.stopTicker();
    this.persistAndBroadcast();
    return this.getState();
  }

  resume(): PomodoroState {
    if (this.state.status !== 'paused') return this.getState();
    const now = Date.now();
    this.state = {
      ...this.state,
      status: 'running',
      endsAt: now + this.state.remainingSeconds * 1000,
    };
    this.persistAndBroadcast();
    this.startTicker();
    return this.getState();
  }

  stop(): PomodoroState {
    this.stopTicker();
    this.state = { ...IDLE_STATE };
    this.persistAndBroadcast();
    return this.getState();
  }

  dispose(): void {
    this.stopTicker();
    this.tray?.destroy();
    this.tray = null;
  }

  private refreshRemaining(): void {
    if (this.state.status !== 'running' || !this.state.endsAt) return;
    const remainingSeconds = Math.max(0, Math.ceil((this.state.endsAt - Date.now()) / 1000));
    if (remainingSeconds === 0) {
      this.finishSlot();
      return;
    }
    this.state = { ...this.state, remainingSeconds };
  }

  private finishSlot(): void {
    if (this.state.status === 'completed') return;
    this.stopTicker();
    this.state = {
      ...this.state,
      status: 'completed',
      remainingSeconds: 0,
      endsAt: undefined,
      completedAt: Date.now(),
    };
    this.persistAndBroadcast();

    if (ElectronNotification.isSupported()) {
      const notification = new ElectronNotification({
        title: 'Pomodoro complete',
        body: this.state.subtaskTitle
          ? `Did you finish “${this.state.subtaskTitle}”?`
          : 'Your focus slot is complete.',
        silent: false,
      });
      notification.on('click', () => this.openBuild({
        action: 'open-active',
        taskId: this.state.taskId,
        sessionId: this.state.sessionId,
      }));
      notification.show();
    }
  }

  private startTicker(): void {
    this.stopTicker();
    this.timer = setInterval(() => {
      const previous = this.state.remainingSeconds;
      this.refreshRemaining();
      if (this.state.remainingSeconds !== previous || this.state.status === 'completed') {
        this.broadcast();
        this.updateTray();
      }
    }, 1000);
    this.timer.unref?.();
  }

  private stopTicker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private persistAndBroadcast(): void {
    this.store.set('state', this.state);
    this.broadcast();
    this.updateTray();
  }

  private broadcast(): void {
    const state = { ...this.state };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.POMODORO_STATE_CHANGED, state);
    }
  }

  private createTray(): void {
    if (this.tray) return;
    const fallbackIconPath = path.join(process.resourcesPath, 'electron.icns');
    let icon = nativeImage.createFromPath(buildIconPath);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(fallbackIconPath);
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16, quality: 'best' });
    if (process.platform === 'darwin' && !icon.isEmpty()) icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Build Pomodoro');
    this.tray.on('click', () => this.show());
  }

  private updateTray(): void {
    if (!this.tray) return;
    const active = this.state.status !== 'idle';
    const time = formatPomodoroTime(this.state.remainingSeconds);
    this.tray.setTitle(active ? ` ${time}` : '');
    this.tray.setToolTip(active
      ? `${this.state.subtaskTitle || this.state.taskTitle || 'Pomodoro'} — ${time}`
      : 'Build Pomodoro');

    const template: Electron.MenuItemConstructorOptions[] = active ? [
      { label: this.state.taskTitle || 'Current task', enabled: false },
      ...(this.state.subtaskTitle ? [{ label: `Slot: ${this.state.subtaskTitle}`, enabled: false }] : []),
      { label: `${this.state.status === 'completed' ? 'Complete' : this.state.status === 'paused' ? 'Paused' : 'Remaining'}: ${time}`, enabled: false },
      { type: 'separator' },
      ...(this.state.status === 'running' ? [{ label: 'Pause', click: () => this.pause() }] : []),
      ...(this.state.status === 'paused' ? [{ label: 'Resume', click: () => this.resume() }] : []),
      {
        label: this.state.sessionId ? 'Open focus session' : 'Open Build',
        click: () => this.openBuild({
          action: 'open-active',
          taskId: this.state.taskId,
          sessionId: this.state.sessionId,
        }),
      },
      { label: 'Stop Pomodoro', click: () => this.stop() },
    ] : [
      {
        label: 'Start first task…',
        click: () => this.openBuild({ action: 'start-first' }),
      },
      { label: 'Open Build', click: () => this.openBuild({ action: 'open-active' }) },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private openBuild(request: PomodoroUIRequest): void {
    let window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) {
      this.createWindow?.();
      window = BrowserWindow.getAllWindows()[0];
    }
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const sendRequest = () => {
      if (!window?.isDestroyed()) window.webContents.send(IPC_CHANNELS.POMODORO_UI_REQUESTED, request);
    };
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => setTimeout(sendRequest, 250));
    }
    else sendRequest();
  }
}

export const pomodoroService = new PomodoroService();
