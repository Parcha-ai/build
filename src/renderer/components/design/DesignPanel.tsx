import React, { useCallback, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, X, Loader2 } from 'lucide-react';
import OpenDesignIcon from './OpenDesignIcon';
import { useUIStore } from '../../stores/ui.store';

interface DesignPanelProps {
  sessionId?: string | null;
  /** Hide the panel's own header (used in full-takeover mode where MainContent provides the bar) */
  chromeless?: boolean;
}

/**
 * Design mode panel — embeds the Open Design canvas (artifact tree, live
 * preview, chat rail) served by the local OD daemon. The agent writes HTML
 * explorations into the session's design workspace; OD's file watcher
 * hot-reloads the preview, so the user watches designs evolve live.
 */
export default function DesignPanel({ sessionId, chromeless }: DesignPanelProps) {
  const toggleDesignPanel = useUIStore((s) => s.toggleDesignPanel);
  const showDesignPanel = useUIStore((s) => s.showDesignPanel);
  const panel = useUIStore(
    useCallback((s) => (sessionId ? s.sessionDesignPanels[sessionId] || null : null), [sessionId])
  );
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  // Manual activation path (panel opened without the agent's DesignMode tool)
  const handleActivate = async () => {
    if (!sessionId) return;
    setIsActivating(true);
    setActivationError(null);
    try {
      const workspace = await window.electronAPI.design.ensureWorkspace(sessionId);
      showDesignPanel(sessionId, { url: workspace.panelUrl, workspaceDir: workspace.workspaceDir }, true);
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsActivating(false);
    }
  };

  const handleReload = () => {
    webviewRef.current?.reload();
  };

  const handleOpenExternal = () => {
    if (panel?.url) window.electronAPI.app.openExternal(panel.url);
  };

  return (
    <div className="h-full flex flex-col bg-claude-bg">
      {!chromeless && (
      <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-pink-400 flex-shrink-0"><OpenDesignIcon size={15} /></span>
          <span className="text-sm font-medium truncate">Design</span>
          {panel?.workspaceDir && (
            <span className="text-[10px] font-mono text-claude-text-secondary truncate" title={panel.workspaceDir}>
              {panel.workspaceDir.split('/').slice(-2).join('/')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {panel && (
            <>
              <button
                onClick={handleReload}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Reload canvas"
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={handleOpenExternal}
                className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
                title="Open in browser"
              >
                <ExternalLink size={14} />
              </button>
            </>
          )}
          <button
            onClick={toggleDesignPanel}
            className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
            title="Close design panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      )}

      {panel ? (
        <div className="flex-1 relative">
          <webview
            ref={webviewRef}
            src={panel.url}
            className="w-full h-full"
            partition="persist:design"
          />
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-claude-text-secondary px-6 text-center">
          <span className="text-pink-400/60"><OpenDesignIcon size={28} /></span>
          <p className="text-sm max-w-sm">
            Design mode embeds an Open Design canvas here. Ask the agent to design something, or start a design
            workspace for this session now.
          </p>
          <button
            onClick={handleActivate}
            disabled={!sessionId || isActivating}
            className="px-3 py-1.5 rounded bg-claude-surface border border-claude-border text-sm text-claude-text hover:bg-claude-bg disabled:opacity-50 flex items-center gap-2"
          >
            {isActivating && <Loader2 size={14} className="animate-spin" />}
            {isActivating ? 'Starting Open Design…' : 'Start design workspace'}
          </button>
          {activationError && (
            <p className="text-xs text-red-400 max-w-sm break-words">{activationError}</p>
          )}
        </div>
      )}
    </div>
  );
}
