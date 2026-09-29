import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { isSessionNotFoundError, useSessionStore } from '../../stores/session.store';
import { useAuthStore } from '../../stores/auth.store';
import { ChevronDown, Check } from 'lucide-react';
import CostBadge from '../analytics/CostBadge';
import { MicrophoneButton } from '../chat/MicrophoneButton';
import { VoiceModeErrorBoundary } from '../chat/VoiceModeErrorBoundary';
import type { Branch } from '../../../shared/types';

// Dev instance name from environment variable (set by scripts/dev.sh, passed via preload)
const DEV_INSTANCE_NAME: string | null =
  (window as unknown as { electronAPI?: { devInstanceName?: string | null } }).electronAPI?.devInstanceName || null;

// Extract subagent type from Task tool input
function getSubagentType(input: Record<string, unknown>): string | null {
  const description = (input.description as string) || '';
  const prompt = (input.prompt as string) || '';
  const combined = `${description} ${prompt}`.toLowerCase();

  // Pattern match common subagent types
  if (combined.includes('explore') || combined.includes('search')) return 'EXPLORE';
  if (combined.includes('plan')) return 'PLAN';
  if (combined.includes('implement') || combined.includes('code') || combined.includes('bond')) return 'IMPLEMENT';
  if (combined.includes('document') || combined.includes('moneypenny')) return 'DOCUMENT';
  if (combined.includes('test') || combined.includes('verify') || combined.includes('scaramanga')) return 'TEST';
  if (combined.includes('q') || combined.includes('briefing')) return 'BRIEF';

  if (input.subagent_type) {
    return (input.subagent_type as string).toUpperCase();
  }

  return null;
}

const EMPTY_TOOL_CALLS: never[] = [];

export default function StatusBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const updateSession = useSessionStore((s) => s.updateSession);
  const refreshSessionBranch = useSessionStore((s) => s.refreshSessionBranch);
  const activeToolCalls = useSessionStore(useCallback(
    (s) => s.currentToolCalls[s.activeSessionId || ''] || EMPTY_TOOL_CALLS,
    []
  ));
  const isDevMode = useAuthStore((s) => s.isDevMode);
  const [dockerStatus, setDockerStatus] = useState<{ available: boolean; version?: string } | null>(null);
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [appVersion, setAppVersion] = useState('0.0.0');
  const [updateInfo, setUpdateInfo] = useState<{ version: string; downloadUrl: string; releaseNotes?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [aheadBehind, setAheadBehind] = useState<{ ahead: number; behind: number; tracking: boolean } | null>(null);
  const [todayCost, setTodayCost] = useState<number | null>(null);
  const contextUsage = useSessionStore((s) => (s.activeSessionId ? s.contextUsage[s.activeSessionId] : null));

  // Fetch app version on mount
  useEffect(() => {
    window.electronAPI?.app.getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // Listen for update available notifications from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI?.update?.onUpdateAvailable((info) => {
      console.log(`[StatusBar] Update available: v${info.version}`);
      setUpdateInfo(info);
    });
    return () => { unsubscribe?.(); };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Ahead/behind upstream for local sessions (read-only git status).
  useEffect(() => {
    setAheadBehind(null);
    if (!activeSessionId || activeSession?.sshConfig) return;
    let cancelled = false;
    window.electronAPI.git.getStatus(activeSessionId)
      .then((status: { tracking: string | null; ahead: number; behind: number }) => {
        if (!cancelled) setAheadBehind({ ahead: status.ahead || 0, behind: status.behind || 0, tracking: !!status.tracking });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeSessionId, activeSession?.sshConfig, activeSession?.branch]);

  // Today's spend across all sessions.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.electronAPI?.analytics?.getSummary?.()
        .then((summary: { todayTotalCost?: number }) => {
          if (!cancelled && typeof summary?.todayTotalCost === 'number') setTodayCost(summary.todayTotalCost);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsub = window.electronAPI?.analytics?.onTokenEvent?.(() => refresh());
    return () => { cancelled = true; unsub?.(); };
  }, []);

  // Watch for branch changes via file system events (not polling)
  useEffect(() => {
    if (!activeSessionId) return;
    if (activeSession?.sshConfig) {
      refreshSessionBranch(activeSessionId);
      return;
    }

    const startBranchWatcher = async () => {
      let result = await window.electronAPI.git.watchBranch(activeSessionId);
      if (!result.success && result.error && isSessionNotFoundError(result.error, activeSessionId)) {
        await window.electronAPI.sessions.update(activeSessionId, {});
        result = await window.electronAPI.git.watchBranch(activeSessionId);
      }
      if (result.success && result.branch) {
        // Initial branch value from the watcher
        refreshSessionBranch(activeSessionId);
      }
    };

    startBranchWatcher().catch(console.error);

    // Clean up: stop watching when session changes or component unmounts
    return () => {
      window.electronAPI.git.unwatchBranch(activeSessionId).catch(console.error);
    };
  }, [activeSession?.sshConfig, activeSessionId, refreshSessionBranch]);

  // Listen for branch change events from the file system watcher
  useEffect(() => {
    const unsubscribe = window.electronAPI.git.onBranchChanged(({ sessionId, branch }) => {
      console.log(`[StatusBar] Branch changed via fs.watch for session ${sessionId}: ${branch}`);
      // Update the session store with the new branch (for any session, not just active)
      updateSession(sessionId, { branch });
    });

    return unsubscribe;
  }, [updateSession]);

  // Track active Task tool calls (subagents)
  const activeTaskTools = useMemo(() => {
    return activeToolCalls.filter(tc => tc.name === 'Task' && (tc.status === 'running' || tc.status === 'pending'));
  }, [activeToolCalls]);

  const hasActiveSubagents = activeTaskTools.length > 0;

  useEffect(() => {
    window.electronAPI.docker.getStatus().then(setDockerStatus);
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadBranches = async () => {
    if (!activeSessionId) return;
    setLoadingBranches(true);
    try {
      const branchList = await window.electronAPI.git.getBranches(activeSessionId);
      setBranches(branchList);
    } catch (error) {
      console.error('Failed to load branches:', error);
    } finally {
      setLoadingBranches(false);
    }
  };

  const handleBranchClick = () => {
    if (!showBranchMenu) {
      loadBranches();
    }
    setShowBranchMenu(!showBranchMenu);
  };

  const handleBranchSwitch = async (branchName: string) => {
    if (!activeSessionId || !activeSession || branchName === activeSession.branch) {
      setShowBranchMenu(false);
      return;
    }

    setSwitchingBranch(true);
    try {
      await window.electronAPI.git.checkout(activeSessionId, branchName);
      // Update the session with new branch
      await updateSession(activeSessionId, { branch: branchName });
      setShowBranchMenu(false);
    } catch (error) {
      console.error('Failed to switch branch:', error);
    } finally {
      setSwitchingBranch(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-diff-add';
      case 'stopped':
        return 'shadow-[inset_0_0_0_1.5px_#666666]';
      case 'error':
        return 'bg-diff-del';
      case 'starting':
      case 'stopping':
      case 'creating':
        return 'bg-amber';
      default:
        return 'shadow-[inset_0_0_0_1.5px_#666666]';
    }
  };

  return (
    <div className="h-[26px] flex-shrink-0 flex items-center gap-4 px-3.5 text-[11px] font-mono bg-ink-0 border-t border-line text-fg-4">
      {/* Left section */}
      <div className="flex items-center gap-4 min-w-0">
        {/* Branch dropdown */}
        {activeSession && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={handleBranchClick}
              disabled={switchingBranch}
              className="flex items-center gap-1.5 text-fg-3 hover:text-fg transition-colors disabled:opacity-50"
              title="Switch branch"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="flex-shrink-0">
                <circle cx="6" cy="6" r="2.2" />
                <circle cx="6" cy="18" r="2.2" />
                <circle cx="18" cy="8" r="2.2" />
                <path d="M6 8.2v7.6M18 10.2c0 4-3 5.8-9.8 6.6" />
              </svg>
              <span className="truncate max-w-[240px]">
                {switchingBranch ? 'switching…' : activeSession.branch}
              </span>
              <ChevronDown size={10} className={`transition-transform text-fg-5 ${showBranchMenu ? 'rotate-180' : ''}`} />
            </button>

            {/* Branch dropdown menu */}
            {showBranchMenu && (
              <div className="absolute bottom-full left-0 mb-1 w-64 max-h-64 overflow-y-auto py-1 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.35)] z-50">
                {loadingBranches ? (
                  <div className="px-3 py-2 text-fg-4">Loading branches...</div>
                ) : branches.length === 0 ? (
                  <div className="px-3 py-2 text-fg-4">No branches found</div>
                ) : (
                  branches.map((branch) => (
                    <button
                      key={branch.name}
                      onClick={() => handleBranchSwitch(branch.name)}
                      className={`w-full h-7 px-3 flex items-center gap-2 text-left hover:bg-claude-surface-hover transition-colors ${
                        branch.name === activeSession.branch ? 'text-fg' : 'text-fg-3'
                      }`}
                    >
                      {branch.name === activeSession.branch && (
                        <Check size={10} className="text-accent flex-shrink-0" />
                      )}
                      <span className={`truncate ${branch.name === activeSession.branch ? '' : 'ml-4'}`}>
                        {branch.name}
                      </span>
                      {branch.current && (
                        <span className="ml-auto text-[9.5px] text-fg-5">HEAD</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Ahead / behind upstream */}
        {activeSession && aheadBehind?.tracking && (
          <span className="tabular-nums" title="Commits ahead / behind upstream">
            ↑{aheadBehind.ahead} ↓{aheadBehind.behind}
          </span>
        )}

        {/* Session status — only surfaced when it's not the normal running state */}
        {activeSession && activeSession.status !== 'running' && (
          <div className="flex items-center gap-1.5" title="Session status">
            <span
              className={`w-1.5 h-1.5 rounded-full ${getStatusColor(activeSession.status)} ${
                activeSession.status === 'starting' ||
                activeSession.status === 'stopping' ||
                activeSession.status === 'creating'
                  ? 'animate-pulse'
                  : ''
              }`}
            />
            <span>{activeSession.status}</span>
          </div>
        )}

        {/* Dev instance */}
        {isDevMode && DEV_INSTANCE_NAME && (
          <span className="flex items-center gap-1.5" title={`Dev instance${activeSession ? ` · session ${activeSession.status}` : ''}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${activeSession && activeSession.status !== 'running' ? getStatusColor(activeSession.status) : 'bg-diff-add'}`} />
            <span className="text-fg-3">{DEV_INSTANCE_NAME}</span>
          </span>
        )}

        {/* Docker status — only when docker is actually available */}
        {dockerStatus?.available && (
          <div className="flex items-center gap-1.5" title="Docker">
            <span className="w-1.5 h-1.5 rounded-full bg-diff-add" />
            <span>docker {dockerStatus.version || ''}</span>
          </div>
        )}

        {/* Subagent indicator */}
        {activeSession && hasActiveSubagents && (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" />
            <span className="text-accent-text">
              agent: {activeTaskTools.length > 1
                ? `${activeTaskTools.length} active`
                : (getSubagentType(activeTaskTools[0].input) || 'TASK').toLowerCase()}
            </span>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-4">
        {/* Singleton transport controller; its visible control lives in the active composer. */}
        <VoiceModeErrorBoundary>
          <MicrophoneButton />
        </VoiceModeErrorBoundary>

        {/* Context window meter */}
        {activeSession && contextUsage && contextUsage.contextWindowSize > 0 && (() => {
          const pct = Math.max(0, Math.min(100, Math.round(contextUsage.percentage)));
          const fill = pct >= 90 ? 'bg-diff-del' : pct >= 75 ? 'bg-amber' : 'bg-fg-3';
          return (
            <span
              className="flex items-center gap-1.5"
              title={`Context: ${contextUsage.inputTokens.toLocaleString()} / ${contextUsage.contextWindowSize.toLocaleString()} tokens`}
            >
              ctx
              <span className="w-12 h-1 bg-[#262626] overflow-hidden flex">
                <span className={fill} style={{ width: `${pct}%` }} />
              </span>
              <span className="tabular-nums">{pct}%</span>
            </span>
          );
        })()}

        {activeSession && <CostBadge />}

        {todayCost !== null && todayCost > 0 && (
          <span className="tabular-nums" title="Spend today (all sessions)">
            ${todayCost.toFixed(2)} today
          </span>
        )}

        {activeSession?.status === 'running' && !!activeSession.ports?.web && (
          <span title="Web port">
            :{activeSession.ports.web}
          </span>
        )}

        {updateInfo ? (
          <button
            onClick={() => window.electronAPI?.app.openExternal(updateInfo.downloadUrl)}
            className="flex items-center gap-1.5 text-accent-text hover:text-fg transition-colors"
            title={`v${updateInfo.version} available — click to download${updateInfo.releaseNotes ? '\n\n' + updateInfo.releaseNotes.slice(0, 200) : ''}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" />
            <span>update v{updateInfo.version}</span>
          </button>
        ) : (
          <span className="text-fg-5">v{appVersion}</span>
        )}
      </div>
    </div>
  );
}
