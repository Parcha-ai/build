/**
 * Plugin Service - Manages Claude Code plugin discovery and installation
 *
 * Plugins are stored in git-based marketplaces (GitHub repos)
 * Uses `claude plugin` CLI commands for management
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findUsableLocalExecutable } from '../utils/local-executable';
import type {
  PluginMarketplace,
  InstalledPlugin,
  MarketplacePlugin,
} from '../../shared/types';

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(fs.readFile);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);

// Claude plugins directory
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const MARKETPLACES_DIR = path.join(PLUGINS_DIR, 'marketplaces');
const KNOWN_MARKETPLACES_FILE = path.join(PLUGINS_DIR, 'known_marketplaces.json');

function resolveClaudeCli(): string {
  const cli = findUsableLocalExecutable(['claude'], [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  ]);
  if (!cli) {
    throw new Error('Claude Code CLI is not installed or is blocked by macOS quarantine.');
  }
  return cli;
}

// Popular plugin marketplaces for discovery
export const POPULAR_MARKETPLACES = [
  {
    name: 'claude-plugins-official',
    repo: 'anthropics/claude-plugins-official',
    description: 'Official Anthropic-managed directory of high quality Claude Code plugins',
    official: true,
  },
  {
    name: 'claude-code-plugins',
    repo: 'anthropics/claude-code',
    description: 'Built-in plugins from the main Claude Code repository',
    official: true,
  },
  {
    name: 'kivilaid-marketplace',
    repo: 'kivilaid/plugin-marketplace',
    description: 'Comprehensive marketplace with 87+ plugins from 10+ sources',
    official: false,
  },
  {
    name: 'claude-superpowers',
    repo: 'ivan-magda/claude-superpowers',
    description: 'Curated collection for Swift development and AI-assisted workflows',
    official: false,
  },
  {
    name: 'cc-marketplace',
    repo: 'ananddtyagi/cc-marketplace',
    description: 'Community-driven marketplace for Claude Code commands and plugins',
    official: false,
  },
  {
    name: 'feedmob-marketplace',
    repo: 'feed-mob/claude-code-marketplace',
    description: 'FeedMob Dev Team plugins for enhanced development workflows',
    official: false,
  },
  {
    name: 'claude-code-templates',
    repo: 'davila7/claude-code-templates',
    description: 'Templates and boilerplates for rapid development',
    official: false,
  },
];

class PluginService {
  /**
   * Get list of popular plugin marketplaces for discovery
   */
  getPopularMarketplaces() {
    return POPULAR_MARKETPLACES;
  }

  /**
   * Get list of configured plugin marketplaces
   */
  async getMarketplaces(): Promise<PluginMarketplace[]> {
    try {
      // Read the known_marketplaces.json file
      const content = await readFileAsync(KNOWN_MARKETPLACES_FILE, 'utf-8');
      const data = JSON.parse(content);

      const marketplaces: PluginMarketplace[] = [];
      for (const [name, info] of Object.entries(data)) {
        const marketplace = info as {
          source: { source: string; repo?: string; url?: string; path?: string };
          installLocation: string;
          lastUpdated?: string;
        };
        marketplaces.push({
          name,
          source: {
            source: marketplace.source.source as 'github' | 'git' | 'local',
            repo: marketplace.source.repo,
            url: marketplace.source.url,
            path: marketplace.source.path,
          },
          installLocation: marketplace.installLocation,
          lastUpdated: marketplace.lastUpdated,
        });
      }

      return marketplaces;
    } catch (error) {
      console.error('[Plugin Service] Error reading marketplaces:', error);
      return [];
    }
  }

  /**
   * Get list of installed plugins using `claude plugin list`
   */
  async getInstalledPlugins(): Promise<InstalledPlugin[]> {
    try {
      const { stdout } = await execFileAsync(resolveClaudeCli(), ['plugin', 'list'], {
        timeout: 15000,
      });

      const plugins: InstalledPlugin[] = [];
      const lines = stdout.split('\n');

      let currentPlugin: Partial<InstalledPlugin> | null = null;

      for (const line of lines) {
        // Match plugin name line: "❯ plugin-name@marketplace"
        const nameMatch = line.match(/^\s*❯\s+(.+)@(.+)$/);
        if (nameMatch) {
          if (currentPlugin && currentPlugin.id) {
            plugins.push(currentPlugin as InstalledPlugin);
          }
          currentPlugin = {
            id: `${nameMatch[1]}@${nameMatch[2]}`,
            name: nameMatch[1],
            marketplace: nameMatch[2],
          };
          continue;
        }

        if (currentPlugin) {
          // Match version line
          const versionMatch = line.match(/Version:\s*(.+)/);
          if (versionMatch) {
            currentPlugin.version = versionMatch[1].trim();
            continue;
          }

          // Match scope line
          const scopeMatch = line.match(/Scope:\s*(.+)/);
          if (scopeMatch) {
            currentPlugin.scope = scopeMatch[1].trim() as 'user' | 'project';
            continue;
          }

          // Match status line
          const statusMatch = line.match(/Status:\s*(✔|✘)\s*(enabled|disabled)/);
          if (statusMatch) {
            currentPlugin.enabled = statusMatch[1] === '✔';
          }
        }
      }

      // Don't forget the last plugin
      if (currentPlugin && currentPlugin.id) {
        plugins.push(currentPlugin as InstalledPlugin);
      }

      return plugins;
    } catch (error) {
      console.error('[Plugin Service] Error getting installed plugins:', error);
      return [];
    }
  }

  /**
   * Get available plugins from all marketplaces
   */
  async getAvailablePlugins(): Promise<MarketplacePlugin[]> {
    console.log('[Plugin Service] Getting available plugins from all marketplaces');
    const plugins: MarketplacePlugin[] = [];
    const marketplaces = await this.getMarketplaces();
    const installedPlugins = await this.getInstalledPlugins();

    console.log('[Plugin Service] Found marketplaces:', marketplaces.map(m => m.name));
    console.log('[Plugin Service] Found installed plugins:', installedPlugins.length);

    // Create a map of installed plugins for quick lookup
    const installedMap = new Map<string, InstalledPlugin>();
    for (const plugin of installedPlugins) {
      installedMap.set(`${plugin.name}@${plugin.marketplace}`, plugin);
    }

    for (const marketplace of marketplaces) {
      try {
        console.log('[Plugin Service] Scanning marketplace:', marketplace.name, 'at', marketplace.installLocation);
        const marketplacePlugins = await this.scanMarketplacePlugins(marketplace);
        console.log('[Plugin Service] Found plugins in', marketplace.name, ':', marketplacePlugins.length);
        for (const plugin of marketplacePlugins) {
          const installedKey = `${plugin.id}@${marketplace.name}`;
          const installed = installedMap.get(installedKey);

          plugins.push({
            ...plugin,
            marketplace: marketplace.name,
            marketplaceRepo: marketplace.source.repo || marketplace.source.url,
            installed: !!installed,
            enabled: installed?.enabled,
            installedVersion: installed?.version,
          });
        }
      } catch (error) {
        console.error(`[Plugin Service] Error scanning marketplace ${marketplace.name}:`, error);
      }
    }

    return plugins;
  }

  /**
   * Scan a marketplace directory for plugins by reading the marketplace.json manifest
   */
  private async scanMarketplacePlugins(marketplace: PluginMarketplace): Promise<MarketplacePlugin[]> {
    const plugins: MarketplacePlugin[] = [];

    try {
      // Read the marketplace.json manifest
      const manifestPath = path.join(marketplace.installLocation, '.claude-plugin', 'marketplace.json');

      console.log('[Plugin Service] Reading marketplace manifest:', manifestPath);
      const manifestContent = await readFileAsync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      if (!manifest.plugins || !Array.isArray(manifest.plugins)) {
        console.warn('[Plugin Service] No plugins array in marketplace:', marketplace.name);
        return plugins;
      }

      console.log('[Plugin Service] Marketplace', marketplace.name, 'has', manifest.plugins.length, 'plugins in manifest');

      // Parse each plugin from the manifest
      for (const pluginEntry of manifest.plugins) {
        // Check what content types the plugin has by reading its directory
        let hasCommands = false;
        let hasSkills = false;
        let hasAgents = false;
        let hasHooks = false;
        let hasMcpServers = false;

        try {
          // Determine plugin path from source
          let pluginPath: string;
          if (typeof pluginEntry.source === 'string') {
            // Local path like "./plugins/typescript-lsp"
            pluginPath = path.join(marketplace.installLocation, pluginEntry.source);
          } else if (pluginEntry.source?.url) {
            // External URL - these are downloaded when installed
            pluginPath = '';
          } else {
            console.warn('[Plugin Service] Unknown source format for plugin:', pluginEntry.name);
            continue;
          }

          // If we have a local path, scan for content types
          if (pluginPath) {
            const contents = await readdirAsync(pluginPath).catch(() => [] as string[]);
            hasCommands = contents.includes('commands');
            hasSkills = contents.includes('skills');
            hasAgents = contents.includes('agents');
            hasHooks = contents.includes('hooks');
            hasMcpServers = contents.includes('.mcp.json') || contents.includes('mcp');
          }
        } catch (error) {
          console.warn('[Plugin Service] Could not scan plugin directory:', pluginEntry.name, error);
        }

        plugins.push({
          id: pluginEntry.name,
          name: this.formatPluginName(pluginEntry.name),
          description: pluginEntry.description || `Plugin: ${pluginEntry.name}`,
          marketplace: marketplace.name,
          hasCommands,
          hasSkills,
          hasAgents,
          hasHooks,
          hasMcpServers,
        });
      }

      console.log('[Plugin Service] Parsed', plugins.length, 'plugins from', marketplace.name);
    } catch (error) {
      console.error(`[Plugin Service] Error reading marketplace manifest for ${marketplace.name}:`, error);
    }

    return plugins;
  }

  /**
   * Format plugin directory name to display name
   */
  private formatPluginName(dirName: string): string {
    return dirName
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Install a plugin using `claude plugin install`
   */
  async installPlugin(
    pluginId: string,
    marketplace: string,
    options?: { scope?: 'user' | 'project' }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const pluginSpec = `${pluginId}@${marketplace}`;
      console.log('[Plugin Service] Installing plugin:', pluginSpec);

      const args = ['plugin', 'install', pluginSpec];
      if (options?.scope) {
        args.push('--scope', options.scope);
      }
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, args, {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            console.log('[Plugin Service] Plugin installed successfully:', pluginSpec);
            resolve({ success: true });
          } else {
            console.error('[Plugin Service] Plugin installation failed:', stderr || stdout);
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          console.error('[Plugin Service] Spawn error:', err);
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      console.error('[Plugin Service] Install error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Uninstall a plugin using `claude plugin uninstall`
   */
  async uninstallPlugin(pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> {
    try {
      const pluginSpec = `${pluginId}@${marketplace}`;
      console.log('[Plugin Service] Uninstalling plugin:', pluginSpec);
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, ['plugin', 'uninstall', pluginSpec], {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            console.log('[Plugin Service] Plugin uninstalled successfully:', pluginSpec);
            resolve({ success: true });
          } else {
            console.error('[Plugin Service] Plugin uninstall failed:', stderr || stdout);
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          console.error('[Plugin Service] Spawn error:', err);
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      console.error('[Plugin Service] Uninstall error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Enable a plugin using `claude plugin enable`
   */
  async enablePlugin(pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> {
    try {
      const pluginSpec = `${pluginId}@${marketplace}`;
      console.log('[Plugin Service] Enabling plugin:', pluginSpec);
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, ['plugin', 'enable', pluginSpec], {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Disable a plugin using `claude plugin disable`
   */
  async disablePlugin(pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> {
    try {
      const pluginSpec = `${pluginId}@${marketplace}`;
      console.log('[Plugin Service] Disabling plugin:', pluginSpec);
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, ['plugin', 'disable', pluginSpec], {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Add a marketplace using `claude plugin marketplace add`
   */
  async addMarketplace(source: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[Plugin Service] Adding marketplace:', source);
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, ['plugin', 'marketplace', 'add', source], {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Remove a marketplace using `claude plugin marketplace remove`
   */
  async removeMarketplace(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[Plugin Service] Removing marketplace:', name);
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, ['plugin', 'marketplace', 'remove', name], {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Update marketplaces using `claude plugin marketplace update`
   */
  async updateMarketplaces(name?: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[Plugin Service] Updating marketplaces:', name || 'all');

      const args = ['plugin', 'marketplace', 'update'];
      if (name) {
        args.push(name);
      }
      const claudeCli = resolveClaudeCli();

      return new Promise((resolve) => {
        const child = spawn(claudeCli, args, {
          shell: false,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: stderr || stdout || `Exit code: ${code}` });
          }
        });

        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

export const pluginService = new PluginService();
