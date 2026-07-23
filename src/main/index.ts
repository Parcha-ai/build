import { app, BrowserWindow, ipcMain, protocol, session, net, Menu, systemPreferences } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';

// Dev instance name from environment variable (set by scripts/dev.sh)
export const DEV_INSTANCE_NAME = process.env.DEV_INSTANCE_NAME || null;

// File logging for production builds — writes to G-Build/main.log
if (!DEV_INSTANCE_NAME) {
  try {
    const logDir = path.join(app.getPath('userData'));
    const logPath = path.join(logDir, 'main.log');
    const maxLogBytes = 25 * 1024 * 1024;
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > maxLogBytes) {
      fs.renameSync(logPath, `${logPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const ts = () => new Date().toISOString();
    const formatArg = (arg: unknown): string => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    };
    const write = (level: 'LOG' | 'WARN' | 'ERROR', args: unknown[]): void => {
      const body = args.map(formatArg).join(' ');
      const capped = body.length > 6000 ? `${body.slice(0, 6000)}...[truncated ${body.length - 6000} chars]` : body;
      logStream.write(`${ts()} [${level}] ${capped}\n`);
    };
    console.log = (...args: unknown[]) => { write('LOG', args); origLog(...args); };
    console.warn = (...args: unknown[]) => { write('WARN', args); origWarn(...args); };
    console.error = (...args: unknown[]) => { write('ERROR', args); origError(...args); };
  } catch {
    // Non-fatal — logging is best-effort
  }
}

// Use separate user data directory for dev to avoid clobbering production data
if (process.env.GREP_DEV_USER_DATA) {
  app.setPath('userData', process.env.GREP_DEV_USER_DATA);
  console.log(`[Electron] Using dev userData: ${process.env.GREP_DEV_USER_DATA}`);
}

// Enable remote debugging for CDP access. The override is important for dev
// because production/stable builds may already own the default port.
const CDP_PORT = process.env.ELECTRON_CDP_PORT
  || (process.env.NODE_ENV === 'development' || DEV_INSTANCE_NAME ? '9223' : '9222');
app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT);
console.log(`[Electron] Using CDP port: ${CDP_PORT}`);

// CRITICAL: Fix PATH for packaged macOS apps launched from Finder
// Without this, spawned processes (like Claude Code) can't find 'node' because
// GUI apps don't inherit the user's shell PATH
import fixPath from 'fix-path';
fixPath();

// ADDITIONAL PATH FIX: Ensure common node locations are in PATH
// fix-path doesn't always work reliably, so add explicit fallbacks
const commonNodePaths = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/local/bin',
  `${process.env.HOME}/.nvm/versions/node/v*/bin`,
  `${process.env.HOME}/.nodenv/shims`,
  `${process.env.HOME}/.asdf/shims`,
];
const currentPath = process.env.PATH || '';
const missingPaths = commonNodePaths.filter(p => !currentPath.includes(p.replace('*', '')));
if (missingPaths.length > 0) {
  process.env.PATH = [...missingPaths, currentPath].join(':');
  console.log('[Electron] Added missing PATH entries:', missingPaths);
}
import { registerAuthHandlers } from './ipc/auth.ipc';
import { registerSessionHandlers } from './ipc/session.ipc';
import { registerGitHandlers } from './ipc/git.ipc';
import { registerTerminalHandlers } from './ipc/terminal.ipc';
import { registerClaudeHandlers , claudeService } from './ipc/claude.ipc';
import { registerSettingsHandlers } from './ipc/settings.ipc';
import { registerDevHandlers } from './ipc/dev.ipc';
import { registerFsHandlers } from './ipc/fs.ipc';
import { registerAudioHandlers } from './ipc/audio.ipc';
import { registerRealtimeHandlers } from './ipc/realtime.ipc';
import { registerVoiceHandlers } from './ipc/voice.ipc';
import { registerExtensionHandlers } from './ipc/extension.ipc';
import { registerBrowserHandlers } from './ipc/browser.ipc';
import { registerSSHHandlers } from './ipc/ssh.ipc';
import { registerMemoryHandlers } from './ipc/memory.ipc';
import { registerSecureKeysIPC } from './ipc/secure-keys.ipc';
import { registerQmdHandlers } from './ipc/qmd.ipc';
import { registerMcpHandlers } from './ipc/mcp.ipc';
import { registerPluginHandlers } from './ipc/plugin.ipc';
import { registerCodexHandlers } from './ipc/codex.ipc';
import { registerDesignHandlers } from './ipc/design.ipc';
import { registerOpenClawHandlers } from './ipc/openclaw.ipc';
import { registerAnalyticsHandlers } from './ipc/analytics.ipc';
import { registerQueueHandlers } from './ipc/queue.ipc';
import { getGStackModes, isGStackInstalled, installGStack, upgradeGStack } from './services/gstack.service';
import { mcpService } from './services/mcp.service';
import { IPC_CHANNELS } from '../shared/constants/channels';
import { cdpProxyService } from './services/cdp-proxy.service';
import { powerService } from './services/power.service';
import { maybeRunRendererCdpScript } from './services/renderer-cdp.service';
import { updateService } from './services/update.service';

// Global error handlers to prevent crashes from broken pipes and other uncaught errors
process.on('uncaughtException', (error: Error) => {
  // EPIPE errors occur when stdout/stderr is closed (e.g., terminal closed during development)
  // These are safe to ignore as they don't affect app functionality
  if (error.message.includes('EPIPE')) {
    // Silently ignore broken pipe errors
    return;
  }

  // Log other uncaught exceptions
  console.error('[Uncaught Exception]', error);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[Unhandled Rejection]', reason);
});

// Prevent stdout/stderr errors from crashing the app
if (process.stdout) {
  process.stdout.on('error', (error: Error) => {
    if (!error.message.includes('EPIPE')) {
      console.error('[stdout error]', error);
    }
  });
}

if (process.stderr) {
  process.stderr.on('error', (error: Error) => {
    if (!error.message.includes('EPIPE')) {
      console.error('[stderr error]', error);
    }
  });
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Disable Chromium privacy features that break OAuth and localStorage for third-party contexts
// These must be set before app.ready
app.commandLine.appendSwitch('disable-features', 'ThirdPartyCookieDeprecationTrialSettings,BlockThirdPartyCookies,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,PartitionedCookies,ThirdPartyStoragePartitioning');
app.commandLine.appendSwitch('enable-features', 'AllowSameSiteNoneCookies');

// Register custom protocol for Monaco assets - MUST be before app.ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'monaco-asset',
    privileges: {
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
      secure: true,
    },
  },
]);

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
const allWindows = new Set<BrowserWindow>();
const isMac = process.platform === 'darwin';
const BROWSER_PARTITION_PREFIX = 'browser-';
const BROWSER_PARTITION_KEEP_COUNT = 32;
const BROWSER_PARTITION_RECENT_MS = 6 * 60 * 60 * 1000;

function scheduleBrowserPartitionCleanup(): void {
  const timer = setTimeout(() => {
    void cleanupOldBrowserPartitions();
  }, 30_000);
  timer.unref?.();
}

async function cleanupOldBrowserPartitions(): Promise<void> {
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(partitionsDir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[Main] Failed to read browser partitions:', error);
    }
    return;
  }

  const partitions = (
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(BROWSER_PARTITION_PREFIX))
      .map(async entry => {
        const fullPath = path.join(partitionsDir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { name: entry.name, fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }))
  ).filter((entry): entry is { name: string; fullPath: string; mtimeMs: number } => !!entry);

  if (partitions.length <= BROWSER_PARTITION_KEEP_COUNT) return;

  const now = Date.now();
  const sorted = [...partitions].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(sorted.slice(0, BROWSER_PARTITION_KEEP_COUNT).map(entry => entry.name));
  let removed = 0;
  let failed = 0;

  for (const entry of sorted.slice(BROWSER_PARTITION_KEEP_COUNT)) {
    if (keep.has(entry.name)) continue;
    if (now - entry.mtimeMs < BROWSER_PARTITION_RECENT_MS) continue;
    try {
      await fs.promises.rm(entry.fullPath, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      console.warn('[Main] Failed to remove old browser partition:', entry.name, error);
    }
  }

  if (removed > 0 || failed > 0) {
    console.log('[Main] Browser partition cleanup complete:', {
      scanned: partitions.length,
      keptNewest: BROWSER_PARTITION_KEEP_COUNT,
      removed,
      failed,
    });
  }
}

if (process.env.GREP_DISABLE_SINGLE_INSTANCE !== '1') {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    console.log('[Main] Another Build instance is already running, exiting');
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    });
  }
}

const createWindow = (): void => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false, // Show after ready-to-show to prevent flash
    center: true, // Center on screen
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for node-pty
      webviewTag: true,
    },
  });

  // Store preload path on window for browser pop-out window creation
  (mainWindow as any).__preloadPath = MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY;

  // Set the main window reference IMMEDIATELY after creation
  // This ensures Claude service can send permission requests at any time
  claudeService.setMainWindow(mainWindow);
  console.log('[Main] Main window reference set for Claude service');

  const sendAppShortcutToFocusedWindow = (action: string) => {
    const target = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!target || target.isDestroyed()) return;
    target.webContents.send(IPC_CHANNELS.APP_SHORTCUT_TRIGGERED, { action });
  };

  // Set custom application menu to disable CMD+R reload (we handle it ourselves)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+Shift+N',
          click: () => createNewWindow(),
        },
        {
          label: 'New Session',
          accelerator: 'CommandOrControl+N',
          click: () => sendAppShortcutToFocusedWindow('new-session'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Removed 'reload' and 'forceReload' - we handle CMD+R ourselves
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Show window when ready to prevent blank screen
  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready to show');
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Fallback: force show after 3 seconds if ready-to-show doesn't fire
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('[Main] Forcing window to show (ready-to-show timeout)');
      mainWindow.show();
      mainWindow.center();
      mainWindow.focus();
    }
  }, 3000);

  // Load the index.html of the app.
  console.log('[Main] Loading renderer from:', MAIN_WINDOW_WEBPACK_ENTRY);
  console.log('[Main] __dirname:', __dirname);
  console.log('[Main] process.resourcesPath:', process.resourcesPath);

  mainWindow.webContents.once('did-finish-load', () => {
    void maybeRunRendererCdpScript(mainWindow as BrowserWindow);
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    .then(() => console.log('[Main] Renderer loaded successfully'))
    .catch(err => console.error('[Main] Failed to load renderer:', err));

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Renderer failed to load:', errorCode, errorDescription);
  });

  const sendShortcutToRenderer = (action: string) => {
    mainWindow?.webContents.send(IPC_CHANNELS.APP_SHORTCUT_TRIGGERED, { action });
  };

  // Intercept app shortcuts in the main process so packaged builds do not depend on
  // renderer focus state to deliver keyboard commands.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // NOTE: Ctrl+Tab interception is ONLY on webview's before-input-event
    // (see did-attach-webview handler below). Don't intercept here on the
    // main window — it kills native keydown/keyup events that the renderer's
    // useSessionSwitcher hook needs for the chat-focused case.

    const key = (input.key || '').toLowerCase();

    if (input.type !== 'keyDown') {
      return;
    }

    // On macOS, Control-based chords are normal textarea editing shortcuts
    // (for example Ctrl+F/Ctrl+B/Ctrl+K/Ctrl+T). Only treat Command as the
    // app shortcut modifier there.
    const primaryModifier = isMac ? input.meta : input.control;

    if (!primaryModifier || input.alt) {
      return;
    }

    let action: string | null = null;

    if (input.shift && key === 'n') {
      event.preventDefault();
      createNewWindow();
      return;
    } else if (!input.shift && key === 'n') {
      action = 'new-session';
    } else if (!input.shift && key === 'r') {
      action = 'browser-refresh';
    } else if (input.shift && key === 'g') {
      action = 'toggle-command-center';
    } else if (input.shift && key === 'f') {
      action = 'toggle-file-search';
    } else if (!input.shift && key === 'k') {
      action = 'toggle-quick-search';
    } else if (!input.shift && key === 's') {
      action = 'save-or-new-session';
    } else if (!input.shift && key === 'w') {
      action = 'close-editor-tab';
    } else if (!input.shift && key === 't') {
      action = 'fork-empty';
    // NOTE: Cmd+F is deliberately NOT intercepted here — it must reach Monaco's
    // built-in Find widget and the browser's native find-in-page.
    } else if (!input.shift && key === '[') {
      action = 'prev-fork';
    } else if (!input.shift && key === ']') {
      action = 'next-fork';
    } else if (!input.shift && key === 'b') {
      action = 'background-task';
    }

    if (action) {
      event.preventDefault();
      sendShortcutToRenderer(action);
      if (action === 'browser-refresh') {
        // Preserve the existing dedicated IPC event for older renderer code.
        mainWindow?.webContents.send(IPC_CHANNELS.APP_CMD_R_PRESSED);
      }
    }
  });

  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: monaco-asset:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: monaco-asset:",
          "style-src 'self' 'unsafe-inline' monaco-asset: https://fonts.googleapis.com",
          "connect-src 'self' https://api.anthropic.com https://api.github.com https://api.elevenlabs.io https://*.elevenlabs.io https://api.openai.com wss://*.livekit.cloud wss://*.elevenlabs.io ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* monaco-asset:",
          "img-src 'self' data: https: blob:",
          "font-src 'self' data: monaco-asset: https://fonts.gstatic.com",
          "worker-src 'self' blob: data: monaco-asset:",
        ].join('; ')
      }
    });
  });

  // Handle permission requests for the main window (media, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('[Main] Default session permission requested:', permission);
    // Allow media (includes microphone/camera) and other necessary permissions
    // 'media' covers microphone and camera access in Electron
    if (permission === 'media' || permission === 'notifications') {
      callback(true);
    } else {
      // For other permissions, use default behavior
      callback(true);
    }
  });

  // Also set the permission check handler for synchronous permission checks
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    // Allow media permissions for the app ('media' covers microphone/camera)
    if (permission === 'media') {
      return true;
    }
    return true;
  });

  // Configure webview partition session for browser preview
  const webviewSession = session.fromPartition('persist:browser');

  // Log storage path to verify it's persistent
  console.log('[Main] Webview session storage path:', webviewSession.getStoragePath());

  // Allow all permissions for browser preview webview
  webviewSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('[Main] Permission requested:', permission);
    callback(true);
  });

  // Handle webview creation - configure preferences
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    console.log('[Main] Attaching webview with partition:', params.partition);
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = false;
    webPreferences.sandbox = false; // Required for webview to work
    webPreferences.webSecurity = false; // Allow cross-origin requests in preview
    webPreferences.partition = params.partition || 'persist:browser';
    webPreferences.enableWebSQL = false;
    webPreferences.experimentalFeatures = true;
  });

  // After webview is attached, set up event handlers
  mainWindow.webContents.on('did-attach-webview', (event, webviewContents) => {
    console.log('[Main] Webview attached, id:', webviewContents.id);

    // Configure the actual per-Build-session guest partition. BrowserPreview
    // uses persist:browser-<rootSessionId>, so configuring only the legacy
    // persist:browser session would leave grouped tabs without permissions.
    webviewContents.session.setPermissionRequestHandler((_requestingContents, _permission, callback) => {
      callback(true);
    });

    // Forward Ctrl+Tab from webview to main window renderer so the session
    // switcher works even when the browser preview has focus. Webview has
    // its own renderer process — keyboard events don't reach the parent.
    webviewContents.on('before-input-event', (evt, input) => {
      const k = (input.key || '').toLowerCase();
      const primaryModifier = isMac ? input.meta : input.control;
      if (input.type === 'keyDown' && primaryModifier && input.shift && !input.alt && k === 'n') {
        evt.preventDefault();
        createNewWindow();
        return;
      }
      if (input.type === 'keyDown' && input.control && k === 'tab') {
        evt.preventDefault();
        mainWindow?.webContents.send('session-switcher', { action: input.shift ? 'prev' : 'next' });
      }
      if (input.type === 'keyUp' && k === 'control') {
        mainWindow?.webContents.send('session-switcher', { action: 'confirm' });
      }
    });

    webviewContents.on('did-finish-load', () => {
      console.log('[Main] Webview finished loading:', webviewContents.getURL());
    });

    // Handle popups/new windows from within the webview
    webviewContents.setWindowOpenHandler(({ url }) => {
      console.log('[Main] Webview popup requested:', url);
      if (url.includes('google.com') || url.includes('accounts.google') || url.includes('auth')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              // Reuse the exact guest session so OAuth cookies land in the
              // originating Build session's profile.
              session: webviewContents.session,
              webSecurity: false,
            }
          }
        };
      }
      return { action: 'deny' };
    });
  });

  // Handle new windows from main window (fallback)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[Main] Window open requested:', url);
    // Allow OAuth popups
    if (url.includes('google.com') || url.includes('accounts.google') || url.includes('auth')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: 'persist:browser'
          }
        }
      };
    }
    return { action: 'deny' };
  });

  // Open DevTools for debugging (disabled for production builds)
  // Capture renderer console + crash info in main process logs
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log(`[Renderer Console] ${message.substring(0, 500)}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[RENDERER CRASHED] reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      claudeService.setMainWindow(mainWindow);
    }
  });
  if (process.env.GREP_DEV_USER_DATA) mainWindow.webContents.openDevTools();

  allWindows.add(mainWindow);

  mainWindow.on('closed', () => {
    allWindows.delete(mainWindow!);
    mainWindow = null;
  });
};

function createNewWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    center: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  (win as any).__preloadPath = MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY;
  allWindows.add(win);

  win.webContents.once('did-finish-load', () => {
    void maybeRunRendererCdpScript(win);
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      console.log('[Main] Forcing new window to show (ready-to-show timeout)');
      win.show();
      win.center();
      win.focus();
    }
  }, 3000);

  const sendShortcutToRenderer = (action: string) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.APP_SHORTCUT_TRIGGERED, { action });
    }
  };

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const key = (input.key || '').toLowerCase();
    const primaryModifier = isMac ? input.meta : input.control;
    if (!primaryModifier || input.alt) return;

    let action: string | null = null;
    if (input.shift && key === 'n') {
      event.preventDefault();
      createNewWindow();
      return;
    } else if (!input.shift && key === 'n') {
      action = 'new-session';
    } else if (!input.shift && key === 'r') {
      action = 'browser-refresh';
    } else if (input.shift && key === 'g') {
      action = 'toggle-command-center';
    } else if (input.shift && key === 'f') {
      action = 'toggle-file-search';
    } else if (!input.shift && key === 'k') {
      action = 'toggle-quick-search';
    } else if (!input.shift && key === 's') {
      action = 'save-or-new-session';
    } else if (!input.shift && key === 'w') {
      action = 'close-editor-tab';
    } else if (!input.shift && key === 't') {
      action = 'fork-empty';
    } else if (!input.shift && key === '[') {
      action = 'prev-fork';
    } else if (!input.shift && key === ']') {
      action = 'next-fork';
    } else if (!input.shift && key === 'b') {
      action = 'background-task';
    }

    if (action) {
      event.preventDefault();
      sendShortcutToRenderer(action);
      if (action === 'browser-refresh') {
        win.webContents.send(IPC_CHANNELS.APP_CMD_R_PRESSED);
      }
    }
  });

  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    console.log('[Main] Attaching webview with partition:', params.partition);
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = false;
    webPreferences.sandbox = false;
    webPreferences.webSecurity = false;
    webPreferences.partition = params.partition || 'persist:browser';
    webPreferences.enableWebSQL = false;
    webPreferences.experimentalFeatures = true;
  });

  win.webContents.on('did-attach-webview', (_event, webviewContents) => {
    console.log('[Main] Webview attached, id:', webviewContents.id);

    webviewContents.session.setPermissionRequestHandler((_requestingContents, _permission, callback) => {
      callback(true);
    });

    webviewContents.on('before-input-event', (evt, input) => {
      const k = (input.key || '').toLowerCase();
      const primaryModifier = isMac ? input.meta : input.control;
      if (input.type === 'keyDown' && primaryModifier && input.shift && !input.alt && k === 'n') {
        evt.preventDefault();
        createNewWindow();
        return;
      }
      if (input.type === 'keyDown' && input.control && k === 'tab') {
        evt.preventDefault();
        win.webContents.send('session-switcher', { action: input.shift ? 'prev' : 'next' });
      }
      if (input.type === 'keyUp' && k === 'control') {
        win.webContents.send('session-switcher', { action: 'confirm' });
      }
    });

    webviewContents.on('did-finish-load', () => {
      console.log('[Main] Webview finished loading:', webviewContents.getURL());
    });

    webviewContents.setWindowOpenHandler(({ url }) => {
      console.log('[Main] Webview popup requested:', url);
      if (url.includes('google.com') || url.includes('accounts.google') || url.includes('auth')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              session: webviewContents.session,
              webSecurity: false,
            }
          }
        };
      }
      return { action: 'deny' };
    });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[Main] Window open requested:', url);
    if (url.includes('google.com') || url.includes('accounts.google') || url.includes('auth')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: 'persist:browser'
          }
        }
      };
    }
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log(`[Renderer Console] ${message.substring(0, 500)}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[RENDERER CRASHED] reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.on('focus', () => {
    claudeService.setMainWindow(win);
  });

  win.on('closed', () => {
    allWindows.delete(win);
  });

  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    .then(() => console.log('[Main] New window loaded'))
    .catch(err => console.error('[Main] New window failed:', err));
}

// Register custom protocols
app.whenReady().then(() => {
  // OAuth callback protocol
  protocol.registerHttpProtocol('grep', (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      if (code && mainWindow) {
        mainWindow.webContents.send('auth:oauth-callback', { code });
      }
    }
  });

  // Monaco assets protocol - serves files from node_modules
  protocol.handle('monaco-asset', (request) => {
    const url = new URL(request.url);
    // URL format: monaco-asset://app/node_modules/monaco-editor/min/vs/...
    // Extract the path after /node_modules/
    const relativePath = url.pathname.replace(/^\/node_modules\//, '');

    // Get the project root directory (where node_modules lives)
    // __dirname in webpack main is: <project-root>/.webpack/main
    // We need to go up 2 levels to get to project root
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    const baseDir = isDev
      ? path.join(__dirname, '..', '..') // .webpack/main -> project root
      : app.getAppPath();

    let filePath: string;
    if (isDev) {
      // Dev: files are in project root node_modules
      filePath = path.join(baseDir, 'node_modules', relativePath);
    } else {
      // Packaged: Monaco copied to Resources/node_modules by postPackage hook
      filePath = path.join(process.resourcesPath, 'node_modules', relativePath);
    }

    const fileUrl = pathToFileURL(filePath).toString();
    return net.fetch(fileUrl, { bypassCustomProtocolHandlers: true });
  });
});

// Register IPC handlers
function registerIPCHandlers(): void {
  registerAuthHandlers(ipcMain);
  registerSessionHandlers(ipcMain);
  registerGitHandlers(ipcMain);
  registerTerminalHandlers(ipcMain);
  registerClaudeHandlers(ipcMain);
  registerSettingsHandlers(ipcMain);
  registerDevHandlers(ipcMain);
  registerFsHandlers(ipcMain);
  registerAudioHandlers(ipcMain);
  registerRealtimeHandlers(ipcMain);
  registerVoiceHandlers(ipcMain);
  registerExtensionHandlers(ipcMain);
  registerBrowserHandlers(ipcMain);
  registerSSHHandlers(ipcMain);
  registerMemoryHandlers(ipcMain);
  registerSecureKeysIPC();
  registerQmdHandlers(ipcMain, () => mainWindow);
  registerMcpHandlers(ipcMain);
  registerPluginHandlers(ipcMain);
  registerCodexHandlers(ipcMain);
  registerDesignHandlers(ipcMain);
  registerOpenClawHandlers(ipcMain);
  registerAnalyticsHandlers(ipcMain);
  registerQueueHandlers(ipcMain);

  // Wakeup scheduler — fires timers for ScheduleWakeup/CronCreate and sends
  // the prompt back to the renderer so it flows through the normal sendMessage path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { wakeupScheduler } = require('./services/wakeup.service');
  wakeupScheduler.on('wakeup', ({ sessionId, prompt, reason }: { sessionId: string; prompt: string; reason: string }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[Main] Wakeup fired for ${sessionId}: ${reason}`);
      broadcastToAll(IPC_CHANNELS.CLAUDE_WAKEUP_FIRED, { sessionId, prompt, reason });
    }
  });

  // GStack workflow skills
  ipcMain.handle(IPC_CHANNELS.GSTACK_GET_MODES, () => getGStackModes());
  ipcMain.handle(IPC_CHANNELS.GSTACK_IS_INSTALLED, () => isGStackInstalled());
  ipcMain.handle(IPC_CHANNELS.GSTACK_INSTALL, async () => installGStack());
  ipcMain.handle(IPC_CHANNELS.GSTACK_UPGRADE, async () => upgradeGStack());

  // Update check (manual trigger from renderer)
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    return updateService.checkForUpdates();
  });
}

// Migrate data from old "Grep Build" or "G-Build" app directories to new "Build" on first launch
function migrateFromGrepBuild(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pathModule = require('path');
  const newDir = app.getPath('userData'); // Now points to Build
  const parentDir = pathModule.dirname(newDir);

  // Check both old directory names, preferring the more recent "G-Build" over "Grep Build"
  const gBuildDir = pathModule.join(parentDir, 'G-Build');
  const grepBuildDir = pathModule.join(parentDir, 'Grep Build');
  const oldDir = fs.existsSync(gBuildDir) ? gBuildDir : (fs.existsSync(grepBuildDir) ? grepBuildDir : null);

  // Only migrate if an old dir exists and we haven't migrated yet
  const migrationMarker = pathModule.join(newDir, '.migrated-from-grep-build');
  if (!oldDir || fs.existsSync(migrationMarker)) return;

  console.log('[Migration] Migrating data from', oldDir, '→', newDir);
  const filesToMigrate = [
    'claudette-sessions.json',
    'claudette-settings.json',
    'claudette-message-cache.json',
    'claudette-memory.json',
    'claudette-qmd.json',
    'claudette-mcp-servers.json',
    'claudette-sessions-dev.json',
  ];

  for (const file of filesToMigrate) {
    const src = pathModule.join(oldDir, file);
    const dst = pathModule.join(newDir, file);
    if (fs.existsSync(src)) {
      try {
        // Overwrite — the app may have created default/empty files before migration ran
        fs.copyFileSync(src, dst);
        console.log(`[Migration] Copied ${file}`);
      } catch (err) {
        console.error(`[Migration] Failed to copy ${file}:`, err);
      }
    }
  }

  // Also copy Local Storage (contains renderer localStorage data)
  const oldLS = pathModule.join(oldDir, 'Local Storage');
  const newLS = pathModule.join(newDir, 'Local Storage');
  if (fs.existsSync(oldLS) && !fs.existsSync(newLS)) {
    try {
      fs.cpSync(oldLS, newLS, { recursive: true });
      console.log('[Migration] Copied Local Storage');
    } catch (err) {
      console.error('[Migration] Failed to copy Local Storage:', err);
    }
  }

  // Mark migration as complete
  fs.writeFileSync(migrationMarker, new Date().toISOString());
  console.log('[Migration] Complete');
}

// This method will be called when Electron has finished initialization
app.on('ready', async () => {
  migrateFromGrepBuild();
  registerIPCHandlers();
  powerService.init();
  // On wake from sleep, tell renderers to reattach to any SSH remote turns
  // that kept running while the connection was down.
  powerService.onSystemResume(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.SSH_SYSTEM_RESUMED);
    }
  });
  mcpService.ensureOpenDesignMcpServer()
    .catch((error) => {
      console.warn('[Main] Failed to restore OpenDesign MCP server on startup:', error);
    })
    .finally(() => {
      mcpService.syncLocalHarnessConfigs().catch((error) => {
        console.warn('[Main] Failed to sync local MCP harness configs on startup:', error);
      });
    });
  createWindow();
  scheduleBrowserPartitionCleanup();

  // Start CDP proxy for Stagehand webview integration
  try {
    await cdpProxyService.start();
    console.log('[Main] CDP proxy started for Stagehand webview integration');
  } catch (error) {
    console.error('[Main] Failed to start CDP proxy:', error);
  }

  // Start update checker (checks GitHub releases for newer versions)
  if (mainWindow) {
    updateService.start(mainWindow);
  }
});

// Clean up power management on quit
app.on('will-quit', () => {
  // Flush all cached stores to disk before quitting so no data is lost
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CachedStore } = require('./cached-store');
  CachedStore.flushAll();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SessionMessageCacheStore } = require('./session-message-cache-store');
  SessionMessageCacheStore.flushAll();

  // Do not kill SSH remote Claude jobs here. They are launched through the
  // detached bridge specifically so in-flight remote work survives app quits,
  // laptop sleep, and transient network drops. Explicit session deletion/cancel
  // still performs targeted remote cleanup.
  powerService.dispose();

  // Stop the Open Design daemon if we spawned it (adopted daemons are left alone)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { designService } = require('./services/design.service');
  designService.shutdown();

  // Clean up wakeup timers
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wakeupScheduler } = require('./services/wakeup.service');
    wakeupScheduler.destroy();
  } catch { /* ignore */ }

  // Clean up update checker
  updateService.stop();
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, re-create a window when dock icon is clicked and no windows are open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Export mainWindow for use in IPC handlers.
// Returns the focused window, falling back to the primary or any open window.
export function getMainWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && allWindows.has(focused)) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  for (const w of allWindows) {
    if (!w.isDestroyed()) return w;
  }
  return null;
}

// Broadcast an IPC event to ALL open windows (each renderer filters by sessionId)
export function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const w of allWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, ...args);
    }
  }
}
