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
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-ink-1 p-6 text-center">
        <p className="text-[13px] text-diff-del-text">Browser tab failed to initialize.</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="h-8 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-white/5"
        >
          Retry browser tab
        </button>
      </div>
    );
  }
}
