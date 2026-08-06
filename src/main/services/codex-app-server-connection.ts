import * as readline from 'readline';
import type { Readable, Writable } from 'stream';

export interface CodexAppServerMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

/**
 * App-server multiplexes root and delegated-agent turns over one connection.
 * Item notifications expose the owning turn directly, while turn lifecycle
 * notifications carry it on the nested turn object.
 */
export function getCodexAppServerMessageTurnId(
  message: CodexAppServerMessage,
): string | undefined {
  const directTurnId = message.params?.turnId;
  if (typeof directTurnId === 'string') return directTurnId;

  const turn = message.params?.turn;
  if (turn && typeof turn === 'object') {
    const nestedTurnId = (turn as Record<string, unknown>).id;
    if (typeof nestedTurnId === 'string') return nestedTurnId;
  }

  return undefined;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Small JSONL/JSON-RPC client for `codex app-server` (whose default transport
 * is stdio across the supported local and remote Codex CLI versions).
 *
 * The app-server connection remains writable for the lifetime of a turn, which
 * is the important difference from `codex exec`: queued Build messages can be
 * acknowledged by `turn/steer` while the model is still working.
 */
export class CodexAppServerConnection {
  private readonly reader: readline.Interface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notifications: CodexAppServerMessage[] = [];
  private readonly notificationWaiters: Array<(message: CodexAppServerMessage | null) => void> = [];
  private readonly diagnostics: string[] = [];
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    this.reader = readline.createInterface({ input: output });
    this.reader.on('line', (line) => this.handleLine(line));
    this.reader.once('close', () => this.dispose(new Error('Codex app-server output closed')));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'grep-build',
        title: 'Build',
        version: '1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify('initialized');
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.input.writableEnded || this.input.destroyed) {
      return Promise.reject(new Error('Codex app-server is not writable'));
    }

    const id = this.nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write(params ? { method, params } : { method });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  nextNotification(): Promise<CodexAppServerMessage | null> {
    const queued = this.notifications.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.notificationWaiters.push(resolve));
  }

  endInput(): void {
    if (!this.input.writableEnded && !this.input.destroyed) {
      this.input.end();
    }
  }

  getDiagnostics(maxChars = 1_000): string {
    return this.diagnostics.join('\n').slice(-maxChars);
  }

  dispose(error = new Error('Codex app-server connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    while (this.notificationWaiters.length > 0) {
      this.notificationWaiters.shift()?.(null);
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || this.input.writableEnded || this.input.destroyed) return;
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: CodexAppServerMessage;
    try {
      message = JSON.parse(trimmed) as CodexAppServerMessage;
    } catch {
      this.diagnostics.push(trimmed.slice(0, 1_000));
      if (this.diagnostics.length > 10) this.diagnostics.shift();
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'Codex app-server request failed');
        (error as Error & { data?: unknown }).data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    const waiter = this.notificationWaiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.notifications.push(message);
    }
  }
}
