import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const editorStore = fs.readFileSync(path.join(root, 'src/renderer/stores/editor.store.ts'), 'utf8');
const fsIpc = fs.readFileSync(path.join(root, 'src/main/ipc/fs.ipc.ts'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

assert.match(
  editorStore,
  /function splitPathLineSuffix\(filePath: string\)/,
  'editor store must parse clickable path:line values',
);
assert.match(
  editorStore,
  /const normalizedFilePath = parsedPath\.filePath/,
  'editor store must use normalized file path',
);
assert.match(
  editorStore,
  /const normalizedLineNumber = lineNumber \?\? parsedPath\.lineNumber/,
  'editor store must preserve line suffix as editor line number',
);
assert.match(
  editorStore,
  /window\.electronAPI\.fs\.readFile\(normalizedFilePath/,
  'editor store must not pass path:line to fs.readFile',
);

assert.match(
  fsIpc,
  /function stripPathLineSuffix\(filePath: string\)/,
  'fs IPC must normalize path:line values defensively',
);
assert.match(
  fsIpc,
  /const normalizedFilePath = resolveFilePathForSession\(filePath, session\?\.worktreePath\)/,
  'fs read/write handlers must normalize incoming paths against the session worktree',
);
assert.match(
  fsIpc,
  /sshService\.readRemoteFile\(sessionId, session\.sshConfig, normalizedFilePath\)/,
  'remote reads must receive normalized paths',
);
assert.match(
  fsIpc,
  /sshService\.writeRemoteFile\(sessionId, session\.sshConfig, normalizedFilePath, content\)/,
  'remote writes must receive normalized paths',
);

assert.match(
  sshService,
  /private stripPathLineSuffix\(filePath: string\): string/,
  'ssh service must guard direct remote file reads/writes',
);
assert.match(
  sshService,
  /const normalizedFilePath = this\.stripPathLineSuffix\(filePath\)/,
  'ssh read/write methods must strip line suffixes before shelling out',
);
assert.doesNotMatch(
  sshService,
  /const command = `cat '\$\{escapedPath\}'`;[\s\S]{0,160}Failed to read remote file \$\{filePath\}/,
  'ssh read errors must not report the unnormalized path',
);

console.log('remote file line suffix verifier passed');
