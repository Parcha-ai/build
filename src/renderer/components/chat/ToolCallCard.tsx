import React, { useState, useMemo } from 'react';
import { Terminal, FileText, Search, FolderOpen, Play, Edit2, Globe, Code, HelpCircle, ListTodo, Loader2, ChevronRight, ChevronDown, CheckCircle2, Circle, Clock, ExternalLink, ListPlus, ListChecks, FileSearch, List, ArrowUpRight, Check, X } from 'lucide-react';
import { LazyMonacoEditor, LazyDiffEditor } from './LazyMonacoEditor';
import type { ToolCall } from '../../../shared/types';
import { isTranscriptVisibleToolCall, normalizeToolCall } from '../../../shared/utils/tool-call-transformer';
import { extractContentBlockText } from '../../../shared/utils/content-block-text';
import { useEditorStore } from '../../stores/editor.store';

interface ToolCallCardProps {
  toolCall: ToolCall;
  isLatest?: boolean; // If true, expand by default
  isLatestToolCall?: boolean; // Alias for isLatest
  isStreaming?: boolean; // If currently streaming
  defaultCollapsed?: boolean; // If true, start collapsed (for old messages to improve performance)
  onBackground?: (toolCall: ToolCall) => void; // Callback to background a running Bash command
  /** 'card' (default) = standalone bordered card; 'row' = compact 28px borderless row used inside ToolRunGroup */
  variant?: 'card' | 'row';
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface EditChange {
  kind: string;
  path: string;
  diff?: string;
}

function getEditChanges(input: Record<string, unknown>): EditChange[] {
  if (!Array.isArray(input.changes)) return [];
  return input.changes.flatMap((rawChange) => {
    if (!rawChange || typeof rawChange !== 'object') return [];
    const change = rawChange as Record<string, unknown>;
    if (typeof change.path !== 'string' || !change.path) return [];
    return [{
      kind: typeof change.kind === 'string' ? change.kind : 'update',
      path: change.path,
      ...(typeof change.diff === 'string' && change.diff ? { diff: change.diff } : {}),
    }];
  });
}

// Map tool names to icons and labels
const TOOL_CONFIG: Record<string, {
  icon: React.ElementType;
  label: string;
  color: string;
  bgGradient?: string;  // Optional background gradient for special tools
  borderColor?: string; // Optional border color
  iconSize?: number;    // Optional icon size override
}> = {
  Bash: { icon: Terminal, label: 'Bash', color: 'text-fg-3' },
  Command: { icon: Terminal, label: 'Command', color: 'text-fg-3' },
  BashOutput: { icon: Terminal, label: 'Bash Output', color: 'text-fg-3' },
  KillShell: { icon: Terminal, label: 'Kill Shell', color: 'text-fg-3' },
  Read: { icon: FileText, label: 'Read', color: 'text-fg-3' },
  Grep: { icon: Search, label: 'Grep', color: 'text-fg-3' },
  Glob: { icon: FolderOpen, label: 'Glob', color: 'text-fg-3' },
  Write: { icon: FileText, label: 'Write', color: 'text-fg-3' },
  Edit: { icon: Edit2, label: 'Edit', color: 'text-fg-3' },
  Delete: { icon: FileText, label: 'Delete', color: 'text-fg-3' },
  Ls: { icon: FolderOpen, label: 'List', color: 'text-fg-3' },
  MCP: { icon: Code, label: 'MCP', color: 'text-fg-3' },
  ToolSearch: { icon: Search, label: 'Tool Search', color: 'text-fg-3' },
  Skill: { icon: Code, label: 'Skill', color: 'text-fg-3' },
  Monitor: { icon: Clock, label: 'Monitor', color: 'text-fg-3' },
  Lint: { icon: FileSearch, label: 'Lint', color: 'text-fg-3' },
  GenerateImage: { icon: FileText, label: 'Generate Image', color: 'text-fg-3' },
  RecordScreen: { icon: Play, label: 'Record Screen', color: 'text-fg-3' },
  UpdateTopic: { icon: Edit2, label: 'Update Topic', color: 'text-fg-3' },
  WebFetch: { icon: Globe, label: 'WebFetch', color: 'text-fg-3' },
  WebSearch: { icon: Search, label: 'WebSearch', color: 'text-fg-3' },
  Task: {
    icon: Code,
    label: 'Agent Task',
    color: 'text-fg-3',
    iconSize: 18
  },
  TodoWrite: { icon: ListTodo, label: 'Todo', color: 'text-fg-3' },
  // New SDK Tasks system
  TaskCreate: {
    icon: ListPlus,
    label: 'Create Task',
    color: 'text-fg-3',
  },
  TaskUpdate: {
    icon: ListChecks,
    label: 'Update Task',
    color: 'text-fg-3',
  },
  TaskGet: {
    icon: FileSearch,
    label: 'Get Task',
    color: 'text-fg-3',
  },
  TaskList: {
    icon: List,
    label: 'List Tasks',
    color: 'text-fg-3',
  },
  AskUserQuestion: { icon: HelpCircle, label: 'Ask', color: 'text-fg-3' },
  // Browser automation tools (Stagehand MCP)
  BrowserSnapshot: { icon: Globe, label: 'BrowserSnapshot', color: 'text-fg-3' },
  BrowserNavigate: { icon: Globe, label: 'BrowserNavigate', color: 'text-fg-3' },
  BrowserAct: { icon: Globe, label: 'BrowserAct', color: 'text-fg-3' },
  BrowserObserve: { icon: Globe, label: 'BrowserObserve', color: 'text-fg-3' },
  BrowserAgent: { icon: Globe, label: 'BrowserAgent', color: 'text-fg-3' },
  BrowserClick: { icon: Globe, label: 'BrowserClick', color: 'text-fg-3' },
  BrowserType: { icon: Globe, label: 'BrowserType', color: 'text-fg-3' },
  BrowserExtract: { icon: Globe, label: 'BrowserExtract', color: 'text-fg-3' },
  BrowserExtractData: { icon: Globe, label: 'BrowserExtractData', color: 'text-fg-3' },
  BrowserGetInfo: { icon: Globe, label: 'BrowserGetInfo', color: 'text-fg-3' },
  BrowserGetDOM: { icon: Globe, label: 'BrowserGetDOM', color: 'text-fg-3' },
  // Utility MCP tools
  UpdateSessionName: { icon: Edit2, label: 'UpdateSessionName', color: 'text-fg-3' },
  // Document MCP tools
  DocumentCreate: { icon: FileText, label: 'DocumentCreate', color: 'text-fg-3' },
  DocumentRead: { icon: FileText, label: 'DocumentRead', color: 'text-fg-3' },
  DocumentEdit: { icon: Edit2, label: 'DocumentEdit', color: 'text-fg-3' },
  DocumentPreview: { icon: Globe, label: 'DocumentPreview', color: 'text-fg-3' },
};

const DEFAULT_CONFIG = { icon: Play, label: 'Tool', color: 'text-fg-3' };

// Graphite tokens shared by tool rows
const MONO_FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const WELL = 'bg-[#0B0B0B] p-2.5 font-mono text-[12px] leading-[1.6] text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]';
const SECTION_LABEL = 'mb-1 text-[11px] uppercase tracking-[0.04em] text-fg-5';
const EDITOR_FRAME = 'overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]';

// Extract subagent type from Task tool input
function getSubagentType(input: Record<string, unknown>): string | null {
  const description = (input.description as string) || '';
  const prompt = (input.prompt as string) || '';
  const combined = `${description} ${prompt}`.toLowerCase();

  // Pattern match common subagent types from descriptions
  if (combined.includes('explore') || combined.includes('search')) return 'EXPLORE';
  if (combined.includes('plan')) return 'PLAN';
  if (combined.includes('implement') || combined.includes('code') || combined.includes('bond')) return 'IMPLEMENT';
  if (combined.includes('document') || combined.includes('moneypenny')) return 'DOCUMENT';
  if (combined.includes('test') || combined.includes('verify') || combined.includes('scaramanga')) return 'TEST';
  if (combined.includes('q') || combined.includes('briefing')) return 'BRIEF';

  // Check for explicit subagent_type field
  if (input.subagent_type) {
    return (input.subagent_type as string).toUpperCase();
  }

  return 'TASK'; // Fallback generic label
}

// Format the tool input as a readable string for the summary
function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
    case 'Command':
      return (input.command as string) || 'Running command...';
    case 'BashOutput':
      return (input.shell_id as string) || 'Reading shell output...';
    case 'KillShell':
      return (input.shell_id as string) || 'Stopping shell...';
    case 'Read':
      return (input.file_path as string) || 'Reading file...';
    case 'Grep':
      return `${input.pattern || ''} ${input.path || ''}`.trim() || 'Searching...';
    case 'Glob':
      return (input.pattern as string) || 'Finding files...';
    case 'Write':
      return (input.file_path as string) || 'Writing file...';
    case 'Edit':
      if (input.file_path) return input.file_path as string;
      {
        const changes = getEditChanges(input);
        if (changes.length === 1) return changes[0].path;
        if (changes.length > 1) return `${changes.length} files changed`;
      }
      return 'Editing file...';
    case 'Delete':
      return (input.file_path as string) || 'Deleting file...';
    case 'Ls':
      return (input.path as string) || 'Listing directory...';
    case 'MCP':
      return `${input.server || ''} ${input.tool || ''}`.trim() || 'Calling MCP tool...';
    case 'ToolSearch':
      return (input.query as string) || 'Searching tools...';
    case 'Skill':
      return (input.skill as string) || 'Running skill...';
    case 'Monitor':
      return (input.task as string) || 'Monitoring task...';
    case 'UpdateTopic':
      return (input.topic as string) || 'Updating topic...';
    case 'WebFetch':
      return (input.url as string) || 'Fetching URL...';
    case 'WebSearch':
      return (input.query as string) || 'Searching web...';
    case 'Task': {
      const type = getSubagentType(input);
      const description = (input.description as string) || (input.prompt as string)?.slice(0, 80) || '';
      return type ? `[${type}] ${description}` : description;
    }
    case 'TodoWrite': {
      const todosRawSummary = input.todos;
      const todos = Array.isArray(todosRawSummary) ? todosRawSummary as TodoItem[] : undefined;
      if (!todos?.length) return 'Updating tasks...';
      const inProgress = todos.filter(t => t.status === 'in_progress').length;
      const completed = todos.filter(t => t.status === 'completed').length;
      const pending = todos.filter(t => t.status === 'pending').length;
      return `${completed}/${todos.length} done${inProgress > 0 ? `, ${inProgress} active` : ''}${pending > 0 ? `, ${pending} pending` : ''}`;
    }
    // New SDK Tasks system
    case 'TaskCreate': {
      const subject = input.subject as string;
      return subject ? `Creating: "${subject.slice(0, 50)}${subject.length > 50 ? '...' : ''}"` : 'Creating task...';
    }
    case 'TaskUpdate': {
      const taskId = input.taskId as string;
      const status = input.status as string;
      const subject = input.subject as string;
      if (status) {
        return `Task #${taskId}: ${status}`;
      }
      if (subject) {
        return `Task #${taskId}: "${subject.slice(0, 30)}${subject.length > 30 ? '...' : ''}"`;
      }
      return `Updating task #${taskId}`;
    }
    case 'TaskGet': {
      const taskId = input.taskId as string;
      return `Getting task #${taskId}`;
    }
    case 'TaskList':
      return 'Listing tasks';
    // Browser automation tools (Stagehand MCP)
    case 'BrowserSnapshot':
    case 'BrowserNavigate':
      return (input.url as string) || 'Navigating...';
    case 'BrowserAct':
      return (input.instruction as string) || 'Performing action...';
    case 'BrowserObserve':
      return (input.instruction as string) || 'Observing page...';
    case 'BrowserAgent':
      return (input.task as string) || 'Running agent task...';
    case 'BrowserClick':
      return (input.selector as string) || 'Clicking element...';
    case 'BrowserType':
      return `${input.selector || ''}: "${(input.text as string)?.slice(0, 30) || ''}"` || 'Typing...';
    case 'BrowserExtract':
    case 'BrowserExtractData':
      return (input.instruction as string) || (input.selector as string) || 'Extracting data...';
    case 'BrowserGetInfo':
      return 'Getting page info...';
    case 'BrowserGetDOM':
      return (input.selector as string) || 'Getting DOM...';
    // Document tools
    case 'DocumentCreate':
      return `${input.type || 'document'}: ${(input.path as string)?.split('/').pop() || 'Creating...'}`;
    case 'DocumentRead':
    case 'DocumentPreview':
      return (input.path as string)?.split('/').pop() || 'Reading document...';
    case 'DocumentEdit':
      return (input.path as string)?.split('/').pop() || 'Editing document...';
    case 'UpdateSessionName':
      return (input.name as string) || 'Updating session name...';
    default: {
      const firstValue = Object.values(input).find(v => typeof v === 'string');
      return (firstValue as string) || JSON.stringify(input).slice(0, 100);
    }
  }
}

// Clickable file path component
function ClickableFilePath({ filePath, label, lineNumber }: { filePath: string; label?: string; lineNumber?: number }) {
  const openFile = useEditorStore((state) => state.openFile);
  const openPlan = useEditorStore((state) => state.openPlan);
  const fileName = filePath.split('/').pop() || filePath;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[ClickableFilePath] Opening file:', filePath, 'lineNumber:', lineNumber);

    // Check if this is a plan file
    const isPlanFile = filePath.includes('/.claude/plans/');
    console.log('[ClickableFilePath] Is plan file:', isPlanFile);

    if (isPlanFile) {
      // Read the plan file and open in Plan panel
      console.log('[ClickableFilePath] Opening as plan in Plan panel');
      const { useSessionStore } = await import('../../stores/session.store');
      const { useUIStore } = await import('../../stores/ui.store');
      const activeSessionId = useSessionStore.getState().activeSessionId;

      if (activeSessionId && window.electronAPI?.fs?.readFile) {
        const result = await window.electronAPI.fs.readFile(filePath, activeSessionId);
        if (result.success && result.content) {
          useUIStore.getState().setPlanContent(activeSessionId, result.content);
          useUIStore.getState().showPlanPanel();
        }
      }
    } else if (openFile) {
      // Regular file - open in editor
      openFile(filePath, lineNumber);
    } else {
      console.error('[ClickableFilePath] openFile is undefined!');
    }
  };

  return (
    <button
      onClick={handleClick}
      className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] font-normal text-fg-2 hover:text-accent-text transition-colors group"
    >
      <FileText size={12} className="flex-shrink-0 text-fg-4" />
      <span className="truncate group-hover:underline">{label || fileName}</span>
      <ExternalLink size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// Helper to detect language from file path
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', json: 'json', md: 'markdown', html: 'html', css: 'css',
    scss: 'scss', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell',
  };
  return langMap[ext] || 'plaintext';
}

// Helper to detect if file is an image or video
function getMediaType(filePath: string): 'image' | 'video' | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  return null;
}

// Helper to try parsing a string as JSON
function tryParseJSON(str: string): object | null {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  // Quick check if it looks like JSON (starts with { or [)
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// Helper to detect base64 image data in content
function extractBase64Image(content: string): { type: string; data: string } | null {
  // Check for data URL format: data:image/xxx;base64,...
  const dataUrlMatch = content.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return { type: dataUrlMatch[1], data: dataUrlMatch[2] };
  }

  // Check for raw base64 that looks like an image (PNG/JPEG magic bytes)
  // PNG starts with iVBOR, JPEG starts with /9j/
  if (content.startsWith('iVBOR') || content.startsWith('/9j/')) {
    const type = content.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    return { type, data: content };
  }

  return null;
}

// JSON result viewer using Monaco for syntax highlighting
function JSONResultViewer({ data, toolCallId, priority = false }: { data: unknown; toolCallId: string; priority?: boolean }) {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  // For small JSON (under 500 chars), show inline formatted
  if (jsonString.length < 500) {
    return (
      <pre className={`whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${WELL} text-[11.5px]`}>
        {jsonString}
      </pre>
    );
  }

  // For larger JSON, use Monaco editor with proper syntax highlighting
  return (
    <div className={EDITOR_FRAME}>
      <LazyMonacoEditor
        editorId={`json-${toolCallId}`}
        height="300px"
        language="json"
        value={jsonString}
        priority={priority}
        options={{
          readOnly: true,
          fontFamily: MONO_FONT,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: 'off',
          folding: true,
          renderLineHighlight: 'none',
          contextmenu: false,
          automaticLayout: true,
          wordWrap: 'on',
        }}
      />
    </div>
  );
}

// Rich media preview component
function MediaPreview({ src, type, alt }: { src: string; type: 'image' | 'video'; alt?: string }) {
  const [isZoomed, setIsZoomed] = React.useState(false);

  if (type === 'video') {
    return (
      <div className={EDITOR_FRAME}>
        <video
          src={src}
          controls
          className="max-w-full max-h-96"
          style={{ display: 'block' }}
        />
      </div>
    );
  }

  return (
    <div className={`${EDITOR_FRAME} relative`}>
      <img
        src={src}
        alt={alt || 'Preview'}
        className={`max-w-full cursor-pointer transition-all ${isZoomed ? 'max-h-none' : 'max-h-96'}`}
        style={{ display: 'block' }}
        onClick={() => setIsZoomed(!isZoomed)}
        title={isZoomed ? 'Click to shrink' : 'Click to expand'}
      />
      {!isZoomed && (
        <div className="absolute bottom-1 right-1 bg-black/70 px-1.5 py-0.5 text-[10.5px] text-fg-2">
          Click to expand
        </div>
      )}
    </div>
  );
}

// Render a file write view - shows file content being written with Monaco Editor
function WriteView({ content, filePath, toolCallId, priority = false }: { content: string; filePath: string; toolCallId: string; priority?: boolean }) {
  const language = getLanguageFromPath(filePath);

  return (
    <div className="space-y-2 text-xs">
      {/* File header - clickable */}
      <div className="font-semibold flex items-center gap-2">
        <ClickableFilePath filePath={filePath} label={`Writing: ${filePath.split('/').pop() || filePath}`} />
      </div>

      {/* Monaco Editor for file content - lazy loaded */}
      <div className={EDITOR_FRAME}>
        <div className="flex items-center gap-2 border-b border-white/[0.05] bg-[rgba(63,185,80,0.09)] px-3 py-1 text-[11px] uppercase tracking-[0.04em] text-diff-add-text">
          NEW FILE
        </div>
        <LazyMonacoEditor
          editorId={`write-${toolCallId}`}
          height="300px"
          language={language}
          value={content}
          priority={priority}
          options={{
            readOnly: true,
            fontFamily: MONO_FONT,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: 'on',
            folding: false,
            renderLineHighlight: 'none',
            contextmenu: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

// Render a diff view for Edit tool using Monaco diff editor (lazy loaded)
function DiffView({ oldString, newString, filePath, toolCallId, priority = false }: { oldString: string; newString: string; filePath: string; toolCallId: string; priority?: boolean }) {
  const language = getLanguageFromPath(filePath);
  const openFile = useEditorStore((state) => state.openFile);
  const lineCount = Math.max(oldString.split('\n').length, newString.split('\n').length);
  const editorHeight = `${Math.min(priority ? 280 : 220, Math.max(88, lineCount * 22 + 44))}px`;

  const handleDiffClick = async () => {
    console.log('[DiffView] Opening file from diff click:', filePath);

    // Check if this is a plan file
    const isPlanFile = filePath.includes('/.claude/plans/');

    if (isPlanFile) {
      // Open in Plan panel
      const { useSessionStore } = await import('../../stores/session.store');
      const { useUIStore } = await import('../../stores/ui.store');
      const activeSessionId = useSessionStore.getState().activeSessionId;

      if (activeSessionId && window.electronAPI?.fs?.readFile) {
        const result = await window.electronAPI.fs.readFile(filePath, activeSessionId);
        if (result.success && result.content) {
          useUIStore.getState().setPlanContent(activeSessionId, result.content);
          useUIStore.getState().showPlanPanel();
        }
      }
    } else if (openFile) {
      openFile(filePath);
    } else {
      console.error('[DiffView] openFile is undefined!');
    }
  };

  return (
    <div className="space-y-2 text-xs">
      {/* File header - clickable */}
      <div className="font-semibold">
        <ClickableFilePath filePath={filePath} />
      </div>

      {/* Monaco Diff Editor - bounded in transcript and clickable to open file */}
      <div
        className="overflow-hidden cursor-pointer shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.45)] transition-shadow"
        onClick={handleDiffClick}
        title="Click to open file in editor"
      >
        <div className="px-3 py-1 text-[11px] uppercase tracking-[0.04em] text-fg-5 border-b border-white/[0.05]">
          DIFF (Click to open file)
        </div>
        <LazyDiffEditor
          editorId={`diff-${toolCallId}`}
          height={editorHeight}
          language={language}
          original={oldString}
          modified={newString}
          priority={priority}
          options={{
            readOnly: true,
            fontFamily: MONO_FONT,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: 'on',
            contextmenu: false,
            renderLineHighlight: 'all',
            automaticLayout: true,
            renderSideBySide: true,
            enableSplitViewResizing: false,
            renderOverviewRuler: false,
            wordWrap: 'on',
            diffWordWrap: 'on',
            scrollbar: {
              vertical: 'auto',
              horizontal: 'hidden',
              alwaysConsumeMouseWheel: false,
            },
          }}
        />
      </div>
    </div>
  );
}

// Codex app-server provides a unified diff for each FileUpdateChange rather
// than Claude's old_string/new_string pair. Render that native payload instead
// of leaving the Edit card in a permanent loading state.
function UnifiedDiffView({ change, toolCallId, priority = false }: { change: EditChange; toolCallId: string; priority?: boolean }) {
  const openFile = useEditorStore((state) => state.openFile);
  const lineCount = change.diff?.split('\n').length || 1;
  const editorHeight = `${Math.min(priority ? 300 : 240, Math.max(88, lineCount * 19 + 44))}px`;
  const kindLabel = change.kind === 'add' ? 'Added' : change.kind === 'delete' ? 'Deleted' : 'Updated';

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 font-semibold">
        <span className="text-fg-5 uppercase text-[11px] tracking-[0.04em] font-normal">{kindLabel}</span>
        <ClickableFilePath filePath={change.path} />
      </div>
      {change.diff ? (
        <div
          className="overflow-hidden cursor-pointer shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.45)] transition-shadow"
          onClick={() => openFile?.(change.path)}
          title="Click to open file in editor"
        >
          <div className="px-3 py-1 text-[11px] uppercase tracking-[0.04em] text-fg-5 border-b border-white/[0.05]">
            PATCH (Click to open file)
          </div>
          <LazyMonacoEditor
            editorId={`patch-${toolCallId}-${change.path}`}
            height={editorHeight}
            language="diff"
            value={change.diff}
            priority={priority}
            options={{
              readOnly: true,
              fontFamily: MONO_FONT,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbers: 'off',
              folding: false,
              renderLineHighlight: 'none',
              contextmenu: false,
              automaticLayout: true,
              wordWrap: 'off',
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                alwaysConsumeMouseWheel: false,
              },
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// Render expanded content based on tool type
function ExpandedContent({ toolCall, priority = false }: { toolCall: ToolCall; priority?: boolean }) {
  const { name, input, result } = toolCall;
  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';

  // Special rendering for Read tool - show clickable file path with Monaco preview or media
  if (name === 'Read') {
    const filePath = (input.file_path as string) || '';
    const lineNumber = (input.offset as number) || undefined;
    const language = getLanguageFromPath(filePath);
    const mediaType = getMediaType(filePath);

    // Show loading state if no file path yet
    if (!filePath) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-fg-4">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading file path...</span>
        </div>
      );
    }

    // Handle image/video files
    if (mediaType && result !== undefined && typeof result === 'string') {
      // Try to extract base64 data or use the result directly
      const base64Data = extractBase64Image(result);
      const src = base64Data
        ? `data:${base64Data.type};base64,${base64Data.data}`
        : result.startsWith('data:') ? result : `file://${filePath}`;

      return (
        <div className="space-y-2 text-xs">
          <div className="font-semibold">
            <ClickableFilePath filePath={filePath} />
          </div>
          <MediaPreview src={src} type={mediaType} alt={filePath.split('/').pop()} />
        </div>
      );
    }

    return (
      <div className="space-y-2 text-xs">
        {/* Clickable file path header */}
        <div className="font-semibold">
          <ClickableFilePath filePath={filePath} lineNumber={lineNumber} />
        </div>

        {/* Result preview with Monaco if available */}
        {result !== undefined ? (
          <div>
            <div className={SECTION_LABEL}>Content Preview:</div>
            {typeof result === 'string' && result.length > 10 ? (
              <div className={EDITOR_FRAME}>
                <LazyMonacoEditor
                  editorId={`read-${toolCall.id}`}
                  height="300px"
                  language={language}
                  value={result.slice(0, 5000)}
                  priority={priority}
                  options={{
                    readOnly: true,
                    fontFamily: MONO_FONT,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                    lineNumbers: 'on',
                    folding: true,
                    renderLineHighlight: 'none',
                    contextmenu: false,
                    automaticLayout: true,
                  }}
                />
              </div>
            ) : (
              typeof result === 'object' ? (() => {
                try {
                  const r = result as Record<string, unknown>;
                  let imgSrc: string | null = null;
                  if (r.type === 'image' && typeof r.source === 'object' && r.source !== null) {
                    const s = r.source as Record<string, unknown>;
                    if (s.type === 'base64' && typeof s.data === 'string') {
                      imgSrc = `data:${(s.media_type as string) || 'image/png'};base64,${s.data}`;
                    }
                  }
                  if (!imgSrc && Array.isArray(result)) {
                    for (const b of result as unknown[]) {
                      if (b && typeof b === 'object' && (b as any).type === 'image' && typeof (b as any).source === 'object') {
                        const s = (b as any).source;
                        if (s?.type === 'base64' && typeof s.data === 'string') {
                          imgSrc = `data:${s.media_type || 'image/png'};base64,${s.data}`;
                          break;
                        }
                      }
                    }
                  }
                  if (!imgSrc && Array.isArray(r.content)) {
                    for (const b of r.content as unknown[]) {
                      if (b && typeof b === 'object' && (b as any).type === 'image' && typeof (b as any).source === 'object') {
                        const s = (b as any).source;
                        if (s?.type === 'base64' && typeof s.data === 'string') {
                          imgSrc = `data:${s.media_type || 'image/png'};base64,${s.data}`;
                          break;
                        }
                      }
                    }
                  }
                  if (imgSrc) {
                    return <MediaPreview src={imgSrc} type="image" alt={filePath.split('/').pop()} />;
                  }
                } catch {
                  // Fall through to JSON viewer on any error
                }
                return <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />;
              })() : (
                <pre className={`whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${WELL}`}>
                  {String(result)}
                </pre>
              )
            )}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-[12px] text-fg-4">
            <Loader2 size={12} className="animate-spin" />
            <span>Reading file...</span>
          </div>
        ) : null}
      </div>
    );
  }

  // Shell-backed Codex executions are deliberately labelled Command so a
  // read/test invocation is not mistaken for a file edit performed by Bash.
  if (name === 'Bash' || name === 'Command') {
    const command = (input.command as string) || '';

    // Show loading state if no command yet
    if (!command) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-fg-4">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading command...</span>
        </div>
      );
    }

    return (
      <div className="space-y-2 text-xs">
        <div>
          <div className={SECTION_LABEL}>Command:</div>
          <pre className="whitespace-pre-wrap overflow-x-auto font-mono text-[12px] leading-[1.6] text-fg-2">
            <span className="text-fg-5">$</span> {command}
          </pre>
        </div>

        {/* Result section */}
        {result !== undefined ? (
          <div>
            <div className={SECTION_LABEL}>Output:</div>
            {typeof result === 'object' ? (
              <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />
            ) : tryParseJSON(String(result)) ? (
              <JSONResultViewer data={tryParseJSON(String(result))} toolCallId={toolCall.id} priority={priority} />
            ) : (
              <pre className="whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto font-mono text-[12px] leading-[1.6] text-fg-4">
                {String(result)}
              </pre>
            )}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-[12px] text-fg-4">
            <Loader2 size={12} className="animate-spin" />
            <span>Running...</span>
          </div>
        ) : null}
      </div>
    );
  }

  // Special rendering for Write tool - show file content being written
  if (name === 'Write') {
    const content = (input.content as string) || '';
    const filePath = (input.file_path as string) || '';

    // Show loading state if no content yet
    if (!content && !filePath) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-fg-4">
          <Loader2 size={12} className="animate-spin" />
          <span>Preparing file content...</span>
        </div>
      );
    }

    if (content) {
      return <WriteView content={content} filePath={filePath} toolCallId={toolCall.id} priority={priority} />;
    }

    // Have file path but no content yet
    return (
      <div className="flex items-center gap-2 text-[12px] text-fg-4">
        <Loader2 size={12} className="animate-spin" />
        <span>Writing to {filePath.split('/').pop() || filePath}...</span>
      </div>
    );
  }

  // Special rendering for Edit tool - show diff view
  if (name === 'Edit') {
    const oldString = (input.old_string as string) || '';
    const newString = (input.new_string as string) || '';
    const filePath = (input.file_path as string) || '';
    const changes = getEditChanges(input);
    const unifiedDiff = (input.unified_diff as string) || '';

    // Show loading state if no content yet
    if (!oldString && !newString && !filePath && changes.length === 0 && isRunning) {
      return (
        <div className="flex items-center gap-2 text-[12px] text-fg-4">
          <Loader2 size={12} className="animate-spin" />
          <span>Preparing edit...</span>
        </div>
      );
    }

    if (oldString || newString) {
      return <DiffView oldString={oldString} newString={newString} filePath={filePath} toolCallId={toolCall.id} priority={priority} />;
    }

    if (changes.length > 0) {
      const displayChanges = changes.map((change, index) => (
        index === 0 && !change.diff && unifiedDiff
          ? { ...change, diff: unifiedDiff }
          : change
      ));
      return (
        <div className="space-y-4">
          {displayChanges.map((change, index) => (
            <UnifiedDiffView
              key={`${change.path}-${index}`}
              change={change}
              toolCallId={`${toolCall.id}-${index}`}
              priority={priority}
            />
          ))}
        </div>
      );
    }

    // Have file path but no diff content yet
    if (filePath && isRunning) return (
      <div className="flex items-center gap-2 text-[12px] text-fg-4">
        <Loader2 size={12} className="animate-spin" />
        <span>Loading changes for {filePath.split('/').pop() || filePath}...</span>
      </div>
    );

    return (
      <div className="text-[12px] text-fg-4">
        {filePath ? <ClickableFilePath filePath={filePath} /> : 'Edit completed; Codex did not provide patch details.'}
      </div>
    );
  }

  // Special rendering for TodoWrite - show task list
  if (name === 'TodoWrite') {
    const todosRaw = input.todos;
    const todos = Array.isArray(todosRaw) ? todosRaw as TodoItem[] : undefined;
    if (!todos?.length) return null;

    return (
      <div className="space-y-1">
        {todos.map((todo, index) => (
          <div key={index} className="flex items-start gap-2 text-[12.5px]">
            {todo.status === 'completed' ? (
              <CheckCircle2 size={13} className="text-diff-add flex-shrink-0 mt-0.5" />
            ) : todo.status === 'in_progress' ? (
              <Clock size={13} className="text-accent flex-shrink-0 mt-0.5 animate-pulse" />
            ) : (
              <Circle size={13} className="text-fg-5 flex-shrink-0 mt-0.5" />
            )}
            <span className={
              todo.status === 'completed'
                ? 'text-fg-5 line-through'
                : todo.status === 'in_progress'
                  ? 'text-fg'
                  : 'text-fg-3'
            }>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Check if input has meaningful content
  const hasInput = typeof input === 'object'
    ? Object.keys(input).length > 0
    : input !== null && input !== undefined && String(input).trim() !== '';

  // Check if result contains base64 image data (string or object with screenshot field)
  const resultStr = typeof result === 'string' ? result : '';
  const base64Image = extractBase64Image(resultStr);

  // Check for Anthropic API image format: { type: "image", source: { data: "...", media_type: "image/png", type: "base64" } }
  let anthropicImage: string | null = null;
  if (!base64Image && typeof result === 'object' && result !== null) {
    const resultObj = result as Record<string, unknown>;

    // Check if result is a single image content block
    if (resultObj.type === 'image' && typeof resultObj.source === 'object' && resultObj.source !== null) {
      const source = resultObj.source as Record<string, unknown>;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const mediaType = (source.media_type as string) || 'image/png';
        anthropicImage = `data:${mediaType};base64,${source.data}`;
      }
    }

    // Check if result has a content array with image blocks
    if (!anthropicImage && Array.isArray(resultObj.content)) {
      const imageBlock = resultObj.content.find((block: unknown) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          return b.type === 'image' && typeof b.source === 'object';
        }
        return false;
      });

      if (imageBlock) {
        const block = imageBlock as Record<string, unknown>;
        const source = block.source as Record<string, unknown>;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const mediaType = (source.media_type as string) || 'image/png';
          anthropicImage = `data:${mediaType};base64,${source.data}`;
        }
      }
    }
  }

  // Also check for screenshot field in object results (common for browser/MCP tools)
  let screenshotFromObject: string | null = null;
  if (!base64Image && !anthropicImage && typeof result === 'object' && result !== null) {
    const resultObj = result as Record<string, unknown>;
    // Look for common screenshot field names
    const screenshotField = resultObj.screenshot || resultObj.image || resultObj.imageData;
    if (typeof screenshotField === 'string') {
      const extracted = extractBase64Image(screenshotField);
      if (extracted) {
        screenshotFromObject = `data:${extracted.type};base64,${extracted.data}`;
      } else if (screenshotField.startsWith('data:image')) {
        screenshotFromObject = screenshotField;
      }
    }
  }

  // For other tools, show input and result
  const contentBlockResult = extractContentBlockText(result);

  return (
    <div className="space-y-2 text-xs">
      {/* Input section - only show if there's meaningful input */}
      {hasInput && (
        <div>
          <div className={SECTION_LABEL}>Input:</div>
          {typeof input === 'object' ? (
            <JSONResultViewer data={input} toolCallId={`${toolCall.id}-input`} priority={priority} />
          ) : (
            <pre className={`whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto ${WELL}`}>
              {String(input)}
            </pre>
          )}
        </div>
      )}

      {/* Result section (if available) */}
      {result !== undefined && (
        <div>
          <div className={SECTION_LABEL}>Result:</div>
          {base64Image ? (
            <MediaPreview
              src={`data:${base64Image.type};base64,${base64Image.data}`}
              type="image"
              alt="Tool result"
            />
          ) : anthropicImage ? (
            <div className="space-y-2">
              <MediaPreview src={anthropicImage} type="image" alt="Tool result" />
              {/* Show text content if present alongside the image */}
              {(() => {
                if (typeof result !== 'object' || result === null) return null;
                const resultObj = result as Record<string, unknown>;
                if (!('content' in resultObj) || !Array.isArray(resultObj.content)) return null;

                return resultObj.content.map((block: unknown, idx: number) => {
                  if (typeof block === 'object' && block !== null) {
                    const b = block as Record<string, unknown>;
                    if (b.type === 'text' && typeof b.text === 'string') {
                      return (
                        <pre key={idx} className={`whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${WELL}`}>
                          {b.text}
                        </pre>
                      );
                    }
                  }
                  return null;
                });
              })()}
            </div>
          ) : screenshotFromObject ? (
            <div className="space-y-2">
              <MediaPreview src={screenshotFromObject} type="image" alt="Screenshot" />
              {/* Show other fields from the object result */}
              {typeof result === 'object' && Object.keys(result as Record<string, unknown>).filter(k => !['screenshot', 'image', 'imageData'].includes(k)).length > 0 && (
                <JSONResultViewer
                  data={Object.fromEntries(
                    Object.entries(result as Record<string, unknown>).filter(([k]) => !['screenshot', 'image', 'imageData'].includes(k))
                  )}
                  toolCallId={`${toolCall.id}-fields`}
                  priority={priority}
                />
              )}
            </div>
          ) : contentBlockResult.matched ? (
            <pre className={`whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${WELL}`}>
              {contentBlockResult.text}
            </pre>
          ) : typeof result === 'object' ? (
            <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />
          ) : tryParseJSON(String(result)) ? (
            <JSONResultViewer data={tryParseJSON(String(result))} toolCallId={toolCall.id} priority={priority} />
          ) : (
            <pre className={`whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${WELL}`}>
              {String(result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Display-only line counts for the collapsed row meta (+N −N)
function countDiffLines(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return { add, del };
}

function getDiffStats(name: string, input: Record<string, unknown>): { add: number; del: number } | null {
  if (name === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    return content ? { add: content.split('\n').length, del: 0 } : null;
  }
  if (name !== 'Edit') return null;
  const oldString = typeof input.old_string === 'string' ? input.old_string : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  if (oldString || newString) {
    return {
      add: newString ? newString.split('\n').length : 0,
      del: oldString ? oldString.split('\n').length : 0,
    };
  }
  const diffs = getEditChanges(input).map((change) => change.diff).filter((diff): diff is string => Boolean(diff));
  if (diffs.length === 0 && typeof input.unified_diff === 'string' && input.unified_diff) diffs.push(input.unified_diff);
  if (diffs.length === 0) return null;
  return diffs.reduce((acc, diff) => {
    const counts = countDiffLines(diff);
    return { add: acc.add + counts.add, del: acc.del + counts.del };
  }, { add: 0, del: 0 });
}

function formatToolDuration(toolCall: ToolCall): string | null {
  if (!toolCall.startedAt || !toolCall.completedAt) return null;
  const ms = new Date(toolCall.completedAt).getTime() - new Date(toolCall.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Codex-style status glyph: accent spinner / green check / red cross
function ToolStatusGlyph({ status }: { status: ToolCall['status'] }) {
  if (status === 'running' || status === 'pending') {
    return <Loader2 size={13} strokeWidth={2.4} className="flex-shrink-0 animate-spin text-accent" />;
  }
  if (status === 'error') {
    return <X size={13} strokeWidth={2.6} className="flex-shrink-0 text-diff-del" />;
  }
  return <Check size={13} strokeWidth={2.6} className="flex-shrink-0 text-diff-add" />;
}

export default function ToolCallCard({ toolCall, isLatest = false, isLatestToolCall = false, defaultCollapsed = false, onBackground, variant = 'card' }: ToolCallCardProps) {
  const normalizedToolCall = useMemo(() => normalizeToolCall(toolCall), [toolCall]);
  const isTranscriptVisible = isTranscriptVisibleToolCall(normalizedToolCall);

  // Start collapsed for old messages (performance optimization) - otherwise expanded by default
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);
  // Track if content has ever been rendered (to prevent Monaco disposal errors on collapse)
  const [hasBeenExpanded, setHasBeenExpanded] = useState(!defaultCollapsed);

  // Update hasBeenExpanded when first expanded
  React.useEffect(() => {
    if (isExpanded && !hasBeenExpanded) {
      setHasBeenExpanded(true);
    }
  }, [isExpanded, hasBeenExpanded]);

  // Keep isLatest/isLatestToolCall for potential future use but don't auto-collapse
  const _shouldExpand = isLatest || isLatestToolCall; // eslint-disable-line @typescript-eslint/no-unused-vars

  const baseToolName = normalizedToolCall.name;
  const config = TOOL_CONFIG[baseToolName] || DEFAULT_CONFIG;

  const commandDisplay = useMemo(() => formatToolInput(baseToolName, normalizedToolCall.input), [baseToolName, normalizedToolCall.input]);
  if (!isTranscriptVisible) {
    return null;
  }

  const isRunning = normalizedToolCall.status === 'running' || normalizedToolCall.status === 'pending';

  // Detect if this is a Task tool (subagent)
  const isTaskTool = baseToolName === 'Task';
  const subagentType = isTaskTool ? getSubagentType(normalizedToolCall.input) : null;

  // Detect if this is a running Bash command that can be backgrounded
  const isBashTool = baseToolName === 'Bash';
  const canBackground = isBashTool && isRunning && onBackground;

  const isError = normalizedToolCall.status === 'error';
  const isShellCard = baseToolName === 'Bash' || baseToolName === 'Command';
  const diffStats = getDiffStats(baseToolName, normalizedToolCall.input);
  const duration = formatToolDuration(normalizedToolCall);

  if (variant === 'row') {
    // Compact grouped row (Codex style): 28px, no borders. Status slot only shows
    // for running/failed calls so a finished run reads as a quiet list.
    return (
      <div className="min-w-0">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsExpanded(!isExpanded)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded(!isExpanded);
            }
          }}
          className={`group/row flex h-7 w-full cursor-pointer items-center gap-2 px-3 text-left font-mono text-[12px] transition-colors ${
            isError ? 'hover:bg-[rgba(248,81,73,0.06)]' : 'hover:bg-white/[0.03]'
          }`}
        >
          <span className="flex w-3 flex-shrink-0 items-center justify-center">
            {isRunning || isError ? <ToolStatusGlyph status={normalizedToolCall.status} /> : null}
          </span>
          <span className={`w-[52px] flex-shrink-0 truncate ${isError ? 'text-diff-del' : 'text-fg-3'}`}>{config.label}</span>
          <span className="min-w-0 flex-1 truncate text-fg-2" title={commandDisplay}>{commandDisplay}</span>
          {diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
            <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px]">
              {diffStats.add > 0 && <span className="text-diff-add">+{diffStats.add}</span>}
              {diffStats.del > 0 && <span className="text-diff-del">−{diffStats.del}</span>}
            </span>
          )}
          {(isError || duration) && (
            <span className={`flex-shrink-0 text-[11px] ${isError ? 'text-diff-del' : 'text-fg-5'}`}>
              {isError ? (duration ? `failed · ${duration}` : 'failed') : duration}
            </span>
          )}
          {canBackground && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBackground(normalizedToolCall);
              }}
              className="flex h-5 flex-shrink-0 items-center gap-1 px-1.5 text-[10.5px] text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-white/[0.04] hover:text-fg"
              title="Move to background (Cmd+B)"
            >
              <ArrowUpRight size={10} />
              <span>BG</span>
            </button>
          )}
          {isExpanded ? (
            <ChevronDown size={12} className="flex-shrink-0 text-fg-5" />
          ) : (
            <ChevronRight size={12} className="flex-shrink-0 text-fg-5 opacity-0 transition-opacity group-hover/row:opacity-100" />
          )}
        </div>
        {hasBeenExpanded && (
          <div className="pb-2 pl-8 pr-3 pt-1" style={{ display: isExpanded ? 'block' : 'none' }}>
            <ExpandedContent toolCall={normalizedToolCall} priority={isLatest || isLatestToolCall || isRunning} />
          </div>
        )}
      </div>
    );
  }

  // Graphite card: ink-1 with a 7% inset hairline; shell output sits on the darker well
  const cardClasses = `overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] ${
    isShellCard ? 'bg-[#0B0B0B]' : 'bg-ink-1'
  }`;

  const buttonClasses = `w-full flex items-center gap-2.5 px-3 py-[9px] text-left transition-colors ${
    isError ? 'bg-[rgba(248,81,73,0.05)] hover:bg-[rgba(248,81,73,0.08)]' : 'hover:bg-white/[0.03]'
  } ${isTaskTool && isRunning ? 'animate-pulse-slow' : ''}`;

  return (
    <div className={cardClasses}>
      {/* Header row - clickable */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        className={buttonClasses}
      >
        {/* Status glyph */}
        <ToolStatusGlyph status={normalizedToolCall.status} />

        {/* Tool name */}
        <span className="min-w-[48px] flex-shrink-0 whitespace-nowrap font-mono text-[12px] text-fg-3">{config.label}</span>

        {/* Subagent type tag (Task tools only) */}
        {isTaskTool && subagentType && (
          <span
            className="flex-shrink-0 px-[5px] py-px font-mono text-[9.5px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]"
            style={{ letterSpacing: '0.04em' }}
          >
            {subagentType}
          </span>
        )}

        {/* Input/command summary (always visible) */}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={commandDisplay}>
          {commandDisplay}
        </span>

        {/* Right-aligned meta */}
        {diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
          <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-[11px]">
            {diffStats.add > 0 && <span className="text-diff-add">+{diffStats.add}</span>}
            {diffStats.del > 0 && <span className="text-diff-del">−{diffStats.del}</span>}
          </span>
        )}
        {(isError || duration) && (
          <span className={`flex-shrink-0 font-mono text-[11px] ${isError ? 'text-diff-del' : 'text-fg-4'}`}>
            {isError ? (duration ? `failed · ${duration}` : 'failed') : duration}
          </span>
        )}

        {/* Background button for running Bash commands */}
        {canBackground && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBackground(normalizedToolCall);
            }}
            className="flex h-5 flex-shrink-0 items-center gap-1 px-1.5 font-mono text-[10.5px] text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:text-fg hover:bg-white/[0.04]"
            title="Move to background (Cmd+B)"
          >
            <ArrowUpRight size={10} />
            <span>BG</span>
          </button>
        )}

        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown size={12} className="flex-shrink-0 text-fg-5" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-fg-5" />
        )}
      </div>

      {/* Expanded content - once rendered, hide with CSS to prevent Monaco disposal errors */}
      {hasBeenExpanded && (
        <div
          className="border-t border-white/[0.05] px-3 pb-3 pt-2.5"
          style={{
            display: isExpanded ? 'block' : 'none',
          }}
        >
          {/* Priority loading for recent/active tool calls */}
          <ExpandedContent toolCall={normalizedToolCall} priority={isLatest || isLatestToolCall || isRunning} />
        </div>
      )}
    </div>
  );
}
