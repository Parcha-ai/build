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
};

const REMOTE_HARNESS_ORDER: Array<keyof RemoteCliCapabilities> = ['claude', 'codex', 'cursor', 'gemini', 'opencode'];

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

  // Status
  const [isTesting, setIsTesting] = useState(false);
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

  // Load saved config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const saved = await window.electronAPI.ssh.getSavedConfig();
        if (saved) {
          setHost(saved.host || '');
          setPort(saved.port || '22');
          setUsername(saved.username || '');
          setPrivateKeyPath(saved.privateKeyPath || '');
          setRemoteWorkdir(saved.remoteWorkdir || '');
          setSessionName(saved.sessionName || '');
          setWorktreeScript(saved.worktreeScript || '');
          setSyncSettings(saved.syncSettings ?? true);
        }
      } catch (error) {
        console.error('Failed to load saved SSH config:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadConfig();
  }, []);

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
      };

      // Save config via IPC (persisted to electron-store)
      await window.electronAPI.ssh.saveConfig({ host, port, username, privateKeyPath, remoteWorkdir, sessionName, worktreeScript, syncSettings });

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
        <Loader2 size={24} className="animate-spin text-claude-text-secondary" />
        <span className="mt-2 text-[10px] text-claude-text-secondary">Loading saved config...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Teleport Source Info */}
      {isTeleportMode && teleportSource && (
        <div className="mb-3 p-3 bg-cyan-500/10 border border-cyan-500/30" style={{ borderRadius: 0 }}>
          <div className="flex items-center gap-2 mb-1">
            <Upload size={14} className="text-cyan-400" />
            <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">TELEPORTING FROM LOCAL</span>
          </div>
          <div className="font-mono text-sm font-bold text-claude-text">{teleportSource.name}</div>
          <div className="text-[10px] text-claude-text-secondary truncate mt-0.5">{teleportSource.worktreePath}</div>
        </div>
      )}

      {/* Tab Header */}
      <div className="flex border-b border-claude-border mb-3">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-[10px] font-bold transition-colors ${
              activeTab === tab.id
                ? 'text-claude-accent border-b-2 border-claude-accent -mb-[1px]'
                : 'text-claude-text-secondary hover:text-claude-text'
            }`}
            style={{ letterSpacing: '0.1em' }}
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
                <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                  HOST
                </label>
                <div className="relative">
                  <Server size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-text-secondary" />
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="hostname or IP"
                    className="w-full pl-9 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                    style={{ borderRadius: 0 }}
                  />
                </div>
              </div>
              <div className="w-16">
                <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                  PORT
                </label>
                <input
                  type="text"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  className="w-full px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text text-center"
                  style={{ borderRadius: 0 }}
                />
              </div>
            </div>

            {/* Username */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ubuntu"
                className="w-full px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                style={{ borderRadius: 0 }}
              />
            </div>

            {/* Private Key */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                PRIVATE KEY
              </label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-text-secondary" />
                  <input
                    type="text"
                    value={privateKeyPath}
                    readOnly
                    placeholder="~/.ssh/id_ed25519"
                    onClick={handleSelectKeyFile}
                    className="w-full pl-9 pr-3 py-1.5 text-sm font-mono focus:outline-none bg-claude-bg border border-claude-border text-claude-text cursor-pointer truncate"
                    style={{ borderRadius: 0 }}
                  />
                </div>
                <button
                  onClick={handleSelectKeyFile}
                  className="px-3 py-1.5 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface border border-claude-border text-claude-text"
                  style={{ borderRadius: 0 }}
                >
                  ...
                </button>
              </div>
            </div>

            {/* Passphrase */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                KEY PASSPHRASE <span className="font-normal opacity-60">(if encrypted)</span>
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Leave empty if none"
                className="w-full px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                style={{ borderRadius: 0 }}
              />
            </div>
          </>
        )}

        {activeTab === 'setup' && (
          <>
            {/* Remote Working Directory */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                REMOTE WORKING DIRECTORY
              </label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Folder size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-text-secondary" />
                  <input
                    type="text"
                    value={remoteWorkdir}
                    onChange={(e) => setRemoteWorkdir(e.target.value)}
                    placeholder="/home/ubuntu/project"
                    className="w-full pl-9 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                    style={{ borderRadius: 0 }}
                  />
                </div>
                <button
                  onClick={() => {
                    if (isConnectionValid) {
                      setShowDirBrowser(true);
                    }
                  }}
                  disabled={!isConnectionValid}
                  className="px-3 py-1.5 bg-claude-surface border border-claude-border hover:bg-claude-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={isConnectionValid ? "Browse remote directories" : "Fill in connection details first"}
                  style={{ borderRadius: 0 }}
                >
                  <FolderSearch size={14} className="text-claude-text-secondary" />
                </button>
              </div>
              <p className="text-[9px] text-claude-text-secondary mt-1">Where remote harnesses will execute tools</p>
            </div>

            {/* Session Name */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                SESSION NAME <span className="font-normal opacity-60">(optional)</span>
              </label>
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Auto-generated from hostname"
                className="w-full px-3 py-1.5 text-sm focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                style={{ borderRadius: 0 }}
              />
            </div>

            {/* Worktree Setup Script */}
            <div>
              <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                SETUP SCRIPT <span className="font-normal opacity-60">(optional)</span>
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Terminal size={14} className="absolute left-3 top-2.5 text-claude-text-secondary" />
                  <textarea
                    value={worktreeScript}
                    onChange={(e) => setWorktreeScript(e.target.value)}
                    placeholder="./setup-worktree.sh my-branch"
                    rows={2}
                    className="w-full pl-9 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text resize-none"
                    style={{ borderRadius: 0 }}
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
                  className="px-3 py-1.5 bg-claude-surface border border-claude-border hover:bg-claude-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={testResult?.success ? "Browse remote files" : "Test connection first"}
                  style={{ borderRadius: 0 }}
                >
                  <FolderSearch size={14} className="text-claude-text-secondary" />
                </button>
              </div>
              <p className="text-[9px] text-claude-text-secondary mt-1">Runs before the agent starts (e.g., clone repo, create worktree)</p>
            </div>

            {/* Sync Settings */}
            <div className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                id="syncSettings"
                checked={syncSettings}
                onChange={(e) => setSyncSettings(e.target.checked)}
                className="w-3.5 h-3.5 accent-claude-accent"
              />
              <label htmlFor="syncSettings" className="text-[11px] text-claude-text cursor-pointer flex items-center gap-1.5">
                <Settings size={11} className="text-claude-text-secondary" />
                Sync settings to remote (~/.claude/agents, commands, CLAUDE.md)
              </label>
            </div>

            {!isTeleportMode && (
              <div>
                <label className="block text-[10px] font-bold mb-1 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                  EXISTING SESSION
                </label>
                {worktreeScript.trim() ? (
                  <div className="p-2 border border-amber-400/30 bg-amber-400/10 text-[10px] text-claude-text-secondary">
                    Resume selection is disabled while a setup script is configured, because the script can change the final working directory.
                  </div>
                ) : isLoadingResumeCandidates ? (
                  <div className="p-2 border border-claude-border bg-claude-bg text-[10px] text-claude-text-secondary flex items-center gap-2">
                    <Loader2 size={12} className="animate-spin" />
                    Checking for existing remote sessions...
                  </div>
                ) : resumeCandidates.length > 0 ? (
                  <div className="border border-claude-border bg-claude-bg">
                    <label className="flex items-center gap-2 px-3 py-2 text-[11px] text-claude-text border-b border-claude-border cursor-pointer">
                      <input
                        type="radio"
                        name="ssh-resume-mode"
                        checked={resumeMode === 'new'}
                        onChange={() => {
                          setResumeMode('new');
                          setSelectedResumeSessionId('');
                        }}
                        className="accent-claude-accent"
                      />
                      Start fresh
                    </label>
                    <div className="px-3 py-2 border-b border-claude-border text-[10px] text-claude-text-secondary">
                      Or continue one of the existing remote Claude sessions in this folder:
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      {resumeCandidates.map((candidate) => (
                        <label
                          key={candidate.sessionId}
                          className="flex flex-col gap-1 px-3 py-2 text-[11px] text-claude-text border-b border-claude-border/50 cursor-pointer last:border-b-0"
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
                              className="accent-claude-accent"
                            />
                            <span className="font-mono text-[10px]">{candidate.sessionId}</span>
                          </div>
                          <div className="pl-5 text-[9px] text-claude-text-secondary">
                            Last active: {new Date(candidate.mtime * 1000).toLocaleString()}
                          </div>
                          {candidate.localSessionId && (
                            <div className="pl-5 text-[9px] text-cyan-400">
                              Will also carry forward local Build session history{candidate.localSessionName ? ` from ${candidate.localSessionName}` : ''}.
                            </div>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : testResult?.success ? (
                  <div className="p-2 border border-claude-border bg-claude-bg text-[10px] text-claude-text-secondary">
                    No existing Claude sessions were found for this remote folder.
                  </div>
                ) : (
                  <div className="p-2 border border-claude-border bg-claude-bg text-[10px] text-claude-text-secondary">
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
          className="w-full py-2 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface border border-claude-border text-claude-text disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ borderRadius: 0, letterSpacing: '0.1em' }}
        >
          {isTesting && <Loader2 size={12} className="animate-spin" />}
          {isTesting ? 'TESTING...' : 'TEST CONNECTION'}
        </button>

        {/* Test Result */}
        {testResult && (
          <div className={`p-2 border text-[10px] ${testResult.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <CheckCircle size={14} className="text-green-400" />
              ) : (
                <XCircle size={14} className="text-red-400" />
              )}
              <span className={testResult.success ? 'text-green-400' : 'text-red-400'}>
                {testResult.success
                  ? `Connected. ${formatRemoteHarnesses(testResult.cliCapabilities) || testResult.claudeCodeVersion || ''}`
                  : testResult.error}
              </span>
            </div>
            {testResult.success && testResult.claudeCodeVersion && (
              <div className="mt-1 pl-6 text-green-300/80">
                Claude Code: {testResult.claudeCodeVersion}
              </div>
            )}
            {testResult.success && testResult.setupWarning && (
              <div className="mt-2 flex items-start gap-2 text-amber-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{testResult.setupWarning}</span>
              </div>
            )}
            {testResult.missingCliInstallCommands && testResult.missingCliInstallCommands.length > 0 && (
              <div className="mt-2 space-y-1">
                {testResult.missingCliInstallCommands.map((setup) => (
                  <div key={setup.harness} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-[9px] text-claude-text-secondary">{setup.label}</span>
                    <code className="flex-1 min-w-0 px-2 py-1 bg-claude-bg border border-claude-border text-[9px] font-mono text-claude-text-secondary truncate">
                      {setup.command}
                    </code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(setup.command).catch(() => undefined)}
                      className="p-1 border border-claude-border text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface"
                      title={`Copy ${setup.label} install command`}
                      style={{ borderRadius: 0 }}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Create Error */}
        {createError && (
          <div className="p-2 bg-red-500/20 border border-red-500/50 text-[10px] text-red-400">
            {createError}
          </div>
        )}

        {/* Requirements Note */}
        {!testResult?.success && (
          <div className="p-2 bg-amber-400/10 border border-amber-400/30 text-[9px] text-claude-text-secondary flex items-start gap-2">
            <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
            <span>
              Requires at least one supported remote harness CLI:{' '}
              <code className="bg-claude-bg px-1">claude</code>,{' '}
              <code className="bg-claude-bg px-1">codex</code>,{' '}
              <code className="bg-claude-bg px-1">cursor-agent</code>,{' '}
              <code className="bg-claude-bg px-1">gemini</code>, or{' '}
              <code className="bg-claude-bg px-1">opencode</code>.
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-claude-border">
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-[10px] font-bold hover:bg-claude-bg transition-colors text-claude-text-secondary"
            style={{ letterSpacing: '0.05em', borderRadius: 0 }}
          >
            BACK
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || isCreating}
            className={`px-4 py-1.5 text-[10px] font-bold text-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
              isTeleportMode ? 'bg-cyan-500 hover:bg-cyan-600' : 'bg-claude-accent hover:bg-claude-accent-hover'
            }`}
            style={{ letterSpacing: '0.05em', borderRadius: 0 }}
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
