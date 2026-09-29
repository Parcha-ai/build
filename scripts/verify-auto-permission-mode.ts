import assert from 'assert';
import fs from 'fs';
import path from 'path';

const servicePath = path.join(__dirname, '..', 'src/main/services/claude.service.ts');
const source = fs.readFileSync(servicePath, 'utf-8');

assert.match(
  source,
  /const sdkPermissionMode: SDKPermissionMode = effectivePermissionMode === 'auto'\s*\? 'bypassPermissions'/,
  'Auto permission mode must become unattended harness execution',
);

assert.match(
  source,
  /if \(currentPermissionMode === 'bypassPermissions'\) \{[\s\S]*?behavior: 'allow'/,
  'Unattended Claude execution must allow tool calls without a user prompt',
);

assert.match(
  source,
  /const requiresDangerFlag = autoBuildLeadPermissionMode === 'bypassPermissions';/,
  'Remote native Claude execution must receive the unattended permission flag',
);

console.log('auto permission mode verifier passed');
