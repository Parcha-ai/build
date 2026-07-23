import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CascadeService } from '../src/main/services/cascade.service';
import { CASCADE_MODE_ID } from '../src/shared/config/cascade';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert.equal(CASCADE_MODE_ID, 'cascade');

const upstreamPlaybook = read('resources/cascade/SKILL.md');
const upstreamTemplates = read('resources/cascade/references/templates.md');
assert.match(upstreamPlaybook, /^name:\s*cascade$/m);
assert.match(upstreamPlaybook, /PLAN[\s\S]*ADVANCE[\s\S]*TAKEOVER/);
assert.match(upstreamPlaybook, /No loop advances without its EXIT\.md/);
assert.match(upstreamPlaybook, /AT_BOUND is a first-class exit/);
assert.match(upstreamPlaybook, /Final loop = re-plan gate/);
assert.match(upstreamTemplates, /## Parallel track \(interleave, don't serialize\)/);
assert.match(upstreamTemplates, /## Status: COMPLETE \| AT_BOUND/);

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cascade-'));
try {
  const service = new CascadeService();
  const runtime = service.prepareRuntime(tempHome);
  assert.equal(runtime.skillDir, path.join(tempHome, '.build', 'workflows', 'cascade'));
  assert.equal(runtime.skillFile, path.join(runtime.skillDir, 'SKILL.md'));
  assert.equal(runtime.templatesFile, path.join(runtime.skillDir, 'references', 'templates.md'));
  assert.ok(fs.existsSync(runtime.skillFile));
  assert.ok(fs.existsSync(runtime.templatesFile));
  assert.match(fs.readFileSync(runtime.skillFile, 'utf8'), /^name:\s*cascade-build$/m);
  assert.match(runtime.systemContext, /workflow layered over the model and harness the user selected/);
  assert.match(runtime.systemContext, /Cascade does not select or replace the model/);
  assert.match(runtime.systemContext, /“Parallel track” is dependency bookkeeping/);
  assert.match(runtime.systemContext, /<cascade_playbook/);
  assert.match(runtime.systemContext, /<cascade_templates/);
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

const claudeService = read('src/main/services/claude.service.ts');
const cascadeBranchStart = claudeService.indexOf('if (cascadeMode)');
const parableBranchStart = claudeService.indexOf('if (selectedModel === PARABLE_MODE_ID)', cascadeBranchStart);
assert.ok(cascadeBranchStart > 0, 'Claude service must activate Cascade from its workflow toggle');
assert.ok(parableBranchStart > cascadeBranchStart, 'Cascade overlay must prepare independently before Parable routing');
const cascadeBranch = claudeService.slice(cascadeBranchStart, parableBranchStart);
assert.match(cascadeBranch, /cascadeService\.prepareRuntime/);
assert.match(cascadeBranch, /syncLocalDirectoryToRemote/);
assert.match(cascadeBranch, /~\/.build\/workflows\/cascade/);
assert.doesNotMatch(cascadeBranch, /selectedModel\s*=/, 'Cascade activation must never replace the selected model');
assert.doesNotMatch(claudeService, /id: CASCADE_MODE_ID/, 'Cascade must not appear in the model catalog');
assert.doesNotMatch(claudeService, /selectedModel === CASCADE_MODE_ID/, 'Cascade must not be routed as a pseudo-model');
assert.match(claudeService, /autoOrchestrationContext = withCascadeContext\(parableRuntime\.systemContext\)/);
assert.match(
  claudeService,
  /autoOrchestrationContext = withCascadeContext\(\[\s*approvedPlanHandoffContext,\s*routingDecision\.orchestration\?\.handoffPrompt,/,
);
assert.match(
  claudeService,
  /const codexContext = usesNativeCodexThread[\s\S]*?\[conversationContext, cascadeRuntime\?\.systemContext\][\s\S]*?: \[secureEnvContext, ensureCascadeContext\(conversationContext\)\]/,
);
assert.match(claudeService, /const effectiveCursorContext = ensureCascadeContext\(cursorContext\)/);
assert.match(claudeService, /const effectiveGeminiContext = ensureCascadeContext\(geminiContext\)/);
assert.match(claudeService, /\[secureEnvContext, ensureCascadeContext\(openCodeContext\)\]/);
assert.match(claudeService, /<cascade_runtime_control priority="authoritative">/);
assert.match(claudeService, /Cascade does not replace the selected model or execution strategy/);
assert.match(claudeService, /fastMode\?: boolean,[\s\S]{0,80}cascadeMode\?: boolean/);

const inputArea = read('src/renderer/components/chat/InputArea.tsx');
assert.match(inputArea, /cascade-mode-toggle/);
assert.match(inputArea, /setCascadeMode\(sessionId, !cascadeActive\)/);
assert.match(inputArea, /The selected model will not change/);
assert.match(inputArea, /name: 'cascade'[\s\S]*?itemType: 'cascade'/);
assert.match(inputArea, /name: 'cascade-off'[\s\S]*?cascadeEnabled: false/);
assert.match(inputArea, /trimmed\.match\(\/\^\\\/cascade[\s\S]*?setCascadeMode\(sessionId, enabled\)/);
assert.doesNotMatch(inputArea, /selectModel\(CASCADE_MODE_ID\)/);

const sessionStore = read('src/renderer/stores/session.store.ts');
assert.match(sessionStore, /cascadeMode: Record<string, boolean>/);
assert.match(sessionStore, /setCascadeMode: \(sessionId: string, enabled: boolean\)/);
assert.match(sessionStore, /const isCascadeActive = Boolean\(cascadeMode\[sessionId\]\)/);
assert.match(sessionStore, /userMessage\.id,[\s\S]{0,40}isCascadeActive/);
assert.match(sessionStore, /session\.model === CASCADE_MODE_ID[\s\S]*?model: 'auto', cascadeMode: true/);

const preload = read('src/main/preload.ts');
const claudeIpc = read('src/main/ipc/claude.ipc.ts');
assert.match(preload, /userMessageId\?: string, cascadeMode\?: boolean/);
assert.match(claudeIpc, /userMessageId\?: string, cascadeMode\?: boolean/);
assert.match(claudeIpc, /supplementalMessages, fastMode, cascadeMode/);

const settings = read('src/renderer/components/settings/SettingsDialog.tsx');
assert.match(settings, /model\.id !== PARABLE_MODE_ID && model\.id !== CASCADE_MODE_ID/);

const forgeConfig = read('forge.config.ts');
assert.match(forgeConfig, /resources', 'cascade/);
assert.match(forgeConfig, /Copied Cascade skill/);

console.log('Cascade mode verification passed.');
