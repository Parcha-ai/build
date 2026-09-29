import assert from 'assert';
import { filterRemoteClaudeArguments } from '../src/main/services/ssh.service';

const linear = { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.linear.app/mcp'] };
const unsafe = { type: 'stdio', command: '/Users/local/tool', args: [] };
const raw = JSON.stringify({ mcpServers: { linear, unsafe } });
const filtered = filterRemoteClaudeArguments(['--mcp-config', raw]);

assert.equal(filtered[0], '--mcp-config');
assert.deepEqual(JSON.parse(filtered[1]), { mcpServers: { linear } });
console.log('SSH Linear MCP verifier passed');
