import React, { useState, useEffect, useRef } from 'react';
import { Activity, ChevronRight, ChevronDown, Square } from 'lucide-react';

export interface MonitorEvent {
  id: string;
  text: string;
  timestamp: number;
}

export interface MonitorInstance {
  id: string;             // tool_use id
  aliases?: string[];     // alternate ids, e.g. tool_use id after async agent rekey
  description: string;    // "watching git log", etc
  events: MonitorEvent[]; // accumulated stdout lines
  active: boolean;        // true while the monitor is running
  kind?: 'monitor' | 'subagent';
  persistent?: boolean;   // session-length watch
  startedAt: number;
}

interface MonitorBlockProps {
  monitors: MonitorInstance[];
  onStop?: (monitorId: string) => void;
}

function inferMonitorKind(monitor: MonitorInstance): 'monitor' | 'subagent' {
  if (monitor.kind === 'subagent') return 'subagent';
  if (monitor.kind === 'monitor') return 'monitor';
  return /^[a-z0-9_-]+:\s/i.test(monitor.description) ? 'subagent' : 'monitor';
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export default function MonitorBlock({ monitors, onStop }: MonitorBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const eventsRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest event when expanded
  useEffect(() => {
    if (isExpanded && eventsRef.current) {
      eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
    }
  }, [monitors, isExpanded]);

  if (monitors.length === 0) return null;

  // Active monitors first
  const activeCount = monitors.filter((m) => m.active).length;
  const activeAgentCount = monitors.filter((m) => m.active && inferMonitorKind(m) === 'subagent').length;
  const activeMonitorCount = monitors.filter((m) => m.active && inferMonitorKind(m) === 'monitor').length;
  const totalEvents = monitors.reduce((sum, m) => sum + m.events.length, 0);
  const activeSummary = [
    activeAgentCount > 0 ? pluralize(activeAgentCount, 'agent') : '',
    activeMonitorCount > 0 ? pluralize(activeMonitorCount, 'monitor') : '',
  ].filter(Boolean).join(' · ');

  // Get the most recent event across all monitors
  const latestEvent = monitors
    .flatMap((m) => m.events.map((e) => ({ ...e, monitorId: m.id, description: m.description })))
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  const previewText = latestEvent
    ? latestEvent.text.slice(0, 120)
    : activeCount > 0
      ? 'Waiting for events...'
      : 'Monitor idle';

  const dotColor = activeCount > 0 ? 'bg-accent status-pulse' : 'bg-fg-5';

  return (
    <div className="overflow-hidden bg-ink-1 text-[12.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
      {/* Header row - clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-[9px] text-left text-fg-3 transition-colors hover:bg-white/[0.03]"
        aria-label="Background agents and monitors"
      >
        {isExpanded ? (
          <ChevronDown size={12} className="flex-shrink-0 text-fg-4" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-fg-4" />
        )}
        <div className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${dotColor}`} />
        <Activity size={13} className="flex-shrink-0 text-fg-4" />
        <span className="flex-shrink-0 font-medium capitalize text-fg-2">
          {activeCount > 0 ? activeSummary : 'Monitor'}
        </span>
        {activeCount > 0 && (
          <span className="flex-shrink-0 text-[11.5px] text-accent-text">
            running
          </span>
        )}
        <span className="flex-shrink-0 font-mono text-[11px] text-fg-4">
          {totalEvents} event{totalEvents === 1 ? '' : 's'}
        </span>
        <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-5">
          {previewText}
        </span>
      </button>

      {/* Expanded view - all monitors with all their events */}
      {isExpanded && (
        <div
          ref={eventsRef}
          className="max-h-64 space-y-2 overflow-y-auto border-t border-white/[0.05] px-3 py-2"
        >
          {monitors.map((monitor) => (
            <div key={monitor.id} className="space-y-0.5">
              {/* Monitor header */}
              <div className="sticky top-0 flex items-center gap-2 bg-ink-1 py-0.5">
                <div
                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    monitor.active ? 'bg-accent status-pulse' : 'bg-fg-5'
                  }`}
                />
                <span
                  className="flex-shrink-0 px-1 font-mono text-[9.5px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]"
                  style={{ letterSpacing: '0.04em' }}
                >
                  {inferMonitorKind(monitor) === 'subagent' ? 'agent' : 'monitor'}
                </span>
                <span className="flex-1 truncate text-[12.5px] font-medium text-fg">
                  {monitor.description}
                </span>
                {monitor.persistent && (
                  <span className="font-mono text-[10px] uppercase text-fg-4">persistent</span>
                )}
                {monitor.active && onStop && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStop(monitor.id);
                    }}
                    className="p-0.5 text-fg-4 transition-colors hover:text-diff-del"
                    title="Stop monitor"
                  >
                    <Square size={12} />
                  </button>
                )}
              </div>

              {/* Events */}
              {monitor.events.length === 0 ? (
                <div className="ml-3.5 text-[12px] text-fg-5">
                  No events yet...
                </div>
              ) : (
                monitor.events.map((event) => (
                  <div key={event.id} className="ml-3.5 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-fg-3">
                    <span className="mr-2 text-fg-5">
                      {new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                    {event.text}
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
