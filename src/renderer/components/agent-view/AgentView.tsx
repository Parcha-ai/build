import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from '../chat/MessageList';
import InputArea from '../chat/InputArea';
import PermissionDialog from '../chat/PermissionDialog';
import QuestionDialog from '../chat/QuestionDialog';
import { getSessionDisplayName } from '../../utils/session-display';

const EMPTY_MESSAGES: never[] = [];
const EMPTY_EVENTS: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];
const EMPTY_QUEUE: never[] = [];
const noopBackgroundTask = () => undefined;

export default function AgentView() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedId = useUIStore((s) => s.agentViewSelectedSessionId);

  const approvePermission = useSessionStore((s) => s.approvePermission);
  const denyPermission = useSessionStore((s) => s.denyPermission);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const cancelQuestion = useSessionStore((s) => s.cancelQuestion);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const loadMessages = useSessionStore((s) => s.loadMessages);

  const selectedSession = useMemo(() => {
    return sessions.find((s) => s.id === selectedId) || null;
  }, [sessions, selectedId]);

  const sessionMessages = useSessionStore(useCallback((s) => selectedId ? (s.messages[selectedId] || EMPTY_MESSAGES) : EMPTY_MESSAGES, [selectedId]));
  const isSessionStreaming = useSessionStore(useCallback((s) => selectedId ? (s.isStreaming[selectedId] || false) : false, [selectedId]));
  const sessionStreamEvents = useSessionStore(useCallback((s) => selectedId ? (s.streamEvents[selectedId] || EMPTY_EVENTS) : EMPTY_EVENTS, [selectedId]));
  const streamContent = useSessionStore(useCallback((s) => selectedId ? (s.currentStreamContent[selectedId] || '') : '', [selectedId]));
  const streamingToolCalls = useSessionStore(useCallback((s) => selectedId ? (s.currentToolCalls[selectedId] || EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS, [selectedId]));
  const queuedMessages = useSessionStore(useCallback((s) => selectedId ? (s.messageQueue[selectedId] || EMPTY_QUEUE) : EMPTY_QUEUE, [selectedId]));
  const isLoadingMessages = useSessionStore(useCallback((s) => selectedId ? (s.isLoadingMessages[selectedId] || false) : false, [selectedId]));
  const currentPermission = useSessionStore(useCallback((s) => selectedId ? (s.pendingPermission[selectedId] || null) : null, [selectedId]));
  const currentQuestion = useSessionStore(useCallback((s) => selectedId ? (s.pendingQuestion[selectedId] || null) : null, [selectedId]));

  useEffect(() => {
    if (selectedId) {
      loadMessages(selectedId);
    }
  }, [selectedId, loadMessages]);

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

  useEffect(() => {
    hasScrolledInitially.current = false;
  }, [selectedId]);

  return (
    <div className="flex flex-col h-full overflow-hidden font-mono">
      {selectedSession ? (
        <>
          {/* Header */}
          <div className="h-8 flex items-center px-3 bg-claude-surface/50 border-b border-claude-border flex-shrink-0">
            <div className={`w-1.5 h-1.5 flex-shrink-0 mr-2 ${selectedSession.status === 'running' ? 'bg-green-500' : selectedSession.status === 'error' ? 'bg-red-500' : 'bg-gray-500'}`} style={{ borderRadius: 0 }} />
            <span className="text-[11px] font-bold text-claude-text uppercase" style={{ letterSpacing: '0.05em' }}>
              {getSessionDisplayName(selectedSession)}
            </span>
            {selectedSession.branch && (
              <span className="text-[10px] text-claude-text-secondary ml-2 truncate">
                {selectedSession.branch}
              </span>
            )}
            {selectedSession.status === 'error' && selectedSession.errorMessage && (
              <span className="text-[9px] text-red-400 ml-auto truncate max-w-[50%]" title={selectedSession.errorMessage}>
                {selectedSession.errorMessage}
              </span>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <MessageList
              sessionId={selectedId || undefined}
              messages={sessionMessages}
              isStreaming={isSessionStreaming}
              isLoadingMessages={isLoadingMessages}
              streamEvents={sessionStreamEvents}
              streamContent={streamContent}
              streamingToolCalls={streamingToolCalls}
              currentToolCalls={streamingToolCalls}
              queuedMessages={queuedMessages}
              onBackgroundTask={noopBackgroundTask}
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
            disabled={false}
            isStreaming={isSessionStreaming}
          />
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-claude-text-secondary">
          <div className="text-center">
            <div className="text-[10px] font-bold uppercase mb-1" style={{ letterSpacing: '0.1em' }}>NO SESSION SELECTED</div>
            <div className="text-[10px]">Select a session from the sidebar</div>
          </div>
        </div>
      )}
    </div>
  );
}
