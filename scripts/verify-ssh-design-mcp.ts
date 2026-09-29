import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { designMcpHttpService } from '../src/main/services/design-mcp-http.service';

const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/claude.service.ts'), 'utf8');
assert.ok(source.includes('designMcpHttpService.ensure('));
assert.ok(source.includes('sshService.setupReverseTunnel('));
assert.match(source, /type: 'http',[\s\S]*?127\.0\.0\.1:\$\{designMcpPort\}\/mcp/);
assert.match(source, /Design MCP tool enabled over SSH bridge/);
assert.match(source, /designMcpHttpService\.stop\(sessionId\)/);
assert.doesNotMatch(source, /disallowedTools:\s*\['DesignSync'\]/);

async function post(port: number, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ result?: any }>;
}

async function main() {
  const sessionId = 'design-mcp-verifier';
  const port = await designMcpHttpService.ensure(sessionId, async (brief) => ({
    content: [{ type: 'text', text: `accepted:${brief}` }],
  }));
  try {
    const initialized = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(initialized.result?.serverInfo?.name, 'claudette-design');
    const listed = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(listed.result?.tools?.[0]?.name, 'DesignMode');
    const called = await post(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'DesignMode', arguments: { brief: 'test brief' } },
    });
    assert.equal(called.result?.content?.[0]?.text, 'accepted:test brief');
  } finally {
    designMcpHttpService.stop(sessionId);
  }
  console.log('SSH DesignMode MCP verifier passed');
}

void main();
