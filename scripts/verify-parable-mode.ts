import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ParableService } from '../src/main/services/parable.service';
import { filterParableClaudeArguments } from '../src/main/utils/parable-claude-args';
import { filterRemoteClaudeEnvironment } from '../src/main/utils/remote-claude-env';

const root = path.resolve(__dirname, '..');

const remoteParableEnv = filterRemoteClaudeEnvironment({
  ANTHROPIC_API_KEY: 'anthropic-test',
  BUILD_PARABLE_MODE: '1',
  PARABLE_SKILL_DIR: '/home/test/.claude/skills/parable-build',
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  UNRELATED_LOCAL_SECRET: 'must-not-cross-ssh',
});
assert.equal(remoteParableEnv.BUILD_PARABLE_MODE, '1');
assert.equal(remoteParableEnv.PARABLE_SKILL_DIR, '/home/test/.claude/skills/parable-build');
assert.equal(remoteParableEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
assert.equal(remoteParableEnv.UNRELATED_LOCAL_SECRET, undefined);

assert.deepEqual(
  filterParableClaudeArguments([
    '--output-format', 'stream-json',
    '--model', 'claude-fable-5',
    '--resume', 'session-id',
    '--model=gpt-5.6-sol',
    '--effort', 'high',
  ]),
  [
    '--output-format', 'stream-json',
    '--resume', 'session-id',
    '--effort', 'high',
  ],
);

const service = new ParableService();
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'build-parable-home-'));
try {
  const onboardingRuntime = service.prepareRuntime('verify-onboarding', runtimeHome);
  assert.equal(onboardingRuntime.useSubscriptionLauncher, false);
  assert.equal(onboardingRuntime.subscriptionStatus.configured, false);
  assert.equal(path.basename(onboardingRuntime.skillDir), 'parable-build');
  assert.match(fs.readFileSync(onboardingRuntime.skillFile, 'utf8'), /^name: parable-build$/m);
  assert.match(onboardingRuntime.systemContext, /Subscription setup is not staged/);
  assert.match(onboardingRuntime.systemContext, /First-time install/);
  assert.match(onboardingRuntime.systemContext, /parable\.sh/);
  assert.equal(onboardingRuntime.env.PARABLE_CONFIG, undefined);

  const setupCommand = service.buildSetupCommand(['claude', 'chatgpt'], {
    skillDir: onboardingRuntime.skillDir,
  });
  assert.match(setupCommand, /--vendors claude,chatgpt/);
  assert.match(setupCommand, /--build-proxy/);
  assert.match(setupCommand, /--no-auth/);
  assert.doesNotMatch(setupCommand, /xai/);

  const configDir = path.join(runtimeHome, '.config', 'parable');
  const binDir = path.join(runtimeHome, '.local', 'bin');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'parable.toml'), '[parable]\nversion = 1\n', { mode: 0o600 });
  const structuredConfig = service.getConfigData(runtimeHome) as Record<string, any>;
  structuredConfig.parable = { version: 1, default_executor: 'sonnet', default_reviewer: 'opus', log_dir: '.parable', repo_notes: 'Keep edits small.' };
  structuredConfig.claude = { base_url: 'http://127.0.0.1:8317', auth_token_env: 'PARABLE_TEST_TOKEN', brain_model: 'claude-sonnet-5', binary: 'claude' };
  structuredConfig.providers = {
    claude: { type: 'subagent' },
    codex_test: { type: 'codex', base_url: 'https://example.test/v1', env_key: 'CODEX_TEST_KEY', wire_api: 'responses', http_headers: { 'X-Test': 'yes' }, query_params: { region: 'test' } },
    pi_test: { type: 'pi', base_url: 'https://example.test/v1', env_key: 'PI_TEST_KEY', api: 'openai-completions', headers: { 'X-PI': 'yes' }, compat: { supportsDeveloperRole: true } },
  };
  structuredConfig.executors = {
    codex_test: { provider: 'codex_test', model: 'test-model', effort: 'high', enabled: false, cost: { in: 1, out: 2, cache_in: 0.5 }, extra_config: ['model_context_window=1000'] },
    pi_test: { provider: 'pi_test', model: 'test-model', effort: 'high', enabled: false, reasoning: true, model_overrides: { maxTokens: 1000 } },
  };
  structuredConfig.checks = { tests: { run: 'true', cwd: '.', when: ['post-implement'], timeout_minutes: 1, grep: 'error', tail_lines: 12 } };
  structuredConfig.routing = { feature: ['sonnet'], notes: 'Use the best fit.' };
  structuredConfig.research = { provider: 'grep.ai' };
  service.saveConfigData(structuredConfig, runtimeHome);
  const roundTrippedConfig = service.getConfigData(runtimeHome) as Record<string, any>;
  assert.equal(roundTrippedConfig.parable.default_executor, 'sonnet');
  assert.equal(roundTrippedConfig.claude.auth_token_env, 'PARABLE_TEST_TOKEN');
  assert.equal(roundTrippedConfig.providers.codex_test.http_headers['X-Test'], 'yes');
  assert.equal(roundTrippedConfig.providers.codex_test.query_params.region, 'test');
  assert.equal(roundTrippedConfig.providers.pi_test.compat.supportsDeveloperRole, true);
  assert.equal(roundTrippedConfig.executors.codex_test.cost.cache_in, 0.5);
  assert.deepEqual(roundTrippedConfig.executors.codex_test.extra_config, ['model_context_window=1000']);
  assert.equal(roundTrippedConfig.executors.pi_test.model_overrides.maxTokens, 1000);
  assert.equal(roundTrippedConfig.checks.tests.grep, 'error');
  assert.equal(roundTrippedConfig.checks.tests.tail_lines, 12);
  assert.equal(fs.statSync(path.join(configDir, 'parable.toml')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(configDir, 'setup.json'), JSON.stringify({
    schemaVersion: 1,
    vendors: ['claude', 'chatgpt', 'xai'],
  }), { mode: 0o600 });
  const launcherPath = path.join(binDir, 'parable');
  fs.writeFileSync(launcherPath, [
    '#!/bin/sh',
    "printf '%s\\n' '{\"schemaVersion\":1,\"directoryModeValid\":true,\"scanned\":true,\"providers\":{\"claude\":{\"present\":true,\"recordCount\":1},\"chatgpt\":{\"present\":true,\"recordCount\":1},\"xai\":{\"present\":true,\"recordCount\":1}},\"records\":{\"allModesValid\":true}}'",
  ].join('\n'));
  fs.chmodSync(launcherPath, 0o700);

  const readyRuntime = service.prepareRuntime('verify-ready', runtimeHome);
  assert.equal(readyRuntime.useSubscriptionLauncher, true);
  assert.equal(readyRuntime.subscriptionStatus.ready, true);
  assert.deepEqual(readyRuntime.subscriptionStatus.vendors, ['claude', 'chatgpt', 'xai']);
  assert.equal(readyRuntime.subscriptionStatus.providers.chatgpt.present, true);
  assert.equal(readyRuntime.launcherPath, launcherPath);
  assert.match(readyRuntime.systemContext, /upstream launcher owns proxy readiness/);
  assert.match(readyRuntime.systemContext, /user-owned loopback proxy/);
} finally {
  fs.rmSync(runtimeHome, { recursive: true, force: true });
}

const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const settingsDialog = fs.readFileSync(path.join(root, 'src/renderer/components/settings/SettingsDialog.tsx'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const parableIpc = fs.readFileSync(path.join(root, 'src/main/ipc/parable.ipc.ts'), 'utf8');
const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.ts'), 'utf8');

const parableBranch = claudeService.indexOf('if (selectedModel === PARABLE_MODE_ID)');
const autoBuildBranch = claudeService.indexOf("if (selectedModel === 'auto')", parableBranch);
assert.ok(parableBranch >= 0, 'Claude service must resolve the Parable pseudo-model');
assert.ok(autoBuildBranch > parableBranch, 'Parable must resolve before Auto Build');
const parableBranchSource = claudeService.slice(parableBranch, autoBuildBranch);
assert.match(parableBranchSource, /ensureRemoteParableRuntime/);
assert.match(parableBranchSource, /useSubscriptionLauncher: remoteStatus\.ready/);
assert.match(parableBranchSource, /Parable cannot start:/);
assert.match(parableBranchSource, /Connect or deselect these subscription pools/);
assert.doesNotMatch(parableBranchSource, /writeRemoteFile/);
assert.match(claudeService, /createLocalParableClaudeCodeProcess/);
assert.match(claudeService, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'claudette-parable-'\)\)/);
assert.match(claudeService, /exec \$\{shimInvocation\} "\$@"/);
assert.match(claudeService, /PATH: \[shimDir, existingPath\]/);
assert.match(claudeService, /filterParableClaudeArguments\(forwardedArgs\)/);
assert.match(claudeService, /createRemoteParableProcess/);
assert.match(claudeService, /filterParableLauncherPrelude/);
assert.match(claudeService, /const launcherArgs = \[[\s\S]*?'--brain',[\s\S]*?'auto',[\s\S]*?'--'/);
assert.match(sshService, /getRemoteParableSubscriptionStatus/);
assert.match(sshService, /Preparing Parable on this remote host/);
assert.match(sshService, /Installing Parable runtime and proxy/);
assert.match(sshService, /remote upload timed out after 60 seconds/);
assert.match(sshService, /\.build-setup\.lock/);
assert.match(sshService, /\.local\/bin\/parable" install/);
assert.match(sshService, /localConfigText/);
assert.match(sshService, /Remote Parable settings validation failed/);
assert.match(sshService, /PARABLE_CONFIG=\$\{this\.quoteForShell\(temporaryConfigPath\)\}/);
assert.match(sshService, /status\.launcherPath\)\} install/);
assert.match(claudeService, /parableService\.getConfigText\(\)/);
assert.match(sshService, /createRemoteParableProcess/);
assert.match(sshService, /filterRemoteClaudeEnvironment\(sdkOptions\.env\)/);
assert.match(inputArea, /onClick=\{\(\) => selectModel\(PARABLE_MODE_ID\)\}[\s\S]*?\bParable\s*<\/span>/);
assert.match(sessionStore, /getSessionModel\(state, sessionId\) === PARABLE_MODE_ID[\s\S]*?activeStreamModel/);
assert.match(settingsDialog, /Claude Code, multi-model cast/);
assert.match(settingsDialog, /parable\.startSetup/);
assert.match(settingsDialog, /parable\.startAuth/);
assert.match(settingsDialog, /parable\.onAuthEvent/);
assert.match(settingsDialog, /Open authorization page/);
assert.match(settingsDialog, /Device code/);
assert.match(settingsDialog, /Install Parable/);
assert.match(parableIpc, /\['auth', 'add', vendor\]/);
assert.match(parableIpc, /vendor === 'chatgpt'\) args\.push\('--device'\)/);
assert.match(parableIpc, /authorizationUrl/);
assert.match(parableIpc, /userCode/);
assert.match(settingsDialog, /\+ Create agent/);
assert.match(settingsDialog, /Save settings/);
assert.match(settingsDialog, /Verification checks/);
for (const label of [
  'Claude proxy URL',
  'Claude token environment variable',
  'HTTP headers',
  'Query parameters',
  'PI compatibility options',
  'Reasoning model',
  'Input cost',
  'Output cost',
  'Cache input cost',
  'Codex extra configuration',
  'PI model overrides',
  'Failure line pattern',
  'Failure tail lines',
]) {
  assert.ok(settingsDialog.includes(label), `Structured Parable UI must expose ${label}`);
}
assert.match(settingsDialog, /normal controls above cover the current Parable schema/);
assert.match(preload, /PARABLE_CONFIG_GET_DATA/);
assert.match(parableIpc, /parable\.legacy-/);
assert.match(parableIpc, /restored the legacy configuration/);
assert.doesNotMatch(settingsDialog, /Add executor/);
assert.match(preload, /PARABLE_GET_STATUS/);
assert.match(preload, /PARABLE_GET_SETUP_COMMAND/);
assert.match(forgeConfig, /resources[\s\S]*parable/);

const skillDir = path.join(root, 'resources', 'parable');
assert.ok(fs.existsSync(path.join(skillDir, 'parable.sh')));
assert.ok(fs.existsSync(path.join(skillDir, 'runtime', 'bin', 'parable.js')));
assert.ok(fs.existsSync(path.join(skillDir, 'runtime', 'lib', 'onboarding.js')));
assert.ok(fs.existsSync(path.join(skillDir, 'runtime', 'VERSION')));
assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /parable auth login/);
assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /harness is\s+Claude Code/);

console.log('Parable mode verification passed');
