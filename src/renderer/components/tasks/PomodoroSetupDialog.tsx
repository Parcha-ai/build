import React, { useEffect, useState } from 'react';
import { Clock3, X } from 'lucide-react';
import type { FocusTask } from '../../../shared/types';
import { DEFAULT_POMODORO_MINUTES } from '../../../shared/utils/pomodoro';
import { useTaskStore } from '../../stores/task.store';
import { SessionPickerList, type TaskSessionSelection } from './TaskSessionPicker';

interface PomodoroSetupDialogProps {
  task: FocusTask;
  onClose: () => void;
}

export default function PomodoroSetupDialog({ task, onClose }: PomodoroSetupDialogProps) {
  const startPomodoro = useTaskStore((state) => state.startPomodoro);
  const [selection, setSelection] = useState<TaskSessionSelection>({
    sessionId: task.pomodoroExternal ? undefined : task.sessionId,
    external: Boolean(task.pomodoroExternal),
  });
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_POMODORO_MINUTES);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !starting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, starting]);

  const canStart = subtaskTitle.trim().length > 0 && (selection.external || Boolean(selection.sessionId));

  const handleStart = async () => {
    if (!canStart || starting) return;
    setStarting(true);
    setError(null);
    try {
      await startPomodoro(task.id, {
        ...selection,
        subtaskTitle: subtaskTitle.trim(),
        durationMinutes,
      });
      onClose();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the Pomodoro');
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="pomodoro-setup-title">
      <div className="w-full max-w-xl bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="mt-0.5 bg-ink-4 p-2 text-fg-2">
            <Clock3 size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="pomodoro-setup-title" className="text-[16px] font-semibold tracking-tight text-fg">Plan one focus slot</h2>
            <p className="mt-0.5 truncate text-[13px] text-fg-3">{task.title}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-fg-3 hover:bg-claude-surface-hover hover:text-fg" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
              What single outcome will you finish in this slot?
            </span>
            <input
              value={subtaskTitle}
              onChange={(event) => setSubtaskTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canStart) void handleStart();
              }}
              placeholder="e.g. Implement and test the empty state"
              className="w-full border-0 bg-ink-3 px-3 py-2.5 text-[13px] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              autoFocus
            />
          </label>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
                Where will you work?
              </span>
              <label className="flex items-center gap-1.5 text-[12px] text-fg-3">
                <span>Minutes</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(Math.min(120, Math.max(1, Number(event.target.value) || 1)))}
                  className="w-14 border-0 bg-ink-3 px-1.5 py-1 text-center font-mono text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] focus:outline-none focus:ring-1 focus:ring-accent/50"
                />
              </label>
            </div>
            <SessionPickerList
              selectedSessionId={selection.sessionId}
              external={selection.external}
              onSelect={setSelection}
            />
          </div>

          {error && <p className="text-[12px] text-diff-del">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="max-w-sm text-[11.5px] leading-relaxed text-fg-4">
            Choosing a Build session switches to it. Outside Build keeps the timer available in the system menu bar.
          </p>
          <button
            type="button"
            disabled={!canStart || starting}
            onClick={() => void handleStart()}
            className="shrink-0 h-8 bg-fg px-4 text-[13px] font-semibold text-ink-0 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            {starting ? 'Starting…' : `Start ${durationMinutes} min`}
          </button>
        </div>
      </div>
    </div>
  );
}
