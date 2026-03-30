import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

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

/**
 * Find the codex CLI binary — checks node_modules platform packages first,
 * then falls back to PATH.
 */
function findCodexBinary(): string {
  // Platform binary from @openai/codex-<platform> package
  const platform = process.platform;
  const arch = process.arch;
  let targetTriple = '';
  if (platform === 'darwin' && arch === 'arm64') targetTriple = 'aarch64-apple-darwin';
  else if (platform === 'darwin' && arch === 'x64') targetTriple = 'x86_64-apple-darwin';
  else if (platform === 'linux' && arch === 'x64') targetTriple = 'x86_64-unknown-linux-gnu';
  else if (platform === 'linux' && arch === 'arm64') targetTriple = 'aarch64-unknown-linux-gnu';

  if (targetTriple) {
    const platformPkg = path.join('@openai', `codex-${platform}-${arch}`);
    const binaryRel = path.join('vendor', targetTriple, 'codex', platform === 'win32' ? 'codex.exe' : 'codex');
    const candidates = [
      // Packaged app: Resources/node_modules/ (outside app.asar)
      path.join(process.resourcesPath, 'node_modules', platformPkg, binaryRel),
      // Dev: project root node_modules
      path.resolve(process.cwd(), 'node_modules', platformPkg, binaryRel),
      // Dev fallback: relative to __dirname (webpack output)
      path.resolve(__dirname, '..', '..', 'node_modules', platformPkg, binaryRel),
    ];

    for (const candidate of candidates) {
      console.log(`[Codex Service] Checking binary path: ${candidate}`);
      if (fs.existsSync(candidate)) {
        console.log(`[Codex Service] Found binary at: ${candidate}`);
        return candidate;
      }
    }
  }

  // Fallback: check PATH
  const { execSync } = require('child_process');
  try {
    const result = execSync('which codex', { encoding: 'utf8' }).trim();
    if (result) {
      console.log(`[Codex Service] Found binary in PATH: ${result}`);
      return result;
    }
  } catch {
    // not in PATH
  }

  console.error(`[Codex Service] Binary not found. __dirname=${__dirname}, resourcesPath=${process.resourcesPath}, cwd=${process.cwd()}`);
  throw new Error('Unable to locate Codex CLI binary. Ensure @openai/codex is installed with optional dependencies.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface CodexJsonEvent {
  type: string;
  item?: {
    id: string;
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    status?: string;
    changes?: Array<{ kind: string; path: string }>;
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    error?: { message: string };
  };
  error?: { message: string };
  message?: string;
}

class CodexServiceImpl {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private codexBinaryPath: string | null = null;

  getOpenAiApiKey(): string | undefined {
    const userKey = settingsStore.get('openAiApiKey') as string | undefined;
    if (userKey) return userKey;
    return settingsStore.get('openaiApiKey') as string | undefined;
  }

  private getCodexBinary(): string {
    if (!this.codexBinaryPath) {
      this.codexBinaryPath = findCodexBinary();
    }
    return this.codexBinaryPath;
  }

  /**
   * Translate a JSON event from `codex exec --experimental-json` into our CodexStreamEvent.
   */
  private translateEvent(event: CodexJsonEvent): CodexStreamEvent | null {
    switch (event.type) {
      case 'item.started': {
        const item = event.item;
        if (!item) return null;
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
        if (!item) return null;
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
        if (!item) return null;
        if (item.type === 'agent_message') {
          // Only emit if we haven't seen this text via item.updated already
          // Track via _lastEmittedText on the event (set by streamDirect)
          return { type: 'text_delta', content: item.text };
        }
        if (item.type === 'reasoning') {
          return { type: 'thinking_delta', content: item.text };
        }
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

    const MAX_PROMPT_CHARS = 50000;
    const safePrompt = prompt.length > MAX_PROMPT_CHARS
      ? prompt.substring(0, MAX_PROMPT_CHARS) + '\n\n[... truncated due to length]'
      : prompt;

    let summary = '';
    let reasoning = '';
    const toolCalls: Array<{ type: string; detail: string }> = [];

    try {
      for await (const event of this.spawnCodex(sessionId, safePrompt, workingDir, apiKey)) {
        const item = event.item;
        if (!item) continue;

        if (event.type === 'item.completed') {
          switch (item.type) {
            case 'agent_message':
              summary += (item.text || '') + '\n';
              break;
            case 'reasoning':
              reasoning += (item.text || '') + '\n';
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
                detail: (item.changes || []).map((c: { kind: string; path: string }) => `${c.kind}: ${c.path}`).join('\n'),
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
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { summary: 'Codex run was cancelled.', toolCalls: [] };
      }
      return {
        summary: `Codex error: ${error instanceof Error ? error.message : String(error)}`,
        toolCalls: [],
      };
    }

    return {
      summary: summary.trim() || 'Codex completed without a text response.',
      toolCalls,
      reasoning: reasoning.trim() || undefined,
    };
  }

  /**
   * Spawn `codex exec --experimental-json` and yield parsed JSON events.
   */
  private async *spawnCodex(
    sessionId: string,
    prompt: string,
    workingDir: string,
    apiKey: string,
  ): AsyncGenerator<CodexJsonEvent> {
    let binary: string;
    try {
      binary = this.getCodexBinary();
    } catch (err) {
      throw new Error(`Failed to initialize Codex: ${err instanceof Error ? err.message : String(err)}`);
    }

    const args = [
      'exec',
      '--experimental-json',
      '--sandbox', 'workspace-write',
      '--cd', workingDir,
      '--skip-git-repo-check',
      '--config', 'approval_policy="never"',
    ];

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    env.CODEX_API_KEY = apiKey;
    env.CODEX_SDK_ORIGINATOR = 'grep-build';

    const abortController = new AbortController();
    const child = spawn(binary, args, { env, signal: abortController.signal });

    this.activeProcesses.set(sessionId, { process: child, abortController });

    // Write prompt to stdin then close it
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
      console.log(`[Codex Service] Prompt written to stdin (${prompt.length} chars)`);
    }

    // Capture stderr for diagnostics
    let stderrOutput = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        console.log('[Codex Service] stderr:', text.substring(0, 200));
      });
    }

    // Read JSON events line-by-line from stdout
    if (!child.stdout) {
      throw new Error('Codex process has no stdout');
    }

    const rl = readline.createInterface({ input: child.stdout });
    let eventCount = 0;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          eventCount++;
          console.log(`[Codex Service] Event ${eventCount}: ${event.type} ${event.item?.type || ''}`);
          yield event;
        } catch {
          console.warn('[Codex Service] Failed to parse JSON line:', line.substring(0, 200));
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
      console.log(`[Codex Service] Stream ended. Total events: ${eventCount}, stderr: ${stderrOutput.substring(0, 200)}`);
    }

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        console.log(`[Codex Service] Process exited with code: ${code}`);
        resolve();
      });
      // If already exited
      if (child.exitCode !== null) {
        console.log(`[Codex Service] Process already exited with code: ${child.exitCode}`);
        resolve();
      }
    });
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

    const MAX_PROMPT_CHARS = 50000;
    let safePrompt = prompt;
    if (prompt.length > MAX_PROMPT_CHARS) {
      console.warn(`[Codex Service] Prompt too long (${prompt.length} chars), truncating to ${MAX_PROMPT_CHARS}`);
      safePrompt = prompt.substring(0, MAX_PROMPT_CHARS) + '\n\n[... truncated due to length]';
    }

    try {
      // Track text already emitted via item.updated to avoid duplicating on item.completed
      let lastUpdatedText = '';

      for await (const event of this.spawnCodex(sessionId, safePrompt, workingDir, apiKey)) {
        // Track item.updated text for dedup
        if (event.type === 'item.updated' && event.item?.type === 'agent_message') {
          lastUpdatedText = event.item.text || '';
        }

        const translated = this.translateEvent(event);
        if (!translated) continue;

        // Skip item.completed text_delta if item.updated already sent the same text
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && lastUpdatedText) {
          lastUpdatedText = '';
          continue; // Already emitted via item.updated
        }

        yield translated;
      }

      yield { type: 'complete' };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'complete' };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  /**
   * Stream Codex as Claude-compatible StreamEvents so it works in the existing chat pipeline.
   */
  async *streamAsChat(sessionId: string, prompt: string, workingDir: string): AsyncGenerator<{
    type: string;
    content?: string;
    toolCall?: { id: string; name: string; input: Record<string, unknown>; status: string; result?: string };
    error?: string;
    systemInfo?: { tools: string[]; model: string };
  }> {
    yield {
      type: 'system',
      systemInfo: { tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'], model: 'codex' },
    };

    for await (const event of this.streamDirect(sessionId, prompt, workingDir)) {
      switch (event.type) {
        case 'text_start':
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
    for (const key of [sessionId, `tool:${sessionId}`]) {
      const active = this.activeProcesses.get(key);
      if (active) {
        console.log(`[Codex Service] Cancelling run for ${key}`);
        active.abortController.abort();
        active.process.kill('SIGTERM');
        this.activeProcesses.delete(key);
      }
    }
  }
}

export const codexService = new CodexServiceImpl();
