import React, { useEffect, useRef } from 'react';
import { Crown, Cpu, Shield, Rocket, TestTube, Eye, BarChart3, type LucideIcon } from 'lucide-react';
import type { GStackMode } from '../../../shared/types';

// Icon mapping for each mode
const ICON_MAP: Record<string, LucideIcon> = {
  Crown,
  Cpu,
  Shield,
  Rocket,
  TestTube,
  Eye,
  BarChart3,
};

interface GStackModeInfo {
  id: GStackMode;
  name: string;
  shortName: string;
  description: string;
  icon: string;
  color: string;
}

interface GStackMenuProps {
  activeMode: GStackMode | null;
  modes: GStackModeInfo[];
  onSelectMode: (mode: GStackMode | null) => void;
  onClose: () => void;
}

// Group skills by phase
const PHASE_GROUPS = [
  { label: 'Planning', modes: ['plan-ceo', 'plan-eng'] },
  { label: 'Development', modes: ['review', 'ship'] },
  { label: 'Testing', modes: ['qa', 'browse'] },
  { label: 'Analysis', modes: ['retro'] },
];

export default function GStackMenu({ modes, onSelectMode, onClose }: GStackMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const getModeById = (id: string) => modes.find((m) => m.id === id);

  return (
    <div
      ref={menuRef}
      className="absolute top-full right-0 mt-1 w-72 bg-ink-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.35)] z-50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-line">
        <span className="text-[11px] text-fg-4 uppercase tracking-[0.04em]">
          GStack Skills
        </span>
      </div>

      {/* Skill groups */}
      <div className="py-1 max-h-[400px] overflow-y-auto">
        {PHASE_GROUPS.map((group, groupIdx) => (
          <div key={group.label}>
            {groupIdx > 0 && <div className="mx-3 my-1 border-t border-line" />}
            <div className="px-3 py-1">
              <span className="text-[11px] text-fg-5 uppercase tracking-[0.04em]">
                {group.label}
              </span>
            </div>
            {group.modes.map((modeId) => {
              const mode = getModeById(modeId);
              if (!mode) return null;
              const IconComponent = ICON_MAP[mode.icon];

              return (
                <button
                  key={mode.id}
                  onClick={() => {
                    onSelectMode(mode.id);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 hover:bg-claude-surface-hover transition-colors text-left"
                >
                  {/* Icon */}
                  <div
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center"
                    style={{ color: mode.color }}
                  >
                    {IconComponent && <IconComponent size={14} />}
                  </div>

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-fg truncate">{mode.name}</div>
                    <div className="text-[11.5px] text-fg-4 truncate">{mode.description}</div>
                  </div>

                  {/* Shortname badge */}
                  <span
                    className="text-[9.5px] font-mono uppercase px-[5px] py-px flex-shrink-0"
                    style={{ backgroundColor: `${mode.color}20`, color: mode.color }}
                  >
                    {mode.shortName}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
