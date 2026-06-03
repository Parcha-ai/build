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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-claude-surface border border-claude-border w-full max-w-md max-h-[90vh] flex flex-col" style={{ borderRadius: 0 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-cyan-400" />
            <span className="font-mono text-sm font-bold">TELEPORT TO SSH</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-claude-bg transition-colors"
            style={{ borderRadius: 0 }}
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
              <Loader2 size={32} className="animate-spin text-cyan-400 mb-4" />
              <span className="text-sm font-mono text-cyan-400">{progressMessage || 'Teleporting...'}</span>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} className="text-green-400 mb-4" />
              <span className="text-sm font-mono text-green-400">Teleportation complete!</span>
              <span className="text-xs text-claude-text-secondary mt-2">Switching to remote session...</span>
            </div>
          )}

          {status === 'error' && error && (
            <div className="py-8">
              <div className="text-red-400 text-sm bg-red-400/10 p-4 border border-red-400/30 mb-4" style={{ borderRadius: 0 }}>
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle size={16} />
                  <span className="font-bold">Teleportation Failed</span>
                </div>
                <span className="text-xs">{error}</span>
              </div>
              <button
                onClick={() => {
                  setStatus('idle');
                  setError(null);
                }}
                className="w-full py-2 text-sm bg-claude-bg hover:bg-claude-surface border border-claude-border"
                style={{ borderRadius: 0 }}
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
