import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.ok(
  inputArea.includes('const modeChangeDisabled = disabled || isSending || hasQueuedMessages;'),
  'InputArea must disable permission mode changes while sending or queued',
);

assert.match(
  inputArea,
  /useEffect\(\(\) => \{\s*if \(isSending \|\| hasQueuedMessages\) \{\s*setShowPlanModeNudge\(false\);\s*\}\s*\}, \[isSending, hasQueuedMessages\]\);/,
  'InputArea must hide the Plan-mode nudge while sending or queued',
);

const planNudgeCondition = inputArea.match(
  /if \(\s*!planNudgeAction\s*&&\s*!isSending\s*&&\s*!hasQueuedMessages\s*&&\s*shouldSuggestPlanModeNudge\(message, attachments, currentModel, currentMode, cascadeActive\)\s*\) \{/,
)?.[0] || '';
assert.ok(
  planNudgeCondition,
  'Plan-mode nudge must not open during active or queued turns',
);

const shiftTabBlock = inputArea.match(
  /if \(e\.key === 'Tab' && e\.shiftKey\) \{[\s\S]*?cyclePermissionMode\(sessionId\);[\s\S]*?return;\s*\}/,
)?.[0] || '';
assert.ok(shiftTabBlock, 'Shift+Tab permission-mode handler must exist');
assert.match(
  shiftTabBlock,
  /if \(modeChangeDisabled\) return;[\s\S]*?cyclePermissionMode\(sessionId\);/,
  'Shift+Tab must not cycle permission mode while sending or queued',
);

const modeButtonBlock = inputArea.match(
  /<button\s+onClick=\{\(\) => cyclePermissionMode\(sessionId\)\}[\s\S]*?>\s*\{modeConfig\.label\}\s*<\/button>/,
)?.[0] || '';
assert.ok(modeButtonBlock, 'permission-mode toolbar button must exist');
assert.match(
  modeButtonBlock,
  /disabled=\{modeChangeDisabled\}/,
  'permission-mode toolbar button must be disabled while sending or queued',
);

assert.match(
  sessionStore,
  /function hasActiveOrQueuedTurn\(state: Pick<SessionState, 'isStreaming' \| 'isProcessingQueue' \| 'activeStreamModel' \| 'activeUserPrompt' \| 'messageQueue'>, sessionId: string\): boolean \{/,
  'Session store must centralize active-or-queued turn detection for permission mode changes',
);

assert.match(
  sessionStore,
  /function canChangePermissionModeDuringActiveTurn\(mode: PermissionMode\): boolean \{\s*return mode === 'bypassPermissions';\s*\}/,
  'Session store must allow only explicit bypass escalation during active turns',
);

const setPermissionModeBlock = sessionStore.match(
  /setPermissionMode: \(sessionId, mode\) => \{[\s\S]*?persistPermissionMode\(sessionId, normalizedMode\);\s*\},/,
)?.[0] || '';
assert.ok(setPermissionModeBlock, 'setPermissionMode implementation must exist');
assert.match(
  setPermissionModeBlock,
  /normalizedMode !== currentMode[\s\S]*?hasActiveOrQueuedTurn\(state, sessionId\)[\s\S]*?!canChangePermissionModeDuringActiveTurn\(normalizedMode\)[\s\S]*?return;/,
  'setPermissionMode must reject non-bypass changes while a turn is active or queued',
);

const cyclePermissionModeBlock = sessionStore.match(
  /cyclePermissionMode: \(sessionId\) => \{[\s\S]*?persistPermissionMode\(sessionId, nextMode\);\s*\},/,
)?.[0] || '';
assert.ok(cyclePermissionModeBlock, 'cyclePermissionMode implementation must exist');
assert.match(
  cyclePermissionModeBlock,
  /if \(hasActiveOrQueuedTurn\(state, sessionId\)\) \{[\s\S]*?return;[\s\S]*?\}/,
  'cyclePermissionMode must reject cycling while a turn is active or queued',
);

console.log('active permission mode guard verifier passed');
