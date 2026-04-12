import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { codexService } from '../services/codex.service';
import { getMainWindow } from '../index';
import { secureKeysService } from '../services/secure-keys.service';
import { sshService } from '../services/ssh.service';
import type { SSHConfig } from '../../shared/types';
import { getSessionStoreName } from '../store-names';

// Batching helper for smooth text streaming (mirrors claude.ipc.ts pattern)
class CodexChunkBatcher {
  private textBuffer = '';
  private thinkingBuffer = '';
  private textTimer: NodeJS.Timeout | null = null;
  private thinkingTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY = 100;

  constructor(
    private sessionId: string,
    private sendText: (content: string) => void,
    private sendThinking: (content: string) => void
  ) {}

  addText(content: string) {
    this.textBuffer += content;
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => this.flushText(), this.BATCH_DELAY);
    }
  }

  addThinking(content: string) {
    this.thinkingBuffer += content;
    if (!this.thinkingTimer) {
      this.thinkingTimer = setTimeout(() => this.flushThinking(), this.BATCH_DELAY);
    }
  }

  flushText() {
    if (this.textBuffer) {
      this.sendText(this.textBuffer);
      this.textBuffer = '';
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
  }

  flushThinking() {
    if (this.thinkingBuffer) {
      this.sendThinking(this.thinkingBuffer);
      this.thinkingBuffer = '';
    }
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  flush() {
    this.flushText();
    this.flushThinking();
  }
}

export function registerCodexHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.CODEX_RUN,
    async (_, sessionId: string, prompt: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      console.log('[Codex IPC] Starting Codex run for session:', sessionId);

      // Determine working directory from session
      const Store = (await import('electron-store')).default;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionsStore = new Store({ name: getSessionStoreName() }) as any;
      const sessionData =
        sessionsStore.get(`sessions.${sessionId}`) as { worktreePath?: string; repoPath?: string; sshConfig?: SSHConfig } | undefined
        || sessionsStore.get(`discoveredSessions.${sessionId}`) as { worktreePath?: string; repoPath?: string; sshConfig?: SSHConfig } | undefined;
      const workingDir = sessionData?.sshConfig?.remoteWorkdir || sessionData?.worktreePath || sessionData?.repoPath || process.cwd();
      const { modifiedText } = secureKeysService.interceptAndReplaceKeys(sessionId, prompt);
      const secureEnvContext = await prepareSecureEnvContext(sessionId, sessionData?.sshConfig);
      const fullPrompt = secureEnvContext ? `${secureEnvContext}\n\n${modifiedText}` : modifiedText;

      const batcher = new CodexChunkBatcher(
        sessionId,
        (content) => mainWindow.webContents.send(IPC_CHANNELS.CODEX_STREAM_CHUNK, { sessionId, content }),
        (content) => mainWindow.webContents.send(IPC_CHANNELS.CODEX_THINKING, { sessionId, content })
      );

      try {
        for await (const event of codexService.streamDirect(sessionId, fullPrompt, workingDir, sessionData?.sshConfig)) {
          switch (event.type) {
            case 'text_start':
              // Nothing to send yet, just marks the start
              break;

            case 'text_delta':
              batcher.addText(event.content || '');
              break;

            case 'thinking_start':
            case 'thinking_delta':
              batcher.addThinking(event.content || '');
              break;

            case 'tool_use':
              batcher.flush();
              mainWindow.webContents.send(IPC_CHANNELS.CODEX_TOOL_CALL, {
                sessionId,
                toolCall: event.toolCall,
              });
              break;

            case 'tool_result':
              batcher.flush();
              mainWindow.webContents.send(IPC_CHANNELS.CODEX_TOOL_CALL, {
                sessionId,
                toolCall: event.toolCall,
              });
              break;

            case 'complete':
              batcher.flush();
              mainWindow.webContents.send(IPC_CHANNELS.CODEX_COMPLETE, { sessionId });
              break;

            case 'error':
              batcher.flush();
              mainWindow.webContents.send(IPC_CHANNELS.CODEX_ERROR, {
                sessionId,
                error: event.error,
              });
              break;
          }
        }
      } catch (error) {
        batcher.flush();
        mainWindow.webContents.send(IPC_CHANNELS.CODEX_ERROR, {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.CODEX_CANCEL, async (_, sessionId: string) => {
    console.log('[Codex IPC] Cancelling Codex run for session:', sessionId);
    codexService.cancel(sessionId);
    await new Promise(resolve => setTimeout(resolve, 50));
  });
}

function getSecureEnvFilePath(sessionId: string, sshConfig?: SSHConfig): string {
  return sshConfig
    ? `/tmp/g-build-secure-env-${sessionId}.sh`
    : path.join(os.tmpdir(), `g-build-secure-env-${sessionId}.sh`);
}

function formatSecureEnvFileContent(sessionId: string): string {
  const envVars = secureKeysService.getSessionEnvVars(sessionId);
  const lines = [
    `# Temporary secure environment variables for Build session ${sessionId}`,
    ...envVars.map(({ name, value }) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`),
    '',
  ];

  return lines.join('\n');
}

async function prepareSecureEnvContext(sessionId: string, sshConfig?: SSHConfig): Promise<string | undefined> {
  const envVars = secureKeysService.getSessionEnvVars(sessionId);
  if (envVars.length === 0) {
    return undefined;
  }

  const envFilePath = getSecureEnvFilePath(sessionId, sshConfig);
  const envFileContent = formatSecureEnvFileContent(sessionId);

  if (sshConfig) {
    await sshService.writeRemoteFile(sessionId, sshConfig, envFilePath, envFileContent);
  } else {
    fs.writeFileSync(envFilePath, envFileContent, { mode: 0o600 });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch {
      // best-effort permission tightening
    }
  }

  const envVarNames = envVars.map(({ name }) => `- ${name}`).join('\n');

  return `The user provided sensitive environment variables. They are available in a temporary shell file at \`${envFilePath}\`.

Available variable names:
${envVarNames}

Read or source that file if you need the actual values. Do not print secret values into chat, logs, diffs, or committed files unless the user explicitly asks for that.`;
}
