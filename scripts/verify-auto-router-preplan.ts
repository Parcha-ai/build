import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Module from 'module';

const settings: Record<string, unknown> = {
  autoRouterConfig: {
    prePlanEnabled: true,
    prePlanModel: 'claude-fable-5',
    planModel: 'claude-sonnet-4-6',
    buildModel: 'codex:gpt-5.5',
    verifyModel: 'codex:gpt-5.5',
    refineModel: 'cursor:composer-2.5',
    fallbackModel: 'claude-sonnet-4-6',
    costAware: false,
  },
};

class MockStore {
  get(key: string, fallback?: unknown): unknown {
    if (key === 'settings') return settings;
    if (key === 'openAiApiKey' || key === 'openaiApiKey') return 'test-openai-key';
    return fallback;
  }
  set(): void {
    // Persistence is intentionally disabled in this isolated router verifier.
  }
}

interface ModuleWithLoad {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
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

async function main(): Promise<void> {
  const { autoRouterService } = await import('../src/main/services/auto-router.service');

  const substantial = await autoRouterService.classifyAndRoute(
    'preplan-substantial',
    'Build a new end-to-end authentication workflow across local and remote sessions, including migration and rollout handling.',
    { skipMetaController: true },
  );
  assert.strictEqual(substantial.planningGate?.action, 'start');
  assert.strictEqual(substantial.tier, 'plan');
  assert.strictEqual(substantial.resolvedModel, 'claude-fable-5');
  assert.strictEqual(substantial.orchestration?.stages.length, 1);

  const localized = await autoRouterService.classifyAndRoute(
    'preplan-localized',
    'Use codex to fix this bug in the authentication form.',
    { skipMetaController: true },
  );
  assert.notStrictEqual(localized.planningGate?.action, 'start');
  assert.strictEqual(localized.resolvedHarness, 'codex');

  const continuation = await autoRouterService.classifyAndRoute(
    'preplan-active',
    'The main user is an operations lead at a 50-person company.',
    { skipMetaController: true, prePlanActive: true },
  );
  assert.strictEqual(continuation.planningGate?.action, 'start');
  assert.strictEqual(continuation.resolvedModel, 'claude-fable-5');

  const forced = await autoRouterService.classifyAndRoute(
    'preplan-forced',
    'Add one more setting.',
    { skipMetaController: true, prePlanForced: true },
  );
  assert.strictEqual(forced.planningGate?.action, 'start');
  assert.strictEqual(forced.resolvedModel, 'claude-fable-5');

  const approved = await autoRouterService.classifyAndRoute(
    'preplan-approved',
    'Execute the approved plan now.',
    {
      skipMetaController: true,
      approvedPlanContinuation: true,
    },
  );
  assert.strictEqual(approved.planningGate?.action, 'none');
  assert.strictEqual(approved.tier, 'build');
  assert.strictEqual(approved.resolvedModel, 'codex:gpt-5.5');

  const claudeService = fs.readFileSync(
    path.join(__dirname, '..', 'src/main/services/claude.service.ts'),
    'utf8',
  );
  assert.match(claudeService, /buildAutoPlanningSystemContext/);
  assert.match(claudeService, /AUTO_PLANNING_MIN_DISCOVERY_TURNS = 1/);
  assert.match(claudeService, /AUTO_PLANNING_MAX_PLAN_WORDS = 500/);
  assert.match(claudeService, /eightyTwentyService\.loadPlaybook\(\)\.systemContext/);
  assert.match(claudeService, /Make one user decision, not a multi-round interview/);
  assert.match(claudeService, /2-3 meaningfully different narrow slices/);
  assert.match(claudeService, /isAutoPlanningFirstSliceQuestion/);
  assert.match(claudeService, /questions\.length !== 1/);
  assert.match(claudeService, /Auto Build 80\/20 choice incomplete/);
  assert.match(claudeService, /80\\\/20 First Slice/);
  assert.match(claudeService, /Smallest Implementation/);
  assert.match(claudeService, /Not Now/);
  assert.match(claudeService, /Execution Handoff/);
  assert.match(claudeService, /Build's ExitPlanMode\/Plan Panel is the single final approval gate/);
  assert.match(claudeService, /Never invoke office-hours, secondary strategy reviews, or a separate \/spec workflow/);
  assert.match(claudeService, /this\.clearSdkSessionId\(sessionId\);[\s\S]*?Retired native planning session/);
  assert.match(claudeService, /Build the following request now\. The user explicitly bypassed/);
  assert.match(claudeService, /isAutoPlanningSafeToolUse/);
  assert.match(claudeService, /Auto pre-flight allowing scoped planning tool/);
  assert.match(claudeService, /git\\s\+\(\?:add\|commit\|push/);

  const questionToolStart = claudeService.indexOf('private async handleAskUserQuestionTool(');
  const questionToolEnd = claudeService.indexOf('/** Reconstruct the SDK canUseTool contract', questionToolStart);
  const questionToolBlock = claudeService.slice(questionToolStart, questionToolEnd);
  assert.ok(questionToolStart > -1 && questionToolEnd > questionToolStart);
  assert.ok(
    questionToolBlock.indexOf('const answers = await this.askUserQuestion')
      < questionToolBlock.indexOf('questionCount: (currentPlanningState.questionCount || 0) + 1'),
    '80/20 choice progress must only increment after the user answers.',
  );
  assert.match(claudeService, /Keep the approved artifact pending until the execution lead actually/);

  const autoRouter = fs.readFileSync(
    path.join(__dirname, '..', 'src/main/services/auto-router.service.ts'),
    'utf8',
  );
  assert.match(autoRouter, /Approved plan handoff uses the configured Execution model/);
  assert.match(autoRouter, /approvedExecutionLead/);

  const settingsDialog = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/components/settings/SettingsDialog.tsx'),
    'utf8',
  );
  assert.match(settingsDialog, /Pre-build 80\/20 gate/);
  assert.match(settingsDialog, /one 80\/20 scope choice/);
  assert.match(settingsDialog, /setAutoBuildPrePlanEnabled\(savedAutoConfig\?\.prePlanEnabled !== false\)/);
  assert.match(settingsDialog, /prePlanModel,\s*\)/);

  const inputArea = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/components/chat/InputArea.tsx'),
    'utf8',
  );
  assert.match(inputArea, /Build now anyway/);
  assert.match(inputArea, /interruptAndSend\(sessionId, '\/build-now'\)/);
  assert.match(inputArea, /interruptAndSend\(sessionId, '\/80-20-first'\)/);
  assert.match(inputArea, /Run 80\/20/);

  const playbookPath = path.join(__dirname, '..', 'resources', '80-20', 'SKILL.md');
  const playbook = fs.readFileSync(playbookPath, 'utf8');
  assert.match(playbook, /^name: 80-20$/m);
  assert.match(playbook, /Keep the process to one user decision/);
  assert.match(playbook, /Identify 2–3 independently shippable first slices/);
  assert.match(playbook, /Keep the complete handoff under 500 words/);
  assert.match(playbook, /Do not invoke office-hours/);
  assert.match(playbook, /Do not invoke `\/spec` automatically/);

  const playbookService = fs.readFileSync(
    path.join(__dirname, '..', 'src/main/services/eighty-twenty.service.ts'),
    'utf8',
  );
  assert.match(playbookService, /resourcesPath\?: string/);
  assert.match(playbookService, /path\.join\(resourcesPath, '80-20'\)/);
  assert.match(playbookService, /<build_80_20_playbook/);
  assert.match(playbookService, /Do not search for, install, or invoke a project or user skill/);

  const forgeConfig = fs.readFileSync(path.join(__dirname, '..', 'forge.config.ts'), 'utf8');
  assert.match(forgeConfig, /path\.join\(__dirname, 'resources', '80-20'\)/);
  assert.match(forgeConfig, /fs\.copy\(eightyTwentySourceDir, eightyTwentyDestDir\)/);
  assert.strictEqual(
    fs.existsSync(path.join(__dirname, '..', '.claude', 'skills', '80-20', 'SKILL.md')),
    false,
    'The app-owned 80/20 playbook must not be installed into the project skill directory.',
  );

  console.log('auto-router preplan verifier passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
