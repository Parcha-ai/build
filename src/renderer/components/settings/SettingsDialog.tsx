import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Eye, EyeOff, Check, Loader2, Search, Download, Sparkles, Settings, Key, History } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';
import ReleaseNotes from '../common/ReleaseNotes';

type TabId = 'general' | 'apiKeys' | 'releases';

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.ReactNode;
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

  // Audio settings
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [ralphLoopEnabled, setRalphLoopEnabled] = useState(false);
  const [computerUseEnabled, setComputerUseEnabled] = useState(false);
  const [maxComputerUseIterations, setMaxComputerUseIterations] = useState(20);

  // General settings
  const [qmdEnabled, setQmdEnabled] = useState(false);
  const [ultraPlanMode, setUltraPlanMode] = useState(false);
  const [lunchReminderEnabled, setLunchReminderEnabled] = useState(false);
  const [lunchReminderTime, setLunchReminderTime] = useState('12:00');
  const [bedtimeReminderEnabled, setBedtimeReminderEnabled] = useState(false);
  const [bedtimeReminderTime, setBedtimeReminderTime] = useState('23:00');

  // Foundry settings
  const [foundryEnabled, setFoundryEnabled] = useState(false);
  const [foundryBaseUrl, setFoundryBaseUrl] = useState('');
  const [foundryApiKey, setFoundryApiKey] = useState('');
  const [showFoundryApiKey, setShowFoundryApiKey] = useState(false);
  const [foundryDefaultSonnetModel, setFoundryDefaultSonnetModel] = useState('');
  const [foundryDefaultHaikuModel, setFoundryDefaultHaikuModel] = useState('');
  const [foundryDefaultOpusModel, setFoundryDefaultOpusModel] = useState('');


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
  const autoSaveAppSettings = useCallback(async (updates: { qmdEnabled?: boolean; ultraPlanMode?: boolean; lunchReminderEnabled?: boolean; lunchReminderTime?: string; bedtimeReminderEnabled?: boolean; bedtimeReminderTime?: string; foundryEnabled?: boolean; foundryBaseUrl?: string; foundryApiKey?: string; foundryDefaultSonnetModel?: string; foundryDefaultHaikuModel?: string; foundryDefaultOpusModel?: string }) => {
    showSaveIndicator();
    try {
      await window.electronAPI.settings.set(updates);
      console.log('[SettingsDialog] Auto-saved app settings:', updates);

      // Reload available models if Foundry settings changed
      const isFoundryUpdate = 'foundryEnabled' in updates || 'foundryDefaultSonnetModel' in updates || 'foundryDefaultHaikuModel' in updates || 'foundryDefaultOpusModel' in updates;
      if (isFoundryUpdate) {
        console.log('[SettingsDialog] Foundry settings changed, reloading available models');
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
  const autoSaveApiKey = useCallback(async (key: string, type: 'anthropic' | 'openai' | 'google') => {
    showSaveIndicator();
    try {
      if (type === 'anthropic') {
        await window.electronAPI.settings.setApiKey(key);
      } else if (type === 'openai') {
        await window.electronAPI.audio.setOpenAiKey(key);
      } else if (type === 'google') {
        await window.electronAPI.settings.setGoogleApiKey(key);
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

  // Load all settings on open
  useEffect(() => {
    if (isSettingsOpen) {
      setIsLoading(true);
      Promise.all([
        window.electronAPI.settings.getApiKey(),
        window.electronAPI.audio.getOpenAiKey(),
        window.electronAPI.settings.getGoogleApiKey(),
        window.electronAPI.settings.get(),
        window.electronAPI.qmd.getStatus(),
        loadSettings(),
      ])
        .then(([anthropicKey, openAiKey, googleKey, appSettings, qmdStatusResult]) => {
          console.log('[SettingsDialog] Loaded settings:', appSettings);
          setApiKey(anthropicKey || '');
          setOpenaiApiKey(openAiKey || '');
          setGoogleApiKey(googleKey || '');
          setQmdEnabled(appSettings.qmdEnabled || false);
          setUltraPlanMode(appSettings.ultraPlanMode || false);
          setLunchReminderEnabled(appSettings.lunchReminderEnabled || false);
          setLunchReminderTime(appSettings.lunchReminderTime || '12:00');
          setBedtimeReminderEnabled(appSettings.bedtimeReminderEnabled || false);
          setBedtimeReminderTime(appSettings.bedtimeReminderTime || '23:00');
          // Foundry settings
          setFoundryEnabled(appSettings.foundryEnabled || false);
          setFoundryBaseUrl(appSettings.foundryBaseUrl || '');
          setFoundryApiKey(appSettings.foundryApiKey || '');
          setFoundryDefaultSonnetModel(appSettings.foundryDefaultSonnetModel || '');
          setFoundryDefaultHaikuModel(appSettings.foundryDefaultHaikuModel || '');
          setFoundryDefaultOpusModel(appSettings.foundryDefaultOpusModel || '');
          setQmdStatus(qmdStatusResult);
          setIsLoading(false);
        })
        .catch((error) => {
          console.error('Failed to load settings:', error);
          setIsLoading(false);
        });
    }
  }, [isSettingsOpen, loadSettings]);

  // Update local state when audio settings load
  useEffect(() => {
    if (audioSettings) {
      setVoiceModeEnabled(audioSettings.voiceModeEnabled || false);
      setRalphLoopEnabled(audioSettings.ralphLoopEnabled || false);
      setComputerUseEnabled(audioSettings.computerUseEnabled || false);
      setMaxComputerUseIterations(audioSettings.maxComputerUseIterations || 20);
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

      {/* Google/Gemini API Key */}
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

      {/* Anthropic Foundry (Azure) */}
      <div className="space-y-3 pt-4 border-t border-claude-border">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
            Anthropic Foundry (Azure)
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
                placeholder="https://your-endpoint.cognitiveservices.azure.com/anthropic/v1/messages"
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
