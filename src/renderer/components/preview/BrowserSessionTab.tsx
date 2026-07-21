import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Session } from '../../../shared/types';
import type { BrowserWorkspaceTab } from '../../stores/ui.store';
import { useUIStore } from '../../stores/ui.store';

interface BrowserSessionTabProps {
  tab: BrowserWorkspaceTab;
  ownerSession?: Session;
  isActive: boolean;
  onActivate: () => void;
  compact?: boolean;
}

export default function BrowserSessionTab({ tab, ownerSession, isActive, onActivate, compact = false }: BrowserSessionTabProps) {
  const renameBrowserTab = useUIStore((state) => state.renameBrowserTab);
  const closeBrowserTab = useUIStore((state) => state.closeBrowserTab);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(tab.name);

  useEffect(() => {
    if (!isEditing) setDraft(tab.name);
  }, [isEditing, tab.name]);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const beginRename = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(tab.name);
    setIsEditing(true);
  };

  const commitRename = () => {
    if (!isEditing) return;
    setIsEditing(false);
    renameBrowserTab(tab.id, draft);
  };

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      data-browser-tab-id={tab.id}
      data-browser-owner-session-id={tab.ownerSessionId}
      onClick={() => { if (!isEditing) onActivate(); }}
      onDoubleClick={beginRename}
      onKeyDown={(event) => {
        if (!isEditing && (event.key === 'Enter' || event.key === ' ')) onActivate();
      }}
      title={isEditing ? undefined : 'Double-click to rename browser tab'}
      className={`group flex items-center gap-1.5 pl-3 pr-1 border-r border-claude-border transition-colors whitespace-nowrap cursor-pointer ${
        compact ? 'h-8 text-[10px] font-mono font-bold uppercase' : 'py-2 text-xs font-mono'
      } ${
        isActive
          ? 'bg-claude-bg text-claude-text'
          : 'bg-claude-surface text-claude-text-secondary hover:bg-claude-bg/50'
      }`}
      style={compact ? { letterSpacing: '0.05em' } : undefined}
    >
      <div
        className={`w-1.5 h-1.5 flex-shrink-0 ${ownerSession?.status === 'running' ? 'bg-green-500' : 'bg-gray-500'}`}
        style={{ borderRadius: 0 }}
      />
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(tab.name);
              setIsEditing(false);
            }
          }}
          aria-label="Browser tab name"
          className="w-[140px] min-w-0 bg-claude-surface border border-claude-accent px-1 py-0.5 text-inherit font-inherit outline-none normal-case"
        />
      ) : (
        <span className={`truncate ${compact ? 'max-w-[140px]' : 'max-w-[120px]'}`}>{tab.name}</span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          closeBrowserTab(tab.id);
        }}
        className="ml-1 p-0.5 text-claude-text-secondary opacity-0 group-hover:opacity-100 hover:text-claude-text"
        title="Close browser tab"
        aria-label={`Close ${tab.name}`}
      >
        <X size={11} />
      </button>
    </div>
  );
}
