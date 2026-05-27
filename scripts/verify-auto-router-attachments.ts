import assert from 'assert';
import Module from 'module';

const settings = {
  autoRouterConfig: {
    categories: [
      { id: 'plan', label: 'Planning', model: 'claude-opus-4-7' },
      { id: 'build', label: 'Execution', model: 'codex:gpt-5.5' },
      { id: 'verify', label: 'Verification', model: 'codex:gpt-5.5' },
      { id: 'refine', label: 'Refinement', model: 'cursor:composer-2.5' },
    ],
    costAware: true,
  },
  cursorApiKey: 'test-cursor-key',
  cerebrasApiKey: '',
};

class MockStore {
  get(key: string, defaultValue?: unknown): unknown {
    if (key === 'settings') return settings;
    if (key === 'openAiApiKey' || key === 'openaiApiKey') return 'test-openai-key';
    return defaultValue;
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

const cliCapabilities = {
  claude: true,
  codex: true,
  cursor: true,
  gemini: true,
  opencode: true,
};

async function main(): Promise<void> {
  const visualRefine = await autoRouterService.classifyAndRoute(
    'router-attachments-refine',
    'now the artifact is missing?',
    {
      isSSH: true,
      remoteCliCapabilities: cliCapabilities,
      attachmentCount: 3,
      attachmentTypes: ['dom_element', 'dom_element', 'image'],
      skipMetaController: true,
    },
  );

  assert.equal(visualRefine.tier, 'refine');
  assert.equal(visualRefine.resolvedModel, 'cursor:composer-2.5');
  assert.equal(visualRefine.resolvedHarness, 'cursor');

  const domOnlyRefine = await autoRouterService.classifyAndRoute(
    'router-attachments-dom-refine',
    'move this up',
    {
      isSSH: true,
      remoteCliCapabilities: cliCapabilities,
      attachmentCount: 1,
      attachmentTypes: ['dom_element'],
      skipMetaController: true,
    },
  );

  assert.equal(domOnlyRefine.tier, 'refine');
  assert.equal(domOnlyRefine.resolvedModel, 'cursor:composer-2.5');
  assert.equal(domOnlyRefine.resolvedHarness, 'cursor');

  const visualBuild = await autoRouterService.classifyAndRoute(
    'router-attachments-build',
    'implement this UI',
    {
      isSSH: true,
      remoteCliCapabilities: cliCapabilities,
      attachmentCount: 1,
      attachmentTypes: ['image'],
      skipMetaController: true,
    },
  );

  assert.equal(visualBuild.tier, 'build');
  assert.equal(visualBuild.resolvedModel, 'codex:gpt-5.5');
  assert.equal(visualBuild.resolvedHarness, 'codex');

  console.log('auto-router attachment routing verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
