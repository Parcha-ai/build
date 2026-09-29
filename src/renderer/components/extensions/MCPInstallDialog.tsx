import React, { useState, useEffect, useRef } from 'react';
import { X, Server, Loader2, Check, AlertCircle, Eye, EyeOff, Key, Package, Globe, ExternalLink } from 'lucide-react';
import type { MarketplaceMCPServer } from '../../../shared/types';

interface MCPInstallDialogProps {
  server: MarketplaceMCPServer;
  onClose: () => void;
  onSuccess: () => void;
}

export default function MCPInstallDialog({ server, onClose, onSuccess }: MCPInstallDialogProps) {
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Initialize auth values with empty strings
  useEffect(() => {
    if (server.authFields && server.authFields.length > 0) {
      const initial: Record<string, string> = {};
      server.authFields.forEach((field) => {
        initial[field.key] = '';
      });
      setAuthValues(initial);
    }
  }, [server]);

  // Focus first input on mount
  useEffect(() => {
    if (firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, []);

  const handleInputChange = (key: string, value: string) => {
    setAuthValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleInstall = async () => {
    // Validate required auth fields
    if (server.authFields && server.authFields.length > 0) {
      for (const field of server.authFields) {
        if (!authValues[field.key]?.trim()) {
          setResult({ success: false, message: `${field.label} is required` });
          return;
        }
      }
    }

    setInstalling(true);
    setResult(null);

    try {
      const response = await window.electronAPI.mcp.install(server.id, authValues);

      if (response.authUrl) {
        // OAuth flow detected - open URL in browser
        setResult({
          success: false,
          message: 'Opening authentication page in browser...',
        });
        window.electronAPI.app.openExternal(response.authUrl);

        // Keep dialog open for user to complete OAuth
        setTimeout(() => {
          setResult({
            success: true,
            message: 'Complete authentication in your browser, then restart the app to use this server.',
          });
        }, 1000);
      } else if (response.success) {
        setResult({ success: true, message: `${server.name} installed successfully!` });
        // Auto-close after success
        setTimeout(() => {
          onSuccess();
        }, 1500);
      } else {
        setResult({ success: false, message: response.error || 'Installation failed' });
      }
    } catch (error) {
      setResult({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setInstalling(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !installing) {
      onClose();
    } else if (e.key === 'Enter' && !installing) {
      handleInstall();
    }
  };

  const hasAuthFields = server.authFields && server.authFields.length > 0;
  const hasNpm = server.packages?.some((p) => p.registry_name === 'npm');
  const hasRemote = server.remotes && server.remotes.length > 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-[500px] max-w-[95%] max-h-[90%] flex flex-col"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div className="w-8 h-8 flex items-center justify-center bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] flex-shrink-0">
              {server.icon ? (
                <img src={server.icon} alt="" className="w-5 h-5 object-contain" />
              ) : (
                <Server size={16} className="text-fg-3" />
              )}
            </div>
            <div>
              <span className="text-[16px] font-semibold tracking-tight text-fg">Install {server.name}</span>
              <p className="text-[11.5px] text-fg-4 font-mono">{server.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-fg-3 hover:text-fg transition-colors"
            disabled={installing}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 flex-1 overflow-y-auto">
          {/* Server Info */}
          <div className="p-3 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] space-y-2">
            <p className="text-[13px] text-fg-3">{server.description}</p>

            {/* Installation Method */}
            <div className="flex items-center gap-3 text-[11.5px] text-fg-4">
              {hasNpm && (
                <span className="flex items-center gap-1">
                  <Package size={10} />
                  {server.packages?.find((p) => p.registry_name === 'npm')?.name}
                </span>
              )}
              {hasRemote && (
                <span className="flex items-center gap-1">
                  <Globe size={10} />
                  Remote Server
                </span>
              )}
            </div>

            {/* Links */}
            {(server.repositoryUrl || server.websiteUrl) && (
              <div className="flex items-center gap-3 pt-2 border-t border-line">
                {server.repositoryUrl && (
                  <button
                    onClick={() => window.electronAPI.app.openExternal(server.repositoryUrl!)}
                    className="flex items-center gap-1 text-[12px] text-fg-3 hover:text-accent-text transition-colors"
                  >
                    <ExternalLink size={10} />
                    Repository
                  </button>
                )}
                {server.websiteUrl && (
                  <button
                    onClick={() => window.electronAPI.app.openExternal(server.websiteUrl!)}
                    className="flex items-center gap-1 text-[12px] text-fg-3 hover:text-accent-text transition-colors"
                  >
                    <Globe size={10} />
                    Website
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Auth Fields */}
          {hasAuthFields ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Key size={14} className="text-amber" />
                <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4">
                  Configuration Required
                </span>
              </div>

              {server.authFields!.map((field, index) => (
                <div key={field.key}>
                  <label className="block text-[12px] text-fg-3 mb-1.5">
                    {field.label}
                    {field.secret && (
                      <span className="ml-1 text-[11px] text-amber">(secret)</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      ref={index === 0 ? firstInputRef : undefined}
                      type={field.secret && !showSecrets[field.key] ? 'password' : 'text'}
                      value={authValues[field.key] || ''}
                      onChange={(e) => handleInputChange(field.key, e.target.value)}
                      placeholder={field.secret ? '********' : `Enter ${field.label.toLowerCase()}`}
                      className="w-full px-3 py-2 pr-10 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] font-mono text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      disabled={installing}
                    />
                    {field.secret && (
                      <button
                        type="button"
                        onClick={() => toggleSecretVisibility(field.key)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-4 hover:text-fg transition-colors"
                        tabIndex={-1}
                      >
                        {showSecrets[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <p className="text-[12px] text-fg-4">
                These credentials will be stored in your Claude Code configuration.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]">
              <Check size={14} className="text-diff-add flex-shrink-0" />
              <p className="text-[13px] text-diff-add-text">No configuration required for this server</p>
            </div>
          )}

          {/* Result Message */}
          {result && (
            <div
              className={`flex items-start gap-2 p-3 ${
                result.success
                  ? 'bg-diff-add/10 shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)]'
                  : 'bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)]'
              }`}
            >
              {result.success ? (
                <Check size={14} className="text-diff-add flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={14} className="text-diff-del flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-[13px] ${result.success ? 'text-diff-add-text' : 'text-diff-del-text'}`}>
                {result.message}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line flex-shrink-0">
          <button
            onClick={onClose}
            className="h-8 px-3 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            disabled={installing}
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={installing}
            className="h-8 px-3 text-[13px] font-semibold bg-fg text-ink-0 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {installing ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Installing...
              </>
            ) : (
              <>
                <Server size={12} />
                Install
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
