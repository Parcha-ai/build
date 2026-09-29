import * as http from 'node:http';

type DesignToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type DesignHandler = (brief: string) => Promise<DesignToolResult>;

interface DesignEndpoint {
  server: http.Server;
  port: number;
  handler: DesignHandler;
}

/** Session-scoped MCP endpoint used by Claude processes running over SSH. */
class DesignMcpHttpService {
  private endpoints = new Map<string, DesignEndpoint>();

  async ensure(sessionId: string, handler: DesignHandler): Promise<number> {
    const existing = this.endpoints.get(sessionId);
    if (existing) {
      existing.handler = handler;
      return existing.port;
    }

    const endpoint = { server: null as unknown as http.Server, port: 0, handler };
    const server = http.createServer((request, response) => {
      void this.handle(endpoint, request, response);
    });
    endpoint.server = server;
    endpoint.port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Design MCP server did not receive a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });
    this.endpoints.set(sessionId, endpoint);
    console.log(`[Design MCP] SSH endpoint ready for ${sessionId.substring(0, 8)} on port ${endpoint.port}`);
    return endpoint.port;
  }

  stop(sessionId: string): void {
    const endpoint = this.endpoints.get(sessionId);
    if (!endpoint) return;
    endpoint.server.close();
    this.endpoints.delete(sessionId);
  }

  private async handle(endpoint: DesignEndpoint, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'POST /mcp is required' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let message: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      this.send(response, null, undefined, { code: -32700, message: 'Parse error' });
      return;
    }

    if (message.id === undefined || message.id === null) {
      response.writeHead(204);
      response.end();
      return;
    }

    if (message.method === 'initialize') {
      this.send(response, message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claudette-design', version: '1.0.0' },
      });
      return;
    }
    if (message.method === 'ping') {
      this.send(response, message.id, {});
      return;
    }
    if (message.method === 'tools/list') {
      this.send(response, message.id, {
        tools: [{
          name: 'DesignMode',
          description: 'Start Build DesignMode for this session with a complete visual design brief.',
          inputSchema: {
            type: 'object',
            properties: { brief: { type: 'string', description: 'The complete visual design brief.' } },
            required: ['brief'],
            additionalProperties: false,
          },
        }],
      });
      return;
    }
    if (message.method === 'tools/call') {
      const params = message.params || {};
      const args = (params.arguments || {}) as Record<string, unknown>;
      if (params.name !== 'DesignMode' || typeof args.brief !== 'string' || !args.brief.trim()) {
        this.send(response, message.id, undefined, { code: -32602, message: 'DesignMode requires a non-empty brief' });
        return;
      }
      try {
        this.send(response, message.id, await endpoint.handler(args.brief));
      } catch (error) {
        this.send(response, message.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
      return;
    }

    this.send(response, message.id, undefined, { code: -32601, message: 'Method not found' });
  }

  private send(
    response: http.ServerResponse,
    id: string | number | null,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
  }
}

export const designMcpHttpService = new DesignMcpHttpService();
