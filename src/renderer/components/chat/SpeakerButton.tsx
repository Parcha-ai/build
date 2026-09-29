import React, { useEffect, useRef, useCallback } from 'react';
import { Volume2, VolumeX, Loader2, Radio } from 'lucide-react';
import { useAudioStore } from '../../stores/audio.store';
import { AudioWaveform } from './AudioWaveform';

interface SpeakerButtonProps {
  messageId: string;
  text: string;
  disabled?: boolean;
}

// Singleton AudioContext for the entire app
let globalAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!globalAudioContext || globalAudioContext.state === 'closed') {
    globalAudioContext = new AudioContext();
  }
  return globalAudioContext;
}

export const SpeakerButton: React.FC<SpeakerButtonProps> = ({
  messageId,
  text,
  disabled = false,
}) => {
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playedRef = useRef(false);

  const {
    ttsStates,
    settings,
    startTTS,
    stopTTS,
    setTTSError,
  } = useAudioStore();

  const ttsState = ttsStates[messageId];
  const isPlaying = ttsState?.isPlaying || false;
  const audioChunks = ttsState?.audioChunks || [];
  const progress = ttsState?.progress || 0;

  // Play audio when chunks are received and stream is complete
  useEffect(() => {
    // Only play when we have chunks, playing, stream is complete, and haven't played yet
    if (!isPlaying || audioChunks.length === 0 || playedRef.current || progress !== 100) {
      return;
    }

    playedRef.current = true;

    const playAudio = async () => {
      try {
        const audioContext = getAudioContext();

        // Resume if suspended (required by browser autoplay policies)
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        // Concatenate all audio chunks
        const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const concatenated = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunks) {
          concatenated.set(chunk, offset);
          offset += chunk.length;
        }

        // Decode audio data
        const audioBuffer = await audioContext.decodeAudioData(concatenated.buffer.slice(0));

        // Stop any existing playback
        if (sourceNodeRef.current) {
          try {
            sourceNodeRef.current.stop();
          } catch {
            // Already stopped
          }
        }

        // Create and play audio buffer
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        sourceNodeRef.current = source;

        source.onended = () => {
          sourceNodeRef.current = null;
          playedRef.current = false;
        };

        source.start(0);
      } catch (error) {
        console.error('Failed to play audio:', error);
        setTTSError(messageId, error instanceof Error ? error.message : 'Playback failed');
        playedRef.current = false;
        // Also stop the TTS state so user can retry
        stopTTS(messageId);
      }
    };

    playAudio();
  }, [audioChunks.length, isPlaying, progress, messageId, setTTSError, stopTTS]);

  // Reset played ref when playback stops
  useEffect(() => {
    if (!isPlaying) {
      playedRef.current = false;
    }
  }, [isPlaying]);

  const handleClick = useCallback(async () => {
    if (isPlaying) {
      // Stop playback
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch {
          // Already stopped
        }
        sourceNodeRef.current = null;
      }
      stopTTS(messageId);
      await window.electronAPI.audio.cancelTTS(messageId);
      playedRef.current = false;
    } else {
      // Start TTS
      if (!settings?.voiceSettings) {
        setTTSError(messageId, 'Voice settings not configured');
        return;
      }

      startTTS(messageId);
      const response = await window.electronAPI.audio.streamTTS({
        text,
        messageId,
        voiceId: settings.voiceSettings.voiceId,
        modelId: 'gpt-4o-mini-tts',
      });

      if (!response.success) {
        setTTSError(messageId, response.error || 'Failed to start TTS');
        stopTTS(messageId);
      }
    }
  }, [isPlaying, messageId, text, settings, startTTS, stopTTS, setTTSError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch {
          // Already stopped
        }
      }
    };
  }, []);

  const isLoading = isPlaying && audioChunks.length === 0;
  const isBuffering = isPlaying && progress < 100;

  return (
    <div className="flex items-center gap-2">
      {/* Playing/buffering indicator with waveform */}
      {isPlaying && !isLoading && (
        <div className="flex items-center gap-2 px-2 py-1 bg-accent/[0.13] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]" style={{ borderRadius: 0 }}>
          <AudioWaveform isActive={!isBuffering} color="rgb(76, 154, 255)" barCount={6} height={12} />
          {isBuffering && (
            <span className="text-[11px] text-accent-text uppercase tracking-[0.04em]">
              Buffering
            </span>
          )}
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 px-2 py-1 bg-accent/[0.13] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]" style={{ borderRadius: 0 }}>
          <Radio className="w-3 h-3 text-accent-text animate-pulse" />
          <span className="text-[11px] text-accent-text uppercase tracking-[0.04em]">
            Streaming
          </span>
        </div>
      )}

      {/* Speaker button */}
      <button
        onClick={handleClick}
        disabled={disabled}
        className={`
          relative flex h-[30px] w-[30px] items-center justify-center transition-colors duration-150 group
          ${isPlaying
            ? 'bg-accent/[0.13] text-accent-text shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)] hover:bg-accent/20'
            : 'bg-transparent text-fg-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-white/[0.05] hover:text-fg'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        style={{ borderRadius: 0 }}
        title={isPlaying ? 'Stop playback' : 'Play with text-to-speech'}
      >
        {isLoading ? (
          <Loader2 className="w-[15px] h-[15px] animate-spin" />
        ) : isPlaying ? (
          <VolumeX className="w-[15px] h-[15px]" />
        ) : (
          <Volume2 className="w-[15px] h-[15px]" />
        )}

        {/* Subtle animation when playing */}
        {isPlaying && !isLoading && (
          <span className="absolute inset-0 border border-accent/60 animate-pulse" style={{ borderRadius: 0 }} />
        )}
      </button>
    </div>
  );
};
