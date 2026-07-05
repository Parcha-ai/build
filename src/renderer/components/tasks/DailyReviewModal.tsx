import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  CheckSquare,
  ClipboardList,
  GripVertical,
  Plus,
  Target,
  X,
} from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import type { FocusTask } from '../../../shared/types';

interface DailyReviewModalProps {
  onDismiss: () => void;
}

type ReviewStep = 'plan' | 'commit';

const steps: Array<{ id: ReviewStep; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'commit', label: 'Commit' },
];

const staleTaskDays = 7;

const getAgeDays = (task: FocusTask) => {
  const created = new Date(task.createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.floor((Date.now() - created) / 86400000);
};

const cleanBrainDumpLine = (line: string) => {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .trim();
};

export default function DailyReviewModal({ onDismiss }: DailyReviewModalProps) {
  const {
    tasks,
    isLoaded,
    loadTasks,
    addTask,
    updateTask,
    deleteTask,
    setTasks,
  } = useTaskStore();

  const [stepIndex, setStepIndex] = useState(0);
  const [brainDump, setBrainDump] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [taskTitleDrafts, setTaskTitleDrafts] = useState<Record<string, string>>({});
  const [successNote, setSuccessNote] = useState('');
  const [avoidNote, setAvoidNote] = useState('');
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      loadTasks();
    }
  }, [isLoaded, loadTasks]);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => a.order - b.order), [tasks]);
  const openTasks = useMemo(() => sortedTasks.filter((task) => task.status !== 'done'), [sortedTasks]);
  const completedTasks = useMemo(() => sortedTasks.filter((task) => task.status === 'done'), [sortedTasks]);
  const currentStep = steps[stepIndex].id;
  const topTask = openTasks[0];

  const hasOpenTasks = openTasks.length > 0;
  const hasDraftTasks = newTaskTitle.trim().length > 0 || brainDump.trim().length > 0;
  const firstDraftTaskTitle = useMemo(() => {
    const inlineTask = newTaskTitle.trim();
    if (inlineTask) return inlineTask;
    return brainDump
      .split('\n')
      .map(cleanBrainDumpLine)
      .find(Boolean);
  }, [brainDump, newTaskTitle]);
  const canContinue =
    currentStep === 'plan' ? hasOpenTasks || hasDraftTasks :
    hasOpenTasks;

  const clearCompletedTasks = useCallback(async () => {
    const remaining = sortedTasks.filter((task) => task.status !== 'done');
    await setTasks(remaining);
  }, [setTasks, sortedTasks]);

  const handleMarkDone = useCallback(async (taskId: string) => {
    await updateTask(taskId, { status: 'done', completedAt: new Date().toISOString() });
  }, [updateTask]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    await deleteTask(taskId);
    setTaskTitleDrafts((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, [deleteTask]);

  const handleAddTask = useCallback(async () => {
    const trimmed = newTaskTitle.trim();
    if (!trimmed) return;

    await addTask(trimmed);
    setNewTaskTitle('');
  }, [addTask, newTaskTitle]);

  const handleAddTaskKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleAddTask();
    } else if (e.key === 'Escape') {
      setNewTaskTitle('');
    }
  }, [handleAddTask]);

  const commitTaskTitleDraft = useCallback(async (task: FocusTask) => {
    const draft = taskTitleDrafts[task.id];
    if (draft === undefined) return;

    const trimmed = draft.trim();
    setTaskTitleDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });

    if (!trimmed || trimmed === task.title) return;
    await updateTask(task.id, { title: trimmed });
  }, [taskTitleDrafts, updateTask]);

  const cancelTaskTitleDraft = useCallback((taskId: string) => {
    setTaskTitleDrafts((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const handleTaskTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, task: FocusTask) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTaskTitleDraft(task.id);
    }
  }, [cancelTaskTitleDraft]);

  const addBrainDumpTasks = useCallback(async () => {
    const lines = brainDump
      .split('\n')
      .map(cleanBrainDumpLine)
      .filter(Boolean);

    for (const line of lines) {
      await addTask(line);
    }

    if (lines.length > 0) {
      setBrainDump('');
    }
  }, [addTask, brainDump]);

  const moveTask = useCallback(async (taskId: string, direction: -1 | 1) => {
    const currentOpen = sortedTasks.filter((task) => task.status !== 'done');
    const done = sortedTasks.filter((task) => task.status === 'done');
    const index = currentOpen.findIndex((task) => task.id === taskId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= currentOpen.length) return;

    const reorderedOpen = [...currentOpen];
    const [moved] = reorderedOpen.splice(index, 1);
    reorderedOpen.splice(targetIndex, 0, moved);
    await setTasks([...reorderedOpen, ...done]);
  }, [setTasks, sortedTasks]);

  const reorderOpenTasks = useCallback(async (fromTaskId: string, toTaskId: string) => {
    if (fromTaskId === toTaskId) return;

    const currentOpen = sortedTasks.filter((task) => task.status !== 'done');
    const done = sortedTasks.filter((task) => task.status === 'done');
    const fromIndex = currentOpen.findIndex((task) => task.id === fromTaskId);
    const toIndex = currentOpen.findIndex((task) => task.id === toTaskId);
    if (fromIndex < 0 || toIndex < 0) return;

    const reorderedOpen = [...currentOpen];
    const [moved] = reorderedOpen.splice(fromIndex, 1);
    reorderedOpen.splice(toIndex, 0, moved);
    await setTasks([...reorderedOpen, ...done]);
  }, [setTasks, sortedTasks]);

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    setDraggedTaskId(taskId);
    setDragOverTaskId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, taskId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTaskId(taskId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTaskId(null);
    setDragOverTaskId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetTaskId: string) => {
    e.preventDefault();
    const sourceTaskId = draggedTaskId || e.dataTransfer.getData('text/plain');
    setDraggedTaskId(null);
    setDragOverTaskId(null);
    if (!sourceTaskId) return;
    void reorderOpenTasks(sourceTaskId, targetTaskId);
  }, [draggedTaskId, reorderOpenTasks]);

  const saveIntentAndDismiss = useCallback((requireTask = true, fallbackTopTaskTitle?: string) => {
    if (requireTask && !topTask) return;
    try {
      localStorage.setItem(`daily-review-intent-${new Date().toDateString()}`, JSON.stringify({
        topTaskId: topTask?.id,
        topTaskTitle: topTask?.title ?? fallbackTopTaskTitle,
        successNote: successNote.trim(),
        avoidNote: avoidNote.trim(),
        completedAt: new Date().toISOString(),
      }));
    } catch {
      // Non-critical; task state is already persisted separately.
    }
    onDismiss();
  }, [avoidNote, onDismiss, successNote, topTask]);

  const flushDraftTasks = useCallback(async () => {
    if (newTaskTitle.trim()) {
      await handleAddTask();
    }
    if (brainDump.trim()) {
      await addBrainDumpTasks();
    }
  }, [addBrainDumpTasks, brainDump, handleAddTask, newTaskTitle]);

  const handleAcceptCurrentStack = useCallback(async () => {
    const fallbackTopTaskTitle = topTask?.title ?? firstDraftTaskTitle;
    await flushDraftTasks();
    if (!hasOpenTasks && !hasDraftTasks) return;
    saveIntentAndDismiss(false, fallbackTopTaskTitle);
  }, [firstDraftTaskTitle, flushDraftTasks, hasDraftTasks, hasOpenTasks, saveIntentAndDismiss, topTask]);

  const handleFinish = useCallback(() => {
    if (!topTask || !canContinue) return;
    saveIntentAndDismiss();
  }, [canContinue, saveIntentAndDismiss, topTask]);

  const goNext = useCallback(async () => {
    if (currentStep === 'plan') {
      await flushDraftTasks();
    }
    if (!canContinue) return;
    if (stepIndex < steps.length - 1) {
      setStepIndex((idx) => idx + 1);
    }
  }, [canContinue, currentStep, flushDraftTasks, stepIndex]);

  const goBack = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const renderTaskTitleInput = useCallback((task: FocusTask, className = '') => (
    <input
      value={taskTitleDrafts[task.id] ?? task.title}
      onChange={(e) => {
        const value = e.target.value;
        setTaskTitleDrafts((prev) => ({ ...prev, [task.id]: value }));
      }}
      onBlur={() => void commitTaskTitleDraft(task)}
      onKeyDown={(e) => handleTaskTitleKeyDown(e, task)}
      onMouseDown={(e) => e.stopPropagation()}
      className={`w-full min-w-0 bg-transparent border-b border-transparent px-0 py-0.5 text-left focus:outline-none focus:border-emerald-500 ${className}`}
      style={{ borderRadius: 0 }}
    />
  ), [commitTaskTitleDraft, handleTaskTitleKeyDown, taskTitleDrafts]);

  const addTaskControl = (
    <div className="flex items-center gap-2 border border-claude-border bg-claude-bg/50 px-3 py-2">
      <Plus size={14} className="text-emerald-400 flex-shrink-0" />
      <input
        value={newTaskTitle}
        onChange={(e) => setNewTaskTitle(e.target.value)}
        onKeyDown={handleAddTaskKeyDown}
        placeholder="Add task..."
        className="flex-1 min-w-0 bg-transparent text-xs font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none"
        style={{ borderRadius: 0 }}
      />
      <button
        onClick={() => void handleAddTask()}
        disabled={!newTaskTitle.trim()}
        className="px-3 py-1.5 bg-emerald-500/20 text-emerald-300 text-[10px] font-mono uppercase hover:bg-emerald-500/30 disabled:opacity-30"
        style={{ borderRadius: 0 }}
      >
        Add
      </button>
    </div>
  );

  const renderEditableOpenTaskList = useCallback((emptyText: string) => (
    <div className="border border-claude-border bg-claude-bg/50">
      {openTasks.length === 0 ? (
        <p className="px-3 py-4 text-xs text-claude-text-secondary font-mono">
          {emptyText}
        </p>
      ) : (
        openTasks.map((task, index) => (
          <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-b border-claude-border last:border-b-0">
            <div className={`w-6 h-6 border flex items-center justify-center text-[10px] font-mono flex-shrink-0 ${
              index === 0 ? 'border-emerald-500 text-emerald-300' : 'border-claude-border text-claude-text-secondary'
            }`}>
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              {renderTaskTitleInput(task, 'text-xs font-mono text-claude-text')}
            </div>
            <button
              onClick={() => handleMarkDone(task.id)}
              className="p-1 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
              title="Mark done"
            >
              <Check size={13} />
            </button>
            <button
              onClick={() => handleDeleteTask(task.id)}
              className="p-1 border border-red-500/30 text-red-300 hover:bg-red-500/10"
              title="Drop task"
            >
              <X size={13} />
            </button>
          </div>
        ))
      )}
    </div>
  ), [handleDeleteTask, handleMarkDone, openTasks, renderTaskTitleInput]);

  return (
    <div className="fixed inset-0 bg-black/90 z-[9999] flex items-center justify-center p-4">
      <div className="bg-claude-surface border-4 border-emerald-500/60 w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="px-6 py-5 border-b border-claude-border">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center flex-shrink-0">
              <CalendarDays size={22} className="text-emerald-400" strokeWidth={3} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-emerald-400 uppercase" style={{ letterSpacing: '0.08em' }}>
                Morning Priority Reset
              </h2>
              <p className="text-xs text-claude-text-secondary mt-1">
                Capture loose ends, clean up old work, rank the stack, then commit to the first move.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-5">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={`h-9 border flex items-center justify-center gap-2 text-[10px] font-mono uppercase ${
                  index === stepIndex
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                    : index < stepIndex
                      ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-500'
                      : 'border-claude-border text-claude-text-secondary'
                }`}
              >
                {index < stepIndex ? <Check size={12} /> : <span>{index + 1}</span>}
                <span className="truncate">{step.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {currentStep === 'plan' && (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,0.75fr)_minmax(360px,1.25fr)] gap-4">
              <div className="space-y-4">
                {addTaskControl}

                <section>
                  <div className="flex items-center gap-2">
                    <ClipboardList size={16} className="text-emerald-400" />
                    <h3 className="text-xs font-mono uppercase text-claude-text">Capture</h3>
                  </div>
                  <textarea
                    value={brainDump}
                    onChange={(e) => setBrainDump(e.target.value)}
                    placeholder={"Paste loose loops, one per line"}
                    className="mt-2 w-full h-24 px-3 py-3 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-emerald-500 resize-none"
                    style={{ borderRadius: 0 }}
                  />
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] font-mono text-claude-text-secondary">
                      {openTasks.length} open
                    </span>
                    <button
                      onClick={addBrainDumpTasks}
                      disabled={!brainDump.trim()}
                      className="px-3 py-2 bg-emerald-500/20 text-emerald-300 text-xs font-mono uppercase hover:bg-emerald-500/30 disabled:opacity-30"
                      style={{ borderRadius: 0 }}
                    >
                      <Plus size={13} className="inline mr-1" />
                      Add lines
                    </button>
                  </div>
                </section>

                <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <CheckSquare size={15} className="text-emerald-400" />
                    <h3 className="text-xs font-mono uppercase text-claude-text">Close</h3>
                  </div>
                  {completedTasks.length > 0 && (
                    <button
                      onClick={clearCompletedTasks}
                      className="px-2 py-1 text-[10px] font-mono uppercase text-red-300 hover:text-red-200 border border-red-500/30 hover:bg-red-500/10"
                    >
                      Clear completed
                    </button>
                  )}
                </div>
                <div className="border border-claude-border bg-claude-bg/50 max-h-44 overflow-y-auto">
                  {completedTasks.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-claude-text-secondary font-mono">
                      No completed tasks to clear.
                    </p>
                  ) : (
                    completedTasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-b border-claude-border last:border-b-0">
                        <CheckSquare size={13} className="text-emerald-500 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          {renderTaskTitleInput(task, 'text-xs font-mono text-claude-text-secondary line-through')}
                        </div>
                        <button
                          onClick={() => deleteTask(task.id)}
                          className="text-claude-text-secondary hover:text-red-400"
                          title="Clear completed task"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                </section>
              </div>

              <section>
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={15} className="text-amber-400" />
                  <h3 className="text-xs font-mono uppercase text-claude-text">Restack</h3>
                  <span className="text-[10px] font-mono text-claude-text-secondary">
                    drag, edit, done, or drop only if needed
                  </span>
                </div>
                <div className="border border-claude-border bg-claude-bg/50 max-h-[52vh] overflow-y-auto">
                  {openTasks.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-claude-text-secondary font-mono">
                      No open tasks yet.
                    </p>
                  ) : (
                    openTasks.map((task, index) => {
                      const ageDays = getAgeDays(task);
                      const isStale = ageDays >= staleTaskDays;
                      return (
                        <div
                          key={task.id}
                          onDragOver={(e) => handleDragOver(e, task.id)}
                          onDrop={(e) => handleDrop(e, task.id)}
                          onDragEnd={handleDragEnd}
                          className={`group flex flex-wrap items-start gap-3 px-3 py-3 border-b border-claude-border last:border-b-0 transition-colors ${
                            index < 3 ? 'bg-emerald-500/5' : ''
                          } ${
                            dragOverTaskId === task.id && draggedTaskId !== task.id ? 'outline outline-1 outline-emerald-500/70 bg-emerald-500/10' : ''
                          } ${
                            draggedTaskId === task.id ? 'opacity-45' : ''
                          }`}
                        >
                          <div
                            draggable
                            onDragStart={(e) => handleDragStart(e, task.id)}
                            className="mt-1 cursor-grab text-claude-text-secondary/60 group-hover:text-emerald-300 flex-shrink-0"
                            title="Drag to reorder"
                          >
                            <GripVertical size={14} />
                          </div>
                          <div className={`w-7 h-7 border flex items-center justify-center text-[10px] font-mono flex-shrink-0 ${
                            index === 0 ? 'border-emerald-500 text-emerald-300' : 'border-claude-border text-claude-text-secondary'
                          }`}>
                            {index + 1}
                          </div>
                          <div className="flex-1 min-w-[220px]">
                            {renderTaskTitleInput(task, 'text-xs font-mono text-claude-text')}
                            <div className={`text-[10px] font-mono mt-1 ${isStale ? 'text-amber-300' : 'text-claude-text-secondary'}`}>
                              {ageDays === 0 ? 'created today' : `${ageDays} day${ageDays === 1 ? '' : 's'} old`}
                              {isStale ? ' - stale' : ''}
                              {index === 0 ? ' - start here' : ''}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-1 flex-shrink-0">
                            <button
                              onClick={() => moveTask(task.id, -1)}
                              disabled={index === 0}
                              className="p-1 border border-claude-border text-claude-text-secondary hover:text-claude-text disabled:opacity-25"
                              title="Move up"
                            >
                              <ArrowUp size={13} />
                            </button>
                            <button
                              onClick={() => moveTask(task.id, 1)}
                              disabled={index === openTasks.length - 1}
                              className="p-1 border border-claude-border text-claude-text-secondary hover:text-claude-text disabled:opacity-25"
                              title="Move down"
                            >
                              <ArrowDown size={13} />
                            </button>
                            <button
                              onClick={() => handleMarkDone(task.id)}
                              className="px-2 py-1 text-[10px] font-mono uppercase border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                            >
                              Done
                            </button>
                            <button
                              onClick={() => handleDeleteTask(task.id)}
                              className="px-2 py-1 text-[10px] font-mono uppercase border border-red-500/30 text-red-300 hover:bg-red-500/10"
                            >
                              Drop
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          )}

          {currentStep === 'commit' && (
            <div className="space-y-5">
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="text-[10px] font-mono uppercase text-emerald-300 mb-2">First task</div>
                {topTask ? (
                  renderTaskTitleInput(topTask, 'text-base font-mono text-claude-text')
                ) : (
                  <div className="text-base font-mono text-claude-text">No task selected</div>
                )}
              </div>
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Target size={15} className="text-emerald-400" />
                  <h3 className="text-xs font-mono uppercase text-claude-text">Priority stack</h3>
                </div>
                {renderEditableOpenTaskList('No open tasks selected.')}
              </section>
              <div>
                <label className="block text-xs font-mono text-claude-text uppercase mb-2">
                  What would make today successful? <span className="text-claude-text-secondary normal-case">(optional)</span>
                </label>
                <input
                  value={successNote}
                  onChange={(e) => setSuccessNote(e.target.value)}
                  className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-emerald-500"
                  placeholder="One concrete outcome"
                  style={{ borderRadius: 0 }}
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-claude-text uppercase mb-2">
                  What should not steal the morning?
                </label>
                <input
                  value={avoidNote}
                  onChange={(e) => setAvoidNote(e.target.value)}
                  className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-emerald-500"
                  placeholder="Optional distraction or trap"
                  style={{ borderRadius: 0 }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-claude-border flex items-center gap-3">
          <button
            onClick={goBack}
            disabled={stepIndex === 0}
            className="px-4 py-2 border border-claude-border text-xs font-mono uppercase text-claude-text-secondary hover:text-claude-text disabled:opacity-25"
            style={{ borderRadius: 0 }}
          >
            Back
          </button>
          <div className="flex-1 text-[10px] font-mono text-claude-text-secondary">
            {!canContinue && currentStep === 'plan' && 'Add or keep at least one open task before continuing.'}
            {!canContinue && currentStep === 'commit' && 'Keep at least one open task before starting.'}
            {canContinue && currentStep === 'plan' && 'No changes needed? Accept the current order and close this immediately.'}
          </div>
          {stepIndex < steps.length - 1 ? (
            <div className="flex items-center gap-2">
              <button
                onClick={goNext}
                disabled={!canContinue}
                className="px-4 py-2 border border-claude-border text-claude-text text-xs font-mono font-bold uppercase hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-30"
                style={{ borderRadius: 0 }}
              >
                Set Intention
              </button>
              <button
                onClick={() => void handleAcceptCurrentStack()}
                disabled={!canContinue}
                className="px-5 py-2 bg-emerald-500 text-white text-xs font-mono font-bold uppercase hover:bg-emerald-400 disabled:opacity-30"
                style={{ borderRadius: 0 }}
              >
                Accept Stack
              </button>
            </div>
          ) : (
            <button
              onClick={handleFinish}
              disabled={!canContinue}
              className="px-5 py-2 bg-emerald-500 text-white text-xs font-mono font-bold uppercase hover:bg-emerald-400 disabled:opacity-30"
              style={{ borderRadius: 0 }}
            >
              Start My Day
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
