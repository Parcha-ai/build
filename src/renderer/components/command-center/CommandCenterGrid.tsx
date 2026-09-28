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
  // Read-only maps for the header summary line
  const isStreamingMap = useSessionStore((s) => s.isStreaming);
  const pendingPermissionMap = useSessionStore((s) => s.pendingPermission);
  const pendingQuestionMap = useSessionStore((s) => s.pendingQuestion);

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

  const summary = useMemo(() => {
    let running = 0;
    let waiting = 0;
    for (const cell of gridCells) {
      const ids = cell.forks.map(f => f.id);
      if (ids.some(id => pendingPermissionMap[id] || pendingQuestionMap[id])) waiting++;
      else if (ids.some(id => isStreamingMap[id])) running++;
    }
    return { total: gridCells.length, running, waiting };
  }, [gridCells, isStreamingMap, pendingPermissionMap, pendingQuestionMap]);

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
      className={`flex-1 flex flex-col overflow-hidden bg-ink-0 ${isDragOver ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header — title + live summary */}
      <div className="flex items-end gap-4 px-8 pt-7 pb-5 flex-shrink-0">
        <div className="min-w-0">
          <div className="text-[22px] leading-[1.2] font-semibold tracking-[-0.02em] text-fg">
            Command Center
          </div>
          {summary.total > 0 && (
            <div className="text-[13.5px] text-fg-3 mt-1.5">
              {summary.total} {summary.total === 1 ? 'session' : 'sessions'}
              {' · '}{summary.running} running
              {summary.waiting > 0 && <> · <span className="text-amber">{summary.waiting} waiting on you</span></>}
            </div>
          )}
        </div>
      </div>

      {/* Grid container — wrapper div with explicit width for horizontal scroll */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden px-8 pb-6 pt-1">
        <div
          className="h-full gap-3.5"
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
          className="flex items-center justify-center border border-dashed border-line-strong hover:border-fg-5 hover:bg-white/[0.02] cursor-pointer transition-colors min-w-[400px] relative"
          style={{ borderRadius: 0 }}
          onClick={() => setShowPicker(!showPicker)}
        >
          <div className="flex flex-col items-center gap-2 text-fg-4">
            <Plus size={20} />
            <span className="text-[13px] font-medium">
              Add session
            </span>
          </div>

          {/* Session picker dropdown */}
          {showPicker && availableSessions.length > 0 && (
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 max-h-72 overflow-y-auto bg-ink-1 z-50"
              style={{ borderRadius: 0, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1), 0 12px 40px rgba(0,0,0,0.45)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-2 border-b border-line">
                <span className="text-[11px] text-fg-4 uppercase tracking-[0.04em]">
                  Select session
                </span>
              </div>
              {availableSessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => handleAddSession(s.id)}
                  className="w-full text-left px-3 py-2 hover:bg-claude-surface-hover transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        s.status === 'running' ? 'bg-diff-add' : 'bg-fg-5'
                      }`}
                    />
                    <span className="text-[13px] text-fg truncate">
                      {getSessionDisplayName(s)}
                    </span>
                    {s.isStarred && (
                      <span className="text-amber text-[10px]">&#9733;</span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-fg-4 mt-0.5 pl-3.5 truncate">
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
