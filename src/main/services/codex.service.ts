import Store from 'electron-store';
// @openai/codex-sdk is ESM-only — must use dynamic import() in CJS context
// Type imports are fine (erased at compile time)
type ThreadEvent = import('@openai/codex-sdk').ThreadEvent;
type ThreadItem = import('@openai/codex-sdk').ThreadItem;
type Thread = import('@openai/codex-sdk').Thread;
type Codex = import('@openai/codex-sdk').Codex;

// Stream event types for Codex (parallel to Claude's StreamEvent but separate)
export interface CodexStreamEvent {
  type: 'text_start' | 'text_delta' | 'thinking_start' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'complete' | 'error';
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    status: 'running' | 'completed' | 'failed';
    result?: string;
  };
  error?: string;
}

// Result returned when Claude invokes Codex as an MCP tool
export interface CodexToolResult {
  summary: string;
  toolCalls: Array<{
    type: string;
    detail: string;
  }>;
  reasoning?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

// Lazy-load the ESM-only Codex SDK
// webpack transforms import() to __webpack_require__() which generates require() for externals.
// require() of an ESM-only package throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// Bypass webpack's static analysis with Function() to get a real ESM dynamic import().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

async function createCodex(apiKey: string): Promise<InstanceType<typeof import('@openai/codex-sdk').Codex>> {
  const mod = await dynamicImport('@openai/codex-sdk');
  // ESM dynamic import returns the namespace directly: { Codex, Thread }
  // But handle potential .default wrapping from interop layers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolved = (mod as any).default || mod;
  const CodexClass = resolved.Codex || resolved;
  if (typeof CodexClass !== 'function') {
    throw new Error(`Failed to load Codex SDK: got ${typeof CodexClass} instead of constructor. Module keys: ${Object.keys(mod).join(', ')}`);
  }
  return new CodexClass({ apiKey });
}

class CodexServiceImpl {
  private activeThreads: Map<string, { thread: Thread; abortController: AbortController }> = new Map();

  getOpenAiApiKey(): string | undefined {
    // User-provided key
    const userKey = settingsStore.get('openAiApiKey') as string | undefined;
    if (userKey) return userKey;
    // Fallback to openaiApiKey (alternate key name)
    return settingsStore.get('openaiApiKey') as string | undefined;
  }

  /**
   * Translate a Codex ThreadEvent into our CodexStreamEvent format.
   */
  private translateEvent(event: ThreadEvent): CodexStreamEvent | null {
    switch (event.type) {
      case 'item.started': {
        const item = event.item;
        switch (item.type) {
          case 'agent_message':
            return { type: 'text_start' };
          case 'reasoning':
            return { type: 'thinking_start', content: item.text || '' };
          case 'command_execution':
            return {
              type: 'tool_use',
              toolCall: {
                id: item.id,
                name: 'Bash',
                input: { command: item.command },
                status: 'running',
              },
            };
          case 'file_change':
            return {
              type: 'tool_use',
              toolCall: {
                id: item.id,
                name: 'Edit',
                input: { changes: item.changes },
                status: 'running',
              },
            };
          case 'mcp_tool_call':
            return {
              type: 'tool_use',
              toolCall: {
                id: item.id,
                name: `MCP:${item.server}:${item.tool}`,
                input: item.arguments as Record<string, unknown> || {},
                status: 'running',
              },
            };
          default:
            return null;
        }
      }

      case 'item.updated': {
        const item = event.item;
        if (item.type === 'agent_message') {
          return { type: 'text_delta', content: item.text };
        }
        if (item.type === 'reasoning') {
          return { type: 'thinking_delta', content: item.text };
        }
        if (item.type === 'command_execution') {
          return {
            type: 'tool_use',
            toolCall: {
              id: item.id,
              name: 'Bash',
              input: { command: item.command },
              status: item.status === 'completed' ? 'completed' : 'running',
              result: item.aggregated_output,
            },
          };
        }
        return null;
      }

      case 'item.completed': {
        const item = event.item;
        if (item.type === 'command_execution') {
          return {
            type: 'tool_result',
            toolCall: {
              id: item.id,
              name: 'Bash',
              input: { command: item.command },
              status: item.status === 'completed' ? 'completed' : 'failed',
              result: item.aggregated_output,
            },
          };
        }
        if (item.type === 'file_change') {
          return {
            type: 'tool_result',
            toolCall: {
              id: item.id,
              name: 'Edit',
              input: { changes: item.changes },
              status: item.status === 'completed' ? 'completed' : 'failed',
            },
          };
        }
        if (item.type === 'mcp_tool_call') {
          return {
            type: 'tool_result',
            toolCall: {
              id: item.id,
              name: `MCP:${item.server}:${item.tool}`,
              input: item.arguments as Record<string, unknown> || {},
              status: item.status === 'completed' ? 'completed' : 'failed',
              result: item.result ? JSON.stringify(item.result) : item.error?.message,
            },
          };
        }
        return null;
      }

      case 'turn.completed':
        return { type: 'complete' };

      case 'turn.failed':
        return { type: 'error', error: event.error?.message || 'Turn failed' };

      case 'error':
        return { type: 'error', error: event.message || 'Unknown error' };

      default:
        return null;
    }
  }

  /**
   * Summarise thread items into a structured result for the MCP tool response.
   */
  private summariseItems(items: ThreadItem[]): CodexToolResult {
    let summary = '';
    let reasoning = '';
    const toolCalls: Array<{ type: string; detail: string }> = [];

    for (const item of items) {
      switch (item.type) {
        case 'agent_message':
          summary += item.text + '\n';
          break;
        case 'reasoning':
          reasoning += item.text + '\n';
          break;
        case 'command_execution':
          toolCalls.push({
            type: 'bash',
            detail: `$ ${item.command}\n${item.aggregated_output || ''}`.trim(),
          });
          break;
        case 'file_change':
          toolCalls.push({
            type: 'file_change',
            detail: item.changes.map(c => `${c.kind}: ${c.path}`).join('\n'),
          });
          break;
        case 'mcp_tool_call':
          toolCalls.push({
            type: 'mcp',
            detail: `${item.server}:${item.tool}`,
          });
          break;
      }
    }

    return {
      summary: summary.trim() || 'Codex completed without a text response.',
      toolCalls,
      reasoning: reasoning.trim() || undefined,
    };
  }

  /**
   * Run Codex for the MCP tool invocation (blocks until complete, returns structured result).
   */
  async runForTool(sessionId: string, prompt: string, workingDir: string): Promise<CodexToolResult> {
    const apiKey = this.getOpenAiApiKey();
    if (!apiKey) {
      return {
        summary: 'Error: No OpenAI API key configured. Please set your OpenAI API key in Settings.',
        toolCalls: [],
      };
    }

    // Truncate if too long for Codex CLI
    const MAX_PROMPT_CHARS = 50000;
    const safePrompt = prompt.length > MAX_PROMPT_CHARS
      ? prompt.substring(0, MAX_PROMPT_CHARS) + '\n\n[... truncated due to length]'
      : prompt;

    let codex: Awaited<ReturnType<typeof createCodex>>;
    try {
      codex = await createCodex(apiKey);
    } catch (err) {
      return {
        summary: `Failed to initialize Codex: ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
      };
    }

    const thread = codex.startThread({
      workingDirectory: workingDir,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });

    const abortController = new AbortController();
    this.activeThreads.set(`tool:${sessionId}`, { thread, abortController });

    try {
      const result = await thread.run(safePrompt, { signal: abortController.signal });
      return this.summariseItems(result.items);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { summary: 'Codex run was cancelled.', toolCalls: [] };
      }
      return {
        summary: `Codex error: ${error instanceof Error ? error.message : String(error)}`,
        toolCalls: [],
      };
    } finally {
      this.activeThreads.delete(`tool:${sessionId}`);
    }
  }

  /**
   * Stream Codex events for direct /codex invocation.
   */
  async *streamDirect(sessionId: string, prompt: string, workingDir: string): AsyncGenerator<CodexStreamEvent> {
    const apiKey = this.getOpenAiApiKey();
    if (!apiKey) {
      yield { type: 'error', error: 'No OpenAI API key configured. Please set your OpenAI API key in Settings.' };
      return;
    }

    // Codex CLI has internal prompt limits — truncate if excessively long
    const MAX_PROMPT_CHARS = 50000;
    let safePrompt = prompt;
    if (prompt.length > MAX_PROMPT_CHARS) {
      console.warn(`[Codex Service] Prompt too long (${prompt.length} chars), truncating to ${MAX_PROMPT_CHARS}`);
      safePrompt = prompt.substring(0, MAX_PROMPT_CHARS) + '\n\n[... truncated due to length]';
    }

    let codex: Awaited<ReturnType<typeof createCodex>>;
    try {
      codex = await createCodex(apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Codex Service] Failed to create Codex instance:', msg);
      yield { type: 'error', error: `Failed to initialize Codex: ${msg}` };
      return;
    }

    const thread = codex.startThread({
      workingDirectory: workingDir,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });

    const abortController = new AbortController();
    this.activeThreads.set(sessionId, { thread, abortController });

    try {
      const streamedTurn = await thread.runStreamed(safePrompt, { signal: abortController.signal });

      for await (const event of streamedTurn.events) {
        const translated = this.translateEvent(event);
        if (translated) {
          yield translated;
        }
      }

      // Ensure we always yield a complete event
      yield { type: 'complete' };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'complete' };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.activeThreads.delete(sessionId);
    }
  }

  /**
   * Stream Codex as Claude-compatible StreamEvents so it works in the existing chat pipeline.
   * This is the main integration point — when user selects "Codex" as the model.
   */
  async *streamAsChat(sessionId: string, prompt: string, workingDir: string): AsyncGenerator<{
    type: string;
    content?: string;
    toolCall?: { id: string; name: string; input: Record<string, unknown>; status: string; result?: string };
    error?: string;
    systemInfo?: { tools: string[]; model: string };
  }> {
    // Emit system info first (like Claude does)
    yield {
      type: 'system',
      systemInfo: { tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'], model: 'codex' },
    };

    for await (const event of this.streamDirect(sessionId, prompt, workingDir)) {
      switch (event.type) {
        case 'text_start':
          // Nothing to emit — text_delta will follow
          break;
        case 'text_delta':
          if (event.content) {
            yield { type: 'text_delta', content: event.content };
          }
          break;
        case 'thinking_start':
        case 'thinking_delta':
          if (event.content) {
            yield { type: 'thinking_delta', content: event.content };
          }
          break;
        case 'tool_use':
          if (event.toolCall) {
            yield { type: 'tool_use', toolCall: event.toolCall };
          }
          break;
        case 'tool_result':
          if (event.toolCall) {
            yield { type: 'tool_result', toolCall: event.toolCall };
          }
          break;
        case 'complete':
          yield { type: 'message_complete' };
          break;
        case 'error':
          yield { type: 'error', error: event.error };
          break;
      }
    }
  }

  /**
   * Cancel an active Codex run for a session.
   */
  cancel(sessionId: string): void {
    // Check both direct and tool-mode keys
    for (const key of [sessionId, `tool:${sessionId}`]) {
      const active = this.activeThreads.get(key);
      if (active) {
        console.log(`[Codex Service] Cancelling run for ${key}`);
        active.abortController.abort();
        this.activeThreads.delete(key);
      }
    }
  }
}

export const codexService = new CodexServiceImpl();
