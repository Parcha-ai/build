import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const analyticsService = fs.readFileSync(path.join(root, 'src/main/services/analytics.service.ts'), 'utf8');
const analyticsIpc = fs.readFileSync(path.join(root, 'src/main/ipc/analytics.ipc.ts'), 'utf8');
const modelPricing = fs.readFileSync(path.join(root, 'src/shared/config/model-pricing.ts'), 'utf8');
const tokenDashboard = fs.readFileSync(path.join(root, 'src/renderer/components/analytics/TokenDashboard.tsx'), 'utf8');
const harnessPolicy = fs.readFileSync(path.join(root, 'src/main/services/harness-policy.service.ts'), 'utf8');
const parableConfig = fs.readFileSync(path.join(root, 'src/shared/config/parable.ts'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

assert.match(
  claudeService,
  /\{ id: 'claude-opus-5', name: 'Opus 5'/,
  'Claude model picker must expose Opus 5',
);
assert.match(
  claudeService,
  /currentModel\.includes\('opus-5'\)/,
  'Opus 5 must use the native 1M context window size',
);
assert.match(
  claudeService,
  /!selectedModel\.includes\('opus-5'\)/,
  'Opus 5 must skip the legacy 1M context beta flag',
);
assert.match(
  claudeService,
  /supportedModels = \[[\s\S]{0,180}'claude-opus-5'/,
  'Opus 5 must be enabled for the Computer Use API',
);
assert.match(
  claudeService,
  /model\.includes\('opus-5'\)[\s\S]{0,260}return 'computer-use-2025-11-24'/,
  'Opus 5 must use the current Computer Use beta contract',
);
assert.match(
  claudeService,
  /model: this\.resolveCustomModelId\(selectedModel\)/,
  'The selected Opus 5 ID must pass through the shared local and SSH Claude Code launch path',
);

assert.match(
  harnessPolicy,
  /opus-\(\?:5\|4-/,
  'Claude harness policy must enable adaptive thinking for Opus 5',
);
assert.match(
  sessionStore,
  /'claude-opus-5',[\s\S]{0,80}'claude-opus-4-8'/,
  'Renderer fallback model handling must know Opus 5 before prior Opus models',
);
assert.match(
  modelPricing,
  /'claude-opus-5': \{ input: 5, output: 25, cacheRead: 0\.50, cacheWrite: 6\.25 \}/,
  'Analytics pricing must include Opus 5 pricing',
);
assert.match(
  modelPricing,
  /if \(normalized\.includes\('opus'\)\) return MODEL_PRICING\['claude-opus-5'\]/,
  'Analytics pricing fallback must prefer Opus 5 for Opus aliases',
);
assert.match(
  analyticsService,
  /if \(\/\\b\(opus\)\\b\/\.test\(lower\)\) return 'claude-opus-5'/,
  'Historical override inference must map Opus requests to Opus 5',
);
assert.match(
  analyticsIpc,
  /topModel\(selectedByTier\.plan, 'claude-opus-5'\)/,
  'Analytics defaults must report Opus 5 as the current Opus planning model',
);
assert.match(
  tokenDashboard,
  /if \(model\.includes\('opus-5'\)\) return 'Opus 5'/,
  'Token dashboard must display a clean Opus 5 label',
);
assert.match(
  parableConfig,
  /id: 'opus',[\s\S]{0,80}model: 'claude-opus-5'/,
  'New Parable configurations must use Opus 5 for the Opus reviewer',
);

assert.equal(
  packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk'],
  '^0.3.220',
  'Packaged Claude Code SDK must include the Opus 5-era native CLI',
);
assert.equal(
  packageJson.dependencies?.['@anthropic-ai/sdk'],
  '^0.115.0',
  'Anthropic TypeScript SDK must include the Opus 5 model definitions',
);

console.log('Claude Opus 5 support verifier passed');
