import React, { useState } from 'react';
import { Key, Eye, EyeOff, ExternalLink, Check, AlertCircle, Loader2 } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';

export default function ApiKeyOnboarding() {
  const { isOnboardingOpen, closeOnboarding, openSettings, checkApiKey } = useUIStore();
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError('Please enter your API key');
      return;
    }

    // Basic validation - Anthropic keys start with sk-ant-
    if (!apiKey.startsWith('sk-ant-')) {
      setError('Invalid API key format. Anthropic keys start with sk-ant-');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await window.electronAPI.settings.setApiKey(apiKey.trim());
      // Re-check API key to update hasApiKey state
      await checkApiKey();
      closeOnboarding();
    } catch (err) {
      console.error('Failed to save API key:', err);
      setError('Failed to save API key. Please try again.');
    }

    setIsSaving(false);
  };

  const handleSkip = async () => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div
        className="w-[480px] bg-claude-surface border border-claude-border"
        style={{ borderRadius: 0 }}
      >
        {/* Header with icon */}
        <div className="p-6 pb-4 border-b border-claude-border">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 flex items-center justify-center bg-claude-accent/20 border border-claude-accent/40">
              <Key size={20} className="text-claude-accent" />
            </div>
            <div>
              <h2 className="text-lg font-mono font-bold text-claude-text">
                Welcome to Build
              </h2>
              <p className="text-xs font-mono text-claude-text-secondary">
                AI-powered development environment
              </p>
            </div>
          </div>
          <p className="text-sm font-mono text-claude-text-secondary leading-relaxed">
            Enter an Anthropic API key, or skip if you've already logged in with <span className="text-claude-text">claude login</span>.
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* API Key Input */}
          <div className="space-y-2">
            <label className="block text-xs font-mono text-claude-text-secondary uppercase tracking-wider">
              Anthropic API Key
            </label>
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
          </div>

          {/* Get API Key Link */}
          <div className="flex items-center gap-2">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.electronAPI.app?.openExternal?.('https://console.anthropic.com/settings/keys');
              }}
              className="flex items-center gap-1.5 text-sm font-mono text-claude-accent hover:underline"
            >
              <ExternalLink size={12} />
              Get your API key from Anthropic Console
            </a>
          </div>

          {/* Buttons */}
          <div className="pt-4 space-y-3">
            <button
              onClick={handleSave}
              disabled={isSaving || !apiKey.trim()}
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
                  Continue
                </>
              )}
            </button>

            <button
              onClick={handleSkip}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-claude-border text-claude-text font-mono text-sm uppercase tracking-wider hover:bg-claude-bg transition-colors"
              style={{ borderRadius: 0 }}
            >
              Skip — I've already run claude login
            </button>

            <button
              onClick={handleAdvancedSettings}
              className="w-full px-4 py-2 text-claude-text-secondary font-mono text-xs hover:text-claude-text transition-colors"
            >
              Advanced Settings →
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-claude-bg/50 border-t border-claude-border">
          <p className="text-[10px] font-mono text-claude-text-secondary text-center">
            Your API key is stored locally and encrypted. It is never sent anywhere except directly to Anthropic's API.
          </p>
        </div>
      </div>
    </div>
  );
}
