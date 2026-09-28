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
    <div className={`mb-2 bg-ink-1 px-3 py-2.5 text-[12.5px] text-fg-2 ${
      isCompacting
        ? 'shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]'
        : 'shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)]'
    }`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex-shrink-0">
          {isCompacting ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : (
            <CheckCircle2 size={13} className="text-diff-add" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-fg">
              {isCompacting ? 'Compacting' : 'Compaction Done'}
            </span>
            {isCompacting && (
              <span className="font-mono text-[11px] text-fg-5">{elapsed}</span>
            )}
            {!isCompacting && tokensSaved !== undefined && (
              <span className="font-mono text-[11px] text-diff-add">
                Saved {tokensSaved.toLocaleString()} tokens
              </span>
            )}
          </div>

          <div className="mt-1 leading-relaxed text-fg-3">
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
                  className="inline-flex h-[26px] items-center gap-1.5 bg-[#EDEDED] px-2.5 text-[12px] font-semibold text-[#0F0F0F] transition-colors hover:bg-white"
                >
                  <ArrowLeftRight size={11} />
                  Use {recommendedLabel}
                </button>
              )}
              {canChooseFallback && (
                <button
                  onClick={() => onHandoff(notice.fallbackModel!)}
                  className="inline-flex h-[26px] items-center gap-1.5 px-2.5 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-white/[0.04] hover:text-fg"
                >
                  <ArrowLeftRight size={11} />
                  Use {fallbackLabel}
                </button>
              )}
              {notice.handoffSelected && (
                <button
                  onClick={onSwitchBack}
                  className="inline-flex h-[26px] items-center gap-1.5 px-2.5 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-white/[0.04] hover:text-fg"
                >
                  <ArrowLeftRight size={11} />
                  Keep {originalLabel}
                </button>
              )}
              <button
                onClick={onDismiss}
                className="h-[26px] px-2.5 text-[12px] text-fg-3 transition-colors hover:bg-white/[0.04] hover:text-fg"
              >
                Hide
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 text-fg-4 transition-colors hover:bg-white/[0.05] hover:text-fg"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
