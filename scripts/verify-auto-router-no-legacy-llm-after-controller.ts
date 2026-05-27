import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';

const settings = {
  autoRouterConfig: {
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.3-codex',
    verifyModel: 'gemini:gemini-3.5-flash',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: true,
  },
  cerebrasApiKey: 'test-cerebras-key',
  cursorApiKey: 'test-cursor-key',
  geminiApiKey: 'test-gemini-key',
};

let controllerAttempts = 0;
let fetchAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchAttempts += 1;
  throw new Error('legacy direct LLM classifier should not run after controller attempt');
}) as typeof fetch;

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
          controllerAttempts += 1;
          return null;
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoRouterService } = require('../src/main/services/auto-router.service');
const autoRouterSource = fs.readFileSync(path.resolve(__dirname, '../src/main/services/auto-router.service.ts'), 'utf8');
const sharedTypesSource = fs.readFileSync(path.resolve(__dirname, '../src/shared/types/index.ts'), 'utf8');

async function main(): Promise<void> {
  try {
    const decision = await autoRouterService.classifyAndRoute(
      'no-legacy-llm-after-controller',
      'Design the architecture for a cross-module auth and billing migration, compare rollout risks, and outline the implementation plan before any edits.',
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

    assert.equal(controllerAttempts, 1);
    assert.equal(fetchAttempts, 0);
    assert.equal(decision.method, 'heuristic');
    assert.equal(decision.tier, 'plan');
    assert.doesNotMatch(autoRouterSource, /classifyWithLlm/);
    assert.doesNotMatch(autoRouterSource, /chat\/completions/);
    assert.doesNotMatch(autoRouterSource, /method\s*=\s*'llm'/);
    assert.doesNotMatch(autoRouterSource, /useLlmClassifier|llmConfidenceThreshold|skipLlmClassifier/);
    assert.doesNotMatch(sharedTypesSource, /useLlmClassifier|llmConfidenceThreshold/);
    assert.doesNotMatch(autoRouterSource, /legacy direct LLM/i);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('auto-router no legacy LLM after controller verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
