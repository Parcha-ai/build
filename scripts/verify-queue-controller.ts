import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/services/queue-controller.service.ts'), 'utf8');

// Exports
assert.match(source, /export const queueController/, 'Must export singleton queueController');

// Imports state machine
assert.match(source, /from ['"]\.\/session-turn\.service['"]/, 'Must import from session-turn.service');
assert.match(source, /sessionTurnService/, 'Must use sessionTurnService');

// Listens to transition events
assert.match(source, /sessionTurnService\.on\(['"]transition['"]/, 'Must listen to transition events');

// Core data management methods
assert.match(source, /enqueue\(sessionId: string/, 'Must have enqueue method');
assert.match(source, /remove\(sessionId: string/, 'Must have remove method');
assert.match(source, /edit\(sessionId: string/, 'Must have edit method');
assert.match(source, /moveToFront\(sessionId: string/, 'Must have moveToFront method');
assert.match(source, /clear\(sessionId: string/, 'Must have clear method');
assert.match(source, /getState\(sessionId: string\).*QueueState/, 'Must have getState returning QueueState');
assert.match(source, /dequeueForDrain\(/, 'Must have dequeueForDrain method');
assert.match(source, /peekForDrain\(/, 'Must have peekForDrain method');
assert.match(source, /ackDrain\(/, 'Must have ackDrain method');
assert.match(source, /hasMessages\(/, 'Must have hasMessages method');
assert.match(source, /cleanup\(/, 'Must have cleanup method');

// Safety timer
assert.match(source, /SAFETY_NET_MS\s*=\s*90[_,]?000/, 'Must have 90s safety net timer');
assert.match(source, /armSafetyTimer/, 'Must have armSafetyTimer method');
assert.match(source, /clearSafetyTimer/, 'Must have clearSafetyTimer method');
assert.match(source, /forceIdle/, 'Must use forceIdle for safety net');

// Must NOT have old queue patterns
assert.doesNotMatch(source, /onStreamStart/, 'Must NOT have onStreamStart method');
assert.doesNotMatch(source, /onStreamEnd/, 'Must NOT have onStreamEnd method');
assert.doesNotMatch(source, /drainDeferredSince/, 'Must NOT have drainDeferredSince');
assert.doesNotMatch(source, /remoteActiveDrainAllowed/, 'Must NOT have remoteActiveDrainAllowed');

// Events
assert.match(source, /emit\(['"]drain-ready['"]/, 'Must emit drain-ready event');
assert.match(source, /emit\(['"]state-changed['"]/, 'Must emit state-changed event');

// buildDrainMessage
assert.match(source, /buildDrainMessage/, 'Must have buildDrainMessage method');
assert.match(source, /sourceIds/, 'Must set sourceIds in drain message');
assert.match(source, /sourceCount/, 'Must set sourceCount in drain message');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');

console.log('✓ verify-queue-controller passed');
