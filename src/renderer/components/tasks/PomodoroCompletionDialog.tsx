import React, { useState } from 'react';
import { CheckCircle2, RotateCcw, Square } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';

interface PomodoroCompletionDialogProps {
  onPlanNextSlot: (taskId: string) => void;
  onFinishTask: (taskId: string) => void;
}

export default function PomodoroCompletionDialog({ onPlanNextSlot, onFinishTask }: PomodoroCompletionDialogProps) {
  const pomodoroState = useTaskStore((state) => state.pomodoroState);
  const finishPomodoroSubtask = useTaskStore((state) => state.finishPomodoroSubtask);
  const restartPomodoro = useTaskStore((state) => state.restartPomodoro);
  const stopPomodoro = useTaskStore((state) => state.stopPomodoro);
  const [working, setWorking] = useState(false);

  if (pomodoroState.status !== 'completed' || !pomodoroState.taskId) return null;

  const finishSlot = async (finishWholeTask: boolean) => {
    setWorking(true);
    const taskId = await finishPomodoroSubtask();
    if (taskId) {
      if (finishWholeTask) onFinishTask(taskId);
      else onPlanNextSlot(taskId);
    }
    setWorking(false);
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="pomodoro-complete-title">
      <div className="w-full max-w-md rounded-lg border border-emerald-400/30 bg-claude-surface shadow-2xl">
        <div className="p-5 text-center">
          <CheckCircle2 size={30} className="mx-auto text-emerald-400" />
          <h2 id="pomodoro-complete-title" className="mt-3 text-base font-semibold text-claude-text">Focus slot complete</h2>
          <p className="mt-1 text-[11px] text-claude-text-secondary">Did you finish this outcome?</p>
          <p className="mx-auto mt-3 max-w-sm rounded bg-claude-bg px-3 py-2 text-[12px] font-mono text-claude-text">
            {pomodoroState.subtaskTitle}
          </p>
        </div>

        <div className="grid gap-2 border-t border-claude-border p-3">
          <button
            type="button"
            disabled={working}
            onClick={() => void finishSlot(false)}
            className="rounded bg-emerald-500 px-3 py-2 text-[11px] font-semibold text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            Done — plan the next slot
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void finishSlot(true)}
            className="rounded border border-claude-border px-3 py-2 text-[11px] text-claude-text hover:bg-claude-bg disabled:opacity-40"
          >
            Task complete — move to the next task
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void restartPomodoro()}
            className="flex items-center justify-center gap-1.5 rounded border border-claude-border px-3 py-2 text-[11px] text-claude-text hover:bg-claude-bg disabled:opacity-40"
          >
            <RotateCcw size={11} />
            Not yet — repeat this slot
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void stopPomodoro()}
            className="flex items-center justify-center gap-1.5 px-3 py-1 text-[10px] text-claude-text-secondary hover:text-red-400 disabled:opacity-40"
          >
            <Square size={9} />
            Stop focusing
          </button>
        </div>
      </div>
    </div>
  );
}
