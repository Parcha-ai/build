import assert from 'assert';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '../src/shared/types';
import { mergeConversationMessages } from '../src/main/services/codex-context';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const codexContext = fs.readFileSync(path.join(root, 'src/main/services/codex-context.ts'), 'utf8');
const autoRouteBadge = fs.readFileSync(path.join(root, 'src/renderer/components/chat/AutoRouteBadge.tsx'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const messageList = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageList.tsx'), 'utf8');

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: new Date(Date.UTC(2026, 4, 26, 12, 0, 0)),
  };
}

assert.doesNotMatch(
  claudeService,
  /yield\s+(?:withStageSource\()?\{\s*type:\s*'text_delta',\s*content:\s*`[^`]*Auto Build/is,
  'Visible streamed helper text must not introduce Auto Build-branded sections',
);
assert.doesNotMatch(
  claudeService,
  /Auto Build helper (?:could not complete|skipped)/,
  'Visible helper failures must use neutral follow-up wording',
);
assert.doesNotMatch(
  claudeService,
  /Retrying \$\{this\.getAutoBuildStageDisplayTitle\(stage\)[\s\S]{0,160}fallback execution path|available fallback attempts|purpose: `\$\{stage\.purpose\} \(fallback\)`|fallback \$\{attemptIndex\} result/,
  'Visible follow-up retries must not expose fallback orchestration internals',
);
assert.doesNotMatch(
  claudeService,
  /Follow-up step skipped: (?:\$\{stageHarness\}|(?:claude|codex|cursor|gemini|opencode|custom) execution)/i,
  'Visible skipped follow-ups must not reveal the unavailable harness',
);
assert.doesNotMatch(
  claudeService,
  /Follow-up step could not complete: \$\{error\}|formatAutoBuildStageFailure\(event\.error\)|formatAutoBuildStageFailure\(errorMessage\)/,
  'Visible helper failures must not interpolate raw delegate errors',
);
assert.ok(
  claudeService.includes("return 'Follow-up step could not complete.\\n';"),
  'Visible helper failure text should be generic and provider-neutral',
);
assert.doesNotMatch(
  claudeService,
  /You are an Auto Build helper stage running under the Build orchestrator/,
  'Delegate prompts should not encourage helpers to echo Auto Build internals',
);
assert.match(claudeService, /Verification follow-up/);
assert.match(claudeService, /Follow-up step could not complete/);
assert.match(claudeService, /Do not mention internal coordination, routing, model selection/);
assert.doesNotMatch(claudeService, /## Auto Build Ultra Orchestration/);
assert.match(claudeService, /## Turn Scope/);

assert.doesNotMatch(codexContext, /<auto_build_orchestration>/);
assert.match(codexContext, /<turn_scope>/);

assert.match(sessionStore, /AUTO_BUILD_SECTION_MARKERS = \['\\n\\n---\\n\\nFollow-up ', '\\n\\n---\\n\\nAuto Build '\]/);
assert.match(codexContext, /AUTO_BUILD_SECTION_MARKERS = \['\\n\\n---\\n\\nFollow-up ', '\\n\\n---\\n\\nAuto Build '\]/);
assert.match(sessionStore, /<workflow_turn_result>/);
assert.match(sessionStore, /Completed scope:/);
assert.doesNotMatch(sessionStore, /<auto_build_turn_result>/);
assert.doesNotMatch(sessionStore, /Resolved lead:/);
assert.doesNotMatch(sessionStore, /Routing reason:/);
assert.doesNotMatch(sessionStore, /stage\.harness:\$\{stage\.model\}/);

assert.doesNotMatch(autoRouteBadge, /resolvedModel|confidence|leadModel|fallbackModels|Mode:|Stages:| via |getModelShortName|getHarnessShortName/);
assert.doesNotMatch(autoRouteBadge, /Auto Build:/);
assert.match(autoRouteBadge, /Current turn scope:/);
assert.doesNotMatch(
  inputArea,
  /title=\{currentModel === 'auto'[\s\S]{0,600}resolvedModel/,
  'Auto model picker title must not reveal selected model ids while streaming',
);
assert.doesNotMatch(
  inputArea,
  /title=\{currentModel === 'auto'[\s\S]{0,600}confidence/,
  'Auto model picker title must not reveal routing confidence while streaming',
);
assert.doesNotMatch(
  inputArea,
  /<AutoRouteBadge[\s\S]{0,400}resolvedModel/,
  'Auto route badge must not receive model ids for visible display',
);
assert.match(inputArea, /Current turn scope:/);
assert.doesNotMatch(messageList, /AUTO BUILD/);
assert.doesNotMatch(
  messageList,
  /agentDividerLabel[\s\S]{0,400}harness|harness[\s\S]{0,400}agentDividerLabel/,
  'Streaming follow-up dividers must not reveal helper harnesses',
);
assert.match(messageList, /VERIFICATION FOLLOW-UP/);

const base = message('lead', 'Lead answer');
const neutralFollowUp = message('follow-up', 'Lead answer\n\n---\n\nFollow-up verification\n\nChecks passed');
const legacyAutoBuild = message('legacy', 'Lead answer\n\n---\n\nAuto Build VERIFY via gemini:model\n\nChecks passed');

assert.deepEqual(
  mergeConversationMessages([base], [neutralFollowUp]).map((item) => item.id),
  ['follow-up'],
  'Neutral follow-up sections must still replace lead-only transcript copies',
);
assert.deepEqual(
  mergeConversationMessages([base], [legacyAutoBuild]).map((item) => item.id),
  ['legacy'],
  'Legacy Auto Build sections must remain recoverable for existing transcripts',
);

console.log('auto-router indistinguishable verifier passed');
