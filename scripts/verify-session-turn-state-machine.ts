import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/services/session-turn.service.ts'), 'utf8');

// Exports
assert.match(source, /export const sessionTurnService/, 'Must export singleton sessionTurnService');
assert.match(source, /export type TurnState/, 'Must export TurnState type');
assert.match(source, /export interface TurnTransition/, 'Must export TurnTransition interface');
assert.match(source, /export interface TurnContext/, 'Must export TurnContext interface');
assert.match(source, /export interface RecoveryBudget/, 'Must export RecoveryBudget interface');

// All 5 states present in type
assert.match(source, /IDLE/, 'TurnState must include IDLE');
assert.match(source, /STREAMING/, 'TurnState must include STREAMING');
assert.match(source, /RECOVERING/, 'TurnState must include RECOVERING');
assert.match(source, /REATTACHING/, 'TurnState must include REATTACHING');
assert.match(source, /DRAINING/, 'TurnState must include DRAINING');

// Core methods
assert.match(source, /getState\(sessionId: string\).*TurnState/, 'Must have getState returning TurnState');
assert.match(source, /transition\(sessionId: string/, 'Must have transition method');
assert.match(source, /forceIdle\(sessionId: string/, 'Must have forceIdle method');
assert.match(source, /isActive\(sessionId: string\)/, 'Must have isActive method');
assert.match(source, /getRecoveryBudget\(/, 'Must have getRecoveryBudget method');
assert.match(source, /isRecoveryExhausted\(/, 'Must have isRecoveryExhausted method');
assert.match(source, /cleanup\(sessionId: string\)/, 'Must have cleanup method');

// Recovery budget constants
assert.match(source, /MAX_RECOVERY_ATTEMPTS\s*=\s*3/, 'Recovery must be bounded to 3 attempts');
assert.match(source, /MAX_RECOVERY_MS\s*=\s*60[_,]?000/, 'Recovery must be bounded to 60 seconds');

// Event emission
assert.match(source, /emit\('transition'/, 'Must emit transition events');

// Transition validation
assert.match(source, /isValidTransition/, 'Must have transition validation');

// Logging
assert.match(source, /\[Turn\]/, 'Must log transitions with [Turn] prefix');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');
assert.doesNotMatch(source, /require\(['"]electron['"]\)/, 'Must not require electron');

// No renderer imports
assert.doesNotMatch(source, /from ['"].*renderer/, 'Must not import from renderer');

console.log('✓ verify-session-turn-state-machine passed');
