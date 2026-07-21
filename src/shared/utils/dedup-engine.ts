import type { ChatMessage, ToolCall } from '../types';

/**
 * DedupEngine — tiered deduplication for ChatMessage recovery
 *
 * Catches duplicates via exact, prefix, fuzzy paragraph overlap, and tool signature matching.
 * Replaces the 5 separate dedup functions in message-recovery.ts with a single class.
 */
class DedupEngine {
  /**
   * Check if two messages are duplicates using tiered matching.
   * Tiers are tried in order; first match wins.
   */
  isDuplicate(a: ChatMessage, b: ChatMessage, opts?: {
    maxTimeDeltaMs?: number;  // Default: 300_000 (5 minutes)
    fuzzyThreshold?: number;  // Default: 0.7 (70% paragraph overlap)
  }): boolean {
    const maxTimeDeltaMs = opts?.maxTimeDeltaMs ?? 300_000;
    const fuzzyThreshold = opts?.fuzzyThreshold ?? 0.7;

    // Tier 1: ID match
    if (a.id === b.id) return true;

    // Tier 2: Role mismatch (short-circuit)
    if (a.role !== b.role) return false;

    // Time gate for tiers 3-6
    const timeDelta = Math.abs(this.messageTimestamp(a) - this.messageTimestamp(b));
    const withinTimeWindow = timeDelta <= maxTimeDeltaMs;

    const aNormContent = this.normalize(a.content);
    const bNormContent = this.normalize(b.content);

    // Tier 3: Exact content match
    if (aNormContent === bNormContent && withinTimeWindow) {
      // Only match if content non-empty OR tool/contentBlock signatures match
      if (aNormContent.length > 0) return true;
      const aToolSig = this.toolSignature(a);
      const bToolSig = this.toolSignature(b);
      const aBlockSig = this.contentBlockSignature(a);
      const bBlockSig = this.contentBlockSignature(b);
      if (aToolSig && aToolSig === bToolSig) return true;
      if (aBlockSig && aBlockSig === bBlockSig) return true;
    }

    // Tier 4: Prefix match (both > 200 chars, one starts with the other)
    if (withinTimeWindow && aNormContent.length > 200 && bNormContent.length > 200) {
      if (aNormContent.startsWith(bNormContent) || bNormContent.startsWith(aNormContent)) {
        return true;
      }
    }

    // Tier 5: Fuzzy paragraph overlap (assistant messages, both > 500 chars)
    if (
      withinTimeWindow
      && a.role === 'assistant'
      && b.role === 'assistant'
      && aNormContent.length > 500
      && bNormContent.length > 500
    ) {
      const overlap = this.paragraphOverlap(aNormContent, bNormContent);
      if (overlap >= fuzzyThreshold) return true;
    }

    // Tier 6: Tool signature match
    if (withinTimeWindow) {
      const aToolSig = this.toolSignature(a);
      const bToolSig = this.toolSignature(b);
      if (aToolSig && bToolSig && aToolSig === bToolSig) return true;
    }

    return false;
  }

  /**
   * Merge a duplicate pair, keeping the longer/more complete version.
   * Used during transcript recovery when we know two messages are duplicates.
   */
  mergeDuplicate(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
    const existingContent = this.normalize(existing.content);
    const incomingContent = this.normalize(incoming.content);
    const content = incomingContent.length > existingContent.length ? incoming.content : existing.content;

    return {
      ...existing,
      content,
      toolCalls: this.mergeToolCalls(existing, incoming),
      contentBlocks: this.mergeContentBlocks(existing, incoming),
      interrupted: existing.interrupted || incoming.interrupted,
      timestamp: this.messageTimestamp(existing) < this.messageTimestamp(incoming)
        ? existing.timestamp
        : incoming.timestamp,
    };
  }

  /**
   * Deduplicate an array of messages, preserving order.
   * Later messages are preferred over earlier ones when merging.
   */
  deduplicateMessages(messages: ChatMessage[]): ChatMessage[] {
    const sorted = [...messages].sort((a, b) => this.messageTimestamp(a) - this.messageTimestamp(b));
    const result: ChatMessage[] = [];

    for (const message of sorted) {
      const duplicateIndex = result.findIndex((existing) => this.isDuplicate(existing, message));
      if (duplicateIndex >= 0) {
        result[duplicateIndex] = this.mergeDuplicate(result[duplicateIndex], message);
      } else {
        result.push(message);
      }
    }

    return result;
  }

  // Private helper methods

  private normalize(content?: string): string {
    if (!content) return '';
    const STATUS_PREFIX_RE = /^(?:⚠️ Remote session hiccup — retrying\.\.\.|⏳ Rate limited — retrying in \d+s\.\.\.)\n*/gm;
    return content
      .replace(/\r\n/g, '\n')
      .replace(STATUS_PREFIX_RE, '')
      .trim();
  }

  private paragraphs(text: string): string[] {
    return text
      .split(/\n{2,}/)
      .map((para) => para.replace(/\s+/g, ' ').trim())
      .filter((para) => para.length >= 50);
  }

  private paragraphOverlap(a: string, b: string): number {
    const aParagraphs = this.paragraphs(a);
    const bParagraphs = this.paragraphs(b);
    if (aParagraphs.length === 0 || bParagraphs.length === 0) return 0;

    const bSet = new Set(bParagraphs);
    const shared = aParagraphs.filter((para) => bSet.has(para)).length;
    const maxLength = Math.max(aParagraphs.length, bParagraphs.length);
    return shared / maxLength;
  }

  private toolSignature(message: ChatMessage): string {
    if (!message.toolCalls || message.toolCalls.length === 0) return '';
    return message.toolCalls
      .map((toolCall) => {
        const input = JSON.stringify(toolCall.input || {});
        const result = JSON.stringify(toolCall.result || '');
        const error = toolCall.error || '';
        return `${toolCall.id}:${toolCall.name}:${toolCall.status}:${input}:${result}:${error}`;
      })
      .join('|');
  }

  private contentBlockSignature(message: ChatMessage): string {
    if (!message.contentBlocks || message.contentBlocks.length === 0) return '';
    return message.contentBlocks
      .map((block) => `${block.type}:${block.text || ''}:${block.toolCallId || ''}:${block.agentId || ''}`)
      .join('|');
  }

  private messageTimestamp(message: ChatMessage): number {
    const raw = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
    const time = raw.getTime();
    return Number.isFinite(time) ? time : 0;
  }

  private mergeToolCalls(existing: ChatMessage, incoming: ChatMessage): ToolCall[] | undefined {
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

  private mergeContentBlocks(existing: ChatMessage, incoming: ChatMessage): ChatMessage['contentBlocks'] {
    const merged: NonNullable<ChatMessage['contentBlocks']> = [];
    const seen = new Set<string>();

    for (const block of [...(existing.contentBlocks || []), ...(incoming.contentBlocks || [])]) {
      const key = `${block.type}:${block.text || ''}:${block.toolCallId || ''}:${block.agentId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(block);
    }

    return merged.length > 0 ? merged : undefined;
  }
}

// Singleton export
export const dedupEngine = new DedupEngine();
