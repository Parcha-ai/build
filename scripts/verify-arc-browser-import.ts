import assert from 'assert';
import { createCipheriv, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  chromiumCookieTimeToUnixSeconds,
  decryptArcCookieValue,
  deriveArcCookieKey,
} from '../src/main/services/arc-browser-import.service';

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/main/services/arc-browser-import.service.ts'), 'utf8');
const browserIpc = fs.readFileSync(path.join(root, 'src/main/ipc/browser.ipc.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const browserPreview = fs.readFileSync(path.join(root, 'src/renderer/components/preview/BrowserPreview.tsx'), 'utf8');
const arcImportMenu = fs.readFileSync(path.join(root, 'src/renderer/components/preview/ArcImportMenu.tsx'), 'utf8');

function encryptFixture(password: string, hostKey: string, value: string, databaseVersion: number): string {
  const key = deriveArcCookieKey(password);
  const plaintext = databaseVersion >= 24
    ? Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  return Buffer.concat([Buffer.from('v10'), encrypted]).toString('hex');
}

const password = 'fixture-safe-storage-password';
const hostKey = '.example.com';
const cookieValue = 'signed-in-session-token';
const key = deriveArcCookieKey(password);

const v24Fixture = encryptFixture(password, hostKey, cookieValue, 24);
assert.equal(decryptArcCookieValue(v24Fixture, hostKey, 24, key), cookieValue);
assert.equal(
  decryptArcCookieValue(v24Fixture, '.wrong.example', 24, key),
  null,
  'v24 cookies must verify the encrypted domain hash',
);

const v23Fixture = encryptFixture(password, hostKey, cookieValue, 23);
assert.equal(decryptArcCookieValue(v23Fixture, hostKey, 23, key), cookieValue);
assert.equal(decryptArcCookieValue('76313100', hostKey, 24, key), null);
key.fill(0);

assert.equal(chromiumCookieTimeToUnixSeconds('13344473600000000'), 1_700_000_000);
assert.equal(chromiumCookieTimeToUnixSeconds('0'), undefined);

assert.match(service, /find-generic-password', '-w', '-s', ARC_SAFE_STORAGE_SERVICE/);
assert.match(service, /\.backup \$\{quotedSnapshotPath\}/);
assert.match(service, /topFrameSiteKey\) return 'skipped'/);
assert.match(service, /await targetSession\.cookies\.flushStore\(\)/);
assert.doesNotMatch(service, /console\.(?:log|debug)\([^\n]*(?:password|encryptedValue|cookie\.value)/i);

assert.match(browserIpc, /BROWSER_LIST_ARC_PROFILES/);
assert.match(browserIpc, /BROWSER_IMPORT_ARC_COOKIES/);
assert.match(browserIpc, /getBrowserPartitionName\(partitionId\)/);
assert.match(preload, /listArcProfiles: \(\): Promise<ArcBrowserProfile\[\]>/);
assert.match(preload, /importArcCookies: \(partitionId: string, profileId: string\): Promise<ArcCookieImportResult>/);
assert.match(browserPreview, /partitionId=\{partitionId \|\| session\.id\}/);
assert.match(browserPreview, /<form onSubmit=\{handleUrlSubmit\} className="min-w-0 flex-1">/);
assert.match(browserPreview, /aria-label="More browser actions"/);
assert.match(browserPreview, /Clear browser data/);
assert.match(arcImportMenu, /Copies cookies and sign-ins into this Build browser profile/);
assert.match(arcImportMenu, /window\.electronAPI\.browser\.importArcCookies\(partitionId, profile\.id\)/);
assert.match(arcImportMenu, /createPortal\(/);
assert.match(arcImportMenu, /window\.innerWidth - width - VIEWPORT_MARGIN/);
assert.doesNotMatch(arcImportMenu, /className="absolute right-0 top-full/);

console.log('Arc browser import verifier passed');
