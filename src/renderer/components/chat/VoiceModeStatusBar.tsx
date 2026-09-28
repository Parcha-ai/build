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
  const waveColor = voiceState.isSpeaking ? 'bg-accent-text' : 'bg-accent';

  return (
    <div className="flex min-w-0 max-w-[36rem] items-center gap-2">
      <div
        className={`build-voice-wave flex h-4 flex-shrink-0 items-center gap-[2px] ${waveActive ? 'is-active' : ''}`}
        aria-hidden="true"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <span
            key={index}
            className={`build-voice-wave-bar h-[11px] w-[2px] ${waveColor}`}
            style={{ animationDelay: `${-index * 57}ms` }}
          />
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        {voiceState.agentResponse ? (
          <div className="hide-scrollbar overflow-x-auto" ref={statusScrollRef}>
            <span className={`inline-block max-w-64 truncate whitespace-nowrap text-[12px] ${
              voiceState.isSpeaking ? 'grep-speaking-shimmer' : 'text-fg-2'
            }`}>
              {voiceState.agentResponse}
            </span>
          </div>
        ) : voiceState.isSpeaking ? (
          <span className="grep-speaking-shimmer block text-[12px] text-accent-text">Speaking…</span>
        ) : voiceState.transcript ? (
          <div className="hide-scrollbar overflow-x-auto" ref={statusScrollRef}>
            <span className="inline-block max-w-64 truncate whitespace-nowrap text-[12px] text-fg">
              {voiceState.transcript}
            </span>
          </div>
        ) : (
          <span className="block text-[12px] text-fg-4">Listening…</span>
        )}
      </div>

      <label className="flex flex-shrink-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.04em] text-fg-4">
        <span>Voice</span>
        <select
          aria-label="Realtime voice"
          value={settings?.realtimeVoice || 'marin'}
          onChange={(event) => {
            const realtimeVoice = event.target.value as RealtimeVoiceOption;
            void updateSettings({ realtimeVoice });
          }}
          className="max-w-24 bg-ink-3 px-1.5 py-0.5 text-[11.5px] normal-case tracking-normal text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] focus:shadow-[inset_0_0_0_1px_rgba(76,154,255,0.6)] focus:outline-none"
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
          background: linear-gradient(90deg, #4C9AFF 0%, #CFE2FF 45%, #4C9AFF 100%);
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
