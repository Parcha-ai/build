import React, { useEffect, useState, useCallback } from 'react';
import { CheckSquare, Clock3, ListTodo, Pause, Play, Plus, Square, StopCircle } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import { useSessionStore } from '../../stores/session.store';
import { formatPomodoroTime } from '../../../shared/utils/pomodoro';
import TaskItem from './TaskItem';
import PomodoroCompletionDialog from './PomodoroCompletionDialog';
import PomodoroSetupDialog from './PomodoroSetupDialog';

export default function TaskList() {
  const {
    tasks,
    focusModeEnabled,
    activeTaskId,
    pomodoroState,
    isLoaded,
    loadTasks,
    addTask,
    updateTask,
    deleteTask,
    reorderTasks,
    markTaskDone,
    addSubtask,
    toggleSubtask,
    deleteSubtask,
    pausePomodoro,
    resumePomodoro,
    stopPomodoro,
    syncPomodoroState,
  } = useTaskStore();
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  const [isAdding, setIsAdding] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [setupTaskId, setSetupTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      loadTasks();
    }
  }, [isLoaded, loadTasks]);

  useEffect(() => {
    const stopStateListener = window.electronAPI.pomodoro.onStateChanged(syncPomodoroState);
    const stopUIListener = window.electronAPI.pomodoro.onUIRequested((request) => {
      if (request.sessionId) setActiveSession(request.sessionId);
      if (request.action === 'start-first') {
        const firstTask = [...useTaskStore.getState().tasks]
          .sort((a, b) => a.order - b.order)
          .find((task) => task.status !== 'done');
        if (firstTask) setSetupTaskId(firstTask.id);
        else setIsAdding(true);
      }
    });
    return () => {
      stopStateListener();
      stopUIListener();
    };
  }, [setActiveSession, syncPomodoroState]);

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
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((id: string) => {
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
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

  const pendingCount = tasks.filter(t => t.status !== 'done').length;
  const setupTask = setupTaskId ? tasks.find((task) => task.id === setupTaskId) : undefined;

  const startFirstTask = useCallback(() => {
    if (pomodoroState.status !== 'idle') {
      if (pomodoroState.sessionId) setActiveSession(pomodoroState.sessionId);
      return;
    }
    const firstTask = [...tasks]
      .sort((a, b) => a.order - b.order)
      .find((task) => task.status !== 'done');
    if (firstTask) setSetupTaskId(firstTask.id);
    else setIsAdding(true);
  }, [pomodoroState, setActiveSession, tasks]);

  const finishTaskAndMoveNext = useCallback(async (taskId: string) => {
    await markTaskDone(taskId);
    const nextTask = [...useTaskStore.getState().tasks]
      .sort((a, b) => a.order - b.order)
      .find((task) => task.status !== 'done');
    if (nextTask) setSetupTaskId(nextTask.id);
  }, [markTaskDone]);

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
          onClick={startFirstTask}
          className={`p-0.5 transition-colors ${
            pomodoroState.status !== 'idle'
              ? 'text-emerald-400 hover:text-emerald-300'
              : 'text-claude-text-secondary hover:text-emerald-400'
          }`}
          title={pomodoroState.status === 'idle' ? 'Start first task Pomodoro' : 'Open active focus session'}
        >
          <Clock3 size={12} />
        </button>
        <button
          onClick={() => setIsAdding(true)}
          className="p-0.5 text-claude-text-secondary hover:text-claude-text transition-colors"
          title="Add Task"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Active timer — the same clock is also kept alive in the system menu bar. */}
      {pomodoroState.status !== 'idle' && (
        <div className="mx-2 mb-1.5 rounded border border-emerald-400/25 bg-emerald-400/5 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => pomodoroState.status === 'paused' ? void resumePomodoro() : void pausePomodoro()}
              disabled={pomodoroState.status === 'completed'}
              className="text-emerald-400 hover:text-emerald-300 disabled:opacity-30"
              title={pomodoroState.status === 'paused' ? 'Resume' : 'Pause'}
            >
              {pomodoroState.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}
            </button>
            <button
              type="button"
              onClick={() => pomodoroState.sessionId && setActiveSession(pomodoroState.sessionId)}
              className="min-w-0 flex-1 text-left"
              title={pomodoroState.sessionId ? 'Open focus session' : 'Outside Build focus'}
            >
              <span className="block truncate text-[10px] font-semibold text-claude-text">{pomodoroState.taskTitle}</span>
              <span className="block truncate text-[9px] text-claude-text-secondary">{pomodoroState.subtaskTitle}</span>
            </button>
            <span className="font-mono text-[12px] font-bold tabular-nums text-emerald-300">
              {formatPomodoroTime(pomodoroState.remainingSeconds)}
            </span>
            <button
              type="button"
              onClick={() => void stopPomodoro()}
              className="text-claude-text-secondary hover:text-red-400"
              title="Stop Pomodoro"
            >
              <StopCircle size={11} />
            </button>
          </div>
          {pomodoroState.external && (
            <div className="mt-1 text-[8px] uppercase tracking-wider text-amber-300/80">Outside Build · menu bar active</div>
          )}
        </div>
      )}

      {/* Task list */}
      <div>
        {sortedTasks.map((task) => {
          const isCurrent = task.id === activeTaskId;

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
                isDragging={draggedId === task.id}
                isDragOver={dragOverId === task.id && draggedId !== task.id}
                onUpdate={updateTask}
                onDelete={deleteTask}
                onToggleDone={handleToggleDone}
                onStartPomodoro={setSetupTaskId}
                onAddSubtask={addSubtask}
                onToggleSubtask={toggleSubtask}
                onDeleteSubtask={deleteSubtask}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
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

      {setupTask && (
        <PomodoroSetupDialog task={setupTask} onClose={() => setSetupTaskId(null)} />
      )}
      <PomodoroCompletionDialog
        onPlanNextSlot={setSetupTaskId}
        onFinishTask={(taskId) => void finishTaskAndMoveNext(taskId)}
      />
    </div>
  );
}
