import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from '../chat/MessageList';
import PermissionDialog from '../chat/PermissionDialog';
import QuestionDialog from '../chat/QuestionDialog';
import InputArea from '../chat/InputArea';
import type { Session } from '../../../shared/types';
import { canSendMessageToSession } from '../../utils/session-input';
import { getSessionDisplayName } from '../../utils/session-display';
import PullRequestStatusIcon from '../git/PullRequestStatusIcon';

// Stable empty arrays to avoid reference changes
const EMPTY_MESSAGES: never[] = [];
const EMPTY_EVENTS: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];
const EMPTY_QUEUE: never[] = [];

interface CommandCenterCellProps {
  session: Session;    // Root session (or standalone)
  forks: Session[];    // All siblings including root, sorted
  isFocused: boolean;
}

export default function CommandCenterCell({ session, forks, isFocused }: CommandCenterCellProps) {
  // If there are forks, allow switching between them via tabs
  const [activeTabId, setActiveTabId] = useState(session.id);
  const hasForks = forks.length > 1;

  // The session whose messages we actually display
  const displaySession = useMemo(() => {
    if (!hasForks) return session;
    return forks.find(f => f.id === activeTabId) || session;
  }, [hasForks, forks, activeTabId, session]);

  const displayId = displaySession.id;

  const sessionMessages = useSessionStore(useCallback((s) => s.messages[displayId] || EMPTY_MESSAGES, [displayId]));
  const isSessionStreaming = useSessionStore(useCallback((s) => s.isStreaming[displayId] || false, [displayId]));
  const sessionStreamEvents = useSessionStore(useCallback((s) => s.streamEvents[displayId] || EMPTY_EVENTS, [displayId]));
  const streamContent = useSessionStore(useCallback((s) => s.currentStreamContent[displayId] || '', [displayId]));
  const streamingToolCalls = useSessionStore(useCallback((s) => s.currentToolCalls[displayId] || EMPTY_TOOL_CALLS, [displayId]));
  const queuedMessages = useSessionStore(useCallback((s) => s.messageQueue[displayId] || EMPTY_QUEUE, [displayId]));
  const isLoadingMessages = useSessionStore(useCallback((s) => s.isLoadingMessages[displayId] || false, [displayId]));
  const currentPermission = useSessionStore(useCallback((s) => s.pendingPermission[displayId] || null, [displayId]));
  const currentQuestion = useSessionStore(useCallback((s) => s.pendingQuestion[displayId] || null, [displayId]));

  const approvePermission = useSessionStore((s) => s.approvePermission);
  const denyPermission = useSessionStore((s) => s.denyPermission);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const cancelQuestion = useSessionStore((s) => s.cancelQuestion);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const removeFromCommandCenter = useSessionStore((s) => s.removeFromCommandCenter);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const loadMessages = useSessionStore((s) => s.loadMessages);
  const startSession = useSessionStore((s) => s.startSession);

  const setFocused = useUIStore((s) => s.setCommandCenterFocusedSession);
  const toggleCommandCenter = useUIStore((s) => s.toggleCommandCenter);
  const loadedMessageSessionIds = useRef(new Set<string>());

  // Refs for auto-scroll
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitially = useRef(false);

  // Load only the visible tab's messages, once. Loading every fork whenever
  // the fork array identity changes makes Command Center expensive during
  // active streaming.
  useEffect(() => {
    if (loadedMessageSessionIds.current.has(displayId)) return;
    loadedMessageSessionIds.current.add(displayId);
    loadMessages(displayId);
  }, [displayId, loadMessages]);

  // Start the session if it's stopped when first added to Command Center
  const initialStatusRef = useRef(session.status);
  useEffect(() => {
    if (initialStatusRef.current === 'stopped') {
      startSession(session.id);
    }
  }, [session.id, startSession]);

  // Auto-scroll to bottom on initial load and when new messages arrive
  useEffect(() => {
    if (sessionMessages.length > 0 || streamContent) {
      // Small delay to let DOM render
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: hasScrolledInitially.current ? 'smooth' : 'auto' });
        hasScrolledInitially.current = true;
      }, hasScrolledInitially.current ? 100 : 50);
      return () => clearTimeout(timer);
    }
  }, [sessionMessages.length, streamContent, isSessionStreaming]);

  // Reset scroll when switching fork tabs
  useEffect(() => {
    hasScrolledInitially.current = false;
  }, [activeTabId]);

  const handleFocus = useCallback(() => {
    setFocused(session.id);
  }, [session.id, setFocused]);

  const handleDoubleClickHeader = useCallback(() => {
    setActiveSession(displayId);
    toggleCommandCenter();
  }, [displayId, setActiveSession, toggleCommandCenter]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    removeFromCommandCenter(session.id);
  }, [session.id, removeFromCommandCenter]);
  const headerLabel = getSessionDisplayName(displaySession);

  const needsYou = !!(currentPermission || currentQuestion);

  // Status dot per Graphite spec: running = accent pulse, needs you = amber
  // with halo, error = red disc, transitional = muted pulse, idle = hollow ring.
  const renderStatusDot = (status: string) => {
    if (needsYou) {
      return (
        <span
          className="w-[7px] h-[7px] rounded-full bg-amber flex-shrink-0"
          style={{ boxShadow: '0 0 0 3px rgba(240,180,41,0.2)' }}
        />
      );
    }
    if (isSessionStreaming) {
      return <span className="w-[7px] h-[7px] rounded-full bg-accent flex-shrink-0 status-pulse" />;
    }
    switch (status) {
      case 'error':
        return (
          <span
            className="w-[14px] h-[14px] -mx-[3px] rounded-full flex items-center justify-center flex-shrink-0 text-diff-del"
            style={{ background: 'rgba(248,81,73,0.16)' }}
          >
            <X size={9} strokeWidth={3} />
          </span>
        );
      case 'starting': case 'stopping': case 'creating':
        return <span className="w-[7px] h-[7px] rounded-full bg-fg-4 flex-shrink-0 status-pulse" />;
      case 'running':
        return <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ boxShadow: 'inset 0 0 0 1.5px #666666' }} />;
      default:
        return <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.18)' }} />;
    }
  };

  // Mono harness/model tag (display-only derivation of session.model)
  const modelTag = displaySession.model
    ? displaySession.model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ').toUpperCase()
    : null;

  const repoName = (displaySession.repoPath || '').split('/').filter(Boolean).pop();
  const metaParts = [
    repoName,
    displaySession.sshConfig?.host ? `ssh ${displaySession.sshConfig.host}` : null,
    displaySession.branch,
  ].filter(Boolean) as string[];

  const cellShadow = needsYou
    ? 'inset 0 0 0 1px rgba(240,180,41,0.5), 0 0 0 4px rgba(240,180,41,0.08)'
    : isSessionStreaming
      ? 'inset 0 0 0 1px rgba(76,154,255,0.45), 0 0 0 4px rgba(76,154,255,0.08)'
      : isFocused
        ? 'inset 0 0 0 1px rgba(255,255,255,0.22)'
        : 'inset 0 0 0 1px rgba(255,255,255,0.08)';

  return (
    <div
      className="flex flex-col overflow-hidden bg-[#171717] transition-shadow"
      style={{ borderRadius: 0, minWidth: 400, boxShadow: cellShadow }}
      onClick={handleFocus}
    >
      {/* Header — status dot, title, model tag; meta line; fork tabs */}
      <div
        className="flex flex-col gap-1 px-4 pt-3.5 pb-2.5 cursor-pointer flex-shrink-0"
        onDoubleClick={handleDoubleClickHeader}
      >
        <div className="flex items-center gap-2 min-w-0">
          {renderStatusDot(displaySession.status)}
          <span className="text-[14px] font-medium text-fg truncate min-w-0">
            {headerLabel}
          </span>
          {isSessionStreaming && (
            <span className="text-[11px] text-accent-text flex-shrink-0 text-shimmer">
              Active
            </span>
          )}
          <PullRequestStatusIcon
            sessionId={displaySession.id}
            branch={displaySession.branch}
            size={11}
          />
          <div className="flex-1" />
          {modelTag && (
            <span
              className="font-mono text-[9.5px] px-1.5 py-0.5 text-fg-3 flex-shrink-0 whitespace-nowrap"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.16)' }}
            >
              {modelTag}
            </span>
          )}
          <button
            onClick={handleRemove}
            className="w-5 h-5 flex items-center justify-center text-fg-4 hover:text-diff-del hover:bg-white/5 flex-shrink-0"
            style={{ borderRadius: 0 }}
            title="Remove from Command Center"
          >
            <X size={12} />
          </button>
        </div>
        {metaParts.length > 0 && (
          <div className="font-mono text-[11px] text-fg-4 pl-[15px] truncate">
            {metaParts.join(' · ')}
          </div>
        )}

        {/* Fork tabs — only when session has forks */}
        {hasForks && (
          <div className="flex items-center gap-0.5 mt-1.5 pl-[15px] overflow-x-auto min-w-0">
            {forks.map((fork) => {
              const isActive = fork.id === activeTabId;
              const isRoot = !fork.parentSessionId;
              const label = isRoot ? 'Root' : getSessionDisplayName(fork);
              return (
                <button
                  key={fork.id}
                  onClick={(e) => { e.stopPropagation(); setActiveTabId(fork.id); }}
                  className={`flex items-center px-2 py-1 text-[11.5px] whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-[#262626] text-fg'
                      : 'text-fg-4 hover:text-fg-2'
                  }`}
                  title={getSessionDisplayName(fork)}
                >
                  {label}
                  <PullRequestStatusIcon
                    sessionId={fork.id}
                    branch={fork.branch}
                    size={9}
                    interactive={false}
                    className="ml-1"
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Messages — scrollable, auto-scrolled to bottom */}
      <div ref={messagesContainerRef} className="flex-1 mx-3 bg-[#0B0B0B] overflow-y-auto overflow-x-hidden min-w-0">
        <MessageList
          sessionId={displayId}
          messages={sessionMessages}
          isStreaming={isSessionStreaming}
          isLoadingMessages={isLoadingMessages}
          streamEvents={sessionStreamEvents}
          streamContent={streamContent}
          streamingToolCalls={streamingToolCalls}
          currentToolCalls={streamingToolCalls}
          queuedMessages={queuedMessages}
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          onBackgroundTask={() => {}}
        />
        <div ref={messagesEndRef} />
      </div>

      {/* Permission dialog — only in focused cell */}
      {isFocused && currentPermission && (
        <div className="mx-3 mt-2 px-2 py-1.5 bg-ink-1">
          <PermissionDialog
            request={currentPermission}
            onApprove={(modifiedInput, alwaysApprove) => approvePermission(displayId, modifiedInput, alwaysApprove)}
            onDeny={() => denyPermission(displayId)}
            onBuildIt={() => {
              setPermissionMode(displayId, 'bypassPermissions');
              approvePermission(displayId);
            }}
          />
        </div>
      )}

      {/* Keep interactive requests visible even when another cell has focus. */}
      {!isFocused && currentQuestion && (
        <button
          type="button"
          className="flex-shrink-0 mx-3 mt-2 px-3 py-2 text-left text-[12px] font-medium text-amber hover:bg-[rgba(240,180,41,0.12)]"
          style={{ background: 'rgba(240,180,41,0.07)', boxShadow: 'inset 0 0 0 1px rgba(240,180,41,0.22)' }}
          onClick={(event) => {
            event.stopPropagation();
            handleFocus();
          }}
        >
          Question waiting · click to answer
        </button>
      )}

      {/* Question dialog — focused cell */}
      {isFocused && currentQuestion && (
        <div className="mx-3 mt-2 px-2 py-1.5 bg-ink-1">
          <QuestionDialog
            request={currentQuestion}
            onAnswer={(answers) => answerQuestion(displayId, answers)}
            onCancel={() => cancelQuestion(displayId)}
          />
        </div>
      )}

      {/* Full input area — same as chat view */}
      <InputArea
        sessionId={displayId}
        disabled={!canSendMessageToSession(displaySession)}
        isStreaming={isSessionStreaming}
      />
    </div>
  );
}
