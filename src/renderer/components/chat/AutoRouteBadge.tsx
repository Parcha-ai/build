import React from 'react';

interface AutoRouteBadgeProps {
  tier: string;
  domain?: string;
  resolvedModel: string;
  confidence: number;
  orchestration?: {
    mode: string;
    leadHarness: string;
    leadModel: string;
    stages: Array<{ tier: string; harness: string; model: string; purpose: string; fallbackModels?: string[] }>;
  };
  compact?: boolean;
}

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  plan:   { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30' },
  build:  { bg: 'bg-blue-500/15',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  verify: { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30' },
  refine: { bg: 'bg-green-500/15',  text: 'text-green-400',  border: 'border-green-500/30' },
};

function getModelShortName(model: string): string {
  if (model.startsWith('codex:')) return model.split(':')[1];
  if (model.startsWith('cursor:')) return model.split(':')[1];
  if (model.startsWith('gemini:')) return model.split(':')[1];
  if (model.includes('opus-4-7')) return 'Opus 4.7';
  if (model.includes('opus-4-6')) return 'Opus 4.6';
  if (model.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (model.includes('sonnet-4-5')) return 'Sonnet 4.5';
  if (model.includes('haiku')) return 'Haiku 4.5';
  return model;
}

function getHarnessShortName(harness: string): string {
  switch (harness) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
    case 'custom': return 'Custom';
    default: return harness;
  }
}

export const AutoRouteBadge: React.FC<AutoRouteBadgeProps> = ({ tier, domain, resolvedModel, confidence, orchestration, compact }) => {
  const colors = TIER_COLORS[tier] || TIER_COLORS.build;
  const modelName = getModelShortName(resolvedModel);
  const delegateStages = orchestration?.stages.filter((stage) => stage.model !== orchestration.leadModel) || [];
  const stageTitle = orchestration?.stages
    .map((stage, index) => {
      const fallbackSummary = stage.fallbackModels?.length
        ? ` (fallbacks: ${stage.fallbackModels.map(getModelShortName).join(', ')})`
        : '';
      return `${index + 1}. ${stage.tier.toUpperCase()} via ${getHarnessShortName(stage.harness)}:${getModelShortName(stage.model)}${fallbackSummary} - ${stage.purpose}`;
    })
    .join('\n');
  const title = [
    `Auto Build: ${tier.toUpperCase()} tier${domain ? ` / ${domain}` : ''} -> ${resolvedModel} (${Math.round(confidence * 100)}% confidence)`,
    orchestration ? `Mode: ${orchestration.mode}` : '',
    stageTitle ? `Stages:\n${stageTitle}` : '',
  ].filter(Boolean).join('\n');

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${colors.bg} ${colors.text} border ${colors.border} rounded`}
        title={title}
      >
        {domain ? `${tier}:${domain}` : tier}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono ${colors.bg} ${colors.text} border ${colors.border} rounded`}
      title={title}
    >
      <span className="uppercase font-bold tracking-wider">{tier}</span>
      {domain && <span className="opacity-70 uppercase">{domain}</span>}
      <span className="opacity-50">→</span>
      <span>{modelName}</span>
      {delegateStages.length > 0 && (
        <span className="opacity-70">+{delegateStages.length}</span>
      )}
    </span>
  );
};
