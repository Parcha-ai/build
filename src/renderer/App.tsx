import React, { useEffect, useLayoutEffect, useState, useMemo, memo } from 'react';
import { useAuthStore } from './stores/auth.store';
import { useSessionStore } from './stores/session.store';
import { useUIStore } from './stores/ui.store';
import { useEditorStore } from './stores/editor.store';
import { initializeTTSListeners, useAudioStore } from './stores/audio.store';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import StatusBar from './components/layout/StatusBar';
import LoginScreen from './components/auth/LoginScreen';
import SettingsDialog from './components/settings/SettingsDialog';
import ApiKeyOnboarding from './components/onboarding/ApiKeyOnboarding';
import QuickSearch from './components/editor/QuickSearch';
import FileContentSearch from './components/editor/FileContentSearch';
import SessionSwitcher from './components/session/SessionSwitcher';
import QMDPrompt from './components/qmd/QMDPrompt';
import LunchLockModal from './components/layout/LunchLockModal';
import BedtimeLockModal from './components/layout/BedtimeLockModal';
import DailyReviewModal from './components/tasks/DailyReviewModal';
import BedtimeTaskReviewModal from './components/tasks/BedtimeTaskReviewModal';
import { Terminal, Globe, PanelRight, Settings, PanelLeftClose, Monitor, AlertTriangle, Package, FileText, FileCode, ClipboardList, GitBranch, Plus } from 'lucide-react';
import OpenDesignIcon from './components/design/OpenDesignIcon';
import { getBrowserPartitionId } from '../shared/utils/browser-partition';
import { openLinkInAppBrowser } from './utils/open-link-in-browser';
import BrowserSessionTab from './components/preview/BrowserSessionTab';
import BrowserPreviewBoundary from './components/preview/BrowserPreviewBoundary';
import type { BrowserChatInsertPayload } from '../shared/types';

// Check if we're running in Electron (has electronAPI) or browser preview mode
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const PRIMARY_MODIFIER_KEY: 'metaKey' | 'ctrlKey' = /mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';
const DAILY_REVIEW_DONE_KEY = 'daily-review-date';
const DAILY_REVIEW_CLAIM_KEY = 'daily-review-active-window';
const DAILY_REVIEW_WINDOW_ID_KEY = 'daily-review-window-id';
const DAILY_REVIEW_CLAIM_TTL_MS = 6 * 60 * 60 * 1000;

function getDailyReviewWindowId() {
  try {
    const existing = window.sessionStorage.getItem(DAILY_REVIEW_WINDOW_ID_KEY);
    if (existing) return existing;
    const id = `window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(DAILY_REVIEW_WINDOW_ID_KEY, id);
    return id;
  } catch {
    return `window-${Date.now()}`;
  }
}

function claimDailyReviewWindow(today: string, windowId: string) {
  try {
    const raw = localStorage.getItem(DAILY_REVIEW_CLAIM_KEY);
    if (raw) {
      const claim = JSON.parse(raw) as { date?: string; windowId?: string; claimedAt?: number };
      const isCurrentDay = claim.date === today;
      const isFresh = typeof claim.claimedAt === 'number' && Date.now() - claim.claimedAt < DAILY_REVIEW_CLAIM_TTL_MS;
      if (isCurrentDay && isFresh && claim.windowId && claim.windowId !== windowId) {
        return false;
      }
    }

    localStorage.setItem(DAILY_REVIEW_CLAIM_KEY, JSON.stringify({
      date: today,
      windowId,
      claimedAt: Date.now(),
    }));
    return true;
  } catch {
    return true;
  }
}

function releaseDailyReviewWindow(windowId: string) {
  try {
    const raw = localStorage.getItem(DAILY_REVIEW_CLAIM_KEY);
    if (!raw) return;
    const claim = JSON.parse(raw) as { windowId?: string };
    if (claim.windowId === windowId) {
      localStorage.removeItem(DAILY_REVIEW_CLAIM_KEY);
    }
  } catch {
    localStorage.removeItem(DAILY_REVIEW_CLAIM_KEY);
  }
}

function parseTimeParts(value: string | undefined, fallbackHour: number, fallbackMinute: number) {
  const [rawHour, rawMinute] = (value || '').split(':').map(Number);
  const hour = Number.isFinite(rawHour) ? rawHour : fallbackHour;
  const minute = Number.isFinite(rawMinute) ? rawMinute : fallbackMinute;
  return { hour, minute };
}

// Preview Mode Component - shown when running outside Electron
function PreviewMode() {
  return (
    <div className="h-screen w-screen flex flex-col bg-claude-bg">
      {/* Preview mode banner */}
      <div className="h-10 bg-amber-500/20 border-b border-amber-500/50 flex items-center justify-center gap-2 px-4">
        <AlertTriangle size={16} className="text-amber-400" />
        <span className="text-amber-200 text-sm font-mono">
          PREVIEW MODE - Running outside Electron (no backend connection)
        </span>
      </div>

      {/* Mock UI */}
      <div className="flex-1 flex flex-col">
        {/* Title bar */}
        <div className="h-8 bg-claude-surface border-b border-claude-border flex items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Monitor size={14} className="text-claude-accent" />
            <span className="text-sm font-mono text-claude-text">CLAUDETTE</span>
          </div>
          <div className="flex items-center gap-2 text-claude-text-secondary">
            <Terminal size={14} />
            <Globe size={14} />
            <Settings size={14} />
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 flex">
          {/* Sidebar mock */}
          <div className="w-64 bg-claude-surface border-r border-claude-border p-4">
            <div className="text-xs font-mono text-claude-text-secondary mb-4" style={{ letterSpacing: '0.1em' }}>
              SESSIONS
            </div>
            <div className="space-y-2">
              {['claudette', 'my-project', 'demo-app'].map((name) => (
                <div
                  key={name}
                  className="px-3 py-2 bg-claude-bg border border-claude-border text-sm font-mono text-claude-text-secondary"
                  style={{ borderRadius: 0 }}
                >
                  {name}
                </div>
              ))}
            </div>
          </div>

          {/* Chat mock */}
          <div className="flex-1 flex flex-col">
            <div className="flex-1 p-4 space-y-4 overflow-auto">
              <p className="text-claude-text-secondary italic text-sm font-mono">
                Hello! How can I help you today?
              </p>
              <div className="text-claude-text font-mono text-sm">
                This is a preview of the Claudette UI. In preview mode, you can explore
                the interface but backend features (chat, terminal, git) are unavailable.
              </div>
              <div className="mt-8 p-4 border border-claude-border bg-claude-surface">
                <div className="text-xs font-mono text-claude-text-secondary mb-2" style={{ letterSpacing: '0.1em' }}>
                  PREVIEW MODE INFO
                </div>
                <ul className="text-sm font-mono text-claude-text-secondary space-y-1">
                  <li>• UI components render correctly</li>
                  <li>• No Electron IPC available</li>
                  <li>• No backend services</li>
                  <li>• Useful for UI development</li>
                </ul>
              </div>
            </div>

            {/* Input mock */}
            <div className="border-t border-claude-border p-4">
              <div className="flex items-center gap-2">
                <span className="text-green-400 font-bold">{'>>'}</span>
                <input
                  type="text"
                  placeholder="type here... (preview mode - not functional)"
                  disabled
                  className="flex-1 bg-transparent text-claude-text-secondary font-mono text-sm focus:outline-none"
                />
              </div>
              <div className="mt-1 text-[9px] text-claude-text-secondary font-mono" style={{ letterSpacing: '0.05em' }}>
                AUTO @ THINK @ FILE ENTER SEND
              </div>
            </div>
          </div>
        </div>

        {/* Status bar mock */}
        <div className="h-8 bg-claude-surface border-t border-claude-border flex items-center px-4 text-[11px] font-mono text-claude-text-secondary">
          <span className="text-amber-400">PREVIEW MODE</span>
          <div className="flex-1" />
          <span>CLAUDETTE v1.0.0</span>
        </div>
      </div>
    </div>
  );
}

// Helper: compute countdown state for a target time
function useCountdown(enabled: boolean, targetTime: string, loggedKey: string, windowMinutes: number) {
  const now = new Date();
  const today = now.toDateString();
  const logged = localStorage.getItem(loggedKey) === today;

  if (!enabled || logged) return null;

  const [targetHour, targetMinute] = targetTime.split(':').map(Number);
  const targetDate = new Date();
  targetDate.setHours(targetHour, targetMinute, 0, 0);
  const msUntil = targetDate.getTime() - now.getTime();
  const minutesUntil = Math.floor(msUntil / 60000);

  if (minutesUntil > windowMinutes || minutesUntil < 0) return null;

  const secondsUntil = Math.floor(msUntil / 1000);
  const minsLeft = Math.floor(secondsUntil / 60);
  const secsLeft = secondsUntil % 60;
  return { secondsUntil, display: `${minsLeft}:${secsLeft.toString().padStart(2, '0')}` };
}

// Isolated clock component — ticks every second without re-rendering the rest of the app
const StatusBarClock = memo(function StatusBarClock({
  lunchReminderEnabled, lunchTime,
  bedtimeReminderEnabled, bedtimeTime,
}: {
  lunchReminderEnabled: boolean; lunchTime: string;
  bedtimeReminderEnabled: boolean; bedtimeTime: string;
}) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const hours = currentTime.getHours();
  const minutes = currentTime.getMinutes();
  const seconds = currentTime.getSeconds();
  const normalTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  // Check lunch countdown
  const lunch = useCountdown(lunchReminderEnabled, lunchTime, 'lunch-logged-date', 30);

  // Check bedtime countdown (1 hour window)
  const bedtime = useCountdown(bedtimeReminderEnabled, bedtimeTime, 'bedtime-logged-date', 60);

  // Bedtime takes priority if both are active
  if (bedtime) {
    let color = 'text-white';
    if (bedtime.secondsUntil <= 60) color = 'text-red-500 font-bold';
    else if (bedtime.secondsUntil <= 300) color = 'text-red-500 font-bold';
    else if (bedtime.secondsUntil <= 1800) color = 'text-amber-500 font-bold';
    else color = 'text-indigo-400 font-bold';

    return (
      <div className={`flex items-center gap-2 font-mono text-base ${color} transition-colors`}>
        <span className="text-xs uppercase font-bold" style={{ letterSpacing: '0.1em' }}>BED IN</span>
        <span className="font-bold tabular-nums" style={{ letterSpacing: '0.05em' }}>{bedtime.display}</span>
      </div>
    );
  }

  if (lunch) {
    let color = 'text-white';
    if (lunch.secondsUntil <= 60) color = 'text-red-500 font-bold';
    else if (lunch.secondsUntil <= 300) color = 'text-red-500 font-bold';
    else if (lunch.secondsUntil <= 1800) color = 'text-amber-500 font-bold';

    return (
      <div className={`flex items-center gap-2 font-mono text-base ${color} transition-colors`}>
        <span className="text-xs uppercase font-bold" style={{ letterSpacing: '0.1em' }}>LUNCH IN</span>
        <span className="font-bold tabular-nums" style={{ letterSpacing: '0.05em' }}>{lunch.display}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 font-mono text-base text-white transition-colors">
      <span className="font-bold tabular-nums" style={{ letterSpacing: '0.05em' }}>{normalTime}</span>
    </div>
  );
});

// Main App component that requires Electron
function ElectronApp() {
  const { user, isLoading, isDevMode } = useAuthStore();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const isSidebarOpen = useUIStore((s) => s.isSidebarOpen);
  const isTerminalPanelOpen = useUIStore((s) => s.isTerminalPanelOpen);
  const isBrowserPanelOpen = useUIStore((s) => s.isBrowserPanelOpen);
  const isExtensionsPanelOpen = useUIStore((s) => s.isExtensionsPanelOpen);
  const isPlanPanelOpen = useUIStore((s) => s.isPlanPanelOpen);
  const isDesignPanelOpen = useUIStore((s) => s.isDesignPanelOpen);
  const isDesignTakeoverActive = useUIStore(
    (s) => !!(activeSessionId && s.sessionDesignTakeover[activeSessionId])
  );
  const isHtmlPanelOpen = useUIStore((s) => s.isHtmlPanelOpen);
  const isGitPanelOpen = useUIStore((s) => s.isGitPanelOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useUIStore((s) => s.toggleTerminalPanel);
  const toggleBrowserPanel = useUIStore((s) => s.toggleBrowserPanel);
  const toggleExtensionsPanel = useUIStore((s) => s.toggleExtensionsPanel);
  const togglePlanPanel = useUIStore((s) => s.togglePlanPanel);
  const toggleHtmlPanel = useUIStore((s) => s.toggleHtmlPanel);
  const toggleGitPanel = useUIStore((s) => s.toggleGitPanel);
  const cycleSplitRatio = useUIStore((s) => s.cycleSplitRatio);
  const openSettings = useUIStore((s) => s.openSettings);
  const hasApiKey = useUIStore((s) => s.hasApiKey);
  const setActivePanelSession = useUIStore((s) => s.setActivePanelSession);
  const isEditorOpen = useEditorStore((s) => s.isEditorOpen);
  const openEditor = useEditorStore((s) => s.openEditor);
  const closeEditor = useEditorStore((s) => s.closeEditor);
  const setActiveEditorSession = useEditorStore((s) => s.setActiveSession);

  // Panel layout and editor tabs belong to the exact conversation session.
  // Hydrate before paint so switching sessions never flashes or inherits the
  // previous session's right-side workspace.
  useLayoutEffect(() => {
    setActivePanelSession(activeSessionId);
    setActiveEditorSession(activeSessionId);
  }, [activeSessionId, setActiveEditorSession, setActivePanelSession]);

  // Toggle editor panel
  const toggleEditorPanel = () => {
    if (isEditorOpen) {
      closeEditor();
    } else {
      openEditor();
    }
  };
  const [isInitialized, setIsInitialized] = useState(false);

  // Clock and lunch/bedtime enforcement system
  const [showLunchModal, setShowLunchModal] = useState(false);
  const [lunchReminderEnabled, setLunchReminderEnabled] = useState(false);
  const [lunchTime, setLunchTime] = useState('12:00');
  const [showBedtimeModal, setShowBedtimeModal] = useState(false);
  const [bedtimeReminderEnabled, setBedtimeReminderEnabled] = useState(false);
  const [bedtimeTime, setBedtimeTime] = useState('23:00');
  const [showDailyReviewModal, setShowDailyReviewModal] = useState(false);
  const [showBedtimeTaskReviewModal, setShowBedtimeTaskReviewModal] = useState(false);
  const dailyReviewWindowId = useMemo(() => getDailyReviewWindowId(), []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Load lunch + bedtime settings
  useEffect(() => {
    window.electronAPI.settings.get().then((settings) => {
      setLunchReminderEnabled(settings.lunchReminderEnabled || false);
      setLunchTime(settings.lunchReminderTime || '12:00');
      setBedtimeReminderEnabled(settings.bedtimeReminderEnabled || false);
      setBedtimeTime(settings.bedtimeReminderTime || '23:00');
    });
  }, []);

  // Lunch enforcement check — runs every 60s (clock is handled by StatusBarClock component)
  useEffect(() => {
    const checkLunchStatus = async () => {
      const today = new Date().toDateString();
      const lunchLogged = localStorage.getItem('lunch-logged-date');

      const settings = await window.electronAPI.settings.get();
      if (!settings.lunchReminderEnabled) return;

      const configuredTime = settings.lunchReminderTime || '12:00';
      const [lunchHour, lunchMinute] = configuredTime.split(':').map(Number);

      const now = new Date();
      if (now.getHours() === lunchHour && now.getMinutes() === lunchMinute && lunchLogged !== today) {
        setShowLunchModal(true);
      }
    };

    const interval = setInterval(checkLunchStatus, 60000);
    checkLunchStatus();

    return () => clearInterval(interval);
  }, []);

  const handleLunchConfirmed = async (meal: string) => {
    const today = new Date().toDateString();
    localStorage.setItem('lunch-logged-date', today);

    // Store in proper memory system
    if (activeSession?.worktreePath) {
      try {
        console.log('[Lunch System] Attempting to store in memory:', {
          worktreePath: activeSession.worktreePath,
          meal,
          date: today
        });

        const result = await window.electronAPI.memory.remember({
          category: 'preference',
          content: `Lunch on ${today}: ${meal}`,
          source: 'user',
        }, activeSession.worktreePath);

        console.log('[Lunch System] Successfully logged to memory:', result);
      } catch (error) {
        console.error('[Lunch System] Failed to log to memory:', error);
      }
    } else {
      console.warn('[Lunch System] No active session or worktree path, skipping memory storage');
    }

    setShowLunchModal(false);
  };

  // Bedtime enforcement check — runs every 60s
  useEffect(() => {
    const checkBedtimeStatus = async () => {
      const today = new Date().toDateString();
      const bedtimeLogged = localStorage.getItem('bedtime-logged-date');
      const bedtimeSnoozed = localStorage.getItem('bedtime-snooze-until');

      const settings = await window.electronAPI.settings.get();
      if (!settings.bedtimeReminderEnabled) {
        setShowBedtimeModal(false);
        return;
      }

      const configuredTime = settings.bedtimeReminderTime || '23:00';
      const [bedHour, bedMinute] = configuredTime.split(':').map(Number);

      const now = new Date();

      // Check if snoozed and snooze hasn't expired
      if (bedtimeSnoozed) {
        const snoozeExpiry = new Date(bedtimeSnoozed);
        if (now < snoozeExpiry) {
          setShowBedtimeModal(false);
          return; // Still in snooze period
        }
      }

      // Bedtime window: from bedtime hour until 4 AM the next morning.
      // Dismissal lasts until 4 AM — not just until midnight. This prevents
      // the modal from re-appearing at 00:01 because the date changed.
      const hour = now.getHours();
      const MORNING_CUTOFF = 4;
      const isPastBedtime = (hour === bedHour && now.getMinutes() >= bedMinute) || hour > bedHour;
      const isBeforeMorning = hour < MORNING_CUTOFF;
      const inBedtimeWindow = isPastBedtime || isBeforeMorning;

      // Hard stop: always show in bedtime window. Snooze gives 5 min,
      // then locks completely until morning. No dismiss.
      if (inBedtimeWindow) {
        setShowBedtimeModal(true);
      } else {
        setShowBedtimeModal(false);
        // Reset snooze tracker when morning comes
        localStorage.removeItem('bedtime-snooze-used-today');
      }
    };

    const interval = setInterval(checkBedtimeStatus, 60000);
    checkBedtimeStatus();

    return () => clearInterval(interval);
  }, []);

  const handleBedtimeDismiss = () => {
    // "Go to Bed" closes the window. The modal will re-appear if reopened
    // during bedtime window. Hard stop — no dismissal.
    window.close();
  };

  const handleBedtimeSnooze = () => {
    // Snooze for 5 minutes
    const snoozeUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    localStorage.setItem('bedtime-snooze-until', snoozeUntil);
    setShowBedtimeModal(false);
  };

  // Daily task review check — runs every 60s
  useEffect(() => {
    const checkDailyReview = async () => {
      const settings = await window.electronAPI.settings.get();
      if ((settings as any).dailyReviewEnabled !== true) return;
      if (!settings?.onboardingSkipped && !await useUIStore.getState().checkApiKey()) return;

      const now = new Date();
      const hour = now.getHours();
      const min = now.getMinutes();
      const today = now.toDateString();
      const reviewTime = parseTimeParts((settings as any).dailyReviewTime, 9, 0);

      // Show if: after configured review time, before 6 PM, not yet reviewed today.
      const isPastReviewTime = hour > reviewTime.hour || (hour === reviewTime.hour && min >= reviewTime.minute);
      const isBeforeEvening = hour < 18;
      const reviewedToday = localStorage.getItem(DAILY_REVIEW_DONE_KEY) === today;

      if (isPastReviewTime && isBeforeEvening && !reviewedToday && claimDailyReviewWindow(today, dailyReviewWindowId)) {
        setShowDailyReviewModal(true);
      }
    };

    const interval = setInterval(checkDailyReview, 60000);
    checkDailyReview();
    return () => clearInterval(interval);
  }, [dailyReviewWindowId]);

  useEffect(() => {
    return () => releaseDailyReviewWindow(dailyReviewWindowId);
  }, [dailyReviewWindowId]);

  // Bedtime task review check — fires 30min before bedtime
  useEffect(() => {
    const checkBedtimeTaskReview = async () => {
      const settings = await window.electronAPI.settings.get();
      if (!(settings as any).bedtimeTaskReviewEnabled || !settings.bedtimeReminderEnabled) {
        setShowBedtimeTaskReviewModal(false);
        return;
      }

      const now = new Date();
      const bedtime = settings.bedtimeReminderTime || '23:00';
      const [bedHour, bedMin] = bedtime.split(':').map(Number);

      // 30 min before bedtime
      let reviewHour = bedHour;
      let reviewMin = bedMin - 30;
      if (reviewMin < 0) { reviewHour -= 1; reviewMin += 60; }

      const hour = now.getHours();
      const min = now.getMinutes();
      const isPastReviewTime = hour > reviewHour || (hour === reviewHour && min >= reviewMin);
      const isBeforeBedtime = hour < bedHour || (hour === bedHour && min < bedMin);
      const reviewedToday = localStorage.getItem('bedtime-task-review-date') === now.toDateString();

      if (isPastReviewTime && isBeforeBedtime && !reviewedToday) {
        setShowBedtimeTaskReviewModal(true);
      }
    };

    const interval = setInterval(checkBedtimeTaskReview, 60000);
    checkBedtimeTaskReview();
    return () => clearInterval(interval);
  }, []);

  const handleDailyReviewDismiss = () => {
    localStorage.setItem(DAILY_REVIEW_DONE_KEY, new Date().toDateString());
    releaseDailyReviewWindow(dailyReviewWindowId);
    setShowDailyReviewModal(false);
  };

  const handleBedtimeTaskReviewDismiss = () => {
    localStorage.setItem('bedtime-task-review-date', new Date().toDateString());
    setShowBedtimeTaskReviewModal(false);
  };

  useEffect(() => {
    const init = async () => {
      // Initialize global TTS event listeners (only once)
      initializeTTSListeners();

      // Load audio settings for voice features
      await useAudioStore.getState().loadSettings();

      await useAuthStore.getState().checkAuth();

      // Show onboarding for new users (no API key and haven't completed onboarding before).
      const hasKey = await useUIStore.getState().checkApiKey();
      const settings = await window.electronAPI?.settings?.get?.();
      if (!hasKey && !settings?.onboardingSkipped) {
        useUIStore.getState().openOnboarding();
      }

      setIsInitialized(true);
    };
    init();
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const primaryModifierPressed = e[PRIMARY_MODIFIER_KEY];

      // Cmd+Shift+Y: Toggle app-level voice mode. The main-process bridge
      // handles packaged builds and embedded browser focus; this path keeps
      // the shortcut working in the renderer-only development environment.
      if (primaryModifierPressed && e.shiftKey && !e.altKey && e.code === 'KeyY') {
        e.preventDefault();
        if (!e.repeat) window.dispatchEvent(new CustomEvent('grep-voice-toggle'));
        return;
      }

      // Cmd+Shift+G: Toggle Command Center
      if (primaryModifierPressed && e.shiftKey && e.key === 'g') {
        e.preventDefault();
        useUIStore.getState().toggleCommandCenter();
        return;
      }

      // Cmd+Shift+A: Toggle Agent View
      if (primaryModifierPressed && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        useUIStore.getState().toggleAgentView();
        return;
      }

      // Cmd+Shift+F: File Content Search
      if (primaryModifierPressed && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        useEditorStore.getState().toggleFileSearch();
        return;
      }

      // Cmd+K: Quick Search
      if (primaryModifierPressed && e.key === 'k') {
        e.preventDefault();
        console.log('[App] CMD+K pressed - toggling QuickSearch');
        useEditorStore.getState().toggleQuickSearch();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Native shortcut bridge from the main process for packaged builds
  useEffect(() => {
    const unsubscribe = window.electronAPI.app.onShortcutTriggered(({ action }) => {
      switch (action) {
        case 'toggle-voice-mode':
          window.dispatchEvent(new CustomEvent('grep-voice-toggle'));
          return;
        case 'toggle-command-center':
          useUIStore.getState().toggleCommandCenter();
          return;
        case 'toggle-agent-view':
          useUIStore.getState().toggleAgentView();
          return;
        case 'toggle-file-search':
          useEditorStore.getState().toggleFileSearch();
          return;
        case 'toggle-quick-search':
          useEditorStore.getState().toggleQuickSearch();
          return;
        case 'new-session':
          useUIStore.getState().openNewSessionDialog();
          return;
        case 'browser-refresh': {
          const uiState = useUIStore.getState();
          if (!uiState.isBrowserPanelOpen) {
            return;
          }
          const sessionState = useSessionStore.getState();
          const selectedSession = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId);
          const partitionId = selectedSession
            ? getBrowserPartitionId(selectedSession.id, sessionState.sessions)
            : null;
          const activeBrowserTab = partitionId
            ? uiState.browserTabs.find((tab) => tab.id === uiState.activeBrowserTabIdsByPartition[partitionId])
            : null;
          if (!activeBrowserTab) {
            return;
          }

          window.dispatchEvent(new CustomEvent('grep-browser-refresh', {
            detail: { sessionId: activeBrowserTab.ownerSessionId, browserTabId: activeBrowserTab.id },
          }));
          return;
        }
        case 'save-or-new-session':
          if (useEditorStore.getState().isEditorOpen) {
            window.dispatchEvent(new CustomEvent('grep-shortcut', {
              detail: { action: 'save' },
            }));
          } else {
            useUIStore.getState().openNewSessionDialog();
          }
          return;
        case 'close-editor-tab':
          if (useEditorStore.getState().isEditorOpen) {
            window.dispatchEvent(new CustomEvent('grep-shortcut', {
              detail: { action: 'close-tab' },
            }));
          }
          return;
        case 'fork-empty':
          if (useSessionStore.getState().activeSessionId) {
            void useSessionStore.getState().createForkFromCurrent('');
          }
          return;
        case 'prev-fork':
          useSessionStore.getState().cycleForkTabs('prev');
          return;
        case 'next-fork':
          useSessionStore.getState().cycleForkTabs('next');
          return;
        // Ctrl+Tab session switching handled entirely by useSessionSwitcher hook
        case 'background-task':
          if (!useSessionStore.getState().activeSessionId) {
            return;
          }
          window.dispatchEvent(new CustomEvent('grep-shortcut', {
            detail: {
              action: 'background-task',
              sessionId: useSessionStore.getState().activeSessionId,
            },
          }));
          return;
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Auto-open browser panel when Stagehand browser tools are used
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onBrowserUpdate((data: { sessionId: string; screenshot: string; url?: string; timestamp: string }) => {
      const uiState = useUIStore.getState();
      const sessionState = useSessionStore.getState();
      const owner = sessionState.sessions.find((session) => session.id === data.sessionId);
      if (!owner) return;
      const existing = uiState.browserTabs.find((tab) => tab.ownerSessionId === data.sessionId);
      if (existing) {
        uiState.setActiveBrowserTab(existing.id);
        if (data.url) uiState.updateBrowserTabUrl(existing.id, data.url);
      } else {
        uiState.createBrowserTab(
          owner.id,
          getBrowserPartitionId(owner.id, sessionState.sessions),
          data.url || owner.lastBrowserUrl || `http://localhost:${owner.ports?.web || 3000}`,
        );
      }
      uiState.enableSessionBrowser(data.sessionId);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Browser screenshots and inspector captures may originate in the detached
  // browser window. Retarget the browser tab owner's event to the visible chat
  // in the same fork family, then deliver one ordinary local composer event.
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onChatInsert((payload: BrowserChatInsertPayload) => {
      const sessionState = useSessionStore.getState();
      const uiState = useUIStore.getState();
      const visibleChatSessionId = uiState.isCommandCenterActive
        ? uiState.commandCenterFocusedSessionId
        : uiState.isAgentViewActive
          ? uiState.agentViewSelectedSessionId
          : sessionState.activeSessionId;
      const sourceSession = sessionState.sessions.find((session) => session.id === payload.sessionId);
      const visibleSession = sessionState.sessions.find((session) => session.id === visibleChatSessionId);
      const targetSessionId = sourceSession && visibleSession
        && getBrowserPartitionId(sourceSession.id, sessionState.sessions) === getBrowserPartitionId(visibleSession.id, sessionState.sessions)
        ? visibleSession.id
        : payload.sessionId;

      window.dispatchEvent(new CustomEvent('grep-insert-chat', {
        detail: { ...payload, sessionId: targetSessionId },
      }));
    });

    return unsubscribe;
  }, []);

  // Open browser panel when requested by main process (for Stagehand initialization)
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onBrowserOpenPanel((data: { sessionId?: string; url?: string }) => {
      if (data.url) {
        void openLinkInAppBrowser(data.url, data.sessionId);
        return;
      }
      if (!data.sessionId) return;
      console.log('[App] Browser panel open requested for session:', data.sessionId);
      const uiState = useUIStore.getState();
      const sessionState = useSessionStore.getState();
      const owner = sessionState.sessions.find((session) => session.id === data.sessionId);
      if (owner && !uiState.browserTabs.some((tab) => tab.ownerSessionId === owner.id)) {
        uiState.createBrowserTab(
          owner.id,
          getBrowserPartitionId(owner.id, sessionState.sessions),
          owner.lastBrowserUrl || `http://localhost:${owner.ports?.web || 3000}`,
        );
      }
      uiState.enableSessionBrowser(data.sessionId);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Switch RHS to the design panel when the agent activates design mode
  useEffect(() => {
    const unsubscribe = window.electronAPI.design.onDesignOpenPanel((data: { sessionId: string; url: string; workspaceDir: string; takeover?: boolean }) => {
      console.log('[App] Design panel open requested for session:', data.sessionId, data.url, 'takeover:', data.takeover);
      useUIStore.getState().showDesignPanel(data.sessionId, { url: data.url, workspaceDir: data.workspaceDir }, data.takeover);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    // Load sessions when authenticated OR in dev mode
    if (user || isDevMode) {
      const store = useSessionStore.getState();
      store.loadSessions().then(() => {
        // After sessions are loaded, check for auto-resume (Build It mode interrupted)
        useSessionStore.getState().checkAndAutoResume();
      });
      const unsubscribeSession = store.subscribeToSessionChanges();
      const unsubscribeSetup = store.subscribeToSetupProgress();
      const unsubscribeCompaction = store.subscribeToCompaction();
      const unsubscribeAutoResume = store.setupAutoResumeOnClose();
      const unsubscribeClaude = store.subscribeToClaude();
      const unsubscribeBgTasks = store.subscribeToBackgroundTasks();
      const unsubscribeBtw = store.subscribeToBtw();
      const unsubscribeRC = store.subscribeToRemoteControl();
      const unsubscribeCodex = store.subscribeToCodex();
      return () => {
        unsubscribeSession();
        unsubscribeSetup();
        unsubscribeCompaction();
        unsubscribeAutoResume();
        unsubscribeClaude();
        unsubscribeBgTasks();
        unsubscribeBtw();
        unsubscribeRC();
        unsubscribeCodex();
      };
    }
  }, [user, isDevMode]);

  if (!isInitialized || isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-claude-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-claude-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-claude-text-secondary">Loading Build...</p>
        </div>
      </div>
    );
  }

  // Show login if not authenticated AND not in dev mode
  if (!user && !isDevMode) {
    return <LoginScreen />;
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-claude-bg overflow-hidden">
      {/* Title bar with drag region and controls */}
      <div
        className="h-8 bg-claude-surface border-b border-claude-border flex items-center justify-between"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Left: sidebar toggle + spacer for traffic lights */}
        <div className="flex items-center h-full">
          <div
            className="pl-20 pr-2 flex items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              onClick={toggleSidebar}
              className={`p-1 transition-colors hover:text-claude-text ${
                isSidebarOpen ? 'text-claude-text' : 'text-claude-text-secondary'
              }`}
              title="Toggle Sidebar"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
        </div>

        {/* Center: Clock with lunch countdown — isolated component to avoid re-rendering entire app */}
        <div className="absolute left-1/2 transform -translate-x-1/2 flex items-center">
          <StatusBarClock lunchReminderEnabled={lunchReminderEnabled} lunchTime={lunchTime} bedtimeReminderEnabled={bedtimeReminderEnabled} bedtimeTime={bedtimeTime} />
        </div>

        {/* Right: panel toggle buttons */}
        <div
          className="flex items-center gap-0.5 px-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={toggleTerminalPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isTerminalPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Terminal"
          >
            <Terminal size={14} />
          </button>
          <button
            onClick={toggleBrowserPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isBrowserPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Browser"
          >
            <Globe size={14} />
          </button>
          <button
            onClick={toggleExtensionsPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isExtensionsPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Extensions"
          >
            <Package size={14} />
          </button>
          <button
            onClick={togglePlanPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isPlanPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Plan"
          >
            <ClipboardList size={14} />
          </button>
          <button
            onClick={toggleHtmlPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isHtmlPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle HTML Preview"
          >
            <FileText size={14} />
          </button>
          <button
            onClick={toggleEditorPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isEditorOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Editor (Files)"
          >
            <FileCode size={14} />
          </button>
          <button
            onClick={toggleGitPanel}
            className={`p-1 transition-colors hover:text-claude-text ${
              isGitPanelOpen ? 'text-claude-text' : 'text-claude-text-secondary'
            }`}
            title="Toggle Git"
          >
            <GitBranch size={14} />
          </button>
          <button
            onClick={async () => {
              const sid = useSessionStore.getState().activeSessionId;
              if (!sid) return;
              const ui = useUIStore.getState();
              if (ui.sessionDesignTakeover[sid]) {
                ui.setDesignTakeover(sid, false);
                return;
              }
              // Design always takes over the full space (chat included)
              const existing = ui.sessionDesignPanels[sid];
              if (existing) {
                ui.showDesignPanel(sid, existing, true);
                return;
              }
              try {
                const ws = await window.electronAPI.design.ensureWorkspace(sid);
                useUIStore.getState().showDesignPanel(sid, { url: ws.panelUrl, workspaceDir: ws.workspaceDir }, true);
              } catch (error) {
                console.error('[App] Could not start design workspace:', error);
                useUIStore.getState().toggleDesignPanel(); // fall back to panel empty-state (shows the error path)
              }
            }}
            className={`p-1 transition-colors hover:text-pink-400 ${
              isDesignTakeoverActive || isDesignPanelOpen ? 'text-pink-400' : 'text-claude-text-secondary'
            }`}
            title="Toggle Design Mode"
          >
            <OpenDesignIcon size={15} />
          </button>
          <button
            onClick={cycleSplitRatio}
            className="p-1 text-claude-text-secondary hover:text-claude-text transition-colors"
            title="Cycle Split Layout"
          >
            <PanelRight size={14} />
          </button>
          <button
            onClick={openSettings}
            className="p-1 text-claude-text-secondary hover:text-claude-text transition-colors"
            title="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        {isSidebarOpen && <Sidebar />}

        {/* Main content area */}
        <MainContent />
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Settings Dialog */}
      <SettingsDialog />

      {/* API Key Onboarding */}
      <ApiKeyOnboarding />

      {/* Quick Search (Cmd+K) */}
      <QuickSearch />

      {/* File Content Search (Cmd+Shift+F) */}
      <FileContentSearch />

      {/* Session Switcher (Ctrl+Tab) */}
      <SessionSwitcher />

      {/* Lunch Lock Modal */}
      {showBedtimeModal && (
        <BedtimeLockModal onDismiss={handleBedtimeDismiss} onSnooze={handleBedtimeSnooze} />
      )}
      {showLunchModal && (
        <LunchLockModal onConfirm={handleLunchConfirmed} />
      )}
      {showDailyReviewModal && (
        <DailyReviewModal onDismiss={handleDailyReviewDismiss} />
      )}
      {showBedtimeTaskReviewModal && (
        <BedtimeTaskReviewModal onDismiss={handleBedtimeTaskReviewDismiss} />
      )}

      {/* QMD Semantic Search Prompt */}
      <QMDPrompt />
    </div>
  );
}

// Browser-only mode — rendered in the pop-out browser window
function BrowserOnlyApp() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const browserTabs = useUIStore((s) => s.browserTabs);
  const activeBrowserTabIdsByPartition = useUIStore((s) => s.activeBrowserTabIdsByPartition);
  const createBrowserTab = useUIStore((s) => s.createBrowserTab);
  const setActiveBrowserTab = useUIStore((s) => s.setActiveBrowserTab);
  const updateBrowserTabUrl = useUIStore((s) => s.updateBrowserTabUrl);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const init = async () => {
      await useAuthStore.getState().checkAuth();
      await useSessionStore.getState().loadSessions();
      setReady(true);
    };
    init();
  }, []);

  const mountedBrowserTabs = useMemo(() => browserTabs.filter((tab) => (
    sessions.some((session) => session.id === tab.ownerSessionId)
  )), [browserTabs, sessions]);
  const fallbackOwner = sessions.find((session) => session.id === activeSessionId) || sessions[0];
  const activeBrowserPartitionId = fallbackOwner
    ? getBrowserPartitionId(fallbackOwner.id, sessions)
    : null;
  const browserTabsForPartition = useMemo(() => mountedBrowserTabs.filter((tab) => (
    tab.partitionId === activeBrowserPartitionId
  )), [activeBrowserPartitionId, mountedBrowserTabs]);
  const activeBrowserTabId = activeBrowserPartitionId
    ? activeBrowserTabIdsByPartition[activeBrowserPartitionId] || null
    : null;
  const activeBrowserTab = browserTabsForPartition.find((tab) => tab.id === activeBrowserTabId)
    || browserTabsForPartition[0]
    || null;
  const activeBrowserOwnerSession = activeBrowserTab
    ? sessions.find((session) => session.id === activeBrowserTab.ownerSessionId) || null
    : null;
  const activeBrowserRuntimeSession = fallbackOwner || activeBrowserOwnerSession;

  useEffect(() => {
    if (!ready || !fallbackOwner) return;
    if (browserTabsForPartition.length === 0) {
      createBrowserTab(
        fallbackOwner.id,
        getBrowserPartitionId(fallbackOwner.id, sessions),
        fallbackOwner.lastBrowserUrl || `http://localhost:${fallbackOwner.ports?.web || 3000}`,
      );
    } else if (!activeBrowserTabId || !browserTabsForPartition.some((tab) => tab.id === activeBrowserTabId)) {
      setActiveBrowserTab(browserTabsForPartition[0].id);
    }
  }, [activeBrowserTabId, browserTabsForPartition, createBrowserTab, fallbackOwner, ready, sessions, setActiveBrowserTab]);

  if (!ready || !activeBrowserTab || !activeBrowserRuntimeSession) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-claude-bg">
        <p className="text-claude-text-secondary font-mono text-sm">Loading browser...</p>
      </div>
    );
  }

  const BrowserPreview = React.lazy(() => import('./components/preview/BrowserPreview'));

  return (
    <div className="h-screen w-screen flex flex-col bg-claude-bg">
      {/* Independent browser workspace tabs */}
      <div
        className="h-8 bg-claude-surface border-b border-claude-border flex items-center"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex-1 flex items-center overflow-x-auto" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {browserTabsForPartition.map((tab) => (
            <BrowserSessionTab
              key={tab.id}
              tab={tab}
              ownerSession={sessions.find((session) => session.id === tab.ownerSessionId)}
              isActive={tab.id === activeBrowserTab.id}
              onActivate={() => setActiveBrowserTab(tab.id)}
              compact
            />
          ))}
          <button
            type="button"
            onClick={() => {
              if (!fallbackOwner) return;
              createBrowserTab(
                fallbackOwner.id,
                getBrowserPartitionId(fallbackOwner.id, sessions),
                fallbackOwner.lastBrowserUrl || `http://localhost:${fallbackOwner.ports?.web || 3000}`,
              );
            }}
            className="h-8 px-2 text-claude-text-secondary hover:text-claude-text hover:bg-claude-bg/50"
            title="New browser tab"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      {/* Saved tabs retain their URL, but only the visible tab owns a Chromium
          guest. Hidden webviews remain full renderer processes and previously
          caused every persisted Build session to come alive on app startup. */}
      <div className="flex-1 overflow-hidden relative">
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center"><p className="text-claude-text-secondary">Loading...</p></div>}>
          <div
            key={activeBrowserTab.id}
            data-browser-tab-id={activeBrowserTab.id}
            data-browser-owner-session-id={activeBrowserTab.ownerSessionId}
            className="absolute inset-0"
          >
            <BrowserPreviewBoundary tabId={activeBrowserTab.id}>
              <BrowserPreview
                session={activeBrowserRuntimeSession}
                isVisible={true}
                partitionId={activeBrowserTab.partitionId}
                browserTabId={activeBrowserTab.id}
                initialBrowserUrl={activeBrowserTab.url}
                onBrowserUrlChange={(url) => updateBrowserTabUrl(activeBrowserTab.id, url)}
              />
            </BrowserPreviewBoundary>
          </div>
        </React.Suspense>
      </div>
    </div>
  );
}

// Root component - decides which mode to render
export default function App() {
  if (!isElectron) {
    return <PreviewMode />;
  }

  // Check for browser-only mode (pop-out window)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'browser') {
    return <BrowserOnlyApp />;
  }

  return <ElectronApp />;
}
