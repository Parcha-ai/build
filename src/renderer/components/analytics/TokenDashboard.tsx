import React, { useEffect, useState, useCallback } from 'react';
import { X, RefreshCw, Settings } from 'lucide-react';

interface AnalyticsSummary {
  todayTotalCost: number;
  todayTotalTokens: number;
  todayCacheHitRate: number;
  monthTotalCost: number;
  monthIncludedUsd: number;
  monthExtraUsageCost: number;
  isOverIncludedUsage: boolean;
  percentOfIncluded: number;
  bySession: Array<{ sessionId: string; sessionName: string; model: string; totalTokens: number; cost: number; baselineCost: number; savings: number }>;
  byHarness: Array<{ harness: string; cost: number; baselineCost: number; savings: number; tokenCount: number; turnCount: number }>;
  byModel: Array<{ model: string; cost: number; tokenCount: number }>;
  byTool: Array<{ tool: string; cost: number; callCount: number }>;
  hourlyTimeline: Array<{ hour: string; tokens: number; cost: number }>;
}

interface TierConfig {
  monthlyIncludedUsd: number;
  planName: string;
}

interface HarnessInsight {
  harness: string;
  model: string;
  runs: number;
  successes: number;
  failures: number;
  successRate: number;
  overrideCount: number;
  totalCost: number;
  bestTier?: string;
  bestDomain?: string;
}

function formatCost(cost: number): string {
  if (cost < 0.01 && cost > 0) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function getModelShortName(model: string): string {
  if (model.includes('glm-5.2') || model.includes('zai-glm')) return 'GLM 5.2';
  if (model.includes('fable-5')) return 'Fable 5';
  if (model.includes('sonnet-5')) return 'Sonnet 5';
  if (model.includes('opus-5')) return 'Opus 5';
  if (model.includes('opus-4-8')) return 'Opus 4.8';
  if (model.includes('opus-4-7')) return 'Opus 4.7';
  if (model.includes('opus-4-6')) return 'Opus 4.6';
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (model.includes('sonnet-4-5')) return 'Sonnet 4.5';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  if (model.includes('codex')) return 'Codex';
  return model.split('/').pop() || model;
}

function getCostTier(model: string): string {
  if (model.includes('glm-5.2') || model.includes('zai-glm')) return '$';
  if (model.includes('opus')) return '$$$';
  if (model.includes('sonnet')) return '$$';
  if (model.includes('haiku')) return '$';
  return '$$';
}

function getHarnessLabel(harness: string): string {
  return harness.charAt(0).toUpperCase() + harness.slice(1);
}

interface SparklineProps {
  data: number[];
  width: number;
  height: number;
  color: string;
}

function Sparkline({ data, width, height, color }: SparklineProps) {
  if (data.length === 0 || data.every(d => d === 0)) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke={color} strokeWidth="1" strokeDasharray="2,2" />
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const step = width / Math.max(data.length - 1, 1);
  const points = data.map((v, i) => `${i * step},${height - (v / max) * (height - 4)}`).join(' ');
  return (
    <svg width={width} height={height}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

export default function TokenDashboard({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [tierConfig, setTierConfig] = useState<TierConfig | null>(null);
  const [harnessInsights, setHarnessInsights] = useState<HarnessInsight[]>([]);
  const [showTierSettings, setShowTierSettings] = useState(false);
  const [tierInput, setTierInput] = useState('');
  const [planInput, setPlanInput] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, t, insights] = await Promise.all([
        window.electronAPI.analytics.getSummary(),
        window.electronAPI.analytics.getTierConfig(),
        window.electronAPI.analytics.getHarnessInsights?.().catch(() => []),
      ]);
      setSummary(s);
      setTierConfig(t);
      setHarnessInsights(Array.isArray(insights) ? insights : []);
      setTierInput(String(t.monthlyIncludedUsd));
      setPlanInput(t.planName);
    } catch (e) {
      console.error('[TokenDashboard] Failed to load analytics:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsub = window.electronAPI.analytics.onTokenEvent(() => refresh());
    return () => { unsub(); };
  }, [refresh]);

  const saveTierConfig = async () => {
    const amount = parseFloat(tierInput);
    if (isNaN(amount) || amount <= 0) return;
    await window.electronAPI.analytics.setTierConfig({ monthlyIncludedUsd: amount, planName: planInput || 'Custom' });
    setShowTierSettings(false);
    refresh();
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-fg-4 text-[13px]">
        Loading analytics...
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="h-full flex items-center justify-center text-fg-4 text-[13px]">
        No analytics data available yet. Send some messages to start tracking.
      </div>
    );
  }

  const tierUsedPercent = tierConfig ? summary.percentOfIncluded : 0;
  const remainingIncluded = tierConfig ? Math.max(0, tierConfig.monthlyIncludedUsd - summary.monthTotalCost) : 0;

  return (
    <div className="h-full flex flex-col bg-ink-1 text-[12px] overflow-hidden">
      {/* Header */}
      <div className="h-11 flex items-center justify-between px-4 border-b border-line bg-ink-1">
        <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-fg">
          Token analytics
        </h2>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowTierSettings(!showTierSettings)} className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors" title="Usage tier settings">
            <Settings size={12} />
          </button>
          <button onClick={refresh} className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors" title="Refresh">
            <RefreshCw size={12} />
          </button>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors" title="Close">
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Tier settings inline */}
      {showTierSettings && (
        <div className="px-4 py-3 border-b border-line bg-ink-2 space-y-2">
          <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4">Usage tier config</div>
          <div className="flex items-center gap-2">
            <label className="text-fg-4 w-20">Plan name:</label>
            <input
              value={planInput}
              onChange={(e) => setPlanInput(e.target.value)}
              className="flex-1 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-2 py-1 text-fg text-[12px] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.6)]"
              placeholder="Pro / Team / Enterprise"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-fg-4 w-20">Monthly $:</label>
            <input
              value={tierInput}
              onChange={(e) => setTierInput(e.target.value)}
              className="flex-1 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-2 py-1 text-fg text-[12px] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.6)]"
              type="number"
              min="1"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowTierSettings(false)} className="h-7 px-2.5 text-fg-3 hover:text-fg">Cancel</button>
            <button onClick={saveTierConfig} className="h-7 px-2.5 bg-[#EDEDED] text-[#0F0F0F] font-semibold hover:bg-white">Save</button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Top stats row */}
        <div className="grid grid-cols-4 gap-3">
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1">TODAY'S SPEND</div>
            <div className="font-mono text-[20px] font-medium tracking-[-0.02em] text-fg">{formatCost(summary.todayTotalCost)}</div>
            <div className="text-[11px] text-fg-4">{formatTokens(summary.todayTotalTokens)} tokens</div>
          </div>
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1">CACHE HIT RATE</div>
            <div className={`font-mono text-[20px] font-medium tracking-[-0.02em] ${summary.todayCacheHitRate >= 50 ? 'text-diff-add' : summary.todayCacheHitRate >= 20 ? 'text-amber' : 'text-diff-del'}`}>
              {summary.todayCacheHitRate.toFixed(0)}%
            </div>
            <div className="text-[11px] text-fg-4">of input tokens cached</div>
          </div>
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1">MONTH TOTAL</div>
            <div className={`font-mono text-[20px] font-medium tracking-[-0.02em] ${summary.isOverIncludedUsage ? 'text-diff-del' : 'text-fg'}`}>
              {formatCost(summary.monthTotalCost)}
            </div>
            <div className="text-[11px] text-fg-4">
              {tierConfig && `of ${formatCost(tierConfig.monthlyIncludedUsd)} included`}
            </div>
          </div>
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-1">SAVED VS MAX</div>
            <div className="font-mono text-[20px] font-medium tracking-[-0.02em] text-diff-add">
              {formatCost(summary.byHarness.reduce((sum, h) => sum + h.savings, 0))}
            </div>
            <div className="text-[11px] text-fg-4">vs all turns on GPT-5.6</div>
          </div>
        </div>

        {/* Monthly usage tier bar */}
        {tierConfig && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="flex justify-between items-center mb-2">
              <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4">
                MONTHLY USAGE — {tierConfig.planName.toUpperCase()}
              </div>
              <div className="text-[11px] text-fg-4">
                {formatCost(remainingIncluded)} remaining
              </div>
            </div>
            <div className="w-full h-1 bg-[#262626] relative">
              <div
                className={`h-full transition-all ${
                  tierUsedPercent >= 100 ? 'bg-diff-del' : tierUsedPercent >= 80 ? 'bg-amber' : 'bg-accent'
                }`}
                style={{ width: `${Math.min(100, tierUsedPercent)}%` }}
              />
              {/* Threshold marker at 100% */}
              <div className="absolute top-0 bottom-0 w-px bg-fg-4" style={{ left: '100%' }} />
            </div>
            <div className="flex justify-between mt-1">
              <span className="font-mono text-[10.5px] text-fg-4">{tierUsedPercent.toFixed(1)}% used</span>
              {summary.monthExtraUsageCost > 0 && (
                <span className="font-mono text-[10.5px] text-diff-del">+{formatCost(summary.monthExtraUsageCost)} extra usage</span>
              )}
            </div>
          </div>
        )}

        {/* Hourly Timeline */}
        <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
          <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
            TOKEN USAGE — LAST 24H
          </div>
          <Sparkline
            data={summary.hourlyTimeline.map(h => h.tokens)}
            width={400}
            height={40}
            color="#4C9AFF"
          />
          <div className="flex justify-between mt-1">
            <span className="font-mono text-[10.5px] text-fg-4">
              {summary.hourlyTimeline[0]?.hour || ''}
            </span>
            <span className="font-mono text-[10.5px] text-fg-4">
              {summary.hourlyTimeline[summary.hourlyTimeline.length - 1]?.hour || ''}
            </span>
          </div>
        </div>

        {/* By Session */}
        {summary.bySession.length > 0 && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
              BY SESSION (TODAY)
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.04em] text-fg-5 border-b border-line">
                  <th className="text-left py-1 pr-2">Session</th>
                  <th className="text-left py-1 pr-2">Model</th>
                  <th className="text-right py-1 pr-2">Tokens</th>
                  <th className="text-right py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.bySession.slice(0, 10).map((s) => (
                  <tr key={s.sessionId} className="border-b border-line">
                    <td className="py-1 pr-2 text-fg truncate max-w-[120px]">{s.sessionName}</td>
                    <td className="py-1 pr-2 text-fg-4">{getModelShortName(s.model)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">{formatTokens(s.totalTokens)}</td>
                    <td className="py-1 text-right font-mono text-fg">{formatCost(s.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* By Harness */}
        {summary.byHarness.length > 0 && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
              BY HARNESS (TODAY)
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.04em] text-fg-5 border-b border-line">
                  <th className="text-left py-1 pr-2">Harness</th>
                  <th className="text-right py-1 pr-2">Turns</th>
                  <th className="text-right py-1 pr-2">Tokens</th>
                  <th className="text-right py-1 pr-2">Cost</th>
                  <th className="text-right py-1">Saved</th>
                </tr>
              </thead>
              <tbody>
                {summary.byHarness.map((h) => (
                  <tr key={h.harness} className="border-b border-line">
                    <td className="py-1 pr-2 text-fg">{getHarnessLabel(h.harness)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">{h.turnCount}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">{formatTokens(h.tokenCount)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg">{formatCost(h.cost)}</td>
                    <td className="py-1 text-right font-mono text-diff-add">{formatCost(h.savings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Learned Routing */}
        {harnessInsights.length > 0 && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
              LEARNED ROUTING SIGNALS
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.04em] text-fg-5 border-b border-line">
                  <th className="text-left py-1 pr-2">Model</th>
                  <th className="text-left py-1 pr-2">Best for</th>
                  <th className="text-right py-1 pr-2">Runs</th>
                  <th className="text-right py-1 pr-2">Success</th>
                  <th className="text-right py-1">Overrides</th>
                </tr>
              </thead>
              <tbody>
                {harnessInsights.slice(0, 6).map((insight) => (
                  <tr key={`${insight.harness}:${insight.model}`} className="border-b border-line">
                    <td className="py-1 pr-2 text-fg truncate max-w-[170px]">{insight.model}</td>
                    <td className="py-1 pr-2 text-fg-4">
                      {[insight.bestDomain, insight.bestTier].filter(Boolean).join(' / ') || '-'}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">{insight.runs}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">
                      {insight.runs > 0 ? `${Math.round(insight.successRate * 100)}%` : '-'}
                    </td>
                    <td className="py-1 text-right font-mono text-fg-4">{insight.overrideCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* By Model */}
        {summary.byModel.length > 0 && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
              BY MODEL (TODAY)
            </div>
            <div className="space-y-2">
              {summary.byModel.map((m) => {
                const pct = summary.todayTotalCost > 0 ? (m.cost / summary.todayTotalCost) * 100 : 0;
                return (
                  <div key={m.model}>
                    <div className="flex justify-between mb-0.5">
                      <span className="text-fg">
                        {getModelShortName(m.model)} <span className="text-fg-4">{getCostTier(m.model)}</span>
                      </span>
                      <span className="text-fg">{formatCost(m.cost)}</span>
                    </div>
                    <div className="w-full h-1 bg-[#262626]">
                      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* By Tool */}
        {summary.byTool.length > 0 && (
          <div className="p-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-fg-4 mb-2">
              BY TOOL (TODAY)
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.04em] text-fg-5 border-b border-line">
                  <th className="text-left py-1 pr-2">Tool</th>
                  <th className="text-right py-1 pr-2">Calls</th>
                  <th className="text-right py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.byTool.slice(0, 15).map((t) => (
                  <tr key={t.tool} className="border-b border-line">
                    <td className="py-1 pr-2 text-fg">{t.tool}</td>
                    <td className="py-1 pr-2 text-right font-mono text-fg-4">{t.callCount}</td>
                    <td className="py-1 text-right font-mono text-fg">{formatCost(t.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Savings suggestions */}
        {summary.byModel.some(m => m.model.includes('opus') && m.tokenCount < 50000) && (
          <div className="p-3 bg-[rgba(240,180,41,0.07)] shadow-[inset_0_0_0_1px_rgba(240,180,41,0.3)]">
            <div className="text-[11px] uppercase tracking-[0.04em] text-amber mb-1">Savings suggestion</div>
            <div className="text-[11px] text-fg-2">
              Some sessions are using Opus with relatively low token counts. Consider using Sonnet for smaller tasks — it's 5x cheaper with similar quality for most coding work.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
