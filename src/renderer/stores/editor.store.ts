import { create } from 'zustand';

// Check if running in Electron environment
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

export interface EditorTab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
  lineNumber?: number;
  isPreviewMode?: boolean; // For markdown files, track if showing preview vs raw
  isPlanTab?: boolean; // Special flag for plan approval tabs
  planRequestId?: string; // For plan approval tabs, track the request ID
}

interface EditorWorkspace {
  isEditorOpen: boolean;
  tabs: EditorTab[];
  activeTabId: string | null;
  isLoading: boolean;
  error: string | null;
}

interface EditorState {
  isEditorOpen: boolean;
  tabs: EditorTab[];
  activeTabId: string | null;
  isLoading: boolean;
  error: string | null;
  activeSessionId: string | null;
  sessionWorkspaces: Record<string, EditorWorkspace>;

  // Quick Search state
  isQuickSearchOpen: boolean;

  // File Content Search state
  isFileSearchOpen: boolean;

  openFile: (filePath: string, lineNumber?: number) => Promise<void>;
  openPlan: (planContent: string, requestId: string) => void; // Open plan as editor tab
  closeTab: (tabId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  saveTab: (tabId: string) => Promise<boolean>;
  saveAllTabs: () => Promise<void>;
  closeEditor: () => void;
  openEditor: () => void;
  closeEditorForSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  cleanupSession: (sessionId: string) => void;
  togglePreviewMode: (tabId: string) => void; // Toggle between preview and edit for markdown

  // Quick Search actions
  openQuickSearch: () => void;
  closeQuickSearch: () => void;
  toggleQuickSearch: () => void;

  // File Content Search actions
  openFileSearch: () => void;
  closeFileSearch: () => void;
  toggleFileSearch: () => void;
}

function emptyEditorWorkspace(): EditorWorkspace {
  return {
    isEditorOpen: false,
    tabs: [],
    activeTabId: null,
    isLoading: false,
    error: null,
  };
}

function getEditorWorkspace(state: EditorState, sessionId: string): EditorWorkspace {
  return state.sessionWorkspaces[sessionId] || emptyEditorWorkspace();
}

function updateEditorWorkspace(
  state: EditorState,
  sessionId: string | null,
  update: (workspace: EditorWorkspace) => EditorWorkspace,
): Partial<EditorState> {
  if (!sessionId) return update({
    isEditorOpen: state.isEditorOpen,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    isLoading: state.isLoading,
    error: state.error,
  });
  const workspace = update(getEditorWorkspace(state, sessionId));
  return {
    sessionWorkspaces: { ...state.sessionWorkspaces, [sessionId]: workspace },
    ...(state.activeSessionId === sessionId ? workspace : {}),
  };
}

// Get language from file extension
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'json': 'json',
    'md': 'markdown',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'sql': 'sql',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'dockerfile': 'dockerfile',
    'toml': 'toml',
    'ini': 'ini',
    'vue': 'vue',
    'svelte': 'svelte',
    'graphql': 'graphql',
    'gql': 'graphql',
  };
  return languageMap[ext] || 'plaintext';
}

// Generate a unique tab ID
function generateTabId(filePath: string): string {
  return `tab-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;
}

function splitPathLineSuffix(filePath: string): { filePath: string; lineNumber?: number } {
  const match = filePath.match(/^(.+):(\d+)(?::\d+)?$/);
  if (!match) return { filePath };
  const [, basePath, lineText] = match;
  if (!basePath.includes('/') && !basePath.includes('\\')) return { filePath };
  return {
    filePath: basePath,
    lineNumber: Number.parseInt(lineText, 10),
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  isEditorOpen: false,
  tabs: [],
  activeTabId: null,
  isLoading: false,
  error: null,
  activeSessionId: null,
  sessionWorkspaces: {},
  isQuickSearchOpen: false,
  isFileSearchOpen: false,

  openFile: async (filePath: string, lineNumber?: number) => {
    const parsedPath = splitPathLineSuffix(filePath);
    const normalizedFilePath = parsedPath.filePath;
    const normalizedLineNumber = lineNumber ?? parsedPath.lineNumber;
    console.log('[EditorStore] openFile called:', filePath, 'normalized:', normalizedFilePath, 'lineNumber:', normalizedLineNumber);

    if (!hasElectronAPI) {
      console.error('[EditorStore] No Electron API available');
      set({ error: 'File operations not available in preview mode', isLoading: false });
      return;
    }

    // Capture the owning session before any async work. If the user switches
    // sessions while the file is loading, the completed tab must stay in the
    // workspace that requested it.
    const { useSessionStore } = await import('./session.store');
    const activeSessionId = useSessionStore.getState().activeSessionId;
    console.log('[EditorStore] Active session ID:', activeSessionId);

    if (!activeSessionId) {
      set({ error: 'No active session', isLoading: false });
      return;
    }

    const workspace = getEditorWorkspace(get(), activeSessionId);
    const { tabs } = workspace;
    console.log('[EditorStore] Current tabs:', tabs.length);

    // Check if file is already open
    const existingTab = tabs.find(tab => tab.filePath === normalizedFilePath);
    if (existingTab) {
      console.log('[EditorStore] File already open, activating tab:', existingTab.id);
      set((state) => updateEditorWorkspace(state, activeSessionId, (current) => ({
        ...current,
        activeTabId: existingTab.id,
        isEditorOpen: true,
        tabs: current.tabs.map(tab => tab.id === existingTab.id
          ? { ...tab, lineNumber: normalizedLineNumber ?? tab.lineNumber }
          : tab),
      })));
      import('./ui.store').then(({ useUIStore }) => {
        useUIStore.getState().prepareSessionForEditor(activeSessionId);
      });
      return;
    }

    console.log('[EditorStore] Setting loading state');
    set((state) => updateEditorWorkspace(state, activeSessionId, (current) => ({
      ...current,
      isLoading: true,
      error: null,
    })));

    try {
      console.log('[EditorStore] Reading file via IPC, sessionId:', activeSessionId);
      const result = await window.electronAPI.fs.readFile(normalizedFilePath, activeSessionId || undefined);
      console.log('[EditorStore] Read result:', result);

      if (!result.success) {
        console.error('[EditorStore] Failed to read file:', result.error);
        set((state) => updateEditorWorkspace(state, activeSessionId, (current) => ({
          ...current,
          error: result.error || 'Failed to read file',
          isLoading: false,
        })));
        return;
      }

      const content = result.content || '';
      const fileName = normalizedFilePath.split('/').pop() || normalizedFilePath;
      const language = getLanguageFromPath(normalizedFilePath);
      console.log('[EditorStore] Creating new tab, fileName:', fileName, 'language:', language);

      const newTab: EditorTab = {
        id: generateTabId(normalizedFilePath),
        filePath: normalizedFilePath,
        fileName,
        content,
        originalContent: content,
        isDirty: false,
        language,
        lineNumber: normalizedLineNumber,
        // Default to preview mode for markdown files
        isPreviewMode: language === 'markdown',
      };

      console.log('[EditorStore] Setting tab state, isEditorOpen will be true');
      set((state) => updateEditorWorkspace(state, activeSessionId, (current) => ({
        ...current,
        tabs: [...current.tabs, newTab],
        activeTabId: newTab.id,
        isEditorOpen: true,
        isLoading: false,
      })));
      console.log('[EditorStore] Tab created successfully, ID:', newTab.id);

      // Close competing panels (Browser, Extensions, Plan) when opening editor
      // Import dynamically to avoid circular dependency
      console.log('[EditorStore] Closing competing panels');
      import('./ui.store').then(({ useUIStore }) => {
        useUIStore.getState().prepareSessionForEditor(activeSessionId);
        console.log('[EditorStore] Competing panels closed');
      });
    } catch (error) {
      console.error('[EditorStore] Exception in openFile:', error);
      set((state) => updateEditorWorkspace(state, activeSessionId, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to open file',
        isLoading: false,
      })));
    }
  },

  closeTab: (tabId: string) => {
    set(state => updateEditorWorkspace(state, state.activeSessionId, (workspace) => {
      const newTabs = workspace.tabs.filter(tab => tab.id !== tabId);
      let newActiveTabId = workspace.activeTabId;

      // If we closed the active tab, activate another one
      if (workspace.activeTabId === tabId) {
        const closedIndex = workspace.tabs.findIndex(tab => tab.id === tabId);
        if (newTabs.length > 0) {
          // Prefer the tab to the left, or the first tab if we closed the leftmost
          newActiveTabId = newTabs[Math.max(0, closedIndex - 1)]?.id || newTabs[0]?.id || null;
        } else {
          newActiveTabId = null;
        }
      }

      return {
        ...workspace,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        isEditorOpen: newTabs.length > 0,
      };
    }));
  },

  closeAllTabs: () => {
    set((state) => updateEditorWorkspace(state, state.activeSessionId, (workspace) => ({
      ...workspace,
      tabs: [],
      activeTabId: null,
      isEditorOpen: false,
    })));
  },

  setActiveTab: (tabId: string) => {
    set((state) => updateEditorWorkspace(state, state.activeSessionId, (workspace) => ({
      ...workspace,
      activeTabId: tabId,
    })));
  },

  updateTabContent: (tabId: string, content: string) => {
    set(state => updateEditorWorkspace(state, state.activeSessionId, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map(tab => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          content,
          isDirty: content !== tab.originalContent,
        };
      }),
    })));
  },

  saveTab: async (tabId: string) => {
    if (!hasElectronAPI) {
      set({ error: 'File operations not available in preview mode' });
      return false;
    }
    const sessionId = get().activeSessionId;
    const tabs = sessionId ? getEditorWorkspace(get(), sessionId).tabs : get().tabs;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return false;

    try {
      // Pass sessionId so SSH sessions write to the remote machine
      const result = await window.electronAPI.fs.writeFile(tab.filePath, tab.content, sessionId || undefined);

      if (!result.success) {
        set((state) => updateEditorWorkspace(state, sessionId, (workspace) => ({
          ...workspace,
          error: result.error || 'Failed to save file',
        })));
        return false;
      }

      set(state => updateEditorWorkspace(state, sessionId, (workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map(t => {
          if (t.id !== tabId) return t;
          return {
            ...t,
            originalContent: t.content,
            isDirty: false,
          };
        }),
        error: null,
      })));

      return true;
    } catch (error) {
      set((state) => updateEditorWorkspace(state, sessionId, (workspace) => ({
        ...workspace,
        error: error instanceof Error ? error.message : 'Failed to save file',
      })));
      return false;
    }
  },

  saveAllTabs: async () => {
    const state = get();
    const tabs = state.activeSessionId ? getEditorWorkspace(state, state.activeSessionId).tabs : state.tabs;
    const { saveTab } = state;
    const dirtyTabs = tabs.filter(tab => tab.isDirty);
    await Promise.all(dirtyTabs.map(tab => saveTab(tab.id)));
  },

  openPlan: (planContent: string, requestId: string) => {
    console.log('[EditorStore] openPlan called, requestId:', requestId);

    const planTab: EditorTab = {
      id: `plan-${requestId}`,
      filePath: `plan://${requestId}`,
      fileName: 'Plan (Awaiting Approval)',
      content: planContent,
      originalContent: planContent,
      isDirty: false,
      language: 'markdown',
      isPreviewMode: true,  // Always show plans in preview
      isPlanTab: true,
      planRequestId: requestId,
    };

    const sessionId = get().activeSessionId;
    set(state => updateEditorWorkspace(state, sessionId, (workspace) => ({
      ...workspace,
      tabs: [...workspace.tabs.filter(t => !t.isPlanTab), planTab],
      activeTabId: planTab.id,
      isEditorOpen: true,
    })));

    // Close competing panels
    import('./ui.store').then(({ useUIStore }) => {
      useUIStore.getState().prepareSessionForEditor(sessionId || undefined);
    });
  },

  closeEditor: () => {
    set((state) => updateEditorWorkspace(state, state.activeSessionId, (workspace) => ({
      ...workspace,
      isEditorOpen: false,
    })));
  },

  openEditor: () => {
    const sessionId = get().activeSessionId;
    set((state) => updateEditorWorkspace(state, sessionId, (workspace) => ({
      ...workspace,
      isEditorOpen: true,
    })));
    // Close competing panels when manually opening editor
    // Import dynamically to avoid circular dependency
    import('./ui.store').then(({ useUIStore }) => {
      useUIStore.getState().prepareSessionForEditor(sessionId || undefined);
    });
  },

  closeEditorForSession: (sessionId) => {
    set((state) => updateEditorWorkspace(state, sessionId, (workspace) => ({
      ...workspace,
      isEditorOpen: false,
    })));
  },

  setActiveSession: (sessionId) => {
    set((state) => ({
      activeSessionId: sessionId,
      ...(sessionId ? getEditorWorkspace(state, sessionId) : emptyEditorWorkspace()),
    }));
  },

  cleanupSession: (sessionId) => {
    set((state) => {
      const sessionWorkspaces = { ...state.sessionWorkspaces };
      delete sessionWorkspaces[sessionId];
      return {
        sessionWorkspaces,
        ...(state.activeSessionId === sessionId
          ? { activeSessionId: null, ...emptyEditorWorkspace() }
          : {}),
      };
    });
  },

  togglePreviewMode: (tabId: string) => {
    set(state => updateEditorWorkspace(state, state.activeSessionId, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, isPreviewMode: !tab.isPreviewMode }
          : tab
      ),
    })));
  },

  // Quick Search actions
  openQuickSearch: () => {
    set({ isQuickSearchOpen: true, isFileSearchOpen: false });
  },

  closeQuickSearch: () => {
    set({ isQuickSearchOpen: false });
  },

  toggleQuickSearch: () => {
    set(state => ({ isQuickSearchOpen: !state.isQuickSearchOpen, isFileSearchOpen: false }));
  },

  // File Content Search actions
  openFileSearch: () => {
    set({ isFileSearchOpen: true, isQuickSearchOpen: false });
  },

  closeFileSearch: () => {
    set({ isFileSearchOpen: false });
  },

  toggleFileSearch: () => {
    set(state => ({ isFileSearchOpen: !state.isFileSearchOpen, isQuickSearchOpen: false }));
  },
}));
