import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Guards the fix for lost conversation continuity: context percentage used to
// be computed from the result message's CUMULATIVE turn usage (cache reads
// re-count the context on every API call), producing readings like 134% or
// 2704% that tripped the >=95% resume gate and silently dropped --resume.
// Context occupancy must come from the LAST single API call's usage instead,
// and impossible (>100%) stored readings must be re-measured, never trusted.

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');

// 1. Both stream loops track per-API-call context tokens from top-level
//    assistant messages (subagent/sidechain calls excluded).
const trackerDeclarations = claudeService.match(/let lastApiCallContextTokens: number \| undefined;/g) || [];
assert.strictEqual(trackerDeclarations.length, 2, 'both stream loops declare lastApiCallContextTokens');

const perCallCaptures = claudeService.match(/if \(!assistantMsg\.parent_tool_use_id && assistantMsg\.message\?\.usage\) \{/g) || [];
assert.strictEqual(perCallCaptures.length, 2, 'both stream loops capture per-call usage from top-level assistant messages');

// 2. Both result handlers gate context on the per-call reading, falling back
//    to cumulative only when no per-call reading exists.
const contextTokenUses = claudeService.match(/const contextTokens = lastApiCallContextTokens \?\? inputTokens;/g) || [];
assert.strictEqual(contextTokenUses.length, 2, 'both result handlers prefer per-call context tokens');

// 3. rememberSessionContextUsage is never fed the raw cumulative result usage.
assert.ok(
  !/rememberSessionContextUsage\(sessionId, inputTokens, contextWindowSize/.test(claudeService),
  'cumulative inputTokens must not be persisted as context usage'
);
const rememberContextCalls = claudeService.match(/rememberSessionContextUsage\(sessionId, contextTokens, contextWindowSize, percentage\)/g) || [];
assert.strictEqual(rememberContextCalls.length, 2, 'both result handlers persist per-call context tokens');

// 4. The resume gate discards impossible stored readings (>100%) and
//    re-measures from the transcript instead of clearing the SDK resume.
const resolveBlock = claudeService.match(/private async resolveSessionContextPercentage\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(resolveBlock, /storedPercentage <= 100\) return storedPercentage/);
assert.match(resolveBlock, /Discarding impossible stored context reading/);
assert.match(resolveBlock, /this\.sessionContextPercentage\.delete\(sessionId\)/);
assert.match(resolveBlock, /this\.sessionStore\.delete\(`contextUsage\.\$\{sessionId\}`\)/);
assert.match(resolveBlock, /inferSessionContextPercentageFromSdkTranscript\(sessionId, session, sdkSessionId, model\)/);

// 5. Transcript-tail inference skips sidechain (subagent) entries, which run
//    in their own context windows.
const extractStart = claudeService.indexOf('private extractContextUsageFromTranscriptContent(');
const extractEnd = claudeService.indexOf('private readLocalTranscriptTail(');
assert.ok(extractStart !== -1 && extractEnd > extractStart, 'transcript usage extraction method exists');
const extractBlock = claudeService.slice(extractStart, extractEnd);
assert.match(extractBlock, /if \(entry\.isSidechain\) continue;/);

// 6. Rich getContextUsage() readings (most accurate) are persisted when available.
assert.match(claudeService, /rememberSessionContextUsage\(\s*sessionId,\s*richUsage\.totalTokens,\s*richUsage\.maxTokens,/);

console.log('verify-context-percentage-resume-gate: all checks passed');
