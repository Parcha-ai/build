import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from '../chat/MessageList';
import PermissionDialog from '../chat/PermissionDialog';
import QuestionDialog from '../chat/QuestionDialog';
import InputArea from '../chat/InputArea';
import type { Session } from '../../../shared/types';

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

  // Refs for auto-scroll
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitially = useRef(false);

  // Load messages for ALL forks when cell mounts
  useEffect(() => {
    for (const fork of forks) {
      loadMessages(fork.id);
    }
  }, [forks, loadMessages]);

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

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'error': return 'bg-red-500';
      case 'starting': case 'stopping': case 'creating': return 'bg-yellow-500 animate-pulse';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div
      className={`flex flex-col overflow-hidden bg-claude-bg border transition-all ${
        isFocused
          ? 'border-claude-accent ring-2 ring-claude-accent/40'
          : 'border-claude-border hover:border-claude-text-secondary/40'
      }`}
      style={{ borderRadius: 0, minWidth: 400 }}
      onClick={handleFocus}
    >
      {/* Compact header — with fork tabs inline */}
      <div
        className="h-6 flex items-center px-2 bg-claude-surface/50 border-b border-claude-border cursor-pointer flex-shrink-0"
        onDoubleClick={handleDoubleClickHeader}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
          <div className={`w-1.5 h-1.5 flex-shrink-0 ${getStatusColor(displaySession.status)}`} style={{ borderRadius: 0 }} />
          <span className="text-[10px] font-bold text-claude-text truncate uppercase" style={{ letterSpacing: '0.05em' }}>
            {session.forkName || session.name}
          </span>
          {isSessionStreaming && (
            <span className="text-[9px] font-bold text-green-400 flex-shrink-0" style={{ letterSpacing: '0.05em' }}>
              ACTIVE
            </span>
          )}
        </div>

        {/* Fork tabs inline — only when session has forks */}
        {hasForks && (
          <div className="flex items-center ml-2 overflow-x-auto flex-1 min-w-0">
            {forks.map((fork) => {
              const isActive = fork.id === activeTabId;
              const isRoot = !fork.parentSessionId;
              const label = isRoot ? 'ROOT' : (fork.aiGeneratedName || fork.forkName || fork.name);
              return (
                <button
                  key={fork.id}
                  onClick={(e) => { e.stopPropagation(); setActiveTabId(fork.id); }}
                  className={`px-1.5 py-0.5 text-[9px] font-bold uppercase whitespace-nowrap transition-colors ${
                    isActive
                      ? 'text-claude-text border-b border-claude-accent'
                      : 'text-claude-text-secondary hover:text-claude-text'
                  }`}
                  style={{ letterSpacing: '0.05em' }}
                  title={fork.name}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {!hasForks && <div className="flex-1" />}

        <button
          onClick={handleRemove}
          className="p-0.5 text-claude-text-secondary hover:text-red-400 hover:bg-red-400/10 flex-shrink-0 ml-1"
          style={{ borderRadius: 0 }}
          title="Remove from Command Center"
        >
          <X size={10} />
        </button>
      </div>

      {/* Messages — scrollable, auto-scrolled to bottom */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
        <MessageList
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
        <div className="border-t border-claude-border px-2 py-1.5 bg-claude-surface">
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

      {/* Question dialog — only in focused cell */}
      {isFocused && currentQuestion && (
        <div className="border-t border-claude-border px-2 py-1.5 bg-claude-surface">
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
        disabled={displaySession.status !== 'running'}
        isStreaming={isSessionStreaming}
      />
    </div>
  );
}
