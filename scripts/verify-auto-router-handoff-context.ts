import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';
import type { ChatMessage } from '../src/shared/types';
import { buildUnifiedHarnessContext } from '../src/main/services/codex-context';

const root = path.resolve(__dirname, '..');
const autoRouterService = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const flueMetaRouterService = fs.readFileSync(path.join(root, 'src/main/services/flue-meta-router.service.ts'), 'utf8');
const codexContext = fs.readFileSync(path.join(root, 'src/main/services/codex-context.ts'), 'utf8');
const sharedTypes = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf8');

assert.match(
  flueMetaRouterService,
  /Switch-cost: prefer one lead/,
  'Flue controller prompt must account for cross-harness switch cost',
);
assert.match(
  flueMetaRouterService,
  /plan, build-check, or failure boundary/,
  'Flue controller prompt must prefer handoffs at artifact/phase boundaries',
);
assert.match(
  flueMetaRouterService,
  /artifact\/transcript refs over copied history/,
  'Flue controller prompt must prefer artifact references over full history stuffing',
);

assert.match(autoRouterService, /Context switches are expensive/);
assert.match(autoRouterService, /transcript file references let the next harness search its own context/);
assert.match(autoRouterService, /plan-to-execution handoffs should point at the plan file path when available/);
assert.match(autoRouterService, /approvedPlanContinuation\?: boolean/);
assert.match(autoRouterService, /continuationHarness\?: Harness/);
assert.match(autoRouterService, /Continuing approved plan in/);
assert.match(autoRouterService, /userRequestedDifferentHarness/);
assert.match(autoRouterService, /shouldPreferContinuationHarness/);
assert.match(autoRouterService, /isApprovedPlanExecutionFollowup/);
assert.match(autoRouterService, /approved plan follow-up means execute the plan/);
assert.match(autoRouterService, /includeTranscriptReferences: true/);
assert.match(autoRouterService, /includePlanFileReference: true/);
assert.match(autoRouterService, /avoidBulkContextOnHandoff: true/);
assert.match(autoRouterService, /maxHandoffConversationChars: 24000/);

assert.match(codexContext, /handoffReferences\?: string\[\]/);
assert.match(codexContext, /<handoff_references>/);
assert.match(codexContext, /Context transfer between coding agents is expensive/);
assert.match(codexContext, /focused search\/read operations over asking for broad copied/);

assert.match(claudeService, /sessionApprovedPlanFiles: Map<string, \{ content: string; filePath: string \}>/);
assert.match(claudeService, /planApprovalRecords: Map<string, PlanApprovalRecord>/);
assert.match(claudeService, /lastAssistantModel/);
assert.match(claudeService, /resolveLastAssistantRoute/);
assert.match(claudeService, /approvedPlanContinuation/);
assert.match(claudeService, /harnessState\.\$\{sessionId\}\.approvedPlan/);
assert.match(claudeService, /continuationHarness: continuationRoute\.harness/);
assert.match(claudeService, /continuationModel: continuationRoute\.model/);
assert.match(claudeService, /interface PlanApprovalRecord/);
assert.match(claudeService, /Late plan approval recorded for next harness handoff/);
assert.match(claudeService, /rememberApprovedPlan/);
assert.match(claudeService, /applyPlanApprovalExecutionMode/);
assert.match(claudeService, /<approved_plan_handoff>/);
assert.match(claudeService, /The user approved this plan for execution/);
assert.match(claudeService, /Plan file path: \$\{planFile\.filePath\}/);
assert.match(claudeService, /planContent, planFilePath, pending \? 'live' : 'late'/);
assert.match(claudeService, /Claude transcript file on remote: ~\/\.claude\/projects\/\$\{escapedPath\}\/\$\{sdkSessionId\}\.jsonl/);
assert.match(claudeService, /Fallback transcript search on remote: ~\/\.claude\/projects\/\*\/\$\{sdkSessionId\}\.jsonl/);
assert.match(claudeService, /Claude transcript file search: ~\/\.claude\/projects\/\*\/\$\{sdkSessionId\}\.jsonl/);
assert.match(claudeService, /Math\.min\(contextLimits\?\.maxConversationChars \?\? 24000, 24000\)/);
assert.match(claudeService, /Use any transcript file reference or plan file path in the handoff context/);
assert.match(claudeService, /leadContextLimit = stage\.trigger === 'after-plan' \? 12000 : 24000/);
assert.doesNotMatch(
  claudeService,
  /if \(planFilePath\) \{\s*this\.sessionApprovedPlanFiles\.set/,
  'Content-only ExitPlanMode plans must be saved for the next harness',
);

assert.match(sharedTypes, /includeTranscriptReferences: boolean/);
assert.match(sharedTypes, /includePlanFileReference: boolean/);
assert.match(sharedTypes, /avoidBulkContextOnHandoff: boolean/);
assert.match(sharedTypes, /maxHandoffConversationChars: number/);
assert.match(sharedTypes, /planContent\?: string/);
assert.match(sharedTypes, /planFilePath\?: string/);

const oldBulkMarker = 'OLD_BULK_CONTEXT_SHOULD_NOT_CROSS_HANDOFF';
const recentMarker = 'RECENT_DECISION_SHOULD_CROSS_HANDOFF';
const handoffMessages: ChatMessage[] = [
  {
    id: 'old-bulk',
    role: 'assistant',
    content: `${oldBulkMarker}\n${'large copied history '.repeat(260)}`,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    harness: 'claude',
  },
  {
    id: 'recent-decision',
    role: 'assistant',
    content: `${recentMarker}: build finished; run focused verification next.`,
    timestamp: new Date('2026-01-01T00:01:00Z'),
    harness: 'codex',
  },
];
const handoffContext = buildUnifiedHarnessContext({
  currentHarness: 'cursor',
  projectPath: root,
  includeProjectContext: false,
  orchestrationContext: 'Use phase boundaries and avoid unnecessary harness switches.',
  handoffReferences: [
    'Plan file path: /tmp/meta-harness-plan.md',
    'Claude transcript file: /Users/aj/.claude/projects/-tmp-repo/session-123.jsonl',
    'Plan file path: /tmp/meta-harness-plan.md',
    '   ',
  ],
  maxConversationChars: 900,
  messages: handoffMessages,
});

assert.match(handoffContext, /<handoff_references>/);
assert.match(handoffContext, /Context transfer between coding agents is expensive/);
assert.match(handoffContext, /Plan file path: \/tmp\/meta-harness-plan\.md/);
assert.match(handoffContext, /Claude transcript file: \/Users\/aj\/\.claude\/projects\/-tmp-repo\/session-123\.jsonl/);
assert.equal((handoffContext.match(/Plan file path: \/tmp\/meta-harness-plan\.md/g) || []).length, 1);
assert.ok(
  handoffContext.indexOf('<handoff_references>') < handoffContext.indexOf('<conversation_history>'),
  'Handoff refs must appear before pasted conversation history',
);
assert.match(handoffContext, new RegExp(recentMarker));
assert.doesNotMatch(handoffContext, new RegExp(oldBulkMarker), 'Old bulk context should be dropped under handoff budget');

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

async function runRoutingPolicyAssertion(): Promise<void> {
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
    const decision = await autoRouterService.classifyAndRoute(
      'handoff-context-policy-behavior',
      'Fix the failing tests and update the code until they pass',
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

    assert.equal(decision.tier, 'build');
    assert.equal(decision.orchestration?.contextPolicy.includeTranscriptReferences, true);
    assert.equal(decision.orchestration?.contextPolicy.includePlanFileReference, true);
    assert.equal(decision.orchestration?.contextPolicy.avoidBulkContextOnHandoff, true);
    assert.equal(decision.orchestration?.contextPolicy.maxHandoffConversationChars, 24000);
    assert.match(decision.orchestration?.handoffPrompt || '', /Context switches are expensive/);
    assert.match(decision.orchestration?.handoffPrompt || '', /transcript file references/);

    const stickyDecision = await autoRouterService.classifyAndRoute(
      'handoff-context-approved-plan-sticky',
      'OK go do it',
      {
        isSSH: true,
        remoteCliCapabilities: {
          claude: true,
          codex: true,
          cursor: true,
          gemini: true,
          opencode: true,
        },
        approvedPlanContinuation: true,
        continuationHarness: 'claude',
        continuationModel: 'claude-opus-4-8',
        skipMetaController: true,
      },
    );

    assert.equal(stickyDecision.tier, 'build');
    assert.equal(stickyDecision.resolvedHarness, 'claude');
    assert.equal(stickyDecision.resolvedModel, 'claude-opus-4-8');
    assert.match(stickyDecision.reason, /Continuing approved plan in claude/);

    const explicitSwitchDecision = await autoRouterService.classifyAndRoute(
      'handoff-context-approved-plan-explicit-switch',
      'Use Codex to execute the plan',
      {
        isSSH: true,
        remoteCliCapabilities: {
          claude: true,
          codex: true,
          cursor: true,
          gemini: true,
          opencode: true,
        },
        approvedPlanContinuation: true,
        continuationHarness: 'claude',
        continuationModel: 'claude-opus-4-8',
        skipMetaController: true,
      },
    );

    assert.equal(explicitSwitchDecision.tier, 'build');
    assert.equal(explicitSwitchDecision.resolvedHarness, 'codex');
  } finally {
    moduleWithLoad._load = originalLoad;
  }
}

runRoutingPolicyAssertion()
  .then(() => {
    console.log('auto-router handoff context verifier passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
