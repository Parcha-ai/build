import React, { useState, useEffect, useRef } from 'react';
import { Ampersand, Loader2, ChevronRight, ChevronDown, CheckCircle2, XCircle, Square } from 'lucide-react';
import type { BackgroundTask } from '../../stores/session.store';

interface BackgroundTasksBlockProps {
  tasks: BackgroundTask[];
  onStopTask?: (taskId: string) => void;
  onViewOutput?: (taskId: string) => void;
}

export default function BackgroundTasksBlock({ tasks, onStopTask, onViewOutput }: BackgroundTasksBlockProps) {
  // Start collapsed by default - user can expand if they want to see all tasks
  const [isExpanded, setIsExpanded] = useState(false);
  const expandedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll expanded view to bottom when new output arrives
  useEffect(() => {
    if (isExpanded && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [tasks, isExpanded]);

  // Calculate stats
  const runningTasks = tasks.filter(t => t.status === 'running').length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const errorTasks = tasks.filter(t => t.status === 'error').length;

  // Get preview - first running task's command
  const firstRunningTask = tasks.find(t => t.status === 'running');
  const previewText = firstRunningTask
    ? firstRunningTask.command.slice(0, 60) + (firstRunningTask.command.length > 60 ? '...' : '')
    : runningTasks === 0
      ? `${completedTasks} completed${errorTasks > 0 ? `, ${errorTasks} failed` : ''}`
      : '';

  // Get last few lines of output for preview
  const getOutputPreview = (output: string, lines = 3): string => {
    if (!output) return '';
    const outputLines = output.split('\n').filter(l => l.trim());
    return outputLines.slice(-lines).join('\n');
  };

  const CARD = 'bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] overflow-hidden';
  const dotClass = runningTasks > 0 ? 'bg-accent status-pulse' : errorTasks > 0 ? 'bg-diff-del' : 'bg-diff-add';

  return (
    <div className={`${CARD} text-[12.5px]`}>
      {/* Header row - clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-[9px] text-left text-fg-3 transition-colors hover:bg-white/[0.03]"
      >
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown size={12} className="flex-shrink-0 text-fg-4" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-fg-4" />
        )}

        {/* Status dot */}
        <span className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${dotClass}`} />

        {/* Icon and label */}
        <Ampersand size={13} className="flex-shrink-0 text-fg-4" />
        <span className="font-medium text-fg-2">Background</span>
        <span className="font-mono text-[11.5px] text-fg-4">{runningTasks} running</span>

        {/* Preview (collapsed) - shows first running task's command */}
        {!isExpanded && previewText && (
          firstRunningTask ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
              <span className="text-fg-5">$ </span>{previewText}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-fg-4">{previewText}</span>
          )
        )}

        {/* Loading spinner for running tasks */}
        {runningTasks > 0 && (
          <Loader2 size={12} className="ml-auto flex-shrink-0 animate-spin text-accent" />
        )}
      </button>

      {/* Expanded content - fixed height with scroll */}
      {isExpanded && (
        <div
          ref={expandedRef}
          className="max-h-80 overflow-y-auto scroll-smooth border-t border-white/[0.05] px-3 py-2"
        >
          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.id} className="border-b border-white/[0.05] pb-2 last:border-b-0 last:pb-0">
                {/* Task header */}
                <div className="mb-1 flex items-center gap-2 text-[12px]">
                  {/* Status icon */}
                  {task.status === 'completed' ? (
                    <CheckCircle2 size={13} className="flex-shrink-0 text-diff-add" />
                  ) : task.status === 'error' ? (
                    <XCircle size={13} className="flex-shrink-0 text-diff-del" />
                  ) : (
                    <Loader2 size={13} className="flex-shrink-0 animate-spin text-accent" />
                  )}

                  {/* Command */}
                  <span className="font-mono text-fg-5">$</span>
                  <span className={`flex-1 truncate font-mono ${
                    task.status === 'completed'
                      ? 'text-fg-3'
                      : task.status === 'error'
                        ? 'text-diff-del-text'
                        : 'text-fg'
                  }`}>
                    {task.command.slice(0, 80)}{task.command.length > 80 ? '...' : ''}
                  </span>

                  {/* Actions */}
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {task.status === 'running' && onStopTask && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onStopTask(task.id);
                        }}
                        className="flex h-5 w-5 items-center justify-center text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:text-diff-del"
                        title="Stop task"
                      >
                        <Square size={10} />
                      </button>
                    )}
                    {task.outputFile && onViewOutput && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onViewOutput(task.id);
                        }}
                        className="h-5 px-1.5 text-[11px] text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:text-fg"
                      >
                        View
                      </button>
                    )}
                  </div>
                </div>

                {/* Output preview */}
                {task.output && (
                  <pre className="ml-5 max-h-20 overflow-x-auto overflow-y-auto whitespace-pre-wrap bg-[#0B0B0B] p-2 font-mono text-[11px] leading-relaxed text-fg-4">
                    {getOutputPreview(task.output, 4)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
