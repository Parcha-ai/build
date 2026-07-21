import type {
  PullRequestCheckState,
  PullRequestLifecycle,
  PullRequestStatus,
} from '../types';

interface RawStatusCheck {
  status?: unknown;
  conclusion?: unknown;
  state?: unknown;
}

interface RawPullRequest {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  isDraft?: unknown;
  reviewDecision?: unknown;
  mergeStateStatus?: unknown;
  mergeable?: unknown;
  statusCheckRollup?: unknown;
  updatedAt?: unknown;
}

const FAILURE_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STARTUP_FAILURE',
  'STALE',
  'TIMED_OUT',
]);

const BLOCKING_MERGE_STATES = new Set(['BEHIND', 'DIRTY']);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function classifyPullRequestChecks(value: unknown): PullRequestCheckState {
  if (!Array.isArray(value) || value.length === 0) return 'none';

  let hasPending = false;
  for (const rawCheck of value) {
    if (!rawCheck || typeof rawCheck !== 'object') continue;
    const check = rawCheck as RawStatusCheck;
    const status = asString(check.status)?.toUpperCase();
    const conclusion = asString(check.conclusion)?.toUpperCase();
    const state = asString(check.state)?.toUpperCase();

    if (state === 'FAILURE' || state === 'ERROR' || (conclusion && FAILURE_CONCLUSIONS.has(conclusion))) {
      return 'failing';
    }
    if (
      state === 'PENDING'
      || state === 'EXPECTED'
      || (status && status !== 'COMPLETED')
      || (status === 'COMPLETED' && !conclusion)
    ) {
      hasPending = true;
    }
  }

  return hasPending ? 'pending' : 'passing';
}

export function classifyPullRequestLifecycle(
  raw: RawPullRequest,
  checks = classifyPullRequestChecks(raw.statusCheckRollup),
): PullRequestLifecycle {
  if (raw.isDraft === true) return 'draft';

  const reviewDecision = asString(raw.reviewDecision)?.toUpperCase();
  const mergeStateStatus = asString(raw.mergeStateStatus)?.toUpperCase();
  const mergeable = asString(raw.mergeable)?.toUpperCase();
  const isBlocked = checks === 'pending'
    || checks === 'failing'
    || reviewDecision === 'CHANGES_REQUESTED'
    || (mergeStateStatus ? BLOCKING_MERGE_STATES.has(mergeStateStatus) : false)
    || mergeStateStatus === 'UNKNOWN'
    || mergeable === 'CONFLICTING'
    || mergeable === 'UNKNOWN';

  return isBlocked ? 'iterating' : 'ready';
}

export function parsePullRequestStatus(output: string): PullRequestStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const raw = parsed[0] as RawPullRequest;
  if (
    typeof raw?.number !== 'number'
    || typeof raw.url !== 'string'
    || typeof raw.title !== 'string'
  ) {
    return null;
  }

  const checks = classifyPullRequestChecks(raw.statusCheckRollup);
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    lifecycle: classifyPullRequestLifecycle(raw, checks),
    checks,
    ...(asString(raw.reviewDecision) ? { reviewDecision: asString(raw.reviewDecision) } : {}),
    ...(asString(raw.mergeStateStatus) ? { mergeStateStatus: asString(raw.mergeStateStatus) } : {}),
    ...(asString(raw.mergeable) ? { mergeable: asString(raw.mergeable) } : {}),
    ...(asString(raw.updatedAt) ? { updatedAt: asString(raw.updatedAt) } : {}),
  };
}

export function normalizeGitHubRepository(remoteUrl: string): string | null {
  const value = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!value) return null;

  const scpMatch = value.includes('://')
    ? null
    : value.match(/^(?:[^@]+@)?([^:]+):(.+\/.+)$/);
  if (scpMatch) {
    const [, host, repoPath] = scpMatch;
    return host === 'github.com' ? repoPath : `${host}/${repoPath}`;
  }

  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    const repoPath = parsed.pathname.replace(/^\//, '');
    if (repoPath.split('/').length < 2) return null;
    return parsed.hostname === 'github.com' ? repoPath : `${parsed.hostname}/${repoPath}`;
  } catch {
    return null;
  }
}
