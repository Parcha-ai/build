import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { transcriptEntriesToChatMessages, type TranscriptEntry } from '../src/main/services/transcript.service';
import { shouldResetNativeHarnessThread } from '../src/shared/utils/harness-switch';

assert.equal(shouldResetNativeHarnessThread('codex', 'codex', { fromHarness: 'claude', toHarness: 'codex' }), true);
assert.equal(shouldResetNativeHarnessThread('codex', 'codex', { fromHarness: 'codex', toHarness: 'codex' }), false);
assert.equal(shouldResetNativeHarnessThread('codex', 'claude', undefined), true);
assert.equal(shouldResetNativeHarnessThread('codex', 'codex', undefined), false);

const root = path.resolve(__dirname, '..');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sessionService = fs.readFileSync(path.join(root, 'src/main/services/session.service.ts'), 'utf8');
const transcriptService = fs.readFileSync(path.join(root, 'src/main/services/transcript.service.ts'), 'utf8');
const channels = fs.readFileSync(path.join(root, 'src/shared/constants/channels.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

const getMessagesHandler = claudeIpc.match(/ipcMain\.handle\(IPC_CHANNELS\.CLAUDE_GET_MESSAGES[\s\S]*?\n {2}\}\);/)?.[0] || '';
assert.match(getMessagesHandler, /claudeService\.getCanonicalMessages\(sessionId, limit\)/);
assert.doesNotMatch(getMessagesHandler, /claudeService\.getMessages\(sessionId, limit\)/);
assert.match(getMessagesHandler, /mergeCompletedStreamMessages\(canonicalMessages, sessionId, limit\)/);

assert.match(channels, /CLAUDE_HAS_BUILD_TRANSCRIPT: 'claude:has-build-transcript'/);
assert.match(channels, /CLAUDE_NOTE_HARNESS_SWITCH: 'claude:note-harness-switch'/);
assert.match(preload, /hasBuildTranscript: \(sessionId: string\): Promise<boolean>/);
assert.match(preload, /noteHarnessSwitch: \(sessionId: string, fromModel: string, toModel: string\): void/);
assert.match(claudeIpc, /CLAUDE_NOTE_HARNESS_SWITCH[\s\S]*?claudeService\.noteHarnessSwitch/);
assert.match(sessionStore, /window\.electronAPI\.claude\.noteHarnessSwitch\(sessionId, previousModel \|\| 'auto', model\)/);
assert.match(claudeService, /pendingHarnessSwitch/);
assert.match(claudeService, /consumePendingHarnessSwitch\(sessionId, selectedModel\)/);
assert.match(claudeService, /shouldResetNativeHarnessThread\('codex', lastHarnessForCodex, pendingHarnessSwitch\)/);
assert.match(claudeService, /codexService\.clearThreadId\(sessionId\)/);
assert.match(claudeService, /includeCurrentHarnessMessages: includeCurrentCodexHistory/);
assert.match(claudeIpc, /IPC_CHANNELS\.CLAUDE_HAS_BUILD_TRANSCRIPT/);
assert.match(claudeIpc, /claudeService\.hasBuildTranscriptForSession\(sessionId\)/);
assert.match(claudeIpc, /function recordCompletedStreamMessage\(sessionId: string, message: ChatMessage\): void \{\s*if \(claudeService\.hasBuildTranscriptForSession\(sessionId\)\) return;/);
assert.match(sessionStore, /hasAuthoritativeBuildTranscript/);
assert.match(sessionStore, /async function hasBuildTranscriptForHydration\(sessionId: string\): Promise<boolean>/);
assert.match(sessionStore, /!window\.electronAPI\.claude\.hasBuildTranscript/);
assert.match(sessionStore, /const supplementalMessagesForContext = hasAuthoritativeBuildTranscript\s*\?\s*\[\]\s*:\s*loadSupplementalMessagesForModelContext\(sessionId\)/);
assert.match(sessionStore, /hasAuthoritativeBuildTranscript\s*\?\s*\[\]\s*:\s*loadSupplementalMessages\(sessionId\)/);
assert.match(sessionStore, /if \(hasAuthoritativeBuildTranscript && loadSupplementalMessages\(sessionId\)\.length > 0\) \{/);

assert.match(claudeService, /transcriptPath: string;/);
assert.match(claudeService, /private transcriptPathCache = new Map<string, \{ sdkSessionId: string; transcriptPath: string \}>\(\);/);
assert.match(claudeService, /if \(cached\.transcriptPath !== transcriptPath\) \{/);
assert.match(claudeService, /Cache invalidated - transcript path changed/);

const transcriptPathMethod = claudeService.match(/private findTranscriptPath\(sessionId: string, sdkSessionId: string\): string \| null \{[\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(transcriptPathMethod, /cached\.sdkSessionId === sdkSessionId/);
assert.match(transcriptPathMethod, /path\.basename\(cached\.transcriptPath\) === `\$\{sdkSessionId\}\.jsonl`/);
assert.match(transcriptPathMethod, /fs\.existsSync\(cached\.transcriptPath\)/);
assert.match(transcriptPathMethod, /this\.transcriptPathCache\.delete\(sessionId\)/);
assert.match(transcriptPathMethod, /this\.transcriptPathCache\.set\(sessionId, \{ sdkSessionId, transcriptPath \}\)/);

const parseTranscriptsFromDirMethod = claudeService.match(/private parseTranscriptsFromDir\(dir: string, sdkSessionId\?: string\): ChatMessage\[] \{[\s\S]*?\n {2}\}/)?.[0] || '';
const requestedMissingIndex = parseTranscriptsFromDirMethod.indexOf('Requested SDK transcript not found; refusing to load a different transcript');
const loadMostRecentIndex = parseTranscriptsFromDirMethod.indexOf('Loading most recent transcript');
assert.ok(requestedMissingIndex >= 0, 'Missing requested SDK transcript guard');
assert.ok(loadMostRecentIndex >= 0, 'Missing legacy most-recent transcript fallback');
assert.ok(requestedMissingIndex < loadMostRecentIndex, 'SDK-specific missing transcript must return before legacy fallback');
assert.match(parseTranscriptsFromDirMethod, /return \[\];/);

const canonicalMethod = claudeService.match(/async getCanonicalMessages\([\s\S]*?Promise<ChatMessage\[]> \{[\s\S]*?\n {2}\}/)?.[0] || '';
const buildLoadIndex = canonicalMethod.indexOf('this.loadBuildTranscriptForSession(sessionId)');
const claudeLoadIndex = canonicalMethod.indexOf('const claudeMessages');
assert.ok(buildLoadIndex >= 0, 'Canonical messages must load Build transcript entries');
assert.ok(claudeLoadIndex >= 0, 'Canonical messages must retain Claude legacy backfill');
assert.ok(buildLoadIndex < claudeLoadIndex, 'Build transcript must be considered before Claude transcript');
assert.match(canonicalMethod, /if \(buildTranscript\.exists\)/);
assert.match(canonicalMethod, /options: \{ allowSdkFallback\?: boolean \} = \{\}/);
assert.match(canonicalMethod, /if \(options\.allowSdkFallback === false\) \{/);
assert.match(canonicalMethod, /Skipping SDK transcript fallback for foreground context/);
assert.match(canonicalMethod, /return filterInternalPromptEchoes\(limit && limit > 0/);
assert.match(canonicalMethod, /transcriptService\.upsertMessages\(buildTranscript\.sessionId, usableClaudeMessages/);

assert.match(claudeService, /private getCanonicalTranscriptCandidateIds\(sessionId: string\): string\[\]/);
assert.match(claudeService, /sdkSessionMappings/);
assert.match(claudeService, /continuedFromSessionId/);
assert.match(claudeService, /relatedSessionIds/);
assert.match(claudeService, /preferredIds/);
assert.match(claudeService, /private getBuildTranscriptLatestTime\(candidateId: string, entries: TranscriptEntry\[]\): number/);
assert.match(claudeService, /private loadBuildTranscriptForSession\(sessionId: string\)/);
assert.match(claudeService, /const usableTranscripts = transcripts\.filter/);
assert.match(claudeService, /const withAssistant = usableTranscripts\.filter/);
assert.match(claudeService, /const timeDelta = b\.latestTime - a\.latestTime/);
assert.match(claudeService, /hasBuildTranscriptForSession\(sessionId: string\): boolean/);
assert.match(claudeService, /Using freshest Build transcript alias/);
assert.doesNotMatch(claudeService, /if \(candidateId === sessionId && entries\.length > 0\) \{\s*return \{ sessionId: candidateId, entries, exists: true \};\s*\}/);
assert.match(
  claudeService,
  /const includeCurrentClaudeHarness = !effectiveSdkSessionId;/,
  'Claude must include prior Claude turns when SDK resume is unavailable',
);
assert.match(
  claudeService,
  /includeCurrentClaudeHarness \? undefined : 'claude'/,
  'Build transcript continuity must not filter out Claude messages after resume is cleared',
);
assert.match(
  claudeService,
  /Recent Build Session Context/,
  'Full Build transcript context must use a clear system prompt label',
);
assert.match(
  claudeService,
  /<build_session_continuity>/,
  'Full Build transcript fallback must pin authoritative continuity before raw history',
);
assert.match(
  claudeService,
  /filterMessagesForBuildContinuityContext/,
  'Full Build transcript fallback must filter false no-context assistant replies',
);
assert.match(
  claudeService,
  /isFalseNoContextAssistantMessage/,
  'Build transcript fallback must identify stale fresh-conversation replies',
);
assert.match(
  claudeService,
  /authoritative over any earlier assistant message claiming missing context/,
  'Pinned continuity context must override stale no-context assistant replies',
);
assert.match(
  claudeService,
  /const continuityMessages = includeCurrentClaudeHarness[\s\S]*?this\.filterMessagesForBuildContinuityContext\(merged\)[\s\S]*?: merged;/,
  'Claude fallback context must clean the Build transcript before injecting it',
);
assert.match(
  claudeService,
  /const pinnedBuildContinuityContext = this\.buildBuildSessionContinuityContext\(\s*sessionId,\s*session,\s*includeCurrentClaudeHarness \? continuityMessages/,
  'Claude fallback context must prepend a pinned Build session continuity block',
);
assert.match(
  claudeService,
  /Claude \$\{includeCurrentClaudeHarness \? 'Build transcript' : 'cross-harness'\} context/,
  'Claude continuity logging must distinguish full Build transcript context from cross-harness context',
);

assert.match(sessionService, /resolveBuildSessionIdForDiscoveredSession/);
assert.match(sessionService, /const canonicalId = this\.resolveBuildSessionIdForDiscoveredSession/);
assert.match(sessionService, /sessionMap\.set\(canonicalId/);
assert.match(sessionService, /canonicalId !== id/);

assert.match(transcriptService, /Persists ALL harness messages/);
assert.match(transcriptService, /~\/\.build\/transcripts\/\{sessionId\}\.jsonl/);
assert.match(transcriptService, /mergeRecoveredStreamMessages\(existingMessages, incomingMessages\)/);
assert.match(sessionStore, /function mergeDuplicateTimelineMessage\(existing: ChatMessage, incoming: ChatMessage\): ChatMessage/);
assert.match(sessionStore, /seenIds\.has\(message\.id\)[\s\S]*?mergeDuplicateTimelineMessage\(deduped\[existingIndex\], message\)/);
assert.doesNotMatch(sessionStore, /if \(seenIds\.has\(message\.id\)\) \{\s*continue;\s*\}/);

const recoveredEntries: TranscriptEntry[] = [
  {
    id: 'assistant-codex',
    role: 'assistant',
    content: 'Codex survived reload',
    timestamp: '2026-05-29T12:00:00.000Z',
    harness: 'codex',
    model: 'codex:gpt-5.5',
    toolCalls: [{ id: 'tool-1', name: 'Read', input: '{"file_path":"src/app.ts"}', result: 'plain text result' }],
  },
];
const recoveredMessages = transcriptEntriesToChatMessages(recoveredEntries);
assert.equal(recoveredMessages.length, 1);
assert.equal(recoveredMessages[0].harness, 'codex');
assert.equal(recoveredMessages[0].content, 'Codex survived reload');
assert.equal(recoveredMessages[0].toolCalls?.[0]?.name, 'Read');

console.log('build transcript precedence verifier passed');
