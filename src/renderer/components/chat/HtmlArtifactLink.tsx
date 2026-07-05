import React, { useCallback, useEffect } from 'react';
import { Code2, PanelRight } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';

interface HtmlArtifactLinkProps {
  sessionId?: string;
  html: string;
  messageId: string;
  autoOpen?: boolean;
  title?: string;
}

export default function HtmlArtifactLink({
  sessionId,
  html,
  messageId,
  autoOpen = false,
  title = 'HTML Response',
}: HtmlArtifactLinkProps) {
  const setHtmlArtifact = useUIStore((s) => s.setHtmlArtifact);

  const openArtifact = useCallback(() => {
    if (!sessionId) return;
    setHtmlArtifact(sessionId, {
      html,
      messageId,
      title,
    });
  }, [html, messageId, sessionId, setHtmlArtifact, title]);

  useEffect(() => {
    if (autoOpen) {
      openArtifact();
    }
  }, [autoOpen, openArtifact]);

  return (
    <div className="my-2 border border-purple-500/30 bg-purple-500/10 px-3 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Code2 size={14} className="text-purple-400 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-mono text-claude-text truncate">{title}</div>
          <div className="text-[10px] font-mono text-claude-text-secondary">
            {html.length.toLocaleString()} chars
          </div>
        </div>
      </div>
      <button
        onClick={openArtifact}
        disabled={!sessionId}
        className="flex items-center gap-1.5 px-2 py-1 text-xs font-mono font-bold text-purple-300 border border-purple-500/40 hover:bg-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        title="Open HTML preview"
        style={{ borderRadius: 0 }}
      >
        <PanelRight size={13} />
        Open Preview
      </button>
    </div>
  );
}
