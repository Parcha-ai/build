import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const dialog = fs.readFileSync(path.join(root, 'src/renderer/components/session/NewSessionDialog.tsx'), 'utf8');
const authStore = fs.readFileSync(path.join(root, 'src/renderer/stores/auth.store.ts'), 'utf8');
const authService = fs.readFileSync(path.join(root, 'src/main/services/auth.service.ts'), 'utf8');
const installedVerifier = fs.readFileSync(path.join(root, 'scripts/verify-installed-build-fixes.js'), 'utf8');

assert.match(
  dialog,
  /GITHUB_REPO_UI_STABILITY_MARKER = 'github-new-session-stable-v1'/,
  'GitHub new session dialog must expose a packaged marker for this fix',
);
assert.match(
  dialog,
  /function normalizeGitHubRepo/,
  'GitHub repo payloads must be normalized before rendering',
);
assert.match(
  dialog,
  /Array\.isArray\(repos\) \? repos : \[\]/,
  'GitHub repo list must tolerate non-array store state',
);
assert.match(
  dialog,
  /safeRepos\.filter/,
  'GitHub search must operate on normalized safe repos',
);
assert.match(
  dialog,
  /function normalizeManualRepoInput/,
  'manual GitHub repo entry must be normalized before session creation',
);
assert.match(
  dialog,
  /cloneUrl = `https:\/\/github\.com\/\$\{fullName\}\.git`/,
  'manual owner/repo entry must clone via a valid GitHub HTTPS URL',
);
assert.match(
  dialog,
  /if \(isOpen && step === 'repo'\) \{[\s\S]*?void loadGitHubRepos\(\);[\s\S]*?\}/,
  'opening the GitHub repo picker must trigger repo loading',
);
assert.match(
  dialog,
  /repoListError &&/,
  'GitHub repo picker must show repo loading errors instead of silently failing',
);
assert.doesNotMatch(
  dialog,
  /repos\.filter\(/,
  'GitHub repo picker must not filter raw repos directly',
);
assert.doesNotMatch(
  dialog,
  /filteredRepos\.map\(\(repo\) => \([\s\S]*?key=\{repo\.id\}/,
  'GitHub repo picker must not key rows solely by a potentially missing raw id',
);

assert.match(
  authStore,
  /if \(!Array\.isArray\(repos\)\)/,
  'auth store must reject non-array repo payloads',
);
assert.match(
  authStore,
  /throw new Error\('GitHub repository response was not a list'\)/,
  'auth store must surface malformed repo payloads to the dialog',
);
assert.match(
  authService,
  /if \(!Array\.isArray\(data\)\)/,
  'main auth service must guard malformed GitHub API responses',
);
assert.match(
  authService,
  /\.filter\(\(repo: unknown\): repo is Record<string, unknown>/,
  'main auth service must filter invalid repo entries',
);
assert.match(
  installedVerifier,
  /github-new-session-stable-v1/,
  'installed app verifier must assert GitHub new-session UI stability marker',
);

console.log('github new session UI verifier passed');
