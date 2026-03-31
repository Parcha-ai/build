import type { ChatMessage } from '../../shared/types';

const MAX_ASSISTANT_CHARS = 2000;
const MAX_TOOL_INPUT_CHARS = 100;

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
You are continuing work that was started by a previous assistant (Claude).
Use this context to understand what has been discussed and decided.

${formatted.join('\n')}
</conversation_history>

`;
}
