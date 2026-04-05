import type { ChatMessage } from '../../shared/types';

const MAX_ASSISTANT_CHARS = 2000;
const MAX_TOOL_INPUT_CHARS = 100;

function normalizeChatMessageTimestamp(message: ChatMessage): ChatMessage {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  return {
    ...message,
    timestamp,
  };
}

function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const aTime = normalizeChatMessageTimestamp(a).timestamp.getTime();
  const bTime = normalizeChatMessageTimestamp(b).timestamp.getTime();
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  const roleOrder = { system: 0, user: 1, assistant: 2 };
  const roleDelta = roleOrder[a.role] - roleOrder[b.role];
  if (roleDelta !== 0) {
    return roleDelta;
  }

  return a.id.localeCompare(b.id);
}

function buildMessageFingerprint(message: ChatMessage): string {
  const normalized = normalizeChatMessageTimestamp(message);
  const toolFingerprint = (normalized.toolCalls || [])
    .map((toolCall) => `${toolCall.id}:${toolCall.name}:${toolCall.status}:${toolCall.result || ''}`)
    .join('|');

  return [
    normalized.role,
    normalized.timestamp.getTime(),
    normalized.content,
    toolFingerprint,
    normalized.interrupted ? '1' : '0',
  ].join('::');
}

export function mergeConversationMessages(primary: ChatMessage[], supplemental: ChatMessage[]): ChatMessage[] {
  const merged = [...primary, ...supplemental]
    .map(normalizeChatMessageTimestamp)
    .sort(compareChatMessages);

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: ChatMessage[] = [];

  for (const message of merged) {
    if (seenIds.has(message.id)) {
      continue;
    }

    const fingerprint = buildMessageFingerprint(message);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenIds.add(message.id);
    seenFingerprints.add(fingerprint);
    deduped.push(message);
  }

  return deduped;
}

/**
 * Format conversation history into a structured context block for Codex.
 * Builds from newest messages backward within the character budget,
 * then reverses to chronological order.
 */
export function formatConversationContext(messages: ChatMessage[], budgetChars: number): string {
  if (!messages || messages.length === 0) return '';

  const formatted: string[] = [];
  let totalChars = 0;

  // Iterate newest-first so we prioritise recent context
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.role.toUpperCase();

    // Format message content
    let content = msg.content || '';
    if (msg.role === 'assistant' && content.length > MAX_ASSISTANT_CHARS) {
      content = content.substring(0, MAX_ASSISTANT_CHARS) + '\n[...truncated]';
    }

    // Summarise tool calls (name + truncated input, skip results — they're huge)
    let toolSummary = '';
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const summaries = msg.toolCalls.map(tc => {
        let inputStr = '';
        if (tc.input) {
          if (tc.input.command) {
            inputStr = String(tc.input.command);
          } else if (tc.input.file_path) {
            inputStr = String(tc.input.file_path);
          } else {
            inputStr = JSON.stringify(tc.input);
          }
          if (inputStr.length > MAX_TOOL_INPUT_CHARS) {
            inputStr = inputStr.substring(0, MAX_TOOL_INPUT_CHARS) + '...';
          }
        }
        return `  [${tc.name}] ${inputStr}`;
      });
      toolSummary = '\n' + summaries.join('\n');
    }

    const block = `### ${role}\n${content}${toolSummary}\n`;

    // Check budget
    if (totalChars + block.length > budgetChars) break;

    formatted.push(block);
    totalChars += block.length;
  }

  if (formatted.length === 0) return '';

  // Reverse to chronological order
  formatted.reverse();

  return `<conversation_history>
The following is the recent conversation history from this coding session.
Some of these turns may have been produced by Claude and some by Codex.
Use this context to understand what has been discussed and decided.

${formatted.join('\n')}
</conversation_history>

`;
}
