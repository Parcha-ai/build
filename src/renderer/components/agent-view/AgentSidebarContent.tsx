import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { prioritizeSessions, groupByPriority, PRIORITY_CONFIG } from '../../utils/sessionPriority';
import type { SessionPriority } from '../../utils/sessionPriority';
import AgentViewSessionRow from './AgentViewSessionRow';
import { getFirstVisibleTabSession } from '../../utils/session-display';

const PRIORITY_ORDER: SessionPriority[] = ['needs-input', 'error', 'active', 'idle'];

export default function AgentSidebarContent() {
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPermission = useSessionStore((s) => s.pendingPermission);
  const pendingQuestion = useSessionStore((s) => s.pendingQuestion);
  const isStreamingMap = useSessionStore((s) => s.isStreaming);
  const contextUsage = useSessionStore((s) => s.contextUsage);

  const agentViewSelectedSessionId = useUIStore((s) => s.agentViewSelectedSessionId);
  const agentViewTimeFilterHours = useUIStore((s) => s.agentViewTimeFilterHours);
  const setAgentViewSelectedSession = useUIStore((s) => s.setAgentViewSelectedSession);
  const setAgentViewTimeFilterHours = useUIStore((s) => s.setAgentViewTimeFilterHours);

  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const prioritizedSessions = useMemo(() => {
    return prioritizeSessions(sessions, pendingPermission, pendingQuestion, isStreamingMap, agentViewTimeFilterHours);
  }, [sessions, pendingPermission, pendingQuestion, isStreamingMap, agentViewTimeFilterHours]);

  const groupedSessions = useMemo(() => {
    return groupByPriority(prioritizedSessions);
  }, [prioritizedSessions]);

  useEffect(() => {
    const selectedStillValid = prioritizedSessions.some((p) => (
      getFirstVisibleTabSession(p.session, sessions).id === agentViewSelectedSessionId
    ));
    if (!selectedStillValid && prioritizedSessions.length > 0) {
      setAgentViewSelectedSession(getFirstVisibleTabSession(prioritizedSessions[0].session, sessions).id);
    }
  }, [prioritizedSessions, agentViewSelectedSessionId, sessions, setAgentViewSelectedSession]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false);
      }
    };
    if (showFilterDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showFilterDropdown]);

  return (
    <>
      {/* Agent view header with time filter */}
      <div className="mx-2.5 px-2.5 h-7 flex items-center justify-between border-b border-line flex-shrink-0">
        <span className="font-mono text-[10.5px] text-fg-4">
          {prioritizedSessions.length} session{prioritizedSessions.length !== 1 ? 's' : ''}
        </span>
        <div className="relative" ref={filterDropdownRef}>
          <button
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className="flex items-center gap-1 font-mono text-[10.5px] text-fg-4 hover:text-fg-2"
          >
            <Clock size={10} />
            <span>{agentViewTimeFilterHours}h</span>
            <ChevronDown size={8} />
          </button>
          {showFilterDropdown && (
            <div className="absolute top-full right-0 mt-1 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.35)] z-50 py-1">
              {[6, 12, 24, 48].map(hours => (
                <button
                  key={hours}
                  onClick={() => {
                    setAgentViewTimeFilterHours(hours);
                    setShowFilterDropdown(false);
                  }}
                  className={`w-full text-left px-3 h-7 text-[12px] whitespace-nowrap hover:bg-claude-surface-hover ${
                    hours === agentViewTimeFilterHours ? 'text-accent-text' : 'text-fg-2'
                  }`}
                >
                  Last {hours}h
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Priority-grouped session list */}
      <div className="flex-1 overflow-y-auto px-2.5">
        {prioritizedSessions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-fg-4">
            <div className="text-center px-4">
              <div className="text-[11px] uppercase tracking-[0.04em] mb-1 text-fg-3">No sessions</div>
              <div className="text-[11.5px] text-fg-5">No active sessions in the last {agentViewTimeFilterHours}h</div>
            </div>
          </div>
        ) : (
          PRIORITY_ORDER.map(priority => {
            const group = groupedSessions.get(priority);
            if (!group || group.length === 0) return null;
            const config = PRIORITY_CONFIG[priority];
            return (
              <div key={priority}>
                <div className="sticky top-0 z-10 flex items-center gap-2 px-2.5 pt-3 pb-1.5 bg-ink-0">
                  <span
                    className={`w-[7px] h-[7px] flex-shrink-0 rounded-full ${
                      priority === 'needs-input'
                        ? 'bg-amber shadow-[0_0_0_3px_rgba(240,180,41,0.18)]'
                        : priority === 'error'
                          ? 'bg-diff-del'
                          : priority === 'active'
                            ? 'bg-accent status-pulse'
                            : 'shadow-[inset_0_0_0_1.5px_#666666]'
                    }`}
                  />
                  <span className="text-[11px] uppercase tracking-[0.04em] text-fg-4">
                    {config.label}
                  </span>
                  <span className="font-mono text-[10.5px] text-fg-5">
                    {group.length}
                  </span>
                </div>
                {group.map(({ session, priority: p }) => {
                  const visibleTabSession = getFirstVisibleTabSession(session, sessions);
                  return (
                    <AgentViewSessionRow
                      key={session.id}
                      session={visibleTabSession}
                      priority={p}
                      isSelected={visibleTabSession.id === agentViewSelectedSessionId}
                      isStreaming={Boolean(isStreamingMap[visibleTabSession.id] || isStreamingMap[session.id])}
                      contextPercentage={contextUsage[visibleTabSession.id]?.percentage ?? contextUsage[session.id]?.percentage}
                      onClick={() => setAgentViewSelectedSession(visibleTabSession.id)}
                    />
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
