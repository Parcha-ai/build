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
    <div className="my-2 flex items-center justify-between gap-3 bg-ink-1 px-3 py-[9px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
      <div className="flex items-center gap-2 min-w-0">
        <Code2 size={14} className="text-fg-3 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg truncate">{title}</div>
          <div className="font-mono text-[11px] text-fg-5">
            {html.length.toLocaleString()} chars
          </div>
        </div>
      </div>
      <button
        onClick={openArtifact}
        disabled={!sessionId}
        className="flex h-[26px] flex-shrink-0 items-center gap-1.5 px-2.5 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-white/[0.04] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        title="Open HTML preview"
      >
        <PanelRight size={13} />
        Open Preview
      </button>
    </div>
  );
}
