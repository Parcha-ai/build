import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Plus, MoreHorizontal, GitFork, MessageSquare } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';

interface ForkTabsProps {
  sessionId: string;
}

function formatRelativeDate(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * ForkTabs - Horizontal tab bar showing conversation forks.
 * Closing a tab moves it to an overflow menu (···) — persisted in localStorage.
 * The overflow menu also shows all other sessions from the same project directory,
 * allowing any session to be promoted to a tab.
 */
export default function ForkTabs({ sessionId }: ForkTabsProps) {
  const getForkSiblings = useSessionStore(s => s.getForkSiblings);
  const getProjectSessions = useSessionStore(s => s.getProjectSessions);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const createForkFromCurrent = useSessionStore(s => s.createForkFromCurrent);

  const forkSiblings = getForkSiblings(sessionId);
  const projectSessions = getProjectSessions(sessionId);
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

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify([...overflowIds]));
  }, [overflowIds, storageKey]);

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

  // Overflow: closed forks + project sessions not already in the fork group
  const forkGroupIds = new Set(forkSiblings.map(f => f.id));
  const closedForks = forkSiblings.filter(f => overflowIds.has(f.id));
  const projectOnlySessions = projectSessions.filter(s => !forkGroupIds.has(s.id));
  const hasOverflowItems = closedForks.length > 0 || projectOnlySessions.length > 0;

  const handleClose = useCallback((e: React.MouseEvent, forkId: string) => {
    e.stopPropagation();
    setOverflowIds(prev => new Set(prev).add(forkId));

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

  // Show tabs if multiple forks exist OR there are project sessions to discover
  if (forkSiblings.length <= 1 && projectOnlySessions.length === 0) return null;

  return (
    <div className="border-b border-claude-border bg-claude-bg/50 text-xs font-mono">
      <div className="flex items-center px-3 py-1 overflow-x-auto">
        {visibleForks.map((fork, index) => {
          const isActive = fork.id === activeSessionId;
          const displayName = fork.aiGeneratedName || fork.forkName || fork.name;
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

        {/* Overflow menu — closed forks + project sessions */}
        {hasOverflowItems && (
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setShowOverflow(!showOverflow)}
              className="flex items-center gap-1 px-2 py-1 border-l border-claude-border/30 text-claude-text-secondary hover:text-claude-text transition-colors"
              title={`${closedForks.length + projectOnlySessions.length} more session${closedForks.length + projectOnlySessions.length > 1 ? 's' : ''}`}
            >
              <MoreHorizontal size={12} />
              <span className="text-[9px]">{closedForks.length + projectOnlySessions.length}</span>
            </button>
            {showOverflow && (
              <div className="absolute top-full right-0 mt-1 bg-claude-surface border border-claude-border shadow-lg z-50 min-w-64 max-h-80 overflow-y-auto">
                {/* Closed forks section */}
                {closedForks.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-b border-claude-border">
                      <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">Closed Forks</span>
                    </div>
                    {closedForks.map(fork => (
                      <button
                        key={fork.id}
                        onClick={() => handleRestore(fork.id)}
                        className="w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors flex items-center gap-2"
                      >
                        <GitFork size={10} className="text-claude-accent flex-shrink-0" />
                        <span className="text-xs truncate flex-1">{fork.aiGeneratedName || fork.forkName || fork.name}</span>
                        <span className="text-[9px] text-claude-text-secondary flex-shrink-0">
                          {formatRelativeDate(fork.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </>
                )}

                {/* Project sessions section */}
                {projectOnlySessions.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 border-b border-claude-border">
                      <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">Other Sessions</span>
                    </div>
                    {projectOnlySessions.map(session => {
                      const isFork = !!session.parentSessionId;
                      return (
                        <button
                          key={session.id}
                          onClick={() => {
                            setActiveSession(session.id);
                            setShowOverflow(false);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors flex items-center gap-2"
                        >
                          {isFork
                            ? <GitFork size={10} className="text-purple-400 flex-shrink-0" />
                            : <MessageSquare size={10} className="text-claude-text-secondary flex-shrink-0" />
                          }
                          <span className="text-xs truncate flex-1">{session.aiGeneratedName || session.forkName || session.name}</span>
                          <span className="text-[9px] text-claude-text-secondary flex-shrink-0">
                            {formatRelativeDate(session.updatedAt)}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
