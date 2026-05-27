import assert from 'assert';
import Module from 'module';
import type { ChatMessage } from '../src/shared/types';

const settings = {
  autoRouterConfig: {
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.3-codex',
    verifyModel: 'gemini:gemini-3.5-flash',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: true,
  },
  cerebrasApiKey: '',
  cursorApiKey: 'test-cursor-key',
  geminiApiKey: 'test-gemini-key',
};

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
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { autoRouterService } = require('../src/main/services/auto-router.service');

async function main(): Promise<void> {
  const recentMessages: ChatMessage[] = [{
    id: 'workflow-result-with-hidden-failure',
    role: 'system',
    content: '<workflow_turn_result>\nCompleted scope: build\nFollow-up output:\nVerification follow-up could not complete.\n</workflow_turn_result>',
    timestamp: new Date(),
    metadata: {
      workflowFailures: [{
        harness: 'gemini',
        model: 'gemini:gemini-3.5-flash',
        error: 'quota exceeded',
      }],
    },
  }];

  assert.doesNotMatch(recentMessages[0].content, /gemini|codex|cursor|opencode|claude-sonnet|claude-opus/i);

  const decision = await autoRouterService.classifyAndRoute(
    'workflow-metadata-cooldown',
    'Tests are failing with this stack trace, figure out why before editing anything.',
    {
      isSSH: true,
      remoteCliCapabilities: {
        claude: true,
        codex: true,
        cursor: true,
        gemini: true,
        opencode: true,
      },
      recentMessages,
      skipMetaController: true,
    },
  );

  assert.equal(decision.tier, 'verify');
  assert.notEqual(decision.resolvedHarness, 'gemini');
  assert.notEqual(decision.resolvedModel, 'gemini:gemini-3.5-flash');
  assert.match(decision.reason, /temporarily avoiding recently failed helper/);
  assert.doesNotMatch(decision.reason, /gemini:gemini-3\.5-flash|quota exceeded/);

  console.log('auto-router workflow metadata verifier passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
