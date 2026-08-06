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
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="pomodoro-setup-title">
      <div className="w-full max-w-xl rounded-lg border border-claude-border bg-claude-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-claude-border px-4 py-3">
          <div className="mt-0.5 rounded-md bg-emerald-400/10 p-2 text-emerald-300">
            <Clock3 size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="pomodoro-setup-title" className="text-sm font-semibold text-claude-text">Plan one focus slot</h2>
            <p className="mt-0.5 truncate text-[11px] text-claude-text-secondary">{task.title}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-claude-text-secondary hover:text-claude-text" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-claude-text-secondary">
              What single outcome will you finish in this slot?
            </span>
            <input
              value={subtaskTitle}
              onChange={(event) => setSubtaskTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canStart) void handleStart();
              }}
              placeholder="e.g. Implement and test the empty state"
              className="w-full rounded border border-claude-border bg-claude-bg px-3 py-2.5 text-[12px] font-mono text-claude-text placeholder:text-claude-text-secondary/50 focus:border-emerald-400 focus:outline-none"
              autoFocus
            />
          </label>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-claude-text-secondary">
                Where will you work?
              </span>
              <label className="flex items-center gap-1.5 text-[10px] text-claude-text-secondary">
                <span>Minutes</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(Math.min(120, Math.max(1, Number(event.target.value) || 1)))}
                  className="w-14 rounded border border-claude-border bg-claude-bg px-1.5 py-1 text-center font-mono text-claude-text focus:border-emerald-400 focus:outline-none"
                />
              </label>
            </div>
            <SessionPickerList
              selectedSessionId={selection.sessionId}
              external={selection.external}
              onSelect={setSelection}
            />
          </div>

          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-claude-border px-4 py-3">
          <p className="max-w-sm text-[9px] leading-relaxed text-claude-text-secondary">
            Choosing a Build session switches to it. Outside Build keeps the timer available in the system menu bar.
          </p>
          <button
            type="button"
            disabled={!canStart || starting}
            onClick={() => void handleStart()}
            className="shrink-0 rounded bg-emerald-500 px-4 py-2 text-[11px] font-semibold text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {starting ? 'Starting…' : `Start ${durationMinutes} min`}
          </button>
        </div>
      </div>
    </div>
  );
}
