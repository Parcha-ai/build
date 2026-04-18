// Faithful recreation of Claudette's StatusBar for hype reel
// Uses exact same Tailwind classes and structure from StatusBar.tsx

import React from "react";
import { ChevronDown } from "lucide-react";

interface GrepStatusBarProps {
  sessionStatus?: string;
  branch?: string;
  port?: number;
  version?: string;
  dockerAvailable?: boolean;
  showSubagent?: boolean;
  subagentType?: string;
}

export function GrepStatusBar({
  sessionStatus = 'running',
  branch = 'main',
  port = 3000,
  version = '0.3.7',
  dockerAvailable = true,
  showSubagent = false,
  subagentType = 'IMPLEMENT',
}: GrepStatusBarProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'stopped': return 'bg-gray-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-yellow-500';
    }
  };

  return (
    <div className="h-8 flex items-center px-4 text-[11px] font-mono bg-claude-surface border-t border-claude-border text-claude-text-secondary">
      {/* Left section */}
      <div className="flex items-center gap-3">
        {/* Docker status */}
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 ${dockerAvailable ? 'bg-green-500' : 'bg-red-500'}`}
            style={{ borderRadius: 0 }}
          />
          <span style={{ letterSpacing: '0.05em' }}>
            DOCKER 24.0.7
          </span>
        </div>

        <div className="w-px h-3 bg-claude-border" />

        {/* Session status */}
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 ${getStatusColor(sessionStatus)}`}
            style={{ borderRadius: 0 }}
          />
          <span style={{ letterSpacing: '0.05em' }}>
            {sessionStatus.toUpperCase()}
          </span>
        </div>

        <div className="w-px h-3 bg-claude-border" />

        {/* Branch */}
        <div className="flex items-center gap-1">
          <span style={{ letterSpacing: '0.05em' }}>BRANCH:</span>
          <span className="font-bold text-claude-text">{branch}</span>
          <ChevronDown size={10} />
        </div>

        {/* Subagent indicator */}
        {showSubagent && (
          <>
            <div className="w-px h-3 bg-claude-border" />
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-purple-500 animate-pulse" style={{ borderRadius: 0 }} />
              <span style={{ letterSpacing: '0.05em' }} className="text-purple-400">
                AGENT: {subagentType}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span style={{ letterSpacing: '0.05em' }}>PORT:</span>
          <span className="font-bold text-claude-text">{port}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span style={{ letterSpacing: '0.05em' }}>BUILD v{version}</span>
        </div>
      </div>
    </div>
  );
}
