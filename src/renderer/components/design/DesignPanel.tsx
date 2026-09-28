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
    <div className="h-full flex flex-col bg-ink-1">
      {!chromeless && (
      <div className="h-11 flex items-center justify-between px-3 border-b border-line bg-ink-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-accent flex-shrink-0"><OpenDesignIcon size={15} /></span>
          <span className="text-[13px] font-medium text-fg truncate">Design Mode</span>
          {panel?.workspaceDir && (
            <span className="text-[11px] font-mono text-fg-5 truncate" title={panel.workspaceDir}>
              {panel.workspaceDir.split('/').slice(-2).join('/')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {panel && (
            <>
              <button
                onClick={handleReload}
                className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
                title="Reload canvas"
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={handleOpenExternal}
                className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
                title="Open in browser"
              >
                <ExternalLink size={14} />
              </button>
            </>
          )}
          <button
            onClick={toggleDesignPanel}
            className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
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
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fg-4 px-6 text-center">
          <span className="text-fg-5"><OpenDesignIcon size={28} /></span>
          <p className="text-[13px] text-fg-3 max-w-sm">
            Design Mode opens a live design canvas here. Ask the agent to design something, or start a design
            workspace for this session now.
          </p>
          <button
            onClick={handleActivate}
            disabled={!sessionId || isActivating}
            className="h-8 px-3 bg-[#EDEDED] text-[13px] font-semibold text-[#0F0F0F] hover:bg-white disabled:opacity-50 flex items-center gap-2"
          >
            {isActivating && <Loader2 size={14} className="animate-spin" />}
            {isActivating ? 'Starting Design Mode…' : 'Start design workspace'}
          </button>
          {activationError && (
            <p className="text-[12px] text-diff-del-text max-w-sm break-words">{activationError}</p>
          )}
        </div>
      )}
    </div>
  );
}
