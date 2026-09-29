// Configure Monaco FIRST before any other imports
import './monaco-config';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { useAuthStore } from './stores/auth.store';
import { useSessionStore } from './stores/session.store';
import { useUIStore } from './stores/ui.store';
import { useAudioStore } from './stores/audio.store';
import './styles/globals.css';

// Create React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

// Get root element
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

// Create root and render app
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);

// Expose a minimal test bridge for renderer smoke tests driven via Electron CDP.
if (typeof window !== 'undefined') {
  window.__GREP_TEST__ = {
    useAuthStore,
    useSessionStore,
    useUIStore,
    useAudioStore,
  };
}

// Declare the global electron API type
declare global {
  interface Window {
    electronAPI: import('../main/preload').ElectronAPI;
    __GREP_TEST__?: {
      useAuthStore: typeof useAuthStore;
      useSessionStore: typeof useSessionStore;
      useUIStore: typeof useUIStore;
      useAudioStore: typeof useAudioStore;
    };
  }
}
