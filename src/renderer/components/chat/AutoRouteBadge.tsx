import React from 'react';

interface AutoRouteBadgeProps {
  tier: string;
  domain?: string;
  resolvedHarness?: string;
  resolvedModel?: string;
  resolvedModelLabel?: string;
  compact?: boolean;
}

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  plan:   { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30' },
  build:  { bg: 'bg-blue-500/15',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  verify: { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30' },
  refine: { bg: 'bg-green-500/15',  text: 'text-green-400',  border: 'border-green-500/30' },
};

const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  custom: 'Custom',
};

function formatModelId(model?: string): string | undefined {
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

function formatRouteTitle(tier: string, domain?: string, harness?: string, model?: string, modelLabel?: string): string {
  const scope = domain && domain !== 'general' ? `${tier}:${domain}` : tier;
  const agent = [
    harness ? HARNESS_LABELS[harness] || harness : undefined,
    modelLabel || formatModelId(model),
  ].filter(Boolean).join(' ');
  return agent ? `Auto Build routed to ${agent} for ${scope}` : `Current turn scope: ${scope}`;
}

export const AutoRouteBadge: React.FC<AutoRouteBadgeProps> = ({ tier, domain, resolvedHarness, resolvedModel, resolvedModelLabel, compact }) => {
  const colors = TIER_COLORS[tier] || TIER_COLORS.build;
  const harnessLabel = resolvedHarness ? HARNESS_LABELS[resolvedHarness] || resolvedHarness : undefined;
  const modelLabel = resolvedModelLabel || formatModelId(resolvedModel);
  const agentLabel = [harnessLabel, modelLabel].filter(Boolean).join(' ');
  const scopeLabel = domain && domain !== 'general' ? `${tier}:${domain}` : tier;
  const title = formatRouteTitle(tier, domain, resolvedHarness, resolvedModel, resolvedModelLabel);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${colors.bg} ${colors.text} border ${colors.border} rounded`}
        title={title}
      >
        {agentLabel || scopeLabel}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono ${colors.bg} ${colors.text} border ${colors.border} rounded`}
      title={title}
    >
      <span className="uppercase font-bold tracking-wider">{agentLabel || tier}</span>
      <span className="opacity-70 uppercase">{scopeLabel}</span>
    </span>
  );
};
