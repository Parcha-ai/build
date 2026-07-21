import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const marketplace = fs.readFileSync(
  path.join(root, 'src/renderer/components/extensions/UnifiedMarketplace.tsx'),
  'utf8',
);

assert.match(
  marketplace,
  /useState<MarketplaceTab>\('plugins'\)/,
  'Extensions Marketplace should open on the plugin catalog',
);
assert.match(marketplace, /const \[mcpLoading, setMcpLoading\] = useState\(true\)/);
assert.match(marketplace, /const \[pluginLoading, setPluginLoading\] = useState\(true\)/);
assert.match(marketplace, /const loadMcpData = async \(\) =>/);
assert.match(marketplace, /const loadPluginData = async \(\) =>/);
assert.match(
  marketplace,
  /void loadPluginData\(\);\s*void loadMcpData\(\);/,
  'plugin and MCP catalogs should start independently',
);

const dataLoadBlock = marketplace.slice(
  marketplace.indexOf('const loadMcpData'),
  marketplace.indexOf('// Debounce search query'),
);
assert.doesNotMatch(
  dataLoadBlock,
  /Promise\.all/,
  'slow MCP pagination must not block the local plugin catalog',
);
assert.match(
  marketplace,
  /const activeLoading = activeTab === 'plugins' \? pluginLoading : mcpLoading/,
  'loading state must follow the visible catalog only',
);

const tabBarIndex = marketplace.indexOf('{/* Tab Bar */}');
const activeLoadingIndex = marketplace.indexOf('{activeLoading ? (');
assert.ok(tabBarIndex >= 0 && activeLoadingIndex > tabBarIndex, 'catalog tabs must remain usable while one source loads');

assert.doesNotMatch(
  marketplace,
  /await loadData\(\)/,
  'plugin actions must not refetch and wait for the unrelated MCP registry',
);

console.log('Unified marketplace loading verifier passed');
