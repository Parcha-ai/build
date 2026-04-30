import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
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

  const sessions = useSessionStore(s => s.sessions);
  const loadSessions = useSessionStore(s => s.loadSessions);

  const forkSiblings = getForkSiblings(sessionId);
  const projectSessions = getProjectSessions(sessionId);
  const rootId = forkSiblings.find(f => !f.parentSessionId)?.id || sessionId;

  // Auto-scan remote transcripts on mount for SSH sessions.
  // Creates session records for any orphaned transcripts in the same directory
  // so they appear in the overflow menu without manual intervention.
  const hasScanned = useRef(false);
  useEffect(() => {
    if (hasScanned.current) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session?.sshConfig) return;
    hasScanned.current = true;

    window.electronAPI?.sessions?.scanRemoteTranscripts?.(rootId).then((newSessions) => {
      if (newSessions && newSessions.length > 0) {
        console.log(`[ForkTabs] Discovered ${newSessions.length} orphaned remote transcript(s)`);
        loadSessions();
      }
    }).catch((err: unknown) => {
      console.warn('[ForkTabs] Remote scan failed:', err);
    });
  }, [sessionId, rootId, sessions, loadSessions]);

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
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });

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
    // Use click (not mousedown) + requestAnimationFrame so the toggle
    // button's onClick completes before the outside-click listener fires.
    // Without this, the dropdown opens and immediately closes in the same tick.
    const raf = requestAnimationFrame(() => {
      document.addEventListener('click', handleClick);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('click', handleClick);
    };
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

  // Always show for SSH sessions (so the + button is accessible).
  // For local sessions, only show when there are forks or project siblings.
  const currentSession = sessions.find(s => s.id === sessionId);
  const isSSH = !!(currentSession as any)?.sshConfig;
  if (!isSSH && forkSiblings.length <= 1 && projectOnlySessions.length === 0) return null;

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

        {/* New tab — fresh session in the same directory, added as a sibling tab
            (same fork group, clean transcript). NOT a fork — Option+Enter forks with transcript. */}
        <button
          onClick={async () => {
            const currentSession = sessions.find(s => s.id === sessionId);
            const rootSession = sessions.find(s => s.id === rootId);
            const session = rootSession?.sshConfig ? rootSession : currentSession;
            if (session?.sshConfig) {
              try {
                // Strip worktreeScript so it doesn't re-run setup — we're
                // connecting to the SAME directory, not creating a new worktree.
                const { worktreeScript: _, ...cleanConfig } = session.sshConfig as any;
                // Pre-update root's childSessionIds so the new session is in the
                // fork group BEFORE it gets broadcast via SESSION_LIST_UPDATED.
                const root = forkSiblings.find(f => f.id === rootId);

                const newSession = await window.electronAPI.ssh.createSession({
                  name: `${session.name} (new)`,
                  sshConfig: { ...cleanConfig, syncSettings: false },
                  parentSessionId: rootId,
                });
                if (newSession) {
                  // Update root's children list
                  if (root) {
                    const children = [...(root.childSessionIds || [])];
                    if (!children.includes(newSession.id)) {
                      children.push(newSession.id);
                      await window.electronAPI.sessions.update(rootId, {
                        childSessionIds: children,
                        isRoot: true,
                      } as any);
                    }
                  }
                  loadSessions();
                  setActiveSession(newSession.id);
                }
              } catch (err) {
                console.error('[ForkTabs] Failed to create new tab:', err);
              }
            }
          }}
          className="flex items-center justify-center px-2 py-1 border-l border-claude-border/30 text-claude-text-secondary hover:text-claude-accent transition-colors"
          title="New tab — fresh session (Cmd+T)"
        >
          <Plus size={12} />
        </button>

        {/* Overflow menu trigger — closed forks + project sessions */}
        {hasOverflowItems && (
          <button
            ref={overflowBtnRef}
            onClick={() => {
              if (!showOverflow && overflowBtnRef.current) {
                const rect = overflowBtnRef.current.getBoundingClientRect();
                setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
              }
              setShowOverflow(!showOverflow);
            }}
            className="flex items-center gap-1 px-2 py-1 border-l border-claude-border/30 text-claude-text-secondary hover:text-claude-text transition-colors"
            title={`${closedForks.length + projectOnlySessions.length} more session${closedForks.length + projectOnlySessions.length > 1 ? 's' : ''}`}
          >
            <MoreHorizontal size={12} />
            <span className="text-[9px]">{closedForks.length + projectOnlySessions.length}</span>
          </button>
        )}

        {/* Overflow dropdown — rendered via portal to escape overflow:auto clipping */}
        {showOverflow && ReactDOM.createPortal(
          <div
            ref={overflowRef}
            className="fixed bg-claude-surface border border-claude-border shadow-lg z-[9999] min-w-64 max-h-80 overflow-y-auto text-xs font-mono"
            style={{ top: dropdownPos.top, right: dropdownPos.right }}
          >
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
                      onClick={async () => {
                        // Adopt this session into the current fork group so it
                        // appears as a tab instead of navigating away entirely.
                        if (!session.parentSessionId || session.parentSessionId !== rootId) {
                          try {
                            await window.electronAPI.sessions.update(session.id, {
                              parentSessionId: rootId,
                              isRoot: false,
                            } as any);
                            // Also update parent's childSessionIds
                            const root = forkSiblings.find(f => f.id === rootId);
                            if (root) {
                              const children = [...(root.childSessionIds || [])];
                              if (!children.includes(session.id)) {
                                children.push(session.id);
                                await window.electronAPI.sessions.update(rootId, {
                                  childSessionIds: children,
                                  isRoot: true,
                                } as any);
                              }
                            }
                          } catch (err) {
                            console.warn('[ForkTabs] Failed to adopt session into fork group:', err);
                          }
                        }
                        // Remove from overflow so it appears as a visible tab
                        setOverflowIds(prev => {
                          const next = new Set(prev);
                          next.delete(session.id);
                          return next;
                        });
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
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}
