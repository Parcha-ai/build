import React, { useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Copy, Square, Terminal, FileEdit, ChevronDown, ChevronRight } from 'lucide-react';

interface CodexToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: string;
  result?: string;
}

interface CodexOverlayProps {
  prompt: string;
  content: string;
  thinking: string;
  toolCalls: CodexToolCall[];
  error: string | null;
  isStreaming: boolean;
  onDismiss: () => void;
  onCancel: () => void;
}

function ToolCallCard({ toolCall }: { toolCall: CodexToolCall }) {
  const [expanded, setExpanded] = React.useState(false);
  const isRunning = toolCall.status === 'running';
  const isFailed = toolCall.status === 'failed';

  const icon = toolCall.name === 'Bash' ? (
    <Terminal size={12} className="text-fg-4" />
  ) : (
    <FileEdit size={12} className="text-fg-4" />
  );

  const label = toolCall.name === 'Bash'
    ? (toolCall.input?.command as string || 'command')
    : toolCall.name;

  return (
    <div className={`my-1 bg-ink-1 text-[12px] ${isFailed ? 'shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)]' : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-[7px] text-fg-5 hover:bg-white/[0.03] text-left"
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {icon}
        <span className="truncate flex-1 text-fg font-mono text-[12px]">{label}</span>
        {isRunning && <span className="status-pulse w-[7px] h-[7px] rounded-full bg-accent" />}
        {isFailed && <span className="font-mono text-diff-del text-[10.5px]">FAILED</span>}
      </button>
      {expanded && toolCall.result && (
        <pre className="bg-[#0B0B0B] px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-fg-4 border-t border-white/[0.05] overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
          {toolCall.result}
        </pre>
      )}
    </div>
  );
}

export default function CodexOverlay({
  prompt,
  content,
  thinking,
  toolCalls,
  error,
  isStreaming,
  onDismiss,
  onCancel,
}: CodexOverlayProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isStreaming) {
        onCancel();
      } else {
        onDismiss();
      }
    }
  }, [isStreaming, onDismiss, onCancel]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
  };

  return (
    <div className="border-t border-white/[0.06] bg-ink-3 text-fg-2 max-h-80 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-fg-3">/CODEX</span>
          <span className="text-[12px] text-fg-4 truncate max-w-[300px]">{prompt}</span>
        </div>
        <div className="flex items-center gap-1">
          {isStreaming && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-2 py-0.5 hover:bg-white/[0.05] text-fg-4 hover:text-diff-del text-[11px]"
              title="Cancel (Esc)"
            >
              <Square size={10} />
              <span>Stop</span>
            </button>
          )}
          {content && (
            <button
              onClick={handleCopy}
              className="p-1 hover:bg-white/[0.05] text-fg-4 hover:text-fg"
              title="Copy response"
            >
              <Copy size={12} />
            </button>
          )}
          <button
            onClick={isStreaming ? onCancel : onDismiss}
            className="p-1 hover:bg-white/[0.05] text-fg-4 hover:text-fg"
            title="Dismiss (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Thinking block (collapsible) */}
      {thinking && (
        <details className="border-b border-white/5">
          <summary className="px-3 py-1 text-[11px] text-fg-5 cursor-pointer hover:text-fg-3">
            Reasoning...
          </summary>
          <div className="px-3 py-1 text-[11.5px] text-fg-5 max-h-20 overflow-y-auto whitespace-pre-wrap">
            {thinking}
          </div>
        </details>
      )}

      {/* Tool calls */}
      {toolCalls.length > 0 && (
        <div className="px-3 py-1 border-b border-white/5">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {/* Response content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 text-[13.5px] leading-[1.6]">
        {error ? (
          <div className="text-diff-del-text text-[12.5px]">{error}</div>
        ) : content ? (
          <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 text-[#D4D4D4] [&_code]:bg-[#262626] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px] [&_code]:before:content-none [&_code]:after:content-none [&_pre]:bg-[#0B0B0B] [&_pre]:p-2.5 [&_pre]:rounded-none">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : isStreaming ? (
          <span className="text-shimmer">Codex is thinking...</span>
        ) : null}
        {isStreaming && content && (
          <span className="status-pulse ml-1 inline-block h-[7px] w-[7px] rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}
