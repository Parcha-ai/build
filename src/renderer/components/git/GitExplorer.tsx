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
  Plus,
  Minus,
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
      <div className="h-full flex items-center justify-center bg-claude-bg text-claude-text-secondary">
        <p>Start the session to view git</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-claude-bg">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-claude-border bg-claude-surface">
        <div className="flex items-center gap-2">
          <GitBranch size={18} className="text-claude-accent" />
          <span className="font-medium font-mono">{status?.current || session.branch}</span>
          {(status?.ahead ?? 0) > 0 && (
            <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-500 rounded">
              ↑{status?.ahead}
            </span>
          )}
          {(status?.behind ?? 0) > 0 && (
            <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-500 rounded">
              ↓{status?.behind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePull}
            className="p-1.5 rounded hover:bg-claude-bg transition-colors"
            title="Pull"
          >
            <Download size={16} />
          </button>
          <button
            onClick={handlePush}
            className="p-1.5 rounded hover:bg-claude-bg transition-colors"
            title="Push"
          >
            <Upload size={16} />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded hover:bg-claude-bg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-claude-border bg-claude-surface">
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
      className={`flex items-center gap-1.5 px-4 py-2 text-sm transition-colors ${
        active
          ? 'text-claude-text border-b-2 border-claude-accent'
          : 'text-claude-text-secondary hover:text-claude-text'
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
      <div className="p-4 text-claude-text-secondary text-center">
        Loading commits...
      </div>
    );
  }

  return (
    <div className="relative pl-6">
      {/* Timeline line */}
      <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-claude-border" />

      {commits.map((commit, index) => (
        <div
          key={commit.hash}
          onClick={() => onSelectCommit(selectedCommit === commit.hash ? null : commit.hash)}
          className={`relative py-3 px-4 cursor-pointer transition-colors ${
            selectedCommit === commit.hash
              ? 'bg-claude-accent/10'
              : 'hover:bg-claude-surface'
          }`}
        >
          {/* Commit dot */}
          <div className="absolute left-2.5 top-5 w-3 h-3 rounded-full bg-claude-accent border-2 border-claude-bg" />

          <div className="ml-4">
            <div className="flex items-center gap-2 text-xs text-claude-text-secondary mb-1">
              <code className="text-blue-400">{commit.hash.slice(0, 7)}</code>
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {formatDate(commit.date)}
              </span>
            </div>
            <p className="text-sm font-medium line-clamp-2">{commit.message}</p>
            <div className="flex items-center gap-1 mt-1 text-xs text-claude-text-secondary">
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
          <h4 className="text-xs font-semibold text-claude-text-secondary uppercase tracking-wider px-2 mb-2">
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
          <h4 className="text-xs font-semibold text-claude-text-secondary uppercase tracking-wider px-2 mb-2">
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
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${
        isCurrent
          ? 'bg-claude-accent/20 text-claude-accent'
          : 'hover:bg-claude-surface'
      }`}
    >
      <GitBranch size={14} />
      <span className="font-mono">{branch.name}</span>
      {isCurrent && (
        <span className="ml-auto text-xs bg-claude-accent/20 px-1.5 py-0.5 rounded">
          current
        </span>
      )}
    </button>
  );
}

function ChangesList({ files, diff }: { files: any[]; diff: string }) {
  if (files.length === 0) {
    return (
      <div className="p-4 text-claude-text-secondary text-center">
        No changes
      </div>
    );
  }

  return (
    <div className="p-2">
      {files.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-claude-surface text-sm"
        >
          <StatusIcon status={file.status} />
          <span className="font-mono truncate">{file.path}</span>
        </div>
      ))}

      {diff && (
        <div className="mt-4 border-t border-claude-border pt-4">
          <pre className="text-xs font-mono overflow-x-auto p-2 bg-claude-surface rounded">
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
      return <Plus size={14} className="text-green-500" />;
    case 'deleted':
      return <Minus size={14} className="text-red-500" />;
    case 'modified':
      return <FileCode size={14} className="text-yellow-500" />;
    default:
      return <FileCode size={14} className="text-claude-text-secondary" />;
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
        <div className="h-full flex flex-col items-center justify-center gap-2 bg-claude-bg text-claude-text-secondary p-4">
          <p className="text-sm">Git panel hit an error.</p>
          <p className="text-xs font-mono text-red-400 text-center break-all">
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-3 py-1.5 text-xs border border-claude-border rounded hover:bg-claude-surface"
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
