import React from 'react';
import { Zap, Check } from 'lucide-react';
import type { CompactionStatus } from '../../../shared/types';

interface CompactionBarProps {
  status: CompactionStatus;
}

export default function CompactionBar({ status }: CompactionBarProps) {
  if (!status.isCompacting) return null;

  const isSmartCompact = status.smartCompact?.enabled;

  return (
    <div className="h-[2px] w-full overflow-hidden bg-white/[0.04]">
      <div
        className="h-full"
        style={{
          background: isSmartCompact
            ? 'linear-gradient(90deg, rgba(76,154,255,0) 0%, #4C9AFF 30%, #8DBBFF 50%, #4C9AFF 70%, rgba(76,154,255,0) 100%)'
            : 'linear-gradient(90deg, rgba(76,154,255,0) 0%, #4C9AFF 50%, rgba(76,154,255,0) 100%)',
          backgroundSize: '200% 100%',
          animation: 'compactShimmer 1.5s linear infinite',
        }}
      />
      <style>{`
        @keyframes compactShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

// Completion variant shown briefly after compaction
export function CompactionComplete({ tokensSaved }: { tokensSaved?: number }) {
  return (
    <div className="h-[2px] w-full bg-diff-add/80" />
  );
}
