import Store from 'electron-store';
import { spawn, execSync, execFileSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import type { CursorStreamEvent } from './cursor.service';
import { terminateProcessTree } from '../utils/process-tree';
import { mcpService } from './mcp.service';
import { sshService } from './ssh.service';
import type { SSHConfig } from '../../shared/types';

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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

class CursorCliService {
  private activeProcesses: Map<string, { process: ChildProcess; abortController: AbortController }> = new Map();
  private agentBinaryCache: string | null | false = null;
  private chatIds: Map<string, string> = new Map();

  private getApiKey(): string | undefined {
    const settings = settingsStore.get('settings', {}) as Record<string, unknown>;
    return (settings.cursorApiKey as string)?.trim()
      || (settingsStore.get('cursorApiKey') as string | undefined)?.trim()
      || process.env.CURSOR_API_KEY?.trim()
      || undefined;
  }

  findAgentBinary(): string | null {
    if (this.agentBinaryCache === false) return null;
    if (this.agentBinaryCache) return this.agentBinaryCache;

    const homeDir = os.homedir();
    const candidates = [
      `${homeDir}/.local/bin/cursor-agent`,
      `${homeDir}/.cursor/bin/cursor-agent`,
      '/usr/local/bin/cursor-agent',
      '/opt/homebrew/bin/cursor-agent',
      `${homeDir}/.local/bin/agent`,
      `${homeDir}/.cursor/bin/agent`,
      '/usr/local/bin/agent',
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
      const result = execSync('which cursor-agent', { encoding: 'utf8' }).trim();
      if (result) {
        console.log(`[Cursor CLI] Found cursor-agent via which: ${result}`);
        this.agentBinaryCache = result;
        return result;
      }
    } catch { /* not in PATH */ }

    try {
      const result = execSync('which agent', { encoding: 'utf8' }).trim();
      if (result) {
        console.log(`[Cursor CLI] Found agent via which: ${result}`);
        this.agentBinaryCache = result;
        return result;
      }
    } catch { /* not in PATH */ }

    console.log('[Cursor CLI] agent binary not found locally');
    this.agentBinaryCache = false;
    return null;
  }

  getChatId(sessionId: string): string | undefined {
    return this.chatIds.get(sessionId);
  }

  setChatId(sessionId: string, chatId: string): void {
    this.chatIds.set(sessionId, chatId);
    console.log(`[Cursor CLI] Stored chatId ${chatId} for session ${sessionId.substring(0, 8)}`);
  }

  clearChatId(sessionId: string): void {
    this.chatIds.delete(sessionId);
  }

  private quoteForRemoteShell(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private remotePathForShell(value: string): string {
    return !value || value === '~' ? '$HOME' : this.quoteForRemoteShell(value);
  }

  private getRemotePathPrefix(): string {
    return 'export PATH="$HOME/.local/bin:$HOME/.cursor/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH"';
  }

  private buildSshTarget(sshConfig: SSHConfig): string {
    return sshConfig.username ? `${sshConfig.username}@${sshConfig.host}` : sshConfig.host;
  }

  private buildSshArgs(sshConfig: SSHConfig, remoteCommand: string): string[] {
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
    args.push(this.buildSshTarget(sshConfig), remoteCommand);
    return args;
  }

  async createChat(workDir: string): Promise<string | null> {
    const agentBin = this.findAgentBinary();
    if (!agentBin) return null;

    try {
      const chatId = execSync(`"${agentBin}" create-chat`, {
        encoding: 'utf8',
        cwd: workDir,
        timeout: 10000,
      }).trim();
      if (chatId && chatId.match(/^[a-f0-9-]+$/i)) {
        console.log(`[Cursor CLI] Created chat: ${chatId}`);
        return chatId;
      }
      console.warn(`[Cursor CLI] create-chat returned unexpected output: ${chatId.substring(0, 100)}`);
      return null;
    } catch (e) {
      console.warn('[Cursor CLI] Failed to create chat:', e);
      return null;
    }
  }

  async createSshChat(sshConfig: SSHConfig, remoteDir: string): Promise<string | null> {
    try {
      const remoteCmd = [
        `cd ${this.remotePathForShell(remoteDir)}`,
        this.getRemotePathPrefix(),
        'agent_bin="$(command -v cursor-agent || command -v agent)"',
        '"$agent_bin" create-chat',
      ].join(' && ');
      const chatId = execFileSync('ssh', this.buildSshArgs(sshConfig, remoteCmd), {
        encoding: 'utf8',
        timeout: 15000,
      }).trim();
      if (chatId && chatId.match(/^[a-f0-9-]+$/i)) {
        console.log(`[Cursor CLI] Created SSH chat on ${sshConfig.host}: ${chatId}`);
        return chatId;
      }
      return null;
    } catch (e) {
      console.warn('[Cursor CLI] Failed to create SSH chat:', e);
      return null;
    }
  }

  private translateEvent(event: CursorCliJsonEvent, assistantState: { lastLen: number }): CursorStreamEvent | null {
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
        const text = this.extractMessageText(event);
        if (text) {
          const delta = text.substring(assistantState.lastLen);
          assistantState.lastLen = text.length;
          if (delta) {
            return { type: 'text_delta', content: delta };
          }
        }
        return null;
      }

      case 'tool_call':
        assistantState.lastLen = 0;
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
        return {
          type: 'message_complete',
          message: this.buildResultMessage(event),
          usage: {
            inputTokens: event.usage?.inputTokens,
            outputTokens: event.usage?.outputTokens,
            cacheReadTokens: event.usage?.cacheReadTokens,
            cacheWriteTokens: event.usage?.cacheWriteTokens,
            model: event.model,
          },
        };

      case 'error':
        return { type: 'error', error: event.message?.content?.[0]?.text || 'Cursor CLI error' };

      default:
        return null;
    }
  }

  private extractMessageText(event: CursorCliJsonEvent): string {
    const parts: string[] = [];
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') {
          parts.push(block);
        } else if (block && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block && typeof (block as { content?: unknown }).content === 'string') {
          parts.push((block as { content: string }).content);
        }
      }
    }

    if (event.type === 'assistant' && typeof event.text === 'string') {
      parts.push(event.text);
    }

    return parts.join('');
  }

  private buildResultMessage(event: CursorCliJsonEvent): CursorStreamEvent['message'] | undefined {
    const content = this.extractMessageText(event);
    if (!content.trim()) return undefined;
    return {
      id: `cursor-cli-result-${Date.now()}`,
      role: 'assistant',
      content,
      timestamp: new Date(),
      harness: 'cursor',
    };
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
    sshConfig?: SSHConfig,
    chatId?: string,
  ): AsyncGenerator<CursorStreamEvent> {
    const apiKey = this.getApiKey();
    const assistantState = { lastLen: 0 };

    const cursorModel = model.replace('cursor:', '');

    yield {
      type: 'system',
      systemInfo: {
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Ls'],
        model: cursorModel || 'cursor-agent',
      },
    };

    let child: ChildProcess;
    this.cancel(sessionId);
    const abortController = new AbortController();

    if (sshConfig) {
      const syncResult = await sshService.syncMcpConfigsToRemote(sessionId, sshConfig);
      if (!syncResult.success) {
        yield { type: 'error', error: `Failed to sync MCP config to remote: ${syncResult.error}` };
        return;
      }

      const remoteDir = workDir || sshConfig.remoteWorkdir || '~';
      const b64Message = Buffer.from(message).toString('base64');
      const remoteArgs = [
        '-p', `"$(printf '%s' '${b64Message}' | base64 -d)"`,
        '--output-format', 'stream-json',
        '--force',
        '--trust',
        '--approve-mcps',
      ];
      if (chatId) {
        remoteArgs.push('--resume', this.quoteForRemoteShell(chatId));
      }
      if (cursorModel) {
        remoteArgs.push('--model', this.quoteForRemoteShell(cursorModel));
      }

      const remoteCmd = [
        `cd ${this.remotePathForShell(remoteDir)}`,
        this.getRemotePathPrefix(),
        apiKey ? `export CURSOR_API_KEY=${this.quoteForRemoteShell(apiKey)}` : '',
        'agent_bin="$(command -v cursor-agent || command -v agent)"',
        `"$agent_bin" ${remoteArgs.join(' ')}`,
      ].filter(Boolean).join(' && ');

      console.log(`[Cursor CLI] SSH exec on ${sshConfig.host}: cursor-agent -p <${message.length} chars> --model ${cursorModel}${chatId ? ` --resume ${chatId}` : ' (new chat)'}`);

      child = spawn('ssh', this.buildSshArgs(sshConfig, remoteCmd), {
        signal: abortController.signal,
        detached: process.platform !== 'win32',
      });
    } else {
      const syncResult = await mcpService.syncLocalHarnessConfigs();
      if (Object.keys(syncResult.errors).length > 0) {
        yield { type: 'error', error: `Failed to sync local MCP config: ${JSON.stringify(syncResult.errors)}` };
        return;
      }

      const agentBin = this.findAgentBinary();
      if (!agentBin) {
        yield { type: 'error', error: 'Cursor agent CLI not found. Install it with: curl https://cursor.com/install -fsS | bash' };
        return;
      }

      const args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--force',
        '--trust',
        '--approve-mcps',
      ];
      if (chatId) {
        args.push('--resume', chatId);
      }
      if (cursorModel) {
        args.push('--model', cursorModel);
      }

      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (apiKey) env.CURSOR_API_KEY = apiKey;

      console.log(`[Cursor CLI] Local spawn: cursor-agent -p <${message.length} chars> --model ${cursorModel}${chatId ? ` --resume ${chatId}` : ' (new chat)'}`);

      child = spawn(agentBin, args, {
        env,
        cwd: workDir,
        signal: abortController.signal,
        detached: process.platform !== 'win32',
      });
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ABORT_ERR') {
        console.warn('[Cursor CLI] Process error:', error);
      }
    });

    this.activeProcesses.set(sessionId, { process: child, abortController });

    let stderrOutput = '';
    let nonJsonOutput = '';
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
    let sawAssistantText = false;
    let sawToolActivity = false;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CursorCliJsonEvent;
          eventCount++;
          const translated = this.translateEvent(event, assistantState);
          if (translated) {
            if (translated.type === 'text_delta' && translated.content?.trim()) {
              sawAssistantText = true;
            }
            if (translated.type === 'tool_use' || translated.type === 'tool_result') {
              sawToolActivity = true;
            }
            if (translated.type === 'message_complete') {
              const finalText = translated.message?.content?.trim();
              if (!sawAssistantText && !finalText && sawToolActivity) {
                const completion = 'Cursor completed tool work but did not return a final text response.';
                yield { type: 'text_delta', content: completion };
                translated.message = {
                  id: `cursor-cli-tool-only-${Date.now()}`,
                  role: 'assistant',
                  content: completion,
                  timestamp: new Date(),
                  harness: 'cursor',
                };
              }
            }
            yield translated;
            if (translated.type === 'message_complete') return;
          }
        } catch {
          nonJsonOutput += `${line}\n`;
          console.warn('[Cursor CLI] Non-JSON line:', line.substring(0, 150));
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);
      console.log(`[Cursor CLI] Stream ended. Events: ${eventCount}, chatId: ${chatId || 'none'}`);
    }

    if (eventCount === 0) {
      const combinedOutput = `${stderrOutput}\n${nonJsonOutput}`;
      if (/press any key to sign in|provided API key is invalid|authenticat/i.test(combinedOutput)) {
        yield {
          type: 'error',
          error: 'Cursor Agent is not authenticated for non-interactive use. Complete Cursor CLI auth, or add a Cursor API key in Settings > API Keys / CURSOR_API_KEY.',
        };
        return;
      }

      const lastLine = combinedOutput.split('\n').filter(l => l.trim()).pop();
      if (lastLine) {
        yield { type: 'error', error: lastLine };
        return;
      }
    }

    if (!sawAssistantText && sawToolActivity) {
      const completion = 'Cursor completed tool work but did not return a final text response.';
      yield { type: 'text_delta', content: completion };
      yield {
        type: 'message_complete',
        message: {
          id: `cursor-cli-tool-only-${Date.now()}`,
          role: 'assistant',
          content: completion,
          timestamp: new Date(),
          harness: 'cursor',
        },
      };
      return;
    }

    yield { type: 'message_complete' };
  }

  cancel(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      console.log(`[Cursor CLI] Cancelling run for ${sessionId}`);
      terminateProcessTree(active.process, 1000, true);
      active.abortController.abort();
      this.activeProcesses.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [id, active] of this.activeProcesses) {
      try {
        terminateProcessTree(active.process, 1000, true);
        active.abortController.abort();
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
