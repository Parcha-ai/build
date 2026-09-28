import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GitBranch, Image, Target, FileCode, Maximize2 } from 'lucide-react';
import ToolCallCard from './ToolCallCard';
import ToolRunGroup from './ToolRunGroup';
import HtmlArtifactLink from './HtmlArtifactLink';
import { SpeakerButton } from './SpeakerButton';
import { useEditorStore } from '../../stores/editor.store';
import { useUIStore } from '../../stores/ui.store';
import { isHtmlResponse, extractHtml } from '../../utils/htmlDetector';
import type { ChatMessage, ToolCall } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/types';
import { buildMissingToolCall, getMessageRenderArtifacts, getRenderedBlockText } from '../../../shared/utils/message-rendering';
import { isTranscriptVisibleToolCall } from '../../../shared/utils/tool-call-transformer';
import ChatMarkdownLink from './ChatMarkdownLink';

// Regex to match file paths with optional line numbers
// Matches: /path/to/file.ext or /path/to/file.ext:123
const FILE_PATH_REGEX = /(\/(?:Users|home|var|etc|opt|tmp|usr|app|src|lib|pkg|workspace)[^\s:,;)}\]"'`<>]*\.[a-zA-Z0-9]+(?::\d+)?)/g;
const RECENT_TOOL_CARD_LIMIT = 80;
const DENSE_TOOL_CALL_THRESHOLD = 24;
const HISTORICAL_PREVIEW_HEAD_CHARS = 700;
const HISTORICAL_PREVIEW_TAIL_CHARS = 500;
const READER_PANEL_CHAR_THRESHOLD = 1500;

interface MessageBubbleProps {
  sessionId?: string;
  message: ChatMessage;
  isStreaming?: boolean;
  streamingToolCalls?: ToolCall[];
  isLatestMessage?: boolean; // True only for the most recent message in the conversation
  isOldMessage?: boolean; // True for messages older than 10 from the end - collapse tool cards by default
  isLatestUserMessage?: boolean; // True for the most recent user message (don't show rewind)
  renderHtmlResponse?: boolean; // True when this session is in HTML response mode
  onRewind?: (messageId: string) => void; // Callback when rewind button is clicked
}

// Extracted component for rendering text content blocks with markdown
interface TextContentBlockProps {
  sessionId?: string;
  content: string;
  messageId: string;
  showSpeaker: boolean;
  openFile: (path: string, line?: number) => void;
  renderHtmlResponse?: boolean;
  autoOpenHtmlArtifact?: boolean;
}

function TextContentBlock({
  sessionId,
  content,
  messageId,
  showSpeaker,
  openFile,
  renderHtmlResponse = false,
  autoOpenHtmlArtifact = false,
}: TextContentBlockProps) {
  if (isHtmlResponse(content, { allowFragment: renderHtmlResponse })) {
    return (
      <HtmlArtifactLink
        sessionId={sessionId}
        html={extractHtml(content)}
        messageId={messageId}
        autoOpen={autoOpenHtmlArtifact}
      />
    );
  }

  return (
    <div className="relative group">
      {/* Speaker button - top right, brutalist style - only show on first text block */}
      {showSpeaker && (
        <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
          <SpeakerButton messageId={messageId} text={content} />
        </div>
      )}
      <div
        className="prose prose-invert max-w-none font-sans text-[14.5px] leading-[1.65] text-[#D4D4D4] pr-12 break-words"
        style={{ overflowWrap: 'anywhere' }}
      >
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
                      <div
                        className="px-3 py-1.5 font-mono text-[10.5px] uppercase text-fg-5 border-b border-white/[0.05]"
                        style={{ letterSpacing: '0.04em' }}
                      >
                        {match[1].toUpperCase()}
                      </div>
                    )}
                    <pre className="m-0 bg-transparent p-3 whitespace-pre-wrap break-words">
                      <code className="font-mono text-[12.5px] leading-[1.6] text-fg-2" {...props}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              }

              // Inline code - check if it's a file path
              const codeText = String(children);
              const isFilePath = FILE_PATH_REGEX.test(codeText);
              FILE_PATH_REGEX.lastIndex = 0;

              if (isFilePath) {
                const lineMatch = codeText.match(/:(\d+)$/);
                const filePath = lineMatch ? codeText.slice(0, -lineMatch[0].length) : codeText;
                const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
                const fileName = filePath.split('/').pop() || filePath;

                return (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openFile(filePath, lineNumber);
                    }}
                    className="px-1 py-px font-mono text-[0.86em] bg-[#1E1E1E] text-accent-text hover:text-[#B5D3FF] hover:bg-[#262626] cursor-pointer"
                    title={`Open ${filePath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
                  >
                    {fileName}
                    {lineNumber ? `:${lineNumber}` : ''}
                  </button>
                );
              }

              return (
                <code
                  className="px-1 py-px font-mono text-[0.86em] font-normal bg-[#1E1E1E] text-fg-2 before:content-none after:content-none"
                  {...props}
                >
                  {children}
                </code>
              );
            },
            p({ children }) {
              return <p className="my-2 leading-[1.65]">{children}</p>;
            },
            ul({ children }) {
              return <ul className="my-2 ml-5 pl-0 list-disc list-outside marker:text-fg-5">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="my-2 ml-5 pl-0 list-decimal list-outside marker:text-fg-5">{children}</ol>;
            },
            li({ children }) {
              return <li className="my-1 ml-0 pl-1">{children}</li>;
            },
            h1({ children }) {
              return <h1 className="mt-5 mb-2 text-[18px] font-semibold tracking-[-0.02em] text-fg">{children}</h1>;
            },
            h2({ children }) {
              return <h2 className="mt-4 mb-1.5 text-[16px] font-semibold tracking-[-0.02em] text-fg">{children}</h2>;
            },
            h3({ children }) {
              return <h3 className="mt-3 mb-1 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">{children}</h3>;
            },
            a({ href, children }) {
              return (
                <ChatMarkdownLink href={href} sessionId={sessionId}>
                  {children}
                </ChatMarkdownLink>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote className="my-3 border-l-2 border-white/[0.14] pl-3 not-italic font-normal text-fg-3">
                  {children}
                </blockquote>
              );
            },
            strong({ children }) {
              return <strong className="font-semibold text-fg">{children}</strong>;
            },
            em({ children }) {
              return <em className="italic">{children}</em>;
            },
            table({ children }) {
              return (
                <div className="my-2 overflow-x-auto">
                  <table className="not-prose my-0 min-w-full border-collapse text-[13px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children }) {
              return <thead className="bg-ink-1">{children}</thead>;
            },
            tbody({ children }) {
              return <tbody>{children}</tbody>;
            },
            tr({ children }) {
              return <tr className="border-b border-white/[0.07]">{children}</tr>;
            },
            th({ children }) {
              return (
                <th className="px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2 border-r border-white/[0.07] last:border-r-0">
                  {children}
                </th>
              );
            },
            td({ children }) {
              return (
                <td className="px-3 py-2 text-[13px] text-[#D4D4D4] border-r border-white/[0.07] last:border-r-0">{children}</td>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function CollapsedToolSummary({ count }: { count: number }) {
  if (count <= 0) return null;

  return (
    <div className="flex items-center gap-2 py-1 text-[12px] text-fg-4">
      <FileCode size={12} className="text-fg-5 flex-shrink-0" />
      <span>
        {count} historical tool call{count === 1 ? '' : 's'} collapsed
      </span>
    </div>
  );
}

function getHistoricalPreview(message: ChatMessage): string {
  const text = (message.content || getRenderedBlockText(message.contentBlocks)).trim();
  if (!text) return '';

  const maxLength = HISTORICAL_PREVIEW_HEAD_CHARS + HISTORICAL_PREVIEW_TAIL_CHARS;
  if (text.length <= maxLength) return text;

  return `${text.slice(0, HISTORICAL_PREVIEW_HEAD_CHARS).trimEnd()}\n...\n${text.slice(-HISTORICAL_PREVIEW_TAIL_CHARS).trimStart()}`;
}

function countHistoricalToolBlocks(message: ChatMessage, visibleToolCallCount: number): number {
  const metadataCount = Number(message.metadata?.historicalToolCallCount);
  if (Number.isFinite(metadataCount) && metadataCount > 0) {
    return metadataCount;
  }

  const blockCount = (message.contentBlocks || [])
    .filter((block) => block.type === 'tool_use' && block.toolCallId)
    .length;
  return Math.max(visibleToolCallCount, blockCount);
}

function HistoricalAssistantSummary({
  preview,
  toolCount,
  onExpand,
}: {
  preview: string;
  toolCount: number;
  onExpand: () => void;
}) {
  return (
    <div className="space-y-2 border-l border-white/[0.07] py-1 pl-3">
      {preview ? (
        <p
          className="whitespace-pre-wrap text-[13px] leading-[1.6] text-fg-4 break-words"
          style={{ overflowWrap: 'anywhere' }}
        >
          {preview}
        </p>
      ) : (
        <p className="text-[13px] text-fg-4">
          Historical assistant response collapsed.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CollapsedToolSummary count={toolCount} />
        <button
          type="button"
          onClick={onExpand}
          className="h-5 text-[11.5px] text-fg-4 underline-offset-2 hover:text-fg-2 hover:underline transition-colors"
        >
          Show details
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  sessionId,
  message,
  isStreaming,
  streamingToolCalls,
  isLatestMessage = false,
  isOldMessage = false,
  isLatestUserMessage = false,
  renderHtmlResponse = false,
  onRewind,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [isRewinding, setIsRewinding] = useState(false);
  const [showHistoricalDetail, setShowHistoricalDetail] = useState(false);
  const openFile = useEditorStore((state) => state.openFile);
  // Note: activeSessionId, updateSession, sessions accessed via getState() in click handlers only

  // Show rewind button for user messages that aren't the most recent one
  const showRewindButton = isUser && !isLatestUserMessage && onRewind && !isStreaming;

  const handleRewind = async () => {
    if (!onRewind || isRewinding) return;
    setIsRewinding(true);
    try {
      await onRewind(message.id);
    } catch (error) {
      console.error('Failed to rewind:', error);
    } finally {
      setIsRewinding(false);
    }
  };

  const {
    toolCalls,
    unrenderedToolCalls,
    unrenderedMessageContent,
    isToolOnlyMessage,
    toolOnlySummary,
  } = getMessageRenderArtifacts(message, streamingToolCalls);
  const hiddenToolCallIds = useMemo(() => new Set(
    (streamingToolCalls || message.toolCalls || [])
      .filter((toolCall) => !isTranscriptVisibleToolCall(toolCall))
      .map((toolCall) => toolCall.id),
  ), [message.toolCalls, streamingToolCalls]);
  const toolCallById = useMemo(() => new Map(
    toolCalls.map((toolCall) => [toolCall.id, toolCall] as const),
  ), [toolCalls]);
  const firstTextBlockIndex = useMemo(() => (
    message.contentBlocks?.findIndex((block) => block.type === 'text') ?? -1
  ), [message.contentBlocks]);
  const toolCardRenderLimit = isOldMessage && !isLatestMessage && !isStreaming
    ? 0
    : RECENT_TOOL_CARD_LIMIT;
  // A completed agent run can contain dozens of large tool results. Expanding
  // all of them while STREAM_END moves the run into message history creates a
  // large synchronous React/Monaco mount and can beachball the renderer.
  // Keep dense runs and non-latest results as cheap headers until requested.
  const collapseToolCardsByDefault = isOldMessage
    || (!isStreaming && (!isLatestMessage || toolCalls.length >= DENSE_TOOL_CALL_THRESHOLD));
  const historicalCollapsed = !isUser && !isSystem && isOldMessage && !isLatestMessage && !isStreaming && !showHistoricalDetail;
  const historicalPreview = useMemo(() => getHistoricalPreview(message), [message]);
  const historicalToolCount = useMemo(() => countHistoricalToolBlocks(message, toolCalls.length), [message, toolCalls.length]);
  const assistantTextContent = useMemo(() => {
    const renderedBlockText = getRenderedBlockText(message.contentBlocks);
    return renderedBlockText.trim() ? renderedBlockText : (message.content || '');
  }, [message.content, message.contentBlocks]);
  // Reader is the lightweight way to inspect a large historical response. Do
  // not hide it with the historical-collapse optimization—the response can
  // become "old" immediately after a tool-heavy turn adds enough messages.
  const shouldOfferReader = assistantTextContent.length >= READER_PANEL_CHAR_THRESHOLD
    && Boolean(sessionId);
  const shouldRenderAssistantTextAsHtml = renderHtmlResponse
    && !isUser
    && !isSystem
    && !historicalCollapsed
    && Boolean(assistantTextContent.trim())
    && isHtmlResponse(assistantTextContent, { allowFragment: true });

  return (
    <div className="group/msg flex gap-2 min-w-0">
      {/* Content */}
      <div className="flex-1 min-w-0">
        {isSystem ? (
          // System messages (setup output) - distinct styling with terminal look
          <div className="overflow-hidden bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="px-3 py-[9px] border-b border-white/[0.05] flex items-center gap-2">
              <span className="text-[11px] uppercase text-fg-4" style={{ letterSpacing: '0.04em' }}>
                SETUP OUTPUT
              </span>
            </div>
            <div className="p-3 max-h-96 overflow-y-auto bg-[#0B0B0B]">
              <div className="prose prose-invert max-w-none font-mono text-[12px] leading-[1.6] text-fg-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content || ''}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : isUser ? (
          // User messages - right-aligned graphite bubble
          <div className="flex justify-end">
          <div className="relative group max-w-[440px] min-w-0 bg-[#262626] px-3.5 py-2.5">
            {/* Rewind button - appears on hover in top-right */}
            {showRewindButton && (
              <button
                onClick={handleRewind}
                disabled={isRewinding}
                className="absolute top-1 right-full mr-1.5 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-fg-4 hover:text-fg hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed"
                title="Fork conversation from this point"
              >
                <GitBranch size={14} className={isRewinding ? 'animate-pulse' : ''} />
              </button>
            )}
            <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-fg" style={{ overflowWrap: 'anywhere' }}>
              {message.content}
            </p>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {message.attachments.map((attachment, index) => {
                  const imageData = attachment.type === 'image' ? attachment.content
                    : attachment.type === 'dom_element' && attachment.screenshot ? attachment.screenshot
                    : null;
                  if (imageData) {
                    const src = imageData.startsWith('data:') ? imageData : `data:image/png;base64,${imageData}`;
                    return (
                      <div key={index} className="overflow-hidden bg-ink-4">
                        <img
                          src={src}
                          alt={attachment.name}
                          className="max-h-40 max-w-xs object-contain bg-black/30"
                        />
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          {attachment.type === 'dom_element' ? (
                            <Target size={10} className="text-fg-3 flex-shrink-0" />
                          ) : (
                            <Image size={10} className="text-fg-3 flex-shrink-0" />
                          )}
                          <span className="truncate font-mono text-[11px] text-fg-2">
                            {attachment.name}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={index}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs bg-ink-4"
                    >
                      {attachment.type === 'dom_element' ? (
                        <Target size={12} className="text-fg-3" />
                      ) : (
                        <FileCode size={12} className="text-fg-3" />
                      )}
                      <span className="truncate max-w-[200px] font-mono text-[11.5px] text-fg-2">
                        {attachment.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </div>
        ) : (
          // Assistant messages - render content blocks in order when available
          <div className="space-y-3">
            {/* Interrupted indicator */}
            {message.interrupted && (
              <div className="inline-flex items-center gap-2 px-2 py-1 text-[11px] uppercase text-amber shadow-[inset_0_0_0_1px_rgba(240,180,41,0.35)]">
                <span className="h-1.5 w-1.5 rounded-full bg-amber" />
                <span style={{ letterSpacing: '0.04em' }}>INTERRUPTED</span>
              </div>
            )}

            {/* Open in Reader button for large responses */}
            {shouldOfferReader && sessionId && (
              <button
                onClick={() => {
                  const firstLine = assistantTextContent.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim();
                  useUIStore.getState().setMarkdownPanel(sessionId, {
                    content: assistantTextContent,
                    messageId: message.id,
                    title: firstLine && firstLine.length < 80 ? firstLine : undefined,
                  });
                }}
                className="flex h-6 items-center gap-1.5 px-2 text-[11px] text-fg-3 hover:text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/[0.04] transition-colors"
                title="Open in side panel for easier reading"
              >
                <Maximize2 size={10} />
                <span>OPEN IN READER{/\|.+\|/.test(assistantTextContent) ? ' (has tables)' : ''}</span>
              </button>
            )}

            {/* Render content blocks in chronological order when available */}
            {historicalCollapsed ? (
              <HistoricalAssistantSummary
                preview={historicalPreview || toolOnlySummary}
                toolCount={historicalToolCount}
                onExpand={() => setShowHistoricalDetail(true)}
              />
            ) : message.contentBlocks && message.contentBlocks.length > 0 ? (
              (() => {
                // Build an agent colour map for this message's blocks
                const blockAgentMap = new Map<string, number>();
                let colorIdx = 0;
                message.contentBlocks!.forEach(b => {
                  if (b.agentId && !blockAgentMap.has(b.agentId)) {
                    blockAgentMap.set(b.agentId, colorIdx++);
                  }
                });

                const renderedBlocks: React.ReactNode[] = [];
                let renderedToolCards = 0;
                let omittedToolCards = 0;
                // Consecutive tool calls are buffered and flushed as one grouped card
                // (a lone call keeps its standalone card). Rendering-only.
                let pendingRun: { toolCall: ToolCall; blockIndex: number; agentId?: string; agentStyle?: React.CSSProperties }[] = [];
                const flushRun = () => {
                  if (pendingRun.length === 0) return;
                  if (pendingRun.length === 1) {
                    const { toolCall, blockIndex, agentStyle } = pendingRun[0];
                    renderedBlocks.push(
                      <div key={toolCall.id} style={agentStyle}>
                        <ToolCallCard
                          toolCall={toolCall}
                          isLatestToolCall={isLatestMessage && blockIndex === message.contentBlocks!.length - 1}
                          isStreaming={isStreaming}
                          defaultCollapsed={collapseToolCardsByDefault}
                        />
                      </div>
                    );
                  } else {
                    renderedBlocks.push(
                      <div key={`run-${pendingRun[0].toolCall.id}`} style={pendingRun[0].agentStyle}>
                        <ToolRunGroup toolCalls={pendingRun.map((entry) => entry.toolCall)} isLive={Boolean(isStreaming)} />
                      </div>
                    );
                  }
                  pendingRun = [];
                };

                message.contentBlocks!.forEach((block, blockIndex) => {
                  const isTeammate = !!block.agentId;
                  const blockColor = isTeammate && block.agentId
                    ? AGENT_COLORS[blockAgentMap.get(block.agentId)! % AGENT_COLORS.length]
                    : undefined;
                  const agentStyle = isTeammate && blockColor
                    ? { borderLeft: `2px solid ${blockColor}`, paddingLeft: '8px' } as React.CSSProperties
                    : undefined;

                  if (block.type === 'tool_use' && block.toolCallId) {
                    if (hiddenToolCallIds.has(block.toolCallId)) {
                      return;
                    }
                    const toolCall = toolCallById.get(block.toolCallId) || buildMissingToolCall(block.toolCallId, block.agentId);
                    if (!isTranscriptVisibleToolCall(toolCall)) {
                      return;
                    }
                    if (renderedToolCards >= toolCardRenderLimit) {
                      omittedToolCards += 1;
                      return;
                    }
                    renderedToolCards += 1;
                    // Teammate switches start a new run so agent colouring stays per-run
                    if (pendingRun.length > 0 && pendingRun[0].agentId !== block.agentId) flushRun();
                    pendingRun.push({ toolCall, blockIndex, agentId: block.agentId, agentStyle });
                  } else if (block.type === 'text' && block.text) {
                    if (shouldRenderAssistantTextAsHtml) {
                      return;
                    }
                    flushRun();
                    renderedBlocks.push(
                      <div key={`text-${blockIndex}`} style={agentStyle}>
                        <TextContentBlock
                          sessionId={sessionId}
                          content={block.text}
                          messageId={message.id}
                          showSpeaker={blockIndex === firstTextBlockIndex}
                          openFile={openFile}
                          renderHtmlResponse={renderHtmlResponse}
                          autoOpenHtmlArtifact={isLatestMessage || Boolean(isStreaming)}
                        />
                      </div>
                    );
                  }
                });

                flushRun();

                const unrenderedToolBlocks: React.ReactNode[] = [];
                const unrenderedVisible: ToolCall[] = [];
                unrenderedToolCalls.forEach((toolCall) => {
                  if (renderedToolCards >= toolCardRenderLimit) {
                    omittedToolCards += 1;
                    return;
                  }
                  renderedToolCards += 1;
                  unrenderedVisible.push(toolCall);
                });
                if (unrenderedVisible.length === 1) {
                  unrenderedToolBlocks.push(
                    <ToolCallCard
                      key={`unrendered-tool-${unrenderedVisible[0].id}`}
                      toolCall={unrenderedVisible[0]}
                      isLatestToolCall={isLatestMessage}
                      isStreaming={isStreaming}
                      defaultCollapsed={collapseToolCardsByDefault}
                    />
                  );
                } else if (unrenderedVisible.length > 1) {
                  unrenderedToolBlocks.push(
                    <ToolRunGroup
                      key={`unrendered-run-${unrenderedVisible[0].id}`}
                      toolCalls={unrenderedVisible}
                      isLive={Boolean(isStreaming)}
                    />
                  );
                }

                return [
                  omittedToolCards > 0 ? <CollapsedToolSummary key="collapsed-tools" count={omittedToolCards} /> : null,
                  ...renderedBlocks,
                  shouldRenderAssistantTextAsHtml ? (
                    <HtmlArtifactLink
                      key="html-response-artifact"
                      sessionId={sessionId}
                      html={extractHtml(assistantTextContent)}
                      messageId={message.id}
                      autoOpen={isLatestMessage || Boolean(isStreaming)}
                    />
                  ) : null,
                  ...unrenderedToolBlocks,
                  unrenderedMessageContent ? (
                    <TextContentBlock
                      sessionId={sessionId}
                      key="message-content-fallback"
                      content={unrenderedMessageContent}
                      messageId={message.id}
                      showSpeaker={false}
                      openFile={openFile}
                      renderHtmlResponse={renderHtmlResponse}
                      autoOpenHtmlArtifact={isLatestMessage || Boolean(isStreaming)}
                    />
                  ) : null,
                ];
              })()
            ) : (
              /* Fallback for messages without contentBlocks (backwards compat) */
              <>
                {/* Tool calls execute (during action) */}
                {toolCalls.slice(0, toolCardRenderLimit).length > 1 ? (
                  <ToolRunGroup toolCalls={toolCalls.slice(0, toolCardRenderLimit)} isLive={Boolean(isStreaming)} />
                ) : toolCalls.slice(0, toolCardRenderLimit).map((toolCall, index) => (
                  <ToolCallCard
                    key={toolCall.id}
                    toolCall={toolCall}
                    isLatestToolCall={isLatestMessage && index === toolCalls.length - 1}
                    isStreaming={isStreaming}
                    defaultCollapsed={collapseToolCardsByDefault}
                  />
                ))}
                <CollapsedToolSummary count={Math.max(0, toolCalls.length - toolCardRenderLimit)} />

                {/* Final content streams last (summary/response) */}
                {message.content && (
              isHtmlResponse(message.content, { allowFragment: renderHtmlResponse }) ? (
                <HtmlArtifactLink
                  sessionId={sessionId}
                  html={extractHtml(message.content)}
                  messageId={message.id}
                  autoOpen={isLatestMessage || Boolean(isStreaming)}
                />
              ) : (
              <div className="relative group">
                {/* Speaker button - top right, brutalist style */}
                <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
                  <SpeakerButton
                    messageId={message.id}
                    text={message.content}
                  />
                </div>
                <div className="prose prose-invert max-w-none font-sans text-[14.5px] leading-[1.65] text-[#D4D4D4] pr-12 break-words" style={{ overflowWrap: 'anywhere' }}>
                  <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Custom code block rendering
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      const isBlock = String(children).includes('\n') || match;

                      if (isBlock) {
                        return (
                          <div className="not-prose my-3 overflow-hidden bg-[#0B0B0B] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                            {match && (
                              <div
                                className="px-3 py-1.5 font-mono text-[10.5px] uppercase text-fg-5 border-b border-white/[0.05]"
                                style={{ letterSpacing: '0.05em' }}
                              >
                                {match[1].toUpperCase()}
                              </div>
                            )}
                            <pre className="m-0 bg-transparent p-3 whitespace-pre-wrap break-words">
                              <code className="font-mono text-[12.5px] leading-[1.6] text-fg-2" {...props}>
                                {children}
                              </code>
                            </pre>
                          </div>
                        );
                      }

                      // Inline code - check if it's a file path
                      const codeText = String(children);
                      const isFilePath = FILE_PATH_REGEX.test(codeText);
                      FILE_PATH_REGEX.lastIndex = 0; // Reset regex

                      if (isFilePath) {
                        // Parse the file path with optional line number
                        const lineMatch = codeText.match(/:(\d+)$/);
                        const filePath = lineMatch ? codeText.slice(0, -lineMatch[0].length) : codeText;
                        const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
                        const fileName = filePath.split('/').pop() || filePath;

                        return (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openFile(filePath, lineNumber);
                            }}
                            className="px-1 py-px font-mono text-[0.86em] bg-[#1E1E1E] text-accent-text hover:text-[#B5D3FF] hover:bg-[#262626] cursor-pointer"
                            title={`Open ${filePath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
                          >
                            {fileName}{lineNumber ? `:${lineNumber}` : ''}
                          </button>
                        );
                      }

                      return (
                        <code
                          className="px-1 py-px font-mono text-[0.86em] font-normal bg-[#1E1E1E] text-fg-2 before:content-none after:content-none"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    // Style paragraphs
                    p({ children }) {
                      return <p className="my-2 leading-[1.65]">{children}</p>;
                    },
                    // Style lists
                    ul({ children }) {
                      return <ul className="my-2 ml-5 pl-0 list-disc list-outside marker:text-fg-5">{children}</ul>;
                    },
                    ol({ children }) {
                      return <ol className="my-2 ml-5 pl-0 list-decimal list-outside marker:text-fg-5">{children}</ol>;
                    },
                    li({ children }) {
                      return <li className="my-1 ml-0 pl-1">{children}</li>;
                    },
                    // Style headings
                    h1({ children }) {
                      return <h1 className="mt-5 mb-2 text-[18px] font-semibold tracking-[-0.02em] text-fg">{children}</h1>;
                    },
                    h2({ children }) {
                      return <h2 className="mt-4 mb-1.5 text-[16px] font-semibold tracking-[-0.02em] text-fg">{children}</h2>;
                    },
                    h3({ children }) {
                      return <h3 className="mt-3 mb-1 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">{children}</h3>;
                    },
                    // Style links
                    a({ href, children }) {
                      return (
                        <ChatMarkdownLink href={href} sessionId={sessionId}>
                          {children}
                        </ChatMarkdownLink>
                      );
                    },
                    // Style blockquotes
                    blockquote({ children }) {
                      return (
                        <blockquote className="my-3 border-l-2 border-white/[0.14] pl-3 not-italic font-normal text-fg-3">
                          {children}
                        </blockquote>
                      );
                    },
                    // Style strong/bold
                    strong({ children }) {
                      return <strong className="font-semibold text-fg">{children}</strong>;
                    },
                    // Style emphasis/italic
                    em({ children }) {
                      return <em className="italic">{children}</em>;
                    },
                    // Style tables
                    table({ children }) {
                      return (
                        <div className="my-2 overflow-x-auto">
                          <table className="not-prose my-0 min-w-full border-collapse text-[13px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                            {children}
                          </table>
                        </div>
                      );
                    },
                    thead({ children }) {
                      return <thead className="bg-ink-1">{children}</thead>;
                    },
                    tbody({ children }) {
                      return <tbody>{children}</tbody>;
                    },
                    tr({ children }) {
                      return <tr className="border-b border-white/[0.07]">{children}</tr>;
                    },
                    th({ children }) {
                      return (
                        <th className="px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2 border-r border-white/[0.07] last:border-r-0">
                          {children}
                        </th>
                      );
                    },
                    td({ children }) {
                      return (
                        <td className="px-3 py-2 text-[13px] text-[#D4D4D4] border-r border-white/[0.07] last:border-r-0">
                          {children}
                        </td>
                      );
                    },
                  }}
                >
                  {message.content}
                </ReactMarkdown>
                </div>
              </div>
              )
            )}
              </>
            )}

            {/* The "Completed N tool call(s) without a final text response." note
                (toolOnlySummary) is intentionally not rendered — it is noise. It
                is still used as the historical-collapse preview fallback above. */}
          </div>
        )}

        {/* Timestamp - hide for tool-only messages to keep UI clean */}
        {!isToolOnlyMessage && (
          <div
            className={`mt-1.5 font-mono text-[10.5px] text-fg-5 ${isUser ? 'text-right' : ''} ${
              isStreaming || isLatestMessage ? '' : 'opacity-0 transition-opacity group-hover/msg:opacity-100'
            }`}
          >
            {isStreaming ? (
              <span className="flex items-center gap-2 font-sans text-[12px]">
                <span
                  className="status-pulse inline-block h-[7px] w-[7px] rounded-full bg-accent"
                />
                <span className="text-shimmer font-medium">Typing…</span>
              </span>
            ) : (
              <span style={{ letterSpacing: '0.02em' }}>{formatTime(message.timestamp)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Memoize to prevent unnecessary re-renders when props haven't changed
export default React.memo(MessageBubble);
