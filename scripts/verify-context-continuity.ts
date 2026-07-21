import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/services/context-continuity.service.ts'), 'utf8');

// Exports
assert.match(source, /export const contextContinuityService/, 'Must export singleton contextContinuityService');
assert.match(source, /export interface TurnContextPayload/, 'Must export TurnContextPayload interface');
assert.match(source, /export interface BuildTurnContextOpts/, 'Must export BuildTurnContextOpts interface');

// Core methods
assert.match(source, /buildTurnContext\(/, 'Must have buildTurnContext method');
assert.match(source, /buildConversationSync\(/, 'Must have buildConversationSync method');
assert.match(source, /buildDesignContext\(/, 'Must have buildDesignContext method');

// TurnContextPayload fields
assert.match(source, /systemPrompt.*string/, 'TurnContextPayload must have systemPrompt');
assert.match(source, /conversationSync\?.*string/, 'TurnContextPayload must have optional conversationSync');
assert.match(source, /designContext\?.*string/, 'TurnContextPayload must have optional designContext');

// conversation_sync format
assert.match(source, /<conversation_sync>/, 'Must use <conversation_sync> tags');
assert.match(source, /CONTINUING an existing conversation/, 'Must frame as continuing conversation');
assert.match(source, /authoritative/, 'Must frame sync as authoritative');

// Delta computation
assert.match(source, /computeDelta/, 'Must have computeDelta method');
assert.match(source, /comparableText/, 'Must have comparableText normalization');

// escapeRegExp helper
assert.match(source, /escapeRegExp/, 'Must have escapeRegExp helper');

// Design file embedding for SSH
assert.match(source, /embedded/, 'Must have file embedding logic');
assert.match(source, /remoteDir/, 'Must reference remoteDir for path rewriting');

// Lazy imports
assert.match(source, /await import\(['"]\.\/design\.service['"]\)/, 'Must use lazy import for designService');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');

// Handles both delta and full sync
assert.match(source, /delta.*full|full.*delta/, 'Must handle both delta and full sync modes');

console.log('✓ verify-context-continuity passed');
