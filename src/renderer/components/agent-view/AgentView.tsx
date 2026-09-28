import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from '../chat/MessageList';
import InputArea from '../chat/InputArea';
import PermissionDialog from '../chat/PermissionDialog';
import QuestionDialog from '../chat/QuestionDialog';
import { getSessionDisplayName } from '../../utils/session-display';
import PullRequestStatusIcon from '../git/PullRequestStatusIcon';

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
    <div className="flex flex-col h-full overflow-hidden bg-ink-2">
      {selectedSession ? (
        <>
          {/* Header */}
          <div className="h-[52px] flex items-center gap-2.5 px-5 border-b border-line flex-shrink-0">
            <div className={`w-[7px] h-[7px] flex-shrink-0 rounded-full ${selectedSession.status === 'running' ? 'bg-accent' : selectedSession.status === 'error' ? 'bg-diff-del' : 'shadow-[inset_0_0_0_1.5px_#666666]'}`} />
            <span className="text-[14px] font-semibold tracking-[-0.02em] text-fg truncate">
              {getSessionDisplayName(selectedSession)}
            </span>
            {selectedSession.branch && (
              <span className="font-mono text-[11.5px] text-fg-4 truncate">
                {selectedSession.branch}
              </span>
            )}
            <PullRequestStatusIcon
              sessionId={selectedSession.id}
              branch={selectedSession.branch}
              size={11}
              className=""
            />
            {selectedSession.status === 'error' && selectedSession.errorMessage && (
              <span className="text-[11.5px] text-diff-del-text ml-auto truncate max-w-[50%]" title={selectedSession.errorMessage}>
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
            <div className="border-t border-line px-2 py-1.5 bg-ink-2">
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
            <div className="border-t border-line px-2 py-1.5 bg-ink-2">
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
        <div className="flex-1 flex items-center justify-center text-fg-4">
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-[0.04em] mb-1 text-fg-3">No session selected</div>
            <div className="text-[12px] text-fg-5">Select a session from the sidebar</div>
          </div>
        </div>
      )}
    </div>
  );
}
