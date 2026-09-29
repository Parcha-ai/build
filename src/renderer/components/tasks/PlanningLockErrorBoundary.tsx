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
        <div className="w-full max-w-lg bg-ink-2 p-7 text-center shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45),0_16px_40px_rgba(0,0,0,0.4)]">
          <AlertTriangle size={36} className="mx-auto text-diff-del" />
          <h2 className="mt-4 text-[18px] font-semibold tracking-tight text-fg">Planner needs to reload</h2>
          <p className="mt-2 text-[13px] text-fg-3">
            Build caught a planner error. Your tasks and timer remain saved.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 h-9 w-full bg-fg px-5 text-[13px] font-semibold text-ink-0 hover:bg-white"
            style={{ borderRadius: 0 }}
          >
            Reload Planner
          </button>
        </div>
      </div>
    );
  }
}
