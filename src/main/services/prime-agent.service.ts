import Store from 'electron-store';
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as readline from 'readline';
import type { ChatMessage, SSHConfig } from '../../shared/types';
import { findUsableLocalExecutable } from '../utils/local-executable';
import { terminateProcessTree } from '../utils/process-tree';
import { prependPolicyPreamble, type HarnessPolicyTranslation } from './harness-policy.service';
import { sshService, type SpawnedProcess } from './ssh.service';

export interface PrimeAgentStreamEvent {
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
const store = new Store({ name: 'claudette-settings' }) as any;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteDirectory(value: string): string {
  return !value || value === '~' ? '$HOME' : shellQuote(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function serializeResult(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class PrimeAgentService {
  private active = new Map<string, { process: ChildProcess | SpawnedProcess; remote: boolean }>();
  private localBinary: string | undefined;
  private assistantText = new Map<string, string>();

  private sessionStoreKey(sessionId: string): string {
    return `primeAgentSessions.${sessionId}`;
  }

  private targetKey(sshConfig?: SSHConfig): string {
    return sshConfig
      ? `ssh:${sshConfig.username}@${sshConfig.host}:${sshConfig.port || 22}`
      : 'local';
  }

  private getResumeId(sessionId: string, sshConfig?: SSHConfig): string | undefined {
    const sessions = (store.get(this.sessionStoreKey(sessionId), {}) || {}) as Record<string, string>;
    return sessions[this.targetKey(sshConfig)];
  }

  private setResumeId(sessionId: string, resumeId: string, sshConfig?: SSHConfig): void {
    const key = this.sessionStoreKey(sessionId);
    const sessions = (store.get(key, {}) || {}) as Record<string, string>;
    store.set(key, { ...sessions, [this.targetKey(sshConfig)]: resumeId });
  }

  clearSession(sessionId: string): void {
    store.delete(this.sessionStoreKey(sessionId));
  }

  private getLocalBinary(): string {
    if (this.localBinary) return this.localBinary;
    const home = os.homedir();
    const binary = findUsableLocalExecutable(['prime-agent'], [
      `${home}/.local/bin/prime-agent`,
      `${home}/bin/prime-agent`,
      '/opt/homebrew/bin/prime-agent',
      '/usr/local/bin/prime-agent',
    ]);
    if (!binary) {
      throw new Error('Prime Agent is not installed. Install it from Settings > Agents, or run the official Prime Agent installer.');
    }
    this.localBinary = binary;
    return binary;
  }

  private translate(sessionId: string, event: Record<string, unknown>, sshConfig?: SSHConfig): PrimeAgentStreamEvent | null {
    const type = text(event.type) || '';
    if (type === 'session') {
      const id = text(event.id);
      if (id) this.setResumeId(sessionId, id, sshConfig);
      return null;
    }
    if (type === 'message_update') {
      const update = record(event.assistantMessageEvent);
      if (text(update?.type) === 'text_delta') {
        const delta = text(update?.delta);
        if (delta) {
          this.assistantText.set(sessionId, `${this.assistantText.get(sessionId) || ''}${delta}`);
          return { type: 'text_delta', content: delta };
        }
      }
      if (text(update?.type)?.includes('thinking')) {
        const delta = text(update?.delta);
        return delta ? { type: 'thinking_delta', content: delta } : null;
      }
      return null;
    }
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
      const ended = type === 'tool_execution_end';
      return {
        type: ended ? 'tool_result' : 'tool_use',
        toolCall: {
          id: text(event.toolCallId) || `prime-tool-${Date.now()}`,
          name: text(event.toolName) || 'Prime Agent tool',
          input: record(event.args) || {},
          status: ended ? (event.isError ? 'error' : 'completed') : 'running',
          result: ended ? serializeResult(event.result) : undefined,
        },
      };
    }
    if (type === 'auto_retry_start') {
      return { type: 'thinking_delta', content: `Prime Agent is retrying: ${text(event.errorMessage) || 'temporary provider error'}\n` };
    }
    if (type === 'error') {
      return { type: 'error', error: text(event.message) || text(event.error) || 'Prime Agent reported an error.' };
    }
    return null;
  }

  private localProcess(message: string, workDir: string, resumeId: string | undefined, policy?: HarnessPolicyTranslation): ChildProcess {
    const binary = this.getLocalBinary();
    const prompt = prependPolicyPreamble(message, policy?.promptPreamble);
    const args = ['--mode', 'json', '--cwd', workDir, '--offline'];
    if (resumeId) args.push('--resume', resumeId);
    args.push('Follow the Build request supplied on standard input.');
    const child = spawn(binary, args, {
      cwd: workDir,
      env: { ...(process.env as Record<string, string>), ...(policy?.env || {}), PI_SKIP_VERSION_CHECK: '1' },
      detached: process.platform !== 'win32',
    });
    child.stdin?.end(prompt);
    return child;
  }

  private remoteProcess(sessionId: string, message: string, workDir: string, config: SSHConfig, resumeId: string | undefined, policy?: HarnessPolicyTranslation): SpawnedProcess {
    const prompt = prependPolicyPreamble(message, policy?.promptPreamble);
    const args = ['--mode', 'json', '--cwd', workDir, '--offline'];
    if (resumeId) args.push('--resume', resumeId);
    const command = [
      `cd ${remoteDirectory(workDir)}`,
      'export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"',
      'command -v prime-agent >/dev/null 2>&1 || { echo "Prime Agent is not installed on this remote. Install it from Build SSH setup." >&2; exit 127; }',
      'prompt_file="$(mktemp "${TMPDIR:-/tmp}/build-prime-prompt.XXXXXX")"',
      'cleanup_prompt_file() { rm -f "$prompt_file"; }',
      'trap cleanup_prompt_file EXIT',
      'cat > "$prompt_file"',
      `prime-agent ${args.map(shellQuote).join(' ')} 'Follow the Build request supplied on standard input.' < "$prompt_file"`,
    ].join(' && ');
    const child = sshService.createDetachedCommandProcess(sessionId, config, {
      command: 'bash',
      recoveryCommand: 'prime-agent',
      args: ['-lc', command],
      cwd: workDir,
      env: { ...(policy?.env || {}), PI_SKIP_VERSION_CHECK: '1' },
      closeStdinOnEnd: true,
      requireDetached: true,
    });
    child.stdin.end(prompt);
    return child;
  }

  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    _model: string,
    sshConfig?: SSHConfig,
    policy?: HarnessPolicyTranslation,
  ): AsyncGenerator<PrimeAgentStreamEvent> {
    this.cancel(sessionId);
    this.assistantText.delete(sessionId);
    yield { type: 'system', systemInfo: { tools: ['IPython', 'Bash', 'Files', 'Subagents'], model: 'Prime Agent' } };

    let child: ChildProcess | SpawnedProcess;
    try {
      const resumeId = this.getResumeId(sessionId, sshConfig);
      child = sshConfig
        ? this.remoteProcess(sessionId, message, workDir, sshConfig, resumeId, policy)
        : this.localProcess(message, workDir, resumeId, policy);
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      return;
    }
    this.active.set(sessionId, { process: child, remote: Boolean(sshConfig) });

    let stderr = '';
    if ('stderr' in child && child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderr = `${stderr}${data.toString()}`.slice(-4_000);
      });
    }
    if (!child.stdout) {
      this.active.delete(sessionId);
      yield { type: 'error', error: 'Prime Agent did not provide an output stream.' };
      return;
    }

    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const lines = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const translated = this.translate(sessionId, JSON.parse(line) as Record<string, unknown>, sshConfig);
          if (translated) yield translated;
        } catch {
          // JSON mode reserves stdout for protocol records. Keep non-JSON
          // diagnostics out of the assistant transcript and report them only
          // if the process fails.
          stderr = `${stderr}\n${line}`.slice(-4_000);
        }
      }
    } finally {
      lines.close();
      this.active.delete(sessionId);
    }

    const exitCode = await exit;
    if (exitCode && exitCode !== 0) {
      if (this.getResumeId(sessionId, sshConfig)) this.clearSession(sessionId);
      yield { type: 'error', error: stderr.trim() || `Prime Agent exited with code ${exitCode}.` };
      return;
    }
    const finalText = this.assistantText.get(sessionId) || '';
    this.assistantText.delete(sessionId);
    yield {
      type: 'message_complete',
      message: finalText.trim() ? {
        id: `prime-result-${Date.now()}`,
        role: 'assistant',
        content: finalText,
        timestamp: new Date(),
        harness: 'prime',
      } : undefined,
    };
  }

  async *replayDetachedAsChat(
    sessionId: string,
    process: SpawnedProcess,
    model?: string,
    sshConfig?: SSHConfig,
  ): AsyncGenerator<PrimeAgentStreamEvent> {
    this.assistantText.delete(sessionId);
    yield {
      type: 'system',
      systemInfo: { tools: ['IPython', 'Bash', 'Files', 'Subagents'], model: model || 'Prime Agent' },
    };
    if (!process.stdout) {
      yield { type: 'error', error: 'Recovered Prime Agent process has no output stream.' };
      return;
    }
    const lines = readline.createInterface({ input: process.stdout });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = this.translate(sessionId, JSON.parse(line) as Record<string, unknown>, sshConfig);
          if (event) yield event;
        } catch {
          // The detached bridge log can contain stderr diagnostics. Only
          // structured Prime Agent events belong in the chat transcript.
        }
      }
    } finally {
      lines.close();
    }
    const finalText = this.assistantText.get(sessionId) || '';
    this.assistantText.delete(sessionId);
    yield {
      type: 'message_complete',
      message: finalText.trim() ? {
        id: `prime-recovered-result-${Date.now()}`,
        role: 'assistant',
        content: finalText,
        timestamp: new Date(),
        harness: 'prime',
      } : undefined,
    };
  }

  cancel(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (!active) return;
    if (active.remote) active.process.kill('SIGTERM');
    else terminateProcessTree(active.process as ChildProcess, 1_000, true);
    this.active.delete(sessionId);
  }
}

export const primeAgentService = new PrimeAgentService();
export function getPrimeAgentService(): PrimeAgentService {
  return primeAgentService;
}
