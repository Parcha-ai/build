import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Target,
  Camera,
  Code,
  X,
  Trash2,
  Bot,
  FileText,
  FileSpreadsheet,
  Presentation,
  File,
} from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import { useSessionStore } from '../../stores/session.store';
import type { Session } from '../../../shared/types';

interface AutomationIndicator {
  type: 'click' | 'type' | 'navigate' | 'snapshot';
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
}

// Helper to detect document types from file URLs
function getDocumentInfo(url: string): { isFile: boolean; filename: string; docType: 'docx' | 'xlsx' | 'slides' | 'web' | 'other'; displayName: string } {
  if (!url.startsWith('file://')) {
    return { isFile: false, filename: '', docType: 'web', displayName: '' };
  }

  const filePath = url.replace('file://', '');
  const filename = filePath.split('/').pop() || filePath;
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  let docType: 'docx' | 'xlsx' | 'slides' | 'web' | 'other' = 'other';
  let displayName = filename;

  // Check if this is a preview file from our document service
  if (filename.startsWith('preview-') && ext === 'html') {
    const match = filename.match(/preview-\d+-(.+)\.html$/);
    if (match) {
      const originalName = match[1];
      displayName = originalName;
      if (originalName.toLowerCase().includes('docx') || originalName.toLowerCase().includes('doc')) {
        docType = 'docx';
      } else if (originalName.toLowerCase().includes('xlsx') || originalName.toLowerCase().includes('xls')) {
        docType = 'xlsx';
      } else if (originalName.toLowerCase().includes('slide') || originalName.toLowerCase().includes('presentation')) {
        docType = 'slides';
      } else {
        docType = 'other';
      }
    }
  } else {
    if (['docx', 'doc'].includes(ext)) docType = 'docx';
    else if (['xlsx', 'xls', 'csv'].includes(ext)) docType = 'xlsx';
    else if (['html', 'htm'].includes(ext) && (filename.includes('slide') || filename.includes('presentation') || filename.includes('reveal'))) docType = 'slides';
    else if (['html', 'htm'].includes(ext)) docType = 'web';
  }

  return { isFile: true, filename, docType, displayName };
}

// Icon component for document type
function DocumentIcon({ docType, className }: { docType: string; className?: string }) {
  switch (docType) {
    case 'docx':
      return <FileText className={className} />;
    case 'xlsx':
      return <FileSpreadsheet className={className} />;
    case 'slides':
      return <Presentation className={className} />;
    default:
      return <File className={className} />;
  }
}

interface BrowserPreviewProps {
  session: Session;
  isVisible?: boolean; // Controls visibility without unmounting
}

const DEBUG_BROWSER_PREVIEW = false;
const logBrowserPreview = (...args: unknown[]) => {
  if (DEBUG_BROWSER_PREVIEW) {
    console.log(...args);
  }
};

export default function BrowserPreview({ session, isVisible = true }: BrowserPreviewProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const registeredWebContentsIdRef = useRef<number | null>(null);
  const updateSession = useSessionStore((s) => s.updateSession);

  // Smart URL detection: use last browser URL, or find last localhost URL in transcript
  const getSessionUrl = useCallback(() => {
    if (session.lastBrowserUrl) {
      return session.lastBrowserUrl;
    }

    // Search messages for localhost URLs (most recent first)
    const sessionMessages = useSessionStore.getState().messages[session.id] || [];
    const localhostRegex = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?[^\s]*/gi;

    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const msg = sessionMessages[i];
      if (msg.content) {
        const matches = msg.content.match(localhostRegex);
        if (matches && matches.length > 0) {
          logBrowserPreview('[BrowserPreview] Found localhost URL in transcript:', matches[matches.length - 1]);
          return matches[matches.length - 1];
        }
      }
    }

    // Fallback to session's web port, or default to 3000 if not set
    const port = session.ports?.web || 3000;
    return `http://localhost:${port}`;
  }, [session.id, session.lastBrowserUrl, session.ports?.web]);

  const [url, setUrl] = useState(() => {
    try {
      const initialUrl = getSessionUrl();
      logBrowserPreview('[BrowserPreview] Initial URL:', initialUrl);
      return initialUrl;
    } catch (err) {
      console.error('[BrowserPreview] Error getting initial URL:', err);
      return 'http://localhost:3000';
    }
  });
  const [inputUrl, setInputUrl] = useState(() => {
    try {
      return getSessionUrl();
    } catch (err) {
      return 'http://localhost:3000';
    }
  });
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [webviewReady, setWebviewReady] = useState(false);
  // Track the last URL we told the webview to load, to avoid redundant loadURL calls
  const lastLoadedUrl = useRef<string>(url);
  // Initial URL for webview src - only used once, then loadURL is used for navigation
  const initialUrl = useRef<string>(url);
  const initializedSessionId = useRef<string>(session.id);

  // Retry state for failed loads
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Automation visual feedback state
  const [isAutomationActive, setIsAutomationActive] = useState(false);
  const [automationIndicator, setAutomationIndicator] = useState<AutomationIndicator | null>(null);
  const [clickRipples, setClickRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  // Use per-session inspector state for multi-session support
  const {
    sessionInspectorActive,
    setSessionInspectorActive,
    setSessionSelectedElement,
    sessionEditingText,
  } = useUIStore();

  // Get this session's inspector state
  const isInspectorActive = sessionInspectorActive[session.id] || false;

  // Inspector drag-to-select region state (Shift+drag within inspector mode)
  const [regionStart, setRegionStart] = useState<{ x: number; y: number } | null>(null);
  const [regionEnd, setRegionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const regionOverlayRef = useRef<HTMLDivElement>(null);

  // Track Shift key for region select mode
  useEffect(() => {
    if (!isInspectorActive) { setShiftHeld(false); return; }
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [isInspectorActive]);
  const setInspectorActive = useCallback(
    (active: boolean) => setSessionInspectorActive(session.id, active),
    [session.id, setSessionInspectorActive]
  );
  const setSelectedElement = useCallback(
    (element: unknown | null) => setSessionSelectedElement(session.id, element),
    [session.id, setSessionSelectedElement]
  );

  // Initialize URL for this tab/session.
  useEffect(() => {
    if (initializedSessionId.current === session.id) {
      return;
    }
    initializedSessionId.current = session.id;
    const newUrl = getSessionUrl();
    logBrowserPreview('[BrowserPreview] Initializing browser for session:', session.id, '->', newUrl);
    initialUrl.current = newUrl;
    lastLoadedUrl.current = '';
    retryCount.current = 0;
    setUrl(newUrl);
    setInputUrl(newUrl);
  }, [getSessionUrl, session.id]);

  // Navigate webview whenever url state changes and differs from what's currently loaded
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !webviewReady || !url) return;

    // Only call loadURL if url differs from last loaded — avoids redundant reloads
    // when handleDidNavigate updates url state to reflect where the webview already is
    if (url !== lastLoadedUrl.current) {
      logBrowserPreview('[BrowserPreview] URL changed, calling loadURL:', url, '(was:', lastLoadedUrl.current, ')');
      lastLoadedUrl.current = url;
      // loadURL returns a Promise that rejects on ERR_ABORTED (-3) during redirects.
      // This is normal for SPAs — the page cancels initial load and redirects.
      webview.loadURL(url).catch((e: Error) => {
        logBrowserPreview('[BrowserPreview] loadURL rejected (usually harmless redirect):', e.message);
      });
    }
  }, [url, webviewReady]);

  // Register webview with main process for CDP access
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDomReady = () => {
      // Mark webview as ready for navigation
      setWebviewReady(true);

      // Get webContentsId and register with main process for CDP
      const webContentsId = (webview as any).getWebContentsId?.();
      if (webContentsId) {
        logBrowserPreview('[BrowserPreview] Registering webview for CDP:', session.id, '->', webContentsId);
        registeredWebContentsIdRef.current = webContentsId;
        window.electronAPI.browser.registerWebview(session.id, webContentsId);
      }

      // Ensure webview can receive keyboard input
      webview.focus();
    };

    webview.addEventListener('dom-ready', handleDomReady);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      // Unregister when unmounting
      const registeredWebContentsId = registeredWebContentsIdRef.current;
      registeredWebContentsIdRef.current = null;
      window.electronAPI.browser.unregisterWebview(session.id, registeredWebContentsId ?? undefined);
    };
  }, [session.id]);

  // Handle webview events
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      console.error('[BrowserPreview] No webview ref');
      return;
    }

    logBrowserPreview('[BrowserPreview] Setting up webview, initial URL:', url);

    const handleDidStartLoading = () => {
      logBrowserPreview('[BrowserPreview] Started loading');
      setIsLoading(true);
    };
    const handleDidStopLoading = () => {
      logBrowserPreview('[BrowserPreview] Stopped loading');
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      logBrowserPreview('[BrowserPreview] handleDidNavigate fired with e.url:', e.url);
      // Successful navigation — reset retry counter
      retryCount.current = 0;
      // Sync lastLoadedUrl so the navigation effect doesn't re-trigger loadURL
      lastLoadedUrl.current = e.url;
      setUrl(e.url);
      setInputUrl(e.url);
      // Save the URL to session so it persists across reloads
      updateSession(session.id, { lastBrowserUrl: e.url });
    };
    const handleDidFailLoad = (e: any) => {
      console.error('[BrowserPreview] Navigation failed:', e.errorCode, e.errorDescription);
      // Don't stop loading spinner on transient errors - OAuth redirects can trigger these
      if (e.errorCode !== -3) { // -3 is ERR_ABORTED, often happens during redirects
        setIsLoading(false);
      }

      // Retry on connection errors (dev server not yet running, etc.)
      // -102 = ERR_CONNECTION_REFUSED, -105 = ERR_NAME_NOT_RESOLVED, -106 = ERR_INTERNET_DISCONNECTED
      const retryableCodes = [-102, -105, -106];
      if (retryableCodes.includes(e.errorCode) && retryCount.current < 3) {
        retryCount.current++;
        logBrowserPreview(`[BrowserPreview] Scheduling retry ${retryCount.current}/3 in 3 seconds...`);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          const wv = webviewRef.current;
          if (wv) {
            logBrowserPreview(`[BrowserPreview] Retrying navigation (attempt ${retryCount.current})...`);
            wv.reload();
          }
        }, 3000);
      }
    };

    webview.addEventListener('did-start-loading', handleDidStartLoading);
    webview.addEventListener('did-stop-loading', handleDidStopLoading);
    webview.addEventListener('did-navigate', handleDidNavigate as any);
    webview.addEventListener('did-navigate-in-page', handleDidNavigate as any);
    webview.addEventListener('did-fail-load', handleDidFailLoad as any);

    return () => {
      webview.removeEventListener('did-start-loading', handleDidStartLoading);
      webview.removeEventListener('did-stop-loading', handleDidStopLoading);
      webview.removeEventListener('did-navigate', handleDidNavigate as any);
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate as any);
      webview.removeEventListener('did-fail-load', handleDidFailLoad as any);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  // Handle navigation requests from main process (e.g., from BrowserSnapshot tool)
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onNavigate((data: { sessionId: string; url: string }) => {
      const { sessionId: reqSessionId, url: targetUrl } = data;
      if (reqSessionId !== session.id) return;

      logBrowserPreview('[BrowserPreview] Navigation request from main process:', targetUrl);
      navigate(targetUrl);
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [session.id]);

  // Handle CMD+R browser refresh (custom event from App.tsx)
  useEffect(() => {
    const handleBrowserRefresh = () => {
      const webview = webviewRef.current;
      if (webview && isVisible) {
        logBrowserPreview('[BrowserPreview] CMD+R hard refresh triggered');
        webview.reloadIgnoringCache();
      }
    };

    window.addEventListener('browser-refresh', handleBrowserRefresh);
    return () => window.removeEventListener('browser-refresh', handleBrowserRefresh);
  }, [isVisible]);

  // Handle automation events from main process (CDP-based automation visual feedback)
  useEffect(() => {
    logBrowserPreview('[BrowserPreview] Setting up automation event listener for session:', session.id);
    const unsubscribe = window.electronAPI.browser.onAutomationEvent((data: { sessionId: string; type: string; action: string; data?: Record<string, unknown> }) => {
      logBrowserPreview('[BrowserPreview] Received automation event:', data, 'current session:', session.id);
      if (data.sessionId !== session.id) {
        logBrowserPreview('[BrowserPreview] Ignoring event - session mismatch');
        return;
      }

      logBrowserPreview('[BrowserPreview] Processing automation event:', data);

      if (data.type === 'start') {
        setIsAutomationActive(true);
        setAutomationIndicator({
          type: data.action as any,
          selector: data.data?.selector as string,
          text: data.data?.text as string,
        });
      } else if (data.type === 'position' && data.action === 'click') {
        // Show click ripple at position
        const x = data.data?.x as number;
        const y = data.data?.y as number;
        if (x !== undefined && y !== undefined) {
          const id = Date.now();
          setClickRipples(prev => [...prev, { id, x, y }]);
          setTimeout(() => {
            setClickRipples(prev => prev.filter(r => r.id !== id));
          }, 600);
        }
      } else if (data.type === 'end') {
        // Clear automation state after a short delay for visual feedback
        setTimeout(() => {
          setIsAutomationActive(false);
          setAutomationIndicator(null);
        }, 300);
      }
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [session.id]);

  // Handle Stagehand browser updates — navigate webview to match Stagehand's URL
  useEffect(() => {
    logBrowserPreview('[BrowserPreview] Setting up Stagehand update listener for session:', session.id);
    const unsubscribe = window.electronAPI.browser.onBrowserUpdate((data: { sessionId: string; screenshot: string; url?: string; timestamp: string }) => {
      if (data.sessionId !== session.id) {
        return;
      }

      logBrowserPreview('[BrowserPreview] Stagehand update received:', data.url || 'unknown URL');

      // Navigate the webview to match Stagehand's current URL
      if (data.url) {
        navigate(data.url);
      }
      setIsAutomationActive(true);

      // Auto-hide automation indicator after a delay
      setTimeout(() => {
        setIsAutomationActive(false);
      }, 1500);
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [session.id]);

  // Helper to show click ripple effect
  const showClickRipple = async (selector: string) => {
    const webview = webviewRef.current;
    if (!webview) return;

    try {
      // Get element position from webview
      const pos = await webview.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()
      `);

      if (pos) {
        const id = Date.now();
        setClickRipples(prev => [...prev, { id, x: pos.x, y: pos.y }]);
        // Remove ripple after animation
        setTimeout(() => {
          setClickRipples(prev => prev.filter(r => r.id !== id));
        }, 600);
      }
    } catch (e) {
      console.error('[BrowserPreview] Failed to show click ripple:', e);
    }
  };

  // Handle browser action requests from main process (click, type, extract, etc.)
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onAction(async (data: { sessionId: string; requestId: string; action: string; params: Record<string, unknown> }) => {
      const { sessionId: reqSessionId, requestId, action, params } = data;
      if (reqSessionId !== session.id) return;

      const webview = webviewRef.current;
      if (!webview) {
        window.electronAPI.browser.sendActionResult({ requestId, success: false, error: 'No webview available' });
        return;
      }

      logBrowserPreview('[BrowserPreview] Action request:', action, params);

      // Show automation active state
      setIsAutomationActive(true);

      try {
        let result: any;

        switch (action) {
          case 'click': {
            const { selector } = params as { selector: string };
            // Show visual indicator
            setAutomationIndicator({ type: 'click', selector });
            // Show click ripple
            await showClickRipple(selector);

            result = await webview.executeJavaScript(`
              (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { found: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
                el.click();
                return { found: true, tagName: el.tagName, text: el.textContent?.slice(0, 100) };
              })()
            `);
            if (!result.found) {
              setIsAutomationActive(false);
              setAutomationIndicator(null);
              window.electronAPI.browser.sendActionResult({ requestId, success: false, error: result.error });
              return;
            }
            window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { clicked: result } });
            break;
          }

          case 'type': {
            const { selector, text } = params as { selector: string; text: string };
            // Show visual indicator
            setAutomationIndicator({ type: 'type', selector, text: text.slice(0, 30) });

            result = await webview.executeJavaScript(`
              (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { found: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                  el.value = ${JSON.stringify(text)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (el.isContentEditable) {
                  el.textContent = ${JSON.stringify(text)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                  return { found: true, error: 'Element is not editable' };
                }
                return { found: true, typed: true };
              })()
            `);
            if (!result.found) {
              setIsAutomationActive(false);
              setAutomationIndicator(null);
              window.electronAPI.browser.sendActionResult({ requestId, success: false, error: result.error });
              return;
            }
            if (result.error) {
              setIsAutomationActive(false);
              setAutomationIndicator(null);
              window.electronAPI.browser.sendActionResult({ requestId, success: false, error: result.error });
              return;
            }
            window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { typed: true } });
            break;
          }

          case 'extractText': {
            const { selector } = params as { selector?: string };
            if (selector) {
              result = await webview.executeJavaScript(`
                (function() {
                  const el = document.querySelector(${JSON.stringify(selector)});
                  if (!el) return { found: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
                  return { found: true, text: el.textContent || '' };
                })()
              `);
              if (!result.found) {
                window.electronAPI.browser.sendActionResult({ requestId, success: false, error: result.error });
                return;
              }
              window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { text: result.text } });
            } else {
              const text = await webview.executeJavaScript('document.body.innerText');
              window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { text } });
            }
            break;
          }

          case 'executeScript': {
            const { script } = params as { script: string };
            result = await webview.executeJavaScript(script);
            window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { result } });
            break;
          }

          case 'getPageInfo': {
            const pageUrl = webview.getURL();
            const title = await webview.executeJavaScript('document.title');
            window.electronAPI.browser.sendActionResult({ requestId, success: true, data: { url: pageUrl, title } });
            break;
          }

          default:
            window.electronAPI.browser.sendActionResult({ requestId, success: false, error: `Unknown action: ${action}` });
        }

        // Clear automation indicator after successful action (with delay for visual feedback)
        setTimeout(() => {
          setIsAutomationActive(false);
          setAutomationIndicator(null);
        }, 500);
      } catch (error) {
        console.error('[BrowserPreview] Action error:', error);
        setIsAutomationActive(false);
        setAutomationIndicator(null);
        window.electronAPI.browser.sendActionResult({
          requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [session.id]);

  // Handle snapshot capture requests from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onCaptureRequest(async (data: { sessionId: string; requestId?: string }) => {
      const { sessionId: reqSessionId, requestId } = data;
      if (reqSessionId !== session.id) return;

      const webview = webviewRef.current;
      if (!webview) {
        console.error('[BrowserPreview] No webview available for snapshot');
        // Must send error response to prevent timeout in main process
        if (requestId) {
          window.electronAPI.browser.sendSnapshotData({
            url: '',
            screenshot: '',
            html: '',
            timestamp: new Date(),
            requestId,
            error: 'No webview available',
          });
        }
        return;
      }

      try {
        // Capture screenshot
        const screenshot = await webview.capturePage();
        const screenshotDataUrl = screenshot.toDataURL();

        // Get HTML content with timeout protection
        const html = await Promise.race([
          webview.executeJavaScript('document.documentElement.outerHTML'),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('JavaScript execution timeout (5s)')), 5000)
          )
        ]);

        // Get current URL safely
        const url = webview.getURL() || 'about:blank';

        // Send snapshot data back to main process
        window.electronAPI.browser.sendSnapshotData({
          url,
          screenshot: screenshotDataUrl,
          html,
          timestamp: new Date(),
          requestId, // Include requestId for proper matching
        });

        logBrowserPreview('[BrowserPreview] Snapshot captured successfully');
      } catch (error) {
        console.error('[BrowserPreview] Error capturing snapshot:', error);
        // Send error snapshot so main process doesn't timeout
        window.electronAPI.browser.sendSnapshotData({
          url: webview.getURL() || 'about:blank',
          screenshot: '',
          html: `<error>${error instanceof Error ? error.message : String(error)}</error>`,
          timestamp: new Date(),
          requestId,
        });
      }
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [session.id]);

  // Handle Cmd+R browser refresh from MainContent
  useEffect(() => {
    const handleRefresh = (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail.sessionId === session.id) {
        logBrowserPreview('[BrowserPreview] Hard refreshing browser via Cmd+R');
        webviewRef.current?.reloadIgnoringCache();
      }
    };

    window.addEventListener('grep-browser-refresh', handleRefresh as EventListener);
    return () => window.removeEventListener('grep-browser-refresh', handleRefresh as EventListener);
  }, [session.id]);

  // Handle auto-reload after text replacement Edit tool completion
  useEffect(() => {
    const handleTextEditReload = (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail.sessionId === session.id) {
        logBrowserPreview('[BrowserPreview] Hard reloading browser after text replacement edit');
        webviewRef.current?.reloadIgnoringCache();
      }
    };

    window.addEventListener('grep-browser-reload', handleTextEditReload as EventListener);
    return () => window.removeEventListener('grep-browser-reload', handleTextEditReload as EventListener);
  }, [session.id]);

  const injectInspector = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    logBrowserPreview('[BrowserPreview] injectInspector called');

    // Listen for console messages (our communication channel)
    const handleConsoleMessage = async (event: Electron.ConsoleMessageEvent) => {
      logBrowserPreview('[BrowserPreview] Console message received:', event.message.slice(0, 100));

      // Handle text edit start/end to blur/focus chat input
      if (event.message.startsWith('GREP_TEXT_EDIT_START:')) {
        window.dispatchEvent(new CustomEvent('grep-text-edit-active', {
          detail: { active: true, sessionId: session.id }
        }));
        return;
      }
      if (event.message.startsWith('GREP_TEXT_EDIT_END:')) {
        window.dispatchEvent(new CustomEvent('grep-text-edit-active', {
          detail: { active: false, sessionId: session.id }
        }));
        return;
      }

      if (event.message.startsWith('GREP_INSPECTOR:')) {
        try {
          const data = JSON.parse(event.message.replace('GREP_INSPECTOR:', ''));
          logBrowserPreview('[BrowserPreview] Inspector data parsed:', data);

          // Handle inline text replacement
          if (data.type === 'text_replacement') {
            const { originalText, replacementText, context } = data;

            // Construct prompt for Claude
            const prompt = `I need you to replace text in the UI for the page at ${url}.

**Original Text**: "${originalText}"
**Replacement Text**: "${replacementText}"

**Context**:
- Parent element: <${context.parentTag}>
- CSS selector: ${context.parentSelector}
${context.reactComponent ? `- React component: ${context.reactComponent}` : ''}
- Surrounding text: ...${context.before} [TARGET] ${context.after}...

Please:
1. Find the source file that renders this UI element
2. Locate the exact occurrence of "${originalText}" in the code
3. Replace it with "${replacementText}"
4. If there are multiple occurrences, use the context above to determine which one

Use the Edit tool to make the change. The page will reload automatically once you're done.`;

            // Send directly to Claude (no modal)
            const sendMessage = useSessionStore.getState().sendMessage;
            const setSessionEditingText = useUIStore.getState().setSessionEditingText;

            setSessionEditingText(session.id, true);
            sendMessage(session.id, prompt, []);

            return;
          }

          // Capture screenshot of element bounds
          let screenshotBase64 = '';
          if (data.boundingRect && webview) {
            const { x, y, width, height } = data.boundingRect;
            // Add some padding around the element
            const padding = 10;
            const rect = {
              x: Math.max(0, x - padding),
              y: Math.max(0, y - padding),
              width: width + (padding * 2),
              height: height + (padding * 2),
            };

            try {
              logBrowserPreview('[BrowserPreview] Capturing screenshot of rect:', rect);
              const image = await webview.capturePage(rect as Electron.Rectangle);
              screenshotBase64 = image.toDataURL().split(',')[1] || '';
              logBrowserPreview('[BrowserPreview] Screenshot captured, size:', screenshotBase64.length);
            } catch (screenshotError) {
              console.error('[BrowserPreview] Failed to capture screenshot:', screenshotError);
            }
          }

          // Include screenshot in the element data
          const elementWithScreenshot = {
            ...data,
            screenshot: screenshotBase64,
          };

          // Generate structured markdown for the element context
          const elementName = data.reactComponent
            ? `<${data.reactComponent}>`
            : `<${data.tagName.toLowerCase()}>`;

          const markdown = `## Selected Element

**Element:** ${elementName}
**Selector:** \`${data.selector}\`
${data.id ? `**ID:** \`${data.id}\`\n` : ''}${data.className ? `**Classes:** \`${data.className}\`\n` : ''}**Position:** x=${data.boundingRect.x}, y=${data.boundingRect.y}, width=${data.boundingRect.width}px, height=${data.boundingRect.height}px
${data.textContent ? `**Text Content:** "${data.textContent.slice(0, 100)}${data.textContent.length > 100 ? '...' : ''}"\n` : ''}
**Current Page:** ${url}

---

**Your instruction:**
`;

          logBrowserPreview('[BrowserPreview] Element selected - populating chat input');

          // Dispatch event to populate chat input with element context (as attachments only, no text)
          const insertEvent = new CustomEvent('grep-insert-chat', {
            detail: {
              sessionId: session.id,
              content: '',
              screenshot: screenshotBase64,
              elementContext: {
                selector: data.selector,
                outerHTML: `[Page: ${url}]\n\n${data.outerHTML || ''}`,
                tagName: data.tagName,
                reactComponent: data.reactComponent,
              },
            },
          });
          window.dispatchEvent(insertEvent);

          // Set selected element for inspector panel
          setSelectedElement(elementWithScreenshot);
          setInspectorActive(false);
        } catch (e) {
          console.error('Failed to parse inspector data:', e);
        }
      }
    };

    // Remove previous listener before adding new one (prevents duplicates on re-inject)
    if ((webview as any)._inspectorCleanup) {
      (webview as any)._inspectorCleanup();
    }
    webview.addEventListener('console-message', handleConsoleMessage as any);

    (webview as any)._inspectorCleanup = () => {
      webview.removeEventListener('console-message', handleConsoleMessage as any);
    };

    // Inject inspector script
    try {
      await webview.executeJavaScript(`
        (function() {
          console.log('[GREP] Starting inspector injection...');

          // Remove existing inspector
          const existing = document.getElementById('grep-inspector');
          if (existing) {
            console.log('[GREP] Removing existing inspector');
            existing.remove();
          }
          const existingTooltip = document.getElementById('grep-inspector-tooltip');
          if (existingTooltip) existingTooltip.remove();

          // Remove any existing text highlights
          const existingHighlights = document.querySelectorAll('.grep-text-highlight');
          existingHighlights.forEach(h => {
            const parent = h.parentNode;
            if (parent) {
              while (h.firstChild) parent.insertBefore(h.firstChild, h);
              parent.removeChild(h);
            }
          });

          // Add shimmer animation CSS
          if (!document.getElementById('grep-shimmer-style')) {
            const style = document.createElement('style');
            style.id = 'grep-shimmer-style';
            style.textContent = \`
              @keyframes grep-shimmer {
                0% { background-position: -200% 0; }
                100% { background-position: 200% 0; }
              }
            \`;
            document.head.appendChild(style);
          }

          // Create overlay with purple theme (for elements)
          const overlay = document.createElement('div');
          overlay.id = 'grep-inspector';
          overlay.style.cssText = 'position:fixed !important;pointer-events:none !important;background:rgba(93,95,239,0.15) !important;border:2px solid #5D5FEF !important;z-index:2147483647 !important;transition:all 0.05s ease !important;display:block !important;visibility:visible !important;box-sizing:border-box !important;';
          document.body.appendChild(overlay);

          // Create info tooltip - positioned ABOVE element like React DevTools
          const tooltip = document.createElement('div');
          tooltip.id = 'grep-inspector-tooltip';
          tooltip.style.cssText = 'position:fixed !important;background:#5D5FEF !important;color:#fff !important;padding:3px 8px !important;font-size:11px !important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace !important;border-radius:3px !important;z-index:2147483647 !important;pointer-events:none !important;white-space:nowrap !important;display:block !important;visibility:visible !important;box-shadow:0 2px 8px rgba(0,0,0,0.3) !important;';
          document.body.appendChild(tooltip);

          document.body.style.cursor = 'crosshair';

          // Track hovered text node
          let hoveredTextNode = null;

          // Get text node at a specific point
          function getTextNodeAtPoint(x, y) {
            const element = document.elementFromPoint(x, y);
            if (!element) return null;

            // Check if this element contains direct text nodes
            for (const node of element.childNodes) {
              if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim()) {
                // Get the range for this text node
                const range = document.createRange();
                range.selectNodeContents(node);
                const rects = range.getClientRects();

                // Check if mouse is over this text node's bounds
                for (const rect of rects) {
                  if (x >= rect.left && x <= rect.right &&
                      y >= rect.top && y <= rect.bottom) {
                    return {
                      node: node,
                      text: node.textContent.trim(),
                      element: element,
                      rect: rect
                    };
                  }
                }
              }
            }

            return null;
          }

          function clearTextHighlight() {
            const highlights = document.querySelectorAll('.grep-text-highlight');
            highlights.forEach(h => {
              const parent = h.parentNode;
              if (parent) {
                while (h.firstChild) parent.insertBefore(h.firstChild, h);
                parent.removeChild(h);
              }
            });
          }

          // Try to get React component name using DevTools hook or fiber
          function getReactComponentName(el) {
            // Method 1: Try React DevTools global hook (most reliable)
            const devToolsHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (devToolsHook && devToolsHook.renderers) {
              for (const [, renderer] of devToolsHook.renderers) {
                try {
                  // Try to get fiber from element using DevTools API
                  if (renderer.findFiberByHostInstance) {
                    const fiber = renderer.findFiberByHostInstance(el);
                    if (fiber) {
                      const name = getComponentNameFromFiber(fiber);
                      if (name) return name;
                    }
                  }
                } catch (e) {
                  // DevTools API not available or error, try fallback
                }
              }
            }

            // Method 2: Direct fiber access (fallback)
            const fiberKey = Object.keys(el).find(key =>
              key.startsWith('__reactFiber$') ||
              key.startsWith('__reactInternalInstance$')
            );

            if (fiberKey) {
              const fiber = el[fiberKey];
              return getComponentNameFromFiber(fiber);
            }
            return null;
          }

          // Extract component name from React fiber
          function getComponentNameFromFiber(fiber) {
            let current = fiber;
            // Walk up to find the nearest named component
            while (current) {
              if (current.type) {
                // Function/class component
                if (typeof current.type === 'function') {
                  const name = current.type.displayName || current.type.name;
                  if (name && name !== 'Anonymous' && !name.startsWith('_') && name.length < 50) {
                    return name;
                  }
                }
                // ForwardRef: { $$typeof: Symbol(react.forward_ref), render: fn }
                if (current.type.$$typeof?.toString().includes('forward_ref')) {
                  const name = current.type.displayName || current.type.render?.displayName || current.type.render?.name;
                  if (name) return name;
                }
                // Memo: { $$typeof: Symbol(react.memo), type: fn }
                if (current.type.$$typeof?.toString().includes('memo')) {
                  const innerType = current.type.type;
                  const name = innerType?.displayName || innerType?.name;
                  if (name) return name;
                }
                // Context Provider/Consumer
                if (current.type._context) {
                  return current.type._context.displayName || 'Context';
                }
              }
              current = current.return;
            }
            return null;
          }

          // Get a nice display name for the element
          function getDisplayName(el) {
            const reactName = getReactComponentName(el);
            const tagName = el.tagName.toLowerCase();

            if (reactName) {
              return reactName + ' · ' + tagName;
            }

            // Fallback to tag + id/class
            if (el.id) {
              return tagName + '#' + el.id;
            }
            if (el.className && typeof el.className === 'string') {
              const mainClass = el.className.split(' ').filter(Boolean)[0];
              if (mainClass) {
                return tagName + '.' + mainClass;
              }
            }
            return tagName;
          }

          function getSelector(el) {
            const parts = [];
            let current = el;
            while (current && current !== document.body) {
              let selector = current.tagName.toLowerCase();
              if (current.id) selector += '#' + current.id;
              else if (current.className && typeof current.className === 'string') {
                selector += '.' + current.className.split(' ').filter(Boolean).join('.');
              }
              parts.unshift(selector);
              current = current.parentElement;
            }
            return parts.join(' > ');
          }

          function handleMove(e) {
            if (!e.target || e.target === document.body || e.target === document.documentElement) return;

            // First, check if we're over a text node
            const textNode = getTextNodeAtPoint(e.clientX, e.clientY);

            if (textNode) {
              // Hovering over text node - show yellow highlight
              if (!hoveredTextNode || hoveredTextNode.node !== textNode.node) {
                clearTextHighlight();
                hoveredTextNode = textNode;

                // Create yellow highlight for text
                const range = document.createRange();
                range.selectNodeContents(textNode.node);
                const highlight = document.createElement('span');
                highlight.className = 'grep-text-highlight';
                highlight.style.cssText = 'background: rgba(255, 255, 0, 0.4) !important; cursor: text !important; pointer-events: none !important;';

                try {
                  range.surroundContents(highlight);
                } catch (e) {
                  // If surroundContents fails (complex DOM), just highlight the element
                  console.warn('[GREP] Could not highlight text node:', e);
                  hoveredTextNode = null;
                }
              }

              // Hide element overlay when over text
              overlay.style.display = 'none';

              // Show tooltip with "Text" indicator
              tooltip.textContent = '📝 Text';
              tooltip.style.background = '#F59E0B !important'; // Yellow/orange for text
              tooltip.style.display = 'block';

              // Position tooltip
              const rect = textNode.rect;
              const tooltipHeight = 24;
              const spaceAbove = rect.top;

              if (spaceAbove >= tooltipHeight + 4) {
                tooltip.style.top = (rect.top - tooltipHeight - 4) + 'px';
              } else {
                tooltip.style.top = (rect.bottom + 4) + 'px';
              }

              const tooltipWidth = tooltip.offsetWidth || 100;
              let leftPos = rect.left;
              if (leftPos + tooltipWidth > window.innerWidth - 10) {
                leftPos = window.innerWidth - tooltipWidth - 10;
              }
              if (leftPos < 10) leftPos = 10;
              tooltip.style.left = leftPos + 'px';

            } else {
              // Hovering over element (not text) - show purple overlay
              clearTextHighlight();
              hoveredTextNode = null;

              const el = e.target;
              const rect = el.getBoundingClientRect();

              // Position overlay
              overlay.style.display = 'block';
              overlay.style.top = rect.top + 'px';
              overlay.style.left = rect.left + 'px';
              overlay.style.width = rect.width + 'px';
              overlay.style.height = rect.height + 'px';

              // Get display name and position tooltip ABOVE the element
              const displayName = getDisplayName(el);
              tooltip.textContent = displayName;
              tooltip.style.background = '#5D5FEF !important'; // Purple for elements
              tooltip.style.display = 'block';

              // Position tooltip above element, or below if not enough space
              const tooltipHeight = 24;
              const spaceAbove = rect.top;

              if (spaceAbove >= tooltipHeight + 4) {
                // Position above
                tooltip.style.top = (rect.top - tooltipHeight - 4) + 'px';
              } else {
                // Position below
                tooltip.style.top = (rect.bottom + 4) + 'px';
              }

              // Align left edge with element, but keep on screen
              const tooltipWidth = tooltip.offsetWidth || 100;
              let leftPos = rect.left;
              if (leftPos + tooltipWidth > window.innerWidth - 10) {
                leftPos = window.innerWidth - tooltipWidth - 10;
              }
              if (leftPos < 10) leftPos = 10;
              tooltip.style.left = leftPos + 'px';
            }
          }

          function handleClick(e) {
            e.preventDefault();
            e.stopPropagation();

            // Check if we clicked on a text node
            if (hoveredTextNode) {
              console.log('[GREP] Text node clicked:', hoveredTextNode.text);

              const element = hoveredTextNode.element;
              const originalText = hoveredTextNode.text;

              // Get context for Claude
              const siblings = Array.from(element.parentNode ? element.parentNode.childNodes : []);
              const index = siblings.indexOf(element);
              const prevText = (index > 0 && siblings[index - 1]?.textContent) ? siblings[index - 1].textContent.trim() : '';
              const nextText = (index < siblings.length - 1 && siblings[index + 1]?.textContent) ? siblings[index + 1].textContent.trim() : '';
              const reactComponent = getReactComponentName(element);
              const rect = hoveredTextNode.rect;

              // Create inline editable overlay
              const editor = document.createElement('div');
              editor.id = 'grep-inline-editor';
              editor.contentEditable = 'true';
              editor.textContent = originalText;
              editor.style.cssText = \`
                position: fixed !important;
                top: \${rect.top}px !important;
                left: \${rect.left}px !important;
                min-width: \${rect.width}px !important;
                min-height: \${rect.height}px !important;
                background: rgba(255, 255, 255, 0.98) !important;
                color: #000 !important;
                padding: 2px 6px !important;
                border: 2px solid #5D5FEF !important;
                border-radius: 4px !important;
                font: inherit !important;
                line-height: inherit !important;
                z-index: 2147483647 !important;
                outline: none !important;
                box-shadow: 0 4px 12px rgba(93, 95, 239, 0.3) !important;
                white-space: pre-wrap !important;
                word-wrap: break-word !important;
              \`;

              document.body.appendChild(editor);

              // Notify renderer to blur chat input
              console.log('GREP_TEXT_EDIT_START:');

              editor.focus();

              // Select all text
              const range = document.createRange();
              range.selectNodeContents(editor);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);

              const cleanup = () => {
                // Notify renderer to re-enable chat input
                console.log('GREP_TEXT_EDIT_END:');

                editor.remove();
                document.body.style.cursor = '';
                overlay.remove();
                tooltip.remove();
                clearTextHighlight();
                document.removeEventListener('mouseover', handleMove);
                document.removeEventListener('click', handleClick, true);
              };

              // Enter to confirm, Escape to cancel
              editor.addEventListener('keydown', (evt) => {
                console.log('[GREP] Editor keydown:', evt.key);

                if (evt.key === 'Enter' && !evt.shiftKey) {
                  evt.preventDefault();
                  evt.stopPropagation();
                  evt.stopImmediatePropagation();

                  console.log('[GREP] Enter pressed, submitting edit');
                  const replacement = editor.textContent.trim();

                  if (replacement && replacement !== originalText) {
                    // Add shimmer to original element
                    element.style.animation = 'grep-shimmer 1.5s infinite';
                    element.style.backgroundImage = 'linear-gradient(90deg, transparent, rgba(93,95,239,0.3), transparent)';
                    element.style.backgroundSize = '200% 100%';

                    const data = {
                      type: 'text_replacement',
                      originalText: originalText,
                      replacementText: replacement,
                      context: {
                        before: prevText,
                        after: nextText,
                        parentTag: element.tagName.toLowerCase(),
                        parentSelector: getSelector(element),
                        reactComponent: reactComponent || undefined
                      }
                    };
                    console.log('GREP_INSPECTOR:' + JSON.stringify(data));
                  }
                  cleanup();
                } else if (evt.key === 'Escape') {
                  console.log('[GREP] Escape pressed, canceling edit');
                  evt.preventDefault();
                  evt.stopPropagation();
                  evt.stopImmediatePropagation();
                  cleanup();
                }
              });

              // Click outside to cancel
              setTimeout(() => {
                const outsideClick = (evt) => {
                  if (!editor.contains(evt.target)) {
                    cleanup();
                    document.removeEventListener('click', outsideClick, true);
                  }
                };
                document.addEventListener('click', outsideClick, true);
              }, 100);

            } else {
              // Element click (existing behavior)
              const el = e.target;
              const selector = getSelector(el);
              const reactComponent = getReactComponentName(el);

              console.log('[GREP] Element clicked:', selector);

              // Get bounding rect for screenshot capture
              const rect = el.getBoundingClientRect();
              const context = {
                tagName: el.tagName.toLowerCase(),
                id: el.id || '',
                className: (typeof el.className === 'string' ? el.className : ''),
                selector: selector,
                reactComponent: reactComponent || '',
                innerHTML: (el.innerHTML || '').slice(0, 500),
                outerHTML: (el.outerHTML || '').slice(0, 1000),
                textContent: (el.textContent || '').slice(0, 500),
                attributes: Array.from(el.attributes || []).map(a => ({ name: a.name, value: a.value })),
                // Include bounding rect for screenshot capture
                boundingRect: {
                  x: Math.max(0, Math.floor(rect.x)),
                  y: Math.max(0, Math.floor(rect.y)),
                  width: Math.ceil(rect.width),
                  height: Math.ceil(rect.height),
                },
              };

              // Send via console.log which will be caught by console-message event
              console.log('GREP_INSPECTOR:' + JSON.stringify(context));
            }

            // Cleanup
            document.body.style.cursor = '';
            overlay.remove();
            tooltip.remove();
            clearTextHighlight();
            document.removeEventListener('mouseover', handleMove);
            document.removeEventListener('click', handleClick, true);

            console.log('[GREP] Inspector cleaned up');
          }

          document.addEventListener('mouseover', handleMove);
          document.addEventListener('click', handleClick, true);

          console.log('[GREP] Inspector initialized successfully');
        })();
      `);
      logBrowserPreview('[BrowserPreview] Inspector injected successfully');
    } catch (error) {
      console.error('[BrowserPreview] Failed to inject inspector:', error);
    }
  }, [setSelectedElement, setInspectorActive]);

  // Handle inspector mode - inject when active, cleanup when inactive
  useEffect(() => {
    const webview = webviewRef.current;
    logBrowserPreview('[BrowserPreview] Inspector effect running, isInspectorActive:', isInspectorActive, 'webview:', !!webview);

    if (isInspectorActive && webview) {
      logBrowserPreview('[BrowserPreview] Calling injectInspector...');
      injectInspector();
    } else if (!isInspectorActive && webview) {
      // Cleanup when inspector is disabled
      if ((webview as any)._inspectorCleanup) {
        (webview as any)._inspectorCleanup();
        delete (webview as any)._inspectorCleanup;
      }
      // Remove inspector elements from page
      try {
        webview.executeJavaScript(`
          document.body.style.cursor = '';
          document.getElementById('grep-inspector')?.remove();
          document.getElementById('grep-inspector-tooltip')?.remove();
        `).catch(() => {
          // Ignore promise rejection if page not loaded.
        });
      } catch {
        // Ignore synchronous error if webview not ready
      }
    }

    // Cleanup on unmount
    return () => {
      if (webview && (webview as any)._inspectorCleanup) {
        (webview as any)._inspectorCleanup();
        delete (webview as any)._inspectorCleanup;
      }
    };
  }, [isInspectorActive, injectInspector]);

  const cancelInspector = async () => {
    setInspectorActive(false);
    const webview = webviewRef.current;
    if (webview) {
      // Cleanup event listeners
      if ((webview as any)._inspectorCleanup) {
        (webview as any)._inspectorCleanup();
        delete (webview as any)._inspectorCleanup;
      }

      // Remove inspector elements from page
      try {
        await webview.executeJavaScript(`
          document.body.style.cursor = '';
          document.getElementById('grep-inspector')?.remove();
          document.getElementById('grep-inspector-tooltip')?.remove();
        `);
      } catch {
        // Ignore errors if webview not ready
      }
    }
  };

  const navigate = (targetUrl: string) => {
    logBrowserPreview('[BrowserPreview] navigate() called with:', targetUrl);
    if (!targetUrl.startsWith('http') && !targetUrl.startsWith('file://')) {
      targetUrl = 'http://' + targetUrl;
    }
    logBrowserPreview('[BrowserPreview] navigate() setting URL to:', targetUrl);
    // Setting url state triggers the navigation effect, which calls loadURL
    // if the URL differs from lastLoadedUrl
    setUrl(targetUrl);
    setInputUrl(targetUrl);
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  const clearStorage = async () => {
    const webview = webviewRef.current;
    if (!webview) return;

    try {
      // First, clear storage at the Electron session level (cookies, etc.)
      await window.electronAPI.browser.clearStorage(session.id);

      // Then clear storage in the page context (localStorage, sessionStorage, IndexedDB)
      await webview.executeJavaScript(`
        localStorage.clear();
        sessionStorage.clear();
        // Clear all IndexedDB databases
        if (window.indexedDB && window.indexedDB.databases) {
          window.indexedDB.databases().then(dbs => {
            dbs.forEach(db => {
              if (db.name) window.indexedDB.deleteDatabase(db.name);
            });
          });
        }
      `);

      logBrowserPreview('[BrowserPreview] All storage cleared successfully');

      // Hard reload the page to start fresh
      webview.reloadIgnoringCache();
    } catch (error) {
      console.error('[BrowserPreview] Failed to clear storage:', error);
    }
  };

  if (session.status !== 'running') {
    return (
      <div
        className="h-full flex items-center justify-center bg-claude-bg text-claude-text-secondary"
        style={{ display: isVisible ? 'flex' : 'none' }}
      >
        <p>Start the session to preview</p>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-claude-bg"
      style={{ display: isVisible ? 'flex' : 'none' }}
    >
      {/* Toolbar */}
      <div className="h-10 flex items-center gap-2 px-2 bg-claude-surface border-b border-claude-border">
        {/* Navigation */}
        <button
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors disabled:opacity-30"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors disabled:opacity-30"
        >
          <ArrowRight size={16} />
        </button>
        <button
          onClick={() => webviewRef.current?.reloadIgnoringCache()}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors"
          title="Hard refresh (ignore cache)"
        >
          <RotateCw size={16} className={isLoading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={clearStorage}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors text-red-400 hover:text-red-300"
          title="Clear all storage (cookies, localStorage, sessionStorage, IndexedDB)"
        >
          <Trash2 size={16} />
        </button>

        {/* URL bar */}
        <form onSubmit={handleUrlSubmit} className="flex-1">
          {(() => {
            const docInfo = getDocumentInfo(url);
            if (docInfo.isFile && docInfo.docType !== 'web') {
              // Show document-style URL bar
              return (
                <div className="w-full px-3 py-1 bg-claude-bg border border-claude-border rounded text-sm flex items-center gap-2">
                  <DocumentIcon docType={docInfo.docType} className="w-4 h-4 text-claude-text-secondary flex-shrink-0" />
                  <span className="truncate text-claude-text" title={url}>
                    {docInfo.displayName}
                  </span>
                  <span className="text-claude-text-secondary text-xs uppercase flex-shrink-0 px-2 py-0.5 bg-claude-surface rounded">
                    {docInfo.docType === 'docx' ? 'Word' : docInfo.docType === 'xlsx' ? 'Excel' : docInfo.docType === 'slides' ? 'Slides' : 'Document'}
                  </span>
                </div>
              );
            }
            // Regular URL input
            return (
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                className="w-full px-3 py-1 bg-claude-bg border border-claude-border rounded text-sm focus:outline-none focus:border-claude-accent font-mono"
              />
            );
          })()}
        </form>

        {/* Actions */}
        <button
          onClick={() => setInspectorActive(!isInspectorActive)}
          className={`p-1.5 rounded transition-colors ${
            isInspectorActive
              ? 'text-white'
              : 'hover:bg-claude-bg'
          }`}
          style={isInspectorActive ? { backgroundColor: '#5D5FEF' } : undefined}
          title="Select element"
        >
          <Target size={16} />
        </button>
        <button
          onClick={async () => {
            const webview = webviewRef.current;
            if (!webview) return;
            try {
              const image = await webview.capturePage();
              const dataUrl = image.toDataURL();
              const base64 = dataUrl.split(',')[1] || '';
              // Dispatch to InputArea as an image attachment
              window.dispatchEvent(new CustomEvent('grep-insert-chat', {
                detail: {
                  sessionId: session.id,
                  screenshot: base64,
                  content: '',
                },
              }));
              logBrowserPreview('[BrowserPreview] Screenshot captured and attached to input');
            } catch (err) {
              console.error('[BrowserPreview] Screenshot capture failed:', err);
            }
          }}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors"
          title="Screenshot viewport and attach to input"
        >
          <Camera size={16} />
        </button>
        <button
          onClick={() => webviewRef.current?.openDevTools()}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors"
          title="Open DevTools"
        >
          <Code size={16} />
        </button>
        <button
          onClick={() => window.electronAPI.app.openExternal(url)}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors"
          title="Open in browser"
        >
          <ExternalLink size={16} />
        </button>
        <button
          onClick={() => window.electronAPI.app.openBrowserWindow()}
          className="p-1.5 rounded hover:bg-claude-bg transition-colors"
          title="Pop out to separate window"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="15" height="14" rx="2" />
            <rect x="7" y="3" width="15" height="14" rx="2" />
          </svg>
        </button>
      </div>

      {/* Inspector mode banner */}
      {isInspectorActive && (
        <div className="h-8 flex items-center justify-center gap-2 text-white text-sm" style={{ backgroundColor: '#5D5FEF' }}>
          <Target size={14} />
          <span>Click to select · Hold Shift + drag to select region</span>
          <button
            onClick={cancelInspector}
            className="ml-2 p-0.5 rounded hover:opacity-80"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Webview / Stagehand Screenshot */}
      <div
        ref={containerRef}
        className={`flex-1 relative transition-all duration-300 ${
          isAutomationActive
            ? 'ring-2 ring-opacity-75 shadow-[0_0_20px_rgba(93,95,239,0.4)]'
            : ''
        }`}
        style={isAutomationActive ? { '--tw-ring-color': '#5D5FEF' } as React.CSSProperties : undefined}
      >
        {/* Live webview — always visible. Stagehand controls this same webview via CDP,
            so the user sees automation happening in real time. */}
        {/* eslint-disable-next-line */}
        <div
          className="absolute inset-0 w-full h-full"
          onClick={() => webviewRef.current?.focus()}
        >
          <webview
            key={session.id}
            ref={webviewRef}
            src={initialUrl.current}
            className="w-full h-full"
            partition={`persist:browser-${session.id}`}
            webpreferences="contextIsolation=no"
          />
        </div>

        {/* Inspector drag overlay — only active when Shift held or dragging */}
        {isInspectorActive && (shiftHeld || isDragging) && (
          <div
            ref={regionOverlayRef}
            className="absolute inset-0 z-40 cursor-crosshair"
            style={{ backgroundColor: isDragging ? 'rgba(0,0,0,0.1)' : 'transparent' }}
            onMouseDown={(e) => {
              const rect = regionOverlayRef.current?.getBoundingClientRect();
              if (!rect) return;
              setRegionStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              setRegionEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              setIsDragging(true);
            }}
            onMouseMove={(e) => {
              if (!isDragging || !regionOverlayRef.current) return;
              const rect = regionOverlayRef.current.getBoundingClientRect();
              setRegionEnd({
                x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
                y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
              });
            }}
            onMouseUp={async (e) => {
              if (!isDragging || !regionStart || !regionEnd) {
                setIsDragging(false);
                return;
              }
              setIsDragging(false);

              const x1 = Math.min(regionStart.x, regionEnd.x);
              const y1 = Math.min(regionStart.y, regionEnd.y);
              const x2 = Math.max(regionStart.x, regionEnd.x);
              const y2 = Math.max(regionStart.y, regionEnd.y);
              const width = x2 - x1;
              const height = y2 - y1;

              // Small selection = click — forward to the webview for inspector element selection
              if (width < 15 && height < 15) {
                setRegionStart(null);
                setRegionEnd(null);
                const webview = webviewRef.current;
                if (webview) {
                  const clickX = Math.round(regionStart.x);
                  const clickY = Math.round(regionStart.y);
                  // Use Electron's sendInputEvent to simulate a real click inside the webview
                  try {
                    webview.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    webview.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                  } catch (err) {
                    console.warn('[BrowserPreview] Failed to forward click to webview:', err);
                  }
                }
                return;
              }

              const webview = webviewRef.current;
              if (!webview) return;

              try {
                // 1. Capture screenshot of the region
                const image = await webview.capturePage({
                  x: Math.round(x1),
                  y: Math.round(y1),
                  width: Math.round(width),
                  height: Math.round(height),
                } as Electron.Rectangle);
                const screenshotBase64 = image.toDataURL().split(',')[1] || '';

                // 2. Find elements and React components in the region
                const elementsScript = `
                  (function() {
                    const x1 = ${Math.round(x1)}, y1 = ${Math.round(y1)};
                    const x2 = ${Math.round(x2)}, y2 = ${Math.round(y2)};
                    const results = [];
                    const seen = new Set();

                    // Sample points in a grid across the region
                    const stepX = Math.max(10, (x2 - x1) / 10);
                    const stepY = Math.max(10, (y2 - y1) / 10);

                    for (let x = x1; x <= x2; x += stepX) {
                      for (let y = y1; y <= y2; y += stepY) {
                        const els = document.elementsFromPoint(x, y);
                        for (const el of els) {
                          if (seen.has(el) || el === document.body || el === document.documentElement) continue;
                          const rect = el.getBoundingClientRect();
                          // Element must overlap the selection region
                          if (rect.right < x1 || rect.left > x2 || rect.bottom < y1 || rect.top > y2) continue;
                          seen.add(el);

                          // Get React component name
                          let reactComponent = null;
                          const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                          if (fiberKey) {
                            let fiber = el[fiberKey];
                            for (let i = 0; i < 10 && fiber; i++) {
                              if (typeof fiber.type === 'function' || typeof fiber.type === 'object') {
                                const name = fiber.type?.displayName || fiber.type?.name;
                                if (name && !name.startsWith('_') && name.length > 1) {
                                  reactComponent = name;
                                  break;
                                }
                              }
                              fiber = fiber.return;
                            }
                          }

                          // Get computed styles (key properties only)
                          const style = window.getComputedStyle(el);
                          const styles = {
                            display: style.display,
                            position: style.position,
                            fontSize: style.fontSize,
                            color: style.color,
                            backgroundColor: style.backgroundColor,
                          };

                          results.push({
                            tagName: el.tagName.toLowerCase(),
                            id: el.id || undefined,
                            className: el.className?.toString()?.slice(0, 200) || undefined,
                            reactComponent,
                            textContent: el.textContent?.slice(0, 150) || undefined,
                            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                            styles,
                          });
                        }
                      }
                    }

                    // Sort by area (largest first) and limit
                    results.sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
                    return JSON.stringify(results.slice(0, 30));
                  })()
                `;

                const elementsJson = await webview.executeJavaScript(elementsScript);
                const elements = JSON.parse(elementsJson || '[]');

                // 3. Build structured context
                const reactComponents = elements.filter((e: { reactComponent?: string }) => e.reactComponent).map((e: { reactComponent: string }) => e.reactComponent);
                const uniqueComponents = [...new Set(reactComponents)];

                // Build markdown summary
                const mdLines = [
                  '## Region Selection',
                  '',
                  '**Region:** x=' + Math.round(x1) + ', y=' + Math.round(y1) + ', ' + Math.round(width) + '×' + Math.round(height) + 'px',
                  '**Page:** ' + url,
                ];
                if (uniqueComponents.length > 0) {
                  mdLines.push('**React Components:** ' + uniqueComponents.join(', '));
                }
                mdLines.push('**Elements found:** ' + elements.length, '');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                elements.slice(0, 15).forEach((el: any) => {
                  const name = el.reactComponent ? '<' + el.reactComponent + '>' : '<' + el.tagName + '>';
                  const idStr = el.id ? ' #' + el.id : '';
                  const textStr = el.textContent ? ' "' + el.textContent.slice(0, 60) + '"' : '';
                  mdLines.push('- ' + name + idStr + textStr);
                });
                mdLines.push('', '---');
                const markdown = mdLines.join('\n');

                // 4. Dispatch to chat input as attachment chip (like regular inspector)
                window.dispatchEvent(new CustomEvent('grep-insert-chat', {
                  detail: {
                    sessionId: session.id,
                    content: '', // No visible text — context is in attachments
                    screenshot: screenshotBase64,
                    elementContext: {
                      selector: 'region(' + Math.round(x1) + ',' + Math.round(y1) + ',' + Math.round(width) + 'x' + Math.round(height) + ')',
                      outerHTML: markdown,
                      tagName: 'region',
                      reactComponent: uniqueComponents.length > 0 ? uniqueComponents[0] : undefined,
                    },
                  },
                }));

                logBrowserPreview('[BrowserPreview] Region captured:', { width: Math.round(width), height: Math.round(height), elements: elements.length, reactComponents: uniqueComponents });
              } catch (err) {
                console.error('[BrowserPreview] Region capture failed:', err);
              }

              // Reset region (stay in inspector mode)
              setRegionStart(null);
              setRegionEnd(null);
            }}
          >
            {/* Selection rectangle */}
            {isDragging && regionStart && regionEnd && (
              <div
                className="absolute border-2 border-teal-400 pointer-events-none"
                style={{
                  left: Math.min(regionStart.x, regionEnd.x),
                  top: Math.min(regionStart.y, regionEnd.y),
                  width: Math.abs(regionEnd.x - regionStart.x),
                  height: Math.abs(regionEnd.y - regionStart.y),
                  backgroundColor: 'rgba(13, 148, 136, 0.15)',
                }}
              />
            )}
          </div>
        )}

        {/* Automation indicator overlay */}
        {isAutomationActive && (
          <div className="absolute top-2 right-2 z-50 flex items-center gap-2 text-white px-3 py-1.5 rounded-full text-xs font-medium shadow-lg animate-pulse" style={{ backgroundColor: 'rgba(93,95,239,0.9)' }}>
            <Bot size={14} className="animate-bounce" />
            <span>
              {automationIndicator?.type === 'click' && `Clicking: ${automationIndicator.selector}`}
              {automationIndicator?.type === 'type' && `Typing: "${automationIndicator.text}..."`}
              {automationIndicator?.type === 'navigate' && 'Navigating...'}
              {automationIndicator?.type === 'snapshot' && 'Taking snapshot...'}
              {!automationIndicator && 'Automating...'}
            </span>
          </div>
        )}

        {/* Click ripple effects */}
        {clickRipples.map(ripple => (
          <div
            key={ripple.id}
            className="absolute pointer-events-none z-40"
            style={{
              left: ripple.x - 20,
              top: ripple.y - 20,
            }}
          >
            {/* Outer expanding ring */}
            <div
              className="w-10 h-10 rounded-full border-2 animate-ping"
              style={{ borderColor: '#5D5FEF', animationDuration: '0.6s' }}
            />
            {/* Inner solid dot */}
            <div
              className="absolute inset-0 flex items-center justify-center"
            >
              <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: '#5D5FEF' }} />
            </div>
          </div>
        ))}

        {/* Text editing loading overlay */}
        {sessionEditingText[session.id] && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-40 pointer-events-none">
            <div className="bg-claude-sidebar rounded-lg p-6 shadow-xl border border-claude-border">
              <div className="flex items-center gap-3">
                <div className="text-2xl animate-spin">⟳</div>
                <div className="text-claude-text">
                  <div className="font-medium">Editing file...</div>
                  <div className="text-sm text-claude-text-secondary">
                    Claude is updating the source code
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Automation mode footer indicator */}
      {isAutomationActive && (
        <div className="h-6 flex items-center justify-center gap-2 text-white text-xs" style={{ backgroundColor: '#5D5FEF' }}>
          <Bot size={12} />
          <span>Browser automation in progress</span>
          <div className="flex gap-1 ml-2">
            <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}

    </div>
  );
}
