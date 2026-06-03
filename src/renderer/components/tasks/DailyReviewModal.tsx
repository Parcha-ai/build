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
  Square,
  Target,
  X,
} from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import type { FocusTask } from '../../../shared/types';

interface DailyReviewModalProps {
  onDismiss: () => void;
}

type ReviewStep = 'close' | 'capture' | 'stack' | 'commit';

const steps: Array<{ id: ReviewStep; label: string }> = [
  { id: 'close', label: 'Close loops' },
  { id: 'capture', label: 'Capture' },
  { id: 'stack', label: 'Restack' },
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
  const [reviewedOpenTaskIds, setReviewedOpenTaskIds] = useState<Set<string>>(new Set());
  const [brainDump, setBrainDump] = useState('');
  const [successNote, setSuccessNote] = useState('');
  const [avoidNote, setAvoidNote] = useState('');
  const [confirmedStack, setConfirmedStack] = useState(false);
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
  const reviewedVisibleOpenCount = openTasks.filter((task) => reviewedOpenTaskIds.has(task.id)).length;
  const currentStep = steps[stepIndex].id;
  const topTask = openTasks[0];

  const openLoopReviewComplete = openTasks.every((task) => reviewedOpenTaskIds.has(task.id));
  const hasOpenTasks = openTasks.length > 0;
  const hasSuccessNote = successNote.trim().length >= 3;
  const canContinue =
    currentStep === 'close' ? openLoopReviewComplete :
    currentStep === 'capture' ? hasOpenTasks || brainDump.trim().length > 0 :
    currentStep === 'stack' ? hasOpenTasks :
    confirmedStack && hasSuccessNote && hasOpenTasks;

  const markOpenReviewed = useCallback((taskId: string) => {
    setReviewedOpenTaskIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }, []);

  const clearCompletedTasks = useCallback(async () => {
    const remaining = sortedTasks.filter((task) => task.status !== 'done');
    await setTasks(remaining);
  }, [setTasks, sortedTasks]);

  const handleKeepTask = useCallback((taskId: string) => {
    markOpenReviewed(taskId);
  }, [markOpenReviewed]);

  const handleMarkDone = useCallback(async (taskId: string) => {
    await updateTask(taskId, { status: 'done', completedAt: new Date().toISOString() });
    markOpenReviewed(taskId);
  }, [markOpenReviewed, updateTask]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    await deleteTask(taskId);
    markOpenReviewed(taskId);
  }, [deleteTask, markOpenReviewed]);

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
    setConfirmedStack(false);
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
    setConfirmedStack(false);
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

  const handleFinish = useCallback(() => {
    if (!topTask || !canContinue) return;
    try {
      localStorage.setItem(`daily-review-intent-${new Date().toDateString()}`, JSON.stringify({
        topTaskId: topTask.id,
        topTaskTitle: topTask.title,
        successNote: successNote.trim(),
        avoidNote: avoidNote.trim(),
        completedAt: new Date().toISOString(),
      }));
    } catch {
      // Non-critical; task state is already persisted separately.
    }
    onDismiss();
  }, [avoidNote, canContinue, onDismiss, successNote, topTask]);

  const goNext = useCallback(async () => {
    if (currentStep === 'capture' && brainDump.trim()) {
      await addBrainDumpTasks();
    }
    if (!canContinue) return;
    if (stepIndex < steps.length - 1) {
      setStepIndex((idx) => idx + 1);
    }
  }, [addBrainDumpTasks, brainDump, canContinue, currentStep, stepIndex]);

  const goBack = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

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
                Close stale loops, capture what is in your head, restack the list, then commit to the first move.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 mt-5">
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
          {currentStep === 'close' && (
            <div className="space-y-5">
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <CheckSquare size={15} className="text-emerald-400" />
                    <h3 className="text-xs font-mono uppercase text-claude-text">Completed work</h3>
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
                <div className="border border-claude-border bg-claude-bg/50">
                  {completedTasks.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-claude-text-secondary font-mono">
                      No completed tasks to clear.
                    </p>
                  ) : (
                    completedTasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-b border-claude-border last:border-b-0">
                        <CheckSquare size={13} className="text-emerald-500 flex-shrink-0" />
                        <span className="flex-1 min-w-0 truncate text-xs font-mono text-claude-text-secondary line-through">
                          {task.title}
                        </span>
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

              <section>
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={15} className="text-amber-400" />
                  <h3 className="text-xs font-mono uppercase text-claude-text">Open loops</h3>
                  {openTasks.length > 0 && (
                    <span className="text-[10px] font-mono text-amber-300">
                      review {reviewedVisibleOpenCount}/{openTasks.length}
                    </span>
                  )}
                </div>
                <div className="border border-claude-border bg-claude-bg/50">
                  {openTasks.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-claude-text-secondary font-mono">
                      No open tasks to close.
                    </p>
                  ) : (
                    openTasks.map((task) => {
                      const reviewed = reviewedOpenTaskIds.has(task.id);
                      const ageDays = getAgeDays(task);
                      const isStale = ageDays >= staleTaskDays;
                      return (
                        <div key={task.id} className={`px-3 py-3 border-b border-claude-border last:border-b-0 ${reviewed ? 'opacity-55' : ''}`}>
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-mono text-claude-text truncate">{task.title}</div>
                              <div className={`text-[10px] font-mono mt-1 ${isStale ? 'text-amber-300' : 'text-claude-text-secondary'}`}>
                                {ageDays === 0 ? 'created today' : `${ageDays} day${ageDays === 1 ? '' : 's'} old`}
                                {isStale ? ' - stale' : ''}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => handleKeepTask(task.id)}
                                className="px-2 py-1 text-[10px] font-mono uppercase border border-claude-border hover:border-emerald-500 hover:text-emerald-300"
                              >
                                Keep
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
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          )}

          {currentStep === 'capture' && (
            <div className="space-y-5">
              <div className="flex items-center gap-2">
                <ClipboardList size={16} className="text-emerald-400" />
                <h3 className="text-xs font-mono uppercase text-claude-text">Brain dump open loops</h3>
              </div>
              <p className="text-xs text-claude-text-secondary">
                Add one task per line. Empty task lists cannot pass this step.
              </p>
              <textarea
                value={brainDump}
                onChange={(e) => setBrainDump(e.target.value)}
                placeholder={"Finish release notes\nReview blocked PRs\nBook dentist appointment"}
                className="w-full h-40 px-3 py-3 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-emerald-500 resize-none"
                style={{ borderRadius: 0 }}
                autoFocus
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-claude-text-secondary">
                  {openTasks.length} open task{openTasks.length === 1 ? '' : 's'} in the stack
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
            </div>
          )}

          {currentStep === 'stack' && (
            <div className="space-y-5">
              <div className="flex items-center gap-2">
                <Target size={16} className="text-emerald-400" />
                <h3 className="text-xs font-mono uppercase text-claude-text">Restack priorities</h3>
              </div>
              <p className="text-xs text-claude-text-secondary">
                Put the real first task at the top. The first three become today&apos;s visible priority stack.
              </p>
              <div className="border border-claude-border bg-claude-bg/50">
                {openTasks.map((task, index) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onDragOver={(e) => handleDragOver(e, task.id)}
                    onDrop={(e) => handleDrop(e, task.id)}
                    onDragEnd={handleDragEnd}
                    className={`group flex items-center gap-3 px-3 py-2 border-b border-claude-border last:border-b-0 transition-colors ${
                      index < 3 ? 'bg-emerald-500/5' : ''
                    } ${
                      dragOverTaskId === task.id && draggedTaskId !== task.id ? 'outline outline-1 outline-emerald-500/70 bg-emerald-500/10' : ''
                    } ${
                      draggedTaskId === task.id ? 'opacity-45' : ''
                    }`}
                  >
                    <div
                      className="cursor-grab text-claude-text-secondary/60 group-hover:text-emerald-300 flex-shrink-0"
                      title="Drag to reorder"
                    >
                      <GripVertical size={14} />
                    </div>
                    <div className={`w-7 h-7 border flex items-center justify-center text-[10px] font-mono flex-shrink-0 ${
                      index === 0 ? 'border-emerald-500 text-emerald-300' : 'border-claude-border text-claude-text-secondary'
                    }`}>
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono text-claude-text truncate">{task.title}</div>
                      {index === 0 && (
                        <div className="text-[10px] font-mono text-emerald-300 mt-0.5">start here</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
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
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentStep === 'commit' && (
            <div className="space-y-5">
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="text-[10px] font-mono uppercase text-emerald-300 mb-2">First task</div>
                <div className="text-base font-mono text-claude-text">{topTask?.title || 'No task selected'}</div>
              </div>
              <div>
                <label className="block text-xs font-mono text-claude-text uppercase mb-2">
                  What would make today successful?
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
              <button
                onClick={() => setConfirmedStack(!confirmedStack)}
                className="flex items-center gap-3 text-left w-full border border-claude-border bg-claude-bg/50 px-3 py-3 hover:border-emerald-500/40"
              >
                {confirmedStack ? <CheckSquare size={16} className="text-emerald-400" /> : <Square size={16} className="text-claude-text-secondary" />}
                <span className="text-xs font-mono text-claude-text">
                  I have reviewed old tasks, restacked the list, and know the first action.
                </span>
              </button>
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
            {!canContinue && currentStep === 'close' && 'Review each stale open task before continuing.'}
            {!canContinue && currentStep === 'capture' && 'Add at least one open task before continuing.'}
            {!canContinue && currentStep === 'commit' && 'Write the success condition and confirm the stack.'}
          </div>
          {stepIndex < steps.length - 1 ? (
            <button
              onClick={goNext}
              disabled={!canContinue}
              className="px-5 py-2 bg-emerald-500 text-white text-xs font-mono font-bold uppercase hover:bg-emerald-400 disabled:opacity-30"
              style={{ borderRadius: 0 }}
            >
              Next
            </button>
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
