import React from 'react';
import type { Session } from '../../../shared/types';
import type { SessionPriority } from '../../utils/sessionPriority';
import { PRIORITY_CONFIG } from '../../utils/sessionPriority';
import { getSessionDisplayName } from '../../utils/session-display';

interface AgentViewSessionRowProps {
  session: Session;
  priority: SessionPriority;
  isSelected: boolean;
  isStreaming: boolean;
  contextPercentage?: number;
  onClick: () => void;
}

export default function AgentViewSessionRow({
  session,
  priority,
  isSelected,
  isStreaming,
  contextPercentage,
  onClick,
}: AgentViewSessionRowProps) {
  const config = PRIORITY_CONFIG[priority];
  const displayName = getSessionDisplayName(session);

  const getRelativeTime = (date: Date) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-claude-border/50 border-l-2 transition-colors ${
        isSelected
          ? 'bg-claude-accent/10 border-l-claude-accent'
          : `hover:bg-claude-surface/50 ${config.bgClass}`
      }`}
      style={{ borderRadius: 0 }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-claude-text truncate flex-1">
          {displayName}
        </span>
        {isStreaming && (
          <span className="text-[8px] font-bold text-green-400 flex-shrink-0" style={{ letterSpacing: '0.05em' }}>
            LIVE
          </span>
        )}
        <span className="text-[9px] text-claude-text-secondary flex-shrink-0">
          {getRelativeTime(session.updatedAt)}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-0.5">
        {session.branch && (
          <span className="text-[10px] text-claude-text-secondary truncate">
            {session.branch}
          </span>
        )}
        <div className="flex-1" />
        {contextPercentage !== undefined && contextPercentage > 0 && (
          <div className="flex items-center gap-1">
            <div className="w-8 h-1 bg-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
              <div
                className={`h-full ${contextPercentage >= 75 ? 'bg-red-500' : contextPercentage >= 50 ? 'bg-amber-500' : 'bg-claude-accent'}`}
                style={{ width: `${Math.min(100, contextPercentage)}%` }}
              />
            </div>
            <span className="text-[8px] text-claude-text-secondary tabular-nums">{contextPercentage}%</span>
          </div>
        )}
      </div>

      {priority === 'needs-input' && (
        <div className="mt-1">
          <span className="text-[9px] font-bold text-red-400" style={{ letterSpacing: '0.05em' }}>
            AWAITING RESPONSE
          </span>
        </div>
      )}
      {priority === 'error' && session.errorMessage && (
        <div className="mt-1">
          <span className="text-[9px] text-amber-400 truncate block">
            {session.errorMessage}
          </span>
        </div>
      )}
    </button>
  );
}
