import React, { useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Headphones, Loader2 } from 'lucide-react';
import { useVoiceConversationSDK } from '../../hooks/useVoiceConversationSDK';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';

// Stable empty array references outside component to prevent infinite re-renders
const EMPTY_MESSAGES: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];

interface VoiceAgentButtonProps {
  sessionId: string;
  onTranscriptionComplete?: (text: string) => void;
  disabled?: boolean;
}

// Imperative handle for voice agent control from InputArea
export interface VoiceAgentHandle {
  startPushToTalk: () => Promise<void>;
  stopPushToTalk: () => Promise<void>;
  toggleVoiceMode: () => Promise<void>;
  disconnectVoiceMode: () => Promise<void>;
  isConnected: boolean;
}

/**
 * Voice Agent Button - Toggles ElevenLabs Conversational AI Voice Mode
 *
 * Click: Toggle voice agent on/off
 * When on, the InputArea shows voice mode UI with wave visualization
 *
 * Requires ElevenLabs API key + Agent ID configured in Settings.
 */
export const VoiceAgentButton = forwardRef<VoiceAgentHandle, VoiceAgentButtonProps>(({
  sessionId,
  onTranscriptionComplete,
  disabled = false,
}, ref) => {
  const {
    settings: audioSettings,
    voiceModeStates,
    setVoiceModeConnecting,
    setVoiceModeConnected,
    setVoiceModeDisconnected,
    setVoiceModeSpeaking,
    setVoiceModeUserSpeaking,
    setVoiceModeAudioLevel,
    setVoiceModeTranscript,
    setVoiceModeAgentResponse,
    setVoiceModeError,
    setAudioMode,
  } = useAudioStore();

  const agentId = audioSettings?.elevenLabsAgentId;
  const apiKey = audioSettings?.elevenLabsApiKey;
  const isConfigured = Boolean(agentId) && Boolean(apiKey);
  const voiceState = voiceModeStates[sessionId];
  const isConnected = voiceState?.isConnected || false;
  const isConnecting = voiceState?.isConnecting || false;

  // Get session context for ElevenLabs agent
  const messages = useSessionStore((state) => state.messages[sessionId]) || EMPTY_MESSAGES;
  const session = useSessionStore((state) => state.sessions.find(s => s.id === sessionId));
  const isStreaming = useSessionStore((state) => !!state.isStreaming[sessionId]);

  // Subscribe to thinking content and assistant text for incremental updates
  const currentThinkingContent = useSessionStore((state) => state.currentThinkingContent[sessionId] || '');
  const currentToolCalls = useSessionStore((state) => state.currentToolCalls[sessionId] || EMPTY_TOOL_CALLS);
  const pendingPermission = useSessionStore((state) => state.pendingPermission[sessionId]);

  // Generate context summary for ElevenLabs agent
  const generateContextSummary = useCallback((isInitial = false) => {
    const contextMessages = isInitial
      ? (messages.length > 50 ? messages.slice(-50) : messages)
      : messages.slice(-5);

    const messageSummary = contextMessages
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const maxLength = isInitial ? 300 : 150;
        return `${m.role}: ${content.slice(0, maxLength)}${content.length > maxLength ? '...' : ''}`;
      })
      .join('\n');

    const projectName = session?.repoPath?.split('/').pop() || session?.name || 'unknown project';

    if (isInitial) {
      return `INITIAL SESSION CONTEXT:
You are now connected as the voice assistant for Build (an AI coding tool).

PROJECT: ${projectName}
WORKING DIRECTORY: ${session?.repoPath || 'unknown'}
BRANCH: ${session?.branch || 'main'}
STATUS: ${isStreaming ? 'Build is currently working on a task' : 'Build is idle, ready for instructions'}

FULL CONVERSATION HISTORY (${contextMessages.length} messages):
${messageSummary || 'No conversation yet - this is a fresh session'}

IMPORTANT: Claude Code already has ALL of this context. Do NOT repeat analysis or work that's already been done.
Your role is to:
1. Understand what's already been discussed
2. Help the user communicate new requests to Claude Code
3. Report on Claude Code's progress when asked

You should greet the user briefly and ask how you can help with their coding work on ${projectName}.`;
    }

    return `Current Build Session Context:
- Working directory: ${session?.repoPath || 'unknown'}
- Branch: ${session?.branch || 'unknown'}
- Session state: ${isStreaming ? 'Currently working on a task' : 'Idle, waiting for input'}
- Recent conversation:
${messageSummary || 'No messages yet'}`;
  }, [messages, session, isStreaming]);

  const {
    isConnected: hookConnected,
    isConnecting: hookConnecting,
    isSpeaking,
    audioLevel,
    currentTranscript,
    error,
    connect,
    disconnect,
    startRecording,
    updateContext,
    speak,
    sendUserActivity,
  } = useVoiceConversationSDK({
    agentId: agentId || '',
    sessionId,
    onTranscript: (text, isFinal) => {
      setVoiceModeTranscript(sessionId, text);
      setVoiceModeUserSpeaking(sessionId, !isFinal && text.length > 0);
      if (isFinal && text.trim()) {
        console.log('[VoiceAgentButton] Final transcript received, waiting for tool call:', text.slice(0, 50));
      }
    },
    onClaudeResponse: (text) => {
      setVoiceModeAgentResponse(sessionId, text);
      console.log('[VoiceAgentButton] Agent response:', text.slice(0, 50));
    },
    onError: (error) => {
      console.error('[VoiceAgentButton] Voice error:', error);
      setVoiceModeError(sessionId, error);
    },
    onToolCall: async (toolCall) => {
      console.log('[VoiceAgentButton] Tool call received:', toolCall.toolName, toolCall.parameters);

      if (toolCall.toolName === 'execute_grep_command') {
        const instruction = toolCall.parameters.instruction as string;
        if (instruction) {
          console.log('[VoiceAgentButton] Executing Build command:', instruction.slice(0, 100));
          onTranscriptionComplete?.(instruction);
          return `TASK SUBMITTED. Build is now working on: "${instruction.slice(0, 50)}...". Call get_task_status every 5-10 seconds to check progress and announce what Build is doing.`;
        }
        return 'No instruction provided';
      }

      if (toolCall.toolName === 'get_task_status') {
        const currentState = useSessionStore.getState();
        const sessionIsStreaming = currentState.isStreaming[sessionId];
        const thinking = currentState.currentThinkingContent[sessionId] || '';
        const toolCalls = currentState.currentToolCalls[sessionId] || [];
        const sessionMessages = currentState.messages[sessionId] || [];

        const thinkingSentences = thinking.split(/[.!?]\s+/).filter(s => s.trim().length > 10);
        const latestThinking = thinkingSentences.length > 0 ? thinkingSentences[thinkingSentences.length - 1].slice(0, 100) : '';

        if (sessionIsStreaming) {
          const recentToolCalls = toolCalls.slice(-3).map(tc => ({
            tool: tc.name,
            input: tc.input,
          }));

          return JSON.stringify({
            status: 'working',
            toolCallCount: toolCalls.length,
            recentToolCalls: recentToolCalls,
            latestThought: latestThinking,
          });
        } else {
          const lastMessage = sessionMessages[sessionMessages.length - 1];
          let completionContent = '';
          if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
            completionContent = lastMessage.content.slice(0, 500);
          }

          return JSON.stringify({
            status: 'complete',
            completionContent: completionContent,
          });
        }
      }

      return `Unknown tool: ${toolCall.toolName}`;
    },
  });

  // Expose imperative handle for voice agent control from InputArea
  useImperativeHandle(ref, () => ({
    startPushToTalk: async () => {
      console.log('[VoiceAgent] startPushToTalk called, isConnected:', hookConnected);
      if (!hookConnected && !hookConnecting) {
        try {
          setVoiceModeConnecting(sessionId);
          await connect();
          setTimeout(async () => {
            await startRecording();
          }, 100);
        } catch (e) {
          console.error('[VoiceAgent] Push-to-talk connect error:', e);
          setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
        }
      } else if (hookConnected) {
        await startRecording();
      }
    },
    stopPushToTalk: async () => {
      console.log('[VoiceAgent] stopPushToTalk called');
      await window.electronAPI.voice.endInput();
    },
    toggleVoiceMode: async () => {
      console.log('[VoiceAgent] toggleVoiceMode called, isConnected:', hookConnected);
      if (hookConnected) {
        await disconnect();
        setVoiceModeDisconnected(sessionId);
        setVoiceModeUserSpeaking(sessionId, false);
        setAudioMode(sessionId, false);
      } else if (!hookConnecting) {
        try {
          setVoiceModeConnecting(sessionId);
          await connect();
          setTimeout(async () => {
            await startRecording();
          }, 100);
        } catch (e) {
          console.error('[VoiceAgent] Toggle connect error:', e);
          setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
        }
      }
    },
    disconnectVoiceMode: async () => {
      console.log('[VoiceAgent] disconnectVoiceMode called');
      if (hookConnected) {
        await disconnect();
        setVoiceModeDisconnected(sessionId);
        setVoiceModeUserSpeaking(sessionId, false);
        setAudioMode(sessionId, false);
      }
    },
    isConnected: hookConnected,
  }), [hookConnected, hookConnecting, connect, disconnect, startRecording, sessionId,
      setVoiceModeConnecting, setVoiceModeDisconnected, setVoiceModeUserSpeaking, setVoiceModeError, setAudioMode]);

  // Sync hook state to store
  useEffect(() => {
    if (hookConnecting && !isConnecting) {
      setVoiceModeConnecting(sessionId);
    }
  }, [hookConnecting, isConnecting, sessionId, setVoiceModeConnecting]);

  useEffect(() => {
    if (hookConnected && !isConnected) {
      setVoiceModeConnected(sessionId);
      setAudioMode(sessionId, true);
    } else if (!hookConnected && isConnected) {
      setVoiceModeDisconnected(sessionId);
      setAudioMode(sessionId, false);
      setVoiceModeUserSpeaking(sessionId, false);
    }
  }, [hookConnected, isConnected, sessionId, setVoiceModeConnected, setVoiceModeDisconnected, setAudioMode, setVoiceModeUserSpeaking]);

  useEffect(() => {
    setVoiceModeSpeaking(sessionId, isSpeaking);
  }, [isSpeaking, sessionId, setVoiceModeSpeaking]);

  useEffect(() => {
    setVoiceModeAudioLevel(sessionId, audioLevel);
  }, [audioLevel, sessionId, setVoiceModeAudioLevel]);

  useEffect(() => {
    if (currentTranscript) {
      setVoiceModeTranscript(sessionId, currentTranscript);
    }
  }, [currentTranscript, sessionId, setVoiceModeTranscript]);

  useEffect(() => {
    if (error) {
      setVoiceModeError(sessionId, error);
    }
  }, [error, sessionId, setVoiceModeError]);

  // Ref to hold generateContextSummary to avoid dependency issues
  const generateContextRef = useRef(generateContextSummary);
  generateContextRef.current = generateContextSummary;

  // Send initial context when connected
  useEffect(() => {
    console.log('[VoiceAgentButton] Connection effect fired, hookConnected:', hookConnected);
    if (hookConnected) {
      const context = generateContextRef.current(true);
      console.log('[VoiceAgentButton] Sending initial context, preview:', context.slice(0, 200));
      updateContext(context);
    }
  }, [hookConnected]); // eslint-disable-line

  // Helper to summarize assistant response for voice announcements
  const summarizeForVoice = useCallback((content: unknown): string => {
    if (typeof content !== 'string') return 'Task completed';

    if (content.includes('Created') || content.includes('created')) {
      const match = content.match(/[Cc]reated?\s+(?:file\s+)?[`"]?([^`"\n]+)[`"]?/);
      if (match) return `Created ${match[1]}`;
    }
    if (content.includes('Updated') || content.includes('updated') || content.includes('Modified') || content.includes('modified')) {
      return 'Made the changes';
    }
    if (content.includes('Done') || content.includes('done') || content.includes('Complete') || content.includes('complete')) {
      return 'Done';
    }
    if (content.includes('Error') || content.includes('error') || content.includes('failed')) {
      return 'Encountered an issue';
    }

    const firstLine = content.split('\n')[0].slice(0, 100);
    return firstLine.length < content.length ? firstLine + '...' : firstLine;
  }, []);

  // Send context updates when messages change
  const prevMessagesLengthRef = useRef(messages.length);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    if (hookConnected && messages.length > 0 && messages.length !== prevMessagesLengthRef.current) {
      const lastMessage = messages[messages.length - 1];

      if (lastMessage?.role === 'assistant') {
        const summary = summarizeForVoice(lastMessage.content);
        console.log('[VoiceAgentButton] Build responded, sending progress update:', summary);

        if (!isStreaming && prevStreamingRef.current) {
          console.log('[VoiceAgentButton] Streaming ended, announcing completion');

          const completionData = JSON.stringify({
            type: 'task_complete',
            assistantResponse: typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 1000) : 'Task completed',
          });
          updateContext(completionData);

          if (!isSpeaking) {
            speak('Task complete. Give a brief summary.');
          }
        } else {
          updateContext(`Build progress: ${summary}\nStatus: Still working...`);
        }
      } else {
        console.log('[VoiceAgentButton] Messages changed, sending context update');
        const context = generateContextRef.current();
        console.log('[VoiceAgentButton] Context preview:', context.slice(0, 100));
        updateContext(context);
      }
    }
    prevMessagesLengthRef.current = messages.length;
    prevStreamingRef.current = isStreaming;
  }, [hookConnected, messages.length, isStreaming, summarizeForVoice, speak]); // eslint-disable-line

  // User activity signal ref for preventing "are you there?" prompts
  const activityIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (hookConnected && isStreaming) {
      sendUserActivity();
      console.log('[VoiceAgentButton] Sent initial user activity signal');

      activityIntervalRef.current = setInterval(() => {
        sendUserActivity();
        console.log('[VoiceAgentButton] Sent periodic user activity signal');
      }, 15000);
    } else {
      if (activityIntervalRef.current) {
        clearInterval(activityIntervalRef.current);
        activityIntervalRef.current = null;
      }
    }

    return () => {
      if (activityIntervalRef.current) {
        clearInterval(activityIntervalRef.current);
        activityIntervalRef.current = null;
      }
    };
  }, [hookConnected, isStreaming, sendUserActivity]);

  // Event-driven status updates - send tool changes as silent context
  const prevToolCallCountRef = useRef<number>(0);

  useEffect(() => {
    if (!hookConnected || !isStreaming) {
      prevToolCallCountRef.current = 0;
      return;
    }

    const currentCount = currentToolCalls.length;
    if (currentCount > prevToolCallCountRef.current && currentCount > 0) {
      const newTools = currentToolCalls.slice(prevToolCallCountRef.current);

      const rawToolData = newTools.map(tool => ({
        tool: tool.name,
        input: tool.input,
      }));

      const contextJson = JSON.stringify({
        type: 'tool_update',
        toolCalls: rawToolData,
        note: 'This is background context. Only mention if relevant and not already covered by thinking updates.',
      });

      console.log('[VoiceAgentButton] Tool update (silent context):', contextJson.slice(0, 200));
      updateContext(contextJson);
    }
    prevToolCallCountRef.current = currentCount;
  }, [hookConnected, isStreaming, currentToolCalls, updateContext]);

  // Announce permission requests vocally
  const prevPermissionRef = useRef<string | null>(null);
  const hadPendingPermissionRef = useRef<boolean>(false);

  useEffect(() => {
    if (!hookConnected) {
      prevPermissionRef.current = null;
      hadPendingPermissionRef.current = false;
      return;
    }

    if (hadPendingPermissionRef.current && !pendingPermission) {
      console.log('[VoiceAgentButton] Permission resolved, notifying agent');
      updateContext(JSON.stringify({ type: 'permission_resolved', status: 'approved' }));
      speak('Permission granted. Build is continuing.');
      hadPendingPermissionRef.current = false;
      prevPermissionRef.current = null;
      return;
    }

    if (!pendingPermission) {
      return;
    }

    hadPendingPermissionRef.current = true;

    const permissionId = pendingPermission.requestId;
    if (permissionId !== prevPermissionRef.current) {
      prevPermissionRef.current = permissionId;

      let announcement = 'Permission needed.';
      if (pendingPermission.toolName === 'Bash') {
        const command = pendingPermission.toolInput?.command as string;
        if (command) {
          const cmdPreview = command.split(/\s+/).slice(0, 3).join(' ');
          announcement = `Permission needed to run: ${cmdPreview}`;
        }
      } else {
        announcement = `Permission needed for ${pendingPermission.toolName}`;
      }

      console.log('[VoiceAgentButton] Permission request, announcing:', announcement);
      speak(`${announcement}. Tell me that Build needs permission to proceed.`);
    }
  }, [hookConnected, pendingPermission, speak, updateContext]);

  // Silent thinking context updates
  const prevThinkingContentRef = useRef<string>('');
  const lastContextUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (!hookConnected || !isStreaming || !currentThinkingContent) {
      if (!isStreaming) {
        prevThinkingContentRef.current = '';
        lastContextUpdateRef.current = 0;
      }
      return;
    }

    const now = Date.now();
    if (now - lastContextUpdateRef.current < 5000) {
      return;
    }

    const newContent = currentThinkingContent.slice(prevThinkingContentRef.current.length);
    if (newContent.length < 100) {
      return;
    }

    const sentences = currentThinkingContent.split(/[.!?]/).filter(s => s.trim().length > 10);
    const recentThinking = sentences.slice(-3).join('. ').slice(0, 500);

    if (recentThinking.length > 30) {
      const contextJson = JSON.stringify({
        type: 'thinking_update',
        thought: recentThinking,
        instruction: 'Only speak if you notice something significant: a discovery, a change in approach, or important progress. Stay quiet for routine work.',
      });

      console.log('[VoiceAgentButton] Silent thinking context update');
      updateContext(contextJson);

      prevThinkingContentRef.current = currentThinkingContent;
      lastContextUpdateRef.current = now;
    }
  }, [hookConnected, isStreaming, currentThinkingContent, updateContext]);

  const handleClick = useCallback(async () => {
    if (isConnected) {
      await disconnect();
      setVoiceModeDisconnected(sessionId);
      setVoiceModeUserSpeaking(sessionId, false);
      setAudioMode(sessionId, false);
    } else if (!isConnecting) {
      try {
        setVoiceModeConnecting(sessionId);
        await connect();
        setTimeout(async () => {
          await startRecording();
        }, 100);
      } catch (e) {
        console.error('[VoiceAgentButton] Failed to connect:', e);
        setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
      }
    }
  }, [isConnected, isConnecting, connect, disconnect, startRecording, sessionId,
      setVoiceModeConnecting, setVoiceModeDisconnected, setVoiceModeUserSpeaking, setVoiceModeError, setAudioMode]);

  const getStatusColor = () => {
    if (error || voiceState?.error) return 'text-red-500';
    if (isConnected) return 'text-green-500 hover:text-red-400';
    if (isConnecting) return 'text-yellow-500';
    return 'text-claude-text-secondary hover:text-claude-accent';
  };

  const getTitle = () => {
    if (!isConfigured) return 'Configure ElevenLabs API Key and Agent ID in Settings for voice agent mode';
    if (error || voiceState?.error) return `Error: ${error || voiceState?.error}`;
    if (isConnecting) return 'Connecting to voice agent...';
    if (isConnected) return 'Voice agent ON - Click to disconnect';
    return 'Click to start voice agent';
  };

  const renderIcon = () => {
    if (isConnecting) {
      return <Loader2 className="w-4 h-4 animate-spin" />;
    }

    if (isConnected) {
      return (
        <div className="relative">
          <Headphones className="w-4 h-4" />
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
        </div>
      );
    }

    return <Headphones className="w-4 h-4" />;
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isConnecting || !isConfigured}
      className={`
        relative p-1 transition-all duration-200
        ${!isConfigured ? 'text-claude-text-secondary opacity-40 cursor-not-allowed' : getStatusColor()}
        ${disabled || isConnecting ? 'opacity-50 cursor-not-allowed' : !isConfigured ? '' : 'cursor-pointer'}
      `}
      style={{ borderRadius: 0 }}
      title={getTitle()}
    >
      {renderIcon()}
    </button>
  );
});

VoiceAgentButton.displayName = 'VoiceAgentButton';
