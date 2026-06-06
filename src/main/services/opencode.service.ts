import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as readline from 'readline';
import type { ChatMessage, SSHConfig } from '../../shared/types';
import { isLocalModeEnabled, isLocalOllamaModel } from '../../shared/local-mode';
import { terminateProcessTree } from '../utils/process-tree';
import { mcpService } from './mcp.service';
import { sshService } from './ssh.service';
import { findUsableLocalExecutable } from '../utils/local-executable';
import { prependPolicyPreamble, type HarnessPolicyTranslation } from './harness-policy.service';

export interface OpenCodeStreamEvent {
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
  message?: ChatMessage;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

interface OpenCodeCommand {
  command: string;
  prefixArgs: string[];
  label: string;
}

function findOpenCodeCommand(): OpenCodeCommand {
  const home = os.homedir();
  const pathBinary = findUsableLocalExecutable(['opencode'], [
    `${home}/.local/bin/opencode`,
    `${home}/.bun/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ]);
  if (pathBinary) {
    return { command: pathBinary, prefixArgs: [], label: 'opencode' };
  }

  const npxBinary = findUsableLocalExecutable(['npx'], [
    '/opt/homebrew/bin/npx',
    '/usr/local/bin/npx',
  ]);
  if (npxBinary) {
    return { command: npxBinary, prefixArgs: ['-y', 'opencode-ai'], label: 'npx opencode-ai' };
  }

  throw new Error('Unable to locate OpenCode CLI runner. Install OpenCode with npm install -g opencode-ai, or install Node/npm so Build can run npx opencode-ai.');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNestedString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  let current: unknown = record;
  for (const key of keys) {
    const next = asRecord(current)?.[key];
    if (next === undefined) return undefined;
    current = next;
  }
  return getString(current);
}

function buildPermissionConfig(permissionMode?: string): string {
  if (permissionMode === 'plan' || permissionMode === 'dontAsk') {
    return JSON.stringify({
      '*': 'allow',
      edit: 'deny',
      external_directory: 'deny',
      question: 'deny',
    });
  }

  return JSON.stringify({
    '*': 'allow',
    question: 'deny',
  });
}

function resolveOpenCodeModel(model: string): string {
  const modelId = model.replace('opencode:', '');
  if (modelId.includes('/')) return modelId;
  return `deepseek/${modelId}`;
}

function extractTextFromEvent(event: Record<string, unknown>): string | undefined {
  const direct = getString(event.content) || getString(event.text) || getString(event.delta);
  if (direct) return direct;

  const part = asRecord(event.part);
  if (part) {
    const partText = getString(part.text) || getString(part.content);
    if (partText) return partText;
  }

  const message = asRecord(event.message);
  if (message) {
    if (message.role && message.role !== 'assistant') return undefined;
    const messageContent = getString(message.content) || getString(message.text);
    if (messageContent) return messageContent;
  }

  return getNestedString(event, ['data', 'content'])
    || getNestedString(event, ['data', 'text'])
    || getNestedString(event, ['data', 'message', 'content']);
}

function extractToolName(event: Record<string, unknown>): string | undefined {
  return getString(event.tool)
    || getString(event.tool_name)
    || getString(event.name)
    || getNestedString(event, ['part', 'tool'])
    || getNestedString(event, ['part', 'name']);
}

function extractToolInput(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.input)
    || asRecord(event.parameters)
    || asRecord(event.args)
    || asRecord(asRecord(event.part)?.input)
    || {};
}

function extractToolResult(event: Record<string, unknown>): string | undefined {
  const result = event.result || event.output || asRecord(event.part)?.result;
  if (typeof result === 'string') return result;
  if (result !== undefined) return JSON.stringify(result);
  return undefined;
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

function getRemotePathPrefix(): string {
  return [
    'export PATH="$HOME/.local/bin:$HOME/.cursor/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"',
    'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
    'export PATH',
  ].join(' && ');
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

class OpenCodeService {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private openCodeCommand: OpenCodeCommand | null = null;
  private lastAssistantTextBySession = new Map<string, string>();

  getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    return (settings.deepseekApiKey as string) || process.env.DEEPSEEK_API_KEY || undefined;
  }

  private getSettings(): Record<string, unknown> {
    return settingsStore.get('settings', {}) as Record<string, unknown>;
  }

  private getCommand(): OpenCodeCommand {
    if (!this.openCodeCommand) {
      this.openCodeCommand = findOpenCodeCommand();
    }
    return this.openCodeCommand;
  }

  private getOfflineSafeCommand(): OpenCodeCommand {
    const command = findOpenCodeCommand();
    if (command.prefixArgs.length > 0) {
      throw new Error('Local Mode requires an installed OpenCode CLI binary. The npx fallback can reach the network when opencode-ai is not cached, so install OpenCode with: brew install anomalyco/tap/opencode');
    }
    this.openCodeCommand = command;
    return command;
  }

  private translateJsonEvent(sessionId: string, event: Record<string, unknown>): OpenCodeStreamEvent | null {
    const eventType = getString(event.type) || getString(event.event) || '';
    const lowerType = eventType.toLowerCase();

    if (lowerType.includes('error')) {
      return { type: 'error', error: extractTextFromEvent(event) || getString(event.error) || 'OpenCode reported an error' };
    }

    if (lowerType.includes('tool')) {
      const toolName = extractToolName(event);
      if (!toolName) return null;
      const toolId = getString(event.tool_id) || getString(event.toolCallID) || getString(event.id) || `opencode-tool-${Date.now()}`;
      const isResult = lowerType.includes('result') || lowerType.includes('finish') || lowerType.includes('complete');
      return {
        type: isResult ? 'tool_result' : 'tool_use',
        toolCall: {
          id: toolId,
          name: toolName,
          input: extractToolInput(event),
          status: isResult ? 'completed' : 'running',
          result: isResult ? extractToolResult(event) : undefined,
        },
      };
    }

    const text = extractTextFromEvent(event);
    if (!text) return null;

    const lastText = this.lastAssistantTextBySession.get(sessionId) || '';
    const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
    this.lastAssistantTextBySession.set(sessionId, text);
    return delta ? { type: 'text_delta', content: delta } : null;
  }

  private buildLocalSpawn(openCodeCommand: OpenCodeCommand, message: string, workDir: string, opencodeModel: string, abortController: AbortController, permissionMode?: string, policy?: HarnessPolicyTranslation) {
    const settings = this.getSettings();
    const effectiveMessage = prependPolicyPreamble(message, policy?.promptPreamble);
    const args = [
      ...openCodeCommand.prefixArgs,
      'run',
      effectiveMessage,
      '--model', opencodeModel,
      '--format', 'json',
      '--dir', workDir,
    ];

    if (permissionMode !== 'plan' && permissionMode !== 'dontAsk') {
      args.push('--dangerously-skip-permissions');
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const apiKey = this.getApiKey();
    if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
    Object.assign(env, policy?.env || {});
    env.OPENCODE_PERMISSION = buildPermissionConfig(permissionMode);
    env.OPENCODE_CLIENT = 'build-autobuild';
    env.OPENCODE_CONFIG = mcpService.getOpenCodeConfigPath();
    env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    env.OPENCODE_DISABLE_TERMINAL_TITLE = 'true';
    env.OPENCODE_ENABLE_EXPERIMENTAL_MODELS = 'true';
    if (settings.localModeDisableLspDownload === true) {
      env.OPENCODE_DISABLE_LSP_DOWNLOAD = 'true';
    }

    console.log(`[OpenCode Service] Local spawn via ${openCodeCommand.label}: ${openCodeCommand.command} ${args.slice(0, openCodeCommand.prefixArgs.length + 1).join(' ')} <${effectiveMessage.length} chars>`);

    return spawn(openCodeCommand.command, args, {
      cwd: workDir,
      env,
      signal: abortController.signal,
      detached: process.platform !== 'win32',
    });
  }

  private buildSshSpawn(message: string, remoteDir: string, opencodeModel: string, sshConfig: SSHConfig, permissionMode?: string, policy?: HarnessPolicyTranslation) {
    const settings = this.getSettings();
    const apiKey = this.getApiKey() || '';
    const effectiveMessage = prependPolicyPreamble(message, policy?.promptPreamble);
    const permissionConfig = buildPermissionConfig(permissionMode);
    const skipFlag = permissionMode !== 'plan' && permissionMode !== 'dontAsk'
      ? ' --dangerously-skip-permissions'
      : '';
    const command = [
      `cd ${remotePathForShell(remoteDir)}`,
      getRemotePathPrefix(),
      apiKey ? `export DEEPSEEK_API_KEY=${quoteForRemoteShell(apiKey)}` : '',
      ...Object.entries(policy?.env || {}).map(([key, value]) => `export ${key}=${quoteForRemoteShell(value)}`),
      `export OPENCODE_PERMISSION=${quoteForRemoteShell(permissionConfig)}`,
      'export OPENCODE_CLIENT=build-autobuild',
      'export OPENCODE_CONFIG="$HOME/.config/opencode/build-mcp.json"',
      'export OPENCODE_DISABLE_AUTOUPDATE=true',
      'export OPENCODE_DISABLE_MODELS_FETCH=true',
      'export OPENCODE_DISABLE_TERMINAL_TITLE=true',
      'export OPENCODE_ENABLE_EXPERIMENTAL_MODELS=true',
      settings.localModeDisableLspDownload === true ? 'export OPENCODE_DISABLE_LSP_DOWNLOAD=true' : '',
      'prompt_file="$(mktemp "${TMPDIR:-/tmp}/build-opencode-prompt.XXXXXX")"',
      'cleanup_prompt_file() { rm -f "$prompt_file"; }',
      'trap cleanup_prompt_file EXIT',
      'cat > "$prompt_file"',
      'if command -v opencode >/dev/null 2>&1; then opencode_cmd="$(command -v opencode)"; opencode_prefix=""; elif command -v npx >/dev/null 2>&1; then opencode_cmd="$(command -v npx)"; opencode_prefix="-y opencode-ai"; else echo "OpenCode runner not found on remote. Install OpenCode with: npm install -g opencode-ai, or install Node/npm for npx fallback." >&2; exit 127; fi',
      `"$opencode_cmd" \${opencode_prefix} run "$(cat "$prompt_file")" --model ${quoteForRemoteShell(opencodeModel)} --format json --dir ${remotePathForShell(remoteDir)}${skipFlag}`,
    ].filter(Boolean).join(' && ');

    const abortController = new AbortController();
    const child = spawn('ssh', buildSshArgs(sshConfig, command), {
      signal: abortController.signal,
      detached: process.platform !== 'win32',
    });
    child.stdin?.end(effectiveMessage);

    return { child, abortController };
  }

  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    model: string,
    sshConfig?: SSHConfig,
    permissionMode?: string,
    policy?: HarnessPolicyTranslation,
  ): AsyncGenerator<OpenCodeStreamEvent> {
    const settings = this.getSettings();
    const opencodeModel = resolveOpenCodeModel(model);
    const localOllamaModel = isLocalOllamaModel(opencodeModel);

    if (localOllamaModel && sshConfig) {
      yield {
        type: 'error',
        error: 'Local Mode uses Ollama on this Mac and is only supported for local sessions. SSH sessions would run OpenCode on the remote host.',
      };
      return;
    }

    const apiKey = this.getApiKey();
    if (!apiKey && !localOllamaModel) {
      yield { type: 'error', error: 'DeepSeek API key not configured. Add it in Settings > API Keys, or set DEEPSEEK_API_KEY.' };
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

    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
        model: isLocalModeEnabled(settings) && localOllamaModel ? `${opencodeModel} (local)` : opencodeModel,
      },
    };

    this.cancel(sessionId);

    let child: ChildProcess;
    let abortController: AbortController;
    try {
      if (sshConfig) {
        const sshSpawn = this.buildSshSpawn(message, workDir, opencodeModel, sshConfig, permissionMode, policy);
        child = sshSpawn.child;
        abortController = sshSpawn.abortController;
      } else {
        const openCodeCommand = localOllamaModel ? this.getOfflineSafeCommand() : this.getCommand();
        abortController = new AbortController();
        child = this.buildLocalSpawn(openCodeCommand, message, workDir, opencodeModel, abortController, permissionMode, policy);
      }
    } catch (error) {
      yield { type: 'error', error: `Failed to start OpenCode: ${error instanceof Error ? error.message : String(error)}` };
      return;
    }

    this.activeProcesses.set(sessionId, { process: child, abortController });
    this.lastAssistantTextBySession.delete(sessionId);

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

    let stderrOutput = '';
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrOutput += text;
      console.log('[OpenCode Service] stderr:', text.substring(0, 200));
    });

    if (!child.stdout) {
      this.activeProcesses.delete(sessionId);
      yield { type: 'error', error: 'OpenCode process has no stdout' };
      return;
    }

    const rl = readline.createInterface({ input: child.stdout });
    let emitted = false;
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const jsonLine = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        try {
          const event = JSON.parse(jsonLine) as Record<string, unknown>;
          const translated = this.translateJsonEvent(sessionId, event);
          if (translated) {
            emitted = true;
            yield translated;
            if (translated.type === 'error') {
              return;
            }
          }
        } catch {
          emitted = true;
          yield { type: 'text_delta', content: `${line}\n` };
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
    }

    const exitCode = await exitPromise;
    if (exitCode && exitCode !== 0) {
      const errorText = stderrOutput.trim() || `OpenCode exited with code ${exitCode}`;
      this.lastAssistantTextBySession.delete(sessionId);
      yield { type: 'error', error: errorText };
      return;
    }

    if (!emitted && stderrOutput.trim()) {
      this.lastAssistantTextBySession.delete(sessionId);
      yield { type: 'error', error: stderrOutput.trim() };
      return;
    }

    const finalText = this.lastAssistantTextBySession.get(sessionId) || '';
    this.lastAssistantTextBySession.delete(sessionId);
    yield {
      type: 'message_complete',
      message: finalText.trim() ? {
        id: `opencode-result-${Date.now()}`,
        role: 'assistant',
        content: finalText,
        timestamp: new Date(),
        harness: 'opencode',
      } : undefined,
    };
  }

  cancel(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (!active) return;
    terminateProcessTree(active.process, 1000, true);
    active.abortController.abort();
    this.activeProcesses.delete(sessionId);
  }
}

export const openCodeService = new OpenCodeService();
export function getOpenCodeService(): OpenCodeService {
  return openCodeService;
}
