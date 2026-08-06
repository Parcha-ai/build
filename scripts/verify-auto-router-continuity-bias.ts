import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';

// Guards settings-aligned continuity: native resume is reused only when it
// agrees with the configured model for the newly resolved tier. Tier changes,
// approved plans, custom routes, and explicit harness requests can switch.

const root = path.resolve(__dirname, '..');
const autoRouterSource = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const claudeServiceSource = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const flueMetaRouterSource = fs.readFileSync(path.join(root, 'src/main/services/flue-meta-router.service.ts'), 'utf8');

// Static wiring: settings choose first; continuity is only an optimization.
assert.match(autoRouterSource, /isContinuationIntentMessage/);
assert.match(autoRouterSource, /isPrWorkflowContinuation/);
assert.match(autoRouterSource, /if \(options\.approvedPlanContinuation && isApprovedPlanExecutionFollowup\(message\)\) return false;/);
assert.match(autoRouterSource, /harnessFromModel\(configured\) === options\.continuationHarness/);
assert.match(autoRouterSource, /Configured \$\{tier\} model \$\{configured\} matches the previous/);
assert.match(autoRouterSource, /continuationHarness: routeOptions\.continuationHarness/);
assert.match(autoRouterSource, /!metaLead && !customCategoryLead/);

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
assert.match(flueMetaRouterSource, /Continuity may reuse previousTurn only when it matches fixed\/custom settings for the resolved tier/);

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
    assert.match(followUp.reason, /Configured .* model codex:gpt-5.5 matches the previous codex harness/);

    // 2. A follow-up that resolves to Refinement follows the configured Cursor
    // model instead of sticking to the previous Codex harness.
    const anaphoric = await autoRouterService.classifyAndRoute(
      'continuity-anaphora-follows-tier-settings',
      'That change broke the settings dialog spacing — adjust what you did so the buttons line up with the inputs again',
      baseOptions,
    );
    assert.equal(anaphoric.tier, 'refine');
    assert.equal(anaphoric.resolvedHarness, 'cursor', 'refinement settings must beat prior-harness inertia');
    assert.equal(anaphoric.resolvedModel, 'cursor:composer-2.5');

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
    assert.equal(bareMention.resolvedHarness, 'cursor', 'bare harness-name mention should still follow refinement settings');
    assert.notEqual(bareMention.resolvedHarness, 'claude', 'bare CLAUDE.md mention must not act like an explicit Claude request');

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

    // 7. A Build follow-up coming from a Claude planning model switches to the
    // configured Execution model.
    const crossTierSwitch = await autoRouterService.classifyAndRoute(
      'continuity-build-settings-beat-claude',
      'now implement the approved api retry plan',
      {
        ...baseOptions,
        continuationHarness: 'claude' as const,
        continuationModel: 'claude-opus-4-8',
      },
    );
    assert.equal(crossTierSwitch.tier, 'build');
    assert.equal(crossTierSwitch.resolvedHarness, 'codex');
    assert.equal(crossTierSwitch.resolvedModel, 'codex:gpt-5.5');

    // 8. Approval is a hard phase boundary even when the prior planning model
    // is available and resumable.
    const approvedPlan = await autoRouterService.classifyAndRoute(
      'continuity-approved-plan-switches',
      'Execute the approved plan now.',
      {
        ...baseOptions,
        approvedPlanContinuation: true,
        continuationHarness: 'claude' as const,
        continuationModel: 'claude-opus-4-8',
      },
    );
    assert.equal(approvedPlan.tier, 'build');
    assert.equal(approvedPlan.resolvedHarness, 'codex');
    assert.equal(approvedPlan.resolvedModel, 'codex:gpt-5.5');

    // 9. PR/release workflows are execution phase boundaries. Neither their
    // embedded plan/review language nor a frustrated prose wrapper may send
    // them back through a plan-only Claude turn.
    const resolvedPrWorkflow = await autoRouterService.classifyAndRoute(
      'explicit-pr-workflow-executes',
      '<invoked_workflow kind="command" name="/pr" scope="project" path="/repo/.claude/commands/pr.md">\nReview the plan, run tests, push, and create the PR.\n</invoked_workflow>',
      { ...baseOptions, permissionMode: 'bypassPermissions' },
    );
    assert.equal(resolvedPrWorkflow.tier, 'build');
    assert.equal(resolvedPrWorkflow.planningGate.action, 'none');
    assert.equal(resolvedPrWorkflow.resolvedHarness, 'claude');
    assert.equal(resolvedPrWorkflow.resolvedModel, 'claude-fable-5');
    assert.equal(resolvedPrWorkflow.categoryId, 'pr');
    assert.equal(resolvedPrWorkflow.categoryLabel, 'Pull requests');
    assert.equal(resolvedPrWorkflow.missionControl?.categoryId, 'pr');
    assert.equal(resolvedPrWorkflow.orchestration?.mode, 'single');
    assert.match(resolvedPrWorkflow.reason, /First-class PR category uses configured model claude-fable-5/);

    const nativePrWorkflow = await autoRouterService.classifyAndRoute(
      'native-pr-workflow-executes',
      '/pr',
      { ...baseOptions, permissionMode: 'bypassPermissions' },
    );
    assert.equal(nativePrWorkflow.tier, 'build');
    assert.equal(nativePrWorkflow.categoryId, 'pr');
    assert.equal(nativePrWorkflow.resolvedModel, 'claude-fable-5');
    assert.equal(nativePrWorkflow.orchestration?.mode, 'single');
    assert.equal(nativePrWorkflow.orchestration?.handoffPrompt, '');

    // A disconnected background check must not turn a prose continuation of
    // the native PR workflow into a generic Sol build turn. This reproduces
    // the Fable -> background pytest -> Sol handoff seen in production.
    const pendingPrWorkflow = await autoRouterService.classifyAndRoute(
      'pending-pr-workflow-stays-on-pr-model',
      'OK while it is doing that in the PR workflow, resolve the blockers and move the review policies into REVIEW.md',
      { ...baseOptions, permissionMode: 'bypassPermissions' },
    );
    assert.equal(pendingPrWorkflow.tier, 'build');
    assert.equal(pendingPrWorkflow.categoryId, 'pr');
    assert.equal(pendingPrWorkflow.resolvedHarness, 'claude');
    assert.equal(pendingPrWorkflow.resolvedModel, 'claude-fable-5');
    assert.equal(pendingPrWorkflow.orchestration?.mode, 'single');

    const frustratedPrWorkflow = await autoRouterService.classifyAndRoute(
      'frustrated-pr-workflow-executes',
      'stop wasting my time and do the fucking /pr',
      { ...baseOptions, permissionMode: 'bypassPermissions' },
    );
    assert.equal(frustratedPrWorkflow.tier, 'build');
    assert.equal(frustratedPrWorkflow.planningGate.action, 'none');
    assert.equal(frustratedPrWorkflow.resolvedModel, 'claude-fable-5');
    assert.equal(frustratedPrWorkflow.missionControl?.categoryId, 'pr');

    // This is the exact shape seen by Fable after a cross-harness transcript
    // sync. The active imperative comes after the sync envelope, and "create"
    // must still be treated as workflow execution rather than model-routed
    // planning.
    const syncedCreatePrWorkflow = await autoRouterService.classifyAndRoute(
      'synced-create-pr-workflow-executes',
      '<conversation_sync>prior transcript with plans and reviews</conversation_sync>\ncreate the /pr',
      { ...baseOptions, skipMetaController: false, permissionMode: 'bypassPermissions' },
    );
    assert.equal(syncedCreatePrWorkflow.tier, 'build');
    assert.equal(syncedCreatePrWorkflow.planningGate.action, 'none');
    assert.equal(syncedCreatePrWorkflow.resolvedModel, 'claude-fable-5');
    assert.equal(syncedCreatePrWorkflow.missionControl?.categoryId, 'pr');
    assert.match(syncedCreatePrWorkflow.reason, /explicitly invoked a mutating execution workflow/i);

    // 10. Ordinary spoken PR operations are also hard phase boundaries. They
    // must not depend on slash-command expansion to avoid Fable plan mode.
    const createPr = await autoRouterService.classifyAndRoute(
      'spoken-pr-publication-executes',
      'Push the branch and create the PR now',
      { ...baseOptions, skipMetaController: false, permissionMode: 'bypassPermissions' },
    );
    assert.equal(createPr.tier, 'build');
    assert.equal(createPr.planningGate.action, 'none');
    assert.equal(createPr.resolvedModel, 'codex:gpt-5.5');
    assert.match(createPr.reason, /publication request must execute without a planning turn/);

    const prStatus = await autoRouterService.classifyAndRoute(
      'spoken-pr-status-verifies',
      'Is there a PR yet?',
      { ...baseOptions, skipMetaController: false, permissionMode: 'bypassPermissions' },
    );
    assert.equal(prStatus.tier, 'verify');
    assert.equal(prStatus.planningGate.action, 'none');
    assert.equal(prStatus.resolvedModel, 'gemini:gemini-3.5-flash');
    assert.match(prStatus.reason, /status lookup is verification, not planning/);

    const planLoopComplaint = await autoRouterService.classifyAndRoute(
      'pr-plan-loop-complaint-verifies',
      'WHY DOES IT KEEP GOING INTO PLAN MODE IN FABLE TO WRITE THE PR?',
      { ...baseOptions, skipMetaController: false, permissionMode: 'bypassPermissions' },
    );
    assert.equal(planLoopComplaint.tier, 'verify');
    assert.equal(planLoopComplaint.planningGate.action, 'none');
    assert.match(planLoopComplaint.reason, /unwanted planning or verification loop/);

    // 11. The input's explicitly selected permission mode is authoritative.
    // Even a direct publication command stays in Plan when the user deliberately
    // selected Plan; the PR fast path only applies to executable input modes.
    const manuallySelectedPlan = await autoRouterService.classifyAndRoute(
      'manual-plan-mode-remains-authoritative',
      'Push the branch and create the PR now',
      { ...baseOptions, skipMetaController: false, permissionMode: 'plan' },
    );
    assert.equal(manuallySelectedPlan.tier, 'plan');
    assert.equal(manuallySelectedPlan.resolvedModel, 'claude-sonnet-4-6');
    assert.match(manuallySelectedPlan.reason, /Permission mode is plan/);

    console.log(`[AutoRouter] follow-up → ${followUp.resolvedHarness}:${followUp.resolvedModel}`);
    console.log(`[AutoRouter] anaphoric → ${anaphoric.resolvedHarness}:${anaphoric.resolvedModel}`);
    console.log(`[AutoRouter] new intent → ${newIntent.resolvedHarness}:${newIntent.resolvedModel}`);
    console.log(`[AutoRouter] explicit switch → ${explicitSwitch.resolvedHarness}:${explicitSwitch.resolvedModel}`);
    console.log(`[AutoRouter] new task cue → ${newTask.resolvedHarness}:${newTask.resolvedModel}`);
    console.log(`[AutoRouter] plan escalation → ${planEscalation.resolvedHarness}:${planEscalation.resolvedModel}`);
    console.log(`[AutoRouter] cross-tier switch → ${crossTierSwitch.resolvedHarness}:${crossTierSwitch.resolvedModel}`);
    console.log(`[AutoRouter] approved plan → ${approvedPlan.resolvedHarness}:${approvedPlan.resolvedModel}`);
    console.log(`[AutoRouter] explicit /pr → ${resolvedPrWorkflow.resolvedHarness}:${resolvedPrWorkflow.resolvedModel}`);
    console.log(`[AutoRouter] native /pr → ${nativePrWorkflow.resolvedHarness}:${nativePrWorkflow.resolvedModel}`);
    console.log(`[AutoRouter] pending PR workflow → ${pendingPrWorkflow.resolvedHarness}:${pendingPrWorkflow.resolvedModel}`);
    console.log(`[AutoRouter] synced create /pr → ${syncedCreatePrWorkflow.resolvedHarness}:${syncedCreatePrWorkflow.resolvedModel}`);
    console.log(`[AutoRouter] spoken PR creation → ${createPr.resolvedHarness}:${createPr.resolvedModel}`);
    console.log(`[AutoRouter] spoken PR status → ${prStatus.resolvedHarness}:${prStatus.resolvedModel}`);
    console.log(`[AutoRouter] manual Plan mode → ${manuallySelectedPlan.resolvedHarness}:${manuallySelectedPlan.resolvedModel}`);
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
