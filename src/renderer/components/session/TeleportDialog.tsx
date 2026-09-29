import React, { useState, useEffect } from 'react';
import { X, Upload, Check, Loader2, AlertCircle } from 'lucide-react';
import type { Session, SSHConfig } from '../../../shared/types';
import SSHConfigForm from './SSHConfigForm';

interface TeleportDialogProps {
  session: Session;
  onClose: () => void;
  onTeleported: (newSessionId: string) => void;
}

export default function TeleportDialog({ session, onClose, onTeleported }: TeleportDialogProps) {
  const [status, setStatus] = useState<'idle' | 'teleporting' | 'success' | 'error'>('idle');
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Listen for progress updates
    const unsubscribe = window.electronAPI.ssh.onSetupProgress((data) => {
      if (data.sessionId === session.id) {
        if (data.message) {
          setProgressMessage(data.message);
        }
        if (data.status === 'error') {
          setStatus('error');
          setError(data.error || 'Unknown error');
        } else if (data.status === 'completed') {
          setStatus('success');
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [session.id]);

  const handleTeleport = async (config: SSHConfig) => {
    setStatus('teleporting');
    setError(null);
    setProgressMessage('Initializing teleportation...');

    try {
      const result = await window.electronAPI.ssh.teleportSession(session.id, config);

      if (result.success && result.newSessionId) {
        setStatus('success');
        // Give user a moment to see success message
        setTimeout(() => {
          onTeleported(result.newSessionId!);
        }, 1000);
      } else {
        setStatus('error');
        setError(result.error || 'Teleportation failed');
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] w-full max-w-md max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-fg-3" />
            <span className="text-[16px] font-semibold tracking-tight text-fg">TELEPORT TO SSH</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-fg-3 hover:text-fg hover:bg-claude-surface-hover transition-colors"
            disabled={status === 'teleporting'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {status === 'idle' && (
            <SSHConfigForm
              teleportSource={session}
              onBack={onClose}
              onConnect={async () => undefined} // Not used in teleport mode
              onTeleport={handleTeleport}
            />
          )}

          {status === 'teleporting' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-accent mb-4" />
              <span className="text-[13px] text-fg-2">{progressMessage || 'Teleporting...'}</span>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} className="text-diff-add mb-4" />
              <span className="text-[13px] text-diff-add-text">Teleportation complete!</span>
              <span className="text-[12px] text-fg-4 mt-2">Switching to remote session...</span>
            </div>
          )}

          {status === 'error' && error && (
            <div className="py-8">
              <div className="text-diff-del-text text-[13px] bg-diff-del/10 p-4 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.35)] mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  <span className="font-semibold">Teleportation Failed</span>
                </div>
                <span className="text-[12px]">{error}</span>
              </div>
              <button
                onClick={() => {
                  setStatus('idle');
                  setError(null);
                }}
                className="w-full h-8 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
