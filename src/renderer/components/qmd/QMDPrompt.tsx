import React, { useState, useEffect, useCallback } from 'react';
import { Search, X, Check, Loader2 } from 'lucide-react';

interface QMDPromptRequest {
  sessionId: string;
  projectPath: string;
}

export default function QMDPrompt() {
  const [promptRequest, setPromptRequest] = useState<QMDPromptRequest | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingMessage, setIndexingMessage] = useState('');

  // Listen for QMD prompt requests from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.qmd.onPromptRequest((data) => {
      console.log('[QMDPrompt] Received prompt request:', data);
      setPromptRequest(data);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Listen for indexing progress
  useEffect(() => {
    if (!isIndexing) return;

    const unsubscribe = window.electronAPI.qmd.onIndexingProgress((data) => {
      console.log('[QMDPrompt] Indexing progress:', data);
      setIndexingMessage(data.message);
    });

    return () => {
      unsubscribe();
    };
  }, [isIndexing]);

  const handleEnable = useCallback(async () => {
    if (!promptRequest) return;

    try {
      setIsIndexing(true);
      setIndexingMessage('Checking QMD installation...');

      // Check if QMD is installed
      const status = await window.electronAPI.qmd.getStatus();

      if (!status.installed) {
        // Auto-install QMD
        setIndexingMessage('Installing QMD (this may take a moment)...');
        const installed = await window.electronAPI.qmd.autoInstall();
        if (!installed) {
          setIndexingMessage('Failed to install QMD');
          setTimeout(() => {
            setPromptRequest(null);
            setIsIndexing(false);
            setIndexingMessage('');
          }, 2000);
          return;
        }
      }

      // Set project preference to enabled
      await window.electronAPI.qmd.setProjectPreference(promptRequest.projectPath, 'enabled');

      setIndexingMessage('Indexing codebase...');

      // Trigger indexing
      const success = await window.electronAPI.qmd.ensureIndexed(promptRequest.projectPath);

      if (success) {
        setIndexingMessage('Setup complete!');
        // Close after a short delay
        setTimeout(() => {
          setPromptRequest(null);
          setIsIndexing(false);
          setIndexingMessage('');
        }, 1000);
      } else {
        setIndexingMessage('Indexing failed');
        setTimeout(() => {
          setPromptRequest(null);
          setIsIndexing(false);
          setIndexingMessage('');
        }, 2000);
      }
    } catch (error) {
      console.error('[QMDPrompt] Failed to enable QMD:', error);
      setIndexingMessage('Failed to enable QMD');
      setTimeout(() => {
        setPromptRequest(null);
        setIsIndexing(false);
        setIndexingMessage('');
      }, 2000);
    }
  }, [promptRequest]);

  const handleDisable = useCallback(async () => {
    if (!promptRequest) return;

    try {
      // Set project preference to disabled
      await window.electronAPI.qmd.setProjectPreference(promptRequest.projectPath, 'disabled');
      setPromptRequest(null);
    } catch (error) {
      console.error('[QMDPrompt] Failed to disable QMD:', error);
      setPromptRequest(null);
    }
  }, [promptRequest]);

  const handleDismiss = useCallback(() => {
    setPromptRequest(null);
    setIsIndexing(false);
    setIndexingMessage('');
  }, []);

  if (!promptRequest) return null;

  // Extract project name from path
  const projectName = promptRequest.projectPath.split('/').pop() || 'this project';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="w-[400px] bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]"
        style={{ borderRadius: 0 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2">
            <Search size={16} className="text-accent" />
            <h2 className="text-[16px] font-semibold tracking-tight text-fg">
              Semantic Search
            </h2>
          </div>
          {!isIndexing && (
            <button
              onClick={handleDismiss}
              className="p-1 text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {isIndexing ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 size={24} className="text-accent animate-spin" />
              <p className="text-[13px] text-fg-2 text-center">
                {indexingMessage}
              </p>
            </div>
          ) : (
            <>
              <p className="text-[14px] text-fg">
                Enable semantic search for <span className="font-mono text-accent-text">{projectName}</span>?
              </p>
              <p className="text-[13px] text-fg-3">
                This allows Claude to search your codebase using natural language queries,
                finding relevant code even when you don't know the exact file names or terms.
              </p>
              <p className="text-[13px] text-fg-3">
                The first indexing may take a moment depending on project size.
              </p>
            </>
          )}
        </div>

        {/* Actions */}
        {!isIndexing && (
          <div className="flex gap-2 px-4 py-3 border-t border-line">
            <button
              onClick={handleDisable}
              className="flex-1 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors"
              style={{ borderRadius: 0 }}
            >
              Not Now
            </button>
            <button
              onClick={handleEnable}
              className="flex-1 flex items-center justify-center gap-2 h-8 px-3 text-[13px] font-semibold text-ink-0 bg-fg hover:bg-white transition-colors"
              style={{ borderRadius: 0 }}
            >
              <Check size={14} />
              Enable
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
