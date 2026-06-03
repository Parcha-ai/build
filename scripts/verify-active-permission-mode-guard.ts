import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');

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
  /if \(\s*!planNudgeAction\s*&&\s*!isSending\s*&&\s*!hasQueuedMessages\s*&&\s*shouldSuggestPlanModeNudge\(message, attachments, currentModel, currentMode\)\s*\) \{/,
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

console.log('active permission mode guard verifier passed');
