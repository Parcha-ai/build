import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  classifyPullRequestChecks,
  normalizeGitHubRepository,
  parsePullRequestStatus,
} from '../src/shared/utils/pull-request-status';

const root = path.resolve(__dirname, '..');

function ghOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    number: 812,
    url: 'https://github.com/acme/repo/pull/812',
    title: 'Add PR lifecycle indicators',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    updatedAt: '2026-07-16T12:00:00Z',
    ...overrides,
  }]);
}

assert.strictEqual(classifyPullRequestChecks([]), 'none');
assert.strictEqual(
  classifyPullRequestChecks([{ status: 'IN_PROGRESS', conclusion: null }]),
  'pending',
);
assert.strictEqual(
  classifyPullRequestChecks([{ status: 'COMPLETED', conclusion: null }]),
  'pending',
);
assert.strictEqual(normalizeGitHubRepository('git@github.com:Parcha-ai/claudette.git'), 'Parcha-ai/claudette');
assert.strictEqual(normalizeGitHubRepository('https://github.com/Parcha-ai/claudette.git'), 'Parcha-ai/claudette');
assert.strictEqual(normalizeGitHubRepository('ssh://git@ghe.example.com/Parcha/Build.git'), 'ghe.example.com/Parcha/Build');
assert.strictEqual(normalizeGitHubRepository('not-a-repository'), null);
assert.strictEqual(
  classifyPullRequestChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }]),
  'failing',
);
assert.strictEqual(
  classifyPullRequestChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { state: 'SUCCESS' },
  ]),
  'passing',
);

assert.strictEqual(parsePullRequestStatus('[]'), null, 'no open PR should render no icon');
assert.strictEqual(parsePullRequestStatus(ghOutput({ isDraft: true }))?.lifecycle, 'draft');
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }))?.lifecycle,
  'iterating',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ reviewDecision: 'CHANGES_REQUESTED' }))?.lifecycle,
  'iterating',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ mergeStateStatus: 'BEHIND' }))?.lifecycle,
  'iterating',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ mergeable: 'CONFLICTING' }))?.lifecycle,
  'iterating',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ mergeable: 'UNKNOWN' }))?.lifecycle,
  'iterating',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput())?.lifecycle,
  'ready',
  'GitHub BLOCKED means review is required and should still be review-ready when CI is green',
);
assert.strictEqual(
  parsePullRequestStatus(ghOutput({ reviewDecision: 'APPROVED' }))?.lifecycle,
  'ready',
);

const channels = fs.readFileSync(path.join(root, 'src/shared/constants/channels.ts'), 'utf8');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/git.ipc.ts'), 'utf8');
const gitService = fs.readFileSync(path.join(root, 'src/main/services/git.service.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const indicator = fs.readFileSync(path.join(root, 'src/renderer/components/git/PullRequestStatusIcon.tsx'), 'utf8');
const tabs = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ForkTabs.tsx'), 'utf8');
const commandCenter = fs.readFileSync(path.join(root, 'src/renderer/components/command-center/CommandCenterCell.tsx'), 'utf8');

assert.match(channels, /GIT_PULL_REQUEST_STATUS/);
assert.match(ipc, /getRemotePullRequestJson/);
assert.match(ipc, /getRemoteOriginUrl/);
assert.match(ipc, /normalizeGitHubRepository/);
assert.match(ipc, /getPullRequestStatus\(sessionId\)/);
assert.match(ipc, /pullRequestStatusPending/);
assert.match(ipc, /MAX_CONCURRENT_REMOTE_PULL_REQUEST_LOOKUPS = 2/);
assert.match(ipc, /withRemotePullRequestLookupSlot/);
assert.match(ipc, /getRemotePullRequestLookupSessionId/);
assert.match(ipc, /5 \* 60_000/);
assert.match(gitService, /checkIsRepo\(\)/);
assert.match(preload, /getPullRequestStatus:/);
assert.match(indicator, /refetchInterval: isStreaming \? false : 5 \* 60_000/);
assert.match(indicator, /refetchOnWindowFocus: false/);
assert.match(indicator, /wasStreaming\.current && !isStreaming/);
assert.match(indicator, /GitPullRequestDraft/);
assert.match(indicator, /GitPullRequestArrow/);
assert.match(indicator, /ready for review/);
assert.match(indicator, /PR status unavailable/);
assert.match(indicator, /openExternal\(status\.url\)/);
assert.match(tabs, /<PullRequestStatusIcon sessionId=\{fork\.id\}/);
assert.match(commandCenter, /sessionId=\{displaySession\.id\}/);

console.log('Pull request lifecycle status verification passed.');
