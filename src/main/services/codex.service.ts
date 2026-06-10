import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import type { Client, SFTPWrapper } from 'ssh2';
import { sshService } from './ssh.service';
import type { Attachment, ChatMessage, SSHConfig } from '../../shared/types';
import { terminateProcessTree } from '../utils/process-tree';
import { truncateMiddlePreservingTail } from '../../shared/utils/prompt-truncation';
import { mcpService } from './mcp.service';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import { findUsableLocalExecutable, isUsableLocalExecutable } from '../utils/local-executable';
import { prependPolicyPreamble, type HarnessPolicyTranslation, type CodexReasoningEffort } from './harness-policy.service';
import { buildProjectInstructionContext, formatProjectInstructionContextFiles } from './codex-context';

const STREAM_DEBUG = process.env.GREP_DEBUG_STREAMING === '1';

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
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
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
    const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryRels = [
      path.join('vendor', targetTriple, 'bin', binaryName),
      path.join('vendor', targetTriple, 'codex', binaryName),
    ];
    const candidateBases = [
      // Packaged app: Resources/node_modules/ (outside app.asar)
      path.join(process.resourcesPath, 'node_modules', platformPkg),
      // Dev: project root node_modules
      path.resolve(process.cwd(), 'node_modules', platformPkg),
      // Dev fallback: relative to __dirname (webpack output)
      path.resolve(__dirname, '..', '..', 'node_modules', platformPkg),
    ];
    const candidates = candidateBases.flatMap((base) => binaryRels.map((binaryRel) => path.join(base, binaryRel)));

    for (const candidate of candidates) {
      console.log(`[Codex Service] Checking binary path: ${candidate}`);
      if (isUsableLocalExecutable(candidate)) {
        console.log(`[Codex Service] Found binary at: ${candidate}`);
        return candidate;
      }
    }
  }

  const pathResult = findUsableLocalExecutable(['codex']);
  if (pathResult) {
    console.log(`[Codex Service] Found binary in PATH: ${pathResult}`);
    return pathResult;
  }

  console.error(`[Codex Service] Binary not found. __dirname=${__dirname}, resourcesPath=${process.resourcesPath}, cwd=${process.cwd()}`);
  throw new Error('Unable to locate a usable Codex CLI binary. Ensure @openai/codex is installed and not quarantined by macOS.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface CodexJsonEvent {
  type: string;
  thread_id?: string;
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
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
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
  modelReasoningEffort?: CodexReasoningEffort;
  policy?: HarnessPolicyTranslation;
}

interface CodexNativeThreadOptions {
  resumeThreadId?: string;
  persistThread?: boolean;
}

class CodexServiceImpl {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private codexBinaryPath: string | null = null;
  private codexThreadIds: Map<string, string> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionStore: any = new CachedStore({ name: getSessionStoreName() }) as any;
  private readonly CODEX_INSTRUCTION_CONTEXT_CHAR_LIMIT = 30000;

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

  getThreadId(sessionId: string): string | undefined {
    const cached = this.codexThreadIds.get(sessionId);
    if (cached) return cached;

    const stored = this.sessionStore.get(`harnessState.${sessionId}.codexThreadId`) as string | undefined;
    if (stored) {
      this.codexThreadIds.set(sessionId, stored);
      return stored;
    }

    return undefined;
  }

  clearThreadId(sessionId: string): void {
    this.codexThreadIds.delete(sessionId);
    this.sessionStore.delete(`harnessState.${sessionId}.codexThreadId`);
  }

  private rememberThreadId(sessionId: string, threadId: string): void {
    this.codexThreadIds.set(sessionId, threadId);
    this.sessionStore.set(`harnessState.${sessionId}.codexThreadId`, threadId);
    console.log(`[Codex Service] Remembered native Codex thread ${threadId} for session ${sessionId.substring(0, 8)}`);
  }

  private isBenignDiagnosticLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('WARNING: proceeding, even though we could not update PATH:')) {
      return true;
    }
    return false;
  }

  private buildCodexProcessErrorMessage(
    exitCode: number | null,
    stderrOutput: string,
    diagnosticLines: string[],
    label: string,
  ): string | undefined {
    const meaningfulDiagnostics = [
      ...stderrOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !this.isBenignDiagnosticLine(line)),
      ...diagnosticLines
        .map((line) => line.trim())
        .filter((line) => line && !this.isBenignDiagnosticLine(line)),
    ];

    const lastDiagnostic = meaningfulDiagnostics[meaningfulDiagnostics.length - 1];
    if (lastDiagnostic) {
      return lastDiagnostic;
    }

    if (exitCode && exitCode !== 0) {
      return `${label} exited before emitting JSON events (exit code ${exitCode}).`;
    }

    return undefined;
  }

  private async buildCodexInstructionContext(sessionId: string, workingDir: string, sshConfig?: SSHConfig): Promise<string> {
    const context = sshConfig
      ? formatProjectInstructionContextFiles(
          await sshService.scanRemoteHarnessContextFiles(sessionId, sshConfig, workingDir),
          {
            maxChars: this.CODEX_INSTRUCTION_CONTEXT_CHAR_LIMIT,
            maxFiles: 48,
          },
        )
      : buildProjectInstructionContext(workingDir, {
          maxChars: this.CODEX_INSTRUCTION_CONTEXT_CHAR_LIMIT,
          maxFiles: 48,
        });
    if (context) {
      console.log(`[Codex Service] Injecting shared harness instruction context for Codex (${context.length} chars)`);
    }
    return context;
  }

  private async prependCodexInstructionContext(sessionId: string, prompt: string, workingDir: string, sshConfig?: SSHConfig): Promise<string> {
    if (prompt.includes('<project_harness_context>')) return prompt;
    const instructionContext = await this.buildCodexInstructionContext(sessionId, workingDir, sshConfig);
    return instructionContext ? `${instructionContext}\n\n${prompt}` : prompt;
  }

  /**
   * Translate a JSON event from `codex exec --json` into our CodexStreamEvent.
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
        return {
          type: 'complete',
          usage: event.usage ? {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cacheReadTokens: event.usage.cached_input_tokens,
          } : undefined,
        };

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
  async runForTool(sessionId: string, prompt: string, workingDir: string, sshConfig?: SSHConfig, codexModel?: string): Promise<CodexToolResult> {
    const apiKey = this.getOpenAiApiKey();
    const promptWithInstructions = await this.prependCodexInstructionContext(sessionId, prompt, workingDir, sshConfig);

    const MAX_PROMPT_CHARS = 50000;
    const safePrompt = promptWithInstructions.length > MAX_PROMPT_CHARS
      ? truncateMiddlePreservingTail(promptWithInstructions, MAX_PROMPT_CHARS)
      : promptWithInstructions;

    let summary = '';
    let reasoning = '';
    const toolCalls: Array<{ type: string; detail: string }> = [];

    try {
      const events = sshConfig
        ? this.spawnCodexSSH(sessionId, safePrompt, workingDir, apiKey, sshConfig, codexModel)
        : this.spawnCodex(sessionId, safePrompt, workingDir, apiKey, codexModel);

      for await (const event of events) {
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
    apiKey: string | undefined,
    codexModel?: string,
    imagePaths: string[] = [],
    executionMode?: CodexExecutionMode,
    nativeThread?: CodexNativeThreadOptions,
  ): AsyncGenerator<CodexJsonEvent> {
    let binary: string;
    try {
      binary = this.getCodexBinary();
    } catch (err) {
      throw new Error(`Failed to initialize Codex: ${err instanceof Error ? err.message : String(err)}`);
    }

    const args = [
      'exec',
      '--json',
      '--cd', workingDir,
      '--skip-git-repo-check',
    ];
    this.appendExecutionModeArgs(args, executionMode);
    if (codexModel) {
      args.push('--model', codexModel);
    }
    if (nativeThread?.resumeThreadId) {
      console.log(`[Codex Service] Resuming native Codex thread ${nativeThread.resumeThreadId}`);
      args.push('resume', nativeThread.resumeThreadId);
    }
    for (const imagePath of imagePaths) {
      args.push('--image', imagePath);
    }

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (apiKey) {
      env.CODEX_API_KEY = apiKey;
      env.OPENAI_API_KEY = env.OPENAI_API_KEY || apiKey;
    }
    Object.assign(env, executionMode?.policy?.env || {});
    env.CODEX_SDK_ORIGINATOR = 'grep-build';

    this.cancel(sessionId);
    const abortController = new AbortController();
    const child = spawn(binary, args, {
      env,
      signal: abortController.signal,
      detached: process.platform !== 'win32',
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ABORT_ERR') {
        console.warn('[Codex Service] Process error:', error);
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

      child.once('close', (code) => {
        console.log(`[Codex Service] Process exited with code: ${code}`);
        settle(code);
      });

      if (child.exitCode !== null) {
        console.log(`[Codex Service] Process already exited with code: ${child.exitCode}`);
        settle(child.exitCode);
      }
    });

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
    const diagnosticLines: string[] = [];

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          eventCount++;
          console.log(`[Codex Service] Event ${eventCount}: ${event.type} ${event.item?.type || ''}`);
          yield event;
        } catch {
          diagnosticLines.push(line);
          console.warn('[Codex Service] Failed to parse JSON line:', line.substring(0, 200));
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
      console.log(`[Codex Service] Stream ended. Total events: ${eventCount}, stderr: ${stderrOutput.substring(0, 200)}`);
    }

    const exitCode = await exitPromise;
    if (eventCount === 0) {
      const diagnosticMessage = this.buildCodexProcessErrorMessage(exitCode, stderrOutput, diagnosticLines, 'Codex');
      if (diagnosticMessage) {
        throw new Error(diagnosticMessage);
      }
    }
  }

  /**
   * Spawn codex on a remote SSH server and yield JSON events.
   */
  private async *spawnCodexSSH(
    sessionId: string,
    prompt: string,
    workingDir: string,
    apiKey: string | undefined,
    sshConfig: SSHConfig,
    codexModel?: string,
    imagePaths: string[] = [],
    executionMode?: CodexExecutionMode,
    nativeThread?: CodexNativeThreadOptions,
  ): AsyncGenerator<CodexJsonEvent> {
    console.log(`[Codex Service] Spawning Codex via SSH on ${sshConfig.host}`);

    const codexArgs = ['exec', '--json', '--skip-git-repo-check'];
    this.appendExecutionModeArgs(codexArgs, executionMode);
    if (codexModel) {
      codexArgs.push('--model', codexModel);
    }
    if (nativeThread?.resumeThreadId) {
      console.log(`[Codex Service] Resuming native SSH Codex thread ${nativeThread.resumeThreadId}`);
      codexArgs.push('resume', nativeThread.resumeThreadId);
    }
    for (const imagePath of imagePaths) {
      codexArgs.push('--image', imagePath);
    }

    const process = sshService.createDetachedCommandProcess(sessionId, sshConfig, {
      command: 'codex',
      args: codexArgs,
      cwd: workingDir,
      env: {
        ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {}),
        ...(executionMode?.policy?.env || {}),
      },
      closeStdinOnEnd: true,
    });

    const rl = readline.createInterface({ input: process.stdout });
    let eventCount = 0;
    let processError: Error | null = null;
    const diagnosticLines: string[] = [];
    const exitPromise = new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      process.once('exit', (code) => {
        settle(code);
      });

      if (process.exitCode !== null) {
        settle(process.exitCode);
      }
    });

    process.on('error', (error: Error) => {
      console.warn('[Codex Service] Detached SSH Codex bridge error:', error.message);
      processError = error;
    });

    process.stdin.write(prompt);
    process.stdin.end();

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          eventCount++;
          if (STREAM_DEBUG) {
            console.log(`[Codex Service] SSH Event ${eventCount}: ${event.type} ${event.item?.type || ''}`);
          }
          yield event;
        } catch {
          // Non-JSON output from remote (e.g. shell messages) — skip
          diagnosticLines.push(line);
        }
      }
    } finally {
      rl.close();
      console.log(`[Codex Service] SSH stream ended. Total events: ${eventCount}`);
    }

    const exitCode = await exitPromise;
    if (processError && eventCount === 0) {
      throw processError;
    }
    if (eventCount === 0) {
      const diagnosticMessage = this.buildCodexProcessErrorMessage(exitCode, '', diagnosticLines, 'Remote Codex');
      if (diagnosticMessage) {
        throw new Error(diagnosticMessage);
      }
    }
  }

  /**
   * Stream Codex events for direct /codex invocation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *streamDirect(sessionId: string, prompt: string, workingDir: string, sshConfig?: any, codexModel?: string, attachments?: Attachment[], permissionMode?: string, policy?: HarnessPolicyTranslation, nativeThread?: CodexNativeThreadOptions): AsyncGenerator<CodexStreamEvent> {
    const apiKey = this.getOpenAiApiKey();

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

    const executionMode = this.getExecutionMode(permissionMode, policy);
    const promptWithInstructions = await this.prependCodexInstructionContext(sessionId, prompt, workingDir, sshConfig);
    const promptWithModeContext = this.buildPromptWithExecutionMode(promptWithInstructions, executionMode);
    const MAX_PROMPT_CHARS = 50000;
    let safePrompt = prompt;
    if (promptWithModeContext.length > MAX_PROMPT_CHARS) {
      console.warn(`[Codex Service] Prompt too long (${promptWithModeContext.length} chars), middle-truncating to ${MAX_PROMPT_CHARS} while preserving latest input`);
      safePrompt = truncateMiddlePreservingTail(promptWithModeContext, MAX_PROMPT_CHARS);
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
      ? this.spawnCodexSSH(sessionId, safePrompt, workingDir, apiKey, sshConfig, codexModel, preparedAssets.imagePaths, executionMode, nativeThread)
      : this.spawnCodex(sessionId, safePrompt, workingDir, apiKey, codexModel, preparedAssets.imagePaths, executionMode, nativeThread);

    try {
      // Codex --experimental-json emits multiple item.completed agent_message per turn
      // (no item.updated streaming). Collect text and emit as text_deltas with separators.
      let emittedMessageCount = 0;

      for await (const event of eventSource) {
        if (nativeThread?.persistThread && event.type === 'thread.started' && event.thread_id) {
          this.rememberThreadId(sessionId, event.thread_id);
        }

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
  async *streamAsChat(sessionId: string, prompt: string, workingDir: string, sshConfig?: any, conversationContext?: string, codexModel?: string, attachments?: Attachment[], permissionMode?: string, policy?: HarnessPolicyTranslation, nativeThread?: CodexNativeThreadOptions): AsyncGenerator<{
    type: string;
    content?: string;
    toolCall?: { id: string; name: string; input: Record<string, unknown>; status: string; result?: string };
    error?: string;
    systemInfo?: { tools: string[]; model: string };
    message?: ChatMessage;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  }> {
    yield {
      type: 'system',
      systemInfo: { tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'], model: codexModel || 'codex' },
    };

    const promptWithAttachmentContext = this.buildPromptWithAttachmentContext(prompt, attachments);
    // Prepend conversation context from prior Claude turns if available
    const fullPrompt = conversationContext ? `${conversationContext}\n\n${promptWithAttachmentContext}` : promptWithAttachmentContext;
    let outputContent = '';

    for await (const event of this.streamDirect(sessionId, fullPrompt, workingDir, sshConfig, codexModel, attachments, permissionMode, policy, nativeThread)) {
      switch (event.type) {
        case 'text_start':
          break;
        case 'text_delta':
          if (event.content) {
            outputContent += event.content;
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
          yield {
            type: 'message_complete',
            message: outputContent.trim() ? {
              id: `codex-result-${Date.now()}`,
              role: 'assistant',
              content: outputContent,
              timestamp: new Date(),
              harness: 'codex',
            } : undefined,
            usage: event.usage,
          };
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
        terminateProcessTree(active.process, 1000, true);
        active.abortController.abort();
        this.activeProcesses.delete(key);
      }
    }
  }

  private escapeShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "'\\''");
  }

  private getExecutionMode(permissionMode?: string, policy?: HarnessPolicyTranslation): CodexExecutionMode {
    const policyFields = {
      ...(policy?.codex?.modelReasoningEffort ? { modelReasoningEffort: policy.codex.modelReasoningEffort } : {}),
      ...(policy ? { policy } : {}),
    };
    switch (permissionMode) {
      case 'plan':
        return {
          ...policyFields,
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
          ...policyFields,
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
          useDangerouslyBypass: false,
        };
      case 'default':
        return {
          ...policyFields,
          approvalPolicy: 'on-request',
          sandboxMode: 'workspace-write',
          useDangerouslyBypass: false,
        };
      case 'dontAsk':
        return {
          ...policyFields,
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          useDangerouslyBypass: false,
        };
      case 'bypassPermissions':
      default:
        return {
          ...policyFields,
          useDangerouslyBypass: true,
        };
    }
  }

  private appendExecutionModeArgs(args: string[], executionMode?: CodexExecutionMode): void {
    if (executionMode?.useDangerouslyBypass) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', executionMode?.sandboxMode || 'workspace-write');
      args.push('--config', `approval_policy="${executionMode?.approvalPolicy || 'never'}"`);
    }

    if (executionMode?.modelReasoningEffort) {
      args.push('--config', `model_reasoning_effort="${executionMode.modelReasoningEffort}"`);
    }
  }

  private buildPromptWithExecutionMode(prompt: string, executionMode: CodexExecutionMode): string {
    const promptWithPermissionMode = executionMode.promptPreamble
      ? `${executionMode.promptPreamble}\n\n${prompt}`
      : prompt;
    return prependPolicyPreamble(promptWithPermissionMode, executionMode.policy?.promptPreamble);
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

  private normalizeBase64ImageData(data: string): string {
    const match = data.match(/^data:image\/[^;]+;base64,(.*)$/i);
    return match ? match[1] : data;
  }

  private getImageAttachmentsForCodex(attachments: Attachment[]): Array<{ name: string; content: string }> {
    const images: Array<{ name: string; content: string }> = [];
    for (const attachment of attachments) {
      if (attachment.type === 'image' && attachment.content) {
        images.push({
          name: attachment.name,
          content: this.normalizeBase64ImageData(attachment.content),
        });
        continue;
      }

      if (attachment.type === 'dom_element' && attachment.screenshot) {
        images.push({
          name: `${attachment.name || 'selected-element'}-screenshot.png`,
          content: this.normalizeBase64ImageData(attachment.screenshot),
        });
      }
    }

    return images;
  }

  private async prepareLocalImageFiles(sessionId: string, attachments: Attachment[]): Promise<PreparedCodexAssets> {
    const imageAttachments = this.getImageAttachmentsForCodex(attachments);
    if (imageAttachments.length === 0) {
      return { imagePaths: [], cleanup: async () => undefined };
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `claudette-codex-${sessionId}-`));
    const imagePaths: string[] = [];

    try {
      for (const [index, attachment] of imageAttachments.entries()) {
        const imagePath = path.join(tempDir, `image-${index}${this.getImageFileExtension(attachment.name)}`);
        await fs.promises.writeFile(imagePath, this.normalizeBase64ImageData(attachment.content), 'base64');
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
    if (this.getImageAttachmentsForCodex(attachments).length === 0) {
      return { imagePaths: [], cleanup: async () => undefined };
    }

    return sshConfig
      ? this.prepareRemoteImageFiles(sessionId, attachments, sshConfig)
      : this.prepareLocalImageFiles(sessionId, attachments);
  }
}

export const codexService = new CodexServiceImpl();
