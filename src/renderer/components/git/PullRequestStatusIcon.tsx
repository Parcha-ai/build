import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp, GitPullRequest, GitPullRequestArrow, GitPullRequestDraft } from 'lucide-react';
import type { PullRequestStatus } from '../../../shared/types';
import { useSessionStore } from '../../stores/session.store';

interface PullRequestStatusIconProps {
  sessionId: string;
  branch?: string;
  size?: number;
  interactive?: boolean;
  className?: string;
}

function getIteratingReason(status: PullRequestStatus): string {
  if (status.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (status.checks === 'failing') return 'checks failing';
  if (status.checks === 'pending') return 'checks pending';
  if (status.mergeable === 'CONFLICTING' || status.mergeStateStatus === 'DIRTY') return 'has conflicts';
  if (status.mergeStateStatus === 'BEHIND') return 'branch behind';
  return 'iteration in progress';
}

function getStatusPresentation(status: PullRequestStatus) {
  if (status.lifecycle === 'draft') {
    return {
      Icon: GitPullRequestDraft,
      className: 'text-slate-400',
      label: `Draft PR #${status.number}`,
    };
  }
  if (status.lifecycle === 'iterating') {
    return {
      Icon: GitPullRequestArrow,
      className: 'text-amber-400',
      label: `PR #${status.number} iterating · ${getIteratingReason(status)}`,
    };
  }
  return {
    Icon: GitPullRequest,
    className: 'text-emerald-400',
    label: status.reviewDecision === 'APPROVED'
      ? `PR #${status.number} approved`
      : `PR #${status.number} ready for review`,
  };
}

export default function PullRequestStatusIcon({
  sessionId,
  branch,
  size = 12,
  interactive = true,
  className = '',
}: PullRequestStatusIconProps) {
  const isStreaming = useSessionStore((state) => Boolean(state.isStreaming[sessionId]));
  const wasStreaming = useRef(isStreaming);
  const { data: result, refetch } = useQuery({
    queryKey: ['pull-request-status', sessionId, branch || ''],
    queryFn: () => window.electronAPI.git.getPullRequestStatus(sessionId),
    enabled: Boolean(sessionId && branch),
    staleTime: 5 * 60_000,
    refetchInterval: isStreaming ? false : 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      void refetch();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, refetch]);

  if (result && !result.available) {
    return (
      <span
        className={`inline-flex flex-shrink-0 items-center text-claude-text-secondary/40 ${className}`}
        title="PR status unavailable · authenticate GitHub CLI locally or on the remote host"
        aria-label="Pull request status unavailable"
      >
        <CircleHelp size={size} aria-hidden="true" />
      </span>
    );
  }

  const status = result?.status;
  if (!status) return null;
  const { Icon, className: statusClassName, label } = getStatusPresentation(status);
  const title = `${label} · ${status.title}`;
  const icon = <Icon size={size} aria-hidden="true" />;

  if (!interactive) {
    return (
      <span
        className={`inline-flex flex-shrink-0 items-center ${statusClassName} ${className}`}
        title={title}
        aria-label={label}
      >
        {icon}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`inline-flex flex-shrink-0 items-center hover:brightness-125 ${statusClassName} ${className}`}
      title={`${title} · Open on GitHub`}
      aria-label={`${label}: open on GitHub`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void window.electronAPI.app.openExternal(status.url);
      }}
    >
      {icon}
    </button>
  );
}
