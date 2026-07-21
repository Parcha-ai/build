import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { AdhdOutputService } from '../src/main/services/adhd-output.service';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');

const skill = read('resources/i-have-adhd/SKILL.md');
const license = read('resources/i-have-adhd/LICENSE');
assert.match(skill, /^name:\s*i-have-adhd$/m);
assert.match(skill, /responding to ANY user message/);
for (const rule of [
  'Lead with the next action',
  'Number multi-step tasks',
  'End with one concrete next action',
  'Suppress tangents',
  'Restate state every turn',
  'Give specific time estimates',
  'Make completed work visible',
  'Matter-of-fact tone for errors',
  'Cap lists at 5 items',
  'No preamble, no recap, no closing pleasantries',
]) {
  assert.match(skill, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2026 Ayoub Ghriss/);

const service = new AdhdOutputService();
const playbook = service.loadPlaybook();
assert.equal(playbook.skillContent, skill);
assert.match(playbook.systemContext, /<build_default_output_contract/);
assert.match(playbook.systemContext, /every user-facing agent/);
assert.match(playbook.systemContext, /every delegated or sub-agent prompt/);
assert.match(playbook.systemContext, /Explicit user formatting instructions and safety requirements override/);

const claudeService = read('src/main/services/claude.service.ts');
assert.match(claudeService, /append \+= `\\n\\n\$\{adhdOutputService\.getSystemContext\(\)\}`/);
assert.match(
  claudeService,
  /const orchestrationAndPlanContext = \[\s*adhdOutputService\.getSystemContext\(\),\s*autoOrchestrationContext,/,
  'new CLI threads and Auto helper stages must receive the default contract',
);
assert.match(
  claudeService,
  /const withOutputContract = current\.includes\('<build_default_output_contract'\)[\s\S]{0,180}\[defaultOutputContext, current\]/,
  'resumed native CLI threads must receive the default contract on every turn',
);
assert.match(claudeService, /const openClawMessage = `\$\{ensureCascadeContext\(\)\}\\n\\n\$\{userMessage\}`/);
assert.match(claudeService, /codexContext = \[secureEnvContext, ensureCascadeContext\(conversationContext\)\]/);
assert.match(claudeService, /effectiveCursorContext = ensureCascadeContext\(cursorContext\)/);
assert.match(claudeService, /effectiveGeminiContext = ensureCascadeContext\(geminiContext\)/);
assert.match(claudeService, /ensureCascadeContext\(openCodeContext\)/);

const forgeConfig = read('forge.config.ts');
assert.match(forgeConfig, /resources', 'i-have-adhd/);
assert.match(forgeConfig, /Copied ADHD-friendly output skill/);

console.log('Default ADHD-friendly output contract verification passed.');
