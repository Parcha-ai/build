import { Agent } from '@cursor/sdk';
import type { InteractionUpdate, Run, SDKAgent } from '@cursor/sdk';
import Store from 'electron-store';

/**
 * Stream events emitted by CursorService, aligned with the app's StreamEvent shape
 * so claude.service.ts can forward them with minimal translation.
 */
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

/**
 * Translate a Cursor SDK tool-call type string (e.g. "shell", "edit", "write")
 * into a human-friendly name matching the conventions used by the renderer.
 */
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

class CursorService {
  private activeAgents: Map<string, SDKAgent> = new Map();

  private getApiKey(): string | undefined {
    return settingsStore.get('cursorApiKey') as string | undefined;
  }

  /**
   * Stream a single message through a Cursor agent.
   *
   * Uses `agent.send()` with an `onDelta` callback to capture real-time
   * InteractionUpdate events and translates them into CursorStreamEvents
   * that mirror the app's StreamEvent contract.
   */
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

    // Emit a system event so the renderer knows which tools/model are active
    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Ls', 'Search'],
        model: modelId || 'cursor',
      },
    };

    // Queue for events produced by the onDelta callback.
    // The callback pushes events; the generator loop shifts them out.
    const eventQueue: CursorStreamEvent[] = [];
    let finished = false;
    let runError: Error | null = null;

    // Resolve when a new event lands in the queue or the run finishes
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
      // Re-use or create the agent for this session
      let agent = this.activeAgents.get(sessionId);
      if (!agent) {
        agent = await Agent.create({
          model: { id: modelId },
          apiKey,
          local: { cwd: workDir },
        });
        this.activeAgents.set(sessionId, agent);
      }

      // Fire the message — the onDelta callback feeds our event queue
      const run: Run = await agent.send(message, {
        onDelta: ({ update }: { update: InteractionUpdate }) => {
          try {
            this.translateDelta(update, pushEvent);
          } catch (err) {
            console.error('[Cursor Service] Error translating delta:', err);
          }
        },
      });

      // Wait for the run to complete (or error out)
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

      // Drain the event queue as it fills
      while (true) {
        while (eventQueue.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          yield eventQueue.shift()!;
        }

        if (finished) break;

        // Park until a new event or completion
        await new Promise<void>((resolve) => {
          wakeup = resolve;
        });
      }

      // Drain any stragglers
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

  /**
   * Translate a single Cursor SDK InteractionUpdate into one or more CursorStreamEvents.
   *
   * The SDK uses hyphenated type discriminators:
   *   text-delta, thinking-delta, tool-call-started, tool-call-completed, turn-ended
   */
  private translateDelta(
    update: InteractionUpdate,
    push: (evt: CursorStreamEvent) => void,
  ): void {
    // The update is a discriminated union keyed on `type`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = update as any;

    switch (u.type) {
      case 'text-delta':
        if (u.text) {
          push({ type: 'text_delta', content: u.text });
        }
        break;

      case 'thinking-delta':
        if (u.text) {
          push({ type: 'thinking_delta', content: u.text });
        }
        break;

      case 'thinking-completed':
        // Nothing to push — the thinking block is complete
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
        // The run.wait() promise handles final completion
        break;

      case 'partial-tool-call':
        // Incremental updates to tool args — we skip these for now
        break;

      case 'token-delta':
      case 'summary':
      case 'summary-started':
      case 'summary-completed':
      case 'shell-output-delta':
      case 'user-message-appended':
      case 'step-started':
      case 'step-completed':
        // Informational events — not surfaced to the UI
        break;

      default:
        console.log(`[Cursor Service] Unhandled delta type: ${u.type}`);
    }
  }

  /**
   * Cancel an active Cursor session.
   */
  cancel(sessionId: string): void {
    const agent = this.activeAgents.get(sessionId);
    if (agent) {
      console.log(`[Cursor Service] Closing agent for session ${sessionId}`);
      agent.close();
      this.activeAgents.delete(sessionId);
    }
  }

  /**
   * Clean up all agents (called on app quit).
   */
  disposeAll(): void {
    for (const [id, agent] of this.activeAgents) {
      try {
        agent.close();
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
