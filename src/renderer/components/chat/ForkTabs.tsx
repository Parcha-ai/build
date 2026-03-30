import React, { useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';

interface ForkTabsProps {
  sessionId: string;
}

/**
 * ForkTabs - Horizontal tab bar showing conversation forks
 * Displays when a session has conversation forks (parent + children)
 * Closing a tab hides it (doesn't delete the session)
 */
export default function ForkTabs({ sessionId }: ForkTabsProps) {
  const getForkSiblings = useSessionStore(s => s.getForkSiblings);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const createForkFromCurrent = useSessionStore(s => s.createForkFromCurrent);

  // Track closed/hidden tabs locally (persists within the component's lifecycle)
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());

  const forkSiblings = getForkSiblings(sessionId);
  const visibleForks = forkSiblings.filter(f => !closedTabs.has(f.id));

  const handleClose = useCallback((e: React.MouseEvent, forkId: string) => {
    e.stopPropagation();
    setClosedTabs(prev => new Set(prev).add(forkId));

    // If we closed the active tab, switch to the next visible one
    if (forkId === activeSessionId) {
      const remaining = forkSiblings.filter(f => f.id !== forkId && !closedTabs.has(f.id));
      if (remaining.length > 0) {
        // Prefer parent (root) session, then first sibling
        const root = remaining.find(f => !f.parentSessionId);
        setActiveSession(root?.id || remaining[0].id);
      }
    }
  }, [activeSessionId, forkSiblings, closedTabs, setActiveSession]);

  // Only show if there are multiple visible forks
  if (visibleForks.length <= 1) return null;

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
      </div>
    </div>
  );
}
