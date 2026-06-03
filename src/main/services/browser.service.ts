import { BrowserWindow, ipcMain, webContents } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { cdpProxyService } from './cdp-proxy.service';

export interface BrowserSnapshot {
  url: string;
  screenshot: string; // base64 encoded PNG
  html: string;
  timestamp: Date;
  requestId?: string; // Unique ID for matching async requests
}

export interface ConsoleMessage {
  type: 'log' | 'warning' | 'error' | 'info' | 'debug';
  text: string;
  timestamp: Date;
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type: string;
  timestamp: Date;
  responseHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  responseSize?: number;
  timing?: {
    started: number;
    finished?: number;
    duration?: number;
  };
}

/**
 * Service for browser automation using Chrome DevTools Protocol
 * Supports multiple simultaneous sessions with independent browsers.
 * A session can also be visible in multiple app windows; the most recently
 * registered live webview is used for CDP automation.
 */
export class BrowserService {
  private webviewSnapshots = new Map<string, BrowserSnapshot>();
  private pendingSnapshots = new Map<string, { resolve: (snapshot: BrowserSnapshot) => void; reject: (error: Error) => void }>();

  // Map sessionId to live webContentsIds for CDP access. Last id is active.
  private sessionWebContents = new Map<string, number[]>();
  // Reverse map: webContentsId to sessionId (for routing debugger events)
  private webContentsToSession = new Map<number, string>();
  // Track attached debuggers
  private attachedDebuggers = new Set<number>();
  // Track which webContents have debugger event listeners attached
  private debuggerListenersAttached = new Set<number>();
  // Track webviews that already have lifecycle cleanup listeners attached.
  private webviewDestroyListenersAttached = new Set<number>();

  // Console and network capture storage (keyed by sessionId)
  private consoleLogs = new Map<string, ConsoleMessage[]>();
  private networkRequests = new Map<string, Map<string, NetworkRequest>>();
  // Track which sessions have CDP domains enabled
  private enabledDomains = new Map<string, Set<string>>();

  constructor() {
    // Listen for snapshot data from renderer (fallback for complex captures)
    ipcMain.on('browser:snapshot-captured', (_event, snapshot: BrowserSnapshot) => {
      const key = snapshot.requestId || snapshot.url;
      const pending = this.pendingSnapshots.get(key);
      if (pending) {
        pending.resolve(snapshot);
        this.pendingSnapshots.delete(key);
      }
    });

    // Listen for webview registration from renderer
    ipcMain.on('browser:register-webview', (_event, data: { sessionId: string; webContentsId: number }) => {
      console.log('[Browser Service] === WEBVIEW REGISTRATION ===');
      console.log('[Browser Service] Session ID:', data.sessionId);
      console.log('[Browser Service] webContentsId:', data.webContentsId);

      // Verify the webContents exists
      const wc = webContents.fromId(data.webContentsId);
      if (wc) {
        console.log('[Browser Service] webContents verified - URL:', wc.getURL?.() || 'unknown');

        const hadSessionBrowser = this.hasSessionWebContents(data.sessionId);
        this.rememberWebview(data.sessionId, data.webContentsId, wc);
        console.log('[Browser Service] Registration successful. Total registered sessions:', this.getRegisteredSessions().length);
        console.log('[Browser Service] Active sessions with browsers:', this.getRegisteredSessions());

        // Notify CDP proxy that a new target is available — this unblocks Playwright's
        // connectOverCDP if it called Target.setAutoAttach before the webview was ready
        if (!hadSessionBrowser) {
          cdpProxyService.notifyNewTarget(data.sessionId);
        }
      } else {
        console.error('[Browser Service] FAILED - webContents.fromId returned null for ID:', data.webContentsId);
      }
    });

    // Listen for webview unregistration
    ipcMain.on('browser:unregister-webview', (_event, data: { sessionId: string; webContentsId?: number }) => {
      console.log('[Browser Service] Unregistering webview:', data.sessionId, '-> webContentsId:', data.webContentsId);
      this.forgetWebview(data.sessionId, data.webContentsId);
      console.log('[Browser Service] Remaining sessions with browsers:', this.getRegisteredSessions());
    });
  }

  private pruneSessionWebContents(sessionId: string): number[] {
    const ids = this.sessionWebContents.get(sessionId) || [];
    if (ids.length === 0) {
      this.sessionWebContents.delete(sessionId);
      return [];
    }

    const live: number[] = [];
    for (const id of ids) {
      if (webContents.fromId(id)) {
        live.push(id);
      } else if (this.webContentsToSession.get(id) === sessionId) {
        this.webContentsToSession.delete(id);
      }
    }

    if (live.length > 0) {
      this.sessionWebContents.set(sessionId, live);
    } else {
      this.sessionWebContents.delete(sessionId);
      this.enabledDomains.delete(sessionId);
    }

    return live;
  }

  private getActiveWebContentsId(sessionId: string): number | undefined {
    const ids = this.pruneSessionWebContents(sessionId);
    return ids.length > 0 ? ids[ids.length - 1] : undefined;
  }

  private hasAnyWebContents(): boolean {
    return this.getRegisteredSessions().length > 0;
  }

  private hasSessionWebContents(sessionId: string): boolean {
    return this.getActiveWebContentsId(sessionId) !== undefined;
  }

  private rememberWebview(sessionId: string, webContentsId: number, wc: Electron.WebContents): void {
    const previousSessionId = this.webContentsToSession.get(webContentsId);
    if (previousSessionId && previousSessionId !== sessionId) {
      this.forgetWebview(previousSessionId, webContentsId);
    }

    const previousActiveId = this.getActiveWebContentsId(sessionId);
    const ids = this.pruneSessionWebContents(sessionId).filter((id) => id !== webContentsId);
    ids.push(webContentsId);
    this.sessionWebContents.set(sessionId, ids);
    this.webContentsToSession.set(webContentsId, sessionId);

    if (previousActiveId !== webContentsId) {
      this.enabledDomains.delete(sessionId);
    }

    if (!this.webviewDestroyListenersAttached.has(webContentsId)) {
      this.webviewDestroyListenersAttached.add(webContentsId);
      wc.once('destroyed', () => {
        this.webviewDestroyListenersAttached.delete(webContentsId);
        const ownerSessionId = this.webContentsToSession.get(webContentsId) || sessionId;
        this.forgetWebview(ownerSessionId, webContentsId);
      });
    }
  }

  private forgetWebview(sessionId: string, webContentsId?: number): void {
    const ids = this.pruneSessionWebContents(sessionId);
    const activeBefore = ids[ids.length - 1];
    const removed = webContentsId === undefined
      ? ids
      : ids.filter((id) => id === webContentsId);

    if (removed.length === 0) {
      return;
    }

    const remaining = webContentsId === undefined
      ? []
      : ids.filter((id) => id !== webContentsId);

    for (const id of removed) {
      this.detachDebugger(id);
      this.debuggerListenersAttached.delete(id);
      this.attachedDebuggers.delete(id);
      if (this.webContentsToSession.get(id) === sessionId) {
        this.webContentsToSession.delete(id);
      }
    }

    if (remaining.length > 0) {
      this.sessionWebContents.set(sessionId, remaining);
      if (removed.includes(activeBefore)) {
        this.enabledDomains.delete(sessionId);
      }
      return;
    }

    this.sessionWebContents.delete(sessionId);
    this.enabledDomains.delete(sessionId);

    const targetDestroyedId = removed[removed.length - 1];
    if (targetDestroyedId !== undefined) {
      // Notify CDP proxy only when the session has no visible browser left.
      cdpProxyService.unregisterWebview(sessionId, targetDestroyedId);
    }
  }

  /**
   * Get webContentsId for a session (public, for CDP proxy)
   */
  getWebContentsId(sessionId: string): number | undefined {
    return this.getActiveWebContentsId(sessionId);
  }

  /**
   * Get all registered session IDs (public, for CDP proxy)
   */
  getRegisteredSessions(): string[] {
    return Array.from(this.sessionWebContents.keys()).filter((sessionId) => this.getActiveWebContentsId(sessionId) !== undefined);
  }

  /**
   * Get first available session ID (fallback)
   */
  getFirstSessionId(): string | undefined {
    const sessions = this.getRegisteredSessions();
    return sessions.length > 0 ? sessions[0] : undefined;
  }

  /**
   * Get webContents for a session's webview
   * Falls back to any registered session if specified session not found
   */
  private getWebContents(sessionId: string): Electron.WebContents | null {
    // Debug: Log all registered sessions
    console.log('[Browser Service] getWebContents called for session:', sessionId);
    console.log('[Browser Service] All registered sessions:', Array.from(this.sessionWebContents.entries()));

    let webContentsId = this.getActiveWebContentsId(sessionId);

    if (!webContentsId) {
      console.warn('[Browser Service] No webContentsId found for session:', sessionId);

      // Fallback: use any registered session (useful for MCP tools without session context)
      const allSessions = this.getRegisteredSessions();
      if (allSessions.length > 0) {
        const fallbackSessionId = allSessions[0];
        const fallbackWebContentsId = this.getActiveWebContentsId(fallbackSessionId);
        console.log('[Browser Service] Using fallback session:', fallbackSessionId);
        webContentsId = fallbackWebContentsId;
      } else {
        console.error('[Browser Service] No webviews registered at all!');
        return null;
      }
    }

    if (!webContentsId) {
      console.error('[Browser Service] No live webContentsId found after fallback lookup');
      return null;
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      console.error('[Browser Service] webContents.fromId returned null for ID:', webContentsId);
    } else {
      console.log('[Browser Service] Found webContents:', wc.id, 'URL:', wc.getURL?.() || 'unknown');
    }
    return wc || null;
  }

  /**
   * Attach debugger to webContents if not already attached
   */
  private async attachDebugger(wc: Electron.WebContents): Promise<void> {
    if (this.attachedDebuggers.has(wc.id)) {
      return;
    }

    try {
      wc.debugger.attach('1.3');
      this.attachedDebuggers.add(wc.id);
      console.log('[Browser Service] Debugger attached to webContents:', wc.id);

      // Clean up when webContents is destroyed
      wc.once('destroyed', () => {
        console.log('[Browser Service] WebContents destroyed:', wc.id);
        this.attachedDebuggers.delete(wc.id);
        this.debuggerListenersAttached.delete(wc.id);
        // Clean up reverse mapping
        const sessionId = this.webContentsToSession.get(wc.id);
        if (sessionId) {
          this.forgetWebview(sessionId, wc.id);
        }
      });
    } catch (err) {
      // Already attached or devtools open
      console.log('[Browser Service] Debugger attach:', err);
    }
  }

  /**
   * Detach debugger from webContents
   */
  private detachDebugger(webContentsId: number): void {
    if (!this.attachedDebuggers.has(webContentsId)) {
      return;
    }

    try {
      const wc = webContents.fromId(webContentsId);
      if (wc) {
        wc.debugger.detach();
      }
      this.attachedDebuggers.delete(webContentsId);
    } catch (err) {
      console.log('[Browser Service] Debugger detach error:', err);
    }
  }

  /**
   * Send CDP command to webContents
   */
  private async sendCDP(wc: Electron.WebContents, method: string, params?: Record<string, unknown>): Promise<any> {
    await this.attachDebugger(wc);
    return wc.debugger.sendCommand(method, params);
  }

  /**
   * Navigate browser to a specific URL using CDP
   */
  async navigate(sessionId: string, url: string): Promise<void> {
    // Check if browser panel is open - if not, silently ignore (might be called during initialization)
    if (!this.hasAnyWebContents()) {
      console.log('[Browser Service] Navigate called but no browser panels registered yet. Ignoring.');
      return;
    }

    // Emit start event for visual feedback
    this.emitAutomationEvent(sessionId, { type: 'start', action: 'navigate', data: { url } });

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      // Fallback to IPC method
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        // Use fallback session if original sessionId has no webview
        let targetSessionId = sessionId;
        if (!this.hasSessionWebContents(sessionId)) {
          const allSessions = this.getRegisteredSessions();
          if (allSessions.length > 0) {
            targetSessionId = allSessions[0];
            console.log('[Browser Service] Using fallback session for IPC navigate:', targetSessionId);
          }
        }
        mainWindow.webContents.send('browser:navigate', { sessionId: targetSessionId, url });
      }
      this.emitAutomationEvent(sessionId, { type: 'end', action: 'navigate', data: { success: true, url } });
      return;
    }

    try {
      await this.sendCDP(wc, 'Page.navigate', { url });
      // Wait for page to load
      await this.sendCDP(wc, 'Page.enable');
      this.emitAutomationEvent(sessionId, { type: 'end', action: 'navigate', data: { success: true, url } });
    } catch (error) {
      console.error('[Browser Service] CDP navigate error:', error);
      // Fallback to direct navigation
      wc.loadURL(url);
      this.emitAutomationEvent(sessionId, { type: 'end', action: 'navigate', data: { success: true, url } });
    }
  }

  /**
   * Emit automation event to renderer for visual feedback
   */
  private emitAutomationEvent(sessionId: string, event: { type: string; action: string; data?: Record<string, unknown> }): void {
    const windows = BrowserWindow.getAllWindows();
    console.log('[Browser Service] Emitting automation event to', windows.length, 'windows:', { sessionId, ...event });
    if (windows.length === 0) {
      console.warn('[Browser Service] No windows found for automation event');
      return;
    }
    // Broadcast to all windows to ensure the correct one receives it
    for (const win of windows) {
      win.webContents.send('browser:automation-event', { sessionId, ...event });
    }
  }

  /**
   * Click on an element by CSS selector using CDP
   */
  async click(sessionId: string, selector: string): Promise<{ success: boolean; error?: string; position?: { x: number; y: number } }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    // Emit start event for visual feedback
    this.emitAutomationEvent(sessionId, { type: 'start', action: 'click', data: { selector } });

    try {
      // Use Runtime.evaluate to find element and get its position
      const result = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found: ${selector}' };
            const rect = el.getBoundingClientRect();
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              tagName: el.tagName,
              text: el.textContent?.slice(0, 100)
            };
          })()
        `,
        returnByValue: true,
      });

      if (result.result?.value?.error) {
        this.emitAutomationEvent(sessionId, { type: 'end', action: 'click', data: { success: false } });
        return { success: false, error: result.result.value.error };
      }

      const { x, y } = result.result.value;

      // Emit position for visual feedback
      this.emitAutomationEvent(sessionId, { type: 'position', action: 'click', data: { x, y, selector } });

      // Dispatch mouse events using CDP Input domain
      await this.sendCDP(wc, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });

      await this.sendCDP(wc, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });

      this.emitAutomationEvent(sessionId, { type: 'end', action: 'click', data: { success: true, x, y } });
      return { success: true, position: { x, y } };
    } catch (error) {
      console.error('[Browser Service] CDP click error:', error);
      this.emitAutomationEvent(sessionId, { type: 'end', action: 'click', data: { success: false } });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Type text into an element using CDP
   */
  async type(sessionId: string, selector: string, text: string): Promise<{ success: boolean; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    // Emit start event for visual feedback
    this.emitAutomationEvent(sessionId, { type: 'start', action: 'type', data: { selector, text: text.slice(0, 30) } });

    try {
      // First focus the element
      const focusResult = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found: ${selector}' };
            el.focus();
            if (el.select) el.select(); // Select all existing text
            return { success: true };
          })()
        `,
        returnByValue: true,
      });

      if (focusResult.result?.value?.error) {
        this.emitAutomationEvent(sessionId, { type: 'end', action: 'type', data: { success: false } });
        return { success: false, error: focusResult.result.value.error };
      }

      // Clear existing content and type new text using CDP
      // First clear with select all + delete
      await this.sendCDP(wc, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: 2, // Ctrl/Cmd
      });
      await this.sendCDP(wc, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: 2,
      });

      // Use insertText for reliable text input
      await this.sendCDP(wc, 'Input.insertText', { text });

      this.emitAutomationEvent(sessionId, { type: 'end', action: 'type', data: { success: true } });
      return { success: true };
    } catch (error) {
      console.error('[Browser Service] CDP type error:', error);
      this.emitAutomationEvent(sessionId, { type: 'end', action: 'type', data: { success: false } });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Extract text from page or specific element using CDP
   */
  async extractText(sessionId: string, selector?: string): Promise<{ success: boolean; text?: string; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const expression = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`
        : `document.body.innerText`;

      const result = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        return { success: false, error: result.exceptionDetails.text };
      }

      return { success: true, text: result.result.value || '' };
    } catch (error) {
      console.error('[Browser Service] CDP extract error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Execute custom JavaScript using CDP Runtime.evaluate
   */
  async executeScript(sessionId: string, script: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const result = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        return { success: false, error: result.exceptionDetails.text };
      }

      return { success: true, result: result.result.value };
    } catch (error) {
      console.error('[Browser Service] CDP executeScript error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get page info using CDP
   */
  async getPageInfo(sessionId: string): Promise<{ success: boolean; url?: string; title?: string; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const result = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression: `({ url: window.location.href, title: document.title })`,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        return { success: false, error: result.exceptionDetails.text };
      }

      return { success: true, ...result.result.value };
    } catch (error) {
      console.error('[Browser Service] CDP getPageInfo error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Capture screenshot using CDP Page.captureScreenshot
   */
  async captureScreenshotCDP(sessionId: string): Promise<{ success: boolean; screenshot?: string; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const result = await this.sendCDP(wc, 'Page.captureScreenshot', {
        format: 'png',
      });

      return { success: true, screenshot: result.data };
    } catch (error) {
      console.error('[Browser Service] CDP screenshot error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get DOM tree using CDP
   */
  async getDOM(sessionId: string): Promise<{ success: boolean; html?: string; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const result = await this.sendCDP(wc, 'Runtime.evaluate', {
        expression: `document.documentElement.outerHTML`,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        return { success: false, error: result.exceptionDetails.text };
      }

      return { success: true, html: result.result.value };
    } catch (error) {
      console.error('[Browser Service] CDP getDOM error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Set up debugger event listener for a webContents (only once per webContents)
   * Routes events to the correct session based on webContentsId -> sessionId mapping
   */
  private setupDebuggerEventListener(wc: Electron.WebContents): void {
    if (this.debuggerListenersAttached.has(wc.id)) {
      return;
    }

    this.debuggerListenersAttached.add(wc.id);
    console.log('[Browser Service] Setting up debugger event listener for webContents:', wc.id);

    wc.debugger.on('message', (_event, method, params) => {
      // Get the sessionId for this webContents
      const sessionId = this.webContentsToSession.get(wc.id);
      if (!sessionId) {
        return;
      }

      // Handle Runtime (console) events
      if (method === 'Runtime.consoleAPICalled') {
        const logs = this.consoleLogs.get(sessionId) || [];
        const args = (params.args || []).map((arg: any) => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'undefined') return 'undefined';
          if (arg.type === 'object' && arg.preview) {
            return JSON.stringify(arg.preview.properties?.reduce((acc: any, p: any) => {
              acc[p.name] = p.value;
              return acc;
            }, {}) || arg.description);
          }
          return arg.description || String(arg.value);
        });

        logs.push({
          type: params.type as ConsoleMessage['type'],
          text: args.join(' '),
          timestamp: new Date(),
          url: params.stackTrace?.callFrames?.[0]?.url,
          lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
          stackTrace: params.stackTrace?.callFrames?.map((f: any) =>
            `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`
          ).join('\n'),
        });

        // Keep only last 500 messages
        if (logs.length > 500) {
          logs.splice(0, logs.length - 500);
        }
        this.consoleLogs.set(sessionId, logs);
      }

      if (method === 'Runtime.exceptionThrown') {
        const logs = this.consoleLogs.get(sessionId) || [];
        const exception = params.exceptionDetails;
        logs.push({
          type: 'error',
          text: exception.text + (exception.exception?.description ? '\n' + exception.exception.description : ''),
          timestamp: new Date(),
          url: exception.url,
          lineNumber: exception.lineNumber,
          stackTrace: exception.stackTrace?.callFrames?.map((f: any) =>
            `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`
          ).join('\n'),
        });
        this.consoleLogs.set(sessionId, logs);
      }

      // Handle Network events
      const requests = this.networkRequests.get(sessionId);
      if (requests) {
        if (method === 'Network.requestWillBeSent') {
          requests.set(params.requestId, {
            requestId: params.requestId,
            url: params.request.url,
            method: params.request.method,
            type: params.type || 'Other',
            timestamp: new Date(),
            requestHeaders: params.request.headers,
            timing: {
              started: Date.now(),
            },
          });
        }

        if (method === 'Network.responseReceived') {
          const req = requests.get(params.requestId);
          if (req) {
            req.status = params.response.status;
            req.statusText = params.response.statusText;
            req.responseHeaders = params.response.headers;
            req.type = params.type || req.type;
          }
        }

        if (method === 'Network.loadingFinished') {
          const req = requests.get(params.requestId);
          if (req && req.timing) {
            req.timing.finished = Date.now();
            req.timing.duration = req.timing.finished - req.timing.started;
            req.responseSize = params.encodedDataLength;
          }
        }

        if (method === 'Network.loadingFailed') {
          const req = requests.get(params.requestId);
          if (req) {
            req.status = 0;
            req.statusText = params.errorText || 'Failed';
          }
        }

        // Keep only last 200 requests
        if (requests.size > 200) {
          const entries = Array.from(requests.entries());
          const toDelete = entries.slice(0, entries.length - 200);
          toDelete.forEach(([key]) => requests.delete(key));
        }
      }
    });
  }

  /**
   * Enable console capture via CDP Runtime domain
   */
  async enableConsoleCapture(sessionId: string): Promise<{ success: boolean; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      // Check if already enabled
      const domains = this.enabledDomains.get(sessionId) || new Set();
      if (domains.has('Runtime')) {
        return { success: true };
      }

      // Initialize storage
      if (!this.consoleLogs.has(sessionId)) {
        this.consoleLogs.set(sessionId, []);
      }

      await this.attachDebugger(wc);

      // Set up event listener (only once per webContents)
      this.setupDebuggerEventListener(wc);

      // Enable Runtime domain
      await wc.debugger.sendCommand('Runtime.enable');

      domains.add('Runtime');
      this.enabledDomains.set(sessionId, domains);

      console.log('[Browser Service] Console capture enabled for session:', sessionId);
      return { success: true };
    } catch (error) {
      console.error('[Browser Service] CDP enableConsoleCapture error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get captured console logs for a session
   */
  getConsoleLogs(sessionId: string, filter?: { type?: string; limit?: number; since?: Date }): ConsoleMessage[] {
    let logs = this.consoleLogs.get(sessionId) || [];

    if (filter?.type) {
      logs = logs.filter(l => l.type === filter.type);
    }

    if (filter?.since) {
      logs = logs.filter(l => l.timestamp >= filter.since!);
    }

    if (filter?.limit) {
      logs = logs.slice(-filter.limit);
    }

    return logs;
  }

  /**
   * Clear console logs for a session
   */
  clearConsoleLogs(sessionId: string): void {
    this.consoleLogs.set(sessionId, []);
  }

  /**
   * Enable network request capture via CDP Network domain
   */
  async enableNetworkCapture(sessionId: string): Promise<{ success: boolean; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      // Check if already enabled
      const domains = this.enabledDomains.get(sessionId) || new Set();
      if (domains.has('Network')) {
        return { success: true };
      }

      // Initialize storage
      if (!this.networkRequests.has(sessionId)) {
        this.networkRequests.set(sessionId, new Map());
      }

      await this.attachDebugger(wc);

      // Set up event listener (only once per webContents) - handles both console and network events
      this.setupDebuggerEventListener(wc);

      // Enable Network domain
      await wc.debugger.sendCommand('Network.enable');

      domains.add('Network');
      this.enabledDomains.set(sessionId, domains);

      console.log('[Browser Service] Network capture enabled for session:', sessionId);
      return { success: true };
    } catch (error) {
      console.error('[Browser Service] CDP enableNetworkCapture error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get captured network requests for a session
   */
  getNetworkRequests(sessionId: string, filter?: { urlPattern?: string; method?: string; status?: number; limit?: number }): NetworkRequest[] {
    const requests = this.networkRequests.get(sessionId);
    if (!requests) return [];

    let results = Array.from(requests.values());

    if (filter?.urlPattern) {
      const pattern = new RegExp(filter.urlPattern, 'i');
      results = results.filter(r => pattern.test(r.url));
    }

    if (filter?.method) {
      results = results.filter(r => r.method === filter.method);
    }

    if (filter?.status !== undefined) {
      results = results.filter(r => r.status === filter.status);
    }

    if (filter?.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Clear network requests for a session
   */
  clearNetworkRequests(sessionId: string): void {
    this.networkRequests.set(sessionId, new Map());
  }

  /**
   * Get response body for a specific request (if available)
   */
  async getResponseBody(sessionId: string, requestId: string): Promise<{ success: boolean; body?: string; base64Encoded?: boolean; error?: string }> {
    // Check if browser panel is open
    if (!this.hasAnyWebContents()) {
      return { success: false, error: 'Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.' };
    }

    const wc = this.getWebContents(sessionId);
    if (!wc) {
      return { success: false, error: 'No webview found for session' };
    }

    try {
      const result = await this.sendCDP(wc, 'Network.getResponseBody', { requestId });
      return {
        success: true,
        body: result.body,
        base64Encoded: result.base64Encoded,
      };
    } catch (error) {
      console.error('[Browser Service] CDP getResponseBody error:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Enable all debugging domains (console + network)
   */
  async enableDebugging(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const consoleResult = await this.enableConsoleCapture(sessionId);
    if (!consoleResult.success) {
      return consoleResult;
    }

    const networkResult = await this.enableNetworkCapture(sessionId);
    if (!networkResult.success) {
      return networkResult;
    }

    return { success: true };
  }

  /**
   * Check if browser automation is available (webview is registered)
   */
  isBrowserAvailable(sessionId: string): boolean {
    return this.hasSessionWebContents(sessionId) || this.hasAnyWebContents();
  }

  /**
   * Capture a snapshot of the current browser view (using CDP when possible)
   */
  async captureSnapshot(sessionId: string, url: string): Promise<BrowserSnapshot> {
    // Check if any webview is registered
    if (!this.hasAnyWebContents()) {
      throw new Error('Browser panel is not open. Please open the browser panel (use the globe icon in the toolbar) to use browser automation tools.');
    }

    const wc = this.getWebContents(sessionId);

    if (wc) {
      try {
        // Try CDP-based capture
        const [screenshotResult, htmlResult, pageInfo] = await Promise.all([
          this.captureScreenshotCDP(sessionId),
          this.getDOM(sessionId),
          this.getPageInfo(sessionId),
        ]);

        if (screenshotResult.success && htmlResult.success) {
          return {
            url: pageInfo.url || url,
            screenshot: screenshotResult.screenshot || '',
            html: htmlResult.html || '',
            timestamp: new Date(),
          };
        }
      } catch (error) {
        console.log('[Browser Service] CDP snapshot failed, falling back to IPC:', error);
      }
    }

    // Fallback to IPC-based capture
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      throw new Error('No browser window available');
    }

    // Try to use fallback session if original sessionId has no webview registered
    let targetSessionId = sessionId;
    if (!this.hasSessionWebContents(sessionId)) {
      const allSessions = this.getRegisteredSessions();
      if (allSessions.length > 0) {
        targetSessionId = allSessions[0];
        console.log('[Browser Service] Using fallback session for IPC capture:', targetSessionId);
      }
    }

    const requestId = `${targetSessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    mainWindow.webContents.send('browser:capture-snapshot', { sessionId: targetSessionId, requestId });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSnapshots.delete(requestId);
        reject(new Error('Snapshot capture timeout (10s)'));
      }, 10000);

      this.pendingSnapshots.set(requestId, {
        resolve: (snapshot) => {
          clearTimeout(timeout);
          this.webviewSnapshots.set(sessionId, snapshot);
          resolve(snapshot);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.pendingSnapshots.delete(requestId);
          reject(error);
        },
      });
    });
  }

  /**
   * Clean up all data associated with a deleted session
   */
  cleanupSession(sessionId: string): void {
    this.webviewSnapshots.delete(sessionId);
    this.consoleLogs.delete(sessionId);
    this.networkRequests.delete(sessionId);
    this.enabledDomains.delete(sessionId);

    this.forgetWebview(sessionId);
  }

  /**
   * Get the last captured snapshot for a session
   */
  getSnapshot(sessionId: string): BrowserSnapshot | null {
    return this.webviewSnapshots.get(sessionId) || null;
  }

  /**
   * Save snapshot to disk
   */
  async saveSnapshotToDisk(sessionId: string, snapshot: BrowserSnapshot): Promise<string> {
    const snapshotDir = path.join(os.tmpdir(), 'claudette-snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `snapshot-${sessionId}-${timestamp}.png`;
    const filepath = path.join(snapshotDir, filename);

    let base64Data = snapshot.screenshot;
    if (base64Data.startsWith('data:')) {
      const base64Index = base64Data.indexOf('base64,');
      if (base64Index !== -1) {
        base64Data = base64Data.substring(base64Index + 7);
      }
    }

    const buffer = Buffer.from(base64Data, 'base64');
    await fs.writeFile(filepath, buffer);

    return filepath;
  }
}

export const browserService = new BrowserService();
