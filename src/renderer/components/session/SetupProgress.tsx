import React from 'react';
import { Loader2, CheckCircle2, AlertCircle, Terminal } from 'lucide-react';
import type { Session, SetupProgressEvent } from '../../../shared/types';

interface SetupProgressProps {
  session: Session;
  progress?: SetupProgressEvent | null;
}

export default function SetupProgress({ session, progress }: SetupProgressProps) {
  // Determine display status
  const isRunning = session.status === 'setup' || progress?.status === 'running';
  const isCompleted = progress?.status === 'completed';
  const isError = progress?.status === 'error';

  return (
    <div className="h-full flex flex-col bg-claude-bg p-4 overflow-hidden">
      {/* Header section - compact */}
      <div className="flex items-center gap-4 mb-4 shrink-0">
        {/* Status Icon */}
        <div className="shrink-0">
          {isRunning && (
            <div className="w-12 h-12 bg-accent/10 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-claude-accent animate-spin" />
            </div>
          )}
          {isCompleted && (
            <div className="w-12 h-12 bg-diff-add/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-diff-add" />
            </div>
          )}
          {isError && (
            <div className="w-12 h-12 bg-diff-del/10 flex items-center justify-center">
              <AlertCircle className="w-6 h-6 text-diff-del" />
            </div>
          )}
        </div>

        {/* Title and session info */}
        <div className="flex-1 min-w-0">
          <h2 className="text-[16px] font-semibold tracking-tight text-fg">
            {isRunning && 'Setting Up Worktree'}
            {isCompleted && 'Setup Complete'}
            {isError && 'Setup Failed'}
          </h2>
          <div className="text-[12px] text-fg-4 mt-1 flex items-center gap-3 flex-wrap">
            <span className="font-mono truncate" title={session.worktreePath}>
              {session.worktreePath}
            </span>
            {session.branch && (
              <span className="text-accent-text font-mono">
                {session.branch}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Progress indicator */}
      {isRunning && (
        <div className="mb-3 shrink-0">
          <div className="flex items-center gap-2 text-[12px] text-fg-3 mb-1">
            <Terminal size={12} />
            <span>{progress?.message || 'Running setup script...'}</span>
          </div>
          <div className="w-full bg-ink-4 h-1" style={{ borderRadius: 0 }}>
            <div className="bg-accent h-full animate-pulse" style={{ width: '60%', borderRadius: 0 }} />
          </div>
        </div>
      )}

      {/* Output area - fills remaining space and scrolls */}
      {progress?.output && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-1 shrink-0">
            OUTPUT
          </div>
          <pre className="flex-1 p-3 bg-ink-term shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-[11.5px] font-mono text-fg-2 overflow-auto whitespace-pre-wrap" style={{ borderRadius: 0 }}>
            {progress.output}
          </pre>
        </div>
      )}

      {/* Error message when no output */}
      {isError && !progress?.output && (
        <div className="p-3 bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)] text-[12px] text-diff-del-text shrink-0">
          {progress?.error || 'The setup script encountered an error.'}
        </div>
      )}

      {/* Completed message */}
      {isCompleted && !progress?.output && (
        <div className="p-3 bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.35)] text-[12px] text-diff-add-text shrink-0">
          Your workspace is ready to use.
        </div>
      )}
    </div>
  );
}
