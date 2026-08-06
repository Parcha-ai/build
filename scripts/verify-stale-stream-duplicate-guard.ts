import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const transcriptService = fs.readFileSync(path.join(root, 'src/main/services/transcript.service.ts'), 'utf8');
const messageRecovery = fs.readFileSync(path.join(root, 'src/shared/utils/message-recovery.ts'), 'utf8');
const streamFinalization = fs.readFileSync(path.join(root, 'src/shared/utils/stream-finalization.ts'), 'utf8');
const installedVerifier = fs.readFileSync(path.join(root, 'scripts/verify-installed-build-fixes.js'), 'utf8');

assert.match(
  sessionStore,
  /const UNANSWERED_DUPLICATE_USER_PROMPT_WINDOW_MS = 30_000;/,
  'renderer must use a short unanswered duplicate prompt suppression window',
);
assert.match(
  sessionStore,
  /function hasRecentUnansweredDuplicateUserPrompt\(state: SessionState, sessionId: string, message: string\): boolean \{/,
  'renderer must detect unanswered duplicate user prompts',
);
assert.match(
  sessionStore,
  /existingMessage\.role === 'assistant' && hasRecoverableOutput\(existingMessage\)[\s\S]*?return false;/,
  'duplicate suppression must stop once there is assistant output after the previous prompt',
);
assert.match(
  sessionStore,
  /hasRecentUnansweredDuplicateUserPrompt\(state, sessionId, message\)[\s\S]*?Suppressing duplicate unanswered user prompt/,
  'sendMessage must suppress duplicate unanswered prompts before starting another turn',
);
assert.match(
  sessionStore,
  /window\.electronAPI\.claude\.hasActiveQuery\(sessionId\)\.catch\(\(\) => false\)/,
  'sendMessage must check backend active query state when renderer state may be stale',
);
assert.match(
  sessionStore,
  /Backend still has active query for \$\{sessionId\}; queueing instead of starting duplicate turn/,
  'sendMessage must queue when main still owns an active query',
);
assert.match(
  sessionStore,
  /state\.isStreaming\[sessionId\] \|\| state\.isProcessingQueue\[sessionId\] \|\| backendActiveQuery/,
  'queue branch must include backendActiveQuery',
);
assert.match(
  sessionStore,
  /let remoteActiveProcessPromise: Promise<boolean> = Promise\.resolve\(false\);/,
  'renderer must start one live SSH ownership probe for an otherwise idle send',
);
assert.ok(
  sessionStore.indexOf('remoteActiveProcessPromise = currentSession?.sshConfig') > 0
    && sessionStore.indexOf('remoteActiveProcessPromise = currentSession?.sshConfig') < sessionStore.indexOf('// Start streaming immediately'),
  'renderer must start remote process liveness checking before clearing stream state for a new send',
);
assert.match(
  sessionStore,
  /setStreaming\(sessionId, true\);[\s\S]*?const remoteActive = await remoteActiveProcessPromise;/,
  'renderer must show optimistic stream state before awaiting the single remote ownership probe',
);
assert.match(
  sessionStore,
  /previousStreamSnapshot[\s\S]*?hasPreviousStreamSnapshot[\s\S]*?streamEvents: hasPreviousStreamSnapshot/,
  'late remote-active fallback must restore existing stream events after optimistic stream reset',
);
assert.match(
  preload,
  /hasActiveQuery: \(sessionId: string\): Promise<boolean> =>[\s\S]*?IPC_CHANNELS\.CLAUDE_HAS_ACTIVE_QUERY/,
  'preload must expose hasActiveQuery to renderer',
);
assert.match(
  claudeIpc,
  /IPC_CHANNELS\.CLAUDE_HAS_ACTIVE_QUERY[\s\S]*?claudeService\.hasActiveQuery\(sessionId\)/,
  'main IPC must answer renderer backend active-query checks',
);
assert.match(
  sessionStore,
  /queued message after optimistic send and requesting reattach[\s\S]*?startRemoteProcessMonitor\(sessionId, get, set, loadMessages,[\s\S]*?attachStream: true/,
  'remote-active SSH enqueue must immediately request a stream reattach',
);
const sendMessageMethod = sessionStore.slice(
  sessionStore.indexOf('sendMessage: async (sessionId, message, attachments, opts) => {'),
  sessionStore.indexOf('\n  loadMessages:', sessionStore.indexOf('sendMessage: async (sessionId, message, attachments, opts) => {')),
);
assert.equal(
  (sendMessageMethod.match(/window\.electronAPI\.ssh\.hasActiveRemoteProcess\(sessionId\)/g) || []).length,
  1,
  'a send must never perform duplicate sequential remote ownership probes',
);
assert.match(
  claudeIpc,
  /lost its injectable Query object while remote process is still active[\s\S]*?preserving the remote turn, requesting reattach[\s\S]*?CLAUDE_REMOTE_TURN_RECOVERABLE/,
  'main queue must request reattach without aborting a surviving non-injectable SSH turn',
);
assert.doesNotMatch(
  claudeIpc,
  /clearLocalActiveQueryForRemoteReattach/,
  'queue recovery must not clear a live wrapper by aborting its remote process',
);
assert.match(
  installedVerifier,
  /Suppressing duplicate unanswered user prompt/,
  'installed app verifier must assert duplicate guard marker',
);
assert.match(
  messageRecovery,
  /export function isExactLongAssistantDuplicate\(a: ChatMessage, b: ChatMessage\): boolean/,
  'shared recovery must identify exact long assistant duplicates across stale snapshots',
);
assert.match(
  messageRecovery,
  /export function stripTransientStatusLines\(content\?: string\): string/,
  'shared recovery must expose transient retry/status stripping',
);
assert.match(
  messageRecovery,
  /stripTransientStatusLines\(message\.content\)[\s\S]*?message\.contentBlocks\?\.some\(\(block\) => block\.type !== 'text' \|\| stripTransientStatusLines\(block\.text\)\)/,
  'status-only retry messages must not count as recoverable assistant transcript output',
);
assert.match(
  streamFinalization,
  /return stripTransientStatusLines\(selected\);/,
  'final assistant content must drop transient retry/status lines',
);
assert.match(
  streamFinalization,
  /function stripTransientStatusBlocks\(contentBlocks\?: ContentBlock\[\]\): ContentBlock\[\] \| undefined/,
  'final assistant content blocks must drop transient retry/status lines too',
);
assert.doesNotMatch(
  messageRecovery.match(/export function isExactLongAssistantDuplicate[\s\S]*?\n\}/)?.[0] || '',
  /toolSignature|contentBlockSignature/,
  'long assistant duplicate detection must key off visible answer text, not unstable tool ids',
);
assert.match(
  sessionStore,
  /isExactLongAssistantDuplicate\(existing, message\)/,
  'renderer hydration must collapse repeated long assistant rows already stored on disk',
);
assert.match(
  sessionStore,
  /authoritativeBuildTranscript[\s\S]*message\.role !== 'assistant' && normalized\.timestamp\.getTime\(\) > loadedLatest/,
  'authoritative Build transcript hydration must not preserve orphaned in-memory assistant rows',
);
assert.match(
  sessionStore,
  /authoritativeBuildTranscript: hasAuthoritativeBuildTranscript/,
  'loadMessages must pass authoritative Build transcript state into in-memory merge logic',
);
assert.match(
  sessionStore,
  /partialTranscript: Boolean\(applyOptions\.requestedLimit && mergedMessages\.length >= applyOptions\.requestedLimit\)/,
  'limited transcript hydration must be marked as partial so older in-memory rows are preserved',
);
assert.match(
  sessionStore,
  /partial transcript slice/,
  'partial transcript hydration should be logged for diagnosis',
);
assert.match(
  sessionStore,
  /replaceWhileStreaming: startedAsEmptyActiveSession/,
  'empty active-session hydration must allow the backfill load to apply while streaming',
);
assert.match(
  sessionStore,
  /const existingMessages = state\.messages\[sessionId\] \|\| \[\];[\s\S]*?const allowStreamingReplace = options\.replaceWhileStreaming \|\| applyOptions\.replaceWhileStreaming;[\s\S]*?state\.isStreaming\[sessionId\] && !allowStreamingReplace && existingMessages\.length > 0/,
  'loadMessages must only skip active-stream replacement when there are already in-memory messages',
);
assert.match(
  sessionStore,
  /Hydrating empty active session from transcript/,
  'loadMessages must hydrate an empty active SSH session from transcript instead of showing a blank chat',
);
assert.match(
  transcriptService,
  /Collapsed duplicate assistant transcript row by content/,
  'transcript writes must collapse repeated long assistant rows instead of appending them',
);
assert.match(
  transcriptService.slice(
    transcriptService.indexOf('appendMessage(sessionId: string, entry: TranscriptEntry): void'),
    transcriptService.indexOf('upsertMessage(sessionId: string, entry: TranscriptEntry)')
  ),
  /findExactAssistantDuplicateIndex\(existingEntries, entry\)/,
  'appendMessage must collapse exact long assistant duplicates before appending',
);
assert.match(
  transcriptService.slice(
    transcriptService.indexOf('replaceMessages(sessionId: string, entries: TranscriptEntry[])'),
    transcriptService.indexOf('upsertMessages(')
  ),
  /collapseExactAssistantDuplicates\(entries\)/,
  'replaceMessages must normalize exact long assistant duplicates before writing',
);
assert.match(
  transcriptService,
  /MAX_TRANSCRIPT_TOOL_PAYLOAD_CHARS = 50_000/,
  'canonical transcript writes must cap hidden tool payloads so transcript hydration stays fast',
);
assert.match(
  claudeIpc,
  /MAX_TRANSCRIPT_TOOL_PAYLOAD_CHARS = 50_000/,
  'live snapshot transcript writes must cap hidden tool payloads too',
);
assert.match(
  transcriptService,
  /canonicalId: string/,
  'transcript upserts must return the canonical id selected during duplicate collapse',
);
assert.match(
  claudeIpc,
  /const snapshotId = id;[\s\S]*?id = writeAssistantToTranscript\(sessionId, finalizedMessage[\s\S]*?clearInProgressMessage\(sessionId, snapshotId\)/,
  'snapshot writers must adopt the canonical transcript id when the final message is committed',
);
assert.match(
  claudeIpc,
  /if \(snapshotVersion === lastWrittenVersion\) return;/,
  'forced recovery events must not rewrite an unchanged transcript sidecar',
);

console.log('stale stream duplicate guard verifier passed');
