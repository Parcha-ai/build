import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Eye, EyeOff, Check, Loader2, Search, Download, Sparkles, Settings, Key, History } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';
import ReleaseNotes from '../common/ReleaseNotes';

type TabId = 'general' | 'autoBuild' | 'apiKeys' | 'releases';

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

type AutoBuildModelKey = 'plan' | 'build' | 'verify' | 'refine' | 'fallback';

type AutoBuildModelSettings = Record<AutoBuildModelKey, string>;

const AUTO_BUILD_MODEL_DEFAULTS: AutoBuildModelSettings = {
  plan: 'claude-sonnet-4-6',
  build: 'codex:gpt-5.5',
  verify: 'codex:gpt-5.5',
  refine: 'cursor:composer-2.5',
  fallback: 'claude-sonnet-4-6',
};

const AUTO_BUILD_MODEL_ROWS: Array<{ id: AutoBuildModelKey; label: string; detail: string }> = [
  { id: 'plan', label: 'Planning', detail: 'Architecture, reviews, tradeoffs' },
  { id: 'build', label: 'Execution', detail: 'Code and file changes' },
  { id: 'verify', label: 'Verification', detail: 'Tests, QA, debugging' },
  { id: 'refine', label: 'Refinement', detail: 'Small focused edits' },
  { id: 'fallback', label: 'Fallback', detail: 'Safe default when a harness is unavailable' },
];

function autoBuildConfigFromState(models: AutoBuildModelSettings, costAware: boolean) {
  return {
    planModel: models.plan,
    buildModel: models.build,
    verifyModel: models.verify,
    refineModel: models.refine,
    fallbackModel: models.fallback,
    costAware,
  };
}

function migrateAutoBuildModels(savedAutoConfig: any): AutoBuildModelSettings {
  const models: AutoBuildModelSettings = { ...AUTO_BUILD_MODEL_DEFAULTS };

  if (Array.isArray(savedAutoConfig?.categories)) {
    for (const category of savedAutoConfig.categories) {
      if (category?.id === 'plan' && typeof category.model === 'string') models.plan = category.model;
      if (category?.id === 'build' && typeof category.model === 'string') models.build = category.model;
      if (category?.id === 'verify' && typeof category.model === 'string') models.verify = category.model;
      if (category?.id === 'refine' && typeof category.model === 'string') models.refine = category.model;
    }
  }

  if (typeof savedAutoConfig?.planModel === 'string') models.plan = savedAutoConfig.planModel;
  if (typeof savedAutoConfig?.buildModel === 'string') models.build = savedAutoConfig.buildModel;
  if (typeof savedAutoConfig?.verifyModel === 'string') models.verify = savedAutoConfig.verifyModel;
  if (typeof savedAutoConfig?.refineModel === 'string') models.refine = savedAutoConfig.refineModel;
  if (typeof savedAutoConfig?.fallbackModel === 'string') models.fallback = savedAutoConfig.fallbackModel;

  return models;
}

// Extracted to module level to prevent recreation on every render (causes focus loss)
const ApiKeyInputComponent = ({
  value,
  onChange,
  show,
  onToggleShow,
  placeholder,
  onSave,
  isLoading,
  handleDebouncedChange,
}: {
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggleShow: () => void;
  placeholder: string;
  onSave: (value: string) => void;
  isLoading: boolean;
  handleDebouncedChange: (value: string, saveFn: (value: string) => void) => void;
}) => (
  <div className="relative">
    <input
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(e) => {
        const newValue = e.target.value;
        onChange(newValue);
        handleDebouncedChange(newValue, onSave);
      }}
      placeholder={isLoading ? 'Loading...' : placeholder}
      disabled={isLoading}
      className="w-full px-3 py-2 pr-10 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent disabled:opacity-50"
      style={{ borderRadius: 0 }}
    />
    <button
      onClick={onToggleShow}
      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-claude-text-secondary hover:text-claude-text"
      type="button"
    >
      {show ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  </div>
);
const ApiKeyInput = React.memo(ApiKeyInputComponent);

const TABS: TabConfig[] = [
  { id: 'general', label: 'General', icon: <Settings size={14} /> },
  { id: 'autoBuild', label: 'Auto Build', icon: <Sparkles size={14} /> },
  { id: 'apiKeys', label: 'API Keys', icon: <Key size={14} /> },
  { id: 'releases', label: 'Releases', icon: <History size={14} /> },
];

export default function SettingsDialog() {
  const { isSettingsOpen, closeSettings } = useUIStore();
  const { settings: audioSettings, loadSettings, updateSettings } = useAudioStore();
  const loadAvailableModels = useSessionStore((s) => s.loadAvailableModels);

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabId>('general');

  // Save status indicator
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // API Keys
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [showGoogleApiKey, setShowGoogleApiKey] = useState(false);
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState('');
  const [showElevenLabsApiKey, setShowElevenLabsApiKey] = useState(false);
  const [elevenLabsAgentId, setElevenLabsAgentId] = useState('');
  const [cursorApiKey, setCursorApiKey] = useState('');
  const [showCursorApiKey, setShowCursorApiKey] = useState(false);
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [showDeepseekApiKey, setShowDeepseekApiKey] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);

  // Audio settings
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [ralphLoopEnabled, setRalphLoopEnabled] = useState(false);
  const [computerUseEnabled, setComputerUseEnabled] = useState(false);
  const [maxComputerUseIterations, setMaxComputerUseIterations] = useState(20);

  // General settings
  const [qmdEnabled, setQmdEnabled] = useState(false);
  const [ultraPlanMode, setUltraPlanMode] = useState(false);
  const [showClearContextOnPlanAccept, setShowClearContextOnPlanAccept] = useState(false);
  const [lunchReminderEnabled, setLunchReminderEnabled] = useState(false);
  const [lunchReminderTime, setLunchReminderTime] = useState('12:00');
  const [bedtimeReminderEnabled, setBedtimeReminderEnabled] = useState(false);
  const [bedtimeReminderTime, setBedtimeReminderTime] = useState('23:00');
  const [dailyReviewEnabled, setDailyReviewEnabled] = useState(true);
  const [dailyReviewTime, setDailyReviewTime] = useState('09:00');
  const [bedtimeTaskReviewEnabled, setBedtimeTaskReviewEnabled] = useState(true);

  // Foundry settings
  const [foundryEnabled, setFoundryEnabled] = useState(false);
  const [foundryBaseUrl, setFoundryBaseUrl] = useState('');
  const [foundryApiKey, setFoundryApiKey] = useState('');
  const [showFoundryApiKey, setShowFoundryApiKey] = useState(false);
  const [foundryDefaultSonnetModel, setFoundryDefaultSonnetModel] = useState('');
  const [foundryDefaultHaikuModel, setFoundryDefaultHaikuModel] = useState('');
  const [foundryDefaultOpusModel, setFoundryDefaultOpusModel] = useState('');

  // Custom models (Kimi, Gemini, etc via API proxy)
  const [customModels, setCustomModels] = useState<Array<{ id: string; name: string; modelId: string; baseUrl: string; apiKey: string; description?: string }>>([]);

  // Auto Build fixed model routing tiers
  const availableModels = useSessionStore((s) => s.availableModels || []);
  const [autoBuildModels, setAutoBuildModels] = useState<AutoBuildModelSettings>(AUTO_BUILD_MODEL_DEFAULTS);
  const [autoBuildCostAware, setAutoBuildCostAware] = useState(true);

  // QMD status
  const [qmdStatus, setQmdStatus] = useState<{ installed: boolean; bundled: boolean } | null>(null);
  const [isInstallingQmd, setIsInstallingQmd] = useState(false);
  const [qmdInstallMessage, setQmdInstallMessage] = useState('');

  const [isLoading, setIsLoading] = useState(true);

  // Show save indicator briefly
  const showSaveIndicator = useCallback(() => {
    setSaveStatus('saving');
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      setSaveStatus('saved');
      saveTimeoutRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, 1500);
    }, 300);
  }, []);

  // Auto-save app settings (toggles and time picker)
  const autoSaveAppSettings = useCallback(async (updates: { qmdEnabled?: boolean; ultraPlanMode?: boolean; showClearContextOnPlanAccept?: boolean; lunchReminderEnabled?: boolean; lunchReminderTime?: string; bedtimeReminderEnabled?: boolean; bedtimeReminderTime?: string; dailyReviewEnabled?: boolean; dailyReviewTime?: string; bedtimeTaskReviewEnabled?: boolean; foundryEnabled?: boolean; foundryBaseUrl?: string; foundryApiKey?: string; foundryDefaultSonnetModel?: string; foundryDefaultHaikuModel?: string; foundryDefaultOpusModel?: string; customModels?: typeof customModels; cursorApiKey?: string; deepseekApiKey?: string; geminiApiKey?: string; autoRouterConfig?: any }) => {
    showSaveIndicator();
    try {
      await window.electronAPI.settings.set(updates);
      console.log('[SettingsDialog] Auto-saved app settings:', updates);

      // Reload available models if model-affecting settings changed
      const isModelUpdate = 'foundryEnabled' in updates || 'foundryDefaultSonnetModel' in updates || 'foundryDefaultHaikuModel' in updates || 'foundryDefaultOpusModel' in updates || 'customModels' in updates || 'cursorApiKey' in updates || 'deepseekApiKey' in updates || 'geminiApiKey' in updates;
      if (isModelUpdate) {
        console.log('[SettingsDialog] Model-affecting settings changed, reloading available models');
        await loadAvailableModels();
      }
    } catch (error) {
      console.error('Failed to auto-save app settings:', error);
    }
  }, [showSaveIndicator, loadAvailableModels]);

  // Auto-save audio settings
  const autoSaveAudioSettings = useCallback(async (updates: Partial<typeof audioSettings>) => {
    if (!audioSettings) return;
    showSaveIndicator();
    try {
      await updateSettings({
        ...audioSettings,
        ...updates,
      });
      console.log('[SettingsDialog] Auto-saved audio settings:', updates);
    } catch (error) {
      console.error('Failed to auto-save audio settings:', error);
    }
  }, [audioSettings, updateSettings, showSaveIndicator]);

  // Auto-save API keys with debounce for text inputs
  const autoSaveApiKey = useCallback(async (key: string, type: 'anthropic' | 'openai' | 'google' | 'elevenlabs') => {
    showSaveIndicator();
    try {
      if (type === 'anthropic') {
        await window.electronAPI.settings.setApiKey(key);
      } else if (type === 'openai') {
        await window.electronAPI.audio.setOpenAiKey(key);
      } else if (type === 'google') {
        await window.electronAPI.settings.setGoogleApiKey(key);
      } else if (type === 'elevenlabs') {
        await window.electronAPI.audio.setElevenLabsKey(key);
      }
      console.log(`[SettingsDialog] Auto-saved ${type} API key`);
    } catch (error) {
      console.error(`Failed to auto-save ${type} API key:`, error);
    }
  }, [showSaveIndicator]);

  // Debounced text input handler
  const handleDebouncedChange = useCallback((value: string, saveFn: (value: string) => void) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      saveFn(value);
    }, 500);
  }, []);

  // Load all settings on open — fast store reads first, slow QMD check independently
  useEffect(() => {
    if (isSettingsOpen) {
      setIsLoading(true);

      // These are all instant electron-store reads — never hang
      Promise.all([
        window.electronAPI.settings.getApiKey(),
        window.electronAPI.audio.getOpenAiKey(),
        window.electronAPI.settings.getGoogleApiKey(),
        window.electronAPI.settings.get(),
        loadSettings(),
        window.electronAPI.audio.getElevenLabsKey(),
      ])
        .then(([anthropicKey, openAiKey, googleKey, appSettings, , elevenLabsKey]) => {
          console.log('[SettingsDialog] Loaded settings:', appSettings);
          setApiKey(anthropicKey || '');
          setOpenaiApiKey(openAiKey || '');
          setGoogleApiKey(googleKey || '');
          setElevenLabsApiKey(elevenLabsKey || '');
          setQmdEnabled(appSettings.qmdEnabled || false);
          setUltraPlanMode(appSettings.ultraPlanMode || false);
          setShowClearContextOnPlanAccept((appSettings as any).showClearContextOnPlanAccept || false);
          setLunchReminderEnabled(appSettings.lunchReminderEnabled || false);
          setLunchReminderTime(appSettings.lunchReminderTime || '12:00');
          setBedtimeReminderEnabled(appSettings.bedtimeReminderEnabled || false);
          setBedtimeReminderTime(appSettings.bedtimeReminderTime || '23:00');
          setDailyReviewEnabled((appSettings as any).dailyReviewEnabled ?? true);
          setDailyReviewTime((appSettings as any).dailyReviewTime || '09:00');
          setBedtimeTaskReviewEnabled((appSettings as any).bedtimeTaskReviewEnabled ?? true);
          setFoundryEnabled(appSettings.foundryEnabled || false);
          setFoundryBaseUrl(appSettings.foundryBaseUrl || '');
          setFoundryApiKey(appSettings.foundryApiKey || '');
          setFoundryDefaultSonnetModel(appSettings.foundryDefaultSonnetModel || '');
          setFoundryDefaultHaikuModel(appSettings.foundryDefaultHaikuModel || '');
          setFoundryDefaultOpusModel(appSettings.foundryDefaultOpusModel || '');
          setCustomModels((appSettings as any).customModels || []);
          setCursorApiKey((appSettings as any).cursorApiKey || '');
          setDeepseekApiKey((appSettings as any).deepseekApiKey || '');
          setGeminiApiKey((appSettings as any).geminiApiKey || '');
          // Auto Build config
          const savedAutoConfig = (appSettings as any).autoRouterConfig;
          if (savedAutoConfig) {
            setAutoBuildModels(migrateAutoBuildModels(savedAutoConfig));
          }
          if (savedAutoConfig?.costAware !== undefined) {
            setAutoBuildCostAware(savedAutoConfig.costAware);
          }
          setIsLoading(false);
        })
        .catch((error) => {
          console.error('Failed to load settings:', error);
          setIsLoading(false);
        });

      // QMD spawns shell processes — load independently so it never blocks API keys
      window.electronAPI.qmd.getStatus()
        .then((s) => setQmdStatus(s))
        .catch((err) => console.warn('[SettingsDialog] QMD status check failed:', err));
    }
  }, [isSettingsOpen, loadSettings]);

  // Update local state when audio settings load
  useEffect(() => {
    if (audioSettings) {
      setVoiceModeEnabled(audioSettings.voiceModeEnabled || false);
      setRalphLoopEnabled(audioSettings.ralphLoopEnabled || false);
      setComputerUseEnabled(audioSettings.computerUseEnabled || false);
      setMaxComputerUseIterations(audioSettings.maxComputerUseIterations || 20);
      setElevenLabsAgentId(audioSettings.elevenLabsAgentId || '');
    }
  }, [audioSettings]);

  // Cleanup timeouts
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSettings();
    }
  };

  // Handle QMD auto-install
  const handleInstallQmd = useCallback(async () => {
    setIsInstallingQmd(true);
    setQmdInstallMessage('Installing QMD...');

    const unsubscribe = window.electronAPI.qmd.onIndexingProgress((data) => {
      setQmdInstallMessage(data.message);
    });

    try {
      const success = await window.electronAPI.qmd.autoInstall();
      if (success) {
        setQmdInstallMessage('QMD installed successfully!');
        const newStatus = await window.electronAPI.qmd.getStatus();
        setQmdStatus(newStatus);
        setTimeout(() => setQmdInstallMessage(''), 2000);
      } else {
        setQmdInstallMessage('Installation failed');
        setTimeout(() => setQmdInstallMessage(''), 3000);
      }
    } catch (error) {
      console.error('Failed to install QMD:', error);
      setQmdInstallMessage('Installation failed');
      setTimeout(() => setQmdInstallMessage(''), 3000);
    } finally {
      setIsInstallingQmd(false);
      unsubscribe();
    }
  }, []);

  // Toggle component for consistent styling
  const Toggle = ({ enabled, onChange, disabled = false, color = 'bg-claude-accent' }: {
    enabled: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    color?: string;
  }) => (
    <button
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center transition-colors ${
        enabled ? color : 'bg-claude-border'
      } disabled:opacity-50`}
      style={{ borderRadius: 0 }}
    >
      <span
        className={`inline-block h-4 w-4 transform bg-white transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );

  // API Key input component
  if (!isSettingsOpen) return null;

  // Render General Tab
  const renderGeneralTab = () => (
    <div className="space-y-6">
      {/* QMD Semantic Search */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-blue-400" />
          <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
            Semantic Codebase Search
          </h3>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Enable QMD Search
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              AI-powered semantic search through your codebase
            </p>
          </div>
          <Toggle
            enabled={qmdEnabled}
            onChange={(value) => {
              setQmdEnabled(value);
              autoSaveAppSettings({ qmdEnabled: value });
            }}
            disabled={isLoading}
            color="bg-blue-500"
          />
        </div>

        {qmdStatus && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono text-claude-text-secondary">
              {qmdStatus.installed ? (
                <span className="text-green-400">
                  QMD {qmdStatus.bundled ? '(bundled)' : '(installed)'} ready
                </span>
              ) : isInstallingQmd ? (
                <span className="flex items-center gap-2 text-blue-400">
                  <Loader2 size={12} className="animate-spin" />
                  {qmdInstallMessage || 'Installing...'}
                </span>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-amber-400">QMD not installed</span>
                  <button
                    onClick={handleInstallQmd}
                    disabled={isLoading}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
                    style={{ borderRadius: 0 }}
                  >
                    <Download size={10} />
                    Install
                  </button>
                </div>
              )}
            </div>
            {qmdInstallMessage && !isInstallingQmd && (
              <div className="text-[10px] font-mono text-green-400">
                {qmdInstallMessage}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lunch Reminder */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
          Reminders
        </h3>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Lunch Reminder
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Get reminded to log your lunch at a specific time
            </p>
          </div>
          <Toggle
            enabled={lunchReminderEnabled}
            onChange={(value) => {
              setLunchReminderEnabled(value);
              autoSaveAppSettings({ lunchReminderEnabled: value });
            }}
            disabled={isLoading}
            color="bg-green-500"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
            Reminder Time
          </label>
          <input
            type="time"
            value={lunchReminderTime}
            onChange={(e) => {
              const value = e.target.value;
              setLunchReminderTime(value);
              autoSaveAppSettings({ lunchReminderTime: value });
            }}
            disabled={isLoading || !lunchReminderEnabled}
            className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm focus:outline-none focus:border-claude-accent disabled:opacity-50"
            style={{ borderRadius: 0 }}
          />
          <p className="text-[10px] font-mono text-claude-text-secondary">
            Time to remind you to take a lunch break
          </p>
        </div>
      </div>

      {/* Bedtime Reminder */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Bedtime Reminder
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Get reminded to go to bed — with 5-minute snooze
            </p>
          </div>
          <Toggle
            enabled={bedtimeReminderEnabled}
            onChange={(value) => {
              setBedtimeReminderEnabled(value);
              autoSaveAppSettings({ bedtimeReminderEnabled: value });
            }}
            disabled={isLoading}
            color="bg-indigo-500"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
            Bedtime
          </label>
          <input
            type="time"
            value={bedtimeReminderTime}
            onChange={(e) => {
              const value = e.target.value;
              setBedtimeReminderTime(value);
              autoSaveAppSettings({ bedtimeReminderTime: value });
            }}
            disabled={isLoading || !bedtimeReminderEnabled}
            className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm focus:outline-none focus:border-claude-accent disabled:opacity-50"
            style={{ borderRadius: 0 }}
          />
          <p className="text-[10px] font-mono text-claude-text-secondary">
            Clock turns indigo → amber → red as bedtime approaches. Dialog locks the app at bedtime.
          </p>
        </div>
      </div>

      {/* Daily Task Review */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
          Task Reviews
        </h3>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Daily Task Review
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Morning prompt to review and plan your tasks
            </p>
          </div>
          <Toggle
            enabled={dailyReviewEnabled}
            onChange={(value) => {
              setDailyReviewEnabled(value);
              autoSaveAppSettings({ dailyReviewEnabled: value });
            }}
            disabled={isLoading}
            color="bg-emerald-500"
          />
        </div>

        {dailyReviewEnabled && (
          <div className="space-y-2">
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Review Time
            </label>
            <input
              type="time"
              value={dailyReviewTime}
              onChange={(e) => {
                const value = e.target.value;
                setDailyReviewTime(value);
                autoSaveAppSettings({ dailyReviewTime: value });
              }}
              disabled={isLoading}
              className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm focus:outline-none focus:border-claude-accent disabled:opacity-50"
              style={{ borderRadius: 0 }}
            />
            <p className="text-[10px] font-mono text-claude-text-secondary">
              Shows a task review modal after this time (until 6 PM)
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Bedtime Task Review
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Review tasks 30 minutes before bedtime
            </p>
          </div>
          <Toggle
            enabled={bedtimeTaskReviewEnabled}
            onChange={(value) => {
              setBedtimeTaskReviewEnabled(value);
              autoSaveAppSettings({ bedtimeTaskReviewEnabled: value });
            }}
            disabled={isLoading}
            color="bg-indigo-500"
          />
        </div>
      </div>

      {/* Ultra Plan Mode */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-purple-400" />
          <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
            Ultra Plan Mode
          </h3>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Enable Ultra Plan Mode
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              After plan approval, automatically create structured tasks with dependencies
            </p>
          </div>
          <Toggle
            enabled={ultraPlanMode}
            onChange={(value) => {
              setUltraPlanMode(value);
              autoSaveAppSettings({ ultraPlanMode: value });
            }}
            disabled={isLoading}
            color="bg-purple-500"
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Clear Context on Plan Accept
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Show option to summarize and start with clean context when approving a plan
            </p>
          </div>
          <Toggle
            enabled={showClearContextOnPlanAccept}
            onChange={(value) => {
              setShowClearContextOnPlanAccept(value);
              autoSaveAppSettings({ showClearContextOnPlanAccept: value });
            }}
            disabled={isLoading}
            color="bg-purple-500"
          />
        </div>
      </div>

      {/* Ralph Loop Toggle */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
          Just Build It Mode
        </h3>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Ralph Loop (Persistent Work)
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Agent keeps working until task is objectively complete
            </p>
          </div>
          <Toggle
            enabled={ralphLoopEnabled}
            onChange={(value) => {
              setRalphLoopEnabled(value);
              autoSaveAudioSettings({ ralphLoopEnabled: value });
            }}
            disabled={isLoading}
            color="bg-purple-500"
          />
        </div>

        {/* Computer Use API Settings */}
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Computer Use Mode (Visual Automation)
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Enable Claude-powered screenshot-based browser automation
            </p>
            {computerUseEnabled && (
              <p className="text-[10px] font-mono text-amber-500 mt-1">
                ⚠️ Requires Anthropic API (not compatible with Foundry)
              </p>
            )}
          </div>
          <Toggle
            enabled={computerUseEnabled}
            onChange={(value) => {
              setComputerUseEnabled(value);
              autoSaveAudioSettings({ computerUseEnabled: value });
            }}
            disabled={isLoading}
            color="bg-blue-500"
          />
        </div>

        {/* Max Computer Use Iterations */}
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Max Computer Use Iterations
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Limit iterations to prevent runaway loops (default: 20)
            </p>
          </div>
          <input
            type="number"
            min="1"
            max="50"
            value={maxComputerUseIterations}
            onChange={(e) => {
              const value = parseInt(e.target.value) || 20;
              setMaxComputerUseIterations(value);
              autoSaveAudioSettings({ maxComputerUseIterations: value });
            }}
            disabled={isLoading}
            className="w-20 px-2 py-1 bg-claude-surface border border-claude-border text-claude-text text-xs font-mono rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>
      </div>

      {/* Voice Conversation Mode */}
      <div className="space-y-4 pt-4 border-t border-claude-border">
        <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
          Voice Conversation Mode (Experimental)
        </h3>

        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Enable Voice Conversation
            </label>
            <p className="text-[10px] font-mono text-claude-text-secondary mt-1">
              Hands-free speech-to-speech conversations with Claude
            </p>
          </div>
          <Toggle
            enabled={voiceModeEnabled}
            onChange={(value) => {
              setVoiceModeEnabled(value);
              autoSaveAudioSettings({ voiceModeEnabled: value });
            }}
            disabled={isLoading}
          />
        </div>
      </div>
    </div>
  );

  // Render Auto Build Tab
  const renderAutoBuildTab = () => {
    const getHarnessLabel = (id: string) => {
      if (id.startsWith('codex:')) return 'Codex';
      if (id.startsWith('cursor:')) return 'Cursor';
      if (id.startsWith('gemini:')) return 'Gemini';
      if (id.startsWith('opencode:')) return 'DeepSeek';
      if (id.startsWith('custom:')) return 'Custom';
      if (id.startsWith('claude-')) return 'Claude';
      return '';
    };

    const allModelsById = new Map<string, { id: string; name: string; harness: string }>();
    availableModels
      .filter(m => m.id !== 'auto')
      .forEach(m => {
        allModelsById.set(m.id, {
          id: m.id,
          name: m.name,
          harness: getHarnessLabel(m.id),
        });
      });
    Object.values(autoBuildModels)
      .filter(modelId => modelId && modelId !== 'auto')
      .forEach(modelId => {
        if (!allModelsById.has(modelId)) {
          allModelsById.set(modelId, {
            id: modelId,
            name: modelId,
            harness: getHarnessLabel(modelId),
          });
        }
      });
    const allModels = Array.from(allModelsById.values());

    const saveAutoBuildConfig = (models: AutoBuildModelSettings, costAware = autoBuildCostAware) => {
      autoSaveAppSettings({
        autoRouterConfig: autoBuildConfigFromState(models, costAware),
      } as any);
    };

    const updateTierModel = (id: AutoBuildModelKey, model: string) => {
      const updated = { ...autoBuildModels, [id]: model };
      setAutoBuildModels(updated);
      saveAutoBuildConfig(updated);
    };

    return (
      <div className="space-y-4 p-4 overflow-y-auto max-h-[460px]">
        <div>
          <h3 className="text-sm font-medium text-claude-text mb-1">Auto Build Routing</h3>
          <p className="text-[10px] text-claude-text-secondary mb-4">
            Pick the harness/model for each fixed task category. When Auto Build is selected, routing assigns the turn to one of these categories and delegates execution to the selected harness.
          </p>
        </div>

        {/* Fixed tier -> model mapping */}
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">Fixed categories</label>
            <span className="text-[10px] text-claude-text-secondary">Auto Build delegates only to these category choices</span>
          </div>

          {AUTO_BUILD_MODEL_ROWS.map((row) => (
            <div key={row.id} className="grid grid-cols-[130px_14px_1fr] items-center gap-2">
              <div>
                <div className="text-xs font-mono text-claude-text">{row.label}</div>
                <div className="text-[9px] text-claude-text-secondary truncate">{row.detail}</div>
              </div>

              <span className="text-claude-text-secondary text-[10px]">→</span>

              <select
                value={autoBuildModels[row.id]}
                onChange={(e) => updateTierModel(row.id, e.target.value)}
                className="flex-1 bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
              >
                {allModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.harness ? `${m.name.replace(/ \(Codex\)| \(Cursor\)/, '')} [${m.harness}]` : m.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Cost-aware routing toggle */}
        <div className="border-t border-claude-border/30 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-xs text-claude-text">Cost-aware routing</label>
              <p className="text-[10px] text-claude-text-secondary">Automatically downgrade models when monthly spend is high</p>
            </div>
            <button
              onClick={() => {
                const next = !autoBuildCostAware;
                setAutoBuildCostAware(next);
                saveAutoBuildConfig(autoBuildModels, next);
              }}
              className={`w-8 h-4 rounded-full transition-colors relative ${autoBuildCostAware ? 'bg-claude-accent' : 'bg-claude-border'}`}
            >
              <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-transform ${autoBuildCostAware ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>

        {/* Info section */}
        <div className="border-t border-claude-border/30 pt-4">
          <p className="text-[10px] text-claude-text-secondary">
            Select <span className="text-purple-400 font-bold">Auto Build</span> from the model picker in any session. Build injects transcripts, project instructions, agents, and skills into CLI harnesses where possible.
          </p>
        </div>
      </div>
    );
  };

  // Render API Keys Tab
  const renderApiKeysTab = () => (
    <div className="space-y-6">
      {/* Anthropic API Key */}
      <div className="space-y-2">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          Anthropic API Key
        </label>
        <ApiKeyInput
          value={apiKey}
          onChange={setApiKey}
          show={showApiKey}
          onToggleShow={() => setShowApiKey(!showApiKey)}
          placeholder="sk-ant-..."
          onSave={(value) => autoSaveApiKey(value, 'anthropic')}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          Get your API key from{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://console.anthropic.com/settings/keys');
            }}
            className="text-claude-accent hover:underline"
          >
            console.anthropic.com
          </a>
          . Or skip this and run <span className="text-claude-text">claude login</span> in your terminal to use OAuth.
        </p>
      </div>

      {/* Anthropic Foundry */}
      <div className="space-y-3 pt-4 border-t border-claude-border">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
            Anthropic Foundry
          </label>
          <button
            onClick={() => {
              const newValue = !foundryEnabled;
              setFoundryEnabled(newValue);
              autoSaveAppSettings({ foundryEnabled: newValue });
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              foundryEnabled ? 'bg-claude-accent' : 'bg-claude-border'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                foundryEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>
        {foundryEnabled && (
          <div className="space-y-3 pl-2 border-l-2 border-claude-accent/30">
            <div>
              <label className="block text-[10px] font-mono text-claude-text-secondary mb-1">Base URL</label>
              <input
                type="text"
                value={foundryBaseUrl}
                onChange={(e) => {
                  const val = e.target.value;
                  setFoundryBaseUrl(val);
                  handleDebouncedChange(val, (v) => autoSaveAppSettings({ foundryBaseUrl: v }));
                }}
                placeholder="https://your-foundry-endpoint/v1/messages"
                className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
                style={{ borderRadius: 0 }}
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-claude-text-secondary mb-1">Foundry API Key</label>
              <ApiKeyInput
                value={foundryApiKey}
                onChange={setFoundryApiKey}
                show={showFoundryApiKey}
                onToggleShow={() => setShowFoundryApiKey(!showFoundryApiKey)}
                placeholder="foundry-..."
                onSave={(value) => autoSaveAppSettings({ foundryApiKey: value })}
                isLoading={isLoading}
                handleDebouncedChange={handleDebouncedChange}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-[10px] font-mono text-claude-text-secondary">Model Overrides (optional)</label>
              <input
                type="text"
                value={foundryDefaultSonnetModel}
                onChange={(e) => {
                  const val = e.target.value;
                  setFoundryDefaultSonnetModel(val);
                  handleDebouncedChange(val, (v) => autoSaveAppSettings({ foundryDefaultSonnetModel: v }));
                }}
                placeholder="Sonnet model name"
                className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
                style={{ borderRadius: 0 }}
              />
              <input
                type="text"
                value={foundryDefaultHaikuModel}
                onChange={(e) => {
                  const val = e.target.value;
                  setFoundryDefaultHaikuModel(val);
                  handleDebouncedChange(val, (v) => autoSaveAppSettings({ foundryDefaultHaikuModel: v }));
                }}
                placeholder="Haiku model name"
                className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
                style={{ borderRadius: 0 }}
              />
              <input
                type="text"
                value={foundryDefaultOpusModel}
                onChange={(e) => {
                  const val = e.target.value;
                  setFoundryDefaultOpusModel(val);
                  handleDebouncedChange(val, (v) => autoSaveAppSettings({ foundryDefaultOpusModel: v }));
                }}
                placeholder="Opus model name"
                className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
                style={{ borderRadius: 0 }}
              />
            </div>
          </div>
        )}
      </div>

      {/* OpenAI API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          OpenAI API Key (Speech-to-Text)
        </label>
        <ApiKeyInput
          value={openaiApiKey}
          onChange={setOpenaiApiKey}
          show={showOpenaiApiKey}
          onToggleShow={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
          placeholder="sk-..."
          onSave={(value) => autoSaveApiKey(value, 'openai')}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          For voice transcription using Whisper.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://platform.openai.com/api-keys');
            }}
            className="text-claude-accent hover:underline"
          >
            Get key
          </a>
        </p>
      </div>

      {/* ElevenLabs API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          ElevenLabs API Key
        </label>
        <ApiKeyInput
          value={elevenLabsApiKey}
          onChange={setElevenLabsApiKey}
          show={showElevenLabsApiKey}
          onToggleShow={() => setShowElevenLabsApiKey(!showElevenLabsApiKey)}
          placeholder="xi-..."
          onSave={(value) => autoSaveApiKey(value, 'elevenlabs')}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          Required for voice mode.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://elevenlabs.io/app/settings/api-keys');
            }}
            className="text-claude-accent hover:underline"
          >
            Get your key at elevenlabs.io
          </a>
        </p>
      </div>

      {/* ElevenLabs Agent ID */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          ElevenLabs Agent ID
        </label>
        <div className="relative">
          <input
            type="text"
            value={elevenLabsAgentId}
            onChange={(e) => {
              const newValue = e.target.value;
              setElevenLabsAgentId(newValue);
              handleDebouncedChange(newValue, (v) => autoSaveAudioSettings({ elevenLabsAgentId: v }));
            }}
            placeholder="agent_..."
            disabled={isLoading}
            className="w-full px-3 py-2 bg-claude-bg border border-claude-border text-claude-text font-mono text-sm placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent disabled:opacity-50"
            style={{ borderRadius: 0 }}
          />
        </div>
        <p className="text-[10px] font-mono text-claude-text-secondary">
          Your Conversational AI agent ID for voice mode
        </p>
      </div>

      {/* Cursor API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          Cursor API Key
        </label>
        <ApiKeyInput
          value={cursorApiKey}
          onChange={setCursorApiKey}
          show={showCursorApiKey}
          onToggleShow={() => setShowCursorApiKey(!showCursorApiKey)}
          placeholder="cur-..."
          onSave={(value) => autoSaveAppSettings({ cursorApiKey: value })}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          For Cursor coding agent (local sessions only).{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://cursor.com/settings');
            }}
            className="text-claude-accent hover:underline"
          >
            Get your key at cursor.com
          </a>
        </p>
      </div>

      {/* DeepSeek API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          DeepSeek API Key
        </label>
        <ApiKeyInput
          value={deepseekApiKey}
          onChange={setDeepseekApiKey}
          show={showDeepseekApiKey}
          onToggleShow={() => setShowDeepseekApiKey(!showDeepseekApiKey)}
          placeholder="sk-..."
          onSave={(value) => autoSaveAppSettings({ deepseekApiKey: value })}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          For DeepSeek models via OpenCode agent.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://platform.deepseek.com');
            }}
            className="text-claude-accent hover:underline"
          >
            Get your key at platform.deepseek.com
          </a>
        </p>
      </div>

      {/* Gemini CLI API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          Gemini API Key
        </label>
        <ApiKeyInput
          value={geminiApiKey}
          onChange={setGeminiApiKey}
          show={showGeminiApiKey}
          onToggleShow={() => setShowGeminiApiKey(!showGeminiApiKey)}
          placeholder="Enter your Google Gemini API key"
          onSave={(value) => autoSaveAppSettings({ geminiApiKey: value })}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          For Gemini coding agent via CLI (gemini-2.5-pro, gemini-2.5-flash).{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://aistudio.google.com/apikey');
            }}
            className="text-claude-accent hover:underline"
          >
            Get your key at aistudio.google.com
          </a>
        </p>
      </div>

      {/* Google/Gemini API Key (Browser AI) */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          Google/Gemini API Key (Browser AI)
        </label>
        <ApiKeyInput
          value={googleApiKey}
          onChange={setGoogleApiKey}
          show={showGoogleApiKey}
          onToggleShow={() => setShowGoogleApiKey(!showGoogleApiKey)}
          placeholder="AIza..."
          onSave={(value) => autoSaveApiKey(value, 'google')}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          For AI-powered browser automation (Stagehand).{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://aistudio.google.com/app/apikey');
            }}
            className="text-claude-accent hover:underline"
          >
            Get key
          </a>
        </p>
      </div>

      {/* Custom Models (Kimi, Gemini, etc via Anthropic-compatible proxy) */}
      <div className="space-y-3 pt-4 border-t border-claude-border">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
            Custom Models
          </label>
          <button
            onClick={() => {
              const newModel = {
                id: `model-${Date.now()}`,
                name: '',
                modelId: '',
                baseUrl: '',
                apiKey: '',
                description: '',
              };
              const updated = [...customModels, newModel];
              setCustomModels(updated);
            }}
            className="px-2 py-0.5 text-[10px] font-mono text-claude-accent border border-claude-accent/30 hover:bg-claude-accent/10 uppercase"
            style={{ borderRadius: 0 }}
          >
            + Add Model
          </button>
        </div>
        <p className="text-[9px] text-claude-text-secondary">
          Add third-party models via Anthropic-compatible API proxies (e.g. Kimi K2.6, Gemini).
        </p>
        {customModels.map((model, index) => (
          <div key={model.id} className="space-y-2 pl-2 border-l-2 border-cyan-500/30 pb-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-cyan-400 uppercase">Model {index + 1}</span>
              <button
                onClick={() => {
                  const updated = customModels.filter((_, i) => i !== index);
                  setCustomModels(updated);
                  autoSaveAppSettings({ customModels: updated });
                }}
                className="text-[10px] text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
            <input
              type="text"
              value={model.name}
              onChange={(e) => {
                const updated = [...customModels];
                updated[index] = { ...updated[index], name: e.target.value };
                setCustomModels(updated);
                handleDebouncedChange(e.target.value, () => autoSaveAppSettings({ customModels: updated }));
              }}
              placeholder="Display name (e.g. Kimi K2.6)"
              className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
              style={{ borderRadius: 0 }}
            />
            <input
              type="text"
              value={model.modelId}
              onChange={(e) => {
                const updated = [...customModels];
                updated[index] = { ...updated[index], modelId: e.target.value };
                setCustomModels(updated);
                handleDebouncedChange(e.target.value, () => autoSaveAppSettings({ customModels: updated }));
              }}
              placeholder="Model ID (e.g. kimi-k2.6-0528)"
              className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
              style={{ borderRadius: 0 }}
            />
            <input
              type="text"
              value={model.baseUrl}
              onChange={(e) => {
                const updated = [...customModels];
                updated[index] = { ...updated[index], baseUrl: e.target.value };
                setCustomModels(updated);
                handleDebouncedChange(e.target.value, () => autoSaveAppSettings({ customModels: updated }));
              }}
              placeholder="API base URL (e.g. https://api.moonshot.ai/anthropic)"
              className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
              style={{ borderRadius: 0 }}
            />
            <input
              type="password"
              value={model.apiKey}
              onChange={(e) => {
                const updated = [...customModels];
                updated[index] = { ...updated[index], apiKey: e.target.value };
                setCustomModels(updated);
                handleDebouncedChange(e.target.value, () => autoSaveAppSettings({ customModels: updated }));
              }}
              placeholder="API key"
              className="w-full px-3 py-1.5 bg-claude-bg border border-claude-border text-claude-text font-mono text-xs placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
              style={{ borderRadius: 0 }}
            />
          </div>
        ))}
      </div>

      {/* Info */}
      <div className="pt-4">
        <p className="text-[10px] font-mono text-claude-text-secondary text-center">
          API keys are stored locally and encrypted. Voice features require external API keys.
        </p>
      </div>
    </div>
  );

  // Render Releases Tab
  const renderReleasesTab = () => (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-purple-400" />
        <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
          What's New
        </h3>
      </div>
      <ReleaseNotes />
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return renderGeneralTab();
      case 'autoBuild':
        return renderAutoBuildTab();
      case 'apiKeys':
        return renderApiKeysTab();
      case 'releases':
        return renderReleasesTab();
      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={closeSettings}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-[680px] h-[560px] bg-claude-surface border border-claude-border flex"
        onClick={(e) => e.stopPropagation()}
        style={{ borderRadius: 0 }}
      >
        {/* Left Sidebar - Tab Navigation */}
        <div className="w-[160px] border-r border-claude-border bg-claude-bg flex flex-col">
          <div className="p-3 border-b border-claude-border">
            <h2 className="text-xs font-mono font-bold text-claude-text uppercase tracking-wider">
              Settings
            </h2>
          </div>
          <nav className="flex-1 py-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === tab.id
                    ? 'bg-claude-accent text-white'
                    : 'text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </nav>
          {/* Save status indicator */}
          <div className="p-3 border-t border-claude-border">
            <div className={`text-[10px] font-mono text-center transition-opacity duration-200 ${
              saveStatus === 'idle' ? 'opacity-0' : 'opacity-100'
            }`}>
              {saveStatus === 'saving' && (
                <span className="text-claude-text-secondary flex items-center justify-center gap-1">
                  <Loader2 size={10} className="animate-spin" />
                  Saving...
                </span>
              )}
              {saveStatus === 'saved' && (
                <span className="text-green-400 flex items-center justify-center gap-1">
                  <Check size={10} />
                  Saved
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border">
            <h3 className="text-xs font-mono font-bold text-claude-text uppercase tracking-wider">
              {TABS.find(t => t.id === activeTab)?.label}
            </h3>
            <button
              onClick={closeSettings}
              className="p-1 text-claude-text-secondary hover:text-claude-text transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
