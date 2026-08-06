import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, GitFork, Link2, Monitor, Search, Star } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { useSessionStore } from '../../stores/session.store';
import { getSessionDisplayName } from '../../utils/session-display';

export interface TaskSessionSelection {
  sessionId?: string;
  external: boolean;
}

interface SessionPickerListProps {
  selectedSessionId?: string;
  external: boolean;
  onSelect: (selection: TaskSessionSelection) => void;
  autoFocus?: boolean;
}

function timestamp(value: Date | string | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function searchableText(session: Session): string {
  return [
    getSessionDisplayName(session),
    session.name,
    session.branch,
    session.repoPath,
    session.worktreePath,
    session.forkName,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function SessionPickerList({
  selectedSessionId,
  external,
  onSelect,
  autoFocus = false,
}: SessionPickerListProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessionActivity = useSessionStore((state) => state.sessionActivity);
  const [query, setQuery] = useState('');

  const orderedSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sessions
      .filter((session) => !normalizedQuery || searchableText(session).includes(normalizedQuery))
      .sort((a, b) => {
        const score = (session: Session) => {
          if (session.id === selectedSessionId) return 100;
          if (session.id === activeSessionId) return 80;
          if (session.isStarred) return 60;
          if (sessionActivity[session.id] === 'active' || session.status === 'running') return 40;
          return 0;
        };
        return score(b) - score(a) || timestamp(b.updatedAt) - timestamp(a.updatedAt);
      });
  }, [activeSessionId, query, selectedSessionId, sessionActivity, sessions]);

  return (
    <div className="min-w-0">
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-claude-text-secondary" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions, branches, or paths…"
          className="w-full rounded border border-claude-border bg-claude-bg py-2 pl-8 pr-2 text-[11px] font-mono text-claude-text placeholder:text-claude-text-secondary/60 focus:border-cyan-500 focus:outline-none"
          autoFocus={autoFocus}
        />
      </div>

      <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
        <button
          type="button"
          onClick={() => onSelect({ external: true })}
          className={`flex w-full items-center gap-2 rounded border px-2.5 py-2 text-left transition-colors ${
            external
              ? 'border-amber-400/60 bg-amber-400/10 text-amber-200'
              : 'border-claude-border bg-claude-bg/60 text-claude-text hover:border-amber-400/40 hover:bg-amber-400/5'
          }`}
        >
          <Monitor size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold">Outside Build</span>
            <span className="block truncate text-[9px] text-claude-text-secondary">Keep the timer in the menu bar without switching sessions</span>
          </span>
          {external && <Check size={13} className="shrink-0" />}
        </button>

        {orderedSessions.map((session) => {
          const selected = !external && session.id === selectedSessionId;
          const activity = sessionActivity[session.id];
          const path = session.worktreePath || session.repoPath;
          return (
            <button
              type="button"
              key={session.id}
              onClick={() => onSelect({ sessionId: session.id, external: false })}
              className={`flex w-full items-start gap-2 rounded border px-2.5 py-2 text-left transition-colors ${
                selected
                  ? 'border-cyan-400/60 bg-cyan-400/10'
                  : 'border-transparent hover:border-claude-border hover:bg-claude-bg'
              }`}
            >
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                activity === 'active' ? 'bg-green-400' : session.status === 'error' ? 'bg-red-400' : 'bg-claude-text-secondary/40'
              }`} />
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-1 truncate text-[11px] font-semibold ${selected ? 'text-cyan-300' : 'text-claude-text'}`}>
                  {session.isStarred && <Star size={9} className="shrink-0 fill-amber-300 text-amber-300" />}
                  {session.parentSessionId && <GitFork size={9} className="shrink-0 text-violet-300" />}
                  <span className="truncate">{getSessionDisplayName(session)}</span>
                  {session.id === activeSessionId && <span className="shrink-0 text-[8px] uppercase text-green-400">current</span>}
                </span>
                <span className="mt-0.5 block truncate text-[9px] text-claude-text-secondary">
                  {session.branch || 'no branch'}{path ? ` · ${path}` : ''}
                </span>
              </span>
              {selected && <Check size={13} className="mt-0.5 shrink-0 text-cyan-300" />}
            </button>
          );
        })}

        {orderedSessions.length === 0 && (
          <div className="px-2 py-4 text-center text-[10px] font-mono text-claude-text-secondary">
            No sessions match “{query}”
          </div>
        )}
      </div>
    </div>
  );
}

interface TaskSessionPickerProps {
  selectedSessionId?: string;
  external: boolean;
  onSelect: (selection: TaskSessionSelection) => void;
}

export default function TaskSessionPicker({ selectedSessionId, external, onSelect }: TaskSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const label = external
    ? 'Outside Build'
    : selectedSession
      ? getSessionDisplayName(selectedSession)
      : 'Link focus session';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`max-w-24 truncate transition-opacity ${
          external
            ? 'text-amber-300 opacity-80 group-hover:opacity-100'
            : selectedSession
              ? 'text-cyan-400 opacity-70 group-hover:opacity-100'
              : 'text-claude-text-secondary opacity-0 hover:text-cyan-400 group-hover:opacity-100'
        }`}
        title={label}
      >
        {external ? <Monitor size={10} /> : <Link2 size={10} />}
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-[90] w-80 rounded-md border border-claude-border bg-claude-surface p-2 shadow-2xl">
          <div className="mb-2 px-0.5 text-[9px] font-bold uppercase tracking-wider text-claude-text-secondary">
            Task focus location
          </div>
          <SessionPickerList
            selectedSessionId={selectedSessionId}
            external={external}
            onSelect={(selection) => {
              onSelect(selection);
              setOpen(false);
            }}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
