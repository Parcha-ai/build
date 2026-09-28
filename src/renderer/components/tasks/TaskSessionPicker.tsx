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
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions, branches, or paths…"
          className="w-full border-0 bg-ink-3 py-2 pl-8 pr-2 text-[13px] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
          autoFocus={autoFocus}
        />
      </div>

      <div className="max-h-60 space-y-px overflow-y-auto pr-1">
        <button
          type="button"
          onClick={() => onSelect({ external: true })}
          className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors ${
            external
              ? 'bg-amber/10 text-amber shadow-[inset_0_0_0_1px_rgba(240,180,41,0.45)]'
              : 'text-fg-2 hover:bg-claude-surface-hover'
          }`}
        >
          <Monitor size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Outside Build</span>
            <span className="block truncate text-[11.5px] text-fg-4">Keep the timer in the menu bar without switching sessions</span>
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
              className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors ${
                selected
                  ? 'bg-claude-surface-hover'
                  : 'hover:bg-claude-surface-hover'
              }`}
            >
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                activity === 'active' ? 'bg-accent' : session.status === 'error' ? 'bg-diff-del' : 'bg-fg-5'
              }`} />
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-1 truncate text-[13px] font-medium ${selected ? 'text-fg' : 'text-fg-2'}`}>
                  {session.isStarred && <Star size={9} className="shrink-0 fill-amber text-amber" />}
                  {session.parentSessionId && <GitFork size={9} className="shrink-0 text-fg-4" />}
                  <span className="truncate">{getSessionDisplayName(session)}</span>
                  {session.id === activeSessionId && <span className="shrink-0 font-mono text-[10px] uppercase text-diff-add">current</span>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[11px] text-fg-4">
                  {session.branch || 'no branch'}{path ? ` · ${path}` : ''}
                </span>
              </span>
              {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent" />}
            </button>
          );
        })}

        {orderedSessions.length === 0 && (
          <div className="px-2 py-4 text-center text-[12px] text-fg-4">
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
            ? 'text-amber opacity-80 group-hover:opacity-100'
            : selectedSession
              ? 'text-accent opacity-70 group-hover:opacity-100'
              : 'text-fg-4 opacity-0 hover:text-accent group-hover:opacity-100'
        }`}
        title={label}
      >
        {external ? <Monitor size={10} /> : <Link2 size={10} />}
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-[90] w-80 bg-ink-2 p-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
          <div className="mb-2 px-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
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
