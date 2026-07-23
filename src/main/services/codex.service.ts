import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import type { Client, SFTPWrapper } from 'ssh2';
import { sshService } from './ssh.service';
import type { SpawnedProcess } from './ssh.service';
import type { Attachment, ChatMessage, SSHConfig } from '../../shared/types';
import { terminateProcessTree } from '../utils/process-tree';
import { truncateMiddlePreservingTail } from '../../shared/utils/prompt-truncation';
import { mcpService } from './mcp.service';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import { findUsableLocalExecutable, isUsableLocalExecutable } from '../utils/local-executable';
import { prependPolicyPreamble, type HarnessPolicyTranslation, type CodexReasoningEffort } from './harness-policy.service';
import { buildProjectInstructionContext, formatProjectInstructionContextFiles } from './codex-context';
import { hasFileAttachments, prepareFileAttachmentsForHarness } from './attachment-file-assets';
import {
  ZAI_GLM_CONTEXT_WINDOW,
  ZAI_OPENAI_COMPAT_BASE_URL,
  isZaiGlmCodexModel,
} from '../../shared/config/zai-glm';
import { CodexAgentMessageBuffer } from './codex-agent-message-buffer';
import {
  CodexAppServerConnection,
  type CodexAppServerMessage,
} from './codex-app-server-connection';
import { filterRemoteCodexEnvironment } from '../utils/remote-codex-env';
import {
  codexFileChangeToolInput,
  normalizeCodexFileChanges,
  type CodexFileChange,
} from './codex-file-change';

const STREAM_DEBUG = process.env.GREP_DEBUG_STREAMING === '1';
// Codex prompts are streamed over stdin locally and through the detached SSH
// bridge, so this is a model-context safety budget rather than a process argv
// limit. Roughly 60-80K code-heavy tokens leaves headroom in a 128K context for
// Codex's own instructions, tool definitions, reasoning, and response.
const MAX_CODEX_INITIAL_PROMPT_CHARS = 240_000;
const ATTACHMENT_ONLY_PROMPT = 'Use the attached file(s) as input for the current task. Continue from the existing session context and the latest user request instead of asking me to restate the task.';

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
  // A provider-reported turn failure is authoritative: the remote process is
  // finished and must not be mistaken for a recoverable SSH transport drop.
  terminalFailure?: boolean;
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
    changes?: CodexFileChange[];
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
  filePromptBlock: string;
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
  developerInstructions?: string;
  markDeveloperInstructionsSeeded?: boolean;
}

interface ActiveCodexAppServer {
  connection: CodexAppServerConnection;
  process: ChildProcess | SpawnedProcess;
  abortController: AbortController;
  threadId: string;
  turnId: string;
  workingDir: string;
  sshConfig?: SSHConfig;
  assetCleanups: Array<() => Promise<void>>;
}

class CodexServiceImpl {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private activeAppServers: Map<string, ActiveCodexAppServer> = new Map();
  private codexBinaryPath: string | null = null;
  private codexThreadIds: Map<string, string> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionStore: any = new CachedStore({ name: getSessionStoreName() }) as any;
  private readonly CODEX_INSTRUCTION_CONTEXT_CHAR_LIMIT = 30000;
  private readonly CODEX_DEVELOPER_INSTRUCTIONS_VERSION = 1;

  getOpenAiApiKey(): string | undefined {
    const userKey = settingsStore.get('openAiApiKey') as string | undefined;
    if (userKey) return userKey;
    return settingsStore.get('openaiApiKey') as string | undefined;
  }

  private getSettingsObject(): Record<string, unknown> {
    return settingsStore.get('settings', {}) as Record<string, unknown>;
  }

  private getZaiApiKey(): string | undefined {
    const settings = this.getSettingsObject();
    const storedKey = typeof settings.zaiApiKey === 'string' ? settings.zaiApiKey.trim() : '';
    const topLevelKey = settingsStore.get('zaiApiKey') as string | undefined;
    return storedKey || topLevelKey?.trim() || process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || undefined;
  }

  private getApiKeyForCodexModel(codexModel?: string): string | undefined {
    if (isZaiGlmCodexModel(codexModel)) {
      return this.getZaiApiKey();
    }
    return this.getOpenAiApiKey();
  }

  private appendProviderConfigArgs(args: string[], codexModel?: string): void {
    if (!isZaiGlmCodexModel(codexModel)) return;

    args.push('--config', 'model_provider="zai"');
    args.push('--config', 'model_providers.zai.name="Z.AI GLM"');
    args.push('--config', `model_providers.zai.base_url="${ZAI_OPENAI_COMPAT_BASE_URL}"`);
    args.push('--config', 'model_providers.zai.env_key="ZAI_API_KEY"');
    args.push('--config', `model_context_window=${ZAI_GLM_CONTEXT_WINDOW}`);
  }

  private applyProviderEnv(env: Record<string, string>, apiKey: string | undefined, codexModel?: string): void {
    if (isZaiGlmCodexModel(codexModel)) {
      if (apiKey) {
        env.ZAI_API_KEY = apiKey;
      }
      return;
    }

    if (apiKey) {
      env.CODEX_API_KEY = apiKey;
      env.OPENAI_API_KEY = env.OPENAI_API_KEY || apiKey;
    }
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
    this.sessionStore.delete(`harnessState.${sessionId}.codexDeveloperInstructions`);
  }

  private rememberThreadId(sessionId: string, threadId: string): void {
    this.codexThreadIds.set(sessionId, threadId);
    this.sessionStore.set(`harnessState.${sessionId}.codexThreadId`, threadId);
    console.log(`[Codex Service] Remembered native Codex thread ${threadId} for session ${sessionId.substring(0, 8)}`);
  }

  private hasSeededDeveloperInstructions(sessionId: string, threadId: string): boolean {
    const seeded = this.sessionStore.get(`harnessState.${sessionId}.codexDeveloperInstructions`) as {
      threadId?: string;
      version?: number;
    } | undefined;
    return seeded?.threadId === threadId && seeded.version === this.CODEX_DEVELOPER_INSTRUCTIONS_VERSION;
  }

  private rememberDeveloperInstructions(sessionId: string, threadId: string): void {
    this.sessionStore.set(`harnessState.${sessionId}.codexDeveloperInstructions`, {
      threadId,
      version: this.CODEX_DEVELOPER_INSTRUCTIONS_VERSION,
    });
    console.log(`[Codex Service] Seeded native Codex developer instructions for thread ${threadId}`);
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
                name: 'Command',
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
                input: codexFileChangeToolInput(item.changes || []),
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
              name: 'Command',
              input: { command: item.command },
              status: item.status === 'completed' ? 'completed' : 'running',
              result: item.aggregated_output,
            },
          };
        }
        if (item.type === 'file_change') {
          return {
            type: 'tool_use',
            toolCall: {
              id: item.id,
              name: 'Edit',
              input: codexFileChangeToolInput(item.changes || []),
              status: item.status === 'completed' ? 'completed' : 'running',
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
              name: 'Command',
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
              input: codexFileChangeToolInput(item.changes || []),
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
        return {
          type: 'error',
          error: event.error?.message || 'Turn failed',
          terminalFailure: true,
        };

      case 'error':
        return { type: 'error', error: event.message || 'Unknown error' };

      default:
        return null;
    }
  }

  private toAppServerUserInput(text: string, imagePaths: string[] = []): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    if (text.trim()) {
      input.push({ type: 'text', text, text_elements: [] });
    }
    for (const imagePath of imagePaths) {
      input.push({ type: 'localImage', path: imagePath });
    }
    return input;
  }

  private toAppServerSandboxPolicy(executionMode?: CodexExecutionMode): Record<string, unknown> {
    if (executionMode?.useDangerouslyBypass || executionMode?.sandboxMode === 'danger-full-access') {
      return { type: 'dangerFullAccess' };
    }
    if (executionMode?.sandboxMode === 'read-only') {
      return { type: 'readOnly', networkAccess: false };
    }
    return {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private mapAppServerItem(rawItem: unknown): CodexJsonEvent['item'] | undefined {
    if (!rawItem || typeof rawItem !== 'object') return undefined;
    const item = rawItem as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : `codex-item-${Date.now()}`;
    const type = typeof item.type === 'string' ? item.type : '';

    switch (type) {
      case 'agentMessage':
        return { id, type: 'agent_message', text: typeof item.text === 'string' ? item.text : '' };
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string') : [];
        const content = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === 'string') : [];
        return { id, type: 'reasoning', text: [...summary, ...content].join('\n') };
      }
      case 'commandExecution':
        return {
          id,
          type: 'command_execution',
          command: typeof item.command === 'string' ? item.command : '',
          aggregated_output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined,
          status: item.status === 'completed' ? 'completed' : item.status === 'failed' || item.status === 'declined' ? 'failed' : 'in_progress',
        };
      case 'fileChange':
        return {
          id,
          type: 'file_change',
          changes: normalizeCodexFileChanges(item.changes),
          status: item.status === 'completed' ? 'completed' : item.status === 'failed' || item.status === 'declined' ? 'failed' : 'in_progress',
        };
      case 'mcpToolCall':
        return {
          id,
          type: 'mcp_tool_call',
          server: typeof item.server === 'string' ? item.server : 'unknown',
          tool: typeof item.tool === 'string' ? item.tool : 'unknown',
          arguments: item.arguments && typeof item.arguments === 'object'
            ? item.arguments as Record<string, unknown>
            : {},
          status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'in_progress',
          result: item.result,
          error: item.error && typeof item.error === 'object'
            ? { message: String((item.error as Record<string, unknown>).message || 'MCP tool failed') }
            : undefined,
        };
      default:
        return undefined;
    }
  }

  private mapAppServerNotification(
    message: CodexAppServerMessage,
    usage?: CodexJsonEvent['usage'],
  ): CodexJsonEvent | null {
    const params = message.params || {};
    switch (message.method) {
      case 'thread/started': {
        const thread = params.thread as Record<string, unknown> | undefined;
        return thread && typeof thread.id === 'string'
          ? { type: 'thread.started', thread_id: thread.id }
          : null;
      }
      case 'item/started':
      case 'item/completed': {
        const item = this.mapAppServerItem(params.item);
        if (!item) return null;
        return {
          type: message.method === 'item/started' ? 'item.started' : 'item.completed',
          item,
        };
      }
      case 'item/fileChange/patchUpdated': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        if (!itemId) return null;
        return {
          type: 'item.updated',
          item: {
            id: itemId,
            type: 'file_change',
            changes: normalizeCodexFileChanges(params.changes),
            status: 'in_progress',
          },
        };
      }
      case 'turn/completed': {
        const turn = params.turn as Record<string, unknown> | undefined;
        if (turn?.status === 'failed') {
          const error = turn.error as Record<string, unknown> | undefined;
          return { type: 'turn.failed', error: { message: String(error?.message || 'Codex turn failed') } };
        }
        return { type: 'turn.completed', usage };
      }
      case 'error': {
        if (params.willRetry === true) return null;
        const error = params.error as Record<string, unknown> | undefined;
        return { type: 'error', message: String(error?.message || 'Codex app-server error') };
      }
      default:
        return null;
    }
  }

  private handleAppServerRequest(connection: CodexAppServerConnection, message: CodexAppServerMessage): void {
    if (message.id === undefined || !message.method) return;

    switch (message.method) {
      case 'currentTime/read':
        connection.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        // App-server should not ask in Build's non-interactive Codex modes,
        // but declining is safer than hanging forever if a provider does.
        connection.respond(message.id, { decision: 'decline' });
        return;
      case 'item/tool/requestUserInput': {
        const questions = Array.isArray(message.params?.questions) ? message.params?.questions : [];
        const answers = Object.fromEntries(questions.flatMap((question) => {
          if (!question || typeof question !== 'object') return [];
          const id = (question as Record<string, unknown>).id;
          return typeof id === 'string' ? [[id, { answers: [] }]] : [];
        }));
        connection.respond(message.id, { answers });
        return;
      }
      case 'mcpServer/elicitation/request':
        connection.respond(message.id, { action: 'cancel', content: null, _meta: null });
        return;
      default:
        connection.respondError(message.id, `Build does not handle Codex app-server request ${message.method}`);
    }
  }

  /**
   * Run Codex for the MCP tool invocation (blocks until complete, returns structured result).
   */
  async runForTool(sessionId: string, prompt: string, workingDir: string, sshConfig?: SSHConfig, codexModel?: string): Promise<CodexToolResult> {
    const apiKey = this.getApiKeyForCodexModel(codexModel);
    if (isZaiGlmCodexModel(codexModel) && !apiKey) {
      throw new Error('Z.AI API key is required for GLM 5.2 via Codex. Set it in Settings -> Agents -> Z.AI API Key or export ZAI_API_KEY.');
    }
    const promptWithInstructions = await this.prependCodexInstructionContext(sessionId, prompt, workingDir, sshConfig);

    const safePrompt = promptWithInstructions.length > MAX_CODEX_INITIAL_PROMPT_CHARS
      ? truncateMiddlePreservingTail(promptWithInstructions, MAX_CODEX_INITIAL_PROMPT_CHARS)
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
   * Spawn a persistent Codex chat turn over the app-server protocol. Unlike
   * `codex exec`, this keeps stdin open and exposes `turn/steer` while the turn
   * is active.
   */
  private async *spawnCodexAppServer(
    sessionId: string,
    prompt: string,
    workingDir: string,
    apiKey: string | undefined,
    sshConfig?: SSHConfig,
    codexModel?: string,
    imagePaths: string[] = [],
    executionMode?: CodexExecutionMode,
    nativeThread?: CodexNativeThreadOptions,
  ): AsyncGenerator<CodexJsonEvent> {
    let binary = 'codex';
    if (!sshConfig) {
      try {
        binary = this.getCodexBinary();
      } catch (error) {
        throw new Error(`Failed to initialize Codex app-server: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // stdio:// is the app-server default across Codex CLI versions. --stdio
    // was added later and makes older-but-supported remote CLIs (for example
    // 0.124.0) exit immediately with "unexpected argument '--stdio'".
    const args = ['app-server'];
    this.appendProviderConfigArgs(args, codexModel);
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    this.applyProviderEnv(env, apiKey, codexModel);
    Object.assign(env, executionMode?.policy?.env || {});
    env.CODEX_SDK_ORIGINATOR = 'grep-build';
    const processEnv = sshConfig ? filterRemoteCodexEnvironment(env) : env;

    this.cancel(sessionId);
    const abortController = new AbortController();
    const child: ChildProcess | SpawnedProcess = sshConfig
      ? sshService.createDetachedCommandProcess(sessionId, sshConfig, {
          command: 'codex',
          args,
          cwd: workingDir,
          env: processEnv,
          signal: abortController.signal,
          closeStdinOnEnd: true,
          requireDetached: true,
        })
      : spawn(binary, args, {
          cwd: workingDir,
          env: processEnv,
          signal: abortController.signal,
          detached: process.platform !== 'win32',
        });

    child.once('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ABORT_ERR') {
        console.warn('[Codex App Server] Process error:', error.message);
      }
    });

    const stdout = child.stdout;
    const stdin = child.stdin;
    if (!stdout || !stdin) {
      throw new Error('Codex app-server process is missing stdio');
    }
    let stderrDiagnostic = '';
    if (!sshConfig && 'stderr' in child && child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const diagnostic = data.toString().trim();
        if (diagnostic) {
          stderrDiagnostic = `${stderrDiagnostic}\n${diagnostic}`.slice(-1_000);
          console.log('[Codex App Server] stderr:', diagnostic.substring(0, 300));
        }
      });
    }

    const connection = new CodexAppServerConnection(stdin, stdout);
    child.once('exit', (code, signal) => {
      const diagnostic = connection.getDiagnostics() || stderrDiagnostic.trim();
      const status = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : '';
      const detail = diagnostic ? `: ${diagnostic}` : '';
      connection.dispose(new Error(`Codex app-server process exited${status}${detail}`));
    });

    let activeState: ActiveCodexAppServer | undefined;
    let terminalEventSeen = false;
    let pendingAppServerError: string | undefined;
    try {
      await connection.initialize();

      const approvalPolicy = executionMode?.useDangerouslyBypass
        ? 'never'
        : executionMode?.approvalPolicy || 'never';
      const sandboxMode = executionMode?.useDangerouslyBypass
        ? 'danger-full-access'
        : executionMode?.sandboxMode || 'workspace-write';
      const threadParams: Record<string, unknown> = {
        model: codexModel || null,
        cwd: workingDir,
        approvalPolicy,
        sandbox: sandboxMode,
        ephemeral: nativeThread?.persistThread !== true,
        historyMode: 'legacy',
        threadSource: 'grep-build',
        ...(nativeThread?.developerInstructions
          ? { developerInstructions: nativeThread.developerInstructions }
          : {}),
      };

      let threadResponse: Record<string, unknown>;
      if (nativeThread?.resumeThreadId) {
        try {
          threadResponse = await connection.request('thread/resume', {
            threadId: nativeThread.resumeThreadId,
            model: codexModel || null,
            cwd: workingDir,
            approvalPolicy,
            ...(nativeThread.developerInstructions
              ? { developerInstructions: nativeThread.developerInstructions }
              : {}),
          });
          console.log(`[Codex App Server] Resumed thread ${nativeThread.resumeThreadId}`);
        } catch (error) {
          console.warn('[Codex App Server] Native thread resume failed; starting a fresh thread:', error);
          this.clearThreadId(sessionId);
          threadResponse = await connection.request('thread/start', threadParams);
        }
      } else {
        threadResponse = await connection.request('thread/start', threadParams);
      }

      const thread = threadResponse.thread as Record<string, unknown> | undefined;
      const threadId = typeof thread?.id === 'string' ? thread.id : nativeThread?.resumeThreadId;
      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id');
      }
      if (nativeThread?.persistThread) {
        this.rememberThreadId(sessionId, threadId);
      }
      if (nativeThread?.markDeveloperInstructionsSeeded) {
        this.rememberDeveloperInstructions(sessionId, threadId);
      }

      const turnResponse = await connection.request('turn/start', {
        threadId,
        input: this.toAppServerUserInput(prompt, imagePaths),
        cwd: workingDir,
        approvalPolicy,
        sandboxPolicy: this.toAppServerSandboxPolicy(executionMode),
        model: codexModel || null,
        effort: executionMode?.modelReasoningEffort || null,
      });
      const turn = turnResponse.turn as Record<string, unknown> | undefined;
      const turnId = typeof turn?.id === 'string' ? turn.id : undefined;
      if (!turnId) {
        throw new Error('Codex app-server did not return a turn id');
      }

      activeState = {
        connection,
        process: child,
        abortController,
        threadId,
        turnId,
        workingDir,
        sshConfig,
        assetCleanups: [],
      };
      this.activeAppServers.set(sessionId, activeState);
      console.log(`[Codex App Server] Turn ${turnId} is steerable for ${sessionId.substring(0, 8)}`);

      let usage: CodexJsonEvent['usage'];
      while (true) {
        const message = await connection.nextNotification();
        if (!message) break;

        if (message.id !== undefined && message.method) {
          this.handleAppServerRequest(connection, message);
          continue;
        }

        if (message.method === 'turn/started') {
          const startedTurn = message.params?.turn as Record<string, unknown> | undefined;
          if (typeof startedTurn?.id === 'string') {
            activeState.turnId = startedTurn.id;
          }
        } else if (message.method === 'thread/tokenUsage/updated') {
          const tokenUsage = message.params?.tokenUsage as Record<string, unknown> | undefined;
          const last = tokenUsage?.last as Record<string, unknown> | undefined;
          if (last) {
            usage = {
              input_tokens: Number(last.inputTokens || 0),
              cached_input_tokens: Number(last.cachedInputTokens || 0),
              output_tokens: Number(last.outputTokens || 0),
            };
          }
        }

        const event = this.mapAppServerNotification(message, usage);
        if (!event) continue;
        // App-server emits an `error` notification immediately before the
        // authoritative failed `turn/completed`. Do not end the consumer on
        // the preliminary notification: doing so closes the bridge before its
        // exit marker lands, and SSH recovery can misclassify the completed
        // provider failure as a disconnected live turn.
        if (event.type === 'error') {
          pendingAppServerError = event.message || 'Codex app-server error';
          console.warn('[Codex App Server] Received preliminary error notification; waiting for terminal turn status');
          continue;
        }
        yield event;
        if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          terminalEventSeen = true;
          break;
        }
      }

      if (!terminalEventSeen) {
        throw new Error(pendingAppServerError || 'Codex app-server ended before the active turn completed');
      }
    } finally {
      if (activeState && this.activeAppServers.get(sessionId) === activeState) {
        this.activeAppServers.delete(sessionId);
      }
      for (const cleanup of activeState?.assetCleanups || []) {
        await cleanup().catch((error) => console.warn('[Codex App Server] Failed to clean up steered assets:', error));
      }
      connection.endInput();
      connection.dispose();
    }
  }

  canSteer(sessionId: string): boolean {
    const active = this.activeAppServers.get(sessionId);
    return Boolean(active?.threadId && active?.turnId);
  }

  async steer(sessionId: string, message: string, attachments?: Attachment[]): Promise<boolean> {
    const active = this.activeAppServers.get(sessionId);
    if (!active) {
      console.log(`[Codex App Server] Cannot steer ${sessionId}: no active app-server turn`);
      return false;
    }

    let preparedAssets: PreparedCodexAssets = {
      imagePaths: [],
      filePromptBlock: '',
      cleanup: async () => undefined,
    };
    try {
      preparedAssets = await this.prepareCodexAssets(
        sessionId,
        attachments || [],
        active.workingDir,
        active.sshConfig,
      );
      const promptWithAttachmentContext = this.buildPromptWithAttachmentContext(message, attachments);
      const steerText = preparedAssets.filePromptBlock
        ? `${preparedAssets.filePromptBlock}\n\n${promptWithAttachmentContext || ATTACHMENT_ONLY_PROMPT}`
        : promptWithAttachmentContext || (preparedAssets.imagePaths.length > 0 ? ATTACHMENT_ONLY_PROMPT : '');
      if (!steerText.trim() && preparedAssets.imagePaths.length === 0) {
        await preparedAssets.cleanup();
        return false;
      }

      const expectedTurnId = active.turnId;
      const response = await active.connection.request('turn/steer', {
        threadId: active.threadId,
        expectedTurnId,
        input: this.toAppServerUserInput(steerText, preparedAssets.imagePaths),
      }, 10_000);
      if (response.turnId !== expectedTurnId || this.activeAppServers.get(sessionId) !== active) {
        await preparedAssets.cleanup();
        console.warn(`[Codex App Server] Steer acknowledgement did not match active turn for ${sessionId}`);
        return false;
      }

      active.assetCleanups.push(preparedAssets.cleanup);
      console.log(`[Codex App Server] Steering acknowledged by turn ${expectedTurnId} for ${sessionId.substring(0, 8)}`);
      return true;
    } catch (error) {
      await preparedAssets.cleanup().catch(() => undefined);
      console.warn(`[Codex App Server] Steering failed for ${sessionId}:`, error);
      return false;
    }
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
    this.appendProviderConfigArgs(args, codexModel);
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
    this.applyProviderEnv(env, apiKey, codexModel);
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
    this.appendProviderConfigArgs(codexArgs, codexModel);
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

    const remoteEnv: Record<string, string> = {
      ...(executionMode?.policy?.env || {}),
    };
    this.applyProviderEnv(remoteEnv, apiKey, codexModel);

    const process = sshService.createDetachedCommandProcess(sessionId, sshConfig, {
      command: 'codex',
      args: codexArgs,
      cwd: workingDir,
      env: remoteEnv,
      closeStdinOnEnd: true,
      requireDetached: true,
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
    const apiKey = this.getApiKeyForCodexModel(codexModel);
    if (isZaiGlmCodexModel(codexModel) && !apiKey) {
      yield { type: 'error', error: 'Z.AI API key is required for GLM 5.2 via Codex. Set it in Settings -> Agents -> Z.AI API Key or export ZAI_API_KEY.' };
      return;
    }

    if (sshConfig) {
      if (nativeThread?.persistThread) {
        // ClaudeService already schedules this sync at turn start. Native Codex
        // threads must not wait behind optional MCP bridge startup before they
        // can resume; the existing remote config remains usable for this turn.
        void sshService.syncMcpConfigsToRemote(sessionId, sshConfig).then((syncResult) => {
          if (!syncResult.success) {
            console.warn('[Codex Service] Background remote MCP sync failed:', syncResult.error);
          }
        }).catch((error) => {
          console.warn('[Codex Service] Background remote MCP sync failed:', error);
        });
      } else {
        const syncResult = await sshService.syncMcpConfigsToRemote(sessionId, sshConfig);
        if (!syncResult.success) {
          yield { type: 'error', error: `Failed to sync MCP config to remote: ${syncResult.error}` };
          return;
        }
      }
    } else {
      const syncResult = await mcpService.syncLocalHarnessConfigs();
      if (Object.keys(syncResult.errors).length > 0) {
        yield { type: 'error', error: `Failed to sync local MCP config: ${JSON.stringify(syncResult.errors)}` };
        return;
      }
    }

    let preparedAssets: PreparedCodexAssets = {
      imagePaths: [],
      filePromptBlock: '',
      cleanup: async () => undefined,
    };
    try {
      preparedAssets = await this.prepareCodexAssets(sessionId, attachments || [], workingDir, sshConfig);
    } catch (error) {
      yield {
        type: 'error',
        error: `Failed to prepare Codex attachments: ${error instanceof Error ? error.message : String(error)}`,
      };
      return;
    }

    const executionMode = this.getExecutionMode(permissionMode, policy);
    const promptWithFiles = preparedAssets.filePromptBlock
      ? `${preparedAssets.filePromptBlock}\n\n${prompt || ATTACHMENT_ONLY_PROMPT}`
      : prompt;
    let preparedNativeThread = nativeThread;
    let promptWithInstructions = promptWithFiles;
    if (nativeThread?.persistThread) {
      const shouldSeedDeveloperInstructions = !nativeThread.resumeThreadId
        || !this.hasSeededDeveloperInstructions(sessionId, nativeThread.resumeThreadId);
      if (shouldSeedDeveloperInstructions) {
        const projectInstructions = await this.buildCodexInstructionContext(sessionId, workingDir, sshConfig);
        const developerInstructions = [
          nativeThread.developerInstructions,
          projectInstructions,
        ].filter((value): value is string => Boolean(value?.trim())).join('\n\n');
        preparedNativeThread = {
          ...nativeThread,
          developerInstructions,
          markDeveloperInstructionsSeeded: true,
        };
        console.log(
          `[Codex Service] Seeding native thread developer instructions (${developerInstructions.length} chars)`,
        );
      } else {
        // Stable project/harness instructions are persisted on the native
        // thread. Keep resumed turn input limited to turn-local context.
        preparedNativeThread = {
          ...nativeThread,
          developerInstructions: undefined,
          markDeveloperInstructionsSeeded: false,
        };
        console.log(`[Codex Service] Reusing native thread developer instructions for ${nativeThread.resumeThreadId}`);
      }
    } else {
      promptWithInstructions = await this.prependCodexInstructionContext(sessionId, promptWithFiles, workingDir, sshConfig);
    }
    const promptWithModeContext = this.buildPromptWithExecutionMode(promptWithInstructions, executionMode);
    let safePrompt = prompt;
    if (promptWithModeContext.length > MAX_CODEX_INITIAL_PROMPT_CHARS) {
      console.warn(`[Codex Service] Prompt too long (${promptWithModeContext.length} chars), middle-truncating to ${MAX_CODEX_INITIAL_PROMPT_CHARS} while preserving latest input`);
      safePrompt = truncateMiddlePreservingTail(promptWithModeContext, MAX_CODEX_INITIAL_PROMPT_CHARS);
    } else {
      safePrompt = promptWithModeContext;
    }

    // Persistent manual/Auto Build Codex threads use app-server so normal
    // queued messages can steer the active turn. One-off Codex tool calls keep
    // the simpler exec transport.
    const eventSource = preparedNativeThread?.persistThread
      ? this.spawnCodexAppServer(
          sessionId,
          safePrompt,
          workingDir,
          apiKey,
          sshConfig,
          codexModel,
          preparedAssets.imagePaths,
          executionMode,
          preparedNativeThread,
        )
      : sshConfig
        ? this.spawnCodexSSH(sessionId, safePrompt, workingDir, apiKey, sshConfig, codexModel, preparedAssets.imagePaths, executionMode, preparedNativeThread)
        : this.spawnCodex(sessionId, safePrompt, workingDir, apiKey, codexModel, preparedAssets.imagePaths, executionMode, preparedNativeThread);

    try {
      yield* this.translateCodexEventStream(eventSource, {
        sessionId,
        persistThread: preparedNativeThread?.persistThread,
      });
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
   * Translate raw Codex JSON events into CodexStreamEvents. Shared between the
   * live stream path (streamDirect) and detached-bridge replay
   * (replayDetachedAsChat) so both interpret Codex output identically.
   * Codex --json may emit multiple completed agent messages in one turn:
   * interim commentary followed by the final answer. Keep one message buffered
   * so earlier messages can be surfaced as progress while only the last message
   * becomes permanent assistant content.
   */
  private async *translateCodexEventStream(
    eventSource: AsyncIterable<CodexJsonEvent>,
    options: { sessionId?: string; persistThread?: boolean } = {},
  ): AsyncGenerator<CodexStreamEvent> {
    const agentMessages = new CodexAgentMessageBuffer();

    for await (const event of eventSource) {
      if (options.persistThread && options.sessionId && event.type === 'thread.started' && event.thread_id) {
        this.rememberThreadId(options.sessionId, event.thread_id);
      }

      // A later agent message proves the previous one was commentary/progress.
      // Hold the current message until turn.completed establishes it as final.
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        const progressMessage = agentMessages.accept(event.item.text);
        if (progressMessage) {
          yield { type: 'thinking_delta', content: progressMessage };
        }
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
        const finalMessage = agentMessages.finalize();
        if (finalMessage) {
          yield { type: 'text_delta', content: finalMessage };
        }
        yield translated;
        return; // Don't yield a second complete after the loop
      }

      if (translated.type === 'error') {
        const progressMessage = agentMessages.finalize();
        if (progressMessage) {
          yield { type: 'thinking_delta', content: progressMessage };
        }
        yield translated;
        return;
      }

      yield translated;
    }

    // Fallback complete if no turn.completed was received
    const finalMessage = agentMessages.finalize();
    if (finalMessage) {
      yield { type: 'text_delta', content: finalMessage };
    }
    yield { type: 'complete' };
  }

  /**
   * Replay a detached-bridge Codex job's stdout as chat events. Used by
   * resumeRemoteTurn when reattaching to a Codex turn that survived an app
   * close or disconnect: the bridge replays the JSONL log from the start and
   * tails live output until the job exits.
   */
  async *replayDetachedAsChat(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detachedProcess: any,
    codexModel?: string,
  ): AsyncGenerator<{
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

    const rl = readline.createInterface({ input: detachedProcess.stdout });
    const mapAppServerNotification = this.mapAppServerNotification.bind(this);
    async function* jsonEvents(): AsyncGenerator<CodexJsonEvent> {
      let appServerUsage: CodexJsonEvent['usage'];
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const jsonStart = trimmed.indexOf('{');
        if (jsonStart < 0) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(jsonStart)) as CodexJsonEvent & CodexAppServerMessage;
          if (!parsed.method) {
            if (parsed.type) yield parsed;
            continue;
          }

          // Persistent Codex chat turns use app-server JSON-RPC. Detached SSH
          // recovery replays the same stdout log, so adapt notifications back
          // into the established exec event shape before rendering them.
          if (parsed.method === 'thread/tokenUsage/updated') {
            const tokenUsage = parsed.params?.tokenUsage as Record<string, unknown> | undefined;
            const last = tokenUsage?.last as Record<string, unknown> | undefined;
            if (last) {
              appServerUsage = {
                input_tokens: Number(last.inputTokens || 0),
                cached_input_tokens: Number(last.cachedInputTokens || 0),
                output_tokens: Number(last.outputTokens || 0),
              };
            }
          }
          const event = mapAppServerNotification(parsed, appServerUsage);
          if (event) yield event;
        } catch {
          // Non-JSON bridge/diagnostic output — skip
        }
      }
    }

    let outputContent = '';
    try {
      for await (const event of this.translateCodexEventStream(jsonEvents())) {
        switch (event.type) {
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
                id: `codex-recovered-${Date.now()}`,
                role: 'assistant',
                content: outputContent,
                timestamp: new Date(),
                harness: 'codex',
              } : undefined,
              usage: event.usage,
            };
            return;
          case 'error':
            yield { type: 'error', error: event.error };
            break;
        }
      }
    } finally {
      rl.close();
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
    terminalFailure?: boolean;
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
          yield {
            type: 'error',
            error: event.error,
            terminalFailure: event.terminalFailure,
          };
          break;
      }
    }
  }

  /**
   * Cancel an active Codex run for a session.
   */
  cancel(sessionId: string): void {
    const activeAppServer = this.activeAppServers.get(sessionId);
    if (activeAppServer) {
      console.log(`[Codex App Server] Cancelling active turn for ${sessionId}`);
      this.activeAppServers.delete(sessionId);
      activeAppServer.connection.endInput();
      activeAppServer.connection.dispose(new Error('Codex turn cancelled'));
      activeAppServer.process.kill('SIGTERM');
      activeAppServer.abortController.abort();
    }

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
      return { imagePaths: [], filePromptBlock: '', cleanup: async () => undefined };
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
      filePromptBlock: '',
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
      filePromptBlock: '',
      cleanup: async () => {
        await this.execRemoteCommand(client, `rm -rf '${escapedRemoteDir}'`);
      },
    };
  }

  private async prepareCodexAssets(sessionId: string, attachments: Attachment[], workingDir: string, sshConfig?: SSHConfig): Promise<PreparedCodexAssets> {
    const imageAssets = this.getImageAttachmentsForCodex(attachments).length > 0
      ? (sshConfig
      ? this.prepareRemoteImageFiles(sessionId, attachments, sshConfig)
      : this.prepareLocalImageFiles(sessionId, attachments))
      : Promise.resolve({ imagePaths: [], filePromptBlock: '', cleanup: async () => undefined });
    const preparedImages = await imageAssets;
    const preparedFiles = hasFileAttachments(attachments)
      ? await prepareFileAttachmentsForHarness(sessionId, attachments, workingDir, sshConfig)
      : { promptBlock: '', cleanup: async () => undefined };

    if (preparedFiles.promptBlock) {
      console.log('[Codex Service] Prepared file attachments for Codex prompt');
    }

    return {
      imagePaths: preparedImages.imagePaths,
      filePromptBlock: preparedFiles.promptBlock,
      cleanup: async () => {
        await preparedImages.cleanup().catch(() => undefined);
        await preparedFiles.cleanup().catch(() => undefined);
      },
    };
  }
}

export const codexService = new CodexServiceImpl();
