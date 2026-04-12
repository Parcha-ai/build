import React, { useCallback, useEffect, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Volume2, Loader2 } from 'lucide-react';
import { useVoiceConversationSDK } from '../../hooks/useVoiceConversationSDK';
import { useSessionStore } from '../../stores/session.store';

interface VoiceModeProps {
  sessionId: string;
  agentId: string;
  onTranscript: (text: string) => void;
  onClaudeResponse: (text: string) => void;
  disabled?: boolean;
}

/**
 * Voice Mode Component
 *
 * Provides a voice conversation interface using ElevenLabs Conversational AI.
 * Uses the official @elevenlabs/client SDK with WebRTC for built-in echo cancellation.
 */
export const VoiceMode: React.FC<VoiceModeProps> = ({
  sessionId,
  agentId,
  onTranscript,
  onClaudeResponse,
  disabled = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    isConnected,
    isConnecting,
    isRecording,
    isSpeaking,
    currentTranscript,
    error,
    audioLevel,
    connect,
    disconnect,
    startRecording,
    stopRecording,
  } = useVoiceConversationSDK({
    agentId,
    sessionId,
    systemPrompt: `You are Build, an AI development assistant.
When the user speaks, process their request and help them with code, debugging, and development tasks.
Keep responses concise and conversational.

IMPORTANT: When you receive [THINKING] updates, narrate them out loud to keep the user informed.
These show your internal reasoning process. Speak them naturally as if you're thinking out loud -
for example: "Hmm, let me check the authentication flow..." or "I'm searching for the relevant files now...".
This keeps the conversation flowing and the user engaged while you work.`,
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        onTranscript(text);
      }
    },
    onClaudeResponse,
    onError: (error) => {
      console.error('Voice mode error:', error);
    },
  });

  const handleToggleConnection = useCallback(async () => {
    if (isConnected) {
      await disconnect();
      setIsExpanded(false);
    } else {
      await connect();
      setIsExpanded(true);
    }
  }, [isConnected, connect, disconnect]);

  const handleToggleRecording = useCallback(async () => {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Compact button when not expanded
  if (!isExpanded && !isConnected) {
    return (
      <button
        onClick={handleToggleConnection}
        disabled={disabled || isConnecting}
        className={`
          p-1.5 transition-all duration-200
          ${isConnecting
            ? 'text-yellow-500'
            : 'text-claude-text-secondary hover:text-claude-accent'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        title="Start Voice Mode"
      >
        {isConnecting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Phone className="w-4 h-4" />
        )}
      </button>
    );
  }

  // Expanded voice mode UI when connected
  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-claude-surface/50 border border-claude-border">
      {/* Connection status indicator */}
      <div className="flex items-center gap-1">
        <div
          className={`w-2 h-2 rounded-full ${
            isConnected ? 'bg-green-500' : isConnecting ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
          }`}
        />
        <span className="text-[10px] font-mono text-claude-text-secondary uppercase">
          {isConnected ? 'VOICE' : isConnecting ? 'CONNECTING' : 'OFFLINE'}
        </span>
      </div>

      {/* Recording/Speaking indicators */}
      {isConnected && (
        <>
          {/* Speaking indicator */}
          {isSpeaking && (
            <div className="flex items-center gap-1 text-blue-400">
              <Volume2 className="w-3 h-3 animate-pulse" />
              <span className="text-[10px] font-mono">SPEAKING</span>
            </div>
          )}

          {/* Recording button */}
          <button
            onClick={handleToggleRecording}
            className={`
              p-1 transition-all duration-200
              ${isRecording
                ? 'text-red-500 hover:text-red-400'
                : 'text-claude-text-secondary hover:text-claude-accent'}
            `}
            title={isRecording ? 'Stop Recording' : 'Start Recording'}
          >
            {isRecording ? (
              <div className="relative">
                <MicOff className="w-4 h-4" />
                <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
              </div>
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </button>

          {/* Current transcript preview */}
          {currentTranscript && (
            <div className="flex-1 max-w-[200px] overflow-hidden">
              <span className="text-[10px] font-mono text-claude-text-secondary truncate block italic">
                "{currentTranscript}"
              </span>
            </div>
          )}
        </>
      )}

      {/* Disconnect button */}
      <button
        onClick={handleToggleConnection}
        className="p-1 text-claude-text-secondary hover:text-red-400 transition-colors"
        title="End Voice Mode"
      >
        <PhoneOff className="w-4 h-4" />
      </button>

      {/* Error display */}
      {error && (
        <span className="text-[10px] font-mono text-red-400 truncate max-w-[100px]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
};

export default VoiceMode;
