import Store from 'electron-store';
import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import type { ChatMessage, SSHConfig } from '../../shared/types';
import { terminateProcessTree } from '../utils/process-tree';
import { mcpService } from './mcp.service';
import { sshService } from './ssh.service';

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

function findExecutable(binaryName: string): string | null {
  try {
    const result = execSync(`which ${binaryName}`, { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch {
    // Not in PATH.
  }

  return null;
}

function findOpenCodeCommand(): OpenCodeCommand {
  const pathBinary = findExecutable('opencode');
  if (pathBinary) {
    return { command: pathBinary, prefixArgs: [], label: 'opencode' };
  }

  const home = os.homedir();
  const candidates = [
    `${home}/.local/bin/opencode`,
    `${home}/.bun/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, prefixArgs: [], label: 'opencode' };
    }
  }

  const npxBinary = findExecutable('npx');
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

  private getCommand(): OpenCodeCommand {
    if (!this.openCodeCommand) {
      this.openCodeCommand = findOpenCodeCommand();
    }
    return this.openCodeCommand;
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

  private buildLocalSpawn(openCodeCommand: OpenCodeCommand, message: string, workDir: string, opencodeModel: string, abortController: AbortController, permissionMode?: string) {
    const args = [
      ...openCodeCommand.prefixArgs,
      'run',
      message,
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
    env.OPENCODE_PERMISSION = buildPermissionConfig(permissionMode);
    env.OPENCODE_CLIENT = 'build-autobuild';
    env.OPENCODE_CONFIG = mcpService.getOpenCodeConfigPath();
    env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    env.OPENCODE_DISABLE_TERMINAL_TITLE = 'true';
    env.OPENCODE_ENABLE_EXPERIMENTAL_MODELS = 'true';

    console.log(`[OpenCode Service] Local spawn via ${openCodeCommand.label}: ${openCodeCommand.command} ${args.slice(0, openCodeCommand.prefixArgs.length + 1).join(' ')} <${message.length} chars>`);

    return spawn(openCodeCommand.command, args, {
      cwd: workDir,
      env,
      signal: abortController.signal,
      detached: process.platform !== 'win32',
    });
  }

  private buildSshSpawn(message: string, remoteDir: string, opencodeModel: string, sshConfig: SSHConfig, permissionMode?: string) {
    const apiKey = this.getApiKey() || '';
    const permissionConfig = buildPermissionConfig(permissionMode);
    const skipFlag = permissionMode !== 'plan' && permissionMode !== 'dontAsk'
      ? ' --dangerously-skip-permissions'
      : '';
    const command = [
      `cd ${remotePathForShell(remoteDir)}`,
      getRemotePathPrefix(),
      apiKey ? `export DEEPSEEK_API_KEY=${quoteForRemoteShell(apiKey)}` : '',
      `export OPENCODE_PERMISSION=${quoteForRemoteShell(permissionConfig)}`,
      'export OPENCODE_CLIENT=build-autobuild',
      'export OPENCODE_CONFIG="$HOME/.config/opencode/build-mcp.json"',
      'export OPENCODE_DISABLE_AUTOUPDATE=true',
      'export OPENCODE_DISABLE_TERMINAL_TITLE=true',
      'export OPENCODE_ENABLE_EXPERIMENTAL_MODELS=true',
      'if command -v opencode >/dev/null 2>&1; then opencode_cmd="$(command -v opencode)"; opencode_prefix=""; elif command -v npx >/dev/null 2>&1; then opencode_cmd="$(command -v npx)"; opencode_prefix="-y opencode-ai"; else echo "OpenCode runner not found on remote. Install OpenCode with: npm install -g opencode-ai, or install Node/npm for npx fallback." >&2; exit 127; fi',
      `"$opencode_cmd" \${opencode_prefix} run ${quoteForRemoteShell(message)} --model ${quoteForRemoteShell(opencodeModel)} --format json --dir ${remotePathForShell(remoteDir)}${skipFlag}`,
    ].filter(Boolean).join(' && ');

    const abortController = new AbortController();
    const child = spawn('ssh', buildSshArgs(sshConfig, command), {
      signal: abortController.signal,
      detached: process.platform !== 'win32',
    });

    return { child, abortController };
  }

  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    model: string,
    sshConfig?: SSHConfig,
    permissionMode?: string,
  ): AsyncGenerator<OpenCodeStreamEvent> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
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

    const opencodeModel = resolveOpenCodeModel(model);
    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
        model: opencodeModel,
      },
    };

    this.cancel(sessionId);

    let child: ChildProcess;
    let abortController: AbortController;
    try {
      if (sshConfig) {
        const sshSpawn = this.buildSshSpawn(message, workDir, opencodeModel, sshConfig, permissionMode);
        child = sshSpawn.child;
        abortController = sshSpawn.abortController;
      } else {
        const openCodeCommand = this.getCommand();
        abortController = new AbortController();
        child = this.buildLocalSpawn(openCodeCommand, message, workDir, opencodeModel, abortController, permissionMode);
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
