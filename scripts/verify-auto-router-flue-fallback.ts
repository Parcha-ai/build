import assert from 'assert';
import Module from 'module';

const settings = {
  autoRouterConfig: {
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.3-codex',
    verifyModel: 'gemini:gemini-3.5-flash',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: true,
  },
  cerebrasApiKey: 'invalid-test-key',
  cursorApiKey: 'test-cursor-key',
  geminiApiKey: 'test-gemini-key',
};

let flueAttempts = 0;

class MockStore {
  get(key: string, defaultValue?: unknown): unknown {
    if (key === 'settings') return settings;
    if (key === 'openAiApiKey' || key === 'openaiApiKey') return 'test-openai-key';
    if (key === 'googleApiKey') return 'test-google-key';
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
  if (request === './flue-meta-router.service') {
    return {
      flueMetaRouterService: {
        route: async () => {
          flueAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return null;
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoRouterService } = require('../src/main/services/auto-router.service');

async function main(): Promise<void> {
  const startedAt = Date.now();
  const decision = await autoRouterService.classifyAndRoute(
    'router-flue-fallback',
    'implement the settings change from the plan',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      skipMetaController: false,
    },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(flueAttempts, 1);
  assert.equal(decision.method, 'heuristic');
  assert.equal(decision.tier, 'build');
  assert.equal(decision.resolvedHarness, 'codex');
  assert.equal(decision.resolvedModel, 'codex:gpt-5.3-codex');
  assert.ok(elapsedMs < 250, `Fallback route took ${elapsedMs}ms`);
  assert.ok(!/\bflue\b|meta[- ]harness/i.test(decision.reason), 'Fallback reason leaked controller implementation details');
  assert.ok(!/\bflue\b|meta[- ]harness/i.test(decision.orchestration?.handoffPrompt || ''), 'Fallback handoff leaked controller implementation details');

  console.log('auto-router Flue fallback verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
