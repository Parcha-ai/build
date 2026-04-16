import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/constants/channels';
import type {
  Session,
  GitHubRepo,
  GitHubUser,
  Commit,
  Branch,
  ChatMessage,
  AppSettings,
  DOMElementContext,
  TranscriptionResult,
  TTSRequest,
  AudioSettings,
  SSHConfig,
  SSHResumeCandidate,
  DownloadSessionConfig,
  MCPServerInfo,
  MarketplaceMCPServer,
  PopularMarketplace,
  PluginMarketplace,
  InstalledPlugin,
  MarketplacePlugin
} from '../shared/types';

// Dev instance name from environment variable (set by scripts/dev.sh)
const DEV_INSTANCE_NAME = process.env.DEV_INSTANCE_NAME || null;

// Type-safe API for renderer process
const electronAPI = {
  // App info
  devInstanceName: DEV_INSTANCE_NAME,

  // Auth
  auth: {
    login: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
    getUser: (): Promise<GitHubUser | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_USER),
    getRepos: (): Promise<GitHubRepo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_REPOS),
    checkProviders: (): Promise<{
      claude: { loggedIn: boolean; method?: 'cli' | 'apiKey' | 'chatgpt'; detail?: string };
      codex: { loggedIn: boolean; method?: 'cli' | 'apiKey' | 'chatgpt'; detail?: string };
    }> => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CHECK_PROVIDERS),
    onOAuthCallback: (callback: (data: { code: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { code: string }) => callback(data);
      ipcRenderer.on('auth:oauth-callback', handler);
      return () => ipcRenderer.removeListener('auth:oauth-callback', handler);
    },
  },

  // Sessions
  sessions: {
    create: (config: {
      name: string;
      repoUrl: string;
      branch: string;
      setupScript?: string;
    }): Promise<Session> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, config),
    start: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_START, sessionId),
    stop: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_STOP, sessionId),
    delete: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
    list: (): Promise<Session[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
    get: (sessionId: string): Promise<Session | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),
    update: (sessionId: string, updates: Partial<Session>): Promise<Session> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, sessionId, updates),
    rewindAndFork: (sessionId: string, rewindToMessageId: string): Promise<Session> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_REWIND_FORK, sessionId, rewindToMessageId),
    createFork: (parentSessionId: string, forkPoint: string, initialMessage?: string): Promise<Session> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE_FORK, parentSessionId, forkPoint, initialMessage),
    getForkGroup: (sessionId: string): Promise<Session[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_FORK_GROUP, sessionId),
    onStatusChanged: (callback: (session: Session) => void) => {
      const handler = (_: IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on(IPC_CHANNELS.SESSION_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_STATUS_CHANGED, handler);
    },
    onListUpdated: (callback: (sessions: Session[]) => void) => {
      const handler = (_: IpcRendererEvent, sessions: Session[]) => callback(sessions);
      ipcRenderer.on(IPC_CHANNELS.SESSION_LIST_UPDATED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_LIST_UPDATED, handler);
    },
  },

  // Terminal
  terminal: {
    create: (sessionId: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, sessionId),
    sendInput: (terminalId: string, data: string): void =>
      ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, terminalId, data),
    resize: (terminalId: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, terminalId, cols, rows),
    close: (terminalId: string): void =>
      ipcRenderer.send(IPC_CHANNELS.TERMINAL_CLOSE, terminalId),
    onOutput: (terminalId: string, callback: (data: string) => void) => {
      const channel = `${IPC_CHANNELS.TERMINAL_OUTPUT}:${terminalId}`;
      const handler = (_: IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // Git
  git: {
    getStatus: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, sessionId),
    getLog: (sessionId: string, limit?: number): Promise<Commit[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_LOG, sessionId, limit),
    getBranches: (sessionId: string): Promise<Branch[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCHES, sessionId),
    checkout: (sessionId: string, branch: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT, sessionId, branch),
    getDiff: (sessionId: string, commitHash?: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, sessionId, commitHash),
    commit: (sessionId: string, message: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, sessionId, message),
    push: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, sessionId),
    pull: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, sessionId),
    clone: (url: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_CLONE, url, path),
    // Get current branch for SSH sessions (remote git query)
    getRemoteBranch: (sessionId: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_REMOTE_BRANCH, sessionId),
    // Branch watching
    watchBranch: (sessionId: string): Promise<{ success: boolean; branch?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_WATCH_BRANCH, sessionId),
    unwatchBranch: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_UNWATCH_BRANCH, sessionId),
    onBranchChanged: (callback: (data: { sessionId: string; branch: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; branch: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.GIT_BRANCH_CHANGED, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.GIT_BRANCH_CHANGED, handler); };
    },
  },

  // Claude
  claude: {
    sendMessage: (sessionId: string, message: string, attachments?: unknown[], permissionMode?: string, thinkingMode?: string, model?: string, gstackMode?: string, supplementalMessages?: ChatMessage[]): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SEND_MESSAGE, sessionId, message, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages),
    getMessages: (sessionId: string, limit?: number): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_MESSAGES, sessionId, limit),
    getModels: (): Promise<Array<{ id: string; name: string; description: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_MODELS),
    cancel: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CANCEL, sessionId),
    onStreamChunk: (callback: (chunk: { sessionId: string; content: string; agentId?: string }) => void) => {
      const handler = (_: IpcRendererEvent, chunk: { sessionId: string; content: string; agentId?: string }) => callback(chunk);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_STREAM_CHUNK, handler);
    },
    onThinkingChunk: (callback: (chunk: { sessionId: string; content: string }) => void) => {
      const handler = (_: IpcRendererEvent, chunk: { sessionId: string; content: string }) => callback(chunk);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_THINKING_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_THINKING_CHUNK, handler);
    },
    onStreamEnd: (callback: (data: { sessionId: string; message: ChatMessage }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; message: ChatMessage }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_STREAM_END, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_STREAM_END, handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_STREAM_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_STREAM_ERROR, handler);
    },
    onToolCall: (callback: (data: { sessionId: string; toolCall: unknown; agentId?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; toolCall: unknown; agentId?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_CALL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_CALL, handler);
    },
    onToolResult: (callback: (data: { sessionId: string; toolCall: unknown; agentId?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; toolCall: unknown; agentId?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_RESULT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_RESULT, handler);
    },
    onSystemInfo: (callback: (data: { sessionId: string; systemInfo: { tools: string[]; model: string } }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; systemInfo: { tools: string[]; model: string } }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, handler);
    },
    // Permission request listener
    onPermissionRequest: (callback: (request: any) => void) => {
      const handler = (_: IpcRendererEvent, request: any) => callback(request);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, handler);
    },
    // Send permission response
    respondToPermission: (response: { requestId: string; approved: boolean; modifiedInput?: Record<string, unknown>; alwaysApprove?: boolean }): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PERMISSION_RESPONSE, response),
    // Question request listener
    onQuestionRequest: (callback: (request: any) => void) => {
      const handler = (_: IpcRendererEvent, request: any) => callback(request);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_QUESTION_REQUEST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_QUESTION_REQUEST, handler);
    },
    // Send question response
    respondToQuestion: (response: { requestId: string; answers: Record<string, string> }): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_QUESTION_RESPONSE, response),
    // Task notification (background task completed/failed/stopped)
    onTaskNotification: (callback: (data: { sessionId: string; taskId?: string; status?: string; outputFile?: string; summary?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, handler);
    },
    // Task progress (intermediate background task / tool progress)
    onTaskProgress: (callback: (data: { sessionId: string; taskId?: string; toolUseId?: string; toolName?: string; description?: string; summary?: string; elapsedSeconds?: number }) => void) => {
      const handler = (_: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, handler);
    },
    // Compaction status listener (Smart Compact feature)
    onCompactionStatus: (callback: (status: { sessionId: string; isCompacting: boolean; smartCompact?: { enabled: boolean; originalModel: string; compactingModel: string; reason: string }; preTokens?: number; trigger?: string }) => void) => {
      const handler = (_: IpcRendererEvent, status: any) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, handler);
    },
    // Compaction complete listener
    onCompactionComplete: (callback: (complete: { sessionId: string; preTokens: number; postTokens?: number; smartCompact?: { modelSwitched: boolean; restoredModel: string } }) => void) => {
      const handler = (_: IpcRendererEvent, complete: any) => callback(complete);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, handler);
    },
    // Context usage listener (token count / context window percentage)
    onContextUsage: (callback: (data: { sessionId: string; inputTokens: number; contextWindowSize: number; percentage: number }) => void) => {
      const handler = (_: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, handler);
    },
    // Plan content listener (when plan file is written)
    onPlanContent: (callback: (data: { sessionId: string; planContent: string; planFilePath: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; planContent: string; planFilePath: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_PLAN_CONTENT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_PLAN_CONTENT, handler);
    },
    // Auto-resume for Build It mode
    saveAutoResumeState: (state: { sessionId: string; wasStreaming: boolean; permissionMode: string; lastMessage?: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTO_RESUME_SAVE_STATE, state),
    getAutoResumeState: (): Promise<{ sessionId: string; wasStreaming: boolean; permissionMode: string; lastMessage?: string; timestamp: number } | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTO_RESUME_GET_STATE),
    clearAutoResumeState: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTO_RESUME_CLEAR_STATE),
    // Plan approval request listener (when ExitPlanMode is called)
    onPlanApprovalRequest: (callback: (data: { sessionId: string; requestId: string; planContent: string; planFilePath?: string; allowedPrompts?: Array<{ tool: string; prompt: string }> }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; requestId: string; planContent: string; planFilePath?: string; allowedPrompts?: Array<{ tool: string; prompt: string }> }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_REQUEST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_REQUEST, handler);
    },
    // Send plan approval response
    respondToPlanApproval: (response: { requestId: string; approved: boolean }): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_RESPONSE, response),
    // Inject message into active query (for async queue processing)
    injectMessage: (sessionId: string, message: string, attachments?: unknown[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_INJECT_MESSAGE, sessionId, message, attachments),
    // Check if session has an active query
    hasActiveQuery: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_HAS_ACTIVE_QUERY, sessionId),
    // Update permission mode mid-stream (used by GREP IT! button)
    setPermissionMode: (sessionId: string, mode: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SET_PERMISSION_MODE, sessionId, mode),
    // Listen for permission mode changes from main process (e.g., after plan approval)
    onPermissionModeChanged: (callback: (data: { sessionId: string; mode: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; mode: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_PERMISSION_MODE_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_PERMISSION_MODE_CHANGED, handler);
    },
    // Background task output listener
    onBackgroundTaskOutput: (callback: (data: { sessionId: string; taskId: string; output: string; status: 'running' | 'completed' | 'error'; completedAt?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; taskId: string; output: string; status: 'running' | 'completed' | 'error'; completedAt?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_BACKGROUND_TASK_OUTPUT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_BACKGROUND_TASK_OUTPUT, handler);
    },
    // Ephemeral side question (/btw)
    askBtw: (sessionId: string, question: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_BTW_ASK, sessionId, question),
    onBtwResponse: (callback: (data: { sessionId: string; content: string; done: boolean }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; content: string; done: boolean }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, handler);
    },
    // Remote control — start/stop
    startRc: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_RC_START, sessionId),
    stopRc: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_RC_STOP, sessionId),
    // Remote control session events
    onRcStarted: (callback: (data: { sessionId: string; url: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; url: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_RC_STARTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_RC_STARTED, handler);
    },
    onRcStopped: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_RC_STOPPED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_RC_STOPPED, handler);
    },
  },

  // Browser Preview
  browser: {
    injectInspector: (webviewId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_INJECT_INSPECTOR, webviewId),
    onElementSelected: (callback: (element: DOMElementContext) => void) => {
      const handler = (_: IpcRendererEvent, element: DOMElementContext) => callback(element);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_ELEMENT_SELECTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_ELEMENT_SELECTED, handler);
    },
    captureSnapshot: (sessionId: string, url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CAPTURE_SNAPSHOT, sessionId, url),
    navigateTo: (sessionId: string, url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE_TO, sessionId, url),
    getSnapshot: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_SNAPSHOT, sessionId),
    onCaptureRequest: (callback: (data: { sessionId: string; requestId?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; requestId?: string }) => callback(data);
      ipcRenderer.on('browser:capture-snapshot', handler);
      return () => ipcRenderer.removeListener('browser:capture-snapshot', handler);
    },
    onNavigate: (callback: (data: { sessionId: string; url: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; url: string }) => callback(data);
      ipcRenderer.on('browser:navigate', handler);
      return () => {
        ipcRenderer.removeListener('browser:navigate', handler);
      };
    },
    onAction: (callback: (data: { sessionId: string; requestId: string; action: string; params: Record<string, unknown> }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; requestId: string; action: string; params: Record<string, unknown> }) => callback(data);
      ipcRenderer.on('browser:action', handler);
      return () => ipcRenderer.removeListener('browser:action', handler);
    },
    sendSnapshotData: (snapshot: any) => {
      ipcRenderer.send('browser:snapshot-captured', snapshot);
    },
    sendActionResult: (result: { requestId: string; success: boolean; data?: any; error?: string }) => {
      ipcRenderer.send('browser:action-result', result);
    },
    clearStorage: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_STORAGE),
    registerWebview: (sessionId: string, webContentsId: number) => {
      ipcRenderer.send('browser:register-webview', { sessionId, webContentsId });
    },
    unregisterWebview: (sessionId: string) => {
      ipcRenderer.send('browser:unregister-webview', { sessionId });
    },
    onAutomationEvent: (callback: (data: { sessionId: string; type: string; action: string; data?: Record<string, unknown> }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; type: string; action: string; data?: Record<string, unknown> }) => callback(data);
      ipcRenderer.on('browser:automation-event', handler);
      return () => ipcRenderer.removeListener('browser:automation-event', handler);
    },
    // Stagehand browser update events (screenshot + URL changes)
    onBrowserUpdate: (callback: (data: { sessionId: string; screenshot: string; url?: string; timestamp: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; screenshot: string; url?: string; timestamp: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_UPDATE, handler);
    },
    // Request to open browser panel (from main process for Stagehand)
    onBrowserOpenPanel: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_OPEN_PANEL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_OPEN_PANEL, handler);
    },
  },

  // Settings
  settings: {
    get: (): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Partial<AppSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),
    reset: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET),
    getApiKey: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_API_KEY),
    setApiKey: (key: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_API_KEY, key),
    getGoogleApiKey: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_GOOGLE_API_KEY),
    setGoogleApiKey: (key: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_GOOGLE_API_KEY, key),
  },

  // App
  app: {
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, url),
    openPath: (filePath: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_PATH, filePath),
    getPath: (name: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, name),
    showDialog: (options: unknown): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_DIALOG, options),
    onCmdRPressed: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.APP_CMD_R_PRESSED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.APP_CMD_R_PRESSED, handler);
      };
    },
    onShortcutTriggered: (callback: (data: { action: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { action: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_SHORTCUT_TRIGGERED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.APP_SHORTCUT_TRIGGERED, handler);
      };
    },
    openBrowserWindow: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_BROWSER_WINDOW),
    closeBrowserWindow: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CLOSE_BROWSER_WINDOW),
    onBrowserWindowClosed: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('browser-window-closed', handler);
      return () => {
        ipcRenderer.removeListener('browser-window-closed', handler);
      };
    },
  },

  // Docker
  docker: {
    getStatus: (): Promise<{ available: boolean; version?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCKER_STATUS),
    getContainerStats: (containerId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCKER_CONTAINER_STATS, containerId),
  },

  // Dev Mode
  dev: {
    openLocalRepo: (): Promise<{
      success: boolean;
      canceled?: boolean;
      error?: string;
      repoPath?: string;
      branch?: string;
      name?: string;
      needsGitInit?: boolean;
      isGit?: boolean;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_OPEN_LOCAL_REPO),
    initGit: (repoPath: string): Promise<{
      success: boolean;
      branch?: string;
      error?: string;
    }> => ipcRenderer.invoke('dev:init-git', repoPath),
    checkGitRepo: (repoPath: string): Promise<{
      isGit: boolean;
      branch?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_CHECK_GIT_REPO, repoPath),
    getBranches: (repoPath: string): Promise<{
      success: boolean;
      branches: Array<{ name: string; current: boolean }>;
      currentBranch?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_GET_BRANCHES, repoPath),
    createSession: (data: {
      name: string;
      repoPath: string;
      branch: string;
      createWorktree?: boolean;
    }): Promise<Session> => ipcRenderer.invoke(IPC_CHANNELS.DEV_CREATE_SESSION, data),
    createTeleportSession: (data: {
      sessionId: string;
      name: string;
      cwd: string;
    }): Promise<Session> => ipcRenderer.invoke(IPC_CHANNELS.DEV_CREATE_TELEPORT_SESSION, data),
    checkClaudeCli: (): Promise<{ installed: boolean; path: string | null; version: string | null }> =>
      ipcRenderer.invoke(IPC_CHANNELS.DEV_CHECK_CLAUDE_CLI),
    getActiveSession: (): Promise<string | null> =>
      ipcRenderer.invoke('dev:get-active-session'),
    setActiveSession: (sessionId: string | null): Promise<void> =>
      ipcRenderer.invoke('dev:set-active-session', sessionId),
    getDevMode: (): Promise<boolean> =>
      ipcRenderer.invoke('dev:get-dev-mode'),
    setDevMode: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('dev:set-dev-mode', enabled),
    checkWorktreeSetup: (repoPath: string): Promise<{
      success: boolean;
      hasScript: boolean;
      hasInstructions: boolean;
      scriptPath?: string;
      instructionsPath?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_CHECK_WORKTREE_SETUP, repoPath),
    saveWorktreeScript: (data: { repoPath: string; sourcePath: string }): Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_SAVE_WORKTREE_SCRIPT, data),
    saveWorktreeInstructions: (data: { repoPath: string; instructions: string }): Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_SAVE_WORKTREE_INSTRUCTIONS, data),
    executeWorktreeSetup: (data: { repoPath: string; worktreePath: string }): Promise<{
      success: boolean;
      type?: 'script' | 'instructions' | 'none';
      output?: string;
      error?: string;
      instructions?: string;
      message?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.DEV_EXECUTE_WORKTREE_SETUP, data),
    getRegisteredWebviews: (): Promise<{ success: boolean; webviews: Array<[string, number]> }> =>
      ipcRenderer.invoke('dev:get-registered-webviews'),
    onSetupProgress: (callback: (data: { sessionId: string; status: 'running' | 'completed' | 'error'; message?: string; output?: string; error?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; status: 'running' | 'completed' | 'error'; message?: string; output?: string; error?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.DEV_SETUP_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.DEV_SETUP_PROGRESS, handler);
    },
  },

  // File System
  fs: {
    listFiles: (sessionId: string, query?: string): Promise<Array<{
      name: string;
      path: string;
      relativePath: string;
      type: 'file' | 'folder';
      extension?: string;
    }>> => ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_FILES, sessionId, query),
    readFile: (filePath: string, sessionId?: string): Promise<{ success: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_READ_FILE, filePath, sessionId),
    writeFile: (filePath: string, content: string, sessionId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_FILE, filePath, content, sessionId),
    searchFiles: (
      sessionId: string,
      searchTerm: string,
      options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; maxResults?: number }
    ): Promise<Array<{
      filePath: string;
      relativePath: string;
      fileName: string;
      matches: Array<{ lineNumber: number; lineContent: string }>;
      matchCount: number;
    }>> => ipcRenderer.invoke(IPC_CHANNELS.FS_SEARCH_FILES, sessionId, searchTerm, options),
    searchSymbols: (sessionId: string, query: string): Promise<Array<{
      name: string;
      kind: string;
      path: string;
      relativePath: string;
      lineNumber: number;
      detail: string;
    }>> => ipcRenderer.invoke(IPC_CHANNELS.FS_SEARCH_SYMBOLS, sessionId, query),
  },

  // Audio
  audio: {
    transcribe: (audioData: ArrayBuffer, language?: string): Promise<{ success: boolean; result?: TranscriptionResult; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_TRANSCRIBE, audioData, language),
    streamTTS: (request: TTSRequest): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_TTS_STREAM, request),
    cancelTTS: (messageId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_TTS_CANCEL, messageId),
    getVoices: (): Promise<{ success: boolean; voices?: Array<{ voice_id: string; name: string }>; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_GET_VOICES),
    getSettings: (): Promise<AudioSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SETTINGS_GET),
    setSettings: (settings: Partial<AudioSettings>): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SETTINGS_SET, settings),
    onTTSChunk: (callback: (data: { messageId: string; chunk: number[] }) => void) => {
      const handler = (_: IpcRendererEvent, data: { messageId: string; chunk: number[] }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.AUDIO_TTS_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIO_TTS_CHUNK, handler);
    },
    onTTSComplete: (callback: (data: { messageId: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { messageId: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.AUDIO_TTS_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIO_TTS_COMPLETE, handler);
    },
    onTTSError: (callback: (data: { messageId: string; error: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { messageId: string; error: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.AUDIO_TTS_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIO_TTS_ERROR, handler);
    },
    // API Key management
    getElevenLabsKey: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_GET_ELEVENLABS_KEY),
    setElevenLabsKey: (key: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SET_ELEVENLABS_KEY, key),
    getOpenAiKey: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_GET_OPENAI_KEY),
    setOpenAiKey: (key: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_SET_OPENAI_KEY, key),
    // Microphone permission (macOS)
    checkMicrophonePermission: (): Promise<{ status: string; granted: boolean; canRequest: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_CHECK_MICROPHONE_PERMISSION),
    requestMicrophonePermission: (): Promise<{ success: boolean; granted: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.AUDIO_REQUEST_MICROPHONE_PERMISSION),
  },

  // Realtime API for streaming transcription
  realtime: {
    connect: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REALTIME_CONNECT),
    disconnect: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REALTIME_DISCONNECT),
    sendAudio: (audioData: number[]): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REALTIME_SEND_AUDIO, audioData),
    commitAudio: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REALTIME_COMMIT_AUDIO),
    clearAudio: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REALTIME_CLEAR_AUDIO),
    onConnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.REALTIME_CONNECTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_CONNECTED, handler);
    },
    onDisconnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.REALTIME_DISCONNECTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_DISCONNECTED, handler);
    },
    onTranscriptionDelta: (callback: (delta: string) => void) => {
      const handler = (_: IpcRendererEvent, delta: string) => callback(delta);
      ipcRenderer.on(IPC_CHANNELS.REALTIME_TRANSCRIPTION_DELTA, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_TRANSCRIPTION_DELTA, handler);
    },
    onTranscriptionCompleted: (callback: (transcript: string) => void) => {
      const handler = (_: IpcRendererEvent, transcript: string) => callback(transcript);
      ipcRenderer.on(IPC_CHANNELS.REALTIME_TRANSCRIPTION_COMPLETED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_TRANSCRIPTION_COMPLETED, handler);
    },
    onSpeechStarted: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.REALTIME_SPEECH_STARTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_SPEECH_STARTED, handler);
    },
    onSpeechStopped: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.REALTIME_SPEECH_STOPPED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_SPEECH_STOPPED, handler);
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_: IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on(IPC_CHANNELS.REALTIME_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.REALTIME_ERROR, handler);
    },
  },

  // Extensions (commands, skills, agents)
  extensions: {
    scanCommands: (options?: { sessionId?: string; projectPath?: string } | string) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_SCAN_COMMANDS, options),
    scanSkills: (options?: { sessionId?: string; projectPath?: string } | string) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_SCAN_SKILLS, options),
    scanAgents: (options?: { sessionId?: string; projectPath?: string } | string) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_SCAN_AGENTS, options),
    getCommand: (commandName: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_GET_COMMAND, commandName, projectPath),
    installSkill: (source: string, options?: { global?: boolean; skills?: string[]; projectPath?: string; sessionId?: string }): Promise<{ success: boolean; output: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_INSTALL_SKILL, source, options),
    listAvailableSkills: (source: string): Promise<{ success: boolean; skills?: Array<{ name: string; description?: string }>; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXTENSION_LIST_AVAILABLE_SKILLS, source),
  },

  // Voice mode (ElevenLabs Conversational AI)
  voice: {
    connect: (config: { agentId: string; systemPrompt?: string; sessionContext?: Record<string, unknown> }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_CONNECT, config),
    disconnect: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_DISCONNECT),
    sendAudio: (audioData: number[]): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_SEND_AUDIO, audioData),
    sendText: (text: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_SEND_TEXT, text),
    endInput: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_END_INPUT),
    clearAudioBuffer: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_CLEAR_AUDIO_BUFFER),
    sendContextUpdate: (context: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_CONTEXT_UPDATE, context),
    onConnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.VOICE_CONNECTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_CONNECTED, handler);
    },
    onDisconnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.VOICE_DISCONNECTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_DISCONNECTED, handler);
    },
    onReconnecting: (callback: (data: { attempt: number; maxAttempts: number }) => void) => {
      const handler = (_: IpcRendererEvent, data: { attempt: number; maxAttempts: number }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.VOICE_RECONNECTING, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RECONNECTING, handler);
    },
    onUserTranscript: (callback: (data: { text: string; isFinal: boolean }) => void) => {
      const handler = (_: IpcRendererEvent, data: { text: string; isFinal: boolean }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.VOICE_USER_TRANSCRIPT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_USER_TRANSCRIPT, handler);
    },
    onAgentResponse: (callback: (text: string) => void) => {
      const handler = (_: IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on(IPC_CHANNELS.VOICE_AGENT_RESPONSE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_AGENT_RESPONSE, handler);
    },
    onAudioChunk: (callback: (data: { data: number[]; eventId: number }) => void) => {
      const handler = (_: IpcRendererEvent, data: { data: number[]; eventId: number }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.VOICE_AUDIO_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_AUDIO_CHUNK, handler);
    },
    onInterruption: (callback: (reason: string) => void) => {
      const handler = (_: IpcRendererEvent, reason: string) => callback(reason);
      ipcRenderer.on(IPC_CHANNELS.VOICE_INTERRUPTION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_INTERRUPTION, handler);
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_: IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on(IPC_CHANNELS.VOICE_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_ERROR, handler);
    },
    onToolCall: (callback: (data: { toolCallId: string; toolName: string; parameters: Record<string, unknown> }) => void) => {
      const handler = (_: IpcRendererEvent, data: { toolCallId: string; toolName: string; parameters: Record<string, unknown> }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.VOICE_TOOL_CALL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_TOOL_CALL, handler);
    },
    sendToolResult: (data: { toolCallId: string; result: string; isError?: boolean }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_TOOL_RESULT, data),
    updateAgentPrompt: (data: { agentId: string; prompt: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_UPDATE_AGENT_PROMPT, data),
    sendUserActivity: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_USER_ACTIVITY),
    // Get signed URL for SDK-based WebSocket connection
    getSignedUrl: (config: { agentId: string }): Promise<{ success: boolean; signedUrl?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_SIGNED_URL, config),
    // Get conversation token for SDK-based WebRTC connection (better echo cancellation)
    getConversationToken: (config: { agentId: string }): Promise<{ success: boolean; conversationToken?: string; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_CONVERSATION_TOKEN, config),
  },

  // SSH Remote Sessions
  ssh: {
    testConnection: (config: SSHConfig): Promise<{
      success: boolean;
      error?: string;
      claudeCodeVersion?: string;
      hostname?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_TEST_CONNECTION, config),
    createSession: (data: { name: string; sshConfig: SSHConfig; resumeSessionId?: string }): Promise<Session> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_CREATE_SESSION, data),
    listResumeCandidates: (config: SSHConfig): Promise<SSHResumeCandidate[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_LIST_RESUME_CANDIDATES, config),
    getSavedConfig: (): Promise<{
      host: string;
      port: string;
      username: string;
      privateKeyPath: string;
      remoteWorkdir: string;
      sessionName: string;
      worktreeScript: string;
      syncSettings: boolean;
    } | null> => ipcRenderer.invoke(IPC_CHANNELS.SSH_GET_SAVED_CONFIG),
    saveConfig: (config: {
      host: string;
      port: string;
      username: string;
      privateKeyPath: string;
      remoteWorkdir: string;
      sessionName: string;
      worktreeScript: string;
      syncSettings: boolean;
    }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SSH_SAVE_CONFIG, config),
    onSetupProgress: (callback: (data: { sessionId: string; status: 'running' | 'completed' | 'error'; message?: string; output?: string; error?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; status: 'running' | 'completed' | 'error'; message?: string; output?: string; error?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SSH_SETUP_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_SETUP_PROGRESS, handler);
    },
    checkConnection: (config: SSHConfig): Promise<{
      connected: boolean;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_CHECK_CONNECTION, config),
    teleportSession: (sourceSessionId: string, destinationConfig: SSHConfig): Promise<{
      success: boolean;
      newSessionId?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_TELEPORT_SESSION, { sourceSessionId, destinationConfig }),
    downloadSession: (sessionId: string, config: DownloadSessionConfig): Promise<{
      success: boolean;
      newSessionId?: string;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_DOWNLOAD_SESSION, sessionId, config),
    onDownloadProgress: (callback: (message: string) => void) => {
      const handler = (_: IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on(IPC_CHANNELS.SSH_DOWNLOAD_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_DOWNLOAD_PROGRESS, handler);
    },
    reconnect: (sessionId: string): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_RECONNECT, sessionId),
    onConnectionLost: (callback: (data: { sessionId: string; reason?: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; reason?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SSH_CONNECTION_LOST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_CONNECTION_LOST, handler);
    },
    browseRemoteFiles: (config: SSHConfig, remotePath: string): Promise<{
      success: boolean;
      entries: Array<{ name: string; type: 'file' | 'directory'; permissions: string }>;
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SSH_BROWSE_REMOTE_FILES, config, remotePath),
  },

  // Memory (agent memory system)
  memory: {
    remember: (
      fact: { category: string; content: string; source?: 'user' | 'extracted' | 'agent' },
      projectPath?: string
    ): Promise<{
      id: string;
      category: string;
      content: string;
      createdAt: string;
      updatedAt: string;
      source: string;
      projectPath?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REMEMBER, fact, projectPath),

    recall: (
      query: string,
      projectPath: string,
      options?: { limit?: number; category?: string }
    ): Promise<Array<{
      id: string;
      category: string;
      content: string;
      createdAt: string;
      updatedAt: string;
      source: string;
      projectPath?: string;
    }>> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RECALL, query, projectPath, options),

    forget: (factId: string, projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FORGET, factId, projectPath),

    list: (projectPath: string): Promise<Array<{
      id: string;
      category: string;
      content: string;
      createdAt: string;
      updatedAt: string;
      source: string;
      projectPath?: string;
    }>> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, projectPath),

    sync: (projectPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SYNC, projectPath),
  },

  // Secure Keys (API key/token interception and secure storage)
  secureKeys: {
    interceptAndReplace: (sessionId: string, text: string): Promise<{
      modifiedText: string;
      keysDetected: Array<{ id: string; type: string; description: string }>;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SECURE_KEYS_INTERCEPT, sessionId, text),

    getKey: (keyId: string): Promise<{
      success: boolean;
      value: string | null;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SECURE_KEYS_GET, keyId),

    listKeys: (sessionId: string): Promise<{
      keys: Array<{ id: string; type: string; description: string }>;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SECURE_KEYS_LIST, sessionId),

    clearSession: (sessionId: string): Promise<{
      success: boolean;
    }> => ipcRenderer.invoke(IPC_CHANNELS.SECURE_KEYS_CLEAR_SESSION, sessionId),
  },

  // QMD (semantic codebase search)
  qmd: {
    getStatus: (): Promise<{
      installed: boolean;
      version?: string;
      collections: Array<{ name: string; path: string; fileCount?: number; lastIndexed?: string }>;
      embeddingsReady: boolean;
      bundled: boolean;
    }> => ipcRenderer.invoke(IPC_CHANNELS.QMD_GET_STATUS),

    ensureIndexed: (projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_ENSURE_INDEXED, projectPath),

    createCollection: (projectPath: string, mask?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_CREATE_COLLECTION, projectPath, mask),

    generateEmbeddings: (collectionName?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_GENERATE_EMBEDDINGS, collectionName),

    search: (
      query: string,
      options?: { collection?: string; mode?: 'search' | 'vsearch' | 'query'; limit?: number }
    ): Promise<Array<{ file: string; score: number; content: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_SEARCH, query, options),

    onIndexingProgress: (
      callback: (data: { projectPath?: string; collectionName?: string; message: string }) => void
    ) => {
      const handler = (
        _: IpcRendererEvent,
        data: { projectPath?: string; collectionName?: string; message: string }
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.QMD_INDEXING_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.QMD_INDEXING_PROGRESS, handler);
    },

    // Project preference management
    getProjectPreference: (projectPath: string): Promise<'enabled' | 'disabled' | 'unknown'> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_GET_PROJECT_PREFERENCE, projectPath),

    setProjectPreference: (projectPath: string, preference: 'enabled' | 'disabled'): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_SET_PROJECT_PREFERENCE, projectPath, preference),

    shouldPrompt: (projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_SHOULD_PROMPT, projectPath),

    // Listen for QMD prompt requests from main process
    onPromptRequest: (
      callback: (data: { sessionId: string; projectPath: string }) => void
    ) => {
      const handler = (
        _: IpcRendererEvent,
        data: { sessionId: string; projectPath: string }
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.QMD_PROMPT_RESPONSE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.QMD_PROMPT_RESPONSE, handler);
    },

    // Auto-install QMD (downloads Bun + QMD if not available)
    autoInstall: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.QMD_AUTO_INSTALL),
  },

  // MCP (MCP server management)
  mcp: {
    getServers: (sessionId: string, projectPath?: string): Promise<MCPServerInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVERS, sessionId, projectPath),

    getMarketplace: (): Promise<MarketplaceMCPServer[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_MARKETPLACE),

    install: (serverId: string, authValues: Record<string, string>): Promise<{ success: boolean; error?: string; authUrl?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_INSTALL_SERVER, serverId, authValues),

    installRaw: (serverId: string, config: Record<string, unknown>): Promise<{ success: boolean; error?: string; authUrl?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_INSTALL_SERVER_RAW, serverId, config),

    uninstall: (serverId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_UNINSTALL_SERVER, serverId),
  },

  // Plugins (plugin marketplace management)
  plugins: {
    getPopularMarketplaces: (): Promise<PopularMarketplace[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_POPULAR_MARKETPLACES),

    getMarketplaces: (): Promise<PluginMarketplace[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_MARKETPLACES),

    getInstalled: (): Promise<InstalledPlugin[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_INSTALLED),

    getAvailable: (): Promise<MarketplacePlugin[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_AVAILABLE),

    install: (
      pluginId: string,
      marketplace: string,
      options?: { scope?: 'user' | 'project' }
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INSTALL, pluginId, marketplace, options),

    uninstall: (pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UNINSTALL, pluginId, marketplace),

    enable: (pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_ENABLE, pluginId, marketplace),

    disable: (pluginId: string, marketplace: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_DISABLE, pluginId, marketplace),

    addMarketplace: (source: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_ADD_MARKETPLACE, source),

    removeMarketplace: (name: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_REMOVE_MARKETPLACE, name),

    updateMarketplaces: (name?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UPDATE_MARKETPLACE, name),
  },

  // Codex (second opinion)
  codex: {
    run: (sessionId: string, prompt: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_RUN, sessionId, prompt),
    cancel: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_CANCEL, sessionId),
    onStreamChunk: (callback: (data: { sessionId: string; content: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; content: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CODEX_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_STREAM_CHUNK, handler);
    },
    onToolCall: (callback: (data: { sessionId: string; toolCall: any }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; toolCall: any }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CODEX_TOOL_CALL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_TOOL_CALL, handler);
    },
    onThinking: (callback: (data: { sessionId: string; content: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; content: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CODEX_THINKING, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_THINKING, handler);
    },
    onComplete: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CODEX_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_COMPLETE, handler);
    },
    onError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_: IpcRendererEvent, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CODEX_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_ERROR, handler);
    },
  },

  // GStack workflow skills
  gstack: {
    getModes: (): Promise<Array<{ id: string; name: string; shortName: string; description: string; color: string; category: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.GSTACK_GET_MODES),
    isInstalled: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.GSTACK_IS_INSTALLED),
    install: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.GSTACK_INSTALL),
    upgrade: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.GSTACK_UPGRADE),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI;
