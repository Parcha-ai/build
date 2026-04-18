// Faithful recreation of Build's TasksBlock for hype reel
// Based on actual TasksBlock.tsx — shows task list with status indicators
// Pure props-driven, no useState (Remotion-compatible)

import React from "react";
import { ListTodo, Loader2, ChevronRight, ChevronDown, CheckCircle2, Circle, Clock } from "lucide-react";

export interface MockTask {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface BuildTasksBlockProps {
  tasks: MockTask[];
  isExpanded?: boolean;
  isStreaming?: boolean;
}

export function BuildTasksBlock({ tasks, isExpanded = false, isStreaming = false }: BuildTasksBlockProps) {
  if (tasks.length === 0) return null;

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const inProgressTask = tasks.find(t => t.status === 'in_progress');

  // Preview text for collapsed state
  const previewText = (() => {
    if (inProgressTask) {
      return inProgressTask.activeForm || inProgressTask.subject;
    }
    if (completedTasks === totalTasks && totalTasks > 0) {
      return 'All tasks completed';
    }
    return `${completedTasks}/${totalTasks} tasks completed`;
  })();

  const accentColor = 'text-green-400';
  const dotColor = inProgressTask ? 'bg-amber-500' : completedTasks === totalTasks ? 'bg-green-500' : 'bg-green-500';
  const borderColor = 'border-green-500/30';

  return (
    <div className="font-mono text-sm">
      {/* Header row */}
      <div className="w-full flex items-center gap-2 py-0.5 hover:bg-claude-surface/50 transition-colors text-left cursor-pointer">
        {isExpanded ? (
          <ChevronDown size={12} className={`${accentColor} flex-shrink-0`} />
        ) : (
          <ChevronRight size={12} className={`${accentColor} flex-shrink-0`} />
        )}

        <span
          className={`w-2 h-2 flex-shrink-0 ${dotColor} ${inProgressTask && isStreaming ? 'animate-pulse' : ''}`}
          style={{ borderRadius: 0 }}
        />

        <ListTodo size={14} className={`${accentColor} flex-shrink-0`} />
        <span className={`font-semibold ${accentColor}`}>
          Tasks ({completedTasks}/{totalTasks})
        </span>

        {inProgressTask && isStreaming && (
          <Loader2 size={12} className="text-amber-400 animate-spin flex-shrink-0" />
        )}
      </div>

      {/* Preview (collapsed) */}
      {!isExpanded && (
        <div className={`ml-6 mt-1 p-2 bg-claude-surface/30 border-l-2 ${borderColor}`}>
          <div className="flex items-center gap-2 text-xs text-claude-text-secondary/80">
            {inProgressTask ? (
              <>
                <Clock size={12} className="text-amber-400 animate-pulse flex-shrink-0" />
                <span className="text-amber-400">{previewText}</span>
              </>
            ) : completedTasks === totalTasks ? (
              <>
                <CheckCircle2 size={12} className="text-green-500 flex-shrink-0" />
                <span className="text-green-500">{previewText}</span>
              </>
            ) : (
              <span>{previewText}</span>
            )}
          </div>
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && (
        <div className={`ml-6 mt-1 p-2 bg-claude-surface/30 border-l-2 ${borderColor} max-h-64 overflow-y-auto`}>
          <div className="space-y-1.5">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-start gap-2 text-xs">
                {task.status === 'completed' ? (
                  <CheckCircle2 size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
                ) : task.status === 'in_progress' ? (
                  <Clock size={14} className="text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" />
                ) : (
                  <Circle size={14} className="text-claude-text-secondary flex-shrink-0 mt-0.5" />
                )}

                <span className={
                  task.status === 'completed'
                    ? 'text-claude-text-secondary line-through'
                    : task.status === 'in_progress'
                      ? 'text-amber-400'
                      : 'text-claude-text'
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
