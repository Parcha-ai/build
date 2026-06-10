// IPC Channel Names

export const IPC_CHANNELS = {
  // Auth channels
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_USER: 'auth:get-user',
  AUTH_GET_REPOS: 'auth:get-repos',
  AUTH_STATUS: 'auth:status',
  AUTH_CHECK_PROVIDERS: 'auth:check-providers',

  // Session channels
  SESSION_CREATE: 'session:create',
  SESSION_START: 'session:start',
  SESSION_STOP: 'session:stop',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_UPDATE: 'session:update',
  SESSION_REWIND_FORK: 'session:rewind-fork',
  SESSION_CREATE_FORK: 'session:create-fork', // Create conversation fork
  SESSION_GET_FORK_GROUP: 'session:get-fork-group', // Get all forks in a conversation group
  SESSION_SCAN_REMOTE: 'session:scan-remote',
  SESSION_STATUS_CHANGED: 'session:status-changed',
  SESSION_LIST_UPDATED: 'session:list-updated',

  // Docker channels
  DOCKER_STATUS: 'docker:status',
  DOCKER_CONTAINER_STATS: 'docker:container-stats',
  DOCKER_CONTAINER_LOGS: 'docker:container-logs',

  // Terminal channels
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_CLOSE: 'terminal:close',

  // Git channels
  GIT_STATUS: 'git:status',
  GIT_LOG: 'git:log',
  GIT_BRANCHES: 'git:branches',
  GIT_CHECKOUT: 'git:checkout',
  GIT_DIFF: 'git:diff',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_CLONE: 'git:clone',
  GIT_REMOTE_BRANCH: 'git:remote-branch',
  GIT_WATCH_BRANCH: 'git:watch-branch',
  GIT_UNWATCH_BRANCH: 'git:unwatch-branch',
  GIT_BRANCH_CHANGED: 'git:branch-changed',

  // Claude channels
  CLAUDE_SEND_MESSAGE: 'claude:send-message',
  CLAUDE_RESUME_REMOTE_TURN: 'claude:resume-remote-turn',
  CLAUDE_GET_MESSAGES: 'claude:get-messages',
  CLAUDE_HAS_BUILD_TRANSCRIPT: 'claude:has-build-transcript',
  CLAUDE_GET_MODELS: 'claude:get-models',
  CLAUDE_STREAM_CHUNK: 'claude:stream-chunk',
  CLAUDE_THINKING_CHUNK: 'claude:thinking-chunk',
  CLAUDE_STREAM_END: 'claude:stream-end',
  CLAUDE_STREAM_ERROR: 'claude:stream-error',
  CLAUDE_TOOL_CALL: 'claude:tool-call',
  CLAUDE_TOOL_RESULT: 'claude:tool-result',
  CLAUDE_SYSTEM_INFO: 'claude:system-info',
  CLAUDE_CANCEL: 'claude:cancel',
  CLAUDE_PERMISSION_REQUEST: 'claude:permission-request',
  CLAUDE_PERMISSION_RESPONSE: 'claude:permission-response',
  CLAUDE_QUESTION_REQUEST: 'claude:question-request',
  CLAUDE_QUESTION_RESPONSE: 'claude:question-response',
  CLAUDE_COMPACTION_STATUS: 'claude:compaction-status',
  CLAUDE_CONTEXT_USAGE: 'claude:context-usage',
  CLAUDE_COMPACTION_COMPLETE: 'claude:compaction-complete',
  CLAUDE_WAKEUP_FIRED: 'claude:wakeup-fired',
  CLAUDE_PLAN_CONTENT: 'claude:plan-content',
  CLAUDE_PLAN_APPROVAL_REQUEST: 'claude:plan-approval-request',
  CLAUDE_PLAN_APPROVAL_RESPONSE: 'claude:plan-approval-response',
  CLAUDE_INJECT_MESSAGE: 'claude:inject-message', // Inject message into active query via streamInput
  CLAUDE_HAS_ACTIVE_QUERY: 'claude:has-active-query', // Check if session has active query
  CLAUDE_SET_PERMISSION_MODE: 'claude:set-permission-mode', // Update permission mode mid-stream (used by GREP IT! button)
  CLAUDE_PERMISSION_MODE_CHANGED: 'claude:permission-mode-changed', // Notify renderer of permission mode change from main
  CLAUDE_BACKGROUND_TASK_OUTPUT: 'claude:background-task-output', // Output updates from backgrounded Bash commands
  CLAUDE_TASK_NOTIFICATION: 'claude:task-notification', // Background task completed/failed/stopped
  CLAUDE_TASK_PROGRESS: 'claude:task-progress', // Background task intermediate progress
  CLAUDE_TASK_UPDATED: 'claude:task-updated', // Background task status delta patch
  CLAUDE_BTW_ASK: 'claude:btw-ask', // Ephemeral side question (bypasses conversation history)
  CLAUDE_BTW_RESPONSE: 'claude:btw-response', // Streaming response chunks for /btw
  CLAUDE_RC_START: 'claude:rc-start', // Start remote control session
  CLAUDE_RC_STOP: 'claude:rc-stop', // Stop remote control session
  CLAUDE_REWIND_PREVIEW: 'claude:rewind-preview', // dryRun rewind to see file changes
  CLAUDE_REWIND_EXECUTE: 'claude:rewind-execute', // actually rewind files + fork session
  CLAUDE_RC_STARTED: 'claude:rc-started', // Remote control session started (URL detected)
  CLAUDE_RC_STOPPED: 'claude:rc-stopped', // Remote control session stopped

  // Browser preview channels
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_NAVIGATE_TO: 'browser:navigate-to',
  BROWSER_ELEMENT_SELECTED: 'browser:element-selected',
  BROWSER_INJECT_INSPECTOR: 'browser:inject-inspector',
  BROWSER_CAPTURE_SNAPSHOT: 'browser:capture-snapshot',
  BROWSER_GET_SNAPSHOT: 'browser:get-snapshot',
  BROWSER_CLEAR_STORAGE: 'browser:clear-storage',
  BROWSER_UPDATE: 'browser:update', // Stagehand screenshot/URL updates
  BROWSER_OPEN_PANEL: 'browser:open-panel', // Request to open browser panel
  BROWSER_REGISTER: 'browser:register', // Webview registration from renderer

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_GET_API_KEY: 'settings:get-api-key',
  SETTINGS_SET_API_KEY: 'settings:set-api-key',
  SETTINGS_GET_GOOGLE_API_KEY: 'settings:get-google-api-key',
  SETTINGS_SET_GOOGLE_API_KEY: 'settings:set-google-api-key',

  // App channels
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_OPEN_PATH: 'app:open-path',
  APP_GET_PATH: 'app:get-path',
  APP_SHOW_DIALOG: 'app:show-dialog',
  APP_CMD_R_PRESSED: 'app:cmd-r-pressed',
  APP_SHORTCUT_TRIGGERED: 'app:shortcut-triggered',
  APP_OPEN_BROWSER_WINDOW: 'app:open-browser-window',
  APP_CLOSE_BROWSER_WINDOW: 'app:close-browser-window',

  // Dev mode channels
  DEV_OPEN_LOCAL_REPO: 'dev:open-local-repo',
  DEV_CREATE_SESSION: 'dev:create-session',
  DEV_CREATE_TELEPORT_SESSION: 'dev:create-teleport-session',
  DEV_CHECK_GIT_REPO: 'dev:check-git-repo',
  DEV_GET_BRANCHES: 'dev:get-branches',
  DEV_CHECK_WORKTREE_SETUP: 'dev:check-worktree-setup',
  DEV_SAVE_WORKTREE_SCRIPT: 'dev:save-worktree-script',
  DEV_SAVE_WORKTREE_INSTRUCTIONS: 'dev:save-worktree-instructions',
  DEV_EXECUTE_WORKTREE_SETUP: 'dev:execute-worktree-setup',
  DEV_SETUP_PROGRESS: 'dev:setup-progress',
  DEV_CHECK_CLAUDE_CLI: 'dev:check-claude-cli',

  // File system channels
  FS_LIST_FILES: 'fs:list-files',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_SEARCH_FILES: 'fs:search-files',
  FS_SEARCH_SYMBOLS: 'fs:search-symbols',

  // Audio channels
  AUDIO_TRANSCRIBE: 'audio:transcribe',
  AUDIO_TTS_STREAM: 'audio:tts-stream',
  AUDIO_TTS_CANCEL: 'audio:tts-cancel',
  AUDIO_TTS_CHUNK: 'audio:tts-chunk',
  AUDIO_TTS_COMPLETE: 'audio:tts-complete',
  AUDIO_TTS_ERROR: 'audio:tts-error',
  AUDIO_GET_VOICES: 'audio:get-voices',
  AUDIO_SETTINGS_GET: 'audio:settings-get',
  AUDIO_SETTINGS_SET: 'audio:settings-set',
  AUDIO_GET_ELEVENLABS_KEY: 'audio:get-elevenlabs-key',
  AUDIO_SET_ELEVENLABS_KEY: 'audio:set-elevenlabs-key',
  AUDIO_GET_OPENAI_KEY: 'audio:get-openai-key',
  AUDIO_SET_OPENAI_KEY: 'audio:set-openai-key',
  AUDIO_REQUEST_MICROPHONE_PERMISSION: 'audio:request-microphone-permission', // macOS microphone permission
  AUDIO_CHECK_MICROPHONE_PERMISSION: 'audio:check-microphone-permission', // Check if microphone permission granted

  // Realtime transcription channels
  REALTIME_CONNECT: 'realtime:connect',
  REALTIME_DISCONNECT: 'realtime:disconnect',
  REALTIME_SEND_AUDIO: 'realtime:send-audio',
  REALTIME_COMMIT_AUDIO: 'realtime:commit-audio',
  REALTIME_CLEAR_AUDIO: 'realtime:clear-audio',
  REALTIME_TRANSCRIPTION_DELTA: 'realtime:transcription-delta',
  REALTIME_TRANSCRIPTION_COMPLETED: 'realtime:transcription-completed',
  REALTIME_SPEECH_STARTED: 'realtime:speech-started',
  REALTIME_SPEECH_STOPPED: 'realtime:speech-stopped',
  REALTIME_ERROR: 'realtime:error',
  REALTIME_CONNECTED: 'realtime:connected',
  REALTIME_DISCONNECTED: 'realtime:disconnected',

  // Extension channels (commands, skills, agents)
  EXTENSION_SCAN_COMMANDS: 'extension:scan-commands',
  EXTENSION_SCAN_SKILLS: 'extension:scan-skills',
  EXTENSION_SCAN_AGENTS: 'extension:scan-agents',
  EXTENSION_GET_COMMAND: 'extension:get-command',
  EXTENSION_INSTALL_SKILL: 'extension:install-skill',
  EXTENSION_LIST_AVAILABLE_SKILLS: 'extension:list-available-skills',

  // Auto-resume channels (for Ralph Loop/Build It mode)
  AUTO_RESUME_SAVE_STATE: 'auto-resume:save-state',
  AUTO_RESUME_GET_STATE: 'auto-resume:get-state',
  AUTO_RESUME_CLEAR_STATE: 'auto-resume:clear-state',
  AUTO_RESUME_TRIGGER: 'auto-resume:trigger',

  // SSH channels
  SSH_TEST_CONNECTION: 'ssh:test-connection',
  SSH_CREATE_SESSION: 'ssh:create-session',
  SSH_LIST_RESUME_CANDIDATES: 'ssh:list-resume-candidates',
  SSH_SYNC_SETTINGS: 'ssh:sync-settings',
  SSH_RUN_WORKTREE_SCRIPT: 'ssh:run-worktree-script',
  SSH_GET_SAVED_CONFIG: 'ssh:get-saved-config',
  SSH_SAVE_CONFIG: 'ssh:save-config',
  SSH_SETUP_PROGRESS: 'ssh:setup-progress',
  SSH_CHECK_CONNECTION: 'ssh:check-connection',
  SSH_TELEPORT_SESSION: 'ssh:teleport-session',
  SSH_DOWNLOAD_SESSION: 'ssh:download-session',
  SSH_DOWNLOAD_PROGRESS: 'ssh:download-progress',
  SSH_RECONNECT: 'ssh:reconnect',
  SSH_CONNECTION_LOST: 'ssh:connection-lost',
  SSH_SYSTEM_RESUMED: 'ssh:system-resumed',
  CLAUDE_REMOTE_TURN_RECOVERABLE: 'claude:remote-turn-recoverable',
  SSH_HAS_ACTIVE_REMOTE_PROCESS: 'ssh:has-active-remote-process',
  SSH_HAS_RECOVERABLE_REMOTE_PROCESS: 'ssh:has-recoverable-remote-process',
  SSH_BROWSE_REMOTE_FILES: 'ssh:browse-remote-files',

  // Secure Keys channels (API key/token interception)
  SECURE_KEYS_INTERCEPT: 'secure-keys:intercept',
  SECURE_KEYS_GET: 'secure-keys:get',
  SECURE_KEYS_LIST: 'secure-keys:list',
  SECURE_KEYS_CLEAR_SESSION: 'secure-keys:clear-session',

  // Voice mode channels (ElevenLabs Conversational AI)
  VOICE_CONNECT: 'voice:connect',
  VOICE_DISCONNECT: 'voice:disconnect',
  VOICE_SEND_AUDIO: 'voice:send-audio',
  VOICE_SEND_TEXT: 'voice:send-text',
  VOICE_END_INPUT: 'voice:end-input',
  VOICE_CLEAR_AUDIO_BUFFER: 'voice:clear-audio-buffer', // Clear server-side audio buffer to prevent echo
  VOICE_CONTEXT_UPDATE: 'voice:context-update',
  VOICE_CONNECTED: 'voice:connected',
  VOICE_DISCONNECTED: 'voice:disconnected',
  VOICE_RECONNECTING: 'voice:reconnecting',
  VOICE_USER_TRANSCRIPT: 'voice:user-transcript',
  VOICE_AGENT_RESPONSE: 'voice:agent-response',
  VOICE_AUDIO_CHUNK: 'voice:audio-chunk',
  VOICE_INTERRUPTION: 'voice:interruption',
  VOICE_ERROR: 'voice:error',
  VOICE_TOOL_CALL: 'voice:tool-call',
  VOICE_TOOL_RESULT: 'voice:tool-result',
  VOICE_UPDATE_AGENT_PROMPT: 'voice:update-agent-prompt',
  VOICE_USER_ACTIVITY: 'voice:user-activity',
  VOICE_GET_SIGNED_URL: 'voice:get-signed-url', // Get signed URL for SDK-based WebSocket connection
  VOICE_GET_CONVERSATION_TOKEN: 'voice:get-conversation-token', // Get conversation token for WebRTC connection (better echo cancellation)

  // Memory channels (agent memory system)
  MEMORY_REMEMBER: 'memory:remember',
  MEMORY_RECALL: 'memory:recall',
  MEMORY_FORGET: 'memory:forget',
  MEMORY_LIST: 'memory:list',
  MEMORY_SYNC: 'memory:sync',

  // MCP channels (MCP server management)
  MCP_GET_SERVERS: 'mcp:get-servers',
  MCP_GET_RAW_CONFIG: 'mcp:get-raw-config',
  MCP_GET_MARKETPLACE: 'mcp:get-marketplace',
  MCP_INSTALL_SERVER: 'mcp:install-server',
  MCP_INSTALL_SERVER_RAW: 'mcp:install-server-raw',
  MCP_UNINSTALL_SERVER: 'mcp:uninstall-server',

  // Plugin channels (plugin marketplace management)
  PLUGIN_GET_POPULAR_MARKETPLACES: 'plugin:get-popular-marketplaces',
  PLUGIN_GET_MARKETPLACES: 'plugin:get-marketplaces',
  PLUGIN_GET_INSTALLED: 'plugin:get-installed',
  PLUGIN_GET_AVAILABLE: 'plugin:get-available',
  PLUGIN_INSTALL: 'plugin:install',
  PLUGIN_UNINSTALL: 'plugin:uninstall',
  PLUGIN_ENABLE: 'plugin:enable',
  PLUGIN_DISABLE: 'plugin:disable',
  PLUGIN_ADD_MARKETPLACE: 'plugin:add-marketplace',
  PLUGIN_REMOVE_MARKETPLACE: 'plugin:remove-marketplace',
  PLUGIN_UPDATE_MARKETPLACE: 'plugin:update-marketplace',

  // GStack channels (workflow skills)
  GSTACK_GET_MODES: 'gstack:get-modes',
  GSTACK_IS_INSTALLED: 'gstack:is-installed',
  GSTACK_INSTALL: 'gstack:install',
  GSTACK_UPGRADE: 'gstack:upgrade',

  // OpenClaw channels
  OPENCLAW_CREATE_SESSION: 'openclaw:create-session',

  // Codex channels (second opinion / direct invocation)
  CODEX_RUN: 'codex:run',
  CODEX_STREAM_CHUNK: 'codex:stream-chunk',
  CODEX_TOOL_CALL: 'codex:tool-call',
  CODEX_THINKING: 'codex:thinking',
  CODEX_COMPLETE: 'codex:complete',
  CODEX_ERROR: 'codex:error',
  CODEX_CANCEL: 'codex:cancel',

  // QMD channels (semantic codebase search)
  QMD_GET_STATUS: 'qmd:get-status',
  QMD_ENSURE_INDEXED: 'qmd:ensure-indexed',
  QMD_CREATE_COLLECTION: 'qmd:create-collection',
  QMD_GENERATE_EMBEDDINGS: 'qmd:generate-embeddings',
  QMD_SEARCH: 'qmd:search',
  QMD_INDEXING_PROGRESS: 'qmd:indexing-progress',
  QMD_GET_PROJECT_PREFERENCE: 'qmd:get-project-preference',
  QMD_SET_PROJECT_PREFERENCE: 'qmd:set-project-preference',
  QMD_SHOULD_PROMPT: 'qmd:should-prompt',
  QMD_PROMPT_RESPONSE: 'qmd:prompt-response', // Event sent to renderer to show QMD prompt
  QMD_AUTO_INSTALL: 'qmd:auto-install', // Auto-install QMD (downloads Bun + QMD)

  // Analytics channels (token usage + cost tracking)
  ANALYTICS_GET_SUMMARY: 'analytics:get-summary',
  ANALYTICS_GET_SESSION_COST: 'analytics:get-session-cost',
  ANALYTICS_GET_TIER_CONFIG: 'analytics:get-tier-config',
  ANALYTICS_SET_TIER_CONFIG: 'analytics:set-tier-config',
  ANALYTICS_GET_HARNESS_INSIGHTS: 'analytics:get-harness-insights',
  ANALYTICS_REFRESH_HISTORICAL_USAGE: 'analytics:refresh-historical-usage',
  ANALYTICS_RUN_ROUTER_EVAL: 'analytics:run-router-eval',
  ANALYTICS_RECORD_HARNESS_SELECTION: 'analytics:record-harness-selection',
  ANALYTICS_TOKEN_EVENT: 'analytics:token-event', // Real-time event pushed to renderer

  // Auto Build mode (intelligent model routing)
  CLAUDE_AUTO_ROUTE_DECISION: 'claude:auto-route-decision',

  // Update channels (GitHub release check)
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
} as const;

export type IPCChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
