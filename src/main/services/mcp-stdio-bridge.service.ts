/**
 * MCP Stdio-to-HTTP Bridge Service
 *
 * Spawns local stdio-based MCP servers and wraps them in lightweight HTTP
 * servers so remote SSH sessions can reach them via reverse-tunnelled
 * localhost ports.  The remote harness config points at
 * http://localhost:{port}/mcp instead of a stdio command that doesn't exist
 * on the remote machine.
 *
 * Protocol: MCP uses JSON-RPC 2.0 over newline-delimited JSON on stdio.
 * Each line written to stdin is a request; each line read from stdout is a
 * response or notification.
 */

import { spawn, ChildProcess } from 'child_process';
import * as http from 'node:http';
import { terminateProcessTree } from '../utils/process-tree';

/** Internal state for a single stdio bridge instance. */
interface BridgeInstance {
  /** Unique key: `${command}|${args.join('|')}` */
  key: string;
  /** The spawned stdio MCP process. */
  child: ChildProcess;
  /** HTTP server proxying to/from the child. */
  server: ReturnType<typeof http.createServer>;
  /** The port the HTTP server is listening on. */
  port: number;
  /** Session IDs currently using this bridge (reference counting). */
  sessions: Set<string>;
  /** Whether the child process is alive and ready. */
  alive: boolean;
  /** Pending JSON-RPC requests waiting for a response. */
  pending: Map<string | number, { resolve: (value: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  /** Buffered partial line from stdout. */
  stdoutBuffer: string;
  /** Request counter for generating synthetic IDs when needed. */
  requestCounter: number;
  /** Captures a spawn/exit failure that can happen before readiness listeners attach. */
  startupError?: Error;
}

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

function bridgeKey(command: string, args: string[] = [], env?: Record<string, string>): string {
  // Include env in key so different env configs don't share a bridge
  const envPart = env ? Object.entries(env).sort().map(([k, v]) => `${k}=${v}`).join('&') : '';
  return `${command}|${(args || []).join('|')}|${envPart}`;
}

class McpStdioBridgeService {
  private bridges = new Map<string, BridgeInstance>();
  /** Maps sessionId -> Set of bridge keys used by that session. */
  private sessionBridges = new Map<string, Set<string>>();

  /**
   * Start bridges for all native stdio MCP servers needed by an SSH session.
   *
   * @param sessionId  The SSH session ID.
   * @param stdioConfigs  Map of serverId -> MCPServerConfig for native stdio servers.
   * @returns Map of serverId -> local HTTP port.
   */
  async startBridgesForSession(
    sessionId: string,
    stdioConfigs: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    for (const [serverId, config] of Object.entries(stdioConfigs)) {
      if (!config.command) continue;

      try {
        const port = await this.ensureBridge(sessionId, serverId, config.command, config.args || [], config.env);
        result.set(serverId, port);
        console.log(`[MCP Bridge] Bridge ready for ${serverId}: http://127.0.0.1:${port}/mcp`);
      } catch (err) {
        console.error(`[MCP Bridge] Failed to start bridge for ${serverId}:`, err);
      }
    }

    return result;
  }

  /**
   * Stop all bridges owned by a session.  Bridges shared with other sessions
   * are only stopped when the last session releases them.
   */
  async stopBridgesForSession(sessionId: string): Promise<void> {
    const keys = this.sessionBridges.get(sessionId);
    if (!keys) return;

    for (const key of keys) {
      const bridge = this.bridges.get(key);
      if (!bridge) continue;

      bridge.sessions.delete(sessionId);
      if (bridge.sessions.size === 0) {
        await this.destroyBridge(key, bridge);
      }
    }

    this.sessionBridges.delete(sessionId);
    this.sessionBridgePortsMap.delete(sessionId);
    console.log(`[MCP Bridge] Cleaned up bridges for session ${sessionId}`);
  }

  /** Maps sessionId -> Map<serverId, port> for quick lookups. */
  private sessionBridgePortsMap = new Map<string, Map<string, number>>();

  /**
   * Get the bridge ports currently allocated for a session.
   * Returns Map of serverId -> port.
   */
  getSessionBridgePorts(sessionId: string): Map<string, number> {
    return this.sessionBridgePortsMap.get(sessionId) || new Map();
  }

  /**
   * Get all active bridge ports (for reverse tunnelling).
   */
  getBridgePorts(): Array<{ serverId: string; port: number }> {
    const result: Array<{ serverId: string; port: number }> = [];
    const seen = new Set<number>();

    for (const portMap of this.sessionBridgePortsMap.values()) {
      for (const [serverId, port] of portMap) {
        if (!seen.has(port)) {
          seen.add(port);
          result.push({ serverId, port });
        }
      }
    }

    return result;
  }

  /**
   * Tear down every bridge.  Called on app quit.
   */
  async stopAll(): Promise<void> {
    const keys = [...this.bridges.keys()];
    for (const key of keys) {
      const bridge = this.bridges.get(key);
      if (bridge) {
        await this.destroyBridge(key, bridge);
      }
    }
    this.sessionBridges.clear();
    this.sessionBridgePortsMap.clear();
    console.log('[MCP Bridge] All bridges stopped');
  }

  // ── Private ──────────────────────────────────────────────────

  private async ensureBridge(
    sessionId: string,
    serverId: string,
    command: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<number> {
    const key = bridgeKey(command, args, env);

    const bridge = this.bridges.get(key);
    if (bridge && bridge.alive) {
      // Reuse existing bridge — just add session reference
      bridge.sessions.add(sessionId);
      this.trackSessionBridge(sessionId, key, serverId, bridge.port);
      return bridge.port;
    }

    // If bridge exists but is dead, clean it up first
    if (bridge) {
      await this.destroyBridge(key, bridge);
    }

    // Spawn the stdio MCP process
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env || {}) },
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error(`Failed to spawn ${command}: no stdio streams`);
    }

    // Create bridge instance (port TBD)
    const newBridge: BridgeInstance = {
      key,
      child,
      server: null!,  // assigned below
      port: 0,        // assigned below
      sessions: new Set([sessionId]),
      alive: false,
      pending: new Map(),
      stdoutBuffer: '',
      requestCounter: 0,
    };

    // Listen for stdout lines (JSON-RPC responses)
    child.stdout.on('data', (chunk: Buffer) => {
      this.handleStdoutData(newBridge, chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      console.log(`[MCP Bridge] ${serverId} stderr: ${chunk.toString().trimEnd()}`);
    });

    child.on('error', (err) => {
      console.error(`[MCP Bridge] ${serverId} process error:`, err.message);
      newBridge.startupError = new Error(`${serverId} stdio process error during startup: ${err.message}`);
      newBridge.alive = false;
      this.rejectAllPending(newBridge, new Error(`MCP process crashed: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      console.log(`[MCP Bridge] ${serverId} process exited: code=${code} signal=${signal}`);
      newBridge.startupError = new Error(`${serverId} stdio process exited during startup: code=${code} signal=${signal}`);
      newBridge.alive = false;
      this.rejectAllPending(newBridge, new Error(`MCP process exited: code=${code} signal=${signal}`));
    });

    // Create the HTTP server
    const server = http.createServer();
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleHttpRequest(newBridge, serverId, req, res);
    });

    newBridge.server = server;

    // Bind to a random port on localhost
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`HTTP server bind timeout for ${serverId}`));
      }, 5_000);

      server.listen(0, '127.0.0.1', () => {
        clearTimeout(timeout);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      server.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    newBridge.port = port;

    // Wait for the child process to be ready — send an initialize request
    // and wait for a response (or just confirm it hasn't crashed within a timeout).
    try {
      await this.waitForReady(newBridge, serverId);
    } catch (err) {
      // Process couldn't start — clean up
      await this.destroyBridge(key, newBridge);
      throw err;
    }

    newBridge.alive = true;
    this.bridges.set(key, newBridge);
    this.trackSessionBridge(sessionId, key, serverId, port);

    return port;
  }

  private trackSessionBridge(sessionId: string, key: string, serverId: string, port: number): void {
    if (!this.sessionBridges.has(sessionId)) {
      this.sessionBridges.set(sessionId, new Set());
    }
    this.sessionBridges.get(sessionId)!.add(key);

    if (!this.sessionBridgePortsMap.has(sessionId)) {
      this.sessionBridgePortsMap.set(sessionId, new Map());
    }
    this.sessionBridgePortsMap.get(sessionId)!.set(serverId, port);
  }

  private async waitForReady(bridge: BridgeInstance, serverId: string): Promise<void> {
    if (bridge.startupError) {
      throw bridge.startupError;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        bridge.child.removeListener('exit', handleExit);
        bridge.child.removeListener('error', handleError);
        delete (bridge as any)._initChecker;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        bridge.alive = true;
        resolve();
      };
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new Error(`${serverId} stdio process exited during startup: code=${code} signal=${signal}`));
      };
      const handleError = (err: Error) => {
        fail(new Error(`${serverId} stdio process error during startup: ${err.message}`));
      };
      const timeout = setTimeout(() => {
        fail(new Error(`${serverId} stdio process did not become ready within ${STARTUP_TIMEOUT_MS}ms`));
      }, STARTUP_TIMEOUT_MS);

      // Check if the process is alive after a short delay
      // MCP servers are ready once they can accept JSON-RPC on stdin/stdout
      // We send an 'initialize' request and wait for a response
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: '__bridge_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'build-mcp-bridge', version: '1.0.0' },
        },
      });

      // Set up a one-time listener for the init response
      const checkResponse = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id === '__bridge_init__') {
            // Send initialized notification
            const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
            bridge.child.stdin?.write(initialized + '\n');
            succeed();
            return true;
          }
        } catch {
          // Not valid JSON, ignore
        }
        return false;
      };

      // Store the checker temporarily
      (bridge as any)._initChecker = checkResponse;

      // If the child dies before we hear back, reject
      bridge.child.once('exit', handleExit);
      bridge.child.once('error', handleError);

      if (bridge.startupError) {
        fail(bridge.startupError);
        return;
      }

      // Send the init request
      bridge.child.stdin?.write(initRequest + '\n');
    });
  }

  private handleStdoutData(bridge: BridgeInstance, chunk: Buffer): void {
    bridge.stdoutBuffer += chunk.toString();
    const lines = bridge.stdoutBuffer.split('\n');
    // Keep the last partial line in the buffer
    bridge.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Check if there's an init checker waiting
      const initChecker = (bridge as any)._initChecker as ((line: string) => boolean) | undefined;
      if (initChecker && initChecker(trimmed)) {
        delete (bridge as any)._initChecker;
        continue;
      }

      // Try to parse as JSON-RPC response
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && msg.id !== null) {
          const pending = bridge.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            bridge.pending.delete(msg.id);
            pending.resolve(trimmed);
            continue;
          }
        }
        // Notification or unmatched response — currently dropped
        // (SSE streaming could be added here in future)
      } catch {
        // Non-JSON line from stdout, ignore
      }
    }
  }

  private handleHttpRequest(bridge: BridgeInstance, serverId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept POST to /mcp
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. POST to /mcp.' }));
      return;
    }

    if (!bridge.alive) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: `MCP server ${serverId} is not running` },
        id: null,
      }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }));
        return;
      }

      // JSON-RPC notification (no id) — fire and forget
      if (parsed.id === undefined || parsed.id === null) {
        try {
          bridge.child.stdin?.write(body.replace(/\n/g, '') + '\n');
        } catch (err) {
          console.error(`[MCP Bridge] ${serverId} failed to write notification to stdin:`, err);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // JSON-RPC request — forward to stdio and wait for response
      const id = parsed.id;

      const timer = setTimeout(() => {
        bridge.pending.delete(id);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'MCP server request timeout' },
          id,
        }));
      }, REQUEST_TIMEOUT_MS);

      bridge.pending.set(id, {
        resolve: (response: string) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(response);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: err.message },
            id,
          }));
        },
        timer,
      });

      try {
        bridge.child.stdin?.write(body.replace(/\n/g, '') + '\n');
      } catch (err) {
        clearTimeout(timer);
        bridge.pending.delete(id);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: `Failed to write to MCP process: ${(err as Error).message}` },
          id,
        }));
      }
    });

    req.on('error', () => {
      // Client disconnected — nothing to do
    });
  }

  private rejectAllPending(bridge: BridgeInstance, err: Error): void {
    for (const [id, pending] of bridge.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    bridge.pending.clear();
  }

  private async destroyBridge(key: string, bridge: BridgeInstance): Promise<void> {
    bridge.alive = false;
    this.rejectAllPending(bridge, new Error('Bridge shutting down'));

    // Close HTTP server
    try {
      bridge.server.close();
    } catch {
      // Ignore
    }

    // Kill the child process
    try {
      terminateProcessTree(bridge.child, 2000, true);
    } catch {
      // Ignore
    }

    this.bridges.delete(key);
    console.log(`[MCP Bridge] Destroyed bridge on port ${bridge.port}`);
  }
}

export const mcpStdioBridgeService = new McpStdioBridgeService();
