import type { ChatMessage, ContentBlock, ToolCall } from '../types';
import { withFallbackHarness } from './message-recovery';

interface BuildCompletedStreamMessageOptions {
  message?: ChatMessage;
  content: string;
  toolCalls?: ToolCall[];
  contentBlocks?: ContentBlock[];
  model?: string | null;
  resolvedModel?: string | null;
  fallbackId?: string;
  timestamp?: Date;
}

function hasObjectKeys(value: Record<string, unknown> | undefined): boolean {
  return !!value && Object.keys(value).length > 0;
}

function mergeToolCall(existing: ToolCall, incoming: ToolCall): ToolCall {
  return {
    ...existing,
    ...incoming,
    input: hasObjectKeys(incoming.input) ? incoming.input : existing.input,
    result: incoming.result ?? existing.result,
    error: incoming.error ?? existing.error,
    startedAt: incoming.startedAt ?? existing.startedAt,
    completedAt: incoming.completedAt ?? existing.completedAt,
    agentId: incoming.agentId ?? existing.agentId,
  };
}

function mergeToolCalls(accumulated: ToolCall[] = [], fromMessage: ToolCall[] = []): ToolCall[] | undefined {
  const merged: ToolCall[] = [];
  const indexById = new Map<string, number>();

  for (const toolCall of [...accumulated, ...fromMessage]) {
    const existingIndex = indexById.get(toolCall.id);
    if (existingIndex === undefined) {
      indexById.set(toolCall.id, merged.length);
      merged.push(toolCall);
      continue;
    }

    merged[existingIndex] = mergeToolCall(merged[existingIndex], toolCall);
  }

  return merged.length > 0 ? merged : undefined;
}

function contentBlockKey(block: ContentBlock): string {
  if (block.type === 'tool_use') {
    return `tool:${block.toolCallId || ''}:${block.agentId || ''}`;
  }

  return `text:${block.text || ''}:${block.agentId || ''}`;
}

function mergeContentBlocks(accumulated: ContentBlock[] = [], fromMessage: ContentBlock[] = []): ContentBlock[] | undefined {
  const merged: ContentBlock[] = [];
  const seen = new Set<string>();

  for (const block of [...accumulated, ...fromMessage]) {
    const key = contentBlockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }

  return merged.length > 0 ? merged : undefined;
}

function selectCompletedContent(messageContent = '', streamedContent = ''): string {
  if (!messageContent) return streamedContent;
  if (!streamedContent) return messageContent;
  if (messageContent === streamedContent) return messageContent;
  if (messageContent.includes(streamedContent)) return messageContent;
  if (streamedContent.includes(messageContent)) return streamedContent;
  return streamedContent.length > messageContent.length ? streamedContent : messageContent;
}

function hasToolActivity(toolCalls?: ToolCall[], contentBlocks?: ContentBlock[]): boolean {
  return !!toolCalls?.length || !!contentBlocks?.some((block) => block.type === 'tool_use');
}

export function buildCompletedStreamMessage({
  message,
  content,
  toolCalls = [],
  contentBlocks = [],
  model,
  resolvedModel,
  fallbackId,
  timestamp,
}: BuildCompletedStreamMessageOptions): ChatMessage {
  const finalToolCalls = mergeToolCalls(toolCalls, message?.toolCalls);
  const finalContentBlocks = mergeContentBlocks(contentBlocks, message?.contentBlocks);
  const selectedContent = selectCompletedContent(message?.content, content);
  const finalContent = selectedContent.trim() || !hasToolActivity(finalToolCalls, finalContentBlocks)
    ? selectedContent
    : 'The agent stopped after tool activity without returning a final text response. The last tool result is shown above.';
  const contentBlocksWithFallback = finalContent === selectedContent
    ? finalContentBlocks
    : mergeContentBlocks(finalContentBlocks, [{ type: 'text', text: finalContent }]);
  const finalMessage = message ? {
    ...message,
    content: finalContent,
    toolCalls: finalToolCalls,
    contentBlocks: contentBlocksWithFallback,
  } : {
    id: fallbackId || Date.now().toString(),
    role: 'assistant' as const,
    content: finalContent,
    timestamp: timestamp || new Date(),
    toolCalls: finalToolCalls,
    contentBlocks: contentBlocksWithFallback,
  };

  return withFallbackHarness(finalMessage, model, resolvedModel);
}
