import React from 'react';
import { AlertTriangle, Check, X, ShieldCheck, Zap } from 'lucide-react';
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
    <div className="border-2 border-amber-500 bg-amber-500/10 p-4 font-mono">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={20} className="text-amber-500" />
        <h3 className="text-sm font-bold text-amber-400 uppercase" style={{ letterSpacing: '0.1em' }}>
          PERMISSION REQUIRED
        </h3>
      </div>

      {/* Tool info */}
      <div className="space-y-2 mb-4">
        <div>
          <span className="text-xs text-claude-text-secondary">TOOL:</span>
          <span className="ml-2 text-sm font-bold text-claude-text">{request.toolName}</span>
        </div>

        {/* Command/Input */}
        <div>
          <span className="text-xs text-claude-text-secondary uppercase">{request.toolName === 'Bash' ? 'Command:' : 'Input:'}</span>
          <pre className="mt-1 p-2 bg-claude-bg border border-claude-border text-sm text-claude-text overflow-x-auto">
            {formatInput()}
          </pre>
        </div>

        {/* Message if provided */}
        {request.message && (
          <div className="text-xs text-amber-300">
            {request.message}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onDeny}
          className="px-4 py-2 text-xs font-bold uppercase bg-red-900/40 text-red-400 hover:bg-red-900/60 transition-colors flex items-center gap-1.5"
          style={{ letterSpacing: '0.05em', borderRadius: 0 }}
        >
          <X size={14} />
          DENY
        </button>
        <button
          onClick={() => onApprove()}
          className="px-4 py-2 text-xs font-bold uppercase bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-colors flex items-center gap-1.5"
          style={{ letterSpacing: '0.05em', borderRadius: 0 }}
        >
          <Check size={14} />
          APPROVE
        </button>
        {pattern && (
          <button
            onClick={() => onApprove(undefined, true)}
            className="px-4 py-2 text-xs font-bold uppercase bg-blue-900/40 text-blue-400 hover:bg-blue-900/60 transition-colors flex items-center gap-1.5"
            style={{ letterSpacing: '0.05em', borderRadius: 0 }}
            title={`Always allow: ${pattern}`}
          >
            <ShieldCheck size={14} />
            ALWAYS APPROVE
          </button>
        )}
        <button
          onClick={onBuildIt}
          className="px-4 py-2 text-xs font-bold uppercase bg-purple-900/40 text-purple-400 hover:bg-purple-900/60 transition-colors flex items-center gap-1.5"
          style={{ letterSpacing: '0.05em', borderRadius: 0 }}
          title="Switch to autonomous mode - approve all permissions automatically"
        >
          <Zap size={14} />
          JUST BUILD IT
        </button>
      </div>
      {pattern && (
        <div className="mt-2 text-xs text-claude-text-secondary">
          <span className="text-blue-400">Always approve</span> will allow: <code className="bg-claude-bg px-1">{pattern}</code>
        </div>
      )}
    </div>
  );
}
