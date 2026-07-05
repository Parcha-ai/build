import React, { useMemo, useState } from 'react';
import { Check, Code2, Copy, ExternalLink, Trash2, X } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';

interface HtmlArtifactPanelProps {
  sessionId?: string | null;
}

export default function HtmlArtifactPanel({ sessionId }: HtmlArtifactPanelProps) {
  const toggleHtmlPanel = useUIStore((s) => s.toggleHtmlPanel);
  const clearHtmlArtifact = useUIStore((s) => s.clearHtmlArtifact);
  const artifact = useUIStore(React.useCallback(
    (s) => sessionId ? s.sessionHtmlArtifacts[sessionId] || null : null,
    [sessionId],
  ));
  const [copied, setCopied] = useState(false);

  const srcDoc = useMemo(() => artifact?.html || '', [artifact?.html]);

  const handleCopy = async () => {
    if (!artifact?.html) return;
    try {
      await navigator.clipboard.writeText(artifact.html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail in restricted contexts.
    }
  };

  const handleOpenExternal = () => {
    if (!artifact?.html) return;
    try {
      const encoded = btoa(unescape(encodeURIComponent(artifact.html)));
      window.electronAPI.app.openExternal(`data:text/html;base64,${encoded}`);
    } catch {
      // Opening external data URLs can fail; keep the in-app preview available.
    }
  };

  const handleClear = () => {
    if (sessionId) {
      clearHtmlArtifact(sessionId);
    }
  };

  return (
    <div className="h-full flex flex-col bg-claude-bg">
      <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
        <div className="flex items-center gap-2 min-w-0">
          <Code2 size={14} className="text-purple-400 flex-shrink-0" />
          <span className="text-sm font-medium truncate">
            {artifact?.title || 'HTML Preview'}
          </span>
          {artifact?.updatedAt && (
            <span className="text-[10px] font-mono text-claude-text-secondary flex-shrink-0">
              {new Date(artifact.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {artifact && (
            <>
              <button
                onClick={handleOpenExternal}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Open in browser"
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={handleCopy}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Copy HTML"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
              <button
                onClick={handleClear}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Clear HTML preview"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
          <button
            onClick={toggleHtmlPanel}
            className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
            title="Close HTML preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {artifact ? (
        <iframe
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          className="flex-1 w-full border-0 bg-[#1a1a2e]"
          title="HTML Response Preview"
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-claude-text-secondary p-4">
          <Code2 size={32} className="mb-3 opacity-50" />
          <p className="text-sm font-mono text-center">No HTML response loaded</p>
        </div>
      )}
    </div>
  );
}
