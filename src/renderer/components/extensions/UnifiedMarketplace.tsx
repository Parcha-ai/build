import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Server,
  Puzzle,
  Download,
  Check,
  Loader2,
  Search,
  ExternalLink,
  Key,
  Package,
  Globe,
  Calendar,
  Tag,
  RefreshCw,
  AlertCircle,
  Terminal,
  Sparkles,
  Bot,
  Wrench,
  Power,
  PowerOff,
  Trash2,
  X,
} from 'lucide-react';
import type { MarketplaceMCPServer, MCPServerInfo, MarketplacePlugin } from '../../../shared/types';
import MCPInstallDialog from './MCPInstallDialog';

interface UnifiedMarketplaceProps {
  sessionId: string;
  projectPath?: string;
  installedMcpServers: MCPServerInfo[];
  onMcpServerInstalled: () => void;
}

type MarketplaceTab = 'mcp' | 'plugins';

// Unified item type for display
interface MarketplaceItem {
  type: 'mcp' | 'plugin';
  id: string;
  name: string;
  description: string;
  installed: boolean;
  enabled?: boolean;

  // MCP specific
  mcpServer?: MarketplaceMCPServer;

  // Plugin specific
  plugin?: MarketplacePlugin;
}

// Derive category from MCP server
function deriveMcpCategory(server: MarketplaceMCPServer): string {
  const keywords = server.keywords?.map((k) => k.toLowerCase()) || [];
  const name = server.name.toLowerCase();
  const id = server.id.toLowerCase();

  if (keywords.some((k) => ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'redis'].includes(k))) {
    return 'Database';
  }
  if (keywords.some((k) => ['browser', 'web', 'puppeteer', 'playwright', 'selenium'].includes(k))) {
    return 'Browser';
  }
  if (keywords.some((k) => ['api', 'rest', 'graphql', 'http'].includes(k))) {
    return 'API';
  }
  if (keywords.some((k) => ['file', 'filesystem', 'storage', 's3'].includes(k))) {
    return 'Storage';
  }
  if (keywords.some((k) => ['ai', 'llm', 'openai', 'anthropic', 'ml'].includes(k))) {
    return 'AI';
  }
  if (keywords.some((k) => ['search', 'elasticsearch', 'algolia'].includes(k))) {
    return 'Search';
  }
  if (keywords.some((k) => ['git', 'github', 'gitlab', 'bitbucket'].includes(k))) {
    return 'Version Control';
  }
  if (keywords.some((k) => ['slack', 'discord', 'teams', 'communication'].includes(k))) {
    return 'Communication';
  }
  if (keywords.some((k) => ['monitor', 'observability', 'logging', 'metrics'].includes(k))) {
    return 'Monitoring';
  }

  if (name.includes('database') || name.includes('db') || id.includes('postgres') || id.includes('sql')) {
    return 'Database';
  }
  if (name.includes('browser') || id.includes('puppeteer') || id.includes('playwright')) {
    return 'Browser';
  }
  if (name.includes('file') || id.includes('filesystem')) {
    return 'Storage';
  }

  return 'Other';
}

// Derive category from plugin
function derivePluginCategory(plugin: MarketplacePlugin): string {
  const name = plugin.name.toLowerCase();
  const id = plugin.id.toLowerCase();

  if (id.includes('lsp') || name.includes('language server')) {
    return 'Language Server';
  }
  if (id.includes('commit') || id.includes('git') || id.includes('pr-')) {
    return 'Git & Code Review';
  }
  if (id.includes('output-style') || id.includes('style')) {
    return 'Output Style';
  }
  if (id.includes('frontend') || id.includes('design')) {
    return 'Frontend';
  }
  if (id.includes('sdk') || id.includes('dev') || id.includes('plugin-dev')) {
    return 'Development';
  }
  if (id.includes('security')) {
    return 'Security';
  }

  return 'General';
}

export default function UnifiedMarketplace({
  sessionId,
  projectPath,
  installedMcpServers,
  onMcpServerInstalled,
}: UnifiedMarketplaceProps) {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('plugins');
  const [mcpLoading, setMcpLoading] = useState(true);
  const [pluginLoading, setPluginLoading] = useState(true);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [refreshing, setRefreshing] = useState(false);

  // MCP state
  const [mcpServers, setMcpServers] = useState<MarketplaceMCPServer[]>([]);
  const [selectedMcpServer, setSelectedMcpServer] = useState<MarketplaceMCPServer | null>(null);
  const [showMcpInstallDialog, setShowMcpInstallDialog] = useState(false);

  // Plugin state
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [installingPlugin, setInstallingPlugin] = useState<string | null>(null);
  const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null);

  // GitHub install dialog state (for plugins)
  const [showGitHubInstallDialog, setShowGitHubInstallDialog] = useState(false);

  // Manual MCP install dialog state (for custom URLs/packages)
  const [showManualMcpInstallDialog, setShowManualMcpInstallDialog] = useState(false);

  const loadMcpData = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const mcpData = await window.electronAPI.mcp.getMarketplace();
      setMcpServers(mcpData);
    } catch (err) {
      console.error('[UnifiedMarketplace] Error loading MCP marketplace:', err);
      setMcpError(err instanceof Error ? err.message : 'Failed to load MCP marketplace');
    } finally {
      setMcpLoading(false);
    }
  };

  const loadPluginData = async () => {
    setPluginLoading(true);
    setPluginError(null);
    try {
      const pluginData = await window.electronAPI.plugins.getAvailable();
      setPlugins(pluginData);
    } catch (err) {
      console.error('[UnifiedMarketplace] Error loading plugin marketplace:', err);
      setPluginError(err instanceof Error ? err.message : 'Failed to load plugin marketplace');
    } finally {
      setPluginLoading(false);
    }
  };

  useEffect(() => {
    // The local plugin manifests should never wait for the separately paged
    // remote MCP registry before they can render.
    void loadPluginData();
    void loadMcpData();
  }, []);

  // Debounce search query for better performance
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 200); // 200ms debounce

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Refresh handler
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      if (activeTab === 'plugins') {
        await window.electronAPI.plugins.updateMarketplaces();
        await loadPluginData();
      } else {
        await loadMcpData();
      }
    } finally {
      setRefreshing(false);
    }
  };

  // Check if MCP server is installed
  const isMcpInstalled = (serverId: string) => {
    const simpleId = serverId.split('/').pop() || serverId;
    return installedMcpServers.some(
      (s) => s.id === serverId || s.id === simpleId || s.name.toLowerCase() === simpleId.toLowerCase()
    );
  };

  // Deduplicate MCP servers - keep only latest version of each unique server
  const uniqueMcpServers = useMemo(() => {
    const serverMap = new Map<string, MarketplaceMCPServer>();

    for (const server of mcpServers) {
      // Extract base name (everything before version/variant suffix)
      // e.g., "ai.exa/exa:1.0.0" -> "ai.exa/exa"
      const baseName = server.id.split(':')[0];

      const existing = serverMap.get(baseName);
      if (!existing) {
        serverMap.set(baseName, server);
      } else {
        // Keep the one marked as latest, or compare versions
        if (server.isLatest) {
          serverMap.set(baseName, server);
        } else if (!existing.isLatest && server.version > existing.version) {
          serverMap.set(baseName, server);
        }
      }
    }

    return Array.from(serverMap.values());
  }, [mcpServers]);

  // Derive categories based on active tab
  const categories = useMemo(() => {
    if (activeTab === 'mcp') {
      const cats = new Set<string>();
      uniqueMcpServers.forEach((s) => cats.add(deriveMcpCategory(s)));
      return ['All', ...Array.from(cats).sort()];
    } else {
      const cats = new Set<string>();
      plugins.forEach((p) => cats.add(derivePluginCategory(p)));
      return ['All', ...Array.from(cats).sort()];
    }
  }, [activeTab, uniqueMcpServers, plugins]);

  // Reset category and search when switching tabs
  useEffect(() => {
    setSelectedCategory('All');
    setSearchQuery('');
    setDebouncedSearchQuery('');
  }, [activeTab]);

  // Filter items - use debounced search query
  const filteredMcpServers = useMemo(() => {
    let result = uniqueMcpServers;

    if (selectedCategory !== 'All') {
      result = result.filter((s) => deriveMcpCategory(s) === selectedCategory);
    }

    if (debouncedSearchQuery.trim()) {
      const query = debouncedSearchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query) ||
          s.id.toLowerCase().includes(query) ||
          s.keywords?.some((k) => k.toLowerCase().includes(query))
      );
    }

    return result;
  }, [uniqueMcpServers, selectedCategory, debouncedSearchQuery]);

  const filteredPlugins = useMemo(() => {
    let result = plugins;

    if (selectedCategory !== 'All') {
      result = result.filter((p) => derivePluginCategory(p) === selectedCategory);
    }

    if (debouncedSearchQuery.trim()) {
      const query = debouncedSearchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.id.toLowerCase().includes(query) ||
          p.marketplace.toLowerCase().includes(query)
      );
    }

    return result;
  }, [plugins, selectedCategory, debouncedSearchQuery]);

  // Handle MCP install
  const handleMcpInstallClick = (server: MarketplaceMCPServer) => {
    setSelectedMcpServer(server);
    setShowMcpInstallDialog(true);
  };

  const handleMcpInstallSuccess = () => {
    setShowMcpInstallDialog(false);
    setSelectedMcpServer(null);
    onMcpServerInstalled();
  };

  // Handle plugin install
  const handlePluginInstall = async (plugin: MarketplacePlugin) => {
    setInstallingPlugin(`${plugin.id}@${plugin.marketplace}`);
    try {
      const result = await window.electronAPI.plugins.install(plugin.id, plugin.marketplace);
      if (result.success) {
        await loadPluginData(); // Refresh to show updated status
      } else {
        console.error('[UnifiedMarketplace] Plugin install failed:', result.error);
      }
    } catch (err) {
      console.error('[UnifiedMarketplace] Plugin install error:', err);
    } finally {
      setInstallingPlugin(null);
    }
  };

  // Handle plugin enable/disable
  const handlePluginToggle = async (plugin: MarketplacePlugin) => {
    const key = `${plugin.id}@${plugin.marketplace}`;
    setTogglingPlugin(key);
    try {
      const result = plugin.enabled
        ? await window.electronAPI.plugins.disable(plugin.id, plugin.marketplace)
        : await window.electronAPI.plugins.enable(plugin.id, plugin.marketplace);
      if (result.success) {
        await loadPluginData(); // Refresh to show updated status
      }
    } catch (err) {
      console.error('[UnifiedMarketplace] Plugin toggle error:', err);
    } finally {
      setTogglingPlugin(null);
    }
  };

  // Format date nicely
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return null;
    }
  };

  const activeLoading = activeTab === 'plugins' ? pluginLoading : mcpLoading;
  const activeError = activeTab === 'plugins' ? pluginError : mcpError;
  const retryActiveTab = activeTab === 'plugins' ? loadPluginData : loadMcpData;

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b border-line flex-shrink-0">
        <button
          onClick={() => setActiveTab('mcp')}
          className={`flex items-center gap-2 h-9 px-4 text-[13px] transition-colors ${
            activeTab === 'mcp'
              ? 'text-fg border-b-2 border-accent bg-claude-surface-hover'
              : 'text-fg-3 hover:text-fg hover:bg-claude-surface-hover'
          }`}
        >
          <Server size={14} className={activeTab === 'mcp' ? 'text-accent' : ''} />
          MCP Servers
          <span className="font-mono text-[11px] text-fg-4">({mcpServers.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('plugins')}
          className={`flex items-center gap-2 h-9 px-4 text-[13px] transition-colors ${
            activeTab === 'plugins'
              ? 'text-fg border-b-2 border-accent bg-claude-surface-hover'
              : 'text-fg-3 hover:text-fg hover:bg-claude-surface-hover'
          }`}
        >
          <Puzzle size={14} className={activeTab === 'plugins' ? 'text-accent' : ''} />
          Plugins
          <span className="font-mono text-[11px] text-fg-4">({plugins.length})</span>
        </button>
      </div>

      {activeLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={24} className="animate-spin text-accent" />
            <span className="text-[13px] text-fg-3">
              Loading {activeTab === 'plugins' ? 'plugins' : 'MCP servers'}...
            </span>
          </div>
        </div>
      ) : activeError ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center max-w-md">
            <AlertCircle size={24} className="text-diff-del" />
            <p className="text-[13px] text-diff-del-text">{activeError}</p>
            <button
              onClick={() => void retryActiveTab()}
              className="flex items-center gap-2 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        </div>
      ) : (
        <>
      {/* Search and Filter Bar */}
      <div className="p-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-4" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'mcp' ? 'Search MCP servers...' : 'Search plugins...'}
              className="w-full pl-9 pr-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>

          {/* Category Dropdown */}
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className={`px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent/50 ${
              activeTab === 'mcp' ? 'focus:ring-accent/50' : 'focus:ring-accent/50'
            }`}
          >
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          {/* Install from GitHub/URL button */}
          {activeTab === 'plugins' ? (
            <button
              onClick={() => setShowGitHubInstallDialog(true)}
              className="flex items-center gap-1.5 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors"
              title="Install plugin marketplace from GitHub"
            >
              <Download size={14} />
              GitHub
            </button>
          ) : (
            <button
              onClick={() => setShowManualMcpInstallDialog(true)}
              className="flex items-center gap-1.5 h-8 px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors"
              title="Install MCP server from npm/URL"
            >
              <Download size={14} />
              Custom
            </button>
          )}

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-2 text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors disabled:opacity-40 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
            title="Refresh marketplace"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Results Count */}
      <div className="px-3 py-2 text-[12px] text-fg-4 border-b border-line flex-shrink-0">
        {activeTab === 'mcp' ? filteredMcpServers.length : filteredPlugins.length}{' '}
        {activeTab === 'mcp' ? 'server' : 'plugin'}
        {(activeTab === 'mcp' ? filteredMcpServers.length : filteredPlugins.length) !== 1 ? 's' : ''} found
        {debouncedSearchQuery && ` for "${debouncedSearchQuery}"`}
        {selectedCategory !== 'All' && ` in ${selectedCategory}`}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === 'mcp' ? (
          // MCP Servers Grid
          filteredMcpServers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Server size={32} className="text-fg-5 mb-3" />
              <p className="text-[13px] text-fg-3">No MCP servers found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredMcpServers.map((server) => {
                const installed = isMcpInstalled(server.id);
                const publishDate = formatDate(server.publishedAt);
                const hasNpm = server.packages?.some((p) => p.registry_name === 'npm');
                const hasRemote = server.remotes && server.remotes.length > 0;

                return (
                  <div
                    key={server.id}
                    className="p-4 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-claude-surface-hover transition-colors group"
                  >
                    {/* Header Row */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-10 h-10 flex items-center justify-center bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] flex-shrink-0">
                        {server.icon ? (
                          <img src={server.icon} alt="" className="w-6 h-6 object-contain" />
                        ) : (
                          <Server size={20} className="text-fg-3" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-[14px] text-fg font-semibold tracking-tight truncate">
                            {server.name}
                          </h3>
                          <span className="font-mono text-[10px] text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] px-1.5 py-0.5">
                            v{server.version}
                          </span>
                        </div>
                        <p className="text-[11.5px] text-fg-4 font-mono mt-0.5 truncate">
                          {server.id}
                        </p>
                      </div>

                      <div className="flex-shrink-0">
                        {installed ? (
                          <span className="flex items-center gap-1.5 h-8 px-3 text-[13px] bg-diff-add/10 text-diff-add-text shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]">
                            <Check size={12} />
                            Installed
                          </span>
                        ) : (
                          <button
                            onClick={() => handleMcpInstallClick(server)}
                            className="flex items-center gap-1.5 h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors"
                          >
                            <Download size={12} />
                            Install
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-[13px] text-fg-3 mb-3 line-clamp-2">
                      {server.description}
                    </p>

                    <div className="flex items-center gap-4 flex-wrap text-[11.5px] text-fg-4">
                      <span className="flex items-center gap-1">
                        <Tag size={10} />
                        {deriveMcpCategory(server)}
                      </span>
                      {hasNpm && (
                        <span className="flex items-center gap-1">
                          <Package size={10} />
                          npm
                        </span>
                      )}
                      {hasRemote && (
                        <span className="flex items-center gap-1">
                          <Globe size={10} />
                          Remote
                        </span>
                      )}
                      {server.requiresAuth && (
                        <span className="flex items-center gap-1 text-amber">
                          <Key size={10} />
                          Auth
                        </span>
                      )}
                      {publishDate && (
                        <span className="flex items-center gap-1">
                          <Calendar size={10} />
                          {publishDate}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          // Plugins Grid
          filteredPlugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Puzzle size={32} className="text-fg-5 mb-3" />
              <p className="text-[13px] text-fg-3">No plugins found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredPlugins.map((plugin) => {
                const key = `${plugin.id}@${plugin.marketplace}`;
                const isInstalling = installingPlugin === key;
                const isToggling = togglingPlugin === key;

                return (
                  <div
                    key={key}
                    className="p-4 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-claude-surface-hover transition-colors group"
                  >
                    {/* Header Row */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-10 h-10 flex items-center justify-center bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] flex-shrink-0">
                        <Puzzle size={20} className="text-fg-3" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-[14px] text-fg font-semibold tracking-tight truncate">
                            {plugin.name}
                          </h3>
                          {plugin.installed && (
                            <span
                              className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${
                                plugin.enabled
                                  ? 'bg-diff-add/10 text-diff-add-text'
                                  : 'text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]'
                              }`}
                            >
                              {plugin.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                          )}
                        </div>
                        <p className="text-[11.5px] text-fg-4 font-mono mt-0.5 truncate">
                          {plugin.id}@{plugin.marketplace}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {plugin.installed ? (
                          <>
                            <button
                              onClick={() => handlePluginToggle(plugin)}
                              disabled={isToggling}
                              className={`flex items-center gap-1.5 h-8 px-2 text-[13px] transition-colors ${
                                plugin.enabled
                                  ? 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover hover:text-fg'
                                  : 'bg-diff-add/10 text-diff-add-text hover:bg-diff-add/20'
                              }`}
                              title={plugin.enabled ? 'Disable' : 'Enable'}
                            >
                              {isToggling ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : plugin.enabled ? (
                                <PowerOff size={12} />
                              ) : (
                                <Power size={12} />
                              )}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handlePluginInstall(plugin)}
                            disabled={isInstalling}
                            className="flex items-center gap-1.5 h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40"
                          >
                            {isInstalling ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Download size={12} />
                            )}
                            Install
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-[13px] text-fg-3 mb-3 line-clamp-2">
                      {plugin.description}
                    </p>

                    <div className="flex items-center gap-4 flex-wrap text-[11.5px] text-fg-4">
                      <span className="flex items-center gap-1">
                        <Tag size={10} />
                        {derivePluginCategory(plugin)}
                      </span>
                      {plugin.hasCommands && (
                        <span className="flex items-center gap-1">
                          <Terminal size={10} />
                          Commands
                        </span>
                      )}
                      {plugin.hasSkills && (
                        <span className="flex items-center gap-1">
                          <Sparkles size={10} />
                          Skills
                        </span>
                      )}
                      {plugin.hasAgents && (
                        <span className="flex items-center gap-1">
                          <Bot size={10} />
                          Agents
                        </span>
                      )}
                      {plugin.hasMcpServers && (
                        <span className="flex items-center gap-1">
                          <Server size={10} />
                          MCP
                        </span>
                      )}
                      <span className="text-fg-5">
                        from {plugin.marketplace}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
        </>
      )}

      {/* MCP Install Dialog */}
      {showMcpInstallDialog && selectedMcpServer && (
        <MCPInstallDialog
          server={selectedMcpServer}
          onClose={() => {
            setShowMcpInstallDialog(false);
            setSelectedMcpServer(null);
          }}
          onSuccess={handleMcpInstallSuccess}
        />
      )}

      {/* GitHub Plugin Install Dialog */}
      {showGitHubInstallDialog && (
        <GitHubPluginInstallDialog
          onClose={() => setShowGitHubInstallDialog(false)}
          onSuccess={() => {
            setShowGitHubInstallDialog(false);
            void loadPluginData(); // Refresh plugins list
          }}
        />
      )}

      {/* Manual MCP Install Dialog */}
      {showManualMcpInstallDialog && (
        <ManualMcpInstallDialog
          onClose={() => setShowManualMcpInstallDialog(false)}
          onSuccess={() => {
            setShowManualMcpInstallDialog(false);
            onMcpServerInstalled(); // Refresh MCP servers
          }}
        />
      )}
    </div>
  );
}

// GitHub Plugin Install Dialog Component
function GitHubPluginInstallDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [githubRepo, setGithubRepo] = useState('');
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleInstall = async () => {
    if (!githubRepo.trim()) return;

    setInstalling(true);
    setResult(null);

    try {
      const result = await window.electronAPI.plugins.addMarketplace(githubRepo.trim());

      if (result.success) {
        setResult({ success: true, message: 'Marketplace added successfully! Refreshing plugins...' });
        setTimeout(() => {
          onSuccess();
        }, 1500);
      } else {
        setResult({ success: false, message: result.error || 'Installation failed' });
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-[480px] max-w-[95%]"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !installing) onClose();
          if (e.key === 'Enter' && !installing) handleInstall();
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2">
            <Download size={16} className="text-fg-3" />
            <span className="text-[16px] font-semibold tracking-tight text-fg">Install from GitHub</span>
          </div>
          <button
            onClick={onClose}
            className="text-fg-3 hover:text-fg transition-colors"
            disabled={installing}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
              GitHub Repository
            </label>
            <input
              ref={inputRef}
              type="text"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="e.g., username/repo or https://github.com/username/repo"
              className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              disabled={installing}
            />
            <p className="text-[12px] text-fg-4 mt-2">
              Install a plugin marketplace from a GitHub repository. This will clone the repo and make all its plugins available.
            </p>
          </div>

          {/* Popular marketplaces suggestion */}
          <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <p className="text-[12px] text-fg-3 mb-2">Popular marketplaces:</p>
            <div className="space-y-1">
              <button
                onClick={() => setGithubRepo('kivilaid/plugin-marketplace')}
                className="block text-[12px] text-accent-text hover:text-fg font-mono"
              >
                kivilaid/plugin-marketplace (87+ plugins)
              </button>
              <button
                onClick={() => setGithubRepo('ananddtyagi/cc-marketplace')}
                className="block text-[12px] text-accent-text hover:text-fg font-mono"
              >
                ananddtyagi/cc-marketplace
              </button>
              <button
                onClick={() => setGithubRepo('feed-mob/claude-code-marketplace')}
                className="block text-[12px] text-accent-text hover:text-fg font-mono"
              >
                feed-mob/claude-code-marketplace
              </button>
            </div>
          </div>

          {/* Result Message */}
          {result && (
            <div
              className={`flex items-start gap-2 p-3 ${
                result.success
                  ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]'
                  : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'
              }`}
            >
              {result.success ? (
                <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-[13px] ${result.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                {result.message}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line">
          <button
            onClick={onClose}
            className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            disabled={installing}
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={installing || !githubRepo.trim()}
            className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {installing ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Installing...
              </>
            ) : (
              <>
                <Download size={12} />
                Add Marketplace
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Manual MCP Server Install Dialog Component
function ManualMcpInstallDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [installType, setInstallType] = useState<'npm' | 'remote'>('npm');
  const [serverName, setServerName] = useState('');
  const [npmPackage, setNpmPackage] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [authValue, setAuthValue] = useState('');
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const handleInstall = async () => {
    if (!serverName.trim()) {
      setResult({ success: false, message: 'Server name is required' });
      return;
    }

    if (installType === 'npm' && !npmPackage.trim()) {
      setResult({ success: false, message: 'npm package name is required' });
      return;
    }

    if (installType === 'remote' && !remoteUrl.trim()) {
      setResult({ success: false, message: 'Remote URL is required' });
      return;
    }

    setInstalling(true);
    setResult(null);

    try {
      // Build config for Claudette's electron-store. Remote URL entries are
      // stored natively so the main process can wrap them with mcp-remote for
      // every harness and keep shared auth in ~/.mcp-auth.
      const config: Record<string, unknown> = installType === 'npm'
        ? {
            type: 'stdio',
            command: 'npx',
            args: ['-y', npmPackage.trim()],
          }
        : {
            type: remoteUrl.trim().endsWith('/sse') ? 'sse' : 'http',
            url: remoteUrl.trim(),
          };

      // Add auth environment variable if provided
      if (authKey.trim() && authValue.trim()) {
        if (installType === 'remote') {
          config.headers = { [authKey.trim()]: authValue.trim() };
        } else {
          config.env = { [authKey.trim()]: authValue.trim() };
        }
      } else {
        config.env = {};
      }

      const response = await window.electronAPI.mcp.installRaw(serverName.trim(), config);

      if (response.authUrl) {
        // OAuth flow detected - open URL in browser
        setResult({
          success: false,
          message: 'Opening authentication page in browser...',
        });
        window.electronAPI.app.openExternal(response.authUrl);

        // Keep dialog open for user to complete OAuth
        setTimeout(() => {
          setResult({
            success: true,
            message: 'Complete authentication in your browser, then restart the app to use this server.',
          });
        }, 1000);
      } else if (response.success) {
        setResult({ success: true, message: `${serverName} installed successfully!` });
        setTimeout(() => {
          onSuccess();
        }, 1500);
      } else {
        setResult({ success: false, message: response.error || 'Installation failed' });
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-[520px] max-w-[95%]"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !installing) onClose();
          if (e.key === 'Enter' && !installing) handleInstall();
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-fg-3" />
            <span className="text-[16px] font-semibold tracking-tight text-fg">Install Custom MCP Server</span>
          </div>
          <button
            onClick={onClose}
            className="text-fg-3 hover:text-fg transition-colors"
            disabled={installing}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Server Name */}
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
              Server Name
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="e.g., my-server"
              className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              disabled={installing}
            />
            <p className="text-[12px] text-fg-4 mt-1">
              Unique identifier for this MCP server
            </p>
          </div>

          {/* Installation Type */}
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
              Installation Method
            </label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="installType"
                  checked={installType === 'npm'}
                  onChange={() => setInstallType('npm')}
                  disabled={installing}
                  className="accent-[#4C9AFF]"
                />
                <Package size={14} className="text-fg-4" />
                <span className="text-[13px] text-fg-2">npm Package</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="installType"
                  checked={installType === 'remote'}
                  onChange={() => setInstallType('remote')}
                  disabled={installing}
                  className="accent-[#4C9AFF]"
                />
                <Globe size={14} className="text-fg-4" />
                <span className="text-[13px] text-fg-2">Remote URL</span>
              </label>
            </div>
          </div>

          {/* npm Package or Remote URL */}
          {installType === 'npm' ? (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                npm Package
              </label>
              <input
                type="text"
                value={npmPackage}
                onChange={(e) => setNpmPackage(e.target.value)}
                placeholder="e.g., @modelcontextprotocol/server-postgres"
                className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                disabled={installing}
              />
              <p className="text-[12px] text-fg-4 mt-1">
                Agent SDK will run: npx -y &lt;package&gt;
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                Remote URL
              </label>
              <input
                type="text"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="e.g., https://mcp.linear.app/mcp"
                className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                disabled={installing}
              />
              <p className="text-[12px] text-fg-4 mt-1">
                Build will share this URL with every harness through mcp-remote
              </p>
            </div>
          )}

          {/* Optional Auth */}
          <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] space-y-3">
            <div className="flex items-center gap-2">
              <Key size={14} className="text-fg-4" />
              <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
                Optional Authentication
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  type="text"
                  value={authKey}
                  onChange={(e) => setAuthKey(e.target.value)}
                  placeholder={installType === 'remote' ? 'Header-Name' : 'ENV_VAR_NAME'}
                  className="w-full px-2 py-1.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[12px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  disabled={installing}
                />
              </div>
              <div>
                <input
                  type="password"
                  value={authValue}
                  onChange={(e) => setAuthValue(e.target.value)}
                  placeholder="value"
                  className="w-full px-2 py-1.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[12px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  disabled={installing}
                />
              </div>
            </div>
            <p className="text-[12px] text-fg-4">
              {installType === 'remote' ? 'Header to pass to the remote MCP server' : 'Environment variable to pass to the MCP server'}
            </p>
          </div>

          {/* Result Message */}
          {result && (
            <div
              className={`flex items-start gap-2 p-3 ${
                result.success
                  ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]'
                  : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'
              }`}
            >
              {result.success ? (
                <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-[13px] ${result.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                {result.message}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line">
          <button
            onClick={onClose}
            className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            disabled={installing}
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={
              installing ||
              !serverName.trim() ||
              (installType === 'npm' ? !npmPackage.trim() : !remoteUrl.trim())
            }
            className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {installing ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Installing...
              </>
            ) : (
              <>
                <Server size={12} />
                Install
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
