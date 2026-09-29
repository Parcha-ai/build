import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle, XCircle, Server, Key, Folder, AlertTriangle, Terminal, Settings, Wifi, Wrench, Upload, FolderSearch, Copy } from 'lucide-react';
import type { SSHConfig, SavedSSHConfig, Session, SSHResumeCandidate } from '../../../shared/types';
import RemoteFileBrowser from './RemoteFileBrowser';

interface SSHConfigFormProps {
  onBack: () => void;
  onConnect: (config: SSHConfig, name: string, resumeSessionId?: string) => Promise<void>;
  // Teleport mode: when provided, shows source session info and teleports instead of creating
  teleportSource?: Session;
  onTeleport?: (config: SSHConfig) => Promise<void>;
}

type TabId = 'connection' | 'setup';

type RemoteCliCapabilities = {
  claude?: boolean;
  codex?: boolean;
  cursor?: boolean;
  gemini?: boolean;
  opencode?: boolean;
  prime?: boolean;
};

type RemoteCliSetupCommand = {
  harness: keyof RemoteCliCapabilities;
  label: string;
  command: string;
  docsUrl: string;
};

const REMOTE_HARNESS_LABELS: Record<keyof RemoteCliCapabilities, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  prime: 'Prime Agent',
};

const REMOTE_HARNESS_ORDER: Array<keyof RemoteCliCapabilities> = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'prime'];

function getRemoteHarnessLabels(capabilities?: RemoteCliCapabilities): string[] {
  if (!capabilities) return [];
  return REMOTE_HARNESS_ORDER
    .filter((key) => capabilities[key])
    .map((key) => REMOTE_HARNESS_LABELS[key]);
}

function formatRemoteHarnesses(capabilities?: RemoteCliCapabilities): string {
  const labels = getRemoteHarnessLabels(capabilities);
  return labels.length > 0 ? `Harnesses: ${labels.join(', ')}` : '';
}

export default function SSHConfigForm({ onBack, onConnect, teleportSource, onTeleport }: SSHConfigFormProps) {
  const isTeleportMode = !!teleportSource;
  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('connection');
  const [isLoading, setIsLoading] = useState(true);

  // Connection settings
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState(''); // Never save passphrase

  // Setup settings
  const [remoteWorkdir, setRemoteWorkdir] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [worktreeScript, setWorktreeScript] = useState('');
  const [syncSettings, setSyncSettings] = useState(true);
  const [forwardGitHubCredentials, setForwardGitHubCredentials] = useState(false);

  // Status
  const [isTesting, setIsTesting] = useState(false);
  const [installingHarness, setInstallingHarness] = useState<keyof RemoteCliCapabilities | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    claudeCodeVersion?: string;
    hostname?: string;
    cliCapabilities?: RemoteCliCapabilities;
    setupWarning?: string;
    missingCliInstallCommands?: RemoteCliSetupCommand[];
  } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [resumeCandidates, setResumeCandidates] = useState<SSHResumeCandidate[]>([]);
  const [isLoadingResumeCandidates, setIsLoadingResumeCandidates] = useState(false);
  const [resumeMode, setResumeMode] = useState<'new' | 'existing'>('new');
  const [selectedResumeSessionId, setSelectedResumeSessionId] = useState('');

  // Remote file browser
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);

  // Host whose saved config is currently applied to the form, so switching
  // hosts recalls that host's settings without clobbering in-progress edits.
  const [appliedHostKey, setAppliedHostKey] = useState('');

  const applySavedConfig = (saved: SavedSSHConfig) => {
    setPort(saved.port || '22');
    setUsername(saved.username || '');
    setPrivateKeyPath(saved.privateKeyPath || '');
    setRemoteWorkdir(saved.remoteWorkdir || '');
    setSessionName(saved.sessionName || '');
    setWorktreeScript(saved.worktreeScript || '');
    setSyncSettings(saved.syncSettings ?? true);
    // This must be an affirmative opt-in. Legacy saved SSH configs predate the
    // field and therefore remain safely disabled after upgrading.
    setForwardGitHubCredentials(saved.forwardGitHubCredentials === true);
  };

  // Load saved config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const saved = await window.electronAPI.ssh.getSavedConfig();
        if (saved) {
          setHost(saved.host || '');
          applySavedConfig(saved);
          setAppliedHostKey((saved.host || '').trim().toLowerCase());
        }
      } catch (error) {
        console.error('Failed to load saved SSH config:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadConfig();
  }, []);

  // Recall this host's last-used settings when the hostname changes
  useEffect(() => {
    if (isLoading) return;
    const key = host.trim().toLowerCase();
    if (!key || key === appliedHostKey) return;

    // An opt-in from one host must never bleed into another while its saved
    // config is loading (or when the new host has no saved config at all).
    setForwardGitHubCredentials(false);

    const timeoutId = setTimeout(async () => {
      try {
        const saved = await window.electronAPI.ssh.getHostConfig(key);
        if (saved) {
          applySavedConfig(saved);
        }
      } catch (error) {
        console.error('Failed to load saved config for host:', error);
      } finally {
        setAppliedHostKey(key);
      }
    }, 600);

    return () => clearTimeout(timeoutId);
  }, [host, isLoading, appliedHostKey]);

  // Reset test result when connection fields change
  useEffect(() => {
    if (testResult) {
      setTestResult(null);
    }
    setResumeCandidates([]);
    setResumeMode('new');
    setSelectedResumeSessionId('');
  }, [host, port, username, privateKeyPath, passphrase, remoteWorkdir]);

  useEffect(() => {
    if (worktreeScript.trim()) {
      setResumeMode('new');
      setSelectedResumeSessionId('');
    }
  }, [worktreeScript]);

  // Auto-test connection when all required fields are filled
  useEffect(() => {
    // Don't auto-test while loading saved config or if already testing
    if (isLoading || isTesting) return;

    // Check if all required fields are filled
    const hasAllFields = host && username && privateKeyPath && remoteWorkdir;
    if (!hasAllFields) return;

    // Debounce the test to avoid rapid re-testing while typing
    const timeoutId = setTimeout(() => {
      handleTestConnection();
    }, 800);

    return () => clearTimeout(timeoutId);
  }, [host, port, username, privateKeyPath, remoteWorkdir, passphrase, isLoading]);

  const handleSelectKeyFile = async () => {
    const homePath = await window.electronAPI.app.getPath('home');
    const result = await window.electronAPI.app.showDialog({
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
      defaultPath: `${homePath}/.ssh`,
    }) as { canceled: boolean; filePaths: string[] };

    if (!result.canceled && result.filePaths.length > 0) {
      setPrivateKeyPath(result.filePaths[0]);
    }
  };

  const handleTestConnection = async () => {
    if (!host || !username || !privateKeyPath || !remoteWorkdir) {
      setTestResult({
        success: false,
        error: 'Please fill in all required fields (host, username, key, remote directory)',
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const config: SSHConfig = {
        host,
        port: parseInt(port) || 22,
        username,
        privateKeyPath,
        remoteWorkdir,
        passphrase: passphrase || undefined,
      };

      const result = await window.electronAPI.ssh.testConnection(config);
      setTestResult(result);

      if (result.success && !sessionName && result.hostname) {
        setSessionName(`SSH: ${result.hostname}`);
      }

      if (result.success && !isTeleportMode && !worktreeScript.trim()) {
        setIsLoadingResumeCandidates(true);
        try {
          const candidates = await window.electronAPI.ssh.listResumeCandidates(config);
          setResumeCandidates(candidates);
        } catch (error) {
          console.error('Failed to load SSH resume candidates:', error);
          setResumeCandidates([]);
        } finally {
          setIsLoadingResumeCandidates(false);
        }
      } else {
        setResumeCandidates([]);
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      setResumeCandidates([]);
    } finally {
      setIsTesting(false);
    }
  };

  const handleInstallRemoteHarness = async (harness: keyof RemoteCliCapabilities) => {
    if (!host || !username || !privateKeyPath || !remoteWorkdir) {
      setInstallError('Fill in the host, username, key, and remote directory first.');
      return;
    }

    setInstallingHarness(harness);
    setInstallError(null);
    try {
      const config: SSHConfig = {
        host,
        port: parseInt(port) || 22,
        username,
        privateKeyPath,
        remoteWorkdir,
        passphrase: passphrase || undefined,
      };
      const result = await window.electronAPI.ssh.installCli(config, harness);
      const nextCapabilities = result.capabilities;
      setTestResult((current) => ({
        ...(current || { success: true }),
        success: true,
        cliCapabilities: nextCapabilities,
        setupWarning: undefined,
        missingCliInstallCommands: current?.missingCliInstallCommands?.filter((setup) => setup.harness !== harness),
      }));
      await handleTestConnection();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : `Could not install ${REMOTE_HARNESS_LABELS[harness]}.`);
    } finally {
      setInstallingHarness(null);
    }
  };

  const handleCreate = async () => {
    if (!testResult?.success) {
      setCreateError('Please test the connection first');
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const config: SSHConfig = {
        host,
        port: parseInt(port) || 22,
        username,
        privateKeyPath,
        remoteWorkdir,
        passphrase: passphrase || undefined,
        worktreeScript: worktreeScript || undefined,
        syncSettings,
        forwardGitHubCredentials,
      };

      // Save config via IPC (persisted to electron-store)
      await window.electronAPI.ssh.saveConfig({
        host,
        port,
        username,
        privateKeyPath,
        remoteWorkdir,
        sessionName,
        worktreeScript,
        syncSettings,
        forwardGitHubCredentials,
      });

      // In teleport mode, call onTeleport instead of onConnect
      if (isTeleportMode && onTeleport) {
        await onTeleport(config);
      } else {
        await onConnect(
          config,
          sessionName || `SSH: ${host}`,
          resumeMode === 'existing' ? selectedResumeSessionId : undefined
        );
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : isTeleportMode ? 'Failed to teleport session' : 'Failed to create session');
    } finally {
      setIsCreating(false);
    }
  };

  const isConnectionValid = host && username && privateKeyPath;
  const isSetupValid = remoteWorkdir;
  const canTest = isConnectionValid && isSetupValid;
  const canCreate = !!testResult?.success && (resumeMode === 'new' || !!selectedResumeSessionId);

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'connection', label: 'Connection', icon: <Wifi size={12} /> },
    { id: 'setup', label: 'Setup', icon: <Wrench size={12} /> },
  ];

  // Action button text based on mode
  const actionButtonText = isTeleportMode
    ? (isCreating ? 'TELEPORTING...' : 'TELEPORT')
    : (isCreating ? 'CREATING...' : 'CREATE SESSION');

  // Show loading spinner while fetching saved config
  if (isLoading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-fg-4" />
        <span className="mt-2 text-[12px] text-fg-4">Loading saved config...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Teleport Source Info */}
      {isTeleportMode && teleportSource && (
        <div className="mb-3 p-3 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.3)]">
          <div className="flex items-center gap-2 mb-1">
            <Upload size={14} className="text-accent-text" />
            <span className="text-[11px] font-medium text-accent-text uppercase tracking-[0.04em]">TELEPORTING FROM LOCAL</span>
          </div>
          <div className="text-[14px] font-semibold text-fg">{teleportSource.name}</div>
          <div className="text-[11.5px] font-mono text-fg-4 truncate mt-0.5">{teleportSource.worktreePath}</div>
        </div>
      )}

      {/* Tab Header */}
      <div className="flex gap-1 border-b border-line pb-2 mb-3">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 h-7 px-3 text-[12.5px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-claude-surface-hover text-fg'
                : 'text-fg-3 hover:text-fg hover:bg-claude-surface-hover'
            }`}
          >
            {tab.icon}
            {tab.label.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {activeTab === 'connection' && (
          <>
            {/* Host & Port */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                  HOST
                </label>
                <div className="relative">
                  <Server size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-5" />
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="hostname or IP"
                    className="w-full pl-9 pr-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>
              </div>
              <div className="w-16">
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                  PORT
                </label>
                <input
                  type="text"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  className="w-full px-2 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 text-center"
                />
              </div>
            </div>

            {/* Username */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ubuntu"
                className="w-full px-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
            </div>

            {/* Private Key */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                PRIVATE KEY
              </label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-5" />
                  <input
                    type="text"
                    value={privateKeyPath}
                    readOnly
                    placeholder="~/.ssh/id_ed25519"
                    onClick={handleSelectKeyFile}
                    className="w-full pl-9 pr-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 cursor-pointer truncate"
                  />
                </div>
                <button
                  onClick={handleSelectKeyFile}
                  className="px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                >
                  ...
                </button>
              </div>
            </div>

            {/* Passphrase */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                KEY PASSPHRASE <span className="font-normal normal-case tracking-normal text-fg-5">(if encrypted)</span>
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Leave empty if none"
                className="w-full px-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
            </div>
          </>
        )}

        {activeTab === 'setup' && (
          <>
            {/* Remote Working Directory */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                REMOTE WORKING DIRECTORY
              </label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Folder size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-5" />
                  <input
                    type="text"
                    value={remoteWorkdir}
                    onChange={(e) => setRemoteWorkdir(e.target.value)}
                    placeholder="/home/ubuntu/project"
                    className="w-full pl-9 pr-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>
                <button
                  onClick={() => {
                    if (isConnectionValid) {
                      setShowDirBrowser(true);
                    }
                  }}
                  disabled={!isConnectionValid}
                  className="px-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={isConnectionValid ? "Browse remote directories" : "Fill in connection details first"}
                >
                  <FolderSearch size={14} className="text-fg-3" />
                </button>
              </div>
              <p className="text-[11.5px] text-fg-4 mt-1">Where remote harnesses will execute tools</p>
            </div>

            {/* Session Name */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                SESSION NAME <span className="font-normal normal-case tracking-normal text-fg-5">(optional)</span>
              </label>
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Auto-generated from hostname"
                className="w-full px-3 py-1.5 text-[13px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
            </div>

            {/* Worktree Setup Script */}
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                SETUP SCRIPT <span className="font-normal normal-case tracking-normal text-fg-5">(optional)</span>
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Terminal size={14} className="absolute left-3 top-2.5 text-fg-5" />
                  <textarea
                    value={worktreeScript}
                    onChange={(e) => setWorktreeScript(e.target.value)}
                    placeholder="./setup-worktree.sh my-branch"
                    rows={2}
                    className="w-full pl-9 pr-3 py-1.5 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                  />
                </div>
                <button
                  onClick={() => {
                    // Only show browser if connection is tested successfully
                    if (testResult?.success) {
                      setShowFileBrowser(true);
                    }
                  }}
                  disabled={!testResult?.success}
                  className="px-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={testResult?.success ? "Browse remote files" : "Test connection first"}
                >
                  <FolderSearch size={14} className="text-fg-3" />
                </button>
              </div>
              <p className="text-[11.5px] text-fg-4 mt-1">Runs before the agent starts (e.g., clone repo, create worktree)</p>
            </div>

            {/* Sync Settings */}
            <div className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                id="syncSettings"
                checked={syncSettings}
                onChange={(e) => setSyncSettings(e.target.checked)}
                className="w-3.5 h-3.5 accent-[#4C9AFF]"
              />
              <label htmlFor="syncSettings" className="text-[12.5px] text-fg-2 cursor-pointer flex items-center gap-1.5">
                <Settings size={11} className="text-fg-4" />
                Sync settings to remote (~/.claude/agents, commands, CLAUDE.md)
              </label>
            </div>

            {/* Personal GitHub identity/auth must never ride along with the
                broader settings sync unless the user explicitly asks for it. */}
            <div className="flex items-start gap-2 py-1 pl-5">
              <input
                type="checkbox"
                id="forwardGitHubCredentials"
                checked={forwardGitHubCredentials}
                onChange={(e) => setForwardGitHubCredentials(e.target.checked)}
                disabled={!syncSettings}
                className="w-3.5 h-3.5 mt-0.5 accent-[#F0B429] disabled:opacity-40"
              />
              <label htmlFor="forwardGitHubCredentials" className={`text-[12.5px] flex flex-col gap-0.5 ${syncSettings ? 'text-fg-2 cursor-pointer' : 'text-fg-4 cursor-not-allowed'}`}>
                <span>Forward local GitHub identity &amp; authentication</span>
                <span className="text-[11.5px] text-fg-4 leading-relaxed">
                  Opt in to copy ~/.gitconfig and GitHub CLI auth, then use gh as the remote Git credential helper. Leave off to preserve remote or bot credentials.
                </span>
              </label>
            </div>

            {!isTeleportMode && (
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1 text-fg-4">
                  EXISTING SESSION
                </label>
                {worktreeScript.trim() ? (
                  <div className="p-2 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.35)] bg-amber/10 text-[12px] text-fg-3">
                    Resume selection is disabled while a setup script is configured, because the script can change the final working directory.
                  </div>
                ) : isLoadingResumeCandidates ? (
                  <div className="p-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-[12px] text-fg-3 flex items-center gap-2">
                    <Loader2 size={12} className="animate-spin" />
                    Checking for existing remote sessions...
                  </div>
                ) : resumeCandidates.length > 0 ? (
                  <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    <label className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-fg border-b border-line cursor-pointer hover:bg-claude-surface-hover">
                      <input
                        type="radio"
                        name="ssh-resume-mode"
                        checked={resumeMode === 'new'}
                        onChange={() => {
                          setResumeMode('new');
                          setSelectedResumeSessionId('');
                        }}
                        className="accent-[#4C9AFF]"
                      />
                      Start fresh
                    </label>
                    <div className="px-3 py-2 border-b border-line text-[12px] text-fg-4">
                      Or continue one of the existing remote Claude sessions in this folder:
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      {resumeCandidates.map((candidate) => (
                        <label
                          key={candidate.sessionId}
                          className="flex flex-col gap-1 px-3 py-2 text-[12.5px] text-fg border-b border-line cursor-pointer last:border-b-0 hover:bg-claude-surface-hover"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="ssh-resume-mode"
                              checked={resumeMode === 'existing' && selectedResumeSessionId === candidate.sessionId}
                              onChange={() => {
                                setResumeMode('existing');
                                setSelectedResumeSessionId(candidate.sessionId);
                              }}
                              className="accent-[#4C9AFF]"
                            />
                            <span className="font-mono text-[11.5px]">{candidate.sessionId}</span>
                          </div>
                          <div className="pl-5 text-[11.5px] text-fg-4">
                            Last active: {new Date(candidate.mtime * 1000).toLocaleString()}
                          </div>
                          {candidate.localSessionId && (
                            <div className="pl-5 text-[11.5px] text-accent-text">
                              Will also carry forward local Build session history{candidate.localSessionName ? ` from ${candidate.localSessionName}` : ''}.
                            </div>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : testResult?.success ? (
                  <div className="p-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-[12px] text-fg-3">
                    No existing Claude sessions were found for this remote folder.
                  </div>
                ) : (
                  <div className="p-2 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-[12px] text-fg-3">
                    Test the connection to check for existing sessions in this folder.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Status Section - Always visible */}
      <div className="mt-3 space-y-2">
        {/* Test Button */}
        <button
          onClick={handleTestConnection}
          disabled={!canTest || isTesting}
          className="w-full h-8 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isTesting && <Loader2 size={12} className="animate-spin" />}
          {isTesting ? 'TESTING...' : 'TEST CONNECTION'}
        </button>

        {/* Test Result */}
        {testResult && (
          <div className={`p-2 text-[12px] ${testResult.success ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]' : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'}`}>
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <CheckCircle size={14} className="text-diff-add" />
              ) : (
                <XCircle size={14} className="text-diff-del" />
              )}
              <span className={testResult.success ? 'text-diff-add-text' : 'text-diff-del-text'}>
                {testResult.success
                  ? `Connected. ${formatRemoteHarnesses(testResult.cliCapabilities) || testResult.claudeCodeVersion || ''}`
                  : testResult.error}
              </span>
            </div>
            {testResult.success && testResult.claudeCodeVersion && (
              <div className="mt-1 pl-6 font-mono text-[11.5px] text-diff-add-text/80">
                Claude Code: {testResult.claudeCodeVersion}
              </div>
            )}
            {testResult.success && testResult.setupWarning && (
              <div className="mt-2 flex items-start gap-2 text-amber">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{testResult.setupWarning}</span>
              </div>
            )}
            {testResult.missingCliInstallCommands && testResult.missingCliInstallCommands.length > 0 && (
              <div className="mt-2 space-y-1">
                {testResult.missingCliInstallCommands.map((setup) => (
                  <div key={setup.harness} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-[11.5px] text-fg-4">{setup.label}</span>
                    <code className="flex-1 min-w-0 px-2 py-1 bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-[11px] font-mono text-fg-3 truncate">
                      {setup.command}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleInstallRemoteHarness(setup.harness)}
                      disabled={installingHarness !== null}
                      className="h-6 px-2 text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      title={`Install ${setup.label} on this remote computer`}
                    >
                      {installingHarness === setup.harness && <Loader2 size={10} className="animate-spin" />}
                      {installingHarness === setup.harness ? 'INSTALLING...' : 'INSTALL'}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(setup.command).catch(() => undefined)}
                      className="p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] text-fg-3 hover:text-fg hover:bg-claude-surface-hover"
                      title={`Copy ${setup.label} install command`}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                ))}
                {installError && (
                  <div className="mt-2 text-[11.5px] text-diff-del-text">{installError}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Create Error */}
        {createError && (
          <div className="p-2 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)] text-[12px] text-diff-del-text">
            {createError}
          </div>
        )}

        {/* Requirements Note */}
        {!testResult?.success && (
          <div className="p-2 bg-amber/10 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.3)] text-[12px] text-fg-3 flex items-start gap-2">
            <AlertTriangle size={12} className="text-amber mt-0.5 shrink-0" />
            <span>
              Requires at least one supported remote harness CLI:{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">claude</code>,{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">codex</code>,{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">cursor-agent</code>,{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">gemini</code>, or{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">opencode</code>, or{' '}
              <code className="bg-ink-term px-1 font-mono text-fg-2">prime-agent</code>.
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-line">
          <button
            onClick={onBack}
            className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
          >
            BACK
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || isCreating}
            className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isCreating && <Loader2 size={12} className="animate-spin" />}
            {!isCreating && isTeleportMode && <Upload size={12} />}
            {actionButtonText}
          </button>
        </div>
      </div>

      {/* Remote File Browser Dialog (for setup script) */}
      {showFileBrowser && (
        <RemoteFileBrowser
          sshConfig={{
            host,
            port: parseInt(port) || 22,
            username,
            privateKeyPath,
            passphrase,
            remoteWorkdir: remoteWorkdir || '~',
          }}
          initialPath={remoteWorkdir || '~'}
          onSelect={(path) => {
            setWorktreeScript(path);
            setShowFileBrowser(false);
          }}
          onClose={() => setShowFileBrowser(false)}
          fileFilter={(name) => name.endsWith('.sh')}
        />
      )}

      {/* Remote Directory Browser Dialog (for working directory) */}
      {showDirBrowser && (
        <RemoteFileBrowser
          sshConfig={{
            host,
            port: parseInt(port) || 22,
            username,
            privateKeyPath,
            passphrase,
            remoteWorkdir: remoteWorkdir || '~',
          }}
          initialPath={remoteWorkdir || '~'}
          directoryMode
          onSelect={(path) => {
            setRemoteWorkdir(path);
            setShowDirBrowser(false);
          }}
          onClose={() => setShowDirBrowser(false)}
        />
      )}
    </div>
  );
}
