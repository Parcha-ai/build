import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  codexFileChangeToolInput,
  normalizeCodexFileChanges,
} from '../src/main/services/codex-file-change';

const root = path.resolve(__dirname, '..');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const toolCard = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ToolCallCard.tsx'), 'utf8');
const transformer = fs.readFileSync(path.join(root, 'src/shared/utils/tool-call-transformer.ts'), 'utf8');

const nativeChanges = normalizeCodexFileChanges([
  { path: 'src/app.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
]);
assert.deepStrictEqual(nativeChanges, [
  { path: 'src/app.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
]);

const rolloutChanges = normalizeCodexFileChanges({
  'src/new.ts': { type: 'add', unified_diff: '@@ -0,0 +1 @@\n+export {}' },
  'src/old.ts': { type: 'delete', unifiedDiff: '@@ -1 +0,0 @@\n-old' },
});
assert.deepStrictEqual(rolloutChanges, [
  { path: 'src/new.ts', kind: 'add', diff: '@@ -0,0 +1 @@\n+export {}' },
  { path: 'src/old.ts', kind: 'delete', diff: '@@ -1 +0,0 @@\n-old' },
]);

const singleInput = codexFileChangeToolInput(nativeChanges);
assert.equal(singleInput.file_path, 'src/app.ts');
assert.equal(singleInput.unified_diff, nativeChanges[0].diff);
assert.deepStrictEqual(singleInput.changes, nativeChanges);

const batchInput = codexFileChangeToolInput(rolloutChanges);
assert.equal(batchInput.file_path, undefined);
assert.equal((batchInput.changes as unknown[]).length, 2);

assert.match(codexService, /case 'item\/fileChange\/patchUpdated'/);
assert.match(codexService, /normalizeCodexFileChanges\(params\.changes\)/);
assert.match(codexService, /codexFileChangeToolInput\(item\.changes \|\| \[\]\)/);
assert.match(codexService, /name: 'Command'/);
assert.doesNotMatch(codexService, /type: 'command_execution',[\s\S]{0,220}name: 'Bash'/);
assert.match(toolCard, /function UnifiedDiffView/);
assert.match(toolCard, /language="diff"/);
assert.match(toolCard, /Edit completed; Codex did not provide patch details\./);
assert.match(toolCard, /name === 'Bash' \|\| name === 'Command'/);
assert.match(transformer, /case 'Bash':\s*case 'Command':/);
assert.match(transformer, /command: 'Command'/);
assert.match(transformer, /command_execution: 'Command'/);

console.log('Codex file-change rendering verifier passed');
