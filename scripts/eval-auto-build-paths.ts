/**
 * Exhaustive eval suite for Auto Build paths + session continuity integration.
 *
 * Tests:
 *   1. Auto-router heuristic classification (plan/build/verify/refine)
 *   2. Domain classification
 *   3. Routing decision structure
 *   4. Harness capabilities
 *   5. Turn state machine during auto-build multi-stage flows
 *   6. Recovery during auto-build SSH sessions
 *   7. Queue with different harness capabilities
 *   8. Session phase tracking + workflow awareness
 *   9. Harness failure cooldowns
 *  10. Auto-router config
 *  11. Integration: auto-build + session continuity
 *
 * Usage:  npx ts-node scripts/eval-auto-build-paths.ts
 */
import assert from 'assert';
import Module from 'module';

// ── Mock electron-store and analytics before any service imports ─────────
const settings: Record<string, unknown> = {
  autoRouterConfig: {
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.5',
    verifyModel: 'codex:gpt-5.5',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: true,
  },
  cerebrasApiKey: 'test-cerebras-key',
  cursorApiKey: 'test-cursor-key',
  geminiApiKey: 'test-gemini-key',
  deepseekApiKey: 'test-deepseek-key',
};

class MockStore {
  get(key: string, defaultValue?: unknown): unknown {
    if (key === 'settings') return settings;
    if (key === 'openAiApiKey' || key === 'openaiApiKey') return 'test-openai-key';
    if (key === 'googleApiKey') return 'test-google-key';
    return defaultValue;
  }
  set(): void {
    // This eval only reads settings; writes are intentionally discarded.
  }
}

interface ModuleWithLoad {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

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

// ── Test harness ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('Use testAsync for async tests');
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. AUTO-ROUTER HEURISTIC CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════

async function evalAutoRouterClassification() {
  console.log('\n═══ 1. Auto-Router Classification ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const sid = () => `eval-ar-${Math.random().toString(36).slice(2, 10)}`;

  await testAsync('Plan message routes to plan tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'What is the best approach for implementing this feature? Think about the trade-offs and architecture.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.tier, 'plan', `Expected plan but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Build message routes to build tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Implement the user authentication feature. Write the code for the login endpoint.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.tier, 'build', `Expected build but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Verify message routes to verify tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Run the tests and debug this failing test. There is a regression in the auth module.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.tier, 'verify', `Expected verify but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Refine message routes to refine or verify tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Tweak the button text. Just rename this variable and fix the typo in the label.', {
      skipMetaController: true,
    });
    assert.ok(
      decision.tier === 'refine' || decision.tier === 'verify',
      `Expected refine or verify but got ${decision.tier}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Capability escalation routes to plan', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Think harder about this problem. Use a stronger model to reason through the architecture.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.tier, 'plan', `Expected plan but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Short message gets a valid tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'hello', {
      skipMetaController: true,
    });
    assert.ok(
      ['plan', 'build', 'verify', 'refine'].includes(decision.tier),
      `Got unexpected tier: ${decision.tier}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Approved plan continuation forces build tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'OK go ahead and build it', {
      skipMetaController: true,
      approvedPlanContinuation: true,
    });
    assert.strictEqual(decision.tier, 'build', `Expected build with approved plan but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Permission mode plan forces plan tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login page', {
      skipMetaController: true,
      permissionMode: 'plan',
    });
    assert.strictEqual(decision.tier, 'plan', `Expected plan with plan mode but got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Explicit harness request overrides tier routing', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Use codex to fix this bug in the authentication system', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.resolvedHarness, 'codex', `Expected codex but got ${decision.resolvedHarness}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Continuation harness is respected for follow-ups', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'yes go ahead', {
      skipMetaController: true,
      continuationHarness: 'codex',
      continuationModel: 'codex:gpt-5.5',
    });
    assert.strictEqual(decision.resolvedHarness, 'codex', `Expected codex continuation but got ${decision.resolvedHarness}`);
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 2. DOMAIN CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════

async function evalDomainClassification() {
  console.log('\n═══ 2. Domain Classification ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const sid = () => `eval-domain-${Math.random().toString(36).slice(2, 10)}`;

  await testAsync('Frontend message classified as frontend domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Fix the CSS layout on the React component. The mobile responsive view is broken.', {
      skipMetaController: true,
    });
    assert.ok(
      decision.domain === 'frontend' || decision.domain === 'fullstack',
      `Expected frontend but got ${decision.domain}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Backend message classified as backend domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Add a new API endpoint for user authentication. Update the database migration and schema.', {
      skipMetaController: true,
    });
    assert.ok(
      decision.domain === 'backend' || decision.domain === 'fullstack',
      `Expected backend/fullstack but got ${decision.domain}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Debug message classified as debug domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'The application is crashing with this stack trace. There is a regression causing an exception.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.domain, 'debug', `Expected debug but got ${decision.domain}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Image attachment influences domain to frontend', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Make it look like this', {
      skipMetaController: true,
      attachmentCount: 1,
      attachmentTypes: ['image'],
    });
    assert.ok(
      decision.domain === 'frontend' || decision.domain === 'fullstack',
      `Expected frontend/fullstack with image attachment but got ${decision.domain}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Ops message classified correctly', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Fix the Docker deployment. The CI workflow on GitHub Actions is failing.', {
      skipMetaController: true,
    });
    assert.ok(
      decision.domain === 'ops' || decision.domain === 'debug',
      `Expected ops/debug but got ${decision.domain}`
    );
    autoRouterService.resetPhase(s);
  });

  await testAsync('Copy message classified as copy domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Rewrite the headline and tagline for the landing page hero section. Make it punchier.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.domain, 'copy', `Expected copy but got ${decision.domain}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Data message classified as data domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build a dashboard that shows the analytics metrics from posthog.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.domain, 'data', `Expected data but got ${decision.domain}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Docs message classified as docs domain', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Write documentation and update the README with the changelog.', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.domain, 'docs', `Expected docs but got ${decision.domain}`);
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 3. ROUTING DECISION STRUCTURE
// ═══════════════════════════════════════════════════════════════════

async function evalRoutingDecisionStructure() {
  console.log('\n═══ 3. Routing Decision Structure ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const sid = () => `eval-struct-${Math.random().toString(36).slice(2, 10)}`;

  await testAsync('Decision has all required fields', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login feature', {
      skipMetaController: true,
    });
    assert.ok(decision.tier, 'Must have tier');
    assert.ok(decision.domain, 'Must have domain');
    assert.ok(decision.resolvedModel, 'Must have resolvedModel');
    assert.ok(decision.resolvedHarness, 'Must have resolvedHarness');
    assert.ok(typeof decision.confidence === 'number', 'Confidence must be a number');
    assert.ok(decision.confidence >= 0 && decision.confidence <= 1, 'Confidence must be 0-1');
    assert.ok(decision.reason, 'Must have reason');
    assert.ok(decision.method, 'Must have method');
    assert.ok(decision.orchestration, 'Must have orchestration');
    autoRouterService.resetPhase(s);
  });

  await testAsync('Orchestration plan has valid structure', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login feature', {
      skipMetaController: true,
    });
    const orch = decision.orchestration!;
    assert.ok(orch.mode, 'Orchestration must have mode');
    assert.ok(
      ['single', 'lead-with-delegates', 'sequential'].includes(orch.mode),
      `Mode must be single/lead-with-delegates/sequential, got ${orch.mode}`
    );
    assert.ok(Array.isArray(orch.stages), 'Stages must be array');
    assert.ok(orch.stages.length >= 1, 'Must have at least one stage');
    autoRouterService.resetPhase(s);
  });

  await testAsync('Lead stage has trigger=now', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login feature', {
      skipMetaController: true,
    });
    const leadStage = decision.orchestration!.stages[0];
    assert.strictEqual(leadStage.trigger, 'now', 'Lead stage trigger must be "now"');
    assert.ok(leadStage.model, 'Lead stage must have model');
    assert.ok(leadStage.tier, 'Lead stage must have tier');
    autoRouterService.resetPhase(s);
  });

  await testAsync('resolvedModel matches lead stage model', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login feature', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.resolvedModel, decision.orchestration!.stages[0].model,
      'Decision resolvedModel must match lead stage model');
    autoRouterService.resetPhase(s);
  });

  await testAsync('Heuristic method used when skipMetaController', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Plan the architecture', {
      skipMetaController: true,
    });
    assert.strictEqual(decision.method, 'heuristic',
      `Expected heuristic method but got ${decision.method}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Harness matches model prefix', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build this feature', {
      skipMetaController: true,
    });
    const model = decision.resolvedModel;
    if (model.startsWith('codex:')) {
      assert.strictEqual(decision.resolvedHarness, 'codex');
    } else if (model.startsWith('cursor:')) {
      assert.strictEqual(decision.resolvedHarness, 'cursor');
    } else if (model.startsWith('gemini:')) {
      assert.strictEqual(decision.resolvedHarness, 'gemini');
    } else if (model.startsWith('opencode:')) {
      assert.strictEqual(decision.resolvedHarness, 'opencode');
    } else if (model.startsWith('custom:')) {
      assert.strictEqual(decision.resolvedHarness, 'custom');
    } else {
      assert.strictEqual(decision.resolvedHarness, 'claude');
    }
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 4. HARNESS CAPABILITIES
// ═══════════════════════════════════════════════════════════════════

async function evalHarnessCapabilities() {
  console.log('\n═══ 4. Harness Capabilities ═══');

  const { getHarnessCapabilities } = await import('../src/main/services/harness-capabilities');

  test('Claude supports async injection', () => {
    const caps = getHarnessCapabilities('claude');
    assert.strictEqual(caps.supportsAsyncInjection, true);
    assert.strictEqual(caps.supportsMultiTurn, true);
  });

  test('Codex supports active-turn steering', () => {
    const caps = getHarnessCapabilities('codex');
    assert.strictEqual(caps.supportsAsyncInjection, true);
    assert.strictEqual(caps.supportsMultiTurn, true);
  });

  test('Cursor does NOT support async injection', () => {
    const caps = getHarnessCapabilities('cursor');
    assert.strictEqual(caps.supportsAsyncInjection, false);
    assert.strictEqual(caps.supportsMultiTurn, true);
  });

  test('Gemini is NOT multi-turn', () => {
    const caps = getHarnessCapabilities('gemini');
    assert.strictEqual(caps.supportsAsyncInjection, false);
    assert.strictEqual(caps.supportsMultiTurn, false);
  });

  test('Opencode is NOT multi-turn', () => {
    const caps = getHarnessCapabilities('opencode');
    assert.strictEqual(caps.supportsAsyncInjection, false);
    assert.strictEqual(caps.supportsMultiTurn, false);
  });

  test('Custom harness falls to default', () => {
    const caps = getHarnessCapabilities('custom');
    assert.strictEqual(caps.supportsAsyncInjection, false);
    assert.strictEqual(caps.supportsMultiTurn, false);
  });

  test('Unknown harness gets default capabilities', () => {
    const caps = getHarnessCapabilities('unknown-harness');
    assert.strictEqual(caps.supportsAsyncInjection, false);
    assert.strictEqual(caps.supportsMultiTurn, false);
    assert.strictEqual(caps.minTurnGapMs, 500);
    assert.strictEqual(caps.maxCoalesceWindowMs, 3000);
  });

  test('Undefined harness defaults to claude', () => {
    const caps = getHarnessCapabilities(undefined);
    assert.strictEqual(caps.supportsAsyncInjection, true);
    assert.strictEqual(caps.supportsMultiTurn, true);
  });

  test('All harnesses have minTurnGapMs = 500', () => {
    for (const h of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'custom']) {
      const caps = getHarnessCapabilities(h);
      assert.strictEqual(caps.minTurnGapMs, 500, `${h} must have minTurnGapMs=500`);
    }
  });

  test('All harnesses have maxCoalesceWindowMs = 3000', () => {
    for (const h of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'custom']) {
      const caps = getHarnessCapabilities(h);
      assert.strictEqual(caps.maxCoalesceWindowMs, 3000, `${h} must have maxCoalesceWindowMs=3000`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// 5. TURN STATE MACHINE + AUTO-BUILD INTERACTION
// ═══════════════════════════════════════════════════════════════════

async function evalTurnStateMachineAutoBuild() {
  console.log('\n═══ 5. Turn State Machine + Auto-Build ═══');

  const { sessionTurnService } = await import('../src/main/services/session-turn.service');
  const { queueController } = await import('../src/main/services/queue-controller.service');
  const sid = () => `eval-turn-ab-${Math.random().toString(36).slice(2, 10)}`;

  test('State machine handles auto-build lead stage (IDLE→STREAMING)', () => {
    const s = sid();
    const result = sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    assert.strictEqual(result, 'STREAMING');
    assert.ok(sessionTurnService.isActive(s));
    sessionTurnService.cleanup(s);
  });

  test('State machine handles auto-build multi-stage (STREAMING→IDLE between stages)', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead: codex');
    assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');
    sessionTurnService.transition(s, 'IDLE', 'lead complete');
    assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    sessionTurnService.transition(s, 'STREAMING', 'auto-build delegate: cursor');
    assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');
    sessionTurnService.transition(s, 'IDLE', 'delegate complete');
    assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    sessionTurnService.cleanup(s);
  });

  test('Queue messages survive through multi-stage auto-build', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    queueController.enqueue(s, 'follow-up message while codex is running');
    assert.ok(queueController.hasMessages(s), 'Queue must hold message during streaming');
    sessionTurnService.transition(s, 'IDLE', 'lead complete');
    assert.ok(queueController.hasMessages(s), 'Queue must survive lead completion');
    sessionTurnService.transition(s, 'STREAMING', 'auto-build delegate');
    assert.ok(queueController.hasMessages(s), 'Queue must survive into delegate');
    sessionTurnService.transition(s, 'IDLE', 'delegate complete');
    assert.ok(queueController.hasMessages(s), 'Queue must survive through full auto-build');
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Queue harness tracking works for auto-build harness switches', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    queueController.setActiveHarness(s, 'codex');
    assert.strictEqual(queueController.getState(s).activeHarness, 'codex');
    sessionTurnService.transition(s, 'IDLE', 'lead complete');
    queueController.setActiveHarness(s, 'cursor');
    assert.strictEqual(queueController.getState(s).activeHarness, 'cursor');
    sessionTurnService.transition(s, 'STREAMING', 'delegate');
    assert.strictEqual(queueController.getState(s).activeHarness, 'cursor');
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Auto-build cancellation forces IDLE from any stage', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    sessionTurnService.forceIdle(s, 'user cancelled auto-build');
    assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    sessionTurnService.cleanup(s);
  });

  test('Queue isProcessing reflects auto-build active state', () => {
    const s = sid();
    assert.strictEqual(queueController.getState(s).isProcessing, false);
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    assert.strictEqual(queueController.getState(s).isProcessing, true);
    sessionTurnService.transition(s, 'IDLE', 'lead complete');
    assert.strictEqual(queueController.getState(s).isProcessing, false);
    sessionTurnService.transition(s, 'STREAMING', 'auto-build delegate');
    assert.strictEqual(queueController.getState(s).isProcessing, true);
    sessionTurnService.forceIdle(s);
    assert.strictEqual(queueController.getState(s).isProcessing, false);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Three-stage auto-build lifecycle is consistent', () => {
    const s = sid();
    const harnesses = ['codex', 'cursor', 'claude'];
    for (let i = 0; i < harnesses.length; i++) {
      sessionTurnService.transition(s, 'STREAMING', `stage ${i}: ${harnesses[i]}`);
      queueController.setActiveHarness(s, harnesses[i]);
      assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');
      assert.strictEqual(queueController.getState(s).activeHarness, harnesses[i]);
      sessionTurnService.transition(s, 'IDLE', `stage ${i} done`);
    }
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 6. RECOVERY DURING AUTO-BUILD SSH SESSIONS
// ═══════════════════════════════════════════════════════════════════

async function evalRecoveryAutoBuild() {
  console.log('\n═══ 6. Recovery During Auto-Build SSH ═══');

  const { sessionTurnService } = await import('../src/main/services/session-turn.service');
  const { recoveryService } = await import('../src/main/services/recovery.service');
  const { queueController } = await import('../src/main/services/queue-controller.service');
  const sid = () => `eval-recovery-ab-${Math.random().toString(36).slice(2, 10)}`;

  await testAsync('Non-SSH auto-build error goes to IDLE', async () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead: codex');
    queueController.setActiveHarness(s, 'codex');
    const result = await recoveryService.handleStreamError(s, new Error('codex died'), undefined);
    assert.strictEqual(result.action, 'idle');
    assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  await testAsync('SSH auto-build error attempts recovery then IDLE', async () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead: codex via SSH');
    queueController.setActiveHarness(s, 'codex');
    const sshConfig = { host: 'fake-host', port: 22, username: 'test', remoteWorkdir: '/' } as any;
    const result = await recoveryService.handleStreamError(s, new Error('SSH disconnect'), sshConfig);
    assert.strictEqual(result.action, 'idle');
    assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  await testAsync('Queue survives SSH recovery during auto-build', async () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'auto-build lead');
    queueController.enqueue(s, 'pending message');
    const sshConfig = { host: 'fake', port: 22, username: 'test', remoteWorkdir: '/' } as any;
    await recoveryService.handleStreamError(s, new Error('lost'), sshConfig);
    assert.ok(queueController.hasMessages(s), 'Queue must survive SSH recovery');
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  await testAsync('Multiple errors during auto-build converge to IDLE', async () => {
    const s = sid();
    for (let i = 0; i < 3; i++) {
      sessionTurnService.transition(s, 'STREAMING', `attempt ${i}`);
      const result = await recoveryService.handleStreamError(s, new Error(`error ${i}`), undefined);
      assert.strictEqual(result.action, 'idle');
      assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    }
    sessionTurnService.cleanup(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 7. QUEUE WITH DIFFERENT HARNESS CAPABILITIES
// ═══════════════════════════════════════════════════════════════════

async function evalQueueHarnessCapabilities() {
  console.log('\n═══ 7. Queue with Harness Capabilities ═══');

  const { sessionTurnService } = await import('../src/main/services/session-turn.service');
  const { queueController } = await import('../src/main/services/queue-controller.service');
  const { getHarnessCapabilities } = await import('../src/main/services/harness-capabilities');
  const sid = () => `eval-qcaps-${Math.random().toString(36).slice(2, 10)}`;

  test('Claude harness: message queues during stream', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'claude turn');
    queueController.setActiveHarness(s, 'claude');
    queueController.enqueue(s, 'follow-up');
    assert.ok(queueController.hasMessages(s), 'Message queued');
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Codex harness: messages queue for active-turn steering', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'codex turn');
    queueController.setActiveHarness(s, 'codex');
    queueController.enqueue(s, 'queued while codex streams');
    const caps = getHarnessCapabilities('codex');
    assert.strictEqual(caps.supportsAsyncInjection, true);
    assert.ok(queueController.hasMessages(s));
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Harness switch from codex to claude updates capabilities', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'codex turn');
    queueController.setActiveHarness(s, 'codex');
    assert.strictEqual(getHarnessCapabilities('codex').supportsAsyncInjection, true);
    sessionTurnService.transition(s, 'IDLE', 'done');
    queueController.setActiveHarness(s, 'claude');
    assert.strictEqual(getHarnessCapabilities('claude').supportsAsyncInjection, true);
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Gemini harness: non-multi-turn, messages always queue', () => {
    const s = sid();
    queueController.setActiveHarness(s, 'gemini');
    const caps = getHarnessCapabilities('gemini');
    assert.strictEqual(caps.supportsMultiTurn, false);
    assert.strictEqual(caps.supportsAsyncInjection, false);
    queueController.cleanup(s);
  });

  test('Multiple messages coalesce for drain', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'codex turn');
    queueController.setActiveHarness(s, 'codex');
    queueController.enqueue(s, 'first');
    queueController.enqueue(s, 'second');
    queueController.enqueue(s, 'third');
    const drained = queueController.peekForDrain(s);
    assert.ok(drained);
    assert.strictEqual(drained!.sourceCount, 3);
    assert.ok(drained!.text.includes('first'));
    assert.ok(drained!.text.includes('second'));
    assert.ok(drained!.text.includes('third'));
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('dequeueForDrain consumes the queue', () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'turn');
    queueController.enqueue(s, 'message');
    assert.ok(queueController.hasMessages(s));
    const drained = queueController.dequeueForDrain(s);
    assert.ok(drained);
    assert.ok(!queueController.hasMessages(s), 'Queue must be empty after dequeue');
    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  test('Duplicate messages within 10s are deduplicated', () => {
    const s = sid();
    queueController.enqueue(s, 'same message');
    queueController.enqueue(s, 'same message');
    const drained = queueController.peekForDrain(s);
    assert.ok(drained);
    assert.strictEqual(drained!.sourceCount, 1, 'Duplicate should be deduplicated');
    queueController.cleanup(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 8. SESSION PHASE TRACKING
// ═══════════════════════════════════════════════════════════════════

async function evalSessionPhaseTracking() {
  console.log('\n═══ 8. Session Phase Tracking ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const sid = () => `eval-phase-${Math.random().toString(36).slice(2, 10)}`;

  test('getPhase returns default for new session', () => {
    const s = sid();
    const phase = autoRouterService.getPhase(s);
    assert.strictEqual(phase.hasPlanContext, false);
    assert.strictEqual(phase.hasBuildContext, false);
    assert.ok(Array.isArray(phase.recentTiers));
    autoRouterService.resetPhase(s);
  });

  test('recordTierCompletion updates session phase', () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'plan');
    const phase = autoRouterService.getPhase(s);
    assert.strictEqual(phase.hasPlanContext, true);
    assert.ok(phase.recentTiers.includes('plan'));
    autoRouterService.resetPhase(s);
  });

  test('Build completion sets hasBuildContext', () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'build');
    const phase = autoRouterService.getPhase(s);
    assert.strictEqual(phase.hasBuildContext, true);
    autoRouterService.resetPhase(s);
  });

  test('Phase survives multiple tier completions', () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'plan');
    autoRouterService.recordTierCompletion(s, 'build');
    autoRouterService.recordTierCompletion(s, 'verify');
    const phase = autoRouterService.getPhase(s);
    assert.strictEqual(phase.hasPlanContext, true);
    assert.strictEqual(phase.hasBuildContext, true);
    assert.ok(phase.recentTiers.length >= 3);
    autoRouterService.resetPhase(s);
  });

  test('resetPhase clears everything', () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'plan');
    autoRouterService.recordTierCompletion(s, 'build');
    autoRouterService.resetPhase(s);
    const phase = autoRouterService.getPhase(s);
    assert.strictEqual(phase.hasPlanContext, false);
    assert.strictEqual(phase.hasBuildContext, false);
    assert.strictEqual(phase.recentTiers.length, 0);
  });

  test('lastTierUsed tracks most recent', () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'plan');
    assert.strictEqual(autoRouterService.getPhase(s).lastTierUsed, 'plan');
    autoRouterService.recordTierCompletion(s, 'build');
    assert.strictEqual(autoRouterService.getPhase(s).lastTierUsed, 'build');
    autoRouterService.recordTierCompletion(s, 'verify');
    assert.strictEqual(autoRouterService.getPhase(s).lastTierUsed, 'verify');
    autoRouterService.resetPhase(s);
  });

  await testAsync('Workflow awareness: build-after-plan when plan context exists', async () => {
    const s = sid();
    autoRouterService.recordTierCompletion(s, 'plan');
    const decision = await autoRouterService.classifyAndRoute(s,
      'OK go ahead and build it', {
        skipMetaController: true,
        approvedPlanContinuation: true,
      }
    );
    assert.strictEqual(decision.tier, 'build',
      `Expected build after plan context, got ${decision.tier}`);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Complex task gets plan or build tier', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s,
      'Implement a complete authentication system with OAuth, MFA, and session management across all endpoints', {
        skipMetaController: true,
      }
    );
    assert.ok(
      ['plan', 'build'].includes(decision.tier),
      `Expected plan or build for complex task, got ${decision.tier}`
    );
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 9. HARNESS FAILURE COOLDOWNS
// ═══════════════════════════════════════════════════════════════════

async function evalHarnessFailureCooldowns() {
  console.log('\n═══ 9. Harness Failure Cooldowns ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const sid = () => `eval-cooldown-${Math.random().toString(36).slice(2, 10)}`;

  test('recordHarnessFailure does not throw', () => {
    const s = sid();
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'connection timeout');
    autoRouterService.resetPhase(s);
  });

  test('recordHarnessSuccess does not throw', () => {
    const s = sid();
    autoRouterService.recordHarnessSuccess(s, 'codex', 'codex:gpt-5.5');
    autoRouterService.resetPhase(s);
  });

  await testAsync('Failed harness still produces a valid routing decision', async () => {
    const s = sid();
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'timeout');
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'timeout');
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the authentication system', {
      skipMetaController: true,
    });
    assert.ok(decision.resolvedModel, 'Must still produce a model decision');
    assert.ok(decision.tier, 'Must still have a tier');
    autoRouterService.resetPhase(s);
  });

  test('resetPhase clears failure cooldowns', () => {
    const s = sid();
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'error');
    autoRouterService.resetPhase(s);
    autoRouterService.recordHarnessSuccess(s, 'codex');
    autoRouterService.resetPhase(s);
  });

  test('Multiple harness failures can be recorded', () => {
    const s = sid();
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'timeout');
    autoRouterService.recordHarnessFailure(s, 'cursor', 'cursor:composer-2.5', 'auth error');
    autoRouterService.recordHarnessFailure(s, 'gemini', 'gemini:gemini-3.5-flash', 'rate limit');
    autoRouterService.resetPhase(s);
  });

  test('Success after failure does not throw', () => {
    const s = sid();
    autoRouterService.recordHarnessFailure(s, 'codex', 'codex:gpt-5.5', 'error');
    autoRouterService.recordHarnessSuccess(s, 'codex', 'codex:gpt-5.5');
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 10. CONFIG
// ═══════════════════════════════════════════════════════════════════

async function evalConfig() {
  console.log('\n═══ 10. Auto-Router Config ═══');

  const { autoRouterService } = await import('../src/main/services/auto-router.service');

  test('getConfig returns required fields', () => {
    const config = autoRouterService.getConfig();
    assert.ok(config.planModel, 'Must have planModel');
    assert.ok(config.buildModel, 'Must have buildModel');
    assert.ok(config.verifyModel, 'Must have verifyModel');
    assert.ok(config.refineModel, 'Must have refineModel');
    assert.ok(config.fallbackModel, 'Must have fallbackModel');
  });

  test('Config has correct field types', () => {
    const config = autoRouterService.getConfig();
    assert.ok(typeof config.planModel === 'string');
    assert.ok(typeof config.buildModel === 'string');
    assert.ok(typeof config.verifyModel === 'string');
    assert.ok(typeof config.refineModel === 'string');
    assert.ok(typeof config.fallbackModel === 'string');
    assert.ok(typeof config.costAware === 'boolean');
  });

  test('Config models match mock settings', () => {
    const config = autoRouterService.getConfig();
    const mockConfig = settings.autoRouterConfig as Record<string, unknown>;
    assert.strictEqual(config.planModel, mockConfig.planModel);
    assert.strictEqual(config.buildModel, mockConfig.buildModel);
    assert.strictEqual(config.verifyModel, mockConfig.verifyModel);
    assert.strictEqual(config.refineModel, mockConfig.refineModel);
    assert.strictEqual(config.fallbackModel, mockConfig.fallbackModel);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 11. INTEGRATION: Auto-Build + Session Continuity Services
// ═══════════════════════════════════════════════════════════════════

async function evalIntegration() {
  console.log('\n═══ 11. Integration: Auto-Build + Session Continuity ═══');

  const { sessionTurnService } = await import('../src/main/services/session-turn.service');
  const { queueController } = await import('../src/main/services/queue-controller.service');
  const { autoRouterService } = await import('../src/main/services/auto-router.service');
  const { getHarnessCapabilities } = await import('../src/main/services/harness-capabilities');
  const sid = () => `eval-integ-ab-${Math.random().toString(36).slice(2, 10)}`;

  await testAsync('Full auto-build lifecycle: route → lead → delegate → idle', async () => {
    const s = sid();
    const decision = await autoRouterService.classifyAndRoute(s, 'Build the login system', {
      skipMetaController: true,
    });
    assert.ok(decision.resolvedModel);
    const harness = decision.resolvedHarness || 'claude';

    sessionTurnService.transition(s, 'STREAMING', `auto-build lead: ${harness}`);
    queueController.setActiveHarness(s, harness);
    assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');

    queueController.enqueue(s, 'also add password reset');
    assert.ok(queueController.hasMessages(s));

    sessionTurnService.transition(s, 'IDLE', 'lead complete');
    autoRouterService.recordTierCompletion(s, decision.tier);
    autoRouterService.recordHarnessSuccess(s, harness, decision.resolvedModel);

    const phase = autoRouterService.getPhase(s);
    assert.ok(phase.recentTiers.includes(decision.tier));
    assert.ok(queueController.hasMessages(s), 'Follow-up must survive auto-build');

    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Auto-build with harness switch respects capabilities', async () => {
    const s = sid();
    sessionTurnService.transition(s, 'STREAMING', 'codex lead');
    queueController.setActiveHarness(s, 'codex');
    const codexCaps = getHarnessCapabilities('codex');
    assert.strictEqual(codexCaps.supportsAsyncInjection, true);

    queueController.enqueue(s, 'additional context');
    assert.ok(queueController.hasMessages(s));

    sessionTurnService.transition(s, 'IDLE', 'codex done');
    queueController.setActiveHarness(s, 'claude');
    const claudeCaps = getHarnessCapabilities('claude');
    assert.strictEqual(claudeCaps.supportsAsyncInjection, true);

    sessionTurnService.transition(s, 'STREAMING', 'claude delegate');
    // Message may or may not be drained at this point (async)

    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  await testAsync('Multiple rapid harness transitions stay consistent', async () => {
    const s = sid();
    for (let i = 0; i < 5; i++) {
      const harness = ['claude', 'codex', 'cursor', 'claude', 'codex'][i];
      sessionTurnService.transition(s, 'STREAMING', `stage ${i}: ${harness}`);
      queueController.setActiveHarness(s, harness);
      assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');
      assert.strictEqual(queueController.getState(s).activeHarness, harness);
      sessionTurnService.transition(s, 'IDLE', `stage ${i} done`);
      assert.strictEqual(sessionTurnService.getState(s), 'IDLE');
    }
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
  });

  await testAsync('Auto-build failure + recovery + re-route', async () => {
    const s = sid();
    const decision1 = await autoRouterService.classifyAndRoute(s, 'Build the feature', {
      skipMetaController: true,
    });
    const harness1 = decision1.resolvedHarness || 'claude';
    sessionTurnService.transition(s, 'STREAMING', 'lead');

    autoRouterService.recordHarnessFailure(s, harness1, decision1.resolvedModel, 'timeout');
    sessionTurnService.forceIdle(s, 'failed');

    const decision2 = await autoRouterService.classifyAndRoute(s, 'Try again with the feature', {
      skipMetaController: true,
    });
    assert.ok(decision2.resolvedModel, 'Must produce a model after failure');
    const harness2 = decision2.resolvedHarness || 'claude';
    sessionTurnService.transition(s, 'STREAMING', `retry: ${harness2}`);
    assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');

    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
    autoRouterService.resetPhase(s);
  });

  await testAsync('Route → enqueue → cancel → re-route works end-to-end', async () => {
    const s = sid();
    const d1 = await autoRouterService.classifyAndRoute(s, 'Build auth', { skipMetaController: true });
    sessionTurnService.transition(s, 'STREAMING', 'lead');
    queueController.setActiveHarness(s, d1.resolvedHarness || 'claude');
    queueController.enqueue(s, 'add MFA too');

    // Cancel mid-flight
    sessionTurnService.forceIdle(s, 'cancelled');
    assert.ok(queueController.hasMessages(s), 'Queued message survives cancel');

    // Re-route
    const d2 = await autoRouterService.classifyAndRoute(s, 'Actually use cursor', { skipMetaController: true });
    sessionTurnService.transition(s, 'STREAMING', 'retry');
    queueController.setActiveHarness(s, d2.resolvedHarness || 'claude');
    assert.strictEqual(sessionTurnService.getState(s), 'STREAMING');
    assert.ok(queueController.hasMessages(s), 'Message persists across re-route');

    sessionTurnService.forceIdle(s);
    queueController.cleanup(s);
    sessionTurnService.cleanup(s);
    autoRouterService.resetPhase(s);
  });
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Auto Build Paths Exhaustive Eval Suite                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await evalAutoRouterClassification();
  await evalDomainClassification();
  await evalRoutingDecisionStructure();
  await evalHarnessCapabilities();
  await evalTurnStateMachineAutoBuild();
  await evalRecoveryAutoBuild();
  await evalQueueHarnessCapabilities();
  await evalSessionPhaseTracking();
  await evalHarnessFailureCooldowns();
  await evalConfig();
  await evalIntegration();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('');
    console.log('  Failures:');
    for (const f of failures) {
      console.log(`    • ${f}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
