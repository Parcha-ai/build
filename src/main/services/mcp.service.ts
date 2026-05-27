/**
 * MCP Service - Manages MCP server discovery, installation, and marketplace
 *
 * Stores MCP server configurations in electron-store and loads them into the Agent SDK at runtime.
 * This is separate from Claude Code CLI's ~/.claude/config.json
 */

import Store from 'electron-store';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { terminateProcessTree } from '../utils/process-tree';
import type {
  MCPServerInfo,
  MarketplaceMCPServer,
  MCPRegistryAuthField,
  MCPRegistryPackage,
  MCPRegistryRemote,
} from '../../shared/types';

// MCP Registry API endpoint
const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers';
const MCP_REMOTE_PACKAGE = 'mcp-remote@0.1.38';

// Cache for marketplace servers (refresh every 5 minutes)
let marketplaceCache: MarketplaceMCPServer[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Electron store for Claudette's MCP server configurations
export interface MCPServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
  tools?: Array<Record<string, unknown>>;
}

const mcpStore = new Store<Record<string, MCPServerConfig>>({
  name: 'claudette-mcp-servers',
});

const mcpHarnessSyncStore = new Store<{ managedServerIds?: string[]; removedServerIds?: string[] }>({
  name: 'claudette-mcp-harness-sync',
});

interface ClaudeMcpOptions {
  /**
   * Opt into Claude-native HTTP/SSE MCP transports. Build normally keeps
   * mcp-remote stdio wrappers so every harness can share ~/.mcp-auth.
   */
  preferNativeRemoteTransports?: boolean;
}

interface HarnessMcpSyncResult {
  cursor?: string;
  gemini?: string;
  codex?: string;
  opencode?: string;
  errors: Record<string, string>;
}

interface LocalhostMcpPort {
  serverId: string;
  port: number;
  url: string;
}

export interface MCPRemoteAuthPrewarmEvent {
  serverId: string;
  remoteUrl: string;
  reason: string;
  authenticated: boolean;
}

function cloneServerConfig(config: MCPServerConfig): MCPServerConfig {
  const cloned: MCPServerConfig = { ...config };

  if (config.args) cloned.args = [...config.args];
  else delete cloned.args;

  if (config.env) cloned.env = { ...config.env };
  else delete cloned.env;

  if (config.headers) cloned.headers = { ...config.headers };
  else delete cloned.headers;

  if (config.tools) cloned.tools = config.tools.map((tool) => ({ ...tool }));
  else delete cloned.tools;

  return cloned;
}

function getMcpRemoteUrl(config: MCPServerConfig): string | null {
  if ((config.type && config.type !== 'stdio') || !config.command || !config.args?.some(isMcpRemotePackageArg)) {
    return null;
  }

  return config.args.find((arg) => /^https?:\/\//.test(arg)) || null;
}

function isMcpRemotePackageArg(arg: string): boolean {
  return arg === 'mcp-remote' || /^mcp-remote@/.test(arg);
}

/**
 * Returns true if the config describes a native stdio MCP server — i.e. one
 * that spawns a local binary (command + args) and is NOT an mcp-remote wrapper
 * around an HTTP/SSE endpoint.  These are the servers that cannot run on a
 * remote SSH host and need the stdio-to-HTTP bridge.
 */
export function isNativeStdioServer(config: MCPServerConfig): boolean {
  if (config.url) return false;
  if (!config.command) return false;
  if (config.args?.some(isMcpRemotePackageArg)) return false;
  return true;
}

function pinMcpRemotePackageArg(args: string[]): string[] {
  let replaced = false;
  return args.map((arg) => {
    if (!replaced && isMcpRemotePackageArg(arg)) {
      replaced = true;
      return MCP_REMOTE_PACKAGE;
    }
    return arg;
  });
}

function normalizeMcpRemoteArgs(args: string[]): string[] {
  const normalized = pinMcpRemotePackageArg(args);
  const remoteUrl = normalized.find((arg) => /^https?:\/\//.test(arg));
  if (remoteUrl?.startsWith('http://') && !normalized.includes('--allow-http')) {
    normalized.push('--allow-http');
  }
  return normalized;
}

function mcpHeaderEnvName(serverId: string, headerName: string, index: number): string {
  const normalizedServer = serverId.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').toUpperCase();
  const normalizedHeader = headerName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1').toUpperCase();
  return `BUILD_MCP_${normalizedServer || 'SERVER'}_${normalizedHeader || `HEADER_${index + 1}`}`;
}

function buildMcpRemoteConfig(
  serverId: string,
  config: MCPServerConfig,
  headers?: Record<string, string>,
): MCPServerConfig {
  const args = ['-y', MCP_REMOTE_PACKAGE, config.url || ''];
  const env: Record<string, string> = {};

  if (config.url?.startsWith('http://')) {
    args.push('--allow-http');
  }

  for (const [index, [headerName, headerValue]] of Object.entries(headers || {}).entries()) {
    const envName = mcpHeaderEnvName(serverId, headerName, index);
    env[envName] = headerValue;
    args.push('--header', `${headerName}: \${${envName}}`);
  }

  const wrapped: MCPServerConfig = {
    type: 'stdio',
    command: 'npx',
    args,
  };

  if (Object.keys(env).length > 0) {
    wrapped.env = env;
  }
  if (config.alwaysLoad !== undefined) {
    wrapped.alwaysLoad = config.alwaysLoad;
  }
  if (config.tools) {
    wrapped.tools = config.tools.map((tool) => ({ ...tool }));
  }

  return wrapped;
}

function getMcpRemotePrewarmTimeoutMs(args: string[]): number {
  const timeoutIndex = args.indexOf('--auth-timeout');
  if (timeoutIndex >= 0) {
    const seconds = Number(args[timeoutIndex + 1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(seconds * 1000 + 15_000, 20_000), 190_000);
    }
  }

  return 190_000;
}

export function normalizeMcpServerForClaude(
  config: MCPServerConfig,
  options: ClaudeMcpOptions = {},
  serverId = 'server'
): MCPServerConfig {
  if (config.url) {
    if (options.preferNativeRemoteTransports) {
      return cloneServerConfig(config);
    }

    return buildMcpRemoteConfig(serverId, config, sanitizeStringMap(config.headers) || sanitizeStringMap(config.env));
  }

  const cloned = cloneServerConfig(config);
  const remoteUrl = getMcpRemoteUrl(cloned);

  if (!remoteUrl || !options.preferNativeRemoteTransports) {
    if (remoteUrl && cloned.args) {
      cloned.args = normalizeMcpRemoteArgs(cloned.args);
    }
    return cloned;
  }

  const headers = cloned.headers || {};
  const normalized: MCPServerConfig = {
    type: remoteUrl.endsWith('/sse') ? 'sse' : 'http',
    url: remoteUrl,
  };

  if (Object.keys(headers).length > 0) {
    normalized.headers = headers;
  }
  if (cloned.alwaysLoad !== undefined) {
    normalized.alwaysLoad = cloned.alwaysLoad;
  }
  if (cloned.tools) {
    normalized.tools = cloned.tools;
  }

  return normalized;
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key, val]) => key.trim() && typeof val === 'string')
    .map(([key, val]) => [key.trim(), val as string]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function findLocalhostUrls(config: MCPServerConfig): string[] {
  const candidates = [
    config.url,
    ...(config.args || []),
  ].filter((value): value is string => typeof value === 'string');

  return candidates.filter((value) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(value));
}

function getPortFromLocalhostUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return null;
    }
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    const match = url.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)(?:\/|$)/i);
    return match ? Number(match[1]) : null;
  }
}

function sanitizeHarnessConfig(config: MCPServerConfig, serverId: string): MCPServerConfig | null {
  const env = sanitizeStringMap(config.env);
  const headers = sanitizeStringMap(config.headers);

  if (config.url) {
    return buildMcpRemoteConfig(serverId, config, headers || env);
  }

  if (config.command) {
    const sanitized: MCPServerConfig = {
      command: config.command,
    };
    if (config.args?.length) {
      sanitized.args = config.args.filter((arg) => typeof arg === 'string');
      if (sanitized.args.some(isMcpRemotePackageArg)) {
        sanitized.args = normalizeMcpRemoteArgs(sanitized.args);
      }
    }
    if (env) sanitized.env = env;
    return sanitized;
  }

  return null;
}

function normalizeStoredMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  const normalized = cloneServerConfig(config);
  if (normalized.args?.some(isMcpRemotePackageArg)) {
    normalized.args = normalizeMcpRemoteArgs(normalized.args);
  }
  return normalized;
}

function configsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function parseCodexMcpHeaderName(line: string): string | null {
  const match = line.match(/^\s*\[mcp_servers\.((?:"(?:\\.|[^"])*"|[^\].]+))(?:\.env)?\]\s*$/);
  if (!match) return null;

  const rawName = match[1];
  if (rawName.startsWith('"')) {
    try {
      return JSON.parse(rawName) as string;
    } catch {
      return null;
    }
  }

  return rawName;
}

function removeCodexMcpBlocks(toml: string, serverIds: Set<string>): string {
  const lines = toml.split('\n');
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const headerName = parseCodexMcpHeaderName(line);
    const anyHeader = /^\s*\[/.test(line);

    if (headerName && serverIds.has(headerName)) {
      skipping = true;
      continue;
    }

    if (skipping && anyHeader) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n').trimEnd();
}

function renderCodexMcpBlocks(servers: Record<string, MCPServerConfig>): string {
  const blocks: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    const header = `[mcp_servers.${tomlKey(name)}]`;
    const lines = [header];

    if (config.url) {
      lines.push(`url = ${tomlString(config.url)}`);
    } else if (config.command) {
      lines.push(`command = ${tomlString(config.command)}`);
      if (config.args?.length) {
        lines.push(`args = ${tomlArray(config.args)}`);
      }
    }

    blocks.push(lines.join('\n'));

    const env = sanitizeStringMap(config.env);
    if (env && config.command) {
      const envLines = [`[mcp_servers.${tomlKey(name)}.env]`];
      for (const [key, value] of Object.entries(env)) {
        envLines.push(`${tomlKey(key)} = ${tomlString(value)}`);
      }
      blocks.push(envLines.join('\n'));
    }
  }

  return blocks.join('\n\n');
}

function renderOpenCodeMcpEntries(servers: Record<string, MCPServerConfig>): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(servers)) {
    if (config.url) {
      const remoteConfig: Record<string, unknown> = {
        type: 'remote',
        url: config.url,
        enabled: true,
      };
      const headers = sanitizeStringMap(config.headers);
      if (headers) {
        remoteConfig.headers = headers;
      }
      mcp[name] = remoteConfig;
      continue;
    }

    if (config.command) {
      const localConfig: Record<string, unknown> = {
        type: 'local',
        command: [config.command, ...(config.args || [])],
        enabled: true,
      };
      const env = sanitizeStringMap(config.env);
      if (env) {
        localConfig.environment = env;
      }
      mcp[name] = localConfig;
    }
  }

  return mcp;
}

function renderOpenCodeConfig(servers: Record<string, MCPServerConfig>): string {
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: renderOpenCodeMcpEntries(servers),
  }, null, 2)}\n`;
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = content ? JSON.parse(content) as unknown : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getObjectProperty(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Raw server entry from the MCP Registry API
 */
interface MCPRegistryServerEntry {
  server: {
    $schema?: string;
    name: string;
    description?: string;
    version?: string;
    title?: string;
    repository?: {
      url?: string;
      source?: string;
    };
    websiteUrl?: string;
    icons?: Array<{ url: string; mediaType?: string }>;
    packages?: Array<{
      registry_name: string;
      name: string;
      version?: string;
      runtime?: string;
      transport?: Array<{ type: string }>;
      environment_variables?: Array<{
        name: string;
        description?: string;
        required?: boolean;
        isSecret?: boolean;
      }>;
    }>;
    remotes?: Array<{
      transport_type: string;
      url: string;
      headers?: Array<{
        name: string;
        required?: boolean;
        isSecret?: boolean;
      }>;
    }>;
  };
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: {
      published_versions?: string[];
      is_latest?: boolean;
      published_at?: string;
    };
    'io.modelcontextprotocol.registry/publisher-provided'?: {
      documentation_url?: string;
      keywords?: string[];
      license?: string;
    };
  };
}

interface MCPRegistryResponse {
  servers: MCPRegistryServerEntry[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
}

class MCPService {
  private authPrewarmInFlight = new Set<string>();
  private remoteAuthPrewarmListeners = new Set<(event: MCPRemoteAuthPrewarmEvent) => void>();

  onRemoteAuthPrewarmFinished(listener: (event: MCPRemoteAuthPrewarmEvent) => void): () => void {
    this.remoteAuthPrewarmListeners.add(listener);
    return () => this.remoteAuthPrewarmListeners.delete(listener);
  }

  private emitRemoteAuthPrewarmFinished(event: MCPRemoteAuthPrewarmEvent): void {
    for (const listener of this.remoteAuthPrewarmListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[MCP Service] Remote MCP auth prewarm listener failed:', error);
      }
    }
  }

  private prewarmMcpRemoteAuth(serverId: string, config: MCPServerConfig): void {
    const wrapped = normalizeMcpServerForClaude(config, {}, serverId);
    const remoteUrl = getMcpRemoteUrl(wrapped);

    if (!remoteUrl || wrapped.command !== 'npx' || !wrapped.args?.some(isMcpRemotePackageArg)) {
      return;
    }

    const prewarmKey = `${serverId}:${remoteUrl}`;
    if (this.authPrewarmInFlight.has(prewarmKey)) {
      return;
    }

    this.authPrewarmInFlight.add(prewarmKey);
    const args = [...(wrapped.args || [])];
    if (!args.includes('--auth-timeout')) {
      args.push('--auth-timeout', '180');
    }

    const child = spawn('npx', args, {
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...(wrapped.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let childExited = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.authPrewarmInFlight.delete(prewarmKey);
      if (!childExited) {
        terminateProcessTree(child, 1000, true);
      }
      console.log(`[MCP Service] Remote MCP auth prewarm finished for ${serverId}: ${reason}`);
      this.emitRemoteAuthPrewarmFinished({
        serverId,
        remoteUrl,
        reason,
        authenticated: reason === 'authenticated',
      });
    };

    const timeout = setTimeout(() => finish('timeout'), getMcpRemotePrewarmTimeoutMs(args));
    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      if (
        text.includes('Proxy established successfully') ||
        text.includes('Local STDIO server running') ||
        text.includes('Authentication completed')
      ) {
        finish('authenticated');
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);
    child.on('error', (error) => {
      console.warn(`[MCP Service] Remote MCP auth prewarm failed for ${serverId}:`, error.message);
      finish('error');
    });
    child.on('exit', (code, signal) => {
      childExited = true;
      finish(`exit ${code ?? signal ?? 'unknown'}`);
    });

    console.log(`[MCP Service] Started remote MCP auth prewarm for ${serverId}`);
  }

  /**
   * Get installed MCP servers for display
   */
  getInstalledServers(): MCPServerInfo[] {
    const configs = this.getStoredMcpServersConfig();
    const servers: MCPServerInfo[] = [];

    for (const [id, config] of Object.entries(configs)) {
      servers.push({
        id,
        name: id,
        description: config.type === 'stdio'
          ? `Command: ${config.command} ${config.args?.join(' ')}`
          : `URL: ${config.url}`,
        version: '1.0.0',
        status: 'active',
        type: config.type === 'http' || config.type === 'sse' ? 'http' : 'stdio',
        tools: [],
      });
    }

    return servers;
  }

  /**
   * Get the raw electron-store config for a single MCP server
   */
  getRawConfig(serverId: string): Record<string, unknown> | null {
    const configs = this.getStoredMcpServersConfig();
    return (configs[serverId] as unknown as Record<string, unknown>) || null;
  }

  /**
   * Get all MCP servers for Agent SDK (installed + built-ins)
   */
  getUserMcpServersConfig(): Record<string, MCPServerConfig> {
    return this.getStoredMcpServersConfig();
  }

  private getStoredMcpServersConfig(): Record<string, MCPServerConfig> {
    const configs = (mcpStore as any).store as Record<string, MCPServerConfig>;
    const normalized: Record<string, MCPServerConfig> = {};
    let changed = false;

    for (const [name, config] of Object.entries(configs)) {
      normalized[name] = normalizeStoredMcpServerConfig(config);
      if (!configsEqual(normalized[name], config)) {
        changed = true;
      }
    }

    if (changed) {
      (mcpStore as any).store = normalized;
    }

    return { ...normalized };
  }

  getClaudeMcpServersConfig(options: ClaudeMcpOptions = {}): Record<string, MCPServerConfig> {
    const configs = this.getUserMcpServersConfig();
    const normalized: Record<string, MCPServerConfig> = {};

    for (const [name, config] of Object.entries(configs)) {
      normalized[name] = normalizeMcpServerForClaude(config, options, name);
    }

    return normalized;
  }

  getClaudeMcpSyncData(options: ClaudeMcpOptions = {}): { servers: Record<string, MCPServerConfig>; serverIds: string[]; removeServerIds: string[] } {
    const servers = this.getClaudeMcpServersConfig(options);
    const serverIds = Object.keys(servers);
    const removeServerIds = [...new Set([
      ...this.getHarnessManagedServerIds(),
      ...this.getHarnessRemovedServerIds(),
      ...serverIds,
    ])].sort();
    return { servers, serverIds, removeServerIds };
  }

  getHarnessMcpServersConfig(): Record<string, MCPServerConfig> {
    const configs = this.getUserMcpServersConfig();
    const sanitized: Record<string, MCPServerConfig> = {};

    for (const [name, config] of Object.entries(configs)) {
      const harnessConfig = sanitizeHarnessConfig(config, name);
      if (harnessConfig) {
        sanitized[name] = harnessConfig;
      }
    }

    return sanitized;
  }

  getHarnessManagedServerIds(): string[] {
    const ids = (mcpHarnessSyncStore as any).get('managedServerIds', []) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  getHarnessRemovedServerIds(): string[] {
    const ids = (mcpHarnessSyncStore as any).get('removedServerIds', []) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  private setHarnessManagedServerIds(ids: string[]): void {
    (mcpHarnessSyncStore as any).set('managedServerIds', [...new Set(ids)].sort());
  }

  private markHarnessServerInstalled(id: string): void {
    const removed = this.getHarnessRemovedServerIds().filter((removedId) => removedId !== id);
    (mcpHarnessSyncStore as any).set('removedServerIds', removed);
  }

  private markHarnessServerRemoved(id: string): void {
    const removed = new Set([...this.getHarnessRemovedServerIds(), id]);
    (mcpHarnessSyncStore as any).set('removedServerIds', [...removed].sort());
  }

  getHarnessMcpSyncData(): { servers: Record<string, MCPServerConfig>; serverIds: string[]; removeServerIds: string[] } {
    const servers = this.getHarnessMcpServersConfig();
    const serverIds = Object.keys(servers);
    const removeServerIds = [...new Set([
      ...this.getHarnessManagedServerIds(),
      ...this.getHarnessRemovedServerIds(),
      ...serverIds,
    ])].sort();
    return { servers, serverIds, removeServerIds };
  }

  /**
   * Get all native stdio MCP servers (those that spawn a local binary).
   * These are the ones that need the stdio-to-HTTP bridge for SSH sessions.
   */
  getNativeStdioServers(): Record<string, MCPServerConfig> {
    const configs = this.getUserMcpServersConfig();
    const native: Record<string, MCPServerConfig> = {};
    for (const [name, config] of Object.entries(configs)) {
      if (isNativeStdioServer(config)) {
        native[name] = config;
      }
    }
    return native;
  }

  /**
   * Get Claude MCP configs for SSH sessions, replacing native stdio entries
   * with HTTP bridge URLs pointing at the locally-running bridge servers.
   */
  getClaudeMcpServersConfigForSSH(
    bridgePorts: Map<string, number>,
    options: ClaudeMcpOptions = {}
  ): Record<string, MCPServerConfig> {
    const configs = this.getUserMcpServersConfig();
    const normalized: Record<string, MCPServerConfig> = {};

    for (const [name, config] of Object.entries(configs)) {
      if (bridgePorts.has(name)) {
        // Replace native stdio with HTTP pointing at the bridge
        normalized[name] = {
          type: 'http',
          url: `http://127.0.0.1:${bridgePorts.get(name)}/mcp`,
        };
        if (config.alwaysLoad !== undefined) {
          normalized[name].alwaysLoad = config.alwaysLoad;
        }
        if (config.tools) {
          normalized[name].tools = config.tools.map((tool) => ({ ...tool }));
        }
      } else {
        normalized[name] = normalizeMcpServerForClaude(config, options, name);
      }
    }

    return normalized;
  }

  /**
   * Get harness MCP sync data for SSH sessions, replacing native stdio entries
   * with HTTP bridge URLs.
   */
  getHarnessMcpSyncDataForSSH(
    bridgePorts: Map<string, number>
  ): { servers: Record<string, MCPServerConfig>; serverIds: string[]; removeServerIds: string[] } {
    const configs = this.getUserMcpServersConfig();
    const servers: Record<string, MCPServerConfig> = {};

    for (const [name, config] of Object.entries(configs)) {
      if (bridgePorts.has(name)) {
        servers[name] = {
          type: 'http',
          url: `http://127.0.0.1:${bridgePorts.get(name)}/mcp`,
        };
        if (config.alwaysLoad !== undefined) {
          servers[name].alwaysLoad = config.alwaysLoad;
        }
        if (config.tools) {
          servers[name].tools = config.tools.map((tool) => ({ ...tool }));
        }
      } else {
        const harnessConfig = sanitizeHarnessConfig(config, name);
        if (harnessConfig) {
          servers[name] = harnessConfig;
        }
      }
    }

    const serverIds = Object.keys(servers);
    const removeServerIds = [...new Set([
      ...this.getHarnessManagedServerIds(),
      ...this.getHarnessRemovedServerIds(),
      ...serverIds,
    ])].sort();

    return { servers, serverIds, removeServerIds };
  }

  /**
   * Get Claude MCP sync data for SSH sessions.
   */
  getClaudeMcpSyncDataForSSH(
    bridgePorts: Map<string, number>,
    options: ClaudeMcpOptions = {}
  ): { servers: Record<string, MCPServerConfig>; serverIds: string[]; removeServerIds: string[] } {
    const servers = this.getClaudeMcpServersConfigForSSH(bridgePorts, options);
    const serverIds = Object.keys(servers);
    const removeServerIds = [...new Set([
      ...this.getHarnessManagedServerIds(),
      ...this.getHarnessRemovedServerIds(),
      ...serverIds,
    ])].sort();
    return { servers, serverIds, removeServerIds };
  }

  getLocalhostMcpPorts(): LocalhostMcpPort[] {
    const configs = this.getUserMcpServersConfig();
    const portsByServerAndPort = new Map<string, LocalhostMcpPort>();

    for (const [serverId, config] of Object.entries(configs)) {
      for (const url of findLocalhostUrls(config)) {
        const port = getPortFromLocalhostUrl(url);
        if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
          continue;
        }
        portsByServerAndPort.set(`${serverId}:${port}`, { serverId, port, url });
      }
    }

    return [...portsByServerAndPort.values()];
  }

  buildMergedMcpJson(existingContent: string, servers: Record<string, MCPServerConfig>, removeServerIds: string[]): string {
    let data: Record<string, unknown> = {};
    try {
      data = existingContent ? JSON.parse(existingContent) as Record<string, unknown> : {};
    } catch {
      data = {};
    }

    const existingMcpServers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
      ? data.mcpServers as Record<string, unknown>
      : {};

    for (const id of removeServerIds) {
      delete existingMcpServers[id];
    }
    for (const [id, config] of Object.entries(servers)) {
      existingMcpServers[id] = config;
    }

    data.mcpServers = existingMcpServers;
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  buildMergedCodexConfig(existingContent: string, servers: Record<string, MCPServerConfig>, removeServerIds: string[]): string {
    const stripped = removeCodexMcpBlocks(existingContent || '', new Set(removeServerIds));
    const rendered = renderCodexMcpBlocks(servers);
    const next = [stripped, rendered].filter((part) => part.trim()).join('\n\n');
    return `${next.trimEnd()}\n`;
  }

  buildOpenCodeConfig(servers: Record<string, MCPServerConfig> = this.getHarnessMcpServersConfig()): string {
    return renderOpenCodeConfig(servers);
  }

  buildMergedOpenCodeConfig(
    baseContent: string,
    servers: Record<string, MCPServerConfig>,
    removeServerIds: string[],
    existingBuildContent = '',
  ): string {
    const baseData = parseJsonObject(baseContent);
    const existingBuildData = parseJsonObject(existingBuildContent);
    const data = {
      ...existingBuildData,
      ...baseData,
    };

    const existingMcp = {
      ...getObjectProperty(existingBuildData, 'mcp'),
      ...getObjectProperty(baseData, 'mcp'),
    };

    for (const id of removeServerIds) {
      delete existingMcp[id];
    }
    Object.assign(existingMcp, renderOpenCodeMcpEntries(servers));

    data.$schema = typeof data.$schema === 'string' ? data.$schema : 'https://opencode.ai/config.json';
    data.mcp = existingMcp;
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  getOpenCodeDefaultConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  }

  getOpenCodeConfigPath(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'build-mcp.json');
  }

  private async mergeMcpJsonFile(filePath: string, servers: Record<string, MCPServerConfig>, removeServerIds: Set<string>): Promise<void> {
    let existingContent = '';
    try {
      existingContent = await fs.readFile(filePath, 'utf-8');
    } catch {
      existingContent = '';
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, this.buildMergedMcpJson(existingContent, servers, [...removeServerIds]), 'utf-8');
  }

  private async mergeCodexConfig(filePath: string, servers: Record<string, MCPServerConfig>, removeServerIds: Set<string>): Promise<void> {
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch {
      existing = '';
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, this.buildMergedCodexConfig(existing, servers, [...removeServerIds]), 'utf-8');
  }

  private async writeOpenCodeConfig(filePath: string, baseConfigPath: string, servers: Record<string, MCPServerConfig>, removeServerIds: Set<string>): Promise<void> {
    let baseConfig = '';
    let existingBuildConfig = '';
    try {
      baseConfig = await fs.readFile(baseConfigPath, 'utf-8');
    } catch {
      baseConfig = '';
    }
    try {
      existingBuildConfig = await fs.readFile(filePath, 'utf-8');
    } catch {
      existingBuildConfig = '';
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      this.buildMergedOpenCodeConfig(baseConfig, servers, [...removeServerIds], existingBuildConfig),
      'utf-8'
    );
  }

  async syncLocalHarnessConfigs(): Promise<HarnessMcpSyncResult> {
    const { servers, serverIds, removeServerIds } = this.getHarnessMcpSyncData();
    const removeServerIdSet = new Set(removeServerIds);
    const homeDir = os.homedir();
    const result: HarnessMcpSyncResult = { errors: {} };

    try {
      await this.mergeMcpJsonFile(path.join(homeDir, '.cursor', 'mcp.json'), servers, removeServerIdSet);
      result.cursor = 'synced';
    } catch (error) {
      result.errors.cursor = error instanceof Error ? error.message : String(error);
    }

    try {
      await this.mergeMcpJsonFile(path.join(homeDir, '.gemini', 'settings.json'), servers, removeServerIdSet);
      result.gemini = 'synced';
    } catch (error) {
      result.errors.gemini = error instanceof Error ? error.message : String(error);
    }

    try {
      await this.mergeCodexConfig(path.join(homeDir, '.codex', 'config.toml'), servers, removeServerIdSet);
      result.codex = 'synced';
    } catch (error) {
      result.errors.codex = error instanceof Error ? error.message : String(error);
    }

    try {
      await this.writeOpenCodeConfig(
        this.getOpenCodeConfigPath(),
        this.getOpenCodeDefaultConfigPath(),
        servers,
        removeServerIdSet
      );
      result.opencode = 'synced';
    } catch (error) {
      result.errors.opencode = error instanceof Error ? error.message : String(error);
    }

    this.setHarnessManagedServerIds(serverIds);
    console.log('[MCP Service] Local harness MCP sync complete:', {
      servers: serverIds,
      errors: result.errors,
    });

    return result;
  }

  /**
   * Get list of active MCP servers (for UI display)
   */
  async getActiveServers(projectPath?: string): Promise<MCPServerInfo[]> {
    const installed = this.getInstalledServers();

    // Add built-in servers
    const builtInServers: MCPServerInfo[] = [
      {
        id: 'claudette-browser',
        name: 'Claudette Browser',
        description: 'Built-in browser automation tools (snapshot, navigate, act)',
        version: '2.0.0',
        status: 'active',
        type: 'sdk',
        tools: [
          { name: 'browser_snapshot', description: 'Capture page accessibility tree and screenshot' },
          { name: 'browser_navigate', description: 'Navigate to a URL' },
          { name: 'browser_act', description: 'Perform actions on page elements' },
        ],
      },
    ];

    return [...builtInServers, ...installed];
  }

  /**
   * Fetch all servers from the MCP Registry (handles pagination)
   */
  async fetchMarketplaceServers(): Promise<MarketplaceMCPServer[]> {
    // Return cached data if still valid
    if (marketplaceCache && Date.now() - cacheTimestamp < CACHE_TTL) {
      console.log('[MCP Service] Returning cached marketplace data');
      return marketplaceCache;
    }

    console.log('[MCP Service] Fetching servers from MCP Registry...');
    const allServers: MarketplaceMCPServer[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 20; // Safety limit

    try {
      do {
        const url = cursor ? `${MCP_REGISTRY_API}?cursor=${encodeURIComponent(cursor)}` : MCP_REGISTRY_API;

        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Claudette/1.0',
          },
        });

        if (!response.ok) {
          throw new Error(`Registry API returned ${response.status}: ${response.statusText}`);
        }

        const data: MCPRegistryResponse = await response.json();

        // Transform each server entry
        for (const entry of data.servers) {
          const server = this.transformRegistryServer(entry);
          if (server) {
            allServers.push(server);
          }
        }

        cursor = data.metadata?.nextCursor;
        pageCount++;

        console.log(`[MCP Service] Fetched page ${pageCount}, total servers: ${allServers.length}`);
      } while (cursor && pageCount < maxPages);

      // Sort by name for consistent display
      allServers.sort((a, b) => a.name.localeCompare(b.name));

      // Update cache
      marketplaceCache = allServers;
      cacheTimestamp = Date.now();

      console.log(`[MCP Service] Loaded ${allServers.length} servers from MCP Registry`);
      return allServers;
    } catch (error) {
      console.error('[MCP Service] Error fetching from MCP Registry:', error);

      // Return cached data if available, even if stale
      if (marketplaceCache) {
        console.log('[MCP Service] Returning stale cache due to fetch error');
        return marketplaceCache;
      }

      return [];
    }
  }

  /**
   * Transform a registry server entry into our MarketplaceMCPServer format
   */
  private transformRegistryServer(entry: MCPRegistryServerEntry): MarketplaceMCPServer | null {
    const { server, _meta } = entry;

    if (!server.name) {
      return null;
    }

    // Extract auth fields from packages and remotes
    const authFields: MCPRegistryAuthField[] = [];

    // From packages (environment variables)
    if (server.packages) {
      for (const pkg of server.packages) {
        if (pkg.environment_variables) {
          for (const envVar of pkg.environment_variables) {
            // Only include required or secret fields
            if (envVar.required || envVar.isSecret) {
              authFields.push({
                key: envVar.name,
                label: envVar.description || envVar.name.replace(/_/g, ' '),
                secret: envVar.isSecret ?? false,
              });
            }
          }
        }
      }
    }

    // From remotes (headers)
    if (server.remotes) {
      for (const remote of server.remotes) {
        if (remote.headers) {
          for (const header of remote.headers) {
            if (header.required || header.isSecret) {
              authFields.push({
                key: header.name,
                label: header.name.replace(/-/g, ' '),
                secret: header.isSecret ?? false,
              });
            }
          }
        }
      }
    }

    // Deduplicate auth fields by key
    const uniqueAuthFields = authFields.filter(
      (field, index, self) => index === self.findIndex((f) => f.key === field.key)
    );

    // Get display name from title or derive from ID
    const displayName = server.title || this.deriveDisplayName(server.name);

    // Get metadata
    const officialMeta = _meta?.['io.modelcontextprotocol.registry/official'];
    const publisherMeta = _meta?.['io.modelcontextprotocol.registry/publisher-provided'];

    return {
      id: server.name,
      name: displayName,
      description: server.description || `MCP Server: ${displayName}`,
      version: server.version || '1.0.0',

      repositoryUrl: server.repository?.url,
      websiteUrl: server.websiteUrl,
      license: publisherMeta?.license,

      packages: server.packages as MCPRegistryPackage[] | undefined,
      remotes: server.remotes as MCPRegistryRemote[] | undefined,

      authFields: uniqueAuthFields,
      requiresAuth: uniqueAuthFields.length > 0,

      icon: server.icons?.[0]?.url,
      keywords: publisherMeta?.keywords,
      isLatest: officialMeta?.is_latest,
      publishedAt: officialMeta?.published_at,
    };
  }

  /**
   * Derive a display name from the server ID
   */
  private deriveDisplayName(id: string): string {
    const parts = id.split('/');
    const name = parts[parts.length - 1];

    const cleanName = name
      .replace(/-mcp$/, '')
      .replace(/-server$/, '')
      .replace(/_mcp$/, '')
      .replace(/_server$/, '');

    return cleanName
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Get marketplace servers
   */
  async getMarketplaceServers(): Promise<MarketplaceMCPServer[]> {
    return this.fetchMarketplaceServers();
  }

  /**
   * Install an MCP server - stores config in electron-store
   */
  async installServer(
    server: MarketplaceMCPServer,
    authValues: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const serverId = server.id.split('/').pop() || server.id;

      // Build config based on installation method
      const npmPackage = server.packages?.find((p) => p.registry_name === 'npm');
      const remote = server.remotes?.[0];

      let config: MCPServerConfig;

      if (npmPackage) {
        config = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', npmPackage.name],
          env: authValues,
        };
      } else if (remote) {
        const headerValues: Record<string, string> = {};
        for (const header of remote.headers || []) {
          const value = authValues[header.name];
          if (value) {
            headerValues[header.name] = value;
          }
        }

        config = {
          type: remote.transport_type === 'sse' ? 'sse' : 'http',
          url: remote.url,
        };
        if (Object.keys(headerValues).length > 0) {
          config.headers = headerValues;
        }
      } else {
        return { success: false, error: 'No installation method available for this server' };
      }

      // Store in electron-store
      const servers = (mcpStore as any).store;
      servers[serverId] = config;
      (mcpStore as any).store = servers;
      this.markHarnessServerInstalled(serverId);
      this.prewarmMcpRemoteAuth(serverId, config);
      console.log('[MCP Service] Stored MCP server config:', serverId, config);

      return { success: true };
    } catch (error) {
      console.error('[MCP Service] Install error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Install an MCP server with raw config
   */
  async installServerRaw(
    serverId: string,
    config: MCPServerConfig
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[MCP Service] Installing server (raw config):', serverId, config);

      // Validate config
      if (!config.command && !config.url) {
        return { success: false, error: 'Config must have either command or url' };
      }

      // Store in electron-store
      const servers = (mcpStore as any).store;
      servers[serverId] = config;
      (mcpStore as any).store = servers;
      this.markHarnessServerInstalled(serverId);
      this.prewarmMcpRemoteAuth(serverId, config);
      console.log('[MCP Service] Stored MCP server config:', serverId);

      return { success: true };
    } catch (error) {
      console.error('[MCP Service] Install error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Uninstall an MCP server
   */
  async uninstallServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const simpleId = serverId.split('/').pop() || serverId;
      console.log('[MCP Service] Uninstalling server:', simpleId);

      const servers = (mcpStore as any).store;
      delete servers[simpleId];
      (mcpStore as any).store = servers;
      this.markHarnessServerRemoved(simpleId);
      console.log('[MCP Service] Removed MCP server config:', simpleId);

      return { success: true };
    } catch (error) {
      console.error('[MCP Service] Uninstall error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Clear the marketplace cache
   */
  clearCache(): void {
    marketplaceCache = null;
    cacheTimestamp = 0;
    console.log('[MCP Service] Cache cleared');
  }
}

export const mcpService = new MCPService();
