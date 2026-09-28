import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, FileText, X } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import ChatMarkdownLink from '../chat/ChatMarkdownLink';

interface MarkdownResponsePanelProps {
  sessionId?: string | null;
}

export default function MarkdownResponsePanel({ sessionId }: MarkdownResponsePanelProps) {
  const toggleMarkdownPanel = useUIStore((s) => s.toggleMarkdownPanel);
  const clearMarkdownPanel = useUIStore((s) => s.clearMarkdownPanel);
  const panel = useUIStore(React.useCallback(
    (s) => sessionId ? s.sessionMarkdownPanels[sessionId] || null : null,
    [sessionId],
  ));
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [panel?.messageId]);

  const handleCopy = async () => {
    if (!panel?.content) return;
    try {
      await navigator.clipboard.writeText(panel.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleClear = () => {
    if (sessionId) clearMarkdownPanel(sessionId);
  };

  return (
    <div className="h-full flex flex-col bg-ink-1">
      <div className="h-11 flex items-center justify-between px-3 border-b border-line bg-ink-1">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-accent flex-shrink-0" />
          <span className="text-[13px] font-medium text-fg truncate">
            {panel?.title || 'Response Reader'}
          </span>
          {panel?.updatedAt && (
            <span className="text-[11px] font-mono text-fg-5 flex-shrink-0">
              {new Date(panel.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {panel && (
            <>
              <button
                onClick={handleCopy}
                className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
                title="Copy markdown"
              >
                {copied ? <Check size={14} className="text-diff-add" /> : <Copy size={14} />}
              </button>
            </>
          )}
          <button
            onClick={() => { handleClear(); toggleMarkdownPanel(); }}
            className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
            title="Close reader"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {panel ? (
        <div ref={contentRef} className="flex-1 overflow-auto p-4">
          <div className="prose prose-invert prose-sm max-w-none text-[14.5px] leading-[1.65] text-[#D4D4D4]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ children, ...props }) => (
                  <div className="overflow-x-auto my-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    <table className="w-full text-sm border-collapse" {...props}>{children}</table>
                  </div>
                ),
                thead: ({ children, ...props }) => (
                  <thead className="bg-ink-3" {...props}>{children}</thead>
                ),
                tbody: ({ children, ...props }) => (
                  <tbody {...props}>{children}</tbody>
                ),
                tr: ({ children, ...props }) => (
                  <tr className="border-b border-line" {...props}>{children}</tr>
                ),
                th: ({ children, ...props }) => (
                  <th className="px-3 py-2 text-left text-[13px] font-semibold text-fg border-r border-line last:border-r-0 whitespace-nowrap" {...props}>{children}</th>
                ),
                td: ({ children, ...props }) => (
                  <td className="px-3 py-2 text-[13px] border-r border-line last:border-r-0" {...props}>{children}</td>
                ),
                code: ({ children, className, ...props }) => {
                  const isBlock = className?.includes('language-');
                  if (isBlock) {
                    const lang = className?.replace('language-', '') || '';
                    return (
                      <div className="my-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] overflow-hidden">
                        {lang && (
                          <div className="px-3 py-1 text-[10.5px] font-mono text-fg-4 border-b border-line uppercase">
                            {lang}
                          </div>
                        )}
                        <pre className="p-3 overflow-x-auto bg-[#0B0B0B] font-mono text-[12.5px] leading-relaxed">
                          <code className={className} {...props}>{children}</code>
                        </pre>
                      </div>
                    );
                  }
                  return (
                    <code className="px-1.5 py-0.5 bg-ink-4 text-fg-2 font-mono text-[0.9em]" {...props}>
                      {children}
                    </code>
                  );
                },
                p: ({ children, ...props }) => <p className="my-2 leading-relaxed" {...props}>{children}</p>,
                h1: ({ children, ...props }) => <h1 className="text-xl font-semibold tracking-[-0.02em] text-fg mt-6 mb-3 pb-2 border-b border-line" {...props}>{children}</h1>,
                h2: ({ children, ...props }) => <h2 className="text-lg font-semibold tracking-[-0.02em] text-fg mt-5 mb-2" {...props}>{children}</h2>,
                h3: ({ children, ...props }) => <h3 className="text-base font-semibold tracking-[-0.01em] text-fg mt-4 mb-2" {...props}>{children}</h3>,
                ul: ({ children, ...props }) => <ul className="my-2 pl-5 list-disc space-y-1" {...props}>{children}</ul>,
                ol: ({ children, ...props }) => <ol className="my-2 pl-5 list-decimal space-y-1" {...props}>{children}</ol>,
                li: ({ children, ...props }) => <li className="leading-relaxed" {...props}>{children}</li>,
                blockquote: ({ children, ...props }) => (
                  <blockquote className="border-l-2 border-line-strong pl-3 my-3 text-fg-3 italic" {...props}>{children}</blockquote>
                ),
                a: ({ children, href }) => (
                  <ChatMarkdownLink href={href} sessionId={sessionId || undefined}>{children}</ChatMarkdownLink>
                ),
                strong: ({ children, ...props }) => <strong className="font-semibold text-fg" {...props}>{children}</strong>,
                hr: (props) => <hr className="my-4 border-line" {...props} />,
              }}
            >
              {panel.content}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-fg-4 p-4">
          <FileText size={32} className="mb-3 opacity-50" />
          <p className="text-[13px] text-center">No response loaded</p>
        </div>
      )}
    </div>
  );
}
