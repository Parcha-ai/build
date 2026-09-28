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
      className={`w-full min-w-0 bg-transparent border-b border-transparent px-0 py-0.5 text-left focus:outline-none focus:border-accent/60 ${className}`}
    />
  ), [commitTaskTitleDraft, handleTaskTitleKeyDown, taskTitleDrafts]);

  const addTaskControl = (
    <div className="flex items-center gap-2 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-3 py-1.5 focus-within:ring-1 focus-within:ring-accent/50">
      <Plus size={14} className="text-fg-4 flex-shrink-0" />
      <input
        value={newTaskTitle}
        onChange={(e) => setNewTaskTitle(e.target.value)}
        onKeyDown={handleAddTaskKeyDown}
        placeholder="Add task..."
        className="flex-1 min-w-0 bg-transparent text-[13px] text-fg placeholder:text-fg-5 focus:outline-none"
      />
      <button
        onClick={() => void handleAddTask()}
        disabled={!newTaskTitle.trim()}
        className="h-7 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-40"
      >
        Add
      </button>
    </div>
  );

  const renderEditableOpenTaskList = useCallback((emptyText: string) => (
    <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
      {openTasks.length === 0 ? (
        <p className="px-3 py-4 text-[13px] text-fg-4">
          {emptyText}
        </p>
      ) : (
        openTasks.map((task, index) => (
          <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0">
            <div className={`w-6 h-6 flex items-center justify-center text-[11px] font-mono flex-shrink-0 ${
              index === 0 ? 'bg-accent/10 text-accent-text shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]' : 'text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]'
            }`}>
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              {renderTaskTitleInput(task, 'text-[13px] text-fg-2')}
            </div>
            <button
              onClick={() => handleMarkDone(task.id)}
              className="p-1 text-diff-add shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)] hover:bg-diff-add/10"
              title="Mark done"
            >
              <Check size={13} />
            </button>
            <button
              onClick={() => handleDeleteTask(task.id)}
              className="p-1 text-diff-del shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] hover:bg-diff-del/10"
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
        <div className="w-full max-w-xl p-8 text-center bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
          <CalendarDays size={40} className="text-accent mx-auto" strokeWidth={1.75} />
          <h2 className="mt-5 text-[22px] font-semibold tracking-tight text-fg">{title}</h2>
          <p className="mt-3 text-[14px] text-fg-3">{description}</p>
          <div className="my-7 p-5 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-4xl font-mono font-semibold text-fg">15:00</div>
            <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
              Protected planning time
            </div>
          </div>
          <button
            type="button"
            onClick={startSession}
            className="w-full h-9 px-6 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white"
          >
            Start Planning
          </button>
          <p className="mt-3 text-[12px] text-fg-4">
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
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
        <div className="px-6 py-5 border-b border-line">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] flex items-center justify-center flex-shrink-0">
              <CalendarDays size={22} className="text-accent-text" strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[18px] font-semibold tracking-tight text-fg">
                {title}
              </h2>
              <p className="text-[13px] text-fg-3 mt-1">
                {description}
              </p>
            </div>
            {lockMode && sessionDurationMinutes > 0 && (
              <div className={`px-4 py-2 font-mono text-lg font-semibold ${timerComplete ? 'text-diff-add shadow-[inset_0_0_0_1px_rgba(63,185,80,0.45)]' : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]'}`} title="Optional planning guide">
                {timerComplete ? '00:00' : formattedRemaining}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 mt-5">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={`h-8 flex items-center justify-center gap-2 text-[12px] ${
                  index === stepIndex
                    ? 'bg-claude-surface-hover text-fg shadow-[inset_0_0_0_1px_rgba(76,154,255,0.5)]'
                    : index < stepIndex
                      ? 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]'
                      : 'text-fg-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]'
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
                    <ClipboardList size={16} className="text-fg-4" />
                    <h3 className="text-[13px] font-semibold tracking-tight text-fg">Capture</h3>
                  </div>
                  <textarea
                    value={brainDump}
                    onChange={(e) => setBrainDump(e.target.value)}
                    placeholder={"Paste loose loops, one per line"}
                    className="mt-2 w-full h-24 px-3 py-3 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[12px] text-fg-4">
                      {openTasks.length} open
                    </span>
                    <button
                      onClick={addBrainDumpTasks}
                      disabled={!brainDump.trim()}
                      className="h-8 px-3 text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover text-[13px] disabled:opacity-40"
                    >
                      <Plus size={13} className="inline mr-1" />
                      Add lines
                    </button>
                  </div>
                </section>

                <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <CheckSquare size={15} className="text-fg-4" />
                    <h3 className="text-[13px] font-semibold tracking-tight text-fg">Close</h3>
                  </div>
                  {completedTasks.length > 0 && (
                    <button
                      onClick={clearCompletedTasks}
                      className="h-7 px-2 text-[12px] text-diff-del shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] hover:bg-diff-del/10"
                    >
                      Clear completed
                    </button>
                  )}
                </div>
                <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] max-h-44 overflow-y-auto">
                  {completedTasks.length === 0 ? (
                    <p className="px-3 py-4 text-[13px] text-fg-4">
                      No completed tasks to clear.
                    </p>
                  ) : (
                    completedTasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0">
                        <CheckSquare size={13} className="text-diff-add flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          {renderTaskTitleInput(task, 'text-[13px] text-fg-5 line-through')}
                        </div>
                        <button
                          onClick={() => deleteTask(task.id)}
                          className="text-fg-4 hover:text-diff-del"
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
                  <AlertTriangle size={15} className="text-amber" />
                  <h3 className="text-[13px] font-semibold tracking-tight text-fg">Restack</h3>
                  <span className="text-[12px] text-fg-4">
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
                  className={`mb-3 border border-dashed p-3 transition-colors ${
                    calendarDropActive
                      ? 'border-accent bg-accent/10'
                      : 'border-line-strong bg-ink-1'
                  }`}
                  data-planning-calendar-drop-zone
                >
                  <div className="flex items-center gap-2">
                    <CalendarDays size={15} className="text-accent" />
                    <div className="flex-1">
                      <div className="text-[13px] font-semibold tracking-tight text-fg">Calendar plan</div>
                      <div className="mt-0.5 text-[12px] text-fg-4">
                        {calendarTaskToPlaceId
                          ? 'Choose an hour below.'
                          : 'Drag a task to an hour, or press Schedule and choose a time.'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 max-h-48 overflow-y-auto bg-ink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]" data-planning-calendar-timeline>
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
                          className={`grid min-h-10 grid-cols-[54px_1fr] border-b border-line last:border-b-0 ${calendarTaskToPlaceId ? 'cursor-pointer hover:bg-accent/10' : ''}`}
                        >
                          <div className="border-r border-line px-2 py-2 text-right text-[10.5px] font-mono text-fg-4">
                            {labelHour}
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-claude-surface-hover">
                            {eventsAtHour.length === 0 ? (
                              <span className="text-[11px] text-fg-5">Drop task</span>
                            ) : eventsAtHour.map((event) => (
                              <div key={event.taskId} className="flex min-w-0 items-center gap-1 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] px-2 py-1 text-[11.5px] text-fg-2">
                                <span className="font-mono text-accent-text">{event.time}</span>
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
                        <div key={event.taskId} className="grid grid-cols-[minmax(140px,1fr)_122px_90px_70px_28px] items-center gap-2 p-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                          <div className="truncate text-[13px] text-fg-2" title={event.title}>{event.title}</div>
                          <input
                            type="date"
                            value={event.date}
                            onChange={(e) => updateCalendarEvent(event.taskId, { date: e.target.value })}
                            className="min-w-0 border-0 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-1.5 py-1 text-[12px] font-mono text-fg focus:outline-none focus:ring-1 focus:ring-accent/50"
                            aria-label={`Date for ${event.title}`}
                          />
                          <input
                            type="time"
                            value={event.time}
                            onChange={(e) => updateCalendarEvent(event.taskId, { time: e.target.value })}
                            className="min-w-0 border-0 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-1.5 py-1 text-[12px] font-mono text-fg focus:outline-none focus:ring-1 focus:ring-accent/50"
                            aria-label={`Time for ${event.title}`}
                          />
                          <select
                            value={event.durationMinutes}
                            onChange={(e) => updateCalendarEvent(event.taskId, { durationMinutes: Number(e.target.value) })}
                            className="min-w-0 border-0 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-1 py-1 text-[12px] font-mono text-fg focus:outline-none focus:ring-1 focus:ring-accent/50"
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
                            className="flex h-7 w-7 items-center justify-center text-diff-del shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] hover:bg-diff-del/10"
                            title="Remove from calendar plan"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] max-h-[52vh] overflow-y-auto">
                  {openTasks.length === 0 ? (
                    <p className="px-3 py-4 text-[13px] text-fg-4">
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
                          className={`group flex flex-wrap items-start gap-3 px-3 py-3 border-b border-line last:border-b-0 transition-colors ${
                            index < 3 ? 'bg-accent/[0.04]' : ''
                          } ${
                            dragOverTaskId === task.id && draggedTaskId !== task.id ? 'outline outline-1 outline-accent/70 bg-accent/10' : ''
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
                            className="mt-1 cursor-grab text-fg-5 group-hover:text-fg-2 flex-shrink-0"
                            title="Drag to reorder"
                          >
                            <GripVertical size={14} />
                          </div>
                          <div className={`w-7 h-7 flex items-center justify-center text-[11px] font-mono flex-shrink-0 ${
                            index === 0 ? 'bg-accent/10 text-accent-text shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]' : 'text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]'
                          }`}>
                            {index + 1}
                          </div>
                          <div className="flex-1 min-w-[220px]">
                            {renderTaskTitleInput(task, 'text-[13px] text-fg-2')}
                            <div className={`text-[11.5px] mt-1 ${isStale ? 'text-amber' : 'text-fg-4'}`}>
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
                              className={`h-7 px-2 text-[12px] ${
                                calendarEvents.some((event) => event.taskId === task.id)
                                  ? 'bg-accent/10 text-accent-text shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]'
                                  : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover hover:text-fg'
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
                              className="p-1 text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover hover:text-fg disabled:opacity-25"
                              title="Move up"
                            >
                              <ArrowUp size={13} />
                            </button>
                            <button
                              onClick={() => moveTask(task.id, 1)}
                              disabled={index === openTasks.length - 1}
                              className="p-1 text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover hover:text-fg disabled:opacity-25"
                              title="Move down"
                            >
                              <ArrowDown size={13} />
                            </button>
                            <button
                              onClick={() => handleMarkDone(task.id)}
                              className="h-7 px-2 text-[12px] text-diff-add shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)] hover:bg-diff-add/10"
                            >
                              Done
                            </button>
                            <button
                              onClick={() => handleDeleteTask(task.id)}
                              className="h-7 px-2 text-[12px] text-diff-del shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] hover:bg-diff-del/10"
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
              <div className="bg-accent/[0.06] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-accent-text mb-2">First task</div>
                {topTask ? (
                  renderTaskTitleInput(topTask, 'text-[16px] font-medium text-fg')
                ) : (
                  <div className="text-[16px] text-fg-4">No task selected</div>
                )}
              </div>
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Target size={15} className="text-fg-4" />
                  <h3 className="text-[13px] font-semibold tracking-tight text-fg">Priority stack</h3>
                </div>
                {renderEditableOpenTaskList('No open tasks selected.')}
              </section>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                  What would make today successful? <span className="text-fg-5 normal-case tracking-normal">(optional)</span>
                </label>
                <input
                  value={successNote}
                  onChange={(e) => setSuccessNote(e.target.value)}
                  className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  placeholder="One concrete outcome"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                  What should not steal the morning?
                </label>
                <input
                  value={avoidNote}
                  onChange={(e) => setAvoidNote(e.target.value)}
                  className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  placeholder="Optional distraction or trap"
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center gap-3">
          <button
            onClick={goBack}
            disabled={stepIndex === 0}
            className="h-8 px-4 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover disabled:opacity-25"
          >
            Back
          </button>
          <div className="flex-1 text-[12px] text-fg-4">
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
                className="h-8 px-4 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-40"
              >
                Set Intention
              </button>
              {!lockMode && (
                <button
                  onClick={() => void handleAcceptCurrentStack()}
                  disabled={!canContinue}
                  className="h-8 px-5 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white disabled:opacity-40"
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
              className="h-8 px-5 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white disabled:opacity-40"
            >
              {lockMode ? 'Finish Planning' : 'Start My Day'}
            </button>
          )}
        </div>
        {lockMode && (
          <div className="px-6 pb-3 text-right text-[10.5px] font-mono text-fg-5">
            Keyboard: {navigator.platform.toLowerCase().includes('mac') ? 'Command' : 'Ctrl'} + Enter
          </div>
        )}
      </div>
    </div>
  );
}
