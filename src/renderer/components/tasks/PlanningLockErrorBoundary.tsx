import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface PlanningLockErrorBoundaryState {
  error: Error | null;
}

export default class PlanningLockErrorBoundary extends React.Component<React.PropsWithChildren, PlanningLockErrorBoundaryState> {
  state: PlanningLockErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PlanningLockErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[PlanningLockErrorBoundary] Planner render failed:', error, errorInfo);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="fixed inset-0 z-[100000] bg-black/95 flex items-center justify-center p-4">
        <div className="w-full max-w-lg border-2 border-red-500/70 bg-claude-surface p-7 text-center">
          <AlertTriangle size={36} className="mx-auto text-red-400" />
          <h2 className="mt-4 text-lg font-bold uppercase tracking-wider text-red-300">Planner needs to reload</h2>
          <p className="mt-2 text-xs text-claude-text-secondary">
            Build caught a planner error. Your tasks and timer remain saved.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 w-full bg-emerald-500 px-5 py-3 text-xs font-mono font-bold uppercase text-white hover:bg-emerald-400"
            style={{ borderRadius: 0 }}
          >
            Reload Planner
          </button>
        </div>
      </div>
    );
  }
}
