import type { Session } from '../../shared/types';

const BAD_SESSION_NAMES = new Set([
  'chat', 'continue', 'fix', 'help', 'latest', 'new task', 'session', 'stuff',
  'task', 'that', 'the task', 'thing', 'this', 'this task', 'update', 'work',
]);

function isBadSessionName(value: string | undefined): boolean {
  const normalized = (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return !normalized || BAD_SESSION_NAMES.has(normalized);
}

function titleCaseBranchPart(part: string): string {
  const upper = part.toUpperCase();
  if (part.length <= 3 || ['ui', 'api', 'url', 'ssh', 'mcp', 'pdf'].includes(part.toLowerCase())) return upper;
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function fallbackNameFromBranch(session: Session): string | null {
  const branch = session.branch?.split('/').pop();
  if (!branch) return null;
  const words = branch
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map(titleCaseBranchPart);
  const title = words.join(' ').trim();
  return title && !isBadSessionName(title) ? title : null;
}

function fallbackNameFromPath(session: Session): string | null {
  const rawPath = session.worktreePath || session.repoPath || '';
  const leaf = rawPath.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  const title = leaf
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map(titleCaseBranchPart)
    .join(' ')
    .trim();
  return title && !isBadSessionName(title) ? title : null;
}

export function getSessionDisplayName(session: Session): string {
  const candidates = [
    session.aiGeneratedName,
    session.forkName,
    session.name,
    fallbackNameFromBranch(session),
    fallbackNameFromPath(session),
  ];
  return candidates.find((candidate) => candidate && !isBadSessionName(candidate))
    || session.id.slice(0, 8);
}

function asTime(value: Date | string | undefined): number {
  if (!value) return 0;
  const time = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
  return Number.isFinite(time) ? time : 0;
}

function readJsonArray(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function getRootSession(session: Session, sessions: Session[]): Session {
  let root = session;
  const seen = new Set<string>([session.id]);
  while (root.parentSessionId && !seen.has(root.parentSessionId)) {
    const parent = sessions.find((candidate) => candidate.id === root.parentSessionId);
    if (!parent) break;
    root = parent;
    seen.add(root.id);
  }
  return root;
}

export function getFirstVisibleTabSession(session: Session, sessions: Session[]): Session {
  const root = getRootSession(session, sessions);
  const siblings = [root, ...sessions.filter((candidate) => candidate.parentSessionId === root.id)]
    .sort((a, b) => asTime(a.forkCreatedAt || a.createdAt) - asTime(b.forkCreatedAt || b.createdAt));

  const hiddenIds = new Set(readJsonArray(`grep-overflow-forks-${root.id}`));
  const visible = siblings.filter((candidate) => !candidate.tabHidden && !hiddenIds.has(candidate.id));
  if (visible.length === 0) return root;

  const tabOrder = readJsonArray(`grep-tab-order-${root.id}`);
  if (tabOrder.length === 0) return visible[0];

  const originalIndex = new Map(visible.map((candidate, index) => [candidate.id, index]));
  const orderIndex = new Map(tabOrder.map((id, index) => [id, index]));
  return [...visible].sort((a, b) => {
    const aOrder = orderIndex.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bOrder = orderIndex.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  })[0] || root;
}

export function getSidebarSessionDisplayName(session: Session, sessions: Session[]): string {
  return getSessionDisplayName(getFirstVisibleTabSession(session, sessions));
}
