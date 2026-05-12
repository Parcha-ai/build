import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import { prioritizeSessions, groupByPriority, PRIORITY_CONFIG } from '../../utils/sessionPriority';
import type { SessionPriority } from '../../utils/sessionPriority';
import AgentViewSessionRow from './AgentViewSessionRow';
import MessageList from '../chat/MessageList';
import InputArea from '../chat/InputArea';
import PermissionDialog from '../chat/PermissionDialog';
import QuestionDialog from '../chat/QuestionDialog';

// Stable empty arrays to avoid reference changes
const EMPTY_MESSAGES: never[] = [];
const EMPTY_EVENTS: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];
const EMPTY_QUEUE: never[] = [];

const PRIORITY_ORDER: SessionPriority[] = ['needs-input', 'error', 'active', 'idle'];

export default function AgentView() {
  // Store state
  const sessions = useSessionStore((s) => s.sessions);
  const allMessages = useSessionStore((s) => s.messages);
  const pendingPermission = useSessionStore((s) => s.pendingPermission);
  const pendingQuestion = useSessionStore((s) => s.pendingQuestion);
  const isStreamingMap = useSessionStore((s) => s.isStreaming);
  const contextUsage = useSessionStore((s) => s.contextUsage);

  const {
    agentViewSelectedSessionId,
    agentViewTimeFilterHours,
    setAgentViewSelectedSession,
    setAgentViewTimeFilterHours,
  } = useUIStore();

  // Actions
  const approvePermission = useSessionStore((s) => s.approvePermission);
  const denyPermission = useSessionStore((s) => s.denyPermission);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const cancelQuestion = useSessionStore((s) => s.cancelQuestion);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const loadMessages = useSessionStore((s) => s.loadMessages);

  // Local state
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  // Load messages for all root sessions so we can filter by activity
  useEffect(() => {
    for (const s of sessions) {
      if (!s.parentSessionId && !allMessages[s.id]) {
        loadMessages(s.id);
      }
    }
  }, [sessions, allMessages, loadMessages]);

  // Prioritize and sort sessions
  const prioritizedSessions = useMemo(() => {
    return prioritizeSessions(sessions, allMessages, pendingPermission, pendingQuestion, isStreamingMap, agentViewTimeFilterHours);
  }, [sessions, allMessages, pendingPermission, pendingQuestion, isStreamingMap, agentViewTimeFilterHours]);

  // Group by priority tier for traffic light display
  const groupedSessions = useMemo(() => {
    return groupByPriority(prioritizedSessions);
  }, [prioritizedSessions]);

  // Auto-select highest priority session on mount or when selection becomes invalid
  useEffect(() => {
    const selectedStillValid = prioritizedSessions.some((p) => p.session.id === agentViewSelectedSessionId);
    if (!selectedStillValid && prioritizedSessions.length > 0) {
      setAgentViewSelectedSession(prioritizedSessions[0].session.id);
    }
  }, [prioritizedSessions, agentViewSelectedSessionId, setAgentViewSelectedSession]);

  // Selected session details
  const selectedId = agentViewSelectedSessionId;
  const selectedSession = useMemo(() => {
    return sessions.find((s) => s.id === selectedId) || null;
  }, [sessions, selectedId]);

  // -- Right panel selectors (following CommandCenterCell pattern) --
  const sessionMessages = useSessionStore(useCallback((s) => selectedId ? (s.messages[selectedId] || EMPTY_MESSAGES) : EMPTY_MESSAGES, [selectedId]));
  const isSessionStreaming = useSessionStore(useCallback((s) => selectedId ? (s.isStreaming[selectedId] || false) : false, [selectedId]));
  const sessionStreamEvents = useSessionStore(useCallback((s) => selectedId ? (s.streamEvents[selectedId] || EMPTY_EVENTS) : EMPTY_EVENTS, [selectedId]));
  const streamContent = useSessionStore(useCallback((s) => selectedId ? (s.currentStreamContent[selectedId] || '') : '', [selectedId]));
  const streamingToolCalls = useSessionStore(useCallback((s) => selectedId ? (s.currentToolCalls[selectedId] || EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS, [selectedId]));
  const queuedMessages = useSessionStore(useCallback((s) => selectedId ? (s.messageQueue[selectedId] || EMPTY_QUEUE) : EMPTY_QUEUE, [selectedId]));
  const isLoadingMessages = useSessionStore(useCallback((s) => selectedId ? (s.isLoadingMessages[selectedId] || false) : false, [selectedId]));
  const currentPermission = useSessionStore(useCallback((s) => selectedId ? (s.pendingPermission[selectedId] || null) : null, [selectedId]));
  const currentQuestion = useSessionStore(useCallback((s) => selectedId ? (s.pendingQuestion[selectedId] || null) : null, [selectedId]));

  // Load messages when selected session changes
  useEffect(() => {
    if (selectedId) {
      loadMessages(selectedId);
    }
  }, [selectedId, loadMessages]);

  // Auto-scroll to bottom
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitially = useRef(false);
  useEffect(() => {
    if (sessionMessages.length > 0 || streamContent) {
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: hasScrolledInitially.current ? 'smooth' : 'auto' });
        hasScrolledInitially.current = true;
      }, hasScrolledInitially.current ? 100 : 50);
      return () => clearTimeout(timer);
    }
  }, [sessionMessages.length, streamContent, isSessionStreaming]);

  // Reset scroll on session switch
  useEffect(() => {
    hasScrolledInitially.current = false;
  }, [selectedId]);

  // Close dropdown on outside click
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
    <div className="flex h-full overflow-hidden font-mono">
      {/* Left panel — session list with traffic light grouping */}
      <div className="flex flex-col overflow-hidden border-r border-claude-border" style={{ width: 320, flexShrink: 0 }}>
        {/* Header */}
        <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-claude-text-secondary uppercase" style={{ letterSpacing: '0.1em' }}>
              AGENT VIEW
            </span>
            <span className="text-[10px] text-claude-text-secondary">
              ({prioritizedSessions.length})
            </span>
          </div>
          {/* Time filter dropdown */}
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

        {/* Session list — grouped by priority tier */}
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
                  {/* Traffic light section header */}
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
                  {/* Sessions in this tier */}
                  {group.map(({ session, priority: p }) => (
                    <AgentViewSessionRow
                      key={session.id}
                      session={session}
                      priority={p}
                      isSelected={session.id === selectedId}
                      isStreaming={isStreamingMap[session.id] || false}
                      contextPercentage={contextUsage[session.id]?.percentage}
                      onClick={() => setAgentViewSelectedSession(session.id)}
                    />
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel — chat for selected session */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedSession ? (
          <>
            {/* Header */}
            <div className="h-8 flex items-center px-3 bg-claude-surface/50 border-b border-claude-border flex-shrink-0">
              <div className={`w-1.5 h-1.5 flex-shrink-0 mr-2 ${selectedSession.status === 'running' ? 'bg-green-500' : selectedSession.status === 'error' ? 'bg-red-500' : 'bg-gray-500'}`} style={{ borderRadius: 0 }} />
              <span className="text-[11px] font-bold text-claude-text uppercase" style={{ letterSpacing: '0.05em' }}>
                {selectedSession.forkName || selectedSession.name}
              </span>
              {selectedSession.branch && (
                <span className="text-[10px] text-claude-text-secondary ml-2 truncate">
                  {selectedSession.branch}
                </span>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              <MessageList
                messages={sessionMessages}
                isStreaming={isSessionStreaming}
                isLoadingMessages={isLoadingMessages}
                streamEvents={sessionStreamEvents}
                streamContent={streamContent}
                streamingToolCalls={streamingToolCalls}
                currentToolCalls={streamingToolCalls}
                queuedMessages={queuedMessages}
                onBackgroundTask={() => {}}
              />
              <div ref={messagesEndRef} />
            </div>

            {/* Permission dialog */}
            {currentPermission && (
              <div className="border-t border-claude-border px-2 py-1.5 bg-claude-surface">
                <PermissionDialog
                  request={currentPermission}
                  onApprove={(modifiedInput, alwaysApprove) => approvePermission(selectedId!, modifiedInput, alwaysApprove)}
                  onDeny={() => denyPermission(selectedId!)}
                  onBuildIt={() => {
                    setPermissionMode(selectedId!, 'bypassPermissions');
                    approvePermission(selectedId!);
                  }}
                />
              </div>
            )}

            {/* Question dialog */}
            {currentQuestion && (
              <div className="border-t border-claude-border px-2 py-1.5 bg-claude-surface">
                <QuestionDialog
                  request={currentQuestion}
                  onAnswer={(answers) => answerQuestion(selectedId!, answers)}
                  onCancel={() => cancelQuestion(selectedId!)}
                />
              </div>
            )}

            {/* Input */}
            <InputArea
              sessionId={selectedId!}
              disabled={selectedSession.status !== 'running'}
              isStreaming={isSessionStreaming}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-claude-text-secondary">
            <div className="text-center">
              <div className="text-[10px] font-bold uppercase mb-1" style={{ letterSpacing: '0.1em' }}>NO SESSION SELECTED</div>
              <div className="text-[10px]">Select a session from the left panel</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
