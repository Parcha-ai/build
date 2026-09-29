import React, { useState, useCallback, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth.store';
import { useUIStore } from '../../stores/ui.store';
import SessionList from '../session/SessionList';
import AgentSidebarContent from '../agent-view/AgentSidebarContent';
import TaskList from '../tasks/TaskList';
import NewSessionDialog from '../session/NewSessionDialog';
import { Plus, LogOut, GripVertical, LayoutGrid, Users, BarChart3, SlidersHorizontal } from 'lucide-react';

export default function Sidebar() {
  const { logout, user } = useAuthStore();
  const { sidebarWidth, setSidebarWidth, isCommandCenterActive, toggleCommandCenter, isAgentViewActive, toggleAgentView, isAnalyticsPanelOpen, toggleAnalyticsPanel, isNewSessionDialogOpen, setNewSessionDialogOpen } = useUIStore();
  const openSettings = useUIStore((s) => s.openSettings);
  const [isResizing, setIsResizing] = useState(false);
  const [todayCost, setTodayCost] = useState<number | null>(null);

  // Today's spend next to the Usage row (read-only analytics summary).
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.electronAPI?.analytics?.getSummary?.()
        .then((summary: { todayTotalCost?: number }) => {
          if (!cancelled && typeof summary?.todayTotalCost === 'number') setTodayCost(summary.todayTotalCost);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsub = window.electronAPI?.analytics?.onTokenEvent?.(() => refresh());
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(500, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth, setSidebarWidth]);

  const initials = (user?.name || user?.login || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

  const navRowClass = (active: boolean) =>
    `w-full h-8 flex items-center gap-2.5 px-2.5 text-[13px] text-left transition-colors ${
      active
        ? 'bg-claude-surface-hover text-fg'
        : 'text-fg-3 hover:bg-claude-surface-hover hover:text-fg-2'
    }`;

  return (
    <div className="flex">
      <div
        className="flex flex-col bg-ink-0 font-sans"
        style={{ width: sidebarWidth }}
      >
      {/* New session + primary nav */}
      <div className="px-2.5 pt-3 flex flex-col">
        {!isAgentViewActive && (
          <button
            onClick={() => setNewSessionDialogOpen(true)}
            className="h-9 w-full flex items-center gap-2 px-3 bg-claude-surface-hover shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] text-[13px] font-medium text-fg hover:bg-[#262626] transition-colors"
            title="New Session"
          >
            <Plus size={15} strokeWidth={2} />
            <span className="flex-1 text-left">New session</span>
            <span className="font-mono text-[11px] text-fg-4">⌘N</span>
          </button>
        )}

        <div className={`flex flex-col gap-px ${!isAgentViewActive ? 'mt-3' : ''}`}>
          <button
            onClick={toggleCommandCenter}
            className={navRowClass(isCommandCenterActive)}
            title="Command Center (Cmd+Shift+G)"
          >
            <LayoutGrid size={15} strokeWidth={1.8} className={isCommandCenterActive ? 'text-accent' : ''} />
            <span className="flex-1">Command Center</span>
            <span className="font-mono text-[11px] text-fg-5">⇧⌘G</span>
          </button>
          <button
            onClick={toggleAgentView}
            className={navRowClass(isAgentViewActive)}
            title="Agent View (Cmd+Shift+A)"
          >
            <Users size={15} strokeWidth={1.8} className={isAgentViewActive ? 'text-accent' : ''} />
            <span className="flex-1">Agent view</span>
          </button>
          <button
            onClick={toggleAnalyticsPanel}
            className={navRowClass(isAnalyticsPanelOpen)}
            title="Token Analytics"
          >
            <BarChart3 size={15} strokeWidth={1.8} className={isAnalyticsPanelOpen ? 'text-accent' : ''} />
            <span className="flex-1">Usage</span>
            {todayCost !== null && (
              <span className="font-mono text-[11px] text-fg-5">${todayCost.toFixed(2)}</span>
            )}
          </button>
        </div>
      </div>

      {/* Task List (Today block) */}
      <div className="px-2.5 mt-4">
        <TaskList />
      </div>

      {/* Section header — only in agent view (session list carries its own group labels) */}
      {isAgentViewActive ? (
        <div className="px-5 pt-3.5 pb-1.5 flex items-center">
          <h3 className="text-[11px] font-normal uppercase tracking-[0.04em] text-fg-4">
            Agent view
          </h3>
        </div>
      ) : (
        <div className="h-2" />
      )}

      {/* Content — agent priority list or session list */}
      {isAgentViewActive ? (
        <AgentSidebarContent />
      ) : (
        <div className="flex-1 overflow-y-auto px-2.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-[#2B2B2B]">
          <SessionList />
        </div>
      )}

      {/* Footer */}
      <div className="mx-2.5 mb-2.5 px-2 pt-2.5 pb-0.5 flex items-center gap-2.5 border-t border-line">
        <span
          className="w-[26px] h-[26px] flex-shrink-0 flex items-center justify-center bg-[#333333] text-[11px] font-semibold text-fg overflow-hidden"
          title={user?.login}
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            initials
          )}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-fg-2">
          {user?.name || user?.login || ''}
        </span>
        <button
          onClick={openSettings}
          className="w-7 h-7 flex items-center justify-center transition-colors text-fg-4 hover:bg-claude-surface-hover hover:text-fg-2"
          title="Settings"
        >
          <SlidersHorizontal size={15} strokeWidth={1.8} />
        </button>
        <button
          onClick={logout}
          className="w-7 h-7 -ml-2 flex items-center justify-center transition-colors text-fg-5 hover:bg-claude-surface-hover hover:text-diff-del"
          title="Logout"
        >
          <LogOut size={13} strokeWidth={1.8} />
        </button>
      </div>

      {/* New Session Dialog */}
      <NewSessionDialog
        isOpen={isNewSessionDialogOpen}
        onClose={() => setNewSessionDialogOpen(false)}
      />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        className={`w-px hover:w-1 bg-line hover:bg-claude-accent cursor-col-resize transition-all ${
          isResizing ? 'w-1 bg-claude-accent' : ''
        }`}
      >
        <div className="h-full flex items-center justify-center">
          <GripVertical size={12} className="text-claude-text-secondary opacity-0 hover:opacity-100" />
        </div>
      </div>
    </div>
  );
}
