import assert from 'assert';
import { normalizeMetaEffort, prependPolicyPreamble, translateHarnessPolicy } from '../src/main/services/harness-policy.service';

const missionPolicy = {
  effort: 'ultracode',
  speed: 'fast' as const,
  workflow: 'dynamic' as const,
  budgetUsd: 50,
  verification: 'required' as const,
};

assert.equal(normalizeMetaEffort('off'), 'low');
assert.equal(normalizeMetaEffort('thinking'), 'medium');
assert.equal(normalizeMetaEffort('ultrathink'), 'high');
assert.equal(normalizeMetaEffort('ultracode'), 'max');

const claudePolicy = translateHarnessPolicy({
  harness: 'claude',
  model: 'claude-opus-4-8',
  policy: missionPolicy,
  permissionMode: 'bypassPermissions',
});
assert.equal(claudePolicy.effort, 'max');
assert.equal(claudePolicy.speed, 'fast');
assert.equal(claudePolicy.workflow, 'dynamic');
assert.equal(claudePolicy.budgetUsd, 50);
assert.equal(claudePolicy.verification, 'required');
assert.equal(claudePolicy.env.BUILD_META_EFFORT, 'max');
assert.equal(claudePolicy.env.BUILD_META_SPEED, 'fast');
assert.equal(claudePolicy.env.BUILD_META_WORKFLOW, 'dynamic');
assert.equal(claudePolicy.env.BUILD_META_BUDGET_USD, '50');
assert.equal(claudePolicy.env.BUILD_META_VERIFICATION, 'required');
assert.equal(claudePolicy.claude?.effort, 'max');
assert.deepEqual(claudePolicy.claude?.thinking, { type: 'adaptive', display: 'summarized' });
assert.equal(claudePolicy.claude?.fastMode, true);

const legacyClaudePolicy = translateHarnessPolicy({
  harness: 'claude',
  model: 'claude-sonnet-4-5',
  policy: { effort: 'high' },
});
assert.equal(legacyClaudePolicy.claude?.effort, 'high');
assert.equal(legacyClaudePolicy.claude?.maxThinkingTokens, 100000);

const codexPolicy = translateHarnessPolicy({
  harness: 'codex',
  model: 'codex:gpt-5.5',
  policy: missionPolicy,
});
assert.equal(codexPolicy.codex?.modelReasoningEffort, 'xhigh');
assert.match(codexPolicy.promptPreamble || '', /Workflow: dynamic/);
assert.match(codexPolicy.promptPreamble || '', /Budget cap: \$50\.00/);

const cursorPlanPolicy = translateHarnessPolicy({
  harness: 'cursor',
  model: 'cursor:composer-2.5',
  policy: missionPolicy,
  permissionMode: 'plan',
});
assert.equal(cursorPlanPolicy.cursor?.mode, 'plan');
assert.equal(cursorPlanPolicy.cursor?.sandbox, 'enabled');

const cursorAskPolicy = translateHarnessPolicy({
  harness: 'cursor',
  model: 'cursor:o3',
  policy: missionPolicy,
  permissionMode: 'dontAsk',
});
assert.equal(cursorAskPolicy.cursor?.mode, 'ask');
assert.equal(cursorAskPolicy.cursor?.sandbox, 'enabled');

const geminiAutoEditPolicy = translateHarnessPolicy({
  harness: 'gemini',
  model: 'gemini:gemini-3.5-flash',
  policy: missionPolicy,
  permissionMode: 'acceptEdits',
});
assert.equal(geminiAutoEditPolicy.gemini?.approvalMode, 'auto_edit');

const geminiYoloPolicy = translateHarnessPolicy({
  harness: 'gemini',
  model: 'gemini:gemini-3.5-pro',
  policy: missionPolicy,
  permissionMode: 'bypassPermissions',
});
assert.equal(geminiYoloPolicy.gemini?.approvalMode, 'yolo');

const opencodePolicy = translateHarnessPolicy({
  harness: 'opencode',
  model: 'opencode:qwen-3-coder',
  policy: missionPolicy,
});
assert.match(opencodePolicy.promptPreamble || '', /Harness: opencode/);

const localOpenCodePolicy = translateHarnessPolicy({
  harness: 'opencode',
  model: 'opencode:ollama/qwen3-coder-64k',
  policy: { effort: 'high', speed: 'standard' },
  permissionMode: 'acceptEdits',
});
assert.equal(localOpenCodePolicy.env.BUILD_META_EFFORT, 'high');
assert.equal(localOpenCodePolicy.env.BUILD_META_SPEED, 'standard');
assert.match(localOpenCodePolicy.promptPreamble || '', /Harness: opencode/);
assert.match(localOpenCodePolicy.promptPreamble || '', /Speed: standard/);

const goalPrompt = prependPolicyPreamble('/goal ship the fix\nThen run tests.', '<policy/>');
assert.equal(goalPrompt, '/goal ship the fix\n\n<policy/>\n\nThen run tests.');

console.log('harness policy translation verifier passed');
