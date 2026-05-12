import type { Session, ChatMessage } from '../../shared/types';

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
  messages: Record<string, ChatMessage[]>,
  pendingPermission: Record<string, unknown>,
  pendingQuestion: Record<string, unknown>,
  isStreaming: Record<string, boolean>,
  filterHours: number = 24,
): PrioritizedSession[] {
  const cutoff = Date.now() - filterHours * 60 * 60 * 1000;

  return sessions
    .filter(s => !s.parentSessionId) // Only root sessions (not forks)
    .filter(s => {
      // Always show sessions that need attention right now
      if (isStreaming[s.id] || pendingPermission[s.id] || pendingQuestion[s.id]) return true;
      if (s.status === 'error') return true;
      // Only show sessions with actual message activity in the filter window
      const sessionMessages = messages[s.id];
      if (!sessionMessages || sessionMessages.length === 0) return false;
      const lastMessage = sessionMessages[sessionMessages.length - 1];
      return new Date(lastMessage.timestamp).getTime() > cutoff;
    })
    .map(session => {
      const priority = getSessionPriority(session.id, pendingPermission, pendingQuestion, isStreaming, session.status);
      return { session, priority, priorityRank: PRIORITY_RANK[priority] };
    })
    .sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      // Within same priority, sort by most recently updated
      return new Date(b.session.updatedAt).getTime() - new Date(a.session.updatedAt).getTime();
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
