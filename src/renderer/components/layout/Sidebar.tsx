import React, { useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/auth.store';
import { useUIStore } from '../../stores/ui.store';
import SessionList from '../session/SessionList';
import AgentSidebarContent from '../agent-view/AgentSidebarContent';
import TaskList from '../tasks/TaskList';
import NewSessionDialog from '../session/NewSessionDialog';
import { Plus, LogOut, GripVertical, LayoutGrid, Users, BarChart3 } from 'lucide-react';

export default function Sidebar() {
  const { logout } = useAuthStore();
  const { sidebarWidth, setSidebarWidth, isCommandCenterActive, toggleCommandCenter, isAgentViewActive, toggleAgentView, isAnalyticsPanelOpen, toggleAnalyticsPanel, isNewSessionDialogOpen, setNewSessionDialogOpen } = useUIStore();
  const [isResizing, setIsResizing] = useState(false);

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

  return (
    <div className="flex">
      <div
        className="flex flex-col font-mono bg-claude-surface"
        style={{ width: sidebarWidth }}
      >
      {/* Task List — above everything */}
      <TaskList />

      {/* Header — switches between SESSIONS and AGENT VIEW */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-claude-border">
        <h3
          className="text-[10px] font-bold text-claude-text-secondary"
          style={{ letterSpacing: '0.1em' }}
        >
          {isAgentViewActive ? 'AGENT VIEW' : 'SESSIONS'}
        </h3>
        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleCommandCenter}
            className={`p-1 transition-colors ${
              isCommandCenterActive
                ? 'bg-claude-accent/20 text-claude-accent'
                : 'hover:bg-claude-bg text-claude-text-secondary'
            }`}
            style={{ borderRadius: 0 }}
            title="Command Center (Cmd+Shift+G)"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={toggleAgentView}
            className={`p-1 transition-colors ${
              isAgentViewActive
                ? 'bg-claude-accent/20 text-claude-accent'
                : 'hover:bg-claude-bg text-claude-text-secondary'
            }`}
            style={{ borderRadius: 0 }}
            title="Agent View (Cmd+Shift+A)"
          >
            <Users size={14} />
          </button>
          <button
            onClick={toggleAnalyticsPanel}
            className={`p-1 transition-colors ${
              isAnalyticsPanelOpen
                ? 'bg-claude-accent/20 text-claude-accent'
                : 'hover:bg-claude-bg text-claude-text-secondary'
            }`}
            style={{ borderRadius: 0 }}
            title="Token Analytics"
          >
            <BarChart3 size={14} />
          </button>
          {!isAgentViewActive && (
            <button
              onClick={() => setNewSessionDialogOpen(true)}
              className="p-1 transition-colors hover:bg-claude-bg text-claude-text-secondary"
              style={{ borderRadius: 0 }}
              title="New Session"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Content — agent priority list or session list */}
      {isAgentViewActive ? (
        <AgentSidebarContent />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <SessionList />
        </div>
      )}

      {/* Footer */}
      <div className="p-2 flex items-center justify-end border-t border-claude-border">
        <button
          onClick={logout}
          className="p-1.5 transition-colors hover:bg-claude-bg text-claude-text-secondary hover:text-red-400"
          style={{ borderRadius: 0 }}
          title="Logout"
        >
          <LogOut size={12} />
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
        className={`w-1 hover:w-1.5 bg-claude-border hover:bg-claude-accent cursor-col-resize transition-all ${
          isResizing ? 'w-1.5 bg-claude-accent' : ''
        }`}
      >
        <div className="h-full flex items-center justify-center">
          <GripVertical size={12} className="text-claude-text-secondary opacity-0 hover:opacity-100" />
        </div>
      </div>
    </div>
  );
}
