import { IpcMain, BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import simpleGit from 'simple-git';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { sshService } from '../services/ssh.service';
import type { SSHConfig, Session, SavedSSHConfig, DownloadSessionConfig, SSHResumeCandidate } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStore: any = new CachedStore({ name: getSessionStoreName() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore: any = new Store({ name: 'claudette-settings' });

/**
 * Get the last N path segments from a path (truncate from left)
 * e.g., "/home/ubuntu/dev/parcha/grep3" with 2 segments -> "parcha/grep3"
 */
function getPathTail(path: string, segments: number = 2): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= segments) {
    return parts.join('/');
  }
  return parts.slice(-segments).join('/');
}

/**
 * Send setup progress to all renderer windows
 */
function sendSetupProgress(sessionId: string, status: 'running' | 'completed' | 'error', message?: string, output?: string, error?: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC_CHANNELS.SSH_SETUP_PROGRESS, { sessionId, status, message, output, error });
  }
}

/**
 * Send download progress to all renderer windows
 */
function sendDownloadProgress(message: string): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send(IPC_CHANNELS.SSH_DOWNLOAD_PROGRESS, message);
  });
}

/**
 * Generate a stable hash for a path to use as directory name
 */
function getPathHash(repoPath: string): string {
  return crypto.createHash('md5').update(repoPath).digest('hex').substring(0, 8);
}

function findMatchingLocalSession(config: SSHConfig, remoteSdkSessionId: string): { sessionId: string; name?: string } | undefined {
  const storedSessions = (sessionStore.get('sessions') as Record<string, Session | undefined> | undefined) || {};
  const sdkMappings = (sessionStore.get('sdkSessionMappings') as Record<string, string | undefined> | undefined) || {};

  for (const [localSessionId, candidate] of Object.entries(storedSessions)) {
    if (!candidate?.sshConfig) {
      continue;
    }
    if (sdkMappings[localSessionId] !== remoteSdkSessionId) {
      continue;
    }
    if (candidate.sshConfig.host !== config.host || candidate.sshConfig.username !== config.username) {
      continue;
    }

    const candidateWorkdir = candidate.sshConfig.remoteWorkdir || candidate.worktreePath || candidate.repoPath;
    if (candidateWorkdir !== config.remoteWorkdir) {
      continue;
    }

    return {
      sessionId: localSessionId,
      name: candidate.name,
    };
  }

  return undefined;
}

/**
 * Resolve a path to its main git repository.
 * If the path is inside a worktree, returns the main repo path.
 */
async function getMainRepoPath(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const gitDir = await git.raw(['rev-parse', '--git-dir']);
    const trimmedGitDir = gitDir.trim();

    if (trimmedGitDir.includes('.git/worktrees/') || trimmedGitDir.includes('/.git/worktrees/')) {
      const commonGitDir = await git.raw(['rev-parse', '--git-common-dir']);
      const mainRepoPath = path.dirname(commonGitDir.trim());
      console.log(`[Download] Resolved worktree at ${repoPath} to main repo at ${mainRepoPath}`);
      return mainRepoPath;
    }
  } catch {
    console.log(`[Download] Path ${repoPath} is not a worktree, using as main repo`);
  }
  return repoPath;
}

export function registerSSHHandlers(ipcMain: IpcMain): void {
  /**
   * Test an SSH connection and verify Claude Code is installed
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_TEST_CONNECTION,
    async (_event, config: SSHConfig) => {
      console.log('[SSH IPC] Testing connection to', config.host);

      try {
        const result = await sshService.testConnection(config);
        console.log('[SSH IPC] Connection test result:', result);
        return result;
      } catch (error) {
        console.error('[SSH IPC] Connection test error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Create a new SSH session
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_CREATE_SESSION,
    async (
      _event,
      data: {
        name: string;
        sshConfig: SSHConfig;
        resumeSessionId?: string;
        parentSessionId?: string;
      }
    ) => {
      console.log('[SSH IPC] Creating SSH session:', data.name);

      try {
        const sessionId = uuid();

        // Create session object
        // Use host:parent/folder format for name if no custom name provided
        const folderPath = getPathTail(data.sshConfig.remoteWorkdir, 2);
        const defaultName = `${data.sshConfig.host}:${folderPath}`;
        const session: Session = {
          id: sessionId,
          name: data.name || defaultName,
          repoPath: data.sshConfig.remoteWorkdir, // Remote path
          worktreePath: data.sshConfig.remoteWorkdir,
          branch: 'main', // We could detect this via SSH if needed
          sshConfig: data.sshConfig,
          status: 'creating',
          ports: { web: 0, api: 0, debug: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
          setupScript: '',
          isDevMode: true, // Mark as dev mode (no Docker)
          ...(data.resumeSessionId ? { sdkSessionId: data.resumeSessionId } : {}),
          ...(data.parentSessionId ? { parentSessionId: data.parentSessionId } : {}),
        };

        const localResumeSource = data.resumeSessionId
          ? findMatchingLocalSession(data.sshConfig, data.resumeSessionId)
          : undefined;
        if (localResumeSource) {
          session.continuedFromSessionId = localResumeSource.sessionId;
        }

        // Persist the session in 'creating' state BEFORE kicking off SSH work so
        // the renderer can close its dialog and show streaming setup progress in
        // the chat view straight away (non-blocking session creation).
        sessionStore.set(`sessions.${sessionId}`, session);
        if (data.resumeSessionId) {
          sessionStore.set(`sdkSessionMappings.${sessionId}`, data.resumeSessionId);
        } else {
          // Mark as a brand-new session so getMessages() won't search for old transcripts
          // at the same remote path. The sentinel 'new' is replaced with the real SDK session
          // ID on first message send (claude.service.ts stores it on system_id receipt).
          sessionStore.set(`sdkSessionMappings.${sessionId}`, 'new');
        }

        // Emit an initial progress event so the chat view renders a setup block
        // immediately, before any remote work has started.
        sendSetupProgress(sessionId, 'running', 'Connecting to remote host...');

        // Broadcast session status updates to the renderer so the sidebar/chat
        // stays in sync as setup progresses. Uses the existing status-changed
        // channel already handled by the renderer.
        const broadcastStatus = () => {
          const wins = BrowserWindow.getAllWindows();
          for (const win of wins) {
            if (!win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.SESSION_STATUS_CHANGED, session);
            }
          }
        };

        // Run SSH connect + setup asynchronously so the IPC call returns
        // immediately. Progress and terminal state changes reach the renderer
        // via SSH_SETUP_PROGRESS and SESSION_STATUS_CHANGED events.
        (async () => {
          try {
            await sshService.connect(sessionId, data.sshConfig);
            sendSetupProgress(sessionId, 'running', 'Connected to remote host');

            if (data.sshConfig.worktreeScript || data.sshConfig.syncSettings !== false) {
              console.log('[SSH IPC] Running pre-session setup...');
              const setupResult = await sshService.runPreSessionSetup(
                sessionId,
                data.sshConfig,
                (message) => {
                  console.log('[SSH IPC] Setup progress:', message);
                  sendSetupProgress(sessionId, 'running', undefined, message);
                }
              );

              if (!setupResult.success) {
                console.error('[SSH IPC] Pre-session setup failed:', setupResult.error);
                session.status = 'error';
                session.errorMessage = setupResult.error;
                sendSetupProgress(sessionId, 'error', undefined, undefined, setupResult.error);
              } else {
                if (setupResult.workingDirectory) {
                  console.log('[SSH IPC] Updating session worktreePath to:', setupResult.workingDirectory);
                  session.worktreePath = setupResult.workingDirectory;
                  session.repoPath = setupResult.workingDirectory;
                  if (session.sshConfig) {
                    session.sshConfig.remoteWorkdir = setupResult.workingDirectory;
                  }
                  const folderPath2 = getPathTail(setupResult.workingDirectory, 2);
                  session.name = `${data.sshConfig.host}:${folderPath2}`;
                }
                if (setupResult.setupOutput) {
                  session.setupOutput = setupResult.setupOutput;
                }
                session.status = 'running';
                sendSetupProgress(sessionId, 'completed', 'Setup completed successfully');
              }
            } else {
              session.status = 'running';
              sendSetupProgress(sessionId, 'completed', 'Connected');
            }
          } catch (connError) {
            console.error('[SSH IPC] Failed to establish SSH connection:', connError);
            session.status = 'error';
            session.errorMessage = connError instanceof Error ? connError.message : 'Connection failed';
            sendSetupProgress(sessionId, 'error', undefined, undefined, session.errorMessage);
          } finally {
            session.updatedAt = new Date();
            sessionStore.set(`sessions.${sessionId}`, session);
            broadcastStatus();
            console.log('[SSH IPC] SSH session setup finished:', sessionId, 'status:', session.status);
          }
        })();

        // Return immediately with the pending session so the dialog can close.
        console.log('[SSH IPC] SSH session record created (setup running async):', sessionId);
        return session;
      } catch (error) {
        console.error('[SSH IPC] Failed to create SSH session:', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SSH_LIST_RESUME_CANDIDATES,
    async (_event, config: SSHConfig): Promise<SSHResumeCandidate[]> => {
      const probeSessionId = `ssh-resume-probe-${uuid()}`;

      try {
        const transcripts = await sshService.listRemoteTranscripts(probeSessionId, config, config.remoteWorkdir);
        return transcripts.slice(0, 10).map((transcript) => {
          const localMatch = findMatchingLocalSession(config, transcript.sessionId);
          return {
            sessionId: transcript.sessionId,
            backend: 'claude' as const,
            mtime: transcript.mtime,
            localSessionId: localMatch?.sessionId,
            localSessionName: localMatch?.name,
          };
        });
      } catch (error) {
        console.error('[SSH IPC] Failed to list resume candidates:', error);
        return [];
      } finally {
        sshService.disconnect(probeSessionId);
      }
    }
  );

  /**
   * Manually sync settings to an SSH session
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_SYNC_SETTINGS,
    async (_event, data: { sessionId: string; config: SSHConfig }) => {
      console.log('[SSH IPC] Syncing settings to', data.config.host);
      return sshService.syncSettings(data.sessionId, data.config);
    }
  );

  /**
   * Run a worktree script on a remote machine
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_RUN_WORKTREE_SCRIPT,
    async (
      _event,
      data: { sessionId: string; config: SSHConfig; script: string }
    ) => {
      console.log('[SSH IPC] Running worktree script on', data.config.host);
      return sshService.runWorktreeScript(data.sessionId, data.config, data.script);
    }
  );

  /**
   * Get saved SSH configuration
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_GET_SAVED_CONFIG,
    async () => {
      return settingsStore.get('lastSSHConfig') as SavedSSHConfig | null;
    }
  );

  /**
   * Save SSH configuration
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_SAVE_CONFIG,
    async (_event, config: SavedSSHConfig) => {
      settingsStore.set('lastSSHConfig', config);
    }
  );

  /**
   * Check if SSH connection is available (quick ping)
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_CHECK_CONNECTION,
    async (_event, config: SSHConfig) => {
      console.log('[SSH IPC] Checking connection to', config.host);
      try {
        const result = await sshService.testConnection(config);
        return { connected: result.success, error: result.error };
      } catch (error) {
        return {
          connected: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Teleport a local session to an SSH remote
   * Copies transcript files so Claude can resume with full context
   *
   * Order of operations:
   * 1. Run worktree script FIRST to get final working directory
   * 2. Copy transcripts to the FINAL working directory's project folder
   * 3. Create session pointing to the final directory
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_TELEPORT_SESSION,
    async (
      _event,
      data: {
        sourceSessionId: string;
        destinationConfig: SSHConfig;
      }
    ) => {
      console.log('[SSH IPC] Teleporting session', data.sourceSessionId, 'to', data.destinationConfig.host);

      try {
        // Get source session from store (use individual key pattern)
        const sourceSession = sessionStore.get(`sessions.${data.sourceSessionId}`) as Session | undefined;

        if (!sourceSession) {
          return { success: false, error: 'Source session not found' };
        }

        if (sourceSession.sshConfig) {
          return { success: false, error: 'Cannot teleport an SSH session (already remote)' };
        }

        // Get SDK session ID from either location (new mapping or old session field)
        const sdkSessionId = sessionStore.get(`sdkSessionMappings.${data.sourceSessionId}`) as string | undefined
          || sourceSession.sdkSessionId;

        console.log('[SSH IPC] Source session SDK ID:', sdkSessionId);

        // Send progress updates
        const sendProgress = (message: string) => {
          sendSetupProgress(data.sourceSessionId, 'running', message);
        };

        // Create new SSH session ID
        const newSessionId = uuid();
        let finalWorkdir = data.destinationConfig.remoteWorkdir;
        let setupOutput: string | undefined;

        // STEP 1: Run pre-session setup FIRST to get the final working directory
        // This must happen before copying transcripts so we copy to the right place
        if (data.destinationConfig.worktreeScript || data.destinationConfig.syncSettings !== false) {
          sendProgress('Running pre-session setup...');

          // Connect for setup
          await sshService.connect(newSessionId, data.destinationConfig);

          const setupResult = await sshService.runPreSessionSetup(
            newSessionId,
            data.destinationConfig,
            (message) => {
              console.log('[SSH IPC] Teleport setup progress:', message);
              sendProgress(message);
            }
          );

          if (!setupResult.success) {
            console.error('[SSH IPC] Pre-session setup failed:', setupResult.error);
            sendSetupProgress(data.sourceSessionId, 'error', undefined, undefined, setupResult.error);
            return { success: false, error: setupResult.error };
          }

          // Update working directory if script output one
          if (setupResult.workingDirectory) {
            console.log('[SSH IPC] Final working directory from setup:', setupResult.workingDirectory);
            finalWorkdir = setupResult.workingDirectory;
          }

          setupOutput = setupResult.setupOutput;
        }

        // STEP 2: Now copy transcripts to the FINAL working directory
        // Create a modified config with the final workdir for transcript placement
        const teleportConfig: SSHConfig = {
          ...data.destinationConfig,
          remoteWorkdir: finalWorkdir,
          // Don't sync settings again - we already did it above
          syncSettings: false,
        };

        sendProgress('Copying session transcripts...');
        const result = await sshService.teleportSession(
          sourceSession.worktreePath,
          sdkSessionId,
          teleportConfig,
          sendProgress
        );

        if (!result.success) {
          sendSetupProgress(data.sourceSessionId, 'error', undefined, undefined, result.error);
          return result;
        }

        // STEP 3: Create the session record
        const folderPath = getPathTail(finalWorkdir, 2);

        const newSession: Session = {
          id: newSessionId,
          name: `${data.destinationConfig.host}:${folderPath}`,
          repoPath: finalWorkdir,
          worktreePath: finalWorkdir,
          branch: sourceSession.branch || 'main',
          sshConfig: {
            ...data.destinationConfig,
            remoteWorkdir: finalWorkdir, // Use the final workdir from setup script
          },
          status: 'stopped', // Ready to start
          ports: { web: 0, api: 0, debug: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
          setupScript: '',
          setupOutput,
          isDevMode: true,
          // Preserve SDK session ID so Claude can find the transcript
          sdkSessionId: sdkSessionId,
          // Track teleportation origin
          teleportedFrom: data.sourceSessionId,
        };

        // Save new session (use individual key pattern like SessionService)
        sessionStore.set(`sessions.${newSessionId}`, newSession);

        // Store SDK session mapping so Claude can resume the conversation
        if (sdkSessionId) {
          sessionStore.set(`sdkSessionMappings.${newSessionId}`, sdkSessionId);
          console.log('[SSH IPC] Stored SDK session mapping:', newSessionId, '->', sdkSessionId);
        }

        sendSetupProgress(data.sourceSessionId, 'completed', 'Teleportation complete!');

        console.log('[SSH IPC] Teleported session created:', newSessionId);
        return {
          success: true,
          newSessionId,
        };
      } catch (error) {
        console.error('[SSH IPC] Teleport failed:', error);
        sendSetupProgress(data.sourceSessionId, 'error', undefined, undefined, error instanceof Error ? error.message : 'Unknown error');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Download an SSH session to local (reverse teleport)
   * Copies transcript from remote, creates local worktree, and creates a local session
   *
   * Order of operations:
   * 1. Validate source SSH session exists and has sshConfig
   * 2. Connect to remote & gather git info (remote URL, branch, transcript path)
   * 3. Validate local repo exists and remotes match
   * 4. Create local worktree
   * 5. Download transcript from remote to local
   * 6. Create new local session record
   * 7. Cleanup & return
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_DOWNLOAD_SESSION,
    async (
      _event,
      sessionId: string,
      config: DownloadSessionConfig
    ): Promise<{ success: boolean; newSessionId?: string; error?: string }> => {
      console.log('[SSH IPC] Downloading session', sessionId, 'to local with config:', config);

      try {
        // ========================================================================
        // STEP 1: Validate source session
        // ========================================================================
        const sourceSession = sessionStore.get(`sessions.${sessionId}`) as Session | undefined;

        if (!sourceSession) {
          return { success: false, error: 'Source session not found' };
        }

        if (!sourceSession.sshConfig) {
          return { success: false, error: 'Source session is not an SSH session - nothing to download' };
        }

        const sshConfig = sourceSession.sshConfig;
        const remoteWorkingDir = sourceSession.worktreePath || sshConfig.remoteWorkdir;

        // Get SDK session ID from either location (new mapping or old session field)
        const sdkSessionId = sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
          || sourceSession.sdkSessionId;

        console.log('[SSH IPC] Source session SDK ID:', sdkSessionId);
        sendDownloadProgress('Validating source session...');

        // ========================================================================
        // STEP 2: Connect to remote & gather git info
        // ========================================================================
        const downloadConnId = `download-${Date.now()}`;

        try {
          sendDownloadProgress('Connecting to remote host...');
          await sshService.connect(downloadConnId, sshConfig);
        } catch (connError) {
          return {
            success: false,
            error: `Failed to connect to remote: ${connError instanceof Error ? connError.message : String(connError)}`,
          };
        }

        const connInfo = sshService['connections'].get(downloadConnId);
        if (!connInfo) {
          return { success: false, error: 'Failed to establish SSH connection' };
        }
        const client = connInfo.client;

        let remoteOriginUrl = '';
        let remoteBranch = '';
        let remoteTranscriptPath: string | null = null;

        try {
          sendDownloadProgress('Gathering remote git info...');

          // Get remote origin URL
          try {
            remoteOriginUrl = (await sshService.execCommand(
              client,
              `cd "${remoteWorkingDir}" && git remote get-url origin 2>/dev/null || echo ""`
            )).trim();
          } catch {
            console.log('[SSH IPC] Could not get remote origin URL');
          }

          // Get current branch
          try {
            remoteBranch = (await sshService.execCommand(
              client,
              `cd "${remoteWorkingDir}" && git branch --show-current 2>/dev/null || echo "main"`
            )).trim() || 'main';
          } catch {
            remoteBranch = 'main';
          }

          // Get remote transcript path
          if (sdkSessionId) {
            sendDownloadProgress('Locating remote transcript...');
            remoteTranscriptPath = await sshService.getRemoteTranscriptPath(
              client,
              remoteWorkingDir,
              sdkSessionId
            );
            if (remoteTranscriptPath) {
              console.log('[SSH IPC] Found remote transcript at:', remoteTranscriptPath);
            } else {
              console.log('[SSH IPC] No remote transcript found (session will start fresh)');
            }
          }
        } catch (infoError) {
          console.warn('[SSH IPC] Error gathering remote info (continuing):', infoError);
        }

        // ========================================================================
        // STEP 3: Validate local repo
        // ========================================================================
        sendDownloadProgress('Validating local repository...');

        try {
          await fs.access(config.localRepoPath);
        } catch {
          sshService.disconnect(downloadConnId);
          return { success: false, error: `Local repo path does not exist: ${config.localRepoPath}` };
        }

        const localGit = simpleGit(config.localRepoPath);
        const isGitRepo = await localGit.checkIsRepo();

        if (!isGitRepo) {
          sshService.disconnect(downloadConnId);
          return { success: false, error: `Local path is not a git repository: ${config.localRepoPath}` };
        }

        // Optionally validate that git remotes match
        if (remoteOriginUrl) {
          try {
            const localOriginUrl = (await localGit.remote(['get-url', 'origin'])) as string | void;
            if (localOriginUrl && localOriginUrl.trim()) {
              // Normalise for comparison (strip .git suffix, trailing slashes)
              const normalise = (url: string) => url.trim().replace(/\.git$/, '').replace(/\/$/, '');
              if (normalise(localOriginUrl.toString()) !== normalise(remoteOriginUrl)) {
                console.warn(
                  `[SSH IPC] Git remote mismatch - local: ${localOriginUrl.toString().trim()}, remote: ${remoteOriginUrl}. Proceeding anyway.`
                );
                sendDownloadProgress('Warning: Git remote URLs differ between local and remote. Proceeding anyway.');
              }
            }
          } catch {
            // No remote configured locally - that's fine, continue
            console.log('[SSH IPC] Could not check local git remote (may not have origin)');
          }
        }

        // ========================================================================
        // STEP 4: Create local worktree
        // ========================================================================
        const targetBranch = config.branch || remoteBranch || 'main';
        sendDownloadProgress(`Creating local worktree for branch "${targetBranch}"...`);

        let worktreePath: string;

        try {
          // Resolve to main repo to avoid nested worktree issues
          const mainRepoPath = await getMainRepoPath(config.localRepoPath);
          const mainGit = simpleGit(mainRepoPath);

          const worktreeDirName = `dl-${uuid().substring(0, 8)}`;
          const repoHash = getPathHash(mainRepoPath);
          const centralWorktreesDir = path.join(os.homedir(), '.claudette', 'worktrees', repoHash);
          worktreePath = path.join(centralWorktreesDir, worktreeDirName);

          // Ensure the central directory exists
          await fs.mkdir(centralWorktreesDir, { recursive: true });

          // Check if branch exists locally, if not fetch from remote
          const branches = await mainGit.branch(['-a']);
          const branchExistsLocally = branches.all.includes(targetBranch);
          const branchExistsRemotely = branches.all.includes(`remotes/origin/${targetBranch}`);

          if (!branchExistsLocally && branchExistsRemotely) {
            sendDownloadProgress(`Fetching branch "${targetBranch}" from remote...`);
            try {
              await mainGit.fetch(['origin', targetBranch]);
            } catch (fetchErr) {
              console.warn('[SSH IPC] Fetch failed, will try worktree creation anyway:', fetchErr);
            }
          } else if (!branchExistsLocally && !branchExistsRemotely) {
            // Try a general fetch first
            sendDownloadProgress('Fetching latest branches from remote...');
            try {
              await mainGit.fetch(['--all', '--prune']);
            } catch {
              console.log('[SSH IPC] Fetch --all failed, continuing with local state');
            }
          }

          // Create the worktree
          console.log(`[SSH IPC] Creating worktree at ${worktreePath} from ${mainRepoPath} on branch ${targetBranch}`);
          const branchesAfterFetch = await mainGit.branch(['-a']);
          const localExists = branchesAfterFetch.all.includes(targetBranch);
          const remoteExists = branchesAfterFetch.all.includes(`remotes/origin/${targetBranch}`);

          if (localExists) {
            await mainGit.raw(['worktree', 'add', worktreePath, targetBranch]);
          } else if (remoteExists) {
            // Create tracking branch from remote
            await mainGit.raw(['worktree', 'add', '--track', '-b', targetBranch, worktreePath, `origin/${targetBranch}`]);
          } else {
            // Branch doesn't exist anywhere - create new from current HEAD
            sendDownloadProgress(`Branch "${targetBranch}" not found, creating new branch from HEAD...`);
            await mainGit.raw(['worktree', 'add', '-b', targetBranch, worktreePath]);
          }

          sendDownloadProgress('Worktree created successfully');
        } catch (wtError) {
          sshService.disconnect(downloadConnId);
          return {
            success: false,
            error: `Failed to create worktree: ${wtError instanceof Error ? wtError.message : String(wtError)}`,
          };
        }

        // ========================================================================
        // STEP 5: Download transcript
        // ========================================================================
        let transcriptDownloaded = false;

        if (remoteTranscriptPath && sdkSessionId) {
          sendDownloadProgress('Downloading session transcript...');

          try {
            // Calculate local transcript path using the worktree path
            // Claude stores transcripts in ~/.claude/projects/{escaped-worktree-path}/{sdkSessionId}.jsonl
            const escapedWorktreePath = worktreePath.replace(/\//g, '-').replace(/^-/, '-');
            const localTranscriptDir = path.join(os.homedir(), '.claude', 'projects', escapedWorktreePath);
            const localTranscriptPath = path.join(localTranscriptDir, `${sdkSessionId}.jsonl`);

            // Ensure transcript directory exists
            await fs.mkdir(localTranscriptDir, { recursive: true });

            // Download the transcript file
            // The remote path might start with ~ which we need to resolve
            const resolvedRemotePath = remoteTranscriptPath.startsWith('~')
              ? remoteTranscriptPath // sshService.downloadFile handles ~ via SFTP
              : remoteTranscriptPath;

            // Resolve ~ to actual home directory for SFTP
            let absoluteRemotePath = resolvedRemotePath;
            if (resolvedRemotePath.startsWith('~')) {
              try {
                const homeResult = await sshService.execCommand(client, 'echo $HOME');
                const remoteHome = homeResult.trim();
                absoluteRemotePath = resolvedRemotePath.replace('~', remoteHome);
              } catch {
                console.warn('[SSH IPC] Could not resolve remote home dir, trying path as-is');
              }
            }

            await sshService.downloadFile(client, absoluteRemotePath, localTranscriptPath);
            transcriptDownloaded = true;
            sendDownloadProgress('Transcript downloaded successfully');
            console.log('[SSH IPC] Transcript downloaded to:', localTranscriptPath);
          } catch (dlError) {
            // Non-fatal - session can still be created without transcript
            console.warn('[SSH IPC] Failed to download transcript (non-fatal):', dlError);
            sendDownloadProgress('Warning: Could not download transcript. Session will start fresh.');
          }
        } else {
          sendDownloadProgress('No transcript to download (session will start fresh)');
        }

        // ========================================================================
        // STEP 6: Create new local session
        // ========================================================================
        sendDownloadProgress('Creating local session...');

        const newSessionId = uuid();

        const newSession: Session = {
          id: newSessionId,
          name: config.sessionName,
          repoPath: config.localRepoPath,
          worktreePath: worktreePath,
          branch: targetBranch,
          status: 'stopped',
          ports: { web: 0, api: 0, debug: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
          setupScript: '',
          isDevMode: true,
          isWorktree: true,
          parentRepoPath: config.localRepoPath,
          // Preserve SDK session ID so Claude SDK finds the transcript
          sdkSessionId: sdkSessionId,
          // Track download origin
          downloadedFrom: sessionId,
          // Copy useful metadata from source
          model: sourceSession.model,
        };

        // Save new session (use individual key pattern like SessionService)
        sessionStore.set(`sessions.${newSessionId}`, newSession);

        // Store SDK session mapping so Claude can resume the conversation
        if (sdkSessionId) {
          sessionStore.set(`sdkSessionMappings.${newSessionId}`, sdkSessionId);
          console.log('[SSH IPC] Stored SDK session mapping:', newSessionId, '->', sdkSessionId);
        }

        sendDownloadProgress('Session created!');

        // ========================================================================
        // STEP 7: Cleanup & return
        // ========================================================================
        sshService.disconnect(downloadConnId);

        const transcriptNote = transcriptDownloaded
          ? ' Transcript downloaded successfully.'
          : sdkSessionId
            ? ' Warning: transcript could not be downloaded.'
            : '';

        console.log(`[SSH IPC] Download complete. New session: ${newSessionId}.${transcriptNote}`);

        return {
          success: true,
          newSessionId,
        };
      } catch (error) {
        console.error('[SSH IPC] Download session failed:', error);
        sendDownloadProgress(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Reconnect an SSH session (disconnect and re-establish connection)
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_RECONNECT,
    async (_event, sessionId: string) => {
      console.log('[SSH IPC] Reconnecting SSH session:', sessionId);

      try {
        // Get the session to retrieve SSH config
        const session = sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
        if (!session || !session.sshConfig) {
          throw new Error('Session not found or not an SSH session');
        }

        const config = session.sshConfig;
        const rawSdkSessionId = sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
          || session.sdkSessionId;
        const sdkSessionId = rawSdkSessionId === 'new' ? undefined : rawSdkSessionId;

        sshService.invalidateTranscriptCache(sdkSessionId || sessionId);

        // 1. Clean disconnect
        sshService.disconnect(sessionId);
        console.log('[SSH IPC] Disconnected session:', sessionId);

        // Small delay for clean teardown
        await new Promise(resolve => setTimeout(resolve, 500));

        // 2. Re-establish SSH connection
        console.log('[SSH IPC] Re-establishing SSH connection to', config.host);
        await sshService.connect(sessionId, config);
        console.log('[SSH IPC] SSH connection re-established');

        return { success: true };
      } catch (error) {
        console.error('[SSH IPC] Reconnect failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Browse remote filesystem (list directory contents)
   */
  ipcMain.handle(
    IPC_CHANNELS.SSH_BROWSE_REMOTE_FILES,
    async (_event, config: SSHConfig, remotePath: string) => {
      console.log('[SSH IPC] Browsing remote directory:', remotePath);

      try {
        const entries = await sshService.listRemoteDirectory(config, remotePath);
        return {
          success: true,
          entries,
        };
      } catch (error) {
        console.error('[SSH IPC] Browse remote files failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          entries: [],
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SSH_HAS_ACTIVE_REMOTE_PROCESS,
    async (_event, sessionId: string) => {
      try {
        const session = sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
        if (!session?.sshConfig) return false;
        return sshService.hasActiveRemoteProcess(sessionId, session.sshConfig);
      } catch (error) {
        console.warn('[SSH IPC] Failed to check active remote process:', error);
        return false;
      }
    }
  );
}
