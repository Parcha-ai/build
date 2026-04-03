import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useSessionStore, type BackgroundTask } from '../../stores/session.store';
import { useAudioStore } from '../../stores/audio.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from './MessageList';
import InputArea from './InputArea';
import PermissionDialog from './PermissionDialog';
import QuestionDialog from './QuestionDialog';
import ThinkingBlock from './ThinkingBlock';
import TasksBlock, { type Task } from './TasksBlock';
import BackgroundTasksBlock from './BackgroundTasksBlock';
import BtwOverlay from './BtwOverlay';
// CodexOverlay removed — Codex runs as a model in the existing chat
import RemoteControlPanel from './RemoteControlPanel';
// CompactionBar removed - compaction status now shown in ThinkingBlock
import { SoundVisualization } from './SoundVisualization';
import { ArrowDown } from 'lucide-react';
import type { Session, ToolCall } from '../../../shared/types';
import { GSTACK_MODE_META } from '../../../shared/types';

interface ChatContainerProps {
  session: Session;
}

// Stable empty arrays/objects to avoid reference changes when session data is missing
const EMPTY_MESSAGES: never[] = [];
const EMPTY_EVENTS: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];
const EMPTY_QUEUE: never[] = [];
const EMPTY_BG_TASKS: never[] = [];

export default function ChatContainer({ session }: ChatContainerProps) {
  // Per-session data selectors — only re-render when THIS session's data changes
  const sessionMessages = useSessionStore(useCallback((s) => s.messages[session.id] || EMPTY_MESSAGES, [session.id]));
  const isSessionStreaming = useSessionStore(useCallback((s) => s.isStreaming[session.id] || false, [session.id]));
  const sessionStreamEvents = useSessionStore(useCallback((s) => s.streamEvents[session.id] || EMPTY_EVENTS, [session.id]));
  const streamContent = useSessionStore(useCallback((s) => s.currentStreamContent[session.id] || '', [session.id]));
  const thinkingContent = useSessionStore(useCallback((s) => s.currentThinkingContent[session.id] || '', [session.id]));
  const streamingToolCalls = useSessionStore(useCallback((s) => s.currentToolCalls[session.id] || EMPTY_TOOL_CALLS, [session.id]));
  const systemInfo = useSessionStore(useCallback((s) => s.currentSystemInfo[session.id] || null, [session.id]));
  const currentPermission = useSessionStore(useCallback((s) => s.pendingPermission[session.id] || null, [session.id]));
  const currentQuestion = useSessionStore(useCallback((s) => s.pendingQuestion[session.id] || null, [session.id]));
  const compaction = useSessionStore(useCallback((s) => s.compactionStatus[session.id] || null, [session.id]));
  const queuedMessages = useSessionStore(useCallback((s) => s.messageQueue[session.id] || EMPTY_QUEUE, [session.id]));
  const sessionBgTasks = useSessionStore(useCallback((s) => s.backgroundTasks[session.id] || EMPTY_BG_TASKS, [session.id]));
  const isLoadingMessages = useSessionStore(useCallback((s) => s.isLoadingMessages[session.id] || false, [session.id]));
  const btwState = useSessionStore(useCallback((s) => s.btw[session.id] || null, [session.id]));
  const rcState = useSessionStore(useCallback((s) => s.remoteControl[session.id] || null, [session.id]));
  // Codex second opinion state
  // Codex overlay state removed — Codex runs as a model in the existing chat

  // Action selectors — stable references, never cause re-renders
  const approvePermission = useSessionStore((s) => s.approvePermission);
  const denyPermission = useSessionStore((s) => s.denyPermission);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const addBackgroundTask = useSessionStore((s) => s.addBackgroundTask);
  const removeBackgroundTask = useSessionStore((s) => s.removeBackgroundTask);
  const dismissBtw = useSessionStore((s) => s.dismissBtw);
  // Codex overlay actions removed — Codex runs as a model in the existing chat
  // clearRemoteControl removed — stopRemoteControl handles both IPC kill + state clear

  const { audioModeActive, ttsStates } = useAudioStore();
  const { toggleTerminalPanel, isTerminalPanelOpen } = useUIStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const lastMessageCountRef = useRef(0);
  const lastScrollTop = useRef(0);
  const lastScrollTime = useRef(Date.now());
  const fastScrollCount = useRef(0);
  const fastScrollResetTimer = useRef<NodeJS.Timeout | null>(null);

  // Debug: Log thinking content
  if (thinkingContent) {
    console.log('[ChatContainer] thinkingContent length:', thinkingContent.length, 'isStreaming:', isSessionStreaming);
  }
  const isAudioMode = audioModeActive[session.id] || false;
  const currentPermissionRequest = currentPermission;
  const currentQuestionRequest = currentQuestion;
  const currentCompactionStatus = compaction;
  const sessionBackgroundTasks = sessionBgTasks;

  // Check if any TTS is actively playing for messages in this session
  const isTTSPlaying = sessionMessages.some(msg => msg?.id && ttsStates[msg.id]?.isPlaying);

  // Handler to background a running Bash command
  const handleBackgroundTask = useCallback((toolCall: ToolCall) => {
    const task: BackgroundTask = {
      id: toolCall.id,
      sessionId: session.id,
      command: (toolCall.input?.command as string) || 'Unknown command',
      output: '',
      status: 'running',
      startedAt: new Date(),
    };
    addBackgroundTask(session.id, task);
    console.log('[ChatContainer] Backgrounded task:', task.command.slice(0, 50));
  }, [session.id, addBackgroundTask]);

  // Handler to stop a background task
  const handleStopBackgroundTask = useCallback((taskId: string) => {
    // TODO: Implement actual task termination via IPC
    removeBackgroundTask(session.id, taskId);
    console.log('[ChatContainer] Stopped background task:', taskId);
  }, [session.id, removeBackgroundTask]);

  // Handler to view output file
  const handleViewOutput = useCallback((taskId: string) => {
    const task = sessionBackgroundTasks.find(t => t.id === taskId);
    if (task?.outputFile) {
      // Open in editor
      window.electronAPI?.app.openPath(task.outputFile);
    }
  }, [sessionBackgroundTasks]);

  // Extract tasks from TaskCreate/TaskUpdate/TaskList tool calls (new SDK Tasks system)
  // Also supports legacy TodoWrite for backwards compatibility
  const currentTasks = useMemo((): Task[] => {
    // Debug: Log all tool calls to understand what we're getting
    if (streamingToolCalls.length > 0) {
      console.log('[TasksBlock] All streaming tool calls:', streamingToolCalls.map(tc => tc.name));
    }

    // Debug: Log all task-related tool calls
    const taskToolCalls = streamingToolCalls.filter(tc =>
      tc.name === 'TaskCreate' || tc.name === 'TaskUpdate' || tc.name === 'TaskList' || tc.name === 'TaskGet'
    );
    if (taskToolCalls.length > 0) {
      console.log('[TasksBlock] Found task tool calls in streaming:', taskToolCalls.map(tc => ({
        name: tc.name,
        input: tc.input,
        result: tc.result,
        status: tc.status,
      })));
    }

    // Also check messages for task tool calls
    const messageTaskCalls: any[] = [];
    for (const msg of sessionMessages) {
      if (msg?.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc?.name === 'TaskCreate' || tc?.name === 'TaskUpdate' || tc?.name === 'TaskList' || tc?.name === 'TaskGet') {
            messageTaskCalls.push({ name: tc.name, input: tc.input, result: tc.result });
          }
        }
      }
    }
    if (messageTaskCalls.length > 0) {
      console.log('[TasksBlock] Found task tool calls in messages:', messageTaskCalls);
    }

    // Look for TaskList result first (gives complete picture)
    const taskListCall = [...streamingToolCalls]
      .reverse()
      .find(tc => tc.name === 'TaskList' && tc.result);

    if (taskListCall?.result) {
      // TaskList returns an array of tasks (or might be wrapped in an object)
      const taskListResult = taskListCall.result;
      console.log('[TasksBlock] TaskList result:', taskListResult);

      // Handle both array and object-wrapped formats
      const tasksArray = Array.isArray(taskListResult)
        ? taskListResult
        : (taskListResult as any)?.tasks || (taskListResult as any)?.items || [];

      if (Array.isArray(tasksArray) && tasksArray.length > 0) {
        return tasksArray.map((t: any) => ({
          id: t.id || String(Math.random()),
          subject: t.subject || 'Task',
          description: t.description,
          status: t.status || 'pending',
          owner: t.owner,
          activeForm: t.activeForm,
          blocks: t.blocks,
          blockedBy: t.blockedBy,
        }));
      }
    }

    // Build task list from TaskCreate/TaskUpdate calls in current streaming
    const taskMap = new Map<string, Task>();

    // First, check message history for previous task tool calls
    for (const msg of sessionMessages) {
      if (msg?.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc?.name === 'TaskCreate' && tc.result) {
            const result = tc.result as any;
            if (result.id) {
              taskMap.set(result.id, {
                id: result.id,
                subject: (tc.input as any).subject || 'Task',
                description: (tc.input as any).description,
                status: 'pending',
                activeForm: (tc.input as any).activeForm,
              });
            }
          } else if (tc.name === 'TaskUpdate' && tc.input) {
            const input = tc.input as any;
            const taskId = input.taskId;
            if (taskId && taskMap.has(taskId)) {
              const existing = taskMap.get(taskId)!;
              taskMap.set(taskId, {
                ...existing,
                status: input.status || existing.status,
                subject: input.subject || existing.subject,
                description: input.description || existing.description,
                activeForm: input.activeForm || existing.activeForm,
              });
            }
          } else if (tc.name === 'TaskList' && tc.result && Array.isArray(tc.result)) {
            // TaskList result replaces the map
            taskMap.clear();
            for (const t of tc.result as any[]) {
              taskMap.set(t.id, {
                id: t.id,
                subject: t.subject || 'Task',
                description: t.description,
                status: t.status || 'pending',
                owner: t.owner,
                activeForm: t.activeForm,
                blocks: t.blocks,
                blockedBy: t.blockedBy,
              });
            }
          }
        }
      }
    }

    // Then apply streaming tool calls
    for (const tc of streamingToolCalls) {
      if (tc.name === 'TaskCreate') {
        const input = tc.input as any;
        const tempId = tc.id || String(Math.random());
        // If result has real ID, use it; otherwise use temp
        const taskId = (tc.result as any)?.id || tempId;
        taskMap.set(taskId, {
          id: taskId,
          subject: input.subject || 'Task',
          description: input.description,
          status: 'pending',
          activeForm: input.activeForm,
        });
      } else if (tc.name === 'TaskUpdate') {
        const input = tc.input as any;
        const taskId = input.taskId;
        if (taskId) {
          const existing = taskMap.get(taskId);
          if (existing) {
            taskMap.set(taskId, {
              ...existing,
              status: input.status || existing.status,
              subject: input.subject || existing.subject,
              description: input.description || existing.description,
              activeForm: input.activeForm || existing.activeForm,
            });
          }
        }
      } else if (tc.name === 'TaskList' && tc.result && Array.isArray(tc.result)) {
        // TaskList result replaces the map
        taskMap.clear();
        for (const t of tc.result as any[]) {
          taskMap.set(t.id, {
            id: t.id,
            subject: t.subject || 'Task',
            description: t.description,
            status: t.status || 'pending',
            owner: t.owner,
            activeForm: t.activeForm,
            blocks: t.blocks,
            blockedBy: t.blockedBy,
          });
        }
      }
    }

    // Fallback: Check for legacy TodoWrite calls and convert to Task format
    if (taskMap.size === 0) {
      const todoWriteCall = [...streamingToolCalls]
        .reverse()
        .find(tc => tc.name === 'TodoWrite');

      if (todoWriteCall?.input?.todos && Array.isArray(todoWriteCall.input.todos)) {
        const todos = todoWriteCall.input.todos as any[];
        return todos.map((todo, index) => ({
          id: `todo-${index}`,
          subject: todo.content,
          status: todo.status || 'pending',
          activeForm: todo.activeForm,
        }));
      }

      // Check message history for TodoWrite
      for (let i = sessionMessages.length - 1; i >= 0; i--) {
        const msg = sessionMessages[i];
        if (msg?.toolCalls && Array.isArray(msg.toolCalls)) {
          const todoWrite = [...msg.toolCalls]
            .reverse()
            .find(tc => tc?.name === 'TodoWrite');
          if (todoWrite?.input?.todos && Array.isArray(todoWrite.input.todos)) {
            const todos = todoWrite.input.todos as any[];
            return todos.map((todo, index) => ({
              id: `todo-${index}`,
              subject: todo.content,
              status: todo.status || 'pending',
              activeForm: todo.activeForm,
            }));
          }
        }
      }
    }

    const tasks = Array.from(taskMap.values());
    if (tasks.length > 0) {
      console.log('[TasksBlock] Extracted tasks:', tasks);
    }
    return tasks;
  }, [session.id, streamingToolCalls, sessionMessages]);

  // IPC subscriptions (subscribeToClaude, subscribeToBackgroundTasks, subscribeToBtw,
  // subscribeToRemoteControl) are now hoisted to App.tsx to avoid N-times duplication
  // when multiple ChatContainers are mounted in Command Center mode.

  // Keyboard shortcut: Cmd+B to background running Bash command
  // Use refs to avoid re-registering listener on every streaming token update
  const streamingToolCallsRef = useRef(streamingToolCalls);
  streamingToolCallsRef.current = streamingToolCalls;
  const handleBackgroundTaskRef = useRef(handleBackgroundTask);
  handleBackgroundTaskRef.current = handleBackgroundTask;

  useEffect(() => {
    const runBackgroundShortcut = () => {
      const runningBash = streamingToolCallsRef.current.find(
        (tc) => tc.name === 'Bash' && (tc.status === 'running' || tc.status === 'pending')
      );
      if (runningBash) {
        handleBackgroundTaskRef.current(runningBash);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'b') {
        const runningBash = streamingToolCallsRef.current.find(
          (tc) => tc.name === 'Bash' && (tc.status === 'running' || tc.status === 'pending')
        );
        if (runningBash) {
          e.preventDefault();
          runBackgroundShortcut();
        }
      }
    };

    const handleShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ action: string; sessionId?: string }>).detail;
      if (detail?.action === 'background-task' && detail.sessionId === session.id) {
        runBackgroundShortcut();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('grep-shortcut', handleShortcut as EventListener);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('grep-shortcut', handleShortcut as EventListener);
    };
  }, []);

  // Track programmatic scrolls to avoid re-triggering scroll effects
  const isProgrammaticScroll = useRef(false);

  // Check if user is at bottom of chat
  const checkIfAtBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;

    const threshold = 100; // pixels from bottom to consider "at bottom"
    const isBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    setIsAtBottom(isBottom);
    setShowScrollButton(!isBottom);
    return isBottom;
  }, []);

  // Handle scroll events with velocity detection
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Skip velocity detection for programmatic scrolls (scrollIntoView)
      if (isProgrammaticScroll.current) {
        checkIfAtBottom();
        return;
      }

      const now = Date.now();
      const currentScrollTop = container.scrollTop;
      const timeDelta = now - lastScrollTime.current;
      const scrollDelta = currentScrollTop - lastScrollTop.current;

      // Calculate scroll velocity (pixels per millisecond)
      const velocity = timeDelta > 0 ? Math.abs(scrollDelta / timeDelta) : 0;

      // Determine scroll direction
      const isScrollingDown = scrollDelta > 0;
      const isScrollingUp = scrollDelta < 0;
      const isFastScroll = velocity > 3;

      // Double-scroll gesture: need TWO fast scrolls within 500ms (like double-click)
      if (isScrollingDown && isFastScroll) {
        fastScrollCount.current += 1;
        console.log('[ChatContainer] Fast scroll detected:', fastScrollCount.current, '/ 2');

        // Clear any existing reset timer
        if (fastScrollResetTimer.current) {
          clearTimeout(fastScrollResetTimer.current);
        }

        // Reset count after 500ms (double-scroll window)
        fastScrollResetTimer.current = setTimeout(() => {
          console.log('[ChatContainer] Fast scroll window expired, resetting count');
          fastScrollCount.current = 0;
        }, 500);

        // If we got TWO fast scrolls, trigger snap to bottom
        if (fastScrollCount.current >= 2) {
          console.log('[ChatContainer] Double fast-scroll detected! Snapping to bottom');
          isProgrammaticScroll.current = true;
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          setTimeout(() => { isProgrammaticScroll.current = false; }, 500);
          setIsAtBottom(true);
          setShowScrollButton(false);
          fastScrollCount.current = 0; // Reset
          if (fastScrollResetTimer.current) {
            clearTimeout(fastScrollResetTimer.current);
          }
        }
      } else if (isScrollingUp) {
        // Any upward scroll cancels the gesture and resets counter
        if (fastScrollCount.current > 0) {
          console.log('[ChatContainer] User scrolled up - canceling fast scroll gesture');
        }
        fastScrollCount.current = 0;
        if (fastScrollResetTimer.current) {
          clearTimeout(fastScrollResetTimer.current);
        }
        checkIfAtBottom();
      } else {
        checkIfAtBottom();
      }

      // Update refs for next scroll event
      lastScrollTop.current = currentScrollTop;
      lastScrollTime.current = now;
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfAtBottom]);

  // Auto-scroll: always scroll during active streaming, or when at bottom
  // During streaming the user wants to follow output — don't require them to be exactly at the bottom
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const shouldAutoScroll = isAtBottom || isSessionStreaming;

    if (shouldAutoScroll) {
      // Throttle scrollIntoView to at most once per 100ms during streaming
      if (!scrollTimerRef.current) {
        scrollTimerRef.current = setTimeout(() => {
          isProgrammaticScroll.current = true;
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          setTimeout(() => { isProgrammaticScroll.current = false; }, 500);
          scrollTimerRef.current = null;
        }, 100);
      }
      setHasNewContent(false);
    } else {
      const currentCount = sessionMessages.length;
      if (currentCount > lastMessageCountRef.current || streamContent || thinkingContent) {
        setHasNewContent(true);
      }
    }
    lastMessageCountRef.current = sessionMessages.length;
  }, [sessionMessages, streamContent, thinkingContent, isAtBottom, isSessionStreaming]);

  // Scroll to bottom function for FAB
  const scrollToBottom = useCallback(() => {
    isProgrammaticScroll.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => { isProgrammaticScroll.current = false; }, 500);
    setIsAtBottom(true);
    setShowScrollButton(false);
    setHasNewContent(false);
  }, []);

  // Scroll to bottom when session changes or messages first load
  const prevSessionId = useRef(session.id);
  useEffect(() => {
    if (session.id !== prevSessionId.current) {
      prevSessionId.current = session.id;
      // Delay to let DOM render the messages first
      setTimeout(() => {
        isProgrammaticScroll.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        setIsAtBottom(true);
        setShowScrollButton(false);
      }, 50);
    }
  }, [session.id, sessionMessages.length]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-mono bg-claude-bg min-w-0">
      {/* Header - brutalist */}
      <div className="h-10 border-b border-claude-border flex items-center justify-between px-4 bg-claude-surface/50">
        <div className="flex items-center">
          <h2 className="text-sm font-bold text-claude-text uppercase" style={{ letterSpacing: '0.1em' }}>
            {session.name}
          </h2>
          {session.status === 'running' && (
            <span
              className="ml-2 px-1.5 py-0.5 text-xs font-bold uppercase bg-green-500/20 text-green-500"
              style={{ borderRadius: 0, letterSpacing: '0.05em' }}
            >
              ACTIVE
            </span>
          )}
          {session.status === 'error' && (
            <span
              className="ml-2 px-1.5 py-0.5 text-xs font-bold uppercase bg-red-500/20 text-red-500"
              style={{ borderRadius: 0, letterSpacing: '0.05em' }}
            >
              ERROR
            </span>
          )}
        </div>

        {/* Audio visualization - shows when in audio mode and working/speaking */}
        {isAudioMode && (isSessionStreaming || isTTSPlaying) && (
          <div className="flex items-center gap-2">
            <SoundVisualization
              isActive={true}
              variant="bars"
              size="sm"
            />
            <span className="text-xs text-blue-400 uppercase font-bold" style={{ letterSpacing: '0.05em' }}>
              {isTTSPlaying ? 'SPEAKING' : 'THINKING'}
            </span>
          </div>
        )}
      </div>

      {/* Error banner for sessions with error status */}
      {session.status === 'error' && (
        <div className="p-4 bg-red-500/10 border-b border-red-500/30">
          <div className="flex items-start gap-3">
            <div className="text-red-500 text-xl">⚠</div>
            <div className="flex-1">
              <h3 className="text-sm font-bold text-red-400 mb-1">Session Creation Failed</h3>
              {session.errorMessage ? (
                <div className="mb-3">
                  <p className="text-xs text-red-300/80 mb-2">Error details:</p>
                  <pre className="text-[10px] text-red-300 bg-red-500/10 p-2 border border-red-500/20 overflow-x-auto whitespace-pre-wrap font-mono">
                    {session.errorMessage}
                  </pre>
                </div>
              ) : (
                <p className="text-xs text-red-300/80 mb-3">
                  There was an error setting up this session. This usually happens when cloning a repository fails
                  (e.g., invalid URL, no access, or network issues).
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    // Open the terminal panel in Grep
                    if (!isTerminalPanelOpen) {
                      toggleTerminalPanel();
                    }
                  }}
                  className="px-3 py-1.5 text-[10px] font-bold bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30"
                  style={{ borderRadius: 0 }}
                >
                  OPEN TERMINAL
                </button>
                <button
                  onClick={async () => {
                    // Delete the error session
                    await window.electronAPI.sessions.delete(session.id);
                    // Reload sessions
                    const { loadSessions } = useSessionStore.getState();
                    loadSessions();
                  }}
                  className="px-3 py-1.5 text-[10px] font-bold bg-claude-bg hover:bg-claude-surface text-claude-text-secondary border border-claude-border"
                  style={{ borderRadius: 0 }}
                >
                  DELETE SESSION
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 relative">
        <MessageList
          messages={sessionMessages}
          isStreaming={isSessionStreaming}
          isLoadingMessages={isLoadingMessages}
          streamEvents={sessionStreamEvents}
          streamContent={streamContent}
          streamingToolCalls={streamingToolCalls}
          currentToolCalls={streamingToolCalls}
          queuedMessages={queuedMessages}
          onBackgroundTask={handleBackgroundTask}
        />

        <div ref={messagesEndRef} />

        {/* Scroll to bottom button - positioned at bottom of scrollable area, above tasks/thinking */}
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-50 w-10 h-10 flex items-center justify-center bg-claude-accent text-white border border-claude-accent hover:bg-claude-accent/80 shadow-lg transition-all"
            style={{ borderRadius: 0 }}
            title="Scroll to bottom"
          >
            <ArrowDown size={18} strokeWidth={2.5} />
          </button>
        )}
      </div>

      {/* Tasks section - above thinking */}
      {currentTasks.length > 0 && (
        <div className="border-t border-claude-border bg-claude-surface/30 px-4 py-2">
          <TasksBlock
            tasks={currentTasks}
            isStreaming={isSessionStreaming}
          />
        </div>
      )}

      {/* Background tasks section - between tasks and thinking */}
      {sessionBackgroundTasks.length > 0 && (
        <div className="border-t border-claude-border bg-claude-surface/30 px-4 py-2">
          <BackgroundTasksBlock
            tasks={sessionBackgroundTasks}
            onStopTask={handleStopBackgroundTask}
            onViewOutput={handleViewOutput}
          />
        </div>
      )}

      {/* Active thinking/compacting section - separate from message history */}
      {((isSessionStreaming && thinkingContent) || (currentCompactionStatus?.isCompacting)) && (
        <div className="border-t border-claude-border bg-claude-surface/30 px-4 py-2">
          <ThinkingBlock
            content={thinkingContent}
            isStreaming={isSessionStreaming && !!thinkingContent}
            isCompacting={currentCompactionStatus?.isCompacting}
            compactionStatus={currentCompactionStatus}
            gstackColor={(() => { const mode = useSessionStore.getState().gstackMode[session.id]; return mode ? GSTACK_MODE_META[mode]?.color : undefined; })()}
            gstackLabel={(() => { const mode = useSessionStore.getState().gstackMode[session.id]; return mode ? GSTACK_MODE_META[mode]?.shortName : undefined; })()}
          />
        </div>
      )}

      {/* Permission request - prominent above input */}
      {currentPermissionRequest && (
        <div className="border-t border-claude-border px-4 py-3 bg-claude-surface">
          <PermissionDialog
            request={currentPermissionRequest}
            onApprove={(modifiedInput, alwaysApprove) => approvePermission(session.id, modifiedInput, alwaysApprove)}
            onDeny={() => denyPermission(session.id)}
            onGrepIt={() => {
              // Switch to bypass permissions mode and approve the current request
              setPermissionMode(session.id, 'bypassPermissions');
              approvePermission(session.id);
            }}
          />
        </div>
      )}

      {/* Question request - prominent above input */}
      {currentQuestionRequest && (
        <div className="border-t border-claude-border px-4 py-3 bg-claude-surface">
          <QuestionDialog
            request={currentQuestionRequest}
            onAnswer={(answers) => answerQuestion(session.id, answers)}
          />
        </div>
      )}

      {/* Remote control panel */}
      {rcState && (
        <RemoteControlPanel
          sessionId={session.id}
          url={rcState.url}
          startedAt={rcState.startedAt}
        />
      )}

      {/* Codex overlay removed — Codex now runs as a model in the existing chat */}

      {/* Ephemeral /btw overlay */}
      {btwState && (
        <BtwOverlay
          question={btwState.question}
          response={btwState.response}
          isStreaming={btwState.isStreaming}
          onDismiss={() => dismissBtw(session.id)}
        />
      )}

      {/* Input */}
      <InputArea
        sessionId={session.id}
        disabled={session.status !== 'running'}
        systemInfo={systemInfo}
        isStreaming={isSessionStreaming}
      />
    </div>
  );
}
