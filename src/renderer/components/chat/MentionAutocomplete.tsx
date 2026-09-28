import React, { useState, useEffect, useRef, useCallback } from 'react';
import { File, Folder, Search, X, Loader2 } from 'lucide-react';

export interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'folder';
  extension?: string;
}

export interface Mention {
  type: 'file' | 'folder' | 'symbol';
  name: string;
  path: string;
  displayName: string;
}

interface MentionAutocompleteProps {
  sessionId: string;
  query: string;
  position: { top: number; left: number };
  onSelect: (mention: Mention) => void;
  onClose: () => void;
}

// File type colors using Tailwind classes
const FILE_ICON_COLORS: Record<string, string> = {
  '.ts': 'text-blue-400',
  '.tsx': 'text-blue-400',
  '.js': 'text-yellow-400',
  '.jsx': 'text-yellow-400',
  '.py': 'text-green-400',
  '.go': 'text-cyan-400',
  '.rs': 'text-orange-400',
  '.json': 'text-yellow-300',
  '.md': 'text-gray-400',
  '.css': 'text-pink-400',
  '.scss': 'text-pink-400',
  '.html': 'text-orange-300',
  '.yaml': 'text-red-300',
  '.yml': 'text-red-300',
};

export default function MentionAutocomplete({
  sessionId,
  query,
  position,
  onSelect,
  onClose,
}: MentionAutocompleteProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch files when query changes
  useEffect(() => {
    const fetchFiles = async () => {
      setIsLoading(true);
      try {
        const results = await window.electronAPI.fs.listFiles(sessionId, query);
        setFiles(results);
        setSelectedIndex(0);
      } catch (error) {
        console.error('Failed to fetch files:', error);
        setFiles([]);
      }
      setIsLoading(false);
    };

    const debounce = setTimeout(fetchFiles, 150);
    return () => clearTimeout(debounce);
  }, [sessionId, query]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && files[selectedIndex]) {
        e.preventDefault();
        const file = files[selectedIndex];
        onSelect({
          type: file.type,
          name: file.name,
          path: file.path,
          displayName: file.relativePath,
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [files, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selectedEl?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const getFileIcon = (file: FileEntry) => {
    if (file.type === 'folder') {
      return <Folder size={12} className="text-amber" />;
    }
    const color = FILE_ICON_COLORS[file.extension || ''] || 'text-fg-4';
    return <File size={12} className={color} />;
  };

  return (
    <div
      className="build-composer-menu absolute z-50 overflow-hidden !p-0"
      style={{
        top: position.top,
        left: position.left,
        width: 340,
        maxHeight: 280,
        borderRadius: 0,
      }}
    >
      {/* Header - brutalist */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5 border-b border-line">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
          <Search size={11} />
          <span>Search files & folders</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-fg-4 hover:bg-white/[0.05] hover:text-fg"
          style={{ borderRadius: 0 }}
        >
          <X size={10} />
        </button>
      </div>

      {/* Results */}
      <div ref={listRef} className="overflow-y-auto max-h-[200px] p-1.5">
        {isLoading ? (
          <div className="p-4 text-center">
            <Loader2 size={14} className="animate-spin mx-auto mb-1 text-accent" />
            <span className="text-[12px] text-fg-4">
              Searching…
            </span>
          </div>
        ) : files.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-fg-4">
            {query ? 'No matches found' : 'Type to search…'}
          </div>
        ) : (
          files.map((file, index) => (
            <button
              key={file.path}
              data-index={index}
              onClick={() =>
                onSelect({
                  type: file.type,
                  name: file.name,
                  path: file.path,
                  displayName: file.relativePath,
                })
              }
              className={`build-composer-menu-item !gap-2 !py-1.5 ${
                index === selectedIndex ? 'is-selected' : ''
              }`}
            >
              {getFileIcon(file)}
              <span className="flex-1 truncate font-mono text-[11.5px]">
                {file.relativePath}
              </span>
              <span
                className="font-mono text-[9.5px] uppercase px-1 text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
                style={{ borderRadius: 0 }}
              >
                {file.type === 'folder' ? 'DIR' : 'FILE'}
              </span>
            </button>
          ))
        )}
      </div>

      {/* Footer hint - brutalist */}
      <div className="px-3 py-1.5 flex items-center gap-3.5 font-mono text-[10.5px] border-t border-line text-fg-5">
        <span className="flex items-center gap-1">
          <kbd className="text-fg-4" style={{ borderRadius: 0 }}>↑↓</kbd>
          <span>nav</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="text-fg-4" style={{ borderRadius: 0 }}>↵</kbd>
          <span>select</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="text-fg-4" style={{ borderRadius: 0 }}>esc</kbd>
          <span>close</span>
        </span>
      </div>
    </div>
  );
}
