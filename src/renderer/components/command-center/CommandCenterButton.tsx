import React from 'react';
import { LayoutGrid } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';

export default function CommandCenterButton() {
  const isActive = useUIStore((s) => s.isCommandCenterActive);
  const toggle = useUIStore((s) => s.toggleCommandCenter);

  return (
    <button
      onClick={toggle}
      className={`w-full h-8 flex items-center gap-2 px-3 text-[13px] transition-colors border-b border-line ${
        isActive
          ? 'bg-[rgba(76,154,255,0.13)] text-accent-text'
          : 'text-fg-3 hover:bg-claude-surface-hover hover:text-fg'
      }`}
      style={{ borderRadius: 0 }}
      title="Toggle Command Center (Cmd+Shift+G)"
    >
      <LayoutGrid size={14} />
      <span className="flex-1 text-left">Command Center</span>
      <span className="font-mono text-[10.5px] text-fg-5">⌘⇧G</span>
    </button>
  );
}
