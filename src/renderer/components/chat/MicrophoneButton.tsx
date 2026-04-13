import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { useAudioStore } from '../../stores/audio.store';

interface MicrophoneButtonProps {
  sessionId: string;
  onTranscriptionComplete?: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
  onSpeechStateChange?: (isSpeaking: boolean) => void;
  onConnectionChange?: (isConnected: boolean) => void;
  disabled?: boolean;
}

// Imperative handle for STT control from InputArea
export interface VoiceModeHandle {
  startPushToTalk: () => Promise<void>;
  stopPushToTalk: () => Promise<void>;
  toggleVoiceMode: () => Promise<void>;
  disconnectVoiceMode: () => Promise<void>;
  isConnected: boolean;
}

/**
 * Microphone Button - Streaming Speech-to-Text
 *
 * Uses OpenAI Realtime API for live transcription with server-side VAD.
 * Words appear in the input box as you speak.
 * Only requires an OpenAI API key.
 *
 * Click to start, click again to stop.
 */
export const MicrophoneButton = forwardRef<VoiceModeHandle, MicrophoneButtonProps>(({
  sessionId: _sessionId,
  onTranscriptionComplete,
  onInterimTranscript,
  onSpeechStateChange,
  onConnectionChange,
  disabled = false,
}, ref) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for audio capture
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const isConnectedRef = useRef(false);
  const cleanupFnsRef = useRef<Array<() => void>>([]);

  // Accumulate deltas for the current utterance
  const currentTranscriptRef = useRef('');

  // Ref for callbacks to avoid stale closures
  const onTranscriptionCompleteRef = useRef(onTranscriptionComplete);
  const onInterimTranscriptRef = useRef(onInterimTranscript);
  const onSpeechStateChangeRef = useRef(onSpeechStateChange);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onTranscriptionCompleteRef.current = onTranscriptionComplete;
  onInterimTranscriptRef.current = onInterimTranscript;
  onSpeechStateChangeRef.current = onSpeechStateChange;
  onConnectionChangeRef.current = onConnectionChange;

  /**
   * Convert Float32 audio samples to Int16 PCM
   */
  const float32ToInt16 = useCallback((float32: Float32Array): Int16Array => {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }, []);

  /**
   * Resample audio from source rate to target rate
   */
  const resample = useCallback((samples: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
    if (sourceRate === targetRate) return samples;
    const ratio = sourceRate / targetRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * ratio;
      const low = Math.floor(srcIdx);
      const high = Math.min(low + 1, samples.length - 1);
      const frac = srcIdx - low;
      result[i] = samples[low] * (1 - frac) + samples[high] * frac;
    }
    return result;
  }, []);

  /**
   * Set up IPC event listeners for Realtime API events
   */
  const setupListeners = useCallback(() => {
    // Clean up any existing listeners
    cleanupFnsRef.current.forEach(fn => fn());
    cleanupFnsRef.current = [];

    const unsubConnected = window.electronAPI.realtime.onConnected(() => {
      console.log('[MicrophoneButton] Realtime connected');
      isConnectedRef.current = true;
      setIsConnected(true);
      setIsConnecting(false);
      onConnectionChangeRef.current?.(true);
    });
    cleanupFnsRef.current.push(unsubConnected);

    const unsubDisconnected = window.electronAPI.realtime.onDisconnected(() => {
      console.log('[MicrophoneButton] Realtime disconnected');
      isConnectedRef.current = false;
      setIsConnected(false);
      setIsSpeaking(false);
      onConnectionChangeRef.current?.(false);
    });
    cleanupFnsRef.current.push(unsubDisconnected);

    const unsubDelta = window.electronAPI.realtime.onTranscriptionDelta((delta: string) => {
      // Accumulate deltas for the current utterance
      currentTranscriptRef.current += delta;
      onInterimTranscriptRef.current?.(currentTranscriptRef.current);
    });
    cleanupFnsRef.current.push(unsubDelta);

    const unsubCompleted = window.electronAPI.realtime.onTranscriptionCompleted((transcript: string) => {
      console.log('[MicrophoneButton] Transcription completed:', transcript.slice(0, 80));
      // Use the completed transcript (more accurate than accumulated deltas)
      const finalText = transcript.trim();
      if (finalText) {
        onTranscriptionCompleteRef.current?.(finalText);
      }
      // Reset accumulated transcript for next utterance
      currentTranscriptRef.current = '';
    });
    cleanupFnsRef.current.push(unsubCompleted);

    const unsubSpeechStarted = window.electronAPI.realtime.onSpeechStarted(() => {
      setIsSpeaking(true);
      onSpeechStateChangeRef.current?.(true);
      // Clear accumulated transcript for new utterance
      currentTranscriptRef.current = '';
    });
    cleanupFnsRef.current.push(unsubSpeechStarted);

    const unsubSpeechStopped = window.electronAPI.realtime.onSpeechStopped(() => {
      setIsSpeaking(false);
      onSpeechStateChangeRef.current?.(false);
    });
    cleanupFnsRef.current.push(unsubSpeechStopped);

    const unsubError = window.electronAPI.realtime.onError((err: string) => {
      console.error('[MicrophoneButton] Realtime error:', err);
      setError(err);
    });
    cleanupFnsRef.current.push(unsubError);
  }, []);

  /**
   * Start streaming STT: connect to Realtime API + capture mic audio
   */
  const startStreaming = useCallback(async () => {
    try {
      setError(null);
      setIsConnecting(true);

      // Set up event listeners before connecting
      setupListeners();

      // Connect to OpenAI Realtime API (via main process)
      const result = await window.electronAPI.realtime.connect();
      if (!result.success) {
        throw new Error(result.error || 'Failed to connect to Realtime API');
      }

      // Capture microphone audio
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (!isConnectedRef.current) return;

        const inputData = event.inputBuffer.getChannelData(0);
        const resampled = resample(inputData, audioContext.sampleRate, 16000);
        const int16Data = float32ToInt16(resampled);
        const audioArray = Array.from(int16Data);

        window.electronAPI.realtime.sendAudio(audioArray).catch((e: Error) => {
          console.error('[MicrophoneButton] Error sending audio:', e);
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      console.log('[MicrophoneButton] Streaming STT started');
    } catch (err) {
      console.error('[MicrophoneButton] Failed to start streaming:', err);
      setError(err instanceof Error ? err.message : 'Failed to start microphone');
      setIsConnecting(false);
      // Clean up on failure
      cleanupFnsRef.current.forEach(fn => fn());
      cleanupFnsRef.current = [];
    }
  }, [setupListeners, float32ToInt16, resample]);

  /**
   * Stop streaming STT: disconnect from Realtime API + release mic
   */
  const stopStreaming = useCallback(async () => {
    // Stop audio processing
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    // Disconnect from Realtime API
    await window.electronAPI.realtime.disconnect();

    // Clean up listeners
    cleanupFnsRef.current.forEach(fn => fn());
    cleanupFnsRef.current = [];

    isConnectedRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    setIsSpeaking(false);
    currentTranscriptRef.current = '';
    onConnectionChangeRef.current?.(false);

    console.log('[MicrophoneButton] Streaming STT stopped');
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (isConnectedRef.current) {
        stopStreaming();
      }
    };
  }, [stopStreaming]);

  // Expose imperative handle for push-to-talk control from InputArea
  useImperativeHandle(ref, () => ({
    startPushToTalk: async () => {
      if (!isConnected && !isConnecting) {
        await startStreaming();
      }
    },
    stopPushToTalk: async () => {
      if (isConnected) {
        await stopStreaming();
      }
    },
    toggleVoiceMode: async () => {
      if (isConnected) {
        await stopStreaming();
      } else if (!isConnecting) {
        await startStreaming();
      }
    },
    disconnectVoiceMode: async () => {
      if (isConnected) {
        await stopStreaming();
      }
    },
    isConnected,
  }), [isConnected, isConnecting, startStreaming, stopStreaming]);

  const handleClick = useCallback(async () => {
    if (isConnected) {
      await stopStreaming();
    } else if (!isConnecting) {
      await startStreaming();
    }
  }, [isConnected, isConnecting, startStreaming, stopStreaming]);

  const getStatusColor = () => {
    if (error) return 'text-red-500';
    if (isConnected) return 'text-green-500 hover:text-green-400';
    if (isConnecting) return 'text-yellow-500';
    return 'text-claude-text-secondary hover:text-claude-accent';
  };

  const getTitle = () => {
    if (error) return `Error: ${error}`;
    if (isConnecting) return 'Connecting to speech-to-text...';
    if (isConnected && isSpeaking) return 'Listening... click to stop';
    if (isConnected) return 'Mic active — speak now (click to stop)';
    return 'Click to start dictation';
  };

  const renderIcon = () => {
    if (isConnecting) {
      return <Loader2 className="w-4 h-4 animate-spin" />;
    }

    if (isConnected) {
      return (
        <div className="relative">
          <Mic className="w-4 h-4" />
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
        </div>
      );
    }

    return <Mic className="w-4 h-4" />;
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isConnecting}
      className={`
        relative p-1 transition-all duration-200
        ${getStatusColor()}
        ${disabled || isConnecting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
      style={{ borderRadius: 0 }}
      title={getTitle()}
    >
      {renderIcon()}
    </button>
  );
});

MicrophoneButton.displayName = 'MicrophoneButton';
