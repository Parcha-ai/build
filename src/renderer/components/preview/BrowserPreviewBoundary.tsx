import React from 'react';

interface BrowserPreviewBoundaryProps {
  tabId: string;
  children: React.ReactNode;
}

interface BrowserPreviewBoundaryState {
  error: Error | null;
}

export default class BrowserPreviewBoundary extends React.Component<BrowserPreviewBoundaryProps, BrowserPreviewBoundaryState> {
  state: BrowserPreviewBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BrowserPreviewBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[BrowserPreviewBoundary] Browser tab failed without crashing the app:', error);
  }

  componentDidUpdate(previousProps: BrowserPreviewBoundaryProps): void {
    if (previousProps.tabId !== this.props.tabId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-claude-bg p-6 text-center">
        <p className="text-xs font-mono text-red-400">Browser tab failed to initialize.</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="border border-claude-border px-3 py-1.5 text-xs font-mono text-claude-text hover:bg-claude-surface"
        >
          Retry browser tab
        </button>
      </div>
    );
  }
}
