import React from 'react';
import { Shield, Check, X, ShieldCheck, Zap } from 'lucide-react';
import type { PermissionRequest } from '../../../shared/types';

interface PermissionDialogProps {
  request: PermissionRequest;
  onApprove: (modifiedInput?: Record<string, unknown>, alwaysApprove?: boolean) => void;
  onDeny: () => void;
  onBuildIt: () => void;
}

// Extract a wildcard pattern from a command for "always approve"
// e.g., "gh pr list main" -> "gh pr *"
// e.g., "npm run build" -> "npm run *"
function extractCommandPattern(command: string): string {
  const parts = command.trim().split(/\s+/);
  if (parts.length <= 2) {
    return parts[0] + ' *';
  }
  // Use first two words + wildcard
  return parts.slice(0, 2).join(' ') + ' *';
}

export default function PermissionDialog({ request, onApprove, onDeny, onBuildIt }: PermissionDialogProps) {
  const formatInput = () => {
    const input = request.toolInput || {};
    if (request.toolName === 'Bash') {
      return (input.command as string) || JSON.stringify(input, null, 2);
    }
    return JSON.stringify(input, null, 2);
  };

  // Get pattern for "always approve" display
  const getAlwaysApprovePattern = (): string | null => {
    if (request.toolName === 'Bash') {
      const command = request.toolInput?.command as string;
      if (command) {
        return extractCommandPattern(command);
      }
    }
    return null;
  };

  const pattern = getAlwaysApprovePattern();

  return (
    <div className="bg-ink-1 p-4 shadow-[inset_0_0_0_1px_rgba(240,180,41,0.45)]">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        <Shield size={15} className="flex-shrink-0 text-amber" />
        <h3 className="text-[13.5px] font-semibold text-fg" style={{ letterSpacing: '-0.01em' }}>
          Permission required
        </h3>
        <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full bg-amber shadow-[0_0_0_3px_rgba(240,180,41,0.18)]" />
      </div>

      {/* Tool info */}
      <div className="mb-4 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase text-fg-5" style={{ letterSpacing: '0.04em' }}>TOOL:</span>
          <span className="font-mono text-[12px] text-fg">{request.toolName}</span>
        </div>

        {/* Command/Input */}
        <div>
          <span className="text-[11px] uppercase text-fg-5" style={{ letterSpacing: '0.04em' }}>{request.toolName === 'Bash' ? 'Command:' : 'Input:'}</span>
          <pre className="mt-1 max-h-60 overflow-auto bg-[#0B0B0B] p-2.5 font-mono text-[12px] leading-[1.6] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
            {formatInput()}
          </pre>
        </div>

        {/* Message if provided */}
        {request.message && (
          <div className="text-[12.5px] text-amber">
            {request.message}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onApprove()}
          className="flex h-[30px] items-center gap-1.5 bg-[#EDEDED] px-3 text-[12.5px] font-semibold text-[#0F0F0F] transition-colors hover:bg-white"
        >
          <Check size={13} strokeWidth={2.4} />
          Approve
        </button>
        {pattern && (
          <button
            onClick={() => onApprove(undefined, true)}
            className="flex h-[30px] items-center gap-1.5 px-3 text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] transition-colors hover:bg-white/[0.04] hover:text-fg"
            title={`Always allow: ${pattern}`}
          >
            <ShieldCheck size={13} />
            Always approve
          </button>
        )}
        <button
          onClick={onDeny}
          className="flex h-[30px] items-center gap-1.5 px-3 text-[12.5px] text-fg-3 transition-colors hover:bg-white/[0.04] hover:text-fg"
        >
          <X size={13} />
          Deny
        </button>
        <button
          onClick={onBuildIt}
          className="ml-auto flex h-[30px] items-center gap-1.5 px-3 text-[12.5px] text-accent-text transition-colors hover:bg-[rgba(76,154,255,0.13)]"
          title="Switch to autonomous mode - approve all permissions automatically"
        >
          <Zap size={13} />
          Just build it
        </button>
      </div>
      {pattern && (
        <div className="mt-2.5 text-[11.5px] text-fg-4">
          <span className="text-fg-2">Always approve</span> will allow: <code className="bg-[#0B0B0B] px-1 font-mono text-fg-2">{pattern}</code>
        </div>
      )}
    </div>
  );
}
