// Faithful recreation of Claudette's InputArea for hype reel
// Uses exact same Tailwind classes and structure from InputArea.tsx

import React from "react";
import { Mic, Square, Image, FileCode, Brain, Crown } from "lucide-react";

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
type EffortLevel = 'low' | 'medium' | 'high' | 'max';

interface GStackMode {
  shortName: string;
  color: string;
}

interface GrepInputAreaProps {
  inputText?: string;
  isStreaming?: boolean;
  permissionMode?: PermissionMode;
  effortLevel?: EffortLevel;
  modelLabel?: string;
  showVoiceActive?: boolean;
  disabled?: boolean;
  gstackMode?: GStackMode;
}

const PERMISSION_MODE_CONFIG: Record<PermissionMode, { prompt: string; label: string; color: string }> = {
  acceptEdits: { prompt: '>>', label: 'ACCEPT EDITS', color: 'text-green-400' },
  default: { prompt: '>', label: 'ASK', color: 'text-amber-400' },
  bypassPermissions: { prompt: '>>>', label: 'JUST BUILD IT', color: 'text-purple-400' },
  plan: { prompt: '?', label: 'PLAN', color: 'text-blue-400' },
};

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'QUICK',
  medium: 'THINK',
  high: 'DEEP',
  max: 'ULTRA',
};

const EFFORT_COLORS: Record<EffortLevel, string> = {
  low: 'text-gray-400',
  medium: 'text-blue-400',
  high: 'text-purple-400',
  max: 'text-amber-400',
};

export function GrepInputArea({
  inputText = '',
  isStreaming = false,
  permissionMode = 'acceptEdits',
  effortLevel = 'high',
  modelLabel = 'Opus 4.6',
  showVoiceActive = false,
  disabled = false,
  gstackMode,
}: GrepInputAreaProps) {
  const modeConfig = PERMISSION_MODE_CONFIG[permissionMode];
  const effortLabel = EFFORT_LABELS[effortLevel];
  const effortColor = EFFORT_COLORS[effortLevel];

  return (
    <div className="border-t border-claude-border bg-claude-bg">
      {/* Input row */}
      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          {/* Permission mode prompt */}
          <span className={`font-bold font-mono text-lg ${modeConfig.color} flex-shrink-0 pt-0.5`}>
            {modeConfig.prompt}
          </span>

          {/* GStack mode badge */}
          {gstackMode && (
            <span
              className="flex-shrink-0 font-mono text-[10px] font-bold uppercase px-1.5 py-0.5 mt-1"
              style={{
                color: gstackMode.color,
                border: `2px solid ${gstackMode.color}40`,
                backgroundColor: `${gstackMode.color}10`,
                letterSpacing: '0.08em',
              }}
            >
              {gstackMode.shortName}
            </span>
          )}

          {/* Text input area */}
          <div className="flex-1 min-w-0">
            {isStreaming ? (
              <div className="flex items-center gap-2 text-claude-text-secondary font-mono text-sm py-1">
                <Square size={14} className="text-red-400" />
                <span>Press ESC to interrupt</span>
              </div>
            ) : (
              <div className="text-claude-text font-mono text-sm py-1 min-h-[24px]">
                {inputText || (
                  <span className="text-claude-text-secondary">type here...</span>
                )}
                {/* Blinking cursor */}
                {!inputText && (
                  <span className="inline-block w-0.5 h-4 bg-claude-text animate-pulse ml-0.5" style={{ verticalAlign: 'text-bottom' }} />
                )}
              </div>
            )}
          </div>

          {/* Voice button */}
          <div className="flex-shrink-0">
            {showVoiceActive ? (
              <div className="w-8 h-8 flex items-center justify-center bg-red-500/20 border border-red-500/50" style={{ borderRadius: 0 }}>
                <Mic size={14} className="text-red-400" />
              </div>
            ) : (
              <div className="w-8 h-8 flex items-center justify-center text-claude-text-secondary hover:text-claude-text" style={{ borderRadius: 0 }}>
                <Mic size={14} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mode indicators row */}
      <div className="px-4 pb-2 flex items-center gap-3">
        {/* Permission mode */}
        <span className={`text-[9px] font-bold uppercase ${modeConfig.color}`} style={{ letterSpacing: '0.05em' }}>
          {modeConfig.label}
        </span>

        <span className="text-claude-border">@</span>

        {/* Effort level */}
        <span className={`text-[9px] font-bold uppercase ${effortColor}`} style={{ letterSpacing: '0.05em' }}>
          {effortLabel}
        </span>

        <span className="text-claude-border">@</span>

        {/* Model */}
        <span className="text-[9px] font-bold uppercase text-claude-text-secondary" style={{ letterSpacing: '0.05em' }}>
          {modelLabel}
        </span>

        {/* GStack indicator */}
        {gstackMode && (
          <>
            <span className="text-claude-border">@</span>
            <span className="text-[9px] font-bold uppercase" style={{ letterSpacing: '0.05em', color: gstackMode.color }}>
              GSTACK:{gstackMode.shortName}
            </span>
          </>
        )}

        {/* Attachments */}
        <div className="ml-auto flex items-center gap-1">
          <Image size={10} className="text-claude-text-secondary" />
          <FileCode size={10} className="text-claude-text-secondary" />
        </div>

        <span className="text-[9px] text-claude-text-secondary" style={{ letterSpacing: '0.03em' }}>
          ENTER SEND
        </span>
      </div>
    </div>
  );
}
