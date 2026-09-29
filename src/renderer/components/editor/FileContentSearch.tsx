import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  X,
  Loader2,
  FileText,
  ChevronRight,
  ChevronDown,
  CaseSensitive,
  WholeWord,
  Regex,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editor.store';
import { useSessionStore } from '../../stores/session.store';

interface SearchMatch {
  lineNumber: number;
  lineContent: string;
}

interface FileResult {
  filePath: string;
  relativePath: string;
  fileName: string;
  matches: SearchMatch[];
  matchCount: number;
}

interface FlatItem {
  type: 'file' | 'match';
  fileIndex: number;
  matchIndex?: number;
  filePath: string;
  relativePath: string;
  fileName: string;
  lineNumber?: number;
  lineContent?: string;
  matchCount?: number;
}

export default function FileContentSearch() {
  const { isFileSearchOpen, closeFileSearch, openFile } = useEditorStore();
  const { activeSessionId } = useSessionStore();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  // Search options
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Build flat list for keyboard navigation
  const flatItems: FlatItem[] = [];
  results.forEach((file, fileIndex) => {
    flatItems.push({
      type: 'file',
      fileIndex,
      filePath: file.filePath,
      relativePath: file.relativePath,
      fileName: file.fileName,
      matchCount: file.matchCount,
    });
    if (!collapsedFiles.has(file.filePath)) {
      file.matches.forEach((match, matchIndex) => {
        flatItems.push({
          type: 'match',
          fileIndex,
          matchIndex,
          filePath: file.filePath,
          relativePath: file.relativePath,
          fileName: file.fileName,
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
        });
      });
    }
  });

  // Focus input when opened
  useEffect(() => {
    if (isFileSearchOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isFileSearchOpen]);

  // Debounced search
  useEffect(() => {
    if (!isFileSearchOpen || !activeSessionId) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const searchResults = await window.electronAPI.fs.searchFiles(
          activeSessionId,
          query,
          { caseSensitive, wholeWord, regex: useRegex }
        );
        setResults(searchResults);
        setSelectedIndex(0);
        setCollapsedFiles(new Set());
      } catch (err) {
        console.error('[FileContentSearch] Search failed:', err);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, caseSensitive, wholeWord, useRegex, isFileSearchOpen, activeSessionId]);

  // Reset state when closed
  useEffect(() => {
    if (!isFileSearchOpen) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setCollapsedFiles(new Set());
    }
  }, [isFileSearchOpen]);

  const toggleFileCollapsed = useCallback((filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback((item: FlatItem) => {
    if (item.type === 'file') {
      toggleFileCollapsed(item.filePath);
    } else if (item.type === 'match' && item.lineNumber) {
      openFile(item.filePath, item.lineNumber);
      closeFileSearch();
    }
  }, [openFile, closeFileSearch, toggleFileCollapsed]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, flatItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatItems[selectedIndex]) {
          handleSelect(flatItems[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeFileSearch();
        break;
    }
  }, [flatItems, selectedIndex, handleSelect, closeFileSearch]);

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current) {
      const el = resultsRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeFileSearch();
  }, [closeFileSearch]);

  // Highlight search term in line content
  const highlightMatch = (text: string, searchTerm: string) => {
    if (!searchTerm.trim()) return text;
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const pattern = useRegex ? searchTerm : searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(wholeWord ? `\\b${pattern}\\b` : pattern, flags);
      const parts = text.split(regex);
      const matches = text.match(regex);
      if (!matches) return text;

      return parts.reduce((acc: React.ReactNode[], part, i) => {
        acc.push(part);
        if (i < matches.length) {
          acc.push(
            <span key={i} className="bg-[rgba(240,180,41,0.28)] text-[#FFE3A3] px-0.5">
              {matches[i]}
            </span>
          );
        }
        return acc;
      }, []);
    } catch {
      return text;
    }
  };

  // Summary counts
  const totalFiles = results.length;
  const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);

  if (!isFileSearchOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="w-[700px] max-w-[90vw] bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.45)] overflow-hidden flex flex-col max-h-[70vh]">
        {/* Search input row */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Search size={15} className="text-fg-4 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search in files..."
            className="flex-1 bg-transparent text-fg text-[14px] font-mono outline-none placeholder:text-fg-5"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />

          {/* Option toggles */}
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`w-7 h-7 flex items-center justify-center transition-colors ${
              caseSensitive ? 'bg-[rgba(76,154,255,0.13)] text-accent-text' : 'text-fg-4 hover:text-fg hover:bg-claude-surface-hover'
            }`}
            title="Match Case (Aa)"
          >
            <CaseSensitive size={16} />
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            className={`w-7 h-7 flex items-center justify-center transition-colors ${
              wholeWord ? 'bg-[rgba(76,154,255,0.13)] text-accent-text' : 'text-fg-4 hover:text-fg hover:bg-claude-surface-hover'
            }`}
            title="Whole Word (Ab|)"
          >
            <WholeWord size={16} />
          </button>
          <button
            onClick={() => setUseRegex(!useRegex)}
            className={`w-7 h-7 flex items-center justify-center transition-colors ${
              useRegex ? 'bg-[rgba(76,154,255,0.13)] text-accent-text' : 'text-fg-4 hover:text-fg hover:bg-claude-surface-hover'
            }`}
            title="Use Regular Expression (.*)"
          >
            <Regex size={16} />
          </button>

          {isSearching && <Loader2 size={15} className="text-accent animate-spin" />}
          <button onClick={closeFileSearch} className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover transition-colors">
            <X size={15} className="text-fg-4" />
          </button>
        </div>

        {/* Results summary */}
        {query.trim() && !isSearching && (
          <div className="px-4 py-1.5 text-[11px] text-fg-4 border-b border-line font-mono">
            {totalMatches > 0
              ? `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`
              : 'No results found'}
          </div>
        )}

        {/* Results list */}
        <div ref={resultsRef} className="flex-1 overflow-y-auto">
          {!query.trim() && (
            <div className="px-4 py-8 text-center text-fg-4 text-[13px]">
              Type to search file contents...
            </div>
          )}

          {query.trim() && !isSearching && results.length === 0 && (
            <div className="px-4 py-8 text-center text-fg-4 text-[13px]">
              No results found
            </div>
          )}

          {flatItems.map((item, index) => {
            if (item.type === 'file') {
              const isCollapsed = collapsedFiles.has(item.filePath);
              return (
                <button
                  key={`file-${item.filePath}`}
                  data-index={index}
                  onClick={() => handleSelect(item)}
                  className={`w-full h-8 flex items-center gap-2 px-3 text-left transition-colors ${
                    index === selectedIndex
                      ? 'bg-[#262626] text-fg'
                      : 'text-fg-3 hover:bg-claude-surface-hover'
                  }`}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <FileText size={14} className="text-fg-4 flex-shrink-0" />
                  <span className="text-[13px] font-medium text-fg truncate">
                    {item.fileName}
                  </span>
                  <span className="text-[11.5px] font-mono text-fg-4 truncate flex-1">
                    {item.relativePath}
                  </span>
                  <span className="text-[10.5px] font-mono text-fg-3 bg-ink-4 px-1.5 py-0.5 flex-shrink-0">
                    {item.matchCount}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={`match-${item.filePath}-${item.lineNumber}`}
                data-index={index}
                onClick={() => handleSelect(item)}
                className={`w-full h-7 flex items-center gap-2 pl-10 pr-3 text-left transition-colors ${
                  index === selectedIndex
                    ? 'bg-[#262626] text-fg'
                    : 'text-fg-3 hover:bg-claude-surface-hover'
                }`}
              >
                <span className="text-[11px] font-mono text-fg-5 w-8 text-right flex-shrink-0 tabular-nums">
                  {item.lineNumber}
                </span>
                <span className="text-[12.5px] font-mono truncate">
                  {highlightMatch(item.lineContent || '', query)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Footer hints */}
        <div className="px-4 py-2 border-t border-line font-mono text-[10.5px] text-fg-5 flex items-center gap-4">
          <span><kbd className="px-1 bg-ink-4 text-fg-3">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 bg-ink-4 text-fg-3">↵</kbd> open / toggle</span>
          <span><kbd className="px-1 bg-ink-4 text-fg-3">esc</kbd> close</span>
          <span className="flex-1" />
          <span className="text-fg-5">⌘⇧F</span>
        </div>
      </div>
    </div>
  );
}
