import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type Mode, type Status, type Callbacks } from '@elevenlabs/client';

interface ToolCall {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

interface UseVoiceConversationOptions {
  agentId: string;
  sessionId: string;
  systemPrompt?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onClaudeResponse?: (text: string) => void;
  onError?: (error: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<string>;
}

interface VoiceConversationState {
  isConnected: boolean;
  isConnecting: boolean;
  isRecording: boolean;
  isSpeaking: boolean;
  currentTranscript: string;
  error: string | null;
  audioLevel: number;
}

/**
 * Hook for ElevenLabs Conversational AI voice mode using the official SDK
 *
 * This version uses @elevenlabs/client with WebRTC for:
 * - Built-in hardware-level echo cancellation
 * - Proper mode change detection (speaking/listening)
 * - Official SDK maintenance and updates
 */
export const useVoiceConversationSDK = ({
  agentId,
  sessionId,
  systemPrompt,
  onTranscript,
  onClaudeResponse,
  onError,
  onToolCall,
}: UseVoiceConversationOptions) => {
  const [state, setState] = useState<VoiceConversationState>({
    isConnected: false,
    isConnecting: false,
    isRecording: false,
    isSpeaking: false,
    currentTranscript: '',
    error: null,
    audioLevel: 0,
  });

  // Single conversation instance — only one WebRTC connection at a time.
  // Multiple simultaneous WebRTC connections share one mic and cause chaos.
  const conversationRef = useRef<Conversation | null>(null);
  const isConnectedRef = useRef(false);

  // Track which sessions had voice active — auto-reconnect when switching back
  const voiceActiveSessionsRef = useRef<Set<string>>(new Set());

  // Refs for callbacks to avoid stale closures
  const onTranscriptRef = useRef(onTranscript);
  const onClaudeResponseRef = useRef(onClaudeResponse);
  const onErrorRef = useRef(onError);
  const onToolCallRef = useRef(onToolCall);

  // Keep refs updated
  onTranscriptRef.current = onTranscript;
  onClaudeResponseRef.current = onClaudeResponse;
  onErrorRef.current = onError;
  onToolCallRef.current = onToolCall;

  // Audio level polling interval
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null);

  
  /**
   * Connect to ElevenLabs and start voice mode using the official SDK
   */
  const connect = useCallback(async () => {
    try {
      setState(s => ({ ...s, isConnecting: true, error: null }));

      // On macOS, check and request microphone permission first
      if (window.electronAPI?.audio?.checkMicrophonePermission) {
        const permStatus = await window.electronAPI.audio.checkMicrophonePermission();
        console.log('[VoiceConversationSDK] Microphone permission status:', permStatus);

        if (!permStatus.granted) {
          if (permStatus.canRequest) {
            console.log('[VoiceConversationSDK] Requesting microphone permission...');
            const result = await window.electronAPI.audio.requestMicrophonePermission();
            if (!result.granted) {
              const errorMsg = result.error || 'Microphone access denied';
              console.error('[VoiceConversationSDK] Microphone permission denied:', errorMsg);
              setState(s => ({ ...s, isConnecting: false, error: errorMsg }));
              onErrorRef.current?.(errorMsg);
              return;
            }
            console.log('[VoiceConversationSDK] Microphone permission granted');
          } else {
            const errorMsg = 'Microphone access denied. Please enable it in System Settings > Privacy & Security > Microphone.';
            console.error('[VoiceConversationSDK]', errorMsg);
            setState(s => ({ ...s, isConnecting: false, error: errorMsg }));
            onErrorRef.current?.(errorMsg);
            return;
          }
        }
      }

      // Get conversation token from main process (which has the API key)
      // NOTE: SDK will handle getUserMedia() internally - don't call it twice!
      // Use conversation token + WebRTC for hardware echo cancellation
      console.log('[VoiceConversationSDK] Requesting conversation token for WebRTC...');
      const tokenResult = await window.electronAPI.voice.getConversationToken({ agentId });
      console.log('[VoiceConversationSDK] Token result:', { success: tokenResult.success, hasToken: !!tokenResult.conversationToken, error: tokenResult.error });

      if (!tokenResult.success || !tokenResult.conversationToken) {
        throw new Error(tokenResult.error || 'Failed to get conversation token');
      }

      console.log('[VoiceConversationSDK] Got token, starting WebRTC session...', 'token length:', tokenResult.conversationToken?.length);

      // Build client tools if onToolCall is provided
      const clientTools: Record<string, (params: unknown) => Promise<string>> = {};
      if (onToolCallRef.current) {
        // We'll handle unhandled tool calls via the callback
      }

      // Start session with the official SDK
      // NOTE: Back to WebRTC mode - will catch errors defensively
      const conversation = await Conversation.startSession({
        conversationToken: tokenResult.conversationToken,
        connectionType: 'webrtc',
        clientTools,

        // Callbacks
        onConnect: ({ conversationId }) => {
          console.log('[VoiceConversationSDK] Connected, conversationId:', conversationId);
          isConnectedRef.current = true;
          voiceActiveSessionsRef.current.add(sessionId);
          setState(s => ({ ...s, isConnected: true, isConnecting: false }));
        },

        onDisconnect: (details) => {
          console.log('[VoiceConversationSDK] Disconnected:', details);
          isConnectedRef.current = false;
          setState(s => ({ ...s, isConnected: false, isRecording: false, isSpeaking: false }));

          // Clear audio level polling
          if (audioLevelIntervalRef.current) {
            clearInterval(audioLevelIntervalRef.current);
            audioLevelIntervalRef.current = null;
          }
        },

        onError: (message, context) => {
          try {
            console.error('[VoiceConversationSDK] Error:', message, context);
            const errorMessage = typeof message === 'string' ? message : 'Voice mode error';
            setState(s => ({ ...s, error: errorMessage }));
            onErrorRef.current?.(errorMessage);
          } catch (e) {
            // Defensive: SDK's error handler itself can crash if error object is malformed
            console.error('[VoiceConversationSDK] Error handling error:', e);
            const fallbackMessage = 'Voice mode encountered an error';
            setState(s => ({ ...s, error: fallbackMessage }));
            onErrorRef.current?.(fallbackMessage);
          }
        },

        onMessage: ({ message, role }) => {
          console.log('[VoiceConversationSDK] Message from', role, ':', message.slice(0, 100));

          if (role === 'user') {
            // User transcription
            setState(s => ({ ...s, currentTranscript: message }));
            // Final transcriptions are sent here
            onTranscriptRef.current?.(message, true);
          } else if (role === 'agent') {
            // Agent response
            onClaudeResponseRef.current?.(message);
          }
        },

        onModeChange: ({ mode }) => {
          console.log('[VoiceConversationSDK] Mode changed to:', mode);
          // 'speaking' = agent is talking, 'listening' = waiting for user
          setState(s => ({ ...s, isSpeaking: mode === 'speaking' }));
        },

        onStatusChange: ({ status }) => {
          console.log('[VoiceConversationSDK] Status changed to:', status);
          setState(s => ({
            ...s,
            isConnecting: status === 'connecting',
            isConnected: status === 'connected',
          }));
        },

        onInterruption: (props) => {
          console.log('[VoiceConversationSDK] Interruption:', props);
        },

        onUnhandledClientToolCall: async (toolCall) => {
          console.log('[VoiceConversationSDK] Unhandled tool call:', toolCall);
          if (onToolCallRef.current) {
            try {
              const result = await onToolCallRef.current({
                toolCallId: toolCall.tool_call_id,
                toolName: toolCall.tool_name,
                parameters: toolCall.parameters as Record<string, unknown>,
              });
              console.log('[VoiceConversationSDK] Tool result:', result);
              // Return the result to the SDK so the agent receives it
              return result;
            } catch (error) {
              console.error('[VoiceConversationSDK] Tool call error:', error);
              return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            }
          }
          return 'No handler for this tool call';
        },
      });

      conversationRef.current = conversation;

      // Patch SDK's handleErrorEvent to handle malformed error events (e.g., quota errors)
      try {
        const proto = Object.getPrototypeOf(conversation);
        if (proto && typeof proto.handleErrorEvent === 'function') {
          const original = proto.handleErrorEvent.bind(conversation);
          proto.handleErrorEvent = function(event: any) {
            try {
              return original(event);
            } catch (e) {
              // SDK crashed trying to handle error - extract the real error message
              const errorMessage = event?.message || 'Voice mode error occurred';
              console.error('[VoiceConversationSDK] SDK handleErrorEvent crashed:', e);
              console.error('[VoiceConversationSDK] Real error from server:', errorMessage);

              // Check for quota errors
              if (errorMessage.includes('quota limit') || errorMessage.includes('exceeds your quota')) {
                const quotaError = 'ElevenLabs quota exceeded. Please check your usage at elevenlabs.io/app/usage';
                setState(s => ({ ...s, error: quotaError }));
                onErrorRef.current?.(quotaError);
              } else {
                // Generic error handling
                setState(s => ({ ...s, error: errorMessage }));
                onErrorRef.current?.(errorMessage);
              }

              // Disconnect to prevent further issues
              conversation.endSession?.();
            }
          };
        }
      } catch (e) {
        console.warn('[VoiceConversationSDK] Could not patch handleErrorEvent:', e);
      }

      // Start audio level polling
      audioLevelIntervalRef.current = setInterval(() => {
        if (conversationRef.current && isConnectedRef.current) {
          try {
            const level = conversationRef.current.getInputVolume();
            setState(s => ({ ...s, audioLevel: level }));
          } catch {
            // Ignore errors if conversation is being torn down
          }
        }
      }, 100);

      // Mark as recording since the SDK handles mic capture
      setState(s => ({ ...s, isRecording: true }));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect';
      console.error('[VoiceConversationSDK] Connect error:', error);
      setState(s => ({ ...s, isConnecting: false, error: errorMessage }));
      onErrorRef.current?.(errorMessage);
    }
  }, [agentId]);

  /**
   * Start recording - with the SDK, this is handled automatically
   * This is a no-op since the SDK captures audio from connection start
   */
  const startRecording = useCallback(async () => {
    if (!conversationRef.current || !isConnectedRef.current) {
      console.warn('[VoiceConversationSDK] Not connected');
      return;
    }

    // Unmute the microphone if it was muted
    conversationRef.current.setMicMuted(false);
    setState(s => ({ ...s, isRecording: true }));
  }, []);

  /**
   * Stop recording - mutes the microphone
   */
  const stopRecording = useCallback(async () => {
    if (!conversationRef.current) {
      return;
    }

    // Mute the microphone
    conversationRef.current.setMicMuted(true);
    setState(s => ({ ...s, isRecording: false }));
  }, []);

  /**
   * Disconnect from voice mode
   */
  const disconnect = useCallback(async () => {
    // Clear audio level polling
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }

    if (conversationRef.current) {
      await conversationRef.current.endSession();
      conversationRef.current = null;
    }

    // Explicit disconnect — remove from auto-reconnect set
    voiceActiveSessionsRef.current.delete(sessionId);

    isConnectedRef.current = false;
    setState({
      isConnected: false,
      isConnecting: false,
      isRecording: false,
      isSpeaking: false,
      currentTranscript: '',
      error: null,
      audioLevel: 0,
    });
  }, [sessionId]);

  /**
   * Send text for TTS (to speak Claude's response)
   * Note: With the SDK, this sends a user message - the agent may respond
   */
  const speak = useCallback(async (text: string) => {
    if (!conversationRef.current || !isConnectedRef.current) {
      console.warn('[VoiceConversationSDK] Not connected');
      return;
    }

    // Use sendUserMessage to inject text into the conversation
    conversationRef.current.sendUserMessage(text);
  }, []);

  /**
   * Send context update (inform agent of state changes)
   * Now safe to use since we patched the SDK's error handler
   */
  const updateContext = useCallback(async (context: string) => {
    if (!conversationRef.current || !isConnectedRef.current) {
      console.warn('[VoiceConversationSDK] Not connected');
      return;
    }

    try {
      // Send contextual update to inform the agent about session state
      conversationRef.current.sendContextualUpdate?.(context);
      console.log('[VoiceConversationSDK] Sent context update:', context.slice(0, 100));
    } catch (e) {
      console.error('[VoiceConversationSDK] Failed to send context update:', e);
    }
  }, []);

  /**
   * Send user activity signal
   */
  const sendUserActivity = useCallback(() => {
    if (!conversationRef.current || !isConnectedRef.current) {
      return;
    }

    conversationRef.current.sendUserActivity();
  }, []);

  // Track previous sessionId to detect session switches
  const previousSessionIdRef = useRef(sessionId);

  // On session switch: disconnect current conversation, auto-reconnect if
  // the new session previously had voice active.
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      const oldId = previousSessionIdRef.current;
      console.log('[VoiceConversationSDK] Session switch:', oldId, '→', sessionId);

      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current);
        audioLevelIntervalRef.current = null;
      }

      if (conversationRef.current) {
        conversationRef.current.endSession();
        conversationRef.current = null;
      }

      isConnectedRef.current = false;
      setState({
        isConnected: false,
        isConnecting: false,
        isRecording: false,
        isSpeaking: false,
        currentTranscript: '',
        error: null,
        audioLevel: 0,
      });

      // Auto-reconnect if the new session previously had voice on
      if (voiceActiveSessionsRef.current.has(sessionId)) {
        console.log('[VoiceConversationSDK] Auto-reconnecting voice for session', sessionId);
        // Small delay to let the disconnect settle before reconnecting
        setTimeout(() => {
          connect();
        }, 300);
      }
    }
    previousSessionIdRef.current = sessionId;
  }, [sessionId, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current);
      }
      if (conversationRef.current) {
        conversationRef.current.endSession();
        conversationRef.current = null;
      }
    };
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
  };
};
