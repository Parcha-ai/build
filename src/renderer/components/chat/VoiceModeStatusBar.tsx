import React, { useEffect, useRef } from 'react';
import { useAudioStore } from '../../stores/audio.store';
import {
  getRealtimeVoiceLabel,
  REALTIME_VOICE_OPTIONS,
  type RealtimeVoiceOption,
} from '../../../shared/types/audio';

interface VoiceModeStatusBarProps {
  sessionId: string;
}

/** Isolates live voice updates from the large InputArea render tree. */
export const VoiceModeStatusBar: React.FC<VoiceModeStatusBarProps> = ({ sessionId }) => {
  const voiceState = useAudioStore((state) => state.voiceModeStates[sessionId]);
  const settings = useAudioStore((state) => state.settings);
  const updateSettings = useAudioStore((state) => state.updateSettings);
  const statusScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = statusScrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [voiceState?.agentResponse, voiceState?.transcript]);

  if (!voiceState?.isConnected) return null;

  const waveActive = voiceState.isSpeaking || voiceState.isUserSpeaking || voiceState.audioLevel > 0.04;
  const waveColor = voiceState.isSpeaking ? 'bg-claude-accent' : 'bg-green-400';

  return (
    <div className="flex min-w-0 max-w-[36rem] items-center gap-2">
      <div
        className={`build-voice-wave flex h-4 flex-shrink-0 items-center gap-[2px] ${waveActive ? 'is-active' : ''}`}
        aria-hidden="true"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <span
            key={index}
            className={`build-voice-wave-bar h-[11px] w-[2px] rounded-full ${waveColor}`}
            style={{ animationDelay: `${-index * 57}ms` }}
          />
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        {voiceState.agentResponse ? (
          <div className="hide-scrollbar overflow-x-auto" ref={statusScrollRef}>
            <span className={`inline-block max-w-64 truncate whitespace-nowrap font-mono text-[10px] ${
              voiceState.isSpeaking ? 'grep-speaking-shimmer' : 'text-claude-text'
            }`}>
              {voiceState.agentResponse}
            </span>
          </div>
        ) : voiceState.isSpeaking ? (
          <span className="grep-speaking-shimmer block font-mono text-[10px] text-claude-accent">Speaking…</span>
        ) : voiceState.transcript ? (
          <div className="hide-scrollbar overflow-x-auto" ref={statusScrollRef}>
            <span className="inline-block max-w-64 truncate whitespace-nowrap font-mono text-[10px] text-green-400">
              {voiceState.transcript}
            </span>
          </div>
        ) : (
          <span className="block font-mono text-[10px] text-green-400/70">Listening…</span>
        )}
      </div>

      <label className="flex flex-shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-claude-text-secondary">
        <span>Voice</span>
        <select
          aria-label="Realtime voice"
          value={settings?.realtimeVoice || 'marin'}
          onChange={(event) => {
            const realtimeVoice = event.target.value as RealtimeVoiceOption;
            void updateSettings({ realtimeVoice });
          }}
          className="max-w-20 border border-claude-border bg-claude-bg px-1 py-0.5 font-mono text-[9px] normal-case tracking-normal text-claude-text focus:border-claude-accent focus:outline-none"
          title="Change realtime voice"
        >
          {REALTIME_VOICE_OPTIONS.map((voice) => (
            <option key={voice} value={voice}>{getRealtimeVoiceLabel(voice)}</option>
          ))}
        </select>
      </label>

      <style>{`
        .build-voice-wave-bar {
          transform: scaleY(0.28);
          transform-origin: center;
          will-change: transform, opacity;
          opacity: 0.55;
        }
        .build-voice-wave.is-active .build-voice-wave-bar {
          animation: build-voice-wave 720ms ease-in-out infinite alternate;
        }
        @keyframes build-voice-wave {
          0% { transform: scaleY(0.25); opacity: 0.55; }
          45% { transform: scaleY(1); opacity: 1; }
          100% { transform: scaleY(0.42); opacity: 0.72; }
        }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .grep-speaking-shimmer {
          background: linear-gradient(90deg, #d97757 0%, #f5a88f 45%, #d97757 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: build-voice-shimmer 1.5s linear infinite;
        }
        @keyframes build-voice-shimmer {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .build-voice-wave.is-active .build-voice-wave-bar,
          .grep-speaking-shimmer { animation: none; }
        }
      `}</style>
    </div>
  );
};
