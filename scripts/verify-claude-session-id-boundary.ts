import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  isClaudeSdkSessionId,
  normalizeClaudeSdkSessionId,
} from '../src/shared/utils/claude-session-id';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

const validId = '4217e876-f133-4bfb-be16-e6b6ff00a876';
assert.equal(normalizeClaudeSdkSessionId(validId), validId);
assert.equal(normalizeClaudeSdkSessionId(`  ${validId}  `), validId);
assert.equal(isClaudeSdkSessionId(validId), true);

for (const invalid of ['new', '', 'null', 'undefined', 'sdk-123', 49394, null]) {
  assert.equal(normalizeClaudeSdkSessionId(invalid), undefined, `must reject ${String(invalid)}`);
  assert.equal(isClaudeSdkSessionId(invalid), false, `must not classify ${String(invalid)} as a native id`);
}

const claudeService = read('src/main/services/claude.service.ts');
const sessionService = read('src/main/services/session.service.ts');

assert.match(
  claudeService,
  /const sdkSessionId = normalizeClaudeSdkSessionId\(rawSdkSessionId\);/,
  'normal Claude resume must normalize persisted ids',
);
assert.match(
  claudeService,
  /const forkFromSdkSessionId = forkSourceIsBuildSessionId[\s\S]*?: normalizeClaudeSdkSessionId\(rawForkFromSdkSessionId\);/,
  'fork resume must reject Build ids and normalize its persisted native parent id',
);
assert.match(
  claudeService,
  /\.\.\.\(effectiveForkFromSdkSessionId \? \{ resume: effectiveForkFromSdkSessionId, forkSession: true \} : \{\}\)/,
  'SDK query options may only use the normalized and remotely verified fork source',
);
assert.doesNotMatch(
  claudeService,
  /resume:\s*\(session as any\)\.forkFromSdkSessionId/,
  'raw persisted fork ids must never reach the SDK resume option',
);
assert.match(
  sessionService,
  /parentSdkSessionId = normalizeClaudeSdkSessionId\(/,
  'normal forks must validate the parent native id',
);
assert.match(
  sessionService,
  /parentSession\.sshConfig \? undefined : parentSessionId/,
  'only local sessions may use their Build id as a legacy native-id fallback',
);
assert.doesNotMatch(
  sessionService,
  /rawMappedParentSdkSessionId \|\| parentSession\.sdkSessionId \|\| parentSessionId/,
  'SSH forks must never substitute an internal Build id for a missing native conversation id',
);
assert.match(
  sessionService,
  /parentSession\.sshConfig && parentSdkSessionId \? \{ forkFromSdkSessionId: parentSdkSessionId \} : \{\}/,
  'SSH forks without a native conversation must use cloned Build context',
);
assert.match(
  sessionService,
  /fastStackForkInPlace[\s\S]*?parentSdkSessionId = normalizeClaudeSdkSessionId\(/,
  'Fast Stack must reject sentinels before preparing a native fork',
);
assert.match(
  claudeService,
  /const forkSourceNativeId =[\s\S]*?const forkSourceIsBuildSessionId = Boolean\([\s\S]*?forkSourceNativeId !== rawForkFromSdkSessionId/,
  'runtime must retire legacy fork handles that point at Build sessions without a matching native mapping',
);
assert.match(
  claudeService,
  /delete\(`sessions\.\$\{sessionId\}\.forkFromSdkSessionId`\)/,
  'clearing a stale native session must also clear its one-shot fork handle',
);
assert.match(
  claudeService,
  /const attemptedResumeSessionId = effectiveForkFromSdkSessionId \|\| effectiveSdkSessionId;/,
  'empty-result recovery must cover one-shot fork resumes as well as canonical resumes',
);
assert.match(
  claudeService,
  /const verifiedResumeSessionId = effectiveForkFromSdkSessionId \|\| effectiveSdkSessionId;/,
  'live-owner checks must use the verified/repaired resume handle',
);
assert.match(
  claudeService,
  /this\.clearSdkSessionId\(sessionId\);\s*effectiveSdkSessionId = undefined;\s*effectiveForkFromSdkSessionId = undefined;/,
  'a live or missing resume owner must clear canonical and one-shot fork handles together',
);
assert.match(
  claudeService,
  /repairSshSdkSessionIdFromBuildTranscriptOnce\([\s\S]*?Retiring missing SSH Claude resume/,
  'every SSH Claude resume must verify or repair its remote transcript before spawn',
);
assert.match(
  claudeService,
  /return currentTranscriptFound \? currentSdkSessionId : undefined;/,
  'a missing remote transcript must fall back to authoritative Build context',
);

console.log('Claude session-id boundary verifier passed');
