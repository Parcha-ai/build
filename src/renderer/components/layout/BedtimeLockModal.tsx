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
          <Lock size={56} className="text-fg-4 mx-auto mb-6" strokeWidth={1.5} />
          <h2 className="text-[28px] font-semibold tracking-tight text-fg mb-4">
            Locked
          </h2>
          <p className="text-[15px] text-fg-3 mb-2">
            Go to bed. Your code will be here tomorrow.
          </p>
          <p className="text-[12px] text-fg-5 mt-8">
            Build is locked until 5 AM. Close the app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/95 z-[99999] flex items-center justify-center">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)] p-8 max-w-lg w-full mx-4">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] flex items-center justify-center flex-shrink-0">
            <Moon size={24} className="text-accent-text" strokeWidth={2} />
          </div>
          <div className="flex-1">
            <h2 className="text-[18px] font-semibold tracking-tight text-fg mb-2">
              Bedtime
            </h2>
            <p className="text-[13px] text-fg-3">
              It's past your bedtime. Sleep is non-negotiable — your code will still be here tomorrow.
            </p>
            {locked && countdown > 0 && (
              <p className="text-[12px] text-diff-del mt-2 font-mono">
                Locking in {countdown}s...
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {!snoozeUsed && (
            <>
              <div>
                <label className="block text-[11px] font-medium text-fg-4 mb-2 uppercase tracking-[0.04em]">
                  Why are you still working?
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); setError(''); }}
                  placeholder="e.g., Finishing a deploy"
                  className="w-full px-3 py-2.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
                  autoFocus
                />
                {error && <p className="text-[12px] text-diff-del mt-2">{error}</p>}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSnooze}
                  className="flex-1 h-9 px-6 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover transition-colors"
                >
                  5 More Minutes
                </button>
                <button
                  onClick={handleGoToBed}
                  className="flex-1 h-9 px-6 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white transition-colors"
                >
                  Go to Bed
                </button>
              </div>

              <p className="text-[12px] text-fg-4 text-center">
                You get ONE snooze. After that, Build locks until morning.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
