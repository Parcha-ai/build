import assert from 'assert';
import type { Session } from '../src/shared/types';
import {
  getFirstVisibleTabSession,
  getSessionDisplayName,
  getSidebarSessionDisplayName,
} from '../src/renderer/utils/session-display';

function session(overrides: Partial<Session> & { id: string }): Session {
  const now = new Date('2026-06-02T12:00:00.000Z');
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name ?? '',
    repoPath: overrides.repoPath ?? '',
    worktreePath: overrides.worktreePath ?? '',
    branch: overrides.branch ?? '',
    status: overrides.status ?? 'running',
    ports: overrides.ports ?? { web: 0, api: 0, debug: 0 },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    setupScript: overrides.setupScript ?? '',
  };
}

assert.equal(
  getSessionDisplayName(session({
    id: 'abc123456789',
    aiGeneratedName: 'This',
    forkName: 'work',
    name: 'Task',
    branch: 'feature/fix-stale-transcript',
    repoPath: '/Users/aj/dev/build-app',
  })),
  'FIX Stale Transcript'
);

assert.equal(
  getSessionDisplayName(session({
    id: 'path123456789',
    name: 'this',
    branch: 'this',
    repoPath: '/Users/aj/dev/customer_portal_api',
  })),
  'Customer Portal API'
);

assert.equal(
  getSessionDisplayName(session({
    id: 'fallback987654321',
    name: 'This',
    branch: 'thing',
    repoPath: '/tmp/work',
  })),
  'fallback'
);

assert.equal(
  getSessionDisplayName(session({
    id: 'good-name-session',
    aiGeneratedName: 'Checkout Polish',
    name: 'This',
    branch: 'feature/ignored',
  })),
  'Checkout Polish'
);

const root = session({
  id: 'root-session',
  name: 'root-name',
  createdAt: new Date('2026-06-02T10:00:00.000Z'),
});
const firstFork = session({
  id: 'first-fork',
  name: 'First Fork',
  parentSessionId: root.id,
  forkCreatedAt: new Date('2026-06-02T10:05:00.000Z'),
});
const secondFork = session({
  id: 'second-fork',
  name: 'Second Fork',
  parentSessionId: root.id,
  forkCreatedAt: new Date('2026-06-02T10:10:00.000Z'),
});

assert.equal(getFirstVisibleTabSession(secondFork, [secondFork, firstFork, root]).id, root.id);
assert.equal(getSidebarSessionDisplayName(secondFork, [secondFork, firstFork, root]), 'root-name');

console.log('session display behavior verifier passed');
