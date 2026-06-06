import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildLocalModeAutoRouterConfig,
  buildOpenCodeOllamaProviderConfig,
  getLocalModeModel,
  getLocalModeModelEntries,
  getOllamaModelName,
  isLocalModeEnabled,
  isLocalOllamaModel,
  LOCAL_MODE_DEFAULT_MODEL,
  LOCAL_MODE_DEFAULT_OLLAMA_BASE_URL,
  normalizeLocalOllamaModelId,
} from '../src/shared/local-mode';

const root = path.join(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert.equal(LOCAL_MODE_DEFAULT_MODEL, 'opencode:ollama/qwen3-coder-64k');
assert.equal(LOCAL_MODE_DEFAULT_OLLAMA_BASE_URL, 'http://localhost:11434/v1');
assert.equal(getOllamaModelName('opencode:ollama/qwen3-coder-64k'), 'qwen3-coder-64k');
assert.equal(getOllamaModelName('ollama/qwen2.5-coder:1.5b'), 'qwen2.5-coder:1.5b');
assert.equal(isLocalOllamaModel('opencode:ollama/qwen3-coder-64k'), true);
assert.equal(isLocalOllamaModel('opencode:deepseek-v4-pro'), false);
assert.equal(isLocalOllamaModel('claude-sonnet-4-6'), false);
assert.equal(isLocalModeEnabled({ localModeEnabled: true }), true);
assert.equal(getLocalModeModel({}), LOCAL_MODE_DEFAULT_MODEL);
assert.equal(normalizeLocalOllamaModelId('qwen3-coder-64k'), 'opencode:ollama/qwen3-coder-64k');
assert.equal(normalizeLocalOllamaModelId('ollama/qwen3-coder-64k'), 'opencode:ollama/qwen3-coder-64k');
assert.equal(normalizeLocalOllamaModelId('opencode:deepseek-v4-pro'), LOCAL_MODE_DEFAULT_MODEL);
assert.equal(getLocalModeModel({ localModeModel: 'qwen3-coder-64k' }), 'opencode:ollama/qwen3-coder-64k');

const customSettings = {
  localModeEnabled: true,
  localModeModel: 'opencode:ollama/custom-64k',
  localModeSmallModel: 'opencode:ollama/custom-small',
  localOllamaBaseUrl: 'http://127.0.0.1:11434/v1',
};
assert.equal(getLocalModeModel(customSettings), 'opencode:ollama/custom-64k');
assert.ok(getLocalModeModelEntries(customSettings).some((entry) => entry.id === 'opencode:ollama/custom-64k'));

const routerConfig = buildLocalModeAutoRouterConfig('opencode:ollama/custom-64k');
assert.deepEqual(
  [routerConfig.planModel, routerConfig.buildModel, routerConfig.verifyModel, routerConfig.refineModel, routerConfig.fallbackModel],
  Array(5).fill('opencode:ollama/custom-64k'),
);
assert.equal(routerConfig.costAware, false);

const providerConfig = buildOpenCodeOllamaProviderConfig(customSettings);
assert.equal(providerConfig.provider.ollama.npm, '@ai-sdk/openai-compatible');
assert.equal(providerConfig.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
assert.equal(providerConfig.provider.ollama.models['custom-64k'].tools, true);
assert.equal(providerConfig.provider.ollama.models['custom-small'].tools, true);
assert.equal(providerConfig.autoupdate, false);
assert.equal(providerConfig.share, 'disabled');

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
assert.equal(packageJson.scripts?.['setup:local-mode'], 'bash scripts/setup-local-mode-ollama.sh');

const setupScriptSource = read('scripts/setup-local-mode-ollama.sh');
assert.match(setupScriptSource, /ollama pull "\$RAW_MODEL"/);
assert.match(setupScriptSource, /ollama create "\$PRIMARY_TAG"/);
assert.match(setupScriptSource, /opencode run "say ok" --model "ollama\/\$PRIMARY_TAG"/);
assert.match(setupScriptSource, /brew install \$brew_args/);
assert.match(setupScriptSource, /warmup-result\.txt/);
assert.match(setupScriptSource, /search for LOCAL_MODE_WARMUP/);

const typesSource = read('src/shared/types/index.ts');
assert.match(typesSource, /localModeEnabled\?: boolean/);
assert.match(typesSource, /localModeModel\?: string/);
assert.match(typesSource, /localOllamaBaseUrl\?: string/);
assert.match(typesSource, /localModeDisableLspDownload\?: boolean/);

const settingsSource = read('src/main/services/settings.service.ts');
assert.match(settingsSource, /localModeEnabled: false/);
assert.match(settingsSource, /localModeModel: LOCAL_MODE_DEFAULT_MODEL/);
assert.match(settingsSource, /localOllamaBaseUrl: LOCAL_MODE_DEFAULT_OLLAMA_BASE_URL/);
assert.match(settingsSource, /normalizeLocalOllamaModelId\(updates\.localModeModel/);

const claudeSource = read('src/main/services/claude.service.ts');
assert.match(claudeSource, /Local Mode enabled; exposing local-only model list/);
assert.match(claudeSource, /Local Mode overriding selected model/);
assert.match(claudeSource, /selectedModel = localModel/);
assert.match(claudeSource, /Local Mode is enabled but this is an SSH session/);
assert.match(claudeSource, /getLocalModeModelEntries\(settings\)/);
assert.ok(
  claudeSource.indexOf('Local Mode is enabled but this is an SSH session') < claudeSource.indexOf('this.setActiveQuery(sessionId, abortController)'),
  'Local Mode SSH guard must run before active-query registration',
);

const autoRouterSource = read('src/main/services/auto-router.service.ts');
assert.match(autoRouterSource, /buildLocalModeAutoRouterConfig\(getLocalModeModel\(settings\)\)/);
assert.match(autoRouterSource, /isLocalOllamaModel\(model\)/);
assert.match(autoRouterSource, /return !options\?\.isSSH && hasOpenCodeCli\(\)/);

const openCodeSource = read('src/main/services/opencode.service.ts');
assert.match(openCodeSource, /const localOllamaModel = isLocalOllamaModel\(opencodeModel\)/);
assert.match(openCodeSource, /if \(!apiKey && !localOllamaModel\)/);
assert.match(openCodeSource, /OPENCODE_DISABLE_MODELS_FETCH = 'true'/);
assert.match(openCodeSource, /OPENCODE_DISABLE_LSP_DOWNLOAD = 'true'/);
assert.match(openCodeSource, /Local Mode uses Ollama on this Mac/);
assert.match(openCodeSource, /Local Mode requires an installed OpenCode CLI binary/);
assert.match(openCodeSource, /localOllamaModel \? this\.getOfflineSafeCommand\(\) : this\.getCommand\(\)/);

const mcpSource = read('src/main/services/mcp.service.ts');
assert.match(mcpSource, /buildOpenCodeOllamaProviderConfig\(settings\)/);
assert.match(mcpSource, /data\.enabled_providers = \['ollama'\]/);
assert.match(mcpSource, /mergeOpenCodeOllamaProvider/);
assert.match(mcpSource, /Local Mode enabled; skipping MCP registry fetch/);

const authSource = read('src/main/ipc/auth.ipc.ts');
assert.match(authSource, /localModeReady = isLocalModeEnabled\(settings\) && cli\.installed/);
assert.match(authSource, /npx is not offline-safe/);
assert.match(authSource, /add DeepSeek key or enable Local Mode/);

const updateSource = read('src/main/services/update.service.ts');
assert.match(updateSource, /Local Mode enabled; update checks disabled/);
assert.match(updateSource, /Local Mode enabled; skipping update check/);
assert.match(updateSource, /isLocalModeEnabled\(settings\)/);

const settingsDialogSource = read('src/renderer/components/settings/SettingsDialog.tsx');
assert.match(settingsDialogSource, /Local Mode/);
assert.match(settingsDialogSource, /localModeEnabled/);
assert.match(settingsDialogSource, /localModeDisableLspDownload/);
assert.match(settingsDialogSource, /normalizeLocalOllamaModelId/);
assert.match(settingsDialogSource, /npm run setup:local-mode/);
assert.match(settingsDialogSource, /OPENCODE_DISABLE_MODELS_FETCH=true opencode run/);

const inputAreaSource = read('src/renderer/components/chat/InputArea.tsx');
assert.match(inputAreaSource, /groupOrder = \['claude', 'local'/);
assert.match(inputAreaSource, /isLocalOllamaModel\(model\.id\)/);
assert.match(inputAreaSource, /local: 'Local'/);

assert.match(read('src/main/services/analytics.service.ts'), /if \(isLocalModeEnabled\(settings\)\) return/);
assert.match(read('src/main/services/session-title.service.ts'), /if \(isLocalModeEnabled\(settings\)\) return null/);
assert.match(read('src/main/services/session.service.ts'), /Local Mode enabled; skipping cloud name generation/);
assert.match(read('src/main/index.ts'), /Local Mode blocked renderer network request/);
assert.match(read('src/main/ipc/settings.ipc.ts'), /Local Mode blocked remote external URL/);
assert.match(read('src/renderer/components/common/ReleaseNotes.tsx'), /settings\.localModeEnabled/);

console.log('local mode OpenCode/Ollama verifier passed');
