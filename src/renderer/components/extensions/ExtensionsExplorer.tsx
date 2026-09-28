import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Sparkles, Bot, ChevronDown, ChevronRight, Copy, User, FolderGit, Edit3, Plus, X, Loader2, Check, AlertCircle, FileText, Github, Server, Store, Wrench, Power, PowerOff, Trash2, Package, MoreHorizontal, Download, Eye, EyeOff, Save } from 'lucide-react';
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

  // MCP editor state
  const [mcpEditMode, setMcpEditMode] = useState(false);
  const [mcpEditName, setMcpEditName] = useState('');
  const [mcpEditType, setMcpEditType] = useState<'stdio' | 'url'>('stdio');
  const [mcpEditCommand, setMcpEditCommand] = useState('');
  const [mcpEditArgs, setMcpEditArgs] = useState('');
  const [mcpEditUrl, setMcpEditUrl] = useState('');
  const [mcpEditEnv, setMcpEditEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [mcpEnvVisible, setMcpEnvVisible] = useState<Record<number, boolean>>({});
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpSaveResult, setMcpSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showMcpAddDialog, setShowMcpAddDialog] = useState(false);
  const [mcpDeleting, setMcpDeleting] = useState(false);
  const [mcpIsNew, setMcpIsNew] = useState(false);

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

  // Load raw MCP config when selecting a server for editing
  const loadMcpRawConfig = async (serverId: string) => {
    try {
      const config = await window.electronAPI.mcp.getRawConfig(serverId);
      if (config) {
        setMcpEditType(
          (config.type as string) === 'url' || (config.type as string) === 'http' || (config.type as string) === 'sse'
            ? 'url'
            : 'stdio'
        );
        setMcpEditCommand((config.command as string) || '');
        setMcpEditArgs(((config.args as string[]) || []).join('\n'));
        setMcpEditUrl((config.url as string) || '');
        const keyValueEntries = Object.entries(
          ((config.type as string) === 'url' || (config.type as string) === 'http' || (config.type as string) === 'sse'
            ? (config.headers as Record<string, string>) || (config.env as Record<string, string>)
            : (config.env as Record<string, string>)) || {}
        ).map(
          ([key, value]) => ({ key, value: value as string })
        );
        setMcpEditEnv(keyValueEntries);
        setMcpEnvVisible({});
        setMcpEditName(serverId);
      } else {
        // No raw config found (built-in server), populate from MCPServerInfo
        setMcpEditName(serverId);
        setMcpEditType('stdio');
        setMcpEditCommand('');
        setMcpEditArgs('');
        setMcpEditUrl('');
        setMcpEditEnv([]);
        setMcpEnvVisible({});
      }
    } catch (err) {
      console.error('[Extensions] Failed to load MCP config:', err);
    }
  };

  // Enter MCP edit mode for existing server
  const handleMcpEdit = async (serverId: string) => {
    await loadMcpRawConfig(serverId);
    setMcpEditMode(true);
    setMcpIsNew(false);
    setMcpSaveResult(null);
  };

  // Enter MCP add mode for new server
  const handleMcpAdd = () => {
    setMcpEditMode(true);
    setMcpIsNew(true);
    setMcpEditName('');
    setMcpEditType('stdio');
    setMcpEditCommand('npx');
    setMcpEditArgs('');
    setMcpEditUrl('');
    setMcpEditEnv([]);
    setMcpEnvVisible({});
    setMcpSaveResult(null);
    setShowMcpAddDialog(true);
    setSelectedItem(null);
    setViewingContent(true);
    setExpandedType('mcpServers');
  };

  // Save MCP server config
  const handleMcpSave = async () => {
    if (!mcpEditName.trim()) {
      setMcpSaveResult({ success: false, message: 'Server name is required' });
      return;
    }

    setMcpSaving(true);
    setMcpSaveResult(null);

    try {
      const config: Record<string, unknown> = { type: mcpEditType === 'url' ? 'http' : 'stdio' };

      if (mcpEditType === 'stdio') {
        config.command = mcpEditCommand;
        config.args = mcpEditArgs.split('\n').map((a: string) => a.trim()).filter(Boolean);
      } else {
        config.url = mcpEditUrl;
      }

      const envObj: Record<string, string> = {};
      for (const { key, value } of mcpEditEnv) {
        if (key.trim()) envObj[key.trim()] = value;
      }
      if (Object.keys(envObj).length > 0) {
        if (mcpEditType === 'url') {
          config.headers = envObj;
        } else {
          config.env = envObj;
        }
      }

      const result = await window.electronAPI.mcp.installRaw(mcpEditName.trim(), config);

      if (result.success) {
        setMcpSaveResult({ success: true, message: 'Configuration saved' });
        await refreshMcpServers();
        // After saving a new server, select it in the list
        if (mcpIsNew) {
          setShowMcpAddDialog(false);
          setMcpIsNew(false);
          // Find the newly created server and select it
          const servers = await window.electronAPI.mcp.getServers(sessionId, projectPath);
          setMcpServers(servers);
          const newServer = servers.find((s: MCPServerInfo) => s.id === mcpEditName.trim());
          if (newServer) {
            setSelectedItem(newServer);
          }
        }
        setTimeout(() => setMcpSaveResult(null), 2000);
      } else {
        setMcpSaveResult({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err) {
      setMcpSaveResult({ success: false, message: err instanceof Error ? err.message : 'Error saving config' });
    } finally {
      setMcpSaving(false);
    }
  };

  // Delete MCP server
  const handleMcpDelete = async (serverId: string) => {
    if (!confirm(`Remove MCP server "${serverId}"? This cannot be undone.`)) {
      return;
    }

    setMcpDeleting(true);
    try {
      const result = await window.electronAPI.mcp.uninstall(serverId);
      if (result.success) {
        await refreshMcpServers();
        setSelectedItem(null);
        setViewingContent(false);
        setMcpEditMode(false);
        setShowMcpAddDialog(false);
      } else {
        alert(`Failed to remove server: ${result.error}`);
      }
    } catch (err) {
      alert(`Error removing server: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setMcpDeleting(false);
    }
  };

  // Cancel MCP editing
  const handleMcpEditCancel = () => {
    setMcpEditMode(false);
    setMcpSaveResult(null);
    if (showMcpAddDialog) {
      setShowMcpAddDialog(false);
      setViewingContent(false);
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
    // Reset MCP editor state
    setMcpEditMode(false);
    setShowMcpAddDialog(false);
    setMcpSaveResult(null);
  };

  const handleItemClick = (item: Command | Skill | AgentDefinition | MCPServerInfo | InstalledPlugin) => {
    setOpenAgentMenu(null);
    setSelectedItem(item);
    setViewingContent(true);
    // Reset MCP editor state when switching items
    setMcpEditMode(false);
    setShowMcpAddDialog(false);
    setMcpSaveResult(null);
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
        <div className="px-3 py-2 text-[12px] text-fg-4">
          No commands found. Create <code className="bg-ink-4 px-1 font-mono text-fg-2">.claude/commands/*.md</code>
        </div>
      );
    }

    return commands.map(cmd => (
      <button
        key={`${cmd.scope}-${cmd.name}`}
        onClick={() => handleItemClick(cmd)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface-hover transition-colors ${
          selectedItem === cmd ? 'bg-claude-surface-hover' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-mono text-accent-text">/{cmd.name}</span>
          {cmd.scope === 'user' ? (
            <User size={10} className="text-fg-4" />
          ) : (
            <FolderGit size={10} className="text-fg-4" />
          )}
        </div>
        {cmd.description && (
          <p className="text-[11.5px] text-fg-4 mt-0.5 truncate">{cmd.description}</p>
        )}
      </button>
    ));
  };

  const renderSkillList = () => {
    if (skills.length === 0) {
      return (
        <div className="px-3 py-2 text-[12px] text-fg-4">
          No skills found. Create <code className="bg-ink-4 px-1 font-mono text-fg-2">.claude/skills/*/SKILL.md</code>
        </div>
      );
    }

    return skills.map(skill => (
      <button
        key={`${skill.scope}-${skill.name}`}
        onClick={() => handleItemClick(skill)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface-hover transition-colors ${
          selectedItem === skill ? 'bg-claude-surface-hover' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-mono text-fg">/{skill.name}</span>
          {skill.scope === 'user' ? (
            <User size={10} className="text-fg-4" />
          ) : (
            <FolderGit size={10} className="text-fg-4" />
          )}
        </div>
        {skill.description && (
          <p className="text-[11.5px] text-fg-4 mt-0.5 truncate">{skill.description}</p>
        )}
      </button>
    ));
  };

  const renderAgentList = () => {
    if (agents.length === 0) {
      return (
        <div className="px-3 py-2 text-[12px] text-fg-4">
          No agents found. Create <code className="bg-ink-4 px-1 font-mono text-fg-2">.claude/agents/*.md</code>
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
            className={`w-full px-3 py-2 pr-11 text-left hover:bg-claude-surface-hover transition-colors ${
              selectedItem === agent ? 'bg-claude-surface-hover' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-mono text-fg">@agent-{agent.name}</span>
              {agent.scope === 'user' ? (
                <User size={10} className="text-fg-4" />
              ) : (
                <FolderGit size={10} className="text-fg-4" />
              )}
            </div>
            <p className="text-[11.5px] text-fg-4 mt-0.5 truncate">{agent.description}</p>
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
                  ? 'bg-claude-surface-hover text-fg'
                  : 'text-fg-4 opacity-0 group-hover:opacity-100 hover:bg-claude-surface-hover'
              }`}
              title="Agent actions"
            >
              <MoreHorizontal size={14} />
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-48 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_32px_rgba(0,0,0,0.4)]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExportAgentConfig(agent);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-fg hover:bg-claude-surface-hover"
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
        <div className="px-3 py-2 text-[12px] text-fg-4">
          No MCP servers active. Install from the Marketplace tab.
        </div>
      );
    }

    return mcpServers.map(server => (
      <button
        key={server.id}
        onClick={() => handleItemClick(server)}
        className={`w-full px-3 py-2 text-left hover:bg-claude-surface-hover transition-colors ${
          selectedItem === server ? 'bg-claude-surface-hover' : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-mono text-fg">{server.name}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              server.status === 'active'
                ? 'bg-diff-add'
                : server.status === 'error'
                ? 'bg-diff-del'
                : 'bg-fg-5'
            }`}
          />
          {server.type === 'sdk' && (
            <span className="font-mono text-[10px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] px-1">SDK</span>
          )}
        </div>
        <p className="text-[11.5px] text-fg-4 mt-0.5 truncate">{server.description}</p>
        {server.tools.length > 0 && (
          <p className="text-[11.5px] text-fg-4 mt-1">
            {server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}
          </p>
        )}
      </button>
    ));
  };

  const renderPluginList = () => {
    if (plugins.length === 0) {
      return (
        <div className="px-3 py-2 text-[12px] text-fg-4">
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
          className={`w-full px-3 py-2 text-left hover:bg-claude-surface-hover transition-colors ${
            selectedItem === plugin ? 'bg-claude-surface-hover' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-mono text-fg">{plugin.name}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                plugin.enabled ? 'bg-diff-add' : 'bg-fg-5'
              }`}
              title={plugin.enabled ? 'Enabled' : 'Disabled'}
            />
            <span className="font-mono text-[10px] uppercase text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)] px-1">
              {plugin.scope}
            </span>
          </div>
          <p className="text-[11.5px] text-fg-4 mt-0.5 truncate">
            {plugin.marketplace}
          </p>
        </button>
      );
    });
  };

  const renderItemDetails = () => {
    if (!selectedItem && !showMcpAddDialog) return null;
    if (!viewingContent) return null;

    // Check what type of item we have
    const isPlugin = selectedItem ? ('marketplace' in selectedItem && 'enabled' in selectedItem) : false;
    const isMcpServer = selectedItem ? (!isPlugin && 'tools' in selectedItem && 'status' in selectedItem) : false;
    const isAgent = selectedItem ? (!isPlugin && !isMcpServer && 'systemPrompt' in selectedItem) : false;
    // Commands have .md path, Skills have directory path (content in both now)
    const isCommand = selectedItem ? (!isPlugin && !isMcpServer && !isAgent && 'content' in selectedItem && (selectedItem as Command).path.endsWith('.md')) : false;
    const isSkill = !isPlugin && !isMcpServer && !isAgent && !isCommand;

    // Plugin details
    if (isPlugin) {
      const plugin = selectedItem as InstalledPlugin;
      const key = `${plugin.id}@${plugin.marketplace}`;
      const isToggling = togglingPlugin === key;
      const isUninstalling = uninstallingPlugin === key;

      return (
        <div className="flex-1 overflow-y-auto border-l border-line">
          <div className="p-4">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <Package size={16} className="text-fg-3" />
                <div>
                  <h3 className="text-[15px] font-semibold tracking-tight text-fg">{plugin.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${
                        plugin.enabled
                          ? 'bg-diff-add/10 text-diff-add-text'
                          : 'text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]'
                      }`}
                    >
                      {plugin.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <span className="text-[12px] text-fg-4">{plugin.scope}</span>
                    <span className="text-[12px] text-fg-4">v{plugin.version}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {/* Enable/Disable Toggle */}
                <button
                  onClick={() => handlePluginToggle(plugin)}
                  disabled={isToggling || isUninstalling}
                  className={`flex items-center gap-1.5 h-8 px-2 text-[13px] transition-colors disabled:opacity-40 ${
                    plugin.enabled
                      ? 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover hover:text-fg'
                      : 'bg-diff-add/10 text-diff-add-text hover:bg-diff-add/20'
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
                  className="flex items-center gap-1.5 h-8 px-2 text-[13px] text-diff-del shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] hover:bg-diff-del/10 transition-colors disabled:opacity-40"
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
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Plugin ID</h4>
              <p className="text-[13px] font-mono text-fg-2">{plugin.id}</p>
            </div>

            {/* Marketplace */}
            <div className="mb-4">
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Marketplace</h4>
              <p className="text-[13px] text-fg-2">{plugin.marketplace}</p>
            </div>

            {/* Info */}
            <div className="p-3 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.3)]">
              <p className="text-[13px] text-accent-text">
                This plugin provides commands, skills, and agents that appear in their respective sections.
                {plugin.enabled ? ' Currently enabled and available for use.' : ' Currently disabled - enable to use its features.'}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // MCP Server details
    if (isMcpServer || showMcpAddDialog) {
      const server = isMcpServer ? (selectedItem as MCPServerInfo) : null;
      const isBuiltIn = server?.type === 'sdk';

      // Render the MCP config editor form
      const renderMcpConfigEditor = () => (
        <div className="space-y-4">
          {/* Server Name */}
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1.5">
              Server Name
            </label>
            {mcpIsNew ? (
              <input
                type="text"
                value={mcpEditName}
                onChange={(e) => setMcpEditName(e.target.value)}
                placeholder="my-mcp-server"
                className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                disabled={mcpSaving}
              />
            ) : (
              <p className="text-[13px] font-mono text-fg-2 px-3 py-2 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                {mcpEditName}
              </p>
            )}
          </div>

          {/* Type Selector */}
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1.5">
              Transport Type
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setMcpEditType('stdio')}
                disabled={mcpSaving}
                className={`flex-1 h-8 px-3 text-[13px] transition-colors ${
                  mcpEditType === 'stdio'
                    ? 'bg-claude-surface-hover text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]'
                    : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:text-fg hover:bg-claude-surface-hover'
                } disabled:opacity-40`}
              >
                stdio
              </button>
              <button
                onClick={() => setMcpEditType('url')}
                disabled={mcpSaving}
                className={`flex-1 h-8 px-3 text-[13px] transition-colors ${
                  mcpEditType === 'url'
                    ? 'bg-claude-surface-hover text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]'
                    : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:text-fg hover:bg-claude-surface-hover'
                } disabled:opacity-40`}
              >
                url / http
              </button>
            </div>
          </div>

          {/* stdio fields */}
          {mcpEditType === 'stdio' && (
            <>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1.5">
                  Command
                </label>
                <input
                  type="text"
                  value={mcpEditCommand}
                  onChange={(e) => setMcpEditCommand(e.target.value)}
                  placeholder="npx"
                  className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  disabled={mcpSaving}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1.5">
                  Arguments (one per line)
                </label>
                <textarea
                  value={mcpEditArgs}
                  onChange={(e) => setMcpEditArgs(e.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-name"}
                  className="w-full h-20 px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                  disabled={mcpSaving}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {/* url fields */}
          {mcpEditType === 'url' && (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1.5">
                Server URL
              </label>
              <input
                type="text"
                value={mcpEditUrl}
                onChange={(e) => setMcpEditUrl(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                disabled={mcpSaving}
              />
            </div>
          )}

          {/* Environment Variables / Headers */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
                {mcpEditType === 'url' ? 'Headers' : 'Environment Variables'}
              </label>
              <button
                onClick={() => setMcpEditEnv([...mcpEditEnv, { key: '', value: '' }])}
                disabled={mcpSaving}
                className="flex items-center gap-1 h-6 px-2 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors disabled:opacity-40"
              >
                <Plus size={10} /> Add
              </button>
            </div>
            {mcpEditEnv.length === 0 && (
              <p className="text-[12px] text-fg-4 px-3 py-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                {mcpEditType === 'url'
                  ? 'No headers configured. Add API keys here.'
                  : 'No environment variables configured. Add API keys here.'}
              </p>
            )}
            <div className="space-y-2">
              {mcpEditEnv.map((env, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <input
                    type="text"
                    value={env.key}
                    onChange={(e) => {
                      const updated = [...mcpEditEnv];
                      updated[i] = { ...updated[i], key: e.target.value };
                      setMcpEditEnv(updated);
                    }}
                    placeholder="KEY_NAME"
                    className="flex-1 px-2 py-1.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[12px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    disabled={mcpSaving}
                  />
                  <div className="flex-1 flex items-center gap-0">
                    <input
                      type={mcpEnvVisible[i] ? 'text' : 'password'}
                      value={env.value}
                      onChange={(e) => {
                        const updated = [...mcpEditEnv];
                        updated[i] = { ...updated[i], value: e.target.value };
                        setMcpEditEnv(updated);
                      }}
                      placeholder="value"
                      className="flex-1 min-w-0 px-2 py-1.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[12px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      disabled={mcpSaving}
                    />
                    <button
                      onClick={() => setMcpEnvVisible({ ...mcpEnvVisible, [i]: !mcpEnvVisible[i] })}
                      className="px-1.5 py-1.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg-4 hover:text-fg transition-colors"
                      title={mcpEnvVisible[i] ? 'Hide value' : 'Show value'}
                    >
                      {mcpEnvVisible[i] ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      const updated = mcpEditEnv.filter((_, idx) => idx !== i);
                      setMcpEditEnv(updated);
                      // Clean up visibility state
                      const vis = { ...mcpEnvVisible };
                      delete vis[i];
                      setMcpEnvVisible(vis);
                    }}
                    className="px-1.5 py-1.5 text-diff-del hover:bg-diff-del/10 transition-colors"
                    disabled={mcpSaving}
                    title="Remove variable"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Save Result */}
          {mcpSaveResult && (
            <div className={`flex items-start gap-2 p-3 ${mcpSaveResult.success ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]' : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'}`}>
              {mcpSaveResult.success ? (
                <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-[13px] ${mcpSaveResult.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                {mcpSaveResult.message}
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-2 border-t border-line">
            <button
              onClick={handleMcpEditCancel}
              className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
              disabled={mcpSaving}
            >
              Cancel
            </button>
            <button
              onClick={handleMcpSave}
              disabled={mcpSaving || !mcpEditName.trim()}
              className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {mcpSaving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={12} />
                  {mcpIsNew ? 'Add Server' : 'Save Config'}
                </>
              )}
            </button>
          </div>
        </div>
      );

      // When showing the add dialog (no server selected)
      if (showMcpAddDialog && !server) {
        return (
          <div className="flex-1 overflow-y-auto border-l border-line">
            <div className="p-4">
              <div className="flex items-center gap-2 mb-4">
                <Server size={16} className="text-fg-3" />
                <h3 className="text-[15px] font-semibold tracking-tight text-fg">Add MCP Server</h3>
              </div>
              {renderMcpConfigEditor()}
            </div>
          </div>
        );
      }

      // Existing server view
      if (server) {
        return (
          <div className="flex-1 overflow-y-auto border-l border-line">
            <div className="p-4">
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Server size={16} className="text-fg-3" />
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight text-fg">{server.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`font-mono text-[10px] uppercase px-1.5 py-0.5 ${
                          server.status === 'active'
                            ? 'bg-diff-add/10 text-diff-add-text'
                            : server.status === 'error'
                            ? 'bg-diff-del/10 text-diff-del-text'
                            : 'text-fg-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]'
                        }`}
                      >
                        {server.status}
                      </span>
                      <span className="text-[12px] text-fg-4">{server.type}</span>
                      <span className="text-[12px] text-fg-4">v{server.version}</span>
                    </div>
                  </div>
                </div>
                {/* Edit / Delete buttons (not for built-in servers) */}
                {!isBuiltIn && (
                  <div className="flex items-center gap-1">
                    {!mcpEditMode && (
                      <button
                        onClick={() => handleMcpEdit(server.id)}
                        className="p-1.5 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
                        title="Edit configuration"
                      >
                        <Edit3 size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => handleMcpDelete(server.id)}
                      className="p-1.5 hover:bg-claude-surface-hover text-fg-4 hover:text-diff-del transition-colors"
                      title="Remove server"
                      disabled={mcpDeleting}
                    >
                      {mcpDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                )}
              </div>

              {/* Edit Mode: show config editor */}
              {mcpEditMode && !isBuiltIn ? (
                renderMcpConfigEditor()
              ) : (
                <>
                  {/* Description */}
                  <div className="mb-4">
                    <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Description</h4>
                    <p className="text-[13px] text-fg-2">{server.description}</p>
                  </div>

                  {/* Error Message */}
                  {server.errorMessage && (
                    <div className="mb-4 p-3 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]">
                      <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-diff-del-text mb-1\">Error</h4>
                      <p className="text-[13px] text-diff-del-text">{server.errorMessage}</p>
                    </div>
                  )}

                  {/* Tools */}
                  {server.tools.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                        Available Tools ({server.tools.length})
                      </h4>
                      <div className="space-y-2">
                        {server.tools.map((tool) => (
                          <div
                            key={tool.name}
                            className="p-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                          >
                            <div className="flex items-center gap-2">
                              <Wrench size={12} className="text-fg-4" />
                              <span className="text-[12px] font-mono text-fg">{tool.name}</span>
                            </div>
                            {tool.description && (
                              <p className="text-[12px] text-fg-4 mt-1 ml-5">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      }
    }

    // Guard: if we got here without a selected item, nothing to show
    if (!selectedItem) return null;

    return (
      <div className="flex-1 overflow-y-auto border-l border-line">
        <div className="p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              {isCommand && <Terminal size={16} className="text-fg-3" />}
              {isSkill && <Sparkles size={16} className="text-fg-3" />}
              {isAgent && <Bot size={16} className="text-fg-3" />}
              <div>
                <h3 className="text-[15px] font-semibold tracking-tight text-fg">
                  {isCommand ? `/${selectedItem.name}` : isAgent ? `@agent-${selectedItem.name}` : (selectedItem as Skill).name}
                </h3>
                <p className="text-[12px] text-fg-4 mt-1">
                  {(selectedItem as any).scope === 'user' ? 'User Global' : 'Project'}
                  {(isCommand || !isAgent) && ` • ${(selectedItem as Command | Skill).path}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleEditItem(selectedItem as Command | Skill | AgentDefinition)}
                className="p-1 hover:bg-claude-surface-hover text-fg-4 hover:text-fg"
                title="Edit file"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => copyToClipboard(isCommand ? `/${selectedItem.name}` : `@agent-${selectedItem.name}`)}
                className="p-1 hover:bg-claude-surface-hover text-fg-4"
                title="Copy usage"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>

          {/* Description */}
          {(selectedItem as any).description && (
            <div className="mb-4">
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Description</h4>
              <p className="text-[13px] text-fg-2">{(selectedItem as any).description}</p>
            </div>
          )}

          {/* Content */}
          {isCommand && (
            <div>
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Prompt</h4>
              <pre className="text-[12px] text-fg-2 bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                {(selectedItem as Command).content}
              </pre>
            </div>
          )}

          {isSkill && (
            <div>
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">SKILL.md</h4>
              <pre className="text-[12px] text-fg-2 bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] p-3 overflow-x-auto font-mono whitespace-pre-wrap max-h-96 overflow-y-auto">
                {(selectedItem as Skill).content}
              </pre>
            </div>
          )}

          {isAgent && (
            <div>
              <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">System Prompt</h4>
              <pre className="text-[12px] text-fg-2 bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                {(selectedItem as AgentDefinition).systemPrompt}
              </pre>
              {(selectedItem as AgentDefinition).disallowedTools && (
                <div className="mt-4">
                  <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Disallowed Tools</h4>
                  <div className="flex flex-wrap gap-1">
                    {(selectedItem as AgentDefinition).disallowedTools!.map(tool => (
                      <span key={tool} className="font-mono text-[11px] bg-diff-del/10 text-diff-del-text px-1.5 py-0.5">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Usage example */}
          <div className="mt-6 p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">Usage</h4>
            <p className="text-[13px] text-fg font-mono">
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
        <div className="flex items-center gap-2 text-fg-4">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-[13px]">Loading extensions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar */}
      <div className="flex border-b border-line flex-shrink-0">
        <button
          onClick={() => setActiveTab('installed')}
          className={`flex items-center gap-2 h-9 px-4 text-[13px] transition-colors ${
            activeTab === 'installed'
              ? 'text-fg border-b-2 border-accent bg-claude-surface-hover'
              : 'text-fg-4 hover:text-fg'
          }`}
        >
          <FolderGit size={14} />
          Installed
        </button>
        <button
          onClick={() => setActiveTab('marketplace')}
          className={`flex items-center gap-2 h-9 px-4 text-[13px] transition-colors ${
            activeTab === 'marketplace'
              ? 'text-fg border-b-2 border-accent bg-claude-surface-hover'
              : 'text-fg-4 hover:text-fg'
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
          <div className="w-80 border-r border-line overflow-y-auto flex-shrink-0">
            {/* MCP Servers Section */}
            <div className="border-b border-line">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('mcpServers')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover transition-colors"
                >
                  {expandedType === 'mcpServers' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Server size={14} className="text-fg-3" />
                  <span className="text-[13px] font-medium text-fg">MCP Servers</span>
                  <span className="font-mono text-[11px] text-fg-4">({mcpServers.length})</span>
                </button>
                <button
                  onClick={handleMcpAdd}
                  className="px-2 py-2 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
                  title="Add MCP server"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'mcpServers' && <div>{renderMcpServerList()}</div>}
            </div>

            {/* Plugins Section */}
            <div className="border-b border-line">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('plugins')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover transition-colors"
                >
                  {expandedType === 'plugins' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Package size={14} className="text-fg-3" />
                  <span className="text-[13px] font-medium text-fg">Plugins</span>
                  <span className="font-mono text-[11px] text-fg-4">({plugins.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
                  title="Browse plugin marketplace"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'plugins' && <div>{renderPluginList()}</div>}
            </div>

            {/* Commands Section */}
            <div className="border-b border-line">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('commands')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover transition-colors"
                >
                  {expandedType === 'commands' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Terminal size={14} className="text-fg-3" />
                  <span className="text-[13px] font-medium text-fg">Commands</span>
                  <span className="font-mono text-[11px] text-fg-4">({commands.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
                  title="Browse plugins for more commands"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expandedType === 'commands' && <div>{renderCommandList()}</div>}
            </div>

            {/* Skills Section */}
            <div className="border-b border-line">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('skills')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover transition-colors"
                >
                  {expandedType === 'skills' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Sparkles size={14} className="text-fg-3" />
                  <span className="text-[13px] font-medium text-fg">Skills</span>
                  <span className="font-mono text-[11px] text-fg-4">({skills.length})</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSkillMenu(!showSkillMenu);
                  }}
                  className="px-2 py-2 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
                  title="Add skill"
                >
                  <Plus size={14} />
                </button>

                {/* Skill action menu */}
                {showSkillMenu && (
                  <div
                    ref={skillMenuRef}
                    className="absolute right-0 top-full mt-1 z-50 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_32px_rgba(0,0,0,0.4)] min-w-48"
                  >
                    <button
                      onClick={() => {
                        setShowSkillMenu(false);
                        setShowCreateDialog(true);
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover text-left transition-colors"
                    >
                      <FileText size={14} className="text-fg-3" />
                      <div>
                        <span className="text-[13px] text-fg-2">Create New Skill</span>
                        <p className="text-[12px] text-fg-4">Write a skill from scratch</p>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setShowSkillMenu(false);
                        setShowInstallDialog(true);
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover text-left transition-colors border-t border-line"
                    >
                      <Github size={14} className="text-fg-4" />
                      <div>
                        <span className="text-[13px] text-fg-2">Install from GitHub</span>
                        <p className="text-[12px] text-fg-4">Clone a skill repository</p>
                      </div>
                    </button>
                  </div>
                )}
              </div>
              {expandedType === 'skills' && <div>{renderSkillList()}</div>}
            </div>

            {/* Agents Section */}
            <div className="border-b border-line">
              <div className="flex items-center relative">
                <button
                  onClick={() => toggleType('agents')}
                  className="flex-1 px-3 py-2 flex items-center gap-2 hover:bg-claude-surface-hover transition-colors"
                >
                  {expandedType === 'agents' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Bot size={14} className="text-fg-3" />
                  <span className="text-[13px] font-medium text-fg">Agents</span>
                  <span className="font-mono text-[11px] text-fg-4">({agents.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-2 py-2 hover:bg-claude-surface-hover text-fg-4 hover:text-fg transition-colors"
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
                <Terminal size={48} className="mx-auto mb-4 text-fg-5" />
                <p className="text-[13px] text-fg-3">Select an extension to view details</p>
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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-96 max-w-[90%]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <div className="flex items-center gap-2">
                {installMode === 'github' ? (
                  <Github size={16} className="text-fg-4" />
                ) : (
                  <FileText size={16} className="text-fg-4" />
                )}
                <span className="text-[16px] font-semibold tracking-tight text-fg">
                  {installMode === 'github' ? 'Install from GitHub' : 'Upload Skill File'}
                </span>
              </div>
              <button
                onClick={handleCloseInstallDialog}
                className="text-fg-4 hover:text-fg transition-colors"
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
                  className={`flex-1 h-8 px-3 text-[13px] transition-colors ${
                    installMode === 'github'
                      ? 'bg-claude-surface-hover text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]'
                      : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:text-fg hover:bg-claude-surface-hover'
                  } disabled:opacity-40`}
                >
                  <Github size={14} className="inline mr-1.5" />
                  GitHub
                </button>
                <button
                  onClick={() => setInstallMode('file')}
                  disabled={installing}
                  className={`flex-1 h-8 px-3 text-[13px] transition-colors ${
                    installMode === 'file'
                      ? 'bg-claude-surface-hover text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]'
                      : 'text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:text-fg hover:bg-claude-surface-hover'
                  } disabled:opacity-40`}
                >
                  <FileText size={14} className="inline mr-1.5" />
                  Local File
                </button>
              </div>

              {/* GitHub Mode */}
              {installMode === 'github' && (
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
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
                    className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    disabled={installing}
                  />
                  <p className="text-[12px] text-fg-4 mt-1">
                    Enter a GitHub repo (user/repo) or full URL
                  </p>
                </div>
              )}

              {/* File Upload Mode */}
              {installMode === 'file' && (
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
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
                      className="w-full px-3 py-2 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      <FileText size={14} />
                      {installFile ? installFile.name : 'Choose file...'}
                    </button>
                    {installFile && (
                      <div className="flex items-center justify-between px-3 py-2 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.3)]">
                        <span className="text-[12px] text-accent-text font-mono">{installFile.name}</span>
                        <button
                          onClick={() => setInstallFile(null)}
                          disabled={installing}
                          className="text-accent-text hover:text-fg transition-colors"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="text-[12px] text-fg-4 mt-1">
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
                  className="accent-[#4C9AFF]"
                />
                <label htmlFor="installGlobal" className="text-[12px] text-fg-4">
                  Install globally (available in all projects)
                </label>
              </div>

              {/* Result message */}
              {installResult && (
                <div className={`flex items-start gap-2 p-3 ${installResult.success ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]' : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'}`}>
                  {installResult.success ? (
                    <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
                  )}
                  <p className={`text-[13px] ${installResult.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                    {installResult.message}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line">
              <button
                onClick={handleCloseInstallDialog}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
                disabled={installing}
              >
                Cancel
              </button>
              <button
                onClick={handleInstallSkill}
                disabled={installing || (installMode === 'github' ? !installSource.trim() : !installFile)}
                className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-[600px] max-w-[95%] max-h-[90%] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-fg-3" />
                <span className="text-[16px] font-semibold tracking-tight text-fg">Create New Skill</span>
              </div>
              <button
                onClick={handleCloseCreateDialog}
                className="text-fg-4 hover:text-fg transition-colors"
                disabled={creating}
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              {/* Skill Name */}
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
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
                  className="w-full px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  disabled={creating}
                />
                <p className="text-[12px] text-fg-4 mt-1">
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
                    className="accent-[#4C9AFF]"
                  />
                  <FolderGit size={14} className="text-fg-4" />
                  <span className="text-[13px] text-fg-2">Project</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="skillScope"
                    checked={newSkillGlobal}
                    onChange={() => setNewSkillGlobal(true)}
                    disabled={creating}
                    className="accent-[#4C9AFF]"
                  />
                  <User size={14} className="text-fg-4" />
                  <span className="text-[13px] text-fg-2">Global (all projects)</span>
                </label>
              </div>

              {/* Skill Content Editor */}
              <div className="flex-1">
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-2">
                  SKILL.md Content
                </label>
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  className="w-full h-64 px-3 py-2 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                  disabled={creating}
                  spellCheck={false}
                />
                <p className="text-[12px] text-fg-4 mt-1">
                  Define your skill's behavior and instructions using Markdown
                </p>
              </div>

              {/* Result message */}
              {createResult && (
                <div className={`flex items-start gap-2 p-3 ${createResult.success ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]' : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'}`}>
                  {createResult.success ? (
                    <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
                  )}
                  <p className={`text-[13px] ${createResult.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                    {createResult.message}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line flex-shrink-0">
              <button
                onClick={handleCloseCreateDialog}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
                disabled={creating}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSkill}
                disabled={creating || !newSkillName.trim()}
                className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
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
