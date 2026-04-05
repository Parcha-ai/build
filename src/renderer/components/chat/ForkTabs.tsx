import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Plus, MoreHorizontal } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';

interface ForkTabsProps {
  sessionId: string;
}

/**
 * ForkTabs - Horizontal tab bar showing conversation forks
 * Closing a tab moves it to an overflow menu (···) — persisted in localStorage.
 * Forks can be reopened from the overflow menu.
 */
export default function ForkTabs({ sessionId }: ForkTabsProps) {
  const getForkSiblings = useSessionStore(s => s.getForkSiblings);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const createForkFromCurrent = useSessionStore(s => s.createForkFromCurrent);

  // Find root session ID for localStorage key
  const forkSiblings = getForkSiblings(sessionId);
  const rootId = forkSiblings.find(f => !f.parentSessionId)?.id || sessionId;

  // Persist overflow (closed) tabs in localStorage
  const storageKey = `grep-overflow-forks-${rootId}`;
  const [overflowIds, setOverflowIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Persist to localStorage when overflow changes
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify([...overflowIds]));
  }, [overflowIds, storageKey]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!showOverflow) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showOverflow]);

  const visibleForks = forkSiblings.filter(f => !overflowIds.has(f.id));
  const overflowForks = forkSiblings.filter(f => overflowIds.has(f.id));

  const handleClose = useCallback((e: React.MouseEvent, forkId: string) => {
    e.stopPropagation();
    setOverflowIds(prev => new Set(prev).add(forkId));

    // If we closed the active tab, switch to root or next visible
    if (forkId === activeSessionId) {
      const remaining = forkSiblings.filter(f => f.id !== forkId && !overflowIds.has(f.id));
      if (remaining.length > 0) {
        const root = remaining.find(f => !f.parentSessionId);
        setActiveSession(root?.id || remaining[0].id);
      }
    }
  }, [activeSessionId, forkSiblings, overflowIds, setActiveSession]);

  const handleRestore = useCallback((forkId: string) => {
    setOverflowIds(prev => {
      const next = new Set(prev);
      next.delete(forkId);
      return next;
    });
    setActiveSession(forkId);
    setShowOverflow(false);
  }, [setActiveSession]);

  // Only show if there are multiple forks total (visible + overflow)
  if (forkSiblings.length <= 1) return null;

  return (
    <div className="border-b border-claude-border bg-claude-bg/50 text-xs font-mono">
      <div className="flex items-center px-3 py-1 overflow-x-auto">
        {visibleForks.map((fork, index) => {
          const isActive = fork.id === activeSessionId;
          const displayName = fork.aiGeneratedName || fork.name;
          const isRoot = !fork.parentSessionId;

          return (
            <div
              key={fork.id}
              className={`
                flex items-center gap-2 px-3 py-1 whitespace-nowrap uppercase group
                ${isActive
                  ? 'text-claude-text border-b-2 border-claude-accent'
                  : 'text-claude-text-secondary hover:text-claude-text'
                }
                ${index > 0 ? 'border-l border-claude-border/30' : ''}
              `}
              style={{ letterSpacing: '0.05em' }}
            >
              <button
                onClick={() => setActiveSession(fork.id)}
                className="flex-1 text-left"
                title={fork.name}
              >
                {isActive && '> '}
                {isRoot ? 'ROOT' : displayName}
              </button>
              {!isRoot && (
                <button
                  onClick={(e) => handleClose(e, fork.id)}
                  className="opacity-0 group-hover:opacity-100 text-claude-text-secondary hover:text-red-400 transition-opacity"
                  title="Close fork"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {/* New fork button */}
        <button
          onClick={() => createForkFromCurrent('')}
          className="flex items-center justify-center px-2 py-1 border-l border-claude-border/30 text-claude-text-secondary hover:text-claude-accent transition-colors"
          title="Fork conversation (Cmd+T)"
        >
          <Plus size={12} />
        </button>

        {/* Overflow menu — shows closed forks */}
        {overflowForks.length > 0 && (
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              className="flex items-center gap-1 px-2 py-1 border-l border-claude-border/30 text-claude-text-secondary hover:text-claude-text transition-colors"
              title={`${overflowForks.length} hidden fork${overflowForks.length > 1 ? 's' : ''}`}
            >
              <MoreHorizontal size={12} />
              <span className="text-[9px]">{overflowForks.length}</span>
            </button>
            {showOverflow && (
              <div className="absolute top-full left-0 mt-1 bg-claude-surface border border-claude-border shadow-lg z-50 min-w-48">
                <div className="px-3 py-1.5 border-b border-claude-border">
                  <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">Closed Forks</span>
                </div>
                {overflowForks.map(fork => (
                  <button
                    key={fork.id}
                    onClick={() => handleRestore(fork.id)}
                    className="w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors text-claude-text"
                  >
                    <span className="text-xs uppercase">{fork.aiGeneratedName || fork.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
