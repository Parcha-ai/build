import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const autoRouterService = fs.readFileSync(path.join(root, 'src/main/services/auto-router.service.ts'), 'utf8');
const flueMetaRouterService = fs.readFileSync(path.join(root, 'src/main/services/flue-meta-router.service.ts'), 'utf8');
const sharedTypes = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.match(
  claudeService,
  /private parseGoalCommand\(message: string\): \{ objective: string; source: 'slash-command' \} \| undefined/,
  'Claude service must parse the /goal slash command before execution',
);
assert.match(
  claudeService,
  /if \(explicitGoalCommand\) \{[\s\S]*?userMessage = explicitGoalCommand\.objective;[\s\S]*?selectedModel = 'auto';/s,
  '/goal must force Auto routing so the meta-harness orchestrates the objective',
);
assert.match(
  claudeService,
  /goalObjective: goalOrchestration\?\.objective,[\s\S]*?goalSource: goalOrchestration\?\.source,/s,
  'Auto routing must receive the goal objective and source',
);
assert.match(
  claudeService,
  /const ralphWithGoals = !routingDecisionForAnalytics\?\.goal && audioSettingsForGoals\?\.ralphLoopEnabled && autoBuildLeadPermissionMode === 'bypassPermissions';/,
  'Auto goal routes must not collapse into Codex native /goal; only legacy Ralph Loop may use native Codex goals',
);
assert.doesNotMatch(
  claudeService,
  /routingDecisionForAnalytics\?\.goal\?\.objective \|\| \(ralphWithGoals \? userMessage\.trim\(\) : undefined\)|const codexPrompt = ralphWithGoals \? `\/goal \$\{userMessage\}` : userMessage;/,
  'Auto goal routes must not be implemented as a single native Codex /goal run',
);

assert.match(autoRouterService, /goalObjective\?: string;/);
assert.match(autoRouterService, /goalSource\?: 'slash-command' \| 'ralph-loop';/);
assert.match(autoRouterService, /Goal-driven turn: objective is/);
assert.match(autoRouterService, /<goal>COMPLETE<\/goal>/);
assert.match(autoRouterService, /<goal>BLOCKED<\/goal>/);
assert.match(autoRouterService, /goal: \{\s*objective: goalObjective,\s*source: routeOptions\.goalSource \|\| 'slash-command',\s*\}/s);
assert.match(autoRouterService, /enableGoals: result\.tier === 'verify' \|\| Boolean\(goalObjective\)/);

assert.match(sessionStore, /activeMetaGoals: Record<string, MetaGoalState \| null>/);
assert.match(sessionStore, /function buildMetaGoalContinuationPrompt\(goal: MetaGoalState\): string/);
assert.match(
  sessionStore,
  /function buildMetaGoalContinuationPrompt\(goal: MetaGoalState\): string \{\s*return `\/goal \$\{goal\.objective\}`;\s*\}/s,
  'Meta-goal continuations must re-enter the app /goal command so every iteration reroutes through Auto',
);
assert.match(
  sessionStore,
  /if \(!suppressUserMessage\) \{[\s\S]*?activeMetaGoals:[\s\S]*?\[sessionId\]: goalObjective/s,
  'Hidden meta-goal continuations must preserve the active goal state instead of resetting it as a new user request',
);
assert.match(sessionStore, /latestState\.sendMessage\(sessionId, buildMetaGoalContinuationPrompt\(nextGoal\), undefined, \{\s*suppressUserMessage: true,/s);
assert.match(sessionStore, /activeStreamModel: decision\.resolvedModel/);
assert.match(sessionStore, /const isAutoBuildTurn = Boolean\(autoBuildDecision\);/);

assert.match(flueMetaRouterService, /goalObjective\?: string;/);
assert.match(flueMetaRouterService, /Goal requests represent a persistent objective/);
assert.match(flueMetaRouterService, /objective: redactSecrets\(request\.goalObjective\)\.slice\(0, 600\)/);

assert.match(sharedTypes, /export interface GoalOrchestration/);
assert.match(sharedTypes, /goal\?: GoalOrchestration;/);
assert.match(preload, /goal\?: \{ objective: string; source: 'slash-command' \| 'ralph-loop' \}/);

console.log('auto-router goal orchestration verifier passed');
