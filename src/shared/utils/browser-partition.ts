import type { Session } from '../types';

/**
 * Browser tabs in one conversation-fork family share the root session's
 * persistent Electron partition. Using the existing root partition preserves
 * logins from before family sharing was introduced.
 */
export function getBrowserPartitionId(sessionId: string, sessions: Session[]): string {
  let currentId = sessionId;
  const seen = new Set<string>();

  for (let depth = 0; depth < 20; depth++) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const session = sessions.find((candidate) => candidate.id === currentId);
    if (!session?.parentSessionId) break;
    currentId = session.parentSessionId;
  }

  return currentId;
}

export function getBrowserPartitionName(partitionId: string): string {
  return `persist:browser-${partitionId}`;
}
