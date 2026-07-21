import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useEditorStore } from '../../stores/editor.store';
import ChatContainer from '../chat/ChatContainer';
import ForkTabs, { SESSION_TAB_DRAG_TYPE } from '../chat/ForkTabs';
import TerminalContainer from '../terminal/TerminalContainer';
import BrowserPreview from '../preview/BrowserPreview';
import BrowserSessionTab from '../preview/BrowserSessionTab';
import BrowserPreviewBoundary from '../preview/BrowserPreviewBoundary';
import HtmlArtifactPanel from '../preview/HtmlArtifactPanel';
import MarkdownResponsePanel from '../preview/MarkdownResponsePanel';
import GitExplorer from '../git/GitExplorer';
import EditorPanel from '../editor/EditorPanel';
import ExtensionsExplorer from '../extensions/ExtensionsExplorer';
import PlanPanel from '../plan/PlanPanel';
import DesignPanel from '../design/DesignPanel';
import SetupProgress from '../session/SetupProgress';
import CommandCenterGrid from '../command-center/CommandCenterGrid';
import AgentView from '../agent-view/AgentView';
import EmptyState from './EmptyState';
import { X, GripVertical, GripHorizontal, Smartphone, Monitor, ArrowLeft, Plus } from 'lucide-react';
import { getSessionDisplayName } from '../../utils/session-display';
import { getBrowserPartitionId } from '../../../shared/utils/browser-partition';

const PRIMARY_MODIFIER_KEY: 'metaKey' | 'ctrlKey' = /mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';

export default function MainContent() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const activeSetupProgress = useSessionStore(useCallback(
    (s) => activeSessionId ? s.setupProgress[activeSessionId] || null : null,
    [activeSessionId],
  ));
  const isTerminalPanelOpen = useUIStore((s) => s.isTerminalPanelOpen);
  const isBrowserPanelOpen = useUIStore((s) => s.isBrowserPanelOpen);
  const isGitPanelOpen = useUIStore((s) => s.isGitPanelOpen);
  const isExtensionsPanelOpen = useUIStore((s) => s.isExtensionsPanelOpen);
  const isPlanPanelOpen = useUIStore((s) => s.isPlanPanelOpen);
  const isHtmlPanelOpen = useUIStore((s) => s.isHtmlPanelOpen);
  const isMarkdownPanelOpen = useUIStore((s) => s.isMarkdownPanelOpen);
  const isDesignPanelOpen = useUIStore((s) => s.isDesignPanelOpen);
  const sessionDesignTakeover = useUIStore((s) => s.sessionDesignTakeover);
  const sessionDesignPanels = useUIStore((s) => s.sessionDesignPanels);
  const setDesignTakeover = useUIStore((s) => s.setDesignTakeover);
  const terminalHeight = useUIStore((s) => s.terminalHeight);
  const toggleBrowserPanel = useUIStore((s) => s.toggleBrowserPanel);
  const toggleGitPanel = useUIStore((s) => s.toggleGitPanel);
  const toggleExtensionsPanel = useUIStore((s) => s.toggleExtensionsPanel);
  const setTerminalHeight = useUIStore((s) => s.setTerminalHeight);
  const splitRatio = useUIStore((s) => s.splitRatio);
  const viewportMode = useUIStore((s) => s.viewportMode);
  const toggleViewportMode = useUIStore((s) => s.toggleViewportMode);
  const mobileBrowserHeight = useUIStore((s) => s.mobileBrowserHeight);
  const setMobileBrowserHeight = useUIStore((s) => s.setMobileBrowserHeight);
  const browserTabs = useUIStore((s) => s.browserTabs);
  const activeBrowserTabIdsByPartition = useUIStore((s) => s.activeBrowserTabIdsByPartition);
  const sessionSplitPaneIds = useUIStore((s) => s.sessionSplitPaneIds);
  const setSessionSplitPane = useUIStore((s) => s.setSessionSplitPane);
  const createBrowserTab = useUIStore((s) => s.createBrowserTab);
  const setActiveBrowserTab = useUIStore((s) => s.setActiveBrowserTab);
  const updateBrowserTabUrl = useUIStore((s) => s.updateBrowserTabUrl);
  const isCommandCenterActive = useUIStore((s) => s.isCommandCenterActive);
  const commandCenterFocusedSessionId = useUIStore((s) => s.commandCenterFocusedSessionId);
  const setCommandCenterFocusedSession = useUIStore((s) => s.setCommandCenterFocusedSession);
  const isAgentViewActive = useUIStore((s) => s.isAgentViewActive);
  const agentViewSelectedSessionId = useUIStore((s) => s.agentViewSelectedSessionId);
  const isEditorOpen = useEditorStore((s) => s.isEditorOpen);
  const closeEditor = useEditorStore((s) => s.closeEditor);
  const [isTerminalResizing, setIsTerminalResizing] = useState(false);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [isMobileBrowserResizing, setIsMobileBrowserResizing] = useState(false);
  const [customSplitRatio, setCustomSplitRatio] = useState<number | null>(null);
  const [isSessionSplitDropActive, setIsSessionSplitDropActive] = useState(false);
  const chatSplitAreaRef = React.useRef<HTMLDivElement>(null);
  const previousPrimarySessionIdRef = React.useRef<string | null>(null);

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

        const sessionState = useSessionStore.getState();
        const uiState = useUIStore.getState();
        const selectedSession = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId);
        const partitionId = selectedSession
          ? getBrowserPartitionId(selectedSession.id, sessionState.sessions)
          : null;
        const activeBrowserTab = partitionId
          ? uiState.browserTabs.find((tab) => tab.id === uiState.activeBrowserTabIdsByPartition[partitionId])
          : null;
        if (isBrowserPanelOpen && activeBrowserTab) {
          window.dispatchEvent(new CustomEvent('grep-browser-refresh', {
            detail: { sessionId: activeBrowserTab.ownerSessionId, browserTabId: activeBrowserTab.id }
          }));
        }
        // Otherwise, just do nothing (CMD+R is disabled)
      }
    };

    // Use capture phase to intercept before Electron's default handler
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isBrowserPanelOpen]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const chatTargetSessionId = isCommandCenterActive
    ? commandCenterFocusedSessionId
    : isAgentViewActive
      ? agentViewSelectedSessionId
      : activeSessionId;
  const chatTargetSession = chatTargetSessionId
    ? sessions.find((s) => s.id === chatTargetSessionId) || null
    : null;
  const artifactTargetSessionId = chatTargetSessionId;
  const isSessionSetup = activeSession?.status === 'setup' || activeSetupProgress?.status === 'running';

  // When Command Center is deactivated, restore activeSessionId from the last focused cell
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

  const mountedBrowserTabs = useMemo(() => browserTabs.filter((tab) => (
    sessions.some((session) => session.id === tab.ownerSessionId)
  )), [browserTabs, sessions]);
  const activeBrowserPartitionId = useMemo(() => (
    chatTargetSession ? getBrowserPartitionId(chatTargetSession.id, sessions) : null
  ), [chatTargetSession, sessions]);
  const browserTabsForPartition = useMemo(() => mountedBrowserTabs.filter((tab) => (
    tab.partitionId === activeBrowserPartitionId
  )), [activeBrowserPartitionId, mountedBrowserTabs]);
  const activeBrowserTabId = activeBrowserPartitionId
    ? activeBrowserTabIdsByPartition[activeBrowserPartitionId] || null
    : null;
  const activeBrowserTab = browserTabsForPartition.find((tab) => tab.id === activeBrowserTabId)
    || browserTabsForPartition[0]
    || null;
  const activeBrowserOwnerSession = activeBrowserTab
    ? sessions.find((session) => session.id === activeBrowserTab.ownerSessionId) || null
    : null;

  const createTabForSession = useCallback((session = chatTargetSession) => {
    if (!session) return null;
    const partitionId = getBrowserPartitionId(session.id, sessions);
    const url = session.lastBrowserUrl || `http://localhost:${session.ports?.web || 3000}`;
    return createBrowserTab(session.id, partitionId, url);
  }, [chatTargetSession, createBrowserTab, sessions]);

  // Each root Build session/fork family owns an independent browser tab group.
  // Switching chat tabs inside the family keeps the same group, while switching
  // a left-sidebar Build session restores that group's selected browser tab.
  useEffect(() => {
    if (!isBrowserPanelOpen) return;
    if (browserTabsForPartition.length === 0) createTabForSession();
    else if (!activeBrowserTabId || !browserTabsForPartition.some((tab) => tab.id === activeBrowserTabId)) {
      setActiveBrowserTab(browserTabsForPartition[0].id);
    }
  }, [activeBrowserTabId, browserTabsForPartition, createTabForSession, isBrowserPanelOpen, setActiveBrowserTab]);

  const activeSessionGroupId = activeSession
    ? getBrowserPartitionId(activeSession.id, sessions)
    : null;
  const configuredSplitSessionId = activeSessionGroupId
    ? sessionSplitPaneIds[activeSessionGroupId] || null
    : null;
  const splitSession = configuredSplitSessionId
    ? sessions.find((session) => (
      session.id === configuredSplitSessionId
      && session.id !== activeSession?.id
      && getBrowserPartitionId(session.id, sessions) === activeSessionGroupId
    )) || null
    : null;

  // If the user selects the tab currently shown in the secondary pane, swap
  // the old primary into that pane instead of rendering the same chat twice.
  useEffect(() => {
    if (!activeSession || !activeSessionGroupId) {
      previousPrimarySessionIdRef.current = null;
      return;
    }

    const previousPrimaryId = previousPrimarySessionIdRef.current;
    if (configuredSplitSessionId === activeSession.id) {
      const previousPrimary = sessions.find((session) => session.id === previousPrimaryId);
      if (
        previousPrimary
        && previousPrimary.id !== activeSession.id
        && getBrowserPartitionId(previousPrimary.id, sessions) === activeSessionGroupId
      ) {
        setSessionSplitPane(activeSessionGroupId, previousPrimary.id);
      } else {
        setSessionSplitPane(activeSessionGroupId, null);
      }
    } else if (configuredSplitSessionId && !splitSession) {
      setSessionSplitPane(activeSessionGroupId, null);
    }

    previousPrimarySessionIdRef.current = activeSession.id;
  }, [activeSession, activeSessionGroupId, configuredSplitSessionId, sessions, setSessionSplitPane, splitSession]);

  useEffect(() => {
    const clearSplitDrop = () => setIsSessionSplitDropActive(false);
    window.addEventListener('dragend', clearSplitDrop);
    window.addEventListener('drop', clearSplitDrop);
    return () => {
      window.removeEventListener('dragend', clearSplitDrop);
      window.removeEventListener('drop', clearSplitDrop);
    };
  }, []);

  const handleSessionSplitDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(SESSION_TAB_DRAG_TYPE)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const isRightDropZone = event.clientX >= bounds.left + bounds.width * 0.55;
    if (!isRightDropZone) {
      setIsSessionSplitDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setIsSessionSplitDropActive(true);
  }, []);

  const handleSessionSplitDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!activeSession || !activeSessionGroupId) return;
    const droppedSessionId = event.dataTransfer.getData(SESSION_TAB_DRAG_TYPE);
    const droppedSession = sessions.find((session) => session.id === droppedSessionId);
    if (
      !droppedSession
      || droppedSession.id === activeSession.id
      || getBrowserPartitionId(droppedSession.id, sessions) !== activeSessionGroupId
    ) {
      setIsSessionSplitDropActive(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSessionSplitPane(activeSessionGroupId, droppedSession.id);
    setIsSessionSplitDropActive(false);
  }, [activeSession, activeSessionGroupId, sessions, setSessionSplitPane]);

  const handleSessionSplitDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setIsSessionSplitDropActive(false);
  }, []);

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

  // Design session takeover — the Open Design canvas owns the whole view
  // (one chat: the design session's). The overlay below stays MOUNTED when
  // the user returns to coding (hidden via opacity/size, never display:none
  // or unmount) because the OD webview holds the design run's SSE stream —
  // destroying the webview cancels an in-flight design run.
  const designTakeoverActive = !!sessionDesignTakeover[activeSession.id];
  const activeDesignPanel = sessionDesignPanels[activeSession.id];
  const designOverlay = activeDesignPanel ? (
    <div
      className={`absolute z-30 flex flex-col bg-claude-bg ${
        designTakeoverActive
          ? 'inset-0'
          : 'w-px h-px overflow-hidden opacity-0 pointer-events-none bottom-0 right-0'
      }`}
      aria-hidden={!designTakeoverActive}
    >
      <div className="h-9 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface flex-shrink-0">
        <button
          onClick={() => setDesignTakeover(activeSession.id, false)}
          className="flex items-center gap-1.5 text-sm text-claude-text-secondary hover:text-claude-text"
          title="Return to the coding session — design keeps running and context syncs back automatically"
        >
          <ArrowLeft size={14} />
          Back to coding session
        </button>
        <span className="text-xs text-claude-text-secondary truncate">
          Design session — {getSessionDisplayName(activeSession)}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <DesignPanel sessionId={activeSession.id} chromeless />
      </div>
    </div>
  ) : null;

  // In Command Center mode, browser is a floating overlay — it doesn't consume side panel space
  const hasSidePanel = isCommandCenterActive
    ? (isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen || isMarkdownPanelOpen || isDesignPanelOpen)
    : (isBrowserPanelOpen || isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen || isMarkdownPanelOpen || isDesignPanelOpen);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {designOverlay}
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
          {isAgentViewActive ? (
            <AgentView />
          ) : isCommandCenterActive ? (
            <CommandCenterGrid />
          ) : isSessionSetup ? (
            <SetupProgress session={activeSession} progress={activeSetupProgress} />
          ) : (
            <>
              <ForkTabs sessionId={activeSession.id} />
              <div
                ref={chatSplitAreaRef}
                className="flex-1 min-h-0 flex overflow-hidden relative"
                onDragOver={handleSessionSplitDragOver}
                onDragLeave={handleSessionSplitDragLeave}
                onDrop={handleSessionSplitDrop}
              >
                <div className="flex-1 min-w-0 flex overflow-hidden">
                  <ChatContainer session={activeSession} />
                </div>
                {splitSession && (
                  <>
                    <div className="w-px flex-shrink-0 bg-claude-border shadow-[0_0_0_1px_rgba(255,255,255,0.025)]" />
                    <div className="flex-1 min-w-0 flex overflow-hidden">
                      <ChatContainer
                        session={splitSession}
                        onClosePane={() => {
                          if (activeSessionGroupId) setSessionSplitPane(activeSessionGroupId, null);
                        }}
                      />
                    </div>
                  </>
                )}
                {isSessionSplitDropActive && (
                  <div className="absolute z-40 top-1 bottom-1 right-1 w-[calc(50%_-_0.25rem)] pointer-events-none border-2 border-claude-accent bg-claude-accent/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] flex items-center justify-center">
                    <div className="px-3 py-2 bg-claude-surface border border-claude-accent text-[11px] font-mono font-bold uppercase tracking-wider text-claude-accent">
                      Split right
                    </div>
                  </div>
                )}
              </div>
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
                flexBasis: (viewportMode === 'mobile' && isBrowserPanelOpen && !isGitPanelOpen && !isEditorOpen && !isExtensionsPanelOpen && !isPlanPanelOpen && !isHtmlPanelOpen && !isMarkdownPanelOpen)
                  ? '420px'  // 375px device + padding + border
                  : flexBasis.side,
                flexShrink: 0,
                flexGrow: 0,
              }}
            >
              {/* Left side of side panel: Browser, Git, Editor (stacked vertically) */}
              <div className={`flex flex-col overflow-hidden ${isExtensionsPanelOpen && isBrowserPanelOpen ? 'flex-1' : 'w-full h-full'}`}>
                {/* Browser panel — independent from chat/session tab selection. */}
                {isBrowserPanelOpen && (
                  <div className={`flex flex-col overflow-hidden ${isGitPanelOpen || isEditorOpen ? 'flex-1' : 'h-full'}`}>
                    <div className="h-10 flex items-center justify-between border-b border-claude-border bg-claude-surface">
                      <div className="flex-1 flex items-center overflow-x-auto">
                        {browserTabsForPartition.map((tab) => (
                          <BrowserSessionTab
                            key={tab.id}
                            tab={tab}
                            ownerSession={sessions.find((session) => session.id === tab.ownerSessionId)}
                            isActive={activeBrowserTab?.id === tab.id}
                            onActivate={() => setActiveBrowserTab(tab.id)}
                          />
                        ))}
                        <button
                          type="button"
                          onClick={() => createTabForSession()}
                          disabled={!chatTargetSession}
                          className="h-full px-2 text-claude-text-secondary hover:text-claude-text hover:bg-claude-bg/50 disabled:opacity-30"
                          title="New browser tab"
                          aria-label="New browser tab"
                        >
                          <Plus size={13} />
                        </button>
                        {viewportMode === 'mobile' && (
                          <span className="ml-2 text-xs text-purple-400 font-medium whitespace-nowrap">
                            375 × {mobileBrowserHeight}
                          </span>
                        )}
                      </div>
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
                        {/* Persist every tab's URL, but keep only the visible tab's
                            Chromium guest alive. A hidden <webview> still owns a
                            renderer process, so mounting the whole saved workspace
                            made inactive sessions consume gigabytes after restart. */}
                        {activeBrowserTab && activeBrowserOwnerSession ? (
                          <div
                            key={activeBrowserTab.id}
                            data-browser-tab-id={activeBrowserTab.id}
                            data-browser-owner-session-id={activeBrowserTab.ownerSessionId}
                            className="absolute inset-0"
                          >
                            <BrowserPreviewBoundary tabId={activeBrowserTab.id}>
                              <BrowserPreview
                                session={activeBrowserOwnerSession}
                                isVisible={true}
                                partitionId={activeBrowserTab.partitionId}
                                browserTabId={activeBrowserTab.id}
                                initialBrowserUrl={activeBrowserTab.url}
                                onBrowserUrlChange={(url) => updateBrowserTabUrl(activeBrowserTab.id, url)}
                              />
                            </BrowserPreviewBoundary>
                          </div>
                        ) : null}
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

                {/* HTML response artifact panel */}
                {isHtmlPanelOpen && !isBrowserPanelOpen && (
                  <>
                    {(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen) && (
                      <div className="h-px bg-claude-border" />
                    )}
                    <div className={`flex flex-col overflow-hidden ${(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen) ? 'flex-1' : 'h-full'}`}>
                      <HtmlArtifactPanel sessionId={artifactTargetSessionId} />
                    </div>
                  </>
                )}

                {/* Markdown response reader panel */}
                {isMarkdownPanelOpen && !isBrowserPanelOpen && (
                  <>
                    {(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen) && (
                      <div className="h-px bg-claude-border" />
                    )}
                    <div className={`flex flex-col overflow-hidden ${(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen) ? 'flex-1' : 'h-full'}`}>
                      <MarkdownResponsePanel sessionId={artifactTargetSessionId} />
                    </div>
                  </>
                )}

                {/* Design panel (empty-state / manual start only — once a
                    workspace exists, design renders via the persistent
                    takeover overlay so its webview is never destroyed) */}
                {isDesignPanelOpen && !isBrowserPanelOpen && !activeDesignPanel && (
                  <>
                    {(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen || isMarkdownPanelOpen) && (
                      <div className="h-px bg-claude-border" />
                    )}
                    <div className={`flex flex-col overflow-hidden ${(isGitPanelOpen || isEditorOpen || isExtensionsPanelOpen || isPlanPanelOpen || isHtmlPanelOpen || isMarkdownPanelOpen) ? 'flex-1' : 'h-full'}`}>
                      <DesignPanel sessionId={activeSession.id} />
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
