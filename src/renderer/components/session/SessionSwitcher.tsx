import React from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { useSessionSwitcher } from '../../hooks/useSessionSwitcher';
import { GitBranch, Circle, LayoutGrid } from 'lucide-react';

// Generate a consistent color from session ID
function getSessionColor(sessionId: string): string {
  const colors = [
    '#5D5FEF', // Purple (Claudette accent)
    '#3B82F6', // Blue
    '#10B981', // Green
    '#F59E0B', // Amber
    '#EF4444', // Red
    '#8B5CF6', // Violet
    '#EC4899', // Pink
    '#06B6D4', // Cyan
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
    case 'running': return '#10B981';
    case 'stopped': return '#6B7280';
    case 'error': return '#EF4444';
    default: return '#F59E0B';
  }
}

export default function SessionSwitcher() {
  const { isOpen, selectedIndex, orderedSessionIds, closeSwitcher } = useSessionSwitcher();
  const { sessions, activeSessionId } = useSessionStore();

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
        className="bg-claude-surface border border-claude-border p-6 max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div className="text-sm font-mono text-claude-text-secondary mb-4 text-center">
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

            return (
              <div
                key={sessionId}
                className={`flex-shrink-0 w-48 transition-all duration-150 cursor-pointer ${
                  isSelected
                    ? 'ring-2 ring-claude-accent scale-105'
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
                  className="h-28 flex items-center justify-center border border-claude-border"
                  style={{ backgroundColor: `${sessionColor}20` }}
                >
                  <div
                    className="w-16 h-16 flex items-center justify-center text-2xl font-bold text-white"
                    style={{ backgroundColor: sessionColor }}
                  >
                    {session.name.charAt(0).toUpperCase()}
                  </div>
                </div>

                {/* Session info */}
                <div className="p-2 bg-claude-bg border-x border-b border-claude-border">
                  <div className="flex items-center gap-2">
                    <Circle
                      size={8}
                      fill={getStatusColor(session.status)}
                      color={getStatusColor(session.status)}
                    />
                    <span className="text-sm font-mono text-claude-text truncate flex-1">
                      {session.name.split(' - ')[0]}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] px-1 bg-claude-accent text-white">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-claude-text-secondary mt-1">
                    <GitBranch size={10} />
                    <span className="truncate">{session.branch}</span>
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
            className={`flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase border transition-colors ${
              useUIStore.getState().isCommandCenterActive
                ? 'border-claude-accent text-claude-accent bg-claude-accent/10'
                : 'border-claude-border text-claude-text-secondary hover:text-claude-text hover:border-claude-text-secondary'
            }`}
            style={{ letterSpacing: '0.1em', borderRadius: 0 }}
          >
            <LayoutGrid size={12} />
            Command Center
          </button>
        </div>

        {/* Keyboard hints */}
        <div className="mt-4 text-center text-[10px] text-claude-text-secondary font-mono">
          <kbd className="px-1.5 py-0.5 bg-claude-bg border border-claude-border">Tab</kbd>
          <span className="mx-1">next</span>
          <span className="mx-2 text-claude-border">|</span>
          <kbd className="px-1.5 py-0.5 bg-claude-bg border border-claude-border">Shift+Tab</kbd>
          <span className="mx-1">prev</span>
          <span className="mx-2 text-claude-border">|</span>
          <span className="mx-1">Release</span>
          <kbd className="px-1.5 py-0.5 bg-claude-bg border border-claude-border">Ctrl</kbd>
          <span className="mx-1">to switch</span>
          <span className="mx-2 text-claude-border">|</span>
          <kbd className="px-1.5 py-0.5 bg-claude-bg border border-claude-border">Esc</kbd>
          <span className="mx-1">cancel</span>
        </div>
      </div>
    </div>
  );
}
