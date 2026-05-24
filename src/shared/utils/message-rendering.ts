import type { ChatMessage, ContentBlock, ToolCall } from '../types';

export interface MessageRenderArtifacts {
  toolCalls: ToolCall[];
  renderedToolCallIds: Set<string>;
  unrenderedToolCalls: ToolCall[];
  unrenderedMessageContent: string;
  isToolOnlyMessage: boolean;
  toolOnlySummary: string;
}

export function getRenderedBlockText(blocks?: ContentBlock[]): string {
  return (blocks || [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text || '')
    .join('');
}

export function getUnrenderedMessageContent(content: string | undefined, blocks?: ContentBlock[]): string {
  const rawContent = content || '';
  if (!rawContent.trim()) return '';

  const renderedBlockText = getRenderedBlockText(blocks);
  if (!renderedBlockText.trim()) return rawContent;
  if (renderedBlockText === rawContent || renderedBlockText.includes(rawContent)) return '';

  if (rawContent.includes(renderedBlockText)) {
    return rawContent.replace(renderedBlockText, '').trim();
  }

  return rawContent;
}

export function buildMissingToolCall(toolCallId: string, agentId?: string): ToolCall {
  return {
    id: toolCallId,
    name: 'Tool',
    input: {
      toolCallId,
      note: 'Tool call metadata was not available in the transcript.',
    },
    status: 'completed',
    agentId,
  };
}

export function getMessageRenderArtifacts(message: ChatMessage, streamingToolCalls?: ToolCall[]): MessageRenderArtifacts {
  const toolCalls = streamingToolCalls || (Array.isArray(message.toolCalls) ? message.toolCalls : []);
  const renderedToolCallIds = new Set(
    (message.contentBlocks || [])
      .filter((block) => block.type === 'tool_use' && block.toolCallId)
      .map((block) => block.toolCallId as string),
  );
  const unrenderedToolCalls = message.contentBlocks && message.contentBlocks.length > 0
    ? toolCalls.filter((toolCall) => !renderedToolCallIds.has(toolCall.id))
    : [];
  const unrenderedMessageContent = getUnrenderedMessageContent(message.content, message.contentBlocks);
  const renderedText = getRenderedBlockText(message.contentBlocks);
  const renderedToolCallCount = Math.max(toolCalls.length, renderedToolCallIds.size);
  const isToolOnlyMessage = !message.content?.trim() && !renderedText.trim() && renderedToolCallCount > 0;
  const toolOnlySummary = isToolOnlyMessage
    ? `Completed ${renderedToolCallCount} tool call${renderedToolCallCount === 1 ? '' : 's'} without a final text response.`
    : '';

  return {
    toolCalls,
    renderedToolCallIds,
    unrenderedToolCalls,
    unrenderedMessageContent,
    isToolOnlyMessage,
    toolOnlySummary,
  };
}
