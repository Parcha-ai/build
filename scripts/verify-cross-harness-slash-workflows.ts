import assert from 'assert';
import fs from 'fs';
import path from 'path';
import type { Command, Skill } from '../src/shared/types';
import {
  parseSlashWorkflowInvocation,
  resolveSlashWorkflowFromDefinitions,
  selectSlashWorkflowDefinition,
} from '../src/main/services/slash-workflow.service';

const command = (
  name: string,
  content: string,
  scope: 'user' | 'project' = 'project',
): Command => ({
  name,
  content,
  scope,
  path: `${scope === 'project' ? '/repo' : '/home/test'}/.claude/commands/${name}.md`,
});

const skill = (
  name: string,
  content: string,
  scope: 'user' | 'project' = 'project',
): Skill => ({
  name,
  content,
  scope,
  path: `${scope === 'project' ? '/repo' : '/home/test'}/.claude/skills/${name}`,
});

assert.deepEqual(parseSlashWorkflowInvocation('/pr force'), {
  name: 'pr',
  arguments: 'force',
  originalMessage: '/pr force',
});
assert.deepEqual(parseSlashWorkflowInvocation('Run /pr skill'), {
  name: 'pr',
  arguments: '',
  originalMessage: 'Run /pr skill',
});
assert.deepEqual(parseSlashWorkflowInvocation('invoke /release workflow with staging'), {
  name: 'release',
  arguments: 'staging',
  originalMessage: 'invoke /release workflow with staging',
});
assert.equal(parseSlashWorkflowInvocation('Can you explain what /pr does?'), null);

const commands = [
  command('pr', 'USER PR', 'user'),
  command('pr', 'PROJECT PR $ARGUMENTS then /git-pr and /pr-tests'),
  command('git-pr', 'CREATE PR with $ARGUMENTS'),
  command('pr-tests', 'CHECK CI then /review:final'),
  command('review:final', 'FINAL REVIEW'),
];
const skills = [
  skill('pr', 'SHADOWED SKILL'),
  skill('qa-request', 'CREATE QA'),
];

const selected = selectSlashWorkflowDefinition('PR', commands, skills);
assert.equal(selected?.scope, 'project');
assert.equal(selected?.kind, 'command');
assert.equal(selected?.content, 'PROJECT PR $ARGUMENTS then /git-pr and /pr-tests');

const resolved = resolveSlashWorkflowFromDefinitions('Run /pr skill with --base main', commands, skills);
assert.ok(resolved);
assert.equal(resolved.definition.path, '/repo/.claude/commands/pr.md');
assert.match(resolved.prompt, /PROJECT PR --base main then \/git-pr and \/pr-tests/);
assert.match(resolved.prompt, /name="\/git-pr"/);
assert.match(resolved.prompt, /name="\/pr-tests"/);
assert.match(resolved.prompt, /name="\/review:final"/);
assert.doesNotMatch(resolved.prompt, /USER PR/);
assert.doesNotMatch(resolved.prompt, /SHADOWED SKILL/);
assert.match(resolved.prompt, /do not search old transcripts/);
assert.match(resolved.prompt, /!`command`/);

const positional = resolveSlashWorkflowFromDefinitions(
  '/release "candidate one" force',
  [command('release', 'Release $1 using ${2}; all=$ARGUMENTS')],
  [],
);
assert.match(positional?.prompt || '', /Release candidate one using force; all="candidate one" force/);

assert.equal(resolveSlashWorkflowFromDefinitions('/goal finish it', [command('goal', 'shadow')], []), null);
assert.equal(resolveSlashWorkflowFromDefinitions('/missing', commands, skills), null);

const root = path.resolve(__dirname, '..');
const claudeIpc = fs.readFileSync(path.join(root, 'src/main/ipc/claude.ipc.ts'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const compactInputArea = fs.readFileSync(path.join(root, 'src/renderer/components/command-center/CompactInputArea.tsx'), 'utf8');

assert.match(claudeIpc, /const streamSession = await sessionService\.getSession\(sessionId\)\.catch\(\(\) => null\)/);
assert.match(claudeIpc, /const modelMessage = await resolveCrossHarnessWorkflowMessage\(sessionId, message, streamSession\)/);
assert.match(claudeIpc, /streamMessage\(sessionId, modelMessage,/);
assert.match(claudeIpc, /const injectedText = await resolveCrossHarnessWorkflowMessage\(sessionId, next\.text, session\)/);
assert.doesNotMatch(inputArea, /extensions\.getCommand\(/);
assert.doesNotMatch(compactInputArea, /extensions\.getCommand\(/);

console.log('cross-harness slash workflow verifier passed');
