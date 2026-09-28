import React, { useState, useEffect, useRef } from 'react';
import { ListTodo, Loader2, ChevronRight, ChevronDown, CheckCircle2, Circle, Clock } from 'lucide-react';

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  activeForm?: string;
  blocks?: string[];
  blockedBy?: string[];
}

interface TasksBlockProps {
  tasks: Task[];
  isStreaming?: boolean;
}

export default function TasksBlock({ tasks, isStreaming }: TasksBlockProps) {
  // Start collapsed by default - user can expand if they want to see all tasks
  const [isExpanded, setIsExpanded] = useState(false);
  const expandedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll expanded view to bottom when new tasks arrive
  useEffect(() => {
    if (isExpanded && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [tasks, isExpanded]);

  // Calculate stats
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const inProgressTask = tasks.find(t => t.status === 'in_progress');

  // Get preview text (current active task or progress summary)
  const previewText = (() => {
    if (inProgressTask) {
      return inProgressTask.activeForm || inProgressTask.subject;
    }
    if (completedTasks === totalTasks && totalTasks > 0) {
      return 'All tasks completed';
    }
    return `${completedTasks}/${totalTasks} tasks completed`;
  })();

  const CARD = 'bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] overflow-hidden';

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
        <span
          className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${
            inProgressTask ? `bg-accent ${isStreaming ? 'status-pulse' : ''}` : 'bg-diff-add'
          }`}
        />

        {/* Icon and label */}
        <ListTodo size={13} className="flex-shrink-0 text-fg-4" />
        <span className="font-medium text-fg-2">Tasks</span>
        <span className="font-mono text-[11.5px] text-fg-4">{completedTasks}/{totalTasks}</span>

        {/* Collapsed preview inline */}
        {!isExpanded && (
          <span className={`min-w-0 flex-1 truncate ${
            inProgressTask ? 'text-fg-2' : completedTasks === totalTasks ? 'text-diff-add' : 'text-fg-4'
          }`}>
            {previewText}
          </span>
        )}

        {/* Loading spinner for active tasks while streaming */}
        {inProgressTask && isStreaming && (
          <Loader2 size={12} className="ml-auto flex-shrink-0 animate-spin text-accent" />
        )}
      </button>

      {/* Expanded content - fixed height with scroll */}
      {isExpanded && (
        <div
          ref={expandedRef}
          className="max-h-64 overflow-y-auto scroll-smooth border-t border-white/[0.05] px-3 pb-2.5 pt-2 pl-8"
        >
          <div className="space-y-1.5">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-start gap-2 text-[12.5px]">
                {/* Status icon */}
                {task.status === 'completed' ? (
                  <CheckCircle2 size={13} className="mt-0.5 flex-shrink-0 text-diff-add" />
                ) : task.status === 'in_progress' ? (
                  <Clock size={13} className="mt-0.5 flex-shrink-0 animate-pulse text-accent" />
                ) : (
                  <Circle size={13} className="mt-0.5 flex-shrink-0 text-fg-5" />
                )}

                {/* Task text */}
                <span className={
                  task.status === 'completed'
                    ? 'text-fg-5 line-through'
                    : task.status === 'in_progress'
                      ? 'text-fg'
                      : 'text-fg-3'
                }>
                  {task.status === 'in_progress' && task.activeForm
                    ? task.activeForm
                    : task.subject}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
