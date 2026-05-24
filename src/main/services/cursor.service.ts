import { Agent } from '@cursor/sdk';
import type { InteractionUpdate, McpServerConfig, Run, SDKAgent } from '@cursor/sdk';
import Store from 'electron-store';
import type { ChatMessage } from '../../shared/types';
import type { MCPServerConfig } from './mcp.service';
import { mcpService } from './mcp.service';

export interface CursorStreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'message_complete' | 'error' | 'system';
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    status: string;
    result?: string;
  };
  error?: string;
  systemInfo?: { tools: string[]; model: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
  };
  message?: ChatMessage;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

function toolTypeName(type: string): string {
  const map: Record<string, string> = {
    shell: 'Bash',
    edit: 'Edit',
    write: 'Write',
    read: 'Read',
    delete: 'Delete',
    glob: 'Glob',
    grep: 'Grep',
    ls: 'Ls',
    mcp: 'MCP',
    semSearch: 'Search',
    createPlan: 'Plan',
    updateTodos: 'Todos',
    readLints: 'Lint',
    task: 'Task',
  };
  return map[type] || type;
}

interface AgentState {
  agent: SDKAgent;
  turnCount: number;
}

export function toCursorSdkMcpServers(servers: Record<string, MCPServerConfig>): Record<string, McpServerConfig> {
  const cursorServers: Record<string, McpServerConfig> = {};

  for (const [name, config] of Object.entries(servers)) {
    if (config.command) {
      cursorServers[name] = {
        type: 'stdio',
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
      };
      continue;
    }

    if (config.url) {
      cursorServers[name] = {
        type: config.type === 'sse' ? 'sse' : 'http',
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
      };
    }
  }

  return cursorServers;
}

class CursorService {
  private activeAgents: Map<string, AgentState> = new Map();

  private getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    return (settings.cursorApiKey as string) || undefined;
  }

  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    model: string,
  ): AsyncGenerator<CursorStreamEvent> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      yield { type: 'error', error: 'Cursor API key not configured. Add it in Settings > API Keys.' };
      return;
    }

    const syncResult = await mcpService.syncLocalHarnessConfigs();
    if (Object.keys(syncResult.errors).length > 0) {
      yield { type: 'error', error: `Failed to sync local MCP config: ${JSON.stringify(syncResult.errors)}` };
      return;
    }

    const modelId = model.replace('cursor:', '');
    const cursorMcpServers = toCursorSdkMcpServers(mcpService.getHarnessMcpServersConfig());

    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Ls', 'Search'],
        model: modelId || 'cursor',
      },
    };

    const eventQueue: CursorStreamEvent[] = [];
    let finished = false;
    let runError: Error | null = null;
    let emittedAssistantText = '';
    let sawToolActivity = false;

    let wakeup: (() => void) | null = null;
    const notifyWakeup = (): void => {
      if (wakeup) {
        const w = wakeup;
        wakeup = null;
        w();
      }
    };

    const pushEvent = (evt: CursorStreamEvent): void => {
      if (evt.type === 'text_delta' && evt.content) {
        emittedAssistantText += evt.content;
      }
      if (evt.type === 'tool_use' || evt.type === 'tool_result') {
        sawToolActivity = true;
      }
      eventQueue.push(evt);
      notifyWakeup();
    };

    try {
      let state = this.activeAgents.get(sessionId);

      if (!state) {
        console.log(`[Cursor Service] Creating agent for session ${sessionId.substring(0, 8)}`);
        const agent = await Agent.create({
          model: { id: modelId },
          apiKey,
          local: { cwd: workDir },
          mcpServers: cursorMcpServers,
        });
        state = { agent, turnCount: 0 };
        this.activeAgents.set(sessionId, state);
      }

      state.turnCount++;
      const isFollowUp = state.turnCount > 1;
      if (isFollowUp) {
        console.log(`[Cursor Service] Follow-up turn ${state.turnCount}, using local.force to expire previous run`);
      }

      // On follow-up turns, force-expire the previous persisted run.
      // Without this, agent.send() hangs because the SDK considers
      // the prior run still active internally.
      const run: Run = await state.agent.send(message, {
        mcpServers: cursorMcpServers,
        onDelta: ({ update }: { update: InteractionUpdate }) => {
          try {
            this.translateDelta(update, pushEvent);
          } catch (err) {
            console.error('[Cursor Service] Error translating delta:', err);
          }
        },
        ...(isFollowUp ? { local: { force: true } } : {}),
      });

      run.wait()
        .then((result) => {
          const finalText = typeof result.result === 'string' ? result.result : '';
          let message: ChatMessage | undefined;
          if (finalText.trim()) {
            message = {
              id: `cursor-sdk-result-${Date.now()}`,
              role: 'assistant',
              content: finalText,
              timestamp: new Date(),
              harness: 'cursor',
            };
          } else if (!emittedAssistantText.trim() && sawToolActivity) {
            const completion = 'Cursor completed tool work but did not return a final text response.';
            pushEvent({ type: 'text_delta', content: completion });
            message = {
              id: `cursor-sdk-tool-only-${Date.now()}`,
              role: 'assistant',
              content: completion,
              timestamp: new Date(),
              harness: 'cursor',
            };
          }
          pushEvent({ type: 'message_complete', message });
          finished = true;
          notifyWakeup();
        })
        .catch((err: Error) => {
          runError = err;
          finished = true;
          notifyWakeup();
        });

      while (true) {
        while (eventQueue.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          yield eventQueue.shift()!;
        }

        if (finished) break;

        await new Promise<void>((resolve) => {
          wakeup = resolve;
        });
      }

      while (eventQueue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        yield eventQueue.shift()!;
      }

      if (runError) {
        yield { type: 'error', error: (runError as Error).message || 'Cursor run failed' };
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[Cursor Service] Error:', msg);
      yield { type: 'error', error: msg || 'Cursor agent error' };
    }
  }

  private translateDelta(
    update: InteractionUpdate,
    push: (evt: CursorStreamEvent) => void,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = update as any;

    switch (u.type) {
      case 'text-delta':
        if (u.text) push({ type: 'text_delta', content: u.text });
        break;

      case 'thinking-delta':
        if (u.text) push({ type: 'thinking_delta', content: u.text });
        break;

      case 'thinking-completed':
        break;

      case 'tool-call-started': {
        const tc = u.toolCall || {};
        const name = toolTypeName(tc.type || 'unknown');
        const args = tc.args || {};
        push({
          type: 'tool_use',
          toolCall: {
            id: u.callId || `cursor-tc-${Date.now()}`,
            name,
            input: typeof args === 'object' ? (args as Record<string, unknown>) : { raw: args },
            status: 'running',
          },
        });
        break;
      }

      case 'tool-call-completed': {
        const tc = u.toolCall || {};
        const name = toolTypeName(tc.type || 'unknown');
        const args = tc.args || {};
        const result = tc.result;
        push({
          type: 'tool_result',
          toolCall: {
            id: u.callId || `cursor-tc-${Date.now()}`,
            name,
            input: typeof args === 'object' ? (args as Record<string, unknown>) : { raw: args },
            status: 'completed',
            result: result != null ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
          },
        });
        break;
      }

      case 'turn-ended':
      case 'partial-tool-call':
      case 'token-delta':
      case 'summary':
      case 'summary-started':
      case 'summary-completed':
      case 'shell-output-delta':
      case 'user-message-appended':
      case 'step-started':
      case 'step-completed':
        break;

      default:
        console.log(`[Cursor Service] Unhandled delta type: ${u.type}`);
    }
  }

  cancel(sessionId: string): void {
    const state = this.activeAgents.get(sessionId);
    if (state) {
      console.log(`[Cursor Service] Closing agent for session ${sessionId}`);
      state.agent.close();
      this.activeAgents.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [id, state] of this.activeAgents) {
      try {
        state.agent.close();
      } catch {
        // best-effort
      }
      this.activeAgents.delete(id);
    }
  }
}

// Singleton
let cursorServiceInstance: CursorService | null = null;
export function getCursorService(): CursorService {
  if (!cursorServiceInstance) {
    cursorServiceInstance = new CursorService();
  }
  return cursorServiceInstance;
}
