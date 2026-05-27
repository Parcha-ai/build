import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage, Harness } from '../../shared/types';
import { contentBlockSignature, isCloseTimelineDuplicate, toolSignature } from '../../shared/utils/message-recovery';

const MAX_ASSISTANT_CHARS = 2000;
const MAX_TOOL_INPUT_CHARS = 100;

// Cross-harness context: generous limits for 100K token budget (~400K chars)
const CROSS_HARNESS_ASSISTANT_CHARS = 20000;
const CROSS_HARNESS_MAX_CHARS = 400000;
const PROJECT_CONTEXT_MAX_CHARS = 120000;
const PROJECT_CONTEXT_FILE_MAX_CHARS = 18000;
const SKILL_CONTEXT_FILE_MAX_CHARS = 8000;
const MAX_PROJECT_CONTEXT_FILES = 48;
const AUTO_BUILD_SECTION_MARKERS = ['\n\n---\n\nFollow-up ', '\n\n---\n\nAuto Build '];

export interface ProjectInstructionContextFile {
  label: string;
  filePath: string;
  content: string;
}

interface UnifiedHarnessContextOptions {
  messages: ChatMessage[];
  supplemental?: ChatMessage[];
  currentHarness?: Harness;
  projectPath?: string;
  additionalProjectContext?: string;
  orchestrationContext?: string;
  handoffReferences?: string[];
  memoriesContext?: string;
  includeProjectContext?: boolean;
  maxConversationChars?: number;
  maxProjectContextChars?: number;
  maxProjectContextFiles?: number;
}

interface ProjectInstructionContextOptions {
  maxChars?: number;
  maxFiles?: number;
}

function normalizeChatMessageTimestamp(message: ChatMessage): ChatMessage {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  return {
    ...message,
    timestamp,
  };
}

function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const aTime = normalizeChatMessageTimestamp(a).timestamp.getTime();
  const bTime = normalizeChatMessageTimestamp(b).timestamp.getTime();
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  const roleOrder = { system: 0, user: 1, assistant: 2 };
  const roleDelta = roleOrder[a.role] - roleOrder[b.role];
  if (roleDelta !== 0) {
    return roleDelta;
  }

  return a.id.localeCompare(b.id);
}

function buildMessageFingerprint(message: ChatMessage): string {
  const normalized = normalizeChatMessageTimestamp(message);

  return [
    normalized.role,
    normalized.harness || '',
    normalized.timestamp.getTime(),
    normalized.content,
    toolSignature(normalized),
    contentBlockSignature(normalized),
    normalized.interrupted ? '1' : '0',
  ].join('::');
}

function normalizeContentForCompare(content?: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isCloseExactDuplicate(a: ChatMessage, b: ChatMessage): boolean {
  return isCloseTimelineDuplicate(
    normalizeChatMessageTimestamp(a),
    normalizeChatMessageTimestamp(b),
  );
}

function isAutoBuildAssistantMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && AUTO_BUILD_SECTION_MARKERS.some((marker) =>
    (message.content || '').includes(marker)
  );
}

function isAutoBuildSuperset(base: ChatMessage, candidate: ChatMessage): boolean {
  if (base.role !== 'assistant' || !isAutoBuildAssistantMessage(candidate)) return false;

  const baseContent = normalizeContentForCompare(base.content);
  const candidateContent = normalizeContentForCompare(candidate.content);
  return baseContent.length > 0 && candidateContent.startsWith(baseContent);
}

export function mergeConversationMessages(primary: ChatMessage[], supplemental: ChatMessage[]): ChatMessage[] {
  const normalizedPrimary = primary.map(normalizeChatMessageTimestamp);
  const normalizedSupplemental = supplemental.map(normalizeChatMessageTimestamp);
  const autoBuildSupplemental = normalizedSupplemental.filter(isAutoBuildAssistantMessage);

  const filteredPrimary = normalizedPrimary.filter((message) => {
    if (autoBuildSupplemental.some((candidate) => isAutoBuildSuperset(message, candidate))) {
      return false;
    }
    return true;
  });

  const filteredSupplemental = normalizedSupplemental.filter((message) => {
    if (isAutoBuildAssistantMessage(message)) return true;
    return !normalizedPrimary.some((primaryMessage) => isCloseExactDuplicate(primaryMessage, message));
  });

  const merged = [...filteredPrimary, ...filteredSupplemental]
    .map(normalizeChatMessageTimestamp)
    .sort(compareChatMessages);

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: ChatMessage[] = [];

  for (const message of merged) {
    if (seenIds.has(message.id)) {
      continue;
    }

    const fingerprint = buildMessageFingerprint(message);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    seenIds.add(message.id);
    seenFingerprints.add(fingerprint);
    deduped.push(message);
  }

  return deduped;
}

function contentBlockText(message: ChatMessage): string {
  return (message.contentBlocks || [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text || '')
    .join('');
}

function messageContentForContext(message: ChatMessage): string {
  const content = message.content || '';
  if (content.trim()) return content;
  return contentBlockText(message);
}

function compressMissingToolBlockRefs(message: ChatMessage): string {
  const knownToolIds = new Set((message.toolCalls || []).map((toolCall) => toolCall.id));
  const missingRefs = (message.contentBlocks || [])
    .filter((block) => block.type === 'tool_use' && block.toolCallId && !knownToolIds.has(block.toolCallId))
    .map((block) => block.toolCallId as string);

  if (missingRefs.length === 0) return '';
  if (missingRefs.length <= 6) {
    return `[Tool refs without metadata: ${missingRefs.join(', ')}]`;
  }
  return `[Tool refs without metadata (${missingRefs.length}): ${missingRefs.slice(0, 4).join(', ')}, ... ${missingRefs.slice(-2).join(', ')}]`;
}

/**
 * Format conversation history into a structured context block for Codex.
 * Builds from newest messages backward within the character budget,
 * then reverses to chronological order.
 */
export function formatConversationContext(messages: ChatMessage[], budgetChars: number): string {
  if (!messages || messages.length === 0) return '';

  const formatted: string[] = [];
  let totalChars = 0;

  // Iterate newest-first so we prioritise recent context
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.role.toUpperCase();

    // Format message content
    let content = messageContentForContext(msg);
    if ((msg.role === 'assistant' || msg.role === 'system') && content.length > MAX_ASSISTANT_CHARS) {
      content = content.substring(0, MAX_ASSISTANT_CHARS) + '\n[...truncated]';
    }

    // Summarise tool calls (name + truncated input, skip results — they're huge)
    let toolSummary = '';
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const summaries = msg.toolCalls.map(tc => {
        let inputStr = '';
        if (tc.input) {
          if (tc.input.command) {
            inputStr = String(tc.input.command);
          } else if (tc.input.file_path) {
            inputStr = String(tc.input.file_path);
          } else {
            inputStr = JSON.stringify(tc.input);
          }
          if (inputStr.length > MAX_TOOL_INPUT_CHARS) {
            inputStr = inputStr.substring(0, MAX_TOOL_INPUT_CHARS) + '...';
          }
        }
        return `  [${tc.name}] ${inputStr}`;
      });
      toolSummary = '\n' + summaries.join('\n');
    }
    const missingToolRefs = compressMissingToolBlockRefs(msg);
    if (missingToolRefs) {
      toolSummary += `\n${missingToolRefs}`;
    }

    const block = `### ${role}\n${content}${toolSummary}\n`;

    // Check budget
    if (totalChars + block.length > budgetChars) break;

    formatted.push(block);
    totalChars += block.length;
  }

  if (formatted.length === 0) return '';

  // Reverse to chronological order
  formatted.reverse();

  return `<conversation_history>
The following is the recent conversation history from this coding session.
Some of these turns may have been produced by Claude, Codex, Cursor, Gemini, OpenCode, or another harness.
Use this context to understand what has been discussed and decided.

${formatted.join('\n')}
</conversation_history>

`;
}

function shouldSkipContextDir(name: string): boolean {
  return [
    '.git',
    'node_modules',
    '.webpack',
    'out',
    'dist',
    'build',
    'coverage',
    '.claudette-worktrees',
    'worktrees',
  ].includes(name);
}

function displayPath(filePath: string): string {
  const home = os.homedir();
  if (filePath === home) return '~';
  if (filePath.startsWith(home + path.sep)) {
    return `~${path.sep}${path.relative(home, filePath)}`;
  }
  return filePath;
}

function readContextFile(filePath: string, label: string, maxChars: number): ProjectInstructionContextFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    let content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n[...truncated]`;
    }

    return { label, filePath, content };
  } catch {
    return null;
  }
}

function collectNamedMarkdownFiles(root: string, names: Set<string>, maxDepth: number, limit: number): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (results.length >= limit || depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name) && !seen.has(fullPath)) {
        results.push(fullPath);
        seen.add(fullPath);
      }
    }

    for (const entry of entries) {
      if (results.length >= limit) break;
      if (!entry.isDirectory() || shouldSkipContextDir(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return results;
}

function collectFilesByPredicate(root: string, predicate: (fileName: string) => boolean, maxFiles: number): string[] {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipContextDir(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && predicate(entry.name)) {
        results.push(fullPath);
        if (results.length >= maxFiles) break;
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function addUniqueContextFile(files: ProjectInstructionContextFile[], seen: Set<string>, file: ProjectInstructionContextFile | null): void {
  if (!file) return;
  const key = path.resolve(file.filePath);
  if (seen.has(key)) return;
  seen.add(key);
  files.push(file);
}

export function buildProjectInstructionContext(projectPath?: string, options: ProjectInstructionContextOptions = {}): string {
  const files: ProjectInstructionContextFile[] = [];
  const seen = new Set<string>();
  const instructionNames = new Set(['CLAUDE.md', 'AGENTS.md', 'AGENT.md']);

  const addInstructionFile = (filePath: string, scope: string) => {
    addUniqueContextFile(
      files,
      seen,
      readContextFile(filePath, `${scope}: ${path.basename(filePath)}`, PROJECT_CONTEXT_FILE_MAX_CHARS),
    );
  };

  if (projectPath && fs.existsSync(projectPath)) {
    const projectRoot = path.resolve(projectPath);
    for (const filePath of collectNamedMarkdownFiles(projectRoot, instructionNames, 3, 24)) {
      const relative = path.relative(projectRoot, filePath) || path.basename(filePath);
      addInstructionFile(filePath, `project ${relative}`);
    }

    for (const filePath of [
      path.join(projectRoot, '.cursorrules'),
      path.join(projectRoot, '.windsurfrules'),
      path.join(projectRoot, '.github', 'copilot-instructions.md'),
    ]) {
      const relative = path.relative(projectRoot, filePath) || path.basename(filePath);
      addInstructionFile(filePath, `project ${relative}`);
    }

    const projectCursorRulesDir = path.join(projectRoot, '.cursor', 'rules');
    for (const filePath of collectFilesByPredicate(projectCursorRulesDir, (name) => name.endsWith('.md') || name.endsWith('.mdc'), 18)) {
      const relative = path.relative(projectRoot, filePath);
      addUniqueContextFile(files, seen, readContextFile(filePath, `project cursor rule: ${relative}`, PROJECT_CONTEXT_FILE_MAX_CHARS));
    }

    const projectAgentsDir = path.join(projectRoot, '.claude', 'agents');
    for (const filePath of collectFilesByPredicate(projectAgentsDir, (name) => name.endsWith('.md'), 12)) {
      addUniqueContextFile(files, seen, readContextFile(filePath, `project agent: ${path.basename(filePath)}`, PROJECT_CONTEXT_FILE_MAX_CHARS));
    }

    const projectCommandsDir = path.join(projectRoot, '.claude', 'commands');
    for (const filePath of collectFilesByPredicate(projectCommandsDir, (name) => name.endsWith('.md'), 16)) {
      const relative = path.relative(projectCommandsDir, filePath);
      addUniqueContextFile(files, seen, readContextFile(filePath, `project command: ${relative}`, PROJECT_CONTEXT_FILE_MAX_CHARS));
    }

    const projectSkillsDir = path.join(projectRoot, '.claude', 'skills');
    for (const filePath of collectFilesByPredicate(projectSkillsDir, (name) => name === 'SKILL.md', 18)) {
      const skillName = path.basename(path.dirname(filePath));
      addUniqueContextFile(files, seen, readContextFile(filePath, `project skill: ${skillName}`, SKILL_CONTEXT_FILE_MAX_CHARS));
    }
  }

  const userClaudeDir = path.join(os.homedir(), '.claude');
  addUniqueContextFile(files, seen, readContextFile(path.join(userClaudeDir, 'CLAUDE.md'), 'user CLAUDE.md', PROJECT_CONTEXT_FILE_MAX_CHARS));

  const userAgentsDir = path.join(userClaudeDir, 'agents');
  for (const filePath of collectFilesByPredicate(userAgentsDir, (name) => name.endsWith('.md'), 8)) {
    addUniqueContextFile(files, seen, readContextFile(filePath, `user agent: ${path.basename(filePath)}`, PROJECT_CONTEXT_FILE_MAX_CHARS));
  }

  const userCommandsDir = path.join(userClaudeDir, 'commands');
  for (const filePath of collectFilesByPredicate(userCommandsDir, (name) => name.endsWith('.md'), 8)) {
    const relative = path.relative(userCommandsDir, filePath);
    addUniqueContextFile(files, seen, readContextFile(filePath, `user command: ${relative}`, PROJECT_CONTEXT_FILE_MAX_CHARS));
  }

  const userSkillsDir = path.join(userClaudeDir, 'skills');
  for (const filePath of collectFilesByPredicate(userSkillsDir, (name) => name === 'SKILL.md', 12)) {
    const skillName = path.basename(path.dirname(filePath));
    addUniqueContextFile(files, seen, readContextFile(filePath, `user skill: ${skillName}`, SKILL_CONTEXT_FILE_MAX_CHARS));
  }

  return formatProjectInstructionContextFiles(files, options);
}

export function formatProjectInstructionContextFiles(files: ProjectInstructionContextFile[], options: ProjectInstructionContextOptions = {}): string {
  if (files.length === 0) return '';

  const blocks: string[] = [];
  let totalChars = 0;
  const maxFiles = options.maxFiles ?? MAX_PROJECT_CONTEXT_FILES;
  const maxTotalChars = options.maxChars ?? PROJECT_CONTEXT_MAX_CHARS;
  for (const file of files.slice(0, maxFiles)) {
    let content = (file.content || '').trim();
    if (!content) continue;
    const maxChars = file.label.includes('skill') ? SKILL_CONTEXT_FILE_MAX_CHARS : PROJECT_CONTEXT_FILE_MAX_CHARS;
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n[...truncated]`;
    }
    const block = `### ${file.label}\nPath: ${displayPath(file.filePath)}\n\n${content}\n`;
    if (totalChars + block.length > maxTotalChars) break;
    blocks.push(block);
    totalChars += block.length;
  }

  if (blocks.length === 0) return '';

  return `<project_harness_context>
  Build injected the following project and user instructions so this harness has
  the same operating context Claude Code, Codex, Cursor, and other coding
  harnesses would normally discover. Treat nearer project instructions as higher
  priority than user-level agents, commands, or skills.

${blocks.join('\n')}
</project_harness_context>`;
}

/**
 * Compress tool calls into a concise summary line.
 * Instead of full input/output, just show what was done:
 *   "Ran 5 tools: Bash(npm install), Read(package.json), Edit(src/index.ts), Bash(npm test), Write(config.json)"
 */
function compressToolCalls(toolCalls: ChatMessage['toolCalls']): string {
  if (!toolCalls || toolCalls.length === 0) return '';

  const summaries = toolCalls.map(tc => {
    let shortArg = '';
    if (tc.input) {
      if (tc.input.command) {
        shortArg = String(tc.input.command).split('\n')[0].substring(0, 60);
      } else if (tc.input.file_path) {
        shortArg = String(tc.input.file_path).split('/').slice(-2).join('/');
      } else if (tc.input.query) {
        shortArg = String(tc.input.query).substring(0, 40);
      }
    }
    const failed = tc.status === 'error' ? ' FAILED' : '';
    return shortArg ? `${tc.name}(${shortArg})${failed}` : `${tc.name}${failed}`;
  });

  if (summaries.length <= 6) {
    return `[Tools: ${summaries.join(', ')}]`;
  }
  return `[Tools (${summaries.length}): ${summaries.slice(0, 4).join(', ')}, ... ${summaries.slice(-2).join(', ')}]`;
}

/**
 * Build rich transcript context for cross-harness continuity.
 * When switching between Claude, Cursor, Codex, etc., this provides
 * the new harness with conversation history from OTHER harnesses.
 * Messages from the current harness are excluded — it already has those.
 * Tool calls are compressed to one-line summaries.
 */
export function buildCrossHarnessContext(
  messages: ChatMessage[],
  supplemental: ChatMessage[] = [],
  currentHarness?: Harness,
  maxChars = CROSS_HARNESS_MAX_CHARS,
): string {
  const merged = mergeConversationMessages(messages, supplemental);
  if (merged.length === 0) return '';

  // Filter out messages from the current harness — it already has its own context
  const crossHarnessMessages = currentHarness
    ? merged.filter(msg => !msg.harness || msg.harness !== currentHarness)
    : merged;

  if (crossHarnessMessages.length === 0) return '';

  const formatted: string[] = [];
  let totalChars = 0;

  for (let i = crossHarnessMessages.length - 1; i >= 0; i--) {
    const msg = crossHarnessMessages[i];
    const role = msg.role.toUpperCase();

    let content = messageContentForContext(msg);
    if ((msg.role === 'assistant' || msg.role === 'system') && content.length > CROSS_HARNESS_ASSISTANT_CHARS) {
      content = content.substring(0, CROSS_HARNESS_ASSISTANT_CHARS) + '\n[...truncated]';
    }

    const toolLine = compressToolCalls(msg.toolCalls);
    const missingToolRefs = compressMissingToolBlockRefs(msg);
    const toolLines = [toolLine, missingToolRefs].filter(Boolean).join('\n');
    const block = toolLines
      ? `### ${role}\n${content}\n${toolLines}\n`
      : `### ${role}\n${content}\n`;

    if (totalChars + block.length > maxChars) break;

    formatted.push(block);
    totalChars += block.length;
  }

  if (formatted.length === 0) return '';
  formatted.reverse();

  return `<conversation_history>
You are continuing an existing coding session. The conversation below was produced
by one or more AI coding agents (Claude, Codex, Cursor, Gemini, OpenCode, or others). Treat it as
your own prior context — continue seamlessly from where it left off.

${formatted.join('\n')}
</conversation_history>`;
}

function formatHandoffReferences(references: string[]): string {
  const lines = Array.from(new Set(references.map((reference) => reference.trim()).filter(Boolean)));
  if (lines.length === 0) return '';

  return `<handoff_references>
Context transfer between coding agents is expensive. Prefer these artifact
references and focused search/read operations over asking for broad copied
history.

${lines.map((reference) => `- ${reference}`).join('\n')}
</handoff_references>`;
}

export function buildUnifiedHarnessContext(options: UnifiedHarnessContextOptions): string {
  const blocks: string[] = [];

  if (options.orchestrationContext?.trim()) {
    blocks.push(`<turn_scope>
${options.orchestrationContext.trim()}
</turn_scope>`);
  }

  const handoffReferenceContext = formatHandoffReferences(options.handoffReferences || []);
  if (handoffReferenceContext) {
    blocks.push(handoffReferenceContext);
  }

  const conversationContext = buildCrossHarnessContext(
    options.messages,
    options.supplemental || [],
    options.currentHarness,
    options.maxConversationChars,
  );
  if (conversationContext) {
    blocks.push(conversationContext);
  }

  if (options.memoriesContext?.trim()) {
    blocks.push(`<memory_context>
${options.memoriesContext.trim()}
</memory_context>`);
  }

  if (options.additionalProjectContext?.trim()) {
    blocks.push(options.additionalProjectContext.trim());
  }

  if (options.includeProjectContext !== false) {
    const projectContext = buildProjectInstructionContext(options.projectPath, {
      maxChars: options.maxProjectContextChars,
      maxFiles: options.maxProjectContextFiles,
    });
    if (projectContext) {
      blocks.push(projectContext);
    }
  }

  return blocks.join('\n\n');
}
