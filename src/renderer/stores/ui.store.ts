import { create } from 'zustand';

// Split ratio: 'equal' = 50/50, 'main-focus' = 2/3 main, 'side-focus' = 2/3 side panel
type SplitRatio = 'equal' | 'main-focus' | 'side-focus';

// Browser viewport mode: 'desktop' = full width, 'mobile' = 375px width (iPhone)
type ViewportMode = 'desktop' | 'mobile';

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
  isPlanPanelOpen: boolean;
  isInspectorActive: boolean;
  isSettingsOpen: boolean;
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

  // Multi-session browser support: track which sessions have browsers enabled
  sessionBrowsersEnabled: Record<string, boolean>;
  // Per-session inspector state
  sessionInspectorActive: Record<string, boolean>;
  // Per-session selected element
  sessionSelectedElement: Record<string, unknown | null>;
  // Per-session plan content (markdown)
  sessionPlanContent: Record<string, string>;
  // Per-session text editing state (used for loading animation during text replacement)
  sessionEditingText: Record<string, boolean>;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  toggleTerminalPanel: () => void;
  toggleBrowserPanel: () => void;
  toggleGitPanel: () => void;
  toggleExtensionsPanel: () => void;
  togglePlanPanel: () => void;
  showPlanPanel: () => void;
  setInspectorActive: (active: boolean) => void;
  setSelectedElement: (element: unknown | null) => void;
  cycleSplitRatio: () => void;
  setSplitRatio: (ratio: SplitRatio) => void;
  toggleViewportMode: () => void;
  setViewportMode: (mode: ViewportMode) => void;
  setMobileBrowserHeight: (height: number) => void;
  openSettings: () => void;
  closeSettings: () => void;
  checkApiKey: () => Promise<boolean>;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  setPlanContent: (sessionId: string, content: string) => void;
  clearPlanContent: (sessionId: string) => void;

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
}

export const useUIStore = create<UIState>((set, get) => ({
  isSidebarOpen: true,
  sidebarWidth: 280,
  terminalHeight: 0,
  isTerminalPanelOpen: false,
  isBrowserPanelOpen: false,
  isGitPanelOpen: false,
  isExtensionsPanelOpen: false,
  isPlanPanelOpen: false,
  isInspectorActive: false,
  isSettingsOpen: false,
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

  // Multi-session browser state
  sessionBrowsersEnabled: {},
  sessionInspectorActive: {},
  sessionSelectedElement: {},
  sessionEditingText: {},
  sessionPlanContent: (() => {
    try {
      const stored = localStorage.getItem('grep-plan-content');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('[UI Store] Failed to load persisted plan content:', e);
    }
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
      ...((!state.isBrowserPanelOpen) ? { isExtensionsPanelOpen: false, isPlanPanelOpen: false } : {})
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
      ...((!state.isExtensionsPanelOpen) ? { isBrowserPanelOpen: false, isPlanPanelOpen: false } : {})
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
      ...((!state.isPlanPanelOpen) ? { isBrowserPanelOpen: false, isExtensionsPanelOpen: false } : {})
    });
    // Also close editor when opening plan (dynamic import to avoid circular dependency)
    if (!state.isPlanPanelOpen) {
      import('./editor.store').then(({ useEditorStore }) => {
        useEditorStore.getState().closeEditor();
      });
    }
  },
  showPlanPanel: () => {
    set({ isPlanPanelOpen: true, isBrowserPanelOpen: false, isExtensionsPanelOpen: false });
    // Also close editor when showing plan (dynamic import to avoid circular dependency)
    import('./editor.store').then(({ useEditorStore }) => {
      useEditorStore.getState().closeEditor();
    });
  },
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
  openSettings: () => set({ isSettingsOpen: true }),
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
  setPlanContent: (sessionId: string, content: string) => set((state) => {
    const newContent = { ...state.sessionPlanContent, [sessionId]: content };
    // Persist to localStorage
    try {
      localStorage.setItem('grep-plan-content', JSON.stringify(newContent));
    } catch (e) {
      console.warn('[UI Store] Failed to persist plan content:', e);
    }
    return {
      sessionPlanContent: newContent,
      // Auto-open plan panel when content is set
      isPlanPanelOpen: true,
    };
  }),
  clearPlanContent: (sessionId: string) => set((state) => {
    const newContent = { ...state.sessionPlanContent };
    delete newContent[sessionId];
    // Persist to localStorage
    try {
      localStorage.setItem('grep-plan-content', JSON.stringify(newContent));
    } catch (e) {
      console.warn('[UI Store] Failed to persist plan content:', e);
    }
    return { sessionPlanContent: newContent };
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
    return { isCommandCenterActive: newActive, commandCenterFocusedSessionId: newFocused };
  }),

  setCommandCenterFocusedSession: (id: string | null) => {
    try {
      if (id) localStorage.setItem('grep-command-center-focused', id);
      else localStorage.removeItem('grep-command-center-focused');
    } catch (e) { /* ignore */ }
    set({ commandCenterFocusedSessionId: id });
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
    return {
      sessionBrowsersEnabled: newEnabled,
      sessionInspectorActive: newInspectorActive,
      sessionSelectedElement: newSelectedElement,
      sessionEditingText: newEditingText,
    };
  }),

  setSessionEditingText: (sessionId: string, isEditing: boolean) => set((state) => ({
    sessionEditingText: { ...state.sessionEditingText, [sessionId]: isEditing },
  })),
}));
