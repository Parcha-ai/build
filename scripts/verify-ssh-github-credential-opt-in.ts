import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sharedTypes = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf8');
const sshForm = fs.readFileSync(path.join(root, 'src/renderer/components/session/SSHConfigForm.tsx'), 'utf8');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

assert.match(
  sharedTypes,
  /forwardGitHubCredentials\?: boolean/,
  'persisted SSH configs must support an explicit GitHub credential-forwarding opt-in',
);
assert.match(
  sshForm,
  /useState\(false\).*forwardGitHubCredentials|forwardGitHubCredentials, setForwardGitHubCredentials.*useState\(false\)/s,
  'GitHub credential forwarding must default off in the SSH form',
);
assert.match(
  sshForm,
  /saved\.forwardGitHubCredentials === true/,
  'legacy saved SSH configs must remain opted out',
);
assert.match(
  sshForm,
  /setForwardGitHubCredentials\(false\);[\s\S]*?getHostConfig\(key\)/,
  'a GitHub forwarding opt-in must not bleed from one SSH host into another',
);
assert.match(
  sshForm,
  /Leave off to preserve remote or bot credentials\./,
  'the SSH UI must explain that disabled forwarding preserves remote or bot auth',
);
assert.match(
  sshService,
  /const forwardGitHubCredentials = config\.forwardGitHubCredentials === true/,
  'the backend must require an affirmative opt-in',
);
assert.match(
  sshService,
  /forwardGitHubCredentials \? await this\.getGitHubToken\(\) : null/,
  'the backend must not read the local GitHub token while forwarding is disabled',
);
assert.match(
  sshService,
  /if \(forwardGitHubCredentials\) \{[\s\S]*?remote: '\.gitconfig'/,
  'the laptop Git identity must only be copied inside the opt-in branch',
);
assert.match(
  sshService,
  /if \(forwardGitHubCredentials && ghToken\)/,
  'the remote gh credential helper must only be changed after explicit opt-in',
);
assert.match(
  sshService,
  /GitHub credential forwarding disabled; preserving remote user\/bot auth/,
  'disabled forwarding must be observable in SSH logs',
);

console.log('SSH GitHub credential forwarding opt-in verifier passed');
