import React, { useState } from 'react';
import { Moon } from 'lucide-react';

interface BedtimeLockModalProps {
  onDismiss: () => void;
  onSnooze: () => void;
}

export default function BedtimeLockModal({ onDismiss, onSnooze }: BedtimeLockModalProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const handleDismiss = (e: React.FormEvent) => {
    e.preventDefault();

    if (reason.trim().length < 3) {
      setError('Please explain why you\'re still up (at least 3 characters)');
      return;
    }

    onDismiss();
  };

  const handleSnooze = () => {
    if (reason.trim().length < 3) {
      setError('Please explain why you need 5 more minutes');
      return;
    }
    onSnooze();
  };

  return (
    <div className="fixed inset-0 bg-black/90 z-[9999] flex items-center justify-center">
      <div className="bg-claude-surface border-4 border-indigo-500 p-8 max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-indigo-500/20 border-2 border-indigo-500 flex items-center justify-center flex-shrink-0">
            <Moon size={24} className="text-indigo-400" strokeWidth={3} />
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-indigo-400 mb-2 uppercase" style={{ letterSpacing: '0.1em' }}>
              Bedtime
            </h2>
            <p className="text-sm text-claude-text-secondary">
              It's past your bedtime. Sleep is non-negotiable — your code will still be here tomorrow.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleDismiss} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-claude-text mb-2 uppercase" style={{ letterSpacing: '0.05em' }}>
              Why are you still working?
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError('');
              }}
              placeholder="e.g., Finishing a deploy"
              className="w-full px-4 py-3 bg-claude-bg border-2 border-claude-border text-claude-text font-mono focus:border-indigo-500 focus:outline-none"
              style={{ borderRadius: 0 }}
              autoFocus
            />
            {error && (
              <p className="text-xs text-red-400 mt-2">{error}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSnooze}
              className="flex-1 px-6 py-3 bg-claude-surface border-2 border-indigo-500 text-indigo-400 font-bold uppercase hover:bg-indigo-500/10 transition-colors"
              style={{ borderRadius: 0, letterSpacing: '0.1em' }}
            >
              5 More Minutes
            </button>
            <button
              type="submit"
              className="flex-1 px-6 py-3 bg-indigo-500 text-white font-bold uppercase hover:bg-indigo-400 transition-colors"
              style={{ borderRadius: 0, letterSpacing: '0.1em' }}
            >
              I'm Done
            </button>
          </div>

          <p className="text-[10px] text-claude-text-secondary text-center" style={{ letterSpacing: '0.05em' }}>
            Note: You must explain yourself to continue. "5 More Minutes" gives you one snooze.
          </p>
        </form>
      </div>
    </div>
  );
}
