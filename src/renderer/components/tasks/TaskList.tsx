import React, { useEffect, useState, useCallback } from 'react';
import { ListTodo, Plus, Focus, Square, CheckSquare } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import TaskItem from './TaskItem';
import type { FocusTask } from '../../../shared/types';

export default function TaskList() {
  const {
    tasks,
    focusModeEnabled,
    activeTaskId,
    isLoaded,
    loadTasks,
    addTask,
    updateTask,
    deleteTask,
    reorderTasks,
    markTaskDone,
    toggleFocusMode,
    addSubtask,
    toggleSubtask,
    deleteSubtask,
  } = useTaskStore();

  const [isAdding, setIsAdding] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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
      setIsAdding(false);
    }
  }, [newTaskTitle, addTask]);

  const handleAddKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddTask();
    } else if (e.key === 'Escape') {
      setNewTaskTitle('');
      setIsAdding(false);
    }
  }, [handleAddTask]);

  const handleToggleDone = useCallback((id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    if (task.status === 'done') {
      // Un-complete: set back to pending
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
      setDragOverId(null);
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
    setDragOverId(null);
  }, [draggedId, tasks, reorderTasks]);

  // Restore opacity on drag end (at document level to catch all cases)
  useEffect(() => {
    const handleDragEnd = () => {
      setDraggedId(null);
      setDragOverId(null);
    };
    document.addEventListener('dragend', handleDragEnd);
    return () => document.removeEventListener('dragend', handleDragEnd);
  }, []);

  const pendingCount = tasks.filter(t => t.status !== 'done').length;

  return (
    <div className="mb-3">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center gap-2">
        <ListTodo size={12} className="text-emerald-400" />
        <span className="text-[10px] font-bold text-claude-text-secondary uppercase tracking-wider flex-1">
          Tasks
          {pendingCount > 0 && (
            <span className="ml-1.5 text-[9px] text-emerald-400">
              {pendingCount}
            </span>
          )}
        </span>
        <button
          onClick={toggleFocusMode}
          className={`p-0.5 transition-colors ${
            focusModeEnabled
              ? 'text-green-400 hover:text-green-300'
              : 'text-claude-text-secondary hover:text-claude-text'
          }`}
          title={focusModeEnabled ? 'Disable Focus Mode' : 'Enable Focus Mode'}
        >
          <Focus size={12} />
        </button>
        <button
          onClick={() => setIsAdding(true)}
          className="p-0.5 text-claude-text-secondary hover:text-claude-text transition-colors"
          title="Add Task"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Task list */}
      <div>
        {sortedTasks.map((task) => {
          const isCurrent = task.id === activeTaskId;
          const isDimmed = focusModeEnabled && !isCurrent && task.status !== 'done';

          // In focus mode: active task is prominent, others are collapsed
          if (focusModeEnabled && !isCurrent) {
            return (
              <div
                key={task.id}
                className="px-2 py-0.5 flex items-center gap-1.5 opacity-30"
              >
                {task.status === 'done' ? (
                  <CheckSquare size={9} className="text-green-500/50 flex-shrink-0" />
                ) : (
                  <Square size={9} className="text-claude-text-secondary/50 flex-shrink-0" />
                )}
                <span className={`text-[9px] font-mono truncate ${
                  task.status === 'done' ? 'line-through text-claude-text-secondary/30' : 'text-claude-text-secondary/50'
                }`}>
                  {task.title}
                </span>
              </div>
            );
          }

          return (
            <div key={task.id} className={focusModeEnabled && isCurrent ? 'bg-green-500/5 border-l-2 border-green-500 py-1' : ''}>
              <TaskItem
                task={task}
                isActive={isCurrent}
                onUpdate={updateTask}
                onDelete={deleteTask}
                onToggleDone={handleToggleDone}
                onAddSubtask={addSubtask}
                onToggleSubtask={toggleSubtask}
                onDeleteSubtask={deleteSubtask}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              />
            </div>
          );
        })}
      </div>

      {/* Inline add input */}
      {isAdding && (
        <div className="px-2 py-1">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={handleAddKeyDown}
            onBlur={() => {
              if (!newTaskTitle.trim()) {
                setIsAdding(false);
              }
            }}
            placeholder="New task..."
            className="w-full bg-transparent text-[11px] font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none border-b border-claude-border focus:border-emerald-500"
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
