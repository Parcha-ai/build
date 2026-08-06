import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Keeps a voice transport/render failure from taking down the composer. */
export class VoiceModeErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[VoiceModeErrorBoundary] Uncaught voice error:', error, errorInfo);
  }

  public render() {
    if (!this.state.hasError) return this.props.children;
    return this.props.fallback || (
      <div className="text-xs text-red-500">
        Voice mode error: {this.state.error?.message || 'Unknown error'}
      </div>
    );
  }
}
