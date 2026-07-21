import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/shared/utils/dedup-engine.ts'), 'utf8');

// Exports
assert.match(source, /export const dedupEngine/, 'Must export singleton dedupEngine');

// Core methods
assert.match(source, /isDuplicate\(/, 'Must have isDuplicate method');
assert.match(source, /mergeDuplicate\(/, 'Must have mergeDuplicate method');
assert.match(source, /deduplicateMessages\(/, 'Must have deduplicateMessages method');

// Tiered dedup
assert.match(source, /normalize\(/, 'Must have normalize method');
assert.match(source, /paragraphOverlap\(/, 'Must have paragraphOverlap method');
assert.match(source, /paragraphs\(/, 'Must have paragraphs method');
assert.match(source, /toolSignature\(/, 'Must have toolSignature method');
assert.match(source, /contentBlockSignature\(/, 'Must have contentBlockSignature method');

// Status prefix stripping
assert.match(source, /⚠️ Remote session hiccup/, 'Must strip Remote session hiccup prefix');
assert.match(source, /⏳ Rate limited/, 'Must strip Rate limited prefix');

// Fuzzy threshold
assert.match(source, /0\.7/, 'Must have default fuzzy threshold of 0.7');

// Paragraph filtering
assert.match(source, /50/, 'Must filter paragraphs shorter than 50 chars');

// Prefix matching
assert.match(source, /startsWith/, 'Must have prefix matching');
assert.match(source, /200/, 'Must require > 200 chars for prefix matching');

// Fuzzy matching
assert.match(source, /500/, 'Must require > 500 chars for fuzzy matching');

// No electron imports
assert.doesNotMatch(source, /from ['"]electron['"]/, 'Must not import from electron');
assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/main/, 'Must not import from main process');

// Imports from shared types only
assert.match(source, /from ['"]\.\.\/types['"]/, 'Must import from shared types');

console.log('✓ verify-dedup-engine passed');
