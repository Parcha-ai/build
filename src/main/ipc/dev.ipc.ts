import { IpcMain, dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { v4 as uuid } from 'uuid';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import simpleGit from 'simple-git';
import type { Session } from '../../shared/types';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { findUsableLocalExecutable } from '../utils/local-executable';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Check if Claude Code CLI is installed
 */
async function checkClaudeCli(): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  const home = os.homedir();
  const cliPath = findUsableLocalExecutable(['claude'], [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
  ]);
  if (!cliPath) {
    return { installed: false, path: null, version: null };
  }

  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['--version'], { timeout: 5000 });
    const version = (stdout || stderr).trim().split('\n')[0] || null;
    return { installed: true, path: cliPath, version };
  } catch (error) {
    console.log('[CLI Check] Claude CLI found but version check failed:', error);
    return { installed: true, path: cliPath, version: null };
  }
}

/**
 * Resolve a path to its main git repository.
 * If the path is inside a worktree, returns the main repo path.
 * Otherwise returns the path as-is.
 */
async function getMainRepoPath(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    // Check if this is a worktree by looking at the git dir
    const gitDir = await git.raw(['rev-parse', '--git-dir']);
    const trimmedGitDir = gitDir.trim();

    // If git-dir contains '.git/worktrees/', this is a worktree
    if (trimmedGitDir.includes('.git/worktrees/') || trimmedGitDir.includes('/.git/worktrees/')) {
      // Get the common (main) git dir
      const commonGitDir = await git.raw(['rev-parse', '--git-common-dir']);
      const trimmedCommonDir = commonGitDir.trim();

      // The main repo path is the parent of the .git directory
      // commonGitDir returns something like "/path/to/main/repo/.git"
      const mainRepoPath = path.dirname(trimmedCommonDir);
      console.log(`[Worktree] Resolved worktree at ${repoPath} to main repo at ${mainRepoPath}`);
      return mainRepoPath;
    }
  } catch (error) {
    // Not a worktree or error - use as-is
    console.log(`[Worktree] Path ${repoPath} is not a worktree, using as main repo`);
  }
  return repoPath;
}

/**
 * Generate a stable hash for a path to use as directory name
 */
function getPathHash(repoPath: string): string {
  return crypto.createHash('md5').update(repoPath).digest('hex').substring(0, 8);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = new CachedStore({ name: getSessionStoreName() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore: any = new Store({ name: 'claudette-settings' });

export function registerDevHandlers(ipcMain: IpcMain): void {
  // Open folder picker and check if it's a git repo
  ipcMain.handle(IPC_CHANNELS.DEV_OPEN_LOCAL_REPO, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select a Folder or Git Repository',
      buttonLabel: 'Open Folder',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const repoPath = result.filePaths[0];
    const name = repoPath.split('/').pop() || 'Local Folder';

    // Check if it's a git repository
    try {
      const git = simpleGit(repoPath);
      const isRepo = await git.checkIsRepo();

      if (!isRepo) {
        // Not a git repo - return with flag to offer init
        return {
          success: true,
          needsGitInit: true,
          repoPath,
          name,
          isGit: false,
        };
      }

      // Try to get current branch - may fail if no commits yet
      let branch = 'main';
      try {
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      } catch {
        // Git repo exists but has no commits - offer to initialize properly
        return {
          success: true,
          needsGitInit: true,
          repoPath,
          name,
          isGit: true,
        };
      }

      return {
        success: true,
        needsGitInit: false,
        repoPath,
        branch,
        name,
        isGit: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open folder',
      };
    }
  });

  // Initialize git in a folder
  ipcMain.handle('dev:init-git', async (_event, repoPath: string) => {
    try {
      const git = simpleGit(repoPath);
      await git.init();
      // Create initial commit with .gitignore
      await git.add('.gitignore').catch(() => undefined); // Ignore if no .gitignore
      await git.commit('Initial commit', { '--allow-empty': null });
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
      return { success: true, branch: branch.trim() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initialize git repository',
      };
    }
  });

  // Get/Set active session ID for persistence
  ipcMain.handle('dev:get-active-session', async () => {
    return settingsStore.get('activeSessionId') || null;
  });

  ipcMain.handle('dev:set-active-session', async (_event, sessionId: string | null) => {
    if (sessionId) {
      settingsStore.set('activeSessionId', sessionId);
    } else {
      settingsStore.delete('activeSessionId');
    }
  });

  // Get/Set dev mode for persistence
  ipcMain.handle('dev:get-dev-mode', async () => {
    return settingsStore.get('isDevMode') || false;
  });

  ipcMain.handle('dev:set-dev-mode', async (_event, enabled: boolean) => {
    settingsStore.set('isDevMode', enabled);
  });

  // Check if Claude Code CLI is installed
  ipcMain.handle(IPC_CHANNELS.DEV_CHECK_CLAUDE_CLI, async () => {
    return checkClaudeCli();
  });

  // Check if a folder is a git repository
  ipcMain.handle(IPC_CHANNELS.DEV_CHECK_GIT_REPO, async (_event, repoPath: string) => {
    try {
      const git = simpleGit(repoPath);
      const isGit = await git.checkIsRepo();

      if (!isGit) {
        return { isGit: false };
      }

      // Try to get current branch
      let branch = 'main';
      try {
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      } catch {
        // Git repo exists but has no commits
        branch = 'main';
      }

      return { isGit: true, branch };
    } catch (error) {
      return { isGit: false, error: error instanceof Error ? error.message : 'Failed to check git repo' };
    }
  });

  // Get branches from a repo path (for branch selection dropdown)
  ipcMain.handle(IPC_CHANNELS.DEV_GET_BRANCHES, async (_event, repoPath: string) => {
    try {
      const git = simpleGit(repoPath);
      const isGit = await git.checkIsRepo();

      if (!isGit) {
        return { success: false, branches: [], error: 'Not a git repository' };
      }

      // Fetch from remote to get latest branches (silently fail if no remote)
      try {
        await git.fetch(['--all', '--prune']);
      } catch (fetchError) {
        // If fetch fails (no remote, no network, etc.), continue with local branches only
        console.log('[dev.ipc] Failed to fetch from remote, using local branches only:', fetchError);
      }

      // Get all branches (local and remote)
      const branchSummary = await git.branch(['-a']); // -a shows all (local + remote)
      const currentBranch = branchSummary.current;

      // Process branches: deduplicate and clean up names
      const branchSet = new Set<string>();
      const branches: Array<{ name: string; current: boolean }> = [];

      for (const branchName of branchSummary.all) {
        let cleanName = branchName;

        // For remote branches like "remotes/origin/feature", extract just "feature"
        if (branchName.startsWith('remotes/origin/')) {
          cleanName = branchName.replace('remotes/origin/', '');
          // Skip HEAD pointer
          if (cleanName === 'HEAD') continue;
        }

        // Skip if we've already seen this branch name
        if (branchSet.has(cleanName)) continue;
        branchSet.add(cleanName);

        branches.push({
          name: cleanName,
          current: cleanName === currentBranch,
        });
      }

      // Sort: current branch first, then alphabetically
      branches.sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (!a.current && b.current) return 1;
        return a.name.localeCompare(b.name);
      });

      return { success: true, branches, currentBranch };
    } catch (error) {
      return { success: false, branches: [], error: error instanceof Error ? error.message : 'Failed to get branches' };
    }
  });

  // Create a dev session from local repo (no Docker, no cloning)
  ipcMain.handle(IPC_CHANNELS.DEV_CREATE_SESSION, async (_event, data: {
    name: string;
    repoPath: string;
    branch: string;
    createWorktree?: boolean;
  }) => {
    const sessionId = uuid();
    let worktreePath = data.repoPath;
    let worktreeInstructions: string | undefined;
    let isWorktree = false;
    let parentRepoPath: string | undefined;
    let forkName: string | undefined;

    // If creating a worktree, set up a new worktree directory
    if (data.createWorktree) {
      try {
        // IMPORTANT: Always resolve to the main repo to avoid nested worktrees
        const mainRepoPath = await getMainRepoPath(data.repoPath);
        const git = simpleGit(mainRepoPath);
        const isGit = await git.checkIsRepo();

        if (isGit) {
          // Use the session ID prefix for the worktree directory name
          const worktreeDirName = `wt-${sessionId.substring(0, 8)}`;

          // Use central location: ~/.claudette/worktrees/{repo-hash}/{worktree-dir}
          const repoHash = getPathHash(mainRepoPath);
          const centralWorktreesDir = path.join(os.homedir(), '.claudette', 'worktrees', repoHash);
          worktreePath = path.join(centralWorktreesDir, worktreeDirName);

          // Ensure the central directory exists
          await fs.mkdir(centralWorktreesDir, { recursive: true });

          // Create the worktree FROM THE MAIN REPO (prevents nesting issues)
          console.log(`[Worktree] Creating worktree at ${worktreePath} from main repo ${mainRepoPath}`);
          await git.raw(['worktree', 'add', worktreePath, data.branch]);

          // Track the worktree relationship
          isWorktree = true;
          parentRepoPath = mainRepoPath;

          // Execute worktree setup if configured
          const claudetteDir = path.join(data.repoPath, '.claudette');
          const scriptPath = path.join(claudetteDir, 'worktree-setup.sh');
          const instructionsPath = path.join(claudetteDir, 'worktree-setup.md');

          const [scriptExists, instructionsExist] = await Promise.all([
            fs.access(scriptPath).then(() => true).catch(() => false),
            fs.access(instructionsPath).then(() => true).catch(() => false),
          ]);

          if (scriptExists) {
            console.log(`[Worktree Setup] Executing script: ${scriptPath}`);
            try {
              const { stdout, stderr } = await execAsync(`bash "${scriptPath}"`, {
                cwd: worktreePath,
                env: { ...process.env, WORKTREE_PATH: worktreePath, REPO_PATH: data.repoPath },
              });
              console.log(`[Worktree Setup] Script output:`, stdout);
              if (stderr) console.warn(`[Worktree Setup] Script stderr:`, stderr);
            } catch (error) {
              console.error(`[Worktree Setup] Script execution failed:`, error);
            }
          } else if (instructionsExist) {
            // Read instructions to store on the session - they'll be sent as the first message
            worktreeInstructions = await fs.readFile(instructionsPath, 'utf-8');
            console.log(`[Worktree Setup] Instructions loaded (will be sent as first message):`, worktreeInstructions.substring(0, 100) + '...');
          }
        }
      } catch (error) {
        console.error('Failed to create worktree:', error);
        // Fall back to using the main repo path
        worktreePath = data.repoPath;
      }
    }

    // For worktrees, use the fork name as the session name
    const sessionName = isWorktree && forkName ? forkName : data.name;

    const session: Session = {
      id: sessionId,
      name: sessionName,
      repoPath: data.repoPath,
      worktreePath: worktreePath,
      branch: data.branch,
      status: 'running', // Dev sessions are always "running"
      ports: {
        web: 3000,
        api: 8080,
        debug: 9229,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      setupScript: '',
      isDevMode: true, // Flag for dev mode sessions
      worktreeInstructions, // Setup instructions to send to Claude
      worktreeInstructionsSent: false, // Track if instructions have been sent
      // Fork/worktree tracking
      isWorktree,
      parentRepoPath,
      forkName,
    };

    // Save session
    store.set(`sessions.${sessionId}`, session);

    return session;
  });

  // Check if worktree setup files exist in project
  ipcMain.handle(IPC_CHANNELS.DEV_CHECK_WORKTREE_SETUP, async (_event, repoPath: string) => {
    try {
      const claudetteDir = path.join(repoPath, '.claudette');
      const scriptPath = path.join(claudetteDir, 'worktree-setup.sh');
      const instructionsPath = path.join(claudetteDir, 'worktree-setup.md');

      const [scriptExists, instructionsExist] = await Promise.all([
        fs.access(scriptPath).then(() => true).catch(() => false),
        fs.access(instructionsPath).then(() => true).catch(() => false),
      ]);

      return {
        success: true,
        hasScript: scriptExists,
        hasInstructions: instructionsExist,
        scriptPath: scriptExists ? scriptPath : undefined,
        instructionsPath: instructionsExist ? instructionsPath : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check worktree setup',
      };
    }
  });

  // Save worktree setup script by copying from provided path
  ipcMain.handle(IPC_CHANNELS.DEV_SAVE_WORKTREE_SCRIPT, async (_event, data: {
    repoPath: string;
    sourcePath: string;
  }) => {
    try {
      const claudetteDir = path.join(data.repoPath, '.claudette');
      await fs.mkdir(claudetteDir, { recursive: true });

      const targetPath = path.join(claudetteDir, 'worktree-setup.sh');
      await fs.copyFile(data.sourcePath, targetPath);
      await fs.chmod(targetPath, 0o755); // Make executable

      return { success: true, path: targetPath };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save worktree script',
      };
    }
  });

  // Save worktree setup instructions from text
  ipcMain.handle(IPC_CHANNELS.DEV_SAVE_WORKTREE_INSTRUCTIONS, async (_event, data: {
    repoPath: string;
    instructions: string;
  }) => {
    try {
      const claudetteDir = path.join(data.repoPath, '.claudette');
      await fs.mkdir(claudetteDir, { recursive: true });

      const targetPath = path.join(claudetteDir, 'worktree-setup.md');
      await fs.writeFile(targetPath, data.instructions, 'utf-8');

      return { success: true, path: targetPath };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save worktree instructions',
      };
    }
  });

  // Create a teleport session by spawning Claude Code CLI with --teleport flag
  // This downloads the web session from claude.ai to the local machine
  ipcMain.handle(IPC_CHANNELS.DEV_CREATE_TELEPORT_SESSION, async (_event, data: {
    sessionId: string;
    name: string;
    cwd: string;
  }) => {
    const remoteSessionId = data.sessionId;
    const workingDir = data.cwd;

    if (!workingDir) {
      throw new Error('Project directory is required for teleport. Please select a directory.');
    }

    console.log('[Teleport] Starting teleport for session:', remoteSessionId, 'in', workingDir);

    // First check if Claude CLI is installed
    const cliCheck = await checkClaudeCli();
    if (!cliCheck.installed) {
      throw new Error('Claude Code CLI is not installed. Please install it first: https://docs.anthropic.com/claude-code');
    }

    console.log('[Teleport] Claude CLI found at:', cliCheck.path);

    // Check if the directory is a clean git repo (no uncommitted changes)
    try {
      const git = simpleGit(workingDir);
      const isRepo = await git.checkIsRepo();

      if (isRepo) {
        const status = await git.status();
        const hasChanges = status.modified.length > 0 ||
                          status.staged.length > 0 ||
                          status.not_added.length > 0 ||
                          status.deleted.length > 0;

        if (hasChanges) {
          console.log('[Teleport] Directory has uncommitted changes:', status);
          throw new Error(
            `The selected directory has uncommitted changes.\n\n` +
            `Please commit or stash your changes first, or select a clean directory/worktree.`
          );
        }
        console.log('[Teleport] Git directory is clean');
      } else {
        console.log('[Teleport] Directory is not a git repo - proceeding anyway');
      }
    } catch (gitError: unknown) {
      // Re-throw if it's our "uncommitted changes" error
      if (gitError instanceof Error && gitError.message.includes('uncommitted changes')) {
        throw gitError;
      }
      // Otherwise log and continue (might not be a git repo)
      console.log('[Teleport] Git check failed, proceeding:', gitError);
    }

    // Check if this is a UUID (local session) or web session ID (session_xxx format)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(remoteSessionId);
    const isWebSession = remoteSessionId.startsWith('session_');

    // Look for existing local transcript first
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    let foundTranscript = false;

    if (fsSync.existsSync(claudeDir)) {
      const projectDirs = fsSync.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const candidatePath = path.join(claudeDir, projectDir, `${remoteSessionId}.jsonl`);
        if (fsSync.existsSync(candidatePath)) {
          foundTranscript = true;
          console.log('[Teleport] Found existing local transcript:', candidatePath);
          break;
        }
      }
    }

    // If web session and no local transcript, run claude --teleport
    if (isWebSession && !foundTranscript) {
      console.log('[Teleport] Running: claude --teleport', remoteSessionId, '-p "status update"');

      await new Promise<void>((resolve, reject) => {
        // Format: claude --teleport <session-id> -p "prompt"
        // The -p flag requires a prompt argument for non-interactive mode
        // Note: Don't use shell: true to avoid quoting issues
        const teleportProcess = spawn(cliCheck.path || 'claude', ['--teleport', remoteSessionId, '-p', 'status update'], {
          cwd: workingDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        teleportProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
          console.log('[Teleport stdout]', chunk.toString());
        });

        teleportProcess.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
          console.log('[Teleport stderr]', chunk.toString());
        });

        teleportProcess.on('close', (code) => {
          console.log('[Teleport] Process exited with code:', code);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Teleport failed (exit code ${code}): ${stderr || stdout || 'Unknown error'}`));
          }
        });

        teleportProcess.on('error', (err) => {
          console.error('[Teleport] Process error:', err);
          reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
        });

        // 5 minute timeout - teleport runs a full Claude conversation turn which can take a while
        const timeout = setTimeout(() => {
          teleportProcess.kill();
          reject(new Error('Teleport timed out after 5 minutes. The session may be very large.'));
        }, 300000);

        teleportProcess.on('close', () => clearTimeout(timeout));
      });

      console.log('[Teleport] Teleport completed successfully');
    } else if (!foundTranscript && !isUUID) {
      // Unknown format and no local transcript
      console.log('[Teleport] Unknown session format:', remoteSessionId);
      throw new Error(`Invalid session ID format. Expected UUID or session_xxx format.`);
    } else {
      console.log('[Teleport] Using existing local session:', remoteSessionId);
    }

    // Create a Build session that references the teleported session
    const session: Session = {
      id: remoteSessionId,
      name: data.name,
      repoPath: workingDir,
      worktreePath: workingDir,
      branch: 'main',
      status: 'running',
      ports: {
        web: 3000,
        api: 8080,
        debug: 9229,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      setupScript: '',
      isDevMode: true,
      isTeleported: true,
    };

    // Store the session
    store.set(`sessions.${session.id}`, session);
    store.set(`sdkSessionMappings.${session.id}`, remoteSessionId);

    console.log('[Teleport] Created Build session for teleported conversation:', session.id);

    return session;
  });

  // Debug: Get registered webviews
  ipcMain.handle('dev:get-registered-webviews', async () => {
    const { browserService } = await import('../services/browser.service');
    const registered = Array.from((browserService as any).sessionWebContents.entries());
    return { success: true, webviews: registered };
  });

  // Execute worktree setup (called after worktree creation)
  ipcMain.handle(IPC_CHANNELS.DEV_EXECUTE_WORKTREE_SETUP, async (_event, data: {
    repoPath: string;
    worktreePath: string;
  }) => {
    try {
      const claudetteDir = path.join(data.repoPath, '.claudette');
      const scriptPath = path.join(claudetteDir, 'worktree-setup.sh');
      const instructionsPath = path.join(claudetteDir, 'worktree-setup.md');

      // Check which setup method exists
      const [scriptExists, instructionsExist] = await Promise.all([
        fs.access(scriptPath).then(() => true).catch(() => false),
        fs.access(instructionsPath).then(() => true).catch(() => false),
      ]);

      if (scriptExists) {
        // Execute the script in the worktree directory
        const { stdout, stderr } = await execAsync(`bash "${scriptPath}"`, {
          cwd: data.worktreePath,
          env: { ...process.env, WORKTREE_PATH: data.worktreePath, REPO_PATH: data.repoPath },
        });

        return {
          success: true,
          type: 'script',
          output: stdout,
          error: stderr || undefined,
        };
      } else if (instructionsExist) {
        // Read instructions and return them for Claude to execute
        const instructions = await fs.readFile(instructionsPath, 'utf-8');

        return {
          success: true,
          type: 'instructions',
          instructions,
        };
      } else {
        return {
          success: true,
          type: 'none',
          message: 'No worktree setup configured',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to execute worktree setup',
      };
    }
  });
}
