import React, { useEffect, useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/session.store';

interface SessionCost {
  totalCost: number;
  totalTokens: number;
  turnCount: number;
  extraUsageCost: number;
  isOverIncludedUsage: boolean;
  percentOfIncluded: number;
  baselineCost: number;
  savingsVsBaseline: number;
  baselineModel: string;
  byHarness: Array<{
    harness: string;
    cost: number;
    baselineCost: number;
    savings: number;
    tokenCount: number;
    turnCount: number;
  }>;
}

interface TierConfig {
  monthlyIncludedUsd: number;
  planName: string;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '<$0.01';
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatHarness(harness: string): string {
  return harness.charAt(0).toUpperCase() + harness.slice(1);
}

export default function CostBadge() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [sessionCost, setSessionCost] = useState<SessionCost | null>(null);
  const [tierConfig, setTierConfig] = useState<TierConfig | null>(null);
  const [monthCost, setMonthCost] = useState(0);
  const [showTooltip, setShowTooltip] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const [cost, tier, summary] = await Promise.all([
        window.electronAPI.analytics.getSessionCost(activeSessionId),
        window.electronAPI.analytics.getTierConfig(),
        window.electronAPI.analytics.getSummary(),
      ]);
      setSessionCost(cost);
      setTierConfig(tier);
      setMonthCost(summary.monthTotalCost);
    } catch (e) {
      // Analytics not available yet
    }
  }, [activeSessionId]);

  useEffect(() => {
    refresh();
    const unsub = window.electronAPI.analytics.onTokenEvent(() => refresh());
    return () => { unsub(); };
  }, [refresh]);

  if (!sessionCost || sessionCost.turnCount === 0) return null;

  const tierUsedPercent = tierConfig ? (monthCost / tierConfig.monthlyIncludedUsd) * 100 : 0;
  const isNearLimit = tierUsedPercent >= 80 && tierUsedPercent < 100;
  const isOverLimit = tierUsedPercent >= 100;
  const remainingIncluded = tierConfig ? Math.max(0, tierConfig.monthlyIncludedUsd - monthCost) : 0;
  const extraUsage = tierConfig ? Math.max(0, monthCost - tierConfig.monthlyIncludedUsd) : 0;

  const costColor = isOverLimit
    ? 'text-red-400'
    : isNearLimit
    ? 'text-amber-400'
    : 'text-claude-text-secondary';

  return (
    <div
      className="relative flex items-center gap-1.5 cursor-default"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className={costColor} style={{ letterSpacing: '0.05em' }}>
        {formatCost(sessionCost.totalCost)}
      </span>
      <span className="text-claude-text-secondary" style={{ letterSpacing: '0.05em' }}>
        ({formatTokens(sessionCost.totalTokens)})
      </span>
      {sessionCost.savingsVsBaseline > 0 && (
        <span className="text-green-400" style={{ letterSpacing: '0.05em' }}>
          saved {formatCost(sessionCost.savingsVsBaseline)}
        </span>
      )}

      {/* Tooltip with full cost breakdown */}
      {showTooltip && (
        <div
          className="absolute bottom-full right-0 mb-2 w-80 p-3 bg-claude-surface border border-claude-border shadow-lg text-[11px] font-mono z-50"
          style={{ borderRadius: 0 }}
        >
          <div className="font-bold text-claude-text mb-2" style={{ letterSpacing: '0.05em' }}>
            SESSION COST
          </div>
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-claude-text-secondary">This session:</span>
              <span className="text-claude-text">{formatCost(sessionCost.totalCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-claude-text-secondary">Tokens used:</span>
              <span className="text-claude-text">{formatTokens(sessionCost.totalTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-claude-text-secondary">Turns:</span>
              <span className="text-claude-text">{sessionCost.turnCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-claude-text-secondary">Most expensive route:</span>
              <span className="text-claude-text">{formatCost(sessionCost.baselineCost)}</span>
            </div>
            <div className="flex justify-between text-green-400">
              <span>Saved:</span>
              <span>{formatCost(sessionCost.savingsVsBaseline)}</span>
            </div>
          </div>

          {sessionCost.byHarness.length > 0 && (
            <>
              <div className="border-t border-claude-border my-2" />
              <div className="font-bold text-claude-text mb-2" style={{ letterSpacing: '0.05em' }}>
                BY HARNESS
              </div>
              <div className="space-y-1">
                {sessionCost.byHarness.map((h) => (
                  <div key={h.harness} className="grid grid-cols-[1fr_auto_auto] gap-2">
                    <span className="text-claude-text-secondary">{formatHarness(h.harness)}</span>
                    <span className="text-claude-text">{formatCost(h.cost)}</span>
                    <span className="text-green-400">{h.savings > 0 ? `-${formatCost(h.savings)}` : ''}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tierConfig && (
            <>
              <div className="border-t border-claude-border my-2" />
              <div className="font-bold text-claude-text mb-2" style={{ letterSpacing: '0.05em' }}>
                MONTHLY USAGE ({tierConfig.planName})
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-claude-text-secondary">Month total:</span>
                  <span className="text-claude-text">{formatCost(monthCost)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-claude-text-secondary">Included:</span>
                  <span className="text-claude-text">{formatCost(tierConfig.monthlyIncludedUsd)}</span>
                </div>

                {/* Usage bar */}
                <div className="mt-1">
                  <div className="w-full h-1.5 bg-claude-bg">
                    <div
                      className={`h-full transition-all ${
                        isOverLimit ? 'bg-red-500' : isNearLimit ? 'bg-amber-500' : 'bg-green-500'
                      }`}
                      style={{ width: `${Math.min(100, tierUsedPercent)}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-0.5">
                    <span className="text-[9px] text-claude-text-secondary">
                      {tierUsedPercent.toFixed(0)}% used
                    </span>
                    <span className="text-[9px] text-claude-text-secondary">
                      {formatCost(remainingIncluded)} left
                    </span>
                  </div>
                </div>

                {extraUsage > 0 && (
                  <div className="flex justify-between text-red-400">
                    <span>Extra usage:</span>
                    <span>{formatCost(extraUsage)}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
