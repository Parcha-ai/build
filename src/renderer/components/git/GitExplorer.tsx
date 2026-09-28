import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { withMaterializedSession } from '../../stores/session.store';
import {
  GitBranch,
  GitCommit,
  GitMerge,
  ChevronDown,
  Clock,
  User,
  FileCode,
  RefreshCw,
  Upload,
  Download,
} from 'lucide-react';
import type { Session, Commit, Branch } from '../../../shared/types';

interface GitExplorerProps {
  session: Session;
}

export default function GitExplorer({ session }: GitExplorerProps) {
  return (
    <GitPanelErrorBoundary>
      <GitExplorerContent session={session} />
    </GitPanelErrorBoundary>
  );
}

function GitExplorerContent({ session }: GitExplorerProps) {
  const [activeTab, setActiveTab] = useState<'history' | 'branches' | 'changes'>('history');
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  const { data: commits, isLoading: commitsLoading, refetch: refetchCommits } = useQuery({
    queryKey: ['git-log', session.id],
    queryFn: () => withMaterializedSession(session.id, () => window.electronAPI.git.getLog(session.id, 100)),
    enabled: session.status === 'running',
  });

  const { data: branches, refetch: refetchBranches } = useQuery({
    queryKey: ['git-branches', session.id],
    queryFn: () => withMaterializedSession(session.id, () => window.electronAPI.git.getBranches(session.id)),
    enabled: session.status === 'running',
  });

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['git-status', session.id],
    queryFn: () => withMaterializedSession(session.id, () => window.electronAPI.git.getStatus(session.id)),
    enabled: session.status === 'running',
    refetchInterval: 5000,
  });

  const { data: diff } = useQuery({
    queryKey: ['git-diff', session.id, selectedCommit],
    queryFn: () => withMaterializedSession(session.id, () => window.electronAPI.git.getDiff(session.id, selectedCommit || undefined)),
    enabled: session.status === 'running',
  });

  const handleRefresh = () => {
    refetchCommits();
    refetchBranches();
    refetchStatus();
  };

  const handlePush = async () => {
    try {
      await withMaterializedSession(session.id, () => window.electronAPI.git.push(session.id));
    } catch (error) {
      console.error('[GitExplorer] Push failed:', error);
    }
    handleRefresh();
  };

  const handlePull = async () => {
    try {
      await withMaterializedSession(session.id, () => window.electronAPI.git.pull(session.id));
    } catch (error) {
      console.error('[GitExplorer] Pull failed:', error);
    }
    handleRefresh();
  };

  if (session.status !== 'running') {
    return (
      <div className="h-full flex items-center justify-center bg-ink-1 text-fg-4 text-[13px]">
        <p>Start the session to view git</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-ink-1">
      {/* Header */}
      <div className="h-11 flex items-center justify-between px-3 border-b border-line bg-ink-1">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={14} className="text-fg-4 flex-shrink-0" />
          <span className="font-mono text-[12px] text-fg-2 truncate">{status?.current || session.branch}</span>
          {(status?.ahead ?? 0) > 0 && (
            <span className="font-mono text-[11px] text-diff-add">
              ↑{status?.ahead}
            </span>
          )}
          {(status?.behind ?? 0) > 0 && (
            <span className="font-mono text-[11px] text-amber">
              ↓{status?.behind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePull}
            className="w-7 h-7 flex items-center justify-center text-fg-4 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            title="Pull"
          >
            <Download size={14} />
          </button>
          <button
            onClick={handlePush}
            className="w-7 h-7 flex items-center justify-center text-fg-4 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            title="Push"
          >
            <Upload size={14} />
          </button>
          <button
            onClick={handleRefresh}
            className="w-7 h-7 flex items-center justify-center text-fg-4 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line bg-ink-1">
        <TabButton
          active={activeTab === 'history'}
          onClick={() => setActiveTab('history')}
          icon={<GitCommit size={14} />}
          label="History"
        />
        <TabButton
          active={activeTab === 'branches'}
          onClick={() => setActiveTab('branches')}
          icon={<GitMerge size={14} />}
          label="Branches"
        />
        <TabButton
          active={activeTab === 'changes'}
          onClick={() => setActiveTab('changes')}
          icon={<FileCode size={14} />}
          label={`Changes${status?.files?.length ? ` (${status.files.length})` : ''}`}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'history' && (
          <CommitHistory
            commits={Array.isArray(commits) ? commits : []}
            isLoading={commitsLoading}
            selectedCommit={selectedCommit}
            onSelectCommit={setSelectedCommit}
          />
        )}
        {activeTab === 'branches' && (
          <BranchList
            branches={Array.isArray(branches) ? branches : []}
            currentBranch={status?.current}
            onCheckout={(branch) => {
              window.electronAPI.git.checkout(session.id, branch)
                .then(() => handleRefresh())
                .catch((error) => console.error('[GitExplorer] Checkout failed:', error));
            }}
          />
        )}
        {activeTab === 'changes' && (
          <ChangesList
            files={Array.isArray(status?.files) ? status.files : []}
            diff={typeof diff === 'string' ? diff : ''}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] transition-colors ${
        active
          ? 'bg-[#262626] text-fg'
          : 'text-fg-4 hover:text-fg-2'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function CommitHistory({
  commits,
  isLoading,
  selectedCommit,
  onSelectCommit,
}: {
  commits: Commit[];
  isLoading: boolean;
  selectedCommit: string | null;
  onSelectCommit: (hash: string | null) => void;
}) {
  if (isLoading) {
    return (
      <div className="p-4 text-fg-4 text-[13px] text-center">
        Loading commits...
      </div>
    );
  }

  return (
    <div className="relative pl-6">
      {/* Timeline line */}
      <div className="absolute left-4 top-0 bottom-0 w-px bg-line-strong" />

      {commits.map((commit, index) => (
        <div
          key={commit.hash}
          onClick={() => onSelectCommit(selectedCommit === commit.hash ? null : commit.hash)}
          className={`relative py-2.5 px-4 cursor-pointer transition-colors ${
            selectedCommit === commit.hash
              ? 'bg-claude-surface-hover'
              : 'hover:bg-claude-surface-hover'
          }`}
        >
          {/* Commit dot */}
          <div className="absolute left-[13px] top-[17px] w-[7px] h-[7px] rounded-full bg-fg-4" />

          <div className="ml-4">
            <div className="flex items-center gap-2 font-mono text-[11px] text-fg-4 mb-1">
              <code className="text-accent-text">{commit.hash.slice(0, 7)}</code>
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {formatDate(commit.date)}
              </span>
            </div>
            <p className="text-[13px] text-fg line-clamp-2">{commit.message}</p>
            <div className="flex items-center gap-1 mt-1 text-[11.5px] text-fg-4">
              <User size={12} />
              {commit.author}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BranchList({
  branches,
  currentBranch,
  onCheckout,
}: {
  branches: Branch[];
  currentBranch?: string | null;
  onCheckout: (branch: string) => void;
}) {
  const localBranches = branches.filter((b) => !b.remote);
  const remoteBranches = branches.filter((b) => b.remote);

  return (
    <div className="p-2">
      {localBranches.length > 0 && (
        <div className="mb-4">
          <h4 className="text-[11px] text-fg-4 uppercase tracking-[0.04em] px-2 mb-1.5">
            Local Branches
          </h4>
          {localBranches.map((branch) => (
            <BranchItem
              key={branch.name}
              branch={branch}
              isCurrent={branch.name === currentBranch}
              onCheckout={() => onCheckout(branch.name)}
            />
          ))}
        </div>
      )}

      {remoteBranches.length > 0 && (
        <div>
          <h4 className="text-[11px] text-fg-4 uppercase tracking-[0.04em] px-2 mb-1.5">
            Remote Branches
          </h4>
          {remoteBranches.map((branch) => (
            <BranchItem
              key={branch.name}
              branch={branch}
              isCurrent={false}
              onCheckout={() => onCheckout(branch.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchItem({
  branch,
  isCurrent,
  onCheckout,
}: {
  branch: Branch;
  isCurrent: boolean;
  onCheckout: () => void;
}) {
  return (
    <button
      onClick={onCheckout}
      disabled={isCurrent}
      className={`w-full h-8 flex items-center gap-2 px-2 text-left text-[13px] transition-colors ${
        isCurrent
          ? 'bg-claude-surface-hover text-fg'
          : 'text-fg-2 hover:bg-claude-surface-hover'
      }`}
    >
      <GitBranch size={14} />
      <span className="font-mono text-[12px] truncate">{branch.name}</span>
      {isCurrent && (
        <span className="ml-auto font-mono text-[9.5px] uppercase text-fg-3 px-1.5 py-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">
          current
        </span>
      )}
    </button>
  );
}

function ChangesList({ files, diff }: { files: any[]; diff: string }) {
  if (files.length === 0) {
    return (
      <div className="p-4 text-fg-4 text-[13px] text-center">
        No changes
      </div>
    );
  }

  return (
    <div className="p-2">
      {files.map((file) => (
        <div
          key={file.path}
          className="h-8 flex items-center gap-2 px-2 hover:bg-claude-surface-hover text-[13px]"
        >
          <StatusIcon status={file.status} />
          <span className="font-mono text-[12px] text-fg-2 truncate">{file.path}</span>
        </div>
      ))}

      {diff && (
        <div className="mt-3 border-t border-line pt-3">
          <pre className="text-[11.5px] leading-[1.6] font-mono text-fg-3 overflow-x-auto p-3 bg-[#0B0B0B]">
            {diff.slice(0, 2000)}
            {diff.length > 2000 && '...'}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'added':
      return <span className="w-3.5 flex-shrink-0 text-center font-mono text-[11px] font-medium text-diff-add" title="Added">A</span>;
    case 'deleted':
      return <span className="w-3.5 flex-shrink-0 text-center font-mono text-[11px] font-medium text-diff-del" title="Deleted">D</span>;
    case 'modified':
      return <span className="w-3.5 flex-shrink-0 text-center font-mono text-[11px] font-medium text-amber" title="Modified">M</span>;
    default:
      return (
        <span className="w-3.5 flex-shrink-0 text-center font-mono text-[11px] font-medium text-fg-4" title={status}>
          {(status || '?').charAt(0).toUpperCase()}
        </span>
      );
  }
}

// Contains crashes to the git panel so a render error here can never
// unmount the whole app (React tears down to the nearest boundary).
class GitPanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[GitExplorer] Panel crashed:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-2 bg-ink-1 text-fg-3 p-4">
          <p className="text-[13px]">Git panel hit an error.</p>
          <p className="text-[11.5px] font-mono text-diff-del-text text-center break-all">
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 h-8 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/5"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatDate(date: Date): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString();
}
