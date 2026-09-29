import React, { useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Copy } from 'lucide-react';

interface BtwOverlayProps {
  question: string;
  response: string;
  isStreaming: boolean;
  onDismiss: () => void;
}

export default function BtwOverlay({ question, response, isStreaming, onDismiss }: BtwOverlayProps) {
  // Dismiss on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onDismiss();
    }
  }, [onDismiss]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCopy = () => {
    navigator.clipboard.writeText(response);
  };

  return (
    <div className="mx-6 mt-2 flex max-h-64 flex-col bg-ink-3 text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.35)]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[10.5px] uppercase text-fg-4" style={{ letterSpacing: '0.04em' }}>/BTW</span>
          <span className="max-w-[300px] truncate text-[12px] text-fg-4">{question}</span>
        </div>
        <div className="flex items-center gap-1">
          {response && (
            <button
              onClick={handleCopy}
              className="p-1 text-fg-4 hover:bg-white/[0.05] hover:text-fg"
              title="Copy response"
            >
              <Copy size={12} />
            </button>
          )}
          <button
            onClick={onDismiss}
            className="p-1 text-fg-4 hover:bg-white/[0.05] hover:text-fg"
            title="Dismiss (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Response */}
      <div className="flex-1 overflow-y-auto px-3 py-2 text-[13.5px] leading-[1.6]">
        {response ? (
          <div className="prose prose-sm prose-invert max-w-none text-[13.5px] leading-[1.6] text-[#D4D4D4] [&_p]:my-1 [&_code]:bg-[#262626] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px] [&_code]:before:content-none [&_code]:after:content-none [&_pre]:bg-[#0B0B0B] [&_pre]:p-2.5 [&_pre]:rounded-none">
            <ReactMarkdown>{response}</ReactMarkdown>
          </div>
        ) : isStreaming ? (
          <span className="text-shimmer">Thinking...</span>
        ) : null}
        {isStreaming && response && (
          <span className="status-pulse ml-1 inline-block h-[7px] w-[7px] rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}
