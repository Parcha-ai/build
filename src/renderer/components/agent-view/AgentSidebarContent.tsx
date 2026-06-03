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
      <div className="px-3 py-1.5 flex items-center justify-between border-b border-claude-border bg-claude-surface/50 flex-shrink-0">
        <span className="text-[10px] text-claude-text-secondary">
          {prioritizedSessions.length} session{prioritizedSessions.length !== 1 ? 's' : ''}
        </span>
        <div className="relative" ref={filterDropdownRef}>
          <button
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className="flex items-center gap-1 text-[10px] text-claude-text-secondary hover:text-claude-text"
          >
            <Clock size={10} />
            <span>{agentViewTimeFilterHours}h</span>
            <ChevronDown size={8} />
          </button>
          {showFilterDropdown && (
            <div className="absolute top-full right-0 mt-1 bg-claude-surface border border-claude-border shadow-lg z-50">
              {[6, 12, 24, 48].map(hours => (
                <button
                  key={hours}
                  onClick={() => {
                    setAgentViewTimeFilterHours(hours);
                    setShowFilterDropdown(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-claude-bg ${
                    hours === agentViewTimeFilterHours ? 'text-claude-accent' : 'text-claude-text'
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
      <div className="flex-1 overflow-y-auto">
        {prioritizedSessions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-claude-text-secondary">
            <div className="text-center px-4">
              <div className="text-[10px] font-bold uppercase mb-1" style={{ letterSpacing: '0.1em' }}>NO SESSIONS</div>
              <div className="text-[10px]">No active sessions in the last {agentViewTimeFilterHours}h</div>
            </div>
          </div>
        ) : (
          PRIORITY_ORDER.map(priority => {
            const group = groupedSessions.get(priority);
            if (!group || group.length === 0) return null;
            const config = PRIORITY_CONFIG[priority];
            return (
              <div key={priority}>
                <div
                  className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 border-b border-claude-border"
                  style={{ backgroundColor: `${config.color}10` }}
                >
                  <div
                    className={`w-2.5 h-2.5 flex-shrink-0 ${config.dotClass}`}
                    style={{ borderRadius: 0 }}
                  />
                  <span
                    className="text-[9px] font-bold uppercase"
                    style={{ letterSpacing: '0.1em', color: config.color }}
                  >
                    {config.label}
                  </span>
                  <span className="text-[9px] text-claude-text-secondary">
                    ({group.length})
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
