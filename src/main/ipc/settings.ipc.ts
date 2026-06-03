import { IpcMain, app, shell, dialog, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { SettingsService } from '../services/settings.service';

// Track the detached browser window
let browserWindow: BrowserWindow | null = null;

const settingsService = new SettingsService();

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return settingsService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_, settings) => {
    return settingsService.setSettings(settings);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RESET, async () => {
    return settingsService.resetSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_API_KEY, async () => {
    return settingsService.getApiKey() || '';
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_API_KEY, async (_, key: string) => {
    settingsService.setApiKey(key);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_GOOGLE_API_KEY, async () => {
    return settingsService.getGoogleApiKey() || '';
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_GOOGLE_API_KEY, async (_, key: string) => {
    settingsService.setGoogleApiKey(key);
  });

  // App utilities
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXTERNAL, async (_, url: string) => {
    try {
      await shell.openExternal(url);
    } catch (err) {
      console.error('[Settings IPC] shell.openExternal failed, falling back to open command:', err);
      execFile('open', [url]);
    }
  });

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_PATH, async (_, filePath: string) => {
    return await shell.openPath(filePath);
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_PATH, async (_, name: string) => {
    return app.getPath(name as Parameters<typeof app.getPath>[0]);
  });

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_DIALOG, async (_, options) => {
    return dialog.showOpenDialog(options);
  });

  // Browser pop-out window for Command Center mode
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_BROWSER_WINDOW, async (event) => {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.focus();
      return;
    }

    const parentWindow = BrowserWindow.fromWebContents(event.sender);

    // Get preload path from parent window's webPreferences
    const parentPreload = (parentWindow?.webContents as any)?.session
      ? undefined : undefined;
    // Use the same preload as main window by reading from its webPreferences
    const mainPreloadPath = (parentWindow as any)?.__preloadPath;

    browserWindow = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 400,
      minHeight: 300,
      title: 'Browser Preview',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 15, y: 10 },
      backgroundColor: '#1a1a1a',
      webPreferences: {
        preload: mainPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    // Load the same renderer URL with a query param for browser-only mode
    const mainUrl = event.sender.getURL().split('#')[0].split('?')[0];
    browserWindow.loadURL(`${mainUrl}?mode=browser`);

    browserWindow.on('closed', () => {
      browserWindow = null;
      if (parentWindow && !parentWindow.isDestroyed()) {
        parentWindow.webContents.send('browser-window-closed');
      }
    });
  });

  ipcMain.handle(IPC_CHANNELS.APP_CLOSE_BROWSER_WINDOW, async () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.close();
      browserWindow = null;
    }
  });

  // Docker status
  ipcMain.handle(IPC_CHANNELS.DOCKER_STATUS, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Docker = require('dockerode');
    const docker = new Docker();
    try {
      const info = await docker.info();
      return { available: true, version: info.ServerVersion };
    } catch {
      return { available: false };
    }
  });
}
