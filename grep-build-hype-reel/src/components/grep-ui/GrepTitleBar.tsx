// Faithful recreation of Claudette's title bar for hype reel
// Uses exact same Tailwind classes from App.tsx

import React from "react";
import {
  Terminal,
  Globe,
  PanelLeftClose,
  PanelRight,
  Settings,
  Package,
  FileCode,
  ClipboardList,
  GitBranch,
} from "lucide-react";

interface GrepTitleBarProps {
  isSidebarOpen?: boolean;
  isTerminalOpen?: boolean;
  isBrowserOpen?: boolean;
  isExtensionsOpen?: boolean;
  isPlanOpen?: boolean;
  isEditorOpen?: boolean;
  isGitOpen?: boolean;
  clockTime?: string;
}

export function GrepTitleBar({
  isSidebarOpen = true,
  isTerminalOpen = false,
  isBrowserOpen = false,
  isExtensionsOpen = false,
  isPlanOpen = false,
  isEditorOpen = false,
  isGitOpen = false,
  clockTime = '14:30:00',
}: GrepTitleBarProps) {
  return (
    <div className="h-8 bg-claude-surface border-b border-claude-border flex items-center justify-between">
      {/* Left: sidebar toggle + spacer for traffic lights */}
      <div className="flex items-center h-full">
        <div className="pl-20 pr-2 flex items-center">
          <div className={`p-1 transition-colors ${isSidebarOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
            <PanelLeftClose size={14} />
          </div>
        </div>
      </div>

      {/* Center: Clock */}
      <div className="absolute left-1/2 transform -translate-x-1/2 flex items-center">
        <div className="flex items-center gap-2 font-mono text-base text-white transition-colors">
          <span className="font-bold tabular-nums" style={{ letterSpacing: '0.05em' }}>
            {clockTime}
          </span>
        </div>
      </div>

      {/* Right: panel toggle buttons */}
      <div className="flex items-center gap-0.5 px-2">
        <div className={`p-1 ${isTerminalOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <Terminal size={14} />
        </div>
        <div className={`p-1 ${isBrowserOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <Globe size={14} />
        </div>
        <div className={`p-1 ${isExtensionsOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <Package size={14} />
        </div>
        <div className={`p-1 ${isPlanOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <ClipboardList size={14} />
        </div>
        <div className={`p-1 ${isEditorOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <FileCode size={14} />
        </div>
        <div className={`p-1 ${isGitOpen ? 'text-claude-text' : 'text-claude-text-secondary'}`}>
          <GitBranch size={14} />
        </div>
        <div className="p-1 text-claude-text-secondary">
          <PanelRight size={14} />
        </div>
        <div className="p-1 text-claude-text-secondary">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ imageRendering: 'pixelated' }}>
            {/* Pixel-art B logo */}
            <rect x="2" y="1" width="8" height="2" />
            <rect x="2" y="1" width="2" height="14" />
            <rect x="2" y="7" width="8" height="2" />
            <rect x="2" y="13" width="8" height="2" />
            <rect x="10" y="3" width="2" height="4" />
            <rect x="10" y="9" width="2" height="4" />
            <rect x="12" y="3" width="2" height="2" />
            <rect x="12" y="5" width="0" height="2" />
            <rect x="12" y="9" width="2" height="2" />
          </svg>
        </div>
        <div className="p-1 text-claude-text-secondary">
          <Settings size={14} />
        </div>
      </div>
    </div>
  );
}
