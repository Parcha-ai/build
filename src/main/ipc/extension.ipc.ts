import { type IpcMain } from 'electron';
import { spawn } from 'child_process';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import { extensionService } from '../services/extension.service';
import { sshService } from '../services/ssh.service';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type { Session } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStore: any = new CachedStore({ name: getSessionStoreName() });
const EXTENSION_SCAN_DEBUG = process.env.GREP_DEBUG_EXTENSION_SCANS === '1';

/**
 * Get a session by ID from the store
 */
function getSession(sessionId: string): Session | null {
  const sessions = sessionStore.get('sessions') || {};
  return sessions[sessionId] || null;
}

interface SkillInstallResult {
  success: boolean;
  output: string;
  error?: string;
}

interface AvailableSkill {
  name: string;
  description?: string;
}

export function registerExtensionHandlers(ipcMain: IpcMain): void {
  // Scan for slash commands (supports SSH sessions via sessionId)
  ipcMain.handle(IPC_CHANNELS.EXTENSION_SCAN_COMMANDS, async (_event, options?: { sessionId?: string; projectPath?: string } | string) => {
    try {
      // Handle backwards compatibility - can be called with just projectPath string
      const opts = typeof options === 'string' ? { projectPath: options } : options || {};
      const { sessionId, projectPath } = opts;

      // Check if this is an SSH session
      if (sessionId) {
        const session = getSession(sessionId);
        if (session?.sshConfig) {
          if (EXTENSION_SCAN_DEBUG) console.log('[Extension IPC] Scanning commands on remote SSH session:', sessionId);
          const commands = await sshService.scanRemoteCommands(
            sessionId,
            session.sshConfig,
            session.sshConfig.remoteWorkdir
          );
          return commands;
        }
      }

      // Default to local scanning
      const commands = await extensionService.scanCommands(projectPath);
      return commands;
    } catch (error) {
      console.error('[Extension IPC] Error scanning commands:', error);
      throw error;
    }
  });

  // Scan for skills (supports SSH sessions via sessionId)
  ipcMain.handle(IPC_CHANNELS.EXTENSION_SCAN_SKILLS, async (_event, options?: { sessionId?: string; projectPath?: string } | string) => {
    try {
      // Handle backwards compatibility - can be called with just projectPath string
      const opts = typeof options === 'string' ? { projectPath: options } : options || {};
      const { sessionId, projectPath } = opts;

      // Check if this is an SSH session
      if (sessionId) {
        const session = getSession(sessionId);
        if (session?.sshConfig) {
          if (EXTENSION_SCAN_DEBUG) console.log('[Extension IPC] Scanning skills on remote SSH session:', sessionId);
          const skills = await sshService.scanRemoteSkills(
            sessionId,
            session.sshConfig,
            session.sshConfig.remoteWorkdir
          );
          return skills;
        }
      }

      // Default to local scanning
      const skills = await extensionService.scanSkills(projectPath);
      return skills;
    } catch (error) {
      console.error('[Extension IPC] Error scanning skills:', error);
      throw error;
    }
  });

  // Scan for agents (supports SSH sessions via sessionId)
  ipcMain.handle(IPC_CHANNELS.EXTENSION_SCAN_AGENTS, async (_event, options?: { sessionId?: string; projectPath?: string } | string) => {
    try {
      // Handle backwards compatibility - can be called with just projectPath string
      const opts = typeof options === 'string' ? { projectPath: options } : options || {};
      const { sessionId, projectPath } = opts;

      // Check if this is an SSH session
      if (sessionId) {
        const session = getSession(sessionId);
        if (session?.sshConfig) {
          if (EXTENSION_SCAN_DEBUG) console.log('[Extension IPC] Scanning agents on remote SSH session:', sessionId);
          const agents = await sshService.scanRemoteAgents(
            sessionId,
            session.sshConfig,
            session.sshConfig.remoteWorkdir
          );
          return agents;
        }
      }

      // Default to local scanning
      const agents = await extensionService.scanAgents(projectPath);
      return agents;
    } catch (error) {
      console.error('[Extension IPC] Error scanning agents:', error);
      throw error;
    }
  });

  // Get command content
  ipcMain.handle(IPC_CHANNELS.EXTENSION_GET_COMMAND, async (_event, commandName: string, projectPath?: string) => {
    try {
      const content = await extensionService.getCommandContent(commandName, projectPath);
      return content;
    } catch (error) {
      console.error('[Extension IPC] Error getting command content:', error);
      throw error;
    }
  });

  // Install a skill using npx skills add (supports SSH sessions via sessionId)
  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_INSTALL_SKILL,
    async (_event, source: string, options?: { global?: boolean; skills?: string[]; projectPath?: string; sessionId?: string }): Promise<SkillInstallResult> => {
      try {
        // Check if this is an SSH session
        if (options?.sessionId) {
          const session = getSession(options.sessionId);
          if (session?.sshConfig) {
            console.log('[Extension IPC] Installing skill on remote SSH session:', options.sessionId);
            const result = await sshService.installRemoteSkill(
              options.sessionId,
              session.sshConfig,
              session.sshConfig.remoteWorkdir,
              source,
              { global: options.global, skills: options.skills }
            );
            return result;
          }
        }

        // Local installation
        return new Promise((resolve) => {
          const args = ['skills', 'add', source];

          // Add --yes flag for non-interactive mode
          args.push('-y');

          // Add global flag if specified
          if (options?.global) {
            args.push('-g');
          }

          // Add specific skills if provided
          if (options?.skills && options.skills.length > 0) {
            for (const skill of options.skills) {
              args.push('--skill', skill);
            }
          }

          // Target claude-code agent
          args.push('-a', 'claude-code');

          console.log('[Extension IPC] Running: npx', args.join(' '));

          const cwd = options?.projectPath || process.cwd();
          let output = '';
          let errorOutput = '';

          const child = spawn('npx', args, {
            cwd,
            shell: process.platform === 'darwin' ? '/bin/zsh' : true,
            env: { ...process.env, FORCE_COLOR: '0' }, // Disable colors for cleaner output
          });

          child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            output += text;
            console.log('[Extension IPC] stdout:', text);
          });

          child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            errorOutput += text;
            console.log('[Extension IPC] stderr:', text);
          });

          child.on('close', (code) => {
            if (code === 0) {
              resolve({
                success: true,
                output: output || 'Skill installed successfully',
              });
            } else {
              resolve({
                success: false,
                output,
                error: errorOutput || `Process exited with code ${code}`,
              });
            }
          });

          child.on('error', (err) => {
            resolve({
              success: false,
              output: '',
              error: err.message,
            });
          });
        });
      } catch (error) {
        console.error('[Extension IPC] Error installing skill:', error);
        return {
          success: false,
          output: '',
          error: (error as Error).message,
        };
      }
    }
  );

  // List available skills from a source
  ipcMain.handle(
    IPC_CHANNELS.EXTENSION_LIST_AVAILABLE_SKILLS,
    async (_event, source: string): Promise<{ success: boolean; skills?: AvailableSkill[]; error?: string }> => {
      return new Promise((resolve) => {
        const args = ['skills', 'list', source];

        console.log('[Extension IPC] Running: npx', args.join(' '));

        let output = '';
        let errorOutput = '';

        const child = spawn('npx', args, {
          shell: process.platform === 'darwin' ? '/bin/zsh' : true,
          env: { ...process.env, FORCE_COLOR: '0' },
        });

        child.stdout?.on('data', (data: Buffer) => {
          output += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            // Parse the output to extract skill names
            // The output format varies, but typically lists skills line by line
            const lines = output.split('\n').filter(line => line.trim());
            const skills: AvailableSkill[] = [];

            for (const line of lines) {
              // Try to parse skill entries (format varies by tool version)
              // Common formats: "- skill-name: description" or just "skill-name"
              const match = line.match(/^\s*[-•]\s*(\S+)(?:\s*[-:]\s*(.*))?$/);
              if (match) {
                skills.push({
                  name: match[1],
                  description: match[2]?.trim(),
                });
              } else if (line.trim() && !line.includes('Available skills') && !line.includes('---')) {
                // Fallback: treat the whole line as a skill name
                skills.push({ name: line.trim() });
              }
            }

            resolve({
              success: true,
              skills,
            });
          } else {
            resolve({
              success: false,
              error: errorOutput || `Process exited with code ${code}`,
            });
          }
        });

        child.on('error', (err) => {
          resolve({
            success: false,
            error: err.message,
          });
        });
      });
    }
  );
}
