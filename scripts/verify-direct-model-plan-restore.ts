import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.match(
  service,
  /let effectivePermissionMode = permissionMode;/,
  'streamMessage must track an effective permission mode for the current turn',
);
assert.match(
  service,
  /private autoBuildForcedPlanSessions: Set<string> = new Set\(\);/,
  'Claude service must separately track Auto Build-forced plan mode',
);
assert.match(
  service,
  /getPersistedAutoBuildPrePlanMode\(sessionId: string\): string \| undefined/,
  'Claude service must read persisted Auto Build-forced plan mode across relaunches',
);
assert.match(
  service,
  /persistAutoBuildForcedPlanMode\(sessionId: string, prePlanMode: string\): void/,
  'Claude service must persist Auto Build-forced plan mode restore state',
);

const routePlanBlock = service.match(
  /if \(routingDecision\.tier === 'plan'\) \{[\s\S]*?Auto Build plan route using turn-local plan permission; session mode remains[\s\S]*?\n {10}\}/,
)?.[0] || '';

assert.ok(routePlanBlock, 'Auto Build plan routes must handle forced plan mode');
assert.match(
  routePlanBlock,
  /if \(sdkPermissionMode !== 'plan'\) \{/,
  'Auto Build plan routes must only mark forced plan mode when the original mode was not already plan',
);
assert.doesNotMatch(
  routePlanBlock,
  /this\.sessionPermissionModes\.set\(sessionId, 'plan'\)/,
  'Auto Build plan routes must not persist plan as the session permission mode',
);
assert.match(
  routePlanBlock,
  /this\.autoBuildForcedPlanSessions\.add\(sessionId\)/,
  'Auto Build plan routes must mark forced plan mode in memory',
);
assert.match(
  routePlanBlock,
  /this\.persistAutoBuildForcedPlanMode\(sessionId, prePlanMode\)/,
  'Auto Build plan routes must persist forced plan mode for relaunch recovery',
);
assert.match(
  routePlanBlock,
  /Auto Build plan route using turn-local plan permission; session mode remains/,
  'Auto Build plan routes must log that plan is turn-local',
);

const restoreBlock = service.match(
  /if \(model && model !== 'auto'\) \{[\s\S]*?console\.log\(`\[Claude Service\] Cleared Auto Build plan mode, restored to \$\{restored\}`\);[\s\S]*?\n {4}\}/,
)?.[0] || '';

assert.ok(restoreBlock, 'direct-model sends must clear Auto Build plan mode');
assert.match(
  restoreBlock,
  /const persistedAutoBuildPrePlanMode = this\.getPersistedAutoBuildPrePlanMode\(sessionId\)/,
  'direct-model plan restore must inspect persisted forced plan mode',
);
assert.match(
  restoreBlock,
  /const autoBuildForcedPlanMode = this\.autoBuildForcedPlanSessions\.has\(sessionId\) \|\| Boolean\(persistedAutoBuildPrePlanMode\)/,
  'direct-model plan restore must support in-memory and persisted forced plan markers',
);
assert.match(
  restoreBlock,
  /if \(autoBuildForcedPlanMode\) \{/,
  'direct-model plan restore must clear forced plan markers whenever they are present',
);
assert.match(
  restoreBlock,
  /this\.retireNativePlanningContinuations\(sessionId, 'direct model selected after Auto Build plan'\)/,
  'direct-model plan restore must retire native threads that still contain the Plan instruction',
);
assert.match(
  restoreBlock,
  /const shouldRestoreAutoBuildPlanMode = storedPlanMode === 'plan' \|\| effectivePermissionMode === 'plan'/,
  'direct-model plan restore must only rewrite permission mode when plan leaked into stored or effective mode',
);
assert.match(
  restoreBlock,
  /this\.autoBuildForcedPlanSessions\.delete\(sessionId\)/,
  'direct-model plan restore must clear the Auto Build-forced marker',
);
assert.match(
  restoreBlock,
  /if \(shouldRestoreAutoBuildPlanMode && effectivePermissionMode === 'plan'\) \{[\s\S]*?effectivePermissionMode = restored;/,
  'direct-model plan restore must override a stale plan argument for the current turn',
);
assert.match(
  restoreBlock,
  /CLAUDE_PERMISSION_MODE_CHANGED[\s\S]*?mode: restored/,
  'direct-model plan restore must notify the renderer about the restored permission mode',
);
assert.match(
  restoreBlock,
  /this\.persistSessionPermissionMode\(sessionId, restored\)/,
  'direct-model plan restore must persist the restored permission mode',
);
assert.match(
  restoreBlock,
  /this\.clearPersistedAutoBuildForcedPlanMode\(sessionId\)/,
  'direct-model plan restore must clear persisted forced plan markers even when no mode rewrite is needed',
);
assert.match(
  restoreBlock,
  /Cleared Auto Build plan marker; session mode remains/,
  'direct-model plan restore must log marker-only cleanup separately from permission restoration',
);
assert.match(
  service,
  /this\.persistSessionPermissionMode\(sessionId, 'bypassPermissions'\);[\s\S]*?Plan approved/,
  'plan approval must persist the backend-restored bypass permission mode',
);
assert.match(
  service,
  /setSessionPermissionMode\(sessionId: string, mode: string\): void \{[\s\S]*?this\.autoBuildForcedPlanSessions\.delete\(sessionId\);[\s\S]*?this\.clearPersistedAutoBuildForcedPlanMode\(sessionId\);/,
  'user-driven permission changes must clear Auto Build-forced plan markers',
);
assert.match(
  service,
  /if \(mode !== 'plan' && \(currentMode === 'plan' \|\| hasAutoBuildPlanMarker\)\) \{\s*this\.retireNativePlanningContinuations\(sessionId, 'permission mode left Plan'\);/,
  'leaving Plan from the permission control must retire native planning continuations',
);
assert.match(
  service,
  /private retireNativePlanningContinuations\(sessionId: string, reason: string\): void \{[\s\S]*?this\.clearSdkSessionId\(sessionId\);[\s\S]*?codexService\.clearThreadId\(sessionId\);/,
  'retiring Plan must clear both Claude and Codex native continuation handles',
);
assert.match(
  codexService,
  /preparedNativeThread\?\.resumeThreadId && permissionMode !== 'plan'[\s\S]*?The current turn is not in PLAN mode\.[\s\S]*?Any earlier instruction to remain in PLAN mode or return only a plan no longer applies\./,
  'resumed Codex threads must explicitly supersede stale Plan instructions from older releases',
);

assert.match(
  service,
  /const sdkPermissionMode: SDKPermissionMode = validModes\.includes\(effectivePermissionMode as SDKPermissionMode\)\s*\?\s*\(effectivePermissionMode as SDKPermissionMode\)/,
  'SDK permission mode must be derived from the effective permission mode',
);
assert.doesNotMatch(
  service,
  /const sdkPermissionMode: SDKPermissionMode = validModes\.includes\(permissionMode as SDKPermissionMode\)/,
  'SDK permission mode must not be derived from the stale raw permission argument',
);

const permissionModeChangedHandler = sessionStore.match(
  /const unsubPermissionModeChanged = window\.electronAPI\.claude\.onPermissionModeChanged\([\s\S]*?\n {4}\}\);/,
)?.[0] || '';

assert.ok(permissionModeChangedHandler, 'renderer must subscribe to permission mode changes from main');
assert.match(
  permissionModeChangedHandler,
  /const normalizedMode = normalizePermissionModeForModel\(sessionModel, data\.mode as PermissionMode\)/,
  'renderer must normalize main-process permission mode changes for the selected model',
);
assert.match(
  permissionModeChangedHandler,
  /window\.electronAPI\.sessions\.update\(data\.sessionId, \{ permissionMode: normalizedMode \} as any\)/,
  'renderer must persist permission mode changes received from main',
);

console.log('direct model plan restore verifier passed');
