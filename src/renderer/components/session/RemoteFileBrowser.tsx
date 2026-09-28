import React, { useState, useEffect } from 'react';
import { Folder, File, ChevronLeft, Home, X } from 'lucide-react';
import type { SSHConfig } from '../../../shared/types';

interface RemoteFileBrowserProps {
  sshConfig: SSHConfig;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  fileFilter?: (name: string) => boolean; // Optional filter for files (e.g., .sh files only)
  directoryMode?: boolean; // When true, selects directories instead of files
}

export default function RemoteFileBrowser({
  sshConfig,
  initialPath,
  onSelect,
  onClose,
  fileFilter,
  directoryMode,
}: RemoteFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '~');
  const [entries, setEntries] = useState<Array<{ name: string; type: 'file' | 'directory'; permissions: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load directory contents
  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.ssh.browseRemoteFiles(sshConfig, path);

      if (result.success) {
        // Filter files if fileFilter is provided
        const filteredEntries = fileFilter
          ? result.entries.filter(entry => entry.type === 'directory' || fileFilter(entry.name))
          : result.entries;

        // Sort: directories first, then files, both alphabetically
        const sorted = filteredEntries.sort((a, b) => {
          if (a.type === b.type) {
            return a.name.localeCompare(b.name);
          }
          return a.type === 'directory' ? -1 : 1;
        });

        setEntries(sorted);
      } else {
        setError(result.error || 'Failed to list directory');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  const handleEntryClick = (entry: { name: string; type: 'file' | 'directory' }) => {
    if (entry.type === 'directory') {
      // Navigate into directory
      const newPath = currentPath === '/'
        ? `/${entry.name}`
        : `${currentPath}/${entry.name}`;
      setCurrentPath(newPath);
    } else {
      // Select file
      const fullPath = currentPath === '/'
        ? `/${entry.name}`
        : `${currentPath}/${entry.name}`;
      onSelect(fullPath);
    }
  };

  const handleGoUp = () => {
    if (currentPath === '/' || currentPath === '~') return;
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    setCurrentPath(parentPath);
  };

  const handleGoHome = () => {
    setCurrentPath('~');
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-[16px] font-semibold tracking-tight text-fg">{directoryMode ? 'Select Remote Directory' : 'Browse Remote Files'}</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-claude-surface-hover transition-colors"
            title="Close"
          >
            <X size={14} className="text-fg-3" />
          </button>
        </div>

        {/* Navigation bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-ink-1">
          <button
            onClick={handleGoUp}
            disabled={currentPath === '/' || currentPath === '~'}
            className="p-1 hover:bg-claude-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Go up"
          >
            <ChevronLeft size={14} className="text-fg-3" />
          </button>
          <button
            onClick={handleGoHome}
            className="p-1 hover:bg-claude-surface-hover transition-colors"
            title="Home directory"
          >
            <Home size={14} className="text-fg-3" />
          </button>
          <div className="flex-1 px-2 py-1 text-[12px] font-mono text-fg-2 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
            {currentPath}
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-4 text-center text-[13px] text-fg-4">
              Loading...
            </div>
          )}

          {error && (
            <div className="p-4 text-center text-[13px] text-diff-del">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="p-4 text-center text-[13px] text-fg-4">
              Empty directory
            </div>
          )}

          {!loading && !error && entries.length > 0 && (
            <div className="divide-y divide-line">
              {entries.map((entry, index) => (
                <button
                  key={index}
                  onClick={() => handleEntryClick(entry)}
                  className="w-full flex items-center gap-2 h-8 px-3 hover:bg-claude-surface-hover transition-colors text-left"
                >
                  {entry.type === 'directory' ? (
                    <Folder size={14} className="text-fg-3 flex-shrink-0" />
                  ) : (
                    <File size={14} className="text-fg-5 flex-shrink-0" />
                  )}
                  <span className="text-[12.5px] font-mono text-fg flex-1 truncate">
                    {entry.name}
                  </span>
                  {entry.type === 'directory' && (
                    <span className="text-[12px] text-fg-5">›</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-line flex items-center justify-between gap-3">
          <p className="text-[12px] text-fg-4">
            {directoryMode ? 'Navigate to a directory, then select it' : 'Click a file to select, or navigate through directories'}
          </p>
          {directoryMode && (
            <button
              onClick={() => onSelect(currentPath)}
              className="h-8 px-3 shrink-0 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white"
            >
              SELECT THIS DIRECTORY
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
