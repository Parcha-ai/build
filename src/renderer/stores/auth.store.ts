import { create } from 'zustand';
import type { GitHubUser, GitHubRepo } from '../../shared/types';

// Check if running in Electron environment
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

interface AuthState {
  user: GitHubUser | null;
  repos: GitHubRepo[];
  isLoading: boolean;
  error: string | null;
  isDevMode: boolean;

  checkAuth: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  loadRepos: () => Promise<void>;
  setDevMode: (enabled: boolean) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  repos: [],
  isLoading: true,
  error: null,
  isDevMode: false,

  checkAuth: async () => {
    if (!hasElectronAPI) {
      set({ isLoading: false });
      return;
    }
    // Skip auth gate — go straight to the app in dev mode
    set({ isDevMode: true, isLoading: false });
    if (hasElectronAPI) {
      window.electronAPI.dev.setDevMode(true);
    }
  },

  login: async () => {
    if (!hasElectronAPI) return;
    set({ isLoading: true, error: null });
    try {
      await window.electronAPI.auth.login();
      await get().checkAuth();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Login failed',
        isLoading: false,
      });
    }
  },

  logout: async () => {
    if (!hasElectronAPI) return;
    set({ isLoading: true, error: null });
    try {
      await window.electronAPI.auth.logout();
      set({ user: null, repos: [], isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Logout failed',
        isLoading: false,
      });
    }
  },

  loadRepos: async () => {
    if (!hasElectronAPI) return;
    try {
      const repos = await window.electronAPI.auth.getRepos();
      if (!Array.isArray(repos)) {
        set({
          repos: [],
          error: 'GitHub repository response was not a list',
        });
        throw new Error('GitHub repository response was not a list');
      }
      set({ repos, error: null });
    } catch (error) {
      console.error('Failed to load repos:', error);
      set({
        repos: [],
        error: error instanceof Error ? error.message : 'Failed to load repositories',
      });
      throw error;
    }
  },

  setDevMode: (enabled: boolean) => {
    set({ isDevMode: enabled, isLoading: false });
    // Persist to electron-store (only if running in Electron)
    if (hasElectronAPI) {
      window.electronAPI.dev.setDevMode(enabled);
    }
  },
}));
