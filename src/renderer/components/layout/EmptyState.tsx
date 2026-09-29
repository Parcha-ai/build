import React from 'react';
import { Folder } from 'lucide-react';

export default function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center bg-ink-2">
      <div className="text-center max-w-md">
        {/* Icon */}
        <div className="w-12 h-12 flex items-center justify-center mx-auto mb-5 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
          <Folder size={22} strokeWidth={1.8} className="text-fg-3" />
        </div>

        {/* Title */}
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] mb-2 text-fg">
          No session selected
        </h2>

        {/* Description */}
        <p className="text-[13px] leading-[1.6] mb-6 text-fg-3">
          Select an existing session from the sidebar or create a new one to get started.
        </p>

        {/* Keyboard hint */}
        <div className="flex flex-col gap-2 items-center">
          <div className="flex items-center gap-2 text-[12px] text-fg-4">
            <kbd className="font-mono text-[11px] px-1.5 py-0.5 bg-ink-4 text-fg-2">
              ⌘N
            </kbd>
            <span>New session</span>
          </div>
        </div>
      </div>
    </div>
  );
}
