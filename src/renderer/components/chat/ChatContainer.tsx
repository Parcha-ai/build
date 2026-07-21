import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useSessionStore, withMaterializedSession, type BackgroundTask } from '../../stores/session.store';
import { useAudioStore } from '../../stores/audio.store';
import { useUIStore } from '../../stores/ui.store';
import MessageList from './MessageList';
import InputArea from './InputArea';
import PermissionDialog from './PermissionDialog';
import QuestionDialog from './QuestionDialog';
import ThinkingBlock from './ThinkingBlock';
import TasksBlock, { type Task } from './TasksBlock';
import BackgroundTasksBlock from './BackgroundTasksBlock';
import MonitorBlock from './MonitorBlock';
import BtwOverlay from './BtwOverlay';
// CodexOverlay removed — Codex runs as a model in the existing chat
import RemoteControlPanel from './RemoteControlPanel';
// CompactionBar removed - compaction status now shown in ThinkingBlock
import { SoundVisualization } from './SoundVisualization';
import HistoryPanel from './HistoryPanel';
import TokenDashboard from '../analytics/TokenDashboard';
import { ArrowDown, History, GitBranch, Circle, ExternalLink, X } from 'lucide-react';
import type { Session, ToolCall } from '../../../shared/types';
import { GSTACK_MODE_META } from '../../../shared/types';
import { canSendMessageToSession } from '../../utils/session-input';
import { getSessionDisplayName } from '../../utils/session-display';

function SessionGitInfo({ sessionId }: { sessionId: string }) {
  const [gitInfo, setGitInfo] = useState<{
    branch?: string;
    isDirty: boolean;
    changedFiles: number;
    prNumber?: number;
    prUrl?: string;
  } | null>(null);

  // Check if this is an SSH session — skip polling for SSH to avoid
  // redundant remote git calls (branch is already refreshed by SessionCard)
  const isSSH = useSessionStore(useCallback(
    (s) => !!(s.sessions.find(sess => sess.id === sessionId)?.sshConfig),
    [sessionId]
  ));

  useEffect(() => {
    // Skip git status polling entirely for SSH sessions — branch info
    // is already refreshed by SessionCard's own interval, and polling
    // git:status for SSH triggers expensive remote SSH exec calls
    if (isSSH) return;

    let cancelled = false;

    const fetchGitInfo = async () => {
      try {
        const status = await withMaterializedSession(sessionId, async () => {
          return window.electronAPI?.git?.getStatus(sessionId);
        });
        if (cancelled || !status) return;

        const info: typeof gitInfo = {
          branch: status.current || undefined,
          isDirty: (status.files?.length || 0) > 0,
          changedFiles: status.files?.length || 0,
        };

        // Check for PR on this branch via transcript pr-link entries
        const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
        const messages = useSessionStore.getState().messages[sessionId] || [];
        // Look for PR references in recent assistant messages
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 20); i--) {
          const msg = messages[i];
          if (!msg?.content || typeof msg.content !== 'string') continue;
          const prMatch = msg.content.match(/(?:PR|pull request)\s*#(\d+)/i)
            || msg.content.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
          if (prMatch) {
            info.prNumber = parseInt(prMatch[1]);
            const repoMatch = msg.content.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)/);
            info.prUrl = repoMatch?.[1];
            break;
          }
        }

        if (!cancelled) setGitInfo(info);
      } catch {
        // Git status not available (e.g., not a git repo)
      }
    };

    fetchGitInfo();
    const interval = setInterval(fetchGitInfo, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId, isSSH]);

  if (!gitInfo) return null;

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {gitInfo.branch && (
        <span className="flex items-center gap-1 text-[10px] text-claude-text-secondary font-mono">
          <GitBranch size={10} />
          {gitInfo.branch}
        </span>
      )}
      {gitInfo.isDirty && (
        <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-400" title={`${gitInfo.changedFiles} changed file${gitInfo.changedFiles === 1 ? '' : 's'}`}>
          <Circle size={6} fill="currentColor" />
          {gitInfo.changedFiles}
        </span>
      )}
      {gitInfo.prNumber && (
        <button
          onClick={() => {
            if (gitInfo.prUrl) {
              window.electronAPI?.app?.openExternal?.(gitInfo.prUrl);
            }
          }}
          className="flex items-center gap-0.5 text-[10px] font-bold text-blue-400 hover:text-blue-300"
          title={gitInfo.prUrl || `PR #${gitInfo.prNumber}`}
        >
          PR #{gitInfo.prNumber}
          {gitInfo.prUrl && <ExternalLink size={8} />}
        </button>
      )}
    </div>
  );
}

interface ChatContainerProps {
  session: Session;
  onClosePane?: () => void;
}

// Stable empty arrays/objects to avoid reference changes when session data is missing
const EMPTY_MESSAGES: never[] = [];
const EMPTY_EVENTS: never[] = [];
const EMPTY_TOOL_CALLS: never[] = [];
const EMPTY_QUEUE: never[] = [];
const EMPTY_BG_TASKS: never[] = [];
const EMPTY_MONITORS: never[] = [];

export default function ChatContainer({ session, onClosePane }: ChatContainerProps) {
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
  const sessionMonitors = useSessionStore(useCallback((s) => s.monitorInstances[session.id] || EMPTY_MONITORS, [session.id]));
  const isLoadingMessages = useSessionStore(useCallback((s) => s.isLoadingMessages[session.id] || false, [session.id]));
  const btwState = useSessionStore(useCallback((s) => s.btw[session.id] || null, [session.id]));
  const rcState = useSessionStore(useCallback((s) => s.remoteControl[session.id] || null, [session.id]));
  // Codex second opinion state
  // Codex overlay state removed — Codex runs as a model in the existing chat

  // Action selectors — stable references, never cause re-renders
  const approvePermission = useSessionStore((s) => s.approvePermission);
  const denyPermission = useSessionStore((s) => s.denyPermission);
  const answerQuestion = useSessionStore((s) => s.answerQuestion);
  const cancelQuestion = useSessionStore((s) => s.cancelQuestion);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const addBackgroundTask = useSessionStore((s) => s.addBackgroundTask);
  const removeBackgroundTask = useSessionStore((s) => s.removeBackgroundTask);
  const approvePermissionAsBackground = useSessionStore((s) => s.approvePermissionAsBackground);
  const dismissBtw = useSessionStore((s) => s.dismissBtw);
  // Codex overlay actions removed — Codex runs as a model in the existing chat
  // clearRemoteControl removed — stopRemoteControl handles both IPC kill + state clear

  const audioModeActive = useAudioStore((s) => s.audioModeActive);
  const ttsStates = useAudioStore((s) => s.ttsStates);
  const toggleTerminalPanel = useUIStore((s) => s.toggleTerminalPanel);
  const isTerminalPanelOpen = useUIStore((s) => s.isTerminalPanelOpen);
  const isHistoryPanelOpen = useUIStore((s) => s.isHistoryPanelOpen);
  const toggleHistoryPanel = useUIStore((s) => s.toggleHistoryPanel);
  const isAnalyticsPanelOpen = useUIStore((s) => s.isAnalyticsPanelOpen);
  const toggleAnalyticsPanel = useUIStore((s) => s.toggleAnalyticsPanel);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const lastMessageCountRef = useRef(0);
  const prevIsLoadingMessagesRef = useRef(isLoadingMessages);
  const lastScrollTop = useRef(0);
  const lastScrollTime = useRef(Date.now());
  const fastScrollCount = useRef(0);
  const fastScrollResetTimer = useRef<NodeJS.Timeout | null>(null);

  const isAudioMode = audioModeActive[session.id] || false;
  const currentPermissionRequest = currentPermission;
  const currentQuestionRequest = currentQuestion;
  const currentCompactionStatus = compaction;
  const sessionBackgroundTasks = sessionBgTasks;

  // Check if any TTS is actively playing for messages in this session
  const isTTSPlaying = sessionMessages.some(msg => msg?.id && ttsStates[msg.id]?.isPlaying);

  // Handler to background a running Bash command. Clean path: when the Bash
  // call is waiting on a permission prompt, approve it with
  // `run_in_background: true` so the SDK spawns the shell detached. The
  // resulting shell_id flows through the normal tool_result path and the
  // MonitorBlock picks it up from there.
  //
  // When there is NO pending permission (permission mode = auto-approve and
  // the shell is already running in-band) the clean path doesn't apply — we
  // surface that as a console warning instead of pretending the button did
  // something. A future change can add a "cancel and re-run" blunt path.
  const handleBackgroundTask = useCallback(async (toolCall: ToolCall) => {
    const moved = await approvePermissionAsBackground(session.id);
    if (!moved) {
      console.warn(
        '[ChatContainer] BG button pressed but no pending Bash permission to modify. ' +
          'This tool is already running in-band. Either set permission mode to "prompt" ' +
          'or ask the model to rerun with run_in_background: true.',
        { toolCallId: toolCall.id }
      );
    }
  }, [session.id, approvePermissionAsBackground]);

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
    const recentMessages = sessionMessages.slice(-40);

    // Look for TaskList result first (gives complete picture)
    const taskListCall = [...streamingToolCalls]
      .reverse()
      .find(tc => tc.name === 'TaskList' && tc.result);

    if (taskListCall?.result) {
      // TaskList returns an array of tasks (or might be wrapped in an object)
      const taskListResult = taskListCall.result;

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
    for (const msg of recentMessages) {
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
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const msg = recentMessages[i];
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

  // Auto-scroll when user is at the bottom of the chat.
  // Scrolling up always works — auto-scroll only resumes when you scroll back to the bottom.
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isAtBottom) {
      const streaming = isSessionStreaming && (streamContent || thinkingContent);
      if (!scrollTimerRef.current) {
        scrollTimerRef.current = setTimeout(() => {
          isProgrammaticScroll.current = true;
          if (streaming) {
            // During active streaming, use instant scroll — smooth can't keep up
            const container = messagesContainerRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          } else {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }
          setTimeout(() => { isProgrammaticScroll.current = false; }, streaming ? 30 : 500);
          scrollTimerRef.current = null;
        }, streaming ? 30 : 100);
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

  // Transcript reloads should always land on the latest messages first.
  useEffect(() => {
    if (prevIsLoadingMessagesRef.current && !isLoadingMessages && sessionMessages.length > 0) {
      setTimeout(() => {
        isProgrammaticScroll.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        setIsAtBottom(true);
        setShowScrollButton(false);
        setHasNewContent(false);
      }, 0);
    }

    prevIsLoadingMessagesRef.current = isLoadingMessages;
  }, [isLoadingMessages, sessionMessages.length]);

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
    <div className="flex-1 flex overflow-hidden min-w-0">
    <div className={`flex-1 flex flex-col overflow-hidden font-mono bg-claude-bg min-w-0 ${isHistoryPanelOpen ? '' : ''}`}>
      {/* Header - brutalist */}
      <div className="h-10 border-b border-claude-border flex items-center justify-between px-4 bg-claude-surface/50">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-bold text-claude-text uppercase truncate" style={{ letterSpacing: '0.1em' }}>
            {getSessionDisplayName(session)}
          </h2>
          {session.status === 'running' && (
            <span
              className="px-1.5 py-0.5 text-xs font-bold uppercase bg-green-500/20 text-green-500 flex-shrink-0"
              style={{ borderRadius: 0, letterSpacing: '0.05em' }}
            >
              ACTIVE
            </span>
          )}
          {session.status === 'error' && (
            <span
              className="px-1.5 py-0.5 text-xs font-bold uppercase bg-red-500/20 text-red-500 flex-shrink-0"
              style={{ borderRadius: 0, letterSpacing: '0.05em' }}
            >
              ERROR
            </span>
          )}
          <SessionGitInfo sessionId={session.id} />
        </div>

        <div className="flex items-center gap-2">
          {onClosePane && (
            <button
              onClick={onClosePane}
              className="p-1.5 text-claude-text-secondary hover:text-claude-text hover:bg-claude-bg transition-colors"
              title="Close split pane"
              aria-label="Close split pane"
            >
              <X size={14} />
            </button>
          )}
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

          {/* History panel toggle */}
          <button
            onClick={toggleHistoryPanel}
            className={`p-1.5 transition-colors ${
              isHistoryPanelOpen
                ? 'text-orange-400 bg-orange-500/10'
                : 'text-claude-text-secondary hover:text-claude-text'
            }`}
            title="Toggle history panel"
          >
            <History size={14} />
          </button>
        </div>
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
                    // Open the terminal panel in Build
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
          sessionId={session.id}
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

      {/* Monitor section - above tasks (streaming background watches) */}
      {sessionMonitors.filter(m => m.active || m.persistent).length > 0 && (
        <div className="border-t border-claude-border bg-claude-surface/30 px-4 py-2">
          <MonitorBlock
            monitors={sessionMonitors.filter(m => m.active || m.persistent)}
          />
        </div>
      )}

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
            onBuildIt={() => {
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
            onCancel={() => cancelQuestion(session.id)}
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
        disabled={!canSendMessageToSession(session)}
        systemInfo={systemInfo}
        isStreaming={isSessionStreaming}
      />
    </div>

    {/* History Panel - slides in from the right */}
    {isHistoryPanelOpen && (
      <div className="w-80 shrink-0 border-l border-claude-border">
        <HistoryPanel sessionId={session.id} />
      </div>
    )}

    {/* Analytics Panel - slides in from the right */}
    {isAnalyticsPanelOpen && (
      <div className="w-96 shrink-0 border-l border-claude-border">
        <TokenDashboard onClose={toggleAnalyticsPanel} />
      </div>
    )}
    </div>
  );
}
