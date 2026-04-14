import React, { useState, useEffect, useRef } from 'react';
import { Activity, ChevronRight, ChevronDown, Square } from 'lucide-react';

export interface MonitorEvent {
  id: string;
  text: string;
  timestamp: number;
}

export interface MonitorInstance {
  id: string;             // tool_use id
  description: string;    // "watching git log", etc
  events: MonitorEvent[]; // accumulated stdout lines
  active: boolean;        // true while the monitor is running
  persistent?: boolean;   // session-length watch
  startedAt: number;
}

interface MonitorBlockProps {
  monitors: MonitorInstance[];
  onStop?: (monitorId: string) => void;
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
  const totalEvents = monitors.reduce((sum, m) => sum + m.events.length, 0);

  // Get the most recent event across all monitors
  const latestEvent = monitors
    .flatMap((m) => m.events.map((e) => ({ ...e, monitorId: m.id, description: m.description })))
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  const previewText = latestEvent
    ? latestEvent.text.slice(0, 120)
    : activeCount > 0
      ? 'Waiting for events...'
      : 'Monitor idle';

  const accentColor = activeCount > 0 ? 'text-amber-400' : 'text-claude-text-secondary';
  const dotColor = activeCount > 0 ? 'bg-amber-500 animate-pulse' : 'bg-claude-text-secondary/50';

  return (
    <div className="font-mono text-sm">
      {/* Header row - clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 py-0.5 hover:bg-claude-surface/50 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDown size={14} className="text-claude-text-secondary flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-claude-text-secondary flex-shrink-0" />
        )}
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
        <Activity size={14} className={`flex-shrink-0 ${accentColor}`} />
        <span className={`text-xs font-bold uppercase flex-shrink-0 ${accentColor}`} style={{ letterSpacing: '0.05em' }}>
          Monitor {activeCount > 0 ? `(${activeCount})` : ''}
        </span>
        <span className="text-xs text-claude-text-secondary flex-shrink-0">
          {totalEvents} event{totalEvents === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-claude-text-secondary truncate flex-1 ml-2">
          {previewText}
        </span>
      </button>

      {/* Expanded view - all monitors with all their events */}
      {isExpanded && (
        <div
          ref={eventsRef}
          className="mt-1 ml-4 space-y-2 max-h-64 overflow-y-auto border-l border-claude-border/50 pl-3"
        >
          {monitors.map((monitor) => (
            <div key={monitor.id} className="space-y-0.5">
              {/* Monitor header */}
              <div className="flex items-center gap-2 py-0.5 sticky top-0 bg-claude-surface/95 backdrop-blur">
                <div
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    monitor.active ? 'bg-amber-500 animate-pulse' : 'bg-claude-text-secondary/50'
                  }`}
                />
                <span className="text-xs font-bold text-claude-text truncate flex-1">
                  {monitor.description}
                </span>
                {monitor.persistent && (
                  <span className="text-[10px] text-amber-400 uppercase">persistent</span>
                )}
                {monitor.active && onStop && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStop(monitor.id);
                    }}
                    className="p-0.5 text-claude-text-secondary hover:text-red-400 transition-colors"
                    title="Stop monitor"
                  >
                    <Square size={12} />
                  </button>
                )}
              </div>

              {/* Events */}
              {monitor.events.length === 0 ? (
                <div className="text-xs text-claude-text-secondary italic ml-3">
                  No events yet...
                </div>
              ) : (
                monitor.events.map((event) => (
                  <div key={event.id} className="text-xs text-claude-text ml-3 font-mono whitespace-pre-wrap break-all">
                    <span className="text-claude-text-secondary mr-2">
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
