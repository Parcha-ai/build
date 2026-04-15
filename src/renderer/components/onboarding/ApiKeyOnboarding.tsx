import React, { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, ExternalLink, Check, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
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
  loggedIn: boolean;
  method?: 'cli' | 'apiKey' | 'chatgpt';
  detail?: string;
};

type ProvidersState = {
  claude: ProviderStatus;
  codex: ProviderStatus;
};

const SCAN_PHASES = [
  { label: 'Detecting Claude Code', duration: 600 },
  { label: 'Detecting Codex', duration: 500 },
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

  if (!isOnboardingOpen) return null;

  const anyLoggedIn = providers.claude.loggedIn || providers.codex.loggedIn;
  const showApiKeyOption = scanComplete && (showApiKeyInput || !anyLoggedIn);

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
          />
          <ProviderRow
            icon={<CodexIcon />}
            label="Codex"
            status={providers.codex}
            phaseActive={scanPhase === 1 && !scanComplete}
            phaseDone={scanPhase > 1 || scanComplete}
            phaseLabel={SCAN_PHASES[1].label}
          />
          <SessionScanRow
            icon={<SessionsIcon />}
            phaseActive={scanPhase === 2 && !scanComplete}
            phaseDone={scanComplete}
          />
        </div>

        {/* API key (collapsible / conditional) */}
        {scanComplete && (
          <div className="px-6 pb-2">
            {anyLoggedIn && !showApiKeyInput && (
              <button
                onClick={() => setShowApiKeyInput(true)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-claude-text-secondary hover:text-claude-text border border-claude-border hover:bg-claude-bg/50 transition-colors"
                style={{ borderRadius: 0 }}
              >
                <span className="flex items-center gap-2">
                  <Key size={12} />
                  Add an Anthropic API key (optional)
                </span>
                <ChevronDown size={12} />
              </button>
            )}

            {showApiKeyOption && (
              <div className="space-y-2 pt-2">
                {anyLoggedIn && (
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
                      Anthropic API Key (optional)
                    </label>
                    <button
                      onClick={() => setShowApiKeyInput(false)}
                      className="text-xs font-mono text-claude-text-secondary hover:text-claude-text flex items-center gap-1"
                    >
                      <ChevronUp size={12} /> hide
                    </button>
                  </div>
                )}
                {!anyLoggedIn && (
                  <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
                    Anthropic API Key
                  </label>
                )}
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="sk-ant-..."
                    autoFocus
                    className={`w-full px-3 py-3 pr-10 bg-claude-bg border text-claude-text font-mono text-sm placeholder:text-claude-text-secondary focus:outline-none ${
                      error ? 'border-red-500' : 'border-claude-border focus:border-claude-accent'
                    }`}
                    style={{ borderRadius: 0 }}
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-claude-text-secondary hover:text-claude-text"
                    type="button"
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-xs font-mono">
                    <AlertCircle size={12} />
                    {error}
                  </div>
                )}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electronAPI.app?.openExternal?.('https://console.anthropic.com/settings/keys');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-mono text-claude-accent hover:underline"
                >
                  <ExternalLink size={10} />
                  Get an API key
                </a>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        {scanComplete && (
          <div className="p-6 pt-4 space-y-3">
            {anyLoggedIn && !apiKey.trim() ? (
              <button
                onClick={handleContinue}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-claude-accent text-white font-mono text-sm uppercase tracking-wider hover:bg-claude-accent/80 transition-colors"
                style={{ borderRadius: 0 }}
              >
                <Check size={14} />
                Continue to Build
              </button>
            ) : (
              <button
                onClick={apiKey.trim() ? handleSave : handleContinue}
                disabled={isSaving || (!anyLoggedIn && !apiKey.trim())}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-claude-accent text-white font-mono text-sm uppercase tracking-wider hover:bg-claude-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderRadius: 0 }}
              >
                {isSaving ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    {apiKey.trim() ? 'Save Key & Continue' : 'Continue to Build'}
                  </>
                )}
              </button>
            )}

            <button
              onClick={handleAdvancedSettings}
              className="w-full px-4 py-2 text-claude-text-secondary font-mono text-xs hover:text-claude-text transition-colors"
            >
              Advanced Settings →
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 bg-claude-bg/50 border-t border-claude-border">
          <p className="text-[10px] font-mono text-claude-text-secondary text-center">
            {anyLoggedIn
              ? 'Your existing CLI credentials are used securely. No API key required.'
              : 'Your API key is stored locally and encrypted.'}
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
}: {
  icon: React.ReactNode;
  label: string;
  status: ProviderStatus;
  phaseActive: boolean;
  phaseDone: boolean;
  phaseLabel: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 bg-claude-bg/40 border border-claude-border" style={{ borderRadius: 0 }}>
      <div className="flex items-center gap-2.5">
        <div className="w-[18px] h-[18px] flex items-center justify-center">{icon}</div>
        <span className="text-sm font-mono text-claude-text">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-claude-text-secondary">
          {phaseActive
            ? phaseLabel + '...'
            : !phaseDone
              ? 'Pending'
              : status.loggedIn
                ? status.detail || 'Logged in'
                : 'Not logged in'}
        </span>
        <StatusBadge phaseActive={phaseActive} phaseDone={phaseDone} success={status.loggedIn} />
      </div>
    </div>
  );
}

function SessionScanRow({ icon, phaseActive, phaseDone }: { icon: React.ReactNode; phaseActive: boolean; phaseDone: boolean }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!phaseDone) return;
    window.electronAPI?.sessions?.list?.()
      .then((sessions: any[]) => setCount(Array.isArray(sessions) ? sessions.length : 0))
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
