import assert from 'assert';
import fs from 'fs';
import path from 'path';

const servicePath = path.join(__dirname, '..', 'src/main/services/claude.service.ts');
const source = fs.readFileSync(servicePath, 'utf-8');

function assertContains(pattern: RegExp, message: string): void {
  assert.ok(pattern.test(source), message);
}

assertContains(
  /let autoBuildLeadPermissionMode: SDKPermissionMode = sdkPermissionMode;/,
  'Claude service must keep a separate lead permission mode for Auto Build execution',
);
assertContains(
  /if \(routingDecision\.tier === 'plan'\) \{\s*autoBuildLeadPermissionMode = 'plan';[\s\S]*?persistAutoBuildForcedPlanMode\(sessionId, prePlanMode\);/s,
  'Auto Build plan routes must force the lead harness into turn-local plan permission mode and remember how to restore execution mode',
);
assertContains(
  /Cleared stale Auto Build plan marker for \$\{routingDecision\.tier\} execution route/,
  'A Build/Verify/Refine route must clear Auto Build forced-plan markers instead of carrying plan state forward',
);
assertContains(
  /if \(hadForcedPlanMarker\) \{\s*this\.retireNativePlanningContinuations\([\s\S]*?`Auto Build advanced from Plan to \$\{routingDecision\.tier\}`/s,
  'A Build/Verify/Refine route must start outside any native thread that still contains the Plan instruction',
);
assertContains(
  /codexService\.streamAsChat\([^;]*autoBuildLeadPermissionMode(?:,|\))/s,
  'Codex lead execution must receive the Auto Build lead permission mode',
);
assertContains(
  /openCodeService\.streamMessage\([^;]*autoBuildLeadPermissionMode(?:,|\))/s,
  'OpenCode lead execution must receive the Auto Build lead permission mode',
);
assertContains(
  /permissionMode: autoBuildLeadPermissionMode,/,
  'Claude Code query must receive the Auto Build lead permission mode',
);
assertContains(
  /const requiresDangerFlag = autoBuildLeadPermissionMode === 'bypassPermissions';/,
  'Dangerous skip-permissions flag must be based on the lead permission mode',
);
assertContains(
  /this\.streamLeadWithAutoBuildStages\([\s\S]*?autoOrchestrationContext,\s*sdkPermissionMode,/,
  'Auto Build helper-stage mutability must remain governed by the original session permission mode',
);
assertContains(
  /if \(selectionMode === 'auto'\) \{\s*this\.scheduleAutoPlanExecutionHandoff\(sessionId,\s*true\);/s,
  'Approving a live Auto plan must schedule an execution handoff',
);
assertContains(
  /setTimeout\(\(\) => \{[\s\S]*?query\.interrupt\(\)/s,
  'The approval handoff must interrupt the live planning Query after its permission response is delivered',
);
assertContains(
  /consumeAutoPlanExecutionHandoff\(sessionId, abortController\)[\s\S]*?this\.streamMessage\([\s\S]*?'Execute the approved plan now\.'[\s\S]*?'auto'/s,
  'An interrupted planning Query must re-enter Auto Build in the same visible stream',
);
assertContains(
  /catch \(error\) \{[\s\S]*?consumeAutoPlanExecutionHandoff\(sessionId, abortController\)[\s\S]*?'Execute the approved plan now\.'/s,
  'An interrupt rejection must still re-enter Auto Build instead of surfacing as a planning error',
);
assertContains(
  /const approvedPlanPending = this\.isApprovedPlanExecutionPending\(sessionId\);[\s\S]*?const approvedPlanContinuation = approvedPlanPending\s*&& this\.isApprovedPlanExecutionRequest\(userMessage\);/,
  'Approved plan execution must be a persisted one-shot boundary gated by an explicit execution follow-up',
);
assertContains(
  /this\.markApprovedPlanExecutionCompleted\(sessionId\);/,
  'Only a successfully completed execution lead may consume the one-shot approval boundary',
);
assertContains(
  /if \(handoff\.retirePlanningSession\) \{[\s\S]*?this\.clearSdkSessionId\(sessionId\);[\s\S]*?codexService\.clearThreadId\(sessionId\);/s,
  'Claude and Codex planning-native sessions must be retired before the configured execution harness starts',
);
assertContains(
  /const approvedPlanHandoffContext = approvedPlanContinuation\s*\? this\.buildApprovedPlanHandoffContext\(sessionId\)\s*:\s*'';/,
  'Approved-plan content must not be injected into unrelated Auto turns',
);
assertContains(
  /const recoveredInput = this\.recoveredQueryInputs\.get\(sessionId\);[\s\S]*?request: \{ subtype: 'interrupt' \}/s,
  'An approved recovered SSH plan must interrupt the detached planning CLI through its stdin bridge',
);
assertContains(
  /releaseTurnLock\(\);[\s\S]*?yield\* this\.streamMessage\([\s\S]*?'Execute the approved plan now\.'[\s\S]*?'auto'/s,
  'Recovered plan approval must release the reattach lock and continue into Auto execution',
);

console.log('auto-router plan mode verifier passed');
