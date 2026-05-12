/**
 * MCP Service - Manages MCP server discovery, installation, and marketplace
 *
 * Stores MCP server configurations in electron-store and loads them into the Agent SDK at runtime.
 * This is separate from Claude Code CLI's ~/.claude/config.json
 */

import Store from 'electron-store';
import type {
  MCPServerInfo,
  MarketplaceMCPServer,
  MCPRegistryAuthField,
  MCPRegistryPackage,
  MCPRegistryRemote,
} from '../../shared/types';

// MCP Registry API endpoint
const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers';

// Cache for marketplace servers (refresh every 5 minutes)
let marketplaceCache: MarketplaceMCPServer[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Electron store for Claudette's MCP server configurations
interface MCPServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const mcpStore = new Store<Record<string, MCPServerConfig>>({
  name: 'claudette-mcp-servers',
});

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
  /**
   * Get installed MCP servers for display
   */
  getInstalledServers(): MCPServerInfo[] {
    const configs = (mcpStore as any).store as Record<string, MCPServerConfig>;
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
        type: config.type === 'http' ? 'http' : 'stdio',
        tools: [],
      });
    }

    return servers;
  }

  /**
   * Get the raw electron-store config for a single MCP server
   */
  getRawConfig(serverId: string): Record<string, unknown> | null {
    const configs = (mcpStore as any).store as Record<string, MCPServerConfig>;
    return (configs[serverId] as Record<string, unknown>) || null;
  }

  /**
   * Get all MCP servers for Agent SDK (installed + built-ins)
   */
  getUserMcpServersConfig(): Record<string, MCPServerConfig> {
    return { ...(mcpStore as any).store };
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
        config = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'mcp-remote', remote.url],
          env: authValues,
        };
      } else {
        return { success: false, error: 'No installation method available for this server' };
      }

      // Store in electron-store
      const servers = (mcpStore as any).store;
      servers[serverId] = config;
      (mcpStore as any).store = servers;
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
