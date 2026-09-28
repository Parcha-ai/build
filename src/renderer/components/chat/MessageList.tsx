import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileCode, Image, Loader2, Target } from 'lucide-react';
import MessageBubble from './MessageBubble';
import HtmlArtifactLink from './HtmlArtifactLink';
import ToolCallCard from './ToolCallCard';
import ToolRunGroup, { getHistoricalToolOnlyCount, getOrderedVisibleToolCalls, isGroupableToolOnlyMessage } from './ToolRunGroup';
import ReleaseNotes from '../common/ReleaseNotes';
import { getLatestRelease } from '../../../shared/config/release-notes';
import { useSessionStore } from '../../stores/session.store';
import type { ChatMessage, ToolCall } from '../../../shared/types';
import { GSTACK_MODE_META } from '../../../shared/types';
import { isTranscriptVisibleToolCall } from '../../../shared/utils/tool-call-transformer';
import type { StreamEvent } from '../../stores/session.store';
import { extractHtml, isHtmlResponse } from '../../utils/htmlDetector';
import ChatMarkdownLink from './ChatMarkdownLink';

interface QueuedMessage {
  id: string;
  message: string;
  attachments?: unknown[];
  timestamp: number;
}

interface QueuedAttachment {
  type?: string;
  name: string;
  content?: string;
  screenshot?: string;
}

function queuedAttachment(value: unknown): QueuedAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  return {
    type: typeof candidate.type === 'string' ? candidate.type : undefined,
    name: candidate.name,
    content: typeof candidate.content === 'string' ? candidate.content : undefined,
    screenshot: typeof candidate.screenshot === 'string' ? candidate.screenshot : undefined,
  };
}

function attachmentImageSource(attachment: QueuedAttachment): string | null {
  const imageData = attachment.type === 'image'
    ? attachment.content
    : attachment.type === 'dom_element'
      ? attachment.screenshot
      : undefined;
  if (!imageData) return null;
  return imageData.startsWith('data:') ? imageData : `data:image/png;base64,${imageData}`;
}

function QueuedAttachmentChips({ attachments }: { attachments?: unknown[] }) {
  const visibleAttachments = (attachments || [])
    .map(queuedAttachment)
    .filter((attachment): attachment is QueuedAttachment => Boolean(attachment));
  if (visibleAttachments.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="queued-attachment-chips">
      {visibleAttachments.map((attachment, index) => {
        const imageSource = attachmentImageSource(attachment);
        const Icon = attachment.type === 'dom_element'
          ? Target
          : attachment.type === 'image'
            ? Image
            : FileCode;
        return (
          <div
            key={`${attachment.name}-${index}`}
            className="flex max-w-[240px] items-center gap-1.5 overflow-hidden bg-ink-4 pr-2 text-[11px] text-fg-2"
            title={attachment.name}
          >
            {imageSource ? (
              <img
                src={imageSource}
                alt=""
                className="h-8 w-10 shrink-0 border-r border-white/[0.07] bg-black/30 object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center border-r border-white/[0.07]">
                <Icon size={12} className="text-fg-3" />
              </span>
            )}
            <Icon size={10} className="shrink-0 text-fg-4" />
            <span className="truncate font-mono">{attachment.name}</span>
          </div>
        );
      })}
    </div>
  );
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

  // Fold runs of consecutive tool-only assistant messages into one grouped card.
  // Rendering-only: messages, ordering and persistence are untouched.
  const messageRenderItems = React.useMemo(() => {
    type Item =
      | { kind: 'message'; message: ChatMessage; index: number }
      | { kind: 'tools'; key: string; messages: ChatMessage[]; toolCalls: ToolCall[]; trimmedCount: number; lastIndex: number };
    const items: Item[] = [];
    sortedMessages.forEach((message, index) => {
      const trimmedCount = getHistoricalToolOnlyCount(message);
      if (trimmedCount > 0 || isGroupableToolOnlyMessage(message)) {
        const toolCalls = trimmedCount > 0 ? [] : getOrderedVisibleToolCalls(message);
        const previous = items[items.length - 1];
        if (previous?.kind === 'tools') {
          previous.messages.push(message);
          previous.toolCalls.push(...toolCalls);
          previous.trimmedCount += trimmedCount;
          previous.lastIndex = index;
        } else {
          items.push({ kind: 'tools', key: message.id, messages: [message], toolCalls: [...toolCalls], trimmedCount, lastIndex: index });
        }
        return;
      }
      items.push({ kind: 'message', message, index });
    });
    return items;
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
            <Loader2 size={20} className="animate-spin text-accent mx-auto mb-3" />
            <p className="text-[13px] text-fg-4">Loading transcript...</p>
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
        <div className="flex-1 flex items-center justify-center text-fg-4">
          <div className="text-center max-w-md px-4">
            <div className="mb-4 font-mono text-3xl text-fg-5">$_</div>
            <p className="mb-2 text-[22px] font-semibold tracking-[-0.02em] text-fg">Ready to Build</p>
            <p className="text-[13.5px] text-fg-4">
              Ask questions, request code changes, or get help debugging.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 font-mono text-[11px]">
              <span className="px-2 py-1 text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
                Tab → cycle modes
              </span>
              <span className="px-2 py-1 text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
                Cmd+K → quick search
              </span>
              <span className="px-2 py-1 text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
                Cmd+L → clear chat
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[728px] min-w-0 space-y-5 px-6 pb-6 pt-5">
      {messageRenderItems.map((item) => {
        if (item.kind === 'tools') {
          const isLatestRun = !hasStreamingContent && item.lastIndex === sortedMessages.length - 1;
          // A lone tool call keeps its standalone card (e.g. a single bash card with output)
          if (item.toolCalls.length === 1 && item.trimmedCount === 0) {
            return (
              <ToolCallCard
                key={`${item.key}:${isLatestRun ? 'latest' : 'history'}`}
                toolCall={item.toolCalls[0]}
                isLatestToolCall={isLatestRun}
                defaultCollapsed={!isLatestRun}
              />
            );
          }
          return (
            <ToolRunGroup
              key={`run-${item.key}`}
              toolCalls={item.toolCalls}
              trimmedCount={item.trimmedCount}
              onBackground={onBackgroundTask}
            />
          );
        }
        const { message, index } = item;
        const isLatestMessage = !hasStreamingContent && index === sortedMessages.length - 1;
        return (
          <MessageBubble
            // Remount the one message crossing the live/history boundary so its
            // tool-card mount state is released rather than retained indefinitely.
            key={`${message.id}:${isLatestMessage ? 'latest' : 'history'}`}
            sessionId={effectiveSessionId}
            message={message}
            isStreaming={false}
            isLatestMessage={isLatestMessage}
            isOldMessage={index < sortedMessages.length - 10}
            isLatestUserMessage={message.role === 'user' && index === lastUserMessageIndex}
            renderHtmlResponse={renderHtmlResponse}
            onRewind={handleRewind}
          />
        );
      })}

      {/* Streaming events in chronological order (excluding thinking - shown separately).
          Render whenever events exist, not just when isStreaming — prevents content from
          vanishing when the watchdog or a stale event briefly clears isStreaming. */}
      {streamEvents.length > 0 && (
        <div className="space-y-3">
          {(() => {
            // Group consecutive live tool events into one (expanded) run card.
            // A run breaks on text, and on agent switches so teammate badges stay put.
            type StreamItem = NonNullable<(typeof streamRenderItems)[number]>;
            const segments: ({ kind: 'item'; item: StreamItem } | { kind: 'tools'; items: StreamItem[]; toolCalls: ToolCall[] })[] = [];
            for (const item of streamRenderItems) {
              if (!item) continue;
              const { event } = item;
              if (event.type === 'tool') {
                if (!event.toolCall) continue;
                const liveToolCall = toolCallMap.get(event.toolCall.id) || event.toolCall;
                if (!isTranscriptVisibleToolCall(liveToolCall)) continue;
                const previous = segments[segments.length - 1];
                const breaksRun = item.agentChanged && (item.isTeammate || Boolean(item.previousAgentId));
                if (previous?.kind === 'tools' && !breaksRun) {
                  previous.items.push(item);
                  previous.toolCalls.push(liveToolCall);
                } else {
                  segments.push({ kind: 'tools', items: [item], toolCalls: [liveToolCall] });
                }
                continue;
              }
              segments.push({ kind: 'item', item });
            }
            return segments.map((segment) => {
              if (segment.kind === 'tools' && segment.items.length > 1) {
                const first = segment.items[0];
                const agentColor = (first.event.agentId && activeSessionId) ? getAgentColor(activeSessionId, first.event.agentId) : undefined;
                return (
                  <div
                    key={`stream-run-${first.event.id}`}
                    style={first.isTeammate && agentColor ? { borderLeft: `2px solid ${agentColor}`, paddingLeft: '8px' } : undefined}
                  >
                    <ToolRunGroup toolCalls={segment.toolCalls} isLive={isStreaming} onBackground={onBackgroundTask} />
                  </div>
                );
              }
              return segment.kind === 'tools' ? segment.items[0] : segment.item;
            });
          })().map((item) => {
            if (!item) return null;
            if (!('event' in item)) return item;

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
                <div className="h-px flex-1 bg-white/[0.07]" />
                <div className="px-[5px] py-px font-mono text-[9.5px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]" style={{ letterSpacing: '0.04em' }}>
                  LEAD
                </div>
                <div className="h-px flex-1 bg-white/[0.07]" />
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
                      : 'prose prose-invert max-w-none font-sans text-[14.5px] leading-[1.65] text-[#D4D4D4] break-words min-w-0'}
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
                                <div className="not-prose my-3 overflow-hidden bg-[#0B0B0B] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                                  {match && (
                                    <div className="px-3 py-1.5 font-mono text-[10.5px] uppercase text-fg-5 border-b border-white/[0.05]" style={{ letterSpacing: '0.04em' }}>
                                      {match[1].toUpperCase()}
                                    </div>
                                  )}
                                  <pre className="m-0 bg-transparent p-3 whitespace-pre-wrap break-words">
                                    <code className="font-mono text-[12.5px] leading-[1.6] text-fg-2" {...props}>{children}</code>
                                  </pre>
                                </div>
                              );
                            }
                            return <code className="px-1 py-px font-mono text-[0.86em] font-normal bg-[#1E1E1E] text-fg-2 before:content-none after:content-none" {...props}>{children}</code>;
                          },
                          p({ children }) { return <p className="my-2 leading-[1.65]">{children}</p>; },
                          ul({ children }) { return <ul className="my-2 ml-5 pl-0 list-disc list-outside marker:text-fg-5">{children}</ul>; },
                          ol({ children }) { return <ol className="my-2 ml-5 pl-0 list-decimal list-outside marker:text-fg-5">{children}</ol>; },
                          li({ children }) { return <li className="my-1 ml-0 pl-1">{children}</li>; },
                          h1({ children }) { return <h1 className="mt-5 mb-2 text-[18px] font-semibold tracking-[-0.02em] text-fg">{children}</h1>; },
                          h2({ children }) { return <h2 className="mt-4 mb-1.5 text-[16px] font-semibold tracking-[-0.02em] text-fg">{children}</h2>; },
                          h3({ children }) { return <h3 className="mt-3 mb-1 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">{children}</h3>; },
                          a({ href, children }) {
                            return <ChatMarkdownLink href={href} sessionId={effectiveSessionId}>{children}</ChatMarkdownLink>;
                          },
                          strong({ children }) { return <strong className="font-semibold text-fg">{children}</strong>; },
                          em({ children }) { return <em className="italic">{children}</em>; },
                          table({ children }) {
                            return (
                              <div className="my-2 overflow-x-auto">
                                <table className="not-prose my-0 min-w-full border-collapse text-[13px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">{children}</table>
                              </div>
                            );
                          },
                          thead({ children }) { return <thead className="bg-ink-1">{children}</thead>; },
                          tbody({ children }) { return <tbody>{children}</tbody>; },
                          tr({ children }) { return <tr className="border-b border-white/[0.07]">{children}</tr>; },
                          th({ children }) { return <th className="px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2 border-r border-white/[0.07] last:border-r-0">{children}</th>; },
                          td({ children }) { return <td className="px-3 py-2 text-[13px] text-[#D4D4D4] border-r border-white/[0.07] last:border-r-0">{children}</td>; },
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
        <div className="mt-4 space-y-2">
          {queuedMessages.map((queuedMsg, index) => (
            <div
              key={queuedMsg.id}
              className="ml-auto flex max-w-[440px] items-start gap-2.5 bg-[#262626]/60 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
            >
              <div className="flex-shrink-0">
                <div className="flex h-5 w-5 items-center justify-center bg-ink-4">
                  <span className="font-mono text-[11px] text-fg-2">{index + 1}</span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] uppercase text-fg-4" style={{ letterSpacing: '0.04em' }}>
                    QUEUED
                  </span>
                  <span className="text-[11px] text-fg-5">
                    {queuedMessagesWillSteer ? 'Will steer current response' : 'Will send after current response'}
                  </span>
                </div>
                <p className="text-[14px] leading-[1.55] text-fg-2 break-words" style={{ overflowWrap: 'anywhere' }}>
                  {queuedMsg.message.length > 200
                    ? `${queuedMsg.message.slice(0, 200)}...`
                    : queuedMsg.message}
                </p>
                <QueuedAttachmentChips attachments={queuedMsg.attachments} />
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
            <div className="live-thinking-cluster flex items-center gap-2.5 text-[13px]">
              <div
                className="live-thinking-indicator status-pulse h-[7px] w-[7px] flex-shrink-0 rounded-full"
                style={{ backgroundColor: modeMeta.color }}
              />
              <span className="font-medium" style={{ color: modeMeta.color }}>{modeMeta.shortName} is thinking...</span>
            </div>
          );
        }

        return (
          <div className="live-thinking-cluster flex items-center gap-2.5 text-[13px]">
            <div className="live-thinking-indicator status-pulse h-[7px] w-[7px] flex-shrink-0 rounded-full bg-accent" />
            <span className="text-shimmer font-medium">Build is thinking...</span>
          </div>
        );
      })()}
    </div>
  );
}
