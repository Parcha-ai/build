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
  /const forkFromSdkSessionId = normalizeClaudeSdkSessionId\(rawForkFromSdkSessionId\);/,
  'fork resume must normalize its persisted parent id',
);
assert.match(
  claudeService,
  /\.\.\.\(forkFromSdkSessionId \? \{ resume: forkFromSdkSessionId, forkSession: true \} : \{\}\)/,
  'SDK query options may only use the normalized fork source',
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
  /parentSession\.sshConfig && parentSdkSessionId \? \{ forkFromSdkSessionId: parentSdkSessionId \} : \{\}/,
  'SSH forks without a native conversation must use cloned Build context',
);
assert.match(
  sessionService,
  /fastStackForkInPlace[\s\S]*?parentSdkSessionId = normalizeClaudeSdkSessionId\(/,
  'Fast Stack must reject sentinels before preparing a native fork',
);

console.log('Claude session-id boundary verifier passed');
