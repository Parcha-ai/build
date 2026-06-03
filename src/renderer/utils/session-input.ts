import type { Session } from '../../shared/types';

export function canSendMessageToSession(session: Session): boolean {
  if (session.status === 'running' || session.status === 'stopped') return true;
  if (session.status === 'error') {
    return Boolean(session.worktreePath || session.repoPath || session.sshConfig || session.openclawConfig);
  }

  return false;
}
