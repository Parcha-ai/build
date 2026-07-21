import { create } from 'zustand';

// Split ratio: 'equal' = 50/50, 'main-focus' = 2/3 main, 'side-focus' = 2/3 side panel
type SplitRatio = 'equal' | 'main-focus' | 'side-focus';

// Browser viewport mode: 'desktop' = full width, 'mobile' = 375px width (iPhone)
type ViewportMode = 'desktop' | 'mobile';

export interface HtmlArtifact {
  html: string;
  messageId: string;
  title?: string;
  updatedAt: number;
}

export interface MarkdownPanel {
  content: string;
  messageId: string;
  title?: string;
  updatedAt: number;
}

export interface BrowserWorkspaceTab {
  id: string;
  ownerSessionId: string;
  partitionId: string;
  name: string;
  url: string;
  createdAt: number;
}

const BROWSER_WORKSPACE_KEY = 'grep-browser-workspace-v1';

interface BrowserWorkspaceState {
  tabs: BrowserWorkspaceTab[];
  activeTabId: string | null;
  activeTabIdsByPartition: Record<string, string>;
}

function loadBrowserWorkspace(): BrowserWorkspaceState {
  try {
    const parsed = JSON.parse(localStorage.getItem(BROWSER_WORKSPACE_KEY) || '{}');
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((tab: Partial<BrowserWorkspaceTab>) => (
        typeof tab.id === 'string'
        && typeof tab.ownerSessionId === 'string'
        && typeof tab.partitionId === 'string'
        && typeof tab.name === 'string'
        && typeof tab.url === 'string'
      )) as BrowserWorkspaceTab[]
      : [];
    const activeTabId = typeof parsed.activeTabId === 'string' && tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0]?.id || null;
    const activeTabIdsByPartition = Object.fromEntries(
      Object.entries(parsed.activeTabIdsByPartition || {}).filter(([partitionId, tabId]) => (
        typeof tabId === 'string'
        && tabs.some((tab) => tab.id === tabId && tab.partitionId === partitionId)
      )),
    ) as Record<string, string>;

    // Migrate the old single-active-tab workspace without changing its storage
    // key. Each Build session/fork family now remembers its own selected tab.
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab && !activeTabIdsByPartition[activeTab.partitionId]) {
      activeTabIdsByPartition[activeTab.partitionId] = activeTab.id;
    }
    for (const tab of tabs) {
      if (!activeTabIdsByPartition[tab.partitionId]) {
        activeTabIdsByPartition[tab.partitionId] = tab.id;
      }
    }

    return { tabs, activeTabId, activeTabIdsByPartition };
  } catch {
    return { tabs: [], activeTabId: null, activeTabIdsByPartition: {} };
  }
}

function persistBrowserWorkspace(
  tabs: BrowserWorkspaceTab[],
  activeTabId: string | null,
  activeTabIdsByPartition: Record<string, string>,
): void {
  try {
    localStorage.setItem(BROWSER_WORKSPACE_KEY, JSON.stringify({
      tabs,
      activeTabId,
      activeTabIdsByPartition,
    }));
  } catch { /* ignore storage failures */ }
}

function createBrowserTabId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const initialBrowserWorkspace = loadBrowserWorkspace();

const SESSION_SPLIT_PANES_KEY = 'grep-session-split-panes-v1';

function loadSessionSplitPanes(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_SPLIT_PANES_KEY) || '{}');
    return Object.fromEntries(
      Object.entries(parsed).filter(([groupId, sessionId]) => (
        typeof groupId === 'string' && typeof sessionId === 'string'
      )),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function persistSessionSplitPanes(splitPanes: Record<string, string>): void {
  try {
    localStorage.setItem(SESSION_SPLIT_PANES_KEY, JSON.stringify(splitPanes));
  } catch { /* ignore storage failures */ }
}

// Default mobile browser height (iPhone frame)
const DEFAULT_MOBILE_BROWSER_HEIGHT = 667;

// Load persisted mobile browser height from localStorage
const getPersistedMobileBrowserHeight = (): number => {
  try {
    const stored = localStorage.getItem('grep-mobile-browser-height');
    if (stored) {
      const height = parseInt(stored, 10);
      if (!isNaN(height) && height >= 400 && height <= 900) {
        return height;
      }
    }
  } catch (e) {
    // Ignore localStorage errors
  }
  return DEFAULT_MOBILE_BROWSER_HEIGHT;
};

interface UIState {
  isSidebarOpen: boolean;
  sidebarWidth: number;
  terminalHeight: number;
  isTerminalPanelOpen: boolean;
  isBrowserPanelOpen: boolean;
  isGitPanelOpen: boolean;
  isExtensionsPanelOpen: boolean;
  isDesignPanelOpen: boolean;
  isPlanPanelOpen: boolean;
  isHtmlPanelOpen: boolean;
  isMarkdownPanelOpen: boolean;
  isHistoryPanelOpen: boolean;
  isAnalyticsPanelOpen: boolean;
  isInspectorActive: boolean;
  isSettingsOpen: boolean;
  settingsTab: string | null;
  isOnboardingOpen: boolean;
  hasApiKey: boolean | null; // null = not checked yet, false = missing, true = present
  selectedElement: unknown | null;
  splitRatio: SplitRatio;
  viewportMode: ViewportMode;
  mobileBrowserHeight: number; // Height of mobile browser frame, persisted

  // New Session Dialog — global so it can be triggered from keyboard shortcuts
  isNewSessionDialogOpen: boolean;
  setNewSessionDialogOpen: (open: boolean) => void;
  openNewSessionDialog: () => void;
  closeNewSessionDialog: () => void;

  // Command Center — multi-session grid view
  isCommandCenterActive: boolean;
  commandCenterFocusedSessionId: string | null;

  // Agent View — triage dashboard
  isAgentViewActive: boolean;
  agentViewSelectedSessionId: string | null;
  agentViewTimeFilterHours: number;
  toggleAgentView: () => void;
  setAgentViewSelectedSession: (id: string | null) => void;
  setAgentViewTimeFilterHours: (hours: number) => void;

  // Multi-session browser support: track which sessions have browsers enabled
  sessionBrowsersEnabled: Record<string, boolean>;
  browserTabs: BrowserWorkspaceTab[];
  activeBrowserTabId: string | null;
  activeBrowserTabIdsByPartition: Record<string, string>;
  sessionSplitPaneIds: Record<string, string>;
  // Per-session inspector state
  sessionInspectorActive: Record<string, boolean>;
  // Per-session selected element
  sessionSelectedElement: Record<string, unknown | null>;
  // Per-session plan content (markdown)
  sessionPlanContent: Record<string, string>;
  // Per-session HTML response artifacts
  sessionHtmlArtifacts: Record<string, HtmlArtifact>;
  // Per-session markdown reader panel content
  sessionMarkdownPanels: Record<string, MarkdownPanel>;
  // Per-session text editing state (used for loading animation during text replacement)
  sessionEditingText: Record<string, boolean>;
  // Per-session design panel state (Open Design canvas URL + workspace dir)
  sessionDesignPanels: Record<string, { url: string; workspaceDir: string }>;
  // Sessions where the design session has fully taken over the view (no dual chat)
  sessionDesignTakeover: Record<string, boolean>;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  toggleTerminalPanel: () => void;
  toggleBrowserPanel: () => void;
  toggleGitPanel: () => void;
  toggleExtensionsPanel: () => void;
  togglePlanPanel: () => void;
  showPlanPanel: () => void;
  toggleHtmlPanel: () => void;
  showHtmlPanel: () => void;
  toggleMarkdownPanel: () => void;
  showMarkdownPanel: () => void;
  setMarkdownPanel: (sessionId: string, panel: Omit<MarkdownPanel, 'updatedAt'>) => void;
  clearMarkdownPanel: (sessionId: string) => void;
  toggleHistoryPanel: () => void;
  toggleAnalyticsPanel: () => void;
  toggleDesignPanel: () => void;
  showDesignPanel: (sessionId: string, panel: { url: string; workspaceDir: string }, takeover?: boolean) => void;
  setDesignTakeover: (sessionId: string, active: boolean) => void;
  setInspectorActive: (active: boolean) => void;
  setSelectedElement: (element: unknown | null) => void;
  cycleSplitRatio: () => void;
  setSplitRatio: (ratio: SplitRatio) => void;
  toggleViewportMode: () => void;
  setViewportMode: (mode: ViewportMode) => void;
  setMobileBrowserHeight: (height: number) => void;
  openSettings: (tab?: unknown) => void;
  closeSettings: () => void;
  checkApiKey: () => Promise<boolean>;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  setPlanContent: (sessionId: string, content: string) => void;
  clearPlanContent: (sessionId: string) => void;
  setHtmlArtifact: (sessionId: string, artifact: Omit<HtmlArtifact, 'updatedAt'> & { updatedAt?: number }) => void;
  clearHtmlArtifact: (sessionId: string) => void;

  // Command Center methods
  toggleCommandCenter: () => void;
  setCommandCenterFocusedSession: (id: string | null) => void;

  // Multi-session browser methods
  enableSessionBrowser: (sessionId: string) => void;
  disableSessionBrowser: (sessionId: string) => void;
  isSessionBrowserEnabled: (sessionId: string) => boolean;
  setSessionInspectorActive: (sessionId: string, active: boolean) => void;
  setSessionSelectedElement: (sessionId: string, element: unknown | null) => void;
  cleanupSessionBrowser: (sessionId: string) => void;
  setSessionEditingText: (sessionId: string, isEditing: boolean) => void;
  createBrowserTab: (ownerSessionId: string, partitionId: string, url: string, name?: string) => string;
  setActiveBrowserTab: (tabId: string) => void;
  renameBrowserTab: (tabId: string, name: string) => void;
  updateBrowserTabUrl: (tabId: string, url: string) => void;
  closeBrowserTab: (tabId: string) => void;
  setSessionSplitPane: (groupId: string, sessionId: string | null) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  isSidebarOpen: true,
  sidebarWidth: 280,
  terminalHeight: 0,
  isTerminalPanelOpen: false,
  isBrowserPanelOpen: false,
  isGitPanelOpen: false,
  isExtensionsPanelOpen: false, isDesignPanelOpen: false,
  isPlanPanelOpen: false,
  isHtmlPanelOpen: false,
  isMarkdownPanelOpen: false,
  isHistoryPanelOpen: false,
  isAnalyticsPanelOpen: false,
  isInspectorActive: false,
  isSettingsOpen: false,
  settingsTab: null,
  isOnboardingOpen: false,
  hasApiKey: null,
  selectedElement: null,
  splitRatio: 'equal',
  viewportMode: 'desktop',
  mobileBrowserHeight: getPersistedMobileBrowserHeight(),

  // New Session Dialog state
  isNewSessionDialogOpen: false,
  setNewSessionDialogOpen: (open: boolean) => set({ isNewSessionDialogOpen: open }),
  openNewSessionDialog: () => set({ isNewSessionDialogOpen: true }),
  closeNewSessionDialog: () => set({ isNewSessionDialogOpen: false }),

  // Command Center state — persisted via localStorage
  isCommandCenterActive: (() => {
    try {
      return localStorage.getItem('grep-command-center-active') === 'true';
    } catch (e) { return false; }
  })(),
  commandCenterFocusedSessionId: (() => {
    try {
      return localStorage.getItem('grep-command-center-focused') || null;
    } catch (e) { return null; }
  })(),

  // Agent View state — persisted via localStorage
  isAgentViewActive: (() => {
    try {
      return localStorage.getItem('grep-agent-view-active') === 'true';
    } catch (e) { return false; }
  })(),
  agentViewSelectedSessionId: (() => {
    try {
      return localStorage.getItem('grep-agent-view-selected') || null;
    } catch (e) { return null; }
  })(),
  agentViewTimeFilterHours: (() => {
    try {
      const stored = localStorage.getItem('grep-agent-view-filter-hours');
      return stored ? parseInt(stored, 10) : 24;
    } catch (e) { return 24; }
  })(),

  // Multi-session browser state
  sessionBrowsersEnabled: {},
  browserTabs: initialBrowserWorkspace.tabs,
  activeBrowserTabId: initialBrowserWorkspace.activeTabId,
  activeBrowserTabIdsByPartition: initialBrowserWorkspace.activeTabIdsByPartition,
  sessionSplitPaneIds: loadSessionSplitPanes(),
  sessionInspectorActive: {},
  sessionSelectedElement: {},
  sessionEditingText: {},
  sessionDesignPanels: {},
  sessionDesignTakeover: {},
  sessionHtmlArtifacts: {},
  sessionMarkdownPanels: {},
  sessionPlanContent: (() => {
    // Plan content is no longer persisted to localStorage (was causing
    // silent data loss at 25MB+ localStorage). Plans are re-fetched from
    // the plan file or reconstructed from messages on panel mount.
    return {};
  })(),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setTerminalHeight: (height) => set({ terminalHeight: height }),
  toggleTerminalPanel: () => set((state) => ({ isTerminalPanelOpen: !state.isTerminalPanelOpen })),
  // Browser, Extensions, Plan, and Editor panels are mutually exclusive
  // When opening one, close the others. Git can coexist with any panel.
  toggleBrowserPanel: () => {
    const state = useUIStore.getState();
    set({
      isBrowserPanelOpen: !state.isBrowserPanelOpen,
      // Close competing panels when opening browser
      ...((!state.isBrowserPanelOpen) ? { isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false } : {})
    });
    // Also close editor when opening browser (dynamic import to avoid circular dependency)
    if (!state.isBrowserPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  toggleGitPanel: () => set((state) => ({ isGitPanelOpen: !state.isGitPanelOpen })),
  toggleExtensionsPanel: () => {
    const state = useUIStore.getState();
    set({
      isExtensionsPanelOpen: !state.isExtensionsPanelOpen,
      // Close competing panels when opening extensions
      ...((!state.isExtensionsPanelOpen) ? { isBrowserPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false, isDesignPanelOpen: false } : {})
    });
    // Also close editor when opening extensions (dynamic import to avoid circular dependency)
    if (!state.isExtensionsPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  togglePlanPanel: () => {
    const state = useUIStore.getState();
    set({
      isPlanPanelOpen: !state.isPlanPanelOpen,
      // Close competing panels when opening plan
      ...((!state.isPlanPanelOpen) ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false, isMarkdownPanelOpen: false } : {})
    });
    // Also close editor when opening plan (dynamic import to avoid circular dependency)
    if (!state.isPlanPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  showPlanPanel: () => {
    set({ isPlanPanelOpen: true, isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false, isMarkdownPanelOpen: false });
    // Also close editor when showing plan (dynamic import to avoid circular dependency)
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
  toggleHtmlPanel: () => {
    const state = useUIStore.getState();
    set({
      isHtmlPanelOpen: !state.isHtmlPanelOpen,
      ...((!state.isHtmlPanelOpen) ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHistoryPanelOpen: false, isMarkdownPanelOpen: false } : {})
    });
    if (!state.isHtmlPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  showHtmlPanel: () => {
    set({ isHtmlPanelOpen: true, isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHistoryPanelOpen: false, isMarkdownPanelOpen: false });
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
  toggleMarkdownPanel: () => {
    const state = useUIStore.getState();
    set({
      isMarkdownPanelOpen: !state.isMarkdownPanelOpen,
      ...(!state.isMarkdownPanelOpen ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false } : {}),
    });
    if (!state.isMarkdownPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  showMarkdownPanel: () => {
    set({ isMarkdownPanelOpen: true, isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isHistoryPanelOpen: false });
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
  setMarkdownPanel: (sessionId, panel) => {
    set((state) => ({
      sessionMarkdownPanels: {
        ...state.sessionMarkdownPanels,
        [sessionId]: { ...panel, updatedAt: Date.now() },
      },
      isMarkdownPanelOpen: true,
      isBrowserPanelOpen: false,
      isExtensionsPanelOpen: false, isDesignPanelOpen: false,
      isPlanPanelOpen: false,
      isHtmlPanelOpen: false,
      isHistoryPanelOpen: false,
    }));
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
  clearMarkdownPanel: (sessionId) => set((state) => {
    const panels = { ...state.sessionMarkdownPanels };
    delete panels[sessionId];
    return { sessionMarkdownPanels: panels };
  }),
  toggleHistoryPanel: () => {
    const state = useUIStore.getState();
    set({
      isHistoryPanelOpen: !state.isHistoryPanelOpen,
      // Close competing panels when opening history
      ...(!state.isHistoryPanelOpen ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isMarkdownPanelOpen: false, isAnalyticsPanelOpen: false } : {}),
    });
    // Also close editor when opening history
    if (!state.isHistoryPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  toggleAnalyticsPanel: () => {
    const state = useUIStore.getState();
    set({
      isAnalyticsPanelOpen: !state.isAnalyticsPanelOpen,
      ...((!state.isAnalyticsPanelOpen) ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isDesignPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isMarkdownPanelOpen: false, isHistoryPanelOpen: false } : {}),
    });
    if (!state.isAnalyticsPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  toggleDesignPanel: () => {
    const state = useUIStore.getState();
    set({
      isDesignPanelOpen: !state.isDesignPanelOpen,
      // Close competing panels when opening design
      ...(!state.isDesignPanelOpen ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false, isPlanPanelOpen: false, isHtmlPanelOpen: false, isMarkdownPanelOpen: false, isHistoryPanelOpen: false, isAnalyticsPanelOpen: false } : {}),
    });
    if (!state.isDesignPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  showDesignPanel: (sessionId, panel, takeover) => {
    set((state) => ({
      sessionDesignPanels: { ...state.sessionDesignPanels, [sessionId]: panel },
      ...(takeover !== undefined
        ? { sessionDesignTakeover: { ...state.sessionDesignTakeover, [sessionId]: takeover } }
        : {}),
      isDesignPanelOpen: true,
      isBrowserPanelOpen: false,
      isExtensionsPanelOpen: false,
      isPlanPanelOpen: false,
      isHtmlPanelOpen: false,
      isMarkdownPanelOpen: false,
      isHistoryPanelOpen: false,
      isAnalyticsPanelOpen: false,
    }));
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
  setDesignTakeover: (sessionId, active) => set((state) => ({
    sessionDesignTakeover: { ...state.sessionDesignTakeover, [sessionId]: active },
    ...(active ? {} : { isDesignPanelOpen: false }),
  })),
  setInspectorActive: (active) => set({ isInspectorActive: active }),
  setSelectedElement: (element) => set({ selectedElement: element }),
  cycleSplitRatio: () => set((state) => {
    const order: SplitRatio[] = ['equal', 'main-focus', 'side-focus'];
    const currentIndex = order.indexOf(state.splitRatio);
    const nextIndex = (currentIndex + 1) % order.length;
    return { splitRatio: order[nextIndex] };
  }),
  setSplitRatio: (ratio) => set({ splitRatio: ratio }),
  toggleViewportMode: () => set((state) => ({
    viewportMode: state.viewportMode === 'desktop' ? 'mobile' : 'desktop',
  })),
  setViewportMode: (mode) => set({ viewportMode: mode }),
  setMobileBrowserHeight: (height) => {
    const clampedHeight = Math.max(400, Math.min(900, height));
    try {
      localStorage.setItem('grep-mobile-browser-height', String(clampedHeight));
    } catch (e) {
      // Ignore localStorage errors
    }
    set({ mobileBrowserHeight: clampedHeight });
  },
  openSettings: (tab?: unknown) => set({
    isSettingsOpen: true,
    settingsTab: typeof tab === 'string' ? tab : null,
  }),
  closeSettings: () => set({ isSettingsOpen: false }),
  checkApiKey: async () => {
    try {
      const apiKey = await window.electronAPI?.settings?.getApiKey?.();
      const hasKey = !!apiKey && apiKey.trim().length > 0;
      set({ hasApiKey: hasKey });
      return hasKey;
    } catch (error) {
      console.error('Failed to check API key:', error);
      set({ hasApiKey: false });
      return false;
    }
  },
  openOnboarding: () => set({ isOnboardingOpen: true }),
  closeOnboarding: () => set({ isOnboardingOpen: false }),

  // Plan content methods
  setPlanContent: (sessionId: string, content: string) => set((state) => ({
    sessionPlanContent: { ...state.sessionPlanContent, [sessionId]: content },
    isPlanPanelOpen: true,
    isHtmlPanelOpen: false,
    isMarkdownPanelOpen: false,
  })),
  clearPlanContent: (sessionId: string) => set((state) => {
    const newContent = { ...state.sessionPlanContent };
    delete newContent[sessionId];
    return { sessionPlanContent: newContent };
  }),
  setHtmlArtifact: (sessionId, artifact) => {
    let shouldCloseEditor = false;
    set((state) => ({
      ...(() => {
        shouldCloseEditor = !state.isHtmlPanelOpen
          || state.isBrowserPanelOpen
          || state.isExtensionsPanelOpen
          || state.isPlanPanelOpen
          || state.isHistoryPanelOpen;
        return {};
      })(),
      sessionHtmlArtifacts: {
        ...state.sessionHtmlArtifacts,
        [sessionId]: {
          ...artifact,
          updatedAt: artifact.updatedAt || Date.now(),
        },
      },
      isHtmlPanelOpen: true,
      isBrowserPanelOpen: false,
      isExtensionsPanelOpen: false, isDesignPanelOpen: false,
      isPlanPanelOpen: false,
      isHistoryPanelOpen: false,
      isMarkdownPanelOpen: false,
    }));
    if (shouldCloseEditor) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  clearHtmlArtifact: (sessionId) => set((state) => {
    const artifacts = { ...state.sessionHtmlArtifacts };
    delete artifacts[sessionId];
    return { sessionHtmlArtifacts: artifacts };
  }),

  // Command Center methods
  toggleCommandCenter: () => set((state) => {
    const newActive = !state.isCommandCenterActive;
    const newFocused = newActive ? state.commandCenterFocusedSessionId : null;
    try {
      localStorage.setItem('grep-command-center-active', String(newActive));
      if (newFocused) localStorage.setItem('grep-command-center-focused', newFocused);
      else localStorage.removeItem('grep-command-center-focused');
    } catch (e) { /* ignore */ }
    return {
      isCommandCenterActive: newActive,
      commandCenterFocusedSessionId: newFocused,
      // Mutually exclusive with Agent View
      ...(newActive ? { isAgentViewActive: false } : {}),
    };
  }),

  setCommandCenterFocusedSession: (id: string | null) => {
    try {
      if (id) localStorage.setItem('grep-command-center-focused', id);
      else localStorage.removeItem('grep-command-center-focused');
    } catch (e) { /* ignore */ }
    set({ commandCenterFocusedSessionId: id });
  },

  // Agent View methods
  toggleAgentView: () => set((state) => {
    const newActive = !state.isAgentViewActive;
    try {
      localStorage.setItem('grep-agent-view-active', String(newActive));
    } catch (e) { /* ignore */ }
    return {
      isAgentViewActive: newActive,
      // Mutually exclusive with Command Center
      ...(newActive ? { isCommandCenterActive: false } : {}),
    };
  }),

  setAgentViewSelectedSession: (id: string | null) => {
    try {
      if (id) localStorage.setItem('grep-agent-view-selected', id);
      else localStorage.removeItem('grep-agent-view-selected');
    } catch (e) { /* ignore */ }
    set({ agentViewSelectedSessionId: id });
  },

  setAgentViewTimeFilterHours: (hours: number) => {
    try {
      localStorage.setItem('grep-agent-view-filter-hours', String(hours));
    } catch (e) { /* ignore */ }
    set({ agentViewTimeFilterHours: hours });
  },

  // Multi-session browser methods
  enableSessionBrowser: (sessionId: string) => set((state) => ({
    sessionBrowsersEnabled: { ...state.sessionBrowsersEnabled, [sessionId]: true },
    // Also open the browser panel if not already open
    isBrowserPanelOpen: true,
  })),

  disableSessionBrowser: (sessionId: string) => set((state) => {
    const newEnabled = { ...state.sessionBrowsersEnabled };
    delete newEnabled[sessionId];
    // Close browser panel if no sessions have browsers enabled
    const hasAnyBrowsers = Object.values(newEnabled).some(v => v);
    return {
      sessionBrowsersEnabled: newEnabled,
      isBrowserPanelOpen: hasAnyBrowsers ? state.isBrowserPanelOpen : false,
    };
  }),

  isSessionBrowserEnabled: (sessionId: string) => {
    return get().sessionBrowsersEnabled[sessionId] || false;
  },

  setSessionInspectorActive: (sessionId: string, active: boolean) => set((state) => ({
    sessionInspectorActive: { ...state.sessionInspectorActive, [sessionId]: active },
    // Also update global for backwards compatibility
    isInspectorActive: active,
  })),

  setSessionSelectedElement: (sessionId: string, element: unknown | null) => set((state) => ({
    sessionSelectedElement: { ...state.sessionSelectedElement, [sessionId]: element },
    // Also update global for backwards compatibility
    selectedElement: element,
  })),

  cleanupSessionBrowser: (sessionId: string) => set((state) => {
    const newEnabled = { ...state.sessionBrowsersEnabled };
    const newInspectorActive = { ...state.sessionInspectorActive };
    const newSelectedElement = { ...state.sessionSelectedElement };
    const newEditingText = { ...state.sessionEditingText };
    delete newEnabled[sessionId];
    delete newInspectorActive[sessionId];
    delete newSelectedElement[sessionId];
    delete newEditingText[sessionId];
    const sessionSplitPaneIds = Object.fromEntries(
      Object.entries(state.sessionSplitPaneIds).filter(([groupId, splitSessionId]) => (
        groupId !== sessionId && splitSessionId !== sessionId
      )),
    ) as Record<string, string>;
    persistSessionSplitPanes(sessionSplitPaneIds);
    const browserTabs = state.browserTabs.filter((tab) => tab.ownerSessionId !== sessionId);
    const activeBrowserTabIdsByPartition = Object.fromEntries(
      Object.entries(state.activeBrowserTabIdsByPartition).filter(([partitionId, tabId]) => (
        browserTabs.some((tab) => tab.id === tabId && tab.partitionId === partitionId)
      )),
    ) as Record<string, string>;
    for (const tab of browserTabs) {
      if (!activeBrowserTabIdsByPartition[tab.partitionId]) {
        activeBrowserTabIdsByPartition[tab.partitionId] = tab.id;
      }
    }
    const activeBrowserTabId = browserTabs.some((tab) => tab.id === state.activeBrowserTabId)
      ? state.activeBrowserTabId
      : browserTabs[0]?.id || null;
    persistBrowserWorkspace(browserTabs, activeBrowserTabId, activeBrowserTabIdsByPartition);
    return {
      sessionBrowsersEnabled: newEnabled,
      sessionInspectorActive: newInspectorActive,
      sessionSelectedElement: newSelectedElement,
      sessionEditingText: newEditingText,
      sessionSplitPaneIds,
      browserTabs,
      activeBrowserTabId,
      activeBrowserTabIdsByPartition,
    };
  }),

  setSessionEditingText: (sessionId: string, isEditing: boolean) => set((state) => ({
    sessionEditingText: { ...state.sessionEditingText, [sessionId]: isEditing },
  })),

  createBrowserTab: (ownerSessionId, partitionId, url, name) => {
    const id = createBrowserTabId();
    const state = get();
    const tab: BrowserWorkspaceTab = {
      id,
      ownerSessionId,
      partitionId,
      name: name?.trim() || `Browser ${state.browserTabs.length + 1}`,
      url,
      createdAt: Date.now(),
    };
    const tabs = [...state.browserTabs, tab];
    const activeBrowserTabIdsByPartition = {
      ...state.activeBrowserTabIdsByPartition,
      [partitionId]: id,
    };
    persistBrowserWorkspace(tabs, id, activeBrowserTabIdsByPartition);
    set({
      browserTabs: tabs,
      activeBrowserTabId: id,
      activeBrowserTabIdsByPartition,
      isBrowserPanelOpen: true,
    });
    return id;
  },

  setActiveBrowserTab: (tabId) => set((state) => {
    const tab = state.browserTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return state;
    const activeBrowserTabIdsByPartition = {
      ...state.activeBrowserTabIdsByPartition,
      [tab.partitionId]: tabId,
    };
    persistBrowserWorkspace(state.browserTabs, tabId, activeBrowserTabIdsByPartition);
    return { activeBrowserTabId: tabId, activeBrowserTabIdsByPartition };
  }),

  renameBrowserTab: (tabId, name) => set((state) => {
    const normalized = name.replace(/\s+/g, ' ').trim();
    if (!normalized) return state;
    const tabs = state.browserTabs.map((tab) => tab.id === tabId ? { ...tab, name: normalized } : tab);
    persistBrowserWorkspace(tabs, state.activeBrowserTabId, state.activeBrowserTabIdsByPartition);
    return { browserTabs: tabs };
  }),

  updateBrowserTabUrl: (tabId, url) => set((state) => {
    const tabs = state.browserTabs.map((tab) => tab.id === tabId ? { ...tab, url } : tab);
    persistBrowserWorkspace(tabs, state.activeBrowserTabId, state.activeBrowserTabIdsByPartition);
    return { browserTabs: tabs };
  }),

  closeBrowserTab: (tabId) => set((state) => {
    const closingIndex = state.browserTabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return state;
    const closingTab = state.browserTabs[closingIndex];
    const tabs = state.browserTabs.filter((tab) => tab.id !== tabId);
    const partitionTabs = tabs.filter((tab) => tab.partitionId === closingTab.partitionId);
    const partitionReplacement = partitionTabs[Math.min(
      state.browserTabs.slice(0, closingIndex).filter((tab) => tab.partitionId === closingTab.partitionId).length,
      Math.max(0, partitionTabs.length - 1),
    )];
    const activeBrowserTabIdsByPartition = { ...state.activeBrowserTabIdsByPartition };
    if (activeBrowserTabIdsByPartition[closingTab.partitionId] === tabId) {
      if (partitionReplacement) activeBrowserTabIdsByPartition[closingTab.partitionId] = partitionReplacement.id;
      else delete activeBrowserTabIdsByPartition[closingTab.partitionId];
    }
    const activeTabId = state.activeBrowserTabId === tabId
      ? partitionReplacement?.id || tabs[Math.min(closingIndex, tabs.length - 1)]?.id || null
      : state.activeBrowserTabId;
    persistBrowserWorkspace(tabs, activeTabId, activeBrowserTabIdsByPartition);
    return { browserTabs: tabs, activeBrowserTabId: activeTabId, activeBrowserTabIdsByPartition };
  }),

  setSessionSplitPane: (groupId, sessionId) => set((state) => {
    const sessionSplitPaneIds = { ...state.sessionSplitPaneIds };
    if (sessionId) sessionSplitPaneIds[groupId] = sessionId;
    else delete sessionSplitPaneIds[groupId];
    persistSessionSplitPanes(sessionSplitPaneIds);
    return { sessionSplitPaneIds };
  }),
}));
