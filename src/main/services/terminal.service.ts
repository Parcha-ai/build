import * as pty from 'node-pty';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { ClientChannel } from 'ssh2';
import { getSessionStoreName } from '../store-names';
import { DockerService } from './docker.service';
import { sshService } from './ssh.service';
import type { Session, SSHConfig } from '../../shared/types';

interface LocalTerminal {
  type: 'local' | 'docker';
  id: string;
  sessionId: string;
  ptyProcess: pty.IPty;
  outputListeners: Set<(data: string) => void>;
}

interface SSHTerminal {
  type: 'ssh';
  id: string;
  sessionId: string;
  channel: ClientChannel;
  outputListeners: Set<(data: string) => void>;
}

type Terminal = LocalTerminal | SSHTerminal;

export class TerminalService {
  private terminals: Map<string, Terminal> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private dockerService: DockerService;

  constructor() {
    this.store = new CachedStore({ name: getSessionStoreName() }) as any;
    this.dockerService = new DockerService();
  }

  private getSession(sessionId: string): Session | undefined {
    return (
      this.store.get(`sessions.${sessionId}`) ||
      this.store.get(`discoveredSessions.${sessionId}`)
    ) as Session | undefined;
  }

  async createTerminal(sessionId: string): Promise<string> {
    const session = this.getSession(sessionId);
    console.log('Creating terminal for session:', sessionId);
    console.log('Session data:', JSON.stringify(session, null, 2));

    if (!session) throw new Error(`Session ${sessionId} not found`);

    const terminalId = uuid();

    // Check for SSH session first
    if (session.sshConfig) {
      return this.createSSHTerminal(terminalId, sessionId, session.sshConfig);
    }

    // Docker or local terminal
    let ptyProcess: pty.IPty;

    if (session.containerId) {
      // Attach to Docker container
      ptyProcess = pty.spawn('docker', ['exec', '-it', session.containerId, '/bin/bash'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME || '/',
        env: process.env as { [key: string]: string },
      });
    } else {
      // Local terminal in worktree
      const shell = process.platform === 'win32'
        ? 'powershell.exe'
        : process.env.SHELL || '/bin/zsh'; // Use user's shell or fallback to zsh on macOS

      const cwd = session.worktreePath && fs.existsSync(session.worktreePath)
        ? session.worktreePath
        : session.repoPath && fs.existsSync(session.repoPath)
          ? session.repoPath
          : process.env.HOME || '/';

      if (cwd !== session.worktreePath) {
        console.warn(`Working directory no longer exists: ${session.worktreePath}, falling back to: ${cwd}`);
      }

      console.log('Spawning shell:', shell);
      console.log('Working directory:', cwd);
      console.log('Platform:', process.platform);

      try {
        ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: {
            ...process.env as { [key: string]: string },
            TERM: 'xterm-256color',
          },
        });
      } catch (err) {
        console.error('PTY spawn error:', err);
        throw err;
      }
    }

    const terminal: LocalTerminal = {
      type: session.containerId ? 'docker' : 'local',
      id: terminalId,
      sessionId,
      ptyProcess,
      outputListeners: new Set(),
    };

    // Handle output
    ptyProcess.onData((data) => {
      terminal.outputListeners.forEach(listener => listener(data));
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
      this.terminals.delete(terminalId);
    });

    this.terminals.set(terminalId, terminal);
    return terminalId;
  }

  private async createSSHTerminal(terminalId: string, sessionId: string, sshConfig: SSHConfig): Promise<string> {
    console.log('[Terminal] Creating SSH terminal for session:', sessionId);
    console.log('[Terminal] SSH config:', { host: sshConfig.host, remoteWorkdir: sshConfig.remoteWorkdir });

    try {
      // Create SSH shell channel
      const channel = await sshService.createShell(sessionId, sshConfig);

      const terminal: SSHTerminal = {
        type: 'ssh',
        id: terminalId,
        sessionId,
        channel,
        outputListeners: new Set(),
      };

      // Handle output from SSH channel
      channel.on('data', (data: Buffer) => {
        const str = data.toString();
        terminal.outputListeners.forEach(listener => listener(str));
      });

      // Handle stderr
      channel.stderr.on('data', (data: Buffer) => {
        const str = data.toString();
        terminal.outputListeners.forEach(listener => listener(str));
      });

      // Handle close
      channel.on('close', () => {
        console.log(`[Terminal] SSH terminal ${terminalId} closed`);
        this.terminals.delete(terminalId);
      });

      // Handle errors
      channel.on('error', (err: Error) => {
        console.error(`[Terminal] SSH terminal ${terminalId} error:`, err);
        terminal.outputListeners.forEach(listener =>
          listener(`\r\n\x1b[31mSSH Error: ${err.message}\x1b[0m\r\n`)
        );
      });

      this.terminals.set(terminalId, terminal);
      return terminalId;
    } catch (error) {
      console.error('[Terminal] Failed to create SSH terminal:', error);
      throw error;
    }
  }

  write(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal ${terminalId} not found`);

    if (terminal.type === 'ssh') {
      (terminal as SSHTerminal).channel.write(data);
    } else {
      (terminal as LocalTerminal).ptyProcess.write(data);
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (terminal.type === 'ssh') {
      sshService.resizeShell((terminal as SSHTerminal).channel, cols, rows);
    } else {
      (terminal as LocalTerminal).ptyProcess.resize(cols, rows);
    }
  }

  onOutput(terminalId: string, callback: (data: string) => void): () => void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal ${terminalId} not found`);

    terminal.outputListeners.add(callback);

    return () => {
      terminal.outputListeners.delete(callback);
    };
  }

  closeTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (terminal.type === 'ssh') {
      try {
        (terminal as SSHTerminal).channel.close();
      } catch (error) {
        console.error('[Terminal] Error closing SSH channel:', error);
      }
    } else {
      (terminal as LocalTerminal).ptyProcess.kill();
    }
    this.terminals.delete(terminalId);
  }

  closeAllTerminalsForSession(sessionId: string): void {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.sessionId === sessionId) {
        this.closeTerminal(terminalId);
      }
    }
  }
}
