import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, Plus, Zap, Loader2, Search, GitFork, Server, Star, Focus } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import SessionCard from './SessionCard';
import NewSessionDialog from './NewSessionDialog';
import TeleportDialog from './TeleportDialog';
import DownloadSessionDialog from './DownloadSessionDialog';
import { useUIStore } from '../../stores/ui.store';
import { useTaskStore } from '../../stores/task.store';
import type { Session } from '../../../shared/types';

interface ProjectGroup {
  path: string;
  name: string;
  sessions: Session[];
  mostRecentUpdate: Date;
  forks: ProjectGroup[]; // Worktree forks of this project (as nested groups)
  type: 'local' | 'ssh';  // Distinguish project types
  sshHost?: string;       // For SSH projects, the host name
}

export default function SessionList() {
  const { sessions, activeSessionId, setActiveSession: rawSetActiveSession, isLoadingSessions, loadSessions, startSession } = useSessionStore();

  // When clicking a session in the sidebar, deactivate Command Center
  const setActiveSession = useCallback((sessionId: string) => {
    if (useUIStore.getState().isCommandCenterActive) {
      useUIStore.getState().toggleCommandCenter();
    }
    rawSetActiveSession(sessionId);
  }, [rawSetActiveSession]);

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionInitialPath, setNewSessionInitialPath] = useState<string>('');
  const [newSessionInitialName, setNewSessionInitialName] = useState<string>('');
  const [showAllRecentSessions, setShowAllRecentSessions] = useState(false);
  const [teleportSession, setTeleportSession] = useState<Session | null>(null);
  const [downloadSession, setDownloadSession] = useState<Session | null>(null);

  // Track sessions that have been visited during this app instance
  const [visitedSessionIds, setVisitedSessionIds] = useState<Set<string>>(new Set());

  // Drag-and-drop reorder for starred sessions
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Add active session to visited sessions when it changes
  useEffect(() => {
    if (activeSessionId && !visitedSessionIds.has(activeSessionId)) {
      setVisitedSessionIds(prev => new Set([...prev, activeSessionId]));
    }
  }, [activeSessionId]);

  // Group sessions by project path and sort them - but only re-compute when session IDs change
  // This ensures stable ordering that doesn't reshuffle while you're using the app
  // NOTE: This hook MUST be before any early returns to satisfy React's rules of hooks
  const sortedProjects = useMemo(() => {
    if (sessions.length === 0) return [];

    const projectGroups = new Map<string, ProjectGroup>();
    const forkSessions: Session[] = []; // Collect fork sessions for second pass
    const sshHostGroups = new Map<string, ProjectGroup>(); // SSH sessions grouped by host

    // First pass: separate SSH and local sessions, create project groups
    sessions.forEach(session => {
      // Skip conversation forks UNLESS it's the active session — active session
      // must always be visible in the sidebar so the user can find where they are.
      if (session.parentSessionId && session.id !== activeSessionId) {
        return;
      }

      // Handle SSH sessions - group by host
      if (session.sshConfig) {
        const host = session.sshConfig.host;
        const hostKey = `ssh://${session.sshConfig.username}@${host}`;

        if (!sshHostGroups.has(hostKey)) {
          sshHostGroups.set(hostKey, {
            path: hostKey,
            name: host,
            sessions: [],
            mostRecentUpdate: new Date(session.updatedAt),
            forks: [],
            type: 'ssh',
            sshHost: host,
          });
        }

        const group = sshHostGroups.get(hostKey)!;
        group.sessions.push(session);

        const sessionDate = new Date(session.updatedAt);
        if (sessionDate > group.mostRecentUpdate) {
          group.mostRecentUpdate = sessionDate;
        }
        return;
      }

      // Collect fork sessions for second pass
      if (session.isWorktree && session.parentRepoPath) {
        forkSessions.push(session);
        return;
      }

      const projectPath = session.worktreePath;
      if (!projectGroups.has(projectPath)) {
        // Determine if this is a Claudette-managed worktree (old style without parent tracking)
        const isClaudetteWorktree = projectPath.includes('.claudette-worktrees/') ||
                                    projectPath.includes('.claudette/worktrees/');

        let projectName: string;
        if (isClaudetteWorktree) {
          // For old-style Claudette worktrees, use the session name
          projectName = session.name;
        } else {
          // For regular directories, use parent/folder format for disambiguation
          // e.g., "/home/user/dev/myorg/myapp" -> "myorg/myapp"
          const pathParts = projectPath.split('/').filter(Boolean);
          if (pathParts.length >= 2) {
            projectName = `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
          } else {
            projectName = pathParts[pathParts.length - 1] || 'Unknown';
          }
        }

        projectGroups.set(projectPath, {
          path: projectPath,
          name: projectName,
          sessions: [],
          mostRecentUpdate: new Date(session.updatedAt),
          forks: [],
          type: 'local',
        });
      }

      const group = projectGroups.get(projectPath)!;
      group.sessions.push(session);

      const sessionDate = new Date(session.updatedAt);
      if (sessionDate > group.mostRecentUpdate) {
        group.mostRecentUpdate = sessionDate;
      }
    });

    // Second pass: group fork sessions under their parent projects
    forkSessions.forEach(session => {
      const parentPath = session.parentRepoPath!;
      const parentGroup = projectGroups.get(parentPath);

      if (parentGroup) {
        // Check if we already have a fork group for this worktree path
        let forkGroup = parentGroup.forks.find(f => f.path === session.worktreePath);
        if (!forkGroup) {
          // Use the session's descriptive name (AI-generated)
          forkGroup = {
            path: session.worktreePath,
            name: session.name, // Use the descriptive session name
            sessions: [],
            mostRecentUpdate: new Date(session.updatedAt),
            forks: [], // Forks don't have sub-forks
            type: 'local',
          };
          parentGroup.forks.push(forkGroup);
        }
        forkGroup.sessions.push(session);

        // Update timestamps
        const sessionDate = new Date(session.updatedAt);
        if (sessionDate > forkGroup.mostRecentUpdate) {
          forkGroup.mostRecentUpdate = sessionDate;
        }
        if (sessionDate > parentGroup.mostRecentUpdate) {
          parentGroup.mostRecentUpdate = sessionDate;
        }
      } else {
        // Orphan fork - parent not in our list, create a standalone group
        const projectPath = session.worktreePath;
        if (!projectGroups.has(projectPath)) {
          projectGroups.set(projectPath, {
            path: projectPath,
            name: session.name,
            sessions: [],
            mostRecentUpdate: new Date(session.updatedAt),
            forks: [],
            type: 'local',
          });
        }
        projectGroups.get(projectPath)!.sessions.push(session);
      }
    });

    // Merge local and SSH project groups
    const allProjects = [
      ...Array.from(projectGroups.values()),
      ...Array.from(sshHostGroups.values()),
    ];

    // Sort projects by most recent activity (most recently used first)
    const sorted = allProjects.sort((a, b) =>
      b.mostRecentUpdate.getTime() - a.mostRecentUpdate.getTime()
    );

    // Sort sessions and forks within each project by last used (newest first)
    sorted.forEach(project => {
      project.sessions.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      project.forks.sort((a, b) =>
        b.mostRecentUpdate.getTime() - a.mostRecentUpdate.getTime()
      );
      project.forks.forEach(fork => {
        fork.sessions.sort((a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
    });

    return sorted;
  }, [sessions.map(s => s.id).join(',')]); // Only re-sort when session IDs change (add/remove)

  // Starred sessions — deduplicated by path for SSH sessions.
  // Multiple SSH sessions sharing the same remote path collapse to one entry
  // (the most recently updated), keyed by session name.
  const starredSessions = useMemo(() => {
    const allStarred = sessions
      .filter(s => s.isStarred && !s.parentSessionId)
      .sort((a, b) => {
        const aTime = a.starredAt ? new Date(a.starredAt).getTime() : 0;
        const bTime = b.starredAt ? new Date(b.starredAt).getTime() : 0;
        return aTime - bTime;
      });

    // Deduplicate SSH sessions: one entry per unique remote path
    const sshPathMap = new Map<string, Session>();
    const result: Session[] = [];
    for (const s of allStarred) {
      if (s.sshConfig) {
        const pathKey = s.worktreePath || s.repoPath || s.sshConfig.remoteWorkdir;
        const existing = sshPathMap.get(pathKey);
        if (!existing || new Date(s.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
          sshPathMap.set(pathKey, s);
        }
      } else {
        result.push(s);
      }
    }
    // Add deduplicated SSH sessions, sorted by starredAt
    const sshSessions = Array.from(sshPathMap.values()).sort((a, b) => {
      const aTime = a.starredAt ? new Date(a.starredAt).getTime() : 0;
      const bTime = b.starredAt ? new Date(b.starredAt).getTime() : 0;
      return aTime - bTime;
    });
    result.push(...sshSessions);
    return result;
  }, [sessions]);

  // Recent sessions (running + recently used, excluding starred)
  // Limited to 10 most recent for the "Recent" section
  const recentSessions = useMemo(() => {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    return sessions
      .filter(s =>
        !s.isStarred && // Exclude starred sessions — they have their own section
        !s.parentSessionId && ( // Exclude conversation forks
          s.status === 'running' || // Show all running sessions
          visitedSessionIds.has(s.id) || // Show visited sessions
          new Date(s.updatedAt).getTime() > sevenDaysAgo // Show recently used sessions
        )
      )
      .sort((a, b) => {
        // Currently active session goes first
        if (a.id === activeSessionId) return -1;
        if (b.id === activeSessionId) return 1;
        // Then sort by most recently used
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      })
      .slice(0, 10); // Limit to 10 most recent
  }, [sessions, visitedSessionIds, activeSessionId]);

  const handleCreateSessionInFolder = (projectPath: string, projectName: string) => {
    // Open dialog to create a new session in the same folder
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const sessionName = `${projectName} - ${timestamp}`;

    setNewSessionInitialPath(projectPath);
    setNewSessionInitialName(sessionName);
    setNewSessionDialogOpen(true);
  };

  const toggleProject = (projectPath: string) => {
    const newExpanded = new Set(expandedProjects);
    if (newExpanded.has(projectPath)) {
      newExpanded.delete(projectPath);
    } else {
      newExpanded.add(projectPath);
    }
    setExpandedProjects(newExpanded);
  };

  // Show loading state while scanning for sessions
  if (isLoadingSessions) {
    return (
      <div className="p-6 flex flex-col items-center justify-center text-claude-text-secondary">
        <div className="w-12 h-12 flex items-center justify-center mb-3 bg-claude-surface" style={{ borderRadius: 0 }}>
          <Search size={20} className="text-claude-accent animate-pulse" />
        </div>
        <div className="text-[10px] font-bold uppercase tracking-wider mb-1">
          SCANNING SESSIONS
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <Loader2 size={10} className="animate-spin" />
          <span>Discovering Claude Code transcripts...</span>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-center text-claude-text-secondary text-sm">
        <p>No sessions yet.</p>
        <p className="mt-1 text-xs">Click + to create one.</p>
      </div>
    );
  }

  // Focus Mode: dim entire session list when active
  const focusModeEnabled = useTaskStore?.((s: any) => s.focusModeEnabled) || false;
  const focusActiveTaskId = useTaskStore?.((s: any) => s.activeTaskId) || null;
  const focusTasks = useTaskStore?.((s: any) => s.tasks) || [];
  const activeTask = focusModeEnabled ? focusTasks.find((t: any) => t.id === focusActiveTaskId) : null;
  const focusSessionId = activeTask?.sessionId;

  return (
    <div className="pb-2">
      {/* Focus Mode: show the active task's session prominently */}
      {focusModeEnabled && focusSessionId && (() => {
        const focusSession = sessions.find(s => s.id === focusSessionId);
        if (!focusSession) return null;
        return (
          <div className="mb-3 border-b border-green-500/30">
            <div className="px-3 py-1.5 flex items-center gap-2">
              <Focus size={12} className="text-green-400" />
              <span className="text-[10px] font-bold text-green-400 uppercase tracking-wider">
                Focus
              </span>
            </div>
            <SessionCard
              session={focusSession}
              isActive={focusSession.id === activeSessionId}
              onClick={() => setActiveSession(focusSession.id)}
            />
          </div>
        );
      })()}

      {/* Rest of sessions — dimmed in Focus Mode */}
      <div className={focusModeEnabled ? 'opacity-20 pointer-events-none' : ''}>
      {/* Starred Sessions section */}
      {starredSessions.length > 0 && (
        <div className="mb-3">
          <div className="px-3 py-1.5 flex items-center gap-2">
            <Star size={12} className="text-amber-400" fill="currentColor" />
            <span className="text-[10px] font-bold text-claude-text-secondary uppercase tracking-wider">
              Starred
            </span>
          </div>
          <div>
            {starredSessions.map((session) => (
              <div
                key={session.id}
                draggable
                onDragStart={(e) => {
                  setDraggedId(session.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // Make the drag image semi-transparent
                  if (e.currentTarget instanceof HTMLElement) {
                    e.currentTarget.style.opacity = '0.5';
                  }
                }}
                onDragEnd={(e) => {
                  setDraggedId(null);
                  setDragOverId(null);
                  if (e.currentTarget instanceof HTMLElement) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (draggedId && draggedId !== session.id) {
                    setDragOverId(session.id);
                  }
                }}
                onDragLeave={() => {
                  if (dragOverId === session.id) setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!draggedId || draggedId === session.id) return;

                  // Reorder: compute new starredAt between neighbours
                  const fromIdx = starredSessions.findIndex(s => s.id === draggedId);
                  const toIdx = starredSessions.findIndex(s => s.id === session.id);
                  if (fromIdx < 0 || toIdx < 0) return;

                  // Build new order
                  const reordered = [...starredSessions];
                  const [moved] = reordered.splice(fromIdx, 1);
                  reordered.splice(toIdx, 0, moved);

                  // Assign new starredAt timestamps to maintain order
                  // Use epoch base + index * 1000ms so they're monotonically increasing
                  const base = new Date('2020-01-01T00:00:00Z').getTime();
                  reordered.forEach((s, i) => {
                    const newStarredAt = new Date(base + i * 1000).toISOString();
                    window.electronAPI?.sessions?.update(s.id, {
                      starredAt: newStarredAt,
                    } as any).catch(() => {});
                  });

                  // Reload to reflect new order
                  loadSessions();
                  setDraggedId(null);
                  setDragOverId(null);
                }}
                className={dragOverId === session.id ? 'border-t-2 border-claude-accent' : ''}
              >
                <SessionCard
                  session={session}
                  isActive={session.id === activeSessionId}
                  onClick={() => setActiveSession(session.id)}
                  isFork={session.isWorktree}
                  onTeleportRequest={setTeleportSession}
                  onDownload={setDownloadSession}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Sessions section */}
      {recentSessions.length > 0 && (
        <div className="mb-3">
          <div className="px-3 py-1.5 flex items-center gap-2">
            <Zap size={12} className="text-amber-400" />
            <span className="text-[10px] font-bold text-claude-text-secondary uppercase tracking-wider">
              Recent {recentSessions.length > 5 && `(${recentSessions.length})`}
            </span>
          </div>
          <div>
            {recentSessions.slice(0, showAllRecentSessions ? undefined : 5).map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => setActiveSession(session.id)}
                isFork={session.isWorktree}
                onTeleportRequest={setTeleportSession}
                onDownload={setDownloadSession}
              />
            ))}

            {/* Show more/less button */}
            {recentSessions.length > 5 && (
              <button
                onClick={() => setShowAllRecentSessions(!showAllRecentSessions)}
                className="w-full px-3 py-1.5 text-[10px] font-bold text-claude-accent hover:bg-claude-surface-hover transition-colors uppercase"
                style={{ letterSpacing: '0.05em' }}
              >
                {showAllRecentSessions ? '▲ SHOW LESS' : `▼ SHOW ${recentSessions.length - 5} MORE`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Project folders section */}
      {sortedProjects.length > 0 && (
        <div>
          <div className="px-3 py-1.5 flex items-center gap-2">
            <Folder size={12} className="text-claude-text-secondary" />
            <span className="text-[10px] font-bold text-claude-text-secondary uppercase tracking-wider">
              All Projects
            </span>
          </div>
          {sortedProjects.map((project) => {
            const isExpanded = expandedProjects.has(project.path);
            const hasActiveSession = project.sessions.some(s => s.id === activeSessionId) ||
                                     project.forks.some(f => f.sessions.some(s => s.id === activeSessionId));
            const totalSessions = project.sessions.length + project.forks.reduce((sum, f) => sum + f.sessions.length, 0);

            return (
              <div key={project.path} className="mb-1">
                {/* Project header */}
                <div
                  className={`w-full px-3 py-2 flex items-center gap-2 group hover:bg-claude-bg transition-colors ${
                    hasActiveSession ? 'bg-claude-bg' : ''
                  }`}
                  style={{ borderRadius: 0 }}
                >
                  <button
                    onClick={() => toggleProject(project.path)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="flex-shrink-0 text-claude-text-secondary" />
                    ) : (
                      <ChevronRight size={12} className="flex-shrink-0 text-claude-text-secondary" />
                    )}
                    {project.type === 'ssh' ? (
                      <Server size={14} className="flex-shrink-0 text-cyan-400" />
                    ) : (
                      <Folder size={14} className="flex-shrink-0 text-claude-accent" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-bold text-claude-text truncate block">
                        {project.type === 'ssh' ? (
                          <span className="flex items-center gap-1">
                            <span className="text-cyan-400">⌘</span>
                            {project.name}
                          </span>
                        ) : (
                          project.name
                        )}
                      </span>
                      <span className="text-[10px] text-claude-text-secondary">
                        {project.type === 'ssh' && 'SSH Remote · '}
                        {totalSessions} session{totalSessions !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCreateSessionInFolder(project.path, project.name);
                    }}
                    className="p-1 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-claude-surface text-claude-text-secondary hover:text-claude-accent"
                    title="New session in this folder"
                    style={{ borderRadius: 0 }}
                  >
                    <Plus size={12} />
                  </button>
                </div>

                {/* Sessions and forks under this project */}
                {isExpanded && (
                  <div className="ml-6 relative">
                    {/* Worktrees section - shown FIRST, flat list with tree branch lines */}
                    {project.forks.length > 0 && (() => {
                      const allWorktreeSessions = project.forks.flatMap(fork => fork.sessions);
                      return (
                        <div className="relative mb-2">
                          {/* Worktrees label */}
                          <div className="px-2 py-1 flex items-center gap-2">
                            <GitFork size={10} className="text-emerald-400" />
                            <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider">
                              Worktrees
                            </span>
                          </div>

                          {/* Vertical line from label down through all sessions */}
                          <div
                            className="absolute left-4 top-6 w-px bg-emerald-500/50"
                            style={{ height: `calc(100% - 24px)` }}
                          />

                          {/* Flat list of all worktree sessions with branch lines */}
                          {allWorktreeSessions.map((session, idx) => (
                            <div key={session.id} className="relative">
                              {/* Horizontal branch line */}
                              <div className="absolute left-4 top-4 w-3 h-px bg-emerald-500/50" />

                              <div className="ml-5">
                                <SessionCard
                                  session={session}
                                  isActive={session.id === activeSessionId}
                                  onClick={() => setActiveSession(session.id)}
                                  isFork={true}
                                  onTeleportRequest={setTeleportSession}
                                  onDownload={setDownloadSession}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Regular sessions - shown AFTER worktrees */}
                    {project.sessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        isActive={session.id === activeSessionId}
                        onClick={() => setActiveSession(session.id)}
                        onTeleportRequest={setTeleportSession}
                        onDownload={setDownloadSession}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Session Dialog */}
      <NewSessionDialog
        isOpen={newSessionDialogOpen}
        onClose={() => {
          setNewSessionDialogOpen(false);
          setNewSessionInitialPath('');
          setNewSessionInitialName('');
        }}
        initialPath={newSessionInitialPath}
        initialName={newSessionInitialName}
      />

      {/* Teleport to SSH Dialog */}
      {teleportSession && (
        <TeleportDialog
          session={teleportSession}
          onClose={() => setTeleportSession(null)}
          onTeleported={async (newSessionId) => {
            setTeleportSession(null);
            // Reload sessions from backend to include the new teleported session
            await loadSessions();
            // Select the new session
            await setActiveSession(newSessionId);
            // Explicitly start the session since it's created in 'stopped' state
            await startSession(newSessionId);
          }}
        />
      )}

      {/* Download SSH Session to Local Dialog */}
      {downloadSession && (
        <DownloadSessionDialog
          session={downloadSession}
          onClose={() => setDownloadSession(null)}
          onSuccess={async (newSessionId) => {
            setDownloadSession(null);
            // Reload sessions from backend to include the new local session
            await loadSessions();
            // Select the new session
            await setActiveSession(newSessionId);
            // Explicitly start the session since it's created in 'stopped' state
            await startSession(newSessionId);
          }}
        />
      )}
    </div>
    </div>
  );
}
