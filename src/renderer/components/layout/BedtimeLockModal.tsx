import React, { useState, useEffect } from 'react';
import { Moon, Lock } from 'lucide-react';

interface BedtimeLockModalProps {
  onDismiss: () => void;
  onSnooze: () => void;
}

export default function BedtimeLockModal({ onDismiss, onSnooze }: BedtimeLockModalProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [snoozeUsed, setSnoozeUsed] = useState(() => {
    return localStorage.getItem('bedtime-snooze-used-today') === new Date().toDateString();
  });
  const [locked, setLocked] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // If snooze was already used, go straight to hard lock after 30s
  useEffect(() => {
    if (snoozeUsed) {
      setLocked(true);
      setCountdown(30);
    }
  }, [snoozeUsed]);

  // Countdown to auto-lock if snooze was used
  useEffect(() => {
    if (!locked || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [locked, countdown]);

  const handleSnooze = () => {
    if (reason.trim().length < 3) {
      setError('Explain why you need 5 more minutes');
      return;
    }
    localStorage.setItem('bedtime-snooze-used-today', new Date().toDateString());
    setSnoozeUsed(true);
    onSnooze();
  };

  const handleGoToBed = () => {
    onDismiss();
  };

  if (locked && countdown === 0) {
    // Hard lock — no escape
    return (
      <div className="fixed inset-0 bg-black z-[99999] flex items-center justify-center select-none" style={{ cursor: 'not-allowed' }}>
        <div className="text-center max-w-md">
          <Lock size={64} className="text-indigo-500 mx-auto mb-6" strokeWidth={2} />
          <h2 className="text-3xl font-bold text-indigo-400 mb-4 uppercase" style={{ letterSpacing: '0.15em' }}>
            Locked
          </h2>
          <p className="text-lg text-claude-text-secondary mb-2">
            Go to bed. Your code will be here tomorrow.
          </p>
          <p className="text-xs text-claude-text-secondary/50 mt-8">
            Build is locked until 6 AM. Close the app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/95 z-[99999] flex items-center justify-center">
      <div className="bg-claude-surface border-4 border-indigo-500 p-8 max-w-lg w-full mx-4">
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
            {locked && countdown > 0 && (
              <p className="text-xs text-red-400 mt-2 font-bold uppercase">
                Locking in {countdown}s...
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {!snoozeUsed && (
            <>
              <div>
                <label className="block text-xs font-bold text-claude-text mb-2 uppercase" style={{ letterSpacing: '0.05em' }}>
                  Why are you still working?
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); setError(''); }}
                  placeholder="e.g., Finishing a deploy"
                  className="w-full px-4 py-3 bg-claude-bg border-2 border-claude-border text-claude-text font-mono focus:border-indigo-500 focus:outline-none"
                  style={{ borderRadius: 0 }}
                  autoFocus
                />
                {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSnooze}
                  className="flex-1 px-6 py-3 bg-claude-surface border-2 border-indigo-500 text-indigo-400 font-bold uppercase hover:bg-indigo-500/10 transition-colors"
                  style={{ borderRadius: 0, letterSpacing: '0.1em' }}
                >
                  5 More Minutes
                </button>
                <button
                  onClick={handleGoToBed}
                  className="flex-1 px-6 py-3 bg-indigo-500 text-white font-bold uppercase hover:bg-indigo-400 transition-colors"
                  style={{ borderRadius: 0, letterSpacing: '0.1em' }}
                >
                  Go to Bed
                </button>
              </div>

              <p className="text-[10px] text-claude-text-secondary text-center" style={{ letterSpacing: '0.05em' }}>
                You get ONE snooze. After that, Build locks until morning.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
