import Store from 'electron-store';
import { spawn, execSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Stream events emitted by GeminiService, aligned with the app's StreamEvent shape
 * so claude.service.ts can forward them with minimal translation.
 */
export interface GeminiStreamEvent {
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

/**
 * Raw JSONL event from `gemini --output-format stream-json`.
 *
 * Event types:
 *   init, message, tool_use, tool_result, error, result
 */
interface GeminiJsonEvent {
  type: string;
  timestamp?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

/**
 * Find the system `node` binary (NOT Electron's process.execPath).
 */
function findNodeBinary(): string {
  try {
    const result = execSync('which node', { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch { /* not in PATH */ }

  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    `${os.homedir()}/.nvm/versions/node/current/bin/node`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Unable to locate node binary');
}

/**
 * Find the `gemini` CLI script and resolve it to the real JS file.
 * Returns the resolved path so we can run it via `node <script>` directly,
 * avoiding shell: true (which corrupts arguments containing shell metacharacters).
 */
function findGeminiBinary(): string {
  let binPath: string | null = null;

  try {
    const result = execSync('which gemini', { encoding: 'utf8' }).trim();
    if (result) binPath = result;
  } catch { /* not in PATH */ }

  if (!binPath) {
    const homeDir = os.homedir();
    const candidates = [
      '/usr/local/bin/gemini',
      `${homeDir}/.local/bin/gemini`,
      `${homeDir}/.npm-global/bin/gemini`,
      '/opt/homebrew/bin/gemini',
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        binPath = candidate;
        break;
      }
    }
  }

  if (!binPath) {
    throw new Error(
      'Unable to locate Gemini CLI binary. Install it with: npm install -g @google/gemini-cli',
    );
  }

  // Resolve symlinks to get the real JS file path
  const realPath = fs.realpathSync(binPath);
  console.log(`[Gemini Service] Found binary: ${binPath} → ${realPath}`);
  return realPath;
}

class GeminiService {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private geminiBinaryPath: string | null = null;
  private nodeBinaryPath: string | null = null;

  /**
   * Read the Gemini API key from the nested settings path
   * (same pattern as cursor.service.ts — NOT the top-level store key).
   */
  getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    return (settings.geminiApiKey as string) || undefined;
  }

  private getBinary(): string {
    if (!this.geminiBinaryPath) {
      this.geminiBinaryPath = findGeminiBinary();
    }
    return this.geminiBinaryPath;
  }

  private getNode(): string {
    if (!this.nodeBinaryPath) {
      this.nodeBinaryPath = findNodeBinary();
    }
    return this.nodeBinaryPath;
  }

  /**
   * Translate a raw Gemini JSON event into our normalised GeminiStreamEvent.
   */
  private translateEvent(event: GeminiJsonEvent): GeminiStreamEvent | null {
    switch (event.type) {
      case 'init':
        return {
          type: 'system',
          systemInfo: {
            tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
            model: event.model || 'gemini',
          },
        };

      case 'message':
        // Only forward assistant deltas as text
        if (event.role === 'assistant' && event.delta && event.content) {
          return { type: 'text_delta', content: event.content };
        }
        return null;

      case 'tool_use':
        return {
          type: 'tool_use',
          toolCall: {
            id: event.tool_id || `gemini-tc-${Date.now()}`,
            name: event.tool_name || 'unknown',
            input: event.parameters || {},
            status: 'running',
          },
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          toolCall: {
            id: event.tool_id || `gemini-tr-${Date.now()}`,
            name: event.tool_name || 'unknown',
            input: {},
            status: event.status === 'success' ? 'completed' : 'failed',
            result: event.output,
          },
        };

      case 'error':
        return {
          type: 'error',
          error: event.content || 'Gemini reported an error',
        };

      case 'result':
        return { type: 'message_complete' };

      default:
        console.log(`[Gemini Service] Unhandled event type: ${event.type}`);
        return null;
    }
  }

  /**
   * Stream a single message through the Gemini CLI.
   *
   * Spawns `gemini -p "message" --output-format stream-json --sandbox`
   * in the given workDir and yields translated stream events.
   */
  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    model: string,
  ): AsyncGenerator<GeminiStreamEvent> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      yield { type: 'error', error: 'Gemini API key not configured. Add it in Settings > API Keys.' };
      return;
    }

    let geminiScript: string;
    let nodeBin: string;
    try {
      geminiScript = this.getBinary();
      nodeBin = this.getNode();
    } catch (err) {
      yield { type: 'error', error: `Failed to find Gemini CLI: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }

    const geminiModel = model.replace('gemini:', '');

    // Emit system event so the renderer knows which tools/model are active
    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
        model: geminiModel || 'gemini',
      },
    };

    // Run via `node <gemini-script>` directly — avoids shell: true which
    // corrupts arguments containing shell metacharacters ($, backticks, quotes).
    const args = [
      geminiScript,
      '-p', message,
      '--output-format', 'stream-json',
      '--sandbox',
      '--yolo',
      '--skip-trust',
    ];

    if (geminiModel) {
      args.push('--model', geminiModel);
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.GEMINI_API_KEY = apiKey;
    env.GOOGLE_API_KEY = apiKey;
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';

    console.log(`[Gemini Service] Spawning: ${nodeBin} ${geminiScript} -p <${message.length} chars> --model ${geminiModel}`);

    const abortController = new AbortController();
    const child = spawn(nodeBin, args, {
      env,
      cwd: workDir,
      signal: abortController.signal,
    });

    this.activeProcesses.set(sessionId, { process: child, abortController });

    const exitPromise = new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.once('close', (code) => settle(code));
      if (child.exitCode !== null) settle(child.exitCode);
    });

    // Capture stderr for diagnostics
    let stderrOutput = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        console.log('[Gemini Service] stderr:', text.substring(0, 200));
      });
    }

    if (!child.stdout) {
      this.activeProcesses.delete(sessionId);
      yield { type: 'error', error: 'Gemini process has no stdout' };
      return;
    }

    const rl = readline.createInterface({ input: child.stdout });
    let eventCount = 0;
    const diagnosticLines: string[] = [];

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as GeminiJsonEvent;
          eventCount++;
          console.log(`[Gemini Service] Event ${eventCount}: ${event.type}`);
          const translated = this.translateEvent(event);
          if (translated) {
            yield translated;
            // If the result event fired, we're done
            if (translated.type === 'message_complete') {
              return;
            }
          }
        } catch {
          diagnosticLines.push(line);
          console.warn('[Gemini Service] Failed to parse JSON line:', line.substring(0, 200));
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
      console.log(`[Gemini Service] Stream ended. Total events: ${eventCount}, stderr: ${stderrOutput.substring(0, 200)}`);
    }

    const exitCode = await exitPromise;

    // If we got no events at all, surface diagnostics
    if (eventCount === 0) {
      const meaningfulStderr = stderrOutput
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l)
        .pop();
      const meaningfulDiag = diagnosticLines
        .map((l) => l.trim())
        .filter((l) => l)
        .pop();
      const errMsg =
        meaningfulStderr ||
        meaningfulDiag ||
        (exitCode && exitCode !== 0
          ? `Gemini exited before emitting events (exit code ${exitCode}).`
          : undefined);

      if (errMsg) {
        yield { type: 'error', error: errMsg };
        return;
      }
    }

    // Fallback: ensure we always emit message_complete
    yield { type: 'message_complete' };
  }

  /**
   * Cancel an active Gemini run for a session.
   */
  cancel(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      console.log(`[Gemini Service] Cancelling run for ${sessionId}`);
      active.abortController.abort();
      active.process.kill('SIGTERM');
      const proc = active.process;
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 1000);
      this.activeProcesses.delete(sessionId);
    }
  }

  /**
   * Clean up all processes (called on app quit).
   */
  disposeAll(): void {
    for (const [id, active] of this.activeProcesses) {
      try {
        active.abortController.abort();
        active.process.kill('SIGTERM');
      } catch {
        // best-effort
      }
      this.activeProcesses.delete(id);
    }
  }
}

// Singleton
let geminiServiceInstance: GeminiService | null = null;
export function getGeminiService(): GeminiService {
  if (!geminiServiceInstance) {
    geminiServiceInstance = new GeminiService();
  }
  return geminiServiceInstance;
}
