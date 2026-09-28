import React, { useState } from 'react';
import { AlertCircle } from 'lucide-react';

interface LunchLockModalProps {
  onConfirm: (meal: string) => void;
}

export default function LunchLockModal({ onConfirm }: LunchLockModalProps) {
  const [lunchInput, setLunchInput] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Require at least 3 characters
    if (lunchInput.trim().length < 3) {
      setError('Please describe your lunch properly (at least 3 characters)');
      return;
    }

    // Accept the input
    onConfirm(lunchInput.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[9999] flex items-center justify-center">
      <div className="bg-ink-2 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.45),0_16px_40px_rgba(0,0,0,0.4)] p-8 max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-amber/10 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.45)] flex items-center justify-center flex-shrink-0">
            <AlertCircle size={24} className="text-amber" strokeWidth={2} />
          </div>
          <div className="flex-1">
            <h2 className="text-[18px] font-semibold tracking-tight text-fg mb-2">
              Lunch Break Required
            </h2>
            <p className="text-[13px] text-fg-3">
              It is now 12:00. Per operational protocols, you must confirm your lunch intake before continuing work.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-fg-4 mb-2 uppercase tracking-[0.04em]">
              What did you have for lunch?
            </label>
            <input
              type="text"
              value={lunchInput}
              onChange={(e) => {
                setLunchInput(e.target.value);
                setError('');
              }}
              placeholder="e.g., Sandwich and coffee"
              className="w-full px-3 py-2.5 bg-ink-3 border-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] text-[13px] text-fg placeholder:text-fg-5 focus:outline-none focus:ring-1 focus:ring-accent/50"
              autoFocus
            />
            {error && (
              <p className="text-[12px] text-diff-del mt-2">{error}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 h-9 px-6 bg-fg text-ink-0 text-[13px] font-semibold hover:bg-white transition-colors"
            >
              Confirm Lunch
            </button>
          </div>

          <p className="text-[12px] text-fg-4 text-center">
            Note: You cannot dismiss this dialog until you confirm your lunch intake.
          </p>
        </form>
      </div>
    </div>
  );
}
