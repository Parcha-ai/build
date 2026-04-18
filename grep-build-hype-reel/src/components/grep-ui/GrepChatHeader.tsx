// Faithful recreation of Claudette's ChatContainer header with fork tabs

import React from "react";
import { GitFork, X } from "lucide-react";

interface ForkTab {
  id: string;
  name: string;
}

interface GrepChatHeaderProps {
  sessionName: string;
  status?: 'running' | 'stopped' | 'error';
  forkTabs?: ForkTab[];
  activeTabId?: string;
}

export function GrepChatHeader({
  sessionName,
  status = 'running',
  forkTabs = [],
  activeTabId,
}: GrepChatHeaderProps) {
  const hasRoot = true;
  const allTabs = [
    { id: 'root', name: sessionName, isRoot: true },
    ...forkTabs.map(f => ({ ...f, isRoot: false })),
  ];
  const currentActiveId = activeTabId || 'root';

  return (
    <div className="border-b border-claude-border bg-claude-surface/50 flex-shrink-0">
      {/* Tab bar */}
      <div className="flex items-center">
        {allTabs.map((tab, i) => {
          const isActive = tab.id === currentActiveId;
          return (
            <div
              key={tab.id}
              className="flex items-center gap-2 px-4 py-2.5 border-r border-claude-border"
              style={{
                backgroundColor: isActive ? '#1a1a1a' : 'transparent',
                borderBottom: isActive ? '2px solid #8B8DFF' : '2px solid transparent',
                minWidth: 0,
              }}
            >
              {!tab.isRoot && (
                <GitFork size={12} className="text-claude-accent flex-shrink-0" style={{ transform: 'rotate(180deg)' }} />
              )}
              <span
                className={`text-xs font-bold truncate ${isActive ? 'text-claude-text' : 'text-claude-text-secondary'}`}
                style={{ letterSpacing: '0.05em' }}
              >
                {tab.isRoot ? tab.name.toUpperCase() : tab.name}
              </span>
              {tab.isRoot && status === 'running' && (
                <span
                  className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-green-500/20 text-green-500 flex-shrink-0"
                  style={{ borderRadius: 0, letterSpacing: '0.05em' }}
                >
                  ACTIVE
                </span>
              )}
              {!tab.isRoot && (
                <X size={10} className="text-claude-text-secondary flex-shrink-0 opacity-50" />
              )}
            </div>
          );
        })}

        {/* Spacer to fill rest of header */}
        <div className="flex-1" />
      </div>
    </div>
  );
}
