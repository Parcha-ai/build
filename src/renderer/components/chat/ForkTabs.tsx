import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Plus, MoreHorizontal, GitFork } from 'lucide-react';
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
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const createForkFromCurrent = useSessionStore(s => s.createForkFromCurrent);

  const sessions = useSessionStore(s => s.sessions);
  const loadSessions = useSessionStore(s => s.loadSessions);

  // Group tabs by location (same host + workdir), not by fork tree
  const currentSession = sessions.find(s => s.id === sessionId);
  const locationSiblings = React.useMemo(() => {
    if (!currentSession) return [];
    const workdir = currentSession.worktreePath || currentSession.repoPath || '';
    const host = (currentSession as any).sshConfig?.host;
    return sessions.filter(s => {
      if (s.status !== 'running') return false;
      const sWorkdir = s.worktreePath || s.repoPath || '';
      if (!sWorkdir || !workdir) return false;
      if (host) {
        return (s as any).sshConfig?.host === host && sWorkdir === workdir;
      }
      return sWorkdir === workdir;
    }).sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
  }, [sessions, currentSession]);
  const locationKey = currentSession
    ? `${(currentSession as any).sshConfig?.host || 'local'}:${currentSession.worktreePath || currentSession.repoPath || ''}`
    : sessionId;

  // Auto-scan remote transcripts on mount for SSH sessions.
  // Creates session records for any orphaned transcripts in the same directory
  // so they appear in the overflow menu without manual intervention.
  const hasScanned = useRef(false);
  useEffect(() => {
    if (hasScanned.current) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session?.sshConfig) return;
    hasScanned.current = true;

    window.electronAPI?.sessions?.scanRemoteTranscripts?.(sessionId).then((newSessions) => {
      if (newSessions && newSessions.length > 0) {
        console.log(`[ForkTabs] Discovered ${newSessions.length} orphaned remote transcript(s)`);
        loadSessions();
      }
    }).catch((err: unknown) => {
      console.warn('[ForkTabs] Remote scan failed:', err);
    });
  }, [sessionId, locationKey, sessions, loadSessions]);

  // Persist overflow (closed) tabs — merge localStorage + backend tabHidden flag
  const storageKey = `grep-overflow-forks-${locationKey}`;
  const [overflowIds, setOverflowIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      const fromStorage = stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
      // Also include sessions flagged as tabHidden from backend
      for (const s of locationSiblings) {
        if ((s as any).tabHidden) fromStorage.add(s.id);
      }
      return fromStorage;
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
    try {
      await window.electronAPI.sessions.update(renamingId, {
        aiGeneratedName: renameValue.trim(),
      } as any);
      loadSessions();
    } catch (e) {
      console.warn('[ForkTabs] Rename failed:', e);
    }
    setRenamingId(null);
  }, [renamingId, renameValue, loadSessions]);

  // Drag-and-drop reorder state
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Persist tab order in localStorage
  const orderKey = `grep-tab-order-${locationKey}`;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(orderKey);
      if (stored) setTabOrder(JSON.parse(stored));
    } catch { /* ignore */ }
  }, [orderKey]);

  const saveTabOrder = useCallback((order: string[]) => {
    setTabOrder(order);
    localStorage.setItem(orderKey, JSON.stringify(order));
  }, [orderKey]);

  // Build visible forks with custom ordering
  const visibleForks = useMemo(() => {
    const visible = locationSiblings.filter(f => !overflowIds.has(f.id));
    if (tabOrder.length === 0) return visible;
    // Sort by saved order; any new tabs not in the order go to the end
    const orderMap = new Map(tabOrder.map((id, i) => [id, i]));
    return [...visible].sort((a, b) => {
      const ai = orderMap.get(a.id) ?? Infinity;
      const bi = orderMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }, [locationSiblings, overflowIds, tabOrder]);

  // Overflow: closed tabs (hidden from the tab bar)
  const closedTabs = locationSiblings.filter(f => overflowIds.has(f.id));
  const hasOverflowItems = closedTabs.length > 0;

  const handleClose = useCallback((e: React.MouseEvent, forkId: string) => {
    e.stopPropagation();
    setOverflowIds(prev => new Set(prev).add(forkId));
    // Persist to backend so it survives restart
    window.electronAPI.sessions.update(forkId, { tabHidden: true } as any).catch(() => {});

    if (forkId === activeSessionId) {
      const remaining = locationSiblings.filter(f => f.id !== forkId && !overflowIds.has(f.id));
      if (remaining.length > 0) {
        setActiveSession(remaining[0].id);
      }
    }
  }, [activeSessionId, locationSiblings, overflowIds, setActiveSession]);

  const handleRestore = useCallback((forkId: string) => {
    setOverflowIds(prev => {
      const next = new Set(prev);
      next.delete(forkId);
      return next;
    });
    // Clear backend hidden flag
    window.electronAPI.sessions.update(forkId, { tabHidden: false } as any).catch(() => {});
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
  const isSSH = !!(currentSession as any)?.sshConfig;
  if (!isSSH && locationSiblings.length <= 1) return null;

  return (
    <div className="border-b border-claude-border bg-claude-bg/50 text-xs font-mono">
      <div className="flex items-center px-3 py-1 overflow-x-auto">
        {visibleForks.map((fork, index) => {
          const isActive = fork.id === activeSessionId;
          const displayName = fork.aiGeneratedName || fork.name;
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
            const session = currentSession;
            if (session?.sshConfig) {
              try {
                const { worktreeScript: _, ...cleanConfig } = session.sshConfig as any;
                const newSession = await window.electronAPI.ssh.createSession({
                  name: session.name,
                  sshConfig: { ...cleanConfig, syncSettings: false },
                });
                if (newSession) {
                  useSessionStore.setState((state) => ({
                    sessions: [...state.sessions, newSession as any],
                  }));
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
            title={`${closedTabs.length} closed tab${closedTabs.length > 1 ? 's' : ''}`}
          >
            <MoreHorizontal size={12} />
            <span className="text-[9px]">{closedTabs.length}</span>
          </button>
        )}

        {/* Overflow dropdown — rendered via portal to escape overflow:auto clipping */}
        {showOverflow && ReactDOM.createPortal(
          <div
            ref={overflowRef}
            className="fixed bg-claude-surface border border-claude-border shadow-lg z-[9999] min-w-64 max-h-80 overflow-y-auto text-xs font-mono"
            style={{ top: dropdownPos.top, right: dropdownPos.right }}
          >
            {closedTabs.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-b border-claude-border">
                  <span className="text-[10px] font-semibold text-claude-text-secondary uppercase tracking-wide">Closed Tabs</span>
                </div>
                {closedTabs.map(fork => (
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
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}
