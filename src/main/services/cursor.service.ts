import { Agent } from '@cursor/sdk';
import type { InteractionUpdate, Run, SDKAgent } from '@cursor/sdk';
import Store from 'electron-store';

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

    const modelId = model.replace('cursor:', '');

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

    let wakeup: (() => void) | null = null;
    const notifyWakeup = (): void => {
      if (wakeup) {
        const w = wakeup;
        wakeup = null;
        w();
      }
    };

    const pushEvent = (evt: CursorStreamEvent): void => {
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
        .then(() => {
          pushEvent({ type: 'message_complete' });
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
