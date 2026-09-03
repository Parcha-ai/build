import assert from 'assert';
import { shouldOpenUrlInAppBrowser } from '../src/shared/utils/browser-routing';

const patterns = ['*.m.parcha.dev*', 'localhost:*', '127.0.0.1:*'];

assert.equal(shouldOpenUrlInAppBrowser('https://loops.m.parcha.dev/foo?q=1', patterns), true);
assert.equal(shouldOpenUrlInAppBrowser('localhost:3000/dashboard', patterns), true);
assert.equal(shouldOpenUrlInAppBrowser('http://127.0.0.1:5173/', patterns), true);
assert.equal(shouldOpenUrlInAppBrowser('https://github.com/parcha', patterns), false);
assert.equal(shouldOpenUrlInAppBrowser('https://example.com/', []), false);
assert.equal(shouldOpenUrlInAppBrowser('mailto:test@example.com', patterns), false);

console.log('browser link routing verifier passed');
