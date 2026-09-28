import React, { useState, useEffect } from 'react';
import { X, Download, Check, Loader2, AlertCircle, Folder } from 'lucide-react';
import type { Session } from '../../../shared/types';

interface DownloadSessionDialogProps {
  session: Session;
  onClose: () => void;
  onSuccess: (newSessionId: string) => void;
}

export default function DownloadSessionDialog({ session, onClose, onSuccess }: DownloadSessionDialogProps) {
  const [localRepoPath, setLocalRepoPath] = useState('');
  const [sessionName, setSessionName] = useState(`${session.name} (Local)`);
  const [branch, setBranch] = useState(session.branch || '');
  const [status, setStatus] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Listen for progress updates
    const unsubscribe = window.electronAPI.ssh.onDownloadProgress((message) => {
      setProgressMessage(message);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleSelectFolder = async () => {
    const result = await window.electronAPI.dev.openLocalRepo();
    if (!result.canceled && result.repoPath) {
      setLocalRepoPath(result.repoPath);
      // If the selected folder has a different branch, update the default
      if (result.branch) {
        setBranch(result.branch);
      }
    }
  };

  const handleDownload = async () => {
    if (!localRepoPath || !sessionName.trim()) {
      return;
    }

    setStatus('downloading');
    setError(null);
    setProgressMessage('Initializing download...');

    try {
      const result = await window.electronAPI.ssh.downloadSession(session.id, {
        localRepoPath,
        sessionName: sessionName.trim(),
        branch: branch || undefined,
      });

      if (result.success && result.newSessionId) {
        setStatus('success');
        // Give user a moment to see success message
        setTimeout(() => {
          onSuccess(result.newSessionId!);
        }, 1000);
      } else {
        setStatus('error');
        setError(result.error || 'Download failed');
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const isValid = localRepoPath && sessionName.trim();

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-full max-w-md max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
          <div className="flex items-center gap-2">
            <Download size={16} className="text-fg-3" />
            <span className="text-[16px] font-semibold tracking-tight text-fg">DOWNLOAD TO LOCAL</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            disabled={status === 'downloading'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {status === 'idle' && (
            <div className="space-y-4">
              <p className="text-[13px] text-fg-3">
                Download this SSH session to your local machine
              </p>

              {/* Local Repository Path */}
              <div>
                <label
                  className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                >
                  LOCAL REPOSITORY PATH
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localRepoPath}
                    readOnly
                    placeholder="Select local repository folder..."
                    className="flex-1 h-8 px-3 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 cursor-pointer"
                    onClick={handleSelectFolder}
                  />
                  <button
                    onClick={handleSelectFolder}
                    className="h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover flex items-center gap-1.5"
                  >
                    <Folder size={12} />
                    BROWSE
                  </button>
                </div>
                <p className="text-[11.5px] text-fg-4 mt-1">
                  Select the local git repository to download session files to
                </p>
              </div>

              {/* Session Name */}
              <div>
                <label
                  className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                >
                  SESSION NAME
                </label>
                <input
                  type="text"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  placeholder="My Project (Local)"
                  className="w-full h-8 px-3 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  autoFocus
                />
                <p className="text-[11.5px] text-fg-4 mt-1">
                  Name for the new local session
                </p>
              </div>

              {/* Branch (Optional) */}
              <div>
                <label
                  className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                >
                  BRANCH (OPTIONAL)
                </label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full h-8 px-3 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                />
                <p className="text-[11.5px] text-fg-4 mt-1">
                  Git branch to checkout after download
                </p>
              </div>

              {/* Info box */}
              <div className="p-3 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.3)]">
                <p className="text-[12px] text-fg-3 leading-relaxed">
                  <Download size={12} className="inline mr-1 text-accent-text" />
                  The session's git state and conversation history will be downloaded to your local repository
                </p>
              </div>
            </div>
          )}

          {status === 'downloading' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-accent mb-4" />
              <span className="text-[13px] text-fg-2">{progressMessage || 'Downloading...'}</span>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} className="text-diff-add mb-4" />
              <span className="text-[13px] text-diff-add-text">Download complete!</span>
              <span className="text-[12px] text-fg-4 mt-2">Switching to local session...</span>
            </div>
          )}

          {status === 'error' && error && (
            <div className="py-8">
              <div className="text-diff-del-text text-[13px] bg-diff-del/10 p-4 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)] mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  <span className="font-semibold">Download Failed</span>
                </div>
                <span className="text-[12px]">{error}</span>
              </div>
              <button
                onClick={() => {
                  setStatus('idle');
                  setError(null);
                }}
                className="w-full h-8 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {status === 'idle' && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line flex-shrink-0">
            <button
              onClick={onClose}
              className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={handleDownload}
              disabled={!isValid}
              className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={12} />
              DOWNLOAD
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
