import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Sparkles, Bot, ChevronDown, ChevronRight, Copy, User, FolderGit, Edit3, Plus, X, Loader2, Check, AlertCircle, FileText, Github, Server, Store, Wrench, Power, PowerOff, Trash2, Package, MoreHorizontal, Download } from 'lucide-react';
import type { Command, Skill, AgentDefinition, MCPServerInfo, InstalledPlugin } from '../../../shared/types';
import UnifiedMarketplace from './UnifiedMarketplace';

// Default template for new skills
const SKILL_TEMPLATE = `# My Skill

A brief description of what this skill does.

## Usage

Describe how to use this skill and what it accomplishes.

## Instructions

When this skill is invoked:

1. First, do this thing
2. Then, do this other thing
3. Finally, complete the task

## Examples

Example usage patterns or expected outputs.
`;

interface ExtensionsExplorerProps {
  sessionId: string;
  projectPath?: string;
}

type ExtensionType = 'commands' | 'skills' | 'agents' | 'mcpServers' | 'plugins';
type TabType = 'installed' | 'marketplace';

export default function ExtensionsExplorer({ sessionId, projectPath }: ExtensionsExplorerProps) {
  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>('installed');

  // Extension data
  const [commands, setCommands] = useState<Command[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<ExtensionType | null>('commands');
  const [selectedItem, setSelectedItem] = useState<Command | Skill | AgentDefinition | MCPServerInfo | InstalledPlugin | null>(null);
  const [viewingContent, setViewingContent] = useState(false);

  // Plugin action state
  const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null);
  const [uninstallingPlugin, setUninstallingPlugin] = useState<string | null>(null);

  // Skill action menu state (shown when + is clicked)
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [openAgentMenu, setOpenAgentMenu] = useState<string | null>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);

  // Skill installation state
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installMode, setInstallMode] = useState<'github' | 'file'>('github');
  const [installSource, setInstallSource] = useState('');
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [installGlobal, setInstallGlobal] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null);
  const installInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Create skill state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillContent, setNewSkillContent] = useState(SKILL_TEMPLATE);
  const [newSkillGlobal, setNewSkillGlobal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{ success: boolean; message: string } | null>(null);
  const createNameInputRef = useRef<HTMLInputElement>(null);

  // Load extensions (supports SSH sessions via sessionId)
  useEffect(() => {
    loadExtensions();
  }, [sessionId, projectPath]);

  const loadExtensions = async () => {
    setLoading(true);
    const scanOptions = { sessionId, projectPath };
    try {
      const [cmds, skls, agts, servers, installedPlugins] = await Promise.all([
        window.electronAPI.extensions.scanCommands(scanOptions),
        window.electronAPI.extensions.scanSkills(scanOptions),
        window.electronAPI.extensions.scanAgents(scanOptions),
        window.electronAPI.mcp.getServers(sessionId, projectPath),
        window.electronAPI.plugins.getInstalled(),
      ]);
      setCommands(cmds);
      setSkills(skls);
      setAgents(agts);
      setMcpServers(servers);
      setPlugins(installedPlugins);
    } catch (err) {
      console.error('[Extensions Explorer] Error loading:', err);
    } finally {
      setLoading(false);
    }
  };

  // Refresh MCP servers after installation
  const refreshMcpServers = async () => {
    try {
      const servers = await window.electronAPI.mcp.getServers(sessionId, projectPath);
      setMcpServers(servers);
    } catch (err) {
      console.error('[Extensions Explorer] Error refreshing MCP servers:', err);
    }
  };

  // Handle plugin toggle (enable/disable)
  const handlePluginToggle = async (plugin: InstalledPlugin) => {
    const key = `${plugin.id}@${plugin.marketplace}`;
    setTogglingPlugin(key);
    try {
      const result = plugin.enabled
        ? await window.electronAPI.plugins.disable(plugin.id, plugin.marketplace)
        : await window.electronAPI.plugins.enable(plugin.id, plugin.marketplace);

      if (result.success) {
        await loadExtensions(); // Refresh all data
      } else {
        console.error('[Extensions Explorer] Plugin toggle failed:', result.error);
      }
    } catch (err) {
      console.error('[Extensions Explorer] Plugin toggle error:', err);
    } finally {
      setTogglingPlugin(null);
    }
  };

  // Handle plugin uninstall
  const handlePluginUninstall = async (plugin: InstalledPlugin) => {
    if (!confirm(`Uninstall "${plugin.name}"? This will remove all its commands, skills, and agents.`)) {
      return;
    }

    const key = `${plugin.id}@${plugin.marketplace}`;
    setUninstallingPlugin(key);
    try {
      const result = await window.electronAPI.plugins.uninstall(plugin.id, plugin.marketplace);

      if (result.success) {
        await loadExtensions(); // Refresh all data
        setSelectedItem(null); // Clear selection if this was selected
        setViewingContent(false);
      } else {
        console.error('[Extensions Explorer] Plugin uninstall failed:', result.error);
        alert(`Failed to uninstall: ${result.error}`);
      }
    } catch (err) {
      console.error('[Extensions Explorer] Plugin uninstall error:', err);
      alert(`Error uninstalling: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setUninstallingPlugin(null);
    }
  };

  const toggleType = (type: ExtensionType) => {
    setExpandedType(expandedType === type ? null : type);
    setSelectedItem(null);
    setViewingContent(false);
  };

  const handleItemClick = (item: Command | Skill | AgentDefinition | MCPServerInfo | InstalledPlugin) => {
    setOpenAgentMenu(null);
    setSelectedItem(item);
    setViewingContent(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const downloadJsonFile = (filename: string, data: unknown) => {
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleExportAgentConfig = (agent: AgentDefinition) => {
    setOpenAgentMenu(null);
    const safeName = agent.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'agent';
    downloadJsonFile(`${safeName}.json`, agent);
  };

  // Focus input when dialog opens
  useEffect(() => {
    if (showInstallDialog && installInputRef.current) {
      installInputRef.current.focus();
    }
  }, [showInstallDialog]);

  // Focus input when create dialog opens
  useEffect(() => {
    if (showCreateDialog && createNameInputRef.current) {
      createNameInputRef.current.focus();
    }
  }, [showCreateDialog]);

  // Close skill menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
        setShowSkillMenu(false);
      }
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setOpenAgentMenu(null);
      }
    };

    if (showSkillMenu || openAgentMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSkillMenu, openAgentMenu]);

  // Refresh skills list
  const refreshSkills = async () => {
    try {
      const skls = await window.electronAPI.extensions.scanSkills({ sessionId, projectPath });
      setSkills(skls);
    } catch (err) {
      console.error('[Extensions Explorer] Error refreshing skills:', err);
    }
  };

  // Handle skill installation
  const handleInstallSkill = async () => {
    if (installMode === 'github' && !installSource.trim()) return;
    if (installMode === 'file' && !installFile) return;

    setInstalling(true);
    setInstallResult(null);

    try {
      if (installMode === 'github') {
        // Install from GitHub URL
        const result = await window.electronAPI.extensions.installSkill(installSource.trim(), {
          global: installGlobal,
          projectPath: projectPath,
          sessionId: sessionId,
        });

        if (result.success) {
          setInstallResult({ success: true, message: result.output || 'Skill installed successfully!' });
          // Refresh skills list after successful installation
          await refreshSkills();
          // Reset form after a delay
          setTimeout(() => {
            setShowInstallDialog(false);
            setInstallSource('');
            setInstallResult(null);
          }, 2000);
        } else {
          setInstallResult({ success: false, message: result.error || 'Installation failed' });
        }
      } else {
        // Upload from local file
        if (!installFile) return;

        // Extract skill name from filename (remove .md, .skill, or SKILL.md)
        let skillName = installFile.name;

        // If filename is SKILL.md or SKILL.skill, use parent directory name or prompt user
        if (skillName.toLowerCase() === 'skill.md' || skillName.toLowerCase() === 'skill.skill') {
          setInstallResult({ success: false, message: 'Please rename your file to the desired skill name (e.g., my-skill.md)' });
          setInstalling(false);
          return;
        }

        // Remove common extensions
        skillName = skillName.replace(/\.(md|skill)$/i, '');

        // Validate skill name (alphanumeric, hyphens, underscores only)
        const validName = /^[a-zA-Z0-9_-]+$/.test(skillName);
        if (!validName) {
          setInstallResult({ success: false, message: 'Skill filename can only contain letters, numbers, hyphens, and underscores' });
          setInstalling(false);
          return;
        }

        // Read file content
        const content = await installFile.text();

        // Determine the base path
        const basePath = installGlobal
          ? `${await window.electronAPI.app.getPath('home')}/.claude/skills`
          : `${projectPath}/.claude/skills`;

        const skillDir = `${basePath}/${skillName}`;
        // Claude Code only recognizes files named exactly "SKILL.md" (uppercase)
        const skillFile = `${skillDir}/SKILL.md`;

        // Write file (supports SSH via FS_WRITE_FILE handler with sessionId)
        const result = await window.electronAPI.fs.writeFile(skillFile, content, sessionId);

        if (result.success) {
          setInstallResult({ success: true, message: `Skill "${skillName}" uploaded successfully!` });
          // Refresh skills list
          await refreshSkills();
          // Reset and close after delay
          setTimeout(() => {
            setShowInstallDialog(false);
            setInstallFile(null);
            setInstallResult(null);
          }, 2000);
        } else {
          setInstallResult({ success: false, message: result.error || 'Failed to upload skill' });
        }
      }
    } catch (err) {
      setInstallResult({ success: false, message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setInstalling(false);
    }
  };

  // Handle dialog close
  const handleCloseInstallDialog = () => {
    if (!installing) {
      setShowInstallDialog(false);
      setInstallSource('');
      setInstallFile(null);
      setInstallMode('github');
      setInstallResult(null);
    }
  };

  // Handle create skill
  const handleCreateSkill = async () => {
    if (!newSkillName.trim()) return;

    // Validate skill name (alphanumeric, hyphens, underscores only)
    const validName = /^[a-zA-Z0-9_-]+$/.test(newSkillName.trim());
    if (!validName) {
      setCreateResult({ success: false, message: 'Skill name can only contain letters, numbers, hyphens, and underscores' });
      return;
    }

    setCreating(true);
    setCreateResult(null);

    try {
      // Determine the base path
      const basePath = newSkillGlobal
        ? `${await window.electronAPI.app.getPath('home')}/.claude/skills`
        : `${projectPath}/.claude/skills`;

      const skillDir = `${basePath}/${newSkillName.trim()}`;
      const skillFile = `${skillDir}/SKILL.md`;

      // Create directory and write file (supports SSH via sessionId)
      const result = await window.electronAPI.fs.writeFile(skillFile, newSkillContent, sessionId);

      if (result.success) {
        setCreateResult({ success: true, message: `Skill "${newSkillName}" created successfully!` });
        // Refresh skills list
        await refreshSkills();
        // Reset and close after delay
        setTimeout(() => {
          setShowCreateDialog(false);
          setNewSkillName('');
          setNewSkillContent(SKILL_TEMPLATE);
          setCreateResult(null);
        }, 2000);
      } else {
        setCreateResult({ success: false, message: result.error || 'Failed to create skill' });
      }
    } catch (err) {
      setCreateResult({ success: false, message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setCreating(false);
    }
  };

  // Handle create dialog close
  const handleCloseCreateDialog = () => {
    if (!creating) {
      setShowCreateDialog(false);
      setNewSkillName('');
      setNewSkillContent(SKILL_TEMPLATE);
      setCreateResult(null);
    }
  };

  const handleEditItem = async (item: Command | Skill | AgentDefinition) => {
    const isCommand = 'content' in item;
    const isAgent = 'systemPrompt' in item;

    let filePath: string;

    if (isCommand) {
      // Commands have direct path to .md file
      filePath = (item as Command).path;
    } else if (isAgent) {
      // Agents are stored as .md files in agents directory
      // We need to construct the path
      const agentName = item.name;
      if (item.scope === 'user') {
        // Use ~ for home directory (shell will expand it)
        filePath = `~/.claude/agents/${agentName}.md`;
      } else {
        filePath = `${projectPath}/.claude/agents/${agentName}.md`;
      }
    } else {
      // Skills have path to directory, need to append SKILL.md
      filePath = `${(item as Skill).path}/SKILL.md`;
    }

    // Open file in system default editor
    window.electronAPI.app.openExternal(`file://${filePath}`);
  };

  const renderCommandList = () => {
    if (commands.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-claude-text-secondary">
          No commands found. Create <code className="bg-claude-bg px-1">.claude/commands/*.md</code>
        </div>
      );
    }

    return commands.map(cmd => (
      <button
        key={`${cmd.scope}-${cmd.name}`}
        onClick={() => handleItemClick(cmd)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface transition-colors ${
          selectedItem === cmd ? 'bg-claude-surface' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-claude-accent">/{cmd.name}</span>
          {cmd.scope === 'user' ? (
            <User size={10} className="text-claude-text-secondary" />
          ) : (
            <FolderGit size={10} className="text-claude-text-secondary" />
          )}
        </div>
        {cmd.description && (
          <p className="text-xs text-claude-text-secondary mt-1 truncate">{cmd.description}</p>
        )}
      </button>
    ));
  };

  const renderSkillList = () => {
    if (skills.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-claude-text-secondary">
          No skills found. Create <code className="bg-claude-bg px-1">.claude/skills/*/SKILL.md</code>
        </div>
      );
    }

    return skills.map(skill => (
      <button
        key={`${skill.scope}-${skill.name}`}
        onClick={() => handleItemClick(skill)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface transition-colors ${
          selectedItem === skill ? 'bg-claude-surface' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-purple-400">/{skill.name}</span>
          {skill.scope === 'user' ? (
            <User size={10} className="text-claude-text-secondary" />
          ) : (
            <FolderGit size={10} className="text-claude-text-secondary" />
          )}
        </div>
        {skill.description && (
          <p className="text-xs text-claude-text-secondary mt-1 truncate">{skill.description}</p>
        )}
      </button>
    ));
  };

  const renderAgentList = () => {
    if (agents.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-claude-text-secondary">
          No agents found. Create <code className="bg-claude-bg px-1">.claude/agents/*.md</code>
        </div>
      );
    }

    return agents.map(agent => {
      const agentKey = `${agent.scope}-${agent.name}`;
      const isMenuOpen = openAgentMenu === agentKey;

      return (
        <div key={agentKey} className="relative group">
          <button
            onClick={() => handleItemClick(agent)}
            className={`w-full px-3 py-2 pr-11 text-left hover:bg-claude-surface transition-colors ${
              selectedItem === agent ? 'bg-claude-surface' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-claude-text">@agent-{agent.name}</span>
              {agent.scope === 'user' ? (
                <User size={10} className="text-claude-text-secondary" />
              ) : (
                <FolderGit size={10} className="text-claude-text-secondary" />
              )}
            </div>
            <p className="text-xs text-claude-text-secondary mt-1 truncate">{agent.description}</p>
          </button>

          <div
            ref={isMenuOpen ? agentMenuRef : undefined}
            className="absolute right-2 top-2"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpenAgentMenu(isMenuOpen ? null : agentKey);
              }}
              className={`p-1 transition-colors ${
                isMenuOpen
                  ? 'bg-claude-surface text-claude-text'
                  : 'text-claude-text-secondary opacity-0 group-hover:opacity-100 hover:bg-claude-surface'
              }`}
              title="Agent actions"
            >
              <MoreHorizontal size={14} />
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-48 border border-claude-border bg-claude-bg shadow-lg">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExportAgentConfig(agent);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-claude-text hover:bg-claude-surface"
                >
                  <Download size={13} />
                  Export agent config
                </button>
              </div>
            )}
          </div>
        </div>
      );
    });
  };

  const renderMcpServerList = () => {
    if (mcpServers.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-claude-text-secondary">
          No MCP servers active. Install from the Marketplace tab.
        </div>
      );
    }

    return mcpServers.map(server => (
      <button
        key={server.id}
        onClick={() => handleItemClick(server)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface transition-colors ${
          selectedItem === server ? 'bg-claude-surface' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-green-400">{server.name}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              server.status === 'active'
                ? 'bg-green-500'
                : server.status === 'error'
                ? 'bg-red-500'
                : 'bg-gray-500'
            }`}
          />
          {server.type === 'sdk' && (
            <span className="text-[10px] text-claude-text-secondary bg-claude-surface px-1">SDK</span>
          )}
        </div>
        <p className="text-xs text-claude-text-secondary mt-1 truncate">{server.description}</p>
        {server.tools.length > 0 && (
          <p className="text-[10px] text-claude-text-secondary mt-1">
            {server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}
          </p>
        )}
      </button>
    ));
  };

  const renderPluginList = () => {
    if (plugins.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-claude-text-secondary">
          No plugins installed. Browse the Marketplace tab to install plugins.
        </div>
      );
    }

    return plugins.map(plugin => {
      const key = `${plugin.id}@${plugin.marketplace}`;
      const isToggling = togglingPlugin === key;
      const isUninstalling = uninstallingPlugin === key;

      return (
        <button
          key={key}
          onClick={() => handleItemClick(plugin)}
          className={`w-full px-3 py-2 text-left hover:bg-claude-surface transition-colors ${
            selectedItem === plugin ? 'bg-claude-surface' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-purple-400">{plugin.name}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                plugin.enabled ? 'bg-green-500' : 'bg-gray-500'
              }`}
              title={plugin.enabled ? 'Enabled' : 'Disabled'}
            />
            <span className="text-[10px] text-claude-text-secondary bg-claude-surface px-1">
              {plugin.scope}
            </span>
          </div>
          <p className="text-xs text-claude-text-secondary mt-1 truncate">
            {plugin.marketplace}
          </p>
        </button>
      );
    });
  };

  const renderItemDetails = () => {
    if (!selectedItem || !viewingContent) return null;

    // Check what type of item we have
    const isPlugin = 'marketplace' in selectedItem && 'enabled' in selectedItem;
    const isMcpServer = !isPlugin && 'tools' in selectedItem && 'status' in selectedItem;
    const isAgent = !isPlugin && !isMcpServer && 'systemPrompt' in selectedItem;
    // Commands have .md path, Skills have directory path (content in both now)
    const isCommand = !isPlugin && !isMcpServer && !isAgent && 'content' in selectedItem && (selectedItem as Command).path.endsWith('.md');
    const isSkill = !isPlugin && !isMcpServer && !isAgent && !isCommand;

    // Plugin details
    if (isPlugin) {
      const plugin = selectedItem as InstalledPlugin;
      const key = `${plugin.id}@${plugin.marketplace}`;
      const isToggling = togglingPlugin === key;
      const isUninstalling = uninstallingPlugin === key;

      return (
        <div className="flex-1 overflow-y-auto border-l border-claude-border">
          <div className="p-4">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <Package size={16} className="text-purple-400" />
                <div>
                  <h3 className="text-sm font-mono text-claude-text">{plugin.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`text-xs px-1.5 py-0.5 ${
                        plugin.enabled
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-gray-500/20 text-gray-400'
                      }`}
                    >
                      {plugin.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <span className="text-xs text-claude-text-secondary">{plugin.scope}</span>
                    <span className="text-xs text-claude-text-secondary">v{plugin.version}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {/* Enable/Disable Toggle */}
                <button
                  onClick={() => handlePluginToggle(plugin)}
                  disabled={isToggling || isUninstalling}
                  className={`flex items-center gap-1.5 px-2 py-1.5 text-xs font-mono transition-colors disabled:opacity-50 ${
                    plugin.enabled
                      ? 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
                      : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                  }`}
                  title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
                >
                  {isToggling ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : plugin.enabled ? (
                    <PowerOff size={12} />
                  ) : (
                    <Power size={12} />
                  )}
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </button>

                {/* Uninstall Button */}
                <button
                  onClick={() => handlePluginUninstall(plugin)}
                  disabled={isToggling || isUninstalling}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-mono bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                  title="Uninstall plugin"
                >
                  {isUninstalling ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Uninstall
                </button>
              </div>
            </div>

            {/* Plugin ID */}
            <div className="mb-4">
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Plugin ID</h4>
              <p className="text-sm font-mono text-claude-text">{plugin.id}</p>
            </div>

            {/* Marketplace */}
            <div className="mb-4">
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Marketplace</h4>
              <p className="text-sm text-claude-text">{plugin.marketplace}</p>
            </div>

            {/* Info */}
            <div className="p-3 bg-purple-500/10 border border-purple-500/30">
              <p className="text-xs text-purple-400">
                This plugin provides commands, skills, and agents that appear in their respective sections.
                {plugin.enabled ? ' Currently enabled and available for use.' : ' Currently disabled - enable to use its features.'}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // MCP Server details
    if (isMcpServer) {
      const server = selectedItem as MCPServerInfo;
      return (
        <div className="flex-1 overflow-y-auto border-l border-claude-border">
          <div className="p-4">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-green-400" />
                <div>
                  <h3 className="text-sm font-mono text-claude-text">{server.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`text-xs px-1.5 py-0.5 ${
                        server.status === 'active'
                          ? 'bg-green-500/20 text-green-400'
                          : server.status === 'error'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-gray-500/20 text-gray-400'
                      }`}
                    >
                      {server.status}
                    </span>
                    <span className="text-xs text-claude-text-secondary">{server.type}</span>
                    <span className="text-xs text-claude-text-secondary">v{server.version}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Description */}
            <div className="mb-4">
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Description</h4>
              <p className="text-sm text-claude-text">{server.description}</p>
            </div>

            {/* Error Message */}
            {server.errorMessage && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30">
                <h4 className="text-xs font-mono text-red-400 uppercase mb-1">Error</h4>
                <p className="text-xs text-red-400">{server.errorMessage}</p>
              </div>
            )}

            {/* Tools */}
            {server.tools.length > 0 && (
              <div>
                <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">
                  Available Tools ({server.tools.length})
                </h4>
                <div className="space-y-2">
                  {server.tools.map((tool) => (
                    <div
                      key={tool.name}
                      className="p-2 bg-claude-surface border border-claude-border"
                    >
                      <div className="flex items-center gap-2">
                        <Wrench size={12} className="text-claude-accent" />
                        <span className="text-xs font-mono text-claude-text">{tool.name}</span>
                      </div>
                      {tool.description && (
                        <p className="text-xs text-claude-text-secondary mt-1 ml-5">
                          {tool.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto border-l border-claude-border">
        <div className="p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              {isCommand && <Terminal size={16} className="text-claude-accent" />}
              {isSkill && <Sparkles size={16} className="text-purple-400" />}
              {isAgent && <Bot size={16} className="text-blue-400" />}
              <div>
                <h3 className="text-sm font-mono text-claude-text">
                  {isCommand ? `/${selectedItem.name}` : isAgent ? `@agent-${selectedItem.name}` : (selectedItem as Skill).name}
                </h3>
                <p className="text-xs text-claude-text-secondary mt-1">
                  {selectedItem.scope === 'user' ? 'User Global' : 'Project'}
                  {(isCommand || !isAgent) && ` • ${(selectedItem as Command | Skill).path}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleEditItem(selectedItem as Command | Skill | AgentDefinition)}
                className="p-1 hover:bg-claude-surface text-claude-text-secondary hover:text-claude-accent"
                title="Edit file"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => copyToClipboard(isCommand ? `/${selectedItem.name}` : `@agent-${selectedItem.name}`)}
                className="p-1 hover:bg-claude-surface text-claude-text-secondary"
                title="Copy usage"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>

          {/* Description */}
          {selectedItem.description && (
            <div className="mb-4">
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Description</h4>
              <p className="text-sm text-claude-text">{selectedItem.description}</p>
            </div>
          )}

          {/* Content */}
          {isCommand && (
            <div>
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Prompt</h4>
              <pre className="text-xs text-claude-text bg-claude-surface p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                {(selectedItem as Command).content}
              </pre>
            </div>
          )}

          {isSkill && (
            <div>
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">SKILL.md</h4>
              <pre className="text-xs text-claude-text bg-claude-surface p-3 overflow-x-auto font-mono whitespace-pre-wrap max-h-96 overflow-y-auto">
                {(selectedItem as Skill).content}
              </pre>
            </div>
          )}

          {isAgent && (
            <div>
              <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">System Prompt</h4>
              <pre className="text-xs text-claude-text bg-claude-surface p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                {(selectedItem as AgentDefinition).systemPrompt}
              </pre>
              {(selectedItem as AgentDefinition).disallowedTools && (
                <div className="mt-4">
                  <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Disallowed Tools</h4>
                  <div className="flex flex-wrap gap-1">
                    {(selectedItem as AgentDefinition).disallowedTools!.map(tool => (
                      <span key={tool} className="text-xs bg-red-500/20 text-red-400 px-2 py-1">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Usage example */}
          <div className="mt-6 p-3 bg-claude-bg border border-claude-border">
            <h4 className="text-xs font-mono text-claude-text-secondary uppercase mb-2">Usage</h4>
            <p className="text-xs text-claude-text font-mono">
              {isCommand && `Type /${selectedItem.name} in the input to use this command`}
              {isAgent && `Type @agent-${selectedItem.name} in your message to invoke this agent`}
              {isSkill && `Type /${(selectedItem as Skill).name} to invoke this skill`}
            </p>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-claude-text-secondary">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">Loading extensions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b border-claude-border flex-shrink-0">
        <button
          onClick={() => setActiveTab('installed')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-mono transition-colors ${
            activeTab === 'installed'
              ? 'text-claude-text border-b-2 border-claude-accent bg-claude-surface/50'
              : 'text-claude-text-secondary hover:text-claude-text'
          }`}
        >
          <FolderGit size={14} />
          Installed
        </button>
        <button
          onClick={() => setActiveTab('marketplace')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-mono transition-colors ${
            activeTab === 'marketplace'
              ? 'text-claude-text border-b-2 border-claude-accent bg-claude-surface/50'
              : 'text-claude-text-secondary hover:text-claude-text'
          }`}
        >
          <Store size={14} />
          Marketplace
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'installed' ? (
        <div className="flex-1 flex overflow-hidden">
          {/* List Panel */}
          <div className="w-80 border-r border-claude-border overflow-y-auto flex-shrink-0">
            {/* MCP Servers Section */}
            <div className="border-b border-claude-border">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('mcpServers')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface transition-colors"
                >
                  {expandedType === 'mcpServers' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Server size={14} className="text-green-400" />
                  <span className="text-sm font-mono text-claude-text">MCP Servers</span>
                  <span className="text-xs text-claude-text-secondary">({mcpServers.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface text-claude-text-secondary hover:text-green-400 transition-colors"
                  title="Add MCP server"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'mcpServers' && <div>{renderMcpServerList()}</div>}
            </div>

            {/* Plugins Section */}
            <div className="border-b border-claude-border">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('plugins')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface transition-colors"
                >
                  {expandedType === 'plugins' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Package size={14} className="text-purple-400" />
                  <span className="text-sm font-mono text-claude-text">Plugins</span>
                  <span className="text-xs text-claude-text-secondary">({plugins.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface text-claude-text-secondary hover:text-purple-400 transition-colors"
                  title="Browse plugin marketplace"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'plugins' && <div>{renderPluginList()}</div>}
            </div>

            {/* Commands Section */}
            <div className="border-b border-claude-border">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('commands')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface transition-colors"
                >
                  {expandedType === 'commands' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Terminal size={14} className="text-claude-accent" />
                  <span className="text-sm font-mono text-claude-text">Commands</span>
                  <span className="text-xs text-claude-text-secondary">({commands.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface text-claude-text-secondary hover:text-claude-accent transition-colors"
                  title="Browse plugins for more commands"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'commands' && <div>{renderCommandList()}</div>}
            </div>

            {/* Skills Section */}
            <div className="border-b border-claude-border">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('skills')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface transition-colors"
                >
                  {expandedType === 'skills' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Sparkles size={14} className="text-purple-400" />
                  <span className="text-sm font-mono text-claude-text">Skills</span>
                  <span className="text-xs text-claude-text-secondary">({skills.length})</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSkillMenu(!showSkillMenu);
                  }}
                  className="px-2 py-2 hover:bg-claude-surface text-claude-text-secondary hover:text-purple-400 transition-colors"
                  title="Add skill"
                >
                  <Plus size={14} />
                </button>

                {/* Skill action menu */}
                {showSkillMenu && (
                  <div
                    ref={skillMenuRef}
                    className="absolute right-0 top-full mt-1 z-50 bg-claude-bg border border-claude-border shadow-lg min-w-48"
                  >
                    <button
                      onClick={() => {
                        setShowSkillMenu(false);
                        setShowCreateDialog(true);
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-claude-surface text-left transition-colors"
                    >
                      <FileText size={14} className="text-purple-400" />
                      <div>
                        <span className="text-sm text-claude-text">Create New Skill</span>
                        <p className="text-xs text-claude-text-secondary">Write a skill from scratch</p>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setShowSkillMenu(false);
                        setShowInstallDialog(true);
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-claude-surface text-left transition-colors border-t border-claude-border"
                    >
                      <Github size={14} className="text-claude-text-secondary" />
                      <div>
                        <span className="text-sm text-claude-text">Install from GitHub</span>
                        <p className="text-xs text-claude-text-secondary">Clone a skill repository</p>
                      </div>
                    </button>
                  </div>
                )}
              </div>
              {expandedType === 'skills' && <div>{renderSkillList()}</div>}
            </div>

            {/* Agents Section */}
            <div className="border-b border-claude-border">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('agents')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface transition-colors"
                >
                  {expandedType === 'agents' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Bot size={14} className="text-blue-400" />
                  <span className="text-sm font-mono text-claude-text">Agents</span>
                  <span className="text-xs text-claude-text-secondary">({agents.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface text-claude-text-secondary hover:text-blue-400 transition-colors"
                  title="Browse plugins for more agents"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'agents' && <div>{renderAgentList()}</div>}
            </div>
          </div>

          {/* Details Panel */}
          {viewingContent ? (
            renderItemDetails()
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Terminal size={48} className="mx-auto mb-4 text-claude-text-secondary opacity-50" />
                <p className="text-sm text-claude-text-secondary">Select an extension to view details</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <UnifiedMarketplace
          sessionId={sessionId}
          projectPath={projectPath}
          installedMcpServers={mcpServers}
          onMcpServerInstalled={refreshMcpServers}
        />
      )}

      {/* Install Skill Dialog */}
      {showInstallDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-claude-bg border border-claude-border w-96 max-w-[90%]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border">
              <div className="flex items-center gap-2">
                {installMode === 'github' ? (
                  <Github size={16} className="text-claude-text-secondary" />
                ) : (
                  <FileText size={16} className="text-claude-text-secondary" />
                )}
                <span className="text-sm font-mono text-claude-text">
                  {installMode === 'github' ? 'Install from GitHub' : 'Upload Skill File'}
                </span>
              </div>
              <button
                onClick={handleCloseInstallDialog}
                className="text-claude-text-secondary hover:text-claude-text transition-colors"
                disabled={installing}
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Mode Toggle */}
              <div className="flex gap-2">
                <button
                  onClick={() => setInstallMode('github')}
                  disabled={installing}
                  className={`flex-1 px-3 py-2 text-xs font-mono border transition-colors ${
                    installMode === 'github'
                      ? 'bg-purple-500/20 border-purple-500 text-purple-400'
                      : 'bg-claude-surface border-claude-border text-claude-text-secondary hover:text-claude-text'
                  } disabled:opacity-50`}
                >
                  <Github size={14} className="inline mr-1.5" />
                  GitHub
                </button>
                <button
                  onClick={() => setInstallMode('file')}
                  disabled={installing}
                  className={`flex-1 px-3 py-2 text-xs font-mono border transition-colors ${
                    installMode === 'file'
                      ? 'bg-purple-500/20 border-purple-500 text-purple-400'
                      : 'bg-claude-surface border-claude-border text-claude-text-secondary hover:text-claude-text'
                  } disabled:opacity-50`}
                >
                  <FileText size={14} className="inline mr-1.5" />
                  Local File
                </button>
              </div>

              {/* GitHub Mode */}
              {installMode === 'github' && (
                <div>
                  <label className="block text-xs font-mono text-claude-text-secondary uppercase mb-2">
                    GitHub Source
                  </label>
                  <input
                    ref={installInputRef}
                    type="text"
                    value={installSource}
                    onChange={(e) => setInstallSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !installing) {
                        handleInstallSkill();
                      } else if (e.key === 'Escape') {
                        handleCloseInstallDialog();
                      }
                    }}
                    placeholder="e.g., remotion-dev/skills"
                    className="w-full px-3 py-2 bg-claude-surface border border-claude-border text-sm font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none focus:border-purple-500"
                    disabled={installing}
                  />
                  <p className="text-xs text-claude-text-secondary mt-1">
                    Enter a GitHub repo (user/repo) or full URL
                  </p>
                </div>
              )}

              {/* File Upload Mode */}
              {installMode === 'file' && (
                <div>
                  <label className="block text-xs font-mono text-claude-text-secondary uppercase mb-2">
                    Skill File (.md or .skill)
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.skill"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setInstallFile(file);
                      }
                    }}
                    disabled={installing}
                    className="hidden"
                  />
                  <div className="space-y-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={installing}
                      className="w-full px-3 py-2 bg-claude-surface border border-claude-border text-sm font-mono text-claude-text hover:border-purple-500 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <FileText size={14} />
                      {installFile ? installFile.name : 'Choose file...'}
                    </button>
                    {installFile && (
                      <div className="flex items-center justify-between px-3 py-2 bg-purple-500/10 border border-purple-500/30">
                        <span className="text-xs text-purple-400 font-mono">{installFile.name}</span>
                        <button
                          onClick={() => setInstallFile(null)}
                          disabled={installing}
                          className="text-purple-400 hover:text-purple-300 transition-colors"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-claude-text-secondary mt-1">
                    Select a skill file. The filename becomes the skill name (e.g., my-skill.md → my-skill)
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="installGlobal"
                  checked={installGlobal}
                  onChange={(e) => setInstallGlobal(e.target.checked)}
                  disabled={installing}
                  className="accent-purple-500"
                />
                <label htmlFor="installGlobal" className="text-xs text-claude-text-secondary">
                  Install globally (available in all projects)
                </label>
              </div>

              {/* Result message */}
              {installResult && (
                <div className={`flex items-start gap-2 p-3 ${installResult.success ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
                  {installResult.success ? (
                    <Check size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                  )}
                  <p className={`text-xs ${installResult.success ? 'text-green-500' : 'text-red-500'}`}>
                    {installResult.message}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-claude-border">
              <button
                onClick={handleCloseInstallDialog}
                className="px-3 py-1.5 text-xs font-mono text-claude-text-secondary hover:text-claude-text transition-colors"
                disabled={installing}
              >
                Cancel
              </button>
              <button
                onClick={handleInstallSkill}
                disabled={installing || (installMode === 'github' ? !installSource.trim() : !installFile)}
                className="px-3 py-1.5 text-xs font-mono bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {installing ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    {installMode === 'github' ? 'Installing...' : 'Uploading...'}
                  </>
                ) : (
                  <>
                    <Plus size={12} />
                    {installMode === 'github' ? 'Install' : 'Upload'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Skill Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-claude-bg border border-claude-border w-[600px] max-w-[95%] max-h-[90%] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border flex-shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-purple-400" />
                <span className="text-sm font-mono text-claude-text">Create New Skill</span>
              </div>
              <button
                onClick={handleCloseCreateDialog}
                className="text-claude-text-secondary hover:text-claude-text transition-colors"
                disabled={creating}
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              {/* Skill Name */}
              <div>
                <label className="block text-xs font-mono text-claude-text-secondary uppercase mb-2">
                  Skill Name
                </label>
                <input
                  ref={createNameInputRef}
                  type="text"
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      handleCloseCreateDialog();
                    }
                  }}
                  placeholder="my-skill-name"
                  className="w-full px-3 py-2 bg-claude-surface border border-claude-border text-sm font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none focus:border-purple-500"
                  disabled={creating}
                />
                <p className="text-xs text-claude-text-secondary mt-1">
                  Use lowercase letters, numbers, hyphens, and underscores
                </p>
              </div>

              {/* Scope Selection */}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="skillScope"
                    checked={!newSkillGlobal}
                    onChange={() => setNewSkillGlobal(false)}
                    disabled={creating || !projectPath}
                    className="accent-purple-500"
                  />
                  <FolderGit size={14} className="text-claude-text-secondary" />
                  <span className="text-xs text-claude-text">Project</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="skillScope"
                    checked={newSkillGlobal}
                    onChange={() => setNewSkillGlobal(true)}
                    disabled={creating}
                    className="accent-purple-500"
                  />
                  <User size={14} className="text-claude-text-secondary" />
                  <span className="text-xs text-claude-text">Global (all projects)</span>
                </label>
              </div>

              {/* Skill Content Editor */}
              <div className="flex-1">
                <label className="block text-xs font-mono text-claude-text-secondary uppercase mb-2">
                  SKILL.md Content
                </label>
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  className="w-full h-64 px-3 py-2 bg-claude-surface border border-claude-border text-sm font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none focus:border-purple-500 resize-none"
                  disabled={creating}
                  spellCheck={false}
                />
                <p className="text-xs text-claude-text-secondary mt-1">
                  Define your skill's behavior and instructions using Markdown
                </p>
              </div>

              {/* Result message */}
              {createResult && (
                <div className={`flex items-start gap-2 p-3 ${createResult.success ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
                  {createResult.success ? (
                    <Check size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                  )}
                  <p className={`text-xs ${createResult.success ? 'text-green-500' : 'text-red-500'}`}>
                    {createResult.message}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-claude-border flex-shrink-0">
              <button
                onClick={handleCloseCreateDialog}
                className="px-3 py-1.5 text-xs font-mono text-claude-text-secondary hover:text-claude-text transition-colors"
                disabled={creating}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSkill}
                disabled={creating || !newSkillName.trim()}
                className="px-3 py-1.5 text-xs font-mono bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {creating ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Plus size={12} />
                    Create Skill
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
