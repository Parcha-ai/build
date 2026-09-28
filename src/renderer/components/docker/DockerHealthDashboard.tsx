import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Box, CheckCircle2, ChevronDown, ChevronUp, Clock3, KeyRound, Loader2, RefreshCw, Server, Square, X } from 'lucide-react';
import type { SSHConfig } from '../../../shared/types';

type Row = Record<string, string>;
type Overview = { connected: boolean; checkedAt: string; version?: string; info?: Record<string, unknown>; containers?: Row[]; stats?: Row[]; error?: string };
const inputClass = 'w-full mt-1.5 h-8 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] px-3 font-mono text-[12.5px] text-fg placeholder:text-fg-5 outline-none focus:ring-1 focus:ring-accent/50';
const kindOf = (row: Row) => {
  const state = (row.State || '').toLowerCase();
  const status = (row.Status || '').toLowerCase();
  if (status.includes('unhealthy') || ['restarting', 'dead'].includes(state)) return 'broken';
  if (['running', 'up'].includes(state)) return 'running';
  return 'down';
};

export default function DockerHealthDashboard({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('~/.ssh/id_ed25519');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);

  useEffect(() => { if (isOpen) window.electronAPI.ssh.getSavedConfig().then((saved) => { if (saved) { setHost(saved.host); setPort(saved.port || '22'); setUsername(saved.username); setPrivateKeyPath(saved.privateKeyPath); } }); }, [isOpen]);
  const refresh = useCallback(async () => {
    if (!host.trim() || !username.trim() || !privateKeyPath.trim()) return;
    setLoading(true);
    const config: SSHConfig = { host: host.trim(), port: Number(port) || 22, username: username.trim(), privateKeyPath: privateKeyPath.trim(), remoteWorkdir: '~', syncSettings: false };
    await window.electronAPI.ssh.saveConfig({ host: config.host, port: String(config.port), username: config.username, privateKeyPath: config.privateKeyPath, remoteWorkdir: '~', sessionName: '', worktreeScript: '', syncSettings: false, forwardGitHubCredentials: false });
    try { const result = await window.electronAPI.docker.getRemoteOverview(config) as Overview; setOverview(result); if (result.connected) setSettingsOpen(false); } finally { setLoading(false); }
  }, [host, port, username, privateKeyPath]);
  useEffect(() => { if (!isOpen || !overview?.connected) return; const id = window.setInterval(refresh, 15000); return () => window.clearInterval(id); }, [isOpen, overview?.connected, refresh]);

  const containers = overview?.containers || [];
  const stats = useMemo(() => new Map((overview?.stats || []).map((row) => [row.Name || row.Container, row])), [overview?.stats]);
  const counts = containers.reduce((a, row) => { a[kindOf(row)]++; return a; }, { running: 0, broken: 0, down: 0 });
  if (!isOpen) return null;
  const target = username && host ? `${username}@${host}:${port || '22'}` : 'No host connected';

  return <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="w-full max-w-6xl h-[min(820px,92vh)] bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] flex flex-col">
      <header className="px-5 py-4 border-b border-line flex items-center gap-4">
        <div className="w-9 h-9 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] flex items-center justify-center"><Activity size={18} className="text-accent" /></div>
        <div><h2 className="text-[16px] font-semibold tracking-tight text-fg">DOCKER HEALTH</h2><p className="font-mono text-[11.5px] text-fg-4 mt-0.5">{target}</p></div><div className="flex-1" />
        {overview?.connected && <span className="font-mono text-[11px] text-diff-add flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-diff-add status-pulse" />LIVE · 15s</span>}
        <button onClick={refresh} disabled={loading || !host || !username} className="p-2 text-fg-3 hover:text-fg hover:bg-claude-surface-hover disabled:opacity-40"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
        <button onClick={onClose} className="p-2 text-fg-3 hover:text-fg hover:bg-claude-surface-hover"><X size={16} /></button>
      </header>
      <section className="border-b border-line">
        <button onClick={() => setSettingsOpen(!settingsOpen)} className="w-full px-5 py-2.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 hover:bg-claude-surface-hover"><Server size={12} />SSH CONNECTION <span className="font-mono normal-case tracking-normal font-normal text-fg-3 ml-2">{target}</span><span className="flex-1" />{settingsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button>
        {settingsOpen && <div className="px-5 pb-4 grid grid-cols-12 gap-3">
          <Field label="HOST" value={host} onChange={setHost} placeholder="docker.example.com" span="col-span-5" />
          <Field label="PORT" value={port} onChange={setPort} span="col-span-2" />
          <Field label="USERNAME" value={username} onChange={setUsername} placeholder="ubuntu" span="col-span-5" />
          <Field label="PRIVATE KEY" value={privateKeyPath} onChange={setPrivateKeyPath} span="col-span-9" />
          <button onClick={refresh} disabled={loading || !host || !username || !privateKeyPath} className="col-span-3 mt-[21px] h-8 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white px-4 disabled:opacity-40 flex items-center justify-center gap-2">{loading ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}CONNECT & INSPECT</button>
          <p className="col-span-12 text-[12px] text-fg-4">This host is remembered for next time. Authentication uses your existing SSH key; no password is stored.</p>
        </div>}
      </section>
      <main className="flex-1 overflow-auto p-5">
        {!overview && !loading && <Empty />}
        {loading && !overview && <div className="h-full flex items-center justify-center gap-3 text-[13px] text-fg-3"><Loader2 size={16} className="animate-spin text-accent" />Inspecting Docker on the remote host…</div>}
        {overview && !overview.connected && <div className="shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] bg-diff-del/5 p-5 flex gap-3"><AlertTriangle size={18} className="text-diff-del" /><div><p className="text-[13px] font-medium text-diff-del-text">Could not inspect this host</p><p className="font-mono text-[11.5px] text-fg-3 mt-2 whitespace-pre-wrap">{overview.error}</p></div></div>}
        {overview?.connected && <><div className="grid grid-cols-4 gap-3 mb-5"><Summary label="TOTAL" value={containers.length} icon={<Box size={14} />} tone="accent" /><Summary label="RUNNING" value={counts.running} icon={<CheckCircle2 size={14} />} tone="good" /><Summary label="BROKEN" value={counts.broken} icon={<AlertTriangle size={14} />} tone="bad" /><Summary label="DOWN" value={counts.down} icon={<Square size={13} />} tone="muted" /></div>
          <div className="flex gap-4 mb-3 font-mono text-[11px] text-fg-4"><span>ENGINE {overview.version || 'UNKNOWN'}</span><span>·</span><span>{String(overview.info?.OperatingSystem || overview.info?.Name || 'REMOTE HOST')}</span><span className="flex-1" /><Clock3 size={11} /><span>{new Date(overview.checkedAt).toLocaleTimeString()}</span></div>
          <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"><div className="grid grid-cols-[1.4fr_1.2fr_.75fr_.65fr_.8fr_1fr] gap-3 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4"><span>CONTAINER</span><span>IMAGE</span><span>STATE</span><span>CPU</span><span>MEMORY</span><span>PORTS</span></div>
            {!containers.length ? <div className="p-8 text-center text-[13px] text-fg-3">Docker is healthy, but this host has no containers.</div> : containers.map((row) => <ContainerRow key={row.ID || row.Names} row={row} stat={stats.get(row.Names) || stats.get(row.ID)} />)}
          </div></>}
      </main>
    </div>
  </div>;
}

function Field({ label, value, onChange, span, placeholder }: { label: string; value: string; onChange: (v: string) => void; span: string; placeholder?: string }) { return <label className={`${span} text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4`}>{label}<input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} /></label>; }
function Summary({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) { const c = tone === 'good' ? 'text-diff-add' : tone === 'bad' ? 'text-diff-del' : tone === 'accent' ? 'text-accent' : 'text-fg-4'; return <div className={`bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] p-3 ${c}`}><div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.04em]">{icon}{label}</div><div className="font-mono text-2xl font-semibold text-fg mt-2">{value}</div></div>; }
function Empty() { return <div className="h-full flex flex-col items-center justify-center text-center"><Server size={34} className="text-fg-5 mb-4" /><p className="text-[14px] font-medium text-fg">Connect a Docker host to begin</p><p className="text-[13px] text-fg-3 mt-2">Build will inspect every container over SSH and keep this view current.</p></div>; }
function ContainerRow({ row, stat }: { row: Row; stat?: Row }) { const name = row.Names || row.Name || row.ID?.slice(0, 12) || 'unknown'; const kind = kindOf(row); const color = kind === 'running' ? 'text-diff-add' : kind === 'broken' ? 'text-diff-del' : 'text-fg-4'; return <div className="grid grid-cols-[1.4fr_1.2fr_.75fr_.65fr_.8fr_1fr] gap-3 px-3 py-3 border-t border-line items-center hover:bg-claude-surface-hover"><div className="min-w-0"><p className="font-mono text-[12px] text-fg truncate">{name}</p><p className="font-mono text-[10.5px] text-fg-5 mt-1">{row.ID?.slice(0, 12)}</p></div><span className="font-mono text-[11.5px] text-fg-3 truncate" title={row.Image}>{row.Image || '—'}</span><span className={`font-mono text-[10.5px] font-medium flex items-center gap-1.5 ${color}`}><span className={`w-1.5 h-1.5 rounded-full ${kind === 'running' ? 'bg-diff-add' : kind === 'broken' ? 'bg-diff-del' : 'bg-fg-5'}`} />{kind.toUpperCase()}</span><span className="font-mono text-[11.5px] text-fg-3">{stat?.CPUPerc || '—'}</span><span className="font-mono text-[11.5px] text-fg-3 truncate">{stat?.MemPerc || stat?.MemUsage || '—'}</span><span className="font-mono text-[10.5px] text-fg-4 truncate" title={row.Ports}>{row.Ports || '—'}</span><p className="col-span-6 text-[11px] text-fg-5 -mt-2 truncate">{row.Status || row.State}</p></div>; }
