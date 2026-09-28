import React, { useState, useMemo, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Search, Loader2, GitBranch, Lock, Globe, Folder, Github, Zap, ChevronDown, AlertTriangle, Edit3, Eye, FileText, Terminal as TerminalIcon, Server } from 'lucide-react';
import { useAuthStore } from '../../stores/auth.store';
import { cloneSupplementalMessages, useSessionStore } from '../../stores/session.store';
import SSHConfigForm from './SSHConfigForm';
import type { GitHubRepo, SSHConfig } from '../../../shared/types';

interface NewSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialPath?: string; // Optional: for creating a new session in an existing folder
  initialName?: string; // Optional: initial session name
}

type GitHubRepoCandidate = Partial<GitHubRepo> & { id?: number | string };

const GITHUB_REPO_UI_STABILITY_MARKER = 'github-new-session-stable-v1';

function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '').replace(/\/+$/, '');
}

function inferRepoName(value: string): string {
  const trimmed = stripGitSuffix(value.trim());
  if (!trimmed) return 'Repository';
  const lastPathSegment = trimmed.split('/').filter(Boolean).pop();
  const lastSshSegment = (lastPathSegment || trimmed).split(':').filter(Boolean).pop();
  return stripGitSuffix(lastSshSegment || trimmed) || 'Repository';
}

function normalizeGitHubRepo(repo: GitHubRepoCandidate | null | undefined, index = 0): GitHubRepo | null {
  if (!repo || typeof repo !== 'object') return null;

  const fullName = safeString(repo.fullName).trim();
  const name = safeString(repo.name).trim() || inferRepoName(fullName);
  const normalizedFullName = fullName || name;
  const cloneUrl =
    safeString(repo.cloneUrl).trim() ||
    (normalizedFullName.includes('/') ? `https://github.com/${stripGitSuffix(normalizedFullName)}.git` : '');

  if (!normalizedFullName && !cloneUrl) return null;

  const numericId = Number(repo.id);
  return {
    id: Number.isFinite(numericId) ? numericId : -(index + 1),
    name: name || inferRepoName(cloneUrl),
    fullName: normalizedFullName || inferRepoName(cloneUrl),
    description: safeString(repo.description),
    private: Boolean(repo.private),
    cloneUrl,
    sshUrl: safeString(repo.sshUrl),
    defaultBranch: safeString(repo.defaultBranch).trim() || 'main',
    updatedAt: safeString(repo.updatedAt).trim() || new Date(0).toISOString(),
  };
}

function isGitHubRepo(repo: GitHubRepo | null): repo is GitHubRepo {
  return repo !== null;
}

function normalizeManualRepoInput(input: string): GitHubRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  const trimmed = raw.replace(/\/+$/, '');
  let repoName = inferRepoName(trimmed);
  let fullName = trimmed;
  let cloneUrl = trimmed;

  const githubMatch = trimmed.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  const shorthandMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);

  if (githubMatch) {
    repoName = stripGitSuffix(githubMatch[2]);
    fullName = `${githubMatch[1]}/${repoName}`;
    cloneUrl = trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
  } else if (shorthandMatch) {
    repoName = stripGitSuffix(shorthandMatch[2]);
    fullName = `${shorthandMatch[1]}/${repoName}`;
    cloneUrl = `https://github.com/${fullName}.git`;
  }

  return {
    id: Date.now(),
    name: repoName,
    fullName,
    description: '',
    private: false,
    defaultBranch: 'main',
    cloneUrl,
    sshUrl: '',
    updatedAt: new Date().toISOString(),
  };
}

export default function NewSessionDialog({ isOpen, onClose, initialPath, initialName }: NewSessionDialogProps) {
  const { repos, loadRepos } = useAuthStore();
  const { createSession, setActiveSession, addSession } = useSessionStore();

  const [step, setStep] = useState<'source' | 'repo' | 'folder' | 'config' | 'teleport' | 'ssh-config' | 'openclaw-config'>('source');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [sessionName, setSessionName] = useState('');
  const [branch, setBranch] = useState('');
  const [createWorktree, setCreateWorktree] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [progressLog, setProgressLog] = useState<string[]>([]);
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
  const [isRepoListLoading, setIsRepoListLoading] = useState(false);
  const [repoListError, setRepoListError] = useState<string | null>(null);
  const [openclawGatewayUrl, setOpenclawGatewayUrl] = useState('');
  const [openclawGatewayPassword, setOpenclawGatewayPassword] = useState('');
  const [openclawError, setOpenclawError] = useState<string | null>(null);

  // Subscribe to setup progress (both SSH and dev) while creating.
  // Live updates like "Connecting...", "Embedding documents...", etc.
  useEffect(() => {
    if (!isCreating) return;

    const handleProgress = (data: { sessionId: string; status: string; message?: string; output?: string; error?: string }) => {
      const text = (data.message || data.output || '').trim();
      if (text) {
        setProgressMessage(text);
        setProgressLog((prev) => {
          // Avoid duplicates and keep the log bounded
          if (prev[prev.length - 1] === text) return prev;
          const next = [...prev, text];
          return next.length > 50 ? next.slice(-50) : next;
        });
      }
      if (data.status === 'error' && data.error) {
        setProgressMessage(`Error: ${data.error}`);
      }
    };

    const unsubDev = window.electronAPI.dev.onSetupProgress(handleProgress);
    const unsubSSH = window.electronAPI.ssh.onSetupProgress(handleProgress);

    return () => {
      unsubDev();
      unsubSSH();
    };
  }, [isCreating]);

  // Reset progress when creation starts
  useEffect(() => {
    if (isCreating) {
      setProgressMessage('Starting...');
      setProgressLog([]);
    }
  }, [isCreating]);

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

  const safeRepos = useMemo(() => {
    const repoList = Array.isArray(repos) ? repos : [];
    return repoList.map((repo, index) => normalizeGitHubRepo(repo, index)).filter(isGitHubRepo);
  }, [repos]);

  const loadGitHubRepos = useCallback(async () => {
    setIsRepoListLoading(true);
    setRepoListError(null);
    try {
      await loadRepos();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load GitHub repositories';
      setRepoListError(message);
    } finally {
      setIsRepoListLoading(false);
    }
  }, [loadRepos]);

  useEffect(() => {
    if (isOpen && step === 'repo') {
      void loadGitHubRepos();
    }
  }, [isOpen, step, loadGitHubRepos]);

  const filteredRepos = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return safeRepos;
    return safeRepos.filter((repo) =>
      [repo.name, repo.fullName, repo.description, repo.defaultBranch]
        .some((value) => safeString(value).toLowerCase().includes(query))
    );
  }, [safeRepos, searchQuery]);

  // Filter branches by search query
  const filteredBranches = useMemo(() => {
    if (!branchFilter) return availableBranches;
    const query = branchFilter.toLowerCase();
    return availableBranches.filter(
      (b) => b.name.toLowerCase().includes(query)
    );
  }, [availableBranches, branchFilter]);

  const handleSelectSource = (source: 'github' | 'local' | 'teleport' | 'ssh' | 'openclaw') => {
    if (source === 'github') {
      setRepoListError(null);
      setStep('repo');
    } else if (source === 'teleport') {
      setStep('teleport');
    } else if (source === 'ssh') {
      setStep('ssh-config');
    } else if (source === 'openclaw') {
      setStep('openclaw-config');
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

  const handleSelectRepo = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setSessionName(repo.name || inferRepoName(repo.fullName || repo.cloneUrl));
    setBranch(repo.defaultBranch || 'main');
    setStep('config');
  };

  // Handle manual repo URL entry
  const handleManualRepoUrl = () => {
    const syntheticRepo = normalizeManualRepoInput(manualRepoUrl);
    if (!syntheticRepo) return;

    setSelectedRepo(syntheticRepo);
    setSessionName(syntheticRepo.name);
    setBranch(syntheticRepo.defaultBranch);
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

  const handleOpenClawConnect = async () => {
    if (!openclawGatewayUrl.trim()) return;

    setIsCreating(true);
    setOpenclawError(null);

    try {
      const session = await window.electronAPI.openclaw.createSession({
        name: sessionName || 'OpenClaw',
        openclawConfig: {
          gatewayUrl: openclawGatewayUrl.trim(),
          gatewayPassword: openclawGatewayPassword,
        },
      });

      if (session) {
        addSession(session);
        setActiveSession(session.id);
        handleClose();
      }
    } catch (error) {
      console.error('Failed to create OpenClaw session:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create OpenClaw session';
      setOpenclawError(errorMessage);
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
    setOpenclawGatewayUrl('');
    setOpenclawGatewayPassword('');
    setOpenclawError(null);
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <Dialog.Title
              className="text-[16px] font-semibold tracking-tight text-fg"
            >
              {step === 'source' && 'NEW SESSION'}
              {step === 'repo' && 'SELECT REPOSITORY'}
              {step === 'folder' && 'SELECT FOLDER'}
              {step === 'config' && 'CONFIGURE SESSION'}
              {step === 'teleport' && 'TELEPORT SESSION'}
              {step === 'ssh-config' && 'SSH REMOTE SESSION'}
              {step === 'openclaw-config' && 'OPENCLAW GATEWAY'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="p-1 hover:bg-claude-surface-hover hover:text-fg transition-colors text-fg-3"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="p-4">
            {/* Live setup progress — shown for ANY step while creating (SSH, dev, teleport) */}
            {isCreating && (
              <div className="p-3 mb-4 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                <div className="flex items-center gap-2 mb-2">
                  <Loader2 size={12} className="animate-spin text-accent" />
                  <span className="text-[12.5px] font-medium text-fg-2">
                    {progressMessage || 'Starting...'}
                  </span>
                </div>
                {progressLog.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border-t border-line pt-2 space-y-0.5">
                    {progressLog.slice(-30).map((line, i) => (
                      <div key={i} className="text-[11px] text-fg-4 font-mono whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {step === 'source' ? (
              <>
                {/* Source selection */}
                <div className="space-y-3">
                  <p className="text-[13px] text-fg-3 mb-4">
                    Choose how you want to create your session
                  </p>

                  {/* GitHub option */}
                  <button
                    onClick={() => handleSelectSource('github')}
                    className="w-full p-3 text-left bg-ink-1 hover:bg-claude-surface-hover transition-colors shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] group"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-ink-3 transition-colors">
                        <Github size={20} className="text-fg-2" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[14px] font-semibold text-fg mb-0.5">
                          GitHub Repository
                        </h4>
                        <p className="text-[12.5px] text-fg-3">
                          Clone a repository from your GitHub account
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Local folder option */}
                  <button
                    onClick={() => handleSelectSource('local')}
                    className="w-full p-3 text-left bg-ink-1 hover:bg-claude-surface-hover transition-colors shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] group"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-ink-3 transition-colors">
                        <Folder size={20} className="text-fg-2" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[14px] font-semibold text-fg mb-0.5">
                          Local Folder
                        </h4>
                        <p className="text-[12.5px] text-fg-3">
                          Open an existing folder on your computer
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* SSH Remote option */}
                  <button
                    onClick={() => handleSelectSource('ssh')}
                    className="w-full p-3 text-left bg-ink-1 hover:bg-claude-surface-hover transition-colors shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] group"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-ink-3 transition-colors">
                        <Server size={20} className="text-fg-2" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[14px] font-semibold text-fg mb-0.5">
                          Remote SSH Server
                        </h4>
                        <p className="text-[12.5px] text-fg-3">
                          Connect to a remote machine via SSH
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* OpenClaw Gateway option */}
                  <button
                    onClick={() => handleSelectSource('openclaw')}
                    className="w-full p-3 text-left bg-ink-1 hover:bg-claude-surface-hover transition-colors shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] group"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-ink-3 transition-colors">
                        <Globe size={20} className="text-fg-2" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[14px] font-semibold text-fg mb-0.5">
                          OpenClaw Gateway
                        </h4>
                        <p className="text-[12.5px] text-fg-3">
                          Connect to an OpenClaw AI agent gateway
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Teleport option */}
                  <button
                    onClick={() => handleSelectSource('teleport')}
                    disabled={claudeCliInstalled === false}
                    className={`w-full p-3 text-left transition-colors bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] group ${
                      claudeCliInstalled === false
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-claude-surface-hover'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-ink-3 transition-colors">
                        <Zap size={20} className={claudeCliInstalled === false ? 'text-fg-4' : 'text-fg-2'} />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[14px] font-semibold text-fg mb-0.5">
                          Teleport Session
                        </h4>
                        <p className="text-[12.5px] text-fg-3">
                          Import a session from claude.ai/code
                        </p>
                        {claudeCliInstalled === false && (
                          <div className="mt-2 flex items-center gap-1.5 text-amber text-[12px]">
                            <AlertTriangle size={12} />
                            <span>Claude Code CLI required</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Show CLI installation instructions if not installed */}
                  {claudeCliInstalled === false && (
                    <div className="p-3 bg-amber/10 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.3)]">
                      <p className="text-[12px] text-amber leading-relaxed">
                        <AlertTriangle size={12} className="inline mr-1.5" />
                        Teleport requires Claude Code CLI. Install it with:
                      </p>
                      <code className="block mt-2 text-[11.5px] font-mono text-fg-2 bg-ink-term p-2 select-all">
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
            ) : step === 'openclaw-config' ? (
              <>
                {/* OpenClaw Gateway Config */}
                <div className="space-y-4">
                  <p className="text-[13px] text-fg-3">
                    Connect to an OpenClaw AI agent gateway endpoint.
                  </p>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      SESSION NAME (OPTIONAL)
                    </label>
                    <input
                      type="text"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="OpenClaw"
                      className="w-full px-3 py-2 text-[13px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    />
                  </div>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      GATEWAY URL
                    </label>
                    <input
                      type="text"
                      value={openclawGatewayUrl}
                      onChange={(e) => setOpenclawGatewayUrl(e.target.value)}
                      placeholder="http://myserver:18789"
                      className="w-full px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      autoFocus
                    />
                    <p className="text-[11.5px] text-fg-4 mt-1">
                      The base URL of your OpenClaw gateway (e.g. http://localhost:18789)
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      GATEWAY PASSWORD
                    </label>
                    <input
                      type="password"
                      value={openclawGatewayPassword}
                      onChange={(e) => setOpenclawGatewayPassword(e.target.value)}
                      placeholder="Bearer token for authentication"
                      className="w-full px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    />
                    <p className="text-[11.5px] text-fg-4 mt-1">
                      The gateway password used for Bearer token authentication
                    </p>
                  </div>

                  {openclawError && (
                    <div className="p-3 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)]">
                      <p className="text-[12px] text-diff-del-text font-mono whitespace-pre-wrap">
                        {openclawError}
                      </p>
                    </div>
                  )}

                  <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    <p className="text-[12px] text-fg-3 leading-relaxed">
                      <Globe size={12} className="inline mr-1 text-fg-3" />
                      Messages will be streamed via the OpenAI-compatible /v1/chat/completions endpoint
                    </p>
                  </div>
                </div>
              </>
            ) : step === 'teleport' ? (
              <>
                {/* Teleport Session UI */}
                <div className="space-y-4">
                  <p className="text-[13px] text-fg-3">
                    Enter a session ID from claude.ai/code to import that conversation into Build.
                  </p>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      SESSION ID
                    </label>
                    <input
                      type="text"
                      value={teleportSessionId}
                      onChange={(e) => setTeleportSessionId(e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      autoFocus
                    />
                    <p className="text-[11.5px] text-fg-4 mt-1">
                      Find your session ID at claude.ai/code using /session-id
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      PROJECT DIRECTORY
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={teleportDirectory}
                        readOnly
                        placeholder="Select project directory..."
                        className="flex-1 px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 cursor-pointer"
                        onClick={handleSelectTeleportDirectory}
                      />
                      <button
                        onClick={handleSelectTeleportDirectory}
                        className="px-3 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                      >
                        BROWSE
                      </button>
                    </div>
                    <p className="text-[11.5px] text-fg-4 mt-1">
                      The session will be teleported to this directory
                    </p>
                  </div>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      SESSION NAME (OPTIONAL)
                    </label>
                    <input
                      type="text"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="Imported Session"
                      className="w-full px-3 py-2 text-[13px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    />
                  </div>

                  {teleportError && (
                    <div className="p-3 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)]">
                      <p className="text-[12px] text-diff-del-text font-mono whitespace-pre-wrap">
                        {teleportError}
                      </p>
                    </div>
                  )}

                  <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                    <p className="text-[12px] text-fg-3 leading-relaxed">
                      <Zap size={12} className="inline mr-1 text-amber" />
                      Teleported sessions will resume with full conversation history from claude.ai/code
                    </p>
                  </div>

                  {claudeCliVersion && (
                    <div className="text-[11.5px] font-mono text-fg-4">
                      Claude CLI: {claudeCliVersion}
                    </div>
                  )}
                </div>
              </>
            ) : step === 'repo' ? (
              <>
                {/* Manual URL input */}
                <div
                  className="mb-4 p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                  data-build-fix={GITHUB_REPO_UI_STABILITY_MARKER}
                >
                  <label
                    className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
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
                      className="flex-1 px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      autoFocus
                    />
                    <button
                      onClick={handleManualRepoUrl}
                      disabled={!manualRepoUrl.trim()}
                      className="px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      USE
                    </button>
                  </div>
                </div>

                {/* Divider */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-px bg-line" />
                  <span className="text-[11px] uppercase tracking-[0.04em] text-fg-4">OR SELECT FROM LIST</span>
                  <div className="flex-1 h-px bg-line" />
                </div>

                {/* Search - brutalist */}
                <div className="relative mb-3">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-5"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search repositories..."
                    className="w-full pl-9 pr-4 py-2 text-[13px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>

                {/* Repo list - brutalist */}
                <div className="max-h-[250px] overflow-y-auto space-y-0.5">
                  {repoListError && (
                    <div className="p-3 mb-2 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)]">
                      <p className="text-[12px] text-diff-del-text font-mono break-words">
                        {repoListError}
                      </p>
                      <button
                        type="button"
                        onClick={() => void loadGitHubRepos()}
                        className="mt-2 h-7 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                      >
                        RETRY
                      </button>
                    </div>
                  )}

                  {isRepoListLoading && (
                    <div
                      className="py-6 flex items-center justify-center gap-2 text-[13px] text-fg-4"
                    >
                      <Loader2 size={14} className="animate-spin" />
                      LOADING REPOSITORIES
                    </div>
                  )}

                  {!isRepoListLoading && filteredRepos.map((repo) => (
                    <button
                      key={`${repo.id}:${repo.fullName}`}
                      onClick={() => handleSelectRepo(repo)}
                      className="w-full px-2.5 py-2 text-left hover:bg-claude-surface-hover transition-colors group"
                    >
                      <div className="flex items-start gap-2">
                        {repo.private ? (
                          <Lock size={14} className="mt-0.5 text-fg-4" />
                        ) : (
                          <Globe size={14} className="mt-0.5 text-fg-4" />
                        )}
                        <div className="flex-1 min-w-0">
                          <h4 className="text-[13px] font-medium truncate text-fg">
                            {repo.fullName}
                          </h4>
                          {repo.description && (
                            <p className="text-[11.5px] truncate mt-0.5 text-fg-4">
                              {repo.description}
                            </p>
                          )}
                          <div className="flex items-center gap-1 mt-1 text-[11px] text-fg-5">
                            <GitBranch size={10} />
                            <span className="font-mono">{repo.defaultBranch || 'main'}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}

                  {!isRepoListLoading && filteredRepos.length === 0 && (
                    <div
                      className="py-6 px-4 text-center text-[13px] text-fg-3"
                    >
                      {searchQuery.trim() ? 'NO REPOSITORIES FOUND' : 'NO GITHUB REPOSITORIES LOADED'}
                      <p className="mt-2 text-[12px] text-fg-4">
                        Use the repo URL field above, or refresh after connecting GitHub.
                      </p>
                      <button
                        type="button"
                        onClick={() => void loadGitHubRepos()}
                        className="mt-3 h-7 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                      >
                        REFRESH
                      </button>
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
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
                    >
                      SESSION NAME
                    </label>
                    <input
                      type="text"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="My Development Session"
                      className="w-full px-3 py-2 text-[13px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                    />
                  </div>

                  <div>
                    <label
                      className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4"
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
                          className="w-full px-3 py-2 text-[13px] font-mono text-left flex items-center justify-between bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                        >
                          <span className="flex items-center gap-2">
                            <GitBranch size={14} className="text-fg-4" />
                            {branch || 'Select branch'}
                          </span>
                          <ChevronDown size={14} className={`text-fg-4 transition-transform ${isBranchDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {isBranchDropdownOpen && (
                          <div className="absolute z-50 w-full mt-1 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]">
                            {/* Branch search input */}
                            <div className="p-2 border-b border-line">
                              <div className="relative">
                                <Search
                                  size={12}
                                  className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-5"
                                />
                                <input
                                  type="text"
                                  value={branchFilter}
                                  onChange={(e) => setBranchFilter(e.target.value)}
                                  placeholder="Search branches..."
                                  className="w-full pl-7 pr-2 py-1.5 text-[12px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
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
                                    className={`w-full h-8 px-3 text-left text-[12.5px] font-mono flex items-center gap-2 hover:bg-claude-surface-hover transition-colors ${
                                      branch === b.name ? 'bg-claude-surface-hover text-fg' : 'text-fg-2'
                                    }`}
                                  >
                                    <GitBranch size={12} className={b.current ? 'text-diff-add' : 'text-fg-5'} />
                                    <span className="truncate">{b.name}</span>
                                    {b.current && (
                                      <span className="ml-auto px-1.5 py-px text-[10px] font-mono uppercase text-diff-add-text shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)]">CURRENT</span>
                                    )}
                                  </button>
                                ))
                              ) : (
                                <div className="px-3 py-4 text-center text-[12px] text-fg-4">
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
                        className="w-full px-3 py-2 text-[13px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      />
                    )}
                  </div>

                  <div
                    className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                  >
                    <div className="flex items-center gap-2 text-[13px]">
                      {selectedRepo ? (
                        <>
                          <Globe size={14} className="text-fg-4" />
                          <span className="font-medium text-fg">
                            {selectedRepo.fullName}
                          </span>
                        </>
                      ) : (
                        <>
                          <Folder size={14} className="text-fg-4" />
                          <span className="font-mono text-fg truncate">
                            {selectedFolder}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Worktree option for git repos */}
                  {isGitRepo && selectedFolder && (
                    <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createWorktree}
                          onChange={(e) => setCreateWorktree(e.target.checked)}
                          className="mt-0.5 w-4 h-4 accent-[#4C9AFF]"
                        />
                        <div>
                          <div className="text-[13px] font-medium text-fg mb-1">
                            Create Git Worktree
                          </div>
                          <p className="text-[12px] text-fg-4 leading-relaxed">
                            Creates a new worktree for isolated work. Recommended for parallel development without affecting your main working directory.
                          </p>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Worktree setup configuration */}
                  {isGitRepo && selectedFolder && createWorktree && !hasExistingSetup && (
                    <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] space-y-3">
                      <div>
                        <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-2 text-fg-4">
                          WORKTREE SETUP (OPTIONAL)
                        </label>
                        <p className="text-[12px] text-fg-4 mb-3 leading-relaxed">
                          Configure automated setup for this worktree. Saved to .claudette/ and runs on each new worktree.
                        </p>
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'none'}
                              onChange={() => setWorktreeSetupType('none')}
                              className="w-3 h-3 accent-[#4C9AFF]"
                            />
                            <span className="text-[13px] text-fg-2">No Setup</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'script'}
                              onChange={() => setWorktreeSetupType('script')}
                              className="w-3 h-3 accent-[#4C9AFF]"
                            />
                            <span className="text-[13px] text-fg-2">Shell Script</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="worktree-setup"
                              checked={worktreeSetupType === 'instructions'}
                              onChange={() => setWorktreeSetupType('instructions')}
                              className="w-3 h-3 accent-[#4C9AFF]"
                            />
                            <span className="text-[13px] text-fg-2">Instructions for Claude</span>
                          </label>
                        </div>
                      </div>

                      {worktreeSetupType === 'script' && (
                        <div>
                          <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4">
                            SCRIPT PATH
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={worktreeScriptPath}
                              onChange={(e) => setWorktreeScriptPath(e.target.value)}
                              placeholder="/path/to/setup.sh"
                              className="flex-1 px-2 py-1.5 text-[12px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                            />
                            <button
                              onClick={handleSelectScriptFile}
                              className="px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                            >
                              BROWSE
                            </button>
                          </div>
                          <p className="text-[11.5px] text-fg-4 mt-1">
                            Will be copied to .claudette/worktree-setup.sh
                          </p>
                        </div>
                      )}

                      {worktreeSetupType === 'instructions' && (
                        <div>
                          <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4">
                            SETUP INSTRUCTIONS
                          </label>
                          <textarea
                            value={worktreeInstructions}
                            onChange={(e) => setWorktreeInstructions(e.target.value)}
                            placeholder="Enter setup instructions for Claude to follow..."
                            rows={4}
                            className="w-full px-2 py-1.5 text-[12.5px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                          />
                          <p className="text-[11.5px] text-fg-4 mt-1">
                            Will be saved to .claudette/worktree-setup.md
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Show existing setup with options to view/edit/override */}
                  {isGitRepo && selectedFolder && createWorktree && hasExistingSetup && (
                    <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          {existingSetupType === 'script' ? (
                            <TerminalIcon size={14} className="text-fg-3" />
                          ) : (
                            <FileText size={14} className="text-fg-3" />
                          )}
                          <div>
                            <span className="text-[13px] font-medium text-fg">
                              Existing Worktree Setup
                            </span>
                            <p className="text-[11.5px] font-mono text-fg-4">
                              {existingSetupType === 'script' ? 'worktree-setup.sh' : 'worktree-setup.md'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setShowExistingSetup(!showExistingSetup)}
                            className="p-1.5 hover:bg-claude-surface-hover text-fg-3 hover:text-fg transition-colors"
                            title={showExistingSetup ? 'Hide content' : 'View content'}
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => window.electronAPI.app.openPath(existingSetupPath)}
                            className="p-1.5 hover:bg-claude-surface-hover text-fg-3 hover:text-fg transition-colors"
                            title="Edit in external editor"
                          >
                            <Edit3 size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Show existing setup content */}
                      {showExistingSetup && existingSetupContent && (
                        <div className="bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
                          <pre className="p-2 text-[11px] font-mono text-fg-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                            {existingSetupContent}
                          </pre>
                        </div>
                      )}

                      {/* Override checkbox */}
                      <label className="flex items-start gap-2 cursor-pointer pt-2 border-t border-line">
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
                          className="mt-0.5 w-3 h-3 accent-[#4C9AFF]"
                        />
                        <div>
                          <span className="text-[13px] text-fg-2">Override existing setup</span>
                          <p className="text-[11.5px] text-fg-4">
                            Replace the current worktree setup with a new configuration
                          </p>
                        </div>
                      </label>

                      {/* Override configuration UI */}
                      {overrideExistingSetup && (
                        <div className="pt-3 border-t border-line space-y-3">
                          <div className="space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'none'}
                                onChange={() => setWorktreeSetupType('none')}
                                className="w-3 h-3 accent-[#4C9AFF]"
                              />
                              <span className="text-[13px] text-fg-2">No Setup (remove existing)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'script'}
                                onChange={() => setWorktreeSetupType('script')}
                                className="w-3 h-3 accent-[#4C9AFF]"
                              />
                              <span className="text-[13px] text-fg-2">Shell Script</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="worktree-setup-override"
                                checked={worktreeSetupType === 'instructions'}
                                onChange={() => setWorktreeSetupType('instructions')}
                                className="w-3 h-3 accent-[#4C9AFF]"
                              />
                              <span className="text-[13px] text-fg-2">Instructions for Claude</span>
                            </label>
                          </div>

                          {worktreeSetupType === 'script' && (
                            <div>
                              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4">
                                SCRIPT PATH
                              </label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={worktreeScriptPath}
                                  onChange={(e) => setWorktreeScriptPath(e.target.value)}
                                  placeholder="/path/to/setup.sh"
                                  className="flex-1 px-2 py-1.5 text-[12px] font-mono bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                                />
                                <button
                                  onClick={handleSelectScriptFile}
                                  className="px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
                                >
                                  BROWSE
                                </button>
                              </div>
                            </div>
                          )}

                          {worktreeSetupType === 'instructions' && (
                            <div>
                              <label className="block text-[11px] font-medium uppercase tracking-[0.04em] mb-1.5 text-fg-4">
                                SETUP INSTRUCTIONS
                              </label>
                              <textarea
                                value={worktreeInstructions}
                                onChange={(e) => setWorktreeInstructions(e.target.value)}
                                placeholder="Enter setup instructions for Claude to follow..."
                                rows={4}
                                className="w-full px-2 py-1.5 text-[12.5px] bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50 resize-none"
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Error display */}
                  {createError && (
                    <div className="p-3 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)]">
                      <p className="text-[12px] text-diff-del-text font-mono whitespace-pre-wrap">
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
          <div className="flex items-center justify-between px-4 py-3 border-t border-line">
            {step === 'config' && !initialPath && (
              <button
                onClick={() => setStep(selectedRepo ? 'repo' : 'source')}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
              >
                BACK
              </button>
            )}
            {step === 'repo' && (
              <button
                onClick={() => setStep('source')}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
              >
                BACK
              </button>
            )}
            {step === 'openclaw-config' && (
              <button
                onClick={() => setStep('source')}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
              >
                BACK
              </button>
            )}
            {step === 'teleport' && (
              <button
                onClick={() => setStep('source')}
                className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
              >
                BACK
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Dialog.Close asChild>
                <button
                  className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
                >
                  CANCEL
                </button>
              </Dialog.Close>
              {step === 'config' && (
                <button
                  onClick={handleCreate}
                  disabled={isCreating || !sessionName || !branch}
                  className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isCreating && <Loader2 size={12} className="animate-spin" />}
                  {isCreating ? 'CREATING...' : 'CREATE SESSION'}
                </button>
              )}
              {step === 'openclaw-config' && (
                <button
                  onClick={handleOpenClawConnect}
                  disabled={isCreating || !openclawGatewayUrl.trim()}
                  className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isCreating && <Loader2 size={12} className="animate-spin" />}
                  {isCreating ? 'CONNECTING...' : 'CONNECT'}
                </button>
              )}
              {step === 'teleport' && (
                <button
                  onClick={handleTeleport}
                  disabled={isCreating || !teleportSessionId.trim() || !teleportDirectory}
                  className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
