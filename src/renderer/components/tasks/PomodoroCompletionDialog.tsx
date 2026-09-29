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
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="pomodoro-complete-title">
      <div className="w-full max-w-md bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
        <div className="p-5 text-center">
          <CheckCircle2 size={30} className="mx-auto text-diff-add" />
          <h2 id="pomodoro-complete-title" className="mt-3 text-[16px] font-semibold tracking-tight text-fg">Focus slot complete</h2>
          <p className="mt-1 text-[13px] text-fg-3">Did you finish this outcome?</p>
          <p className="mx-auto mt-3 max-w-sm bg-ink-1 px-3 py-2 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            {pomodoroState.subtaskTitle}
          </p>
        </div>

        <div className="grid gap-2 border-t border-line p-3">
          <button
            type="button"
            disabled={working}
            onClick={() => void finishSlot(false)}
            className="h-8 bg-fg px-3 text-[13px] font-semibold text-ink-0 hover:bg-white disabled:opacity-40"
          >
            Done — plan the next slot
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void finishSlot(true)}
            className="h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-40"
          >
            Task complete — move to the next task
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void restartPomodoro()}
            className="flex items-center justify-center gap-1.5 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-40"
          >
            <RotateCcw size={11} />
            Not yet — repeat this slot
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void stopPomodoro()}
            className="flex items-center justify-center gap-1.5 px-3 py-1 text-[12px] text-fg-4 hover:text-diff-del disabled:opacity-40"
          >
            <Square size={9} />
            Stop focusing
          </button>
        </div>
      </div>
    </div>
  );
}
