import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, Loader2, X } from 'lucide-react';
import type { CompactionSwitchState, ModelInfo } from '../../stores/session.store';

interface CompactionSwitchNoticeProps {
  notice: CompactionSwitchState;
  availableModels: ModelInfo[];
  onDismiss: () => void;
  onHandoff: (model: string) => void;
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
  onHandoff,
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
  const recommendedModel = notice.recommendedModel || notice.fallbackModel;
  const recommendedLabel = getModelLabel(recommendedModel, availableModels);
  const selectedLabel = getModelLabel(notice.handoffModel || recommendedModel, availableModels);
  const tokensSaved = notice.preTokens && notice.postTokens
    ? notice.preTokens - notice.postTokens
    : undefined;
  const isCompacting = notice.status === 'compacting';
  const canChooseRecommended = !!recommendedModel && !notice.handoffSelected;
  const canChooseFallback = !!notice.fallbackModel && notice.fallbackModel !== recommendedModel && !notice.handoffSelected;

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
              notice.handoffSelected ? (
                <>
                  {originalLabel} is compacting. Next turn will hand off to {selectedLabel}.
                </>
              ) : recommendedModel ? (
                <>
                  {originalLabel} is compacting. You can hand the next turn to {recommendedLabel}, or keep the current harness.
                </>
              ) : (
                <>
                  {originalLabel} is compacting. No alternate harness is available for handoff.
                </>
              )
            ) : (
              notice.handoffSelected ? (
                <>
                  {originalLabel} finished compacting. Next turn is set to {selectedLabel}.
                </>
              ) : recommendedModel ? (
                <>
                  {originalLabel} finished compacting. You can hand the next turn to {recommendedLabel}, or keep the current harness.
                </>
              ) : (
                <>
                  {originalLabel} finished compacting.
                </>
              )
            )}
          </div>

          {(recommendedModel || notice.handoffSelected) && (
            <div className="mt-2 flex items-center gap-2">
              {canChooseRecommended && (
                <button
                  onClick={() => onHandoff(recommendedModel!)}
                  className="inline-flex items-center gap-1 border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-400/20"
                >
                  <ArrowLeftRight size={11} />
                  Use {recommendedLabel}
                </button>
              )}
              {canChooseFallback && (
                <button
                  onClick={() => onHandoff(notice.fallbackModel!)}
                  className="inline-flex items-center gap-1 border border-blue-400/40 bg-blue-400/10 px-2 py-1 text-[11px] text-blue-100 transition-colors hover:bg-blue-400/20"
                >
                  <ArrowLeftRight size={11} />
                  Use {fallbackLabel}
                </button>
              )}
              {notice.handoffSelected && (
                <button
                  onClick={onSwitchBack}
                  className="inline-flex items-center gap-1 border border-white/15 px-2 py-1 text-[11px] text-claude-text-secondary transition-colors hover:bg-white/5 hover:text-claude-text"
                >
                  <ArrowLeftRight size={11} />
                  Keep {originalLabel}
                </button>
              )}
              <button
                onClick={onDismiss}
                className="border border-white/15 px-2 py-1 text-[11px] text-claude-text-secondary transition-colors hover:bg-white/5 hover:text-claude-text"
              >
                Hide
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
