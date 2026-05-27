import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';

const settings = {
  autoRouterConfig: {
    categories: [
      { id: 'plan', label: 'Legacy Planning', model: 'claude-haiku-4-5-20251001' },
      { id: 'custom-anything', label: 'Legacy Custom', model: 'cursor:o3' },
    ],
    planModel: 'claude-opus-4-7',
    buildModel: 'codex:gpt-5.5',
    verifyModel: 'gemini:gemini-3.5-flash',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: false,
  },
  cerebrasApiKey: '',
};

class MockStore {
  get(key: string, defaultValue?: unknown): unknown {
    if (key === 'settings') return settings;
    if (key === 'openAiApiKey' || key === 'openaiApiKey') return 'test-openai-key';
    return defaultValue;
  }

  set(): void {
    // Not needed for this verifier.
  }
}

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron-store') {
    return { __esModule: true, default: MockStore };
  }
  if (request === './analytics.service') {
    return {
      analyticsService: {
        getHarnessInsightsForTier: () => [],
        getHarnessInsights: () => [],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoRouterService } = require('../src/main/services/auto-router.service');

const config = autoRouterService.getConfig();
const configRecord = config as typeof config & { categories?: unknown };
const root = path.resolve(__dirname, '..');
const settingsDialog = fs.readFileSync(path.join(root, 'src/renderer/components/settings/SettingsDialog.tsx'), 'utf8');
const sharedTypes = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf8');
const autoRouterSource = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const configWriter = settingsDialog.match(/function autoBuildConfigFromState[\s\S]*?\n}\n\nfunction migrateAutoBuildModels/)?.[0] || '';

async function main(): Promise<void> {
  assert.equal(config.planModel, 'claude-opus-4-7');
  assert.equal(config.buildModel, 'codex:gpt-5.5');
  assert.equal(config.verifyModel, 'gemini:gemini-3.5-flash');
  assert.equal(config.refineModel, 'cursor:composer-2.5');
  assert.equal(config.fallbackModel, 'claude-sonnet-4-6');
  assert.equal(config.costAware, false);
  assert.equal(configRecord.categories, undefined);

  for (const tier of ['plan', 'build', 'verify', 'refine', 'fallback']) {
    assert.match(settingsDialog, new RegExp(`id: '${tier}'`), `Settings UI must expose fixed ${tier} tier row`);
  }

  assert.match(configWriter, /planModel/);
  assert.match(configWriter, /buildModel/);
  assert.match(configWriter, /verifyModel/);
  assert.match(configWriter, /refineModel/);
  assert.match(configWriter, /fallbackModel/);
  assert.doesNotMatch(configWriter, /\bcategories\b/, 'Settings must persist fixed tier fields, not open-ended categories');
  assert.doesNotMatch(settingsDialog, /useFlueMetaHarness|Flue/i, 'Flue must not be exposed as a separate user-selectable mode');
  assert.doesNotMatch(sharedTypes, /useFlueMetaHarness/, 'Auto router config must not include a Flue mode switch');
  assert.doesNotMatch(autoRouterSource, /useFlueMetaHarness/, 'Router must treat Auto Build as the single meta-routing mode');

  autoRouterService.setConfig({
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.5',
    verifyModel: 'codex:gpt-5.5',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: true,
  });

  const decision = await autoRouterService.classifyAndRoute(
    'fixed-settings-plan-model',
    'Review the entire backend architecture and plan a large multi-service migration across the codebase before editing.',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      skipMetaController: true,
    },
  );
  assert.equal(decision.tier, 'plan');
  assert.equal(decision.resolvedModel, 'claude-sonnet-4-6');
  assert.equal(decision.resolvedHarness, 'claude');

  const composerBugFixDecision = await autoRouterService.classifyAndRoute(
    'fixed-settings-composer-localized-bug-fix',
    'Fix the broken modal close button alignment on mobile',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      skipMetaController: true,
    },
  );
  assert.equal(composerBugFixDecision.tier, 'refine');
  assert.equal(composerBugFixDecision.resolvedModel, 'cursor:composer-2.5');
  assert.equal(composerBugFixDecision.resolvedHarness, 'cursor');

  const backendBugFixDecision = await autoRouterService.classifyAndRoute(
    'fixed-settings-backend-bug-fix-stays-build',
    'Fix the failing tests for the auth API regression and update the code until they pass',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      skipMetaController: true,
    },
  );
  assert.equal(backendBugFixDecision.tier, 'build');
  assert.equal(backendBugFixDecision.resolvedModel, 'codex:gpt-5.5');
  assert.equal(backendBugFixDecision.resolvedHarness, 'codex');

  const quotedIssueDecision = await autoRouterService.classifyAndRoute(
    'fixed-settings-no-quoted-issue-escalation',
    'Fix this failing test. Problem statement: I took a closer look at the old failing test and found duplicate media order warnings.',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      skipMetaController: true,
    },
  );
  assert.notEqual(quotedIssueDecision.resolvedModel, 'claude-opus-4-7');

  console.log('auto-router fixed settings verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
