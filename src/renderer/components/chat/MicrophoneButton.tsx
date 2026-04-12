import React, { useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { useVoiceConversationSDK } from '../../hooks/useVoiceConversationSDK';
import { useAudioStore } from '../../stores/audio.store';
import { useSessionStore } from '../../stores/session.store';

// Stable empty array references outside component to prevent infinite re-renders
const EMPTY_MESSAGES: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];

// Debounce helper
function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number
): (...args: Args) => void {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const debouncedFn = useCallback((...args: Args) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      callbackRef.current(...args);
    }, delay);
  }, [delay]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debouncedFn;
}

interface MicrophoneButtonProps {
  sessionId: string;
  onTranscriptionComplete?: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
  disabled?: boolean;
}

// Imperative handle for voice mode control from InputArea
export interface VoiceModeHandle {
  startPushToTalk: () => Promise<void>;
  stopPushToTalk: () => Promise<void>;
  toggleVoiceMode: () => Promise<void>;
  disconnectVoiceMode: () => Promise<void>;
  isConnected: boolean;
}

/**
 * Microphone Button - Toggles ElevenLabs Voice Mode
 *
 * Click: Toggle voice mode on/off
 * When on, the InputArea shows voice mode UI
 *
 * Also exposes imperative handle for push-to-talk (CMD hotkey)
 */
export const MicrophoneButton = forwardRef<VoiceModeHandle, MicrophoneButtonProps>(({
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
  const isConfigured = Boolean(agentId);
  const voiceState = voiceModeStates[sessionId];
  const isConnected = voiceState?.isConnected || false;
  const isConnecting = voiceState?.isConnecting || false;

  // Get session context for ElevenLabs agent
  // Use stable empty array reference to avoid infinite re-renders
  const messages = useSessionStore((state) => state.messages[sessionId]) || EMPTY_MESSAGES;
  const session = useSessionStore((state) => state.sessions.find(s => s.id === sessionId));
  const isStreaming = useSessionStore((state) => !!state.isStreaming[sessionId]);

  // Subscribe to thinking content and assistant text for incremental updates
  // Use stable references for empty values to prevent infinite re-renders
  const currentThinkingContent = useSessionStore((state) => state.currentThinkingContent[sessionId] || '');
  const currentStreamContent = useSessionStore((state) => state.currentStreamContent[sessionId] || '');
  const currentToolCalls = useSessionStore((state) => state.currentToolCalls[sessionId] || EMPTY_TOOL_CALLS);
  const pendingPermission = useSessionStore((state) => state.pendingPermission[sessionId]);

  // Generate context summary for ElevenLabs agent
  const generateContextSummary = useCallback((isInitial = false) => {
    // For initial connection, send ALL messages (or last 50 if > 50)
    // For updates, send last 5 messages
    const contextMessages = isInitial
      ? (messages.length > 50 ? messages.slice(-50) : messages)
      : messages.slice(-5);

    const messageSummary = contextMessages
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        // For initial context, show more of each message
        const maxLength = isInitial ? 300 : 150;
        return `${m.role}: ${content.slice(0, maxLength)}${content.length > maxLength ? '...' : ''}`;
      })
      .join('\n');

    // Extract project name from path
    const projectName = session?.repoPath?.split('/').pop() || session?.name || 'unknown project';

    if (isInitial) {
      // Rich initial context for when voice mode first connects
      // Include FULL conversation history so voice agent understands what's been discussed
      return `INITIAL SESSION CONTEXT:
You are now connected as the voice assistant for G-Build (an AI coding tool).

PROJECT: ${projectName}
WORKING DIRECTORY: ${session?.repoPath || 'unknown'}
BRANCH: ${session?.branch || 'main'}
STATUS: ${isStreaming ? 'G-Build is currently working on a task' : 'G-Build is idle, ready for instructions'}

FULL CONVERSATION HISTORY (${contextMessages.length} messages):
${messageSummary || 'No conversation yet - this is a fresh session'}

IMPORTANT: Claude Code already has ALL of this context. Do NOT repeat analysis or work that's already been done.
Your role is to:
1. Understand what's already been discussed
2. Help the user communicate new requests to Claude Code
3. Report on Claude Code's progress when asked

You should greet the user briefly and ask how you can help with their coding work on ${projectName}.`;
    }

    // Standard update context
    return `Current G-Build Session Context:
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
    // No systemPrompt - use agent's main prompt configured via ElevenLabs API
    // This allows us to update the prompt via API without code changes
    onTranscript: (text, isFinal) => {
      // Update store with transcript for display
      setVoiceModeTranscript(sessionId, text);
      // Track user speaking state for UI feedback (wave animation)
      setVoiceModeUserSpeaking(sessionId, !isFinal && text.length > 0);
      // Note: We no longer send directly to Grep here.
      // ElevenLabs agent decides when to call the execute_grep_command tool.
      if (isFinal && text.trim()) {
        console.log('[MicrophoneButton] Final transcript received, waiting for tool call:', text.slice(0, 50));
      }
    },
    onClaudeResponse: (text) => {
      // Update store with agent response
      setVoiceModeAgentResponse(sessionId, text);
      console.log('[MicrophoneButton] Agent response:', text.slice(0, 50));
    },
    onError: (error) => {
      console.error('[MicrophoneButton] Voice error:', error);
      setVoiceModeError(sessionId, error);
    },
    // Handle tool calls from ElevenLabs agent
    onToolCall: async (toolCall) => {
      console.log('[MicrophoneButton] Tool call received:', toolCall.toolName, toolCall.parameters);

      if (toolCall.toolName === 'execute_grep_command') {
        const instruction = toolCall.parameters.instruction as string;
        if (instruction) {
          console.log('[MicrophoneButton] Executing Grep command:', instruction.slice(0, 100));

          // Send to Grep/Agent SDK
          onTranscriptionComplete?.(instruction);

          // Return a clear "in progress" response
          return `TASK SUBMITTED. G-Build is now working on: "${instruction.slice(0, 50)}...". Call get_task_status every 5-10 seconds to check progress and announce what G-Build is doing.`;
        }
        return 'No instruction provided';
      }

      // Status polling tool - agent calls this to get latest updates
      if (toolCall.toolName === 'get_task_status') {
        const currentState = useSessionStore.getState();
        const sessionIsStreaming = currentState.isStreaming[sessionId];
        const thinking = currentState.currentThinkingContent[sessionId] || '';
        const streamContent = currentState.currentStreamContent[sessionId] || '';
        const toolCalls = currentState.currentToolCalls[sessionId] || [];
        const sessionMessages = currentState.messages[sessionId] || [];

        // Get latest tool call for context
        const latestToolCall = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;
        let currentAction = 'Processing';
        if (latestToolCall) {
          const toolName = latestToolCall.name?.toLowerCase() || '';
          const input = latestToolCall.input || {};
          // Extract file path, getting just the filename for brevity
          const filePath = input.file_path as string | undefined;
          const fileName = filePath ? filePath.split('/').pop() : undefined;

          if (toolName.includes('read')) {
            currentAction = fileName ? `Reading ${fileName}` : 'Reading a file';
          } else if (toolName.includes('write')) {
            currentAction = fileName ? `Writing ${fileName}` : 'Writing a file';
          } else if (toolName.includes('edit')) {
            currentAction = fileName ? `Editing ${fileName}` : 'Editing a file';
          } else if (toolName.includes('bash')) {
            // Include the command being run (truncated)
            const command = input.command as string | undefined;
            const description = input.description as string | undefined;
            if (description) {
              currentAction = description.slice(0, 60);
            } else if (command) {
              // Extract first part of command for context
              const cmdPreview = command.split(/\s+/).slice(0, 4).join(' ');
              currentAction = `Running: ${cmdPreview.slice(0, 50)}`;
            } else {
              currentAction = 'Running a command';
            }
          } else if (toolName.includes('glob')) {
            const pattern = input.pattern as string | undefined;
            currentAction = pattern ? `Searching for ${pattern}` : 'Searching files';
          } else if (toolName.includes('grep')) {
            const pattern = input.pattern as string | undefined;
            currentAction = pattern ? `Searching for "${pattern}"` : 'Searching code';
          } else if (toolName.includes('task')) {
            const desc = input.description as string | undefined;
            currentAction = desc ? `Sub-agent: ${desc.slice(0, 40)}` : 'Working with a sub-agent';
          } else {
            currentAction = `Using ${toolName}`;
          }
        }

        // Extract latest thinking sentence
        const thinkingSentences = thinking.split(/[.!?]\s+/).filter(s => s.trim().length > 10);
        const latestThinking = thinkingSentences.length > 0 ? thinkingSentences[thinkingSentences.length - 1].slice(0, 100) : '';

        if (sessionIsStreaming) {
          // Include raw tool call data for the agent to summarize
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
          // Task complete - get last assistant message
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

  // Expose imperative handle for voice mode control from InputArea
  useImperativeHandle(ref, () => ({
    startPushToTalk: async () => {
      console.log('[VoiceMode] startPushToTalk called, isConnected:', hookConnected);
      if (!hookConnected && !hookConnecting) {
        // Need to connect first
        try {
          setVoiceModeConnecting(sessionId);
          await connect();
          // Wait a bit for connection to establish before starting recording
          setTimeout(async () => {
            await startRecording();
          }, 100);
        } catch (e) {
          console.error('[VoiceMode] Push-to-talk connect error:', e);
          setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
        }
      } else if (hookConnected) {
        // Already connected, just start recording
        await startRecording();
      }
    },
    stopPushToTalk: async () => {
      console.log('[VoiceMode] stopPushToTalk called');
      // Stop recording but keep connected for quick follow-up
      // Just signal end of user input
      await window.electronAPI.voice.endInput();
    },
    toggleVoiceMode: async () => {
      console.log('[VoiceMode] toggleVoiceMode called, isConnected:', hookConnected);
      if (hookConnected) {
        // Disconnect
        await disconnect();
        setVoiceModeDisconnected(sessionId);
        setVoiceModeUserSpeaking(sessionId, false);
        setAudioMode(sessionId, false);
      } else if (!hookConnecting) {
        // Connect
        try {
          setVoiceModeConnecting(sessionId);
          await connect();
          // Start recording immediately after connecting
          setTimeout(async () => {
            await startRecording();
          }, 100);
        } catch (e) {
          console.error('[VoiceMode] Toggle connect error:', e);
          setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
        }
      }
    },
    disconnectVoiceMode: async () => {
      console.log('[VoiceMode] disconnectVoiceMode called');
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
      // Voice mode disconnected (could be unexpected WebSocket close)
      // Clear audioMode to prevent legacy TTS from running ("ghost mode")
      setVoiceModeDisconnected(sessionId);
      setAudioMode(sessionId, false);
      setVoiceModeUserSpeaking(sessionId, false);
    }
  }, [hookConnected, isConnected, sessionId, setVoiceModeConnected, setVoiceModeDisconnected, setAudioMode, setVoiceModeUserSpeaking]);

  useEffect(() => {
    setVoiceModeSpeaking(sessionId, isSpeaking);
  }, [isSpeaking, sessionId, setVoiceModeSpeaking]);

  // Sync audio level to store for wave visualization
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

  // Send initial context when connected - includes rich context for proper greeting
  useEffect(() => {
    console.log('[MicrophoneButton] Connection effect fired, hookConnected:', hookConnected);
    if (hookConnected) {
      // Send rich initial context - this gives the agent all the information it needs
      const context = generateContextRef.current(true);
      console.log('[MicrophoneButton] Sending initial context, preview:', context.slice(0, 200));
      updateContext(context);
      // Note: We don't send a greeting speak() anymore - let user initiate conversation
      // The initial context is enough for the agent to understand the session state
    }
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, [hookConnected]);

  // Helper to summarize assistant response for voice announcements
  const summarizeForVoice = useCallback((content: unknown): string => {
    if (typeof content !== 'string') return 'Task completed';

    // Check for common patterns in Claude responses
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

    // Truncate to first sentence/line if nothing specific found
    const firstLine = content.split('\n')[0].slice(0, 100);
    return firstLine.length < content.length ? firstLine + '...' : firstLine;
  }, []);

  // Send context updates when messages change (Grep responded)
  const prevMessagesLengthRef = useRef(messages.length);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    // Only send update if messages actually changed (not on initial render)
    if (hookConnected && messages.length > 0 && messages.length !== prevMessagesLengthRef.current) {
      const lastMessage = messages[messages.length - 1];

      // If Grep (assistant) responded, send a progress update
      if (lastMessage?.role === 'assistant') {
        const summary = summarizeForVoice(lastMessage.content);
        console.log('[MicrophoneButton] Grep responded, sending progress update:', summary);

        // If streaming just ended, this is the COMPLETION - announce it clearly
        if (!isStreaming && prevStreamingRef.current) {
          console.log('[MicrophoneButton] Streaming ended, announcing completion');

          // Send raw completion data as JSON context
          const completionData = JSON.stringify({
            type: 'task_complete',
            assistantResponse: typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 1000) : 'Task completed',
          });
          updateContext(completionData);

          // Brief completion prompt - let agent summarize naturally
          if (!isSpeaking) {
            speak('Task complete. Give a brief summary.');
          }
        } else {
          // Still streaming - just a progress update (no speak needed)
          updateContext(`G-Build progress: ${summary}\nStatus: Still working...`);
        }
      } else {
        // User message - just update context
        console.log('[MicrophoneButton] Messages changed, sending context update');
        const context = generateContextRef.current();
        console.log('[MicrophoneButton] Context preview:', context.slice(0, 100));
        updateContext(context);
      }
    }
    prevMessagesLengthRef.current = messages.length;
    prevStreamingRef.current = isStreaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookConnected, messages.length, isStreaming, summarizeForVoice, speak]);

  // User activity signal ref for preventing "are you there?" prompts
  const activityIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Send user activity signals while streaming to prevent "are you there?" prompts
  useEffect(() => {
    if (hookConnected && isStreaming) {
      // Send activity signal immediately when streaming starts
      sendUserActivity();
      console.log('[MicrophoneButton] Sent initial user activity signal');

      // Send activity signal every 15 seconds while working
      activityIntervalRef.current = setInterval(() => {
        sendUserActivity();
        console.log('[MicrophoneButton] Sent periodic user activity signal');
      }, 15000);
    } else {
      // Clear interval when not streaming
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

  // Event-driven status updates - send tool changes as silent context (no verbal prompt)
  // The agent can reference this if needed, but thinking updates are the primary verbal updates
  const prevToolCallCountRef = useRef<number>(0);

  useEffect(() => {
    if (!hookConnected || !isStreaming) {
      prevToolCallCountRef.current = 0;
      return;
    }

    // When new tool calls come in, send raw JSON as context (silently - no speak)
    const currentCount = currentToolCalls.length;
    if (currentCount > prevToolCallCountRef.current && currentCount > 0) {
      // Get the new tool calls since last update
      const newTools = currentToolCalls.slice(prevToolCallCountRef.current);

      // Send raw tool call data as JSON
      const rawToolData = newTools.map(tool => ({
        tool: tool.name,
        input: tool.input,
      }));

      const contextJson = JSON.stringify({
        type: 'tool_update',
        toolCalls: rawToolData,
        note: 'This is background context. Only mention if relevant and not already covered by thinking updates.',
      });

      console.log('[MicrophoneButton] Tool update (silent context):', contextJson.slice(0, 200));

      // Send as context only - no verbal prompt for tool calls
      // Thinking updates are the primary way to communicate what's happening
      updateContext(contextJson);
    }
    prevToolCallCountRef.current = currentCount;
  }, [hookConnected, isStreaming, currentToolCalls, updateContext]);

  // Announce permission requests vocally and notify when approved/denied
  const prevPermissionRef = useRef<string | null>(null);
  const hadPendingPermissionRef = useRef<boolean>(false);

  useEffect(() => {
    if (!hookConnected) {
      prevPermissionRef.current = null;
      hadPendingPermissionRef.current = false;
      return;
    }

    // Check if permission was just resolved (had one, now gone)
    if (hadPendingPermissionRef.current && !pendingPermission) {
      console.log('[MicrophoneButton] Permission resolved, notifying agent');
      updateContext(JSON.stringify({ type: 'permission_resolved', status: 'approved' }));
      speak('Permission granted. G-Build is continuing.');
      hadPendingPermissionRef.current = false;
      prevPermissionRef.current = null;
      return;
    }

    if (!pendingPermission) {
      return;
    }

    // Track that we have a pending permission
    hadPendingPermissionRef.current = true;

    // Only announce if this is a new permission request
    const permissionId = pendingPermission.requestId;
    if (permissionId !== prevPermissionRef.current) {
      prevPermissionRef.current = permissionId;

      // Build a descriptive announcement
      let announcement = 'Permission needed.';
      if (pendingPermission.toolName === 'Bash') {
        const command = pendingPermission.toolInput?.command as string;
        if (command) {
          // Extract the main command (first few words)
          const cmdPreview = command.split(/\s+/).slice(0, 3).join(' ');
          announcement = `Permission needed to run: ${cmdPreview}`;
        }
      } else {
        announcement = `Permission needed for ${pendingPermission.toolName}`;
      }

      console.log('[MicrophoneButton] Permission request, announcing:', announcement);
      speak(`${announcement}. Tell me that G-Build needs permission to proceed.`);
    }
  }, [hookConnected, pendingPermission, speak, updateContext]);

  // Silent thinking context updates - NO forced speak() calls
  // The agent decides when to speak based on significant moments:
  // - Discoveries or interesting findings
  // - Changes in direction or approach
  // - Important progress updates
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

    // Throttle context updates to every 5 seconds
    const now = Date.now();
    if (now - lastContextUpdateRef.current < 5000) {
      return;
    }

    // Check for meaningful new content
    const newContent = currentThinkingContent.slice(prevThinkingContentRef.current.length);
    if (newContent.length < 100) {
      return;
    }

    // Get recent thinking for context
    const sentences = currentThinkingContent.split(/[.!?]/).filter(s => s.trim().length > 10);
    const recentThinking = sentences.slice(-3).join('. ').slice(0, 500);

    if (recentThinking.length > 30) {
      // Send context silently - agent decides when to speak
      const contextJson = JSON.stringify({
        type: 'thinking_update',
        thought: recentThinking,
        instruction: 'Only speak if you notice something significant: a discovery, a change in approach, or important progress. Stay quiet for routine work.',
      });

      console.log('[MicrophoneButton] Silent thinking context update');
      updateContext(contextJson);

      prevThinkingContentRef.current = currentThinkingContent;
      lastContextUpdateRef.current = now;
    }
  }, [hookConnected, isStreaming, currentThinkingContent, updateContext]);

  // NOTE: Minimal speech approach - let agent decide when to speak
  // - Thinking updates: Silent context only, agent speaks when significant
  // - Tool calls: Silent context only
  // - Permission requests: Speak (needs user action)
  // - Task completion: Brief natural prompt

  const handleClick = useCallback(async () => {
    if (isConnected) {
      // Disconnect voice mode
      await disconnect();
      setVoiceModeDisconnected(sessionId);
      setVoiceModeUserSpeaking(sessionId, false);
      setAudioMode(sessionId, false);
    } else if (!isConnecting) {
      // Connect to voice mode
      try {
        setVoiceModeConnecting(sessionId);
        await connect();
        // Start recording immediately after connecting
        setTimeout(async () => {
          await startRecording();
        }, 100);
      } catch (e) {
        console.error('[MicrophoneButton] Failed to connect:', e);
        setVoiceModeError(sessionId, e instanceof Error ? e.message : 'Failed to connect');
      }
    }
  }, [isConnected, isConnecting, connect, disconnect, startRecording, sessionId,
      setVoiceModeConnecting, setVoiceModeDisconnected, setVoiceModeUserSpeaking, setVoiceModeError, setAudioMode]);

  const getStatusColor = () => {
    if (error || voiceState?.error) return 'text-red-500';
    if (isConnected) return 'text-green-500 hover:text-red-400'; // Green when on, hover shows it will turn off
    if (isConnecting) return 'text-yellow-500';
    return 'text-claude-text-secondary hover:text-claude-accent';
  };

  const getTitle = () => {
    if (!isConfigured) return 'Configure ElevenLabs Agent ID in Settings';
    if (error || voiceState?.error) return `Error: ${error || voiceState?.error}`;
    if (isConnecting) return 'Connecting to voice mode...';
    if (isConnected) return 'Voice mode ON - Click to turn off';
    return 'Click to start voice mode';
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

MicrophoneButton.displayName = 'MicrophoneButton';
