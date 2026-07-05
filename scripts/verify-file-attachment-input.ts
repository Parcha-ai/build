import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const attachmentAssets = fs.readFileSync(path.join(root, 'src/main/services/attachment-file-assets.ts'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

assert.match(
  inputArea,
  /TEXT_FILE_EXTENSIONS = new Set/,
  'input area must classify pasted CSV/text files',
);
assert.match(
  inputArea,
  /readFileAsText\(file\)/,
  'input area must read pasted text files as text',
);
assert.match(
  inputArea,
  /type: 'file'/,
  'input area must create file attachments for pasted text files',
);
assert.match(
  inputArea,
  /Use the attached file\(s\) as input for the current task\./,
  'file-only sends must produce a non-empty actionable user message',
);

assert.match(
  attachmentAssets,
  /prepareFileAttachmentsForHarness/,
  'main process must expose shared file attachment preparation',
);
assert.match(
  attachmentAssets,
  /\.build', 'attachments'/,
  'file attachments must be materialized under a session-accessible workdir path',
);
assert.match(
  attachmentAssets,
  /sshService\.getConnectionForCodex/,
  'file attachment preparation must support SSH upload',
);
assert.match(
  attachmentAssets,
  /Treat them as user input for the current request/,
  'file attachment prompt block must tell the agent the file is actual user input',
);

assert.match(
  claudeService,
  /hasFileAttachments\(attachments\)/,
  'Claude stream path must recognize file attachments',
);
assert.match(
  claudeService,
  /prepareFileAttachmentsForHarness\(\s*sessionId,\s*attachments,\s*attachmentWorkingDir,\s*session\.sshConfig/,
  'Claude stream path must materialize file attachments locally or over SSH',
);
assert.match(
  claudeService,
  /fullTextMessage = `\$\{fileAttachmentPrompt\}\\n\\n\$\{fullTextMessage \|\| ATTACHMENT_ONLY_PROMPT\}`/,
  'Claude stream path must put file attachment context into the actual prompt',
);
assert.match(
  claudeService,
  /injectMessage:[\s\S]*prepareFileAttachmentsForHarness/,
  'active-query injection must include file attachments',
);
assert.match(
  claudeService,
  /prepareCliAttachments\(\s*sessionId: string,\s*message: string,\s*workingDir: string/,
  'CLI attachment preparation must receive the harness working directory',
);
assert.match(
  claudeService,
  /Prepared \$\{preparedFiles\.files\.length\} file attachment\(s\) for CLI harness/,
  'CLI harnesses must materialize file attachments',
);

assert.match(
  codexService,
  /filePromptBlock/,
  'Codex assets must carry file prompt context',
);
assert.match(
  codexService,
  /prepareCodexAssets\(sessionId, attachments \|\| \[\], workingDir, sshConfig\)/,
  'Codex must prepare file attachments before building the prompt',
);
assert.match(
  codexService,
  /prepareFileAttachmentsForHarness\(sessionId, attachments, workingDir, sshConfig\)/,
  'Codex must materialize file attachments locally or over SSH',
);
assert.match(
  codexService,
  /promptWithFiles = preparedAssets\.filePromptBlock/,
  'Codex prompt must include file attachment context',
);

assert.match(
  gitignore,
  /^\.build\/$/m,
  '.build attachment materialization directory must be ignored',
);

console.log('file attachment input verifier passed');
