import React, { useEffect, useRef, useCallback } from 'react';
import Editor, { OnMount, OnChange, BeforeMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Save, FileText, Circle, Loader2, Eye, Edit3 } from 'lucide-react';
import { useEditorStore } from '../../stores/editor.store';
import { useUIStore } from '../../stores/ui.store';
import { useSessionStore } from '../../stores/session.store';

// Track created model URIs for proper cleanup
const createdModelUris = new Set<string>();
const PRIMARY_MODIFIER_KEY: 'metaKey' | 'ctrlKey' = /mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';

interface EditorPanelProps {
  onClose?: () => void;
}

export default function EditorPanel({ onClose }: EditorPanelProps) {
  const {
    tabs,
    activeTabId,
    isLoading,
    error,
    closeTab,
    setActiveTab,
    updateTabContent,
    saveTab,
    closeEditor,
    togglePreviewMode,
  } = useEditorStore();

  const setHtmlArtifact = useUIStore((s) => s.setHtmlArtifact);
  const showHtmlPanel = useUIStore((s) => s.showHtmlPanel);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const editorRef = useRef<unknown>(null);
  const activeTab = tabs.find(tab => tab.id === activeTabId);

  // Auto-open HTML preview panel when an HTML file is opened
  React.useEffect(() => {
    if (activeTab?.language === 'html' && activeSessionId) {
      setHtmlArtifact(activeSessionId, {
        html: activeTab.content,
        messageId: `editor-${activeTab.id}`,
        title: activeTab.fileName,
      });
      showHtmlPanel();
    }
  }, [activeTab?.id, activeTab?.language]);

  const handleClose = () => {
    closeEditor();
    onClose?.();
  };

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const primaryModifierPressed = e[PRIMARY_MODIFIER_KEY];

      // Cmd/Ctrl + S to save
      if (primaryModifierPressed && e.key === 's') {
        e.preventDefault();
        if (activeTabId) {
          saveTab(activeTabId);
        }
      }
      // Cmd/Ctrl + W to close tab
      if (primaryModifierPressed && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          closeTab(activeTabId);
        }
      }
      // Escape to close editor
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, saveTab, closeTab]);

  useEffect(() => {
    const handleShortcut = (event: Event) => {
      const action = (event as CustomEvent<{ action: string }>).detail?.action;
      if (action === 'save' && activeTabId) {
        saveTab(activeTabId);
      }
      if (action === 'close-tab' && activeTabId) {
        closeTab(activeTabId);
      }
    };

    window.addEventListener('grep-shortcut', handleShortcut as EventListener);
    return () => window.removeEventListener('grep-shortcut', handleShortcut as EventListener);
  }, [activeTabId, saveTab, closeTab]);

  // Jump to line number when tab changes or opens with lineNumber
  useEffect(() => {
    if (activeTab?.lineNumber && editorRef.current) {
      const editor = editorRef.current as { revealLineInCenter: (line: number) => void; setPosition: (pos: { lineNumber: number; column: number }) => void };
      setTimeout(() => {
        editor.revealLineInCenter(activeTab.lineNumber!);
        editor.setPosition({ lineNumber: activeTab.lineNumber!, column: 1 });
      }, 100);
    }
  }, [activeTab?.id, activeTab?.lineNumber]);

  // Track previous tabs to detect closed tabs and dispose their models
  const prevTabsRef = useRef<typeof tabs>([]);

  useEffect(() => {
    const prevTabs = prevTabsRef.current;
    const currentFilePaths = new Set(tabs.map(t => t.filePath));

    // Find tabs that were closed
    const closedTabs = prevTabs.filter(t => !currentFilePaths.has(t.filePath));

    if (closedTabs.length > 0) {
      // Dispose models for closed tabs
      loader.init().then((monacoInstance) => {
        closedTabs.forEach(closedTab => {
          const models = monacoInstance.editor.getModels();
          models.forEach((model: monaco.editor.ITextModel) => {
            // Check if model matches the closed tab's file path
            if (model.uri.path === closedTab.filePath || model.uri.path.endsWith(closedTab.filePath)) {
              console.log('[EditorPanel] Disposing model for closed tab:', model.uri.toString());
              createdModelUris.delete(model.uri.toString());
              model.dispose();
            }
          });
        });
      }).catch(() => undefined);
    }

    prevTabsRef.current = tabs;
  }, [tabs]);

  // Cleanup all Monaco models when component unmounts to prevent listener leaks
  useEffect(() => {
    return () => {
      // Get Monaco instance and dispose all tracked models
      loader.init().then((monacoInstance) => {
        const models = monacoInstance.editor.getModels();
        models.forEach((model: monaco.editor.ITextModel) => {
          // Only dispose models we created (tracked by URI)
          if (createdModelUris.has(model.uri.toString())) {
            model.dispose();
            createdModelUris.delete(model.uri.toString());
          }
        });
      }).catch(() => {
        // Monaco not initialized, nothing to clean up
      });
    };
  }, []);

  // Configure Monaco before mounting
  const handleBeforeMount: BeforeMount = useCallback((monacoInstance) => {
    // Log model count for debugging (only if there are many)
    const modelCount = monacoInstance.editor.getModels().length;
    if (modelCount > 20) {
      console.log('[EditorPanel] Model count:', modelCount);
    }
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    // Track the model URI for cleanup
    const model = editor.getModel();
    if (model) {
      const uri = model.uri.toString();
      createdModelUris.add(uri);
      console.log('[EditorPanel] Tracking model:', uri, '- Total tracked:', createdModelUris.size);
    }

    // Jump to line if specified
    if (activeTab?.lineNumber) {
      setTimeout(() => {
        editor.revealLineInCenter(activeTab.lineNumber!);
        editor.setPosition({ lineNumber: activeTab.lineNumber!, column: 1 });
      }, 100);
    }
  }, [activeTab?.lineNumber]);

  const handleEditorChange: OnChange = useCallback((value) => {
    if (activeTabId && value !== undefined) {
      updateTabContent(activeTabId, value);
    }
  }, [activeTabId, updateTabContent]);

  const handleTabClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  const handleSave = () => {
    if (activeTabId) {
      saveTab(activeTabId);
    }
  };

  return (
    <div className="h-full flex flex-col bg-claude-bg">
      {/* Header with tabs */}
      <div className="flex items-center justify-between bg-claude-surface border-b border-claude-border">
        {/* Tabs */}
        <div className="flex-1 flex items-center overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-mono border-r border-claude-border transition-colors ${
                tab.id === activeTabId
                  ? 'bg-claude-bg text-claude-text'
                  : 'bg-claude-surface text-claude-text-secondary hover:bg-claude-bg/50'
              }`}
            >
              <FileText size={14} className="flex-shrink-0" />
              <span className="truncate max-w-[150px]">{tab.fileName}</span>
              {tab.isDirty && (
                <Circle size={8} className="fill-claude-accent text-claude-accent flex-shrink-0" />
              )}
              <button
                onClick={(e) => handleTabClose(e, tab.id)}
                className="ml-1 p-0.5 hover:bg-claude-surface rounded"
              >
                <X size={12} />
              </button>
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-3">
          {/* Preview/Edit toggle for markdown files */}
          {activeTab?.language === 'markdown' && (
            <button
              onClick={() => activeTab && togglePreviewMode(activeTab.id)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-mono bg-claude-surface hover:bg-claude-bg text-claude-text transition-colors"
              title={activeTab.isPreviewMode ? "Switch to Edit Mode" : "Switch to Preview Mode"}
            >
              {activeTab.isPreviewMode ? (
                <>
                  <Edit3 size={12} />
                  EDIT
                </>
              ) : (
                <>
                  <Eye size={12} />
                  PREVIEW
                </>
              )}
            </button>
          )}
          {/* HTML preview opens in the HTML preview panel */}
          {activeTab?.language === 'html' && (
            <button
              onClick={() => {
                if (!activeTab || !activeSessionId) return;
                setHtmlArtifact(activeSessionId, {
                  html: activeTab.content,
                  messageId: `editor-${activeTab.id}`,
                  title: activeTab.fileName,
                });
                showHtmlPanel();
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs font-mono bg-claude-surface hover:bg-claude-bg text-claude-text transition-colors"
              title="Open HTML Preview"
            >
              <Eye size={12} />
              PREVIEW
            </button>
          )}
          {activeTab?.isDirty && (
            <button
              onClick={handleSave}
              className="flex items-center gap-1 px-2 py-1 text-xs font-mono bg-claude-accent text-white hover:bg-claude-accent/80 transition-colors"
              title="Save (Cmd+S)"
            >
              <Save size={12} />
              SAVE
            </button>
          )}
          {activeTab && (
            <button
              onClick={() => window.electronAPI.app.openPath(activeTab.filePath)}
              className="p-1.5 hover:bg-claude-surface rounded transition-colors"
              title="Open in external editor"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </button>
          )}
          <button
            onClick={handleClose}
            className="p-1.5 hover:bg-claude-surface rounded transition-colors"
            title="Close Editor (Esc)"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* File path breadcrumb */}
      {activeTab && (
        <div className="px-3 py-1.5 bg-claude-surface/50 border-b border-claude-border">
          <span className="text-xs font-mono text-claude-text-secondary">
            {activeTab.filePath}
          </span>
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 relative overflow-hidden">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-claude-accent" />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-red-400 font-mono text-sm">{error}</p>
              <button
                onClick={handleClose}
                className="mt-4 px-4 py-2 bg-claude-surface text-claude-text text-sm font-mono hover:bg-claude-surface/80"
                style={{ borderRadius: 0 }}
              >
                Close
              </button>
            </div>
          </div>
        ) : activeTab ? (
          // Show image preview for image files
          /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(activeTab.filePath) ? (
            <div className="flex-1 overflow-auto flex items-center justify-center bg-claude-bg p-4">
              <img
                src={activeTab.content}
                alt={activeTab.fileName}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) :
          // Show markdown preview or Monaco editor based on mode
          activeTab.isPreviewMode && activeTab.language === 'markdown' ? (
            <div className="absolute inset-0 overflow-auto p-6 bg-claude-bg">
              <div className="max-w-4xl mx-auto prose prose-invert prose-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeTab.content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <Editor
              // NOTE: Do NOT use key prop here - it forces remount and causes model leaks
              // Monaco handles model switching internally via the path prop
              height="100%"
              path={activeTab.filePath} // Monaco uses this for model management
              language={activeTab.language}
              value={activeTab.content}
              theme="vs-dark"
              beforeMount={handleBeforeMount}
              onMount={handleEditorMount}
              onChange={handleEditorChange}
              keepCurrentModel={true} // Keep models alive for tab switching (cleaner than remounting)
              saveViewState={true} // Preserve view state for tab switching
              options={{
                fontSize: 13,
                fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
                lineNumbers: 'on',
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                insertSpaces: true,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
              folding: true,
              foldingHighlight: true,
              showFoldingControls: 'mouseover',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 10 },
              suggest: {
                showKeywords: true,
                showSnippets: true,
              },
              quickSuggestions: {
                other: true,
                comments: false,
                strings: false,
              },
            }}
          />
          )
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-claude-text-secondary">
            <p className="font-mono text-sm">No file open</p>
          </div>
        )}
      </div>

      {/* Status bar */}
      {activeTab && (
        <div className="flex items-center justify-between px-3 py-1 bg-claude-surface border-t border-claude-border text-xs font-mono text-claude-text-secondary">
          <div className="flex items-center gap-4">
            <span>{activeTab.language.toUpperCase()}</span>
            <span>UTF-8</span>
          </div>
          <div className="flex items-center gap-4">
            {activeTab.isDirty && <span className="text-claude-accent">Modified</span>}
            <span>Ln {activeTab.lineNumber || 1}</span>
          </div>
        </div>
      )}
    </div>
  );
}
