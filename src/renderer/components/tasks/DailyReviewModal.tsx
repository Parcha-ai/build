import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  CheckSquare,
  ClipboardList,
  Clock,
  GripVertical,
  Plus,
  Target,
  X,
} from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import type { FocusTask } from '../../../shared/types';

interface DailyReviewModalProps {
  onDismiss: () => void;
  onOpenCalendarEvents?: (events: PlanningCalendarEvent[]) => Promise<void> | void;
  title?: string;
  description?: string;
  lockMode?: boolean;
  sessionDurationMinutes?: number;
}

export interface PlanningCalendarEvent {
  taskId: string;
  title: string;
  date: string;
  time: string;
  durationMinutes: number;
}

type ReviewStep = 'plan' | 'commit';

const steps: Array<{ id: ReviewStep; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'commit', label: 'Commit' },
];

const staleTaskDays = 7;
const calendarHours = Array.from({ length: 14 }, (_, index) => index + 7);

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const tomorrowDate = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return formatLocalDate(date);
};

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

export default function DailyReviewModal({
  onDismiss,
  onOpenCalendarEvents,
  title = 'Morning Priority Reset',
  description = 'Capture loose ends, clean up old work, rank the stack, then commit to the first move.',
  lockMode = false,
  sessionDurationMinutes = 0,
}: DailyReviewModalProps) {
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
  const [calendarEvents, setCalendarEvents] = useState<PlanningCalendarEvent[]>([]);
  const [calendarDropActive, setCalendarDropActive] = useState(false);
  const [calendarTaskToPlaceId, setCalendarTaskToPlaceId] = useState<string | null>(null);
  const timerStorageKey = `planning-session-start-${new Date().toDateString()}`;
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(() => {
    if (!lockMode || sessionDurationMinutes <= 0) return Date.now();
    const saved = Number(localStorage.getItem(timerStorageKey));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const [remainingSeconds, setRemainingSeconds] = useState(sessionDurationMinutes * 60);

  useEffect(() => {
    if (!sessionStartedAt || sessionDurationMinutes <= 0) return;
    const updateRemaining = () => {
      const elapsed = Math.floor((Date.now() - sessionStartedAt) / 1000);
      setRemainingSeconds(Math.max(0, sessionDurationMinutes * 60 - elapsed));
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 1000);
    return () => clearInterval(timer);
  }, [sessionDurationMinutes, sessionStartedAt]);

  const startSession = useCallback(() => {
    const startedAt = Date.now();
    localStorage.setItem(timerStorageKey, String(startedAt));
    setSessionStartedAt(startedAt);
    setRemainingSeconds(sessionDurationMinutes * 60);
  }, [sessionDurationMinutes, timerStorageKey]);

  const timerComplete = sessionDurationMinutes <= 0 || remainingSeconds === 0;
  const formattedRemaining = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;

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
    // The same gesture can reorder a task (move) or place a copy on the
    // calendar timeline. Advertising both operations keeps native drops valid.
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.setData('application/x-build-task-id', taskId);
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

  const scheduleTask = useCallback((taskId: string, requestedTime?: string) => {
    const task = openTasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    setCalendarEvents((current) => {
      if (current.some((event) => event.taskId === taskId)) {
        if (!requestedTime) return current;
        return current.map((event) => event.taskId === taskId ? { ...event, time: requestedTime } : event);
      }
      const minutesFromNine = current.length * 30;
      const hour = 9 + Math.floor(minutesFromNine / 60);
      const minute = minutesFromNine % 60;
      return [...current, {
        taskId,
        title: task.title,
        date: tomorrowDate(),
        time: requestedTime || `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        durationMinutes: 30,
      }];
    });
  }, [openTasks]);

  const handleCalendarDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const taskId = e.dataTransfer.getData('application/x-build-task-id')
      || draggedTaskId
      || e.dataTransfer.getData('text/plain');
    setCalendarDropActive(false);
    setDraggedTaskId(null);
    setDragOverTaskId(null);
    const slot = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-planning-calendar-hour]');
    const requestedHour = Number(slot?.dataset.planningCalendarHour);
    if (taskId) {
      scheduleTask(
        taskId,
        Number.isFinite(requestedHour) ? `${String(requestedHour).padStart(2, '0')}:00` : undefined,
      );
    }
  }, [draggedTaskId, scheduleTask]);

  const updateCalendarEvent = useCallback((taskId: string, patch: Partial<PlanningCalendarEvent>) => {
    setCalendarEvents((current) => current.map((event) => (
      event.taskId === taskId ? { ...event, ...patch } : event
    )));
  }, []);

  const removeCalendarEvent = useCallback((taskId: string) => {
    setCalendarEvents((current) => current.filter((event) => event.taskId !== taskId));
  }, []);

  // Electron can suppress native HTML drag events when a pointer crosses
  // editable controls. Track the pointer as a fallback so the visible gesture
  // always schedules the task on the slot where the user releases it.
  useEffect(() => {
    if (!draggedTaskId) return undefined;
    const finishPointerDrag = (event: PointerEvent | MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const calendar = target?.closest<HTMLElement>('[data-planning-calendar-drop-zone]');
      if (!calendar) {
        setDraggedTaskId(null);
        setDragOverTaskId(null);
        return;
      }
      const slot = target?.closest<HTMLElement>('[data-planning-calendar-hour]');
      const requestedHour = Number(slot?.dataset.planningCalendarHour);
      scheduleTask(
        draggedTaskId,
        Number.isFinite(requestedHour) ? `${String(requestedHour).padStart(2, '0')}:00` : undefined,
      );
      setCalendarDropActive(false);
      setCalendarTaskToPlaceId(null);
      setDraggedTaskId(null);
      setDragOverTaskId(null);
    };
    window.addEventListener('pointerup', finishPointerDrag, true);
    window.addEventListener('mouseup', finishPointerDrag, true);
    return () => {
      window.removeEventListener('pointerup', finishPointerDrag, true);
      window.removeEventListener('mouseup', finishPointerDrag, true);
    };
  }, [draggedTaskId, scheduleTask]);

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

  const handleFinish = useCallback(async () => {
    if (!topTask || !canContinue) return;
    if (calendarEvents.length > 0) {
      await onOpenCalendarEvents?.(calendarEvents);
    }
    saveIntentAndDismiss();
  }, [calendarEvents, canContinue, onOpenCalendarEvents, saveIntentAndDismiss, topTask]);

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

  useEffect(() => {
    if (!lockMode || !sessionStartedAt) return;
    const handlePlanningShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (currentStep === 'plan' && canContinue) {
        void goNext();
      } else if (currentStep === 'commit' && canContinue) {
        void handleFinish();
      }
    };
    window.addEventListener('keydown', handlePlanningShortcut, true);
    return () => window.removeEventListener('keydown', handlePlanningShortcut, true);
  }, [canContinue, currentStep, goNext, handleFinish, lockMode, sessionStartedAt]);

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

  // Keep this conditional return below every hook. Returning before the hook
  // above makes the Start Planning click change the hook count and crashes React.
  if (lockMode && !sessionStartedAt) {
    return (
      <div className="planning-lock-interactive fixed inset-0 bg-black/95 z-[100000] flex items-center justify-center p-4">
        <div className="bg-claude-surface border-4 border-emerald-500/60 w-full max-w-xl p-8 text-center">
          <CalendarDays size={42} className="text-emerald-400 mx-auto" strokeWidth={2.5} />
          <h2 className="mt-5 text-2xl font-bold text-emerald-400 uppercase tracking-wider">{title}</h2>
          <p className="mt-3 text-sm text-claude-text-secondary">{description}</p>
          <div className="my-7 border border-emerald-500/40 bg-emerald-500/10 p-5">
            <div className="text-4xl font-mono font-bold text-claude-text">15:00</div>
            <div className="mt-2 text-[10px] font-mono uppercase tracking-wider text-emerald-300">
              Protected planning time
            </div>
          </div>
          <button
            type="button"
            onClick={startSession}
            className="w-full px-6 py-3 bg-emerald-500 text-white text-sm font-mono font-bold uppercase hover:bg-emerald-400"
            style={{ borderRadius: 0 }}
          >
            Start Planning
          </button>
          <p className="mt-3 text-[10px] font-mono text-claude-text-secondary">
            Finish when your plan is ready. The timer is only a planning guide.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`planning-lock-interactive fixed inset-0 bg-black/90 ${lockMode ? 'z-[100000]' : 'z-[9999]'} flex items-center justify-center p-4`}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-claude-surface border-4 border-emerald-500/60 w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="px-6 py-5 border-b border-claude-border">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center flex-shrink-0">
              <CalendarDays size={22} className="text-emerald-400" strokeWidth={3} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-emerald-400 uppercase" style={{ letterSpacing: '0.08em' }}>
                {title}
              </h2>
              <p className="text-xs text-claude-text-secondary mt-1">
                {description}
              </p>
            </div>
            {lockMode && sessionDurationMinutes > 0 && (
              <div className={`px-4 py-2 border font-mono text-lg font-bold ${timerComplete ? 'border-emerald-500 text-emerald-300' : 'border-claude-border text-claude-text-secondary'}`} title="Optional planning guide">
                {timerComplete ? '00:00' : formattedRemaining}
              </div>
            )}
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
                <div
                  onDragEnter={(e) => { e.preventDefault(); setCalendarDropActive(true); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setCalendarDropActive(true); }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCalendarDropActive(false);
                  }}
                  onDrop={handleCalendarDrop}
                  className={`mb-3 border-2 border-dashed p-3 transition-colors ${
                    calendarDropActive
                      ? 'border-emerald-400 bg-emerald-500/15'
                      : 'border-emerald-500/35 bg-emerald-500/5'
                  }`}
                  data-planning-calendar-drop-zone
                >
                  <div className="flex items-center gap-2">
                    <CalendarDays size={15} className="text-emerald-400" />
                    <div className="flex-1">
                      <div className="text-xs font-mono uppercase text-emerald-300">Calendar plan</div>
                      <div className="mt-0.5 text-[10px] font-mono text-claude-text-secondary">
                        {calendarTaskToPlaceId
                          ? 'Choose an hour below.'
                          : 'Drag a task to an hour, or press Schedule and choose a time.'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 max-h-48 overflow-y-auto border border-claude-border/70 bg-claude-bg/60" data-planning-calendar-timeline>
                    {calendarHours.map((hour) => {
                      const eventsAtHour = calendarEvents.filter((event) => Number(event.time.split(':')[0]) === hour);
                      const labelHour = hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
                      return (
                        <div
                          key={hour}
                          data-planning-calendar-hour={hour}
                          onClick={() => {
                            if (!calendarTaskToPlaceId) return;
                            scheduleTask(calendarTaskToPlaceId, `${String(hour).padStart(2, '0')}:00`);
                            setCalendarTaskToPlaceId(null);
                          }}
                          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                          className={`grid min-h-10 grid-cols-[54px_1fr] border-b border-claude-border/50 last:border-b-0 ${calendarTaskToPlaceId ? 'cursor-pointer hover:bg-emerald-500/10' : ''}`}
                        >
                          <div className="border-r border-claude-border/50 px-2 py-2 text-right text-[9px] font-mono text-claude-text-secondary">
                            {labelHour}
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-emerald-500/5">
                            {eventsAtHour.length === 0 ? (
                              <span className="text-[9px] font-mono text-claude-text-secondary/40">Drop task</span>
                            ) : eventsAtHour.map((event) => (
                              <div key={event.taskId} className="flex min-w-0 items-center gap-1 border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[9px] font-mono text-emerald-200">
                                <span className="text-emerald-400">{event.time}</span>
                                <span className="max-w-48 truncate">{event.title}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {calendarEvents.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {calendarEvents.map((event) => (
                        <div key={event.taskId} className="grid grid-cols-[minmax(140px,1fr)_122px_90px_70px_28px] items-center gap-2 border border-emerald-500/25 bg-claude-bg/70 p-2">
                          <div className="truncate text-[11px] font-mono text-claude-text" title={event.title}>{event.title}</div>
                          <input
                            type="date"
                            value={event.date}
                            onChange={(e) => updateCalendarEvent(event.taskId, { date: e.target.value })}
                            className="min-w-0 border border-claude-border bg-claude-surface px-1.5 py-1 text-[10px] font-mono text-claude-text"
                            aria-label={`Date for ${event.title}`}
                          />
                          <input
                            type="time"
                            value={event.time}
                            onChange={(e) => updateCalendarEvent(event.taskId, { time: e.target.value })}
                            className="min-w-0 border border-claude-border bg-claude-surface px-1.5 py-1 text-[10px] font-mono text-claude-text"
                            aria-label={`Time for ${event.title}`}
                          />
                          <select
                            value={event.durationMinutes}
                            onChange={(e) => updateCalendarEvent(event.taskId, { durationMinutes: Number(e.target.value) })}
                            className="min-w-0 border border-claude-border bg-claude-surface px-1 py-1 text-[10px] font-mono text-claude-text"
                            aria-label={`Duration for ${event.title}`}
                          >
                            <option value={15}>15m</option>
                            <option value={30}>30m</option>
                            <option value={45}>45m</option>
                            <option value={60}>1h</option>
                            <option value={90}>90m</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => removeCalendarEvent(event.taskId)}
                            className="flex h-7 w-7 items-center justify-center border border-red-500/30 text-red-300 hover:bg-red-500/10"
                            title="Remove from calendar plan"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
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
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              setDraggedTaskId(task.id);
                              setDragOverTaskId(null);
                            }}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              setDraggedTaskId(task.id);
                              setDragOverTaskId(null);
                            }}
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
                              type="button"
                              onClick={() => {
                                setCalendarTaskToPlaceId(task.id);
                              }}
                              className={`px-2 py-1 text-[10px] font-mono uppercase border ${
                                calendarEvents.some((event) => event.taskId === task.id)
                                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                                  : 'border-claude-border text-claude-text-secondary hover:border-emerald-500/40 hover:text-emerald-300'
                              }`}
                              title="Add to calendar plan"
                            >
                              <Clock size={12} className="inline mr-1" />
                              {calendarTaskToPlaceId === task.id
                                ? 'Pick time'
                                : calendarEvents.some((event) => event.taskId === task.id) ? 'Move' : 'Schedule'}
                            </button>
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
                type="button"
                onClick={goNext}
                disabled={!canContinue}
                className="px-4 py-2 border border-claude-border text-claude-text text-xs font-mono font-bold uppercase hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-30"
                style={{ borderRadius: 0 }}
              >
                Set Intention
              </button>
              {!lockMode && (
                <button
                  onClick={() => void handleAcceptCurrentStack()}
                  disabled={!canContinue}
                  className="px-5 py-2 bg-emerald-500 text-white text-xs font-mono font-bold uppercase hover:bg-emerald-400 disabled:opacity-30"
                  style={{ borderRadius: 0 }}
                >
                  Accept Stack
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={handleFinish}
              disabled={!canContinue}
              className="px-5 py-2 bg-emerald-500 text-white text-xs font-mono font-bold uppercase hover:bg-emerald-400 disabled:opacity-30"
              style={{ borderRadius: 0 }}
            >
              {lockMode ? 'Finish Planning' : 'Start My Day'}
            </button>
          )}
        </div>
        {lockMode && (
          <div className="px-6 pb-3 text-right text-[9px] font-mono uppercase text-claude-text-secondary">
            Keyboard: {navigator.platform.toLowerCase().includes('mac') ? 'Command' : 'Ctrl'} + Enter
          </div>
        )}
      </div>
    </div>
  );
}
