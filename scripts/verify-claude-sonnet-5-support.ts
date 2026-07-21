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
  /\{ id: 'claude-sonnet-5', name: 'Sonnet 5'/,
  'Claude model picker must expose Sonnet 5',
);
assert.match(
  claudeService,
  /currentModel\.includes\('sonnet-5'\)/,
  'Sonnet 5 must use the 1M context window size',
);
assert.match(
  claudeService,
  /!selectedModel\.includes\('sonnet-5'\)/,
  'Sonnet 5 must skip the legacy 1M context beta flag',
);
assert.match(
  claudeService,
  /'claude-sonnet-5'[\s\S]{0,140}'claude-sonnet-4-6'/,
  'Sonnet 5 should be allowed wherever current Sonnet computer-use-capable models are allowed',
);
assert.match(
  claudeService,
  /model\.includes\('sonnet-5'\)[\s\S]{0,160}computer-use-2025-11-24/,
  'Sonnet 5 must use the current Computer Use beta header',
);

assert.match(
  sessionStore,
  /PREFERRED_CLAUDE_FALLBACK_MODELS = \[\s*'claude-sonnet-5'/,
  'Renderer fallback model handling must prefer Sonnet 5 for Claude fallback choices',
);
assert.match(
  autoRouterService,
  /return 'claude-sonnet-5';[\s\S]{0,220}function firstAvailable/,
  'Auto Build cost-aware frontier downgrade should use Sonnet 5',
);
assert.match(
  autoRouterService,
  /config\.fallbackModel,\s*'claude-sonnet-5',\s*'claude-sonnet-4-6'/,
  'Auto Build continuation candidates should include Sonnet 5 before Sonnet 4.6',
);
assert.match(
  autoRouterService,
  /candidates\.push\(config\.planModel, 'claude-sonnet-5', 'claude-sonnet-4-6'\)/,
  'Auto Build planning candidates should include Sonnet 5 before Sonnet 4.6',
);

assert.match(
  modelPricing,
  /'claude-sonnet-5': \{ input: 3, output: 15, cacheRead: 0\.30, cacheWrite: 3\.75 \}/,
  'Analytics pricing must include Sonnet 5 pricing',
);
assert.match(
  modelPricing,
  /if \(normalized\.includes\('sonnet'\)\) return MODEL_PRICING\['claude-sonnet-5'\]/,
  'Analytics pricing fallback must prefer Sonnet 5 for Sonnet aliases',
);
assert.match(
  analyticsService,
  /if \(\/\\b\(sonnet\)\\b\/\.test\(lower\)\) return 'claude-sonnet-5'/,
  'Historical override inference must map Sonnet requests to Sonnet 5',
);
assert.match(
  tokenDashboard,
  /if \(model\.includes\('sonnet-5'\)\) return 'Sonnet 5'/,
  'Token dashboard must display a clean Sonnet 5 label',
);
assert.match(
  harnessPolicy,
  /sonnet-\(\?:5\|4-6\)/,
  'Claude harness policy must enable adaptive thinking for Sonnet 5',
);

console.log('Claude Sonnet 5 support verifier passed');
