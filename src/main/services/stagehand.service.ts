import { Stagehand, type Page } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { BrowserWindow, session } from 'electron';
import { cdpProxyService } from './cdp-proxy.service';
import { browserService } from './browser.service';
import { IPC_CHANNELS } from '../../shared/constants/channels';

export interface StagehandActionResult {
  success: boolean;
  message?: string;
  screenshot?: string; // base64 encoded PNG
  error?: string;
}

export interface StagehandExtractResult<T = unknown> {
  success: boolean;
  data?: T;
  screenshot?: string;
  error?: string;
}

export interface StagehandObserveResult {
  success: boolean;
  actions?: Array<{
    selector: string;
    description: string;
    suggestedAction: string;
  }>;
  screenshot?: string;
  error?: string;
}

export interface StagehandAgentResult {
  success: boolean;
  message?: string;
  actions?: Array<{ type: string; description: string }>;
  screenshot?: string;
  error?: string;
}

export interface StagehandSnapshot {
  url: string;
  title: string;
  screenshot: string; // base64 encoded PNG
  html: string;
  timestamp: Date;
}

/**
 * Service for AI-powered browser automation using Stagehand V3
 * Replaces the CDP-based BrowserService with natural language capabilities
 */
export class StagehandService {
  private stagehand: Stagehand | null = null;
  private isInitializing = false;
  private anthropicApiKey: string | null = null;
  private googleApiKey: string | null = null;
  private connectedToWebview = false; // Track if we're connected to webview or own browser

  /**
   * Set the Anthropic API key for Stagehand's AI features
   */
  setApiKey(apiKey: string): void {
    this.anthropicApiKey = apiKey;
  }

  /**
   * Set the Google API key for Gemini models
   */
  setGoogleApiKey(apiKey: string): void {
    this.googleApiKey = apiKey;
  }

  /**
   * Sync cookies from the Electron webview partition into the Stagehand Playwright context.
   * This ensures the agent's browser has the same auth state as the user's webview.
   * @param sessionId - Session ID to read cookies from (determines partition name)
   * @param url - Optional URL filter for cookies (e.g. 'https://github.com')
   */
  async syncCookiesFromWebview(sessionId?: string, url?: string): Promise<void> {
    if (!this.stagehand || !this.connectedToWebview) {
      return; // No point syncing if not connected to webview or not initialized
    }

    const page = this.getPage();
    if (!page) return;

    try {
      // Determine which session's partition to read from
      const targetSessionId = sessionId || browserService.getFirstSessionId();
      if (!targetSessionId) {
        console.log('[Stagehand] No session ID for cookie sync');
        return;
      }

      const partitionName = browserService.getPartitionName(targetSessionId);
      const ses = session.fromPartition(partitionName);

      // Get cookies, optionally filtered by URL
      const filter: Electron.CookiesGetFilter = url ? { url } : {};
      const electronCookies = await ses.cookies.get(filter);

      if (electronCookies.length === 0) {
        console.log('[Stagehand] No cookies to sync from partition:', partitionName);
        return;
      }

      // Convert Electron cookies to Playwright format
      const playwrightCookies = electronCookies
        .filter(c => c.domain) // Must have a domain
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain!,
          path: c.path || '/',
          expires: c.expirationDate || -1,
          httpOnly: c.httpOnly || false,
          secure: c.secure || false,
          sameSite: (c.sameSite === 'no_restriction' ? 'None' :
                     c.sameSite === 'lax' ? 'Lax' :
                     c.sameSite === 'strict' ? 'Strict' : 'Lax') as 'Strict' | 'Lax' | 'None',
        }));

      // Inject into Playwright context
      // Stagehand's Page type doesn't expose context(), but the underlying Playwright page has it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).context().addCookies(playwrightCookies);
      console.log(`[Stagehand] Synced ${playwrightCookies.length} cookies from partition ${partitionName}`);
    } catch (error) {
      console.error('[Stagehand] Cookie sync error:', error);
      // Non-fatal — continue without cookies
    }
  }

  /**
   * Initialize Stagehand instance
   * Creates a new browser instance in local mode
   * @param sessionId - Optional session ID to open browser panel for
   */
  async init(sessionId?: string): Promise<void> {
    if (this.stagehand) {
      return; // Already initialized
    }

    if (this.isInitializing) {
      // Wait for existing initialization
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;

    try {
      console.log('[Stagehand] Initializing with Electron webview...');

      // Set API keys in environment
      // Stagehand uses GOOGLE_GENERATIVE_AI_API_KEY for Gemini models
      if (this.anthropicApiKey) {
        process.env.ANTHROPIC_API_KEY = this.anthropicApiKey;
      }
      if (this.googleApiKey) {
        process.env.GOOGLE_API_KEY = this.googleApiKey;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = this.googleApiKey;
      }

      // Ensure browser panel is open so webview is available
      console.log('[Stagehand] Ensuring browser panel is open for session:', sessionId || 'unknown');
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow && sessionId) {
        mainWindow.webContents.send(IPC_CHANNELS.BROWSER_OPEN_PANEL, { sessionId });
        // Give the browser panel time to initialize and register with CDP proxy
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Try to connect to webview via CDP proxy
      // Retry a few times since webview might not be created yet
      let cdpUrl: string | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        console.log('[Stagehand] Checking for webview via CDP proxy (attempt', attempt + 1, ')');

        cdpUrl = await this.findWebviewCdpUrl();
        if (cdpUrl) {
          console.log('[Stagehand] Using webview CDP URL:', cdpUrl);
          break;
        }

        if (attempt < 4) {
          console.log('[Stagehand] No webview found yet, waiting...');
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
        }
      }

      if (!cdpUrl) {
        console.log('[Stagehand] No webview CDP found, will launch own browser');
      }

      // If we have a CDP URL (HTTP endpoint), get the browser WebSocket URL
      let browserWsUrl: string | undefined;
      if (cdpUrl) {
        browserWsUrl = cdpProxyService.getBrowserWebSocketUrl();
        console.log('[Stagehand] Using browser WebSocket URL:', browserWsUrl);
      }

      this.stagehand = new Stagehand({
        env: 'LOCAL',
        apiKey: this.googleApiKey || undefined, // Pass Google API key at top level
        localBrowserLaunchOptions: browserWsUrl ? {
          cdpUrl: browserWsUrl, // Connect to existing webview via browser-level CDP
        } : {
          headless: true, // Fallback: launch own browser
        },
        model: 'google/gemini-2.5-flash', // Model name (API key passed separately)
        domSettleTimeout: 3000, // Wait for DOM to stabilize
        verbose: 1,
        disablePino: true, // Disable Pino logging to prevent worker thread crashes
      });

      await this.stagehand.init();
      this.connectedToWebview = !!cdpUrl;
      console.log('[Stagehand] Browser initialized successfully', cdpUrl ? '(connected to webview)' : '(own browser)');
    } catch (error) {
      console.error('[Stagehand] Failed to initialize:', error);
      this.stagehand = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Check if Stagehand is initialized and ready
   */
  isReady(): boolean {
    return this.stagehand !== null;
  }

  /**
   * Check if Stagehand is connected to the Electron webview (vs its own headless browser)
   */
  isConnectedToWebview(): boolean {
    return this.connectedToWebview;
  }

  /**
   * Get the active page from Stagehand context
   */
  private getPage(): Page | undefined {
    if (!this.stagehand) return undefined;
    return this.stagehand.context.activePage();
  }

  /**
   * Navigate to a URL
   * @param url - The URL to navigate to
   * @param sessionId - Optional session ID for opening browser panel
   */
  async navigate(url: string, sessionId?: string): Promise<StagehandActionResult> {
    // Retry logic for destroyed browser
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureInitialized(sessionId);

        const page = this.getPage();
        if (!page) {
          // Page disappeared after init — force reinit and retry
          console.warn('[Stagehand] No active page after ensureInitialized, forcing reinit');
          this.stagehand = null;
          this.connectedToWebview = false;
          if (attempt < 1) continue;
          return { success: false, error: 'No active page available' };
        }

        // Sync cookies before navigating so the agent has the same auth state
        await this.syncCookiesFromWebview(sessionId, url);

        console.log('[Stagehand] Navigating to:', url, this.connectedToWebview ? '(webview)' : '(own browser - webview will NOT update visually)');

        // Add timeout to page.goto (30 seconds)
        const gotoPromise = page.goto(url, { waitUntil: 'domcontentloaded' });
        const gotoTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Navigation timed out after 30 seconds')), 30000)
        );
        await Promise.race([gotoPromise, gotoTimeout]);

        // Wait a bit for dynamic content
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Capture screenshot with timeout
        let screenshot: string | undefined;
        try {
          const screenshotPromise = this.captureScreenshot();
          const screenshotTimeout = new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5000)
          );
          screenshot = await Promise.race([screenshotPromise, screenshotTimeout]);
        } catch (error) {
          console.warn('[Stagehand] Screenshot failed during navigation, continuing without it:', error);
          screenshot = undefined;
        }

        return {
          success: true,
          message: `Navigated to ${url}`,
          screenshot,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Stagehand] Navigation error (attempt', attempt + 1, '):', errorMsg);

        // If browser was destroyed, force reinit and retry
        if (errorMsg.includes('destroyed') || errorMsg.includes('-32000')) {
          console.log('[Stagehand] Browser destroyed, forcing reinitialization...');
          this.stagehand = null;
          this.connectedToWebview = false;
          if (attempt < 1) continue; // Retry
        }

        return {
          success: false,
          error: errorMsg,
        };
      }
    }
    return { success: false, error: 'Navigation failed after retries' };
  }

  /**
   * Execute a natural language action
   * Uses Stagehand's AI to interpret and execute the action
   * @param instruction - The instruction to execute
   * @param sessionId - Optional session ID for opening browser panel
   */
  async act(instruction: string, sessionId?: string): Promise<StagehandActionResult> {
    // Retry logic for destroyed browser
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureInitialized(sessionId);

        console.log('[Stagehand] Executing action:', instruction);

        // Add timeout to prevent hanging forever (30 second timeout)
        const actPromise = this.stagehand!.act(instruction);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Action timed out after 30 seconds')), 30000)
        );

        await Promise.race([actPromise, timeoutPromise]);

        // Wait for any resulting page changes
        await new Promise(resolve => setTimeout(resolve, 500));

        // Capture screenshot with timeout to prevent hanging
        let screenshot: string | undefined;
        try {
          const screenshotPromise = this.captureScreenshot();
          const screenshotTimeout = new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5000) // 5 second timeout for screenshot
          );
          screenshot = await Promise.race([screenshotPromise, screenshotTimeout]);
        } catch (error) {
          console.warn('[Stagehand] Screenshot failed, continuing without it:', error);
          screenshot = undefined;
        }

        return {
          success: true,
          message: `Executed: ${instruction}`,
          screenshot,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Stagehand] Action error (attempt', attempt + 1, '):', errorMsg);

        // If browser was destroyed, force reinit and retry
        if (errorMsg.includes('destroyed') || errorMsg.includes('-32000')) {
          console.log('[Stagehand] Browser destroyed, forcing reinitialization...');
          this.stagehand = null;
          this.connectedToWebview = false;
          if (attempt < 1) continue; // Retry
        }

        return {
          success: false,
          error: errorMsg,
        };
      }
    }
    return { success: false, error: 'Action failed after retries' };
  }

  /**
   * Extract structured data from the page
   * Uses Stagehand's AI to understand and extract data based on a schema
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async extract<T = unknown>(instruction: string, schema: any): Promise<StagehandExtractResult<T>> {
    try {
      await this.ensureInitialized();

      console.log('[Stagehand] Extracting data:', instruction);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await this.stagehand!.extract(instruction, schema as any);

      const screenshot = await this.captureScreenshot();

      return {
        success: true,
        data: data as T,
        screenshot,
      };
    } catch (error) {
      console.error('[Stagehand] Extract error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Observe available actions on the page
   * Returns a list of interactive elements and suggested actions
   * @param instruction - Optional instruction for what to observe
   * @param sessionId - Optional session ID for opening browser panel
   */
  async observe(instruction?: string, sessionId?: string): Promise<StagehandObserveResult> {
    try {
      await this.ensureInitialized();

      console.log('[Stagehand] Observing page:', instruction || 'all elements');
      // observe() requires a string instruction
      const observeInstruction = instruction || 'Find all interactive elements on the page';

      // Add timeout to prevent hanging forever (30 second timeout)
      const observePromise = this.stagehand!.observe(observeInstruction);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Observe timed out after 30 seconds')), 30000)
      );
      const actions = await Promise.race([observePromise, timeoutPromise]) as Array<{ selector: string; description: string }>;

      // Capture screenshot with timeout
      let screenshot: string | undefined;
      try {
        const screenshotPromise = this.captureScreenshot();
        const screenshotTimeout = new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 5000)
        );
        screenshot = await Promise.race([screenshotPromise, screenshotTimeout]);
      } catch (error) {
        console.warn('[Stagehand] Screenshot failed during observe, continuing without it:', error);
        screenshot = undefined;
      }

      return {
        success: true,
        actions: actions.map((a: { selector: string; description: string }) => ({
          selector: a.selector,
          description: a.description,
          suggestedAction: 'click', // Default suggested action
        })),
        screenshot,
      };
    } catch (error) {
      console.error('[Stagehand] Observe error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a multi-step task using Stagehand's autonomous agent
   */
  async agent(task: string, sessionId?: string): Promise<StagehandAgentResult> {
    // Retry logic for lost page
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureInitialized(sessionId);

        // Verify we have an active page before creating agent
        const page = this.getPage();
        if (!page) {
          console.warn('[Stagehand] No active page for agent, forcing reinit');
          this.stagehand = null;
          this.connectedToWebview = false;
          if (attempt < 1) continue;
          return { success: false, error: 'No active page available for agent execution' };
        }

        console.log('[Stagehand] Agent executing task:', task);
        const agentInstance = this.stagehand!.agent({
          model: 'google/gemini-2.5-flash',
        });

        // Add timeout for agent execution (60 seconds for complex tasks)
        const executePromise = agentInstance.execute(task);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent execution timed out after 60 seconds')), 60000)
        );
        const result = await Promise.race([executePromise, timeoutPromise]);

        // Capture screenshot with timeout
        let screenshot: string | undefined;
        try {
          const screenshotPromise = this.captureScreenshot();
          const screenshotTimeout = new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 5000)
          );
          screenshot = await Promise.race([screenshotPromise, screenshotTimeout]);
        } catch (error) {
          console.warn('[Stagehand] Screenshot failed during agent execution, continuing without it:', error);
          screenshot = undefined;
        }

        // Handle the result - it could be AgentResult or AgentStreamResult
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyResult = result as any;

        return {
          success: anyResult.success ?? true,
          message: anyResult.message ?? 'Task completed',
          actions: anyResult.actions?.map((a: { type?: string; reasoning?: string; action?: string; instruction?: string }) => ({
            type: a.type || 'action',
            description: a.reasoning || a.action || a.instruction || `[${a.type || 'action'}]`,
          })) ?? [],
          screenshot,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : (error ? String(error) : 'Unknown agent error');
        console.error('[Stagehand] Agent error (attempt', attempt + 1, '):', errorMsg, error);

        // If browser was destroyed, force reinit and retry
        if (errorMsg.includes('destroyed') || errorMsg.includes('-32000') || errorMsg.includes('Target closed')) {
          console.log('[Stagehand] Browser destroyed during agent, forcing reinit...');
          this.stagehand = null;
          this.connectedToWebview = false;
          if (attempt < 1) continue;
        }

        return {
          success: false,
          error: errorMsg,
        };
      }
    }
    return { success: false, error: 'Agent execution failed after retries' };
  }

  /**
   * Capture a full page snapshot including screenshot and HTML
   */
  async captureSnapshot(): Promise<StagehandSnapshot | null> {
    try {
      await this.ensureInitialized();

      const page = this.getPage();
      if (!page) return null;

      const url = page.url();
      const title = await page.title();
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      const screenshot = screenshotBuffer.toString('base64');

      return {
        url,
        title,
        screenshot,
        html,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('[Stagehand] Snapshot error:', error);
      return null;
    }
  }

  /**
   * Capture just a screenshot
   */
  async captureScreenshot(): Promise<string | undefined> {
    try {
      const page = this.getPage();
      if (!page) return undefined;

      const screenshotBuffer = await page.screenshot({
        type: 'png',
        fullPage: false,
      });
      return screenshotBuffer.toString('base64');
    } catch (error) {
      console.error('[Stagehand] Screenshot error:', error);
      return undefined;
    }
  }

  /**
   * Get current page info
   */
  async getPageInfo(): Promise<{ url: string; title: string } | null> {
    try {
      const page = this.getPage();
      if (!page) return null;

      return {
        url: page.url(),
        title: await page.title(),
      };
    } catch (error) {
      console.error('[Stagehand] Page info error:', error);
      return null;
    }
  }

  /**
   * Get page HTML
   */
  async getHTML(): Promise<string | null> {
    try {
      const page = this.getPage();
      if (!page) return null;
      return await page.evaluate(() => document.documentElement.outerHTML);
    } catch (error) {
      console.error('[Stagehand] HTML error:', error);
      return null;
    }
  }

  /**
   * Click on an element using a CSS selector (fallback for when AI isn't needed)
   */
  async click(selector: string): Promise<StagehandActionResult> {
    try {
      await this.ensureInitialized();

      const page = this.getPage();
      if (!page) {
        return { success: false, error: 'No active page available' };
      }

      console.log('[Stagehand] Clicking selector:', selector);
      await page.locator(selector).click();

      await new Promise(resolve => setTimeout(resolve, 500));
      const screenshot = await this.captureScreenshot();

      return {
        success: true,
        message: `Clicked: ${selector}`,
        screenshot,
      };
    } catch (error) {
      console.error('[Stagehand] Click error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Type text into an element (fallback for when AI isn't needed)
   */
  async type(selector: string, text: string): Promise<StagehandActionResult> {
    try {
      await this.ensureInitialized();

      const page = this.getPage();
      if (!page) {
        return { success: false, error: 'No active page available' };
      }

      console.log('[Stagehand] Typing into selector:', selector);
      await page.locator(selector).fill(text);

      const screenshot = await this.captureScreenshot();

      return {
        success: true,
        message: `Typed into: ${selector}`,
        screenshot,
      };
    } catch (error) {
      console.error('[Stagehand] Type error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Extract text from the page or an element
   */
  async extractText(selector?: string): Promise<{ success: boolean; text?: string; error?: string }> {
    try {
      await this.ensureInitialized();

      const page = this.getPage();
      if (!page) {
        return { success: false, error: 'No active page available' };
      }

      let text: string;

      if (selector) {
        // Use evaluate to get text content of element
        text = await page.evaluate((sel: string) => {
          const element = document.querySelector(sel);
          return element ? element.textContent || '' : '';
        }, selector);
      } else {
        text = await page.evaluate(() => document.body.innerText);
      }

      return { success: true, text };
    } catch (error) {
      console.error('[Stagehand] Extract text error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch (error) {
        console.error('[Stagehand] Close error:', error);
      }
      this.stagehand = null;
      this.connectedToWebview = false;
    }
  }

  /**
   * Check if a webview is available via CDP proxy
   * Returns the HTTP endpoint URL for Playwright's connectOverCDP
   */
  private async findWebviewCdpUrl(): Promise<string | undefined> {
    // First check if CDP proxy is running
    if (!cdpProxyService.isRunning()) {
      console.log('[Stagehand] CDP proxy not running');
      return undefined;
    }

    // Get available webview targets from the proxy
    const targets = cdpProxyService.getTargets();
    console.log('[Stagehand] CDP proxy targets:', targets.length);

    if (targets.length > 0) {
      // Use the HTTP endpoint - Playwright will fetch /json/version to get the WebSocket URL
      const httpEndpoint = cdpProxyService.getHttpEndpoint();
      console.log('[Stagehand] Found webview targets, using HTTP endpoint:', httpEndpoint);
      return httpEndpoint;
    }

    // Fallback: check if there's a registered session we can use
    const sessionId = browserService.getFirstSessionId();
    if (sessionId) {
      const httpEndpoint = cdpProxyService.getHttpEndpoint();
      console.log('[Stagehand] Using session webview via proxy:', sessionId);
      return httpEndpoint;
    }

    return undefined;
  }

  /**
   * Reconnect to the webview if available
   * Call this when the webview might now be available
   */
  async reconnectToWebview(): Promise<boolean> {
    console.log('[Stagehand] Checking for webview to reconnect...');

    const cdpUrl = await this.findWebviewCdpUrl();
    if (!cdpUrl) {
      console.log('[Stagehand] No webview found for reconnection');
      return false;
    }

    console.log('[Stagehand] Found webview, reconnecting via:', cdpUrl);

    // Close existing browser
    await this.close();

    // Reinitialize with webview
    this.isInitializing = true;
    try {
      if (this.anthropicApiKey) {
        process.env.ANTHROPIC_API_KEY = this.anthropicApiKey;
      }
      if (this.googleApiKey) {
        process.env.GOOGLE_API_KEY = this.googleApiKey;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = this.googleApiKey;
      }

      // Use the browser-level WebSocket URL for connection
      const browserWsUrl = cdpProxyService.getBrowserWebSocketUrl();
      console.log('[Stagehand] Connecting to browser WebSocket:', browserWsUrl);

      this.stagehand = new Stagehand({
        env: 'LOCAL',
        apiKey: this.googleApiKey || undefined, // Pass Google API key at top level
        localBrowserLaunchOptions: {
          cdpUrl: browserWsUrl,
        },
        model: 'google/gemini-2.5-flash', // Model name (API key passed separately)
        domSettleTimeout: 3000,
        verbose: 1,
        disablePino: true, // Disable Pino logging to prevent worker thread crashes
      });

      await this.stagehand.init();
      this.connectedToWebview = true;
      console.log('[Stagehand] Successfully reconnected to webview');
      return true;
    } catch (error) {
      console.error('[Stagehand] Failed to reconnect to webview:', error);
      this.stagehand = null;
      this.connectedToWebview = false;
      return false;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Ensure Stagehand is initialized before operations
   * If not connected to webview, try to reconnect
   * @param sessionId - Optional session ID for opening browser panel
   */
  private async ensureInitialized(sessionId?: string): Promise<void> {
    // Check if we need to initialize or reinitialize
    let needsInit = !this.stagehand;

    // If we have stagehand, verify the browser/page is still alive
    if (this.stagehand && !needsInit) {
      try {
        const page = this.stagehand.context.activePage();
        if (!page) {
          console.log('[Stagehand] No active page, will reinitialize');
          needsInit = true;
          // Must null out stagehand so init() doesn't early-return
          try {
            await this.stagehand?.close();
          } catch {
            // Ignore close errors
          }
          this.stagehand = null;
          this.connectedToWebview = false;
        } else {
          // Try to access the page to see if it's still alive
          await page.url();
        }
      } catch (error) {
        console.log('[Stagehand] Browser appears destroyed, will reinitialize:', error);
        needsInit = true;
        // Clean up the dead reference
        try {
          await this.stagehand?.close();
        } catch {
          // Ignore close errors on dead browser
        }
        this.stagehand = null;
        this.connectedToWebview = false;
      }
    }

    if (needsInit) {
      await this.init(sessionId);
    } else if (!this.connectedToWebview) {
      // Already have own browser, but check if webview is now available
      const cdpUrl = await this.findWebviewCdpUrl();
      if (cdpUrl) {
        console.log('[Stagehand] Webview now available, switching from own browser');
        await this.reconnectToWebview();
      }
    }
  }
}

export const stagehandService = new StagehandService();
