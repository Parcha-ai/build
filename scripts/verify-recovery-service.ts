import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/services/recovery.service.ts'), 'utf8');

// Exports
assert.match(source, /export const recoveryService/, 'Must export singleton recoveryService');
assert.match(source, /export interface RecoveryResult/, 'Must export RecoveryResult interface');

// Core methods
assert.match(source, /handleStreamError\(/, 'Must have handleStreamError method');
assert.match(source, /handleReattachComplete\(/, 'Must have handleReattachComplete method');
assert.match(source, /canRecover\(/, 'Must have canRecover method');
assert.match(source, /cancelRecovery\(/, 'Must have cancelRecovery method');

// Imports state machine
assert.match(source, /from ['"]\.\/session-turn\.service['"]/, 'Must import from session-turn.service');
assert.match(source, /sessionTurnService/, 'Must use sessionTurnService');

// Recovery budget constants
assert.match(source, /MAX_ATTEMPTS\s*=\s*3/, 'Must have MAX_ATTEMPTS = 3');
assert.match(source, /MAX_RECOVERY_MS\s*=\s*60[_,]?000/, 'Must have MAX_RECOVERY_MS = 60000');

// Events
assert.match(source, /emit\(['"]reattach-needed['"]/, 'Must emit reattach-needed event');
assert.match(source, /emit\(['"]recovery-exhausted['"]/, 'Must emit recovery-exhausted event');

// SSHConfig handling
assert.match(source, /sshConfig\??: SSHConfig/, 'Must accept optional SSHConfig');

// Non-SSH short circuit
assert.match(source, /!sshConfig/, 'Must handle non-SSH sessions by checking sshConfig');

// Lazy import for sshService
assert.match(source, /await import\(['"]\.\/ssh\.service['"]\)/, 'Must use lazy import for sshService');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');

// Uses transition method
assert.match(source, /sessionTurnService\.transition\(/, 'Must call sessionTurnService.transition');

// Uses forceIdle for cancel
assert.match(source, /sessionTurnService\.forceIdle\(/, 'Must use forceIdle for cancelRecovery');

console.log('✓ verify-recovery-service passed');
