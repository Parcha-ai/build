import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
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
  /this\.autoBuildForcedPlanSessions\.add\(sessionId\)/,
  'Auto Build plan routes must mark the session as Auto Build-forced plan mode',
);

const restoreBlock = service.match(
  /if \(model && model !== 'auto'\) \{[\s\S]*?console\.log\(`\[Claude Service\] Cleared Auto Build plan mode, restored to \$\{restored\}`\);[\s\S]*?\n {4}\}/,
)?.[0] || '';

assert.ok(restoreBlock, 'direct-model sends must clear Auto Build plan mode');
assert.match(
  restoreBlock,
  /storedPlanMode === 'plan' && this\.autoBuildForcedPlanSessions\.has\(sessionId\) && this\.prePlanPermissionModes\.has\(sessionId\)/,
  'direct-model plan restore must only run when Auto Build forced plan mode',
);
assert.match(
  restoreBlock,
  /this\.autoBuildForcedPlanSessions\.delete\(sessionId\)/,
  'direct-model plan restore must clear the Auto Build-forced marker',
);
assert.match(
  restoreBlock,
  /if \(effectivePermissionMode === 'plan'\) \{[\s\S]*?effectivePermissionMode = restored;/,
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
  service,
  /this\.persistSessionPermissionMode\(sessionId, 'bypassPermissions'\);[\s\S]*?Plan approved/,
  'plan approval must persist the backend-restored bypass permission mode',
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
