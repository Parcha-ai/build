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
  /private async repairSshSdkSessionIdFromBuildTranscriptOnce\(/,
  'Claude service keeps a guarded repair helper for explicit recovery paths',
);
assert.match(
  service,
  /private sshSdkResumeRepairChecks: Map<string, \{ sdkSessionId\?: string; checkedAt: number \}> = new Map\(\);/,
  'repair wrapper must cache recent checks per session/mapping',
);
assert.match(
  service,
  /SSH_SDK_RESUME_REPAIR_TTL_MS = 30 \* 60 \* 1000/,
  'repair wrapper must avoid repeated remote transcript scans for ordinary follow-ups',
);
assert.match(
  service,
  /Skipping SSH SDK resume repair scan/,
  'repair wrapper must log when a recent check avoids the expensive scan',
);
assert.match(
  service,
  /SSH foreground Claude turn: probing the verified Claude SDK resume owner/,
  'foreground SSH Claude sends must only probe ownership after the stored resume mapping has been verified',
);
assert.match(
  service,
  /getCanonicalMessages\(\s*sessionId,\s*ROUTING_TRANSCRIPT_LIMIT,\s*\{ allowSdkFallback: false \}/,
  'foreground routing must not fall back to remote SDK transcript discovery',
);
assert.match(
  service,
  /Skipping SDK transcript fallback for foreground context/,
  'cheap foreground history mode must leave an observable log marker',
);

const streamMessageStart = service.indexOf('async *streamMessage(');
const cursorRouteIndex = service.indexOf("if (selectedModel?.startsWith('cursor:'))", streamMessageStart);
const eagerRepairIndex = service.indexOf('await this.repairSshSdkSessionIdFromBuildTranscript(', streamMessageStart);
const guardedRepairIndex = service.indexOf('repairSshSdkSessionIdFromBuildTranscriptOnce(', streamMessageStart);
const verifiedResumeIndex = service.indexOf('SSH foreground Claude turn: probing the verified Claude SDK resume owner', streamMessageStart);
const resumeOptionIndex = service.indexOf('...(effectiveSdkSessionId ? { resume: effectiveSdkSessionId } : {})', verifiedResumeIndex);
assert.ok(cursorRouteIndex >= 0, 'Cursor route must exist in streamMessage');
assert.ok(eagerRepairIndex === -1, 'streamMessage must not call the expensive repair implementation directly');
assert.ok(guardedRepairIndex > cursorRouteIndex, 'foreground SSH Claude sends must verify stored resume mappings after non-Claude routes');
assert.ok(verifiedResumeIndex > guardedRepairIndex, 'remote ownership must only be probed after resume verification');
assert.ok(resumeOptionIndex > verifiedResumeIndex, 'verified SSH resume selection must happen before Claude SDK options are built');
assert.match(
  service.slice(guardedRepairIndex, verifiedResumeIndex),
  /if \(!repairedResumeSessionId\)[\s\S]*?this\.clearSdkSessionId\(sessionId\);[\s\S]*?effectiveSdkSessionId = undefined;[\s\S]*?effectiveForkFromSdkSessionId = undefined;/,
  'missing remote transcripts must retire both canonical and one-shot fork resume handles before launch',
);

console.log('SSH SDK resume repair verifier passed');
