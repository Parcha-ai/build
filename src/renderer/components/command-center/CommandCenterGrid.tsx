import React, { useEffect, useMemo, useCallback, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import CommandCenterCell from './CommandCenterCell';
import type { Session } from '../../../shared/types';
import { getSessionDisplayName } from '../../utils/session-display';

export default function CommandCenterGrid() {
  const sessions = useSessionStore((s) => s.sessions);
  const commandCenterSessionIds = useSessionStore((s) => s.commandCenterSessionIds);
  const addToCommandCenter = useSessionStore((s) => s.addToCommandCenter);
  const getForkSiblings = useSessionStore((s) => s.getForkSiblings);
  const focusedSessionId = useUIStore((s) => s.commandCenterFocusedSessionId);
  const setFocused = useUIStore((s) => s.setCommandCenterFocusedSession);

  const [showPicker, setShowPicker] = useState(false);

  // Auto-focus the first cell if nothing is focused
  useEffect(() => {
    if (!focusedSessionId && commandCenterSessionIds.length > 0) {
      setFocused(commandCenterSessionIds[0]);
    }
  }, [focusedSessionId, commandCenterSessionIds, setFocused]);

  // Build grid cells: each root session + its forks become one cell
  // Order matches commandCenterSessionIds (which follows starred order)
  const gridCells = useMemo(() => {
    const cells: Array<{ rootSession: Session; forks: Session[] }> = [];
    const seen = new Set<string>();

    for (const id of commandCenterSessionIds) {
      if (seen.has(id)) continue;
      const session = sessions.find(s => s.id === id);
      if (!session) continue;

      // Resolve to root if this is a fork child
      let rootId = id;
      let s = session;
      while (s?.parentSessionId) {
        rootId = s.parentSessionId;
        s = sessions.find(x => x.id === rootId) as typeof s;
      }
      if (seen.has(rootId)) continue;

      // Get all fork siblings (includes root + children)
      const forks = getForkSiblings(rootId);
      // Mark all fork IDs as seen so we don't create duplicate cells
      for (const fork of forks) seen.add(fork.id);
      seen.add(rootId);
      // If getForkSiblings returns empty, just use the root session
      const rootSession = sessions.find(x => x.id === rootId) || session;
      const forkList = forks.length > 0 ? forks : [rootSession];

      cells.push({ rootSession, forks: forkList });
    }

    return cells;
  }, [commandCenterSessionIds, sessions, getForkSiblings]);

  // Sessions not yet in the grid (for the add picker) — exclude forks (only show roots)
  const availableSessions = useMemo(() => {
    const inGrid = new Set<string>();
    for (const cell of gridCells) {
      inGrid.add(cell.rootSession.id);
      for (const f of cell.forks) inGrid.add(f.id);
    }
    return sessions
      .filter(s => !inGrid.has(s.id) && !s.parentSessionId)
      .sort((a, b) => {
        // Starred first, then by most recently updated
        if (a.isStarred && !b.isStarred) return -1;
        if (!a.isStarred && b.isStarred) return 1;
        const aTime = new Date(a.updatedAt).getTime();
        const bTime = new Date(b.updatedAt).getTime();
        return bTime - aTime;
      });
  }, [sessions, gridCells]);

  const handleAddSession = useCallback((sessionId: string) => {
    addToCommandCenter(sessionId);
    setShowPicker(false);
  }, [addToCommandCenter]);

  // Total items including the "+" add button
  const totalItems = gridCells.length + 1;
  const numColumns = Math.ceil(totalItems / 2);
  const useFixedColumns = numColumns > 1;

  // Handle drag-and-drop from sidebar
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const sessionId = e.dataTransfer.getData('text/session-id');
    if (sessionId) {
      addToCommandCenter(sessionId);
    }
  }, [addToCommandCenter]);

  return (
    <div
      className={`flex-1 flex flex-col overflow-hidden ${isDragOver ? 'ring-2 ring-claude-accent ring-inset' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Grid container — wrapper div with explicit width for horizontal scroll */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-2">
        <div
          className="h-full gap-2"
          style={{
            display: 'grid',
            gridTemplateRows: '1fr 1fr',
            gridAutoFlow: 'column',
            gridTemplateColumns: useFixedColumns
              ? `repeat(${numColumns}, minmax(420px, 1fr))`
              : '1fr',
            minWidth: useFixedColumns ? `${numColumns * 420}px` : undefined,
          }}
        >
        {gridCells.map(({ rootSession, forks }) => (
          <CommandCenterCell
            key={rootSession.id}
            session={rootSession}
            forks={forks}
            isFocused={focusedSessionId === rootSession.id}
          />
        ))}

        {/* Add button cell */}
        <div
          className="flex items-center justify-center border border-dashed border-claude-border hover:border-claude-text-secondary/40 cursor-pointer transition-colors min-w-[400px] relative"
          style={{ borderRadius: 0 }}
          onClick={() => setShowPicker(!showPicker)}
        >
          <div className="flex flex-col items-center gap-2 text-claude-text-secondary">
            <Plus size={24} />
            <span className="text-[10px] font-bold uppercase" style={{ letterSpacing: '0.1em' }}>
              Add Session
            </span>
          </div>

          {/* Session picker dropdown */}
          {showPicker && availableSessions.length > 0 && (
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 max-h-64 overflow-y-auto bg-claude-surface border border-claude-border shadow-xl z-50"
              style={{ borderRadius: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1.5 border-b border-claude-border">
                <span className="text-[10px] font-bold text-claude-text-secondary uppercase" style={{ letterSpacing: '0.1em' }}>
                  Select Session
                </span>
              </div>
              {availableSessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => handleAddSession(s.id)}
                  className="w-full text-left px-3 py-2 hover:bg-claude-bg transition-colors border-b border-claude-border/50"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-1.5 h-1.5 flex-shrink-0 ${
                        s.status === 'running' ? 'bg-green-500' : 'bg-gray-500'
                      }`}
                      style={{ borderRadius: 0 }}
                    />
                    <span className="text-xs font-bold text-claude-text truncate">
                      {getSessionDisplayName(s)}
                    </span>
                    {s.isStarred && (
                      <span className="text-amber-400 text-[10px]">&#9733;</span>
                    )}
                  </div>
                  <div className="text-[10px] text-claude-text-secondary mt-0.5 pl-3.5 truncate">
                    {s.branch}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
