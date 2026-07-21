import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/services/harness-transport.ts'), 'utf8');

// Exports
assert.match(source, /export interface HarnessTransport/, 'Must export HarnessTransport interface');
assert.match(source, /export class LocalTransport/, 'Must export LocalTransport class');
assert.match(source, /export class SSHTransport/, 'Must export SSHTransport class');
assert.match(source, /export function createTransport/, 'Must export createTransport factory');
assert.match(source, /export interface RecoverableProcess/, 'Must export RecoverableProcess interface');

// Transport kinds
assert.match(source, /kind.*=.*'local'/, 'LocalTransport must have kind = local');
assert.match(source, /kind.*=.*'ssh'/, 'SSHTransport must have kind = ssh');

// Interface methods
assert.match(source, /isRemoteTurnAlive\(/, 'Must have isRemoteTurnAlive method');
assert.match(source, /getRecoverableProcess\(/, 'Must have getRecoverableProcess method');
assert.match(source, /pushFiles\(/, 'Must have pushFiles method');
assert.match(source, /readFile\(/, 'Must have readFile method');
assert.match(source, /cleanupForNewTurn\(/, 'Must have cleanupForNewTurn method');
assert.match(source, /getWorkdir\(\)/, 'Must have getWorkdir method');
assert.match(source, /getSSHConfig\(\)/, 'Must have getSSHConfig method');

// LocalTransport returns safe defaults
assert.match(source, /return false/, 'LocalTransport.isRemoteTurnAlive must return false');
assert.match(source, /return null/, 'LocalTransport.getRecoverableProcess must return null');

// SSHTransport uses lazy imports
assert.match(source, /await import\(['"]\.\/ssh\.service['"]\)/, 'SSHTransport must use lazy import for sshService');

// Error handling in SSH transport
assert.match(source, /catch/, 'SSHTransport must catch errors');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');

console.log('✓ verify-harness-transport passed');
