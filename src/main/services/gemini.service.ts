import Store from 'electron-store';
import { spawn, execSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import { terminateProcessTree } from '../utils/process-tree';
import type { ChatMessage, SSHConfig } from '../../shared/types';
import { mcpService } from './mcp.service';
import { sshService } from './ssh.service';

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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    model?: string;
  };
  message?: ChatMessage;
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
  content?: unknown;
  text?: unknown;
  response?: unknown;
  message?: unknown;
  candidates?: unknown;
  delta?: boolean;
  name?: string;
  toolName?: string;
  tool_name?: string;
  id?: string;
  call_id?: string;
  tool_call_id?: string;
  tool_id?: string;
  parameters?: unknown;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  tool?: unknown;
  tool_call?: unknown;
  function_call?: unknown;
  functionCall?: unknown;
  status?: string;
  output?: unknown;
  result?: unknown;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNestedString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  let current: unknown = record;
  for (const key of keys) {
    current = asRecord(current)?.[key];
    if (current === undefined) return undefined;
  }
  return getString(current);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function extractGeminiToolName(event: GeminiJsonEvent): string {
  const record = event as unknown as Record<string, unknown>;
  return getString(event.tool_name)
    || getString(event.toolName)
    || getString(event.name)
    || getNestedString(record, ['tool', 'name'])
    || getNestedString(record, ['tool_call', 'name'])
    || getNestedString(record, ['function_call', 'name'])
    || getNestedString(record, ['functionCall', 'name'])
    || 'unknown';
}

function extractGeminiToolId(event: GeminiJsonEvent, prefix: string): string {
  return event.tool_id
    || event.tool_call_id
    || event.call_id
    || event.id
    || `${prefix}-${Date.now()}`;
}

function extractGeminiToolInput(event: GeminiJsonEvent): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  return parseRecord(event.parameters)
    || parseRecord(event.input)
    || parseRecord(event.args)
    || parseRecord(event.arguments)
    || parseRecord(asRecord(record.tool)?.parameters)
    || parseRecord(asRecord(record.tool)?.input)
    || parseRecord(asRecord(record.tool)?.args)
    || parseRecord(asRecord(record.tool_call)?.parameters)
    || parseRecord(asRecord(record.tool_call)?.input)
    || parseRecord(asRecord(record.tool_call)?.args)
    || parseRecord(asRecord(record.function_call)?.arguments)
    || parseRecord(asRecord(record.functionCall)?.args)
    || {};
}

function stringifyToolResult(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function collectTextParts(value: unknown, parts: string[], depth = 0): void {
  if (value === undefined || value === null || depth > 6) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextParts(item, parts, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const key of ['text', 'content', 'output', 'response']) {
    const nested = record[key];
    if (typeof nested === 'string') {
      parts.push(nested);
    } else if (nested !== value) {
      collectTextParts(nested, parts, depth + 1);
    }
  }

  for (const key of ['parts', 'message', 'candidate', 'candidates']) {
    collectTextParts(record[key], parts, depth + 1);
  }
}

function extractTextFromValue(value: unknown): string | undefined {
  const parts: string[] = [];
  collectTextParts(value, parts);
  const text = parts.join('');
  return text.trim() ? text : undefined;
}

function extractGeminiText(event: GeminiJsonEvent): string | undefined {
  return extractTextFromValue(event.content)
    || extractTextFromValue(event.text)
    || extractTextFromValue(event.response)
    || extractTextFromValue(event.message)
    || extractTextFromValue(event.candidates);
}

function escapeShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function quoteForRemoteShell(value: string): string {
  return `'${escapeShellSingleQuoted(value)}'`;
}

function remotePathForShell(value: string): string {
  return !value || value === '~' ? '$HOME' : quoteForRemoteShell(value);
}

function buildSshTarget(sshConfig: SSHConfig): string {
  return sshConfig.username ? `${sshConfig.username}@${sshConfig.host}` : sshConfig.host;
}

function buildSshArgs(sshConfig: SSHConfig, remoteCommand: string): string[] {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPersist=no',
    '-S', 'none',
  ];
  if (sshConfig.port) {
    args.push('-p', String(sshConfig.port));
  }
  if (sshConfig.privateKeyPath) {
    args.push('-i', sshConfig.privateKeyPath);
  }
  args.push(buildSshTarget(sshConfig), remoteCommand);
  return args;
}

function getRemotePathPrefix(): string {
  return [
    'export PATH="$HOME/.local/bin:$HOME/.gemini/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/bin:$PATH"',
    'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && export PATH="$d:$PATH"; done',
  ].join(' && ');
}

class GeminiService {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private geminiBinaryPath: string | null = null;
  private nodeBinaryPath: string | null = null;
  private lastAssistantTextBySession = new Map<string, string>();

  /**
   * Read the Gemini API key from the nested settings path
   * (same pattern as cursor.service.ts — NOT the top-level store key).
   */
  getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    // Key stored at top-level 'googleApiKey' by settings.service, fall back to nested path
    return (settings.geminiApiKey as string) || (settingsStore.get('googleApiKey') as string) || undefined;
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
  private translateEvent(sessionId: string, event: GeminiJsonEvent): GeminiStreamEvent | null {
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
        if (!event.role || event.role === 'assistant' || event.role === 'model') {
          const text = extractGeminiText(event);
          if (text) {
            if (event.delta) {
              const previous = this.lastAssistantTextBySession.get(sessionId) || '';
              this.lastAssistantTextBySession.set(sessionId, previous + text);
              return { type: 'text_delta', content: text };
            }

            const previous = this.lastAssistantTextBySession.get(sessionId) || '';
            const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
            this.lastAssistantTextBySession.set(sessionId, text);
            return delta ? { type: 'text_delta', content: delta } : null;
          }
        }
        return null;

      case 'tool_use':
        return {
          type: 'tool_use',
          toolCall: {
            id: extractGeminiToolId(event, 'gemini-tc'),
            name: extractGeminiToolName(event),
            input: extractGeminiToolInput(event),
            status: 'running',
          },
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          toolCall: {
            id: extractGeminiToolId(event, 'gemini-tr'),
            name: extractGeminiToolName(event),
            input: extractGeminiToolInput(event),
            status: event.status && event.status !== 'success' ? 'failed' : 'completed',
            result: stringifyToolResult(event.output ?? event.result),
          },
        };

      case 'error':
        return {
          type: 'error',
          error: getString(event.content) || 'Gemini reported an error',
        };

      case 'result': {
        const finalText = extractGeminiText(event) || this.lastAssistantTextBySession.get(sessionId) || '';
        return {
          type: 'message_complete',
          message: finalText.trim() ? {
            id: `gemini-result-${Date.now()}`,
            role: 'assistant',
            content: finalText,
            timestamp: new Date(),
            harness: 'gemini',
          } : undefined,
          usage: {
            inputTokens: event.stats?.input_tokens,
            outputTokens: event.stats?.output_tokens,
            totalTokens: event.stats?.total_tokens,
            model: event.model,
          },
        };
      }

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
    sshConfig?: SSHConfig,
  ): AsyncGenerator<GeminiStreamEvent> {
    // Check settings first, then fall back to system environment variables
    const apiKey = this.getApiKey() || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      yield { type: 'error', error: 'Gemini API key not configured. Add it in Settings > API Keys, or set GEMINI_API_KEY env var.' };
      return;
    }

    if (sshConfig) {
      const syncResult = await sshService.syncMcpConfigsToRemote(sessionId, sshConfig);
      if (!syncResult.success) {
        yield { type: 'error', error: `Failed to sync MCP config to remote: ${syncResult.error}` };
        return;
      }
    } else {
      const syncResult = await mcpService.syncLocalHarnessConfigs();
      if (Object.keys(syncResult.errors).length > 0) {
        yield { type: 'error', error: `Failed to sync local MCP config: ${JSON.stringify(syncResult.errors)}` };
        return;
      }
    }

    let geminiScript = '';
    let nodeBin = '';
    if (!sshConfig) {
      try {
        geminiScript = this.getBinary();
        nodeBin = this.getNode();
      } catch (err) {
        yield { type: 'error', error: `Failed to find Gemini CLI: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
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

    let child: ChildProcess;
    this.cancel(sessionId);
    const abortController = new AbortController();

    try {
      if (sshConfig) {
        const remoteDir = workDir || sshConfig.remoteWorkdir || '~';
        const remoteArgs = [
          '-p', "''",
          '--output-format', 'stream-json',
          '--sandbox',
          '--yolo',
          '--skip-trust',
        ];
        if (geminiModel) {
          remoteArgs.push('--model', quoteForRemoteShell(geminiModel));
        }
        const remoteCommand = [
          `cd ${remotePathForShell(remoteDir)}`,
          getRemotePathPrefix(),
          `export GEMINI_API_KEY=${quoteForRemoteShell(apiKey)}`,
          `export GOOGLE_API_KEY=${quoteForRemoteShell(apiKey)}`,
          'export GEMINI_CLI_TRUST_WORKSPACE=true',
          'gemini_bin="$(command -v gemini)" || { echo "Gemini CLI not found on remote. Install it with: npm install -g @google/gemini-cli" >&2; exit 127; }',
          `"$gemini_bin" ${remoteArgs.join(' ')}`,
        ].join(' && ');

        console.log(`[Gemini Service] SSH exec on ${sshConfig.host}: gemini -p <stdin:${message.length} chars> --model ${geminiModel}`);
        child = spawn('ssh', buildSshArgs(sshConfig, remoteCommand), {
          signal: abortController.signal,
          detached: process.platform !== 'win32',
        });
        child.stdin?.end(message);
      } else {
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
        child = spawn(nodeBin, args, {
          env,
          cwd: workDir,
          signal: abortController.signal,
          detached: process.platform !== 'win32',
        });
      }
    } catch (err) {
      yield { type: 'error', error: `Failed to start Gemini CLI: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ABORT_ERR') {
        console.warn('[Gemini Service] Process error:', error);
      }
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
          const translated = this.translateEvent(sessionId, event);
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
      this.lastAssistantTextBySession.delete(sessionId);
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
      terminateProcessTree(active.process, 1000, true);
      active.abortController.abort();
      this.activeProcesses.delete(sessionId);
    }
  }

  /**
   * Clean up all processes (called on app quit).
   */
  disposeAll(): void {
    for (const [id, active] of this.activeProcesses) {
      try {
        terminateProcessTree(active.process, 1000, true);
        active.abortController.abort();
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
