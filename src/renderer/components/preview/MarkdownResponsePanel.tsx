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
    <div className="h-full flex flex-col bg-claude-bg">
      <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-blue-400 flex-shrink-0" />
          <span className="text-sm font-medium truncate font-mono">
            {panel?.title || 'Response Reader'}
          </span>
          {panel?.updatedAt && (
            <span className="text-[10px] font-mono text-claude-text-secondary flex-shrink-0">
              {new Date(panel.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {panel && (
            <>
              <button
                onClick={handleCopy}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Copy markdown"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </>
          )}
          <button
            onClick={() => { handleClear(); toggleMarkdownPanel(); }}
            className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
            title="Close reader"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {panel ? (
        <div ref={contentRef} className="flex-1 overflow-auto p-4">
          <div className="prose prose-invert prose-sm max-w-none font-mono text-claude-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ children, ...props }) => (
                  <div className="overflow-x-auto my-4 border border-claude-border">
                    <table className="w-full text-sm border-collapse" {...props}>{children}</table>
                  </div>
                ),
                thead: ({ children, ...props }) => (
                  <thead className="bg-claude-surface" {...props}>{children}</thead>
                ),
                tbody: ({ children, ...props }) => (
                  <tbody {...props}>{children}</tbody>
                ),
                tr: ({ children, ...props }) => (
                  <tr className="border-b border-claude-border" {...props}>{children}</tr>
                ),
                th: ({ children, ...props }) => (
                  <th className="px-3 py-2 text-left text-sm font-bold border-r border-claude-border last:border-r-0 whitespace-nowrap" {...props}>{children}</th>
                ),
                td: ({ children, ...props }) => (
                  <td className="px-3 py-2 text-sm border-r border-claude-border last:border-r-0" {...props}>{children}</td>
                ),
                code: ({ children, className, ...props }) => {
                  const isBlock = className?.includes('language-');
                  if (isBlock) {
                    const lang = className?.replace('language-', '') || '';
                    return (
                      <div className="my-3 border border-claude-border overflow-hidden" style={{ borderRadius: 0 }}>
                        {lang && (
                          <div className="px-3 py-1 bg-claude-surface text-[10px] font-mono text-claude-text-secondary border-b border-claude-border uppercase">
                            {lang}
                          </div>
                        )}
                        <pre className="p-3 overflow-x-auto bg-claude-bg text-sm leading-relaxed">
                          <code className={className} {...props}>{children}</code>
                        </pre>
                      </div>
                    );
                  }
                  return (
                    <code className="px-1.5 py-0.5 bg-claude-surface text-claude-accent text-sm" style={{ borderRadius: 0 }} {...props}>
                      {children}
                    </code>
                  );
                },
                p: ({ children, ...props }) => <p className="my-2 leading-relaxed" {...props}>{children}</p>,
                h1: ({ children, ...props }) => <h1 className="text-xl font-bold mt-6 mb-3 pb-2 border-b border-claude-border" {...props}>{children}</h1>,
                h2: ({ children, ...props }) => <h2 className="text-lg font-bold mt-5 mb-2" {...props}>{children}</h2>,
                h3: ({ children, ...props }) => <h3 className="text-base font-bold mt-4 mb-2" {...props}>{children}</h3>,
                ul: ({ children, ...props }) => <ul className="my-2 pl-5 list-disc space-y-1" {...props}>{children}</ul>,
                ol: ({ children, ...props }) => <ol className="my-2 pl-5 list-decimal space-y-1" {...props}>{children}</ol>,
                li: ({ children, ...props }) => <li className="leading-relaxed" {...props}>{children}</li>,
                blockquote: ({ children, ...props }) => (
                  <blockquote className="border-l-2 border-claude-accent pl-3 my-3 text-claude-text-secondary italic" {...props}>{children}</blockquote>
                ),
                a: ({ children, href }) => (
                  <ChatMarkdownLink href={href} sessionId={sessionId || undefined}>{children}</ChatMarkdownLink>
                ),
                strong: ({ children, ...props }) => <strong className="font-bold text-claude-text" {...props}>{children}</strong>,
                hr: (props) => <hr className="my-4 border-claude-border" {...props} />,
              }}
            >
              {panel.content}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-claude-text-secondary p-4">
          <FileText size={32} className="mb-3 opacity-50" />
          <p className="text-sm font-mono text-center">No response loaded</p>
        </div>
      )}
    </div>
  );
}
