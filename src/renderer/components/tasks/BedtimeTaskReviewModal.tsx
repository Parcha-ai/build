import React, { useEffect, useState, useCallback } from 'react';
import { Moon, Plus, GripVertical, X, Square, CheckSquare } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import type { FocusTask } from '../../../shared/types';

interface BedtimeTaskReviewModalProps {
  onDismiss: () => void;
}

export default function BedtimeTaskReviewModal({ onDismiss }: BedtimeTaskReviewModalProps) {
  const {
    tasks,
    isLoaded,
    loadTasks,
    addTask,
    updateTask,
    deleteTask,
    reorderTasks,
    markTaskDone,
  } = useTaskStore();

  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      loadTasks();
    }
  }, [isLoaded, loadTasks]);

  const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
  const completedCount = tasks.filter(t => t.status === 'done').length;
  const totalCount = tasks.length;

  const handleAddTask = useCallback(async () => {
    const trimmed = newTaskTitle.trim();
    if (trimmed) {
      await addTask(trimmed);
      setNewTaskTitle('');
    }
  }, [newTaskTitle, addTask]);

  const handleAddKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddTask();
    }
  }, [handleAddTask]);

  const handleToggleDone = useCallback((id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    if (task.status === 'done') {
      updateTask(id, { status: 'pending', completedAt: undefined });
    } else {
      markTaskDone(id);
    }
  }, [tasks, updateTask, markTaskDone]);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      return;
    }

    const sorted = [...tasks].sort((a, b) => a.order - b.order);
    const fromIdx = sorted.findIndex(t => t.id === draggedId);
    const toIdx = sorted.findIndex(t => t.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    const reordered = [...sorted];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    reorderTasks(reordered);
    setDraggedId(null);
  }, [draggedId, tasks, reorderTasks]);

  useEffect(() => {
    const handleDragEnd = () => setDraggedId(null);
    document.addEventListener('dragend', handleDragEnd);
    return () => document.removeEventListener('dragend', handleDragEnd);
  }, []);

  return (
    <div className="fixed inset-0 bg-black/90 z-[9999] flex items-center justify-center">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] p-8 max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] flex items-center justify-center flex-shrink-0">
            <Moon size={24} className="text-accent-text" strokeWidth={2} />
          </div>
          <div className="flex-1">
            <h2 className="text-[18px] font-semibold tracking-tight text-fg mb-2">
              End of Day
            </h2>
            <p className="text-[13px] text-fg-3">
              Update your tasks for tomorrow. Mark what you finished and plan what's next.
            </p>
            {totalCount > 0 && (
              <p className="text-[12px] font-mono text-accent-text mt-1">
                {completedCount}/{totalCount} completed today
              </p>
            )}
          </div>
        </div>

        {/* Task list */}
        <div className="space-y-px mb-4 max-h-[300px] overflow-y-auto">
          {sortedTasks.map((task) => {
            const isDone = task.status === 'done';
            return (
              <div
                key={task.id}
                draggable
                onDragStart={(e) => handleDragStart(e, task.id)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, task.id)}
                className={`group flex items-center gap-2 px-3 py-2 transition-colors ${
                  isDone
                    ? 'bg-diff-add/5'
                    : 'bg-ink-1 hover:bg-claude-surface-hover'
                }`}
              >
                <div className="cursor-grab opacity-40 group-hover:opacity-70 transition-opacity flex-shrink-0">
                  <GripVertical size={12} className="text-fg-4" />
                </div>
                <button
                  onClick={() => handleToggleDone(task.id)}
                  className="flex-shrink-0 text-fg-4 hover:text-fg transition-colors"
                >
                  {isDone ? (
                    <CheckSquare size={14} className="text-accent" />
                  ) : (
                    <Square size={14} />
                  )}
                </button>
                <span className={`flex-1 min-w-0 text-[13px] truncate ${
                  isDone ? 'line-through text-fg-5' : 'text-fg-2'
                }`}>
                  {task.title}
                </span>
                <button
                  onClick={() => deleteTask(task.id)}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-fg-4 hover:text-diff-del"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {sortedTasks.length === 0 && (
            <p className="text-[13px] text-fg-4 text-center py-4">
              No tasks. Add tomorrow's goals below.
            </p>
          )}
        </div>

        {/* Add task input */}
        <div className="flex items-center gap-2 mb-6">
          <Plus size={14} className="text-fg-4 flex-shrink-0" />
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={handleAddKeyDown}
            placeholder="Add a task for tomorrow..."
            className="flex-1 h-8 px-3 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
          <button
            onClick={handleAddTask}
            disabled={!newTaskTitle.trim()}
            className="h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {/* Good Night button */}
        <button
          onClick={onDismiss}
          className="w-full h-9 px-6 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white transition-colors"
        >
          Good Night
        </button>

        <p className="text-[12px] text-fg-4 text-center mt-3">
          Set up tomorrow's priorities so you can hit the ground running. Rest well.
        </p>
      </div>
    </div>
  );
}
