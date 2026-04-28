import React, { useEffect, useState, useMemo, memo } from 'react';
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
import { Terminal, Globe, PanelRight, Settings, PanelLeftClose, Monitor, AlertTriangle, Package, FileText, FileCode, ClipboardList, GitBranch } from 'lucide-react';

// Check if we're running in Electron (has electronAPI) or browser preview mode
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const PRIMARY_MODIFIER_KEY: 'metaKey' | 'ctrlKey' = /mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';

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
  const { activeSessionId, sessions } = useSessionStore();
  const {
    isSidebarOpen,
    isTerminalPanelOpen,
    isBrowserPanelOpen,
    isExtensionsPanelOpen,
    isPlanPanelOpen,
    isGitPanelOpen,
    toggleSidebar,
    toggleTerminalPanel,
    toggleBrowserPanel,
    toggleExtensionsPanel,
    togglePlanPanel,
    toggleGitPanel,
    cycleSplitRatio,
    openSettings,
    hasApiKey,
  } = useUIStore();
  const { isEditorOpen, openEditor, closeEditor } = useEditorStore();

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
      if (!settings.bedtimeReminderEnabled) return;

      const configuredTime = settings.bedtimeReminderTime || '23:00';
      const [bedHour, bedMinute] = configuredTime.split(':').map(Number);

      const now = new Date();

      // Check if snoozed and snooze hasn't expired
      if (bedtimeSnoozed) {
        const snoozeExpiry = new Date(bedtimeSnoozed);
        if (now < snoozeExpiry) return; // Still in snooze period
      }

      // Bedtime window: from bedtime hour until 6 AM the next morning.
      // Dismissal lasts until 6 AM — not just until midnight. This prevents
      // the modal from re-appearing at 00:01 because the date changed.
      const hour = now.getHours();
      const MORNING_CUTOFF = 6;
      const isPastBedtime = (hour === bedHour && now.getMinutes() >= bedMinute) || hour > bedHour;
      const isBeforeMorning = hour < MORNING_CUTOFF;
      const inBedtimeWindow = isPastBedtime || isBeforeMorning;

      // Use a timestamp-based dismissal instead of date string so it survives
      // past midnight. Dismissed = don't show again for 8 hours.
      const dismissedUntil = localStorage.getItem('bedtime-dismissed-until');
      const isDismissed = dismissedUntil && now.getTime() < parseInt(dismissedUntil, 10);

      if (inBedtimeWindow && !isDismissed) {
        setShowBedtimeModal(true);
      }
    };

    const interval = setInterval(checkBedtimeStatus, 60000);
    checkBedtimeStatus();

    return () => clearInterval(interval);
  }, []);

  const handleBedtimeDismiss = () => {
    // Dismiss for 8 hours — won't re-appear until after 6 AM even if
    // midnight rolls over and changes the date string.
    const dismissUntil = Date.now() + 8 * 60 * 60 * 1000;
    localStorage.setItem('bedtime-dismissed-until', dismissUntil.toString());
    localStorage.setItem('bedtime-logged-date', new Date().toDateString());
    setShowBedtimeModal(false);
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
      if (!(settings as any).dailyReviewEnabled) return;

      const now = new Date();
      const configuredTime = (settings as any).dailyReviewTime || '09:00';
      const [reviewHour, reviewMinute] = configuredTime.split(':').map(Number);

      // Show if: past review time, before 6 PM, not yet reviewed today
      const hour = now.getHours();
      const isPastReviewTime = hour > reviewHour || (hour === reviewHour && now.getMinutes() >= reviewMinute);
      const isBeforeEvening = hour < 18;
      const reviewedToday = localStorage.getItem('daily-review-date') === now.toDateString();

      if (isPastReviewTime && isBeforeEvening && !reviewedToday) {
        setShowDailyReviewModal(true);
      }
    };

    const interval = setInterval(checkDailyReview, 60000);
    checkDailyReview();
    return () => clearInterval(interval);
  }, []);

  // Bedtime task review check — fires 30min before bedtime
  useEffect(() => {
    const checkBedtimeTaskReview = async () => {
      const settings = await window.electronAPI.settings.get();
      if (!(settings as any).bedtimeTaskReviewEnabled) return;
      if (!settings.bedtimeReminderEnabled) return;

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
    localStorage.setItem('daily-review-date', new Date().toDateString());
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

      // Check for API key and show onboarding if missing (and not previously skipped).
      // Demo mode (`demoForceOnboarding` settings flag) forces the onboarding to show
      // on first launch even when an API key is already present, so the "first run"
      // experience can be recorded without sessions being broken.
      const hasKey = await useUIStore.getState().checkApiKey();
      const settings = await window.electronAPI?.settings?.get?.();
      const forceOnboarding = !!(settings as any)?.demoForceOnboarding;
      if ((!hasKey || forceOnboarding) && !settings?.onboardingSkipped) {
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

      // Cmd+Shift+G: Toggle Command Center
      if (primaryModifierPressed && e.shiftKey && e.key === 'g') {
        e.preventDefault();
        useUIStore.getState().toggleCommandCenter();
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
        case 'toggle-command-center':
          useUIStore.getState().toggleCommandCenter();
          return;
        case 'toggle-file-search':
          useEditorStore.getState().toggleFileSearch();
          return;
        case 'toggle-quick-search':
          useEditorStore.getState().toggleQuickSearch();
          return;
        case 'browser-refresh': {
          const uiState = useUIStore.getState();
          if (!uiState.isBrowserPanelOpen) {
            return;
          }

          const sessionState = useSessionStore.getState();
          const activeId = sessionState.activeSessionId;
          if (!activeId) {
            return;
          }

          let rootId = activeId;
          let session = sessionState.sessions.find((candidate) => candidate.id === rootId);
          while (session?.parentSessionId) {
            rootId = session.parentSessionId;
            session = sessionState.sessions.find((candidate) => candidate.id === rootId);
          }

          window.dispatchEvent(new CustomEvent('grep-browser-refresh', {
            detail: { sessionId: rootId },
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
      // Enable browser for this session - this also opens the browser panel
      useUIStore.getState().enableSessionBrowser(data.sessionId);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Open browser panel when requested by main process (for Stagehand initialization)
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onBrowserOpenPanel((data: { sessionId: string }) => {
      console.log('[App] Browser panel open requested for session:', data.sessionId);
      // Enable browser for this session - this also opens the browser panel
      useUIStore.getState().enableSessionBrowser(data.sessionId);
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
  const { sessions, activeSessionId, commandCenterSessionIds } = useSessionStore();
  const { commandCenterFocusedSessionId, setCommandCenterFocusedSession, enableSessionBrowser } = useUIStore();

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const init = async () => {
      await useAuthStore.getState().checkAuth();
      await useSessionStore.getState().loadSessions();
      setReady(true);
    };
    init();
  }, []);

  // Get command center sessions for tabs
  const ccSessions = useMemo(() => {
    return commandCenterSessionIds
      .map(id => sessions.find(s => s.id === id))
      .filter((s): s is NonNullable<typeof s> => !!s);
  }, [commandCenterSessionIds, sessions]);

  // Auto-enable browsers for all command center sessions
  useEffect(() => {
    if (ready) {
      for (const s of ccSessions) {
        enableSessionBrowser(s.id);
      }
    }
  }, [ready, ccSessions, enableSessionBrowser]);

  // Active tab follows focused session
  const activeSessionForBrowser = commandCenterFocusedSessionId
    ? sessions.find(s => s.id === commandCenterFocusedSessionId)
    : ccSessions[0] || sessions.find(s => s.id === activeSessionId) || sessions[0];

  if (!ready || !activeSessionForBrowser) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-claude-bg">
        <p className="text-claude-text-secondary font-mono text-sm">Loading browser...</p>
      </div>
    );
  }

  const BrowserPreview = React.lazy(() => import('./components/preview/BrowserPreview'));

  return (
    <div className="h-screen w-screen flex flex-col bg-claude-bg">
      {/* Title bar with session tabs */}
      <div
        className="h-8 bg-claude-surface border-b border-claude-border flex items-center"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {ccSessions.length > 1 ? (
          <div className="flex-1 flex items-center overflow-x-auto" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {ccSessions.map(s => {
              const isActive = s.id === activeSessionForBrowser.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setCommandCenterFocusedSession(s.id)}
                  className={`flex items-center gap-1.5 px-3 h-8 text-[10px] font-mono font-bold uppercase border-r border-claude-border transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-claude-bg text-claude-text'
                      : 'bg-claude-surface text-claude-text-secondary hover:bg-claude-bg/50'
                  }`}
                  style={{ letterSpacing: '0.05em' }}
                >
                  <div
                    className={`w-1.5 h-1.5 flex-shrink-0 ${s.status === 'running' ? 'bg-green-500' : 'bg-gray-500'}`}
                    style={{ borderRadius: 0 }}
                  />
                  <span className="truncate max-w-[140px]">{s.forkName || s.name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-[10px] font-mono font-bold text-claude-text-secondary uppercase px-4" style={{ letterSpacing: '0.1em' }}>
            Browser — {activeSessionForBrowser.forkName || activeSessionForBrowser.name}
          </span>
        )}
      </div>
      {/* Browser views — all mounted, only active visible */}
      <div className="flex-1 overflow-hidden relative">
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center"><p className="text-claude-text-secondary">Loading...</p></div>}>
          {ccSessions.length > 1 ? (
            ccSessions.map(s => (
              <div
                key={s.id}
                className="absolute inset-0"
                style={{ display: s.id === activeSessionForBrowser.id ? 'block' : 'none' }}
              >
                <BrowserPreview session={s} isVisible={s.id === activeSessionForBrowser.id} />
              </div>
            ))
          ) : (
            <BrowserPreview session={activeSessionForBrowser} isVisible={true} />
          )}
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
