import React from 'react';
import type { Session } from '../../../shared/types';
import type { SessionPriority } from '../../utils/sessionPriority';
import { getSessionDisplayName } from '../../utils/session-display';
import PullRequestStatusIcon from '../git/PullRequestStatusIcon';

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

  const statusDot =
    priority === 'needs-input'
      ? 'bg-amber shadow-[0_0_0_3px_rgba(240,180,41,0.18)]'
      : priority === 'error'
        ? 'bg-diff-del'
        : isStreaming || priority === 'active'
          ? 'bg-accent status-pulse'
          : 'shadow-[inset_0_0_0_1.5px_#666666]';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 flex items-start gap-2.5 transition-colors ${
        isSelected
          ? 'bg-claude-surface-hover'
          : 'hover:bg-claude-surface-hover/60'
      }`}
    >
      <span className={`mt-1.5 w-[7px] h-[7px] flex-shrink-0 rounded-full ${statusDot}`} />
      <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className={`text-[13px] leading-[18px] truncate flex-1 ${isSelected ? 'text-fg font-medium' : 'text-fg-2'}`}>
          {displayName}
        </span>
        {isStreaming && (
          <span className="font-mono text-[9.5px] px-[5px] py-px uppercase text-accent-text shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] flex-shrink-0">
            LIVE
          </span>
        )}
        <span className="font-mono text-[10.5px] text-fg-4 flex-shrink-0">
          {getRelativeTime(session.updatedAt)}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-0.5">
        {session.branch && (
          <span className="font-mono text-[11px] text-fg-3 truncate">
            {session.branch}
          </span>
        )}
        <PullRequestStatusIcon
          sessionId={session.id}
          branch={session.branch}
          size={10}
          interactive={false}
        />
        <div className="flex-1" />
        {contextPercentage !== undefined && contextPercentage > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-8 h-1 bg-[#262626] overflow-hidden">
              <div
                className={`h-full ${contextPercentage >= 75 ? 'bg-diff-del' : contextPercentage >= 50 ? 'bg-amber' : 'bg-fg-3'}`}
                style={{ width: `${Math.min(100, contextPercentage)}%` }}
              />
            </div>
            <span className="font-mono text-[10px] text-fg-4 tabular-nums">{contextPercentage}%</span>
          </div>
        )}
      </div>

      {priority === 'needs-input' && (
        <div className="mt-1">
          <span className="text-[11.5px] text-amber">
            Awaiting response
          </span>
        </div>
      )}
      {priority === 'error' && session.errorMessage && (
        <div className="mt-1">
          <span className="text-[11.5px] text-diff-del-text truncate block">
            {session.errorMessage}
          </span>
        </div>
      )}
      </div>
    </button>
  );
}
