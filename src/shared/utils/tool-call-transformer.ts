import type { ToolCall } from '../types';

type ToolInput = Record<string, unknown>;
type RawToolCall = Omit<Partial<ToolCall>, 'input' | 'name' | 'status'> & {
  id: string;
  name?: string;
  input?: ToolInput;
  status?: unknown;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  agent: 'Task',
  apply_patch: 'Edit',
  ask_user_question: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  bash: 'Bash',
  bash_output: 'BashOutput',
  bashoutput: 'BashOutput',
  browser_act: 'BrowserAct',
  browser_click: 'BrowserClick',
  browser_extract: 'BrowserExtract',
  browser_get_dom: 'BrowserGetDOM',
  browser_get_info: 'BrowserGetInfo',
  browser_navigate: 'BrowserNavigate',
  browser_observe: 'BrowserObserve',
  browser_snapshot: 'BrowserSnapshot',
  browser_type: 'BrowserType',
  cat: 'Read',
  command: 'Bash',
  command_execution: 'Bash',
  create_file: 'Write',
  create_plan: 'Task',
  createplan: 'Task',
  delete: 'Delete',
  delete_file: 'Delete',
  edit: 'Edit',
  edit_file: 'Edit',
  file_read: 'Read',
  file_search: 'Grep',
  file_write: 'Write',
  generate_image: 'GenerateImage',
  generateimage: 'GenerateImage',
  glob: 'Glob',
  grep: 'Grep',
  kill_shell: 'KillShell',
  killshell: 'KillShell',
  list: 'Ls',
  list_dir: 'Ls',
  list_directory: 'Ls',
  lint: 'Lint',
  ls: 'Ls',
  mcp: 'MCP',
  mcp_browser_act: 'BrowserAct',
  mcp_browser_click: 'BrowserClick',
  mcp_browser_extract: 'BrowserExtract',
  mcp_browser_get_dom: 'BrowserGetDOM',
  mcp_browser_get_info: 'BrowserGetInfo',
  mcp_browser_navigate: 'BrowserNavigate',
  mcp_browser_observe: 'BrowserObserve',
  mcp_browser_snapshot: 'BrowserSnapshot',
  mcp_browser_type: 'BrowserType',
  mcp_browsermcp_browser_act: 'BrowserAct',
  mcp_browsermcp_browser_click: 'BrowserClick',
  mcp_browsermcp_browser_extract: 'BrowserExtract',
  mcp_browsermcp_browser_get_dom: 'BrowserGetDOM',
  mcp_browsermcp_browser_get_info: 'BrowserGetInfo',
  mcp_browsermcp_browser_navigate: 'BrowserNavigate',
  mcp_browsermcp_browser_observe: 'BrowserObserve',
  mcp_browsermcp_browser_snapshot: 'BrowserSnapshot',
  mcp_browsermcp_browser_type: 'BrowserType',
  monitor: 'Monitor',
  plan: 'Task',
  read: 'Read',
  read_file: 'Read',
  read_lints: 'Lint',
  readlints: 'Lint',
  readfile: 'Read',
  record_screen: 'RecordScreen',
  recordscreen: 'RecordScreen',
  ripgrep: 'Grep',
  run_command: 'Bash',
  search: 'Grep',
  search_files: 'Grep',
  shell: 'Bash',
  skill: 'Skill',
  task: 'Task',
  tool_search: 'ToolSearch',
  toolsearch: 'ToolSearch',
  todos: 'TodoWrite',
  todo_write: 'TodoWrite',
  update_topic: 'UpdateTopic',
  update_todos: 'TodoWrite',
  updatetodos: 'TodoWrite',
  write: 'Write',
  write_file: 'Write',
  writefile: 'Write',
};

function getString(input: ToolInput, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function getArray(input: ToolInput, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = input[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function normalizeAliasKey(name: string): string {
  return name.trim().replace(/[\s.-]+/g, '_').toLowerCase();
}

function stripProviderPrefix(name: string): { baseName: string; providerPrefix?: string } {
  if (name.includes('__')) {
    const parts = name.split('__').filter(Boolean);
    return {
      baseName: parts[parts.length - 1] || name,
      providerPrefix: parts.length > 1 ? parts.slice(0, -1).join('__') : undefined,
    };
  }

  if (name.startsWith('MCP:')) {
    const parts = name.split(':');
    return {
      baseName: parts[parts.length - 1] || name,
      providerPrefix: parts.length > 2 ? parts.slice(0, -1).join(':') : 'MCP',
    };
  }

  return { baseName: name };
}

export function normalizeToolName(rawName: string | undefined): string {
  if (!rawName) return 'Tool';
  const { baseName, providerPrefix } = stripProviderPrefix(rawName);
  if (providerPrefix && normalizeAliasKey(providerPrefix).startsWith('mcp')) {
    return 'MCP';
  }
  const aliasKey = normalizeAliasKey(baseName);
  return TOOL_NAME_ALIASES[aliasKey] || TOOL_NAME_ALIASES[baseName] || baseName;
}

export function isTranscriptVisibleToolName(rawName: string | undefined): boolean {
  return normalizeToolName(rawName) !== 'AskUserQuestion';
}

export function isTranscriptVisibleToolCall(toolCall: Pick<ToolCall, 'name'> | undefined): boolean {
  return isTranscriptVisibleToolName(toolCall?.name);
}

function withOriginalToolMetadata(input: ToolInput, rawName: string | undefined, normalizedName: string): ToolInput {
  if (!rawName) return input;
  const { baseName, providerPrefix } = stripProviderPrefix(rawName);
  const metadata: ToolInput = {};
  if (rawName !== normalizedName) {
    metadata._rawToolName = rawName;
  }
  if (normalizedName === 'MCP' && providerPrefix) {
    metadata.server = input.server || providerPrefix.replace(/^mcp[:_]+/i, '');
    metadata.tool = input.tool || baseName;
  }
  if (Object.keys(metadata).length === 0) return input;
  return {
    ...input,
    ...metadata,
  };
}

function normalizeToolInput(toolName: string, input: ToolInput): ToolInput {
  const next = { ...input };
  const filePath = getString(input, ['file_path', 'path', 'file', 'filepath', 'absolute_path', 'target_file']);

  switch (toolName) {
    case 'Bash': {
      const command = getString(input, ['command', 'cmd', 'script', 'shell_command']);
      const description = getString(input, ['description', 'summary']);
      return {
        ...next,
        ...(command ? { command } : {}),
        ...(description ? { description } : {}),
      };
    }
    case 'Read':
      return {
        ...next,
        ...(filePath ? { file_path: filePath } : {}),
      };
    case 'Write': {
      const content = getString(input, ['content', 'text', 'data']);
      return {
        ...next,
        ...(filePath ? { file_path: filePath } : {}),
        ...(content ? { content } : {}),
      };
    }
    case 'Edit': {
      const oldString = getString(input, ['old_string', 'oldText', 'old_text', 'old', 'find']);
      const newString = getString(input, ['new_string', 'newText', 'new_text', 'replacement', 'replace']);
      return {
        ...next,
        ...(filePath ? { file_path: filePath } : {}),
        ...(oldString ? { old_string: oldString } : {}),
        ...(newString ? { new_string: newString } : {}),
      };
    }
    case 'Glob': {
      const pattern = getString(input, ['pattern', 'glob', 'glob_pattern', 'query']);
      const path = getString(input, ['path', 'target_directory', 'directory', 'cwd']);
      return {
        ...next,
        ...(pattern ? { pattern } : {}),
        ...(path || filePath ? { path: path || filePath } : {}),
      };
    }
    case 'Grep': {
      const pattern = getString(input, ['pattern', 'query', 'search', 'regex']);
      return {
        ...next,
        ...(pattern ? { pattern } : {}),
        ...(filePath ? { path: filePath } : {}),
      };
    }
    case 'Ls':
      return {
        ...next,
        ...(filePath ? { path: filePath } : {}),
      };
    case 'Delete':
      return {
        ...next,
        ...(filePath ? { file_path: filePath } : {}),
      };
    case 'TodoWrite': {
      const todos = getArray(input, ['todos', 'items', 'tasks']);
      return {
        ...next,
        ...(todos ? { todos } : {}),
      };
    }
    case 'UpdateTopic': {
      const topic = getString(input, ['topic', 'title', 'subject', 'summary', 'message']);
      return {
        ...next,
        ...(topic ? { topic } : {}),
      };
    }
    case 'ToolSearch': {
      const query = getString(input, ['query', 'q', 'search']);
      return {
        ...next,
        ...(query ? { query } : {}),
      };
    }
    case 'Skill': {
      const skill = getString(input, ['skill', 'name', 'id']);
      return {
        ...next,
        ...(skill ? { skill } : {}),
      };
    }
    case 'Monitor': {
      const task = getString(input, ['task', 'description', 'summary']);
      return {
        ...next,
        ...(task ? { task } : {}),
      };
    }
    default:
      return next;
  }
}

function normalizeToolStatus(status: unknown): ToolCall['status'] {
  switch (String(status || '').toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'error':
    case 'failed':
    case 'failure':
      return 'error';
    case 'pending':
    case 'queued':
      return 'pending';
    case 'running':
    case 'in_progress':
    case 'started':
      return 'running';
    default:
      return 'running';
  }
}

export function normalizeToolCall<T extends RawToolCall>(toolCall: T): T & Pick<ToolCall, 'name' | 'input' | 'status'> {
  const normalizedName = normalizeToolName(toolCall.name);
  const normalizedInput = withOriginalToolMetadata(
    normalizeToolInput(normalizedName, toolCall.input || {}),
    toolCall.name,
    normalizedName,
  );
  return {
    ...toolCall,
    name: normalizedName,
    input: normalizedInput,
    status: normalizeToolStatus(toolCall.status),
  };
}
