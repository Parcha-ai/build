import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import type { CursorStreamEvent } from './cursor.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ToolCallData {
  shellToolCall?: { args?: { command?: string; description?: string }; result?: { success?: { stdout?: string; exitCode?: number } }; description?: string };
  readToolCall?: { args?: { path?: string }; result?: { success?: { totalLines?: number; content?: string } }; description?: string };
  writeToolCall?: { args?: { path?: string }; result?: { success?: { linesCreated?: number } }; description?: string };
  editToolCall?: { args?: { path?: string; oldText?: string; newText?: string }; result?: { success?: boolean }; description?: string };
  globToolCall?: { args?: { pattern?: string }; result?: { success?: { files?: string[] } }; description?: string };
  grepToolCall?: { args?: { pattern?: string; path?: string }; result?: { success?: { matches?: unknown[] } }; description?: string };
  lsToolCall?: { args?: { path?: string }; result?: { success?: { entries?: unknown[] } }; description?: string };
}

interface CursorCliJsonEvent {
  type: string;
  subtype?: string;
  text?: string;
  model?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  duration_ms?: number;
  message?: {
    content?: Array<{ text?: string; type?: string }>;
  };
  tool_call?: ToolCallData;
  call_id?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

interface SshConfig {
  host: string;
  username: string;
  remoteWorkdir?: string;
}

class CursorCliService {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private agentBinaryCache: string | null | false = null;
  private lastAssistantLen = 0;

  private getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    return (settings.cursorApiKey as string) || undefined;
  }

  findAgentBinary(): string | null {
    if (this.agentBinaryCache === false) return null;
    if (this.agentBinaryCache) return this.agentBinaryCache;

    const homeDir = os.homedir();
    const candidates = [
      `${homeDir}/.cursor/bin/agent`,
      '/usr/local/bin/agent',
      `${homeDir}/.local/bin/agent`,
      '/opt/homebrew/bin/agent',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`[Cursor CLI] Found agent binary: ${candidate}`);
        this.agentBinaryCache = candidate;
        return candidate;
      }
    }

    try {
      const { execSync } = require('child_process');
      const result = execSync('which agent', { encoding: 'utf8' }).trim();
      if (result) {
        console.log(`[Cursor CLI] Found agent binary via which: ${result}`);
        this.agentBinaryCache = result;
        return result;
      }
    } catch { /* not in PATH */ }

    console.log('[Cursor CLI] agent binary not found locally');
    this.agentBinaryCache = false;
    return null;
  }

  private translateEvent(event: CursorCliJsonEvent): CursorStreamEvent | null {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          return {
            type: 'system',
            systemInfo: {
              tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Ls'],
              model: event.model || 'cursor-agent',
            },
          };
        }
        return null;

      case 'assistant': {
        const text = event.message?.content?.[0]?.text;
        if (text) {
          // --stream-partial-output sends cumulative text, not deltas.
          // Diff against what we've already emitted to extract the new portion.
          const delta = text.substring(this.lastAssistantLen);
          this.lastAssistantLen = text.length;
          if (delta) {
            return { type: 'text_delta', content: delta };
          }
        }
        return null;
      }

      case 'tool_call':
        this.lastAssistantLen = 0;
        if (event.subtype === 'started') {
          const name = this.extractToolName(event);
          const input = this.extractToolInput(event);
          return {
            type: 'tool_use',
            toolCall: {
              id: event.call_id || `cursor-cli-tc-${Date.now()}`,
              name,
              input,
              status: 'running',
            },
          };
        }
        if (event.subtype === 'completed') {
          const name = this.extractToolName(event);
          const input = this.extractToolInput(event);
          const result = this.extractToolResult(event);
          return {
            type: 'tool_result',
            toolCall: {
              id: event.call_id || `cursor-cli-tr-${Date.now()}`,
              name,
              input,
              status: 'completed',
              result,
            },
          };
        }
        return null;

      case 'thinking':
        if (event.subtype === 'delta' && event.text) {
          return { type: 'thinking_delta', content: event.text };
        }
        return null;

      case 'result':
        return { type: 'message_complete' };

      case 'error':
        return { type: 'error', error: event.message?.content?.[0]?.text || 'Cursor CLI error' };

      default:
        return null;
    }
  }

  private extractToolName(event: CursorCliJsonEvent): string {
    const tc = event.tool_call;
    if (!tc) return 'unknown';
    if (tc.shellToolCall) return 'Bash';
    if (tc.readToolCall) return 'Read';
    if (tc.writeToolCall) return 'Write';
    if (tc.editToolCall) return 'Edit';
    if (tc.globToolCall) return 'Glob';
    if (tc.grepToolCall) return 'Grep';
    if (tc.lsToolCall) return 'Ls';
    return 'unknown';
  }

  private extractToolInput(event: CursorCliJsonEvent): Record<string, unknown> {
    const tc = event.tool_call;
    if (!tc) return {};
    if (tc.shellToolCall?.args) return tc.shellToolCall.args as Record<string, unknown>;
    if (tc.readToolCall?.args) return tc.readToolCall.args as Record<string, unknown>;
    if (tc.writeToolCall?.args) return tc.writeToolCall.args as Record<string, unknown>;
    if (tc.editToolCall?.args) return tc.editToolCall.args as Record<string, unknown>;
    if (tc.globToolCall?.args) return tc.globToolCall.args as Record<string, unknown>;
    if (tc.grepToolCall?.args) return tc.grepToolCall.args as Record<string, unknown>;
    if (tc.lsToolCall?.args) return tc.lsToolCall.args as Record<string, unknown>;
    return {};
  }

  private extractToolResult(event: CursorCliJsonEvent): string | undefined {
    const tc = event.tool_call;
    if (!tc) return undefined;
    if (tc.shellToolCall?.result) return JSON.stringify(tc.shellToolCall.result);
    if (tc.readToolCall?.result) return JSON.stringify(tc.readToolCall.result);
    if (tc.writeToolCall?.result) return JSON.stringify(tc.writeToolCall.result);
    if (tc.editToolCall?.result) return JSON.stringify(tc.editToolCall.result);
    if (tc.globToolCall?.result) return JSON.stringify(tc.globToolCall.result);
    if (tc.grepToolCall?.result) return JSON.stringify(tc.grepToolCall.result);
    if (tc.lsToolCall?.result) return JSON.stringify(tc.lsToolCall.result);
    return undefined;
  }

  async *streamMessage(
    sessionId: string,
    message: string,
    workDir: string,
    model: string,
    sshConfig?: SshConfig,
  ): AsyncGenerator<CursorStreamEvent> {
    // API key is optional — the CLI has its own auth flow
    const apiKey = this.getApiKey();
    this.lastAssistantLen = 0;

    const cursorModel = model.replace('cursor:', '');

    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Ls'],
        model: cursorModel || 'cursor-agent',
      },
    };

    let child: ChildProcess;
    const abortController = new AbortController();

    if (sshConfig) {
      const remoteDir = workDir || sshConfig.remoteWorkdir || '~';
      // Escape the message for safe SSH transmission: base64-encode it
      const b64Message = Buffer.from(message).toString('base64');
      const apiEnv = apiKey ? `CURSOR_API_KEY='${apiKey}' ` : '';
      const remoteCmd = `cd ${remoteDir} && export PATH="$HOME/.local/bin:$HOME/.cursor/bin:$PATH" && ${apiEnv}agent -p "$(echo '${b64Message}' | base64 -d)" --output-format stream-json --stream-partial-output --force${cursorModel ? ` --model "${cursorModel}"` : ''}`;

      console.log(`[Cursor CLI] SSH exec on ${sshConfig.host}: agent -p <${message.length} chars> --model ${cursorModel}`);

      child = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'BatchMode=yes',
        sshConfig.host,
        remoteCmd,
      ], { signal: abortController.signal });
    } else {
      const agentBin = this.findAgentBinary();
      if (!agentBin) {
        yield { type: 'error', error: 'Cursor agent CLI not found. Install it with: curl https://cursor.com/install -fsS | bash' };
        return;
      }

      const args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--force',
      ];
      if (cursorModel) {
        args.push('--model', cursorModel);
      }

      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (apiKey) env.CURSOR_API_KEY = apiKey;

      console.log(`[Cursor CLI] Local spawn: agent -p <${message.length} chars> --model ${cursorModel}`);

      child = spawn(agentBin, args, {
        env,
        cwd: workDir,
        signal: abortController.signal,
      });
    }

    this.activeProcesses.set(sessionId, { process: child, abortController });

    let stderrOutput = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        console.log('[Cursor CLI] stderr:', text.substring(0, 200));
      });
    }

    if (!child.stdout) {
      this.activeProcesses.delete(sessionId);
      yield { type: 'error', error: 'Cursor CLI process has no stdout' };
      return;
    }

    const rl = readline.createInterface({ input: child.stdout });
    let eventCount = 0;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CursorCliJsonEvent;
          eventCount++;
          const translated = this.translateEvent(event);
          if (translated) {
            yield translated;
            if (translated.type === 'message_complete') return;
          }
        } catch {
          console.warn('[Cursor CLI] Non-JSON line:', line.substring(0, 150));
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
      console.log(`[Cursor CLI] Stream ended. Events: ${eventCount}`);
    }

    if (eventCount === 0 && stderrOutput) {
      const lastLine = stderrOutput.split('\n').filter(l => l.trim()).pop();
      if (lastLine) {
        yield { type: 'error', error: lastLine };
        return;
      }
    }

    yield { type: 'message_complete' };
  }

  cancel(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      console.log(`[Cursor CLI] Cancelling run for ${sessionId}`);
      active.abortController.abort();
      active.process.kill('SIGTERM');
      const proc = active.process;
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 1000);
      this.activeProcesses.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [id, active] of this.activeProcesses) {
      try {
        active.abortController.abort();
        active.process.kill('SIGTERM');
      } catch { /* best-effort */ }
      this.activeProcesses.delete(id);
    }
  }
}

let cursorCliServiceInstance: CursorCliService | null = null;
export function getCursorCliService(): CursorCliService {
  if (!cursorCliServiceInstance) {
    cursorCliServiceInstance = new CursorCliService();
  }
  return cursorCliServiceInstance;
}
