import React, { useState, useMemo, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Search, Loader2, GitBranch, Lock, Globe, Folder, Github, Zap, ChevronDown, AlertTriangle, Edit3, Eye, FileText, Terminal as TerminalIcon, Server } from 'lucide-react';
import { useAuthStore } from '../../stores/auth.store';
import { cloneSupplementalMessages, useSessionStore } from '../../stores/session.store';
import SSHConfigForm from './SSHConfigForm';
import type { SSHConfig } from '../../../shared/types';

interface NewSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialPath?: string; // Optional: for creating a new session in an existing folder
  initialName?: string; // Optional: initial session name
}

export default function NewSessionDialog({ isOpen, onClose, initialPath, initialName }: NewSessionDialogProps) {
  const { repos } = useAuthStore();
  const { createSession, setActiveSession, addSession } = useSessionStore();

  const [step, setStep] = useState<'source' | 'repo' | 'folder' | 'config' | 'teleport' | 'ssh-config'>('source');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<typeof repos[0] | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [sessionName, setSessionName] = useState('');
  const [branch, setBranch] = useState('');
  const [createWorktree, setCreateWorktree] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [worktreeSetupType, setWorktreeSetupType] = useState<'none' | 'script' | 'instructions'>('none');
  const [worktreeScriptPath, setWorktreeScriptPath] = useState('');
  const [worktreeInstructions, setWorktreeInstructions] = useState('');
  const [hasExistingSetup, setHasExistingSetup] = useState(false);
  const [existingSetupType, setExistingSetupType] = useState<'script' | 'instructions' | null>(null);
  const [existingSetupContent, setExistingSetupContent] = useState('');
  const [existingSetupPath, setExistingSetupPath] = useState('');
  const [overrideExistingSetup, setOverrideExistingSetup] = useState(false);
  const [showExistingSetup, setShowExistingSetup] = useState(false);
  const [teleportSessionId, setTeleportSessionId] = useState('');
  const [teleportDirectory, setTeleportDirectory] = useState('');
  const [claudeCliInstalled, setClaudeCliInstalled] = useState<boolean | null>(null);
  const [claudeCliVersion, setClaudeCliVersion] = useState<string | null>(null);
  const [availableBranches, setAvailableBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [manualRepoUrl, setManualRepoUrl] = useState('');

  // Check if Claude CLI is installed when dialog opens
  useEffect(() => {
    const checkCli = async () => {
      try {
        const result = await window.electronAPI.dev.checkClaudeCli();
        setClaudeCliInstalled(result.installed);
        setClaudeCliVersion(result.version);
        console.log('[NewSessionDialog] Claude CLI check:', result);
      } catch (error) {
        console.error('[NewSessionDialog] Failed to check Claude CLI:', error);
        setClaudeCliInstalled(false);
        setClaudeCliVersion(null);
      }
    };
    if (isOpen) {
      checkCli();
    }
  }, [isOpen]);

  // Initialize with initialPath if provided
  useEffect(() => {
    if (initialPath && isOpen) {
      setSelectedFolder(initialPath);
      setSessionName(initialName || initialPath.split('/').pop() || 'New Session');
      setStep('config');

      // Check if it's a git repo and get branches
      window.electronAPI.dev.checkGitRepo(initialPath).then(result => {
        setIsGitRepo(result.isGit);
        if (result.branch) {
          setBranch(result.branch);
        }
        // Fetch branches if it's a git repo
        if (result.isGit) {
          window.electronAPI.dev.getBranches(initialPath).then(branchResult => {
            if (branchResult.success) {
              setAvailableBranches(branchResult.branches);
            }
          });
        }
      });

      // Check for existing worktree setup and load content
      window.electronAPI.dev.checkWorktreeSetup(initialPath).then(async (result) => {
        if (result.success && (result.hasScript || result.hasInstructions)) {
          setHasExistingSetup(true);
          // Load the content of the existing setup
          if (result.hasScript && result.scriptPath) {
            setExistingSetupType('script');
            setExistingSetupPath(result.scriptPath);
            const fileResult = await window.electronAPI.fs.readFile(result.scriptPath);
            if (fileResult.success && fileResult.content) {
              setExistingSetupContent(fileResult.content);
            }
          } else if (result.hasInstructions && result.instructionsPath) {
            setExistingSetupType('instructions');
            setExistingSetupPath(result.instructionsPath);
            const fileResult = await window.electronAPI.fs.readFile(result.instructionsPath);
            if (fileResult.success && fileResult.content) {
              setExistingSetupContent(fileResult.content);
            }
          }
        }
      });
    }
  }, [initialPath, initialName, isOpen]);

  const filteredRepos = useMemo(() => {
    if (!searchQuery) return repos;
    const query = searchQuery.toLowerCase();
    return repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(query) ||
        repo.fullName.toLowerCase().includes(query)
    );
  }, [repos, searchQuery]);

  // Filter branches by search query
  const filteredBranches = useMemo(() => {
    if (!branchFilter) return availableBranches;
    const query = branchFilter.toLowerCase();
    return availableBranches.filter(
      (b) => b.name.toLowerCase().includes(query)
    );
  }, [availableBranches, branchFilter]);

  const handleSelectSource = (source: 'github' | 'local' | 'teleport' | 'ssh') => {
    if (source === 'github') {
      setStep('repo');
    } else if (source === 'teleport') {
      setStep('teleport');
    } else if (source === 'ssh') {
      setStep('ssh-config');
    } else {
      // Open folder dialog
      handleSelectFolder();
    }
  };

  const handleSelectFolder = async () => {
    const result = await window.electronAPI.dev.openLocalRepo();
    if (result.success && result.repoPath) {
      setSelectedFolder(result.repoPath);
      setSessionName(result.name || result.repoPath.split('/').pop() || 'Folder');
      setBranch(result.branch || 'main');
      setIsGitRepo(result.isGit || false);
      setStep('config');

      // Fetch branches if it's a git repo
      if (result.isGit) {
        const branchResult = await window.electronAPI.dev.getBranches(result.repoPath);
        if (branchResult.success) {
          setAvailableBranches(branchResult.branches);
        }
      } else {
        setAvailableBranches([]);
      }

      // Check for existing worktree setup and load content
      const setupResult = await window.electronAPI.dev.checkWorktreeSetup(result.repoPath);
      if (setupResult.success && (setupResult.hasScript || setupResult.hasInstructions)) {
        setHasExistingSetup(true);
        // Load the content of the existing setup
        if (setupResult.hasScript && setupResult.scriptPath) {
          setExistingSetupType('script');
          setExistingSetupPath(setupResult.scriptPath);
          const fileResult = await window.electronAPI.fs.readFile(setupResult.scriptPath);
          if (fileResult.success && fileResult.content) {
            setExistingSetupContent(fileResult.content);
          }
        } else if (setupResult.hasInstructions && setupResult.instructionsPath) {
          setExistingSetupType('instructions');
          setExistingSetupPath(setupResult.instructionsPath);
          const fileResult = await window.electronAPI.fs.readFile(setupResult.instructionsPath);
          if (fileResult.success && fileResult.content) {
            setExistingSetupContent(fileResult.content);
          }
        }
      } else {
        // Reset existing setup state
        setHasExistingSetup(false);
        setExistingSetupType(null);
        setExistingSetupContent('');
        setExistingSetupPath('');
      }
    } else if (result.canceled) {
      // User canceled - go back to source selection
      setStep('source');
    }
  };

  const handleSelectRepo = (repo: typeof repos[0]) => {
    setSelectedRepo(repo);
    setSessionName(repo.name);
    setBranch(repo.defaultBranch);
    setStep('config');
  };

  // Handle manual repo URL entry
  const handleManualRepoUrl = () => {
    if (!manualRepoUrl.trim()) return;

    // Extract repo name from URL (e.g., https://github.com/owner/repo.git -> repo)
    const url = manualRepoUrl.trim();
    let repoName = 'Repository';
    let fullName = url;

    // Parse GitHub URL patterns
    const githubMatch = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/i);
    if (githubMatch) {
      repoName = githubMatch[2];
      fullName = `${githubMatch[1]}/${githubMatch[2]}`;
    }

    // Create a synthetic repo object
    const syntheticRepo = {
      id: Date.now(),
      name: repoName,
      fullName,
      description: '',
      private: false,
      defaultBranch: 'main',
      cloneUrl: url.endsWith('.git') ? url : `${url}.git`,
      sshUrl: '', // Not needed for HTTPS clone
      updatedAt: new Date().toISOString(),
    };

    setSelectedRepo(syntheticRepo);
    setSessionName(repoName);
    setBranch('main');
    setStep('config');
  };

  const handleSelectScriptFile = async () => {
    const result = await window.electronAPI.dev.openLocalRepo();
    if (result.success && result.repoPath) {
      setWorktreeScriptPath(result.repoPath);
    }
  };

  const handleSelectTeleportDirectory = async () => {
    const result = await window.electronAPI.dev.openLocalRepo();
    if (result.success && result.repoPath) {
      setTeleportDirectory(result.repoPath);
    }
  };

  const [teleportError, setTeleportError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleTeleport = async () => {
    console.log('[Teleport UI] handleTeleport called', { teleportSessionId, teleportDirectory });

    if (!teleportSessionId.trim() || !teleportDirectory) {
      console.log('[Teleport UI] Missing required fields');
      return;
    }

    setIsCreating(true);
    setTeleportError(null);

    try {
      console.log('[Teleport UI] Calling createTeleportSession...');
      // Create a teleported session by spawning Claude CLI with --teleport
      const session = await window.electronAPI.dev.createTeleportSession({
        sessionId: teleportSessionId.trim(),
        name: sessionName || 'Teleported Session',
        cwd: teleportDirectory,
      });

      console.log('[Teleport UI] Got session:', session);

      if (session) {
        addSession(session);
        setActiveSession(session.id);
        handleClose();
      }
    } catch (error) {
      console.error('[Teleport UI] Failed to teleport session:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTeleportError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  const handleSSHConnect = async (sshConfig: SSHConfig, name: string, resumeSessionId?: string) => {
    setIsCreating(true);
    setCreateError(null);

    try {
      const session = await window.electronAPI.ssh.createSession({
        name,
        sshConfig,
        resumeSessionId,
      });

      if (session) {
        if (session.continuedFromSessionId) {
          cloneSupplementalMessages(session.continuedFromSessionId, session.id);
        }
        addSession(session);
        setActiveSession(session.id);
        handleClose();
      }
    } catch (error) {
      console.error('Failed to create SSH session:', error);
      throw error;
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreate = async () => {
    if (!selectedRepo && !selectedFolder) return;

    setIsCreating(true);
    setCreateError(null);
    try {
      let session;
      if (selectedFolder) {
        // Save worktree setup if provided and worktree is being created
        // Either no existing setup, or user chose to override
        if (isGitRepo && createWorktree && (!hasExistingSetup || overrideExistingSetup)) {
          if (worktreeSetupType === 'script' && worktreeScriptPath) {
            await window.electronAPI.dev.saveWorktreeScript({
              repoPath: selectedFolder,
              sourcePath: worktreeScriptPath,
            });
          } else if (worktreeSetupType === 'instructions' && worktreeInstructions.trim()) {
            await window.electronAPI.dev.saveWorktreeInstructions({
              repoPath: selectedFolder,
              instructions: worktreeInstructions,
            });
          }
        }

        // Create session from local folder using dev mode
        session = await window.electronAPI.dev.createSession({
          name: sessionName,
          repoPath: selectedFolder,
          branch,
          createWorktree: isGitRepo && createWorktree,
        });

        // Add the session to the store
        if (session) {
          addSession(session);
        }
      } else if (selectedRepo) {
        // Create session from GitHub repo
        session = await createSession({
          name: sessionName,
          repoUrl: selectedRepo.cloneUrl,
          branch,
        });
      }

      if (session) {
        setActiveSession(session.id);
        handleClose();
      }
    } catch (error) {
      console.error('Failed to create session:', error);
      // Even on error, the session may have been created with error status
      // Reload sessions to show it in the sidebar
      try {
        const sessions = await window.electronAPI.sessions.list();
        // Find the most recent error session that matches our name
        const errorSession = sessions
          .filter(s => s.status === 'error' && s.name === sessionName)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

        if (errorSession) {
          addSession(errorSession);
          setActiveSession(errorSession.id);
          handleClose();
          return;
        }
      } catch (reloadError) {
        console.error('Failed to reload sessions:', reloadError);
      }

      const errorMessage = error instanceof Error ? error.message : 'Failed to create session';
      setCreateError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    setStep(initialPath ? 'config' : 'source');
    setSearchQuery('');
    setSelectedRepo(null);
    setSelectedFolder(initialPath || '');
    setSessionName(initialName || '');
    setBranch('');
    setCreateWorktree(false);
    setIsGitRepo(false);
    setAvailableBranches([]);
    setIsBranchDropdownOpen(false);
    setBranchFilter('');
    setManualRepoUrl('');
    setCreateError(null);
    setTeleportSessionId('');
    setTeleportDirectory('');
    // Reset worktree setup state
    setHasExistingSetup(false);
    setExistingSetupType(null);
    setExistingSetupContent('');
    setExistingSetupPath('');
    setOverrideExistingSetup(false);
    setShowExistingSetup(false);
    setWorktreeSetupType('none');
    setWorktreeScriptPath('');
    setWorktreeInstructions('');
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg font-mono bg-claude-surface border border-claude-border shadow-xl"
          style={{ borderRadius: 0 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-claude-border">
            <Dialog.Title
              className="text-sm font-bold text-claude-text"
              style={{ letterSpacing: '0.1em' }}
            >
              {step === 'source' && 'NEW SESSION'}
              {step === 'repo' && 'SELECT REPOSITORY'}
              {step === 'folder' && 'SELECT FOLDER'}
              {step === 'config' && 'CONFIGURE SESSION'}
              {step === 'teleport' && 'TELEPORT SESSION'}
              {step === 'ssh-config' && 'SSH REMOTE SESSION'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="p-1 hover:bg-claude-bg transition-colors text-claude-text-secondary"
                style={{ borderRadius: 0 }}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="p-4">
            {step === 'source' ? (
              <>
                {/* Source selection */}
                <div className="space-y-3">
                  <p className="text-xs text-claude-text-secondary mb-4" style={{ letterSpacing: '0.05em' }}>
                    Choose how you want to create your session
                  </p>

                  {/* GitHub option */}
                  <button
                    onClick={() => handleSelectSource('github')}
                    className="w-full p-4 text-left hover:bg-claude-bg transition-colors border border-claude-border group"
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg group-hover:bg-claude-surface transition-colors">
                        <Github size={20} className="text-claude-accent" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-bold text-claude-text mb-1">
                          GitHub Repository
                        </h4>
                        <p className="text-xs text-claude-text-secondary">
                          Clone a repository from your GitHub account
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Local folder option */}
                  <button
                    onClick={() => handleSelectSource('local')}
                    className="w-full p-4 text-left hover:bg-claude-bg transition-colors border border-claude-border group"
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg group-hover:bg-claude-surface transition-colors">
                        <Folder size={20} className="text-claude-accent" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-bold text-claude-text mb-1">
                          Local Folder
                        </h4>
                        <p className="text-xs text-claude-text-secondary">
                          Open an existing folder on your computer
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* SSH Remote option */}
                  <button
                    onClick={() => handleSelectSource('ssh')}
                    className="w-full p-4 text-left hover:bg-claude-bg transition-colors border border-claude-border group"
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg group-hover:bg-claude-surface transition-colors">
                        <Server size={20} className="text-blue-400" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-bold text-claude-text mb-1">
                          Remote SSH Server
                        </h4>
                        <p className="text-xs text-claude-text-secondary">
                          Connect to a remote machine via SSH
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Teleport option */}
                  <button
                    onClick={() => handleSelectSource('teleport')}
                    disabled={claudeCliInstalled === false}
                    className={`w-full p-4 text-left transition-colors border border-claude-border group ${
                      claudeCliInstalled === false
                        ? 'opacity-50 cursor-not-allowed bg-claude-bg'
                        : 'hover:bg-claude-bg'
                    }`}
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-claude-bg group-hover:bg-claude-surface transition-colors">
                        <Zap size={20} className={claudeCliInstalled === false ? 'text-claude-text-secondary' : 'text-amber-400'} />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-bold text-claude-text mb-1">
                          Teleport Session
                        </h4>
                        <p className="text-xs text-claude-text-secondary">
                          Import a session from claude.ai/code
                        </p>
                        {claudeCliInstalled === false && (
                          <div className="mt-2 flex items-center gap-1.5 text-amber-400 text-[10px]">
                            <AlertTriangle size={12} />
                            <span>Claude Code CLI required</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Show CLI installation instructions if not installed */}
                  {claudeCliInstalled === false && (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/30">
                      <p className="text-[10px] text-amber-400 leading-relaxed">
                        <AlertTriangle size={12} className="inline mr-1.5" />
                        Teleport requires Claude Code CLI. Install it with:
                      </p>
                      <code className="block mt-2 text-[10px] font-mono text-claude-text bg-claude-bg p-2 select-all">
                        npm install -g @anthropic-ai/claude-code
                      </code>
                    </div>
                  )}
                </div>
              </>
            ) : step === 'ssh-config' ? (
              <SSHConfigForm
                onBack={() => setStep('source')}
                onConnect={handleSSHConnect}
              />
            ) : step === 'teleport' ? (
              <>
                {/* Teleport Session UI */}
                <div className="space-y-4">
                  <p className="text-xs text-claude-text-secondary" style={{ letterSpacing: '0.05em' }}>
                    Enter a session ID from claude.ai/code to import that conversation into G-Build.
                  </p>

                  <div>
                    <label
                      className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      SESSION ID
                    </label>
                    <input
                      type="text"
                      value={teleportSessionId}
                      onChange={(e) => setTeleportSessionId(e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full px-3 py-2 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                      style={{ borderRadius: 0 }}
                      autoFocus
                    />
                    <p className="text-[9px] text-claude-text-secondary mt-1">
                      Find your session ID at claude.ai/code using /session-id
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      PROJECT DIRECTORY
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={teleportDirectory}
                        readOnly
                        placeholder="Select project directory..."
                        className="flex-1 px-3 py-2 text-sm font-mono focus:outline-none bg-claude-bg border border-claude-border text-claude-text cursor-pointer"
                        style={{ borderRadius: 0 }}
                        onClick={handleSelectTeleportDirectory}
                      />
                      <button
                        onClick={handleSelectTeleportDirectory}
                        className="px-4 py-2 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface border border-claude-border text-claude-text"
                        style={{ borderRadius: 0 }}
                      >
                        BROWSE
                      </button>
                    </div>
                    <p className="text-[9px] text-claude-text-secondary mt-1">
                      The session will be teleported to this directory
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      SESSION NAME (OPTIONAL)
                    </label>
                    <input
                      type="text"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="Imported Session"
                      className="w-full px-3 py-2 text-sm focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                      style={{ borderRadius: 0 }}
                    />
                  </div>

                  {teleportError && (
                    <div className="p-3 bg-red-500/20 border border-red-500/50">
                      <p className="text-[10px] text-red-400 font-mono whitespace-pre-wrap">
                        {teleportError}
                      </p>
                    </div>
                  )}

                  <div className="p-3 bg-amber-400/10 border border-amber-400/30">
                    <p className="text-[10px] text-claude-text-secondary leading-relaxed">
                      <Zap size={12} className="inline mr-1 text-amber-400" />
                      Teleported sessions will resume with full conversation history from claude.ai/code
                    </p>
                  </div>

                  {claudeCliVersion && (
                    <div className="text-[9px] text-claude-text-secondary">
                      Claude CLI: {claudeCliVersion}
                    </div>
                  )}
                </div>
              </>
            ) : step === 'repo' ? (
              <>
                {/* Manual URL input */}
                <div className="mb-4 p-3 bg-claude-bg border border-claude-border">
                  <label
                    className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    ENTER REPO URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualRepoUrl}
                      onChange={(e) => setManualRepoUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleManualRepoUrl()}
                      placeholder="https://github.com/owner/repo"
                      className="flex-1 px-3 py-2 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-surface border border-claude-border text-claude-text"
                      style={{ borderRadius: 0 }}
                      autoFocus
                    />
                    <button
                      onClick={handleManualRepoUrl}
                      disabled={!manualRepoUrl.trim()}
                      className="px-4 py-2 text-[10px] font-bold bg-claude-accent hover:bg-claude-accent-hover text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ borderRadius: 0 }}
                    >
                      USE
                    </button>
                  </div>
                </div>

                {/* Divider */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-px bg-claude-border" />
                  <span className="text-[10px] text-claude-text-secondary">OR SELECT FROM LIST</span>
                  <div className="flex-1 h-px bg-claude-border" />
                </div>

                {/* Search - brutalist */}
                <div className="relative mb-3">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-text-secondary"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search repositories..."
                    className="w-full pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                    style={{ borderRadius: 0 }}
                  />
                </div>

                {/* Repo list - brutalist */}
                <div className="max-h-[250px] overflow-y-auto space-y-0.5">
                  {filteredRepos.map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => handleSelectRepo(repo)}
                      className="w-full p-2.5 text-left hover:bg-claude-bg transition-colors group"
                      style={{ borderRadius: 0 }}
                    >
                      <div className="flex items-start gap-2">
                        {repo.private ? (
                          <Lock size={14} className="mt-0.5 text-claude-text-secondary" />
                        ) : (
                          <Globe size={14} className="mt-0.5 text-claude-text-secondary" />
                        )}
                        <div className="flex-1 min-w-0">
                          <h4 className="text-xs font-bold truncate text-claude-text">
                            {repo.fullName}
                          </h4>
                          {repo.description && (
                            <p className="text-[10px] truncate mt-0.5 text-claude-text-secondary">
                              {repo.description}
                            </p>
                          )}
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-claude-text-secondary">
                            <GitBranch size={10} />
                            <span>{repo.defaultBranch}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}

                  {filteredRepos.length === 0 && (
                    <div
                      className="py-6 text-center text-xs text-claude-text-secondary"
                      style={{ letterSpacing: '0.05em' }}
                    >
                      NO REPOSITORIES FOUND
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Config form - brutalist */}
                <div className="space-y-4">
                  <div>
                    <label
                      className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      SESSION NAME
                    </label>
                    <input
                      type="text"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="My Development Session"
                      className="w-full px-3 py-2 text-sm focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                      style={{ borderRadius: 0 }}
                    />
                  </div>

                  <div>
                    <label
                      className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      BRANCH
                    </label>
                    {/* Branch dropdown for git repos with branches, text input otherwise */}
                    {isGitRepo && availableBranches.length > 0 ? (
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => {
                            const newState = !isBranchDropdownOpen;
                            setIsBranchDropdownOpen(newState);
                            if (!newState) setBranchFilter('');
                          }}
                          className="w-full px-3 py-2 text-sm font-mono text-left flex items-center justify-between focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                          style={{ borderRadius: 0 }}
                        >
                          <span className="flex items-center gap-2">
                            <GitBranch size={14} className="text-claude-text-secondary" />
                            {branch || 'Select branch'}
                          </span>
                          <ChevronDown size={14} className={`text-claude-text-secondary transition-transform ${isBranchDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {isBranchDropdownOpen && (
                          <div className="absolute z-50 w-full mt-1 bg-claude-surface border border-claude-border shadow-lg">
                            {/* Branch search input */}
                            <div className="p-2 border-b border-claude-border">
                              <div className="relative">
                                <Search
                                  size={12}
                                  className="absolute left-2 top-1/2 -translate-y-1/2 text-claude-text-secondary"
                                />
                                <input
                                  type="text"
                                  value={branchFilter}
                                  onChange={(e) => setBranchFilter(e.target.value)}
                                  placeholder="Search branches..."
                                  className="w-full pl-7 pr-2 py-1.5 text-xs font-mono focus:outline-none bg-claude-bg border border-claude-border text-claude-text"
                                  style={{ borderRadius: 0 }}
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            </div>
                            {/* Branch list */}
                            <div className="max-h-40 overflow-y-auto">
                              {filteredBranches.length > 0 ? (
                                filteredBranches.map((b) => (
                                  <button
                                    key={b.name}
                                    type="button"
                                    onClick={() => {
                                      setBranch(b.name);
                                      setIsBranchDropdownOpen(false);
                                      setBranchFilter('');
                                    }}
                                    className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 hover:bg-claude-bg transition-colors ${
                                      branch === b.name ? 'bg-claude-accent/20 text-claude-accent' : 'text-claude-text'
                                    }`}
                                  >
                                    <GitBranch size={12} className={b.current ? 'text-green-400' : 'text-claude-text-secondary'} />
                                    <span className="truncate">{b.name}</span>
                                    {b.current && (
                                      <span className="ml-auto text-[9px] text-green-400 font-bold">CURRENT</span>
                                    )}
                                  </button>
                                ))
                              ) : (
                                <div className="px-3 py-4 text-center text-xs text-claude-text-secondary">
                                  No branches match "{branchFilter}"
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder="main"
                        className="w-full px-3 py-2 text-sm font-mono focus:outline-none focus:border-claude-accent bg-claude-bg border border-claude-border text-claude-text"
                        style={{ borderRadius: 0 }}
                      />
                    )}
                  </div>

                  <div
                    className="p-3 bg-claude-bg border border-claude-border"
                    style={{ borderRadius: 0 }}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      {selectedRepo ? (
                        <>
                          <Globe size={14} className="text-claude-text-secondary" />
                          <span className="font-bold text-claude-text">
                            {selectedRepo.fullName}
                          </span>
                        </>
                      ) : (
                        <>
                          <Folder size={14} className="text-claude-text-secondary" />
                          <span className="font-bold text-claude-text truncate">
                            {selectedFolder}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Worktree option for git repos */}
                  {isGitRepo && selectedFolder && (
                    <div className="p-3 bg-claude-bg/50 border border-claude-border">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createWorktree}
                          onChange={(e) => setCreateWorktree(e.target.checked)}
                          className="mt-0.5 w-4 h-4 accent-claude-accent"
                        />
                        <div>
                          <div className="text-xs font-bold text-claude-text mb-1">
                            Create Git Worktree
                          </div>
                          <p className="text-[10px] text-claude-text-secondary leading-relaxed">
                            Creates a new worktree for isolated work. Recommended for parallel development without affecting your main working directory.
                          </p>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Worktree setup configuration */}
                  {isGitRepo && selectedFolder && createWorktree && !hasExistingSetup && (
                    <div className="p-3 bg-claude-bg border border-claude-border space-y-3">
                      <div>
                        <label className="block text-[10px] font-bold mb-2 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                          WORKTREE SETUP (OPTIONAL)
                        </label>
                        <p className="text-[10px] text-claude-text-secondary mb-3 leading-relaxed">
                          Configure automated setup for this worktree. Saved to .claudette/ and runs on each new worktree.
                        </p>
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'none'}
                              onChange={() => setWorktreeSetupType('none')}
                              className="w-3 h-3 accent-claude-accent"
                            />
                            <span className="text-xs text-claude-text">No Setup</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'script'}
                              onChange={() => setWorktreeSetupType('script')}
                              className="w-3 h-3 accent-claude-accent"
                            />
                            <span className="text-xs text-claude-text">Shell Script</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'instructions'}
                              onChange={() => setWorktreeSetupType('instructions')}
                              className="w-3 h-3 accent-claude-accent"
                            />
                            <span className="text-xs text-claude-text">Instructions for Claude</span>
                          </label>
                        </div>
                      </div>

                      {worktreeSetupType === 'script' && (
                        <div>
                          <label className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                            SCRIPT PATH
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={worktreeScriptPath}
                              onChange={(e) => setWorktreeScriptPath(e.target.value)}
                              placeholder="/path/to/setup.sh"
                              className="flex-1 px-2 py-1.5 text-[10px] font-mono focus:outline-none focus:border-claude-accent bg-claude-surface border border-claude-border text-claude-text"
                              style={{ borderRadius: 0 }}
                            />
                            <button
                              onClick={handleSelectScriptFile}
                              className="px-3 py-1.5 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface border border-claude-border text-claude-text"
                              style={{ borderRadius: 0 }}
                            >
                              BROWSE
                            </button>
                          </div>
                          <p className="text-[9px] text-claude-text-secondary mt-1">
                            Will be copied to .claudette/worktree-setup.sh
                          </p>
                        </div>
                      )}

                      {worktreeSetupType === 'instructions' && (
                        <div>
                          <label className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                            SETUP INSTRUCTIONS
                          </label>
                          <textarea
                            value={worktreeInstructions}
                            onChange={(e) => setWorktreeInstructions(e.target.value)}
                            placeholder="Enter setup instructions for Claude to follow..."
                            rows={4}
                            className="w-full px-2 py-1.5 text-[10px] font-mono focus:outline-none focus:border-claude-accent bg-claude-surface border border-claude-border text-claude-text resize-none"
                            style={{ borderRadius: 0 }}
                          />
                          <p className="text-[9px] text-claude-text-secondary mt-1">
                            Will be saved to .claudette/worktree-setup.md
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Show existing setup with options to view/edit/override */}
                  {isGitRepo && selectedFolder && createWorktree && hasExistingSetup && (
                    <div className="p-3 bg-claude-bg border border-claude-border space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          {existingSetupType === 'script' ? (
                            <TerminalIcon size={14} className="text-claude-accent" />
                          ) : (
                            <FileText size={14} className="text-purple-400" />
                          )}
                          <div>
                            <span className="text-xs font-bold text-claude-text">
                              Existing Worktree Setup
                            </span>
                            <p className="text-[10px] text-claude-text-secondary">
                              {existingSetupType === 'script' ? 'worktree-setup.sh' : 'worktree-setup.md'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setShowExistingSetup(!showExistingSetup)}
                            className="p-1.5 hover:bg-claude-surface text-claude-text-secondary hover:text-claude-text transition-colors"
                            title={showExistingSetup ? 'Hide content' : 'View content'}
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => window.electronAPI.app.openPath(existingSetupPath)}
                            className="p-1.5 hover:bg-claude-surface text-claude-text-secondary hover:text-claude-accent transition-colors"
                            title="Edit in external editor"
                          >
                            <Edit3 size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Show existing setup content */}
                      {showExistingSetup && existingSetupContent && (
                        <div className="bg-claude-surface border border-claude-border">
                          <pre className="p-2 text-[10px] font-mono text-claude-text-secondary max-h-32 overflow-y-auto whitespace-pre-wrap">
                            {existingSetupContent}
                          </pre>
                        </div>
                      )}

                      {/* Override checkbox */}
                      <label className="flex items-start gap-2 cursor-pointer pt-2 border-t border-claude-border">
                        <input
                          type="checkbox"
                          checked={overrideExistingSetup}
                          onChange={(e) => {
                            setOverrideExistingSetup(e.target.checked);
                            if (e.target.checked) {
                              // Pre-populate with existing content if it's instructions
                              if (existingSetupType === 'instructions') {
                                setWorktreeSetupType('instructions');
                                setWorktreeInstructions(existingSetupContent);
                              } else {
                                setWorktreeSetupType('script');
                              }
                            } else {
                              setWorktreeSetupType('none');
                              setWorktreeInstructions('');
                              setWorktreeScriptPath('');
                            }
                          }}
                          className="mt-0.5 w-3 h-3 accent-claude-accent"
                        />
                        <div>
                          <span className="text-xs text-claude-text">Override existing setup</span>
                          <p className="text-[9px] text-claude-text-secondary">
                            Replace the current worktree setup with a new configuration
                          </p>
                        </div>
                      </label>

                      {/* Override configuration UI */}
                      {overrideExistingSetup && (
                        <div className="pt-3 border-t border-claude-border space-y-3">
                          <div className="space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'none'}
                                onChange={() => setWorktreeSetupType('none')}
                                className="w-3 h-3 accent-claude-accent"
                              />
                              <span className="text-xs text-claude-text">No Setup (remove existing)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'script'}
                                onChange={() => setWorktreeSetupType('script')}
                                className="w-3 h-3 accent-claude-accent"
                              />
                              <span className="text-xs text-claude-text">Shell Script</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'instructions'}
                                onChange={() => setWorktreeSetupType('instructions')}
                                className="w-3 h-3 accent-claude-accent"
                              />
                              <span className="text-xs text-claude-text">Instructions for Claude</span>
                            </label>
                          </div>

                          {worktreeSetupType === 'script' && (
                            <div>
                              <label className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                                SCRIPT PATH
                              </label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={worktreeScriptPath}
                                  onChange={(e) => setWorktreeScriptPath(e.target.value)}
                                  placeholder="/path/to/setup.sh"
                                  className="flex-1 px-2 py-1.5 text-[10px] font-mono focus:outline-none focus:border-claude-accent bg-claude-surface border border-claude-border text-claude-text"
                                  style={{ borderRadius: 0 }}
                                />
                                <button
                                  onClick={handleSelectScriptFile}
                                  className="px-3 py-1.5 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface border border-claude-border text-claude-text"
                                  style={{ borderRadius: 0 }}
                                >
                                  BROWSE
                                </button>
                              </div>
                            </div>
                          )}

                          {worktreeSetupType === 'instructions' && (
                            <div>
                              <label className="block text-[10px] font-bold mb-1.5 text-claude-text-secondary" style={{ letterSpacing: '0.1em' }}>
                                SETUP INSTRUCTIONS
                              </label>
                              <textarea
                                value={worktreeInstructions}
                                onChange={(e) => setWorktreeInstructions(e.target.value)}
                                placeholder="Enter setup instructions for Claude to follow..."
                                rows={4}
                                className="w-full px-2 py-1.5 text-[10px] font-mono focus:outline-none focus:border-claude-accent bg-claude-surface border border-claude-border text-claude-text resize-none"
                                style={{ borderRadius: 0 }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Error display */}
                  {createError && (
                    <div className="p-3 bg-red-500/20 border border-red-500/50">
                      <p className="text-[10px] text-red-400 font-mono whitespace-pre-wrap">
                        {createError}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Footer - hide for ssh-config as it has its own footer */}
          {step !== 'ssh-config' && (
          <div className="flex items-center justify-between p-4 border-t border-claude-border">
            {step === 'config' && !initialPath && (
              <button
                onClick={() => setStep(selectedRepo ? 'repo' : 'source')}
                className="px-3 py-1.5 text-[10px] font-bold hover:bg-claude-bg transition-colors text-claude-text-secondary"
                style={{ letterSpacing: '0.05em', borderRadius: 0 }}
              >
                BACK
              </button>
            )}
            {step === 'repo' && (
              <button
                onClick={() => setStep('source')}
                className="px-3 py-1.5 text-[10px] font-bold hover:bg-claude-bg transition-colors text-claude-text-secondary"
                style={{ letterSpacing: '0.05em', borderRadius: 0 }}
              >
                BACK
              </button>
            )}
            {step === 'teleport' && (
              <button
                onClick={() => setStep('source')}
                className="px-3 py-1.5 text-[10px] font-bold hover:bg-claude-bg transition-colors text-claude-text-secondary"
                style={{ letterSpacing: '0.05em', borderRadius: 0 }}
              >
                BACK
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Dialog.Close asChild>
                <button
                  className="px-3 py-1.5 text-[10px] font-bold hover:bg-claude-bg transition-colors text-claude-text-secondary"
                  style={{ letterSpacing: '0.05em', borderRadius: 0 }}
                >
                  CANCEL
                </button>
              </Dialog.Close>
              {step === 'config' && (
                <button
                  onClick={handleCreate}
                  disabled={isCreating || !sessionName || !branch}
                  className="px-4 py-1.5 text-[10px] font-bold text-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed bg-claude-accent hover:bg-claude-accent-hover"
                  style={{ letterSpacing: '0.05em', borderRadius: 0 }}
                >
                  {isCreating && <Loader2 size={12} className="animate-spin" />}
                  {isCreating ? 'CREATING...' : 'CREATE SESSION'}
                </button>
              )}
              {step === 'teleport' && (
                <button
                  onClick={handleTeleport}
                  disabled={isCreating || !teleportSessionId.trim() || !teleportDirectory}
                  className="px-4 py-1.5 text-[10px] font-bold text-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed bg-amber-500 hover:bg-amber-600"
                  style={{ letterSpacing: '0.05em', borderRadius: 0 }}
                >
                  {isCreating && <Loader2 size={12} className="animate-spin" />}
                  {isCreating ? 'TELEPORTING...' : 'TELEPORT SESSION'}
                </button>
              )}
            </div>
          </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
