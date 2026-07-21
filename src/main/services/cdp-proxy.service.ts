/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { webContents, session } from 'electron';
import { browserService } from './browser.service';

/**
 * CDP WebSocket Proxy Service
 * Creates a full CDP-compatible endpoint that bridges external tools (like Playwright/Stagehand)
 * to Electron webview's debugger API.
 *
 * Implements:
 * - HTTP endpoints: /json/version, /json/list, /json/protocol
 * - Browser-level WebSocket connections with Target domain support
 * - Page-level WebSocket connections for direct page control
 */
export class CdpProxyService {
  private httpServer: any = null;
  private wss: WebSocketServer | null = null;
  private port = Number(process.env.CDP_PROXY_PORT || 9223);
  private activeConnections = new Map<WebSocket, {
    webContentsId: number;
    sessionId: string;
    targetId: string;
    type: 'browser' | 'page';
  }>();

  // Track attached sessions for Target domain
  private attachedSessions = new Map<string, { targetId: string; sessionId: string }>();
  private sessionCounter = 0;

  // Track browser-level WebSocket clients (for broadcasting lifecycle events)
  private browserClients = new Set<WebSocket>();

  // Track browser clients that have autoAttach enabled (for attaching to new targets)
  private autoAttachClients = new Map<WebSocket, { flatten: boolean }>();

  // Track detach handlers so we can clean them up (keyed by targetId)
  private detachHandlers = new Map<string, { wc: Electron.WebContents; handler: (...args: any[]) => void }>();

  // Default timeout for CDP commands (30 seconds)
  private static readonly COMMAND_TIMEOUT_MS = 30000;

  /**
   * Start the CDP proxy server (HTTP + WebSocket)
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      console.log('[CDP Proxy] Already running on port', this.port);
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server for /json endpoints
        const requestHandler: http.RequestListener = (req, res) => this.handleHttpRequest(req, res);
        this.httpServer = http.createServer(requestHandler);

        // Create WebSocket server attached to HTTP server
        this.wss = new WebSocketServer({ server: this.httpServer });

        this.wss.on('connection', (ws, req) => {
          console.log('[CDP Proxy] New WebSocket connection:', req.url);
          this.handleWebSocketConnection(ws, req.url || '');
        });

        this.wss.on('error', (error) => {
          console.error('[CDP Proxy] WebSocket server error:', error);
        });

        this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            console.log('[CDP Proxy] Port', this.port, 'in use, trying', this.port + 1);
            this.port++;
            this.httpServer?.close();
            this.httpServer = null;
            this.wss = null;
            // Retry with new port
            this.start().then(resolve).catch(reject);
          } else {
            console.error('[CDP Proxy] HTTP server error:', error);
            reject(error);
          }
        });

        // Bind to localhost only — never expose CDP to the network
        this.httpServer.listen(this.port, '127.0.0.1', () => {
          console.log('[CDP Proxy] Server listening on port', this.port);
          console.log('[CDP Proxy] HTTP endpoints: http://localhost:' + this.port + '/json/version');
          console.log('[CDP Proxy] Browser WS: ws://localhost:' + this.port + '/devtools/browser');
          resolve();
        });
      } catch (error) {
        console.error('[CDP Proxy] Failed to start:', error);
        reject(error);
      }
    });
  }

  /**
   * Handle HTTP requests for CDP discovery endpoints
   */
  private handleHttpRequest(req: any, res: any): void {
    const url = req.url || '';

    // Set CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (url === '/json/version' || url === '/json') {
      // Browser version info - Playwright uses this to get the WebSocket URL
      const version = {
        'Browser': 'Claudette/1.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'Mozilla/5.0 Claudette Electron Webview',
        'V8-Version': process.versions.v8,
        'WebKit-Version': '537.36',
        'webSocketDebuggerUrl': `ws://localhost:${this.port}/devtools/browser`
      };
      res.writeHead(200);
      res.end(JSON.stringify(version));
      return;
    }

    if (url === '/json/list') {
      // List available page targets
      const targets = this.getTargets();
      res.writeHead(200);
      res.end(JSON.stringify(targets));
      return;
    }

    if (url === '/json/protocol') {
      // Return minimal protocol description
      res.writeHead(200);
      res.end(JSON.stringify({ domains: [] }));
      return;
    }

    if (url === '/json/cookies' || url.startsWith('/json/cookies?')) {
      // Return cookies from the webview partition
      // Optional URL filter: /json/cookies?url=https://example.com
      const urlObj = new URL(url, `http://localhost:${this.port}`);
      const filterUrl = urlObj.searchParams.get('url') || undefined;

      const targetSessionId = browserService.getFirstSessionId();
      if (!targetSessionId) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No webview session available' }));
        return;
      }

      const partitionName = browserService.getPartitionName(targetSessionId);
      const ses = session.fromPartition(partitionName);
      const filter: Electron.CookiesGetFilter = filterUrl ? { url: filterUrl } : {};
      ses.cookies.get(filter).then(cookies => {
        res.writeHead(200);
        res.end(JSON.stringify(cookies));
      }).catch(error => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }

    if (url === '/json/new' || url.startsWith('/json/new?')) {
      // Can't create new tabs in our webview, but return existing target
      const targets = this.getTargets();
      if (targets.length > 0) {
        res.writeHead(200);
        res.end(JSON.stringify(targets[0]));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No webview available' }));
      }
      return;
    }

    // Unknown endpoint
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Handle WebSocket connections
   */
  private handleWebSocketConnection(ws: WebSocket, url: string): void {
    // Browser-level connection: /devtools/browser or /devtools/browser/{id}
    if (url.startsWith('/devtools/browser')) {
      this.handleBrowserConnection(ws);
      return;
    }

    // Page-level connection: /devtools/page/{targetId}
    const pageMatch = url.match(/\/devtools\/page\/(.+)/);
    if (pageMatch) {
      this.handlePageConnection(ws, pageMatch[1]);
      return;
    }

    console.error('[CDP Proxy] Invalid WebSocket URL:', url);
    ws.close(1002, 'Invalid URL');
  }

  /**
   * Handle browser-level WebSocket connection
   * This is what Playwright connects to via connectOverCDP
   */
  private handleBrowserConnection(ws: WebSocket): void {
    console.log('[CDP Proxy] Browser-level connection established');

    // Find the first available webview to use as the default target
    const sessions = browserService.getRegisteredSessions();
    const sessionId = sessions.length > 0 ? sessions[0] : 'default';
    const webContentsId = browserService.getWebContentsId(sessionId);

    this.activeConnections.set(ws, {
      webContentsId: webContentsId || 0,
      sessionId,
      targetId: sessionId,
      type: 'browser'
    });

    // Track this as a browser-level client for lifecycle event broadcasting
    this.browserClients.add(ws);

    // Handle incoming CDP commands
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleBrowserCommand(ws, message);
      } catch (error) {
        console.error('[CDP Proxy] Failed to handle browser message:', error);
      }
    });

    ws.on('close', () => {
      console.log('[CDP Proxy] Browser connection closed');
      this.activeConnections.delete(ws);
      this.browserClients.delete(ws);
      this.autoAttachClients.delete(ws);
      // Clear attached sessions so the next browser client can re-attach to targets.
      // Without this, targets stay "attached" in the map and setAutoAttach skips them.
      this.attachedSessions.clear();
    });

    ws.on('error', (error) => {
      console.error('[CDP Proxy] Browser WebSocket error:', error);
    });
  }

  /**
   * Handle browser-level CDP commands
   * Implements Target domain for Playwright compatibility
   */
  private async handleBrowserCommand(ws: WebSocket, message: { id: number; method: string; params?: any; sessionId?: string }): Promise<void> {
    const { id, method, params, sessionId: messageSessionId } = message;

    try {
      let result: any;

      switch (method) {
        // Target domain - required for Playwright
        case 'Target.setDiscoverTargets':
          result = {};
          // Send existing targets as discovered
          if (params?.discover) {
            const targets = this.getTargets();
            for (const target of targets) {
              this.sendEvent(ws, 'Target.targetCreated', {
                targetInfo: {
                  targetId: target.id,
                  type: 'page',
                  title: target.title || '',
                  url: target.url,
                  attached: false,
                  browserContextId: 'default'
                }
              });
            }
          }
          break;

        case 'Target.getTargets': {
          const targetList = this.getTargets().map(t => ({
            targetId: t.id,
            type: 'page',
            title: t.title || '',
            url: t.url,
            attached: this.attachedSessions.has(t.id),
            browserContextId: 'default'
          }));
          result = { targetInfos: targetList };
          break;
        }

        case 'Target.attachToTarget': {
          const targetId = params?.targetId;
          const flatten = params?.flatten ?? true;

          if (!targetId) {
            throw new Error('targetId required');
          }

          const sessionIdStr = `session-${++this.sessionCounter}`;
          this.attachedSessions.set(targetId, { targetId, sessionId: sessionIdStr });

          // Attach debugger to the webview
          const wcId = browserService.getWebContentsId(targetId);
          if (wcId) {
            const wc = webContents.fromId(wcId);
            if (wc) {
              try {
                // Attach if not already attached
                if (!wc.debugger.isAttached()) {
                  wc.debugger.attach('1.3');
                  console.log('[CDP Proxy] Debugger attached for target:', targetId);
                } else {
                  console.log('[CDP Proxy] Debugger already attached for target:', targetId);
                }

                // Always set up event forwarding for this session (even if debugger was already attached)
                const eventHandler = (_event: any, eventMethod: string, eventParams: any) => {
                  // Log navigation-critical events for debugging
                  if (eventMethod.startsWith('Page.') || eventMethod === 'Runtime.executionContextCreated' || eventMethod === 'Runtime.executionContextDestroyed') {
                    const extra = eventMethod === 'Page.lifecycleEvent' ? `name=${eventParams?.name} frameId=${eventParams?.frameId}` :
                                  eventMethod === 'Page.frameNavigated' ? `url=${eventParams?.frame?.url}` :
                                  eventMethod === 'Page.navigatedWithinDocument' ? `url=${eventParams?.url}` : '';
                    console.log(`[CDP Proxy] Event[${sessionIdStr}] → Playwright: ${eventMethod} ${extra}`);
                  }
                  if (flatten && ws.readyState === WebSocket.OPEN) {
                    this.sendEvent(ws, eventMethod, eventParams, sessionIdStr);
                  }
                };
                wc.debugger.on('message', eventHandler);

                // Clean up event handler when WebSocket closes
                ws.on('close', () => {
                  wc.debugger.off('message', eventHandler);
                });

                // Handle debugger detachment (navigation, destruction, DevTools opened, crash)
                const detachHandler = (_event: any, reason: string) => {
                  console.log(`[CDP Proxy] Debugger detached from target ${targetId}: ${reason}`);

                  // Clean up the attached session
                  this.attachedSessions.delete(targetId);

                  // Notify Playwright that the session is detached and target is destroyed
                  if (ws.readyState === WebSocket.OPEN) {
                    this.sendEvent(ws, 'Target.detachedFromTarget', {
                      sessionId: sessionIdStr,
                      reason
                    });
                    this.sendEvent(ws, 'Target.targetDestroyed', {
                      targetId
                    });
                  }

                  // Clean up the detach handler tracking
                  this.detachHandlers.delete(targetId);

                  // Remove the message event handler since debugger is gone
                  wc.debugger.off('message', eventHandler);
                };
                wc.debugger.on('detach', detachHandler);

                // Track the detach handler for cleanup
                this.detachHandlers.set(targetId, { wc, handler: detachHandler });

                // Also clean up detach handler when WebSocket closes
                ws.on('close', () => {
                  wc.debugger.off('detach', detachHandler);
                  this.detachHandlers.delete(targetId);
                });
              } catch (err) {
                console.log('[CDP Proxy] Debugger attach note:', err);
              }
            }
          }

          // Send attachment confirmation
          this.sendEvent(ws, 'Target.attachedToTarget', {
            sessionId: sessionIdStr,
            targetInfo: {
              targetId,
              type: 'page',
              title: '',
              url: this.getTargetUrl(targetId),
              attached: true,
              browserContextId: 'default'
            },
            waitingForDebugger: false
          });

          result = { sessionId: sessionIdStr };
          break;
        }

        case 'Target.detachFromTarget': {
          const detachSessionId = params?.sessionId;
          if (detachSessionId) {
            for (const [tid, session] of this.attachedSessions) {
              if (session.sessionId === detachSessionId) {
                this.attachedSessions.delete(tid);
                break;
              }
            }
          }
          result = {};
          break;
        }

        case 'Target.createBrowserContext':
          // We only have one context (the webview)
          result = { browserContextId: 'default' };
          break;

        case 'Target.disposeBrowserContext':
          result = {};
          break;

        case 'Target.createTarget': {
          // Can't create new targets, return existing one
          const existingTargets = this.getTargets();
          if (existingTargets.length > 0) {
            result = { targetId: existingTargets[0].id };
          } else {
            throw new Error('No webview available');
          }
          break;
        }

        case 'Target.closeTarget':
          // Can't close the webview from here
          result = { success: false };
          break;

        case 'Target.getTargetInfo':
          // If a targetId is provided, return that specific target's info
          if (params?.targetId) {
            const tgtWcId = browserService.getWebContentsId(params.targetId);
            if (tgtWcId) {
              const tgtWc = webContents.fromId(tgtWcId);
              result = {
                targetInfo: {
                  targetId: params.targetId,
                  type: 'page',
                  title: tgtWc?.getTitle?.() || '',
                  url: tgtWc?.getURL() || '',
                  attached: this.attachedSessions.has(params.targetId),
                  browserContextId: 'default'
                }
              };
            } else {
              throw new Error(`Target not found: ${params.targetId}`);
            }
          } else {
            // No targetId — return browser target info (Playwright sends this after setAutoAttach)
            result = {
              targetInfo: {
                targetId: 'browser',
                type: 'browser',
                title: '',
                url: '',
                attached: true,
                browserContextId: ''
              }
            };
          }
          break;

        case 'Target.setAutoAttach':
          result = {};
          // Track this client for auto-attach so we can notify when new targets appear
          if (params?.autoAttach) {
            this.autoAttachClients.set(ws, { flatten: params?.flatten ?? true });
            console.log('[CDP Proxy] Auto-attach enabled for browser client');
          } else {
            this.autoAttachClients.delete(ws);
          }
          // Auto-attach to existing targets
          // Note: Playwright sends waitForDebuggerOnStart=true, but our targets are already
          // running so we always send waitingForDebugger=false in the attachedToTarget event
          if (params?.autoAttach) {
            const targets = this.getTargets();
            for (const target of targets) {
              if (!this.attachedSessions.has(target.id)) {
                const autoSessionId = `session-${++this.sessionCounter}`;
                this.attachedSessions.set(target.id, { targetId: target.id, sessionId: autoSessionId });

                // Attach debugger
                const autoWcId = browserService.getWebContentsId(target.id);
                if (autoWcId) {
                  const autoWc = webContents.fromId(autoWcId);
                  if (autoWc) {
                    try {
                      if (!autoWc.debugger.isAttached()) {
                        autoWc.debugger.attach('1.3');
                      }

                      // Set up event forwarding with proper cleanup tracking
                      const autoEventHandler = (_event: any, eventMethod: string, eventParams: any) => {
                        if (params?.flatten && ws.readyState === WebSocket.OPEN) {
                          this.sendEvent(ws, eventMethod, eventParams, autoSessionId);
                        }
                      };
                      autoWc.debugger.on('message', autoEventHandler);

                      // Handle debugger detachment for auto-attached targets
                      const autoDetachHandler = (_event: any, reason: string) => {
                        console.log(`[CDP Proxy] Auto-attached debugger detached from ${target.id}: ${reason}`);
                        this.attachedSessions.delete(target.id);
                        if (ws.readyState === WebSocket.OPEN) {
                          this.sendEvent(ws, 'Target.detachedFromTarget', {
                            sessionId: autoSessionId,
                            reason
                          });
                          this.sendEvent(ws, 'Target.targetDestroyed', {
                            targetId: target.id
                          });
                        }
                        autoWc.debugger.off('message', autoEventHandler);
                      };
                      autoWc.debugger.on('detach', autoDetachHandler);

                      // Clean up handlers when WebSocket closes (prevents orphaned listeners)
                      ws.on('close', () => {
                        autoWc.debugger.off('message', autoEventHandler);
                        autoWc.debugger.off('detach', autoDetachHandler);
                      });
                    } catch (err) {
                      // Already attached or attachment failed
                      console.log('[CDP Proxy] Auto-attach debugger note:', err);
                    }
                  }
                }

                this.sendEvent(ws, 'Target.attachedToTarget', {
                  sessionId: autoSessionId,
                  targetInfo: {
                    targetId: target.id,
                    type: 'page',
                    title: target.title || '',
                    url: target.url,
                    attached: true,
                    browserContextId: 'default'
                  },
                  waitingForDebugger: false
                });
              }
            }
          }
          break;

        // Browser domain
        case 'Browser.getVersion':
          result = {
            protocolVersion: '1.3',
            product: 'Claudette',
            revision: '1.0',
            userAgent: 'Mozilla/5.0 Claudette Electron Webview',
            jsVersion: process.versions.v8
          };
          break;

        case 'Browser.close':
          // Don't actually close the browser
          result = {};
          break;

        // Forward other commands to the page if we have a session
        default: {
          // Check if this is a session-specific command (flattened or in params)
          const sessionId = messageSessionId || params?.sessionId;
          if (sessionId) {
            result = await this.forwardToPage(sessionId, method, params);
          } else {
            // Try to forward to first available page
            const defaultTarget = this.getTargets()[0];
            if (defaultTarget) {
              result = await this.forwardToPageByTargetId(defaultTarget.id, method, params);
            } else {
              throw new Error(`Unknown browser method: ${method}`);
            }
          }
          break;
        }
      }

      this.sendResponse(ws, id, result);
    } catch (error) {
      console.error('[CDP Proxy] Browser command error:', method, error);
      this.sendError(ws, id, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Forward a command to a page via session ID
   */
  private async forwardToPage(sessionId: string, method: string, params?: any): Promise<any> {
    // Find the target for this session
    for (const [targetId, session] of this.attachedSessions) {
      if (session.sessionId === sessionId) {
        return this.forwardToPageByTargetId(targetId, method, params);
      }
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Send a CDP command with a timeout to prevent infinite hangs.
   * Electron's debugger.sendCommand() can silently hang forever if the debugger
   * detaches between sending and receiving a response. This wrapper ensures
   * we always get a resolution (or rejection) within a bounded time.
   */
  private async sendCommandWithTimeout(
    wc: Electron.WebContents,
    method: string,
    params?: any,
    timeoutMs: number = CdpProxyService.COMMAND_TIMEOUT_MS
  ): Promise<any> {
    return Promise.race([
      wc.debugger.sendCommand(method, params || {}),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms (debugger may be detached or target destroyed)`)),
          timeoutMs
        )
      )
    ]);
  }

  /**
   * Forward a command to a page via target ID
   */
  private async forwardToPageByTargetId(targetId: string, method: string, params?: any): Promise<any> {
    const webContentsId = browserService.getWebContentsId(targetId);
    if (!webContentsId) {
      throw new Error(`Target not found: ${targetId}`);
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      throw new Error(`WebContents not found for target: ${targetId}`);
    }

    // Ensure debugger is attached
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }

    // Remove sessionId from params before sending to debugger
    const cleanParams = { ...params };
    delete cleanParams.sessionId;

    // Log navigation-critical commands for debugging
    if (method.startsWith('Page.') || method.startsWith('Runtime.')) {
      console.log(`[CDP Proxy] Command[${targetId}] → debugger: ${method}`, method === 'Page.navigate' ? JSON.stringify(cleanParams) : '');
    }

    return this.sendCommandWithTimeout(wc, method, cleanParams);
  }

  /**
   * Handle page-level WebSocket connection (direct page control)
   */
  private handlePageConnection(ws: WebSocket, targetId: string): void {
    const webContentsId = browserService.getWebContentsId(targetId);

    if (!webContentsId) {
      console.error('[CDP Proxy] No webview found for target:', targetId);
      ws.close(1002, 'Target not found');
      return;
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      console.error('[CDP Proxy] WebContents not found:', webContentsId);
      ws.close(1002, 'WebContents not found');
      return;
    }

    console.log('[CDP Proxy] Page-level connection to target:', targetId);

    // Attach debugger
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
    } catch (error) {
      console.error('[CDP Proxy] Failed to attach debugger:', error);
      ws.close(1002, 'Failed to attach debugger');
      return;
    }

    this.activeConnections.set(ws, {
      webContentsId,
      sessionId: targetId,
      targetId,
      type: 'page'
    });

    // Forward debugger events to WebSocket
    const eventHandler = (_event: Electron.Event, method: string, params: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method, params }));
      }
    };
    wc.debugger.on('message', eventHandler);

    // Handle debugger detachment for page-level connections
    const detachHandler = (_event: any, reason: string) => {
      console.log(`[CDP Proxy] Page debugger detached from target ${targetId}: ${reason}`);
      wc.debugger.off('message', eventHandler);
      this.activeConnections.delete(ws);
      // Close the WebSocket to signal Playwright that the connection is gone
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, `Debugger detached: ${reason}`);
      }
    };
    wc.debugger.on('detach', detachHandler);

    // Handle incoming commands (with timeout protection)
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const { id, method, params } = message;

        try {
          const result = await this.sendCommandWithTimeout(wc, method, params);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id, result }));
          }
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            }));
          }
        }
      } catch (error) {
        console.error('[CDP Proxy] Failed to parse page message:', error);
      }
    });

    ws.on('close', () => {
      console.log('[CDP Proxy] Page connection closed:', targetId);
      wc.debugger.off('message', eventHandler);
      wc.debugger.off('detach', detachHandler);
      this.activeConnections.delete(ws);
    });
  }

  /**
   * Send a CDP response
   */
  private sendResponse(ws: WebSocket, id: number, result: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, result: result || {} }));
    }
  }

  /**
   * Send a CDP error
   */
  private sendError(ws: WebSocket, id: number, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        id,
        error: { code: -32000, message }
      }));
    }
  }

  /**
   * Send a CDP event
   */
  private sendEvent(ws: WebSocket, method: string, params: any, sessionId?: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      const event: any = { method, params };
      if (sessionId) {
        event.sessionId = sessionId;
      }
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * Get URL for a target
   */
  private getTargetUrl(targetId: string): string {
    const wcId = browserService.getWebContentsId(targetId);
    if (wcId) {
      const wc = webContents.fromId(wcId);
      return wc?.getURL() || '';
    }
    return '';
  }

  /**
   * Stop the CDP proxy server
   */
  stop(): void {
    // Close all active connections
    for (const [ws] of this.activeConnections) {
      ws.close();
    }
    this.activeConnections.clear();
    this.attachedSessions.clear();
    this.browserClients.clear();
    this.detachHandlers.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    console.log('[CDP Proxy] Server stopped');
  }

  /**
   * Get the WebSocket URL for connecting to a specific webview
   */
  getWebSocketUrl(sessionId: string): string | null {
    const webContentsId = browserService.getWebContentsId(sessionId);
    if (!webContentsId) {
      return null;
    }
    return `ws://localhost:${this.port}/devtools/page/${sessionId}`;
  }

  /**
   * Get the browser-level WebSocket URL (for Playwright connectOverCDP)
   */
  getBrowserWebSocketUrl(): string {
    return `ws://localhost:${this.port}/devtools/browser`;
  }

  /**
   * Get the HTTP endpoint URL (for Playwright connectOverCDP)
   */
  getHttpEndpoint(): string {
    return `http://localhost:${this.port}`;
  }

  /**
   * Get CDP targets list (for /json/list endpoint compatibility)
   */
  getTargets(): Array<{ id: string; type: string; title?: string; url: string; webSocketDebuggerUrl: string }> {
    const targets: Array<{ id: string; type: string; title?: string; url: string; webSocketDebuggerUrl: string }> = [];

    const sessions = browserService.getRegisteredSessions();
    for (const sessionId of sessions) {
      const webContentsId = browserService.getWebContentsId(sessionId);
      if (webContentsId) {
        const wc = webContents.fromId(webContentsId);
        if (wc) {
          targets.push({
            id: sessionId,
            type: 'page',
            title: wc.getTitle?.() || '',
            url: wc.getURL() || '',
            webSocketDebuggerUrl: `ws://localhost:${this.port}/devtools/page/${sessionId}`,
          });
        }
      }
    }

    return targets;
  }

  /**
   * Notify auto-attach clients that a new webview target has appeared.
   * Called by browser.service.ts when a webview registers AFTER Playwright
   * has already called Target.setAutoAttach (solves the race condition where
   * Stagehand connects before the browser panel's webview is ready).
   */
  notifyNewTarget(sessionId: string): void {
    if (this.autoAttachClients.size === 0) {
      return; // No clients waiting for auto-attach
    }

    const wcId = browserService.getWebContentsId(sessionId);
    if (!wcId) {
      console.log(`[CDP Proxy] notifyNewTarget: no webContentsId for session ${sessionId}`);
      return;
    }

    const wc = webContents.fromId(wcId);
    if (!wc) {
      console.log(`[CDP Proxy] notifyNewTarget: webContents not found for wcId ${wcId}`);
      return;
    }

    // Skip if this target is already attached
    if (this.attachedSessions.has(sessionId)) {
      console.log(`[CDP Proxy] notifyNewTarget: session ${sessionId} already attached, skipping`);
      return;
    }

    console.log(`[CDP Proxy] notifyNewTarget: new webview registered (session=${sessionId}), notifying ${this.autoAttachClients.size} auto-attach client(s)`);

    // For each auto-attach client, attach to this new target
    for (const [ws, config] of this.autoAttachClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.autoAttachClients.delete(ws);
        continue;
      }

      const autoSessionId = `session-${++this.sessionCounter}`;
      this.attachedSessions.set(sessionId, { targetId: sessionId, sessionId: autoSessionId });

      try {
        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }

        // Set up event forwarding
        const autoEventHandler = (_event: any, eventMethod: string, eventParams: any) => {
          if (config.flatten && ws.readyState === WebSocket.OPEN) {
            this.sendEvent(ws, eventMethod, eventParams, autoSessionId);
          }
        };
        wc.debugger.on('message', autoEventHandler);

        // Handle debugger detachment
        const autoDetachHandler = (_event: any, reason: string) => {
          console.log(`[CDP Proxy] Auto-attached debugger detached from ${sessionId}: ${reason}`);
          this.attachedSessions.delete(sessionId);
          if (ws.readyState === WebSocket.OPEN) {
            this.sendEvent(ws, 'Target.detachedFromTarget', {
              sessionId: autoSessionId,
              reason
            });
            this.sendEvent(ws, 'Target.targetDestroyed', {
              targetId: sessionId
            });
          }
          wc.debugger.off('message', autoEventHandler);
        };
        wc.debugger.on('detach', autoDetachHandler);

        // Clean up when WebSocket closes
        ws.on('close', () => {
          try {
            wc.debugger.off('message', autoEventHandler);
            wc.debugger.off('detach', autoDetachHandler);
          } catch {
            // webContents may already be destroyed
          }
        });
      } catch (err) {
        console.log('[CDP Proxy] notifyNewTarget: debugger attach note:', err);
      }

      // Send the Target.attachedToTarget event — this is what Playwright is waiting for!
      this.sendEvent(ws, 'Target.attachedToTarget', {
        sessionId: autoSessionId,
        targetInfo: {
          targetId: sessionId,
          type: 'page',
          title: wc.getTitle?.() || '',
          url: wc.getURL() || '',
          attached: true,
          browserContextId: 'default'
        },
        waitingForDebugger: false
      });

      console.log(`[CDP Proxy] notifyNewTarget: sent attachedToTarget for session=${sessionId}, cdpSession=${autoSessionId}`);
    }
  }

  /**
   * Clean up CDP proxy state when a webview is unregistered.
   * Called by browser.service.ts when a webview is removed.
   * Removes stale sessions and notifies connected Playwright clients.
   */
  unregisterWebview(sessionId: string, webContentsId: number): void {
    console.log(`[CDP Proxy] Cleaning up for unregistered webview: session=${sessionId}, wcId=${webContentsId}`);

    // Find and remove any attached sessions for this target
    const session = this.attachedSessions.get(sessionId);
    if (session) {
      this.attachedSessions.delete(sessionId);
      console.log(`[CDP Proxy] Removed attached session ${session.sessionId} for target ${sessionId}`);

      // Notify all connected browser-level WebSocket clients
      for (const ws of this.browserClients) {
        if (ws.readyState === WebSocket.OPEN) {
          this.sendEvent(ws, 'Target.detachedFromTarget', {
            sessionId: session.sessionId,
            reason: 'webview unregistered'
          });
          this.sendEvent(ws, 'Target.targetDestroyed', {
            targetId: sessionId
          });
        }
      }
    }

    // Clean up any detach handlers for this target
    const detachEntry = this.detachHandlers.get(sessionId);
    if (detachEntry) {
      try {
        detachEntry.wc.debugger.off('detach', detachEntry.handler);
      } catch {
        // webContents may already be destroyed
      }
      this.detachHandlers.delete(sessionId);
    }

    // Close any page-level connections for this webContents
    for (const [ws, conn] of this.activeConnections) {
      if (conn.webContentsId === webContentsId && conn.type === 'page') {
        console.log(`[CDP Proxy] Closing page connection for destroyed webview: ${sessionId}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1001, 'Webview unregistered');
        }
        this.activeConnections.delete(ws);
      }
    }
  }

  /**
   * Check if the proxy is running
   */
  isRunning(): boolean {
    return this.httpServer !== null;
  }

  /**
   * Get the proxy port
   */
  getPort(): number {
    return this.port;
  }
}

export const cdpProxyService = new CdpProxyService();
