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
  /if \(routingDecision\.tier === 'plan'\) \{\s*autoBuildLeadPermissionMode = 'plan';\s*this\.sessionPermissionModes\.set\(sessionId, 'plan'\);/s,
  'Auto Build plan routes must force the lead harness into plan permission mode',
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

console.log('auto-router plan mode verifier passed');
