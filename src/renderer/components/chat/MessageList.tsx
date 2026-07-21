import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import MessageBubble from './MessageBubble';
import HtmlArtifactLink from './HtmlArtifactLink';
import ToolCallCard from './ToolCallCard';
import ReleaseNotes from '../common/ReleaseNotes';
import { getLatestRelease } from '../../../shared/config/release-notes';
import { useSessionStore } from '../../stores/session.store';
import type { ChatMessage, ToolCall } from '../../../shared/types';
import { GSTACK_MODE_META } from '../../../shared/types';
import { isTranscriptVisibleToolCall } from '../../../shared/utils/tool-call-transformer';
import type { StreamEvent } from '../../stores/session.store';
import { extractHtml, isHtmlResponse } from '../../utils/htmlDetector';

interface QueuedMessage {
  id: string;
  message: string;
  attachments?: unknown[];
  timestamp: number;
}

interface MessageListProps {
  sessionId?: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  isLoadingMessages?: boolean;
  streamEvents: StreamEvent[];
  streamContent: string;
  streamingToolCalls?: ToolCall[];
  currentToolCalls?: ToolCall[]; // Live-updated tool calls (not snapshots)
  queuedMessages?: QueuedMessage[];
  onBackgroundTask?: (toolCall: ToolCall) => void; // Callback to background a running Bash command
}

const MESSAGE_ROLE_ORDER: Record<ChatMessage['role'], number> = {
  system: 0,
  user: 1,
  assistant: 2,
};

function messageListTimestamp(message: ChatMessage): number {
  const timestamp = new Date(message.timestamp || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareVisibleMessages(a: ChatMessage, b: ChatMessage): number {
  const timeDelta = messageListTimestamp(a) - messageListTimestamp(b);
  if (timeDelta !== 0) return timeDelta;

  const roleDelta = MESSAGE_ROLE_ORDER[a.role] - MESSAGE_ROLE_ORDER[b.role];
  if (roleDelta !== 0) return roleDelta;

  return (a.id || '').localeCompare(b.id || '');
}

function getAgentDividerLabel(agentId?: string): string {
  if (!agentId?.startsWith('autobuild:')) return 'FOLLOW-UP';

  const [, tier] = agentId.split(':');
  switch (tier) {
    case 'plan':
      return 'PLANNING FOLLOW-UP';
    case 'build':
      return 'IMPLEMENTATION FOLLOW-UP';
    case 'verify':
      return 'VERIFICATION FOLLOW-UP';
    case 'refine':
      return 'REFINEMENT FOLLOW-UP';
    default:
      return 'FOLLOW-UP';
  }
}

export default function MessageList({
  sessionId,
  messages,
  isStreaming,
  isLoadingMessages = false,
  streamEvents,
  streamContent,
  streamingToolCalls,
  currentToolCalls = [],
  queuedMessages = [],
  onBackgroundTask,
}: MessageListProps) {
  // All hooks must be called before any conditional returns
  const rewindAndFork = useSessionStore((state) => state.rewindAndFork);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const getAgentColor = useSessionStore((state) => state.getAgentColor);
  const effectiveSessionId = sessionId || activeSessionId || undefined;
  const activeStreamModel = useSessionStore(useCallback((state) => {
    if (!effectiveSessionId) return undefined;
    return state.activeStreamModel[effectiveSessionId];
  }, [effectiveSessionId]));
  const htmlRenderMode = useSessionStore(useCallback((state) => {
    if (!effectiveSessionId) return 'md';
    return state.htmlRenderMode[effectiveSessionId]
      || state.sessions.find((session) => session.id === effectiveSessionId)?.htmlRenderMode
      || 'md';
  }, [effectiveSessionId]));
  const renderHtmlResponse = htmlRenderMode === 'html';
  const queuedMessagesWillSteer = isStreaming && Boolean(
    activeStreamModel?.startsWith('codex:') || activeStreamModel?.startsWith('claude'),
  );

  // Create a map for quick lookup of current tool call state by ID
  const toolCallMap = React.useMemo(() => {
    const map = new Map<string, ToolCall>();
    for (const tc of currentToolCalls) {
      map.set(tc.id, tc);
    }
    return map;
  }, [currentToolCalls]);

  // Sort messages by timestamp, show setup system messages but filter other system messages
  const sortedMessages = React.useMemo(() => {
    return [...messages]
      .filter(msg => {
        // Skip undefined/null messages
        if (!msg) return false;
        // Show setup-related system messages (they start with "setup-" id)
        if (msg.role === 'system' && msg.id?.startsWith('setup-')) {
          return true;
        }
        // Filter out other system messages
        return msg.role !== 'system';
      })
      .sort(compareVisibleMessages);
  }, [messages]);

  // Check if we have any content to show (either messages, streaming content, or streaming tool calls)
  const hasStreamingContent = isStreaming && (streamContent || (streamingToolCalls && streamingToolCalls.length > 0));

  // Track whether to show release notes banner (dismissible)
  const [showReleaseNotes, setShowReleaseNotes] = useState(true);

  // Check localStorage for dismissed version
  useEffect(() => {
    const dismissedVersion = localStorage.getItem('grep-dismissed-release');
    const latestVersion = getLatestRelease().version;
    if (dismissedVersion === latestVersion) {
      setShowReleaseNotes(false);
    }
  }, []);

  const handleDismissReleaseNotes = () => {
    const latestVersion = getLatestRelease().version;
    localStorage.setItem('grep-dismissed-release', latestVersion);
    setShowReleaseNotes(false);
  };

  // Find the index of the last user message for rewind button visibility
  // IMPORTANT: This hook must be called before any conditional returns to satisfy React's rules of hooks
  const lastUserMessageIndex = React.useMemo(() => {
    for (let i = sortedMessages.length - 1; i >= 0; i--) {
      if (sortedMessages[i]?.role === 'user') {
        return i;
      }
    }
    return -1;
  }, [sortedMessages]);

  const streamRenderItems = React.useMemo(() => {
    let previousAgentId: string | undefined;
    return streamEvents.map((event) => {
      if (event.type === 'thinking') return null;

      const item = {
        event,
        previousAgentId,
        agentChanged: event.agentId !== previousAgentId,
        isTeammate: Boolean(event.agentId),
        agentDividerLabel: getAgentDividerLabel(event.agentId),
      };
      previousAgentId = event.agentId;
      return item;
    });
  }, [streamEvents]);

  // Callback for rewinding to a specific message
  // IMPORTANT: This hook must be called before any conditional returns to satisfy React's rules of hooks
  const handleRewind = useCallback((messageId: string) => {
    return rewindAndFork(messageId);
  }, [rewindAndFork]);

  // Empty state render - now safe to return early after all hooks are called
  if (messages.length === 0 && !hasStreamingContent) {
    // Loading transcript — show spinner instead of empty state
    if (isLoadingMessages) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <Loader2 size={24} className="animate-spin text-claude-accent mx-auto mb-3" />
            <p className="text-sm text-claude-text-secondary font-mono">Loading transcript...</p>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col">
        {/* Release notes banner at top */}
        {showReleaseNotes && (
          <ReleaseNotes banner onDismiss={handleDismissReleaseNotes} />
        )}

        {/* Empty state message */}
        <div className="flex-1 flex items-center justify-center text-claude-text-secondary">
          <div className="text-center max-w-md px-4">
            <div className="text-4xl mb-4">$_</div>
            <p className="text-lg mb-2 font-bold text-claude-text">Ready to Build</p>
            <p className="text-sm text-claude-text-secondary">
              Ask questions, request code changes, or get help debugging.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs">
              <span className="px-2 py-1 border border-claude-border text-claude-text-secondary">
                Tab → cycle modes
              </span>
              <span className="px-2 py-1 border border-claude-border text-claude-text-secondary">
                Cmd+K → quick search
              </span>
              <span className="px-2 py-1 border border-claude-border text-claude-text-secondary">
                Cmd+L → clear chat
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 min-w-0">
      {sortedMessages.map((message, index) => (
        <MessageBubble
          key={message.id}
          sessionId={effectiveSessionId}
          message={message}
          isStreaming={false}
          isLatestMessage={!hasStreamingContent && index === sortedMessages.length - 1}
          isOldMessage={index < sortedMessages.length - 10}
          isLatestUserMessage={message.role === 'user' && index === lastUserMessageIndex}
          renderHtmlResponse={renderHtmlResponse}
          onRewind={handleRewind}
        />
      ))}

      {/* Streaming events in chronological order (excluding thinking - shown separately).
          Render whenever events exist, not just when isStreaming — prevents content from
          vanishing when the watchdog or a stale event briefly clears isStreaming. */}
      {streamEvents.length > 0 && (
        <div className="space-y-2">
          {streamRenderItems.map((item) => {
            if (!item) return null;

            const { event, previousAgentId, agentChanged, isTeammate, agentDividerLabel } = item;
            const agentColor = (event.agentId && activeSessionId) ? getAgentColor(activeSessionId, event.agentId) : undefined;

            // Agent badge for teammate events when agent changes
            const agentBadge = (agentChanged && isTeammate && agentColor) ? (
              <div className="flex items-center gap-2 py-1.5 mb-1">
                <div className="h-px flex-1 opacity-30" style={{ backgroundColor: agentColor }} />
                <div
                  className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase"
                  style={{
                    color: agentColor,
                    backgroundColor: `${agentColor}15`,
                    border: `1px solid ${agentColor}40`,
                    letterSpacing: '0.08em',
                  }}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: agentColor }} />
                  {agentDividerLabel}
                </div>
                <div className="h-px flex-1 opacity-30" style={{ backgroundColor: agentColor }} />
              </div>
            ) : (agentChanged && !isTeammate && previousAgentId) ? (
              <div className="flex items-center gap-2 py-1.5 mb-1">
                <div className="h-px flex-1 bg-claude-border opacity-30" />
                <div className="text-[10px] font-bold uppercase text-claude-text-secondary px-2 py-0.5 bg-claude-surface/50 border border-claude-border" style={{ letterSpacing: '0.08em' }}>
                  LEAD
                </div>
                <div className="h-px flex-1 bg-claude-border opacity-30" />
              </div>
            ) : null;

            if (event.type === 'tool') {
              if (!event.toolCall) return null;
              // Use the live-updated tool call from currentToolCalls, fall back to snapshot
              const liveToolCall = toolCallMap.get(event.toolCall.id) || event.toolCall;
              if (!isTranscriptVisibleToolCall(liveToolCall)) return null;
              return (
                <React.Fragment key={event.id}>
                  {agentBadge}
                  <div style={isTeammate && agentColor ? { borderLeft: `2px solid ${agentColor}`, paddingLeft: '8px' } : undefined}>
                    <ToolCallCard
                      toolCall={liveToolCall}
                      isLatest={false}
                      isStreaming={true}
                      onBackground={onBackgroundTask}
                    />
                  </div>
                </React.Fragment>
              );
            } else if (event.type === 'text' && event.content) {
              const renderStreamTextAsHtml = renderHtmlResponse && isHtmlResponse(event.content, { allowFragment: true });
              const textContainerStyle = {
                overflowWrap: 'anywhere',
                ...(isTeammate && agentColor ? { borderLeft: `2px solid ${agentColor}`, paddingLeft: '8px' } : {}),
              } as React.CSSProperties;

              return (
                <React.Fragment key={event.id}>
                  {agentBadge}
                  <div
                    className={renderStreamTextAsHtml
                      ? 'min-w-0'
                      : 'prose prose-invert max-w-none font-mono text-claude-text break-words min-w-0'}
                    style={textContainerStyle}
                  >
                    {renderStreamTextAsHtml ? (
                      <HtmlArtifactLink
                        sessionId={effectiveSessionId}
                        html={extractHtml(event.content)}
                        messageId={`${effectiveSessionId || 'stream'}-${event.id}`}
                        autoOpen={true}
                      />
                    ) : (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code({ className, children, ...props }) {
                            const match = /language-(\w+)/.exec(className || '');
                            const isBlock = String(children).includes('\n') || match;
                            if (isBlock) {
                              return (
                                <div className="overflow-hidden border border-claude-border my-2" style={{ borderRadius: 0 }}>
                                  {match && (
                                    <div className="px-2 py-1 text-xs font-bold font-mono bg-claude-surface border-b border-claude-border text-claude-text-secondary" style={{ letterSpacing: '0.05em' }}>
                                      {match[1].toUpperCase()}
                                    </div>
                                  )}
                                  <pre className="p-3 bg-claude-bg m-0 whitespace-pre-wrap break-words">
                                    <code className="text-sm font-mono text-claude-text" {...props}>{children}</code>
                                  </pre>
                                </div>
                              );
                            }
                            return <code className="px-1 py-0.5 text-sm font-mono bg-claude-surface text-claude-accent" style={{ borderRadius: 0 }} {...props}>{children}</code>;
                          },
                          p({ children }) { return <p className="my-1 leading-relaxed">{children}</p>; },
                          ul({ children }) { return <ul className="my-1 ml-6 pl-0 list-disc list-outside">{children}</ul>; },
                          ol({ children }) { return <ol className="my-1 ml-6 pl-0 list-decimal list-outside">{children}</ol>; },
                          li({ children }) { return <li className="my-0.5 ml-0 pl-1">{children}</li>; },
                          h1({ children }) { return <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>; },
                          h2({ children }) { return <h2 className="text-base font-bold mt-2 mb-1">{children}</h2>; },
                          h3({ children }) { return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>; },
                          strong({ children }) { return <strong className="font-bold text-claude-text">{children}</strong>; },
                          em({ children }) { return <em className="italic">{children}</em>; },
                          table({ children }) {
                            return (
                              <div className="my-2 overflow-x-auto">
                                <table className="min-w-full border border-claude-border" style={{ borderRadius: 0 }}>{children}</table>
                              </div>
                            );
                          },
                          thead({ children }) { return <thead className="bg-claude-surface">{children}</thead>; },
                          tbody({ children }) { return <tbody>{children}</tbody>; },
                          tr({ children }) { return <tr className="border-b border-claude-border">{children}</tr>; },
                          th({ children }) { return <th className="px-3 py-2 text-left text-sm font-bold border-r border-claude-border last:border-r-0">{children}</th>; },
                          td({ children }) { return <td className="px-3 py-2 text-sm border-r border-claude-border last:border-r-0">{children}</td>; },
                        }}
                      >
                        {event.content}
                      </ReactMarkdown>
                    )}
                  </div>
                </React.Fragment>
              );
            }
            return null;
          })}
        </div>
      )}

      {/* Queued messages - show as pending user messages */}
      {queuedMessages.length > 0 && (
        <div className="space-y-2 mt-4">
          {queuedMessages.map((queuedMsg, index) => (
            <div
              key={queuedMsg.id}
              className="flex items-start gap-2 p-3 border border-dashed border-claude-border bg-claude-surface/30 opacity-70"
            >
              <div className="flex-shrink-0">
                <div className="w-6 h-6 flex items-center justify-center bg-amber-500/20 border border-amber-500/50">
                  <span className="text-xs text-amber-400 font-bold">{index + 1}</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-amber-400 uppercase" style={{ letterSpacing: '0.05em' }}>
                    QUEUED
                  </span>
                  <span className="text-[10px] text-claude-text-secondary">
                    {queuedMessagesWillSteer ? 'Will steer current response' : 'Will send after current response'}
                  </span>
                </div>
                <p className="text-sm text-claude-text break-words" style={{ overflowWrap: 'anywhere' }}>
                  {queuedMsg.message.length > 200
                    ? `${queuedMsg.message.slice(0, 200)}...`
                    : queuedMsg.message}
                </p>
                {queuedMsg.attachments && queuedMsg.attachments.length > 0 && (
                  <div className="mt-1 text-[10px] text-claude-text-secondary">
                    + {queuedMsg.attachments.length} attachment{queuedMsg.attachments.length > 1 ? 's' : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading indicator - only show when streaming but no content yet */}
      {isStreaming && !hasStreamingContent && (() => {
        const gstackMode = activeSessionId ? useSessionStore.getState().gstackMode[activeSessionId] : null;
        const modeMeta = gstackMode ? GSTACK_MODE_META[gstackMode] : null;

        // Only customize when a GStack mode is active — otherwise use default animation
        if (modeMeta) {
          return (
            <div className="flex items-center gap-2 text-claude-text-secondary">
              <div className="flex gap-0.5">
                <div className="w-2 h-2" style={{ backgroundColor: modeMeta.color, animation: 'pulse-square 1.2s ease-in-out infinite 0s' }} />
                <div className="w-2 h-2" style={{ backgroundColor: modeMeta.color, animation: 'pulse-square 1.2s ease-in-out infinite 0.4s' }} />
                <div className="w-2 h-2" style={{ backgroundColor: modeMeta.color, animation: 'pulse-square 1.2s ease-in-out infinite 0.8s' }} />
              </div>
              <span className="text-sm" style={{ color: modeMeta.color }}>{modeMeta.shortName} is thinking...</span>
            </div>
          );
        }

        return (
          <div className="flex items-center gap-2 text-claude-text-secondary">
            <div className="flex gap-0.5">
              <div className="w-2 h-2 bg-claude-accent" style={{ animation: 'pulse-square 1.2s ease-in-out infinite 0s' }} />
              <div className="w-2 h-2 bg-claude-accent" style={{ animation: 'pulse-square 1.2s ease-in-out infinite 0.4s' }} />
              <div className="w-2 h-2 bg-claude-accent" style={{ animation: 'pulse-square 1.2s ease-in-out infinite 0.8s' }} />
            </div>
            <span className="text-sm">Build is thinking...</span>
          </div>
        );
      })()}
    </div>
  );
}
