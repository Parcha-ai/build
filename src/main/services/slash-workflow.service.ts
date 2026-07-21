import type { Command, Session, Skill } from '../../shared/types';
import { extensionService } from './extension.service';
import { sshService } from './ssh.service';

const RESERVED_SLASH_NAMES = new Set([
  'btw',
  'cascade',
  'cascade-off',
  'codex',
  'goal',
  'loop',
  'monitor',
]);
const MAX_REFERENCED_WORKFLOWS = 48;
const MAX_REFERENCED_WORKFLOW_CHARS = 600_000;

export interface SlashWorkflowInvocation {
  name: string;
  arguments: string;
  originalMessage: string;
}

export interface SlashWorkflowDefinition {
  name: string;
  path: string;
  content: string;
  scope: 'user' | 'project';
  kind: 'command' | 'skill';
}

export interface ResolvedSlashWorkflow {
  invocation: SlashWorkflowInvocation;
  definition: SlashWorkflowDefinition;
  referencedDefinitions: SlashWorkflowDefinition[];
  prompt: string;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tokenizeArguments(value: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"'])/g, '$1'));
  }
  return tokens;
}

function applyArguments(content: string, argumentText: string): string {
  const positional = tokenizeArguments(argumentText);
  return content
    .replace(/\$\{ARGUMENTS\}|\$ARGUMENTS\b/g, argumentText)
    .replace(/\$\{(\d+)\}|\$(\d+)\b/g, (_match, bracedIndex?: string, plainIndex?: string) => {
      const index = Number(bracedIndex || plainIndex) - 1;
      return index >= 0 ? positional[index] || '' : '';
    });
}

function toDefinition(item: Command | Skill, kind: 'command' | 'skill'): SlashWorkflowDefinition {
  return {
    name: item.name,
    path: item.path,
    content: item.content,
    scope: item.scope,
    kind,
  };
}

export function parseSlashWorkflowInvocation(message: string): SlashWorkflowInvocation | null {
  const trimmed = message.trim();
  const direct = trimmed.match(/^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/);
  if (direct) {
    return {
      name: direct[1],
      arguments: (direct[2] || '').trim(),
      originalMessage: message,
    };
  }

  // Build uses this explicit form when asking a manually selected harness to
  // invoke a workflow. Keep the grammar deliberately narrow so ordinary prose
  // mentioning /commands is never rewritten behind the user's back.
  const explicit = trimmed.match(/^(?:run|use|invoke)\s+\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+(?:skill|command|workflow))?(?:\s+(?:with\s+)?([\s\S]+))?$/i);
  if (!explicit) return null;

  return {
    name: explicit[1],
    arguments: (explicit[2] || '').trim(),
    originalMessage: message,
  };
}

export function selectSlashWorkflowDefinition(
  name: string,
  commands: Command[],
  skills: Skill[],
): SlashWorkflowDefinition | null {
  const normalized = normalizeName(name);
  const selectByScope = <T extends Command | Skill>(items: T[]): T | undefined => {
    const matches = items.filter((item) => normalizeName(item.name) === normalized);
    return matches.find((item) => item.scope === 'project') || matches.find((item) => item.scope === 'user');
  };

  const command = selectByScope(commands);
  if (command) return toDefinition(command, 'command');

  const skill = selectByScope(skills);
  return skill ? toDefinition(skill, 'skill') : null;
}

function referencedWorkflowNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const referencePattern = /\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(content)) !== null) {
    const normalized = normalizeName(match[1]);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(match[1]);
    }
  }
  return names;
}

function collectReferencedDefinitions(
  root: SlashWorkflowDefinition,
  commands: Command[],
  skills: Skill[],
): SlashWorkflowDefinition[] {
  const collected: SlashWorkflowDefinition[] = [];
  const seen = new Set([normalizeName(root.name)]);
  const queue = referencedWorkflowNames(root.content);
  let totalChars = 0;

  while (queue.length > 0 && collected.length < MAX_REFERENCED_WORKFLOWS) {
    const name = queue.shift() as string;
    const normalized = normalizeName(name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const definition = selectSlashWorkflowDefinition(name, commands, skills);
    if (!definition) continue;
    if (totalChars + definition.content.length > MAX_REFERENCED_WORKFLOW_CHARS) continue;

    collected.push(definition);
    totalChars += definition.content.length;
    queue.push(...referencedWorkflowNames(definition.content));
  }

  return collected;
}

export function resolveSlashWorkflowFromDefinitions(
  message: string,
  commands: Command[],
  skills: Skill[],
): ResolvedSlashWorkflow | null {
  const invocation = parseSlashWorkflowInvocation(message);
  if (!invocation || RESERVED_SLASH_NAMES.has(normalizeName(invocation.name))) return null;

  const definition = selectSlashWorkflowDefinition(invocation.name, commands, skills);
  if (!definition) return null;

  const referencedDefinitions = collectReferencedDefinitions(definition, commands, skills);
  const rootContent = applyArguments(definition.content, invocation.arguments);
  const referencedBlocks = referencedDefinitions.map((reference) => [
    `<referenced_workflow kind="${reference.kind}" name="/${escapeAttribute(reference.name)}" scope="${reference.scope}" path="${escapeAttribute(reference.path)}">`,
    reference.content,
    '</referenced_workflow>',
  ].join('\n'));
  const argumentsBlock = invocation.arguments || '(none)';

  const prompt = [
    `<invoked_workflow kind="${definition.kind}" name="/${escapeAttribute(definition.name)}" scope="${definition.scope}" path="${escapeAttribute(definition.path)}">`,
    rootContent,
    '</invoked_workflow>',
    '',
    '<workflow_arguments>',
    argumentsBlock,
    '</workflow_arguments>',
    ...(referencedBlocks.length > 0 ? [
      '',
      '<referenced_workflow_definitions>',
      'The invoked workflow references the following installed workflows. Their exact definitions are included so this invocation behaves identically across Claude, Codex, Cursor, Gemini, OpenCode, and other harnesses.',
      ...referencedBlocks,
      '</referenced_workflow_definitions>',
    ] : []),
    '',
    'Execute the invoked workflow now. Its definition is authoritative for this turn; do not search old transcripts or substitute a similarly named workflow. Resolve any Claude custom-command dynamic context expressions such as !`command` in the active project working directory before proceeding.',
  ].join('\n');

  return {
    invocation,
    definition,
    referencedDefinitions,
    prompt,
  };
}

export class SlashWorkflowService {
  private async scanDefinitions(
    sessionId: string,
    session: Session | null,
  ): Promise<{ commands: Command[]; skills: Skill[] }> {
    if (session?.sshConfig) {
      const remoteWorkdir = session.worktreePath || session.sshConfig.remoteWorkdir || session.repoPath;
      const [commands, skills] = await Promise.all([
        sshService.scanRemoteCommands(sessionId, session.sshConfig, remoteWorkdir),
        sshService.scanRemoteSkills(sessionId, session.sshConfig, remoteWorkdir),
      ]);
      return { commands, skills };
    }

    const projectPath = session?.worktreePath || session?.repoPath;
    const [commands, skills] = await Promise.all([
      extensionService.scanCommands(projectPath),
      extensionService.scanSkills(projectPath),
    ]);
    return { commands, skills };
  }

  async resolveInvocation(
    sessionId: string,
    message: string,
    session: Session | null,
  ): Promise<ResolvedSlashWorkflow | null> {
    const invocation = parseSlashWorkflowInvocation(message);
    if (!invocation || RESERVED_SLASH_NAMES.has(normalizeName(invocation.name))) return null;

    const { commands, skills } = await this.scanDefinitions(sessionId, session);
    return resolveSlashWorkflowFromDefinitions(message, commands, skills);
  }
}

export const slashWorkflowService = new SlashWorkflowService();
