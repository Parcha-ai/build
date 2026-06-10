import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';

// Guards the generalized same-harness continuity bias: follow-up turns stay on
// the previous turn's harness (native resume is cheaper than rebuilding
// context), while genuinely new intents, explicit harness requests, plan
// escalations, and capability needs re-route freely.

const root = path.resolve(__dirname, '..');
const autoRouterSource = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const claudeServiceSource = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const flueMetaRouterSource = fs.readFileSync(path.join(root, 'src/main/services/flue-meta-router.service.ts'), 'utf8');

// Static wiring: continuity must not be gated on approved plans alone.
assert.match(autoRouterSource, /isContinuationIntentMessage/);
assert.match(autoRouterSource, /if \(options\.approvedPlanContinuation\) return true;/);
assert.match(autoRouterSource, /return isContinuationIntentMessage\(message, signals\);/);
assert.match(autoRouterSource, /Follow-up on previous \$\{continuationHarness\} turn/);
assert.match(autoRouterSource, /continuationHarness: routeOptions\.continuationHarness/);
assert.match(autoRouterSource, /metaLead\.harness === continuationLead\.harness/);

// claude.service resolves the previous route on EVERY Auto Build turn.
assert.match(claudeServiceSource, /const continuationRoute = await this\.resolveLastAssistantRoute\(sessionId, normalizedSupplementalMessages, recentRoutingMessages\);/);
assert.doesNotMatch(
  claudeServiceSource,
  /approvedPlanContinuation\s*\?\s*await this\.resolveLastAssistantRoute/,
  'Continuation route must not be gated on approved-plan turns'
);

// The meta-controller sees the previous turn and the continuity rule.
assert.match(flueMetaRouterSource, /continuationHarness\?: Harness;/);
assert.match(flueMetaRouterSource, /previousTurn: request\.continuationHarness \? \{/);
assert.match(flueMetaRouterSource, /Continuity: previousTurn = last lead harness\/model/);

const settings = {
  autoRouterConfig: {
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.5',
    verifyModel: 'gemini:gemini-3.5-flash',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: false,
  },
  cerebrasApiKey: '',
  openAiApiKey: 'test-openai-key',
  geminiApiKey: 'test-gemini-key',
  cursorApiKey: 'test-cursor-key',
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

const ALL_REMOTE_CAPABILITIES = {
  claude: true,
  codex: true,
  cursor: true,
  gemini: true,
  opencode: true,
};

async function runContinuityAssertions(): Promise<void> {
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoRouterService } = require('../src/main/services/auto-router.service');
    const baseOptions = {
      isSSH: true,
      remoteCliCapabilities: ALL_REMOTE_CAPABILITIES,
      continuationHarness: 'codex' as const,
      continuationModel: 'codex:gpt-5.5',
      skipMetaController: true,
    };

    // 1. Short follow-up sticks with the previous harness (no approved plan).
    const followUp = await autoRouterService.classifyAndRoute(
      'continuity-follow-up-sticks',
      'now fix the lint errors too',
      baseOptions,
    );
    assert.equal(followUp.resolvedHarness, 'codex', 'follow-up should stay on previous harness');
    assert.equal(followUp.resolvedModel, 'codex:gpt-5.5');
    assert.match(followUp.reason, /Follow-up on previous codex turn/);

    // 2. Anaphoric medium-length refinement sticks too.
    const anaphoric = await autoRouterService.classifyAndRoute(
      'continuity-anaphora-sticks',
      'That change broke the settings dialog spacing — adjust what you did so the buttons line up with the inputs again',
      baseOptions,
    );
    assert.equal(anaphoric.resolvedHarness, 'codex', 'anaphoric refinement should stay on previous harness');

    // 3. A long, self-contained new request re-routes freely.
    const newIntent = await autoRouterService.classifyAndRoute(
      'continuity-new-intent-reroutes',
      'Rewrite the landing page hero copy with three alternative headlines emphasizing speed, reliability, and developer experience for our marketing refresh',
      baseOptions,
    );
    assert.notEqual(newIntent.resolvedHarness, 'codex', 'new self-contained intent must not be pinned to previous harness');

    // 4. Explicit different-harness request always wins.
    const explicitSwitch = await autoRouterService.classifyAndRoute(
      'continuity-explicit-switch',
      'use gemini to check it',
      baseOptions,
    );
    assert.equal(explicitSwitch.resolvedHarness, 'gemini', 'explicit harness request must be honored');
    assert.match(explicitSwitch.reason, /explicitly requested gemini/);

    // 4b. Explicit request beats the tier's configured model too (buildModel
    // is codex, but the user asked for claude).
    const explicitOverConfig = await autoRouterService.classifyAndRoute(
      'continuity-explicit-over-config',
      'use claude to implement the retry logic in the api client module',
      baseOptions,
    );
    assert.equal(explicitOverConfig.resolvedHarness, 'claude', 'explicit request must beat tier-configured harness');
    assert.match(explicitOverConfig.reason, /explicitly requested claude/);

    // 4c. A bare harness-name mention (file path, no directive) is NOT a request.
    const bareMention = await autoRouterService.classifyAndRoute(
      'continuity-bare-mention-not-request',
      'now update the readme section about CLAUDE.md too',
      baseOptions,
    );
    assert.equal(bareMention.resolvedHarness, 'codex', 'bare harness-name mention should not break continuity');

    // 5. "New task" cue breaks stickiness even when short-ish.
    const newTask = await autoRouterService.classifyAndRoute(
      'continuity-new-task-cue',
      'new task: build the billing report api endpoint with a database schema migration',
      { ...baseOptions, continuationHarness: 'cursor' as const, continuationModel: 'cursor:composer-2.5' },
    );
    assert.notEqual(newTask.resolvedHarness, 'cursor', 'new-task cue must re-route freely');

    // 6. Plan-tier escalations never stick to the previous harness.
    const planEscalation = await autoRouterService.classifyAndRoute(
      'continuity-plan-not-sticky',
      'plan the architecture for multi-tenant billing before we write any code',
      baseOptions,
    );
    assert.equal(planEscalation.tier, 'plan');
    assert.doesNotMatch(planEscalation.reason, /Follow-up on previous/);

    console.log(`[AutoRouter] follow-up → ${followUp.resolvedHarness}:${followUp.resolvedModel}`);
    console.log(`[AutoRouter] anaphoric → ${anaphoric.resolvedHarness}:${anaphoric.resolvedModel}`);
    console.log(`[AutoRouter] new intent → ${newIntent.resolvedHarness}:${newIntent.resolvedModel}`);
    console.log(`[AutoRouter] explicit switch → ${explicitSwitch.resolvedHarness}:${explicitSwitch.resolvedModel}`);
    console.log(`[AutoRouter] new task cue → ${newTask.resolvedHarness}:${newTask.resolvedModel}`);
    console.log(`[AutoRouter] plan escalation → ${planEscalation.resolvedHarness}:${planEscalation.resolvedModel}`);
  } finally {
    moduleWithLoad._load = originalLoad;
  }
}

runContinuityAssertions()
  .then(() => {
    console.log('verify-auto-router-continuity-bias: all checks passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
