import React from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useSessionSwitcher } from '../../hooks/useSessionSwitcher';
import { GitBranch, Circle, LayoutGrid } from 'lucide-react';
import { getSessionDisplayName } from '../../utils/session-display';

// Generate a consistent color from session ID
function getSessionColor(sessionId: string): string {
  const colors = [
    '#4C9AFF', // Accent blue
    '#3FB950', // Green
    '#F0B429', // Amber
    '#F85149', // Red
    '#8DBBFF', // Accent text
    '#7EE2A0', // Soft green
    '#A0A0A0', // Graphite
    '#FFA198', // Soft red
  ];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash) + sessionId.charCodeAt(i);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

// Get status color
function getStatusColor(status: string): string {
  switch (status) {
    case 'running': return '#4C9AFF';
    case 'stopped': return '#666666';
    case 'error': return '#F85149';
    default: return '#F0B429';
  }
}

export default function SessionSwitcher() {
  const { isOpen, selectedIndex, orderedSessionIds, closeSwitcher } = useSessionSwitcher();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  if (!isOpen) return null;

  const getSession = (id: string) => sessions.find(s => s.id === id);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
      onClick={() => closeSwitcher()}
      tabIndex={-1}
      ref={(el) => el?.focus()}
    >
      <div
        className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.45)] p-6 max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-4 text-center">
          Switch Session
        </div>

        {/* Horizontal session strip */}
        <div className="flex gap-4 overflow-x-auto pb-2">
          {orderedSessionIds.map((sessionId, index) => {
            const session = getSession(sessionId);
            if (!session) return null;

            const isSelected = index === selectedIndex;
            const isCurrent = sessionId === activeSessionId;
            const sessionColor = getSessionColor(sessionId);
            const displayName = getSessionDisplayName(session);

            return (
              <div
                key={sessionId}
                className={`flex-shrink-0 w-48 transition-all duration-150 cursor-pointer ${
                  isSelected
                    ? 'shadow-[0_0_0_1.5px_#4C9AFF]'
                    : 'opacity-60 hover:opacity-80'
                }`}
                onClick={() => {
                  if (sessionId !== activeSessionId) {
                    useSessionStore.getState().setActiveSession(sessionId);
                  }
                  closeSwitcher();
                }}
              >
                {/* Color block representing the session */}
                <div
                  className="h-28 flex items-center justify-center bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                >
                  <div
                    className="w-14 h-14 flex items-center justify-center text-2xl font-semibold tracking-[-0.02em]"
                    style={{ backgroundColor: `${sessionColor}24`, color: sessionColor, boxShadow: `inset 0 0 0 1px ${sessionColor}55` }}
                  >
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                </div>

                {/* Session info */}
                <div className="px-2.5 py-2 bg-ink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                  <div className="flex items-center gap-2">
                    <Circle
                      size={8}
                      fill={getStatusColor(session.status)}
                      color={getStatusColor(session.status)}
                    />
                    <span className="text-[13px] font-medium text-fg truncate flex-1">
                      {displayName.split(' - ')[0]}
                    </span>
                    {isCurrent && (
                      <span className="font-mono text-[9.5px] px-[5px] py-px uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3 mt-1">
                    <GitBranch size={10} className="text-fg-4" />
                    <span className="font-mono text-[11px] truncate">{session.branch}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Command Center shortcut */}
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => {
              useUIStore.getState().toggleCommandCenter();
              closeSwitcher();
            }}
            className={`flex items-center gap-2 h-[30px] px-3 text-[12px] transition-colors ${
              useUIStore.getState().isCommandCenterActive
                ? 'bg-[rgba(76,154,255,0.13)] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] text-accent-text'
                : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] text-fg-2 hover:text-fg hover:bg-claude-surface-hover'
            }`}
          >
            <LayoutGrid size={12} />
            Command Center
          </button>
        </div>

        {/* Keyboard hints */}
        <div className="mt-4 text-center text-[10.5px] text-fg-5 font-mono">
          <kbd className="px-1.5 py-0.5 bg-ink-4 text-fg-3">Tab</kbd>
          <span className="mx-1">next</span>
          <span className="mx-2 text-fg-5/50">|</span>
          <kbd className="px-1.5 py-0.5 bg-ink-4 text-fg-3">Shift+Tab</kbd>
          <span className="mx-1">prev</span>
          <span className="mx-2 text-fg-5/50">|</span>
          <span className="mx-1">Release</span>
          <kbd className="px-1.5 py-0.5 bg-ink-4 text-fg-3">Ctrl</kbd>
          <span className="mx-1">to switch</span>
          <span className="mx-2 text-fg-5/50">|</span>
          <kbd className="px-1.5 py-0.5 bg-ink-4 text-fg-3">Esc</kbd>
          <span className="mx-1">cancel</span>
        </div>
      </div>
    </div>
  );
}
