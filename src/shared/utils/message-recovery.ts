import type { ChatMessage, Harness, ToolCall } from '../types';

export type PersistedChatMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

export function hasRecoverableOutput(message: ChatMessage): boolean {
  return Boolean(
    message.content?.trim()
    || message.contentBlocks?.length
    || message.toolCalls?.length
  );
}

export function harnessFromModel(model?: string | null): Harness {
  if (!model) return 'claude';
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('custom:')) return 'custom';
  return 'claude';
}

export function fallbackModelForHarness(model?: string | null, resolvedModel?: string | null): string | undefined {
  if (model === 'auto' && resolvedModel) return resolvedModel;
  return model || resolvedModel || undefined;
}

export function withFallbackHarness(message: ChatMessage, model?: string | null, resolvedModel?: string | null): ChatMessage {
  const fallbackModel = fallbackModelForHarness(model, resolvedModel);
  const fallbackHarness = harnessFromModel(fallbackModel);
  const shouldUseResolvedAutoHarness = model === 'auto' && !!resolvedModel && message.harness !== fallbackHarness;
  if (message.harness && !shouldUseResolvedAutoHarness) return message;
  return {
    ...message,
    harness: fallbackHarness,
  };
}

export function normalizeCompletedStreamMessage(message: PersistedChatMessage | ChatMessage): ChatMessage | null {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    ...message,
    timestamp,
  };
}

export function serializeCompletedStreamMessage(message: ChatMessage): PersistedChatMessage {
  const normalized = normalizeCompletedStreamMessage(message);
  return {
    ...(normalized || message),
    timestamp: (normalized?.timestamp || new Date()).toISOString(),
  };
}

export function messageTimestamp(message: ChatMessage): number {
  const raw = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  const time = raw.getTime();
  return Number.isFinite(time) ? time : 0;
}

const STATUS_PREFIX_RE = /^(?:⚠️ Remote session hiccup — retrying\.\.\.|⏳ Rate limited — retrying in \d+s\.\.\.)\n*/gm;

export function normalizeContentForCompare(content?: string): string {
  return (content || '')
    .replace(/\r\n/g, '\n')
    .replace(STATUS_PREFIX_RE, '')
    .trim();
}

export function toolSignature(message: ChatMessage): string {
  return (message.toolCalls || [])
    .map((toolCall) => `${toolCall.id}:${toolCall.name}:${toolCall.status}:${JSON.stringify(toolCall.input || {})}:${JSON.stringify(toolCall.result || '')}:${toolCall.error || ''}`)
    .join('|');
}

export function contentBlockSignature(message: ChatMessage): string {
  return (message.contentBlocks || [])
    .map((block) => `${block.type}:${block.text || ''}:${block.toolCallId || ''}:${block.agentId || ''}`)
    .join('|');
}

export function isDuplicateStreamMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id === b.id) return true;
  if (a.role !== b.role) return false;
  if (a.harness !== b.harness) return false;

  const aContent = normalizeContentForCompare(a.content);
  const bContent = normalizeContentForCompare(b.content);
  if (aContent !== bContent) return false;

  const timeDelta = Math.abs(messageTimestamp(a) - messageTimestamp(b));
  if (timeDelta > 60_000) return false;

  const aTools = toolSignature(a);
  const bTools = toolSignature(b);
  const aBlocks = contentBlockSignature(a);
  const bBlocks = contentBlockSignature(b);
  return Boolean(
    aContent
    || (aTools && aTools === bTools)
    || (aBlocks && aBlocks === bBlocks)
  );
}

export function isCloseTimelineDuplicate(a: ChatMessage, b: ChatMessage, windowMs = 60_000): boolean {
  if (a.id === b.id) return true;
  if (a.role !== b.role) return false;
  if (a.harness !== b.harness) return false;

  const aContent = normalizeContentForCompare(a.content);
  const bContent = normalizeContentForCompare(b.content);
  if (aContent !== bContent) return false;

  const timeDelta = Math.abs(messageTimestamp(a) - messageTimestamp(b));
  if (timeDelta > windowMs) return false;

  const aTools = toolSignature(a);
  const bTools = toolSignature(b);
  const aBlocks = contentBlockSignature(a);
  const bBlocks = contentBlockSignature(b);
  if (aTools || bTools || aBlocks || bBlocks) {
    return aTools === bTools && aBlocks === bBlocks;
  }

  return aContent.length > 0;
}

export function isCloseContentDuplicate(a: ChatMessage, b: ChatMessage, windowMs = 5_000): boolean {
  if (a.id === b.id) return true;
  if (a.role !== b.role) return false;
  if (a.harness !== b.harness) return false;

  const aContent = normalizeContentForCompare(a.content);
  const bContent = normalizeContentForCompare(b.content);
  if (!aContent || aContent !== bContent) return false;

  const timeDelta = Math.abs(messageTimestamp(a) - messageTimestamp(b));
  return timeDelta <= windowMs;
}

export function isExactLongAssistantDuplicate(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id === b.id) return true;
  if (a.role !== 'assistant' || b.role !== 'assistant') return false;
  if ((a.harness || '') !== (b.harness || '')) return false;

  const aContent = normalizeContentForCompare(a.content);
  const bContent = normalizeContentForCompare(b.content);
  if (aContent.length < 200 || aContent !== bContent) return false;
  return true;
}

export function isPrefixAssistantDuplicate(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== 'assistant' || b.role !== 'assistant') return false;
  if ((a.harness || '') !== (b.harness || '')) return false;
  const aContent = normalizeContentForCompare(a.content);
  const bContent = normalizeContentForCompare(b.content);
  if (aContent.length < 200 || bContent.length < 200) return false;
  if (aContent.length === bContent.length) return false;
  const shorter = aContent.length < bContent.length ? aContent : bContent;
  const longer = aContent.length < bContent.length ? bContent : aContent;
  return longer.startsWith(shorter);
}

export function isInterruptedSafetyNetDuplicate(existing: ChatMessage, incoming: ChatMessage): boolean {
  return Boolean(
    existing.interrupted
    && incoming.interrupted
    && isCloseTimelineDuplicate(existing, incoming)
  );
}

function mergeToolCallsForRecovery(existing: ChatMessage, incoming: ChatMessage): ToolCall[] | undefined {
  const merged: ToolCall[] = [];
  const indexById = new Map<string, number>();

  for (const toolCall of [...(existing.toolCalls || []), ...(incoming.toolCalls || [])]) {
    const existingIndex = indexById.get(toolCall.id);
    if (existingIndex === undefined) {
      indexById.set(toolCall.id, merged.length);
      merged.push(toolCall);
      continue;
    }

    merged[existingIndex] = {
      ...merged[existingIndex],
      ...toolCall,
      input: Object.keys(toolCall.input || {}).length > 0 ? toolCall.input : merged[existingIndex].input,
      result: toolCall.result ?? merged[existingIndex].result,
      error: toolCall.error ?? merged[existingIndex].error,
    };
  }

  return merged.length > 0 ? merged : undefined;
}

function contentBlockRecoveryKey(block: NonNullable<ChatMessage['contentBlocks']>[number]): string {
  return `${block.type}:${block.text || ''}:${block.toolCallId || ''}:${block.agentId || ''}`;
}

function mergeContentBlocksForRecovery(existing: ChatMessage, incoming: ChatMessage): ChatMessage['contentBlocks'] {
  const merged: NonNullable<ChatMessage['contentBlocks']> = [];
  const seen = new Set<string>();

  for (const block of [...(existing.contentBlocks || []), ...(incoming.contentBlocks || [])]) {
    const key = contentBlockRecoveryKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }

  return merged.length > 0 ? merged : undefined;
}

function mergeDuplicateRecoveredMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const existingContent = existing.content || '';
  const incomingContent = incoming.content || '';
  const content = incomingContent.length > existingContent.length ? incomingContent : existingContent;
  return {
    ...existing,
    content,
    toolCalls: mergeToolCallsForRecovery(existing, incoming),
    contentBlocks: mergeContentBlocksForRecovery(existing, incoming),
    interrupted: existing.interrupted || incoming.interrupted,
  };
}

export function mergeRecoveredStreamMessages(
  transcriptMessages: ChatMessage[],
  recoveredMessages: ChatMessage[],
  limit?: number,
): ChatMessage[] {
  if (recoveredMessages.length === 0) return transcriptMessages;

  const merged: ChatMessage[] = [];
  for (const message of [...transcriptMessages, ...recoveredMessages].sort((a, b) => messageTimestamp(a) - messageTimestamp(b))) {
    const duplicateIndex = merged.findIndex((existing) =>
      isDuplicateStreamMessage(existing, message)
      || (isExactLongAssistantDuplicate(existing, message)
          && Math.abs(messageTimestamp(existing) - messageTimestamp(message)) < 300_000)
      || isPrefixAssistantDuplicate(existing, message)
    );
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = mergeDuplicateRecoveredMessage(merged[duplicateIndex], message);
      continue;
    }
    merged.push(message);
  }

  return limit && limit > 0 ? merged.slice(-limit) : merged;
}

function normalizedPromptText(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
}

function goalEchoContent(content: string): string | undefined {
  const match = content.match(/^\/goal\s+([\s\S]+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function filterInternalPromptEchoes(messages: ChatMessage[]): ChatMessage[] {
  const filtered: ChatMessage[] = [];

  for (const message of messages) {
    const goalContent = message.role === 'user' ? goalEchoContent(message.content || '') : undefined;
    if (goalContent) {
      const normalizedGoal = normalizedPromptText(goalContent);
      const messageTime = messageTimestamp(message);
      const duplicateVisiblePrompt = [...filtered].reverse().find((candidate) => {
        if (candidate.role !== 'user') return false;
        const candidateContent = candidate.content || '';
        if (goalEchoContent(candidateContent)) return false;
        if (normalizedPromptText(candidateContent) !== normalizedGoal) return false;
        return Math.abs(messageTime - messageTimestamp(candidate)) <= 10 * 60_000;
      });

      if (duplicateVisiblePrompt) {
        continue;
      }
    }

    filtered.push(message);
  }

  return filtered;
}
