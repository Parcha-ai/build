import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useEditorStore } from '../../stores/editor.store';
import ChatContainer from '../chat/ChatContainer';
import ForkTabs from '../chat/ForkTabs';
import TerminalContainer from '../terminal/TerminalContainer';
import BrowserPreview from '../preview/BrowserPreview';
import GitExplorer from '../git/GitExplorer';
import EditorPanel from '../editor/EditorPanel';
import ExtensionsExplorer from '../extensions/ExtensionsExplorer';
import PlanPanel from '../plan/PlanPanel';
import SetupProgress from '../session/SetupProgress';
import CommandCenterGrid from '../command-center/CommandCenterGrid';
import EmptyState from './EmptyState';
import { X, GripVertical, GripHorizontal, Smartphone, Monitor } from 'lucide-react';

const PRIMARY_MODIFIER_KEY: 'metaKey' | 'ctrlKey' = /mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';

export default function MainContent() {
  const { activeSessionId, sessions, setupProgress, commandCenterSessionIds } = useSessionStore();
  const {
    isTerminalPanelOpen,
    isBrowserPanelOpen,
    isGitPanelOpen,
    isExtensionsPanelOpen,
    isPlanPanelOpen,
    terminalHeight,
    toggleBrowserPanel,
    toggleGitPanel,
    toggleExtensionsPanel,
    togglePlanPanel,
    setTerminalHeight,
    splitRatio,
    viewportMode,
    toggleViewportMode,
    mobileBrowserHeight,
    setMobileBrowserHeight,
    // Multi-session browser support
    sessionBrowsersEnabled,
    enableSessionBrowser,
    disableSessionBrowser,
    // Command Center
    isCommandCenterActive,
    commandCenterFocusedSessionId,
    setCommandCenterFocusedSession,
  } = useUIStore();
  const { isEditorOpen, closeEditor } = useEditorStore();
  const [isTerminalResizing, setIsTerminalResizing] = useState(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [isMobileBrowserResizing, setIsMobileBrowserResizing] = useState(false);
  const [customSplitRatio, setCustomSplitRatio] = useState<number | null>(null);

  // Set default terminal height when panel opens
  useEffect(() => {
    if (isTerminalPanelOpen && terminalHeight === 0) {
      setTerminalHeight(250);
    }
  }, [isTerminalPanelOpen, terminalHeight, setTerminalHeight]);

  // Intercept Cmd+R to ALWAYS prevent app reload, and refresh browser if panel is open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e[PRIMARY_MODIFIER_KEY] && e.key === 'r') {
        // Always prevent Electron's default app reload
        e.preventDefault();
        e.stopPropagation();

        // If browser panel is open, refresh the browser instead
        if (isBrowserPanelOpen && activeSessionId) {
          // Dispatch custom event for BrowserPreview to handle (use root session ID)
          const rootId = sessions.find(s => s.id === activeSessionId)?.parentSessionId || activeSessionId;
          window.dispatchEvent(new CustomEvent('grep-browser-refresh', {
            detail: { sessionId: rootId }
          }));
        }
        // Otherwise, just do nothing (CMD+R is disabled)
      }
    };

    // Use capture phase to intercept before Electron's default handler
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isBrowserPanelOpen, activeSessionId]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSetupProgress = activeSessionId ? setupProgress[activeSessionId] : null;
  const isSessionSetup = activeSession?.status === 'setup' || activeSetupProgress?.status === 'running';

  // Helper: get root session ID (walk up parentSessionId chain)
  const getRootSessionId = useCallback((sessionId: string): string => {
    let rootId = sessionId;
    let session = sessions.find(s => s.id === rootId);
    while (session?.parentSessionId) {
      rootId = session.parentSessionId;
      session = sessions.find(s => s.id === rootId);
    }
    return rootId;
  }, [sessions]);

  // When Command Center is deactivated, restore activeSessionId from the last focused cell
  const { setActiveSession } = useSessionStore();
  const prevCommandCenterActive = React.useRef(isCommandCenterActive);
  useEffect(() => {
    if (prevCommandCenterActive.current && !isCommandCenterActive && commandCenterFocusedSessionId) {
      setActiveSession(commandCenterFocusedSessionId);
    }
    prevCommandCenterActive.current = isCommandCenterActive;
  }, [isCommandCenterActive, commandCenterFocusedSessionId, setActiveSession]);

  // In Command Center mode, browser opens as a separate Electron window
  useEffect(() => {
    if (isCommandCenterActive && isBrowserPanelOpen) {
      window.electronAPI?.app.openBrowserWindow();
    }
  }, [isCommandCenterActive, isBrowserPanelOpen]);

  // Listen for browser window being closed externally
  useEffect(() => {
    if (!window.electronAPI?.app.onBrowserWindowClosed) return;
    const unsubscribe = window.electronAPI.app.onBrowserWindowClosed(() => {
      // Don't close the browser panel state — just let the window close
      // User can reopen with the browser button
    });
    return unsubscribe;
  }, []);

  // When Command Center is active and browser panel is open, auto-enable browsers for ALL command center sessions
  useEffect(() => {
    if (isCommandCenterActive && isBrowserPanelOpen) {
      for (const id of commandCenterSessionIds) {
        const rootId = getRootSessionId(id);
        if (!sessionBrowsersEnabled[rootId]) {
          enableSessionBrowser(rootId);
        }
      }
    }
  }, [isCommandCenterActive, isBrowserPanelOpen, commandCenterSessionIds, getRootSessionId, sessionBrowsersEnabled, enableSessionBrowser]);

  // Auto-enable browser for active session's ROOT when browser panel is opened
  useEffect(() => {
    if (isBrowserPanelOpen && activeSessionId) {
      const rootId = getRootSessionId(activeSessionId);
      if (!sessionBrowsersEnabled[rootId]) {
        enableSessionBrowser(rootId);
      }
    }
  }, [isBrowserPanelOpen, activeSessionId, sessionBrowsersEnabled, enableSessionBrowser, getRootSessionId]);

  // Get unique root sessions that have browsers enabled (one BrowserPreview per root, shared across forks)
  const sessionsWithBrowsers = useMemo(() => {
    const enabledRootIds = new Set<string>();
    const result: typeof sessions = [];
    for (const s of sessions) {
      if (sessionBrowsersEnabled[s.id]) {
        // Already a root or has no parent — add directly
        const rootId = s.parentSessionId
          ? (sessions.find(p => p.id === s.parentSessionId)?.id || s.id)
          : s.id;
        if (!enabledRootIds.has(rootId)) {
          enabledRootIds.add(rootId);
          const rootSession = sessions.find(p => p.id === rootId) || s;
          result.push(rootSession);
        }
      }
    }
    return result;
  }, [sessions, sessionBrowsersEnabled]);

  // Calculate flex basis percentages based on split ratio
  const getFlexBasis = () => {
    // Use custom ratio if set (from dragging)
    if (customSplitRatio !== null) {
      return { main: `${customSplitRatio}%`, side: `${100 - customSplitRatio}%` };
    }

    switch (splitRatio) {
      case 'main-focus':
        return { main: '66.67%', side: '33.33%' };
      case 'side-focus':
        return { main: '33.33%', side: '66.67%' };
      case 'equal':
      default:
        return { main: '50%', side: '50%' };
    }
  };

  const flexBasis = getFlexBasis();

  // Get the icon for viewport mode
  const getViewportIcon = () => {
    return viewportMode === 'mobile' ? <Smartphone size={14} /> : <Monitor size={14} />;
  };

  // Get tooltip text for viewport mode
  const getViewportTooltip = () => {
    return viewportMode === 'mobile' ? 'Mobile view (375px) - Click for Desktop' : 'Desktop view - Click for Mobile';
  };

  // Handle panel horizontal resize
  const handlePanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsPanelResizing(true);

    const container = e.currentTarget.parentElement as HTMLElement;

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // Create an overlay to capture mouse events (prevents iframes from stealing them)
    const overlay = document.createElement('div');
    overlay.id = 'panel-resize-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize';
    document.getElementById('panel-resize-overlay')?.remove();
    document.body.appendChild(overlay);

    const handleMouseMove = (e: MouseEvent) => {
      const containerRect = container.getBoundingClientRect();
      const mouseX = e.clientX - containerRect.left;
      const ratio = (mouseX / containerRect.width) * 100;
      const newRatio = Math.max(20, Math.min(80, ratio));
      setCustomSplitRatio(newRatio);
    };

    const handleMouseUp = () => {
      setIsPanelResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      overlay.remove();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Handle terminal vertical resize
  const handleTerminalResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsTerminalResizing(true);

    const startY = e.clientY;
    const startHeight = terminalHeight;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY; // Inverted delta for vertical movement (up = increase height)
      const newHeight = Math.max(150, Math.min(600, startHeight + delta));
      setTerminalHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsTerminalResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [terminalHeight, setTerminalHeight]);

  // Handle mobile browser vertical resize
  const handleMobileBrowserResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMobileBrowserResizing(true);

    const startY = e.clientY;
    const startHeight = mobileBrowserHeight;

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';

    // Create an overlay to capture mouse events
    const overlay = document.createElement('div');
    overlay.id = 'mobile-browser-resize-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:row-resize';
    document.getElementById('mobile-browser-resize-overlay')?.remove();
    document.body.appendChild(overlay);

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startY; // Down = increase height
      const newHeight = startHeight + delta;
      setMobileBrowserHeight(newHeight); // Clamping is done in the store
    };

    const handleMouseUp = () => {
      setIsMobileBrowserResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      overlay.remove();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [mobileBrowserHeight, setMobileBrowserHeight]);

  if (!activeSession) {
    return <EmptyState />;
  }

  // In Command Center mode, browser is a floating overlay — it doesn't consume side panel space
  const hasSidePanel = isCommandCenterActive
    ? (isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen)
    : (isBrowserPanelOpen || isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Main panel area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Primary content - chat or setup progress */}
        {/* In mobile browser mode, use flex-grow to take remaining space */}
        <div
          className="flex flex-col overflow-hidden min-w-0 transition-all duration-200"
          style={{
            flexBasis: hasSidePanel ? flexBasis.main : '100%',
            flexShrink: 1,
            flexGrow: 1,
          }}
        >
          {isCommandCenterActive ? (
            <CommandCenterGrid />
          ) : isSessionSetup ? (
            <SetupProgress session={activeSession} progress={activeSetupProgress} />
          ) : (
            <>
              <ForkTabs sessionId={activeSession.id} />
              <ChatContainer session={activeSession} />
            </>
          )}
        </div>

        {/* Resizable side panel */}
        {hasSidePanel && (
          <>
            {/* Resize handle with split toggle button */}
            <div
              className={`w-1 flex flex-col items-center bg-claude-border hover:w-4 transition-all group cursor-col-resize ${
                isPanelResizing ? 'w-4 bg-claude-accent' : ''
              }`}
              onMouseDown={handlePanelResizeMouseDown}
            >
              {/* Viewport toggle button - appears on hover */}
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomSplitRatio(null); // Reset any custom drag ratio
                  toggleViewportMode();
                }}
                className="p-0.5 my-1 rounded hover:bg-claude-surface-hover text-claude-text-secondary hover:text-claude-accent transition-colors opacity-0 group-hover:opacity-100"
                title={getViewportTooltip()}
              >
                {getViewportIcon()}
              </button>

              {/* Drag handle visual */}
              <div className="flex-1 flex items-center justify-center opacity-0 group-hover:opacity-100">
                <GripVertical size={8} className="text-claude-text-secondary" />
              </div>
            </div>

            {/* Side panel container - horizontal layout for browser + extensions */}
            {/* In mobile mode with only browser panel, use fixed width for mobile device frame */}
            <div
              className="flex overflow-hidden bg-claude-surface transition-all duration-200"
              style={{
                flexBasis: (viewportMode === 'mobile' && isBrowserPanelOpen && !isGitPanelOpen && !isEditorOpen && !isExtensionsPanelOpen && !isPlanPanelOpen)
                  ? '420px'  // 375px device + padding + border
                  : flexBasis.side,
                flexShrink: 0,
                flexGrow: 0,
              }}
            >
              {/* Left side of side panel: Browser, Git, Editor (stacked vertically) */}
              <div className={`flex flex-col overflow-hidden ${isExtensionsPanelOpen && isBrowserPanelOpen ? 'flex-1' : 'w-full h-full'}`}>
                {/* Browser panel - renders multiple BrowserPreview instances for multi-session support */}
                {isBrowserPanelOpen && (
                  <div className={`flex flex-col overflow-hidden ${isGitPanelOpen || isEditorOpen ? 'flex-1' : 'h-full'}`}>
                    <div className="h-10 flex items-center justify-between border-b border-claude-border bg-claude-surface">
                      {/* Command Center mode: session tabs */}
                      {isCommandCenterActive && sessionsWithBrowsers.length > 1 ? (
                        <div className="flex-1 flex items-center overflow-x-auto">
                          {sessionsWithBrowsers.map(session => {
                            const isFocused = commandCenterFocusedSessionId
                              ? getRootSessionId(commandCenterFocusedSessionId) === session.id
                              : false;
                            return (
                              <button
                                key={session.id}
                                onClick={() => setCommandCenterFocusedSession(session.id)}
                                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono border-r border-claude-border transition-colors whitespace-nowrap ${
                                  isFocused
                                    ? 'bg-claude-bg text-claude-text'
                                    : 'bg-claude-surface text-claude-text-secondary hover:bg-claude-bg/50'
                                }`}
                              >
                                <div
                                  className={`w-1.5 h-1.5 flex-shrink-0 ${session.status === 'running' ? 'bg-green-500' : 'bg-gray-500'}`}
                                  style={{ borderRadius: 0 }}
                                />
                                <span className="truncate max-w-[120px]">
                                  {session.forkName || session.name}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-3">
                          <span className="text-sm font-medium">Browser Preview</span>
                          {viewportMode === 'mobile' && (
                            <span className="text-xs text-purple-400 font-medium">
                              375 × {mobileBrowserHeight}
                            </span>
                          )}
                          {sessionsWithBrowsers.length > 1 && (
                            <span className="text-xs text-claude-text-secondary">
                              ({sessionsWithBrowsers.length} browsers)
                            </span>
                          )}
                        </div>
                      )}
                      <button
                        onClick={toggleBrowserPanel}
                        className="p-1 mx-2 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text flex-shrink-0"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {/* Browser content area - centred mobile viewport when in mobile mode */}
                    <div className={`flex-1 overflow-hidden relative ${viewportMode === 'mobile' ? 'bg-gray-900 flex flex-col items-center pt-4' : ''}`}>
                      {/* Mobile device frame when in mobile mode, full size in desktop mode */}
                      <div
                        className={`${viewportMode === 'mobile' ? 'relative rounded-xl overflow-hidden shadow-2xl border-4 border-gray-700' : 'absolute inset-0'}`}
                        style={viewportMode === 'mobile' ? { width: 375, height: mobileBrowserHeight } : undefined}
                      >
                        {/* Render a BrowserPreview for each session with browser enabled */}
                        {/* Only the active session's browser is visible, others stay mounted but hidden */}
                        {sessionsWithBrowsers.map(session => {
                          // In Command Center mode, browser follows the focused cell
                          const effectiveSessionId = isCommandCenterActive
                            ? commandCenterFocusedSessionId
                            : activeSessionId;
                          const activeRootId = effectiveSessionId ? getRootSessionId(effectiveSessionId) : null;
                          const isActive = session.id === activeRootId;
                          return (
                            <div
                              key={session.id}
                              className="absolute inset-0"
                              style={{ display: isActive ? 'block' : 'none' }}
                            >
                              <BrowserPreview
                                session={session}
                                isVisible={isActive}
                              />
                            </div>
                          );
                        })}
                        {/* Fallback for active session if its root isn't in sessionsWithBrowsers yet */}
                        {activeSession && (() => {
                          const rootId = getRootSessionId(activeSession.id);
                          return !sessionBrowsersEnabled[rootId] ? (
                            <BrowserPreview session={sessions.find(s => s.id === rootId) || activeSession} isVisible={true} />
                          ) : null;
                        })()}
                      </div>
                      {/* Vertical resize handle for mobile browser - only in mobile mode */}
                      {viewportMode === 'mobile' && (
                        <div
                          className={`w-[375px] h-3 mt-1 flex items-center justify-center cursor-row-resize rounded-b-lg hover:bg-gray-700 transition-colors ${
                            isMobileBrowserResizing ? 'bg-claude-accent' : 'bg-gray-800'
                          }`}
                          onMouseDown={handleMobileBrowserResizeMouseDown}
                          title="Drag to resize mobile browser height"
                        >
                          <GripHorizontal size={12} className="text-gray-500" />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Horizontal divider when both panels open */}
                {isBrowserPanelOpen && isGitPanelOpen && (
                  <div className="h-px bg-claude-border" />
                )}

                {/* Git panel */}
                {isGitPanelOpen && (
                  <div className={`flex flex-col overflow-hidden ${isBrowserPanelOpen ? 'h-[300px]' : isEditorOpen ? 'h-[200px]' : 'h-full'}`}>
                    <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
                      <span className="text-sm font-medium">Git Explorer</span>
                      <button
                        onClick={toggleGitPanel}
                        className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <GitExplorer session={activeSession} />
                    </div>
                  </div>
                )}

                {/* Horizontal divider when editor is with other panels */}
                {isEditorOpen && (isBrowserPanelOpen || isGitPanelOpen) && (
                  <div className="h-px bg-claude-border" />
                )}

                {/* Editor panel */}
                {isEditorOpen && (
                  <div className={`flex flex-col overflow-hidden ${(isBrowserPanelOpen || isGitPanelOpen) ? 'flex-1' : 'h-full'}`}>
                    <EditorPanel onClose={closeEditor} />
                  </div>
                )}

                {/* Extensions panel - shown here only when browser is NOT open */}
                {isExtensionsPanelOpen && !isBrowserPanelOpen && (
                  <>
                    {(isGitPanelOpen || isEditorOpen) && (
                      <div className="h-px bg-claude-border" />
                    )}
                    <div className={`flex flex-col overflow-hidden ${(isGitPanelOpen || isEditorOpen) ? 'flex-1' : 'h-full'}`}>
                      <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
                        <span className="text-sm font-medium">Extensions</span>
                        <button
                          onClick={toggleExtensionsPanel}
                          className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <ExtensionsExplorer sessionId={activeSession.id} projectPath={activeSession.worktreePath} />
                      </div>
                    </div>
                  </>
                )}

                {/* Plan panel - shown when plan mode creates a plan */}
                {isPlanPanelOpen && !isBrowserPanelOpen && (
                  <>
                    {(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen) && (
                      <div className="h-px bg-claude-border" />
                    )}
                    <div className={`flex flex-col overflow-hidden ${(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen) ? 'flex-1' : 'h-full'}`}>
                      <PlanPanel />
                    </div>
                  </>
                )}
              </div>

              {/* Vertical divider between browser and extensions */}
              {isExtensionsPanelOpen && isBrowserPanelOpen && (
                <div className="w-px bg-claude-border" />
              )}

              {/* Extensions panel - right side pane when browser is open */}
              {isExtensionsPanelOpen && isBrowserPanelOpen && (
                <div className="w-[300px] flex flex-col overflow-hidden border-l border-claude-border">
                  <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
                    <span className="text-sm font-medium">Extensions</span>
                    <button
                      onClick={toggleExtensionsPanel}
                      className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <ExtensionsExplorer sessionId={activeSession.id} projectPath={activeSession.worktreePath} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* In Command Center mode, browser opens as a separate window — no inline overlay */}

      {/* Terminal panel (visible at bottom when toggled on) */}
      {isTerminalPanelOpen && (
        <>
          {/* Terminal resize handle */}
          <div
            className={`h-1 hover:h-1.5 bg-claude-border hover:bg-claude-accent cursor-row-resize flex items-center justify-center transition-all ${
              isTerminalResizing ? 'h-1.5 bg-claude-accent' : ''
            }`}
            onMouseDown={handleTerminalResizeMouseDown}
          >
            <GripVertical size={12} className="text-claude-text-secondary opacity-0 hover:opacity-100 rotate-90" />
          </div>

          {/* Terminal container with dynamic height */}
          <div
            className="border-t border-claude-border"
            style={{ height: terminalHeight || 250 }}
          >
            <TerminalContainer session={activeSession} compact />
          </div>
        </>
      )}
    </div>
  );
}
