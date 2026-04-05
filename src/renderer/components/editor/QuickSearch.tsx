import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Search,
  FileText,
  Hash,
  X,
  Loader2,
  FolderOpen,
  Terminal,
  Globe,
  GitBranch,
  Settings,
  PanelLeftClose,
  Brain,
  Shield,
  Zap,
  Command,
  RotateCcw,
  Layout,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editor.store';
import { useSessionStore, PermissionMode, ThinkingMode, getSupportedPermissionModes, isCodexModel, normalizePermissionModeForModel } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';

interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'folder';
  extension?: string;
}

interface SymbolEntry {
  name: string;
  kind: string;
  path: string;
  relativePath: string;
  lineNumber: number;
  detail: string;
}

interface CommandEntry {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  category: 'view' | 'agent' | 'git' | 'settings';
  shortcut?: string;
  action: () => void;
}

type SearchMode = 'all' | 'files' | 'symbols' | 'commands';

interface SearchResult {
  type: 'file' | 'symbol' | 'command';
  id: string;
  name: string;
  path?: string;
  relativePath?: string;
  detail?: string;
  lineNumber?: number;
  icon: React.ReactNode;
  shortcut?: string;
  action?: () => void;
}

export default function QuickSearch() {
  const { isQuickSearchOpen, closeQuickSearch, openFile } = useEditorStore();
  const { activeSessionId, sessions, permissionMode, thinkingMode, selectedModel, cyclePermissionMode, setPermissionMode, cycleThinkingMode, setThinkingMode } = useSessionStore();
  const {
    toggleSidebar,
    toggleTerminalPanel,
    toggleBrowserPanel,
    toggleGitPanel,
    openSettings,
    isTerminalPanelOpen,
    isBrowserPanelOpen,
    isGitPanelOpen,
    isSidebarOpen,
    cycleSplitRatio,
  } = useUIStore();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [allFiles, setAllFiles] = useState<FileEntry[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>('all');

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Define all available commands
  const commands = useMemo((): CommandEntry[] => {
    const currentModel = activeSessionId
      ? (selectedModel[activeSessionId] || sessions.find((session) => session.id === activeSessionId)?.model)
      : undefined;
    const isCodexSession = isCodexModel(currentModel);
    const supportedPermissionModes = getSupportedPermissionModes(currentModel);
    const currentPermissionMode = activeSessionId
      ? normalizePermissionModeForModel(currentModel, permissionMode[activeSessionId])
      : 'acceptEdits';
    const currentThinkingMode = activeSessionId ? (thinkingMode[activeSessionId] || 'thinking') : 'thinking';

    const permissionModeLabels: Record<PermissionMode, string> = {
      'acceptEdits': 'Accept Edits',
      'default': 'Default',
      'bypassPermissions': 'Just Build It',
      'plan': 'Plan Mode',
      'dontAsk': "Don't Ask",
    };

    const thinkingModeLabels: Record<ThinkingMode, string> = {
      // Legacy values (for backward compatibility)
      'off': 'Low',
      'thinking': 'Medium',
      'ultrathink': 'High',
      // New effort levels
      'low': 'Low',
      'medium': 'Medium',
      'high': 'High',
      'max': 'Max',
    };

    const permissionCommands: CommandEntry[] = [
      {
        id: 'cycle-permission-mode',
        label: 'Cycle Permission Mode',
        description: `Current: ${permissionModeLabels[currentPermissionMode]}`,
        icon: <Shield size={16} />,
        category: 'agent',
        shortcut: '⌘⇧M',
        action: () => activeSessionId && cyclePermissionMode(activeSessionId),
      },
      ...(supportedPermissionModes.includes('acceptEdits') ? [{
        id: 'set-permission-accept-edits',
        label: 'Set Permission: Accept Edits',
        description: isCodexSession ? 'Codex can edit inside the workspace without prompting' : 'Auto-accept file edits from Claude',
        icon: <Shield size={16} className="text-green-400" />,
        category: 'agent' as const,
        shortcut: '⌘1',
        action: () => activeSessionId && setPermissionMode(activeSessionId, 'acceptEdits'),
      }] : []),
      ...(supportedPermissionModes.includes('default') ? [{
        id: 'set-permission-default',
        label: 'Set Permission: Default',
        description: 'Ask for confirmation on file edits',
        icon: <Shield size={16} className="text-yellow-400" />,
        category: 'agent' as const,
        shortcut: '⌘2',
        action: () => activeSessionId && setPermissionMode(activeSessionId, 'default'),
      }] : []),
      ...(supportedPermissionModes.includes('plan') ? [{
        id: 'set-permission-plan',
        label: 'Set Permission: Plan Mode',
        description: isCodexSession ? 'Codex stays read-only and returns a plan' : 'Claude will only plan, not execute',
        icon: <Shield size={16} className="text-blue-400" />,
        category: 'agent' as const,
        shortcut: '⌘3',
        action: () => activeSessionId && setPermissionMode(activeSessionId, 'plan'),
      }] : []),
    ];

    return [
      // View commands
      {
        id: 'toggle-sidebar',
        label: 'Toggle Sidebar',
        description: isSidebarOpen ? 'Hide sidebar' : 'Show sidebar',
        icon: <PanelLeftClose size={16} />,
        category: 'view',
        shortcut: '⌘B',
        action: toggleSidebar,
      },
      {
        id: 'toggle-terminal',
        label: 'Toggle Terminal',
        description: isTerminalPanelOpen ? 'Hide terminal panel' : 'Show terminal panel',
        icon: <Terminal size={16} />,
        category: 'view',
        shortcut: '⌘J',
        action: toggleTerminalPanel,
      },
      {
        id: 'toggle-browser',
        label: 'Toggle Browser Preview',
        description: isBrowserPanelOpen ? 'Hide browser panel' : 'Show browser panel',
        icon: <Globe size={16} />,
        category: 'view',
        shortcut: '⌘⇧P',
        action: toggleBrowserPanel,
      },
      {
        id: 'toggle-git',
        label: 'Toggle Git Panel',
        description: isGitPanelOpen ? 'Hide git panel' : 'Show git panel',
        icon: <GitBranch size={16} />,
        category: 'view',
        shortcut: '⌘⇧G',
        action: toggleGitPanel,
      },
      {
        id: 'cycle-layout',
        label: 'Cycle Split Layout',
        description: 'Toggle between equal, main-focus, and side-focus layouts',
        icon: <Layout size={16} />,
        category: 'view',
        shortcut: '⌘\\',
        action: cycleSplitRatio,
      },
      {
        id: 'open-settings',
        label: 'Open Settings',
        description: 'Open application settings',
        icon: <Settings size={16} />,
        category: 'settings',
        shortcut: '⌘,',
        action: openSettings,
      },

      // Agent mode commands
      ...permissionCommands,

      // Effort level commands (formerly thinking mode)
      {
        id: 'cycle-effort-level',
        label: 'Cycle Effort Level',
        description: `Current: ${thinkingModeLabels[currentThinkingMode] || 'High'}`,
        icon: <Brain size={16} />,
        category: 'agent',
        shortcut: '⌘⇧T',
        action: () => activeSessionId && cycleThinkingMode(activeSessionId),
      },
      {
        id: 'set-effort-low',
        label: 'Set Effort: Low',
        description: 'Fast & efficient - minimal thinking',
        icon: <Brain size={16} className="text-gray-400" />,
        category: 'agent',
        shortcut: '⌘⇧1',
        action: () => activeSessionId && setThinkingMode(activeSessionId, 'low'),
      },
      {
        id: 'set-effort-medium',
        label: 'Set Effort: Medium',
        description: 'Balanced - moderate thinking (10k tokens)',
        icon: <Brain size={16} className="text-blue-400" />,
        category: 'agent',
        shortcut: '⌘⇧2',
        action: () => activeSessionId && setThinkingMode(activeSessionId, 'medium'),
      },
      {
        id: 'set-effort-high',
        label: 'Set Effort: High',
        description: 'Full capability - deep thinking (default)',
        icon: <Brain size={16} className="text-purple-400" />,
        category: 'agent',
        shortcut: '⌘⇧3',
        action: () => activeSessionId && setThinkingMode(activeSessionId, 'high'),
      },
      {
        id: 'set-effort-max',
        label: 'Set Effort: Max',
        description: 'Maximum capability (Opus 4.6 only)',
        icon: <Zap size={16} className="text-pink-400" />,
        category: 'agent',
        shortcut: '⌘⇧4',
        action: () => activeSessionId && setThinkingMode(activeSessionId, 'max'),
      },

      // Git commands (placeholders for now)
      {
        id: 'git-commit',
        label: 'Git: Commit',
        description: 'Create a new commit',
        icon: <GitBranch size={16} className="text-orange-400" />,
        category: 'git',
        shortcut: '⌘⏎',
        action: () => {
          toggleGitPanel();
          closeQuickSearch();
        },
      },
      {
        id: 'git-push',
        label: 'Git: Push',
        description: 'Push changes to remote',
        icon: <GitBranch size={16} className="text-green-400" />,
        category: 'git',
        shortcut: '⌘⇧U',
        action: () => {
          toggleGitPanel();
          closeQuickSearch();
        },
      },
      {
        id: 'git-pull',
        label: 'Git: Pull',
        description: 'Pull changes from remote',
        icon: <GitBranch size={16} className="text-blue-400" />,
        category: 'git',
        shortcut: '⌘⇧D',
        action: () => {
          toggleGitPanel();
          closeQuickSearch();
        },
      },
    ];
  }, [
    activeSessionId,
    sessions,
    permissionMode,
    thinkingMode,
    selectedModel,
    isSidebarOpen,
    isTerminalPanelOpen,
    isBrowserPanelOpen,
    isGitPanelOpen,
    toggleSidebar,
    toggleTerminalPanel,
    toggleBrowserPanel,
    toggleGitPanel,
    openSettings,
    cycleSplitRatio,
    cyclePermissionMode,
    setPermissionMode,
    cycleThinkingMode,
    setThinkingMode,
    closeQuickSearch,
  ]);

  // Determine search mode based on prefix
  useEffect(() => {
    if (query.startsWith('>')) {
      setSearchMode('commands');
    } else if (query.startsWith('@')) {
      setSearchMode('symbols');
    } else if (query.startsWith('/')) {
      setSearchMode('files');
    } else {
      setSearchMode('all');
    }
  }, [query]);

  // Load files when opened
  useEffect(() => {
    console.log('[QuickSearch] Effect triggered - isOpen:', isQuickSearchOpen, 'activeSessionId:', activeSessionId);
    if (isQuickSearchOpen && activeSessionId) {
      setIsLoading(true);
      console.log('[QuickSearch] Loading files for session:', activeSessionId);
      window.electronAPI.fs.listFiles(activeSessionId)
        .then((files) => {
          console.log('[QuickSearch] Loaded', files.length, 'files from session', activeSessionId);
          console.log('[QuickSearch] Sample files:', files.slice(0, 5).map(f => f.relativePath));
          setAllFiles(files);
          setIsLoading(false);
        })
        .catch((error) => {
          console.error('[QuickSearch] Failed to load files for session', activeSessionId, ':', error);
          console.error('[QuickSearch] Error details:', error.message, error.stack);
          setAllFiles([]); // Ensure we clear stale data
          setIsLoading(false);
        });
    } else if (isQuickSearchOpen && !activeSessionId) {
      console.warn('[QuickSearch] ⚠️  No active session - file search will be empty. Please create or select a session.');
      setAllFiles([]);
    }
  }, [isQuickSearchOpen, activeSessionId]);

  // Focus input when opened
  useEffect(() => {
    if (isQuickSearchOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isQuickSearchOpen]);

  // Filter results based on query and mode
  const filteredResults = useMemo(() => {
    const results: SearchResult[] = [];
    const searchQuery = query.replace(/^[>@/]/, '').toLowerCase().trim();

    // Add commands - always search commands in 'all' mode or 'commands' mode
    if (searchMode === 'commands' || searchMode === 'all') {
      const filteredCommands = commands.filter(cmd => {
        if (!searchQuery) return true;
        return (
          cmd.label.toLowerCase().includes(searchQuery) ||
          cmd.description.toLowerCase().includes(searchQuery) ||
          cmd.category.toLowerCase().includes(searchQuery)
        );
      });

      // When no query in 'all' mode, only show a few commands
      // When there's a query, show all matching commands
      const commandsToShow = (!searchQuery && searchMode === 'all')
        ? filteredCommands.slice(0, 5)
        : filteredCommands;

      commandsToShow.forEach(cmd => {
        results.push({
          type: 'command',
          id: cmd.id,
          name: cmd.label,
          detail: cmd.description,
          icon: cmd.icon,
          shortcut: cmd.shortcut,
          action: cmd.action,
        });
      });
    }

    // Add files
    if (searchMode === 'files' || searchMode === 'all') {
      const fileResults = allFiles
        .filter(f => {
          if (f.type !== 'file') return false;
          if (!searchQuery) return true;
          const name = f.name.toLowerCase();
          const path = f.relativePath.toLowerCase();

          // Check for fuzzy match
          if (name.includes(searchQuery) || path.includes(searchQuery)) {
            return true;
          }

          // Check for initials match (e.g., "qs" matches "QuickSearch")
          const initials = f.name
            .split(/[-_./]/)
            .map(part => part[0]?.toLowerCase())
            .join('');
          if (initials.includes(searchQuery)) {
            return true;
          }

          return false;
        })
        .slice(0, searchMode === 'all' ? 10 : 20);

      // Sort by relevance (exact name match first, then path match)
      fileResults.sort((a, b) => {
        if (!searchQuery) return 0;
        const aNameMatch = a.name.toLowerCase().startsWith(searchQuery);
        const bNameMatch = b.name.toLowerCase().startsWith(searchQuery);
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
        return a.relativePath.length - b.relativePath.length;
      });

      fileResults.forEach(f => {
        results.push({
          type: 'file',
          id: f.path,
          name: f.name,
          path: f.path,
          relativePath: f.relativePath,
          icon: <FileText size={16} className="text-blue-400" />,
        });
      });
    }

    // Add symbol search (async, handled separately)
    // Symbols are loaded via useEffect below

    return results;
  }, [query, searchMode, allFiles, commands]);

  // Async symbol search
  useEffect(() => {
    if (searchMode !== 'symbols' || !activeSessionId) return;

    const searchQuery = query.replace(/^@/, '').trim();
    if (searchQuery.length < 2) {
      setResults(filteredResults);
      return;
    }

    setIsLoading(true);
    window.electronAPI.fs.searchSymbols(activeSessionId, searchQuery)
      .then((symbols: SymbolEntry[]) => {
        const symbolResults: SearchResult[] = symbols.map(s => ({
          type: 'symbol' as const,
          id: `${s.path}:${s.lineNumber}`,
          name: s.name,
          path: s.path,
          relativePath: s.relativePath,
          detail: `${s.kind} - ${s.detail}`,
          lineNumber: s.lineNumber,
          icon: <Hash size={16} className="text-purple-400" />,
        }));
        setResults([...filteredResults, ...symbolResults]);
        setIsLoading(false);
      })
      .catch((error) => {
        console.error('Failed to search symbols:', error);
        setResults(filteredResults);
        setIsLoading(false);
      });
  }, [query, searchMode, activeSessionId, filteredResults]);

  // Update results when filtered results change (non-symbol modes)
  useEffect(() => {
    if (searchMode !== 'symbols') {
      setResults(filteredResults);
      setSelectedIndex(0);
    }
  }, [filteredResults, searchMode]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeQuickSearch();
        break;
      case 'Tab':
        e.preventDefault();
        // Cycle through search modes
        if (e.shiftKey) {
          setQuery(prev => {
            if (prev.startsWith('>')) return '@' + prev.slice(1);
            if (prev.startsWith('@')) return '/' + prev.slice(1);
            if (prev.startsWith('/')) return prev.slice(1);
            return '>' + prev;
          });
        } else {
          setQuery(prev => {
            if (prev.startsWith('>')) return prev.slice(1);
            if (prev.startsWith('@')) return '>' + prev.slice(1);
            if (prev.startsWith('/')) return '@' + prev.slice(1);
            return '/' + prev;
          });
        }
        break;
    }
  }, [results, selectedIndex, closeQuickSearch]);

  // Handle selection
  const handleSelect = useCallback((result: SearchResult) => {
    if (result.type === 'command' && result.action) {
      result.action();
      closeQuickSearch();
    } else if (result.type === 'file' || result.type === 'symbol') {
      if (result.path) {
        openFile(result.path, result.lineNumber);
      }
      closeQuickSearch();
    }
  }, [openFile, closeQuickSearch]);

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current) {
      const selectedElement = resultsRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  // Handle click outside to close
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeQuickSearch();
    }
  }, [closeQuickSearch]);

  // Get placeholder text based on mode
  const getPlaceholder = () => {
    switch (searchMode) {
      case 'commands':
        return 'Type a command...';
      case 'symbols':
        return 'Search symbols...';
      case 'files':
        return 'Search files...';
      default:
        return 'Search files, symbols, or commands...';
    }
  };

  // Get mode indicator
  const getModeIndicator = () => {
    switch (searchMode) {
      case 'commands':
        return <span className="text-xs text-purple-400 bg-purple-400/20 px-1.5 py-0.5 rounded">Commands</span>;
      case 'symbols':
        return <span className="text-xs text-blue-400 bg-blue-400/20 px-1.5 py-0.5 rounded">Symbols</span>;
      case 'files':
        return <span className="text-xs text-green-400 bg-green-400/20 px-1.5 py-0.5 rounded">Files</span>;
      default:
        return null;
    }
  };

  if (!isQuickSearchOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={handleBackdropClick}
    >
      <div className="w-[600px] max-w-[90vw] bg-claude-surface border border-claude-border shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-claude-border">
          <Command size={18} className="text-claude-text-secondary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder()}
            className="flex-1 bg-transparent text-claude-text text-sm font-mono outline-none placeholder:text-claude-text-secondary"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {getModeIndicator()}
          {isLoading && <Loader2 size={16} className="text-claude-accent animate-spin" />}
          <button
            onClick={closeQuickSearch}
            className="p-1 hover:bg-claude-bg rounded transition-colors"
          >
            <X size={16} className="text-claude-text-secondary" />
          </button>
        </div>

        {/* Results */}
        <div
          ref={resultsRef}
          className="max-h-[400px] overflow-y-auto"
        >
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-claude-text-secondary text-sm">
              {query.trim() ? 'No results found' : (
                <div className="space-y-2">
                  <p>Type to search...</p>
                  <div className="flex justify-center gap-4 text-xs">
                    <span><kbd className="px-1 bg-claude-bg rounded">&gt;</kbd> commands</span>
                    <span><kbd className="px-1 bg-claude-bg rounded">@</kbd> symbols</span>
                    <span><kbd className="px-1 bg-claude-bg rounded">/</kbd> files</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                onClick={() => handleSelect(result)}
                className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                  index === selectedIndex
                    ? 'bg-claude-accent/20 text-claude-text'
                    : 'text-claude-text-secondary hover:bg-claude-bg/50'
                }`}
              >
                <span className="flex-shrink-0">{result.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm truncate">
                    {result.name}
                  </div>
                  {result.detail && (
                    <div className="text-xs text-claude-text-secondary truncate">
                      {result.relativePath && `${result.relativePath} - `}
                      {result.detail}
                    </div>
                  )}
                  {!result.detail && result.relativePath && (
                    <div className="text-xs text-claude-text-secondary truncate">
                      {result.relativePath}
                    </div>
                  )}
                </div>
                {result.shortcut && (
                  <span className="text-xs text-claude-text-secondary bg-claude-bg px-1.5 py-0.5 rounded">
                    {result.shortcut}
                  </span>
                )}
                {result.lineNumber && (
                  <span className="text-xs text-claude-text-secondary">
                    :{result.lineNumber}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer with hints */}
        <div className="px-4 py-2 border-t border-claude-border text-[10px] text-claude-text-secondary flex items-center gap-4">
          <span><kbd className="px-1 bg-claude-bg rounded">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 bg-claude-bg rounded">↵</kbd> select</span>
          <span><kbd className="px-1 bg-claude-bg rounded">tab</kbd> switch mode</span>
          <span><kbd className="px-1 bg-claude-bg rounded">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
