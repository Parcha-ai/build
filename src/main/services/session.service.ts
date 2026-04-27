import { EventEmitter } from 'events';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { app } from 'electron';
import simpleGit from 'simple-git';
import { DockerService } from './docker.service';
import { GitService } from './git.service';
import { getSessionStoreName } from '../store-names';
import type { Session, SessionStatus } from '../../shared/types';
import Anthropic from '@anthropic-ai/sdk';

interface SessionCreateConfig {
  name: string;
  repoUrl: string;
  branch: string;
  setupScript?: string;
}

// Centralised resolver for the Claude transcripts directory.
// Honours `CLAUDE_PROJECTS_DIR` so demo/test runs can point at a synthetic
// directory without having to override $HOME (which would also break Claude
// CLI / keychain auth).
function getClaudeProjectsDir(): string {
  const override = process.env.CLAUDE_PROJECTS_DIR;
  if (override && override.trim()) return override;
  return path.join(require('os').homedir(), '.claude', 'projects');
}

const DEFAULT_SETUP_SCRIPT = `#!/bin/bash
# Build Session Setup Script
# This script runs when the Docker container starts

# Install dependencies
if [ -f "package.json" ]; then
  npm install
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt
fi

# Custom environment variables
export NODE_ENV=development

# Add your custom setup commands below:
`;

export class SessionService extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private dockerService: DockerService;
  private gitService: GitService;
  private sessionsPath: string;
  private discoveredSessionsCache: Map<string, Session> = new Map();
  private lastDiscoveryTime = 0;
  private readonly DISCOVERY_CACHE_TTL = 60000; // 1 minute cache
  private isInitialLoadDone = false;
  private discoveryInProgress = false;

  constructor() {
    super();
    this.store = new CachedStore({ name: getSessionStoreName() }) as any;
    this.dockerService = new DockerService();
    this.gitService = new GitService();
    this.sessionsPath = path.join(app.getPath('userData'), 'sessions');

    // Load persisted discovered sessions into cache immediately
    this.loadPersistedDiscoveredSessions();
  }

  /**
   * Load previously discovered sessions from store into cache
   * This allows instant startup without waiting for full discovery
   */
  private loadPersistedDiscoveredSessions(): void {
    const persisted = this.store.get('discoveredSessions') as Record<string, Session> | undefined;
    if (persisted) {
      Object.values(persisted).forEach(session => {
        // Fix SSH session names that have full paths - convert to host:folder format
        if (session.sshConfig && session.name.includes(':/')) {
          const parts = session.name.split(':');
          if (parts.length === 2 && parts[1].startsWith('/')) {
            const host = parts[0];
            const folderName = parts[1].split('/').filter(Boolean).pop() || parts[1];
            session.name = `${host}:${folderName}`;
          }
        }
        this.discoveredSessionsCache.set(session.id, session);
      });
      console.log('[Session] Loaded', this.discoveredSessionsCache.size, 'persisted sessions from cache');
    }

    // Migrate stored sessions with worktree paths to have proper fork metadata
    this.migrateWorktreeSessions();
  }

  /**
   * Migrate existing worktree sessions to have proper fork metadata (isWorktree, parentRepoPath)
   * Note: We preserve the existing AI-generated descriptive session names, we do NOT replace them
   */
  private migrateWorktreeSessions(): void {
    const storedSessions = this.store.get('sessions') as Record<string, Session> | undefined;
    if (!storedSessions) return;

    let migrated = 0;

    // Migrate worktrees without fork metadata
    Object.values(storedSessions).forEach(session => {
      // Check if this is a worktree that needs migration
      // Look for paths like ~/.claudette/worktrees/ or old .claudette-worktrees/
      const worktreePath = session.worktreePath || '';
      const isClaudetteWorktree = worktreePath.includes('.claudette/worktrees/') ||
                                  worktreePath.includes('.claudette-worktrees/');

      if (isClaudetteWorktree && !session.isWorktree) {
        // Extract parent repo path from the worktree path
        // Path format: ~/.claudette/worktrees/{repo-hash}/{fork-name}
        // Old format: /path/to/repo/.claudette-worktrees/worktree-{session-id}
        let parentRepoPath: string | undefined;

        if (worktreePath.includes('.claudette-worktrees/')) {
          // Old format - parent is the directory containing .claudette-worktrees
          const idx = worktreePath.indexOf('.claudette-worktrees/');
          parentRepoPath = worktreePath.substring(0, idx - 1); // Remove trailing slash
        } else {
          // New central format - use repoPath if available, otherwise try to determine
          parentRepoPath = session.repoPath !== worktreePath ? session.repoPath : undefined;
        }

        // Update the session with fork metadata
        // IMPORTANT: We preserve the existing session.name (AI-generated descriptive name)
        // We do NOT replace it with silly random names
        session.isWorktree = true;
        session.parentRepoPath = parentRepoPath;

        this.store.set(`sessions.${session.id}`, session);
        migrated++;

        console.log(`[Session Migration] Migrated worktree "${session.name}" (parent: ${parentRepoPath || 'unknown'})`);
      }
    });

    if (migrated > 0) {
      console.log(`[Session Migration] Migrated ${migrated} worktree sessions with fork metadata`);
    }
  }

  /**
   * Persist discovered sessions to store for fast startup
   */
  private persistDiscoveredSessions(): void {
    const sessionsObj: Record<string, Session> = {};
    this.discoveredSessionsCache.forEach((session, id) => {
      sessionsObj[id] = session;
    });
    this.store.set('discoveredSessions', sessionsObj);
    this.store.set('lastDiscoveryTimestamp', Date.now());
  }

  private async ensureSessionsDirectory(): Promise<void> {
    await fs.mkdir(this.sessionsPath, { recursive: true });
  }

  private generateSessionNameAsync(sessionId: string, firstUserMessage: string, actualPath: string): void {
    // Run name generation in background without blocking discovery
    (async () => {
      try {
        // Get API key from settings store
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settingsStore = new Store({ name: 'claudette-settings' }) as any;
        const apiKey = settingsStore.get('anthropicApiKey') as string | undefined;

        if (!apiKey) {
          console.log('[Session] No API key, skipping name generation for:', sessionId);
          return;
        }

        const anthropic = new Anthropic({ apiKey });

        console.log('[Session] Generating name for:', path.basename(actualPath));

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 50,
          messages: [{
            role: 'user',
            content: `Generate a concise 3-5 word descriptive title for this coding session. First message: "${firstUserMessage.slice(0, 200)}"

Only return the title, nothing else.`
          }]
        });

        const title = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
        if (title) {
          this.store.set(`sessionNames.${sessionId}`, title);
          console.log('[Session] Generated name:', path.basename(actualPath), '→', title);

          // Emit event so UI can refresh
          this.emit('sessionNameGenerated', { sessionId, name: title });
        }
      } catch (error) {
        console.error('[Session] Error generating name:', error);
      }
    })();
  }

  private updateSessionStatus(session: Session, status: SessionStatus): Session {
    session.status = status;
    session.updatedAt = new Date();
    this.store.set(`sessions.${session.id}`, session);
    this.emit('statusChanged', session);
    return session;
  }

  async createSession(config: SessionCreateConfig): Promise<Session> {
    await this.ensureSessionsDirectory();

    const sessionId = uuid();
    const sessions = this.getSessions();
    const sessionIndex = sessions.length;
    const ports = this.dockerService.allocatePorts(sessionIndex);

    // Clone repo to sessions directory
    const repoName = config.repoUrl.split('/').pop()?.replace('.git', '') || sessionId;
    const repoPath = path.join(this.sessionsPath, sessionId, repoName);

    const session: Session = {
      id: sessionId,
      name: config.name,
      repoPath,
      worktreePath: repoPath, // Will use cloned repo directly (no separate worktree for GitHub clones)
      branch: config.branch,
      status: 'creating',
      ports,
      createdAt: new Date(),
      updatedAt: new Date(),
      setupScript: config.setupScript || DEFAULT_SETUP_SCRIPT,
    };

    // Save session
    this.store.set(`sessions.${sessionId}`, session);
    this.emit('statusChanged', session);

    try {
      // Clone the repository
      console.log(`[Session] Cloning repository: ${config.repoUrl} to ${repoPath}`);
      await fs.mkdir(path.dirname(repoPath), { recursive: true });
      await this.gitService.clone(config.repoUrl, repoPath);
      console.log(`[Session] Clone completed successfully`);

      // For GitHub clones, use the cloned repo directly (no separate worktree needed)
      // The cloned repo is already on the default branch
      // Update session to use repoPath as worktreePath
      session.worktreePath = repoPath;

      // If a specific branch was requested and it's different from current, check it out
      const git = require('simple-git').default(repoPath);
      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
      if (config.branch !== currentBranch.trim()) {
        console.log(`[Session] Checking out branch: ${config.branch}`);
        try {
          await git.checkout(config.branch);
        } catch (checkoutError) {
          // Branch might not exist remotely, try creating it
          console.log(`[Session] Branch ${config.branch} not found, creating new branch`);
          await git.checkoutLocalBranch(config.branch);
        }
      }
      console.log(`[Session] Using repo at: ${repoPath}`);

      // Create .grep directory with setup script
      const grepDir = path.join(repoPath, '.grep');
      await fs.mkdir(grepDir, { recursive: true });
      await fs.writeFile(
        path.join(grepDir, 'setup.sh'),
        session.setupScript,
        { mode: 0o755 }
      );

      // Update session in store with correct worktreePath
      this.store.set(`sessions.${session.id}`, session);

      this.updateSessionStatus(session, 'stopped');
      return session;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Session] Failed to create session: ${errorMessage}`);
      console.error(`[Session] Full error:`, error);

      // Store error message in session
      session.errorMessage = errorMessage;
      session.status = 'error';
      session.updatedAt = new Date();
      this.store.set(`sessions.${session.id}`, session);
      this.emit('statusChanged', session);

      throw error;
    }
  }

  async startSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Simply activate the session - no Docker needed
    this.updateSessionStatus(session, 'running');
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Simply deactivate the session
    this.updateSessionStatus(session, 'stopped');
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Stop and remove container
    if (session.containerId) {
      await this.dockerService.stopContainer(session.containerId);
      await this.dockerService.removeContainer(session.containerId);
    }

    // Release ports
    this.dockerService.releasePorts(session.ports);

    // Remove session directory
    const sessionDir = path.join(this.sessionsPath, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true });

    // Remove from store
    this.store.delete(`sessions.${sessionId}`);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    // Check store first (for manually created sessions)
    const storedSession = this.store.get(`sessions.${sessionId}`) as Session | undefined;
    if (storedSession) return storedSession;

    // Check discovered sessions cache
    if (this.discoveredSessionsCache.has(sessionId)) {
      return this.discoveredSessionsCache.get(sessionId)!;
    }

    // If cache is stale, refresh discovery and check again
    const now = Date.now();
    if (now - this.lastDiscoveryTime > this.DISCOVERY_CACHE_TTL) {
      await this.listSessions(); // This will refresh the cache
      return this.discoveredSessionsCache.get(sessionId) || null;
    }

    return null;
  }

  async listSessions(): Promise<Session[]> {
    // If we have cached sessions, return them immediately
    // and trigger background discovery for updates (non-blocking)
    if (this.discoveredSessionsCache.size > 0) {
      const now = Date.now();
      // Only trigger background discovery if cache is stale, but NEVER block
      if (now - this.lastDiscoveryTime > this.DISCOVERY_CACHE_TTL) {
        this.backgroundDiscoverSessions();
      }
      const stored = this.getSessions();
      const starredStored = stored.filter(s => s.isStarred && s.sshConfig);
      const merged = this.getMergedSessions();
      const starredMerged = merged.filter(s => s.isStarred && s.sshConfig);
      console.log(`[Session] listSessions: ${stored.length} stored (${starredStored.length} starred SSH), ${this.discoveredSessionsCache.size} discovered, ${merged.length} merged (${starredMerged.length} starred SSH)`);
      // Show sessions that are in merged but NOT in stored (came from discoveredSessionsCache)
      const storedIds = new Set(stored.map(s => s.id));
      const fromCache = starredMerged.filter(s => !storedIds.has(s.id));
      if (fromCache.length > 0) {
        console.log(`[Session]   ${fromCache.length} starred SSH from discoveredCache (not in sessions store):`);
        fromCache.forEach(s => console.log(`[Session]     ${s.name} (${s.id.substring(0, 8)})`));
      }
      return merged;
    }

    // Only do blocking discovery if cache is completely empty
    await this.discoverAndCacheSessions();
    return this.getMergedSessions();
  }

  /**
   * Discover sessions and update cache
   */
  private async discoverAndCacheSessions(): Promise<void> {
    if (this.discoveryInProgress) return;
    this.discoveryInProgress = true;

    try {
      const claudeSessions = await this.discoverClaudeSessions();

      // Update cache with discovered sessions (don't clear - merge to preserve user settings)
      claudeSessions.forEach(s => {
        const existing = this.discoveredSessionsCache.get(s.id);
        if (existing) {
          // Preserve user settings
          s.model = existing.model;
          s.lastBrowserUrl = existing.lastBrowserUrl;
          s.isStarred = existing.isStarred;
          s.starredAt = existing.starredAt;
        }
        this.discoveredSessionsCache.set(s.id, s);
      });

      this.lastDiscoveryTime = Date.now();
      this.persistDiscoveredSessions();

      // Backfill AI names for any unnamed forks (one-time)
      this.backfillForkNames();
    } finally {
      this.discoveryInProgress = false;
    }
  }

  /**
   * Run discovery in background and emit event when new sessions found
   */
  private backgroundDiscoverSessions(): void {
    (async () => {
      const beforeCount = this.discoveredSessionsCache.size;
      await this.discoverAndCacheSessions();
      const afterCount = this.discoveredSessionsCache.size;

      if (afterCount !== beforeCount) {
        console.log('[Session] Background discovery found', afterCount - beforeCount, 'new sessions');
        this.emit('sessionsUpdated', this.getMergedSessions());
      }
    })();
  }

  /**
   * Get merged sessions from cache and store
   */
  private getMergedSessions(): Session[] {
    const storedSessions = this.getSessions();
    const sdkSessionMappings = (this.store.get('sdkSessionMappings') || {}) as Record<string, string>;
    const sessionMap = new Map<string, Session>();

    storedSessions.forEach(s => sessionMap.set(s.id, this.attachSessionIds(s, sdkSessionMappings)));

    this.discoveredSessionsCache.forEach((s, id) => {
      const existing = sessionMap.get(id);
      if (existing) {
        sessionMap.set(id, this.attachSessionIds({
          ...s,
          model: existing.model,
          lastBrowserUrl: existing.lastBrowserUrl,
          isStarred: existing.isStarred,
          starredAt: existing.starredAt,
          sdkSessionId: existing.sdkSessionId || s.sdkSessionId || sdkSessionMappings[id],
          relatedSessionIds: existing.relatedSessionIds || s.relatedSessionIds,
        }, sdkSessionMappings));
      } else {
        sessionMap.set(id, this.attachSessionIds(s, sdkSessionMappings));
      }
    });

    const allSessions = Array.from(sessionMap.values());
    allSessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return allSessions;
  }

  private attachSessionIds(session: Session, sdkSessionMappings: Record<string, string>): Session {
    const sdkSessionId = session.sdkSessionId || sdkSessionMappings[session.id];
    const relatedSessionIds = new Set(session.relatedSessionIds || []);

    if (sdkSessionId) {
      relatedSessionIds.add(sdkSessionId);
    }

    Object.entries(sdkSessionMappings).forEach(([localSessionId, mappedSdkSessionId]) => {
      if (localSessionId === session.id && mappedSdkSessionId) {
        relatedSessionIds.add(mappedSdkSessionId);
      }
      if (mappedSdkSessionId === session.id && localSessionId) {
        relatedSessionIds.add(localSessionId);
      }
    });

    relatedSessionIds.delete(session.id);

    if (!sdkSessionId && relatedSessionIds.size === 0) {
      return session;
    }

    return {
      ...session,
      ...(sdkSessionId ? { sdkSessionId } : {}),
      ...(relatedSessionIds.size > 0 ? { relatedSessionIds: Array.from(relatedSessionIds) } : {}),
    };
  }

  private getSessions(): Session[] {
    const sessions = this.store.get('sessions') as Record<string, Session> | undefined;
    if (!sessions) return [];
    // Filter out stub objects that only have sdkSessionId (from old code paths)
    // Apply sessionNames overrides (AI-generated display names) — same as discoverClaudeSessions does
    return Object.values(sessions)
      .filter(s => s.name && s.repoPath)
      .map(s => {
        const customName = this.store.get(`sessionNames.${s.id}`) as string | undefined;
        return customName ? { ...s, name: customName } : s;
      });
  }

  private async discoverClaudeSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    const claudeProjectsDir = getClaudeProjectsDir();

    console.log('[Session Discovery] Scanning:', claudeProjectsDir);

    try {
      const entries = await fs.readdir(claudeProjectsDir, { withFileTypes: true });
      console.log('[Session Discovery] Found', entries.length, 'entries');

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const projectDir = path.join(claudeProjectsDir, entry.name);
        console.log('[Session Discovery] Scanning project directory:', entry.name);

        // Find a valid project path from ANY transcript in this directory
        // This handles cases where some transcripts have stale Docker paths
        let validProjectPath: string | null = null;
        try {
          // Find .jsonl files (skip agent files and summary files)
          const files = await fs.readdir(projectDir);
          const jsonlFiles = files.filter(f =>
            f.endsWith('.jsonl') &&
            !f.startsWith('agent-') &&
            f.length > 20  // Skip short summary files
          );

          // First pass: find ANY valid cwd from the transcripts
          for (const jsonlFile of jsonlFiles) {
            try {
              const transcriptPath = path.join(projectDir, jsonlFile);
              const content = await fs.readFile(transcriptPath, 'utf-8');
              const lines = content.split('\n').filter(l => l.trim());

              for (const line of lines.slice(0, 50)) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.cwd) {
                    try {
                      await fs.access(parsed.cwd);
                      validProjectPath = parsed.cwd;
                      console.log('[Session Discovery] Found valid path:', validProjectPath);
                      break;
                    } catch {
                      // Path doesn't exist, try next
                    }
                  }
                } catch {
                  // Not valid JSON, skip
                }
              }
              if (validProjectPath) break;
            } catch {
              // Error reading transcript, try next
            }
          }

          // Second pass: create sessions for each transcript using the valid path
          for (const jsonlFile of jsonlFiles) {
            try {
              const transcriptPath = path.join(projectDir, jsonlFile);
              const stats = await fs.stat(transcriptPath);
              const content = await fs.readFile(transcriptPath, 'utf-8');
              const lines = content.split('\n').filter(l => l.trim());

              // Parse lines to find cwd, sessionId, and first user message
              let sessionCwd: string | null = null;
              let transcriptSessionId: string | null = null;
              let firstUserMessage: string | null = null;

              for (const line of lines.slice(0, 50)) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.cwd) sessionCwd = parsed.cwd;
                  if (parsed.sessionId) transcriptSessionId = parsed.sessionId;

                  // Extract first user message for name generation
                  if (!firstUserMessage && parsed.type === 'user') {
                    const content = parsed.message?.content || parsed.content;
                    if (typeof content === 'string') {
                      firstUserMessage = content;
                    } else if (Array.isArray(content)) {
                      const textBlock = content.find((b: any) => b.type === 'text');
                      if (textBlock?.text) {
                        firstUserMessage = textBlock.text;
                      }
                    }
                  }

                  if (sessionCwd && transcriptSessionId && firstUserMessage) break;
                } catch {
                  // Not valid JSON, skip
                }
              }

              // Skip empty transcripts (0 bytes or no lines)
              if (stats.size === 0 || lines.length === 0) {
                console.log('[Session Discovery] Skipping empty transcript:', jsonlFile);
                continue;
              }

              // Use the cached valid path if the transcript's cwd doesn't exist
              let actualPath: string;
              try {
                await fs.access(sessionCwd!); // Non-null assertion: sessionCwd checked above
                actualPath = sessionCwd!;
              } catch {
                // Path doesn't exist - use the cached valid path from first pass
                if (validProjectPath) {
                  actualPath = validProjectPath;
                  console.log('[Session Discovery] Using cached path for', jsonlFile, ':', actualPath);
                } else {
                  // No valid path found in any transcript - skip
                  console.log('[Session Discovery] No valid path found for project:', entry.name);
                  continue;
                }
              }

              // At this point actualPath is guaranteed to be a valid string

              // Get git branch
              let branch = 'main';
              try {
                const git = simpleGit(actualPath);
                const status = await git.status();
                branch = status.current || 'main';
              } catch {
                // Not a git repo or can't get branch
              }

              // Use transcript session ID if available, otherwise hash the transcript file name
              const sessionId = transcriptSessionId || jsonlFile.replace('.jsonl', '');

              // Check if there's a custom name set by Claude (via UpdateSessionName tool)
              const customName = this.store.get(`sessionNames.${sessionId}`) as string | undefined;
              const displayName = customName || `${path.basename(actualPath)} - ${new Date(stats.mtime).toLocaleDateString()}`;

              // Queue background name generation for sessions without custom names
              if (!customName && firstUserMessage) {
                // Generate name asynchronously without blocking discovery
                this.generateSessionNameAsync(sessionId, firstUserMessage, actualPath);
              }

              // Create session from transcript (ephemeral - not stored)
              const session: Session = {
                id: sessionId,
                name: displayName,
                repoPath: actualPath,
                worktreePath: actualPath,
                branch,
                status: 'running',
                ports: { web: 3000, api: 8080, debug: 9229 },
                setupScript: DEFAULT_SETUP_SCRIPT,
                isDevMode: true,
                createdAt: stats.birthtime,
                updatedAt: stats.mtime,  // Use file modification time for sorting
              };

              // Store ONLY the sdkSessionId mapping in a separate object
              // Don't store the full session - discovered sessions are ephemeral
              this.store.set(`sdkSessionMappings.${sessionId}`, sessionId);
              sessions.push(session);
            } catch (fileError) {
              // Error reading this transcript file, skip it
              console.log('[Session Discovery] Error reading transcript:', jsonlFile, fileError);
            }
          }
        } catch (dirError) {
          console.log('[Session Discovery] Error reading project directory:', entry.name, dirError);
        }
      }

      console.log('[Session Discovery] Total discovered:', sessions.length, 'sessions');
    } catch (error) {
      console.error('[Session Discovery] Failed to scan projects directory:', error);
    }

    return sessions;
  }

  /**
   * Rewind a session to a specific message and create a fork
   * This creates a new session with a truncated transcript
   */
  async rewindAndForkSession(sessionId: string, rewindToMessageId: string): Promise<Session> {
    const originalSession = await this.getSession(sessionId);
    if (!originalSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Find the transcript file for this session
    const claudeProjectsDir = getClaudeProjectsDir();

    // Search for the transcript file matching this sessionId
    let transcriptPath: string | null = null;
    let projectHash: string | null = null;

    try {
      const entries = await fs.readdir(claudeProjectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const projectDir = path.join(claudeProjectsDir, entry.name);
        const transcriptFile = `${sessionId}.jsonl`;
        const potentialPath = path.join(projectDir, transcriptFile);

        try {
          await fs.access(potentialPath);
          transcriptPath = potentialPath;
          projectHash = entry.name;
          break;
        } catch {
          // File doesn't exist in this directory, continue searching
        }
      }
    } catch (error) {
      throw new Error(`Failed to search for transcript: ${error}`);
    }

    if (!transcriptPath || !projectHash) {
      throw new Error(`Transcript file not found for session ${sessionId}`);
    }

    // Read the transcript
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // Find all lines up to and including the target message
    const truncatedLines: string[] = [];
    let foundTargetMessage = false;
    let lastUserMessageIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      truncatedLines.push(line);

      try {
        const parsed = JSON.parse(line);
        // Check if this line contains the target message UUID
        if (parsed.uuid === rewindToMessageId) {
          foundTargetMessage = true;
          // Include subsequent lines that are part of the same message exchange
          // (e.g., assistant response immediately after)
          break;
        }
        // Track the last user message index for fallback
        if (parsed.type === 'user' && parsed.message?.role === 'user') {
          lastUserMessageIndex = i;
        }
      } catch {
        // Not valid JSON, keep line anyway (could be metadata)
      }
    }

    if (!foundTargetMessage) {
      throw new Error(`Message ${rewindToMessageId} not found in transcript`);
    }

    // Generate new session ID for the fork
    const forkedSessionId = uuid();
    const forkedTranscriptPath = path.join(
      claudeProjectsDir,
      projectHash,
      `${forkedSessionId}.jsonl`
    );

    // Update sessionId in all lines to point to the new session
    const updatedLines = truncatedLines.map(line => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.sessionId === sessionId) {
          parsed.sessionId = forkedSessionId;
        }
        return JSON.stringify(parsed);
      } catch {
        return line;
      }
    });

    // Write the truncated transcript
    await fs.writeFile(forkedTranscriptPath, updatedLines.join('\n') + '\n', 'utf-8');

    // Generate forked session name
    const originalName = originalSession.name;
    const forkSuffix = ' (forked)';
    const forkedName = originalName.endsWith(forkSuffix)
      ? originalName
      : `${originalName}${forkSuffix}`;

    // Create the forked session object
    const forkedSession: Session = {
      ...originalSession,
      id: forkedSessionId,
      name: forkedName,
      sdkSessionId: undefined, // Fork gets its own SDK session — sharing causes conflicts on resume
      createdAt: new Date(),
      updatedAt: new Date(),
      // Preserve important metadata
      model: originalSession.model,
      branch: originalSession.branch,
      worktreePath: originalSession.worktreePath,
      repoPath: originalSession.repoPath,
      isDevMode: originalSession.isDevMode,
      sshConfig: originalSession.sshConfig,
    };

    // Store the forked session
    this.store.set(`sessions.${forkedSessionId}`, forkedSession);

    // Map the fork to its own session ID so getMessages() finds the forked transcript
    // ({forkedSessionId}.jsonl) directly, without triggering orphan-transcript search
    // that could re-point the fork back to the parent's SDK session.
    this.store.set(`sdkSessionMappings.${forkedSessionId}`, forkedSessionId);

    // Add to discovered sessions cache
    this.discoveredSessionsCache.set(forkedSessionId, forkedSession);
    this.persistDiscoveredSessions();

    // Emit event to notify UI
    this.emit('sessionsUpdated', this.getMergedSessions());

    console.log(`[Session] Created forked session ${forkedSessionId} from ${sessionId} at message ${rewindToMessageId}`);

    return forkedSession;
  }

  /**
   * Create a conversation fork from a parent session using the Claude Agent SDK's
   * native `forkSession()`. The SDK handles transcript copying, compaction summary,
   * and session ID generation — we just create the Build session record and wire
   * up the relationship fields.
   *
   * @param parentSessionId ID of the parent session to fork from
   * @param forkPoint Message ID to fork at, or 'end' to fork at current end of conversation
   * @param initialUserMessage Optional first message to send to the fork (not added yet, caller handles sending)
   */
  async createForkFromInput(
    parentSessionId: string,
    forkPoint: string,
    initialUserMessage?: string
  ): Promise<Session> {
    const parentSession = await this.getSession(parentSessionId);
    if (!parentSession) {
      throw new Error(`Parent session ${parentSessionId} not found`);
    }

    // Resolve the SDK session ID for the parent — this is what the SDK knows
    // the session as (may differ from our internal parentSessionId).
    const parentSdkSessionId =
      (this.store.get(`sdkSessionMappings.${parentSessionId}`) as string | undefined) ||
      parentSession.sdkSessionId ||
      parentSessionId;

    let forkedSessionId: string;
    let forkedSdkSessionId: string;

    // For local sessions, use the SDK's native forkSession which handles
    // transcript copying with compaction summaries. For SSH sessions the
    // transcript lives on the remote machine where the SDK can't reach it,
    // so we create a lightweight fork record and let the first query use
    // `resume` + `forkSession: true` to fork server-side.
    if (!parentSession.sshConfig) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { forkSession } = require('@anthropic-ai/claude-agent-sdk') as { forkSession: (sessionId: string, options?: { upToMessageId?: string; title?: string; dir?: string }) => Promise<{ sessionId: string }> };
      const forkOptions: { upToMessageId?: string; title?: string; dir?: string } = {};
      if (forkPoint !== 'end') {
        forkOptions.upToMessageId = forkPoint;
      }
      forkOptions.title = `${parentSession.name} (fork)`;
      const projectsDirOverride = process.env.CLAUDE_PROJECTS_DIR;
      if (projectsDirOverride) {
        forkOptions.dir = projectsDirOverride;
      }

      console.log(`[Session] Forking via SDK: parent=${parentSdkSessionId} forkPoint=${forkPoint}`);
      const result = await forkSession(parentSdkSessionId, forkOptions);
      forkedSessionId = result.sessionId;
      forkedSdkSessionId = result.sessionId;
      console.log(`[Session] SDK fork created: ${forkedSdkSessionId}`);
    } else {
      // SSH session: create a new session ID. The first sendMessage call will
      // use `resume: parentSdkSessionId` + `forkSession: true` via the SDK
      // query options, which forks the remote transcript server-side.
      forkedSessionId = uuid();
      forkedSdkSessionId = parentSdkSessionId; // Resume from parent, SDK will fork on first query
      console.log(`[Session] SSH fork: new session ${forkedSessionId}, will resume+fork from ${parentSdkSessionId}`);
    }

    const forkedSession: Session = {
      ...parentSession,
      id: forkedSessionId,
      name: `${parentSession.name} (fork)`,
      sdkSessionId: parentSession.sshConfig ? undefined : forkedSdkSessionId,
      createdAt: new Date(),
      updatedAt: new Date(),
      forkCreatedAt: new Date(),
      parentSessionId: parentSessionId,
      childSessionIds: [],
      forkPoint: forkPoint,
      isRoot: false,
      model: parentSession.model,
      branch: parentSession.branch,
      worktreePath: parentSession.worktreePath,
      repoPath: parentSession.repoPath,
      isDevMode: parentSession.isDevMode,
      sshConfig: parentSession.sshConfig,
      // For SSH forks: tell streamMessage to use resume+forkSession on first query
      ...(parentSession.sshConfig ? { forkFromSdkSessionId: parentSdkSessionId } : {}),
    };

    // Store the forked session
    this.store.set(`sessions.${forkedSessionId}`, forkedSession);

    // Map to the SDK session ID so getMessages() finds the transcript.
    // For SSH forks, map to the parent SDK ID so messages load from parent
    // until the first query forks the remote transcript.
    this.store.set(`sdkSessionMappings.${forkedSessionId}`, forkedSdkSessionId);

    // Update parent session: add to childSessionIds, mark as root if not already
    const updatedParent = {
      ...parentSession,
      childSessionIds: [...(parentSession.childSessionIds || []), forkedSessionId],
      isRoot: parentSession.isRoot ?? true,
    };
    this.store.set(`sessions.${parentSessionId}`, updatedParent);

    // Add to discovered sessions cache
    this.discoveredSessionsCache.set(forkedSessionId, forkedSession);
    this.persistDiscoveredSessions();

    // Emit event to notify UI of both updates
    this.emit('sessionsUpdated', this.getMergedSessions());

    console.log(`[Session] Created conversation fork ${forkedSessionId} from parent ${parentSessionId}`);

    // Generate AI name asynchronously (non-blocking)
    if (initialUserMessage) {
      this.generateForkName(forkedSessionId, parentSession, initialUserMessage).catch(err => {
        console.error('[Session] Failed to generate fork name:', err);
      });
    }

    return forkedSession;
  }

  /**
   * Generate an AI-powered name for a conversation fork
   * Uses Claude Haiku to create a 2-3 word descriptive name
   * @param forkedSessionId ID of the forked session to name
   * @param parentSession Parent session for context
   * @param userMessage The user's message that created this fork
   */
  private async generateForkName(
    forkedSessionId: string,
    parentSession: Session,
    userMessage: string
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settingsStore = new Store({ name: 'claudette-settings' }) as any;
    const apiKey = settingsStore.get('anthropicApiKey') as string | undefined;

    if (!apiKey) {
      console.log('[Session] No API key, using fallback fork name');
      // Use fallback name based on fork count
      const forkCount = (parentSession.childSessionIds?.length || 0);
      const fallbackName = `Fork ${forkCount}`;
      await this.updateSession(forkedSessionId, { aiGeneratedName: fallbackName });
      return;
    }

    try {
      const anthropic = new Anthropic({ apiKey });

      console.log('[Session] Generating AI name for fork:', forkedSessionId);

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `Generate a concise 3-word name for this conversation fork.

Parent conversation: "${parentSession.name}"
New direction: "${userMessage.slice(0, 200)}"

Only return the short name (exactly 3 words), nothing else.`
        }]
      });

      const generatedName = response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : null;

      if (generatedName) {
        await this.updateSession(forkedSessionId, {
          aiGeneratedName: generatedName,
          name: generatedName // Update the main name too
        });
        console.log('[Session] Generated fork name:', generatedName);
        // Notify renderer so fork tabs update immediately
        this.emit('sessionsUpdated', this.getMergedSessions());
      }
    } catch (error) {
      console.error('[Session] Failed to generate AI fork name:', error);
      // Use fallback on error
      const forkCount = (parentSession.childSessionIds?.length || 0);
      const fallbackName = `Fork ${forkCount}`;
      await this.updateSession(forkedSessionId, { aiGeneratedName: fallbackName });
      this.emit('sessionsUpdated', this.getMergedSessions());
    }
  }

  /**
   * Backfill AI-generated names for forks that don't have one yet.
   * Reads the first user message from each fork's transcript and uses Haiku to name it.
   */
  private backfillForkNames(): void {
    (async () => {
      try {
        const allSessions = this.getMergedSessions();
        const unnamedForks = allSessions.filter(
          s => s.parentSessionId && !s.aiGeneratedName
        );

        if (unnamedForks.length === 0) return;
        console.log(`[Session] Backfilling names for ${unnamedForks.length} unnamed forks`);

        for (const fork of unnamedForks) {
          // Read the fork's transcript to find the first user message
          const firstMessage = await this.getFirstUserMessage(fork.id);
          if (!firstMessage) {
            // No message found — use a simple fallback
            await this.updateSession(fork.id, { aiGeneratedName: `Fork` });
            continue;
          }

          const parentSession = allSessions.find(s => s.id === fork.parentSessionId);
          if (parentSession) {
            await this.generateForkName(fork.id, parentSession, firstMessage);
          } else {
            // No parent found — generate name from message alone
            await this.generateForkNameStandalone(fork.id, firstMessage);
          }
        }
      } catch (error) {
        console.error('[Session] Failed to backfill fork names:', error);
      }
    })();
  }

  /**
   * Read the first user message from a session's transcript file.
   */
  private async getFirstUserMessage(sessionId: string): Promise<string | null> {
    const claudeProjectsDir = getClaudeProjectsDir();

    try {
      const entries = await fs.readdir(claudeProjectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const transcriptFile = path.join(claudeProjectsDir, entry.name, `${sessionId}.jsonl`);
        try {
          await fs.access(transcriptFile);
          const content = await fs.readFile(transcriptFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'human' && parsed.message?.content) {
                const text = typeof parsed.message.content === 'string'
                  ? parsed.message.content
                  : parsed.message.content.find?.((c: { type: string; text?: string }) => c.type === 'text')?.text;
                if (text) return text;
              }
            } catch { /* skip malformed line */ }
          }
          return null; // Transcript exists but no user message found
        } catch { /* transcript not in this dir */ }
      }
    } catch { /* projects dir doesn't exist */ }
    return null;
  }

  /**
   * Generate a fork name without parent context.
   */
  private async generateForkNameStandalone(forkedSessionId: string, userMessage: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settingsStore = new Store({ name: 'claudette-settings' }) as any;
    const apiKey = settingsStore.get('anthropicApiKey') as string | undefined;

    if (!apiKey) {
      await this.updateSession(forkedSessionId, { aiGeneratedName: 'Fork' });
      return;
    }

    try {
      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `Generate a concise 3-word name for this conversation fork based on the message: "${userMessage.slice(0, 200)}"

Only return the short name (3 words), nothing else.`
        }]
      });

      const generatedName = response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : null;

      if (generatedName) {
        await this.updateSession(forkedSessionId, {
          aiGeneratedName: generatedName,
          name: generatedName
        });
        console.log('[Session] Backfilled fork name:', generatedName);
        this.emit('sessionsUpdated', this.getMergedSessions());
      }
    } catch (error) {
      console.error('[Session] Failed to generate standalone fork name:', error);
      await this.updateSession(forkedSessionId, { aiGeneratedName: 'Fork' });
    }
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const session = await this.getSession(sessionId);
    if (!session) {
      // Silently ignore updates for ephemeral (discovered) sessions
      // These are read-only and recreated on each discovery
      console.log('[Session] Ignoring update for ephemeral session:', sessionId);
      // Return a minimal session object to satisfy the caller
      return {
        id: sessionId,
        name: 'Ephemeral Session',
        repoPath: '',
        worktreePath: '',
        branch: 'main',
        status: 'running',
        ports: { web: 3000, api: 8080, debug: 9229 },
        setupScript: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const updatedSession = {
      ...session,
      ...updates,
      id: session.id, // Prevent ID changes
      updatedAt: new Date(),
    };

    // If setup script changed, update the file
    if (updates.setupScript) {
      const setupPath = path.join(session.worktreePath, '.grep', 'setup.sh');
      await fs.writeFile(setupPath, updates.setupScript, { mode: 0o755 });
    }

    this.store.set(`sessions.${sessionId}`, updatedSession);
    return updatedSession;
  }
}
