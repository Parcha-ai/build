import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Eye, EyeOff, Check, Loader2, Search, Download, Sparkles, Settings, Key, History, AlertCircle, ExternalLink, Terminal, Copy, Bot, RefreshCw, BookOpen, Plus, Trash2 } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';
import ReleaseNotes from '../common/ReleaseNotes';
import type { ParableCheckConfig, ParableConfig, ParableExecutorConfig, ParableTaskClass } from '../../../shared/types';
import { cloneDefaultParableConfig, PARABLE_MODE_ID, PARABLE_TASK_CLASSES } from '../../../shared/config/parable';
import { CASCADE_MODE_ID } from '../../../shared/config/cascade';
import { getKnownModelPricing } from '../../../shared/config/model-pricing';

type TabId = 'general' | 'autoBuild' | 'parable' | 'agents' | 'releases';

type ProviderStatus = {
  installed?: boolean;
  loggedIn: boolean;
  method?: 'cli' | 'apiKey' | 'chatgpt';
  detail?: string;
  path?: string | null;
  version?: string | null;
  installCommand?: string;
  docsUrl?: string;
};

type ProvidersState = {
  claude: ProviderStatus;
  codex: ProviderStatus;
  cursor: ProviderStatus;
  gemini: ProviderStatus;
  grok: ProviderStatus;
  opencode: ProviderStatus;
};

const DEFAULT_PROVIDERS: ProvidersState = {
  claude: { loggedIn: false },
  codex: { loggedIn: false },
  cursor: { loggedIn: false },
  gemini: { loggedIn: false },
  grok: { loggedIn: false },
  opencode: { loggedIn: false },
};

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

type AutoBuildModelKey = 'plan' | 'build' | 'verify' | 'refine' | 'fallback';

type AutoBuildModelSettings = Record<AutoBuildModelKey, string>;

type AutoBuildEffortSettings = Record<AutoBuildModelKey, string>;
type AutoBuildSpeedSettings = Record<AutoBuildModelKey, string>;
type AutoBuildWorkflowSettings = Record<AutoBuildModelKey, string>;
type AutoBuildVerificationSettings = Record<AutoBuildModelKey, string>;
type AutoBuildBudgetSettings = Record<AutoBuildModelKey, string>;

const AUTO_BUILD_EFFORT_DEFAULTS: AutoBuildEffortSettings = {
  plan: '',
  build: '',
  verify: '',
  refine: '',
  fallback: '',
};

const AUTO_BUILD_SPEED_DEFAULTS: AutoBuildSpeedSettings = {
  plan: 'auto',
  build: 'auto',
  verify: 'auto',
  refine: 'auto',
  fallback: 'auto',
};

const AUTO_BUILD_WORKFLOW_DEFAULTS: AutoBuildWorkflowSettings = {
  plan: 'auto',
  build: 'auto',
  verify: 'auto',
  refine: 'auto',
  fallback: 'auto',
};

const AUTO_BUILD_VERIFICATION_DEFAULTS: AutoBuildVerificationSettings = {
  plan: 'auto',
  build: 'auto',
  verify: 'auto',
  refine: 'auto',
  fallback: 'auto',
};

const AUTO_BUILD_BUDGET_DEFAULTS: AutoBuildBudgetSettings = {
  plan: '',
  build: '',
  verify: '',
  refine: '',
  fallback: '',
};

const EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

const SPEED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'standard', label: 'Std' },
  { value: 'fast', label: 'Fast' },
];

const WORKFLOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'single', label: 'Single' },
  { value: 'lead-with-delegates', label: 'Lead+' },
  { value: 'sequential', label: 'Seq' },
  { value: 'dynamic', label: 'Dyn' },
];

const VERIFICATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
  { value: 'optional', label: 'Opt' },
  { value: 'required', label: 'Req' },
];

const AUTO_BUILD_MODEL_DEFAULTS: AutoBuildModelSettings = {
  plan: 'claude-sonnet-4-6',
  build: 'codex:gpt-5.6-sol',
  verify: 'codex:gpt-5.6-sol',
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

interface CustomCategoryState {
  id: string;
  label: string;
  description: string;
  model: string;
  effort: string;
  speed: string;
  workflow: string;
  budgetUsd: string;
  verification: string;
  keywords: string;
}

const FIXED_TIER_IDS = ['plan', 'build', 'verify', 'refine', 'fallback'];

function autoBuildConfigFromState(
  models: AutoBuildModelSettings,
  costAware: boolean,
  effort?: AutoBuildEffortSettings,
  speed?: AutoBuildSpeedSettings,
  workflow?: AutoBuildWorkflowSettings,
  budget?: AutoBuildBudgetSettings,
  verification?: AutoBuildVerificationSettings,
  customCats?: CustomCategoryState[],
  prePlanEnabled = true,
  prePlanModel = 'claude-fable-5',
) {
  const parseBudget = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const categories = (customCats || []).map(c => ({
    id: c.id,
    label: c.label,
    description: c.description,
    model: c.model,
    effort: c.effort || undefined,
    speed: c.speed && c.speed !== 'auto' ? c.speed : undefined,
    workflow: c.workflow && c.workflow !== 'auto' ? c.workflow : undefined,
    budgetUsd: parseBudget(c.budgetUsd),
    verification: c.verification && c.verification !== 'auto' ? c.verification : undefined,
    keywords: c.keywords.split(',').map((k: string) => k.trim()).filter(Boolean),
  }));

  return {
    prePlanEnabled,
    prePlanModel,
    planModel: models.plan,
    buildModel: models.build,
    verifyModel: models.verify,
    refineModel: models.refine,
    fallbackModel: models.fallback,
    ...(effort?.plan ? { planEffort: effort.plan } : {}),
    ...(effort?.build ? { buildEffort: effort.build } : {}),
    ...(effort?.verify ? { verifyEffort: effort.verify } : {}),
    ...(effort?.refine ? { refineEffort: effort.refine } : {}),
    ...(effort?.fallback ? { fallbackEffort: effort.fallback } : {}),
    ...(speed?.plan && speed.plan !== 'auto' ? { planSpeed: speed.plan } : {}),
    ...(speed?.build && speed.build !== 'auto' ? { buildSpeed: speed.build } : {}),
    ...(speed?.verify && speed.verify !== 'auto' ? { verifySpeed: speed.verify } : {}),
    ...(speed?.refine && speed.refine !== 'auto' ? { refineSpeed: speed.refine } : {}),
    ...(speed?.fallback && speed.fallback !== 'auto' ? { fallbackSpeed: speed.fallback } : {}),
    ...(workflow?.plan && workflow.plan !== 'auto' ? { planWorkflow: workflow.plan } : {}),
    ...(workflow?.build && workflow.build !== 'auto' ? { buildWorkflow: workflow.build } : {}),
    ...(workflow?.verify && workflow.verify !== 'auto' ? { verifyWorkflow: workflow.verify } : {}),
    ...(workflow?.refine && workflow.refine !== 'auto' ? { refineWorkflow: workflow.refine } : {}),
    ...(workflow?.fallback && workflow.fallback !== 'auto' ? { fallbackWorkflow: workflow.fallback } : {}),
    ...(budget?.plan && parseBudget(budget.plan) !== undefined ? { planBudgetUsd: parseBudget(budget.plan) } : {}),
    ...(budget?.build && parseBudget(budget.build) !== undefined ? { buildBudgetUsd: parseBudget(budget.build) } : {}),
    ...(budget?.verify && parseBudget(budget.verify) !== undefined ? { verifyBudgetUsd: parseBudget(budget.verify) } : {}),
    ...(budget?.refine && parseBudget(budget.refine) !== undefined ? { refineBudgetUsd: parseBudget(budget.refine) } : {}),
    ...(budget?.fallback && parseBudget(budget.fallback) !== undefined ? { fallbackBudgetUsd: parseBudget(budget.fallback) } : {}),
    ...(verification?.plan && verification.plan !== 'auto' ? { planVerification: verification.plan } : {}),
    ...(verification?.build && verification.build !== 'auto' ? { buildVerification: verification.build } : {}),
    ...(verification?.verify && verification.verify !== 'auto' ? { verifyVerification: verification.verify } : {}),
    ...(verification?.refine && verification.refine !== 'auto' ? { refineVerification: verification.refine } : {}),
    ...(verification?.fallback && verification.fallback !== 'auto' ? { fallbackVerification: verification.fallback } : {}),
    categories,
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
  { id: 'parable', label: 'Parable', icon: <BookOpen size={14} /> },
  { id: 'agents', label: 'Agents', icon: <Bot size={14} /> },
  { id: 'releases', label: 'Releases', icon: <History size={14} /> },
];

export default function SettingsDialog() {
  const { isSettingsOpen, closeSettings, settingsTab } = useUIStore();
  const { settings: audioSettings, loadSettings, updateSettings } = useAudioStore();
  const loadAvailableModels = useSessionStore((s) => s.loadAvailableModels);

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabId>((settingsTab as TabId) || 'general');

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
  const [zaiApiKey, setZaiApiKey] = useState('');
  const [showZaiApiKey, setShowZaiApiKey] = useState(false);
  const [cerebrasApiKey, setCerebrasApiKey] = useState('');
  const [showCerebrasApiKey, setShowCerebrasApiKey] = useState(false);
  const [xaiApiKey, setXaiApiKey] = useState('');
  const [showXaiApiKey, setShowXaiApiKey] = useState(false);

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
  const [dailyReviewEnabled, setDailyReviewEnabled] = useState(false);
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
  const [autoBuildEffort, setAutoBuildEffort] = useState<AutoBuildEffortSettings>(AUTO_BUILD_EFFORT_DEFAULTS);
  const [autoBuildSpeed, setAutoBuildSpeed] = useState<AutoBuildSpeedSettings>(AUTO_BUILD_SPEED_DEFAULTS);
  const [autoBuildWorkflow, setAutoBuildWorkflow] = useState<AutoBuildWorkflowSettings>(AUTO_BUILD_WORKFLOW_DEFAULTS);
  const [autoBuildBudget, setAutoBuildBudget] = useState<AutoBuildBudgetSettings>(AUTO_BUILD_BUDGET_DEFAULTS);
  const [autoBuildVerification, setAutoBuildVerification] = useState<AutoBuildVerificationSettings>(AUTO_BUILD_VERIFICATION_DEFAULTS);
  const [autoBuildCostAware, setAutoBuildCostAware] = useState(true);
  const [autoBuildPrePlanEnabled, setAutoBuildPrePlanEnabled] = useState(true);
  const [autoBuildPrePlanModel, setAutoBuildPrePlanModel] = useState('claude-fable-5');
  const [customCategories, setCustomCategories] = useState<CustomCategoryState[]>([]);

  // Parable mode — Claude Code is the meta-harness and owns executor routing.
  const [parableConfig, setParableConfig] = useState<ParableConfig>(() => cloneDefaultParableConfig());

  // QMD status
  const [qmdStatus, setQmdStatus] = useState<{ installed: boolean; bundled: boolean } | null>(null);
  const [isInstallingQmd, setIsInstallingQmd] = useState(false);
  const [qmdInstallMessage, setQmdInstallMessage] = useState('');

  const [isLoading, setIsLoading] = useState(true);
  const [providers, setProviders] = useState<ProvidersState>(DEFAULT_PROVIDERS);
  const [isCheckingProviders, setIsCheckingProviders] = useState(false);

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
  const autoSaveAppSettings = useCallback(async (updates: { qmdEnabled?: boolean; ultraPlanMode?: boolean; showClearContextOnPlanAccept?: boolean; lunchReminderEnabled?: boolean; lunchReminderTime?: string; bedtimeReminderEnabled?: boolean; bedtimeReminderTime?: string; dailyReviewEnabled?: boolean; dailyReviewTime?: string; bedtimeTaskReviewEnabled?: boolean; foundryEnabled?: boolean; foundryBaseUrl?: string; foundryApiKey?: string; foundryDefaultSonnetModel?: string; foundryDefaultHaikuModel?: string; foundryDefaultOpusModel?: string; customModels?: typeof customModels; cursorApiKey?: string; deepseekApiKey?: string; geminiApiKey?: string; zaiApiKey?: string; xaiApiKey?: string; cerebrasApiKey?: string; autoRouterConfig?: any; parableConfig?: ParableConfig }) => {
    showSaveIndicator();
    try {
      await window.electronAPI.settings.set(updates);
      console.log('[SettingsDialog] Auto-saved app settings:', updates);

      // Reload available models if model-affecting settings changed
      const isModelUpdate = 'foundryEnabled' in updates || 'foundryDefaultSonnetModel' in updates || 'foundryDefaultHaikuModel' in updates || 'foundryDefaultOpusModel' in updates || 'customModels' in updates || 'cursorApiKey' in updates || 'deepseekApiKey' in updates || 'geminiApiKey' in updates || 'zaiApiKey' in updates || 'xaiApiKey' in updates;
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

  const refreshProviders = useCallback(async () => {
    setIsCheckingProviders(true);
    try {
      const result = await window.electronAPI.auth?.checkProviders?.();
      if (result) {
        setProviders({ ...DEFAULT_PROVIDERS, ...result });
      }
    } catch (error) {
      console.warn('[SettingsDialog] Provider status check failed:', error);
    } finally {
      setIsCheckingProviders(false);
    }
  }, []);

  useEffect(() => {
    if (isSettingsOpen) {
      setActiveTab((settingsTab as TabId) || 'general');
    }
  }, [isSettingsOpen, settingsTab]);

  // Load all settings on open — fast store reads first, slow QMD check independently
  useEffect(() => {
    if (isSettingsOpen) {
      setIsLoading(true);
      void refreshProviders();

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
          setDailyReviewEnabled((appSettings as any).dailyReviewEnabled ?? false);
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
          setZaiApiKey((appSettings as any).zaiApiKey || '');
          setCerebrasApiKey((appSettings as any).cerebrasApiKey || '');
          setXaiApiKey((appSettings as any).xaiApiKey || '');
          const savedParableConfig = (appSettings as any).parableConfig as Partial<ParableConfig> | undefined;
          if (savedParableConfig) {
            const parableDefaults = cloneDefaultParableConfig();
            setParableConfig({
              ...parableDefaults,
              ...savedParableConfig,
              executors: Array.isArray(savedParableConfig.executors)
                ? savedParableConfig.executors
                : parableDefaults.executors,
              checks: Array.isArray(savedParableConfig.checks)
                ? savedParableConfig.checks
                : parableDefaults.checks,
            });
          } else {
            setParableConfig(cloneDefaultParableConfig());
          }
          // Auto Build config
          const savedAutoConfig = (appSettings as any).autoRouterConfig;
          if (savedAutoConfig) {
            setAutoBuildModels(migrateAutoBuildModels(savedAutoConfig));
          }
          if (savedAutoConfig?.costAware !== undefined) {
            setAutoBuildCostAware(savedAutoConfig.costAware);
          }
          setAutoBuildPrePlanEnabled(savedAutoConfig?.prePlanEnabled !== false);
          setAutoBuildPrePlanModel(savedAutoConfig?.prePlanModel || 'claude-fable-5');
          // Load effort settings
          const savedEffort: AutoBuildEffortSettings = { ...AUTO_BUILD_EFFORT_DEFAULTS };
          if (savedAutoConfig?.planEffort) savedEffort.plan = savedAutoConfig.planEffort;
          if (savedAutoConfig?.buildEffort) savedEffort.build = savedAutoConfig.buildEffort;
          if (savedAutoConfig?.verifyEffort) savedEffort.verify = savedAutoConfig.verifyEffort;
          if (savedAutoConfig?.refineEffort) savedEffort.refine = savedAutoConfig.refineEffort;
          if (savedAutoConfig?.fallbackEffort) savedEffort.fallback = savedAutoConfig.fallbackEffort;
          setAutoBuildEffort(savedEffort);
          const savedSpeed: AutoBuildSpeedSettings = { ...AUTO_BUILD_SPEED_DEFAULTS };
          if (savedAutoConfig?.planSpeed) savedSpeed.plan = savedAutoConfig.planSpeed;
          if (savedAutoConfig?.buildSpeed) savedSpeed.build = savedAutoConfig.buildSpeed;
          if (savedAutoConfig?.verifySpeed) savedSpeed.verify = savedAutoConfig.verifySpeed;
          if (savedAutoConfig?.refineSpeed) savedSpeed.refine = savedAutoConfig.refineSpeed;
          if (savedAutoConfig?.fallbackSpeed) savedSpeed.fallback = savedAutoConfig.fallbackSpeed;
          setAutoBuildSpeed(savedSpeed);
          const savedWorkflow: AutoBuildWorkflowSettings = { ...AUTO_BUILD_WORKFLOW_DEFAULTS };
          if (savedAutoConfig?.planWorkflow) savedWorkflow.plan = savedAutoConfig.planWorkflow;
          if (savedAutoConfig?.buildWorkflow) savedWorkflow.build = savedAutoConfig.buildWorkflow;
          if (savedAutoConfig?.verifyWorkflow) savedWorkflow.verify = savedAutoConfig.verifyWorkflow;
          if (savedAutoConfig?.refineWorkflow) savedWorkflow.refine = savedAutoConfig.refineWorkflow;
          if (savedAutoConfig?.fallbackWorkflow) savedWorkflow.fallback = savedAutoConfig.fallbackWorkflow;
          setAutoBuildWorkflow(savedWorkflow);
          const savedBudget: AutoBuildBudgetSettings = { ...AUTO_BUILD_BUDGET_DEFAULTS };
          if (savedAutoConfig?.planBudgetUsd !== undefined) savedBudget.plan = String(savedAutoConfig.planBudgetUsd);
          if (savedAutoConfig?.buildBudgetUsd !== undefined) savedBudget.build = String(savedAutoConfig.buildBudgetUsd);
          if (savedAutoConfig?.verifyBudgetUsd !== undefined) savedBudget.verify = String(savedAutoConfig.verifyBudgetUsd);
          if (savedAutoConfig?.refineBudgetUsd !== undefined) savedBudget.refine = String(savedAutoConfig.refineBudgetUsd);
          if (savedAutoConfig?.fallbackBudgetUsd !== undefined) savedBudget.fallback = String(savedAutoConfig.fallbackBudgetUsd);
          setAutoBuildBudget(savedBudget);
          const savedVerification: AutoBuildVerificationSettings = { ...AUTO_BUILD_VERIFICATION_DEFAULTS };
          if (savedAutoConfig?.planVerification) savedVerification.plan = savedAutoConfig.planVerification;
          if (savedAutoConfig?.buildVerification) savedVerification.build = savedAutoConfig.buildVerification;
          if (savedAutoConfig?.verifyVerification) savedVerification.verify = savedAutoConfig.verifyVerification;
          if (savedAutoConfig?.refineVerification) savedVerification.refine = savedAutoConfig.refineVerification;
          if (savedAutoConfig?.fallbackVerification) savedVerification.fallback = savedAutoConfig.fallbackVerification;
          setAutoBuildVerification(savedVerification);
          // Load custom categories
          if (Array.isArray(savedAutoConfig?.categories)) {
            const customs = savedAutoConfig.categories
              .filter((c: any) => c && c.id && !FIXED_TIER_IDS.includes(c.id))
              .map((c: any) => ({
                id: c.id,
                label: c.label || c.id,
                description: c.description || '',
                model: c.model || 'claude-sonnet-4-6',
                effort: c.effort || '',
                speed: c.speed || 'auto',
                workflow: c.workflow || 'auto',
                budgetUsd: c.budgetUsd !== undefined ? String(c.budgetUsd) : '',
                verification: c.verification || 'auto',
                keywords: Array.isArray(c.keywords) ? c.keywords.join(', ') : (c.keywords || ''),
              }));
            setCustomCategories(customs);
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
  }, [isSettingsOpen, loadSettings, refreshProviders]);

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
      if (id.startsWith('grok:')) return 'Grok';
      if (id.startsWith('opencode:')) return 'DeepSeek';
      if (id.startsWith('custom:')) return 'Custom';
      if (id.startsWith('claude-')) return 'Claude';
      return '';
    };

    const allModelsById = new Map<string, { id: string; name: string; harness: string }>();
    availableModels
      .filter(m => m.id !== 'auto' && m.id !== PARABLE_MODE_ID && m.id !== CASCADE_MODE_ID)
      .forEach(m => {
        allModelsById.set(m.id, {
          id: m.id,
          name: m.name,
          harness: getHarnessLabel(m.id),
        });
      });
    // Ensure saved fixed-tier models appear in the dropdown even if not in availableModels
    Object.values(autoBuildModels)
      .filter(modelId => modelId && modelId !== 'auto' && modelId !== PARABLE_MODE_ID && modelId !== CASCADE_MODE_ID)
      .forEach(modelId => {
        if (!allModelsById.has(modelId)) {
          allModelsById.set(modelId, {
            id: modelId,
            name: modelId,
            harness: getHarnessLabel(modelId),
          });
        }
      });
    if (autoBuildPrePlanModel && !allModelsById.has(autoBuildPrePlanModel)) {
      allModelsById.set(autoBuildPrePlanModel, {
        id: autoBuildPrePlanModel,
        name: autoBuildPrePlanModel,
        harness: getHarnessLabel(autoBuildPrePlanModel),
      });
    }
    // Ensure saved custom-category models also appear in the dropdown
    customCategories.forEach(cat => {
      if (cat.model && !allModelsById.has(cat.model)) {
        allModelsById.set(cat.model, {
          id: cat.model,
          name: cat.model,
          harness: getHarnessLabel(cat.model),
        });
      }
    });
    const allModels = Array.from(allModelsById.values());

    const saveAutoBuildConfig = (
      models: AutoBuildModelSettings,
      costAware = autoBuildCostAware,
      effort = autoBuildEffort,
      speed = autoBuildSpeed,
      workflow = autoBuildWorkflow,
      budget = autoBuildBudget,
      verification = autoBuildVerification,
      customs = customCategories,
      prePlanEnabled = autoBuildPrePlanEnabled,
      prePlanModel = autoBuildPrePlanModel,
    ) => {
      autoSaveAppSettings({
        autoRouterConfig: autoBuildConfigFromState(
          models,
          costAware,
          effort,
          speed,
          workflow,
          budget,
          verification,
          customs,
          prePlanEnabled,
          prePlanModel,
        ),
      } as any);
    };

    const updateTierModel = (id: AutoBuildModelKey, model: string) => {
      const updated = { ...autoBuildModels, [id]: model };
      setAutoBuildModels(updated);
      saveAutoBuildConfig(updated);
    };

    const updatePrePlanEnabled = (enabled: boolean) => {
      setAutoBuildPrePlanEnabled(enabled);
      saveAutoBuildConfig(
        autoBuildModels,
        autoBuildCostAware,
        autoBuildEffort,
        autoBuildSpeed,
        autoBuildWorkflow,
        autoBuildBudget,
        autoBuildVerification,
        customCategories,
        enabled,
        autoBuildPrePlanModel,
      );
    };

    const updatePrePlanModel = (model: string) => {
      setAutoBuildPrePlanModel(model);
      saveAutoBuildConfig(
        autoBuildModels,
        autoBuildCostAware,
        autoBuildEffort,
        autoBuildSpeed,
        autoBuildWorkflow,
        autoBuildBudget,
        autoBuildVerification,
        customCategories,
        autoBuildPrePlanEnabled,
        model,
      );
    };

    const updateTierEffort = (id: AutoBuildModelKey, effort: string) => {
      const updated = { ...autoBuildEffort, [id]: effort };
      setAutoBuildEffort(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, updated);
    };

    const updateTierSpeed = (id: AutoBuildModelKey, speed: string) => {
      const updated = { ...autoBuildSpeed, [id]: speed };
      setAutoBuildSpeed(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, updated);
    };

    const updateTierWorkflow = (id: AutoBuildModelKey, workflow: string) => {
      const updated = { ...autoBuildWorkflow, [id]: workflow };
      setAutoBuildWorkflow(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, updated);
    };

    const updateTierBudget = (id: AutoBuildModelKey, budget: string) => {
      const updated = { ...autoBuildBudget, [id]: budget };
      setAutoBuildBudget(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, autoBuildWorkflow, updated);
    };

    const updateTierVerification = (id: AutoBuildModelKey, verification: string) => {
      const updated = { ...autoBuildVerification, [id]: verification };
      setAutoBuildVerification(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, autoBuildWorkflow, autoBuildBudget, updated);
    };

    const addCustomCategory = () => {
      const id = `custom-${Date.now()}`;
      const updated = [...customCategories, {
        id,
        label: 'New Category',
        description: '',
        model: 'claude-sonnet-4-6',
        effort: '',
        speed: 'auto',
        workflow: 'auto',
        budgetUsd: '',
        verification: 'auto',
        keywords: '',
      }];
      setCustomCategories(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, autoBuildWorkflow, autoBuildBudget, autoBuildVerification, updated);
    };

    const updateCustomCategory = (catId: string, field: string, value: string) => {
      const updated = customCategories.map(c => c.id === catId ? { ...c, [field]: value } : c);
      setCustomCategories(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, autoBuildWorkflow, autoBuildBudget, autoBuildVerification, updated);
    };

    const removeCustomCategory = (catId: string) => {
      const updated = customCategories.filter(c => c.id !== catId);
      setCustomCategories(updated);
      saveAutoBuildConfig(autoBuildModels, autoBuildCostAware, autoBuildEffort, autoBuildSpeed, autoBuildWorkflow, autoBuildBudget, autoBuildVerification, updated);
    };

    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-claude-text mb-1">Auto Build Routing</h3>
          <p className="text-[10px] text-claude-text-secondary mb-4">
            Pick the harness/model for each fixed task category. When Auto Build is selected, routing assigns the turn to one of these categories and delegates execution to the selected harness.
          </p>
        </div>

        {/* Cerebras API Key — enables intelligent routing */}
        <div className="space-y-2 border border-claude-border/30 p-3">
          <label className="block text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">
            Cerebras API Key
          </label>
          <ApiKeyInput
            value={cerebrasApiKey}
            onChange={setCerebrasApiKey}
            show={showCerebrasApiKey}
            onToggleShow={() => setShowCerebrasApiKey(!showCerebrasApiKey)}
            placeholder="csk-..."
            onSave={(value) => autoSaveAppSettings({ cerebrasApiKey: value })}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
          <p className="text-[10px] font-mono text-claude-text-secondary">
            Required for intelligent Auto Build routing. Without this key, Auto Build uses heuristic-only routing.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.electronAPI.app?.openExternal?.('https://cloud.cerebras.ai');
              }}
              className="text-claude-accent hover:underline"
            >
              cloud.cerebras.ai
            </a>
          </p>
        </div>

        {/* Fixed tier -> model mapping */}
        <div className="space-y-3 border border-fuchsia-500/20 bg-fuchsia-500/5 p-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider text-fuchsia-400">
                Pre-build 80/20 gate
              </label>
              <p className="mt-1 text-[9px] font-mono text-claude-text-secondary">
                Pause substantial work for one 80/20 scope choice, then approve a compact first-slice implementation handoff.
              </p>
            </div>
            <Toggle
              enabled={autoBuildPrePlanEnabled}
              onChange={updatePrePlanEnabled}
              disabled={isLoading}
              color="bg-fuchsia-500"
            />
          </div>

          <label className="block space-y-1">
            <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">
              Interview model
            </span>
            <select
              value={autoBuildPrePlanModel}
              onChange={(event) => updatePrePlanModel(event.target.value)}
              disabled={!autoBuildPrePlanEnabled}
              className="w-full bg-claude-bg border border-claude-border px-2 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-fuchsia-500 disabled:opacity-40 appearance-none cursor-pointer"
            >
              {allModels
                .filter((model) => model.id.startsWith('claude-') || model.id.startsWith('custom:'))
                .map((model) => (
                  <option key={`pre-plan-${model.id}`} value={model.id}>
                    {model.name}
                  </option>
                ))}
            </select>
          </label>
        </div>

        {/* Fixed tier -> model mapping */}
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">Fixed categories</label>
            <span className="text-[10px] text-claude-text-secondary">Model assignments for the base task tiers</span>
          </div>

          <div className="grid grid-cols-[116px_minmax(220px,1fr)_88px_78px] gap-2 px-2 text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">
            <span />
            <span>Model</span>
            <span>Effort</span>
            <span>Speed</span>
          </div>

          {AUTO_BUILD_MODEL_ROWS.map((row) => (
            <div key={row.id} className="border border-claude-border/20 bg-claude-bg/20 px-2 py-2">
              <div className="grid grid-cols-[116px_minmax(220px,1fr)_88px_78px] items-center gap-2">
                <div>
                  <div className="text-xs font-mono text-claude-text">{row.label}</div>
                  <div className="text-[9px] text-claude-text-secondary truncate">{row.detail}</div>
                </div>

                <select
                  value={autoBuildModels[row.id]}
                  onChange={(e) => updateTierModel(row.id, e.target.value)}
                  className="min-w-0 bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                >
                  {allModels.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.harness ? `${m.name.replace(/ \(Codex\)| \(Cursor\)/, '')} [${m.harness}]` : m.name}
                    </option>
                  ))}
                </select>

                <select
                  value={autoBuildEffort[row.id]}
                  onChange={(e) => updateTierEffort(row.id, e.target.value)}
                  className="bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                  title="Effort level for this category"
                >
                  {EFFORT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                <select
                  value={autoBuildSpeed[row.id]}
                  onChange={(e) => updateTierSpeed(row.id, e.target.value)}
                  className="bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                  title="Speed mode"
                >
                  {SPEED_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <details className="ml-[124px] mt-2 text-[10px] text-claude-text-secondary">
                <summary className="cursor-pointer select-none font-mono uppercase tracking-wider hover:text-claude-text">
                  Optional policy
                </summary>
                <div className="mt-2 grid grid-cols-[120px_120px_96px] gap-2">
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Workflow</span>
                    <select
                      value={autoBuildWorkflow[row.id]}
                      onChange={(e) => updateTierWorkflow(row.id, e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                      title="Workflow mode"
                    >
                      {WORKFLOW_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Verify</span>
                    <select
                      value={autoBuildVerification[row.id]}
                      onChange={(e) => updateTierVerification(row.id, e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                      title="Verification policy"
                    >
                      {VERIFICATION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Budget</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={autoBuildBudget[row.id]}
                      onChange={(e) => updateTierBudget(row.id, e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent"
                      placeholder="$"
                      title="Budget cap in USD"
                    />
                  </label>
                </div>
              </details>
            </div>
          ))}
        </div>

        {/* Custom categories */}
        <div className="border-t border-claude-border/30 pt-4 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">Custom categories</label>
            <button
              onClick={addCustomCategory}
              className="text-[10px] text-claude-accent hover:text-claude-accent/80 font-mono"
            >
              + Add category
            </button>
          </div>

          {customCategories.length === 0 && (
            <p className="text-[9px] text-claude-text-secondary italic">
              Add custom categories with keywords to route specific tasks to a preferred harness.
            </p>
          )}

          {customCategories.map((cat) => (
            <div key={cat.id} className="border border-claude-border/30 rounded px-3 py-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={cat.label}
                  onChange={(e) => updateCustomCategory(cat.id, 'label', e.target.value)}
                  className="flex-1 bg-transparent border-b border-claude-border/30 text-xs font-mono text-claude-text focus:outline-none focus:border-claude-accent px-0 py-0.5"
                  placeholder="Category name"
                />
                <button
                  onClick={() => removeCustomCategory(cat.id)}
                  className="text-red-400/60 hover:text-red-400 text-[10px] font-mono"
                  title="Remove category"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-[minmax(220px,1fr)_88px_78px] gap-2">
                <select
                  value={cat.model}
                  onChange={(e) => updateCustomCategory(cat.id, 'model', e.target.value)}
                  className="min-w-0 bg-claude-bg border border-claude-border px-2 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                >
                  {allModels.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.harness ? `${m.name.replace(/ \(Codex\)| \(Cursor\)/, '')} [${m.harness}]` : m.name}
                    </option>
                  ))}
                </select>
                <select
                  value={cat.effort}
                  onChange={(e) => updateCustomCategory(cat.id, 'effort', e.target.value)}
                  className="bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                  title="Effort level for this category"
                >
                  {EFFORT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <select
                  value={cat.speed}
                  onChange={(e) => updateCustomCategory(cat.id, 'speed', e.target.value)}
                  className="bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                  title="Speed mode"
                >
                  {SPEED_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <input
                value={cat.description}
                onChange={(e) => updateCustomCategory(cat.id, 'description', e.target.value)}
                className="w-full bg-transparent text-[9px] text-claude-text-secondary focus:outline-none focus:text-claude-text border-b border-transparent focus:border-claude-border/30 px-0 py-0.5"
                placeholder="Description (shown to routing)"
              />
              <input
                value={cat.keywords}
                onChange={(e) => updateCustomCategory(cat.id, 'keywords', e.target.value)}
                className="w-full bg-transparent text-[9px] text-claude-text-secondary font-mono focus:outline-none focus:text-claude-text border-b border-transparent focus:border-claude-border/30 px-0 py-0.5"
                placeholder="Keywords (comma-separated, e.g. security, auth, oauth)"
              />
              <details className="text-[10px] text-claude-text-secondary">
                <summary className="cursor-pointer select-none font-mono uppercase tracking-wider hover:text-claude-text">
                  Optional policy
                </summary>
                <div className="mt-2 grid grid-cols-[120px_120px_96px] gap-2">
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Workflow</span>
                    <select
                      value={cat.workflow}
                      onChange={(e) => updateCustomCategory(cat.id, 'workflow', e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                      title="Workflow mode"
                    >
                      {WORKFLOW_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Verify</span>
                    <select
                      value={cat.verification}
                      onChange={(e) => updateCustomCategory(cat.id, 'verification', e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent appearance-none cursor-pointer"
                      title="Verification policy"
                    >
                      {VERIFICATION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[9px] font-mono uppercase tracking-wider">Budget</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={cat.budgetUsd}
                      onChange={(e) => updateCustomCategory(cat.id, 'budgetUsd', e.target.value)}
                      className="w-full bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text focus:outline-none focus:border-claude-accent"
                      placeholder="$"
                      title="Budget cap in USD"
                    />
                  </label>
                </div>
              </details>
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

  const renderParableTab = () => {
    const concreteModels = availableModels.filter((model) => model.id !== 'auto' && model.id !== PARABLE_MODE_ID && model.id !== CASCADE_MODE_ID);
    const brainModels = concreteModels.filter((model) => !/^(?:codex|cursor|gemini|opencode|custom):/.test(model.id));
    const executorModels = concreteModels.filter((model) => (
      !model.id.includes(':') || model.id.startsWith('codex:') || model.id.startsWith('cursor:')
    ));
    const withSavedModel = (models: typeof availableModels, modelId: string) => (
      models.some((model) => model.id === modelId)
        ? models
        : [{ id: modelId, name: modelId, description: 'Saved model' }, ...models]
    );
    const saveParableConfig = (next: ParableConfig) => {
      setParableConfig(next);
      void autoSaveAppSettings({ parableConfig: next });
    };
    const updateExecutor = (executorIndex: number, updates: Partial<ParableExecutorConfig>) => {
      const next = {
        ...parableConfig,
        executors: parableConfig.executors.map((executor, index) => index === executorIndex ? { ...executor, ...updates } : executor),
      };
      saveParableConfig(next);
    };
    const renameExecutor = (executorIndex: number, nextId: string) => {
      const executorId = parableConfig.executors[executorIndex]?.id;
      if (executorId === undefined) return;
      saveParableConfig({
        ...parableConfig,
        defaultExecutor: parableConfig.defaultExecutor === executorId ? nextId : parableConfig.defaultExecutor,
        defaultReviewer: parableConfig.defaultReviewer === executorId ? nextId : parableConfig.defaultReviewer,
        executors: parableConfig.executors.map((executor, index) => index === executorIndex ? { ...executor, id: nextId } : executor),
      });
    };
    const addExecutor = () => {
      const existing = new Set(parableConfig.executors.map((executor) => executor.id));
      let index = parableConfig.executors.length + 1;
      let id = `executor-${index}`;
      while (existing.has(id)) id = `executor-${++index}`;
      const model = executorModels.find((candidate) => candidate.id === 'claude-sonnet-5')?.id
        || executorModels[0]?.id
        || 'claude-sonnet-5';
      saveParableConfig({
        ...parableConfig,
        executors: [...parableConfig.executors, {
          id,
          model,
          enabled: true,
          effort: 'high',
          taskClasses: ['feature'],
          useFor: '',
          avoidFor: '',
        }],
      });
    };
    const removeExecutor = (executorIndex: number) => {
      if (parableConfig.executors.length <= 1) return;
      const executorId = parableConfig.executors[executorIndex]?.id;
      if (executorId === undefined) return;
      const executors = parableConfig.executors.filter((_, index) => index !== executorIndex);
      const firstEnabled = executors.find((executor) => executor.enabled)?.id || executors[0].id;
      saveParableConfig({
        ...parableConfig,
        executors,
        defaultExecutor: parableConfig.defaultExecutor === executorId ? firstEnabled : parableConfig.defaultExecutor,
        defaultReviewer: parableConfig.defaultReviewer === executorId ? firstEnabled : parableConfig.defaultReviewer,
      });
    };
    const toggleTaskClass = (executorIndex: number, executor: ParableExecutorConfig, taskClass: ParableTaskClass) => {
      const taskClasses = executor.taskClasses.includes(taskClass)
        ? executor.taskClasses.filter((value) => value !== taskClass)
        : [...executor.taskClasses, taskClass];
      updateExecutor(executorIndex, { taskClasses });
    };
    const updateCheck = (checkIndex: number, updates: Partial<ParableCheckConfig>) => {
      saveParableConfig({
        ...parableConfig,
        checks: parableConfig.checks.map((check, index) => index === checkIndex ? { ...check, ...updates } : check),
      });
    };
    const addCheck = () => {
      const id = `check-${parableConfig.checks.length + 1}`;
      saveParableConfig({
        ...parableConfig,
        checks: [...parableConfig.checks, { id, run: '', cwd: '.', when: ['post-implement'], timeoutMinutes: 15 }],
      });
    };

    return (
      <div className="space-y-5">
        <div className="border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2">
            <BookOpen size={14} className="text-amber-400" />
            <h3 className="text-sm font-medium text-claude-text">Claude Code meta-harness</h3>
          </div>
          <p className="mt-1 text-[10px] text-claude-text-secondary">
            Parable is a separate model mode. Claude Code plans and routes work to this cast, then verifies and reviews it. Auto Build routing and helper stages are disabled for Parable turns.
          </p>
        </div>

        <div className="grid grid-cols-[minmax(220px,1fr)_120px] gap-3">
          <label className="space-y-1">
            <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">Brain model</span>
            <select
              value={parableConfig.brainModel}
              onChange={(event) => saveParableConfig({ ...parableConfig, brainModel: event.target.value })}
              className="w-full bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
            >
              {withSavedModel(brainModels, parableConfig.brainModel).map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">Max parallel</span>
            <select
              value={parableConfig.maxParallel}
              onChange={(event) => saveParableConfig({ ...parableConfig, maxParallel: Number(event.target.value) })}
              className="w-full bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
            >
              {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">Default executor</span>
            <select
              value={parableConfig.defaultExecutor}
              onChange={(event) => saveParableConfig({ ...parableConfig, defaultExecutor: event.target.value })}
              className="w-full bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
            >
              {parableConfig.executors.map((executor, index) => <option key={`executor-option-${index}`} value={executor.id}>{executor.id}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">Default reviewer</span>
            <select
              value={parableConfig.defaultReviewer}
              onChange={(event) => saveParableConfig({ ...parableConfig, defaultReviewer: event.target.value })}
              className="w-full bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
            >
              {parableConfig.executors.map((executor, index) => <option key={`reviewer-option-${index}`} value={executor.id}>{executor.id}</option>)}
            </select>
          </label>
        </div>

        <label className="block space-y-1">
          <span className="block text-[9px] font-mono uppercase tracking-wider text-claude-text-secondary">Repository notes copied into plans</span>
          <textarea
            value={parableConfig.repoNotes || ''}
            onChange={(event) => saveParableConfig({ ...parableConfig, repoNotes: event.target.value })}
            rows={3}
            className="w-full resize-y bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
            placeholder="Project conventions every executor must follow…"
          />
        </label>

        <section className="space-y-3 border-t border-claude-border/30 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-mono uppercase tracking-wider text-claude-text">Executor cast</h4>
              <p className="text-[9px] text-claude-text-secondary">Claude subagents, Codex, and Cursor executors are supported by the bundled Parable runtime.</p>
            </div>
            <button onClick={addExecutor} className="flex items-center gap-1 text-[10px] font-mono text-amber-400 hover:text-amber-300">
              <Plus size={12} /> Add executor
            </button>
          </div>

          {parableConfig.executors.map((executor, executorIndex) => (
            <div key={`executor-row-${executorIndex}`} className="border border-claude-border/40 bg-claude-bg/20 p-3 space-y-3">
              <div className="grid grid-cols-[120px_minmax(220px,1fr)_90px_28px] items-center gap-2">
                <input
                  value={executor.id}
                  onChange={(event) => renameExecutor(executorIndex, event.target.value)}
                  className="min-w-0 bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
                  aria-label="Executor id"
                />
                <select
                  value={executor.model}
                  onChange={(event) => updateExecutor(executorIndex, {
                    model: event.target.value,
                    costIn: undefined,
                    costOut: undefined,
                    cacheIn: undefined,
                  })}
                  className="min-w-0 bg-claude-bg border border-claude-border px-2 py-1.5 text-xs font-mono text-claude-text"
                >
                  {withSavedModel(executorModels, executor.model).map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </select>
                <select
                  value={executor.effort || 'high'}
                  onChange={(event) => updateExecutor(executorIndex, { effort: event.target.value })}
                  className="bg-claude-bg border border-claude-border px-1.5 py-1.5 text-[10px] font-mono text-claude-text"
                >
                  {EFFORT_OPTIONS.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <button
                  onClick={() => removeExecutor(executorIndex)}
                  disabled={parableConfig.executors.length <= 1}
                  className="text-red-400/70 hover:text-red-400 disabled:opacity-20"
                  title="Remove executor"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {PARABLE_TASK_CLASSES.map((taskClass) => {
                  const selected = executor.taskClasses.includes(taskClass.id);
                  return (
                    <button
                      key={taskClass.id}
                      onClick={() => toggleTaskClass(executorIndex, executor, taskClass.id)}
                      className={`px-2 py-1 text-[9px] font-mono border ${selected ? 'border-amber-400/60 bg-amber-400/10 text-amber-300' : 'border-claude-border/40 text-claude-text-secondary hover:text-claude-text'}`}
                    >
                      {taskClass.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => updateExecutor(executorIndex, { enabled: !executor.enabled })}
                  className={`ml-auto px-2 py-1 text-[9px] font-mono border ${executor.enabled ? 'border-green-500/50 text-green-400' : 'border-claude-border text-claude-text-secondary'}`}
                >
                  {executor.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  value={executor.useFor || ''}
                  onChange={(event) => updateExecutor(executorIndex, { useFor: event.target.value })}
                  className="bg-transparent border-b border-claude-border/40 px-1 py-1 text-[10px] text-claude-text"
                  placeholder="Use for…"
                />
                <input
                  value={executor.avoidFor || ''}
                  onChange={(event) => updateExecutor(executorIndex, { avoidFor: event.target.value })}
                  className="bg-transparent border-b border-claude-border/40 px-1 py-1 text-[10px] text-claude-text"
                  placeholder="Avoid for…"
                />
              </div>

              <details className="text-[10px] text-claude-text-secondary">
                <summary className="cursor-pointer font-mono uppercase tracking-wider">Cost and limits</summary>
                {(() => {
                  const catalogPricing = getKnownModelPricing(executor.model);
                  const hasCostOverride = executor.costIn !== undefined || executor.costOut !== undefined || executor.cacheIn !== undefined;
                  const costFields: Array<[keyof ParableExecutorConfig, string, number | undefined]> = [
                    ['costIn', 'Input $/M', executor.costIn ?? catalogPricing?.input],
                    ['costOut', 'Output $/M', executor.costOut ?? catalogPricing?.output],
                    ['cacheIn', 'Cache $/M', executor.cacheIn ?? catalogPricing?.cacheRead],
                  ];
                  return <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className={catalogPricing && !hasCostOverride ? 'text-green-400' : 'text-amber-400'}>
                        {catalogPricing
                          ? hasCostOverride ? 'Manual pricing override' : 'Automatic pricing from Build model catalog'
                          : 'Unknown model — enter pricing manually'}
                      </span>
                      {catalogPricing && (
                        <button
                          type="button"
                          onClick={() => updateExecutor(executorIndex, hasCostOverride
                            ? { costIn: undefined, costOut: undefined, cacheIn: undefined }
                            : { costIn: catalogPricing.input, costOut: catalogPricing.output, cacheIn: catalogPricing.cacheRead })}
                          className="font-mono text-[9px] text-amber-400 hover:text-amber-300"
                        >
                          {hasCostOverride ? 'Use catalog pricing' : 'Override'}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-5 gap-2">
                      {costFields.map(([field, label, effectiveValue]) => (
                        <label key={field} className="space-y-1">
                          <span className="block text-[8px] font-mono uppercase">{label}</span>
                          <input
                            type="number"
                            min="0"
                            value={effectiveValue ?? ''}
                            disabled={Boolean(catalogPricing) && !hasCostOverride}
                            onChange={(event) => updateExecutor(executorIndex, { [field]: event.target.value === '' ? undefined : Number(event.target.value) })}
                            className="w-full bg-claude-bg border border-claude-border px-1.5 py-1 text-[9px] font-mono text-claude-text disabled:opacity-60"
                          />
                        </label>
                      ))}
                      {([
                        ['contextKtok', 'Context K'],
                        ['maxMinutes', 'Max min'],
                      ] as Array<[keyof ParableExecutorConfig, string]>).map(([field, label]) => (
                    <label key={field} className="space-y-1">
                      <span className="block text-[8px] font-mono uppercase">{label}</span>
                      <input
                        type="number"
                        min="0"
                        value={(executor[field] as number | undefined) ?? ''}
                        onChange={(event) => updateExecutor(executorIndex, { [field]: event.target.value === '' ? undefined : Number(event.target.value) })}
                        className="w-full bg-claude-bg border border-claude-border px-1.5 py-1 text-[9px] font-mono text-claude-text"
                      />
                    </label>
                      ))}
                    </div>
                  </div>;
                })()}
              </details>
            </div>
          ))}
        </section>

        <section className="space-y-3 border-t border-claude-border/30 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-mono uppercase tracking-wider text-claude-text">Deterministic checks</h4>
              <p className="text-[9px] text-claude-text-secondary">Parable runs these before spending reviewer tokens.</p>
            </div>
            <button onClick={addCheck} className="flex items-center gap-1 text-[10px] font-mono text-amber-400 hover:text-amber-300">
              <Plus size={12} /> Add check
            </button>
          </div>
          {parableConfig.checks.length === 0 && (
            <p className="border border-dashed border-claude-border/40 p-3 text-[10px] text-claude-text-secondary">No checks configured. Verification will pass vacuously until you add commands.</p>
          )}
          {parableConfig.checks.map((check, checkIndex) => (
            <div key={`parable-check-${checkIndex}`} className="grid grid-cols-[100px_minmax(260px,1fr)_100px_130px_28px] items-center gap-2 border border-claude-border/40 p-2">
              <input
                value={check.id}
                onChange={(event) => updateCheck(checkIndex, { id: event.target.value })}
                className="bg-claude-bg border border-claude-border px-1.5 py-1 text-[10px] font-mono text-claude-text"
                placeholder="id"
              />
              <input
                value={check.run}
                onChange={(event) => updateCheck(checkIndex, { run: event.target.value })}
                className="bg-claude-bg border border-claude-border px-1.5 py-1 text-[10px] font-mono text-claude-text"
                placeholder="npm test"
              />
              <input
                value={check.cwd || '.'}
                onChange={(event) => updateCheck(checkIndex, { cwd: event.target.value })}
                className="bg-claude-bg border border-claude-border px-1.5 py-1 text-[10px] font-mono text-claude-text"
                placeholder="cwd"
              />
              <select
                value={check.when.includes('pre-commit') ? 'pre-commit' : 'post-implement'}
                onChange={(event) => updateCheck(checkIndex, { when: [event.target.value as 'post-implement' | 'pre-commit'] })}
                className="bg-claude-bg border border-claude-border px-1.5 py-1 text-[10px] font-mono text-claude-text"
              >
                <option value="post-implement">Post implement</option>
                <option value="pre-commit">Pre commit</option>
              </select>
              <button
                onClick={() => saveParableConfig({ ...parableConfig, checks: parableConfig.checks.filter((_, index) => index !== checkIndex) })}
                className="text-red-400/70 hover:text-red-400"
                title="Remove check"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </section>

        <div className="border-t border-claude-border/30 pt-4 text-[10px] text-claude-text-secondary">
          Select <span className="font-bold text-amber-400">Parable</span> from the model picker to test this mode independently from Auto Build. Build keeps its tested upstream copy isolated at <span className="font-mono">~/.claude/skills/parable-build</span>, leaving any personal Parable install untouched.
        </div>
      </div>
    );
  };

  const getProviderStatusText = (status: ProviderStatus) => {
    if (isCheckingProviders) return 'Checking...';
    if (status.loggedIn) return status.detail || 'Ready';
    if (status.installed === false) return 'CLI missing';
    if (status.installed) return status.detail || 'Setup required';
    return status.detail || 'Not ready';
  };

  const copySetupCommand = (command?: string) => {
    if (command) {
      navigator.clipboard?.writeText(command).catch(() => undefined);
    }
  };

  const renderHarnessCard = ({
    id,
    label,
    description,
    status,
    apiKeyLabel,
    apiKeyInput,
    docsUrl,
    keyHelp,
  }: {
    id: keyof ProvidersState;
    label: string;
    description: string;
    status: ProviderStatus;
    apiKeyLabel: string;
    apiKeyInput: React.ReactNode;
    docsUrl: string;
    keyHelp: React.ReactNode;
  }) => {
    const ready = status.loggedIn;
    const setupCommand = status.installCommand;
    const effectiveDocsUrl = status.docsUrl || docsUrl;

    return (
      <div key={id} className="border border-claude-border bg-claude-bg/30" style={{ borderRadius: 0 }}>
        <div className="p-3 border-b border-claude-border/70">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Terminal size={14} className="text-claude-text-secondary" />
                <h4 className="text-sm font-mono font-semibold text-claude-text">{label}</h4>
              </div>
              <p className="mt-1 text-[10px] font-mono text-claude-text-secondary">{description}</p>
            </div>
            <div className={`shrink-0 flex items-center gap-1.5 px-2 py-1 border text-[10px] font-mono ${
              ready
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                : 'border-amber-500/50 bg-amber-500/10 text-amber-400'
            }`}>
              {isCheckingProviders ? (
                <Loader2 size={11} className="animate-spin" />
              ) : ready ? (
                <Check size={11} />
              ) : (
                <AlertCircle size={11} />
              )}
              {getProviderStatusText(status)}
            </div>
          </div>
          {(status.version || status.path) && (
            <div className="mt-2 text-[10px] font-mono text-claude-text-secondary truncate">
              {[status.version, status.path].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>

        <div className="p-3 space-y-3">
          {!ready && setupCommand && (
            <div className="space-y-1.5">
              <label className="block text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">
                Install CLI
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 px-2 py-1.5 bg-claude-surface border border-claude-border text-[10px] font-mono text-claude-text-secondary truncate">
                  {setupCommand}
                </code>
                <button
                  type="button"
                  onClick={() => copySetupCommand(setupCommand)}
                  className="p-1.5 border border-claude-border text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface"
                  title="Copy setup command"
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => window.electronAPI.app?.openExternal?.(effectiveDocsUrl)}
                  className="p-1.5 border border-claude-border text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface"
                  title="Open setup docs"
                >
                  <ExternalLink size={12} />
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-[10px] font-mono text-claude-text-secondary uppercase tracking-wider">
              {apiKeyLabel}
            </label>
            {apiKeyInput}
            <p className="text-[10px] font-mono text-claude-text-secondary">{keyHelp}</p>
          </div>
        </div>
      </div>
    );
  };

  // Render Agents Tab
  const renderAgentsTab = () => {
    const hasReadyAgent = Object.values(providers).some((provider) => provider.loggedIn);
    const handleContinue = async () => {
      await window.electronAPI?.settings?.set?.({ onboardingSkipped: true });
      closeSettings();
    };

    const harnessCards = [
      renderHarnessCard({
        id: 'claude',
        label: 'Claude Code',
        description: 'Primary Anthropic coding harness with CLI auth or direct API key support.',
        status: providers.claude,
        apiKeyLabel: 'Anthropic API Key',
        docsUrl: 'https://docs.anthropic.com/claude-code',
        apiKeyInput: (
          <ApiKeyInput
            value={apiKey}
            onChange={setApiKey}
            show={showApiKey}
            onToggleShow={() => setShowApiKey(!showApiKey)}
            placeholder="sk-ant-..."
            onSave={async (value) => {
              await autoSaveApiKey(value, 'anthropic');
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://console.anthropic.com/settings/keys')}
              className="text-claude-accent hover:underline"
            >
              console.anthropic.com
            </button>
            {' '}or run <span className="text-claude-text">claude login</span>.
          </>
        ),
      }),
      renderHarnessCard({
        id: 'codex',
        label: 'Codex',
        description: 'OpenAI coding harness for GPT-5 class models.',
        status: providers.codex,
        apiKeyLabel: 'OpenAI API Key',
        docsUrl: 'https://github.com/openai/codex',
        apiKeyInput: (
          <ApiKeyInput
            value={openaiApiKey}
            onChange={setOpenaiApiKey}
            show={showOpenaiApiKey}
            onToggleShow={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
            placeholder="sk-..."
            onSave={async (value) => {
              await autoSaveApiKey(value, 'openai');
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://platform.openai.com/api-keys')}
              className="text-claude-accent hover:underline"
            >
              platform.openai.com
            </button>
            {' '}or sign in with ChatGPT through the Codex CLI.
          </>
        ),
      }),
      renderHarnessCard({
        id: 'cursor',
        label: 'Cursor Agent',
        description: 'Cursor coding agent integration for local sessions.',
        status: providers.cursor,
        apiKeyLabel: 'Cursor API Key',
        docsUrl: 'https://cursor.com/cli',
        apiKeyInput: (
          <ApiKeyInput
            value={cursorApiKey}
            onChange={setCursorApiKey}
            show={showCursorApiKey}
            onToggleShow={() => setShowCursorApiKey(!showCursorApiKey)}
            placeholder="cur-..."
            onSave={async (value) => {
              await autoSaveAppSettings({ cursorApiKey: value });
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://cursor.com/settings')}
              className="text-claude-accent hover:underline"
            >
              cursor.com/settings
            </button>
            .
          </>
        ),
      }),
      renderHarnessCard({
        id: 'gemini',
        label: 'Gemini CLI',
        description: 'Google Gemini coding harness for Gemini Pro and Flash models.',
        status: providers.gemini,
        apiKeyLabel: 'Gemini API Key',
        docsUrl: 'https://github.com/google-gemini/gemini-cli',
        apiKeyInput: (
          <ApiKeyInput
            value={geminiApiKey}
            onChange={setGeminiApiKey}
            show={showGeminiApiKey}
            onToggleShow={() => setShowGeminiApiKey(!showGeminiApiKey)}
            placeholder="Enter your Google Gemini API key"
            onSave={async (value) => {
              await autoSaveAppSettings({ geminiApiKey: value });
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a Gemini key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://aistudio.google.com/apikey')}
              className="text-claude-accent hover:underline"
            >
              AI Studio
            </button>
            .
          </>
        ),
      }),
      renderHarnessCard({
        id: 'grok',
        label: 'Grok Build',
        description: 'xAI Grok Build CLI harness using the grok-build model.',
        status: providers.grok,
        apiKeyLabel: 'xAI API Key',
        docsUrl: 'https://docs.x.ai/build/overview',
        apiKeyInput: (
          <ApiKeyInput
            value={xaiApiKey}
            onChange={setXaiApiKey}
            show={showXaiApiKey}
            onToggleShow={() => setShowXaiApiKey(!showXaiApiKey)}
            placeholder="xai-..."
            onSave={async (value) => {
              await autoSaveAppSettings({ xaiApiKey: value });
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://console.x.ai/')}
              className="text-claude-accent hover:underline"
            >
              console.x.ai
            </button>
            {' '}or use Grok CLI auth.
          </>
        ),
      }),
      renderHarnessCard({
        id: 'opencode',
        label: 'OpenCode',
        description: 'OpenCode harness for DeepSeek-backed coding models.',
        status: providers.opencode,
        apiKeyLabel: 'DeepSeek API Key',
        docsUrl: 'https://opencode.ai/docs',
        apiKeyInput: (
          <ApiKeyInput
            value={deepseekApiKey}
            onChange={setDeepseekApiKey}
            show={showDeepseekApiKey}
            onToggleShow={() => setShowDeepseekApiKey(!showDeepseekApiKey)}
            placeholder="sk-..."
            onSave={async (value) => {
              await autoSaveAppSettings({ deepseekApiKey: value });
              await refreshProviders();
            }}
            isLoading={isLoading}
            handleDebouncedChange={handleDebouncedChange}
          />
        ),
        keyHelp: (
          <>
            Add a key from{' '}
            <button
              type="button"
              onClick={() => window.electronAPI.app?.openExternal?.('https://platform.deepseek.com')}
              className="text-claude-accent hover:underline"
            >
              platform.deepseek.com
            </button>
            .
          </>
        ),
      }),
    ];

    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-mono font-semibold text-claude-text">Agent Harnesses</h3>
            <p className="mt-1 text-[10px] font-mono text-claude-text-secondary">
              Configure local agent CLIs and their API keys in one place.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshProviders}
            disabled={isCheckingProviders}
            className="flex items-center gap-1.5 px-2 py-1 border border-claude-border text-[10px] font-mono text-claude-text-secondary hover:text-claude-text hover:bg-claude-bg disabled:opacity-60"
            style={{ borderRadius: 0 }}
          >
            <RefreshCw size={11} className={isCheckingProviders ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        <div className="space-y-3">
          {harnessCards}
        </div>

        {renderOtherApiKeysSection()}

        <button
          type="button"
          onClick={handleContinue}
          disabled={!hasReadyAgent && !apiKey.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-claude-accent text-white font-mono text-xs uppercase tracking-wider hover:bg-claude-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ borderRadius: 0 }}
        >
          <Check size={13} />
          Continue to Build
        </button>
      </div>
    );
  };

  // Render non-harness API keys inside the Agents tab
  const renderOtherApiKeysSection = () => (
    <div className="space-y-6">
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-claude-text-secondary" />
          <h3 className="text-xs font-mono text-claude-text uppercase tracking-wider">
            Other API Keys
          </h3>
        </div>
        <p className="text-[10px] font-mono text-claude-text-secondary">
          Keys below support non-agent features such as voice, browser automation, hosted Claude endpoints, and custom API models.
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
          For voice transcription using Whisper. This is the same OpenAI key used by the Codex agent.{' '}
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

      {/* Z.AI API Key */}
      <div className="space-y-2 pt-4 border-t border-claude-border">
        <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
          Z.AI API Key
        </label>
        <ApiKeyInput
          value={zaiApiKey}
          onChange={setZaiApiKey}
          show={showZaiApiKey}
          onToggleShow={() => setShowZaiApiKey(!showZaiApiKey)}
          placeholder="zai-..."
          onSave={(value) => autoSaveAppSettings({ zaiApiKey: value })}
          isLoading={isLoading}
          handleDebouncedChange={handleDebouncedChange}
        />
        <p className="text-[10px] font-mono text-claude-text-secondary">
          Enables GLM 5.2 in both Claude Code proxy mode and Codex CLI mode. Build uses Z.AI&apos;s Anthropic-compatible endpoint for Claude Code and OpenAI-compatible endpoint for Codex.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.app?.openExternal?.('https://z.ai/api-keys');
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
          Agent credentials and API keys are stored locally and encrypted.
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
      case 'parable':
        return renderParableTab();
      case 'agents':
        return renderAgentsTab();
      case 'releases':
        return renderReleasesTab();
      default:
        return null;
    }
  };

  if (!isSettingsOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={closeSettings}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-[1080px] max-w-[calc(100vw-48px)] h-[760px] max-h-[calc(100vh-48px)] bg-claude-surface border border-claude-border flex"
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
