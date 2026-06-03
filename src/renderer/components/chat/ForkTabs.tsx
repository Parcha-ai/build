import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Plus, MoreHorizontal, GitFork, MessageSquare } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { getSessionDisplayName } from '../../utils/session-display';

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
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const createForkFromCurrent = useSessionStore(s => s.createForkFromCurrent);
  const loadSessions = useSessionStore(s => s.loadSessions);

  // Re-render when session count or any session name/relationship changes
  const sessionCount = useSessionStore(s => s.sessions.length);
  const sessionNamesKey = useSessionStore(s =>
    s.sessions.map(s => `${s.id.slice(0, 6)}:${s.aiGeneratedName || s.name || ''}:${s.parentSessionId || ''}`).join('\n')
  );

  // Compute fork siblings and project sessions when structure or names change
  const { forkSiblings, projectSessions, rootId, sessions } = useMemo(() => {
    const allSessions = useSessionStore.getState().sessions;
    const fs = useSessionStore.getState().getForkSiblings(sessionId);
    const ps = useSessionStore.getState().getProjectSessions(sessionId);
    const rid = fs.find(f => !f.parentSessionId)?.id || sessionId;
    return { forkSiblings: fs, projectSessions: ps, rootId: rid, sessions: allSessions };
  }, [sessionId, sessionCount, sessionNamesKey]);

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

  // Persist overflow (closed) tabs — driven by tabHidden flag on session objects
  const storageKey = `grep-overflow-forks-${rootId}`;
  const [overflowIds, setOverflowIds] = useState<Set<string>>(() => {
    const hidden = new Set<string>();
    for (const s of forkSiblings) {
      if ((s as any).tabHidden) hidden.add(s.id);
    }
    // Also merge localStorage cache for immediate render before backend loads
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        for (const id of JSON.parse(stored)) hidden.add(id);
      }
    } catch { /* ignore */ }
    return hidden;
  });

  // Sync overflowIds when forkSiblings load/change — picks up tabHidden flags
  // that weren't available at initial render (sessions load asynchronously)
  useEffect(() => {
    const newHidden = new Set<string>();
    for (const s of forkSiblings) {
      if ((s as any).tabHidden) newHidden.add(s.id);
    }
    if (newHidden.size > 0) {
      setOverflowIds(prev => {
        const merged = new Set(prev);
        let changed = false;
        for (const id of newHidden) {
          if (!merged.has(id)) { merged.add(id); changed = true; }
        }
        return changed ? merged : prev;
      });
    }
  }, [forkSiblings]);

  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...overflowIds]));
    } catch {
      // localStorage full — purge old grep-* keys to make space
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('grep-overflow-') || key.startsWith('grep-tab-order-'))) {
          toRemove.push(key);
        }
      }
      toRemove.forEach(k => localStorage.removeItem(k));
      try { localStorage.setItem(storageKey, JSON.stringify([...overflowIds])); } catch { /* give up */ }
    }
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

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleRenameStart = useCallback((forkId: string, currentName: string) => {
    setRenamingId(forkId);
    setRenameValue(currentName);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, []);

  const handleRenameCommit = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    const trimmed = renameValue.trim();
    try {
      // Optimistic update — apply immediately to the store so tabs reflect the
      // new name without waiting for the IPC round-trip.
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map(s =>
          s.id === renamingId
            ? { ...s, aiGeneratedName: trimmed, name: trimmed }
            : s
        ),
      }));
      // Persist to backend
      await window.electronAPI.sessions.update(renamingId, {
        aiGeneratedName: trimmed,
        name: trimmed,
      } as any);
      // Also save to sessionNames in settings (authoritative source)
      await window.electronAPI.settings.set({ [`sessionNames.${renamingId}`]: trimmed });
    } catch (e) {
      console.warn('[ForkTabs] Rename failed:', e);
    }
    setRenamingId(null);
  }, [renamingId, renameValue]);

  // Drag-and-drop reorder state
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Persist tab order to localStorage + electron-store (via claudette-settings)
  const orderKey = `grep-tab-order-${rootId}`;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(orderKey);
      if (stored) setTabOrder(JSON.parse(stored));
    } catch { /* ignore */ }
  }, [orderKey]);

  const saveTabOrder = useCallback((order: string[]) => {
    setTabOrder(order);
    try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch { /* quota */ }
  }, [orderKey]);

  // When a session becomes active, permanently remove it from overflow
  useEffect(() => {
    if (activeSessionId && overflowIds.has(activeSessionId)) {
      setOverflowIds(prev => {
        const next = new Set(prev);
        next.delete(activeSessionId);
        return next;
      });
      window.electronAPI.sessions.update(activeSessionId, { tabHidden: false } as any).catch((error) => {
        console.warn('[ForkTabs] Failed to unhide active tab:', error);
      });
    }
  }, [activeSessionId, overflowIds]);

  // Build visible forks with custom ordering
  const visibleForks = useMemo(() => {
    const visible = forkSiblings.filter(f => !overflowIds.has(f.id));
    if (tabOrder.length === 0) return visible;
    // Sort by saved order; any new tabs not in the order go to the end
    const orderMap = new Map(tabOrder.map((id, i) => [id, i]));
    return [...visible].sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Infinity;
      const bi = orderMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }, [forkSiblings, overflowIds, tabOrder]);

  // Overflow: closed forks + project sessions not already in the fork group
  const forkGroupIds = new Set(forkSiblings.map(f => f.id));
  const closedForks = forkSiblings.filter(f => overflowIds.has(f.id));
  const projectOnlySessions = projectSessions.filter(s => !forkGroupIds.has(s.id));
  const hasOverflowItems = closedForks.length > 0 || projectOnlySessions.length > 0;

  const handleClose = useCallback((e: React.MouseEvent, forkId: string) => {
    e.stopPropagation();
    setOverflowIds(prev => new Set(prev).add(forkId));
    // Persist to backend so it survives restart
    window.electronAPI.sessions.update(forkId, { tabHidden: true } as any).catch((error) => {
      console.warn('[ForkTabs] Failed to hide tab:', error);
    });

    if (forkId === activeSessionId) {
      const remaining = forkSiblings.filter(f => f.id !== forkId && !overflowIds.has(f.id));
      if (remaining.length > 0) {
        setActiveSession(remaining[0].id);
      }
    }
  }, [activeSessionId, forkSiblings, overflowIds, setActiveSession]);

  const handleRestore = useCallback((forkId: string) => {
    setOverflowIds(prev => {
      const next = new Set(prev);
      next.delete(forkId);
      return next;
    });
    // Clear backend hidden flag
    window.electronAPI.sessions.update(forkId, { tabHidden: false } as any).catch((error) => {
      console.warn('[ForkTabs] Failed to restore tab:', error);
    });
    setActiveSession(forkId);
    setShowOverflow(false);
  }, [setActiveSession]);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDragId(null);
    setDragOverId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragId) setDragOverId(id);
  }, [dragId]);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;

    const currentOrder = visibleForks.map(f => f.id);
    const fromIdx = currentOrder.indexOf(dragId);
    const toIdx = currentOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragId);
    saveTabOrder(newOrder);

    setDragId(null);
    setDragOverId(null);
  }, [dragId, visibleForks, saveTabOrder]);

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
          const displayName = getSessionDisplayName(fork);
          const isDragOver = fork.id === dragOverId;
          const isRenaming = renamingId === fork.id;

          return (
            <div
              key={fork.id}
              draggable={!isRenaming}
              onDragStart={(e) => handleDragStart(e, fork.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, fork.id)}
              onDrop={(e) => handleDrop(e, fork.id)}
              className={`
                flex items-center gap-2 px-3 py-1.5 whitespace-nowrap uppercase group ${isRenaming ? '' : 'cursor-grab active:cursor-grabbing'}
                ${isActive
                  ? 'text-claude-text bg-claude-accent/15 border-b-2 border-claude-accent font-bold'
                  : 'text-claude-text-secondary hover:text-claude-text hover:bg-claude-bg/80'
                }
                ${index > 0 ? 'border-l border-claude-border/30' : ''}
                ${isDragOver ? 'bg-claude-accent/10' : ''}
              `}
              style={{ letterSpacing: '0.05em' }}
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameCommit();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="flex-1 bg-transparent border-b border-claude-accent text-claude-text text-xs font-mono uppercase outline-none px-0 py-0"
                  style={{ letterSpacing: '0.05em', minWidth: '60px' }}
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => setActiveSession(fork.id)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    handleRenameStart(fork.id, displayName);
                  }}
                  className="flex-1 text-left"
                  title="Double-click to rename"
                >
                  {isActive && '> '}
                  {displayName}
                </button>
              )}
              {visibleForks.length > 1 && !isRenaming && (
                <button
                  onClick={(e) => handleClose(e, fork.id)}
                  className="opacity-0 group-hover:opacity-100 text-claude-text-secondary hover:text-red-400 transition-opacity"
                  title="Close tab"
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
            try {
              const root = forkSiblings.find(f => f.id === rootId);
              let newSession: any;

              if (session?.sshConfig) {
                const { worktreeScript: _, ...cleanConfig } = session.sshConfig as any;
                newSession = await window.electronAPI.ssh.createSession({
                  name: `${session.name} (new)`,
                  sshConfig: { ...cleanConfig, syncSettings: false },
                  parentSessionId: rootId,
                });
              } else {
                const repoPath = session?.worktreePath || session?.repoPath || '';
                const branch = session?.branch || 'main';
                if (repoPath) {
                  newSession = await window.electronAPI.dev.createSession({
                    name: `${session?.name || 'Session'} (new)`,
                    repoPath,
                    branch,
                  });
                  if (newSession) {
                    await window.electronAPI.sessions.update(newSession.id, {
                      parentSessionId: rootId,
                    } as any);
                    newSession.parentSessionId = rootId;
                  }
                }
              }

              if (newSession) {
                useSessionStore.setState((state) => ({
                  sessions: [
                    ...state.sessions.map(s => {
                      if (s.id === rootId) {
                        const children = [...(s.childSessionIds || [])];
                        if (!children.includes(newSession.id)) children.push(newSession.id);
                        return { ...s, childSessionIds: children, isRoot: true } as typeof s;
                      }
                      return s;
                    }),
                    { ...newSession, parentSessionId: rootId } as any,
                  ],
                }));
                setActiveSession(newSession.id);
                window.electronAPI.sessions.update(rootId, {
                  childSessionIds: [...(root?.childSessionIds || []), newSession.id],
                  isRoot: true,
                } as any).catch((error) => {
                  console.warn('[ForkTabs] Failed to attach new tab to root:', error);
                });
              }
            } catch (err) {
              console.error('[ForkTabs] Failed to create new tab:', err);
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
                  <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">Closed Tabs</span>
                </div>
                {closedForks.map(fork => (
                  <button
                    key={fork.id}
                    onClick={() => handleRestore(fork.id)}
                    className="w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors flex items-center gap-2"
                  >
                    <GitFork size={10} className="text-claude-accent flex-shrink-0" />
                    <span className="text-xs truncate flex-1">{getSessionDisplayName(fork)}</span>
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
                        // Optimistically update the local store FIRST so the tab
                        // appears immediately — don't wait for backend round-trip.
                        useSessionStore.setState((state) => ({
                          sessions: state.sessions.map(s => {
                            if (s.id === session.id) {
                              return { ...s, parentSessionId: rootId, isRoot: false, tabHidden: false } as typeof s;
                            }
                            if (s.id === rootId) {
                              const children = [...(s.childSessionIds || [])];
                              if (!children.includes(session.id)) children.push(session.id);
                              return { ...s, childSessionIds: children, isRoot: true } as typeof s;
                            }
                            return s;
                          }),
                        }));
                        // Remove from overflow
                        setOverflowIds(prev => {
                          const next = new Set(prev);
                          next.delete(session.id);
                          return next;
                        });
                        setShowOverflow(false);
                        setActiveSession(session.id);
                        // Persist to backend in background
                        window.electronAPI.sessions.update(session.id, {
                          parentSessionId: rootId, isRoot: false, tabHidden: false,
                        } as any).catch((error) => {
                          console.warn('[ForkTabs] Failed to promote session to tab:', error);
                        });
                        const root = forkSiblings.find(f => f.id === rootId);
                        if (root) {
                          const children = [...(root.childSessionIds || [])];
                          if (!children.includes(session.id)) {
                            children.push(session.id);
                            window.electronAPI.sessions.update(rootId, {
                              childSessionIds: children, isRoot: true,
                            } as any).catch((error) => {
                              console.warn('[ForkTabs] Failed to update root tab children:', error);
                            });
                          }
                        }
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-claude-bg transition-colors flex items-center gap-2"
                    >
                      {isFork
                        ? <GitFork size={10} className="text-purple-400 flex-shrink-0" />
                        : <MessageSquare size={10} className="text-claude-text-secondary flex-shrink-0" />
                      }
                      <span className="text-xs truncate flex-1">{getSessionDisplayName(session)}</span>
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
