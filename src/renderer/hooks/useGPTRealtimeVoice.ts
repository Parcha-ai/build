import { useCallback, useEffect, useRef, useState } from 'react';

interface ToolCall {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

interface UseGPTRealtimeVoiceOptions {
  sessionId: string;
  model?: string; // 'gpt-realtime-2' or 'gpt-realtime-mini'
  voice?: string; // 'ash', 'coral', 'sage', etc.
  onTranscript?: (text: string, isFinal: boolean) => void;
  onAgentResponse?: (text: string) => void;
  onError?: (error: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<string>;
}

interface GPTRealtimeVoiceState {
  isConnected: boolean;
  isConnecting: boolean;
  isRecording: boolean;
  isSpeaking: boolean; // model is outputting audio
  currentTranscript: string;
  agentTranscript: string; // model's spoken response text
  error: string | null;
  audioLevel: number;
}

/**
 * Hook for GPT Realtime voice mode via WebSocket (through IPC).
 *
 * Unlike the ElevenLabs SDK which uses WebRTC with built-in echo
 * cancellation, this hook manually captures the mic, streams PCM16
 * audio via IPC, decodes base64 PCM16 audio for playback, and mutes
 * the mic during model playback to prevent echo feedback.
 */
export const useGPTRealtimeVoice = ({
  sessionId,
  model = 'gpt-realtime-2',
  voice = 'ash',
  onTranscript,
  onAgentResponse,
  onError,
  onToolCall,
}: UseGPTRealtimeVoiceOptions) => {
  const [state, setState] = useState<GPTRealtimeVoiceState>({
    isConnected: false,
    isConnecting: false,
    isRecording: false,
    isSpeaking: false,
    currentTranscript: '',
    agentTranscript: '',
    error: null,
    audioLevel: 0,
  });

  // Refs for the audio pipeline
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const isConnectedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const isMicMutedRef = useRef(false);

  // Audio playback queue
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Track which sessions had voice active -- auto-reconnect on switch
  const voiceActiveSessionsRef = useRef<Set<string>>(new Set());

  // Cleanup functions for IPC event listeners
  const cleanupFunctionsRef = useRef<Array<() => void>>([]);

  // Audio level polling
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Accumulator refs for streaming text
  const agentTextAccumulatorRef = useRef('');
  const userTranscriptAccumulatorRef = useRef('');

  // Stable callback refs to avoid stale closures
  const onTranscriptRef = useRef(onTranscript);
  const onAgentResponseRef = useRef(onAgentResponse);
  const onErrorRef = useRef(onError);
  const onToolCallRef = useRef(onToolCall);

  onTranscriptRef.current = onTranscript;
  onAgentResponseRef.current = onAgentResponse;
  onErrorRef.current = onError;
  onToolCallRef.current = onToolCall;

  // Store the initial context so we can pass it at connect time
  const initialContextRef = useRef<string>('');

  // ----------------------------------------------------------------
  // Audio playback helpers
  // ----------------------------------------------------------------

  /** Decode a base64-encoded PCM16 chunk into a Float32Array. */
  const decodeBase64PCM16 = useCallback((base64: string): Float32Array => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    return float32;
  }, []);

  /** Play the next chunk in the queue, chaining via onended. */
  const playNextChunk = useCallback(() => {
    const ctx = playbackContextRef.current;
    if (!ctx || playbackQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      // Playback ended -- unmute mic
      if (isSpeakingRef.current) {
        isSpeakingRef.current = false;
        setState(s => ({ ...s, isSpeaking: false }));
        // Reconnect mic if we were recording
        if (processorRef.current && micSourceRef.current && !isMicMutedRef.current) {
          try {
            micSourceRef.current.connect(processorRef.current);
          } catch {
            // Already connected -- ignore
          }
        }
      }
      return;
    }

    isPlayingRef.current = true;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const samples = playbackQueueRef.current.shift()!;
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    currentSourceRef.current = source;

    source.onended = () => {
      currentSourceRef.current = null;
      playNextChunk();
    };

    source.start();
  }, []);

  /** Enqueue decoded audio for sequential playback. */
  const enqueueAudio = useCallback((samples: Float32Array) => {
    playbackQueueRef.current.push(samples);

    // Mute mic when model starts speaking to prevent echo
    if (!isSpeakingRef.current) {
      isSpeakingRef.current = true;
      setState(s => ({ ...s, isSpeaking: true }));
      // Disconnect mic -> processor to mute
      if (micSourceRef.current && processorRef.current) {
        try {
          micSourceRef.current.disconnect(processorRef.current);
        } catch {
          // Not connected -- fine
        }
      }
    }

    if (!isPlayingRef.current) {
      playNextChunk();
    }
  }, [playNextChunk]);

  // ----------------------------------------------------------------
  // Float32 -> Int16 conversion (same as useAudioRecorder)
  // ----------------------------------------------------------------
  const float32ToInt16 = useCallback((float32: Float32Array): Int16Array => {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }, []);

  /** Resample from source rate to target rate via linear interpolation. */
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

  // ----------------------------------------------------------------
  // IPC event listeners setup
  // ----------------------------------------------------------------
  const setupListeners = useCallback(() => {
    // --- Audio chunks from the model ---
    const unsubAudio = window.electronAPI.realtime.onAudioChunk((data) => {
      if (data.audio) {
        const decoded = decodeBase64PCM16(data.audio);
        enqueueAudio(decoded);
      }
      if (data.done) {
        // Final audio chunk for this item -- playback queue will drain naturally
        console.log('[GPTRealtime] Audio item done, itemId:', data.itemId);
      }
    });
    cleanupFunctionsRef.current.push(unsubAudio);

    // --- Model response text (streaming) ---
    const unsubTextDelta = window.electronAPI.realtime.onTextDelta((data) => {
      agentTextAccumulatorRef.current += data.text;
      setState(s => ({ ...s, agentTranscript: agentTextAccumulatorRef.current }));
    });
    cleanupFunctionsRef.current.push(unsubTextDelta);

    // --- Model response text (final) ---
    const unsubTextDone = window.electronAPI.realtime.onTextDone((data) => {
      agentTextAccumulatorRef.current = data.text;
      setState(s => ({ ...s, agentTranscript: data.text }));
      onAgentResponseRef.current?.(data.text);
    });
    cleanupFunctionsRef.current.push(unsubTextDone);

    // --- Tool calls from the model ---
    const unsubToolCall = window.electronAPI.realtime.onToolCall(async (data) => {
      console.log('[GPTRealtime] Tool call:', data.name, data.callId);
      if (onToolCallRef.current) {
        try {
          const args = JSON.parse(data.arguments || '{}');
          const result = await onToolCallRef.current({
            toolCallId: data.callId,
            toolName: data.name,
            parameters: args,
          });
          // Submit result back
          await window.electronAPI.realtime.submitToolResult(data.callId, result);
          console.log('[GPTRealtime] Tool result submitted for', data.callId);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : 'Tool call failed';
          console.error('[GPTRealtime] Tool call error:', errMsg);
          try {
            await window.electronAPI.realtime.submitToolResult(data.callId, `Error: ${errMsg}`);
          } catch {
            // Best effort
          }
        }
      }
    });
    cleanupFunctionsRef.current.push(unsubToolCall);

    // --- Response done ---
    const unsubResponseDone = window.electronAPI.realtime.onResponseDone((data) => {
      console.log('[GPTRealtime] Response done, status:', data.status);
      // Reset agent text accumulator for next response
      agentTextAccumulatorRef.current = '';
    });
    cleanupFunctionsRef.current.push(unsubResponseDone);

    // --- User transcription (streaming) ---
    const unsubTranscriptDelta = window.electronAPI.realtime.onTranscriptionDelta((delta: string) => {
      userTranscriptAccumulatorRef.current = delta;
      setState(s => ({ ...s, currentTranscript: delta }));
      onTranscriptRef.current?.(delta, false);
    });
    cleanupFunctionsRef.current.push(unsubTranscriptDelta);

    // --- User transcription (completed) ---
    const unsubTranscriptComplete = window.electronAPI.realtime.onTranscriptionCompleted((transcript: string) => {
      userTranscriptAccumulatorRef.current = '';
      setState(s => ({ ...s, currentTranscript: transcript }));
      onTranscriptRef.current?.(transcript, true);
    });
    cleanupFunctionsRef.current.push(unsubTranscriptComplete);

    // --- Connection events ---
    const unsubConnected = window.electronAPI.realtime.onConnected(() => {
      console.log('[GPTRealtime] Connected');
      isConnectedRef.current = true;
      voiceActiveSessionsRef.current.add(sessionId);
      setState(s => ({ ...s, isConnected: true, isConnecting: false }));
    });
    cleanupFunctionsRef.current.push(unsubConnected);

    const unsubDisconnected = window.electronAPI.realtime.onDisconnected(() => {
      console.log('[GPTRealtime] Disconnected');
      isConnectedRef.current = false;
      setState(s => ({ ...s, isConnected: false, isRecording: false, isSpeaking: false }));
    });
    cleanupFunctionsRef.current.push(unsubDisconnected);

    // --- Errors ---
    const unsubError = window.electronAPI.realtime.onError((error: string) => {
      console.error('[GPTRealtime] Error:', error);
      setState(s => ({ ...s, error }));
      onErrorRef.current?.(error);
    });
    cleanupFunctionsRef.current.push(unsubError);
  }, [sessionId, decodeBase64PCM16, enqueueAudio]);

  const cleanupListeners = useCallback(() => {
    cleanupFunctionsRef.current.forEach(fn => fn());
    cleanupFunctionsRef.current = [];
  }, []);

  // ----------------------------------------------------------------
  // Mic capture
  // ----------------------------------------------------------------
  const startMicCapture = useCallback(async () => {
    // Request mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 24000,
      },
    });
    micStreamRef.current = stream;

    // AudioContext at 24kHz for capture
    const ctx = new AudioContext({ sampleRate: 24000 });
    audioContextRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    micSourceRef.current = source;

    // AnalyserNode for audio level metering
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    source.connect(analyser);

    // ScriptProcessor for sending PCM to the backend
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      if (!isConnectedRef.current) return;
      // If mic is muted (model speaking), skip
      // The source -> processor connection is severed during playback,
      // but onaudioprocess can still fire with silence. Skip sending.
      if (isSpeakingRef.current) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const resampled = resample(inputData, ctx.sampleRate, 24000);
      const int16Data = float32ToInt16(resampled);
      const audioArray = Array.from(int16Data);

      window.electronAPI.realtime.sendAudio(audioArray).catch((err) => {
        console.warn('[GPTRealtime] Failed to send audio chunk:', err);
      });
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    // Audio level polling
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioLevelIntervalRef.current = setInterval(() => {
      if (analyserRef.current) {
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255; // Normalise to 0-1
        setState(s => ({ ...s, audioLevel: avg }));
      }
    }, 100);

    isMicMutedRef.current = false;
    setState(s => ({ ...s, isRecording: true }));

    console.log('[GPTRealtime] Mic capture started');
  }, [float32ToInt16, resample]);

  const stopMicCapture = useCallback(() => {
    // Audio level polling
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }
    analyserRef.current = null;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => { /* cleanup */ });
      audioContextRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }

    setState(s => ({ ...s, isRecording: false, audioLevel: 0 }));
    console.log('[GPTRealtime] Mic capture stopped');
  }, []);

  // ----------------------------------------------------------------
  // Connect / Disconnect
  // ----------------------------------------------------------------
  const connect = useCallback(async () => {
    try {
      setState(s => ({ ...s, isConnecting: true, error: null }));

      // Check macOS mic permission (same pattern as ElevenLabs hook)
      if (window.electronAPI?.audio?.checkMicrophonePermission) {
        const permStatus = await window.electronAPI.audio.checkMicrophonePermission();
        console.log('[GPTRealtime] Mic permission status:', permStatus);

        if (!permStatus.granted) {
          if (permStatus.canRequest) {
            console.log('[GPTRealtime] Requesting mic permission...');
            const result = await window.electronAPI.audio.requestMicrophonePermission();
            if (!result.granted) {
              const errorMsg = result.error || 'Microphone access denied';
              console.error('[GPTRealtime] Mic permission denied:', errorMsg);
              setState(s => ({ ...s, isConnecting: false, error: errorMsg }));
              onErrorRef.current?.(errorMsg);
              return;
            }
            console.log('[GPTRealtime] Mic permission granted');
          } else {
            const errorMsg = 'Microphone access denied. Please enable it in System Settings > Privacy & Security > Microphone.';
            console.error('[GPTRealtime]', errorMsg);
            setState(s => ({ ...s, isConnecting: false, error: errorMsg }));
            onErrorRef.current?.(errorMsg);
            return;
          }
        }
      }

      // Set up IPC event listeners before connecting
      setupListeners();

      // Connect to the Realtime API via the main process
      console.log('[GPTRealtime] Connecting with model:', model);
      const connectResult = await window.electronAPI.realtime.connect(model);
      if (!connectResult.success) {
        throw new Error(connectResult.error || 'Failed to connect to GPT Realtime');
      }

      // Send session configuration
      console.log('[GPTRealtime] Sending session update...');
      const sessionConfig: Parameters<typeof window.electronAPI.realtime.sessionUpdate>[0] = {
        modalities: ['text', 'audio'],
        voice,
        instructions: initialContextRef.current || `You are a helpful voice assistant for a coding tool called Build. Keep responses brief.`,
        tools: [
          {
            type: 'function' as const,
            name: 'execute_grep_command',
            description: 'Send an instruction to Build (the coding agent) to execute. Use this when the user asks you to DO something (write code, fix a bug, run a command, change a file). Pass the full user instruction as the "instruction" parameter.',
            parameters: {
              type: 'object',
              properties: {
                instruction: {
                  type: 'string',
                  description: 'The full instruction to send to Build',
                },
              },
              required: ['instruction'],
            },
          },
          {
            type: 'function' as const,
            name: 'get_task_status',
            description: 'Get the current status of Build (the coding agent). Call this to check what Build is doing, whether a task is complete, or to get the latest progress. Returns JSON with status, recent tool calls, and latest thinking.',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        ],
        turnDetection: {
          type: 'semantic_vad',
          eagerness: 'medium',
        },
        inputAudioNoiseReduction: { type: 'near_field' },
        inputAudioTranscription: { model: 'whisper-1' },
      };

      const updateResult = await window.electronAPI.realtime.sessionUpdate(sessionConfig);
      if (!updateResult.success) {
        console.warn('[GPTRealtime] Session update warning:', updateResult.error);
        // Non-fatal -- the session might still work
      }

      // Create playback AudioContext
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
      playbackQueueRef.current = [];
      isPlayingRef.current = false;

      // Start mic capture
      await startMicCapture();

      console.log('[GPTRealtime] Fully connected and recording');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect';
      console.error('[GPTRealtime] Connect error:', error);
      setState(s => ({ ...s, isConnecting: false, error: errorMessage }));
      onErrorRef.current?.(errorMessage);
      cleanupListeners();
    }
  }, [model, voice, setupListeners, cleanupListeners, startMicCapture]);

  const disconnect = useCallback(async () => {
    // Stop playback
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      currentSourceRef.current = null;
    }
    playbackQueueRef.current = [];
    isPlayingRef.current = false;

    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => { /* cleanup */ });
      playbackContextRef.current = null;
    }

    // Stop mic
    stopMicCapture();

    // Disconnect IPC
    if (isConnectedRef.current) {
      await window.electronAPI.realtime.disconnect();
    }
    isConnectedRef.current = false;
    isSpeakingRef.current = false;

    // Remove from auto-reconnect set
    voiceActiveSessionsRef.current.delete(sessionId);

    // Clean up listeners
    cleanupListeners();

    // Reset accumulators
    agentTextAccumulatorRef.current = '';
    userTranscriptAccumulatorRef.current = '';

    setState({
      isConnected: false,
      isConnecting: false,
      isRecording: false,
      isSpeaking: false,
      currentTranscript: '',
      agentTranscript: '',
      error: null,
      audioLevel: 0,
    });
  }, [sessionId, stopMicCapture, cleanupListeners]);

  // ----------------------------------------------------------------
  // Start / Stop recording (mute/unmute mic while connected)
  // ----------------------------------------------------------------
  const startRecording = useCallback(async () => {
    if (!isConnectedRef.current) {
      console.warn('[GPTRealtime] Not connected');
      return;
    }
    isMicMutedRef.current = false;
    // Reconnect mic -> processor
    if (micSourceRef.current && processorRef.current) {
      try {
        micSourceRef.current.connect(processorRef.current);
      } catch {
        // Already connected
      }
    }
    setState(s => ({ ...s, isRecording: true }));
  }, []);

  const stopRecording = useCallback(async () => {
    isMicMutedRef.current = true;
    // Disconnect mic -> processor to stop sending audio
    if (micSourceRef.current && processorRef.current) {
      try {
        micSourceRef.current.disconnect(processorRef.current);
      } catch {
        // Not connected
      }
    }
    setState(s => ({ ...s, isRecording: false }));
  }, []);

  // ----------------------------------------------------------------
  // No-op methods for API compatibility with ElevenLabs hook
  // ----------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const speak = useCallback(async (text: string) => {
    // GPT Realtime doesn't support text injection the way ElevenLabs does.
    // The model generates its own speech from its instructions and conversation.
    void text;
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const updateContext = useCallback(async (context: string) => {
    // Context is set at connect time via session instructions.
    // GPT Realtime doesn't support runtime context updates like ElevenLabs contextualUpdate.
    void context;
  }, []);

  const sendUserActivity = useCallback(() => {
    // No equivalent in GPT Realtime -- the WebSocket stays alive on its own
    return;
  }, []);

  // ----------------------------------------------------------------
  // Session switch handling
  // ----------------------------------------------------------------
  const previousSessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      const oldId = previousSessionIdRef.current;
      console.log('[GPTRealtime] Session switch:', oldId, '->', sessionId);

      // Tear down current connection
      if (currentSourceRef.current) {
        try { currentSourceRef.current.stop(); } catch { /* */ }
        currentSourceRef.current = null;
      }
      playbackQueueRef.current = [];
      isPlayingRef.current = false;

      if (playbackContextRef.current) {
        playbackContextRef.current.close().catch(() => { /* cleanup */ });
        playbackContextRef.current = null;
      }

      stopMicCapture();

      if (isConnectedRef.current) {
        window.electronAPI.realtime.disconnect().catch(() => { /* cleanup */ });
      }
      isConnectedRef.current = false;
      isSpeakingRef.current = false;
      cleanupListeners();

      agentTextAccumulatorRef.current = '';
      userTranscriptAccumulatorRef.current = '';

      setState({
        isConnected: false,
        isConnecting: false,
        isRecording: false,
        isSpeaking: false,
        currentTranscript: '',
        agentTranscript: '',
        error: null,
        audioLevel: 0,
      });

      // Auto-reconnect if the new session previously had voice active
      if (voiceActiveSessionsRef.current.has(sessionId)) {
        console.log('[GPTRealtime] Auto-reconnecting voice for session', sessionId);
        setTimeout(() => {
          connect();
        }, 300);
      }
    }
    previousSessionIdRef.current = sessionId;
  }, [sessionId, connect, stopMicCapture, cleanupListeners]);

  // ----------------------------------------------------------------
  // Cleanup on unmount
  // ----------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current);
      }
      if (currentSourceRef.current) {
        try { currentSourceRef.current.stop(); } catch { /* */ }
      }
      if (playbackContextRef.current) {
        playbackContextRef.current.close().catch(() => { /* cleanup */ });
      }
      if (processorRef.current) {
        processorRef.current.disconnect();
      }
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => { /* cleanup */ });
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
      }
      if (isConnectedRef.current) {
        window.electronAPI.realtime.disconnect().catch(() => { /* cleanup */ });
      }
      cleanupFunctionsRef.current.forEach(fn => fn());
      cleanupFunctionsRef.current = [];
    };
  }, []);

  // Expose initialContextRef setter for MicrophoneButton to set instructions
  const setInitialContext = useCallback((context: string) => {
    initialContextRef.current = context;
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    speak,
    updateContext,
    sendUserActivity,
    setInitialContext,
  };
};
