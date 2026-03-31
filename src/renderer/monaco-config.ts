// Monaco configuration for Electron - load from local node_modules via custom protocol
// This must be imported BEFORE any Monaco Editor components are used

// FIRST: Suppress Monaco's TextModel disposal race condition error
// This is a known issue with @monaco-editor/react and is harmless
// See: https://github.com/suren-atoyan/monaco-react/issues/290
// Must be set up BEFORE Monaco loads to catch all errors
if (typeof window !== 'undefined') {
  // Monaco errors to suppress - these are known race conditions that are harmless
  const MONACO_ERRORS_TO_SUPPRESS = [
    'TextModel got disposed before DiffEditorWidget model got reset',
    'no diff result available',
    'Diff editor requires a model',
    'Cannot read properties of disposed',
    'Cannot read properties of null',
    'DISPOSED',
  ];

  const isMonacoError = (message: string): boolean => {
    return MONACO_ERRORS_TO_SUPPRESS.some(pattern => message.includes(pattern));
  };

  // Use window.onerror - fires BEFORE addEventListener and can prevent React overlay
  const originalOnerror = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    const errorMessage = String(message || error?.message || '');
    const errorSource = String(source || '');

    // Check if it's a Monaco error (from monaco-asset:// or contains our patterns)
    if (isMonacoError(errorMessage) || (errorSource.includes('monaco') && isMonacoError(errorMessage))) {
      return true; // Returning true prevents default error handling
    }

    // Call original handler if exists
    if (originalOnerror) {
      return originalOnerror(message, source, lineno, colno, error);
    }
    return false;
  };

  // Suppress thrown errors (prevents React error overlay)
  window.addEventListener('error', (event) => {
    // Check both event.message and event.error?.message
    const message = event.message || event.error?.message || '';
    const filename = event.filename || '';

    if (isMonacoError(message) || (filename.includes('monaco') && isMonacoError(message))) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return false;
    }
  }, true); // Use capture phase to catch early

  // Suppress unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason?.message || event.reason?.toString?.() || '';
    if (isMonacoError(message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return false;
    }
  }, true);

  // Suppress console.error version
  const originalError = console.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.error = (...args: any[]) => {
    const message = args.map(a => String(a ?? '')).join(' ');
    if (isMonacoError(message)) {
      return;
    }
    originalError.apply(console, args);
  };

  // Also suppress console.warn for Monaco warnings
  const originalWarn = console.warn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.warn = (...args: any[]) => {
    const message = args.map(a => String(a ?? '')).join(' ');
    if (isMonacoError(message)) {
      return;
    }
    originalWarn.apply(console, args);
  };

  // Disable React error overlay for Monaco errors in development
  // This works with react-error-overlay used by webpack
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyWindow = window as any;
  if (anyWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__) {
    const originalHook = anyWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__;
    anyWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__ = {
      ...originalHook,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleRuntimeError: (error: any) => {
        const message = error?.message || String(error);
        if (isMonacoError(message)) {
          return; // Suppress Monaco errors
        }
        if (originalHook?.handleRuntimeError) {
          originalHook.handleRuntimeError(error);
        }
      },
    };
  }
}

import { loader } from '@monaco-editor/react';

const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

if (hasElectronAPI) {
  // Electron serves Monaco from the custom monaco-asset:// protocol.
  // In plain browser mode this protocol does not exist, so configuring it
  // during startup can break the production web build before React renders.
  loader.config({
    paths: {
      vs: 'monaco-asset://app/node_modules/monaco-editor/min/vs',
    },
  });

  // Initialize Monaco and configure custom theme.
  loader.init().then((monaco) => {
    monaco.editor.defineTheme('claudette-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1a1a2e',
      },
    });
  }).catch((err) => {
    console.error('[Monaco] Failed to initialize:', err);
  });
}

export {};
