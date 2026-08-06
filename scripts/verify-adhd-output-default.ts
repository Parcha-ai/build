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
  'Lead with the outcome or required action',
  'Number multi-step tasks',
  'End with one concrete next action only when required',
  'Suppress tangents',
  'Restate active state while work remains',
  'Give specific time estimates',
  'Make completed work visible',
  'Matter-of-fact tone for errors',
  'Cap lists at 5 items',
  'No preamble, no recap, no closing pleasantries',
]) {
  assert.match(skill, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(skill, /Agency comes before presentation/);
assert.match(skill, /do the work before giving the final response/);
assert.match(skill, /Do not replace execution with a plan, an edit recipe, verification commands, an execution handoff, or a status-only report/);
assert.match(skill, /Treat delegated-agent findings as internal evidence/);
assert.match(skill, /Forbidden role-play preambles include "M here, reporting for duty\."/);
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2026 Ayoub Ghriss/);

const service = new AdhdOutputService();
const playbook = service.loadPlaybook();
assert.equal(playbook.skillContent, skill);
assert.match(playbook.systemContext, /<build_default_output_contract/);
assert.match(playbook.systemContext, /every user-facing agent/);
assert.match(playbook.systemContext, /every delegated or sub-agent prompt/);
assert.match(playbook.systemContext, /controls presentation, not agency or task scope/);
assert.match(playbook.systemContext, /Never replace execution with a plan, edit recipe, verification commands, delegated-agent handoff, or status-only report/);
assert.match(playbook.systemContext, /Explicit user formatting instructions and safety requirements override/);

const autoRouterService = read('src/main/services/auto-router.service.ts');
assert.match(autoRouterService, /Execution ownership: when the request is actionable and tools and authority are available, execute it now/);
assert.match(autoRouterService, /Delegation does not transfer ownership to the user/);

const claudeService = read('src/main/services/claude.service.ts');
const sshService = read('src/main/services/ssh.service.ts');
assert.match(claudeService, /append \+= `\\n\\n\$\{adhdOutputService\.getSystemContext\(\)\}`/);
assert.match(
  claudeService,
  /const orchestrationAndPlanContext = \[\s*options\.includeDefaultOutputContext === false \? '' : adhdOutputService\.getSystemContext\(\),\s*autoOrchestrationContext,/,
  'CLI handoffs must include the default contract unless a native instruction layer owns it',
);
assert.match(
  claudeService,
  /const withOutputContract = current\.includes\('<build_default_output_contract'\)[\s\S]{0,180}\[defaultOutputContext, current\]/,
  'non-Codex resumed CLI threads must receive the default contract on every turn',
);
assert.match(claudeService, /const openClawMessage = `\$\{ensureCascadeContext\(\)\}\\n\\n\$\{userMessage\}`/);
assert.match(
  claudeService,
  /stableCodexDeveloperInstructions = \[secureEnvContext, defaultOutputContext\]/,
  'native Codex threads must receive the default contract as stable developer instructions',
);
assert.match(claudeService, /: \[secureEnvContext, ensureCascadeContext\(conversationContext\)\]/);
assert.match(claudeService, /effectiveCursorContext = ensureCascadeContext\(cursorContext\)/);
assert.match(claudeService, /effectiveGeminiContext = ensureCascadeContext\(geminiContext\)/);
assert.match(claudeService, /ensureCascadeContext\(openCodeContext\)/);
assert.match(sshService, /LEGACY_BUNDLED_ADHD_SKILL_SHA256/);
assert.match(sshService, /disableLegacyBundledOutputSkills/);
assert.match(sshService, /build-legacy-disabled-944ddb6a/);
assert.match(
  sshService,
  /runPreSessionSetup[\s\S]*?await this\.disableLegacyBundledOutputSkills/,
  'legacy output-skill migration belongs in one-time SSH session setup, not every model turn',
);

const forgeConfig = read('forge.config.ts');
assert.match(forgeConfig, /resources', 'i-have-adhd/);
assert.match(forgeConfig, /Copied ADHD-friendly output skill/);

console.log('Default ADHD-friendly output contract verification passed.');
