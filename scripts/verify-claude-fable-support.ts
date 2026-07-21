import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const autoRouterService = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const analyticsService = fs.readFileSync(path.join(root, 'src/main/services/analytics.service.ts'), 'utf8');
const modelPricing = fs.readFileSync(path.join(root, 'src/shared/config/model-pricing.ts'), 'utf8');
const tokenDashboard = fs.readFileSync(path.join(root, 'src/renderer/components/analytics/TokenDashboard.tsx'), 'utf8');
const harnessPolicy = fs.readFileSync(path.join(root, 'src/main/services/harness-policy.service.ts'), 'utf8');

assert.match(
  claudeService,
  /\{ id: 'claude-fable-5', name: 'Fable 5'/,
  'Claude model picker must expose Claude Fable 5',
);
assert.match(
  claudeService,
  /currentModel\.includes\('fable-5'\)/,
  'Claude Fable 5 must use the 1M context window size',
);
assert.match(
  claudeService,
  /!selectedModel\.includes\('fable-5'\)/,
  'Claude Fable 5 must skip the legacy 1M context beta flag',
);
assert.match(
  claudeService,
  /'claude-fable-5'[\s\S]{0,120}'claude-opus-4-6'/,
  'Claude Fable 5 should be allowed wherever the newest Claude Code computer-use-capable models are allowed',
);

assert.match(
  autoRouterService,
  /function isFableModel\(model\?: string\): boolean \{[\s\S]*?claude-fable-5/,
  'Auto Build must recognize Fable for explicit configured routing',
);
assert.match(
  autoRouterService,
  /function frontierClaudeCandidatesForTier\([\s\S]*?configured,[\s\S]*?config\.fallbackModel,[\s\S]*?customTierModels[\s\S]*?claude-fable\|claude-opus/,
  'Auto Build frontier candidates must come from configured tier, fallback, or custom-category models',
);
assert.doesNotMatch(
  autoRouterService,
  /function implicitFrontierClaudeModels|return \['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'\]/,
  'Auto Build must not inject an implicit Opus pool after Opus is removed from settings',
);
assert.match(
  autoRouterService,
  /function isFableAllowedForAutoTier\([\s\S]*?resolveModelForTier\(tier, config\)[\s\S]*?customCategoriesForController\(options\)/,
  'Auto Build must gate Fable on explicit tier or custom category configuration',
);
assert.match(
  autoRouterService,
  /allowFable \|\| !isFableModel\(model\)/,
  'Auto Build learned/model candidate lists must filter unconfigured Fable',
);
assert.doesNotMatch(
  autoRouterService,
  /candidates\.(?:push|unshift)\('claude-fable-5'/,
  'Auto Build must not hard-code Fable into implicit candidate lists',
);
assert.match(
  autoRouterService,
  /\^claude-\(\?:fable\|opus\)/,
  'Cost-aware planning downgrade must treat Fable like other frontier Claude models unless user-configured',
);

assert.match(
  sessionStore,
  /'claude-fable-5'/,
  'Renderer fallback model handling must know about Claude Fable 5',
);
assert.match(
  modelPricing,
  /'claude-fable-5': \{ input: 10, output: 50, cacheRead: 1, cacheWrite: 12\.50 \}/,
  'Analytics pricing must use Fable 5 pricing',
);
assert.match(
  modelPricing,
  /if \(normalized\.includes\('fable'\)\) return MODEL_PRICING\['claude-fable-5'\]/,
  'Analytics pricing fallback must recognize Fable aliases',
);
assert.match(
  analyticsService,
  /if \(\/\\b\(fable\)\\b\/\.test\(lower\)\) return 'claude-fable-5'/,
  'Historical override inference must recognize user requests for Fable',
);
assert.match(
  tokenDashboard,
  /if \(model\.includes\('fable-5'\)\) return 'Fable 5'/,
  'Token dashboard must display a clean Fable 5 label',
);
assert.match(
  harnessPolicy,
  /fable-5\|opus-4-/,
  'Claude harness policy must enable adaptive thinking for Fable 5',
);

console.log('Claude Fable support verifier passed');
