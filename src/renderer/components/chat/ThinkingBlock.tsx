import React, { useState, useEffect, useRef } from 'react';
import { Brain, Loader2, ChevronRight, ChevronDown, Zap } from 'lucide-react';
import type { CompactionStatus } from '../../../shared/types';

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  compactionStatus?: (CompactionStatus & { startTime?: number; postTokens?: number }) | null;
  gstackColor?: string; // GStack mode accent color (e.g. '#f59e0b' for CEO)
  gstackLabel?: string; // GStack mode short name (e.g. 'CEO')
}

export default function ThinkingBlock({ content, isStreaming, isCompacting, compactionStatus, gstackColor, gstackLabel }: ThinkingBlockProps) {
  // Start collapsed by default - user can expand if they want to see full thinking
  const [isExpanded, setIsExpanded] = useState(false);
  const expandedRef = useRef<HTMLDivElement>(null);
  const [elapsedTime, setElapsedTime] = useState('');

  // Update elapsed time for compaction
  useEffect(() => {
    if (!compactionStatus?.startTime) {
      setElapsedTime('');
      return;
    }

    const updateTime = () => {
      const elapsed = Date.now() - (compactionStatus.startTime || 0);
      const seconds = Math.floor(elapsed / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;

      if (minutes > 0) {
        setElapsedTime(`${minutes}m ${remainingSeconds}s`);
      } else {
        setElapsedTime(`${seconds}s`);
      }
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [compactionStatus?.startTime]);

  // Auto-scroll expanded view to bottom when new content arrives
  useEffect(() => {
    if (isExpanded && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [content, isExpanded]);

  // Format compaction status line like Claude Code
  const compactionStatusLine = (() => {
    if (!compactionStatus) return '';

    const parts: string[] = [];

    // Add elapsed time
    if (elapsedTime) {
      parts.push(elapsedTime);
    }

    // Add token reduction if available
    if (compactionStatus.preTokens && compactionStatus.postTokens) {
      const reduction = compactionStatus.preTokens - compactionStatus.postTokens;
      parts.push(`↓ ${reduction.toLocaleString()} tokens`);
    } else if (compactionStatus.preTokens && compactionStatus.isCompacting) {
      // Show pre-token count while compacting
      parts.push(`${compactionStatus.preTokens.toLocaleString()} tokens`);
    }

    return parts.length > 0 ? `(${parts.join(' • ')})` : '';
  })();

  // Get last 2-3 lines for collapsed preview (shows latest updates)
  const previewLines = (() => {
    if (isCompacting) {
      return `Compacting conversation... ${compactionStatusLine}`;
    }
    if (!content) return 'Processing...';
    const lines = content.split('\n').filter(l => l.trim());
    const lastLines = lines.slice(-3); // Last 3 lines
    return lastLines.join('\n');
  })();

  // Graphite: quiet single-line row. Accent (or GStack colour) only while live.
  const hasGStack = !isCompacting && gstackColor;
  const isLive = Boolean(isStreaming || isCompacting);
  const dotStyle = hasGStack ? { backgroundColor: gstackColor } : undefined;
  const labelStyle = hasGStack && !isLive ? { color: gstackColor } : undefined;
  const baseLabel = isCompacting ? 'Compacting' : isStreaming ? 'Thinking' : 'Thought';
  const label = hasGStack ? `[${gstackLabel}] ${baseLabel}` : baseLabel;
  const Icon = isCompacting ? Zap : Brain;

  return (
    <div className="text-[12.5px]">
      {/* Header row - clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-left text-fg-4 transition-colors hover:text-fg-3"
      >
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown size={11} className="flex-shrink-0" />
        ) : (
          <ChevronRight size={11} className="flex-shrink-0" />
        )}

        {/* Live status dot */}
        {isLive ? (
          <span
            className="status-pulse h-[7px] w-[7px] flex-shrink-0 rounded-full bg-accent"
            style={dotStyle}
          />
        ) : (
          <Icon size={12} className="flex-shrink-0 text-fg-5" />
        )}

        {/* Label */}
        <span className={isLive ? 'text-shimmer font-medium' : ''} style={labelStyle}>{label}</span>

        {/* Compaction telemetry */}
        {isCompacting && isExpanded && compactionStatusLine && (
          <span className="font-mono text-[11px] text-fg-5">{compactionStatusLine}</span>
        )}

        {/* Loading spinner for active thinking/compacting */}
        {isLive && (
          <Loader2 size={11} className="flex-shrink-0 animate-spin text-fg-5" />
        )}
      </button>

      {/* Preview (collapsed) - shows last 2-3 lines streaming in */}
      {!isExpanded && (content || isCompacting) && (
        <div className="ml-[5px] mt-1 border-l border-line pl-3">
          <pre className="max-h-[4.8em] overflow-hidden whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-fg-5">
            {previewLines}
          </pre>
        </div>
      )}

      {/* Expanded content - fixed height with scroll, won't push input down */}
      {isExpanded && (content || isCompacting) && (
        <div
          ref={expandedRef}
          className="ml-[5px] mt-1 max-h-64 overflow-y-auto scroll-smooth border-l border-line pl-3"
        >
          <pre className="overflow-x-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg-4">
            {isCompacting
              ? `Compacting conversation... ${compactionStatusLine}\n\nSummarizing conversation context to optimize token usage...`
              : content
            }
          </pre>
        </div>
      )}
    </div>
  );
}
