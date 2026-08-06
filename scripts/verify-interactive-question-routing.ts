import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const questionDialog = fs.readFileSync(path.join(root, 'src/renderer/components/chat/QuestionDialog.tsx'), 'utf8');
const commandCenterCell = fs.readFileSync(path.join(root, 'src/renderer/components/command-center/CommandCenterCell.tsx'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.match(
  claudeService,
  /private sessionRenderers: Map<string, WebContents> = new Map\(\);/,
  'interactive requests must retain the renderer that originated each session turn',
);
assert.match(claudeService, /setSessionRenderer\(sessionId: string, renderer: WebContents\): void/);
assert.match(claudeService, /clearSessionRenderer\(sessionId: string, renderer\?: WebContents\): void/);
assert.match(
  claudeService,
  /private sendInteractiveRendererEvent\(sessionId: string, channel: string, payload: unknown\): boolean/,
);
assert.match(
  claudeService,
  /sendInteractiveRendererEvent\(sessionId, IPC_CHANNELS\.CLAUDE_QUESTION_REQUEST, request\)/,
  'AskUserQuestion must target the session renderer instead of the mutable focused window',
);
assert.match(
  claudeService,
  /private recoveredQueryInputs: Map<string, SpawnedProcess\['stdin'\]>/,
  'reattached SSH turns must retain a writable stdin path',
);
assert.match(
  claudeService,
  /handleRecoveredControlMessage[\s\S]*?rawMessage\.type !== 'control_request'[\s\S]*?handleRecoveredCanUseTool/,
  'reattach replay must restore stream-json control requests instead of rendering only transcript prose',
);
assert.match(
  claudeService,
  /type: 'control_response'[\s\S]*?toolUseID: request\.tool_use_id/,
  'recovered user answers must be returned to the waiting Claude CLI control request',
);
assert.match(
  claudeService,
  /sendInteractiveRendererEvent\(sessionId, IPC_CHANNELS\.CLAUDE_PERMISSION_REQUEST, request\)/,
  'permission gates must use the same session-bound renderer path',
);
assert.match(
  claudeService,
  /sendInteractiveRendererEvent\(sessionId, IPC_CHANNELS\.CLAUDE_PLAN_APPROVAL_REQUEST, request\)/,
  'plan approval gates must use the same session-bound renderer path',
);
assert.doesNotMatch(
  claudeService,
  /Question response timeout|Plan approval response timeout/,
  'interactive questions and plans must not expire on a wall-clock timer',
);
assert.match(
  claudeService,
  /for \(const \[reqId, pending\] of this\.pendingPlanApprovals\.entries\(\)\)[\s\S]*?pending\.reject\(new Error\('Query cancelled'\)\)/,
  'cancelling a turn must explicitly settle any pending plan approval',
);

const bindings = claudeIpc.match(/claudeService\.setSessionRenderer\(sessionId, senderContents\);/g) || [];
const cleanups = claudeIpc.match(/claudeService\.clearSessionRenderer\(sessionId, senderContents\);/g) || [];
assert.equal(bindings.length, 2, 'send and remote-resume paths must bind their originating renderer');
assert.equal(cleanups.length, 2, 'send and remote-resume paths must release their renderer binding');

assert.match(questionDialog, /max-h-\[60vh\] overflow-y-auto overscroll-contain/);
assert.match(questionDialog, /useEffect\(\(\) => \{[\s\S]*?\}, \[request\.requestId\]\);/);
assert.match(questionDialog, /answers\[question\.question\]\?\.has\(option\.label\) \|\| false/);
assert.match(
  commandCenterCell,
  /!isFocused && currentQuestion[\s\S]*?Question waiting · click to answer/,
  'an unfocused Command Center cell must visibly advertise a pending question',
);

const guardedQuestionClears = sessionStore.match(
  /state\.pendingQuestion\[sessionId\]\?\.requestId !== request\.requestId/g,
) || [];
assert.equal(
  guardedQuestionClears.length,
  2,
  'answer and cancel must not clear a newer question from a multi-round interview',
);

console.log('interactive question routing verifier passed');
