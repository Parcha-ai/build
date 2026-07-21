import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const sharedConfig = read('src/shared/config/zai-glm.ts');
const sharedTypes = read('src/shared/types/index.ts');
const claudeService = read('src/main/services/claude.service.ts');
const codexService = read('src/main/services/codex.service.ts');
const autoRouterService = read('src/main/services/auto-router.service.ts');
const settingsDialog = read('src/renderer/components/settings/SettingsDialog.tsx');
const analyticsService = read('src/main/services/analytics.service.ts');
const modelPricing = read('src/shared/config/model-pricing.ts');
const tokenDashboard = read('src/renderer/components/analytics/TokenDashboard.tsx');

assert.match(
  sharedConfig,
  /ZAI_GLM_CLAUDE_MODEL_PICKER_ID = 'custom:zai-glm-5\.2'/,
  'Shared GLM config must define the Claude Code picker model',
);
assert.match(
  sharedConfig,
  /ZAI_GLM_CODEX_MODEL_PICKER_ID = 'codex:glm-5\.2'/,
  'Shared GLM config must define the Codex picker model',
);
assert.match(
  sharedConfig,
  /ZAI_GLM_CLAUDE_MODEL_ID = 'glm-5\.2\[1m\]'/,
  'Claude Code GLM mode must use the 1M GLM-5.2 model id',
);
assert.match(
  sharedConfig,
  /ZAI_ANTHROPIC_BASE_URL = 'https:\/\/api\.z\.ai\/api\/anthropic'/,
  'Claude Code GLM mode must use the Z.AI Anthropic-compatible endpoint',
);
assert.match(
  sharedConfig,
  /ZAI_OPENAI_COMPAT_BASE_URL = 'https:\/\/api\.z\.ai\/api\/coding\/paas\/v4'/,
  'Codex GLM mode must use the Z.AI OpenAI-compatible endpoint',
);

assert.match(
  sharedTypes,
  /zaiApiKey\?: string/,
  'App settings must persist a Z.AI API key',
);
assert.match(
  settingsDialog,
  /Z\.AI API Key/,
  'Settings UI must expose a Z.AI API key field',
);
assert.match(
  settingsDialog,
  /autoSaveAppSettings\(\{ zaiApiKey: value \}\)/,
  'Settings UI must save the Z.AI API key',
);

assert.match(
  claudeService,
  /isZaiGlmClaudePickerModel\(selectedModel\)[\s\S]*?getZaiGlmClaudeEnvVars/,
  'Claude service must route the GLM picker model through built-in Z.AI env vars',
);
assert.match(
  claudeService,
  /ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL/,
  'Claude GLM env must set ANTHROPIC_BASE_URL',
);
assert.match(
  claudeService,
  /ANTHROPIC_AUTH_TOKEN = apiKey/,
  'Claude GLM env must set ANTHROPIC_AUTH_TOKEN for proxy authentication',
);
assert.match(
  claudeService,
  /this\.store\.get\('zaiApiKey'\)/,
  'Claude GLM key lookup must tolerate top-level legacy storage',
);
assert.match(
  claudeService,
  /ANTHROPIC_MODEL: ZAI_GLM_CLAUDE_MODEL_ID/,
  'Claude GLM env must set ANTHROPIC_MODEL to glm-5.2[1m]',
);
assert.match(
  claudeService,
  /CLAUDE_CODE_AUTO_COMPACT_WINDOW: String\(ZAI_GLM_CONTEXT_WINDOW\)/,
  'Claude GLM env must enable the 1M compact window',
);
assert.match(
  claudeService,
  /!selectedModel\.startsWith\('custom:'\)/,
  'Custom Claude Code proxy models must skip the legacy Anthropic 1M beta flag',
);

assert.match(
  codexService,
  /model_provider="zai"/,
  'Codex GLM mode must inject a Z.AI model provider',
);
assert.match(
  codexService,
  /settingsStore\.get\('zaiApiKey'\)/,
  'Codex GLM key lookup must tolerate top-level legacy storage',
);
assert.match(
  codexService,
  /model_providers\.zai\.base_url/,
  'Codex GLM mode must inject the Z.AI base URL',
);
assert.match(
  codexService,
  /model_providers\.zai\.env_key="ZAI_API_KEY"/,
  'Codex GLM mode must authenticate with ZAI_API_KEY',
);
assert.match(
  codexService,
  /model_context_window=\$\{ZAI_GLM_CONTEXT_WINDOW\}/,
  'Codex GLM mode must set the 1M context window',
);
assert.match(
  codexService,
  /Z\.AI API key is required for GLM 5\.2 via Codex/,
  'Codex GLM mode must produce a targeted missing-key error',
);

assert.match(
  autoRouterService,
  /isZaiGlmCodexModel\(model\)[\s\S]*?hasZaiKey/,
  'Auto router must require a Z.AI key for Codex GLM',
);
assert.match(
  autoRouterService,
  /settingsStore\.get\('zaiApiKey'\)/,
  'Auto router credential checks must tolerate top-level legacy storage',
);
assert.match(
  autoRouterService,
  /model === ZAI_GLM_CLAUDE_MODEL_PICKER_ID[\s\S]*?hasZaiKey/,
  'Auto router must require a Z.AI key for Claude Code GLM',
);

assert.match(
  modelPricing,
  /'glm-5\.2': \{ input: 1\.40, output: 4\.40, cacheRead: 0\.26, cacheWrite: 0 \}/,
  'Analytics must include current GLM-5.2 pricing',
);
assert.match(
  analyticsService,
  /return \/\\b\(codex\|openai\)\\b\/\.test\(lower\) \? 'codex:glm-5\.2' : 'custom:zai-glm-5\.2'/,
  'Historical override inference must recognize GLM mentions',
);
assert.match(
  tokenDashboard,
  /return 'GLM 5\.2'/,
  'Token dashboard must display a clean GLM label',
);

console.log('Z.AI GLM 5.2 support verifier passed');
