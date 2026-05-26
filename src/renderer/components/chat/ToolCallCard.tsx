import React, { useState, useMemo } from 'react';
import { Terminal, FileText, Search, FolderOpen, Play, Edit2, Globe, Code, HelpCircle, ListTodo, Loader2, ChevronRight, ChevronDown, CheckCircle2, Circle, Clock, ExternalLink, ListPlus, ListChecks, FileSearch, List, ArrowUpRight } from 'lucide-react';
import { LazyMonacoEditor, LazyDiffEditor } from './LazyMonacoEditor';
import type { ToolCall } from '../../../shared/types';
import { normalizeToolCall } from '../../../shared/utils/tool-call-transformer';
import { extractContentBlockText } from '../../../shared/utils/content-block-text';
import { useEditorStore } from '../../stores/editor.store';

interface ToolCallCardProps {
  toolCall: ToolCall;
  isLatest?: boolean; // If true, expand by default
  isLatestToolCall?: boolean; // Alias for isLatest
  isStreaming?: boolean; // If currently streaming
  defaultCollapsed?: boolean; // If true, start collapsed (for old messages to improve performance)
  onBackground?: (toolCall: ToolCall) => void; // Callback to background a running Bash command
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
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
  Bash: { icon: Terminal, label: 'Bash', color: 'text-green-400' },
  BashOutput: { icon: Terminal, label: 'Bash Output', color: 'text-green-400' },
  KillShell: { icon: Terminal, label: 'Kill Shell', color: 'text-red-400' },
  Read: { icon: FileText, label: 'Read', color: 'text-blue-400' },
  Grep: { icon: Search, label: 'Grep', color: 'text-purple-400' },
  Glob: { icon: FolderOpen, label: 'Glob', color: 'text-yellow-400' },
  Write: { icon: FileText, label: 'Write', color: 'text-pink-400' },
  Edit: { icon: Edit2, label: 'Edit', color: 'text-orange-400' },
  Delete: { icon: FileText, label: 'Delete', color: 'text-red-400' },
  Ls: { icon: FolderOpen, label: 'List', color: 'text-yellow-400' },
  MCP: { icon: Code, label: 'MCP', color: 'text-indigo-400' },
  ToolSearch: { icon: Search, label: 'Tool Search', color: 'text-purple-400' },
  Skill: { icon: Code, label: 'Skill', color: 'text-violet-400' },
  Monitor: { icon: Clock, label: 'Monitor', color: 'text-sky-400' },
  Lint: { icon: FileSearch, label: 'Lint', color: 'text-rose-400' },
  GenerateImage: { icon: FileText, label: 'Generate Image', color: 'text-pink-400' },
  RecordScreen: { icon: Play, label: 'Record Screen', color: 'text-cyan-400' },
  UpdateTopic: { icon: Edit2, label: 'Update Topic', color: 'text-indigo-400' },
  WebFetch: { icon: Globe, label: 'WebFetch', color: 'text-cyan-400' },
  WebSearch: { icon: Search, label: 'WebSearch', color: 'text-teal-400' },
  Task: {
    icon: Code,
    label: 'Agent Task',
    color: 'text-purple-400',
    bgGradient: 'from-purple-900/20 to-indigo-900/20',
    borderColor: 'border-purple-500/50',
    iconSize: 18
  },
  TodoWrite: { icon: ListTodo, label: 'Todo', color: 'text-amber-400' },
  // New SDK Tasks system
  TaskCreate: {
    icon: ListPlus,
    label: 'Create Task',
    color: 'text-green-400',
    bgGradient: 'from-green-900/20 to-emerald-900/20',
    borderColor: 'border-green-500/50',
  },
  TaskUpdate: {
    icon: ListChecks,
    label: 'Update Task',
    color: 'text-blue-400',
    bgGradient: 'from-blue-900/20 to-cyan-900/20',
    borderColor: 'border-blue-500/50',
  },
  TaskGet: {
    icon: FileSearch,
    label: 'Get Task',
    color: 'text-purple-400',
    bgGradient: 'from-purple-900/20 to-violet-900/20',
    borderColor: 'border-purple-500/50',
  },
  TaskList: {
    icon: List,
    label: 'List Tasks',
    color: 'text-amber-400',
    bgGradient: 'from-amber-900/20 to-yellow-900/20',
    borderColor: 'border-amber-500/50',
  },
  AskUserQuestion: { icon: HelpCircle, label: 'Ask', color: 'text-rose-400' },
  // Browser automation tools (Stagehand MCP)
  BrowserSnapshot: { icon: Globe, label: 'BrowserSnapshot', color: 'text-cyan-400' },
  BrowserNavigate: { icon: Globe, label: 'BrowserNavigate', color: 'text-cyan-400' },
  BrowserAct: { icon: Globe, label: 'BrowserAct', color: 'text-emerald-400' },
  BrowserObserve: { icon: Globe, label: 'BrowserObserve', color: 'text-sky-400' },
  BrowserAgent: { icon: Globe, label: 'BrowserAgent', color: 'text-violet-400' },
  BrowserClick: { icon: Globe, label: 'BrowserClick', color: 'text-cyan-400' },
  BrowserType: { icon: Globe, label: 'BrowserType', color: 'text-cyan-400' },
  BrowserExtract: { icon: Globe, label: 'BrowserExtract', color: 'text-cyan-400' },
  BrowserExtractData: { icon: Globe, label: 'BrowserExtractData', color: 'text-teal-400' },
  BrowserGetInfo: { icon: Globe, label: 'BrowserGetInfo', color: 'text-cyan-400' },
  BrowserGetDOM: { icon: Globe, label: 'BrowserGetDOM', color: 'text-cyan-400' },
  // Utility MCP tools
  UpdateSessionName: { icon: Edit2, label: 'UpdateSessionName', color: 'text-indigo-400' },
  // Document MCP tools
  DocumentCreate: { icon: FileText, label: 'DocumentCreate', color: 'text-pink-400' },
  DocumentRead: { icon: FileText, label: 'DocumentRead', color: 'text-blue-400' },
  DocumentEdit: { icon: Edit2, label: 'DocumentEdit', color: 'text-orange-400' },
  DocumentPreview: { icon: Globe, label: 'DocumentPreview', color: 'text-cyan-400' },
};

const DEFAULT_CONFIG = { icon: Play, label: 'Tool', color: 'text-gray-400' };

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
      return (input.file_path as string) || 'Editing file...';
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
      className="flex items-center gap-1 text-claude-text-secondary hover:text-blue-400 transition-colors group"
    >
      <FileText size={12} />
      <span className="group-hover:underline">{label || fileName}</span>
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
      <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto font-mono text-[11px]">
        {jsonString}
      </pre>
    );
  }

  // For larger JSON, use Monaco editor with proper syntax highlighting
  return (
    <div className="border border-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
      <LazyMonacoEditor
        editorId={`json-${toolCallId}`}
        height="300px"
        language="json"
        value={jsonString}
        priority={priority}
        options={{
          readOnly: true,
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
      <div className="border border-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
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
    <div className="border border-claude-border overflow-hidden relative" style={{ borderRadius: 0 }}>
      <img
        src={src}
        alt={alt || 'Preview'}
        className={`max-w-full cursor-pointer transition-all ${isZoomed ? 'max-h-none' : 'max-h-96'}`}
        style={{ display: 'block' }}
        onClick={() => setIsZoomed(!isZoomed)}
        title={isZoomed ? 'Click to shrink' : 'Click to expand'}
      />
      {!isZoomed && (
        <div className="absolute bottom-1 right-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5">
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
      <div className="border border-green-500/50 overflow-hidden" style={{ borderRadius: 0 }}>
        <div className="px-2 py-1 bg-green-900/40 text-green-400 text-xs font-bold uppercase" style={{ letterSpacing: '0.05em' }}>
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
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
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

      {/* Monaco Diff Editor - side by side, lazy loaded - click to open file */}
      <div
        className="border border-claude-border overflow-hidden cursor-pointer hover:border-blue-400 transition-colors"
        style={{ borderRadius: 0 }}
        onClick={handleDiffClick}
        title="Click to open file in editor"
      >
        <div className="px-2 py-1 bg-claude-surface text-claude-text-secondary text-xs font-bold uppercase border-b border-claude-border" style={{ letterSpacing: '0.05em' }}>
          DIFF (Click to open file)
        </div>
        <LazyDiffEditor
          editorId={`diff-${toolCallId}`}
          height="400px"
          language={language}
          original={oldString}
          modified={newString}
          priority={priority}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineNumbers: 'on',
            contextmenu: false,
            renderLineHighlight: 'all',
            automaticLayout: true,
            renderSideBySide: true,
            enableSplitViewResizing: false,
            renderOverviewRuler: false,
          }}
        />
      </div>
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
        <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
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
            <div className="text-claude-text-secondary mb-1 font-semibold">Content Preview:</div>
            {typeof result === 'string' && result.length > 10 ? (
              <div className="border border-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
                <LazyMonacoEditor
                  editorId={`read-${toolCall.id}`}
                  height="300px"
                  language={language}
                  value={result.slice(0, 5000)}
                  priority={priority}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
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
                const r = result as Record<string, unknown>;
                let imgSrc: string | null = null;
                if (r.type === 'image' && typeof r.source === 'object' && r.source !== null) {
                  const s = r.source as Record<string, unknown>;
                  if (s.type === 'base64' && typeof s.data === 'string') {
                    imgSrc = `data:${(s.media_type as string) || 'image/png'};base64,${s.data}`;
                  }
                }
                if (!imgSrc && Array.isArray(r)) {
                  const imgBlock = (r as unknown[]).find((b: unknown) => {
                    const bl = b as Record<string, unknown>;
                    return bl?.type === 'image' && typeof bl.source === 'object';
                  }) as Record<string, unknown> | undefined;
                  if (imgBlock) {
                    const s = imgBlock.source as Record<string, unknown>;
                    if (s?.type === 'base64' && typeof s.data === 'string') {
                      imgSrc = `data:${(s.media_type as string) || 'image/png'};base64,${s.data}`;
                    }
                  }
                }
                if (!imgSrc && Array.isArray((r as any).content)) {
                  const imgBlock = ((r as any).content as unknown[]).find((b: unknown) => {
                    const bl = b as Record<string, unknown>;
                    return bl?.type === 'image' && typeof bl.source === 'object';
                  }) as Record<string, unknown> | undefined;
                  if (imgBlock) {
                    const s = imgBlock.source as Record<string, unknown>;
                    if (s?.type === 'base64' && typeof s.data === 'string') {
                      imgSrc = `data:${(s.media_type as string) || 'image/png'};base64,${s.data}`;
                    }
                  }
                }
                if (imgSrc) {
                  return <MediaPreview src={imgSrc} type="image" alt={filePath.split('/').pop()} />;
                }
                return <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />;
              })() : (
                <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto font-mono text-sm">
                  {String(result)}
                </pre>
              )
            )}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-claude-text-secondary">
            <Loader2 size={12} className="animate-spin" />
            <span>Reading file...</span>
          </div>
        ) : null}
      </div>
    );
  }

  // Special rendering for Bash tool - show command line
  if (name === 'Bash') {
    const command = (input.command as string) || '';

    // Show loading state if no command yet
    if (!command) {
      return (
        <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading command...</span>
        </div>
      );
    }

    return (
      <div className="space-y-2 text-xs">
        <div>
          <div className="text-claude-text-secondary mb-1 font-semibold">Command:</div>
          <pre className="whitespace-pre-wrap text-green-400 bg-black/50 p-2 overflow-x-auto font-mono border-l-2 border-green-500/30">
            $ {command}
          </pre>
        </div>

        {/* Result section */}
        {result !== undefined ? (
          <div>
            <div className="text-claude-text-secondary mb-1 font-semibold">Output:</div>
            {typeof result === 'object' ? (
              <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />
            ) : tryParseJSON(String(result)) ? (
              <JSONResultViewer data={tryParseJSON(String(result))} toolCallId={toolCall.id} priority={priority} />
            ) : (
              <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto font-mono text-sm">
                {String(result)}
              </pre>
            )}
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-2 text-claude-text-secondary">
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
        <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
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
      <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
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

    // Show loading state if no content yet
    if (!oldString && !newString && !filePath) {
      return (
        <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
          <Loader2 size={12} className="animate-spin" />
          <span>Preparing edit...</span>
        </div>
      );
    }

    if (oldString || newString) {
      return <DiffView oldString={oldString} newString={newString} filePath={filePath} toolCallId={toolCall.id} priority={priority} />;
    }

    // Have file path but no diff content yet
    return (
      <div className="flex items-center gap-2 text-xs text-claude-text-secondary">
        <Loader2 size={12} className="animate-spin" />
        <span>Loading changes for {filePath.split('/').pop() || filePath}...</span>
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
          <div key={index} className="flex items-start gap-2 text-xs">
            {todo.status === 'completed' ? (
              <CheckCircle2 size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
            ) : todo.status === 'in_progress' ? (
              <Clock size={14} className="text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" />
            ) : (
              <Circle size={14} className="text-claude-text-secondary flex-shrink-0 mt-0.5" />
            )}
            <span className={
              todo.status === 'completed'
                ? 'text-claude-text-secondary line-through'
                : todo.status === 'in_progress'
                  ? 'text-amber-400'
                  : 'text-claude-text'
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
          <div className="text-claude-text-secondary mb-1 font-semibold">Input:</div>
          {typeof input === 'object' ? (
            <JSONResultViewer data={input} toolCallId={`${toolCall.id}-input`} priority={priority} />
          ) : (
            <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-40 overflow-y-auto">
              {String(input)}
            </pre>
          )}
        </div>
      )}

      {/* Result section (if available) */}
      {result !== undefined && (
        <div>
          <div className="text-claude-text-secondary mb-1 font-semibold">Result:</div>
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
                        <pre key={idx} className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto">
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
            <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto">
              {contentBlockResult.text}
            </pre>
          ) : typeof result === 'object' ? (
            <JSONResultViewer data={result} toolCallId={toolCall.id} priority={priority} />
          ) : tryParseJSON(String(result)) ? (
            <JSONResultViewer data={tryParseJSON(String(result))} toolCallId={toolCall.id} priority={priority} />
          ) : (
            <pre className="whitespace-pre-wrap text-claude-text bg-claude-bg/50 p-2 overflow-x-auto max-h-60 overflow-y-auto">
              {String(result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function ToolCallCard({ toolCall, isLatest = false, isLatestToolCall = false, defaultCollapsed = false, onBackground }: ToolCallCardProps) {
  const normalizedToolCall = useMemo(() => normalizeToolCall(toolCall), [toolCall]);
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
  const Icon = config.icon;

  const commandDisplay = useMemo(() => formatToolInput(baseToolName, normalizedToolCall.input), [baseToolName, normalizedToolCall.input]);

  const isRunning = normalizedToolCall.status === 'running' || normalizedToolCall.status === 'pending';

  // Detect if this is a Task tool (subagent)
  const isTaskTool = baseToolName === 'Task';
  const subagentType = isTaskTool ? getSubagentType(normalizedToolCall.input) : null;

  // Detect if this is a running Bash command that can be backgrounded
  const isBashTool = baseToolName === 'Bash';
  const canBackground = isBashTool && isRunning && onBackground;

  // Status dot color
  const dotColor = isRunning ? 'bg-yellow-500' : 'bg-green-500';

  // Apply enhanced styling for Task tools
  const cardClasses = isTaskTool
    ? `font-mono text-sm bg-gradient-to-r ${config.bgGradient} border-l-4 ${config.borderColor} px-2 py-1 rounded`
    : 'font-mono text-sm';

  const buttonClasses = `w-full flex items-center gap-2 py-0.5 hover:bg-claude-surface/50 transition-colors text-left ${
    isTaskTool && isRunning ? 'animate-pulse-slow' : ''
  }`;

  return (
    <div className={cardClasses}>
      {/* Subagent type badge (Task tools only) */}
      {isTaskTool && subagentType && (
        <div className="mb-1 inline-block px-2 py-0.5 text-[10px] bg-purple-500/20 border border-purple-500/50 text-purple-300 font-bold tracking-wider rounded">
          {subagentType}
        </div>
      )}

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
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown size={12} className={config.color} />
        ) : (
          <ChevronRight size={12} className={config.color} />
        )}

        {/* Status dot */}
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor} ${isRunning ? 'animate-pulse' : ''}`}
        />

        {/* Tool icon and name (larger icon for Task tools) */}
        <Icon size={config.iconSize || 14} className={config.color} />
        <span className={`font-semibold ${config.color}`}>{config.label}</span>

        {/* Separator */}
        <span className="text-claude-text-secondary">·</span>

        {/* Input/command summary (always visible) */}
        <span className="text-claude-text truncate flex-1">
          {commandDisplay}
        </span>

        {/* Loading spinner for running tools */}
        {isRunning && (
          <Loader2 size={12} className="text-yellow-500 animate-spin flex-shrink-0" />
        )}

        {/* Background button for running Bash commands */}
        {canBackground && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBackground(normalizedToolCall);
            }}
            className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 border border-cyan-500/30 flex items-center gap-1"
            style={{ borderRadius: 0 }}
            title="Move to background (Cmd+B)"
          >
            <ArrowUpRight size={10} />
            <span>BG</span>
          </button>
        )}
      </div>

      {/* Expanded content - once rendered, hide with CSS to prevent Monaco disposal errors */}
      {hasBeenExpanded && (
        <div
          className="ml-6 mt-1 p-2 bg-claude-surface/30 border-l-2 border-current"
          style={{
            borderColor: config.color.replace('text-', ''),
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
