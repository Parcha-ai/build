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
  // Graphite tags: transparent with an inset hairline; tint only the text/line.
  pr:     { bg: 'bg-[rgba(76,154,255,0.08)]', text: 'text-accent-text', border: 'shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]' },
  spec:   { bg: 'bg-[rgba(76,154,255,0.08)]', text: 'text-accent-text', border: 'shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]' },
  plan:   { bg: 'bg-transparent', text: 'text-accent-text', border: 'shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]' },
  build:  { bg: 'bg-transparent', text: 'text-fg-3', border: 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]' },
  verify: { bg: 'bg-transparent', text: 'text-amber', border: 'shadow-[inset_0_0_0_1px_rgba(240,180,41,0.35)]' },
  refine: { bg: 'bg-transparent', text: 'text-diff-add', border: 'shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)]' },
};

export const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  prime: 'Prime Agent',
  custom: 'Custom',
};

export function inferHarnessFromModel(model?: string): string | undefined {
  if (!model || model === 'auto') return undefined;
  if (model.startsWith('codex:')) return 'codex';
  if (model.startsWith('cursor:')) return 'cursor';
  if (model.startsWith('gemini:')) return 'gemini';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('prime:')) return 'prime';
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
    ?.replace(/ \((Claude|Cursor|Codex|Gemini|OpenCode|Prime Agent|Custom)\)$/i, '')
    .replace(/ \[(Claude|Cursor|Codex|Gemini|OpenCode|Prime Agent|Custom)\]$/i, '')
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
        className={`inline-flex min-w-0 max-w-[180px] items-center gap-1 px-[5px] py-px text-[9.5px] font-mono uppercase tracking-[0.04em] ${colors.bg} ${colors.text} ${colors.border}`}
        title={title}
      >
        <span className="font-medium">{displayTier === 'spec' ? 'SPEC' : displayTier === 'pr' ? 'PR' : 'AUTO'}</span>
        {agentLabel && <span className="min-w-0 truncate opacity-70 normal-case tracking-normal">{agentLabel}</span>}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex min-w-0 max-w-[220px] items-center gap-1.5 px-1.5 py-px text-[10px] font-mono ${colors.bg} ${colors.text} ${colors.border}`}
      title={title}
    >
      <span className="uppercase font-medium tracking-[0.04em]">{displayTier === 'spec' ? 'SPEC' : displayTier === 'pr' ? 'PR' : 'AUTO'}</span>
      {agentLabel && <span className="min-w-0 truncate opacity-70">{agentLabel}</span>}
    </span>
  );
};
