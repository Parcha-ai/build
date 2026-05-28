import React, { useState, useRef, useEffect } from 'react';
import { Play, Square, Trash2, GitBranch, GitFork, Server, Upload, Pencil, Star, Download, RefreshCw, LayoutGrid } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import type { Session } from '../../../shared/types';
import { GSTACK_MODE_META } from '../../../shared/types';

/**
 * Truncate a file path to show at most the last N segments.
 * e.g. "/home/ubuntu/dev/parcha/claudette" → "parcha/claudette" (n=2)
 */
function truncatePath(fullPath: string, segments = 2): string {
  const parts = fullPath.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= segments) return fullPath;
  return parts.slice(-segments).join('/');
}

// Format date as relative time (e.g., "2h ago", "3d ago", "Jan 15")
function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  // For older dates, show month and day
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface SessionCardProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  isFork?: boolean;
  onTeleportRequest?: (session: Session) => void;
  onDownload?: (session: Session) => void;
}

export default function SessionCard({ session, isActive, onClick, isFork = false, onTeleportRequest, onDownload }: SessionCardProps) {
  const { sessions, startSession, stopSession, deleteSession, updateSession, addToCommandCenter, removeFromCommandCenter, commandCenterSessionIds, loadMessages } = useSessionStore();
  const activity = useSessionStore((s) => s.sessionActivity[session.id]);
  // Check if this session (or its root) is in the command center
  const isInCommandCenter = (() => {
    let rootId = session.id;
    let s = sessions.find(x => x.id === rootId);
    while (s?.parentSessionId) {
      rootId = s.parentSessionId;
      s = sessions.find(x => x.id === rootId);
    }
    return commandCenterSessionIds.includes(rootId);
  })();
  const [isRenaming, setIsRenaming] = useState(false);
  const [editedName, setEditedName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine session type for icon display
  const isSSH = !!session.sshConfig;
  const isWorktree = isFork || session.isWorktree;

  const getStatusColor = () => {
    switch (session.status) {
      case 'running':
        return 'bg-green-500';
      case 'stopped':
        return 'bg-gray-500';
      case 'error':
        return 'bg-red-500';
      case 'starting':
      case 'stopping':
      case 'creating':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    startSession(session.id);
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopSession(session.id);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete session "${session.name}"?`)) {
      deleteSession(session.id);
    }
  };

  const handleTeleport = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onTeleportRequest && !isSSH) {
      onTeleportRequest(session);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDownload && isSSH) {
      onDownload(session);
    }
  };

  const handleReconnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isSSH) return;

    try {
      // Reconnect via SSH service (disconnects and will reconnect on next start)
      const result = await window.electronAPI.ssh.reconnect(session.id);
      if (!result.success) {
        throw new Error(result.error || 'Reconnect failed');
      }

      // Stop the session
      await stopSession(session.id);

      // Small delay to ensure clean stop
      await new Promise(resolve => setTimeout(resolve, 500));

      // Restart the session
      await startSession(session.id);
      await loadMessages(session.id);
    } catch (error) {
      console.error('Failed to reconnect:', error);
    }
  };

  const handleCommandCenterToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isInCommandCenter) {
      removeFromCommandCenter(session.id);
    } else {
      addToCommandCenter(session.id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    startRenaming();
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    startRenaming();
  };

  const handleStarToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.isStarred) {
      updateSession(session.id, { isStarred: false, starredAt: undefined });
    } else {
      updateSession(session.id, { isStarred: true, starredAt: new Date() });
    }
  };

  const startRenaming = () => {
    setEditedName(session.forkName || session.name);
    setIsRenaming(true);
  };

  const saveRename = async () => {
    if (editedName.trim() && editedName !== (session.forkName || session.name)) {
      // Update forkName if it's a fork, otherwise update name
      const updates = isFork || session.forkName
        ? { forkName: editedName.trim() }
        : { name: editedName.trim() };
      await updateSession(session.id, updates);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setIsRenaming(false);
    setEditedName('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveRename();
    } else if (e.key === 'Escape') {
      cancelRename();
    }
  };

  // Focus input when entering rename mode
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  // Periodic branch refresh for SSH sessions (every 30s)
  const refreshSessionBranch = useSessionStore((s) => s.refreshSessionBranch);
  useEffect(() => {
    if (!isSSH) return;
    // Initial refresh
    refreshSessionBranch(session.id);
    const interval = setInterval(() => {
      refreshSessionBranch(session.id);
    }, 30000);
    return () => clearInterval(interval);
  }, [isSSH, session.id, refreshSessionBranch]);

  // Get the appropriate icon based on session type
  const getSessionIcon = () => {
    if (isSSH && isWorktree) {
      // SSH + Worktree: Show server with small fork indicator
      return (
        <div className="relative flex-shrink-0">
          <Server size={10} className="text-cyan-400" />
          <GitFork size={6} className="absolute -bottom-0.5 -right-0.5 text-emerald-400" />
        </div>
      );
    } else if (isSSH) {
      return <Server size={10} className="text-cyan-400 flex-shrink-0" />;
    } else if (isWorktree) {
      return <GitFork size={10} className="text-emerald-400 flex-shrink-0" />;
    } else {
      return <GitBranch size={10} className="flex-shrink-0" />;
    }
  };

  const isAnimating =
    session.status === 'starting' ||
    session.status === 'stopping' ||
    session.status === 'creating';

  return (
    <div
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/session-id', session.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={`relative px-3 py-2 cursor-pointer transition-colors group font-mono ${
        isActive
          ? 'bg-claude-accent/20'
          : 'hover:bg-claude-bg'
      }`}
      style={{
        borderLeft: session.gstackMode && GSTACK_MODE_META[session.gstackMode]
          ? `2px solid ${GSTACK_MODE_META[session.gstackMode].color}`
          : isActive ? '2px solid var(--claude-accent)' : '2px solid transparent',
      }}
    >
      <div className="flex items-start gap-2">
        {/* Status indicator - shape varies by type */}
        <div
          className={`w-2 h-2 mt-1 flex-shrink-0 ${getStatusColor()} ${isAnimating ? 'animate-pulse' : ''}`}
          style={{
            borderRadius: isSSH ? '50%' : (isWorktree ? '2px' : '0'),
            transform: isWorktree ? 'rotate(45deg)' : 'none'
          }}
          title={isSSH ? 'SSH Session' : (isWorktree ? 'Worktree' : 'Project')}
        />

        {/* Content — takes full width */}
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <input
              ref={inputRef}
              type="text"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              onBlur={saveRename}
              onKeyDown={handleKeyDown}
              className="text-xs font-bold w-full bg-claude-surface border border-claude-accent px-1 py-0.5 text-claude-text"
              style={{ borderRadius: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="flex items-center gap-1 group/name">
              <h4
                className={`text-xs font-bold truncate ${isActive ? 'text-claude-text' : 'text-claude-text-secondary'} cursor-text`}
                onDoubleClick={handleDoubleClick}
              >
                {session.aiGeneratedName || session.forkName || session.name}
              </h4>
              {/* Activity indicator: green pulse = active/streaming, amber = waiting for input */}
              {activity === 'active' && (
                <span
                  className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"
                  title="Streaming..."
                />
              )}
              {activity === 'waiting' && (
                <span
                  className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400"
                  title="Waiting for input"
                />
              )}
              <button
                onClick={handleEditClick}
                className="opacity-0 group-hover/name:opacity-100 p-0.5 hover:bg-claude-accent/20 transition-opacity flex-shrink-0"
                style={{ borderRadius: 0 }}
                title="Rename session"
              >
                <Pencil size={10} className="text-claude-text-secondary" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-1 mt-0.5 text-claude-text-secondary">
            {getSessionIcon()}
            {session.gstackMode && GSTACK_MODE_META[session.gstackMode] && (
              <span
                className="text-[8px] font-bold px-0.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: GSTACK_MODE_META[session.gstackMode].color, color: '#000' }}
              >
                {GSTACK_MODE_META[session.gstackMode].shortName}
              </span>
            )}
            <span className="text-[10px] truncate">
              {session.branch}
            </span>
            <span className="text-[10px] text-claude-text-secondary/60 flex-shrink-0">
              · {formatRelativeDate(new Date(session.updatedAt))}
            </span>
          </div>
          {isSSH && session.sshConfig?.remoteWorkdir && (
            <div className="mt-0.5">
              <span className="text-[9px] text-claude-text-secondary/50 truncate block" title={session.sshConfig.remoteWorkdir}>
                {truncatePath(session.sshConfig.remoteWorkdir)}
              </span>
            </div>
          )}
        </div>

        {/* Starred indicator — visible when starred, no layout impact */}
        {session.isStarred && (
          <button
            onClick={handleStarToggle}
            className="p-0.5 text-amber-400 hover:bg-amber-400/20 flex-shrink-0 group-hover:hidden"
            style={{ borderRadius: 0 }}
            title="Unstar session"
          >
            <Star size={10} fill="currentColor" />
          </button>
        )}
      </div>

      {/* Hover overlay — star + actions float over text on hover */}
      <div
        className="absolute right-1 top-1 hidden group-hover:flex items-center gap-0.5 px-1 py-0.5"
        style={{
          background: isActive ? 'var(--claude-accent-bg, rgba(var(--claude-accent-rgb, 139, 92, 246), 0.2))' : 'var(--claude-bg)',
          borderRadius: 0,
        }}
      >
        <button
          onClick={handleStarToggle}
          className={`p-1 transition-all ${
            session.isStarred
              ? 'text-amber-400 hover:bg-amber-400/20'
              : 'text-claude-text-secondary hover:bg-claude-text-secondary/20'
          }`}
          style={{ borderRadius: 0 }}
          title={session.isStarred ? 'Unstar session' : 'Star session'}
        >
          <Star size={12} fill={session.isStarred ? 'currentColor' : 'none'} />
        </button>
        {session.status === 'stopped' && (
          <button
            onClick={handleStart}
            className="p-1 transition-colors hover:bg-green-500/20 text-green-500"
            style={{ borderRadius: 0 }}
            title="Start session"
          >
            <Play size={12} />
          </button>
        )}
        {session.status === 'running' && (
          <button
            onClick={handleStop}
            className="p-1 transition-colors hover:bg-yellow-500/20 text-yellow-500"
            style={{ borderRadius: 0 }}
            title="Stop session"
          >
            <Square size={12} />
          </button>
        )}
        {!isSSH && onTeleportRequest && (
          <button
            onClick={handleTeleport}
            className="p-1 transition-colors hover:bg-cyan-500/20 text-cyan-400"
            style={{ borderRadius: 0 }}
            title="Teleport to SSH remote"
          >
            <Upload size={12} />
          </button>
        )}
        {isSSH && (
          <button
            onClick={handleReconnect}
            className="p-1 transition-colors hover:bg-blue-500/20 text-blue-400"
            style={{ borderRadius: 0 }}
            title="Reconnect SSH session"
          >
            <RefreshCw size={12} />
          </button>
        )}
        {isSSH && onDownload && (
          <button
            onClick={handleDownload}
            className="p-1 transition-colors hover:bg-cyan-500/20 text-cyan-400"
            style={{ borderRadius: 0 }}
            title="Download to local folder"
          >
            <Download size={12} />
          </button>
        )}
        <button
          onClick={handleCommandCenterToggle}
          className={`p-1 transition-colors ${
            isInCommandCenter
              ? 'text-claude-accent hover:bg-claude-accent/20'
              : 'text-claude-text-secondary hover:bg-claude-text-secondary/20'
          }`}
          style={{ borderRadius: 0 }}
          title={isInCommandCenter ? 'Remove from Command Center' : 'Add to Command Center'}
        >
          <LayoutGrid size={12} />
        </button>
        <button
          onClick={handleDelete}
          className="p-1 transition-colors hover:bg-red-500/20 text-red-400"
          style={{ borderRadius: 0 }}
          title="Delete session"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
