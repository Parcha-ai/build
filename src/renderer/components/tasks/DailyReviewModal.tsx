import React, { useEffect, useState, useCallback } from 'react';
import { CalendarDays, Plus, GripVertical, X, Square, CheckSquare } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import type { FocusTask } from '../../../shared/types';

interface DailyReviewModalProps {
  onDismiss: () => void;
}

export default function DailyReviewModal({ onDismiss }: DailyReviewModalProps) {
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
      <div className="bg-claude-surface border-4 border-emerald-500/60 p-8 max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center flex-shrink-0">
            <CalendarDays size={24} className="text-emerald-400" strokeWidth={3} />
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-emerald-400 mb-2 uppercase" style={{ letterSpacing: '0.1em' }}>
              Daily Review
            </h2>
            <p className="text-sm text-claude-text-secondary">
              Review your tasks for today. Reorder priorities, add new goals, or clear completed work.
            </p>
          </div>
        </div>

        {/* Task list */}
        <div className="space-y-1 mb-4 max-h-[300px] overflow-y-auto">
          {sortedTasks.map((task) => {
            const isDone = task.status === 'done';
            return (
              <div
                key={task.id}
                draggable
                onDragStart={(e) => handleDragStart(e, task.id)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, task.id)}
                className="group flex items-center gap-2 px-3 py-2 bg-claude-bg border border-claude-border hover:border-emerald-500/30 transition-colors"
              >
                <div className="cursor-grab opacity-40 group-hover:opacity-70 transition-opacity flex-shrink-0">
                  <GripVertical size={12} className="text-claude-text-secondary" />
                </div>
                <button
                  onClick={() => handleToggleDone(task.id)}
                  className="flex-shrink-0 text-claude-text-secondary hover:text-claude-text transition-colors"
                >
                  {isDone ? (
                    <CheckSquare size={14} className="text-emerald-500" />
                  ) : (
                    <Square size={14} />
                  )}
                </button>
                <span className={`flex-1 min-w-0 text-xs font-mono truncate ${
                  isDone ? 'line-through text-claude-text-secondary/50' : 'text-claude-text'
                }`}>
                  {task.title}
                </span>
                <button
                  onClick={() => deleteTask(task.id)}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-claude-text-secondary hover:text-red-400"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {sortedTasks.length === 0 && (
            <p className="text-xs font-mono text-claude-text-secondary text-center py-4">
              No tasks yet. Add one below to get started.
            </p>
          )}
        </div>

        {/* Add task input */}
        <div className="flex items-center gap-2 mb-6">
          <Plus size={14} className="text-emerald-400 flex-shrink-0" />
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={handleAddKeyDown}
            placeholder="Add a task..."
            className="flex-1 px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-emerald-500"
            style={{ borderRadius: 0 }}
          />
          <button
            onClick={handleAddTask}
            disabled={!newTaskTitle.trim()}
            className="px-3 py-2 bg-emerald-500/20 text-emerald-400 text-xs font-mono font-bold uppercase hover:bg-emerald-500/30 transition-colors disabled:opacity-30"
            style={{ borderRadius: 0 }}
          >
            Add
          </button>
        </div>

        {/* Start Day button */}
        <button
          onClick={onDismiss}
          className="w-full px-6 py-3 bg-emerald-500 text-white font-bold uppercase hover:bg-emerald-400 transition-colors"
          style={{ borderRadius: 0, letterSpacing: '0.1em' }}
        >
          Start Day
        </button>

        <p className="text-[10px] text-claude-text-secondary text-center mt-3" style={{ letterSpacing: '0.05em' }}>
          Organise your priorities before diving in. You can always edit tasks from the sidebar.
        </p>
      </div>
    </div>
  );
}
