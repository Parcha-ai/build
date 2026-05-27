import React from 'react';

interface AutoRouteBadgeProps {
  tier: string;
  domain?: string;
  compact?: boolean;
}

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  plan:   { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30' },
  build:  { bg: 'bg-blue-500/15',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  verify: { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30' },
  refine: { bg: 'bg-green-500/15',  text: 'text-green-400',  border: 'border-green-500/30' },
};

function formatScope(tier: string, domain?: string): string {
  return domain ? `${tier}:${domain}` : tier;
}

export const AutoRouteBadge: React.FC<AutoRouteBadgeProps> = ({ tier, domain, compact }) => {
  const colors = TIER_COLORS[tier] || TIER_COLORS.build;
  const scope = formatScope(tier, domain);
  const title = `Current turn scope: ${scope}`;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${colors.bg} ${colors.text} border ${colors.border} rounded`}
        title={title}
      >
        {scope}
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
    </span>
  );
};
