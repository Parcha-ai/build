/**
 * OpenClaw Gateway Service
 *
 * Streams chat completions from an OpenClaw gateway endpoint using the
 * OpenAI-compatible /v1/chat/completions API with SSE.  Maintains per-session
 * conversation history in memory and yields events matching the existing chat
 * pipeline StreamEvent format so the renderer needs zero special handling.
 */
import type { ChatMessage } from '../../shared/types';

interface OpenClawMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

class OpenClawService {
  /** Conversation history keyed by sessionId */
  private conversations = new Map<string, OpenClawMessage[]>();
  /** Active AbortControllers keyed by sessionId (for cancellation) */
  private activeRequests = new Map<string, AbortController>();

  /**
   * Stream a chat completion from an OpenClaw gateway.
   *
   * Yields events compatible with the existing StreamEvent pipeline:
   *   system  -> { type:'system', systemInfo }
   *   text_delta -> { type:'text_delta', content }
   *   message_complete -> { type:'message_complete' }
   *   error   -> { type:'error', error }
   */
  async *streamAsChat(
    sessionId: string,
    prompt: string,
    gatewayUrl: string,
    gatewayPassword: string,
  ): AsyncGenerator<{
    type: string;
    content?: string;
    toolCall?: { id: string; name: string; input: Record<string, unknown>; status: string; result?: string };
    error?: string;
    systemInfo?: { tools: string[]; model: string };
    message?: ChatMessage;
    resolvedModel?: string;
  }> {
    // Emit system info event at the start so the UI shows the model badge
    yield {
      type: 'system',
      systemInfo: { tools: [], model: 'openclaw' },
    };

    // Build conversation history
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    const history = this.conversations.get(sessionId)!;
    history.push({ role: 'user', content: prompt });

    // Create abort controller for this request
    const abortController = new AbortController();
    this.activeRequests.set(sessionId, abortController);

    let fullResponse = '';

    try {
      // Normalise URL – strip trailing slash
      const baseUrl = gatewayUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gatewayPassword}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openclaw',
          messages: history.map(m => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const errorMsg = `OpenClaw gateway returned ${response.status}: ${errorBody || response.statusText}`;
        console.error(`[OpenClaw] ${errorMsg}`);
        yield { type: 'error', error: errorMsg };
        // Remove the failed user message from history
        history.pop();
        return;
      }

      if (!response.body) {
        yield { type: 'error', error: 'OpenClaw gateway returned no response body' };
        history.pop();
        return;
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        // Keep the last potentially-incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith(':')) continue;

          // SSE data lines
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            // Stream terminator
            if (data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta;

              if (delta?.content) {
                fullResponse += delta.content;
                yield { type: 'text_delta', content: delta.content };
              }
            } catch {
              // Malformed JSON in SSE – skip this chunk
              console.warn('[OpenClaw] Failed to parse SSE data:', data);
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta;
              if (delta?.content) {
                fullResponse += delta.content;
                yield { type: 'text_delta', content: delta.content };
              }
            } catch {
              // Ignore
            }
          }
        }
      }

      // Append assistant response to conversation history
      if (fullResponse) {
        history.push({ role: 'assistant', content: fullResponse });
      }

      yield {
        type: 'message_complete',
        message: fullResponse.trim() ? {
          id: `openclaw-result-${Date.now()}`,
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date(),
          harness: 'custom',
        } : undefined,
        resolvedModel: 'custom:openclaw',
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled – still record partial response if any
        if (fullResponse) {
          history.push({ role: 'assistant', content: fullResponse });
        }
        yield {
          type: 'message_complete',
          message: fullResponse.trim() ? {
            id: `openclaw-result-${Date.now()}`,
            role: 'assistant',
            content: fullResponse,
            timestamp: new Date(),
            harness: 'custom',
            interrupted: true,
          } : undefined,
          resolvedModel: 'custom:openclaw',
        };
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[OpenClaw] Stream error:', errorMsg);
        yield { type: 'error', error: errorMsg };
        // Remove failed user message
        history.pop();
      }
    } finally {
      this.activeRequests.delete(sessionId);
    }
  }

  /**
   * Cancel an active OpenClaw request for the given session.
   */
  cancel(sessionId: string): void {
    const controller = this.activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionId);
    }
  }

  /**
   * Clear conversation history for a session (used on session deletion).
   */
  clearHistory(sessionId: string): void {
    this.conversations.delete(sessionId);
    this.activeRequests.delete(sessionId);
  }
}

export const openclawService = new OpenClawService();
