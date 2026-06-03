import type { Session } from '../../shared/types';

export type SessionPriority = 'needs-input' | 'error' | 'active' | 'idle';

export interface PrioritizedSession {
  session: Session;
  priority: SessionPriority;
  priorityRank: number; // 0 = highest priority
}

export const PRIORITY_CONFIG: Record<SessionPriority, { color: string; label: string; dotClass: string; bgClass: string }> = {
  'needs-input': { color: '#ef4444', label: 'NEEDS INPUT', dotClass: 'bg-red-500 animate-pulse', bgClass: 'bg-red-500/10 border-l-red-500' },
  'error': { color: '#f59e0b', label: 'ERROR', dotClass: 'bg-amber-500', bgClass: 'bg-amber-500/10 border-l-amber-500' },
  'active': { color: '#22c55e', label: 'ACTIVE', dotClass: 'bg-green-500', bgClass: 'bg-green-500/10 border-l-green-500' },
  'idle': { color: '#6b7280', label: 'IDLE', dotClass: 'bg-gray-500', bgClass: 'bg-gray-700/5 border-l-gray-500' },
};

export function getSessionPriority(
  sessionId: string,
  pendingPermission: Record<string, unknown>,
  pendingQuestion: Record<string, unknown>,
  isStreaming: Record<string, boolean>,
  sessionStatus: string,
): SessionPriority {
  if (pendingPermission[sessionId] || pendingQuestion[sessionId]) return 'needs-input';
  if (sessionStatus === 'error') return 'error';
  if (isStreaming[sessionId]) return 'active';
  return 'idle';
}

const PRIORITY_RANK: Record<SessionPriority, number> = {
  'needs-input': 0,
  'error': 1,
  'active': 2,
  'idle': 3,
};

export function prioritizeSessions(
  sessions: Session[],
  pendingPermission: Record<string, unknown>,
  pendingQuestion: Record<string, unknown>,
  isStreaming: Record<string, boolean>,
  filterHours = 24,
): PrioritizedSession[] {
  const cutoff = Date.now() - filterHours * 60 * 60 * 1000;
  const roots = sessions.filter(s => !s.parentSessionId);
  const childrenByRoot = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = childrenByRoot.get(session.parentSessionId) || [];
    children.push(session);
    childrenByRoot.set(session.parentSessionId, children);
  }

  return roots
    .map(root => {
      const group = [root, ...(childrenByRoot.get(root.id) || [])];
      const latestUpdatedAt = Math.max(...group.map(s => new Date(s.updatedAt).getTime()).filter(Number.isFinite));
      const shouldShow = group.some(s => {
        // Always show sessions that need attention right now
        if (isStreaming[s.id] || pendingPermission[s.id] || pendingQuestion[s.id]) return true;

        // Show sessions updated within the filter window
        if (new Date(s.updatedAt).getTime() > cutoff) return true;

        // Show running SSH sessions even if their stored updatedAt is stale.
        if (s.status === 'running' && (s as any).sshConfig) return true;

        return false;
      });
      if (!shouldShow) return null;

      const priority = group
        .map(session => getSessionPriority(session.id, pendingPermission, pendingQuestion, isStreaming, session.status))
        .sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0];
      return {
        session: root,
        priority,
        priorityRank: PRIORITY_RANK[priority],
        latestUpdatedAt,
      };
    })
    .filter((entry): entry is PrioritizedSession & { latestUpdatedAt: number } => Boolean(entry))
    .sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      // Within same priority, sort by most recently updated
      return b.latestUpdatedAt - a.latestUpdatedAt;
    });
}

export function groupByPriority(sessions: PrioritizedSession[]): Map<SessionPriority, PrioritizedSession[]> {
  const groups = new Map<SessionPriority, PrioritizedSession[]>();
  for (const ps of sessions) {
    const existing = groups.get(ps.priority) || [];
    existing.push(ps);
    groups.set(ps.priority, existing);
  }
  return groups;
}
