import React from 'react';

interface AutoRouteBadgeProps {
  tier: string;
  categoryId?: string;
  categoryLabel?: string;
  domain?: string;
  resolvedHarness?: string;
  modelLabel?: string;
  compact?: boolean;
  planningGateAction?: 'none' | 'suggest' | 'start';
}

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pr:     { bg: 'bg-violet-500/15', text: 'text-violet-400', border: 'border-violet-500/30' },
  spec:   { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-400', border: 'border-fuchsia-500/30' },
  plan:   { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30' },
  build:  { bg: 'bg-blue-500/15',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  verify: { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30' },
  refine: { bg: 'bg-green-500/15',  text: 'text-green-400',  border: 'border-green-500/30' },
};

export const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  custom: 'Custom',
};

export function inferHarnessFromModel(model?: string): string | undefined {
  if (!model || model === 'auto') return undefined;
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('custom:')) return 'custom';
  return 'claude';
}

export function formatModelId(model?: string): string | undefined {
  if (!model) return undefined;
  const raw = model.includes(':') ? model.split(':').slice(1).join(':') : model;
  return raw
    .replace(/^claude-/, '')
    .replace(/^gemini-/, '')
    .replace(/-codex$/, '')
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeModelLabel(label?: string): string | undefined {
  return label
    ?.replace(/ \((Claude|Cursor|Codex|Gemini|OpenCode|Custom)\)$/i, '')
    .replace(/ \[(Claude|Cursor|Codex|Gemini|OpenCode|Custom)\]$/i, '')
    .trim();
}

export function formatHarnessModelLabel(harness?: string, model?: string, modelLabel?: string): string | undefined {
  const resolvedHarness = harness || inferHarnessFromModel(model);
  const harnessLabel = resolvedHarness ? HARNESS_LABELS[resolvedHarness] || resolvedHarness : undefined;
  const displayModel = normalizeModelLabel(modelLabel) || formatModelId(model);
  return [harnessLabel, displayModel].filter(Boolean).join(' ') || undefined;
}

function formatRouteTitle(tier: string, domain?: string, harness?: string, modelLabel?: string): string {
  const scope = domain && domain !== 'general' ? `${tier}:${domain}` : tier;
  const agent = formatHarnessModelLabel(harness, undefined, modelLabel);
  return agent ? `Using ${agent}. Auto Build scope: ${scope}` : `Current turn scope: ${scope}`;
}

export const AutoRouteBadge: React.FC<AutoRouteBadgeProps> = ({ tier, categoryId, categoryLabel, domain, resolvedHarness, modelLabel, compact, planningGateAction }) => {
  const displayTier = planningGateAction === 'start' ? 'spec' : categoryId || tier;
  const colors = TIER_COLORS[displayTier] || TIER_COLORS.build;
  const agentLabel = formatHarnessModelLabel(resolvedHarness, undefined, modelLabel);
  const title = formatRouteTitle(categoryLabel || displayTier, domain, resolvedHarness, modelLabel);

  if (compact) {
    return (
      <span
        className={`inline-flex min-w-0 max-w-[180px] items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${colors.bg} ${colors.text} border ${colors.border} rounded`}
        title={title}
      >
        <span className="font-bold">{displayTier === 'spec' ? 'SPEC' : displayTier === 'pr' ? 'PR' : 'AUTO'}</span>
        {agentLabel && <span className="min-w-0 truncate opacity-70 normal-case tracking-normal">{agentLabel}</span>}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex min-w-0 max-w-[220px] items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono ${colors.bg} ${colors.text} border ${colors.border} rounded`}
      title={title}
    >
      <span className="uppercase font-bold tracking-wider">{displayTier === 'spec' ? 'SPEC' : displayTier === 'pr' ? 'PR' : 'AUTO'}</span>
      {agentLabel && <span className="min-w-0 truncate opacity-70">{agentLabel}</span>}
    </span>
  );
};
