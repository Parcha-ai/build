import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const EXTENSION_SCAN_DEBUG = process.env.GREP_DEBUG_EXTENSION_SCANS === '1';
const EXTENSION_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

function debugExtensionScan(...args: unknown[]): void {
  if (EXTENSION_SCAN_DEBUG) console.log(...args);
}

export interface Command {
  name: string;
  path: string;
  content: string;
  description?: string;
  scope: 'user' | 'project';
}

export interface Skill {
  name: string;
  path: string;
  content: string;
  description?: string;
  scope: 'user' | 'project';
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  disallowedTools?: string[];
  model?: string;
  scope: 'user' | 'project';
}

export class ExtensionService {
  private scanCache = new Map<string, {
    expiresAt: number;
    promise: Promise<unknown>;
  }>();

  private cachedScan<T>(kind: string, projectPath: string | undefined, loader: () => Promise<T>): Promise<T> {
    const cacheKey = `${kind}:${projectPath || ''}`;
    const now = Date.now();
    const cached = this.scanCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.promise as Promise<T>;
    }

    const promise = loader().catch((error) => {
      this.scanCache.delete(cacheKey);
      throw error;
    });
    this.scanCache.set(cacheKey, {
      expiresAt: now + EXTENSION_SCAN_CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  // Only scan the project-level .claude directory for autocomplete.
  // Recursive worktree scans were causing large monorepos to block Electron's
  // main process; harness context collection has its own broader path.
  private async findClaudeDirs(rootPath: string): Promise<string[]> {
    const claudeDir = path.join(rootPath, '.claude');
    try {
      const stat = await fs.stat(claudeDir);
      return stat.isDirectory() ? [claudeDir] : [];
    } catch {
      return [];
    }
  }

  async scanCommands(projectPath?: string): Promise<Command[]> {
    return this.cachedScan('commands', projectPath, async () => {
    const commands: Command[] = [];

    // Scan user commands
    const userCommandsDir = path.join(os.homedir(), '.claude', 'commands');
    debugExtensionScan('[ExtensionService] Scanning user commands:', userCommandsDir);
    const userCommands = await this.scanCommandsRec(userCommandsDir, 'user', '');
    debugExtensionScan('[ExtensionService] Found user commands:', userCommands.length);
    commands.push(...userCommands);

    // Scan project root .claude directory.
    if (projectPath) {
      const claudeDirs = await this.findClaudeDirs(projectPath);
      debugExtensionScan('[ExtensionService] Found project .claude directories:', claudeDirs);

      for (const claudeDir of claudeDirs) {
        const commandsDir = path.join(claudeDir, 'commands');
        debugExtensionScan('[ExtensionService] Scanning project commands:', commandsDir);
        const projectCommands = await this.scanCommandsRec(commandsDir, 'project', '');
        debugExtensionScan('[ExtensionService] Found commands in', commandsDir, ':', projectCommands.length);
        commands.push(...projectCommands);
      }
    }

    debugExtensionScan('[ExtensionService] Total commands:', commands.length);
    return commands;
    });
  }

  private async scanCommandsRec(dir: string, scope: 'user' | 'project', namespace: string): Promise<Command[]> {
    const commands: Command[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const newNamespace = namespace ? `${namespace}:${entry.name}` : entry.name;
          const subCommands = await this.scanCommandsRec(fullPath, scope, newNamespace);
          commands.push(...subCommands);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const baseName = entry.name.replace('.md', '');
          const name = namespace ? `${namespace}:${baseName}` : baseName;

          const lines = content.split('\n');
          const firstLine = lines[0]?.trim();
          const description = firstLine?.startsWith('<!--') && firstLine.endsWith('-->')
            ? firstLine.replace(/^<!--\s*/, '').replace(/\s*-->$/, '')
            : undefined;

          commands.push({ name, path: fullPath, content, description, scope });
        }
      }
    } catch (err) {
      // Ignore
    }

    return commands;
  }

  async scanSkills(projectPath?: string): Promise<Skill[]> {
    return this.cachedScan('skills', projectPath, async () => {
    const skills: Skill[] = [];

    const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    debugExtensionScan('[ExtensionService] Scanning user skills:', userSkillsDir);
    const userSkills = await this.scanSkillsRec(userSkillsDir, 'user');
    debugExtensionScan('[ExtensionService] Found user skills:', userSkills.length);
    skills.push(...userSkills);

    // Scan project root .claude directory.
    if (projectPath) {
      const claudeDirs = await this.findClaudeDirs(projectPath);
      debugExtensionScan('[ExtensionService] Found project .claude directories:', claudeDirs);

      for (const claudeDir of claudeDirs) {
        const skillsDir = path.join(claudeDir, 'skills');
        debugExtensionScan('[ExtensionService] Scanning project skills:', skillsDir);
        const projectSkills = await this.scanSkillsRec(skillsDir, 'project');
        debugExtensionScan('[ExtensionService] Found skills in', skillsDir, ':', projectSkills.length);
        skills.push(...projectSkills);
      }
    }

    debugExtensionScan('[ExtensionService] Total skills:', skills.length);
    return skills;
    });
  }

  /**
   * Scan root-level skills only (user's ~/.claude/skills and project's .claude/skills)
   * This matches Claude Code's behavior - it only preloads root-level skills and
   * discovers nested skills dynamically as needed.
   */
  async scanRootSkills(projectPath?: string): Promise<Skill[]> {
    return this.cachedScan('root-skills', projectPath, async () => {
    const skills: Skill[] = [];

    // Scan user skills from ~/.claude/skills
    const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    debugExtensionScan('[ExtensionService] Scanning user root skills:', userSkillsDir);
    const userSkills = await this.scanSkillsRec(userSkillsDir, 'user');
    debugExtensionScan('[ExtensionService] Found user root skills:', userSkills.length);
    skills.push(...userSkills);

    // Scan project skills from {projectPath}/.claude/skills ONLY (not nested)
    if (projectPath) {
      const projectSkillsDir = path.join(projectPath, '.claude', 'skills');
      debugExtensionScan('[ExtensionService] Scanning project root skills:', projectSkillsDir);
      const projectSkills = await this.scanSkillsRec(projectSkillsDir, 'project');
      debugExtensionScan('[ExtensionService] Found project root skills:', projectSkills.length);
      skills.push(...projectSkills);
    }

    debugExtensionScan('[ExtensionService] Total root skills:', skills.length);
    return skills;
    });
  }

  private async scanSkillsRec(dir: string, scope: 'user' | 'project'): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Handle both directories and symlinks to directories
        const isDir = entry.isDirectory();
        const isSymlink = entry.isSymbolicLink();

        if (isDir || isSymlink) {
          const skillDir = path.join(dir, entry.name);

          // For symlinks, verify the target is a directory
          if (isSymlink) {
            try {
              const stat = await fs.stat(skillDir); // fs.stat follows symlinks
              if (!stat.isDirectory()) continue;
            } catch {
              continue; // Broken symlink or inaccessible target
            }
          }

          const skillFile = path.join(skillDir, 'SKILL.md');

          try {
            const content = await fs.readFile(skillFile, 'utf-8');
            const lines = content.split('\n');
            const firstLine = lines[0]?.trim();
            const description = firstLine?.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : undefined;

            skills.push({ name: entry.name, path: skillDir, content, description, scope });
          } catch (err) {
            const subSkills = await this.scanSkillsRec(skillDir, scope);
            skills.push(...subSkills);
          }
        }
      }
    } catch (err) {
      // Ignore
    }

    return skills;
  }

  async scanAgents(projectPath?: string): Promise<AgentDefinition[]> {
    return this.cachedScan('agents', projectPath, async () => {
    const agents: AgentDefinition[] = [];

    const userAgentsDir = path.join(os.homedir(), '.claude', 'agents');
    debugExtensionScan('[ExtensionService] Scanning user agents:', userAgentsDir);
    const userAgents = await this.scanAgentsRec(userAgentsDir, 'user');
    debugExtensionScan('[ExtensionService] Found user agents:', userAgents.length);
    agents.push(...userAgents);

    // Scan project root .claude directory.
    if (projectPath) {
      const claudeDirs = await this.findClaudeDirs(projectPath);
      debugExtensionScan('[ExtensionService] Found project .claude directories:', claudeDirs);

      for (const claudeDir of claudeDirs) {
        const agentsDir = path.join(claudeDir, 'agents');
        debugExtensionScan('[ExtensionService] Scanning project agents:', agentsDir);
        const projectAgents = await this.scanAgentsRec(agentsDir, 'project');
        debugExtensionScan('[ExtensionService] Found agents in', agentsDir, ':', projectAgents.length);
        agents.push(...projectAgents);
      }
    }

    debugExtensionScan('[ExtensionService] Total agents:', agents.length);
    return agents;
    });
  }

  private async scanAgentsRec(dir: string, scope: 'user' | 'project'): Promise<AgentDefinition[]> {
    const agents: AgentDefinition[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subAgents = await this.scanAgentsRec(fullPath, scope);
          agents.push(...subAgents);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const name = entry.name.replace('.md', '');
          const agent = this.parseAgent(content, name, scope);
          if (agent) {
            agents.push(agent);
          }
        }
      }
    } catch (err) {
      // Ignore
    }

    return agents;
  }

  private parseAgent(content: string, name: string, scope: 'user' | 'project'): AgentDefinition | null {
    const lines = content.split('\n');
    let description = '';
    let systemPrompt = '';
    let currentSection = '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('# ')) {
        currentSection = 'description';
        continue;
      } else if (trimmed.startsWith('## System Prompt') || trimmed.startsWith('## Prompt')) {
        currentSection = 'systemPrompt';
        continue;
      }

      if (currentSection === 'description' && trimmed) {
        description += trimmed + ' ';
      } else if (currentSection === 'systemPrompt') {
        systemPrompt += line + '\n';
      }
    }

    if (!description || !systemPrompt) {
      return null;
    }

    return { name, description: description.trim(), systemPrompt: systemPrompt.trim(), scope };
  }

  async getCommandContent(cmdName: string, projPath?: string): Promise<string | null> {
    const cmds = await this.scanCommands(projPath);
    for (const cmd of cmds) {
      if (cmd.name === cmdName) {
        return cmd.content;
      }
    }
    return null;
  }
}

export const extensionService = new ExtensionService();
