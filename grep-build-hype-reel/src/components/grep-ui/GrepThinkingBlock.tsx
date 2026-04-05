// Faithful recreation of Claudette's ThinkingBlock for hype reel
// Uses exact same Tailwind classes and structure from ThinkingBlock.tsx
// Updated with CEO mode support for GStack

import React from "react";
import { Brain, Loader2, ChevronRight, ChevronDown, Crown } from "lucide-react";

type ThinkingMode = 'default' | 'ceo';

interface GrepThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
  isExpanded?: boolean;
  visibleChars?: number; // For typewriter effect
  mode?: ThinkingMode;
}

const MODE_CONFIG: Record<ThinkingMode, { label: string; dotClass: string; textClass: string; borderClass: string; color: string }> = {
  default: {
    label: 'Thinking',
    dotClass: 'bg-purple-500',
    textClass: 'text-purple-400',
    borderClass: 'border-purple-500/30',
    color: '#8b5cf6',
  },
  ceo: {
    label: 'CEO',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/30',
    color: '#f59e0b',
  },
};

export function GrepThinkingBlock({
  content,
  isStreaming = true,
  isExpanded = false,
  visibleChars,
  mode = 'default',
}: GrepThinkingBlockProps) {
  const config = MODE_CONFIG[mode];
  const displayContent = visibleChars !== undefined
    ? content.slice(0, visibleChars)
    : content;

  // Get last 3 lines for collapsed preview
  const previewLines = (() => {
    if (!displayContent) return 'Processing...';
    const lines = displayContent.split('\n').filter(l => l.trim());
    return lines.slice(-3).join('\n');
  })();

  const IconComponent = mode === 'ceo' ? Crown : Brain;

  return (
    <div className="font-mono text-sm">
      {/* Header row */}
      <div className="w-full flex items-center gap-2 py-0.5 hover:bg-claude-surface/50 transition-colors text-left cursor-pointer">
        {isExpanded ? (
          <ChevronDown size={12} className={`${config.textClass} flex-shrink-0`} />
        ) : (
          <ChevronRight size={12} className={`${config.textClass} flex-shrink-0`} />
        )}

        {/* Status dot */}
        <span className={`w-2 h-2 flex-shrink-0 ${config.dotClass} ${isStreaming ? 'animate-pulse' : ''}`} style={{ borderRadius: 0 }} />

        {/* Icon and label */}
        <IconComponent size={14} className={`${config.textClass} flex-shrink-0`} />
        <span className={`font-semibold ${config.textClass}`}>{config.label}</span>

        {/* "is thinking..." text for CEO mode */}
        {mode === 'ceo' && isStreaming && (
          <span className={`text-xs ${config.textClass} opacity-70`}>is thinking...</span>
        )}

        {/* Spinner */}
        {isStreaming && (
          <Loader2 size={12} className={`${config.textClass} animate-spin flex-shrink-0`} />
        )}
      </div>

      {/* Preview (collapsed) */}
      {!isExpanded && displayContent && (
        <div className="ml-6 mt-1 p-2 bg-claude-surface/30" style={{ borderLeft: `2px solid ${config.color}40` }}>
          <pre className="whitespace-pre-wrap text-xs text-claude-text-secondary/80 leading-relaxed overflow-hidden">
            {previewLines}
          </pre>
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && displayContent && (
        <div className="ml-6 mt-1 p-2 bg-claude-surface/30 max-h-64 overflow-y-auto" style={{ borderLeft: `2px solid ${config.color}40` }}>
          <pre className="whitespace-pre-wrap text-sm text-claude-text-secondary leading-relaxed overflow-x-auto">
            {displayContent}
          </pre>
        </div>
      )}
    </div>
  );
}
