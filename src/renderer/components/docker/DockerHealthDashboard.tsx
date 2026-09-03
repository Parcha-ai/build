import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Box, CheckCircle2, ChevronDown, ChevronUp, Clock3, KeyRound, Loader2, RefreshCw, Server, Square, X } from 'lucide-react';
import type { SSHConfig } from '../../../shared/types';

type Row = Record<string, string>;
type Overview = { connected: boolean; checkedAt: string; version?: string; info?: Record<string, unknown>; containers?: Row[]; stats?: Row[]; error?: string };
const inputClass = 'w-full mt-1.5 bg-claude-bg border border-claude-border px-3 py-2 text-xs text-claude-text outline-none focus:border-claude-accent';
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

  return <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="w-full max-w-6xl h-[min(820px,92vh)] bg-claude-surface border border-claude-border shadow-2xl flex flex-col font-mono">
      <header className="px-5 py-4 border-b border-claude-border flex items-center gap-4">
        <div className="w-9 h-9 bg-claude-accent/15 border border-claude-accent/30 flex items-center justify-center"><Activity size={18} className="text-claude-accent" /></div>
        <div><h2 className="text-sm font-bold text-claude-text tracking-[.12em]">DOCKER HEALTH</h2><p className="text-[10px] text-claude-text-secondary mt-0.5">{target}</p></div><div className="flex-1" />
        {overview?.connected && <span className="text-[10px] text-green-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE · 15s</span>}
        <button onClick={refresh} disabled={loading || !host || !username} className="p-2 text-claude-text-secondary hover:text-claude-text disabled:opacity-40"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
        <button onClick={onClose} className="p-2 text-claude-text-secondary hover:text-claude-text"><X size={16} /></button>
      </header>
      <section className="border-b border-claude-border">
        <button onClick={() => setSettingsOpen(!settingsOpen)} className="w-full px-5 py-2.5 flex items-center gap-2 text-[10px] text-claude-text-secondary hover:bg-claude-bg/50"><Server size={12} />SSH CONNECTION <span className="text-claude-text/70 ml-2">{target}</span><span className="flex-1" />{settingsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button>
        {settingsOpen && <div className="px-5 pb-4 grid grid-cols-12 gap-3">
          <Field label="HOST" value={host} onChange={setHost} placeholder="docker.example.com" span="col-span-5" />
          <Field label="PORT" value={port} onChange={setPort} span="col-span-2" />
          <Field label="USERNAME" value={username} onChange={setUsername} placeholder="ubuntu" span="col-span-5" />
          <Field label="PRIVATE KEY" value={privateKeyPath} onChange={setPrivateKeyPath} span="col-span-9" />
          <button onClick={refresh} disabled={loading || !host || !username || !privateKeyPath} className="col-span-3 mt-[19px] bg-claude-accent text-white text-[10px] font-bold tracking-wider px-4 py-2 disabled:opacity-40 flex items-center justify-center gap-2">{loading ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}CONNECT & INSPECT</button>
          <p className="col-span-12 text-[9px] text-claude-text-secondary/70">This host is remembered for next time. Authentication uses your existing SSH key; no password is stored.</p>
        </div>}
      </section>
      <main className="flex-1 overflow-auto p-5">
        {!overview && !loading && <Empty />}
        {loading && !overview && <div className="h-full flex items-center justify-center gap-3 text-xs text-claude-text-secondary"><Loader2 size={16} className="animate-spin text-claude-accent" />Inspecting Docker on the remote host…</div>}
        {overview && !overview.connected && <div className="border border-red-500/30 bg-red-500/5 p-5 flex gap-3"><AlertTriangle size={18} className="text-red-400" /><div><p className="text-xs text-red-300">Could not inspect this host</p><p className="text-[10px] text-claude-text-secondary mt-2 whitespace-pre-wrap">{overview.error}</p></div></div>}
        {overview?.connected && <><div className="grid grid-cols-4 gap-3 mb-5"><Summary label="TOTAL" value={containers.length} icon={<Box size={14} />} tone="accent" /><Summary label="RUNNING" value={counts.running} icon={<CheckCircle2 size={14} />} tone="good" /><Summary label="BROKEN" value={counts.broken} icon={<AlertTriangle size={14} />} tone="bad" /><Summary label="DOWN" value={counts.down} icon={<Square size={13} />} tone="muted" /></div>
          <div className="flex gap-4 mb-3 text-[9px] text-claude-text-secondary"><span>ENGINE {overview.version || 'UNKNOWN'}</span><span>·</span><span>{String(overview.info?.OperatingSystem || overview.info?.Name || 'REMOTE HOST')}</span><span className="flex-1" /><Clock3 size={11} /><span>{new Date(overview.checkedAt).toLocaleTimeString()}</span></div>
          <div className="border border-claude-border"><div className="grid grid-cols-[1.4fr_1.2fr_.75fr_.65fr_.8fr_1fr] gap-3 px-3 py-2 bg-claude-bg text-[9px] text-claude-text-secondary tracking-widest"><span>CONTAINER</span><span>IMAGE</span><span>STATE</span><span>CPU</span><span>MEMORY</span><span>PORTS</span></div>
            {!containers.length ? <div className="p-8 text-center text-[10px] text-claude-text-secondary">Docker is healthy, but this host has no containers.</div> : containers.map((row) => <ContainerRow key={row.ID || row.Names} row={row} stat={stats.get(row.Names) || stats.get(row.ID)} />)}
          </div></>}
      </main>
    </div>
  </div>;
}

function Field({ label, value, onChange, span, placeholder }: { label: string; value: string; onChange: (v: string) => void; span: string; placeholder?: string }) { return <label className={`${span} text-[9px] text-claude-text-secondary tracking-wider`}>{label}<input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} /></label>; }
function Summary({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) { const c = tone === 'good' ? 'text-green-400 border-green-500/25 bg-green-500/5' : tone === 'bad' ? 'text-red-400 border-red-500/25 bg-red-500/5' : tone === 'accent' ? 'text-claude-accent border-claude-accent/25 bg-claude-accent/5' : 'text-claude-text-secondary border-claude-border bg-claude-bg/40'; return <div className={`border p-3 ${c}`}><div className="flex gap-2 text-[9px] tracking-widest">{icon}{label}</div><div className="text-2xl font-bold text-claude-text mt-2">{value}</div></div>; }
function Empty() { return <div className="h-full flex flex-col items-center justify-center text-center"><Server size={34} className="text-claude-text-secondary/30 mb-4" /><p className="text-xs text-claude-text">Connect a Docker host to begin</p><p className="text-[10px] text-claude-text-secondary mt-2">Build will inspect every container over SSH and keep this view current.</p></div>; }
function ContainerRow({ row, stat }: { row: Row; stat?: Row }) { const name = row.Names || row.Name || row.ID?.slice(0, 12) || 'unknown'; const kind = kindOf(row); const color = kind === 'running' ? 'text-green-400' : kind === 'broken' ? 'text-red-400' : 'text-claude-text-secondary'; return <div className="grid grid-cols-[1.4fr_1.2fr_.75fr_.65fr_.8fr_1fr] gap-3 px-3 py-3 border-t border-claude-border items-center hover:bg-claude-bg/40"><div className="min-w-0"><p className="text-[11px] text-claude-text truncate">{name}</p><p className="text-[9px] text-claude-text-secondary mt-1">{row.ID?.slice(0, 12)}</p></div><span className="text-[10px] text-claude-text-secondary truncate" title={row.Image}>{row.Image || '—'}</span><span className={`text-[9px] font-bold flex gap-1.5 ${color}`}><span className={`w-1.5 h-1.5 rounded-full ${kind === 'running' ? 'bg-green-400' : kind === 'broken' ? 'bg-red-400' : 'bg-gray-500'}`} />{kind.toUpperCase()}</span><span className="text-[10px] text-claude-text-secondary">{stat?.CPUPerc || '—'}</span><span className="text-[10px] text-claude-text-secondary truncate">{stat?.MemPerc || stat?.MemUsage || '—'}</span><span className="text-[9px] text-claude-text-secondary truncate" title={row.Ports}>{row.Ports || '—'}</span><p className="col-span-6 text-[9px] text-claude-text-secondary/70 -mt-2 truncate">{row.Status || row.State}</p></div>; }
