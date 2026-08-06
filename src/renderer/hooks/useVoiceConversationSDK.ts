import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeReasoningEffort, RealtimeVoiceOption } from '../../shared/types/audio';

interface ToolCall {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

interface ToolCallResultWithImage {
  output: string;
  inputImageDataUrl: string;
}

type ToolCallResult = string | ToolCallResultWithImage;

interface UseVoiceConversationOptions {
  sessionId: string;
  memorySessionId?: string;
  systemPrompt?: string;
  voice?: RealtimeVoiceOption;
  reasoningEffort?: RealtimeReasoningEffort;
  language?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onAgentResponse?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolCallResult>;
}

interface VoiceConversationState {
  isConnected: boolean;
  isConnecting: boolean;
  isRecording: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  currentTranscript: string;
  error: string | null;
  audioLevel: number;
}

interface RealtimeServerEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  response?: { status?: string };
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  error?: { message?: string; code?: string };
}

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const EVENT_FLUSH_MS = 100;

const INITIAL_STATE: VoiceConversationState = {
  isConnected: false,
  isConnecting: false,
  isRecording: false,
  isSpeaking: false,
  isUserSpeaking: false,
  currentTranscript: '',
  error: null,
  audioLevel: 0,
};

function logVoiceRouting(event: string, details?: Record<string, unknown>): void {
  try {
    window.electronAPI?.voice?.logRoutingEvent({ event, details });
  } catch {
    // Diagnostics must never interrupt the realtime conversation.
  }
}

/**
 * Direct OpenAI Realtime WebRTC transport.
 *
 * The main process exchanges the long-lived OpenAI key for an ephemeral client
 * secret. Audio then travels directly over WebRTC, while JSON events and Build
 * tool calls use the peer connection's data channel.
 */
export const useVoiceConversationSDK = ({
  sessionId,
  memorySessionId,
  systemPrompt,
  voice = 'marin',
  reasoningEffort = 'low',
  language = 'en',
  onTranscript,
  onAgentResponse,
  onError,
  onToolCall,
}: UseVoiceConversationOptions) => {
  const [state, setState] = useState<VoiceConversationState>(INITIAL_STATE);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const connectedRef = useRef(false);
  const explicitDisconnectRef = useRef(false);
  const userTranscriptRef = useRef('');
  const responseTranscriptRef = useRef('');
  const handledToolCallsRef = useRef(new Set<string>());
  const responseActiveRef = useRef(false);
  const responseCreatePendingRef = useRef(false);
  const activeBuildSessionIdRef = useRef(sessionId);
  const memorySessionIdRef = useRef(memorySessionId);

  const systemPromptRef = useRef(systemPrompt);
  const voiceRef = useRef(voice);
  const reasoningEffortRef = useRef(reasoningEffort);
  const languageRef = useRef(language);
  const onTranscriptRef = useRef(onTranscript);
  const onAgentResponseRef = useRef(onAgentResponse);
  const onErrorRef = useRef(onError);
  const onToolCallRef = useRef(onToolCall);

  systemPromptRef.current = systemPrompt;
  voiceRef.current = voice;
  reasoningEffortRef.current = reasoningEffort;
  languageRef.current = language;
  onTranscriptRef.current = onTranscript;
  onAgentResponseRef.current = onAgentResponse;
  onErrorRef.current = onError;
  onToolCallRef.current = onToolCall;
  activeBuildSessionIdRef.current = sessionId;
  memorySessionIdRef.current = memorySessionId;

  const sendEvent = useCallback((event: Record<string, unknown>): boolean => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== 'open') return false;
    channel.send(JSON.stringify(event));
    return true;
  }, []);

  const teardown = useCallback(() => {
    connectedRef.current = false;
    connectPromiseRef.current = null;

    if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
    if (transcriptFlushTimerRef.current) clearTimeout(transcriptFlushTimerRef.current);
    if (responseFlushTimerRef.current) clearTimeout(responseFlushTimerRef.current);
    audioLevelTimerRef.current = null;
    transcriptFlushTimerRef.current = null;
    responseFlushTimerRef.current = null;

    const channel = dataChannelRef.current;
    dataChannelRef.current = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      if (channel.readyState !== 'closed') channel.close();
    }

    const peer = peerConnectionRef.current;
    peerConnectionRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }

    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;

    const remoteAudio = remoteAudioRef.current;
    remoteAudioRef.current = null;
    if (remoteAudio) {
      remoteAudio.pause();
      remoteAudio.srcObject = null;
      remoteAudio.remove();
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();

    userTranscriptRef.current = '';
    responseTranscriptRef.current = '';
    handledToolCallsRef.current.clear();
    responseActiveRef.current = false;
    responseCreatePendingRef.current = false;
  }, []);

  const reportError = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      isConnecting: false,
      error: message,
    }));
    onErrorRef.current?.(message);
  }, []);

  const flushUserTranscript = useCallback((isFinal: boolean) => {
    if (transcriptFlushTimerRef.current) clearTimeout(transcriptFlushTimerRef.current);
    transcriptFlushTimerRef.current = null;
    const text = userTranscriptRef.current.trim();
    if (!text) return;
    setState((current) => current.currentTranscript === text
      ? current
      : { ...current, currentTranscript: text });
    onTranscriptRef.current?.(text, isFinal);
    if (isFinal) logVoiceRouting('transcript.completed', { text });
  }, []);

  const flushAgentResponse = useCallback((isFinal = false) => {
    if (responseFlushTimerRef.current) clearTimeout(responseFlushTimerRef.current);
    responseFlushTimerRef.current = null;
    const text = responseTranscriptRef.current.trim();
    if (text) onAgentResponseRef.current?.(text, isFinal);
  }, []);

  // Realtime accepts only one active response per conversation. Reserve the
  // slot synchronously (before response.created arrives) and coalesce any
  // tool continuation or proactive announcement that races the active turn.
  const requestResponse = useCallback((): boolean => {
    if (responseActiveRef.current) {
      responseCreatePendingRef.current = true;
      logVoiceRouting('response.create.deferred', { reason: 'active_response' });
      return true;
    }
    responseActiveRef.current = true;
    const sent = sendEvent({ type: 'response.create' });
    if (!sent) responseActiveRef.current = false;
    else logVoiceRouting('response.create.sent');
    return sent;
  }, [sendEvent]);

  const handleToolCall = useCallback(async (item: NonNullable<RealtimeServerEvent['item']>) => {
    const callId = item.call_id;
    const toolName = item.name;
    if (!callId || !toolName || handledToolCallsRef.current.has(callId)) return;
    handledToolCallsRef.current.add(callId);

    let parameters: Record<string, unknown> = {};
    try {
      parameters = item.arguments ? JSON.parse(item.arguments) as Record<string, unknown> : {};
    } catch {
      parameters = {};
    }
    logVoiceRouting('tool.request', { callId, toolName, parameters });

    let result: ToolCallResult;
    let isError = false;
    try {
      if (!onToolCallRef.current) throw new Error(`No handler registered for ${toolName}.`);
      result = await onToolCallRef.current({
        toolCallId: callId,
        toolName,
        parameters,
      });
    } catch (error) {
      isError = true;
      result = error instanceof Error ? error.message : 'Build tool call failed.';
    }

    const output = typeof result === 'string' ? result : result.output;
    logVoiceRouting(isError ? 'tool.error' : 'tool.result', {
      callId,
      toolName,
      output,
    });
    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: !isError, result: output }),
      },
    });
    if (!isError && typeof result !== 'string') {
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: result.inputImageDataUrl,
          }],
        },
      });
    }
    requestResponse();
  }, [requestResponse, sendEvent]);

  const handleServerEvent = useCallback((event: RealtimeServerEvent) => {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        setState((current) => ({ ...current, isUserSpeaking: true, isSpeaking: false }));
        break;
      case 'input_audio_buffer.speech_stopped':
        // Semantic VAD has create_response enabled, so reserve the response
        // slot during the short gap before response.created is delivered.
        responseActiveRef.current = true;
        setState((current) => ({ ...current, isUserSpeaking: false }));
        break;
      case 'conversation.item.input_audio_transcription.delta':
        userTranscriptRef.current += event.delta || '';
        if (!transcriptFlushTimerRef.current) {
          transcriptFlushTimerRef.current = setTimeout(() => flushUserTranscript(false), EVENT_FLUSH_MS);
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) userTranscriptRef.current = event.transcript;
        flushUserTranscript(true);
        userTranscriptRef.current = '';
        break;
      case 'response.created':
        responseActiveRef.current = true;
        responseTranscriptRef.current = '';
        setState((current) => ({ ...current, isSpeaking: true, error: null }));
        break;
      case 'output_audio_buffer.started':
        setState((current) => ({ ...current, isSpeaking: true }));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        responseTranscriptRef.current += event.delta || '';
        if (!responseFlushTimerRef.current) {
          responseFlushTimerRef.current = setTimeout(() => flushAgentResponse(false), EVENT_FLUSH_MS);
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
        if (event.transcript) responseTranscriptRef.current = event.transcript;
        flushAgentResponse(true);
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'function_call') void handleToolCall(event.item);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        setState((current) => ({ ...current, isSpeaking: false }));
        break;
      case 'response.done': {
        responseActiveRef.current = false;
        setState((current) => ({ ...current, isSpeaking: false, error: null }));
        if (responseCreatePendingRef.current) {
          responseCreatePendingRef.current = false;
          queueMicrotask(requestResponse);
        }
        break;
      }
      case 'error': {
        const code = event.error?.code || '';
        if (code === 'response_cancel_not_active') break;
        if (code === 'conversation_already_has_active_response') {
          responseCreatePendingRef.current = true;
          logVoiceRouting('response.create.deferred', { reason: code });
          break;
        }
        reportError(event.error?.message || 'OpenAI Realtime returned an error.');
        break;
      }
      default:
        break;
    }
  }, [flushAgentResponse, flushUserTranscript, handleToolCall, reportError, requestResponse]);

  const startAudioLevelMeter = useCallback((stream: MediaStream) => {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    const samples = new Uint8Array(analyser.fftSize);
    let previousLevel = 0;

    audioLevelTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const level = Math.min(1, Math.sqrt(sumSquares / samples.length) * 4);
      if (Math.abs(level - previousLevel) < 0.04 && level > 0.02) return;
      previousLevel = level;
      setState((current) => ({ ...current, audioLevel: level }));
    }, 200);
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    if (connectedRef.current) return;
    if (connectPromiseRef.current) return connectPromiseRef.current;

    explicitDisconnectRef.current = false;
    const connectPromise = (async () => {
      setState((current) => ({ ...current, isConnecting: true, error: null }));

      try {
        if (window.electronAPI?.audio?.checkMicrophonePermission) {
          const permission = await window.electronAPI.audio.checkMicrophonePermission();
          if (!permission.granted) {
            if (!permission.canRequest) {
              throw new Error('Microphone access is disabled. Enable it in System Settings > Privacy & Security > Microphone.');
            }
            const requested = await window.electronAPI.audio.requestMicrophonePermission();
            if (!requested.granted) throw new Error(requested.error || 'Microphone access was not granted.');
          }
        }

        const secret = await window.electronAPI.voice.createRealtimeSession({
          sessionId: activeBuildSessionIdRef.current,
          memorySessionId: memorySessionIdRef.current,
          instructions: systemPromptRef.current || '',
          voice: voiceRef.current,
          reasoningEffort: reasoningEffortRef.current,
          language: languageRef.current,
        });
        if (!secret.success || !secret.clientSecret) {
          throw new Error(secret.error || 'OpenAI Realtime did not return a client secret.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        microphoneStreamRef.current = stream;

        const peer = new RTCPeerConnection();
        peerConnectionRef.current = peer;
        stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

        const remoteAudio = document.createElement('audio');
        remoteAudio.autoplay = true;
        remoteAudio.setAttribute('aria-hidden', 'true');
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
        remoteAudioRef.current = remoteAudio;
        peer.ontrack = ({ streams }) => {
          remoteAudio.srcObject = streams[0];
          void remoteAudio.play().catch(() => undefined);
        };

        const channel = peer.createDataChannel('oai-events');
        dataChannelRef.current = channel;
        channel.onmessage = (message) => {
          try {
            handleServerEvent(JSON.parse(String(message.data)) as RealtimeServerEvent);
          } catch {
            // Ignore malformed diagnostic events without destabilizing audio.
          }
        };

        const opened = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('OpenAI Realtime data channel timed out.')), 15_000);
          channel.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };
          channel.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('OpenAI Realtime data channel failed.'));
          };
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), 15_000);
        const answerResponse = await fetch(REALTIME_CALLS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
          signal: abortController.signal,
        });
        clearTimeout(abortTimer);
        if (!answerResponse.ok) {
          const detail = (await answerResponse.text()).slice(0, 300);
          throw new Error(`OpenAI Realtime WebRTC handshake failed (${answerResponse.status})${detail ? `: ${detail}` : ''}`);
        }

        await peer.setRemoteDescription({ type: 'answer', sdp: await answerResponse.text() });
        await opened;

        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed') {
            const wasConnected = connectedRef.current;
            teardown();
            setState((current) => ({ ...current, isConnected: false, isConnecting: false, isRecording: false, isSpeaking: false }));
            if (wasConnected && !explicitDisconnectRef.current) reportError('OpenAI Realtime voice connection was lost.');
          }
        };

        connectedRef.current = true;
        startAudioLevelMeter(stream);
        setState((current) => ({
          ...current,
          isConnected: true,
          isConnecting: false,
          isRecording: true,
          error: null,
        }));
      } catch (error) {
        teardown();
        const message = error instanceof Error ? error.message : 'Failed to connect OpenAI Realtime voice.';
        reportError(message);
        throw error;
      } finally {
        connectPromiseRef.current = null;
      }
    })();

    connectPromiseRef.current = connectPromise;
    return connectPromise;
  }, [handleServerEvent, reportError, startAudioLevelMeter, teardown]);

  const startRecording = useCallback(async () => {
    microphoneStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = true; });
    setState((current) => ({ ...current, isRecording: connectedRef.current }));
  }, []);

  const stopRecording = useCallback(async () => {
    microphoneStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
    setState((current) => ({ ...current, isRecording: false, isUserSpeaking: false }));
  }, []);

  const disconnect = useCallback(async () => {
    explicitDisconnectRef.current = true;
    teardown();
    setState(INITIAL_STATE);
  }, [teardown]);

  const updateContext = useCallback(async (context: string) => {
    const normalized = context.trim().slice(-6_000);
    if (!normalized) return;
    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `[BUILD CONTEXT UPDATE — background data, do not respond unless the user asks or the update requires user action]\n${normalized}`,
        }],
      },
    });
  }, [sendEvent]);

  const speak = useCallback(async (instruction: string) => {
    if (!instruction.trim()) return;
    const created = sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[BUILD VOICE ANNOUNCEMENT]\n${instruction.trim()}` }],
      },
    });
    if (created) requestResponse();
  }, [requestResponse, sendEvent]);

  useEffect(() => () => teardown(), [teardown]);

  return {
    ...state,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    speak,
    updateContext,
  };
};
