import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');

assert.match(
  service,
  /private async repairSshSdkSessionIdFromBuildTranscript\(/,
  'Claude service must repair SSH SDK resume mappings from the canonical Build transcript',
);
assert.match(
  service,
  /private getBuildUserPromptsForSdkResumeRepair\(sessionId: string, currentUserMessage: string\): string\[\]/,
  'repair must derive significant recent user prompts from the Build transcript',
);
assert.match(
  service,
  /if \(currentMessage && normalized === currentMessage\) continue;/,
  'repair prompt extraction must ignore the current in-flight user message',
);
assert.match(
  service,
  /private getSdkTranscriptPromptMatches\(content: string, prompts: string\[\]\): Set<number>/,
  'repair must compare candidate SDK transcripts against Build prompts',
);
assert.match(
  service,
  /private countContiguousRecentPromptMatches\(matches: Set<number>, promptCount: number\): number/,
  'repair must track contiguous recent prompt continuity, not just total matches',
);
assert.match(
  service,
  /const requiredRecentPrefix = Math\.min\(3, prompts\.length\);/,
  'repair must require enough recent-prefix continuity to catch later wrong-thread follow-ups',
);
assert.match(
  service,
  /let currentTranscriptFound = false;/,
  'repair must distinguish a weak current transcript from a missing mapped transcript',
);
assert.match(
  service,
  /if \(currentSdkSessionId && !currentTranscriptFound\) \{\s*requiredScore = 1;\s*\}/,
  'repair must allow fallback to the best matching candidate when the mapped SDK transcript was deleted',
);
assert.match(
  service,
  /const missingRecentPromptIndex = currentRecentPrefix < prompts\.length \? currentRecentPrefix : undefined;/,
  'repair must target the first significant Build prompt missing from the mapped SDK transcript',
);
assert.match(
  service,
  /const matchedMissingRecentPrompt = typeof missingRecentPromptIndex === 'number'\s*&& matches\.has\(missingRecentPromptIndex\);/,
  'repair must prefer candidates that contain the missing recent Build prompt',
);
assert.match(
  service,
  /sshService\.listRemoteTranscripts\(sessionId, session\.sshConfig, remoteWorkdir\)/,
  'repair must inspect nearby remote Claude transcript candidates',
);
assert.match(
  service,
  /this\.sessionStore\.set\(`sdkSessionMappings\.\$\{sessionId\}`, bestSdkSessionId\)/,
  'repair must persist the corrected SDK mapping before the turn resumes',
);
assert.match(
  service,
  /const sdkSessionId = await this\.repairSshSdkSessionIdFromBuildTranscript\(/,
  'streamMessage must repair the SDK session ID before passing resume to the Claude SDK',
);

const repairCallIndex = service.indexOf('const sdkSessionId = await this.repairSshSdkSessionIdFromBuildTranscript(');
const invalidateIndex = service.indexOf('this.invalidateMessageCache(sessionId);', repairCallIndex);
const resumeOptionIndex = service.indexOf('...(effectiveSdkSessionId ? { resume: effectiveSdkSessionId } : {})', repairCallIndex);
assert.ok(repairCallIndex >= 0, 'repair call must exist in streamMessage');
assert.ok(invalidateIndex > repairCallIndex, 'repair must happen before transcript cache invalidation');
assert.ok(resumeOptionIndex > repairCallIndex, 'repair must happen before Claude SDK resume options are built');

console.log('SSH SDK resume repair verifier passed');
