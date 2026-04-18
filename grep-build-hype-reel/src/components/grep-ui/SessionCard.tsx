// Faithful recreation of Claudette's SessionCard for hype reel
// Uses exact same Tailwind classes and visual structure

import React from "react";
import { GitFork, Star, Server } from "lucide-react";
import type { MockSession } from "../../mocks/mockData";

interface SessionCardProps {
  session: MockSession;
  isActive: boolean;
  isFork?: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-3-5': 'Haiku 3.5',
};

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#8B8DFF',
  'claude-sonnet-4-5': '#A5A7FF',
  'claude-haiku-3-5': '#22c55e',
};

export function SessionCard({ session, isActive, isFork }: SessionCardProps) {
  const modelLabel = session.model ? MODEL_LABELS[session.model] || session.model : '';
  const modelColor = session.model ? MODEL_COLORS[session.model] || '#a0a0a0' : '#a0a0a0';

  return (
    <div
      className={`w-full px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        isActive ? 'bg-claude-bg border-l-2 border-l-claude-accent' : 'hover:bg-claude-bg border-l-2 border-l-transparent'
      }`}
      style={{ borderRadius: 0 }}
    >
      {/* Status dot */}
      <div className="flex-shrink-0">
        <div
          className={`w-1.5 h-1.5 ${
            session.status === 'running' ? 'bg-green-500' :
            session.status === 'error' ? 'bg-red-500' : 'bg-gray-500'
          }`}
          style={{ borderRadius: 0 }}
        />
      </div>

      {/* Fork indicator */}
      {isFork && (
        <GitFork size={10} className="flex-shrink-0 text-emerald-400" />
      )}

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {session.isStarred && (
            <Star size={10} className="text-amber-400 flex-shrink-0" fill="currentColor" />
          )}
          <span className="text-xs font-bold text-claude-text truncate">
            {session.forkName ? session.forkName : session.name}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] text-claude-text-secondary truncate">
            {session.branch}
          </span>
          {modelLabel && (
            <>
              <span className="text-[10px] text-claude-text-secondary">·</span>
              <span className="text-[10px] font-bold" style={{ color: modelColor }}>
                {modelLabel}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
