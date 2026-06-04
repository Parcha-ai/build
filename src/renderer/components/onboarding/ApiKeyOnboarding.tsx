import React, { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, ExternalLink, Check, AlertCircle, Loader2, ChevronDown, ChevronUp, Terminal, Copy } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import buildLogo from '../../../../assets/build-logo.svg';

// Provider icons inline (no external assets needed)
const ClaudeIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
    <rect width="256" height="256" rx="48" fill="#D97757"/>
    <path d="M82 88l29 80h13l-29-80H82zm67 0l-29 80h13l29-80h-13z" fill="#fff"/>
    <path d="M62 88l29 80H78L49 88h13zm132 0l-29 80h13l29-80h-13z" fill="#fff"/>
  </svg>
);

const CodexIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
    <rect width="256" height="256" rx="48" fill="#000"/>
    <path d="M128 56l52 30v60l-52 30-52-30V86l52-30z" stroke="#fff" strokeWidth="10" fill="none"/>
    <circle cx="128" cy="116" r="14" fill="#fff"/>
  </svg>
);

const SessionsIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="4" rx="0.5"/>
    <rect x="3" y="10" width="18" height="4" rx="0.5"/>
    <rect x="3" y="16" width="18" height="4" rx="0.5"/>
  </svg>
);

type ProviderStatus = {
  installed?: boolean;
  loggedIn: boolean;
  method?: 'cli' | 'apiKey' | 'chatgpt';
  detail?: string;
  path?: string | null;
  version?: string | null;
  installCommand?: string;
  loginCommand?: string;
  docsUrl?: string;
};

type ProvidersState = {
  claude: ProviderStatus;
  codex: ProviderStatus;
  cursor: ProviderStatus;
  gemini: ProviderStatus;
  opencode: ProviderStatus;
};

const SCAN_PHASES = [
  { label: 'Detecting Claude Code', duration: 600 },
  { label: 'Detecting Codex', duration: 500 },
  { label: 'Detecting Cursor Agent', duration: 500 },
  { label: 'Detecting Gemini CLI', duration: 500 },
  { label: 'Detecting OpenCode', duration: 500 },
  { label: 'Scanning local sessions', duration: 700 },
];

export default function ApiKeyOnboarding() {
  const { isOnboardingOpen, closeOnboarding, openSettings, checkApiKey } = useUIStore();
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [scanPhase, setScanPhase] = useState(0);
  const [scanComplete, setScanComplete] = useState(false);
  const [providers, setProviders] = useState<ProvidersState>({
    claude: { loggedIn: false },
    codex: { loggedIn: false },
    cursor: { loggedIn: false },
    gemini: { loggedIn: false },
    opencode: { loggedIn: false },
  });

  // Run scanning animation + real provider detection in parallel
  useEffect(() => {
    if (!isOnboardingOpen) return;
    let cancelled = false;

    // Real provider check (resolves quickly)
    const detectionPromise = window.electronAPI.auth?.checkProviders?.()
      .then((res) => {
        if (!cancelled && res) setProviders(res);
      })
      .catch((e) => console.error('[Onboarding] Provider check failed', e));

    // Animated phase progression
    const totalDuration = SCAN_PHASES.reduce((sum, p) => sum + p.duration, 0);
    let elapsed = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    SCAN_PHASES.forEach((phase, i) => {
      elapsed += phase.duration;
      timers.push(
        setTimeout(() => {
          if (!cancelled) setScanPhase(i + 1);
        }, elapsed)
      );
    });
    timers.push(
      setTimeout(async () => {
        if (cancelled) return;
        await detectionPromise;
        if (!cancelled) setScanComplete(true);
      }, totalDuration)
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [isOnboardingOpen]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError('Please enter your API key');
      return;
    }
    if (!apiKey.startsWith('sk-ant-')) {
      setError('Invalid API key format. Anthropic keys start with sk-ant-');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await window.electronAPI.settings.setApiKey(apiKey.trim());
      await checkApiKey();
      closeOnboarding();
    } catch (err) {
      console.error('Failed to save API key:', err);
      setError('Failed to save API key. Please try again.');
    }
    setIsSaving(false);
  };

  const handleContinue = async () => {
    await window.electronAPI?.settings?.set?.({ onboardingSkipped: true });
    closeOnboarding();
  };

  const handleAdvancedSettings = () => {
    closeOnboarding();
    openSettings();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && apiKey.trim()) {
      handleSave();
    }
  };

  // Auto-poll providers while onboarding is open and something isn't ready
  useEffect(() => {
    if (!isOnboardingOpen || !scanComplete) return;
    const allReady = providers.claude.loggedIn && providers.codex.loggedIn &&
      providers.cursor.loggedIn && providers.gemini.loggedIn && providers.opencode.loggedIn;
    if (allReady) return;

    const interval = setInterval(() => {
      window.electronAPI.auth?.checkProviders?.()
        .then((res) => { if (res) setProviders(res); })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(interval);
  }, [isOnboardingOpen, scanComplete, providers.claude.loggedIn, providers.codex.loggedIn, providers.cursor.loggedIn, providers.gemini.loggedIn, providers.opencode.loggedIn]);

  const anyLoggedIn = providers.claude.loggedIn || providers.codex.loggedIn || providers.cursor.loggedIn || providers.gemini.loggedIn || providers.opencode.loggedIn;
  const showApiKeyOption = scanComplete && (showApiKeyInput || !anyLoggedIn);

  if (!isOnboardingOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div
        className="w-[520px] bg-claude-surface border border-claude-border"
        style={{ borderRadius: 0 }}
      >
        {/* Header */}
        <div className="p-6 pb-4 border-b border-claude-border">
          <div className="flex items-center gap-3 mb-1">
            <img src={buildLogo} alt="Build" className="w-10 h-10 border border-claude-border" />
            <div>
              <h2 className="text-lg font-mono font-bold text-claude-text">
                Welcome to Build
              </h2>
              <p className="text-xs font-mono text-claude-text-secondary">
                AI-powered development environment
              </p>
            </div>
          </div>
        </div>

        {/* Provider scan + status */}
        <div className="p-6 space-y-3">
          <ProviderRow
            icon={<ClaudeIcon />}
            label="Claude Code"
            status={providers.claude}
            phaseActive={scanPhase === 0 && !scanComplete}
            phaseDone={scanPhase > 0 || scanComplete}
            phaseLabel={SCAN_PHASES[0].label}
            apiKeyConfig={{
              placeholder: 'sk-ant-...',
              onSave: async (key) => {
                await window.electronAPI.settings.setApiKey(key);
                await checkApiKey();
                const res = await window.electronAPI.auth?.checkProviders?.();
                if (res) setProviders(res);
              },
            }}
          />
          <ProviderRow
            icon={<CodexIcon />}
            label="Codex"
            status={providers.codex}
            phaseActive={scanPhase === 1 && !scanComplete}
            phaseDone={scanPhase > 1 || scanComplete}
            phaseLabel={SCAN_PHASES[1].label}
            apiKeyConfig={{
              placeholder: 'sk-...',
              onSave: async (key) => {
                await window.electronAPI.audio.setOpenAiKey(key);
                const res = await window.electronAPI.auth?.checkProviders?.();
                if (res) setProviders(res);
              },
            }}
          />
          <ProviderRow
            icon={<Terminal size={18} />}
            label="Cursor Agent"
            status={providers.cursor}
            phaseActive={scanPhase === 2 && !scanComplete}
            phaseDone={scanPhase > 2 || scanComplete}
            phaseLabel={SCAN_PHASES[2].label}
            apiKeyConfig={{
              placeholder: 'cur-...',
              onSave: async (key) => {
                await window.electronAPI.settings.set({ cursorApiKey: key });
                const res = await window.electronAPI.auth?.checkProviders?.();
                if (res) setProviders(res);
              },
            }}
          />
          <ProviderRow
            icon={<Terminal size={18} />}
            label="Gemini CLI"
            status={providers.gemini}
            phaseActive={scanPhase === 3 && !scanComplete}
            phaseDone={scanPhase > 3 || scanComplete}
            phaseLabel={SCAN_PHASES[3].label}
            apiKeyConfig={{
              placeholder: 'Gemini API key',
              onSave: async (key) => {
                await window.electronAPI.settings.set({ geminiApiKey: key });
                const res = await window.electronAPI.auth?.checkProviders?.();
                if (res) setProviders(res);
              },
            }}
          />
          <ProviderRow
            icon={<Terminal size={18} />}
            label="OpenCode"
            status={providers.opencode}
            phaseActive={scanPhase === 4 && !scanComplete}
            phaseDone={scanPhase > 4 || scanComplete}
            phaseLabel={SCAN_PHASES[4].label}
            apiKeyConfig={{
              placeholder: 'sk-...',
              onSave: async (key) => {
                await window.electronAPI.settings.set({ deepseekApiKey: key });
                const res = await window.electronAPI.auth?.checkProviders?.();
                if (res) setProviders(res);
              },
            }}
          />
          <SessionScanRow
            icon={<SessionsIcon />}
            phaseActive={scanPhase === 5 && !scanComplete}
            phaseDone={scanComplete}
          />
        </div>

        {/* Action button */}
        {scanComplete && (
          <div className="p-6 pt-4">
            <button
              onClick={handleContinue}
              disabled={!anyLoggedIn}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-claude-accent text-white font-mono text-sm uppercase tracking-wider hover:bg-claude-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderRadius: 0 }}
            >
              <Check size={14} />
              Continue to Build
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 bg-claude-bg/50 border-t border-claude-border">
          <p className="text-[10px] font-mono text-claude-text-secondary text-center">
            {anyLoggedIn
              ? 'Build uses installed CLI credentials when available and tracks harness readiness locally.'
              : 'Sign in or add an API key to at least one agent to continue.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ phaseActive, phaseDone, success }: { phaseActive: boolean; phaseDone: boolean; success: boolean }) {
  if (phaseActive) return <Loader2 size={14} className="animate-spin text-claude-accent" />;
  if (!phaseDone) return <div className="w-3.5 h-3.5 border border-claude-border" />;
  if (success) return (
    <div className="w-3.5 h-3.5 flex items-center justify-center bg-emerald-500/20 border border-emerald-500/60">
      <Check size={10} className="text-emerald-400" strokeWidth={3} />
    </div>
  );
  return (
    <div className="w-3.5 h-3.5 flex items-center justify-center bg-amber-500/20 border border-amber-500/60">
      <AlertCircle size={10} className="text-amber-400" />
    </div>
  );
}

function ProviderRow({
  icon,
  label,
  status,
  phaseActive,
  phaseDone,
  phaseLabel,
  apiKeyConfig,
}: {
  icon: React.ReactNode;
  label: string;
  status: ProviderStatus;
  phaseActive: boolean;
  phaseDone: boolean;
  phaseLabel: string;
  apiKeyConfig?: {
    placeholder: string;
    onSave: (key: string) => Promise<void>;
  };
}) {
  const [showKey, setShowKey] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const needsSetup = phaseDone && !phaseActive && !status.loggedIn;
  const missingCli = needsSetup && status.installed === false;
  const needsAuth = needsSetup && status.installed === true;
  const statusText = phaseActive
    ? `${phaseLabel}...`
    : !phaseDone
      ? 'Pending'
      : status.loggedIn
        ? status.detail || 'Ready'
        : missingCli
          ? 'CLI missing'
          : needsAuth
            ? 'Sign-in required'
            : 'Not ready';

  const activeCommand = needsAuth ? status.loginCommand : status.installCommand;
  const handleCopyCommand = () => {
    if (activeCommand) {
      navigator.clipboard?.writeText(activeCommand).catch(() => undefined);
    }
  };
  const docsUrl = status.docsUrl;
  const canShowApiKey = apiKeyConfig && phaseDone && !phaseActive && !status.loggedIn;

  const handleSaveKey = async () => {
    if (!apiKeyConfig || !keyValue.trim()) return;
    setSaving(true);
    await apiKeyConfig.onSave(keyValue.trim());
    setSaving(false);
  };

  return (
    <div className="px-3 py-2.5 bg-claude-bg/40 border border-claude-border" style={{ borderRadius: 0 }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-[18px] h-[18px] flex items-center justify-center text-claude-text-secondary">{icon}</div>
          <div className="min-w-0">
            <span className="block text-sm font-mono text-claude-text truncate">{label}</span>
            {phaseDone && status.version && (
              <span className="block text-[10px] font-mono text-claude-text-secondary truncate">{status.version}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-claude-text-secondary truncate">
            {statusText}
          </span>
          <StatusBadge phaseActive={phaseActive} phaseDone={phaseDone} success={status.loggedIn} />
        </div>
      </div>

      {needsSetup && (activeCommand || status.docsUrl) && (
        <div className="mt-2 flex items-center gap-2">
          {activeCommand && (
            <code className="flex-1 min-w-0 px-2 py-1 bg-claude-surface border border-claude-border text-[10px] font-mono text-claude-text-secondary truncate">
              {activeCommand}
            </code>
          )}
          {activeCommand && (
            <button
              type="button"
              onClick={handleCopyCommand}
              className="p-1.5 border border-claude-border text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface"
              title={needsAuth ? 'Copy login command' : 'Copy install command'}
            >
              <Copy size={12} />
            </button>
          )}
          {status.docsUrl && (
            <button
              type="button"
              onClick={() => {
                if (docsUrl) window.electronAPI.app?.openExternal?.(docsUrl);
              }}
              className="p-1.5 border border-claude-border text-claude-text-secondary hover:text-claude-text hover:bg-claude-surface"
              title="Open setup docs"
            >
              <ExternalLink size={12} />
            </button>
          )}
        </div>
      )}

      {canShowApiKey && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 w-full flex items-center gap-1.5 text-[10px] font-mono text-claude-text-secondary hover:text-claude-text"
        >
          <Key size={10} />
          <span>Or add API key</span>
          <ChevronDown size={10} />
        </button>
      )}

      {canShowApiKey && expanded && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && keyValue.trim()) handleSaveKey(); }}
                placeholder={apiKeyConfig.placeholder}
                className="w-full px-2 py-1.5 pr-8 bg-claude-surface border border-claude-border text-xs font-mono text-claude-text placeholder:text-claude-text-secondary focus:outline-none focus:border-claude-accent"
                style={{ borderRadius: 0 }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-claude-text-secondary hover:text-claude-text"
              >
                {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
            <button
              type="button"
              onClick={handleSaveKey}
              disabled={!keyValue.trim() || saving}
              className="px-2 py-1.5 text-[10px] font-mono font-bold uppercase bg-claude-accent text-white hover:bg-claude-accent/80 disabled:opacity-40"
              style={{ borderRadius: 0 }}
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : 'Save'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-[10px] font-mono text-claude-text-secondary hover:text-claude-text"
          >
            <ChevronUp size={10} className="inline mr-0.5" />Hide
          </button>
        </div>
      )}
    </div>
  );
}

function SessionScanRow({ icon, phaseActive, phaseDone }: { icon: React.ReactNode; phaseActive: boolean; phaseDone: boolean }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!phaseDone) return;
    window.electronAPI?.sessions?.list?.()
      .then((sessions: unknown[]) => setCount(Array.isArray(sessions) ? sessions.length : 0))
      .catch(() => setCount(0));
  }, [phaseDone]);

  return (
    <div className="flex items-center justify-between px-3 py-2.5 bg-claude-bg/40 border border-claude-border" style={{ borderRadius: 0 }}>
      <div className="flex items-center gap-2.5">
        <div className="w-[18px] h-[18px] flex items-center justify-center text-claude-text-secondary">{icon}</div>
        <span className="text-sm font-mono text-claude-text">Local sessions</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-claude-text-secondary">
          {phaseActive
            ? 'Scanning ~/.claude/projects...'
            : !phaseDone
              ? 'Pending'
              : count === null
                ? 'Reading...'
                : count === 0
                  ? 'No previous sessions'
                  : `Found ${count} session${count === 1 ? '' : 's'}`}
        </span>
        <StatusBadge phaseActive={phaseActive} phaseDone={phaseDone} success={count !== null && count > 0} />
      </div>
    </div>
  );
}
