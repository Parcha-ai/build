import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, Loader2, X } from 'lucide-react';
import type { CompactionSwitchState, ModelInfo } from '../../stores/session.store';

interface CompactionSwitchNoticeProps {
  notice: CompactionSwitchState;
  availableModels: ModelInfo[];
  onDismiss: () => void;
  onSwitchBack: () => void;
}

function formatElapsed(startedAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function getModelLabel(modelId: string | undefined, availableModels: ModelInfo[]): string {
  if (!modelId) return 'another model';

  const fromList = availableModels.find((model) => model.id === modelId);
  if (fromList) {
    return fromList.name;
  }

  if (modelId.startsWith('codex:')) {
    return modelId.replace('codex:', '').toUpperCase();
  }

  return modelId
    .replace(/^claude-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export default function CompactionSwitchNotice({
  notice,
  availableModels,
  onDismiss,
  onSwitchBack,
}: CompactionSwitchNoticeProps) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(notice.startedAt));

  useEffect(() => {
    if (notice.status !== 'compacting') {
      setElapsed(formatElapsed(notice.startedAt));
      return;
    }

    setElapsed(formatElapsed(notice.startedAt));
    const interval = setInterval(() => {
      setElapsed(formatElapsed(notice.startedAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [notice.startedAt, notice.status]);

  const originalLabel = getModelLabel(notice.originalModel, availableModels);
  const fallbackLabel = getModelLabel(notice.fallbackModel, availableModels);
  const tokensSaved = notice.preTokens && notice.postTokens
    ? notice.preTokens - notice.postTokens
    : undefined;
  const isCompacting = notice.status === 'compacting';

  return (
    <div className={`mb-2 border px-3 py-2 font-mono text-xs ${
      isCompacting
        ? 'border-blue-500/40 bg-blue-500/10 text-blue-100'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
    }`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex-shrink-0">
          {isCompacting ? (
            <Loader2 size={14} className="animate-spin text-blue-300" />
          ) : (
            <CheckCircle2 size={14} className="text-emerald-300" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide">
              {isCompacting ? 'Compacting' : 'Compaction Done'}
            </span>
            {isCompacting && (
              <span className="text-[10px] text-blue-200/80">{elapsed}</span>
            )}
            {!isCompacting && tokensSaved !== undefined && (
              <span className="text-[10px] text-emerald-200/80">
                Saved {tokensSaved.toLocaleString()} tokens
              </span>
            )}
          </div>

          <div className="mt-1 leading-relaxed text-claude-text">
            {isCompacting ? (
              notice.autoSwitched && notice.fallbackModel ? (
                <>
                  {originalLabel} is compacting. Next turn is auto-switched to {fallbackLabel} so you can keep moving.
                </>
              ) : (
                <>
                  {originalLabel} is compacting. No alternate backend was available for an automatic handoff.
                </>
              )
            ) : (
              notice.autoSwitched && notice.fallbackModel ? (
                <>
                  {originalLabel} finished compacting. Keep {fallbackLabel} for the next turn, or switch back now.
                </>
              ) : (
                <>
                  {originalLabel} finished compacting.
                </>
              )
            )}
          </div>

          {notice.autoSwitched && notice.fallbackModel && (
            <div className="mt-2 flex items-center gap-2">
              {!isCompacting && (
                <button
                  onClick={onSwitchBack}
                  className="inline-flex items-center gap-1 border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-400/20"
                >
                  <ArrowLeftRight size={11} />
                  Switch Back
                </button>
              )}
              <button
                onClick={onDismiss}
                className="border border-white/15 px-2 py-1 text-[11px] text-claude-text-secondary transition-colors hover:bg-white/5 hover:text-claude-text"
              >
                {isCompacting ? 'Hide' : `Keep ${fallbackLabel}`}
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 text-claude-text-secondary transition-colors hover:bg-white/5 hover:text-claude-text"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
