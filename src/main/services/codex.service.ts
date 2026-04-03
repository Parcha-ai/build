import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { sshService } from './ssh.service';
import type { Attachment, SSHConfig } from '../../shared/types';

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

interface PreparedCodexAssets {
  imagePaths: string[];
  cleanup: () => Promise<void>;
}

type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexExecutionMode {
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  useDangerouslyBypass: boolean;
  promptPreamble?: string;
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
        // agent_message and reasoning handled directly in streamDirect — skip here
        if (item.type === 'agent_message') return null;
        if (item.type === 'reasoning') return null;
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
    codexModel?: string,
    imagePaths: string[] = [],
    executionMode?: CodexExecutionMode,
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
      '--cd', workingDir,
      '--skip-git-repo-check',
    ];
    this.appendExecutionModeArgs(args, executionMode);
    if (codexModel) {
      args.push('--model', codexModel);
    }
    for (const imagePath of imagePaths) {
      args.push('--image', imagePath);
    }

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
   * Spawn codex on a remote SSH server and yield JSON events.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async *spawnCodexSSH(
    sessionId: string,
    prompt: string,
    workingDir: string,
    apiKey: string,
    sshConfig: any,
    codexModel?: string,
    imagePaths: string[] = [],
    executionMode?: CodexExecutionMode,
  ): AsyncGenerator<CodexJsonEvent> {
    console.log(`[Codex Service] Spawning Codex via SSH on ${sshConfig.host}`);

    const client = await sshService.getConnectionForCodex(sessionId, sshConfig);
    const escapedWorkingDir = this.escapeShellSingleQuoted(workingDir);
    const escapedApiKey = this.escapeShellSingleQuoted(apiKey);
    const codexArgs = ['codex', 'exec', '--experimental-json', '--skip-git-repo-check'];
    this.appendExecutionModeArgs(codexArgs, executionMode);
    if (codexModel) {
      codexArgs.push('--model', codexModel);
    }
    for (const imagePath of imagePaths) {
      codexArgs.push('--image', imagePath);
    }
    const escapedCodexCommand = codexArgs
      .map((arg) => `'${this.escapeShellSingleQuoted(arg)}'`)
      .join(' ');

    // Build the remote command — codex must be in PATH on the server
    const cmd = `export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH" && ` +
      `cd '${escapedWorkingDir}' && ` +
      `CODEX_API_KEY='${escapedApiKey}' ` +
      `${escapedCodexCommand} <<'CODEX_EOF'\n${prompt}\nCODEX_EOF`;

    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(cmd, (err, channel) => {
        if (err) reject(err);
        else resolve(channel);
      });
    });

    const rl = readline.createInterface({ input: channel });
    let eventCount = 0;

    channel.stderr.on('data', (data: Buffer) => {
      console.log('[Codex Service] SSH stderr:', data.toString().substring(0, 200));
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          eventCount++;
          console.log(`[Codex Service] SSH Event ${eventCount}: ${event.type} ${event.item?.type || ''}`);
          yield event;
        } catch {
          // Non-JSON output from remote (e.g. shell messages) — skip
        }
      }
    } finally {
      rl.close();
      console.log(`[Codex Service] SSH stream ended. Total events: ${eventCount}`);
    }
  }

  /**
   * Stream Codex events for direct /codex invocation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *streamDirect(sessionId: string, prompt: string, workingDir: string, sshConfig?: any, codexModel?: string, attachments?: Attachment[], permissionMode?: string): AsyncGenerator<CodexStreamEvent> {
    const apiKey = this.getOpenAiApiKey();
    if (!apiKey) {
      yield { type: 'error', error: 'No OpenAI API key configured. Please set your OpenAI API key in Settings.' };
      return;
    }

    const executionMode = this.getExecutionMode(permissionMode);
    const promptWithModeContext = this.buildPromptWithExecutionMode(prompt, executionMode);
    const MAX_PROMPT_CHARS = 50000;
    let safePrompt = prompt;
    if (promptWithModeContext.length > MAX_PROMPT_CHARS) {
      console.warn(`[Codex Service] Prompt too long (${promptWithModeContext.length} chars), truncating to ${MAX_PROMPT_CHARS}`);
      safePrompt = promptWithModeContext.substring(0, MAX_PROMPT_CHARS) + '\n\n[... truncated due to length]';
    } else {
      safePrompt = promptWithModeContext;
    }

    let preparedAssets: PreparedCodexAssets = {
      imagePaths: [],
      cleanup: async () => undefined,
    };
    try {
      preparedAssets = await this.prepareCodexAssets(sessionId, attachments || [], sshConfig);
    } catch (error) {
      yield {
        type: 'error',
        error: `Failed to prepare Codex attachments: ${error instanceof Error ? error.message : String(error)}`,
      };
      return;
    }

    // Choose local or SSH spawn
    const eventSource = sshConfig
      ? this.spawnCodexSSH(sessionId, safePrompt, workingDir, apiKey, sshConfig, codexModel, preparedAssets.imagePaths, executionMode)
      : this.spawnCodex(sessionId, safePrompt, workingDir, apiKey, codexModel, preparedAssets.imagePaths, executionMode);

    try {
      // Codex --experimental-json emits multiple item.completed agent_message per turn
      // (no item.updated streaming). Collect text and emit as text_deltas with separators.
      let emittedMessageCount = 0;

      for await (const event of eventSource) {
        // For agent_message items, emit as text_delta with newline separator between items
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          const prefix = emittedMessageCount > 0 ? '\n\n' : '';
          emittedMessageCount++;
          yield { type: 'text_delta', content: prefix + event.item.text };
          continue;
        }

        // For reasoning items, emit as thinking_delta
        if (event.type === 'item.completed' && event.item?.type === 'reasoning' && event.item.text) {
          yield { type: 'thinking_delta', content: event.item.text };
          continue;
        }

        // Skip item.updated for agent_message/reasoning (avoid duplicates if they appear)
        if (event.type === 'item.updated' && event.item?.type === 'agent_message') continue;
        if (event.type === 'item.updated' && event.item?.type === 'reasoning') continue;

        const translated = this.translateEvent(event);
        if (!translated) continue;

        // If translateEvent returns 'complete' (from turn.completed), yield it and stop
        if (translated.type === 'complete') {
          yield translated;
          return; // Don't yield a second complete after the loop
        }

        yield translated;
      }

      // Fallback complete if no turn.completed was received
      yield { type: 'complete' };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'complete' };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      await preparedAssets.cleanup().catch((error) => {
        console.warn('[Codex Service] Failed to clean up prepared assets:', error);
      });
    }
  }

  /**
   * Stream Codex as Claude-compatible StreamEvents so it works in the existing chat pipeline.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *streamAsChat(sessionId: string, prompt: string, workingDir: string, sshConfig?: any, conversationContext?: string, codexModel?: string, attachments?: Attachment[], permissionMode?: string): AsyncGenerator<{
    type: string;
    content?: string;
    toolCall?: { id: string; name: string; input: Record<string, unknown>; status: string; result?: string };
    error?: string;
    systemInfo?: { tools: string[]; model: string };
  }> {
    yield {
      type: 'system',
      systemInfo: { tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'], model: codexModel || 'codex' },
    };

    const promptWithAttachmentContext = this.buildPromptWithAttachmentContext(prompt, attachments);
    // Prepend conversation context from prior Claude turns if available
    const fullPrompt = conversationContext ? `${conversationContext}\n\n${promptWithAttachmentContext}` : promptWithAttachmentContext;

    for await (const event of this.streamDirect(sessionId, fullPrompt, workingDir, sshConfig, codexModel, attachments, permissionMode)) {
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
        // SIGTERM first, then SIGKILL after 1s if still alive
        active.process.kill('SIGTERM');
        const proc = active.process;
        setTimeout(() => {
          try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, 1000);
        this.activeProcesses.delete(key);
      }
    }
  }

  private escapeShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "'\\''");
  }

  private getExecutionMode(permissionMode?: string): CodexExecutionMode {
    switch (permissionMode) {
      case 'plan':
        return {
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          useDangerouslyBypass: false,
          promptPreamble: [
            'You are in PLAN mode.',
            'Do not modify files, apply patches, or run commands that require write access.',
            'Inspect the codebase as needed and return a concrete implementation plan only.',
          ].join(' '),
        };
      case 'acceptEdits':
        return {
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
          useDangerouslyBypass: false,
        };
      case 'default':
        return {
          approvalPolicy: 'on-request',
          sandboxMode: 'workspace-write',
          useDangerouslyBypass: false,
        };
      case 'dontAsk':
        return {
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          useDangerouslyBypass: false,
        };
      case 'bypassPermissions':
      default:
        return {
          useDangerouslyBypass: true,
        };
    }
  }

  private appendExecutionModeArgs(args: string[], executionMode?: CodexExecutionMode): void {
    if (executionMode?.useDangerouslyBypass) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      return;
    }

    args.push('--sandbox', executionMode?.sandboxMode || 'workspace-write');
    args.push('--config', `approval_policy="${executionMode?.approvalPolicy || 'never'}"`);
  }

  private buildPromptWithExecutionMode(prompt: string, executionMode: CodexExecutionMode): string {
    if (!executionMode.promptPreamble) {
      return prompt;
    }

    return `${executionMode.promptPreamble}\n\n${prompt}`;
  }

  private buildPromptWithAttachmentContext(prompt: string, attachments?: Attachment[]): string {
    const domElementAttachments = attachments?.filter((attachment) => attachment.type === 'dom_element') || [];
    if (domElementAttachments.length === 0) {
      return prompt;
    }

    const domContext = domElementAttachments
      .map((attachment, index) => `<selected-element index="${index + 1}" selector="${attachment.name}">\n${attachment.content}\n</selected-element>`)
      .join('\n\n');

    return `${domContext}\n\n${prompt}`;
  }

  private getImageFileExtension(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg':
      case '.png':
      case '.gif':
      case '.webp':
        return ext;
      default:
        return '.png';
    }
  }

  private async prepareLocalImageFiles(sessionId: string, attachments: Attachment[]): Promise<PreparedCodexAssets> {
    const imageAttachments = attachments.filter((attachment) => attachment.type === 'image');
    if (imageAttachments.length === 0) {
      return { imagePaths: [], cleanup: async () => undefined };
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `claudette-codex-${sessionId}-`));
    const imagePaths: string[] = [];

    try {
      for (const [index, attachment] of imageAttachments.entries()) {
        const imagePath = path.join(tempDir, `image-${index}${this.getImageFileExtension(attachment.name)}`);
        await fs.promises.writeFile(imagePath, attachment.content, 'base64');
        imagePaths.push(imagePath);
      }
    } catch (error) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return {
      imagePaths,
      cleanup: async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  private async getSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) reject(error);
        else resolve(sftp);
      });
    });
  }

  private async fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async execRemoteCommand(client: Client, command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';

        channel.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        channel.on('close', (code: number | null) => {
          if (code === 0 || code === null) {
            resolve(stdout);
          } else {
            reject(new Error(stderr.trim() || `Remote command failed with exit code ${code}`));
          }
        });
      });
    });
  }

  private async prepareRemoteImageFiles(sessionId: string, attachments: Attachment[], sshConfig: SSHConfig): Promise<PreparedCodexAssets> {
    const localAssets = await this.prepareLocalImageFiles(sessionId, attachments);
    if (localAssets.imagePaths.length === 0) {
      return localAssets;
    }

    const client = await sshService.getConnectionForCodex(sessionId, sshConfig);
    const remoteDir = `/tmp/claudette-codex-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const escapedRemoteDir = this.escapeShellSingleQuoted(remoteDir);
    await this.execRemoteCommand(client, `mkdir -p '${escapedRemoteDir}'`);

    const sftp = await this.getSftp(client);
    const remotePaths: string[] = [];

    try {
      for (const [index, localPath] of localAssets.imagePaths.entries()) {
        const remotePath = `${remoteDir}/image-${index}${path.extname(localPath) || '.png'}`;
        await this.fastPut(sftp, localPath, remotePath);
        remotePaths.push(remotePath);
      }
    } catch (error) {
      try {
        await this.execRemoteCommand(client, `rm -rf '${escapedRemoteDir}'`);
      } catch (cleanupError) {
        console.warn('[Codex Service] Failed to clean remote Codex temp dir after upload error:', cleanupError);
      }
      throw error;
    } finally {
      try {
        sftp.end();
      } catch {
        // ignore close errors
      }
      await localAssets.cleanup().catch(() => undefined);
    }

    return {
      imagePaths: remotePaths,
      cleanup: async () => {
        await this.execRemoteCommand(client, `rm -rf '${escapedRemoteDir}'`);
      },
    };
  }

  private async prepareCodexAssets(sessionId: string, attachments: Attachment[], sshConfig?: SSHConfig): Promise<PreparedCodexAssets> {
    if (!attachments.some((attachment) => attachment.type === 'image')) {
      return { imagePaths: [], cleanup: async () => undefined };
    }

    return sshConfig
      ? this.prepareRemoteImageFiles(sessionId, attachments, sshConfig)
      : this.prepareLocalImageFiles(sessionId, attachments);
  }
}

export const codexService = new CodexServiceImpl();
