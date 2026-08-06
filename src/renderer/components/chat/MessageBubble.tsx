import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GitBranch, Image, Target, FileCode, Maximize2 } from 'lucide-react';
import ToolCallCard from './ToolCallCard';
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
        className="prose prose-invert max-w-none font-mono text-claude-text pr-12 break-words"
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
                  <div className="overflow-hidden border border-claude-border my-2" style={{ borderRadius: 0 }}>
                    {match && (
                      <div
                        className="px-2 py-1 text-xs font-bold font-mono bg-claude-surface border-b border-claude-border text-claude-text-secondary"
                        style={{ letterSpacing: '0.05em' }}
                      >
                        {match[1].toUpperCase()}
                      </div>
                    )}
                    <pre className="p-3 bg-claude-bg m-0 whitespace-pre-wrap break-words">
                      <code className="text-sm font-mono text-claude-text" {...props}>
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
                    className="px-1 py-0.5 text-sm font-mono bg-claude-surface text-cyan-400 hover:text-cyan-300 hover:bg-claude-surface/80 cursor-pointer"
                    style={{ borderRadius: 0 }}
                    title={`Open ${filePath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
                  >
                    {fileName}
                    {lineNumber ? `:${lineNumber}` : ''}
                  </button>
                );
              }

              return (
                <code
                  className="px-1 py-0.5 text-sm font-mono bg-claude-surface text-claude-accent"
                  style={{ borderRadius: 0 }}
                  {...props}
                >
                  {children}
                </code>
              );
            },
            p({ children }) {
              return <p className="my-1 leading-relaxed">{children}</p>;
            },
            ul({ children }) {
              return <ul className="my-1 ml-6 pl-0 list-disc list-outside">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="my-1 ml-6 pl-0 list-decimal list-outside">{children}</ol>;
            },
            li({ children }) {
              return <li className="my-0.5 ml-0 pl-1">{children}</li>;
            },
            h1({ children }) {
              return <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>;
            },
            h2({ children }) {
              return <h2 className="text-base font-bold mt-2 mb-1">{children}</h2>;
            },
            h3({ children }) {
              return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>;
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
                <blockquote className="border-l-2 border-claude-accent pl-3 my-2 text-claude-text-secondary">
                  {children}
                </blockquote>
              );
            },
            strong({ children }) {
              return <strong className="font-bold text-claude-text">{children}</strong>;
            },
            em({ children }) {
              return <em className="italic">{children}</em>;
            },
            table({ children }) {
              return (
                <div className="my-2 overflow-x-auto">
                  <table className="min-w-full border border-claude-border" style={{ borderRadius: 0 }}>
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children }) {
              return <thead className="bg-claude-surface">{children}</thead>;
            },
            tbody({ children }) {
              return <tbody>{children}</tbody>;
            },
            tr({ children }) {
              return <tr className="border-b border-claude-border">{children}</tr>;
            },
            th({ children }) {
              return (
                <th className="px-3 py-2 text-left text-sm font-bold border-r border-claude-border last:border-r-0">
                  {children}
                </th>
              );
            },
            td({ children }) {
              return (
                <td className="px-3 py-2 text-sm border-r border-claude-border last:border-r-0">{children}</td>
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
    <div className="flex items-center gap-2 text-[11px] font-mono text-claude-text-secondary border-l-2 border-claude-border pl-2 py-1 bg-claude-surface/20">
      <FileCode size={12} className="text-claude-text-secondary flex-shrink-0" />
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
    <div className="border-l-2 border-claude-border pl-3 py-2 bg-claude-surface/10 space-y-2">
      {preview ? (
        <p
          className="whitespace-pre-wrap text-sm text-claude-text-secondary font-mono break-words"
          style={{ overflowWrap: 'anywhere' }}
        >
          {preview}
        </p>
      ) : (
        <p className="text-sm text-claude-text-secondary font-mono">
          Historical assistant response collapsed.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CollapsedToolSummary count={toolCount} />
        <button
          type="button"
          onClick={onExpand}
          className="px-2 py-1 text-[11px] font-mono font-bold text-claude-accent border border-claude-border hover:bg-claude-surface"
          style={{ borderRadius: 0 }}
        >
          SHOW DETAILS
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
    <div className="flex gap-2 min-w-0">
      {/* Content */}
      <div className="flex-1 min-w-0">
        {isSystem ? (
          // System messages (setup output) - distinct styling with terminal look
          <div className="border border-claude-border bg-claude-bg">
            <div className="px-3 py-1.5 border-b border-claude-border bg-claude-surface flex items-center gap-2">
              <span className="text-[10px] font-bold text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                SETUP OUTPUT
              </span>
            </div>
            <div className="p-3 max-h-96 overflow-y-auto">
              <div className="prose prose-invert max-w-none font-mono text-claude-text text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content || ''}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : isUser ? (
          // User messages - left border accent with subtle background
          <div className="relative group border-l-2 border-blue-500 pl-3 py-1 bg-blue-500/5">
            {/* Rewind button - appears on hover in top-right */}
            {showRewindButton && (
              <button
                onClick={handleRewind}
                disabled={isRewinding}
                className="absolute top-0 right-0 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-claude-text-secondary hover:text-claude-accent hover:bg-claude-surface/50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Fork conversation from this point"
                style={{ borderRadius: 0 }}
              >
                <GitBranch size={14} className={isRewinding ? 'animate-pulse' : ''} />
              </button>
            )}
            <p className="whitespace-pre-wrap text-claude-text font-mono text-base pr-8">
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
                      <div key={index} className="border border-blue-500/20 overflow-hidden" style={{ borderRadius: 0 }}>
                        <img
                          src={src}
                          alt={attachment.name}
                          className="max-h-40 max-w-xs object-contain bg-black/20"
                        />
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-500/10 border-t border-blue-500/20">
                          {attachment.type === 'dom_element' ? (
                            <Target size={10} className="text-blue-400 flex-shrink-0" />
                          ) : (
                            <Image size={10} className="text-green-400 flex-shrink-0" />
                          )}
                          <span className="truncate font-mono text-[10px] text-claude-text-secondary">
                            {attachment.name}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={index}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs bg-blue-500/10 border border-blue-500/20"
                      style={{ borderRadius: 0 }}
                    >
                      {attachment.type === 'dom_element' ? (
                        <Target size={12} className="text-blue-400" />
                      ) : (
                        <FileCode size={12} className="text-purple-400" />
                      )}
                      <span className="truncate max-w-[200px] font-mono text-xs text-claude-text-secondary">
                        {attachment.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          // Assistant messages - render content blocks in order when available
          <div className="space-y-2">
            {/* Interrupted indicator */}
            {message.interrupted && (
              <div className="flex items-center gap-2 px-2 py-1 bg-amber-500/10 border-l-2 border-amber-500 text-amber-400 text-xs font-mono">
                <span style={{ letterSpacing: '0.05em' }}>INTERRUPTED</span>
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
                className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono text-claude-text-secondary hover:text-claude-accent border border-claude-border hover:border-claude-accent transition-colors bg-claude-surface/50"
                style={{ borderRadius: 0 }}
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
                    renderedBlocks.push(
                      <div key={toolCall.id} style={agentStyle}>
                        <ToolCallCard
                          toolCall={toolCall}
                          isLatestToolCall={isLatestMessage && blockIndex === message.contentBlocks!.length - 1 && block.type === 'tool_use'}
                          isStreaming={isStreaming}
                          defaultCollapsed={collapseToolCardsByDefault}
                        />
                      </div>
                    );
                  } else if (block.type === 'text' && block.text) {
                    if (shouldRenderAssistantTextAsHtml) {
                      return;
                    }
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

                const unrenderedToolBlocks: React.ReactNode[] = [];
                unrenderedToolCalls.forEach((toolCall, index) => {
                  if (renderedToolCards >= toolCardRenderLimit) {
                    omittedToolCards += 1;
                    return;
                  }
                  renderedToolCards += 1;
                  unrenderedToolBlocks.push(
                    <ToolCallCard
                      key={`unrendered-tool-${toolCall.id}`}
                      toolCall={toolCall}
                      isLatestToolCall={isLatestMessage && index === unrenderedToolCalls.length - 1}
                      isStreaming={isStreaming}
                      defaultCollapsed={collapseToolCardsByDefault}
                    />
                  );
                });

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
                {toolCalls.slice(0, toolCardRenderLimit).map((toolCall, index) => (
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
                <div className="prose prose-invert max-w-none font-mono text-claude-text pr-12 break-words" style={{ overflowWrap: 'anywhere' }}>
                  <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Custom code block rendering
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      const isBlock = String(children).includes('\n') || match;

                      if (isBlock) {
                        return (
                          <div className="overflow-hidden border border-claude-border my-2" style={{ borderRadius: 0 }}>
                            {match && (
                              <div
                                className="px-2 py-1 text-xs font-bold font-mono bg-claude-surface border-b border-claude-border text-claude-text-secondary"
                                style={{ letterSpacing: '0.05em' }}
                              >
                                {match[1].toUpperCase()}
                              </div>
                            )}
                            <pre className="p-3 bg-claude-bg m-0 whitespace-pre-wrap break-words">
                              <code className="text-sm font-mono text-claude-text" {...props}>
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
                            className="px-1 py-0.5 text-sm font-mono bg-claude-surface text-cyan-400 hover:text-cyan-300 hover:bg-claude-surface/80 cursor-pointer"
                            style={{ borderRadius: 0 }}
                            title={`Open ${filePath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
                          >
                            {fileName}{lineNumber ? `:${lineNumber}` : ''}
                          </button>
                        );
                      }

                      return (
                        <code
                          className="px-1 py-0.5 text-sm font-mono bg-claude-surface text-claude-accent"
                          style={{ borderRadius: 0 }}
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    // Style paragraphs
                    p({ children }) {
                      return <p className="my-1 leading-relaxed">{children}</p>;
                    },
                    // Style lists
                    ul({ children }) {
                      return <ul className="my-1 ml-6 pl-0 list-disc list-outside">{children}</ul>;
                    },
                    ol({ children }) {
                      return <ol className="my-1 ml-6 pl-0 list-decimal list-outside">{children}</ol>;
                    },
                    li({ children }) {
                      return <li className="my-0.5 ml-0 pl-1">{children}</li>;
                    },
                    // Style headings
                    h1({ children }) {
                      return <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>;
                    },
                    h2({ children }) {
                      return <h2 className="text-base font-bold mt-2 mb-1">{children}</h2>;
                    },
                    h3({ children }) {
                      return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>;
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
                        <blockquote className="border-l-2 border-claude-accent pl-3 my-2 text-claude-text-secondary">
                          {children}
                        </blockquote>
                      );
                    },
                    // Style strong/bold
                    strong({ children }) {
                      return <strong className="font-bold text-claude-text">{children}</strong>;
                    },
                    // Style emphasis/italic
                    em({ children }) {
                      return <em className="italic">{children}</em>;
                    },
                    // Style tables
                    table({ children }) {
                      return (
                        <div className="my-2 overflow-x-auto">
                          <table className="min-w-full border border-claude-border" style={{ borderRadius: 0 }}>
                            {children}
                          </table>
                        </div>
                      );
                    },
                    thead({ children }) {
                      return <thead className="bg-claude-surface">{children}</thead>;
                    },
                    tbody({ children }) {
                      return <tbody>{children}</tbody>;
                    },
                    tr({ children }) {
                      return <tr className="border-b border-claude-border">{children}</tr>;
                    },
                    th({ children }) {
                      return (
                        <th className="px-3 py-2 text-left text-sm font-bold border-r border-claude-border last:border-r-0">
                          {children}
                        </th>
                      );
                    },
                    td({ children }) {
                      return (
                        <td className="px-3 py-2 text-sm border-r border-claude-border last:border-r-0">
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

            {!historicalCollapsed && toolOnlySummary && (
              <div className="text-xs font-mono text-claude-text-secondary border-l-2 border-claude-border pl-2">
                {toolOnlySummary}
              </div>
            )}
          </div>
        )}

        {/* Timestamp - hide for tool-only messages to keep UI clean */}
        {!isToolOnlyMessage && (
          <div
            className={`text-xs mt-1 font-mono text-claude-text-secondary ${isUser ? 'text-right' : ''}`}
          >
            {isStreaming ? (
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-1.5 h-1.5 animate-pulse bg-claude-accent"
                  style={{ borderRadius: 0 }}
                />
                <span style={{ letterSpacing: '0.05em' }}>TYPING...</span>
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
