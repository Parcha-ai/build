import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage, Query, SpawnedProcess, TerminalReason } from '@anthropic-ai/claude-agent-sdk';
import type { ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { z } from 'zod';
import Store from 'electron-store';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { ChatMessage, ToolCall, Session, QuestionRequest, QuestionResponse, Attachment, ContentBlock, CompactionStatus, CompactionComplete, PlanApprovalRequest, PlanApprovalResponse } from '../../shared/types';
import { powerService } from './power.service';
import { BrowserWindow, nativeImage } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { browserService } from './browser.service';
import { cdpProxyService } from './cdp-proxy.service';
import { stagehandService } from './stagehand.service';
import { computerUseService } from './computer-use.service';
import { documentService } from './document.service';
import { sshService } from './ssh.service';
import { memoryService, MemoryCategory } from './memory.service';
import { qmdService } from './qmd.service';
import { mcpService } from './mcp.service';
import { codexService } from './codex.service';
import { openclawService } from './openclaw.service';
import { formatConversationContext, mergeConversationMessages, buildCrossHarnessContext } from './codex-context';
import { secureKeysService } from './secure-keys.service';
import { analyticsService, estimateCost } from './analytics.service';

const STREAM_DEBUG = process.env.GREP_DEBUG_STREAMING === '1';

interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'message_complete' | 'error' | 'system' | 'permission_request' | 'compaction_status' | 'compaction_complete' | 'plan_content' | 'context_usage';
  content?: string;
  toolCall?: ToolCall;
  result?: unknown;
  message?: ChatMessage;
  error?: string;
  systemInfo?: {
    tools: string[];
    model: string;
  };
  // Permission request fields
  sessionId?: string;
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  approvalMessage?: string; // Message about why approval is needed
  // Compaction fields
  compactionStatus?: CompactionStatus;
  compactionComplete?: CompactionComplete;
  // Plan content fields
  planContent?: string;
  planFilePath?: string;
  // Agent teams fields
  agentId?: string; // parent_tool_use_id from SDK (null = lead agent)
  agentName?: string; // Descriptive name for the agent/teammate
  // Terminal reason from SDK result message (v0.2.91+)
  terminalReason?: string;
  // Rich context usage breakdown from SDK getContextUsage() (v0.2.86+)
  contextUsageBreakdown?: Record<string, unknown>;
}

interface PendingQuestion {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
}

interface PendingPermission {
  resolve: (response: { approved: boolean; modifiedInput?: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface PendingPlanApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  sessionId: string;
}

export class ClaudeService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private messageCacheStore: any;
  private activeQueries: Map<string, AbortController> = new Map();
  private activeQueryObjects: Map<string, Query> = new Map(); // Store Query objects for streamInput
  private sessionPermissionModes: Map<string, string> = new Map(); // Track current permission mode per session
  private prePlanPermissionModes: Map<string, string> = new Map(); // Track pre-plan mode for restoration after plan approval
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private pendingPlanApprovals: Map<string, PendingPlanApproval> = new Map();
  private sessionPlanFiles: Map<string, { content: string; filePath: string }> = new Map(); // Cache plan content per session
  private lastPlanFeedback: Map<string, string> = new Map(); // Stores feedback from last plan rejection per session
  private mainWindow: BrowserWindow | null = null;
  private onSessionNameChanged: (() => void) | null = null;
  private browserMcpServers: Map<string, any> = new Map();

  // Proactive compaction: track context usage per session and compact idle sessions in background
  private sessionContextPercentage: Map<string, number> = new Map();
  private sessionLastMessageTime: Map<string, number> = new Map();
  private sessionsBeingCompacted: Set<string> = new Set();

  // Performance optimization: Cache parsed messages and transcript paths
  private messageCache = new Map<string, {
    messages: ChatMessage[];
    loadedAt: number;
    fileHash: string;
  }>();
  private transcriptPathCache = new Map<string, string>();

  constructor() {
    this.store = new Store({ name: 'claudette-settings' });
    this.sessionStore = new CachedStore({ name: getSessionStoreName() }) as any;
    this.messageCacheStore = new CachedStore({ name: 'claudette-message-cache' }) as any;
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  setOnSessionNameChanged(callback: () => void): void {
    this.onSessionNameChanged = callback;
  }

  /**
   * Get Foundry environment variables from settings (when Foundry is enabled)
   */
  /**
   * When a custom:* model is selected, override ANTHROPIC_BASE_URL and
   * ANTHROPIC_API_KEY to route through the custom model's API proxy.
   * The model name is resolved separately in streamMessage.
   */
  private getCustomModelEnvVars(selectedModel?: string): Record<string, string> {
    if (!selectedModel?.startsWith('custom:')) return {};
    const customId = selectedModel.replace('custom:', '');
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const customModels = (settings.customModels || []) as Array<{ id: string; modelId: string; baseUrl: string; apiKey: string }>;
    const config = customModels.find(m => m.id === customId);
    if (!config) return {};

    const vars: Record<string, string> = {};
    if (config.baseUrl) vars.ANTHROPIC_BASE_URL = config.baseUrl.trim();
    if (config.apiKey) {
      // Set BOTH auth env vars — ANTHROPIC_AUTH_TOKEN is used by third-party
      // providers (Fireworks, etc) as a passthrough token, while ANTHROPIC_API_KEY
      // is the standard Anthropic auth. The SDK/CLI picks the right one.
      vars.ANTHROPIC_API_KEY = config.apiKey.trim();
      vars.ANTHROPIC_AUTH_TOKEN = config.apiKey.trim();
    }
    if (config.modelId) {
      const modelId = config.modelId.trim();
      vars.ANTHROPIC_MODEL = modelId;
      vars.ANTHROPIC_SMALL_FAST_MODEL = modelId;
      // Replace Sonnet tier — custom models typically match Sonnet's
      // context/capability level. Leave Opus and Haiku as Claude defaults
      // so sub-agents and compaction use the right models.
      vars.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    }
    return vars;
  }

  /**
   * Resolve a custom:* model ID to the actual model name to send to the API.
   */
  private resolveCustomModelId(selectedModel: string): string {
    if (!selectedModel.startsWith('custom:')) return selectedModel;
    const customId = selectedModel.replace('custom:', '');
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const customModels = (settings.customModels || []) as Array<{ id: string; modelId: string }>;
    const config = customModels.find(m => m.id === customId);
    return config?.modelId || selectedModel;
  }

  private getFoundryEnvVars(): Record<string, string> {
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    if (!settings.foundryEnabled) return {};

    const vars: Record<string, string> = {
      CLAUDE_CODE_USE_FOUNDRY: '1',
    };
    if (settings.foundryBaseUrl) {
      vars.ANTHROPIC_FOUNDRY_BASE_URL = (settings.foundryBaseUrl as string).trim();
    }
    if (settings.foundryApiKey) {
      vars.ANTHROPIC_FOUNDRY_API_KEY = (settings.foundryApiKey as string).trim();
    }
    if (settings.foundryDefaultSonnetModel) {
      vars.ANTHROPIC_DEFAULT_SONNET_MODEL = (settings.foundryDefaultSonnetModel as string).trim();
    }
    if (settings.foundryDefaultHaikuModel) {
      vars.ANTHROPIC_DEFAULT_HAIKU_MODEL = (settings.foundryDefaultHaikuModel as string).trim();
    }
    if (settings.foundryDefaultOpusModel) {
      vars.ANTHROPIC_DEFAULT_OPUS_MODEL = (settings.foundryDefaultOpusModel as string).trim();
    }
    return vars;
  }

  /**
   * Update the permission mode for an active session
   * This allows changing from 'default' to 'bypassPermissions' mid-stream
   */
  setSessionPermissionMode(sessionId: string, mode: string): void {
    console.log(`[Claude Service] Setting permission mode for ${sessionId}: ${mode}`);
    // When entering plan mode, store the previous mode for restoration after plan approval
    if (mode === 'plan') {
      const currentMode = this.sessionPermissionModes.get(sessionId) || 'acceptEdits';
      if (currentMode !== 'plan') {
        this.prePlanPermissionModes.set(sessionId, currentMode);
        console.log(`[Claude Service] Stored pre-plan mode for ${sessionId}: ${currentMode}`);
      }
    }
    this.sessionPermissionModes.set(sessionId, mode);
  }

  /**
   * Get the current permission mode for a session
   */
  getSessionPermissionMode(sessionId: string): string | undefined {
    return this.sessionPermissionModes.get(sessionId);
  }

  /**
   * Get the active Query object for a session (used by rewind/history features)
   */
  getActiveQuery(sessionId: string): any | undefined {
    return this.activeQueryObjects.get(sessionId);
  }

  /**
   * Trigger manual compaction for a session by sending /compact command
   * This proactively compacts the conversation history before it gets too large
   */
  async triggerManualCompaction(sessionId: string): Promise<boolean> {
    const queryObj = this.activeQueryObjects.get(sessionId);
    if (!queryObj) {
      console.log('[Claude Service] Cannot compact - no active query for session:', sessionId);
      return false;
    }

    try {
      console.log('[Claude Service] Triggering manual compaction for session:', sessionId);

      // Send /compact command via streamInput
      const compactCommand: AsyncIterable<any> = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: '/compact',
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      };

      await queryObj.streamInput(compactCommand);
      console.log('[Claude Service] Manual compaction triggered successfully');
      return true;
    } catch (error) {
      console.error('[Claude Service] Failed to trigger compaction:', error);
      return false;
    }
  }

  /**
   * Proactive compaction: when the user sends a message to one session,
   * compact any OTHER sessions that are above 60% context and idle (>30s since last message).
   * This runs compaction invisibly while the user is focused elsewhere.
   */
  private compactIdleSessions(activeSessionId: string): void {
    // Only proactively compact when context is genuinely filling up.
    // On 1M windows, 60% (600k) still has massive runway. 85% is the new floor.
    const COMPACT_THRESHOLD = 85; // percentage
    const IDLE_THRESHOLD = 30_000; // 30 seconds
    const now = Date.now();

    for (const [sessionId, percentage] of this.sessionContextPercentage.entries()) {
      if (sessionId === activeSessionId) continue;
      if (percentage < COMPACT_THRESHOLD) continue;
      if (this.sessionsBeingCompacted.has(sessionId)) continue;
      if (!this.activeQueryObjects.has(sessionId)) continue;

      const lastMessage = this.sessionLastMessageTime.get(sessionId) || 0;
      if (now - lastMessage < IDLE_THRESHOLD) continue; // user was recently active here

      console.log(`[Claude Service] Proactive compaction: session ${sessionId.substring(0, 8)} at ${percentage}%, idle for ${Math.round((now - lastMessage) / 1000)}s`);
      this.sessionsBeingCompacted.add(sessionId);
      this.triggerManualCompaction(sessionId).catch(err => {
        console.warn(`[Claude Service] Proactive compaction failed for ${sessionId.substring(0, 8)}:`, err.message);
        this.sessionsBeingCompacted.delete(sessionId);
      });

      // Only compact one session at a time to avoid overloading
      break;
    }
  }

  /**
   * Emit browser update event to renderer for UI synchronization
   * Sends screenshot and URL to update the browser preview panel
   */
  private emitBrowserUpdate(sessionId: string, screenshot: string, url?: string): void {
    console.log('[Claude Service] emitBrowserUpdate called, mainWindow:', !!this.mainWindow, 'sessionId:', sessionId, 'url:', url);
    if (this.mainWindow) {
      console.log('[Claude Service] Sending BROWSER_UPDATE to renderer');
      this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_UPDATE, {
        sessionId,
        screenshot,
        url,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log('[Claude Service] WARNING: mainWindow is null, cannot emit browser update');
    }
  }

  /**
   * Ensure browser panel is open and webview is registered before Stagehand operations
   * This solves the chicken-and-egg problem where Stagehand needs a webview to connect to
   */
  private async ensureBrowserPanelOpen(sessionId: string): Promise<boolean> {
    // Check if webview is already registered
    if (browserService.getRegisteredSessions().length > 0) {
      console.log('[Claude Service] Webview already registered');
      return true;
    }

    // Request renderer to open browser panel
    if (this.mainWindow) {
      console.log('[Claude Service] Requesting browser panel to open for session:', sessionId);
      this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_OPEN_PANEL, { sessionId });

      // Wait for webview to register (poll with timeout)
      const maxWait = 5000; // 5 seconds
      const pollInterval = 200; // 200ms
      let waited = 0;

      while (waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;

        if (browserService.getRegisteredSessions().length > 0) {
          console.log('[Claude Service] Webview registered after', waited, 'ms');
          return true;
        }
      }

      console.log('[Claude Service] Timeout waiting for webview registration');
    }

    return false;
  }

  getApiKey(): string | undefined {
    const key = this.store.get('anthropicApiKey') as string | undefined;
    return key?.trim() || undefined; // Treat empty string as no key
  }

  // Get available Claude models - use Foundry models if configured
  async getAvailableModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    // Check if Anthropic Foundry (Azure) is configured
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const foundryEnabled = settings.foundryEnabled as boolean | undefined;

    if (foundryEnabled) {
      const sonnetModel = settings.foundryDefaultSonnetModel as string | undefined;
      const haikuModel = settings.foundryDefaultHaikuModel as string | undefined;
      const opusModel = settings.foundryDefaultOpusModel as string | undefined;

      const foundryModels = [];

      // Add configured Foundry models
      if (opusModel) {
        foundryModels.push({
          id: opusModel,
          name: 'Opus (Foundry)',
          description: 'Most capable model'
        });
      }
      if (sonnetModel) {
        foundryModels.push({
          id: sonnetModel,
          name: 'Sonnet (Foundry)',
          description: 'Balanced performance'
        });
      }
      if (haikuModel) {
        foundryModels.push({
          id: haikuModel,
          name: 'Haiku (Foundry)',
          description: 'Fastest model'
        });
      }

      if (foundryModels.length > 0) {
        console.log('[Claude Service] Using Foundry models:', foundryModels.map(m => m.id).join(', '));
        return foundryModels;
      }
    }

    // Fallback to default Anthropic models
    console.log('[Claude Service] Using default Anthropic model list');
    const models: Array<{ id: string; name: string; description: string }> = [
      { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Latest and most capable model - best for complex tasks' },
      { id: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Highly capable model' },
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', description: 'Previous generation Opus' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Latest Sonnet - excellent balance of speed and capability' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', description: 'Balanced performance and speed' },
      { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4', description: 'Fast and capable' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: 'Fastest model - best for simple tasks' },
      { id: 'codex:gpt-5.5', name: 'GPT-5.5 (Codex)', description: 'OpenAI latest — most capable coding model' },
      { id: 'codex:gpt-5.4', name: 'GPT-5.4 (Codex)', description: 'OpenAI flagship — best for complex coding tasks' },
      { id: 'codex:gpt-5.4-mini', name: 'GPT-5.4 Mini (Codex)', description: 'OpenAI fast — good balance of speed and capability' },
      { id: 'codex:gpt-5.3-codex', name: 'GPT-5.3 Codex (Codex)', description: 'OpenAI coding-optimised — purpose-built for agents' },
      { id: 'codex:o3', name: 'o3 (Codex)', description: 'OpenAI o3 — deep reasoning model' },
    ];

    // Append custom models from settings (Kimi, Gemini, etc via API proxy)
    const customModels = (settings.customModels || []) as Array<{ id: string; name: string; modelId: string; description?: string }>;
    for (const cm of customModels) {
      if (cm.id && cm.name) {
        models.push({
          id: `custom:${cm.id}`,
          name: cm.name,
          description: cm.description || 'Custom model via API proxy',
        });
      }
    }

    // Cursor models — CLI-based, no API key required for model listing.
    // Try dynamic fetch with API key; otherwise show hardcoded defaults.
    const cursorKey = (settings.cursorApiKey as string) || '';
    let cursorModelsFetched = false;
    if (cursorKey) {
      try {
        const { Cursor } = require('@cursor/sdk');
        const cursorModels = await Cursor.models.list({ apiKey: cursorKey });
        if (cursorModels?.length) {
          for (const m of cursorModels) {
            models.push({
              id: `cursor:${m.id}`,
              name: `${m.displayName || m.id} (Cursor)`,
              description: m.description || 'Cursor model',
            });
          }
          cursorModelsFetched = true;
          console.log(`[Claude Service] Loaded ${cursorModels.length} Cursor models dynamically`);
        }
      } catch (err) {
        console.warn('[Claude Service] Failed to fetch Cursor models dynamically:', err);
      }
    }
    if (!cursorModelsFetched) {
      models.push(
        { id: 'cursor:composer-2.5', name: 'Composer 2.5', description: 'Cursor latest — Composer 2.5' },
        { id: 'cursor:claude-3.5-sonnet', name: 'Cursor (Sonnet 3.5)', description: 'Cursor with Claude Sonnet 3.5' },
        { id: 'cursor:gpt-4o', name: 'Cursor (GPT-4o)', description: 'Cursor with GPT-4o' },
        { id: 'cursor:gemini-3.5-flash', name: 'Gemini 3.5 Flash (Cursor)', description: 'Cursor model' },
        { id: 'cursor:o3', name: 'o3 (Cursor)', description: 'Cursor model' },
      );
    }

    // DeepSeek models via OpenCode (requires API key)
    const deepseekKey = (settings.deepseekApiKey as string) || '';
    if (deepseekKey) {
      models.push(
        { id: 'opencode:deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'DeepSeek via OpenCode agent' },
        { id: 'opencode:deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast DeepSeek via OpenCode' },
        { id: 'opencode:deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', description: 'Reasoning model via OpenCode' },
      );
    }

    // Gemini models via CLI — always show, CLI uses GEMINI_API_KEY env var or settings
    models.push(
      { id: 'gemini:gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'Latest Gemini — 4x faster, frontier-level coding & agents' },
      { id: 'gemini:gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via CLI' },
      { id: 'gemini:gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Google Gemini 2.5 Flash via CLI' },
    );

    return models;
  }

  /**
   * Check if model supports Computer Use API
   */
  private supportsComputerUse(model: string): boolean {
    const supportedModels = [
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet',
      'claude-sonnet-4',
    ];

    return supportedModels.some(m => model.includes(m));
  }

  /**
   * Get Computer Use beta header for the model
   */
  private getComputerUseBetaHeader(model: string): string {
    // Opus 4.6/4.5 and Sonnet 4.6 use newer beta version
    if (model.includes('opus-4-6') || model.includes('opus-4-5') || model.includes('sonnet-4-6')) {
      return 'computer-use-2025-11-24';
    }
    // Other models use older beta version
    return 'computer-use-2025-01-24';
  }

  /**
   * Build the system prompt append section based on session type
   * Includes SSH context for remote sessions and agent memories
   */
  // Static portion of system prompt — cached as a constant to maximize prompt cache hits.
  // The Anthropic API caches from the start of the prompt, so keeping this prefix
  // byte-identical across messages avoids cache misses.
  private static readonly STATIC_SYSTEM_PROMPT = `
## Build Agent

You are the Build agent, an AI development assistant running inside the Build desktop application. You have access to a browser preview panel via MCP tools (claudette-browser) that allows you to test changes you make to web applications in real-time.

### Browser Testing Capabilities

When you make changes to frontend code or start development servers, you can:
- Navigate to localhost URLs to test the application
- Take screenshots to verify UI changes
- Inspect the DOM and check element states
- Monitor network requests and console output

### Proactive Testing

At the start of each session, ask the user: "Would you like me to help test your changes in the browser as we work?"

If the user agrees:
- After making UI changes, navigate to the appropriate URL and take a screenshot to verify the changes
- When starting dev servers, wait for them to be ready then navigate to test the application
- Report any visual issues, console errors, or unexpected behavior you observe
- Be proactive about suggesting which URLs to test based on the files being modified

You are intelligent enough to determine what URLs to test based on the project structure, development server configuration, and the specific files being modified.
`;

  private buildSystemPromptAppend(
    session: Session,
    memoriesPrompt?: string,
    gstackMode?: string,
    secureEnvContext?: string,
    supplementalConversationContext?: string,
  ): string {
    // Start with static content (cached by the API) then append dynamic context
    let append = ClaudeService.STATIC_SYSTEM_PROMPT;

    if (secureEnvContext) {
      append += `\n\n${secureEnvContext}`;
    }

    // Add SSH remote execution context if this is an SSH session
    if (session.sshConfig) {
      append += `

## Remote Execution Context

You are executing commands on a REMOTE machine via SSH. All file operations, bash commands, and tool executions happen on the remote server, not locally.

### Remote Connection Details
- **Host**: ${session.sshConfig.host}
- **Username**: ${session.sshConfig.username}
- **Working Directory**: ${session.worktreePath || session.sshConfig.remoteWorkdir}
${session.branch ? `- **Git Branch**: ${session.branch}` : ''}

### Important Notes
- All paths are relative to the remote working directory
- The browser preview tools run LOCALLY but your code changes are on the remote machine
- If you need to test a web application, remember it's running on the remote server (you may need to use the remote server's hostname or IP)

### Browser Cookies
Cookies from the user's local browser session are synced to \`/tmp/grep-build-cookies.json\` on this machine. If you need to browse an authenticated site using chrome-devtools, read that file and use \`mcp__chrome-devtools__set_cookies\` to inject them, or pass cookies to the browser via JavaScript.
`;

      // Add worktree setup output if available
      if (session.setupOutput) {
        // Clean up ANSI codes from the output
        const cleanOutput = session.setupOutput
          .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
          .replace(/___WORKDIR_END___/g, '') // Remove our internal marker
          .trim();

        if (cleanOutput) {
          append += `
### Worktree Setup Output

The following is the output from the worktree setup script that ran when this session was created. This provides context about the environment setup:

\`\`\`
${cleanOutput}
\`\`\`
`;
        }
      }
    }

    // Inject GStack skill routing if gstack is enabled in settings
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const gstackEnabled = settings.gstackEnabled as boolean | undefined;
    if (gstackEnabled) {
      const { getGStackRoutingPrompt } = require('./gstack.service');
      const routingPrompt = getGStackRoutingPrompt();
      if (routingPrompt) {
        append += '\n\n' + routingPrompt;
      }
    }

    // Add agent memories if available
    if (memoriesPrompt && memoriesPrompt.trim()) {
      append += `
## Your Memories

The following are facts, preferences, and knowledge you have remembered about this project. Use these to provide more relevant and context-aware assistance.

${memoriesPrompt}

**Note**: You can use the \`remember\`, \`recall\`, and \`forget\` tools to manage your memories.
`;
    }

    if (supplementalConversationContext && supplementalConversationContext.trim()) {
      append += `

## Recent Session Context From Other Models

The following recent turns happened in this same session, but may not be present in the current Claude transcript because they were produced while another model was active.
Use them to preserve continuity and avoid repeating work.

${supplementalConversationContext}
`;
    }

    if (session.htmlRenderMode === 'html') {
      append += `

## HTML Response Mode

For substantive responses (more than ~500 characters of content), respond with a complete, self-contained HTML document instead of Markdown. Output the HTML directly — do NOT wrap it in code fences or markdown blocks. Just output the raw HTML starting with <!DOCTYPE html>:

<!DOCTYPE html>
<html>
<head><style>/* your styles */</style></head>
<body>/* your content */</body>
</html>

### HTML Response Guidelines
- Use a dark theme: background #1a1a2e, text #e0e0e0, accent #7c3aed
- Use SVG for diagrams and visualizations (inline, no external deps)
- Use HTML tables for data (styled, not plain)
- Use collapsible \`<details>\` sections for lengthy content
- Use syntax-highlighted \`<pre><code>\` blocks for code
- NO external dependencies (no CDN links, no external CSS/JS)
- Make it visually rich: use color, spacing, borders, shadows
- For short responses (quick answers, confirmations), respond in plain text — no HTML wrapper needed
- Always include \`<meta charset="utf-8">\` in the head
`;
    }

    return append;
  }

  private getSecureEnvFilePath(sessionId: string, session: Session): string {
    return session.sshConfig
      ? `/tmp/g-build-secure-env-${sessionId}.sh`
      : path.join(os.tmpdir(), `g-build-secure-env-${sessionId}.sh`);
  }

  private createLocalClaudeCodeProcess(
    nodeExecutable: string | undefined,
    options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }
  ): SpawnedProcess {
    const child = spawn(nodeExecutable || options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', options.env.DEBUG_CLAUDE_AGENT_SDK ? 'pipe' : 'ignore'],
      signal: options.signal,
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create local Claude Code process stdio');
    }

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      kill: child.kill.bind(child),
      on: child.on.bind(child) as SpawnedProcess['on'],
      once: child.once.bind(child) as SpawnedProcess['once'],
      off: child.off.bind(child) as SpawnedProcess['off'],
    };
  }

  private resolveLocalNodeExecutable(): string | undefined {
    const homeDir = os.homedir();
    const candidates = new Set<string>();
    const addCandidate = (candidate?: string | null) => {
      if (!candidate) return;
      const trimmed = candidate.trim();
      if (!trimmed) return;
      candidates.add(trimmed);
    };

    addCandidate(process.env.CLAUDE_CODE_NODE_PATH);
    addCandidate(process.env.NODE);
    addCandidate(process.env.npm_node_execpath);

    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      addCandidate(path.join(dir, 'node'));
    }

    addCandidate('/opt/homebrew/bin/node');
    addCandidate('/usr/local/bin/node');
    addCandidate('/opt/local/bin/node');
    addCandidate(path.join(homeDir, '.nodenv', 'shims', 'node'));
    addCandidate(path.join(homeDir, '.asdf', 'shims', 'node'));
    addCandidate(path.join(homeDir, '.volta', 'bin', 'node'));

    const nvmVersionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      const versionDirs = fs.readdirSync(nvmVersionsDir)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const versionDir of versionDirs) {
        addCandidate(path.join(nvmVersionsDir, versionDir, 'bin', 'node'));
      }
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore invalid candidates and continue scanning.
      }
    }

    return undefined;
  }

  private formatSecureEnvFileContent(sessionId: string): string {
    const envVars = secureKeysService.getSessionEnvVars(sessionId);
    const lines = [
      `# Temporary secure environment variables for Build session ${sessionId}`,
      ...envVars.map(({ name, value }) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`),
      '',
    ];

    return lines.join('\n');
  }

  private async prepareSecureEnvContext(sessionId: string, session: Session): Promise<string | undefined> {
    const envVars = secureKeysService.getSessionEnvVars(sessionId);
    if (envVars.length === 0) {
      return undefined;
    }

    const envFilePath = this.getSecureEnvFilePath(sessionId, session);
    const envFileContent = this.formatSecureEnvFileContent(sessionId);

    if (session.sshConfig) {
      await sshService.writeRemoteFile(sessionId, session.sshConfig, envFilePath, envFileContent);
    } else {
      fs.writeFileSync(envFilePath, envFileContent, { mode: 0o600 });
      try {
        fs.chmodSync(envFilePath, 0o600);
      } catch {
        // best-effort permission tightening
      }
    }

    const envVarNames = envVars.map(({ name }) => `- ${name}`).join('\n');

    return `## Secure Environment Variables

The user provided sensitive environment variables. They are available in a temporary shell file at \`${envFilePath}\`.

Available variable names:
${envVarNames}

Read or source that file if you need the actual values. Do not print secret values into chat, logs, diffs, or committed files unless the user explicitly asks for that.`;
  }

  private normalizeConversationMessages(messages?: ChatMessage[]): ChatMessage[] {
    if (!messages || messages.length === 0) {
      return [];
    }

    return messages
      .map((message) => ({
        ...message,
        timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      }))
      .filter((message) => !Number.isNaN(message.timestamp.getTime()));
  }

  private buildSupplementalClaudeContext(transcriptMessages: ChatMessage[], supplementalMessages: ChatMessage[], userMessage: string): string {
    if (supplementalMessages.length === 0) {
      return '';
    }

    const lastTranscriptTimestamp = transcriptMessages.length > 0
      ? Math.max(...transcriptMessages.map((message) => message.timestamp.getTime()))
      : -Infinity;

    const deltaMessages = supplementalMessages.filter((message) => message.timestamp.getTime() > lastTranscriptTimestamp);
    const relevantMessages = transcriptMessages.length === 0 ? supplementalMessages : deltaMessages;
    if (relevantMessages.length === 0) {
      return '';
    }

    const CLAUDE_CONTEXT_MAX_CHARS = 20000;
    const promptBudget = userMessage.length + 2000;
    const contextBudget = Math.min(14000, CLAUDE_CONTEXT_MAX_CHARS - promptBudget);

    if (contextBudget <= 1000) {
      return '';
    }

    return formatConversationContext(relevantMessages, contextBudget);
  }

  // Get or create MCP server with browser snapshot tool for session
  private getBrowserMcpServer(sessionId: string) {
    // Create a fresh MCP server for each query — the SDK connects a transport
    // that can't be reused across queries ("Already connected to a transport" error)

    // Initialize Stagehand with API keys
    const apiKey = this.getApiKey();
    if (apiKey) {
      stagehandService.setApiKey(apiKey);
      console.log('[Claude Service] Set Anthropic API key for Stagehand');
    }
    // Pass Google API key for Gemini models (from store or environment)
    const googleApiKey = this.getGoogleApiKey() || process.env.GOOGLE_API_KEY;
    console.log('[Claude Service] Google API key check:', googleApiKey ? 'PRESENT' : 'MISSING', 'from store:', !!this.getGoogleApiKey(), 'from env:', !!process.env.GOOGLE_API_KEY);
    if (googleApiKey) {
      stagehandService.setGoogleApiKey(googleApiKey);
      console.log('[Claude Service] Set Google API key for Stagehand');
    } else {
      console.warn('[Claude Service] No Google API key available - Stagehand AI features will not work!');
    }

    // ============ STAGEHAND-POWERED BROWSER TOOLS ============
    // These tools use AI-powered browser automation via Stagehand

    const browserSnapshotTool = tool(
      'BrowserSnapshot',
      'Capture a snapshot of a webpage in the browser preview. Takes a screenshot and extracts the HTML content. Use this to inspect web pages, debug UI issues, or verify how pages render.',
      {
        url: z.string().describe('The URL to navigate to and capture'),
        waitForLoad: z.boolean().optional().describe('Wait for page to fully load before capturing (default: true)'),
        waitTime: z.number().optional().describe('Time to wait in milliseconds after navigation (default: 2000ms)'),
      },
      async (args) => {
        try {
          const { url, waitForLoad = true, waitTime = 2000 } = args;

          console.log('[Claude Service] Capturing browser snapshot via Stagehand:', url);

          // Also navigate the app's webview to keep it in sync
          browserService.navigate(sessionId, url).catch(err => {
            console.log('[Claude Service] Could not sync webview navigation:', err);
          });

          // Navigate using Stagehand
          const navResult = await stagehandService.navigate(url, sessionId);
          if (!navResult.success) {
            return {
              content: [{
                type: 'text',
                text: `Failed to navigate to ${url}: ${navResult.error}`,
              }],
              isError: true,
            };
          }

          // Additional wait if requested
          if (waitForLoad && waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 10000)));
          }

          // Capture full snapshot
          const snapshot = await stagehandService.captureSnapshot();
          if (!snapshot) {
            return {
              content: [{
                type: 'text',
                text: `Failed to capture snapshot of ${url}`,
              }],
              isError: true,
            };
          }

          // Emit navigation event to update UI
          this.emitBrowserUpdate(sessionId, snapshot.screenshot, snapshot.url);

          // Return snapshot info with image (MCP format)
          return {
            content: [
              {
                type: 'text',
                text: `Captured snapshot of ${snapshot.url} (${snapshot.title})\n\nHTML Preview:\n${snapshot.html.slice(0, 10000)}${snapshot.html.length > 10000 ? '...(truncated)' : ''}`,
              },
              {
                type: 'image',
                data: snapshot.screenshot,
                mimeType: 'image/png',
              },
            ],
          };
        } catch (error) {
          console.error('[Claude Service] Browser snapshot error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to capture browser snapshot: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserNavigate tool - simpler navigation without snapshot
    const browserNavigateTool = tool(
      'BrowserNavigate',
      'Navigate the browser preview to a URL without capturing a snapshot. Use this when you just want to go to a page.',
      {
        url: z.string().describe('The URL to navigate to'),
      },
      async (args) => {
        try {
          const { url } = args;

          // Ensure browser panel is open before Stagehand operations
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Navigating browser via Stagehand to:', url);
          const result = await stagehandService.navigate(url, sessionId);

          // Always sync the webview to the target URL.
          // If Stagehand connected to its own headless browser (fallback), the webview
          // won't have navigated. This ensures the visible browser preview stays in sync.
          if (result.success) {
            browserService.navigate(sessionId, url);
          }

          if (result.success && result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot, url);
          }

          return {
            content: [{
              type: 'text',
              text: result.success ? `Navigated to ${url}` : `Failed to navigate: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to navigate: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // ============ COMPUTER USE API TOOL ============
    // Claude-powered visual browser automation using screenshot-based interaction

    const computerUseTool = tool(
      'computer',
      'Interact with the browser using visual coordination. Takes screenshots and performs mouse/keyboard actions based on pixel coordinates. Use this for precise browser automation when you need to interact with visual elements. Coordinate space is 1024x768 virtual pixels.',
      {
        action: z.string().describe('Action to perform: screenshot, left_click, type, key, mouse_move, scroll, left_click_drag, right_click, middle_click, double_click, triple_click, left_mouse_down, left_mouse_up, hold_key, wait'),
        coordinate: z.tuple([z.number(), z.number()]).optional().describe('Pixel coordinates [x, y] for mouse actions (in 1024x768 virtual space)'),
        coordinate_end: z.tuple([z.number(), z.number()]).optional().describe('End coordinates for drag actions'),
        text: z.string().optional().describe('Text to type or key name to press'),
        scroll_direction: z.string().optional().describe('Scroll direction: up, down, left, right'),
        scroll_amount: z.number().optional().describe('Scroll amount (default: 5)'),
        duration: z.number().optional().describe('Duration in seconds for hold_key or wait'),
      },
      async (args) => {
        try {
          // Ensure browser panel is open
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Computer Use action:', args.action);
          const result = await computerUseService.executeAction(sessionId, args as any);

          const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
            { type: 'text', text: result.message }
          ];

          if (result.screenshot) {
            content.push({
              type: 'image',
              data: result.screenshot,
              mimeType: 'image/png'
            });

            // Emit browser update with screenshot
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return { content, isError: !result.success };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Computer use error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          };
        }
      }
    );

    // BrowserAct tool - AI-powered natural language actions (NEW - Stagehand feature!)
    const browserActTool = tool(
      'BrowserAct',
      'Execute a natural language action in the browser. This is the PRIMARY way to interact with web pages - use natural language like "click the login button", "fill in the email field with test@example.com", "scroll down to see more products". Much more reliable than CSS selectors!',
      {
        instruction: z.string().describe('Natural language instruction for what to do, e.g., "click the login button", "type hello in the search box", "scroll down"'),
      },
      async (args) => {
        try {
          const { instruction } = args;

          // Ensure browser panel is open before Stagehand operations
          await this.ensureBrowserPanelOpen(sessionId);

          console.log('[Claude Service] Browser act:', instruction);
          const result = await stagehandService.act(instruction, sessionId);

          if (result.success && result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [
              {
                type: 'text',
                text: result.success ? `✓ ${result.message}` : `✗ Failed: ${result.error}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserObserve tool - Discover available actions (NEW - Stagehand feature!)
    const browserObserveTool = tool(
      'BrowserObserve',
      'Analyze the current page to discover available actions and interactive elements. Returns a list of things you can do on the page. Use this when you need to understand what actions are possible.',
      {
        instruction: z.string().optional().describe('Optional: Focus on specific types of elements, e.g., "buttons for submitting forms" or "navigation links"'),
      },
      async (args) => {
        try {
          const { instruction } = args;
          console.log('[Claude Service] Browser observe:', instruction || 'all');
          const result = await stagehandService.observe(instruction, sessionId);

          if (!result.success) {
            return {
              content: [{
                type: 'text',
                text: `Failed to observe page: ${result.error}`,
              }],
              isError: true,
            };
          }

          const actionsText = result.actions?.map((a, i) =>
            `${i + 1}. ${a.description}\n   Action: ${a.suggestedAction}\n   Selector: ${a.selector}`
          ).join('\n\n') || 'No actions found';

          return {
            content: [
              {
                type: 'text',
                text: `Available actions on page:\n\n${actionsText}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to observe page: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserAgent tool - Autonomous multi-step workflows (NEW - Stagehand feature!)
    const browserAgentTool = tool(
      'BrowserAgent',
      'Execute a complex multi-step task autonomously. The agent will figure out the necessary steps and execute them. Use this for complex workflows like "log in to the website and navigate to settings".',
      {
        task: z.string().describe('The task to accomplish, e.g., "navigate to the pricing page and extract all plan names and prices"'),
      },
      async (args) => {
        try {
          const { task } = args;
          console.log('[Claude Service] Browser agent task:', task);
          const result = await stagehandService.agent(task, sessionId);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          const actionsLog = result.actions?.map((a, i) =>
            `${i + 1}. ${a.description}`
          ).join('\n') || 'No actions recorded';

          return {
            content: [
              {
                type: 'text',
                text: result.success
                  ? `✓ Task completed: ${result.message}\n\nActions taken:\n${actionsLog}`
                  : `✗ Task failed: ${result.error}`,
              },
              ...(result.screenshot ? [{
                type: 'image' as const,
                data: result.screenshot,
                mimeType: 'image/png' as const,
              }] : []),
            ],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to execute agent task: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserClick tool - click on elements (fallback when CSS selector is needed)
    const browserClickTool = tool(
      'BrowserClick',
      'Click on an element using a CSS selector. NOTE: Prefer using BrowserAct with natural language (e.g., "click the login button") as it is more reliable and self-healing.',
      {
        selector: z.string().describe('CSS selector for the element to click (e.g., "button.submit", "#login-btn")'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] BrowserClick ENTRY - selector:', selector);
          console.log('[Claude Service] stagehandService:', typeof stagehandService, Object.keys(stagehandService));
          const result = await stagehandService.click(selector);
          console.log('[Claude Service] BrowserClick result:', result);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [{
              type: 'text',
              text: result.success ? `Clicked element: ${selector}` : `Failed to click: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to click: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserType tool - type text into inputs (fallback when CSS selector is needed)
    const browserTypeTool = tool(
      'BrowserType',
      'Type text into an input field using a CSS selector. NOTE: Prefer using BrowserAct with natural language (e.g., "type hello@example.com in the email field") as it is more reliable.',
      {
        selector: z.string().describe('CSS selector for the input element (e.g., "input[name=\'email\']", "#search-box")'),
        text: z.string().describe('The text to type into the element'),
      },
      async (args) => {
        try {
          const { selector, text } = args;
          console.log('[Claude Service] Typing into element via Stagehand:', selector);
          const result = await stagehandService.type(selector, text);

          if (result.screenshot) {
            this.emitBrowserUpdate(sessionId, result.screenshot);
          }

          return {
            content: [{
              type: 'text',
              text: result.success
                ? `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" into ${selector}`
                : `Failed to type: ${result.error}`,
            }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to type: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserExtract tool - extract text from page
    const browserExtractTool = tool(
      'BrowserExtract',
      'Extract text content from the browser. Can extract from the whole page or a specific element. For structured data extraction, consider using BrowserExtractData instead.',
      {
        selector: z.string().optional().describe('Optional CSS selector to extract from specific element. If not provided, extracts all page text.'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] Extracting text via Stagehand:', selector || 'full page');
          const result = await stagehandService.extractText(selector);

          if (result.success && result.text !== undefined) {
            const truncated = result.text.length > 5000;
            return {
              content: [{
                type: 'text',
                text: `Extracted text${selector ? ` from ${selector}` : ''}:\n\n${result.text.slice(0, 5000)}${truncated ? '\n\n...(truncated)' : ''}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Failed to extract: ${result.error}`,
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to extract: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserExtractData tool - AI-powered structured data extraction (NEW - Stagehand feature!)
    const browserExtractDataTool = tool(
      'BrowserExtractData',
      'Extract structured data from the page using AI. Describe what data you want and it will be extracted intelligently. Returns JSON data.',
      {
        instruction: z.string().describe('What to extract, e.g., "the product name, price, and rating", "all navigation menu items", "the main article title and author"'),
      },
      async (args) => {
        try {
          const { instruction } = args;
          console.log('[Claude Service] AI data extraction:', instruction);

          // Use a simple schema compatible with Gemini's structured output API.
          // z.record() doesn't produce valid Gemini schema (missing items field),
          // so we use explicit object properties instead.
          const flexibleSchema = z.object({
            items: z.array(z.object({
              label: z.string().describe('Label or key for the extracted item'),
              value: z.string().describe('Value or content of the extracted item'),
            })).describe('Extracted items as label-value pairs'),
          });

          const result = await stagehandService.extract<{ items: Array<{ label: string; value: string }> }>(instruction, flexibleSchema);

          if (result.success && result.data) {
            return {
              content: [{
                type: 'text',
                text: `Extracted data:\n\n${JSON.stringify(result.data, null, 2)}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Failed to extract data: ${result.error}`,
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to extract data: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserGetInfo tool - get current page info
    const browserGetInfoTool = tool(
      'BrowserGetInfo',
      'Get information about the current page in the browser preview (URL, title).',
      {},
      async () => {
        try {
          console.log('[Claude Service] Getting page info via Stagehand');
          const info = await stagehandService.getPageInfo();

          if (info) {
            return {
              content: [{
                type: 'text',
                text: `Current page:\nURL: ${info.url}\nTitle: ${info.title}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: 'Browser not initialized. Navigate to a page first.',
              }],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to get page info: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // BrowserGetDOM tool - get full DOM without truncation
    const browserGetDOMTool = tool(
      'BrowserGetDOM',
      'Get the complete HTML DOM of the current page. Use this when you need to find elements that may not be visible in the initial snapshot preview.',
      {
        selector: z.string().optional().describe('Optional CSS selector to get HTML of specific element instead of whole document'),
      },
      async (args) => {
        try {
          const { selector } = args;
          console.log('[Claude Service] Getting DOM via Stagehand:', selector || 'full page');

          const html = await stagehandService.getHTML();
          if (!html) {
            return {
              content: [{
                type: 'text',
                text: 'Browser not initialized. Navigate to a page first.',
              }],
              isError: true,
            };
          }

          // If selector provided, we could filter but Stagehand doesn't have direct script execution
          // For now, return full HTML - user can use BrowserExtract for specific elements
          if (selector) {
            // Note: Stagehand's page.evaluate could be used here if needed
            console.log('[Claude Service] Note: selector filtering not implemented, returning full DOM');
          }

          // Cap at reasonable limit to avoid overwhelming Claude
          const maxLength = 50000;
          const truncated = html.length > maxLength;

          return {
            content: [{
              type: 'text',
              text: `DOM HTML:\n\n${html.slice(0, maxLength)}${truncated ? '\n\n...(truncated - use BrowserExtract for specific content)' : ''}`,
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to get DOM: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // Note: CDP-based debugging tools (console logs, network requests) are not available with Stagehand
    // Stagehand provides AI-powered automation instead of low-level CDP access

    // UpdateSessionName tool - allow Claude to set descriptive session names
    const updateSessionNameTool = tool(
      'UpdateSessionName',
      'Update the current session name with a descriptive title. Call this when you understand what the session is about to help the user identify it later. Use concise, descriptive titles (3-5 words).',
      {
        name: z.string().describe('A concise descriptive name for this session (e.g., "Video Processing Workflow", "Entity Research Integration")'),
      },
      async (args) => {
        try {
          const { name } = args;
          console.log('[Claude Service] Updating session name:', sessionId, '→', name);

          // Store the custom name
          this.sessionStore.set(`sessionNames.${sessionId}`, name);
          this.onSessionNameChanged?.();

          return {
            content: [{
              type: 'text',
              text: `Session name updated to: "${name}"`,
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Failed to update session name: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentCreate tool - create DOCX, XLSX, or presentation files
    const documentCreateTool = tool(
      'DocumentCreate',
      'Create a new document (Word, Excel spreadsheet, or HTML slide presentation). Use this to generate office documents for reports, data exports, or presentations.',
      {
        type: z.string().describe('Document type - must be one of: "docx" for Word, "xlsx" for Excel, "slides" for reveal.js presentation'),
        path: z.string().describe('Full file path where to save the document'),
        title: z.string().optional().describe('Document title (used for DOCX title or presentation title)'),
        content: z.any().describe('Document content - structure depends on type. For docx: array of {type, text, level?, rows?, items?}. For xlsx: {sheets: [{name, data: 2D array}]}. For slides: {slides: [{title?, content, notes?, background?, transition?}]}'),
      },
      async (args) => {
        try {
          const { type, path: docPath, title, content } = args;
          console.log('[Claude Service] Creating document:', type, docPath);

          let resultPath: string;

          switch (type) {
            case 'docx':
              resultPath = await documentService.createDocx({
                path: docPath,
                title: title,
                content: content as any,
              });
              break;
            case 'xlsx':
              resultPath = await documentService.createXlsx({
                path: docPath,
                sheets: content?.sheets || [{ name: 'Sheet1', data: content?.data || [[]] }],
              });
              break;
            case 'slides':
              resultPath = await documentService.createPresentation({
                path: docPath,
                title: title || 'Presentation',
                theme: content?.theme,
                slides: content?.slides || [],
              });
              break;
            default:
              return {
                content: [{ type: 'text', text: `Unsupported document type: ${type}` }],
                isError: true,
              };
          }

          return {
            content: [{
              type: 'text',
              text: `Created ${type.toUpperCase()} document at: ${resultPath}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentCreate error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to create document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentRead tool - read document content
    const documentReadTool = tool(
      'DocumentRead',
      'Read the content of a document (Word or Excel). Returns the text content or spreadsheet data.',
      {
        path: z.string().describe('Full file path of the document to read'),
      },
      async (args) => {
        try {
          const { path: docPath } = args;
          console.log('[Claude Service] Reading document:', docPath);

          const docType = documentService.getDocumentType(docPath);

          switch (docType) {
            case 'xlsx': {
              const data = await documentService.readXlsx(docPath);
              let summary = '';
              for (const sheet of data.sheets) {
                summary += `\n## Sheet: ${sheet.name}\n`;
                if (sheet.data.length > 0) {
                  const maxRows = Math.min(sheet.data.length, 50);
                  for (let i = 0; i < maxRows; i++) {
                    const row = sheet.data[i];
                    if (row && row.length > 0) {
                      summary += row.map(cell => cell?.value ?? '').join('\t') + '\n';
                    }
                  }
                  if (sheet.data.length > maxRows) {
                    summary += `\n... and ${sheet.data.length - maxRows} more rows`;
                  }
                }
              }
              return {
                content: [{
                  type: 'text',
                  text: `Spreadsheet content from ${docPath}:${summary}`,
                }],
              };
            }
            case 'docx': {
              const rendered = await documentService.renderDocx(docPath);
              const textContent = rendered.html
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, '\n')
                .replace(/\n\s*\n/g, '\n\n')
                .trim()
                .slice(0, 10000);
              return {
                content: [{
                  type: 'text',
                  text: `Word document content from ${docPath}:\n\n${textContent}${textContent.length >= 10000 ? '\n...(truncated)' : ''}`,
                }],
              };
            }
            default:
              return {
                content: [{
                  type: 'text',
                  text: `Cannot read document type: ${docType}. Supported types: docx, xlsx`,
                }],
                isError: true,
              };
          }
        } catch (error) {
          console.error('[Claude Service] DocumentRead error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to read document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentEdit tool - edit Excel cells
    const documentEditTool = tool(
      'DocumentEdit',
      'Edit cells in an Excel spreadsheet. Can update values or formulas in specific cells.',
      {
        path: z.string().describe('Full file path of the Excel file to edit'),
        updates: z.array(z.object({
          sheet: z.string().or(z.number()).describe('Sheet name or index (0-based)'),
          cell: z.string().describe('Cell reference (e.g., "A1", "B2", "C10")'),
          value: z.string().or(z.number()).or(z.boolean()).or(z.null()).optional().describe('New cell value'),
          formula: z.string().optional().describe('Excel formula (without leading =)'),
        })).describe('Array of cell updates'),
      },
      async (args) => {
        try {
          const { path: docPath, updates } = args;
          console.log('[Claude Service] Editing document:', docPath, updates.length, 'updates');

          await documentService.updateXlsxCells(docPath, updates as any);

          return {
            content: [{
              type: 'text',
              text: `Updated ${updates.length} cell(s) in ${docPath}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentEdit error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to edit document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // DocumentPreview tool - preview document in browser panel
    const documentPreviewTool = tool(
      'DocumentPreview',
      'Preview a document (Word, Excel, or presentation) in the browser panel. Converts the document to HTML and displays it.',
      {
        path: z.string().describe('Full file path of the document to preview'),
      },
      async (args) => {
        try {
          const { path: docPath } = args;
          console.log('[Claude Service] Previewing document:', docPath);

          const content = await documentService.renderDocument(docPath);
          const previewPath = await documentService.saveForPreview(content, docPath);
          const fileUrl = `file://${previewPath}`;
          await browserService.navigate(sessionId, fileUrl);

          return {
            content: [{
              type: 'text',
              text: `Previewing ${docPath} in browser panel`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] DocumentPreview error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to preview document: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // ============ MEMORY TOOLS ============
    // These tools allow the agent to persist knowledge across sessions

    // Get project path from session for memory operations
    const getProjectPath = (): string | undefined => {
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      return session?.worktreePath || session?.repoPath;
    };

    const memoryRememberTool = tool(
      'remember',
      'Store an important fact, preference, or discovery for future reference. Use this when you learn something valuable that should persist across sessions. Categories: preference (user preferences), codebase (code structure facts), architecture (design decisions), path (useful file paths), context (current work context).',
      {
        category: z.string().describe('Category: preference, codebase, architecture, path, or context'),
        content: z.string().describe('The fact or information to remember'),
      },
      async (args) => {
        try {
          const { category, content } = args;
          const projectPath = getProjectPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot remember: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Remembering fact:', category, content.substring(0, 50));

          const fact = await memoryService.remember(
            { category: category as MemoryCategory, content, source: 'agent' },
            projectPath
          );

          return {
            content: [{
              type: 'text',
              text: `Remembered [${fact.category}]: "${fact.content}" (id: ${fact.id})`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory remember error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to remember: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryRecallTool = tool(
      'recall',
      'Search your memories for relevant information. Use this before searching the codebase to check if you already know the answer.',
      {
        query: z.string().describe('What to search for in memories'),
        category: z.string().optional().describe('Optional filter: preference, codebase, architecture, path, or context'),
        limit: z.number().optional().describe('Maximum number of results (default: 10)'),
      },
      async (args) => {
        try {
          const { query, category, limit } = args;
          const projectPath = getProjectPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot recall: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Recalling memories for query:', query);

          const facts = await memoryService.recall(query, projectPath, {
            category: category as MemoryCategory | undefined,
            limit,
          });

          if (facts.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No memories found matching: "${query}"`,
              }],
            };
          }

          const formattedFacts = facts.map(f =>
            `- [${f.category}] ${f.content} (id: ${f.id})`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `Found ${facts.length} memories:\n\n${formattedFacts}`,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory recall error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to recall: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryForgetTool = tool(
      'forget',
      'Remove a memory that is no longer accurate or relevant.',
      {
        factId: z.string().describe('ID of the memory to forget'),
      },
      async (args) => {
        try {
          const { factId } = args;
          const projectPath = getProjectPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot forget: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Forgetting fact:', factId);

          const success = await memoryService.forget(factId, projectPath);

          if (success) {
            return {
              content: [{
                type: 'text',
                text: `Forgot memory with id: ${factId}`,
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: `Memory not found with id: ${factId}`,
              }],
            };
          }
        } catch (error) {
          console.error('[Claude Service] Memory forget error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to forget: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const memoryListTool = tool(
      'listMemories',
      'List all memories for the current project. Useful for reviewing what has been remembered.',
      {},
      async () => {
        try {
          const projectPath = getProjectPath();

          if (!projectPath) {
            return {
              content: [{
                type: 'text',
                text: 'Cannot list memories: no project path found for this session.',
              }],
              isError: true,
            };
          }

          console.log('[Claude Service] Listing all memories');

          const facts = await memoryService.listMemories(projectPath);

          if (facts.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No memories stored for this project yet.',
              }],
            };
          }

          // Group by category
          const byCategory: Record<string, typeof facts> = {};
          for (const fact of facts) {
            if (!byCategory[fact.category]) {
              byCategory[fact.category] = [];
            }
            byCategory[fact.category].push(fact);
          }

          let output = `Found ${facts.length} memories:\n\n`;
          for (const [category, categoryFacts] of Object.entries(byCategory)) {
            output += `### ${category}\n`;
            for (const f of categoryFacts) {
              output += `- ${f.content} (id: ${f.id})\n`;
            }
            output += '\n';
          }

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] Memory list error:', error);
          return {
            content: [{
              type: 'text',
              text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    // Codex second opinion tool (OpenAI Codex SDK)
    const codexSecondOpinionTool = tool(
      'CodexSecondOpinion',
      'Get a second opinion from OpenAI Codex on a specific coding task. Codex will analyze the codebase and provide its perspective. Use this when you want to validate your approach, get an alternative solution, or need a fresh perspective on a problem.',
      {
        prompt: z.string().describe('The task or question to ask Codex about'),
        context: z.string().optional().describe('Additional context about what you are working on'),
      },
      async (args) => {
        try {
          const fullPrompt = args.context
            ? `Context: ${args.context}\n\nTask: ${args.prompt}`
            : args.prompt;

          const cwd = getProjectPath() || process.cwd();
          const result = await codexService.runForTool(sessionId, fullPrompt, cwd);

          let responseText = result.summary;
          if (result.toolCalls.length > 0) {
            responseText += '\n\n--- Actions taken ---\n';
            for (const tc of result.toolCalls) {
              responseText += `[${tc.type}] ${tc.detail}\n`;
            }
          }
          if (result.reasoning) {
            responseText += `\n\n--- Reasoning ---\n${result.reasoning}`;
          }

          return {
            content: [{
              type: 'text' as const,
              text: responseText,
            }],
          };
        } catch (error) {
          console.error('[Claude Service] CodexSecondOpinion error:', error);
          return {
            content: [{
              type: 'text' as const,
              text: `Failed to get Codex second opinion: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          };
        }
      }
    );

    const mcpServer = createSdkMcpServer({
      name: 'claudette-browser',
      version: '2.0.0', // Upgraded to Stagehand-powered automation
      tools: [
        // ============ COMPUTER USE API TOOL ============
        // Claude-powered visual automation
        computerUseTool,          // Screenshot-based interaction (CLAUDE NATIVE)

        // ============ STAGEHAND AI-POWERED TOOLS ONLY ============
        // These use Stagehand's AI for browser automation
        browserActTool,           // Natural language actions (PRIMARY)
        browserObserveTool,       // Discover available actions
        browserAgentTool,         // Autonomous multi-step workflows
        browserExtractDataTool,   // AI-powered data extraction

        // Navigation (uses Stagehand)
        browserNavigateTool,

        // ============ NON-BROWSER TOOLS ============
        // Utility tools
        updateSessionNameTool,
        // Document tools
        documentCreateTool,
        documentReadTool,
        documentEditTool,
        documentPreviewTool,
        // Memory tools
        memoryRememberTool,
        memoryRecallTool,
        memoryForgetTool,
        memoryListTool,

        // ============ CODEX SECOND OPINION ============
        codexSecondOpinionTool,

        // ============ SELECTOR-BASED BROWSER TOOLS ============
        browserSnapshotTool,
        browserClickTool,
        browserTypeTool,
        browserExtractTool,
        browserGetInfoTool,
        browserGetDOMTool,
      ],
    });

    return mcpServer;
  }

  /**
   * Execute browser tools locally (used for SSH sessions where browser is local)
   */
  private async executeLocalBrowserTool(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<any> {
    console.log('[Claude Service] Executing browser tool locally:', toolName, input);

    // Ensure browser panel is open
    await this.ensureBrowserPanelOpen(sessionId);

    // Sync cookies from webview into Stagehand before any browser tool execution
    try {
      await stagehandService.syncCookiesFromWebview(sessionId);
    } catch (error) {
      console.warn('[Claude Service] Cookie sync failed (non-fatal):', error);
    }

    switch (toolName) {
      case 'BrowserNavigate': {
        const result = await stagehandService.navigate(input.url as string, sessionId);
        // Also sync the webview in case Stagehand is using its own browser
        if (result.success) {
          browserService.navigate(sessionId, input.url as string);
        }
        return result;
      }

      case 'BrowserAct':
        return stagehandService.act(input.instruction as string, sessionId);

      case 'BrowserObserve':
        return stagehandService.observe(input.instruction as string | undefined, sessionId);

      case 'BrowserAgent':
        return stagehandService.agent(input.task as string, sessionId);

      case 'BrowserExtractData':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return stagehandService.extract(input.instruction as string, input.schema as any);

      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  }

  /**
   * Execute chrome-devtools MCP tool calls locally against the CDP proxy.
   * Used for SSH sessions where the remote machine has no Chrome browser.
   */
  private async executeLocalChromeDevtool(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<any> {
    console.log('[Claude Service] Executing chrome-devtools tool locally:', toolName, input);

    // Ensure browser panel is open
    await this.ensureBrowserPanelOpen(sessionId);

    switch (toolName) {
      case 'list_pages':
      case 'listPages': {
        const targets = cdpProxyService.getTargets();
        return {
          pages: targets.map(t => ({
            id: t.id,
            url: t.url,
            title: t.title || '',
            type: t.type,
          })),
        };
      }

      case 'execute_javascript':
      case 'executeJavascript': {
        const expression = input.expression as string || input.javascript as string;
        if (!expression) throw new Error('expression or javascript parameter required');

        const targetSessionId = browserService.getFirstSessionId();
        if (!targetSessionId) throw new Error('No webview available');

        const wcId = browserService.getWebContentsId(targetSessionId);
        if (!wcId) throw new Error('No webview webContents available');

        const { webContents } = await import('electron');
        const wc = webContents.fromId(wcId);
        if (!wc) throw new Error('WebContents not found');

        if (!wc.debugger.isAttached()) {
          wc.debugger.attach('1.3');
        }
        const result = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return { result: result.result?.value, type: result.result?.type };
      }

      case 'navigate': {
        const url = input.url as string;
        if (!url) throw new Error('url parameter required');
        const result = await stagehandService.navigate(url, sessionId);
        if (result.success) {
          browserService.navigate(sessionId, url);
        }
        return result;
      }

      case 'screenshot': {
        const screenshot = await stagehandService.captureScreenshot();
        return { screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null };
      }

      case 'get_console_logs':
      case 'getConsoleLogs': {
        const logs = browserService.getConsoleLogs(sessionId);
        return { logs: logs || [] };
      }

      case 'get_cookies':
      case 'getCookies': {
        const { session: electronSession } = await import('electron');
        const targetSid = browserService.getFirstSessionId() || sessionId;
        const partitionName = `persist:browser-${targetSid}`;
        const ses = electronSession.fromPartition(partitionName);
        const filter: Electron.CookiesGetFilter = input.url ? { url: input.url as string } : {};
        const cookies = await ses.cookies.get(filter);
        return { cookies };
      }

      case 'set_cookies':
      case 'setCookies': {
        const { session: electronSession } = await import('electron');
        const targetSid = browserService.getFirstSessionId() || sessionId;
        const partitionName = `persist:browser-${targetSid}`;
        const ses = electronSession.fromPartition(partitionName);
        const cookiesToSet = (input.cookies as Array<{ url: string; name: string; value: string; domain?: string; path?: string }>) || [];
        for (const cookie of cookiesToSet) {
          await ses.cookies.set(cookie);
        }
        return { success: true, count: cookiesToSet.length };
      }

      default:
        throw new Error(`Unknown chrome-devtools tool: ${toolName}`);
    }
  }

  /**
   * Create a local in-process MCP server for chrome-devtools.
   * Used for SSH sessions so the agent can see the same tools without npx on the remote.
   */
  private getChromeDevtoolsMcpServer(sessionId: string) {
    return createSdkMcpServer({
      name: 'chrome-devtools',
      version: '1.0.0',
      tools: [
        tool('list_pages', 'List all available browser pages/tabs', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'list_pages', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('execute_javascript', 'Execute JavaScript in the browser page', {
          expression: z.string().describe('JavaScript expression to evaluate'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'execute_javascript', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('navigate', 'Navigate the browser to a URL', {
          url: z.string().describe('URL to navigate to'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'navigate', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('screenshot', 'Take a screenshot of the current page', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'screenshot', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('get_console_logs', 'Get console logs from the browser page', {}, async () => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'get_console_logs', {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('get_cookies', 'Get cookies from the browser', {
          url: z.string().optional().describe('Optional URL to filter cookies'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'get_cookies', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
        tool('set_cookies', 'Set cookies in the browser', {
          cookies: z.array(z.object({
            url: z.string(),
            name: z.string(),
            value: z.string(),
            domain: z.string().optional(),
            path: z.string().optional(),
          })).describe('Array of cookies to set'),
        }, async (input) => {
          const result = await this.executeLocalChromeDevtool(sessionId, 'set_cookies', input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }),
      ],
    });
  }

  setApiKey(apiKey: string): void {
    this.store.set('anthropicApiKey', apiKey);
  }

  getGoogleApiKey(): string | undefined {
    return this.store.get('googleApiKey') as string | undefined;
  }

  setGoogleApiKey(apiKey: string): void {
    this.store.set('googleApiKey', apiKey);
  }

  // Handle question responses from the renderer
  handleQuestionResponse(response: QuestionResponse & { cancelled?: boolean }): void {
    const pending = this.pendingQuestions.get(response.requestId);
    if (pending) {
      if (response.cancelled) {
        pending.reject(new Error('User dismissed the question'));
      } else {
        pending.resolve(response.answers);
      }
      this.pendingQuestions.delete(response.requestId);
    }
  }

  // Handle permission responses from the renderer
  handlePermissionResponse(response: { requestId: string; approved: boolean; modifiedInput?: Record<string, unknown>; alwaysApprove?: boolean }): void {
    console.log('[Claude Service] handlePermissionResponse called:', response.requestId, 'approved:', response.approved, 'alwaysApprove:', response.alwaysApprove);
    const pending = this.pendingPermissions.get(response.requestId);
    if (pending) {
      console.log('[Claude Service] Found pending permission, resolving...');

      // If "always approve" was selected, save the permission pattern
      if (response.approved && response.alwaysApprove && pending.toolName === 'Bash') {
        this.savePermissionPattern(pending.sessionId, pending.toolName, pending.input);
      }

      pending.resolve({ approved: response.approved, modifiedInput: response.modifiedInput });
      this.pendingPermissions.delete(response.requestId);
    } else {
      console.warn('[Claude Service] No pending permission found for requestId:', response.requestId);
    }
  }

  // Save a permission pattern to the project's .claude/settings.local.json
  private async savePermissionPattern(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<void> {
    try {
      // Get the session to find the worktree path
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      if (!session) {
        console.warn('[Claude Service] Could not find session for permission pattern save:', sessionId);
        return;
      }

      const projectPath = session.worktreePath || session.repoPath;
      if (!projectPath) {
        console.warn('[Claude Service] No project path found for session:', sessionId);
        return;
      }

      // Extract the command pattern for Bash tool
      const command = input.command as string;
      if (!command) {
        console.warn('[Claude Service] No command found in Bash input');
        return;
      }

      // Extract wildcard pattern: "gh pr list main" -> "gh pr *"
      const parts = command.trim().split(/\s+/);
      let pattern: string;
      if (parts.length <= 2) {
        pattern = parts[0] + ' *';
      } else {
        pattern = parts.slice(0, 2).join(' ') + ' *';
      }

      // Read existing settings.local.json or create new one
      const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
      const claudeDir = path.dirname(settingsPath);

      // Ensure .claude directory exists
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      let settings: { allowedTools?: string[] } = {};
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      }

      // Initialize allowedTools array if not present
      if (!settings.allowedTools) {
        settings.allowedTools = [];
      }

      // Add the pattern if not already present (format: "Bash(pattern)")
      const permissionEntry = `Bash(${pattern})`;
      if (!settings.allowedTools.includes(permissionEntry)) {
        settings.allowedTools.push(permissionEntry);
        console.log('[Claude Service] Adding permission pattern:', permissionEntry);

        // Write back to settings.local.json
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('[Claude Service] Saved permission to:', settingsPath);
      } else {
        console.log('[Claude Service] Permission pattern already exists:', permissionEntry);
      }
    } catch (error) {
      console.error('[Claude Service] Failed to save permission pattern:', error);
    }
  }

  // Ask user for permission via the renderer
  private async askUserPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ approved: boolean; modifiedInput?: Record<string, unknown> }> {
    const requestId = `permission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingPermissions.set(requestId, { resolve, reject, sessionId, toolName, input });

      // Send permission request to renderer
      if (this.mainWindow) {
        const request = {
          sessionId,
          requestId,
          toolName,
          toolInput: input,  // Use toolInput to match PermissionRequest type
        };
        console.log('[Claude Service] Sending permission request to renderer:', toolName, 'sessionId:', sessionId, 'requestId:', requestId, 'input:', JSON.stringify(input));
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, request);
      } else {
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds
      setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          reject(new Error('Permission response timeout'));
        }
      }, 5 * 60 * 1000); // 5 minute timeout
    });
  }

  // Handle plan approval responses from the renderer
  handlePlanApprovalResponse(response: PlanApprovalResponse): void {
    const pending = this.pendingPlanApprovals.get(response.requestId);
    if (pending) {
      // Store feedback if provided for use in rejection message (scoped per session)
      if (!response.approved && response.feedback) {
        this.lastPlanFeedback.set(pending.sessionId, response.feedback);
      }
      pending.resolve(response.approved);
      this.pendingPlanApprovals.delete(response.requestId);
    }
  }

  // Ask user to approve a plan via the renderer
  private async askPlanApproval(
    sessionId: string,
    planContent: string,
    planFilePath?: string,
    allowedPrompts?: Array<{ tool: string; prompt: string }>
  ): Promise<boolean> {
    const requestId = `plan-approval-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingPlanApprovals.set(requestId, { resolve, reject, sessionId });

      // Send plan approval request to renderer
      if (this.mainWindow) {
        const request: PlanApprovalRequest = {
          sessionId,
          requestId,
          planContent,
          planFilePath,
          allowedPrompts,
        };
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_REQUEST, request);
      } else {
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds (10 minute timeout for plans)
      setTimeout(() => {
        if (this.pendingPlanApprovals.has(requestId)) {
          this.pendingPlanApprovals.delete(requestId);
          reject(new Error('Plan approval response timeout'));
        }
      }, 10 * 60 * 1000); // 10 minute timeout
    });
  }

  // Ask user a question via the renderer
  private async askUserQuestion(sessionId: string, questions: unknown[]): Promise<Record<string, string>> {
    const requestId = `question-${Date.now()}-${Math.random()}`;

    return new Promise((resolve, reject) => {
      // Store the promise resolve/reject functions
      this.pendingQuestions.set(requestId, { resolve, reject });

      // Send question request to renderer
      if (this.mainWindow) {
        const request: QuestionRequest = {
          sessionId,
          requestId,
          questions: questions as any, // SDK types match our Question type
        };
        this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_QUESTION_REQUEST, request);
      } else {
        reject(new Error('Main window not available'));
      }

      // Set a timeout in case the user never responds
      setTimeout(() => {
        if (this.pendingQuestions.has(requestId)) {
          this.pendingQuestions.delete(requestId);
          reject(new Error('Question response timeout'));
        }
      }, 5 * 60 * 1000); // 5 minute timeout
    });
  }

  /**
   * Ephemeral side question (/btw) — makes a direct Anthropic API call with
   * conversation context but does NOT add anything to the session history.
   * Streams response chunks back via IPC.
   */
  // Remote control child processes — one per session
  private rcProcesses = new Map<string, import('child_process').ChildProcess>();

  /**
   * Start a remote control session by spawning `claude remote-control` as a child process.
   * Parses the URL from stdout and emits CLAUDE_RC_STARTED.
   */
  async startRemoteControl(sessionId: string): Promise<void> {
    // If already running, just re-emit the URL
    if (this.rcProcesses.has(sessionId)) {
      console.log('[Claude Service] Remote control already active for session:', sessionId);
      return;
    }

    // Check both manual sessions and discovered sessions (discovered sessions may not be in sessions.*)
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);
    const sessionName = session?.name || 'Build';
    console.log('[Claude Service] startRemoteControl for:', sessionId, 'found:', !!session, 'ssh:', !!session?.sshConfig);

    // For SSH sessions, run remote-control on the remote machine via SSH
    if (session?.sshConfig) {
      await this.startRemoteControlSSH(sessionId, session.sshConfig, sessionName);
      return;
    }

    const cwd = session?.repoPath || process.cwd();
    const { spawn } = require('child_process') as typeof import('child_process');

    // Remote control is now a standalone subcommand (no longer combinable with --resume).
    // It creates a persistent server that accepts sessions from claude.ai/code.
    console.log('[Claude Service] Starting remote-control server for session:', sessionId, 'name:', sessionName);
    const child = spawn('claude', ['remote-control', '--name', sessionName], {
      cwd,
      shell: true,
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rcProcesses.set(sessionId, child);

    // Auto-confirm the "Enable Remote Control? (y/n)" prompt
    child.stdin?.write('y\n');

    this.attachRcOutputHandlers(sessionId, child);
  }

  private attachRcOutputHandlers(sessionId: string, child: import('child_process').ChildProcess): void {
    let outputBuffer = '';
    let urlEmitted = false;

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;
      console.log('[Claude Service] RC stdout:', text.replace(/\x1b\[[^m]*m/g, '').trim());

      // Look for the URL in the output (strip ANSI escape sequences first)
      if (!urlEmitted) {
        const cleanBuffer = outputBuffer.replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[^m]*m/g, '');
        const urlMatch = cleanBuffer.match(/https:\/\/claude\.ai\/code\?environment=[^\s]+/)
          || cleanBuffer.match(/https:\/\/claude\.ai\/code\?bridge=[^\s]+/)
          || cleanBuffer.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
        if (urlMatch) {
          urlEmitted = true;
          const url = urlMatch[0];
          console.log('[Claude Service] Remote control URL detected:', url);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STARTED, {
            sessionId,
            url,
          });
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.log('[Claude Service] RC stderr:', data.toString().trim());
    });

    child.on('close', (code) => {
      console.log('[Claude Service] Remote control process exited with code:', code);
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    });

    child.on('error', (err) => {
      console.error('[Claude Service] Remote control process error:', err);
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    });
  }

  /**
   * Start remote control on an SSH session by running `claude remote-control` on the remote machine.
   */
  private async startRemoteControlSSH(sessionId: string, sshConfig: import('../../shared/types').SSHConfig, sessionName: string): Promise<void> {
    try {
      const client = await sshService['getConnection'](sessionId, sshConfig);
      const claudePaths = `/home/${sshConfig.username}/.local/bin:/home/${sshConfig.username}/bin:/usr/local/bin:/usr/bin`;

      // Remote control is now a standalone subcommand (no longer combinable with --resume).
      console.log('[Claude Service] SSH RC: starting remote-control server for:', sessionName);
      const command = `export PATH="${claudePaths}:$PATH" && cd "${sshConfig.remoteWorkdir}" && echo y | claude remote-control --name "${sessionName}"`;

      console.log('[Claude Service] Starting remote control on SSH:', command);

      // Allocate a PTY so `claude remote-control` (an interactive CLI) flushes
      // its stdout promptly. Without pty:true the ssh2 channel's `data` event
      // never fires for line-buffered, TTY-aware CLIs — the output stays
      // stuck in the remote process's stdout buffer. This was the silent
      // stall: command launched, log line "Starting remote control on SSH"
      // printed, then nothing ever came back.
      client.exec(command, { pty: true }, (err, channel) => {
        if (err) {
          console.error('[Claude Service] SSH RC exec error:', err);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
          return;
        }

        console.log('[Claude Service] SSH RC channel opened with PTY for session:', sessionId);

        // Store the channel so we can kill it later (wrap as a fake ChildProcess)
        const fakeProcess = {
          kill: () => { channel.close(); },
          stdout: channel,
          stderr: channel.stderr,
          stdin: channel,
        } as any;
        this.rcProcesses.set(sessionId, fakeProcess);

        let outputBuffer = '';
        let urlEmitted = false;

        channel.on('data', (data: Buffer) => {
          const text = data.toString();
          outputBuffer += text;
          const clean = text.replace(/\x1b\[[^m]*m/g, '').replace(/\[\d+[A-Z]/g, '').trim();
          if (clean) console.log('[Claude Service] SSH RC stdout:', clean);

          if (!urlEmitted) {
            const cleanBuffer = outputBuffer.replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[^m]*m/g, '');
            const urlMatch = cleanBuffer.match(/https:\/\/claude\.ai\/code\?environment=[^\s]+/)
              || cleanBuffer.match(/https:\/\/claude\.ai\/code\?bridge=[^\s]+/)
              || cleanBuffer.match(/https:\/\/claude\.ai\/code\/[^\s]+/);
            if (urlMatch) {
              urlEmitted = true;
              console.log('[Claude Service] SSH Remote control URL detected:', urlMatch[0]);
              this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STARTED, {
                sessionId,
                url: urlMatch[0],
              });
            }
          }
        });

        channel.stderr.on('data', (data: Buffer) => {
          console.log('[Claude Service] SSH RC stderr:', data.toString().trim());
        });

        channel.on('close', () => {
          console.log('[Claude Service] SSH Remote control channel closed');
          this.rcProcesses.delete(sessionId);
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
        });
      });
    } catch (error) {
      console.error('[Claude Service] Failed to start SSH remote control:', error);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    }
  }

  /**
   * Stop a running remote control session.
   */
  stopRemoteControl(sessionId: string): void {
    const child = this.rcProcesses.get(sessionId);
    if (child) {
      child.kill('SIGTERM');
      this.rcProcesses.delete(sessionId);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_RC_STOPPED, { sessionId });
    }
  }

  async askBtw(sessionId: string, question: string): Promise<void> {
    // Preferred path: the session has a live SDK Query — use the native
    // `askSideQuestion` control so the side answer runs against the running
    // claude's in-memory context. No duplicate API call, no history rebuild,
    // no role-sanitising.
    const liveQuery = this.activeQueryObjects.get(sessionId);
    const liveQueryAny = liveQuery as unknown as { askSideQuestion?: (q: string) => Promise<{ response: string; synthetic: boolean } | null> } | undefined;
    if (liveQueryAny?.askSideQuestion) {
      try {
        console.log('[Claude Service] /btw via SDK askSideQuestion (live query)');
        const answer = await liveQueryAny.askSideQuestion(question);
        const answerText = answer?.response || '';
        if (answerText) {
          this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
            sessionId,
            content: answerText,
            done: false,
          });
        }
        this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
          sessionId,
          content: '',
          done: true,
        });
        return;
      } catch (err) {
        console.warn('[Claude Service] askSideQuestion failed, falling back to CLI:', err);
      }
    }

    // Fallback: no active query (session is idle between turns). Use `claude -p`
    // which authenticates through Claude Code's own credentials (OAuth/keychain) —
    // no separate API key required from Build's settings.
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);

    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      const cliArgs = ['-p', question, '--bare', '--no-session-persistence'];
      let child: import('child_process').ChildProcess;

      if (session?.sshConfig) {
        // SSH session: run claude -p on the remote server
        const remoteCmd = `claude ${cliArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
        const remoteProcess = await sshService.createRemoteProcess(sessionId, session.sshConfig, {
          command: 'bash',
          args: ['-c', remoteCmd],
          cwd: session.sshConfig.remoteWorkdir || '/home/' + session.sshConfig.username,
          env: {},
          signal: new AbortController().signal,
        });
        child = remoteProcess as unknown as import('child_process').ChildProcess;
      } else {
        const cwd = session?.repoPath || process.cwd();
        child = spawn('claude', cliArgs, {
          cwd,
          shell: true,
          env: { ...process.env, CLAUDECODE: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      let fullResponse = '';
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        fullResponse += text;
        this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
          sessionId,
          content: text,
          done: false,
        });
      });

      child.stderr?.on('data', (data: Buffer) => {
        console.warn('[Claude Service] /btw CLI stderr:', data.toString().trim());
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code !== 0 && !fullResponse) {
            reject(new Error(`claude -p exited with code ${code}`));
          } else {
            resolve();
          }
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('/btw timeout (60s)')), 60000);
      });

      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
        sessionId,
        content: '',
        done: true,
      });
    } catch (error) {
      console.error('[Claude Service] /btw error:', error);
      this.mainWindow?.webContents.send(IPC_CHANNELS.CLAUDE_BTW_RESPONSE, {
        sessionId,
        content: `\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}`,
        done: true,
      });
    }
  }

  async *streamMessage(
    sessionId: string,
    userMessage: string,
    attachments?: Attachment[],
    permissionMode?: string,
    thinkingMode?: string,
    model?: string,
    gstackMode?: string,
    supplementalMessages?: ChatMessage[],
  ): AsyncGenerator<StreamEvent> {
    const apiKey = this.getApiKey();

    // Get session for working directory (check both manual and discovered sessions)
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined)
      || (this.sessionStore.get(`discoveredSessions.${sessionId}`) as Session | undefined);

    // Validate message is not empty to prevent API error "text content blocks must be non-empty"
    if (!userMessage || userMessage.trim() === '') {
      // Check if we have image attachments - if so, use a placeholder message
      const hasImages = attachments?.some(a => a.type === 'image');
      if (!hasImages) {
        yield { type: 'error', error: 'Please enter a message before sending.' };
        return;
      }
      // For image-only messages, use a minimal placeholder
      userMessage = 'Please analyze this image.';
    }
    if (!session) {
      yield { type: 'error', error: 'Session not found' };
      return;
    }

    // Track when user last interacted with this session (for proactive compaction)
    this.sessionLastMessageTime.set(sessionId, Date.now());

    // Proactive compaction: compact OTHER idle sessions that are above 60% context
    this.compactIdleSessions(sessionId);

    // Cancel any existing query for this session before starting a new one.
    // Without this, the old SSH process keeps running and the UI gets stuck
    // showing "thinking" from the orphaned query that never sends STREAM_END.
    const existingController = this.activeQueries.get(sessionId);
    if (existingController) {
      console.log(`[Claude Service] Aborting existing query for session ${sessionId.substring(0, 8)} before starting new one`);
      existingController.abort();
      this.backgroundListeners.get(sessionId)?.abort();
      codexService.cancel(sessionId);
      openclawService.cancel(sessionId);
      try { const { getCursorService } = require('./cursor.service'); getCursorService().cancel(sessionId); } catch { /* not loaded */ }
      try { const { getGeminiService } = require('./gemini.service'); getGeminiService().cancel(sessionId); } catch { /* not loaded */ }

      // Kill orphaned remote processes from the old query
      if (session?.sshConfig) {
        sshService.killRemoteProcesses(sessionId, session.sshConfig).catch(() => {});
      }
    }

    // Rate limit auto-retry flag — set in rate_limit_event, checked in result handler
    let pendingRateLimitRetry = false;

    // Create abort controller for cancellation
    const abortController = new AbortController();
    this.activeQueries.set(sessionId, abortController);
    if (!existingController) powerService.sessionStarted(); // Only increment if not replacing

    // Resolve the remote SDK session ID before invalidating transcript caches.
    const rawSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
      || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;
    const sdkSessionId = rawSdkSessionId === 'new' ? undefined : rawSdkSessionId;

    // Invalidate message cache - new message being sent (performance optimization)
    this.invalidateMessageCache(sessionId);
    if (session.sshConfig) {
      sshService.invalidateTranscriptCache(sdkSessionId || sessionId);
    }

    try {
      // Validate and cast permission mode to SDK type
      const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'] as const;
      type SDKPermissionMode = typeof validModes[number];
      const sdkPermissionMode: SDKPermissionMode = validModes.includes(permissionMode as SDKPermissionMode)
        ? (permissionMode as SDKPermissionMode)
        : 'acceptEdits';

      // Store the initial permission mode for this session (can be updated mid-stream via GREP IT!)
      this.sessionPermissionModes.set(sessionId, sdkPermissionMode);

      // If starting in plan mode, store a default pre-plan mode for restoration after approval
      if (sdkPermissionMode === 'plan' && !this.prePlanPermissionModes.has(sessionId)) {
        this.prePlanPermissionModes.set(sessionId, 'acceptEdits');
        console.log(`[Claude Service] Starting in plan mode, stored default pre-plan mode: acceptEdits`);
      }

      // Check if bypassPermissions mode requires the danger flag
      const requiresDangerFlag = sdkPermissionMode === 'bypassPermissions';

      // Map thinking mode to effort levels (via maxThinkingTokens)
      // The Claude Agent SDK uses maxThinkingTokens, which maps to Claude 4.6's effort parameter:
      //   - off = undefined (no extended thinking) ~ effort: null
      //   - thinking = medium effort ~ effort: "medium"
      //   - ultrathink = high effort ~ effort: "high"
      //
      // NOTE: When the SDK adds support for output_config.effort, we can migrate to:
      //   thinking: { type: "adaptive" }
      //   output_config: { effort: "medium" | "high" }
      //
      // For now, we use token budgets that approximate effort levels:
      //   - medium (thinking): 10,000 tokens
      //   - high (ultrathink): 60,000-100,000 tokens (model-dependent)
      //
      // IMPORTANT: Opus models have a max output token limit of 64,000
      // The thinking tokens count towards this limit, so we cap ultrathink at 60,000
      // to leave room for the actual response (~4,000 tokens buffer)
      // Model selection priority:
      // 1. Explicit model parameter (from UI selector)
      // Model resolution priority:
      // 1. Explicit model from UI (passed as parameter)
      // 2. Session's saved model (session.model)
      // 3. Foundry default (if Foundry enabled)
      // 4. First model in the available models list (always the top/latest)
      let selectedModel = model;

      if (!selectedModel && session.model) {
        selectedModel = session.model;
        console.log('[Claude Service] Using session model:', selectedModel);
      }

      if (!selectedModel) {
        const settings = this.store.get('settings', {}) as Record<string, unknown>;
        const foundryEnabled = settings.foundryEnabled as boolean | undefined;
        if (foundryEnabled) {
          const foundrySonnet = settings.foundryDefaultSonnetModel as string | undefined;
          if (foundrySonnet) {
            selectedModel = foundrySonnet;
            console.log('[Claude Service] Using Foundry default sonnet:', selectedModel);
          }
        }
      }

      if (!selectedModel) {
        // Use the first model in the available list — always the latest/best
        const available = await this.getAvailableModels();
        selectedModel = available[0]?.id || 'claude-opus-4-7';
        console.log('[Claude Service] Using top available model:', selectedModel);
      }

      let secureEnvContext: string | undefined;
      try {
        secureEnvContext = await this.prepareSecureEnvContext(sessionId, session);
      } catch (error) {
        console.warn('[Claude Service] Failed to prepare secure environment variable handoff:', error);
      }

      const normalizedSupplementalMessages = this.normalizeConversationMessages(supplementalMessages);

      // Route to OpenClaw when session has openclawConfig
      if (session.openclawConfig) {
        console.log(`[Claude Service] Routing to OpenClaw gateway: ${session.openclawConfig.gatewayUrl}`);
        for await (const event of openclawService.streamAsChat(
          sessionId,
          userMessage,
          session.openclawConfig.gatewayUrl,
          session.openclawConfig.gatewayPassword
        )) {
          yield event as StreamEvent;
        }
        return;
      }

      // Route to Codex when a codex:* model is selected
      if (selectedModel?.startsWith('codex:')) {
        const codexModel = selectedModel.split(':')[1];
        console.log(`[Claude Service] Routing to Codex model=${codexModel} ssh=${!!session.sshConfig}`);
        const projectPath = session.worktreePath || session.repoPath || process.cwd();

        // Enable Codex goals when Ralph Loop is on
        const audioSettings = this.store.get('audioSettings') as Record<string, unknown> | undefined;
        if (audioSettings?.ralphLoopEnabled) {
          try {
            const fs = require('fs');
            const os = require('os');
            const path = require('path');
            const configPath = path.join(os.homedir(), '.codex', 'config.toml');
            const configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
            if (!configContent.includes('goals = true')) {
              const goalsSection = configContent.includes('[features]')
                ? configContent.replace('[features]', '[features]\ngoals = true')
                : configContent + '\n\n[features]\ngoals = true\n';
              fs.writeFileSync(configPath, goalsSection);
              console.log('[Claude Service] Enabled Codex goals for Ralph Loop');
            }
          } catch (e) {
            console.warn('[Claude Service] Could not enable Codex goals:', e);
          }
        }

        let conversationContext = '';
        try {
          const transcriptMessages = await this.getMessages(sessionId);
          const mergedMessages = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
          conversationContext = buildCrossHarnessContext(mergedMessages, [], 'codex');
          if (conversationContext) {
            console.log(`[Claude Service] Codex cross-harness context: ${conversationContext.length} chars from ${mergedMessages.length} messages`);
          }
        } catch (e) {
          console.warn('[Claude Service] Could not load messages for Codex context:', e);
        }

        const codexContext = [secureEnvContext, conversationContext].filter(Boolean).join('\n\n');

        // When Ralph Loop is on, prepend /goal so Codex sets up goal tracking
        const ralphWithGoals = audioSettings?.ralphLoopEnabled && permissionMode === 'bypassPermissions';
        const codexPrompt = ralphWithGoals ? `/goal ${userMessage}` : userMessage;

        for await (const event of codexService.streamAsChat(sessionId, codexPrompt, projectPath, session.sshConfig, codexContext, codexModel, attachments, sdkPermissionMode)) {
          yield event as StreamEvent;
        }
        return;
      }

      // Route to Cursor for cursor:* models
      if (selectedModel?.startsWith('cursor:')) {
        const { getCursorCliService } = require('./cursor-cli.service');
        const cursorCliService = getCursorCliService();
        const cursorApiKey = ((this.store.get('settings', {}) as Record<string, unknown>).cursorApiKey as string) || '';

        // Resume existing Cursor chat only if the last turn was also Cursor.
        // If another harness ran in between, start a fresh chat with cross-harness
        // context so Cursor knows what happened while it was away.
        let chatId = cursorCliService.getChatId(sessionId);
        let cursorContext = '';
        let needsFreshChat = !chatId;

        if (chatId) {
          try {
            const transcriptMessages = await this.getMessages(sessionId);
            const allMessages = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
            const lastAssistant = [...allMessages].reverse().find(m => m.role === 'assistant');
            if (lastAssistant && lastAssistant.harness && lastAssistant.harness !== 'cursor') {
              console.log(`[Claude Service] Last turn was ${lastAssistant.harness}, not Cursor — starting fresh chat with context`);
              cursorCliService.clearChatId(sessionId);
              chatId = null;
              needsFreshChat = true;
            }
          } catch (e) {
            console.warn('[Claude Service] Could not check last harness for Cursor:', e);
          }
        }

        if (needsFreshChat) {
          const workDir = session.worktreePath || session.repoPath || process.cwd();
          if (session.sshConfig) {
            const remoteDir = session.worktreePath || session.sshConfig.remoteWorkdir || '~';
            chatId = await cursorCliService.createSshChat(session.sshConfig, remoteDir);
          } else {
            chatId = await cursorCliService.createChat(workDir);
          }

          if (chatId) {
            cursorCliService.setChatId(sessionId, chatId);
            console.log(`[Claude Service] Cursor new chat ${chatId} for session ${sessionId.substring(0, 8)}`);
          } else {
            console.warn('[Claude Service] Failed to create Cursor chat — each turn will be stateless');
          }

          try {
            const transcriptMessages = await this.getMessages(sessionId);
            const merged = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
            cursorContext = buildCrossHarnessContext(merged, [], 'cursor');
            if (cursorContext) {
              console.log(`[Claude Service] Cursor cross-harness context: ${cursorContext.length} chars`);
            }
          } catch (e) {
            console.warn('[Claude Service] Could not load messages for Cursor context:', e);
          }
        } else {
          console.log(`[Claude Service] Cursor resuming chat ${chatId} for session ${sessionId.substring(0, 8)}`);
        }

        const baseMessage = cursorContext ? `${cursorContext}\n\n${userMessage}` : userMessage;
        const { message: fullMessage, cleanup: cursorCleanup } = await this.prepareCliAttachments(sessionId, baseMessage, attachments, session.sshConfig);

        try {
          if (session.sshConfig) {
            const remoteDir = session.worktreePath || session.sshConfig.remoteWorkdir || '~';
            console.log(`[Claude Service] Cursor SSH → CLI on remote ${session.sshConfig.host}:${remoteDir}`);
            for await (const event of cursorCliService.streamMessage(sessionId, fullMessage, remoteDir, selectedModel, session.sshConfig, chatId || undefined)) {
              yield event as StreamEvent;
            }
            return;
          }

          // Local: SDK path (multi-turn) or CLI path
          if (cursorApiKey && !chatId) {
            const { getCursorService } = require('./cursor.service');
            const cursorService = getCursorService();
            const workDir = session.repoPath || process.cwd();
            for await (const event of cursorService.streamMessage(sessionId, fullMessage, workDir, selectedModel)) {
              yield event as StreamEvent;
            }
          } else {
            const workDir = session.repoPath || process.cwd();
            console.log(`[Claude Service] Cursor local → CLI${chatId ? ` (resume ${chatId})` : ' (new chat)'}`);
            for await (const event of cursorCliService.streamMessage(sessionId, fullMessage, workDir, selectedModel, undefined, chatId || undefined)) {
              yield event as StreamEvent;
            }
          }
        } finally {
          await cursorCleanup();
        }
        return;
      }

      // Route to Gemini CLI for gemini:* models
      if (selectedModel?.startsWith('gemini:')) {
        const { getGeminiService } = require('./gemini.service');
        const geminiService = getGeminiService();
        const workDir = session.worktreePath || session.repoPath || process.cwd();

        // Only build cross-harness context if Claude transcript has messages.
        let geminiContext = '';
        try {
          const transcriptMessages = await this.getMessages(sessionId);
          const merged = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
          geminiContext = buildCrossHarnessContext(merged, [], 'gemini');
          if (geminiContext) {
            console.log(`[Claude Service] Gemini cross-harness context: ${geminiContext.length} chars from ${merged.length} messages`);
          }
        } catch (e) {
          console.warn('[Claude Service] Could not load messages for Gemini context:', e);
        }

        const baseGeminiMessage = geminiContext ? `${geminiContext}\n\n${userMessage}` : userMessage;
        const { message: fullMessage, cleanup: geminiCleanup } = await this.prepareCliAttachments(sessionId, baseGeminiMessage, attachments);
        try {
          for await (const event of geminiService.streamMessage(sessionId, fullMessage, workDir, selectedModel)) {
            yield event as StreamEvent;
          }
        } finally {
          await geminiCleanup();
        }
        return;
      }

      // Route to OpenCode for opencode:* models
      if (selectedModel?.startsWith('opencode:')) {
        // TODO: Phase 2 — OpenCodeService integration
        yield { type: 'error', error: 'OpenCode/DeepSeek agent support coming soon. Switching back to Claude.' };
        return;
      }

      // Build cross-harness context so Claude sees messages from Cursor/Codex turns
      let supplementalConversationContext = '';
      try {
        const transcriptMessages = await this.getMessages(sessionId);
        const merged = mergeConversationMessages(transcriptMessages, normalizedSupplementalMessages);
        if (merged.length > 0) {
          supplementalConversationContext = buildCrossHarnessContext(merged, [], 'claude');
          if (supplementalConversationContext) {
            console.log(`[Claude Service] Claude cross-harness context: ${supplementalConversationContext.length} chars from ${merged.length} messages`);
          }
        }
      } catch (error) {
        console.warn('[Claude Service] Could not load transcript messages for cross-harness context:', error);
      }

      const isOpus = selectedModel.includes('opus');

      // Effort level to thinking token mapping
      // Maps new effort levels (low/medium/high/max) to maxThinkingTokens budgets
      // Also handles legacy values (off/thinking/ultrathink) for backward compatibility
      const effortToThinkingTokens = (effort: string): number | undefined => {
        // Migrate legacy values first
        let migratedEffort = effort;
        if (effort === 'off') migratedEffort = 'low';
        if (effort === 'thinking') migratedEffort = 'medium';
        if (effort === 'ultrathink') migratedEffort = 'high';

        switch (migratedEffort) {
          case 'low':
            return undefined; // No extended thinking - fast & efficient
          case 'medium':
            return 10000; // Balanced effort
          case 'high':
            return isOpus ? 60000 : 100000; // Full capability (default)
          case 'xhigh':
            if (!isOpus) {
              console.warn('[Claude Service] ⚠️  xhigh effort only available on Opus, falling back to high');
              return 100000;
            }
            return 100000; // Extended deep thinking
          case 'max':
            if (!isOpus) {
              console.warn('[Claude Service] ⚠️  max effort only available on Opus, falling back to high');
              return 100000;
            }
            return 128000; // Maximum
          default:
            console.warn(`[Claude Service] Unknown effort level: ${effort}, defaulting to medium`);
            return 10000; // Default to medium if unknown
        }
      };

      const maxThinkingTokens = effortToThinkingTokens(thinkingMode || 'high');

      if (thinkingMode) {
        console.log(`[Claude Service] Effort level: ${thinkingMode} -> maxThinkingTokens: ${maxThinkingTokens}`);
        if (thinkingMode === 'max' && !isOpus) {
          console.log(`[Claude Service] Note: max effort requested but model is not Opus, using high instead`);
        }
      }

      // Build prompt with attachments
      const imageAttachments = attachments?.filter(a => a.type === 'image') || [];
      const domElementAttachments = attachments?.filter(a => a.type === 'dom_element') || [];
      const hasImages = imageAttachments.length > 0;
      const hasDomElements = domElementAttachments.length > 0;

      console.log('[Claude Service] streamMessage - Attachments received:', attachments?.length || 0);
      console.log('[Claude Service] streamMessage - Image attachments:', imageAttachments.length);
      console.log('[Claude Service] streamMessage - DOM element attachments:', domElementAttachments.length);
      if (attachments) {
        attachments.forEach((a, i) => {
          console.log(`[Claude Service] Attachment ${i}: type=${a.type}, name=${a.name}, content exists=${!!a.content}, content length=${a.content?.length || 0}`);
        });
      }

      // Resolve [SECURE_KEY:key_xxx] placeholders back to real values before
      // sending to the model. The renderer replaced detected API keys with
      // placeholders to keep them out of the transcript/UI, but the model
      // needs the actual values to function (e.g. curl -H "Authorization: <key>").
      let resolvedMessage = userMessage.replace(
        /\[SECURE_KEY:([^\]]+)\]/g,
        (_match, keyId) => {
          const realValue = secureKeysService.getKey(keyId);
          if (realValue) return realValue;
          console.warn(`[Claude Service] Could not resolve SECURE_KEY placeholder: ${keyId}`);
          return _match;
        }
      );

      // GStack mode is injected via system prompt append only (buildSystemPromptAppend)
      let fullTextMessage = resolvedMessage;
      if (hasDomElements) {
        const domContext = domElementAttachments.map((el, i) => {
          return `<selected-element index="${i + 1}" selector="${el.name}">\n${el.content}\n</selected-element>`;
        }).join('\n\n');
        fullTextMessage = `${domContext}\n\n${userMessage}`;
        console.log('[Claude Service] Added DOM element context to message');
      }

      if (hasImages) {
        console.log('[Claude Service] Will use multimodal prompt with images');
        imageAttachments.forEach((a, i) => {
          console.log(`[Claude Service] Image ${i}: name=${a.name}, base64 length=${a.content?.length || 0}, first 50 chars=${a.content?.slice(0, 50)}`);
        });
      }

      // Create async generator for prompt with images
      // Capture `this` for use inside the generator function
      const resizeImage = this.resizeImageIfNeeded.bind(this);
      async function* createPromptWithImages(): AsyncIterable<SDKUserMessage> {
        const content: (TextBlockParam | ImageBlockParam)[] = [
          { type: 'text', text: fullTextMessage }
        ];

        for (const attachment of imageAttachments) {
          // Determine media type from filename or default to png
          const ext = attachment.name.split('.').pop()?.toLowerCase();
          const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'gif' ? 'image/gif'
            : ext === 'webp' ? 'image/webp'
            : 'image/png';

          // Resize image if needed to stay under Anthropic's dimension limits
          const resizedData = await resizeImage(attachment.content, mediaType);

          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: resizedData,
            },
          });
        }

        yield {
          type: 'user',
          message: {
            role: 'user',
            content,
          },
          parent_tool_use_id: null,
          session_id: sdkSessionId || '',
        } as SDKUserMessage;
      }

      const prompt = hasImages ? createPromptWithImages() : fullTextMessage;
      console.log('[Claude Service] Using prompt type:', hasImages ? 'multimodal (async generator)' : 'text string');
      if (hasDomElements && !hasImages) {
        console.log('[Claude Service] DOM element context included in text prompt');
      }

      // Pre-fetch agent memories to inject into system prompt
      // Skip for SSH sessions since memory files are local
      const projectPath = session.worktreePath || session.repoPath || process.cwd();
      let memoriesPrompt: string | undefined;
      if (!session.sshConfig) {
        try {
          memoriesPrompt = await memoryService.getMemoriesForPrompt(projectPath);
          if (memoriesPrompt) {
            console.log('[Claude Service] Loaded memories for session, length:', memoriesPrompt.length);
          }
        } catch (error) {
          console.error('[Claude Service] Failed to load memories:', error);
          // Continue without memories - non-critical failure
        }
      }

      // Build MCP servers configuration
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpServersConfig: Record<string, any> = {};

      // For SSH sessions, transfer local webview cookies to the remote machine
      // so the remote chrome-devtools-mcp Chrome can use them
      if (session.sshConfig) {
        try {
          const { session: electronSession } = await import('electron');
          const targetSid = browserService.getFirstSessionId() || sessionId;
          const partitionName = `persist:browser-${targetSid}`;
          const ses = electronSession.fromPartition(partitionName);
          const cookies = await ses.cookies.get({});

          if (cookies.length > 0) {
            const cookieJson = JSON.stringify(cookies, null, 2);
            // Use /tmp as a reliable writable path (tilde doesn't expand in single-quoted paths)
            await sshService.writeRemoteFile(
              sessionId,
              session.sshConfig,
              '/tmp/grep-build-cookies.json',
              cookieJson
            );
            console.log(`[Claude Service] Transferred ${cookies.length} cookies to remote machine`);
          }
        } catch (error) {
          console.warn('[Claude Service] Cookie transfer to remote failed (non-fatal):', error);
        }
      }

      // Browser tools - conditionally loaded to save tokens on tool descriptions
      // For SSH sessions, only load if the session has used browser before (has a lastBrowserUrl)
      // For local sessions, always load as browser preview is a core feature
      const sessionHasBrowserHistory = session.sshConfig ? !!(session as any).lastBrowserUrl : true;
      if (sessionHasBrowserHistory) {
        mcpServersConfig['claudette-browser'] = this.getBrowserMcpServer(sessionId);
        console.log('[Claude Service] Browser MCP tools enabled', session.sshConfig ? '(SSH session)' : '(local session)');
      } else {
        console.log('[Claude Service] Browser MCP tools skipped — SSH session with no browser history');
      }

      // Load user-installed MCP servers from Claudette's electron-store
      // This runs on EVERY message, so new MCP servers are picked up automatically
      try {
        const userMcpServers = mcpService.getUserMcpServersConfig();

        // For SSH sessions, remove chrome-devtools stdio config (can't run npx on remote)
        // The PreToolUse hook will intercept all chrome-devtools calls and run them locally
        if (session.sshConfig && userMcpServers['chrome-devtools']) {
          console.log('[Claude Service] SSH session: replacing remote chrome-devtools with local MCP server');
          delete userMcpServers['chrome-devtools'];
          // Register a local in-process chrome-devtools MCP server so tools are still visible to the agent
          mcpServersConfig['chrome-devtools'] = this.getChromeDevtoolsMcpServer(sessionId);
        }

        // For SSH sessions, set up reverse SSH tunnels for localhost MCP servers
        // so they're accessible from the remote machine
        if (session.sshConfig) {
          for (const [name, config] of Object.entries(userMcpServers)) {
            const args = (config as { args?: string[] }).args || [];
            const localhostArg = args.find((a: string) =>
              /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)/.test(a)
            );
            if (localhostArg) {
              const portMatch = localhostArg.match(/:(\d+)/);
              if (portMatch) {
                const localPort = parseInt(portMatch[1], 10);
                // Set up reverse tunnel: remote:localPort → local:localPort
                sshService.setupReverseTunnel(sessionId, session.sshConfig, localPort).then(() => {
                  console.log(`[Claude Service] Reverse tunnel for ${name} MCP: remote:${localPort} → local:${localPort}`);
                }).catch(err => {
                  console.warn(`[Claude Service] Failed to set up tunnel for ${name} MCP:`, err.message);
                });
              }
            }
          }
        }

        // Handle mcp-remote stdio wrappers (Sentry, Linear, etc.).
        // For SSH: strip them entirely — remote can't reach these endpoints or do OAuth.
        // For local: convert to native SDK types (http/sse) with built-in OAuth.
        for (const name of Object.keys(userMcpServers)) {
          const cfg = userMcpServers[name] as { type?: string; command?: string; args?: string[] };
          if (cfg.type === 'stdio' && cfg.command === 'npx' && cfg.args?.includes('mcp-remote')) {
            if (session.sshConfig) {
              console.log(`[Claude Service] Stripping ${name} for SSH (mcp-remote can't authenticate remotely)`);
              delete userMcpServers[name];
            } else {
              const urlArg = cfg.args.find((a: string) => /^https?:\/\//.test(a));
              if (urlArg) {
                const mcpType = urlArg.endsWith('/sse') ? 'sse' : 'http';
                console.log(`[Claude Service] Converting ${name} from mcp-remote to native ${mcpType}: ${urlArg}`);
                userMcpServers[name] = { type: mcpType, url: urlArg } as any;
              }
            }
          }
        }

        Object.assign(mcpServersConfig, userMcpServers);
        console.log('[Claude Service] Loaded user MCP servers:', Object.keys(userMcpServers));
      } catch (error) {
        console.error('[Claude Service] Error loading user MCP servers:', error);
      }

      // Check if QMD is available for semantic codebase search
      // Only add for local sessions (not SSH) since QMD runs locally
      // Requires: 1) Global setting enabled, 2) Project preference enabled
      if (!session.sshConfig) {
        const qmdGlobalEnabled = this.store.get('qmdEnabled', false) as boolean;
        const qmdProjectEnabled = qmdService.isEnabledForProject(projectPath, qmdGlobalEnabled);

        if (qmdProjectEnabled) {
          const qmdConfig = qmdService.getMcpServerConfig();
          if (qmdConfig) {
            mcpServersConfig['qmd'] = {
              type: 'stdio',
              command: qmdConfig.command,
              args: qmdConfig.args,
            };
            console.log('[Claude Service] QMD MCP server enabled for semantic search');

            // Ensure project is indexed for QMD (runs in background, doesn't block)
            qmdService.ensureProjectIndexed(projectPath, (message) => {
              console.log('[Claude Service] QMD indexing:', message);
            }).catch((error) => {
              console.error('[Claude Service] QMD indexing error:', error);
            });
          }
        } else if (qmdGlobalEnabled) {
          // Global is enabled but project preference is unknown - check if we should prompt
          qmdService.shouldPromptForProject(projectPath).then((shouldPrompt) => {
            if (shouldPrompt && this.mainWindow) {
              console.log('[Claude Service] QMD available - prompting user for project preference');
              this.mainWindow.webContents.send(IPC_CHANNELS.QMD_PROMPT_RESPONSE, {
                sessionId,
                projectPath,
              });
            }
          });
        } else {
          // QMD globally disabled - log for debugging
          console.log('[Claude Service] QMD disabled globally (enable in settings to use semantic search)');
        }
      }

      // Ultra Plan Mode: Configure PostToolUse hook to auto-generate tasks after plan approval
      // This hook fires only when ExitPlanMode succeeds and ultraPlanMode setting is enabled
      const settings = this.store.get('settings', {}) as any;
      const ultraPlanEnabled = settings.ultraPlanMode || false;

      // Build hooks object
      const hooks: any = {};

      // PreToolUse hook for SSH sessions: intercept browser tools and execute locally
      if (session.sshConfig) {
        hooks.PreToolUse = [
          {
            matcher: 'mcp__claudette-browser__Browser*', // Match all MCP browser tools
            hooks: [async (input: any, toolUseID: string | undefined, options: any) => {
              console.log('[SSH Browser Intercept] PreToolUse hook called with:', JSON.stringify({ input, toolUseID, optionsKeys: Object.keys(options || {}) }));
              const fullToolName = input?.tool_name || input?.toolName || '';
              const toolName = fullToolName.replace('mcp__claudette-browser__', '');
              console.log('[SSH Browser Intercept] Extracted tool name:', fullToolName, '->', toolName);

              if (toolName.startsWith('Browser')) {
                console.log('[SSH Browser Intercept] Executing browser tool locally:', toolName);
                try {
                  const toolInput = input?.tool_input || {};
                  const result = await this.executeLocalBrowserTool(sessionId, toolName, toolInput);
                  console.log('[SSH Browser Intercept] Local execution completed:', { success: result.success });
                  return {
                    continue: false,
                    toolResult: result,
                  };
                } catch (error) {
                  console.error('[SSH Browser Intercept] Local execution failed:', error);
                  return {
                    continue: false,
                    toolResult: {
                      success: false,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  };
                }
              }
              return { continue: true };
            }]
          },
          {
            matcher: 'mcp__chrome-devtools__*', // Match all chrome-devtools MCP tools
            hooks: [async (input: any) => {
              const fullToolName = input?.tool_name || input?.toolName || '';
              const toolName = fullToolName.replace('mcp__chrome-devtools__', '');
              console.log('[SSH Chrome DevTools Intercept] Routing locally:', fullToolName, '->', toolName);

              try {
                const toolInput = input?.tool_input || {};
                const result = await this.executeLocalChromeDevtool(sessionId, toolName, toolInput);
                console.log('[SSH Chrome DevTools Intercept] Local execution completed');
                return {
                  continue: false,
                  toolResult: result,
                };
              } catch (error) {
                console.error('[SSH Chrome DevTools Intercept] Local execution failed:', error);
                return {
                  continue: false,
                  toolResult: {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  },
                };
              }
            }]
          },
        ];
      }

      // Ralph Loop: Add Stop hook for Build It mode (bypassPermissions)
      // This intercepts session exit to continue iteration until task is complete
      // Based on Anthropic's official Ralph Wiggum plugin pattern with safety improvements
      const audioSettings = this.store.get('audioSettings') as any;
      const ralphLoopEnabled = audioSettings?.ralphLoopEnabled ?? false;
      const computerUseEnabled = audioSettings?.computerUseEnabled ?? false;
      const maxRalphIterations = audioSettings?.maxRalphIterations ?? 50;
      const maxComputerUseIterations = audioSettings?.maxComputerUseIterations ?? 20;

      if (permissionMode === 'bypassPermissions' && (ralphLoopEnabled || computerUseEnabled)) {
        let iterationCount = 0;
        const maxIterations = computerUseEnabled ? maxComputerUseIterations : maxRalphIterations;
        const loopName = computerUseEnabled ? 'Computer Use' : 'Ralph Loop';

        hooks.Stop = [async (options: { fullContent: string; signal: AbortSignal; stopHookActive?: boolean }) => {
          // Check for explicit completion markers
          const completionMarkers = [
            '<promise>COMPLETE</promise>',
            'Task completed successfully',
            'I have finished'
          ];
          const hasCompletion = completionMarkers.some(marker =>
            options.fullContent.toLowerCase().includes(marker.toLowerCase())
          );

          if (hasCompletion) {
            console.log(`[${loopName}] Completion marker found after ${iterationCount} iterations, allowing exit`);
            return { decision: 'allow' as const };
          }

          // If Claude stopped without using any tools, it's likely stuck or done
          const hasToolUse = options.fullContent.includes('tool_use') || options.fullContent.includes('Tool');
          if (!hasToolUse && iterationCount > 0) {
            console.log(`[${loopName}] No tool use detected at iteration ${iterationCount}, allowing exit (likely stuck or complete)`);
            return { decision: 'allow' as const };
          }

          // Increment and check iteration limit
          iterationCount++;
          console.log(`[${loopName}] Iteration ${iterationCount}/${maxIterations}`);

          if (iterationCount >= maxIterations) {
            console.log(`[${loopName}] Max iterations reached (${maxIterations}), allowing exit`);
            return { decision: 'allow' as const };
          }

          // Build continuation prompt with progressive context
          let continuationPrompt: string;
          if (iterationCount <= 3) {
            continuationPrompt = `Continue working on the task. Review your previous changes and assess progress. Output <promise>COMPLETE</promise> when the task is fully done.`;
          } else if (iterationCount <= 10) {
            continuationPrompt = `Continue working on the task (iteration ${iterationCount}/${maxIterations}). Check git status and your file changes to avoid redoing work. Output <promise>COMPLETE</promise> when done.`;
          } else {
            continuationPrompt = `You've been iterating for ${iterationCount} cycles (max ${maxIterations}). Critically assess whether you're making progress or stuck in a loop. If stuck, document what's blocking you and output <promise>COMPLETE</promise>. If making progress, continue.`;
          }

          return {
            decision: 'block' as const,
            prompt: continuationPrompt,
          };
        }];
      }

      // Add ultra plan mode hooks if enabled
      if (ultraPlanEnabled) {
        hooks.PostToolUse = [{
          matcher: 'ExitPlanMode',  // Only trigger after ExitPlanMode succeeds
          hooks: [async (input: any, toolUseID: string | undefined, { signal }: { signal: AbortSignal }) => {
            try {
              console.log('[Ultra Plan] PostToolUse hook triggered after ExitPlanMode');

              // Read the approved plan content from cache
              const cachedPlan = this.sessionPlanFiles.get(sessionId);
              const planContent = cachedPlan?.content || '';

              if (!planContent) {
                console.log('[Ultra Plan] No plan content available, skipping task generation');
                return { continue: true };
              }

              // Inject system message prompting structured task creation
              const taskCreationPrompt = `
# Task Decomposition Required

Your plan has been approved. Before beginning implementation, you must decompose this plan into structured, executable tasks using the TaskCreate tool.

## Approved Plan Summary

${planContent.substring(0, 2000)}

## Instructions

1. **Analyze the plan** and identify discrete, actionable implementation steps
2. **Create tasks** using the TaskCreate tool with:
   - Clear, imperative subjects (e.g., "Add rewind button UI", "Implement fork backend logic")
   - Detailed descriptions with acceptance criteria
   - activeForm for progress display (e.g., "Adding rewind button")
3. **Set up dependencies** using TaskUpdate with addBlockedBy for tasks that must wait
4. **Use TaskList** to verify the complete task structure
5. **Mark first task as in_progress** using TaskUpdate before starting work

## Task Guidelines

- Create granular, atomic tasks - each task should accomplish ONE clear, testable objective
- Prefer more smaller tasks over fewer large tasks (e.g., separate tasks for "Add type definition", "Add service method", "Add IPC handler")
- Each task should be independently verifiable and take no more than a few focused steps
- Order tasks by natural execution flow
- Use blockedBy for strict dependencies (e.g., "Add backend service" blocks "Add IPC handler")
- Include a final "End-to-end verification" task
- Start work immediately after task structure is confirmed

## Example Task Structure

Task 1: "Set up service layer" (no blockers)
Task 2: "Add IPC handlers" (blocked by Task 1)
Task 3: "Expose preload API" (blocked by Task 2)
Task 4: "Implement UI component" (blocked by Task 3)
Task 5: "End-to-end verification" (blocked by Task 4)

Begin by creating the task structure now.
`;

              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse' as const,
                  additionalContext: taskCreationPrompt,
                }
              };
            } catch (error) {
              console.error('[Ultra Plan] Error in PostToolUse hook:', error);
              return { continue: true };
            }
          }]
        }];
      }

      // Use the Claude Agent SDK query function with Claude Code's system prompt
      console.log('[Claude Service] Starting query, session has sshConfig:', !!session.sshConfig);
      if (session.sshConfig) {
        console.log('[Claude Service] SSH config:', { host: session.sshConfig.host, user: session.sshConfig.username, remoteWorkdir: session.sshConfig.remoteWorkdir });
      }
      const sshConfig = session.sshConfig;
      // Mark this session as actively streaming so its SSH connection gets health checks.
      // Idle sessions (128+ of them) skip health checks to avoid saturating the remote.
      if (sshConfig) sshService.markSessionActive(sessionId);
      const localNodeExecutable = session.sshConfig ? undefined : this.resolveLocalNodeExecutable();
      if (!session.sshConfig) {
        if (localNodeExecutable) {
          console.log('[Claude Service] Using local Node executable for Claude Code:', localNodeExecutable);
        } else {
          console.warn('[Claude Service] Could not resolve a local Node executable explicitly; falling back to PATH lookup');
        }
      }
      // Sync showClearContextOnPlanAccept to ~/.claude/settings.json
      try {
        const userClaudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
        let claudeSettings: Record<string, unknown> = {};
        if (fs.existsSync(userClaudeSettings)) {
          claudeSettings = JSON.parse(fs.readFileSync(userClaudeSettings, 'utf-8'));
        }
        const wantClear = !!(settings as any).showClearContextOnPlanAccept;
        if (claudeSettings.showClearContextOnPlanAccept !== wantClear) {
          claudeSettings.showClearContextOnPlanAccept = wantClear;
          fs.writeFileSync(userClaudeSettings, JSON.stringify(claudeSettings, null, 2));
        }
      } catch (e) {
        console.warn('[Claude Service] Could not sync showClearContextOnPlanAccept:', e);
      }

      const messages = query({
        prompt,
        options: {
          cwd: projectPath,
          abortController,
          permissionMode: sdkPermissionMode,
          ...(requiresDangerFlag ? { allowDangerouslySkipPermissions: true } : {}),
          includePartialMessages: true,
          // Use computed model — resolve custom:* IDs to actual API model names
          model: this.resolveCustomModelId(selectedModel),
          // 1M context is native for Opus 4.6/Sonnet 4.6 (no beta needed since Mar 13 2026)
          // Legacy models (Sonnet 4.5, Sonnet 4) still need the beta until Apr 30 2026
          // Skip betas for Foundry (custom betas not supported)
          ...(!settings.foundryEnabled && !selectedModel.includes('opus-4-6') && !selectedModel.includes('sonnet-4-6')
            ? { betas: ['context-1m-2025-08-07' as const] }
            : {}),
          ...(maxThinkingTokens ? { maxThinkingTokens } : {}),
          // Ultra Plan Mode: Add hooks if enabled
          ...(hooks ? { hooks } : {}),
          // Use Claude Code's system prompt preset with Build agent context
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: this.buildSystemPromptAppend(session, memoriesPrompt, gstackMode, secureEnvContext, supplementalConversationContext),
          },
          // Enable CLAUDE.md and Skills from both user (~/.claude/) and project (.claude/)
          // Skills are discovered automatically by the SDK from these filesystem locations
          // User skills: ~/.claude/skills/, Project skills: .claude/skills/
          enableFileCheckpointing: true,
          settingSources: ['user', 'project'],
          // Pass environment with API key and enable agent teams
          env: (() => {
            // Start with process.env but STRIP any stale custom model vars
            const { ANTHROPIC_BASE_URL: _, ANTHROPIC_MODEL: _m, ANTHROPIC_SMALL_FAST_MODEL: _s, ...cleanEnv } = process.env;
            const customVars = this.getCustomModelEnvVars(selectedModel);
            const foundryVars = this.getFoundryEnvVars();
            const finalEnv = {
              ...cleanEnv,
              ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || 'true',
              ...foundryVars,
              ...customVars,
            };
            if (Object.keys(customVars).length > 0) {
              console.log('[Claude Service] Custom model env:', { baseUrl: customVars.ANTHROPIC_BASE_URL, model: customVars.ANTHROPIC_MODEL, hasKey: !!customVars.ANTHROPIC_API_KEY });
            }
            return finalEnv;
          })(),
          // Resume previous conversation if we have an SDK session ID.
          // For SSH forks: resume from the parent's SDK session + forkSession: true
          // so the remote transcript gets forked on the first query.
          ...(sdkSessionId ? { resume: sdkSessionId } : {}),
          ...((session as any)?.forkFromSdkSessionId ? { resume: (session as any).forkFromSdkSessionId, forkSession: true } : {}),
          // Add MCP servers (browser tools + QMD semantic search if available)
          mcpServers: mcpServersConfig,
          // Spawn Claude Code either locally via a resolved Node binary or remotely over SSH.
          spawnClaudeCodeProcess: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
            if (sshConfig) {
              console.log('[Claude Service] Creating SSH remote process for session:', sessionId);
              console.log('[Claude Service] SDK spawn options:', { command: options.command, args: options.args, cwd: options.cwd });
              return sshService.createRemoteProcess(
                sessionId,
                sshConfig,
                options
              );
            }

            return this.createLocalClaudeCodeProcess(localNodeExecutable, options);
          },
          // Handle tool permission requests
          canUseTool: async (toolName: string, input: Record<string, unknown>, _options: any) => {
            console.log(`[Claude Service] canUseTool called for: ${toolName}, mode: ${sdkPermissionMode}`);

            // Handle AskUserQuestion tool
            if (toolName === 'AskUserQuestion' && input.questions) {
              try {
                const answers = await this.askUserQuestion(sessionId, input.questions as any);
                return {
                  behavior: 'allow' as const,
                  updatedInput: {
                    ...input,
                    answers,
                  },
                };
              } catch (error) {
                console.error('[Claude Service] Error asking user question:', error);
                return {
                  behavior: 'deny' as const,
                  message: error instanceof Error ? error.message : 'Failed to get user response',
                };
              }
            }

            // Handle ExitPlanMode - require user approval before proceeding
            if (toolName === 'ExitPlanMode') {
              try {
                console.log('[Claude Service] ExitPlanMode called, requesting user approval');

                let planContent = '';
                let planFilePath = '';

                // First priority: Check if plan content is provided in the tool input (common for remote sessions)
                if (input.plan && typeof input.plan === 'string') {
                  planContent = input.plan;
                  planFilePath = ''; // No file path when plan is in input
                  console.log('[Claude Service] Using plan from tool input, length:', planContent.length);
                }
                // Second priority: Use the cached plan content for this session (set when plan file was written locally)
                else {
                  const cachedPlan = this.sessionPlanFiles.get(sessionId);

                  if (cachedPlan) {
                    planContent = cachedPlan.content;
                    planFilePath = cachedPlan.filePath;
                    console.log('[Claude Service] Using cached plan from:', planFilePath);
                  } else {
                  // Check if this is a remote SSH session
                  const session = this.sessionStore.get(`sessions.${sessionId}`) as any;

                  if (session?.sshConfig) {
                    // Remote session: read plan file from remote server
                    console.log('[Claude Service] No cached plan for remote session - fetching from remote server');
                    try {
                      // Find the most recent plan file on the remote server
                      const remotePlansDir = '$HOME/.claude/plans';
                      const findCommand = `ls -t ${remotePlansDir}/*.md 2>/dev/null | head -1`;

                      const connectionInfo = sshService['connections'].get(sessionId);
                      if (!connectionInfo?.client) {
                        console.error('[Claude Service] No SSH connection available for session');
                        return {
                          behavior: 'deny' as const,
                          message: 'Plan approval failed: SSH connection not available to fetch remote plan.',
                        };
                      }

                      // Execute command to find most recent plan file
                      const findResult = await new Promise<string>((resolve, reject) => {
                        connectionInfo.client.exec(findCommand, (err: Error | undefined, stream: any) => {
                          if (err) {
                            reject(err);
                            return;
                          }

                          let output = '';
                          stream.on('data', (data: Buffer) => {
                            output += data.toString();
                          });
                          stream.on('close', () => {
                            resolve(output.trim());
                          });
                          stream.stderr.on('data', (data: Buffer) => {
                            console.error('[Claude Service] Remote find stderr:', data.toString());
                          });
                        });
                      });

                      if (!findResult) {
                        console.error('[Claude Service] No plan files found on remote server');
                        return {
                          behavior: 'deny' as const,
                          message: 'Plan approval failed: No plan files found on remote server.',
                        };
                      }

                      planFilePath = findResult;
                      console.log('[Claude Service] Found remote plan file:', planFilePath);

                      // Read the remote plan file
                      planContent = await sshService.readRemoteFile(sessionId, session.sshConfig, planFilePath);
                      console.log('[Claude Service] Successfully read remote plan, length:', planContent.length);
                    } catch (error) {
                      console.error('[Claude Service] Failed to read remote plan file:', error);
                      return {
                        behavior: 'deny' as const,
                        message: `Plan approval failed: Could not read remote plan file: ${error instanceof Error ? error.message : String(error)}`,
                      };
                    }
                  } else {
                    // Local session: Find the plan file that was written most recently
                    console.log('[Claude Service] No cached plan found for local session, scanning directory (this should not happen)');
                    const plansDir = path.join(os.homedir(), '.claude', 'plans');

                    if (fs.existsSync(plansDir)) {
                      const planFiles = fs.readdirSync(plansDir)
                        .filter(f => f.endsWith('.md'))
                        .map(f => ({
                          name: f,
                          path: path.join(plansDir, f),
                          mtime: fs.statSync(path.join(plansDir, f)).mtime.getTime(),
                        }))
                        .sort((a, b) => b.mtime - a.mtime);

                      if (planFiles.length > 0) {
                        planFilePath = planFiles[0].path;
                        planContent = fs.readFileSync(planFilePath, 'utf-8');
                      }
                    }
                  }
                  }
                }

                // If still no plan content, use a placeholder message
                if (!planContent) {
                  planContent = 'Plan content not found. The assistant wants to proceed with the implementation.';
                }

                // Get allowedPrompts from input if present
                const allowedPrompts = input.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined;

                // Ask user for approval
                const approved = await this.askPlanApproval(sessionId, planContent, planFilePath, allowedPrompts);

                if (approved) {
                  console.log('[Claude Service] Plan approved by user');
                  // Clean up cached plan content
                  this.sessionPlanFiles.delete(sessionId);

                  // Switch to bypassPermissions (GREP IT) mode so the agent can execute its plan without interruptions
                  this.sessionPermissionModes.set(sessionId, 'bypassPermissions');
                  this.prePlanPermissionModes.delete(sessionId); // Clean up
                  console.log('[Claude Service] Plan approved — switching to bypassPermissions mode for execution');

                  // Notify the renderer to update its permission mode state
                  if (this.mainWindow) {
                    this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PERMISSION_MODE_CHANGED, {
                      sessionId,
                      mode: 'bypassPermissions',
                    });
                  }

                  return { behavior: 'allow' as const, updatedInput: input };
                } else {
                  console.log('[Claude Service] Plan rejected by user');
                  // Clean up cached plan content
                  this.sessionPlanFiles.delete(sessionId);

                  // Use custom feedback if provided, otherwise use default message
                  const planFeedback = this.lastPlanFeedback.get(sessionId);
                  const rejectionMessage = planFeedback
                    ? `Plan was not approved. User feedback: ${planFeedback}`
                    : 'Plan was not approved by the user. Please revise the plan based on user feedback.';

                  // Clear the feedback after using it
                  this.lastPlanFeedback.delete(sessionId);

                  return {
                    behavior: 'deny' as const,
                    message: rejectionMessage,
                  };
                }
              } catch (error) {
                console.error('[Claude Service] Error requesting plan approval:', error);
                return {
                  behavior: 'deny' as const,
                  message: error instanceof Error ? error.message : 'Failed to get plan approval',
                };
              }
            }

            // Check the CURRENT permission mode (may have changed via GREP IT! button)
            const currentPermissionMode = this.getSessionPermissionMode(sessionId) || sdkPermissionMode;
            console.log(`[Claude Service] Permission check - initial mode: ${sdkPermissionMode}, current mode: ${currentPermissionMode}`);

            // In plan mode, deny write operations
            if (currentPermissionMode === 'plan') {
              const writeTools = ['Write', 'Edit', 'Bash', 'NotebookEdit', 'TodoWrite'];
              if (writeTools.includes(toolName)) {
                console.log(`[Claude Service] Plan mode - denying write tool: ${toolName}`);
                return {
                  behavior: 'deny' as const,
                  message: 'In plan mode, write operations are not permitted. Please exit plan mode to make changes.',
                };
              }
            }

            // In 'bypassPermissions' mode, allow everything without asking
            if (currentPermissionMode === 'bypassPermissions') {
              console.log(`[Claude Service] Bypass permissions mode - auto-allowing: ${toolName}`);
              return { behavior: 'allow' as const, updatedInput: input };
            }

            // In 'default' mode, ask user for permission on tools that modify filesystem
            // In 'acceptEdits' mode, only ask for Bash commands (edits are auto-approved)
            if (currentPermissionMode === 'default') {
              // Default mode: ask for permission on all modifying tools
              const modifyingTools = ['Write', 'Edit', 'Bash', 'NotebookEdit', 'MultiEdit'];
              if (modifyingTools.includes(toolName)) {
                try {
                  console.log(`[Claude Service] Asking user permission for: ${toolName}`);
                  const response = await this.askUserPermission(sessionId, toolName, input);
                  if (response.approved) {
                    return {
                      behavior: 'allow' as const,
                      updatedInput: response.modifiedInput || input,
                    };
                  } else {
                    return {
                      behavior: 'deny' as const,
                      message: 'User denied permission for this tool',
                    };
                  }
                } catch (error) {
                  console.error('[Claude Service] Error getting permission:', error);
                  return {
                    behavior: 'deny' as const,
                    message: error instanceof Error ? error.message : 'Failed to get permission response',
                  };
                }
              }
            } else if (currentPermissionMode === 'acceptEdits') {
              // Accept edits mode: only ask for Bash commands
              if (toolName === 'Bash') {
                try {
                  console.log(`[Claude Service] Asking user permission for Bash command`);
                  const response = await this.askUserPermission(sessionId, toolName, input);
                  if (response.approved) {
                    return {
                      behavior: 'allow' as const,
                      updatedInput: response.modifiedInput || input,
                    };
                  } else {
                    return {
                      behavior: 'deny' as const,
                      message: 'User denied permission for this command',
                    };
                  }
                } catch (error) {
                  console.error('[Claude Service] Error getting permission:', error);
                  return {
                    behavior: 'deny' as const,
                    message: error instanceof Error ? error.message : 'Failed to get permission response',
                  };
                }
              }
            }

            // ScheduleWakeup, CronCreate/Delete/List, RemoteTrigger, PushNotification:
            // Let the SDK handle these natively. The CLI manages its own timers,
            // cron jobs, and loop state. Intercepting them with 'deny' prevented
            // the SDK's internal loop from functioning (wakeups never fired).

            // For other tools or bypassPermissions mode, allow them
            // Must include updatedInput when allowing - SDK requires it
            return { behavior: 'allow' as const, updatedInput: input };
          },
        },
      });

      // Store the Query object so we can inject messages via streamInput
      this.activeQueryObjects.set(sessionId, messages);

      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      const contentBlocks: ContentBlock[] = []; // Track content blocks in order

      // Agent teams tracking — parent_tool_use_id identifies which agent is producing content
      // null = lead agent, string = a teammate spawned via TeammateTool
      let currentAgentId: string | undefined = undefined;
      const agentNames = new Map<string, string>(); // agentId -> descriptive name

      // Batching for stream events to reduce render overhead
      let textBuffer = '';
      let textBufferAgentId: string | undefined = undefined;
      let thinkingBuffer = '';
      let lastFlush = Date.now();
      const FLUSH_INTERVAL_MS = 100; // Batch updates every 100ms for smoother rendering

      const flushBuffers = (): StreamEvent[] => {
        const events: StreamEvent[] = [];

        if (textBuffer) {
          const agentId = textBufferAgentId;
          fullContent += textBuffer;
          const content = textBuffer;
          textBuffer = '';
          textBufferAgentId = undefined;

          // Add or extend text block in contentBlocks (only merge if same agent)
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock && lastBlock.type === 'text' && lastBlock.agentId === agentId) {
            lastBlock.text = (lastBlock.text || '') + content;
          } else {
            contentBlocks.push({ type: 'text', text: content, agentId });
          }

          events.push({ type: 'text_delta', content, agentId });
        }
        if (thinkingBuffer) {
          const content = thinkingBuffer;
          thinkingBuffer = '';
          events.push({ type: 'thinking_delta', content });
        }
        return events;
      };

      let queryComplete = false;
      let lastTerminalReason: string | undefined; // From SDK result message (v0.2.91+)
      let lastToolName: string | undefined; // Track last tool for analytics attribution
      // Use manual iterator instead of `for await` to avoid auto-closing the
      // iterator on break. The background task listener needs the iterator to
      // stay open so it can keep reading task events after the turn ends.
      const msgIterator = messages[Symbol.asyncIterator]();
      let iterResult = await msgIterator.next();
      while (!iterResult.done) {
        const msg = iterResult.value;
        if (abortController.signal.aborted) {
          yield { type: 'error', error: 'Query cancelled' };
          return;
        }

        if (STREAM_DEBUG) {
          console.log('[Claude SDK] Message:', msg.type, JSON.stringify(msg).slice(0, 200));
        }

        if (msg.type !== 'stream_event') {
          for (const event of flushBuffers()) {
            yield event;
          }
        }

        // Handle different message types from the SDK
        switch (msg.type) {
          case 'system': {
            // System messages can have different subtypes
            const subtype = (msg as any).subtype;
            if (subtype && subtype !== 'status') {
              console.log('[Claude SDK] System message subtype:', subtype, JSON.stringify(msg).slice(0, 300));
            }
            const systemMsg = msg as SDKMessage & {
              subtype?: string;
              session_id?: string;
              tools?: string[];
              model?: string;
              status?: string | null;
              compact_metadata?: {
                trigger: 'manual' | 'auto';
                pre_tokens: number;
              };
            };

            // Handle compaction status changes (subtype: 'status')
            if (systemMsg.subtype === 'status') {
              // "requesting" = waiting for API slot (rate limited or queued)
              if (systemMsg.status === 'requesting') {
                console.log('[Claude SDK] Status: requesting (waiting for API)');
                break;
              }
              const isCompacting = systemMsg.status === 'compacting';
              console.log('[Claude SDK] Compaction status:', isCompacting ? 'COMPACTING' : 'idle');

              const compactionStatus: CompactionStatus = {
                sessionId,
                isCompacting,
              };

              // Emit to renderer via IPC
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, compactionStatus);
              }

              yield {
                type: 'compaction_status',
                compactionStatus,
              };
              break;
            }

            // Handle compaction complete (subtype: 'compact_boundary')
            if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
              console.log('[Claude SDK] Compaction complete:', systemMsg.compact_metadata);

              // Clear the cached context percentage so compactIdleSessions()
              // doesn't re-trigger on stale pre-compaction values. The real
              // percentage will be set on the next turn's result message.
              // Without this, the map holds the pre-compaction 85%+ value and
              // every subsequent compactIdleSessions() call re-compacts.
              this.sessionContextPercentage.delete(sessionId);
              this.sessionsBeingCompacted.delete(sessionId);
              console.log(`[Claude SDK] Cleared context percentage for ${sessionId.substring(0, 8)} after compaction`);

              const compactionComplete: CompactionComplete = {
                sessionId,
                preTokens: systemMsg.compact_metadata.pre_tokens,
              };

              // Emit to renderer via IPC
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, compactionComplete);
              }

              yield {
                type: 'compaction_complete',
                compactionComplete,
              };
              break;
            }

            // Handle SDK notifications (Monitor tool events, loop notifications).
            // These are real-time updates from background monitors — the key
            // identifies the source, text is the event content.
            if (systemMsg.subtype === 'notification') {
              const notif = systemMsg as typeof systemMsg & {
                key?: string; text?: string; priority?: string;
              };
              console.log('[Claude SDK] Notification:', notif.key, notif.text?.slice(0, 100));
              if (this.mainWindow && notif.text) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
                  sessionId,
                  taskId: notif.key,
                  description: notif.text,
                });
              }
              break;
            }

            // Handle task_started (background task beginning)
            if (systemMsg.subtype === 'task_started') {
              const started = systemMsg as typeof systemMsg & {
                task_id?: string; description?: string; task_type?: string;
              };
              console.log('[Claude SDK] Task started:', started.task_id, started.description?.slice(0, 80));
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
                  sessionId,
                  taskId: started.task_id,
                  description: `Started: ${started.description || started.task_type || 'task'}`,
                });
              }
              break;
            }

            // Handle task_notification (background task completed/failed/stopped)
            if (systemMsg.subtype === 'task_notification') {
              const notif = systemMsg as typeof systemMsg & {
                task_id?: string; status?: string; output_file?: string;
                summary?: string; usage?: Record<string, unknown>;
              };
              console.log('[Claude SDK] Task notification:', notif.task_id, notif.status, notif.summary?.slice(0, 80));
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, {
                  sessionId,
                  taskId: notif.task_id,
                  status: notif.status,
                  outputFile: notif.output_file,
                  summary: notif.summary,
                });
              }
              break;
            }

            // Handle task_progress (intermediate background task progress)
            if (systemMsg.subtype === 'task_progress') {
              const prog = systemMsg as typeof systemMsg & {
                task_id?: string; description?: string; summary?: string;
                last_tool_name?: string; usage?: Record<string, unknown>;
              };
              if (STREAM_DEBUG) {
                console.log('[Claude SDK] Task progress:', prog.task_id, prog.description?.slice(0, 80));
              }
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
                  sessionId,
                  taskId: prog.task_id,
                  description: prog.description,
                  summary: prog.summary,
                  lastToolName: prog.last_tool_name,
                });
              }
              break;
            }

            // Handle task_updated (real-time status delta patches for background tasks)
            if (systemMsg.subtype === 'task_updated') {
              const update = systemMsg as typeof systemMsg & {
                task_id?: string;
                patch?: {
                  status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
                  description?: string;
                  end_time?: number;
                  error?: string;
                  is_backgrounded?: boolean;
                };
              };
              console.log('[Claude SDK] Task updated:', update.task_id, JSON.stringify(update.patch));
              if (this.mainWindow && update.task_id && update.patch) {
                this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_UPDATED, {
                  sessionId,
                  taskId: update.task_id,
                  patch: update.patch,
                });
              }
              break;
            }

            // Default system message handling (tool/model info)
            // Store the SDK session ID for future resume calls in separate mappings object
            if (systemMsg.session_id) {
              this.sessionStore.set(`sdkSessionMappings.${sessionId}`, systemMsg.session_id);

              // Fetch session summary from SDK and use as display name.
              // Fire-and-forget — NEVER await inside the streaming generator or it
              // blocks the entire real-time pipeline while reading remote state.
              (async () => {
                try {
                  const { getSessionInfo } = require('@anthropic-ai/claude-agent-sdk') as { getSessionInfo: (id: string, opts?: { dir?: string }) => Promise<{ summary?: string } | undefined> };
                  const info = await getSessionInfo(systemMsg.session_id!, { dir: projectPath || process.cwd() });
                  if (info?.summary) {
                    this.sessionStore.set(`sessionNames.${sessionId}`, info.summary);
                    console.log(`[Claude SDK] Session name from SDK: "${info.summary}"`);
                    this.onSessionNameChanged?.();
                  }
                } catch { /* non-fatal */ }
              })();

              // After an SSH fork query, clear the forkFromSdkSessionId flag so
              // subsequent messages don't keep passing --fork-session. Also update
              // the session object so getMessages() uses the new SDK session ID.
              const currentSession = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
              if (currentSession && (currentSession as any).forkFromSdkSessionId) {
                const { forkFromSdkSessionId: _, ...cleanSession } = currentSession as any;
                this.sessionStore.set(`sessions.${sessionId}`, { ...cleanSession, sdkSessionId: systemMsg.session_id });
                console.log(`[Claude SDK] SSH fork complete — cleared forkFromSdkSessionId, new SDK ID: ${systemMsg.session_id}`);
              }
            }

            yield {
              type: 'system',
              systemInfo: {
                tools: systemMsg.tools || [],
                model: systemMsg.model || '',
              },
            };
            break;
          }

          case 'assistant': {
            // Full assistant message - only process tool_use blocks here
            // Text and thinking are handled via stream_event for real-time streaming
            const assistantMsg = msg as SDKMessage & { parent_tool_use_id?: string | null; message?: { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown> }> } };

            // Track which agent is producing this content
            currentAgentId = assistantMsg.parent_tool_use_id || undefined;

            if (assistantMsg.message?.content) {
              // Log all block types to debug tool detection
              if (STREAM_DEBUG) {
                const blockTypes = assistantMsg.message.content.map(b => `${b.type}${b.type === 'tool_use' ? ':' + (b.name || '?') : ''}`).join(', ');
                console.log('[Claude SDK] Assistant content blocks:', blockTypes);
              }

              for (const block of assistantMsg.message.content) {
                if (block.type === 'text' && block.text) {
                  // Only use assistant message text if we somehow missed it in stream_event
                  // This can happen if includePartialMessages doesn't capture everything
                  if (block.text.length > fullContent.length) {
                    const newContent = block.text.slice(fullContent.length);
                    fullContent = block.text;
                    yield { type: 'text_delta', content: newContent };
                  }
                } else if (block.type === 'tool_use') {
                  // Only create tool call if we have a valid name and haven't seen it
                  if (!block.name) {
                    continue;
                  }

                  // Check if we already have this tool call (from stream_event)
                  const existingTool = toolCalls.find(tc => tc.id === block.id);
                  if (!existingTool) {
                    const toolCall: ToolCall = {
                      id: block.id || '',
                      name: block.name,
                      input: block.input || {},
                      status: 'running',
                      startedAt: new Date(),
                      agentId: currentAgentId,
                    };
                    toolCalls.push(toolCall);
                    lastToolName = toolCall.name;
                    // Add tool_use content block to track order
                    contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                    yield { type: 'tool_use', toolCall, agentId: currentAgentId };
                  } else {
                    // Update existing tool call with complete input from full assistant message
                    // stream_event often fires with empty input, this has the complete data
                    if (block.input && Object.keys(block.input).length > 0) {
                      existingTool.input = block.input;
                      // Emit tool_use again to trigger UI update with complete input
                      yield { type: 'tool_use', toolCall: existingTool, agentId: currentAgentId };
                    }
                  }
                }
                // Note: thinking blocks from assistant message are ignored here
                // They should already have been streamed via stream_event thinking_delta
              }
            }
            break;
          }

          case 'stream_event': {
            // Partial/streaming message events - includes thinking deltas and tool use starts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const streamMsg = msg as SDKMessage & { event?: any; parent_tool_use_id?: string | null };

            // Track which agent is producing this stream content
            currentAgentId = streamMsg.parent_tool_use_id || undefined;

            if (streamMsg.event) {
              const event = streamMsg.event;

              if (event.type === 'content_block_delta' && event.delta) {
                if (event.delta.type === 'text_delta' && event.delta.text) {
                  if (textBuffer && textBufferAgentId !== currentAgentId) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = Date.now();
                  }
                  // Buffer text deltas for batching
                  textBufferAgentId = currentAgentId;
                  textBuffer += event.delta.text;

                  // Flush if enough time has passed or buffer is large
                  const now = Date.now();
                  if (now - lastFlush >= FLUSH_INTERVAL_MS || textBuffer.length >= 100) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = now;
                  }
                } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                  // Buffer thinking deltas for batching
                  thinkingBuffer += event.delta.thinking;

                  // Flush if enough time has passed or buffer is large
                  const now = Date.now();
                  if (now - lastFlush >= FLUSH_INTERVAL_MS || thinkingBuffer.length >= 100) {
                    for (const flushed of flushBuffers()) {
                      yield flushed;
                    }
                    lastFlush = now;
                  }
                } else {
                  // Tool input JSON deltas can run for a long time without text.
                  // Flush any visible text/thinking before those otherwise-invisible
                  // events so SSH sessions don't appear stalled until the final result.
                  for (const flushed of flushBuffers()) {
                    yield flushed;
                  }
                }
              } else if (event.type === 'content_block_start' && event.content_block) {
                for (const flushed of flushBuffers()) {
                  yield flushed;
                }

                // Handle tool use start events from streaming
                if (event.content_block.type === 'tool_use' && event.content_block.name) {
                  // Check if we already have this tool call (from assistant message)
                  const existingTool = toolCalls.find(tc => tc.id === event.content_block.id);
                  if (!existingTool) {
                    if (STREAM_DEBUG) {
                      console.log('[Claude SDK] Tool start:', event.content_block.name, currentAgentId ? `(agent: ${currentAgentId.slice(0, 8)})` : '(lead)');
                    }
                    const toolCall: ToolCall = {
                      id: event.content_block.id || `tool-${Date.now()}`,
                      name: event.content_block.name,
                      input: event.content_block.input || {},
                      status: 'running',
                      startedAt: new Date(),
                      agentId: currentAgentId,
                    };
                    toolCalls.push(toolCall);
                    // Add tool_use content block to track order
                    contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: currentAgentId });
                    yield { type: 'tool_use', toolCall, agentId: currentAgentId };
                  }
                }
              } else if (
                event.type === 'content_block_stop'
                || event.type === 'message_delta'
                || event.type === 'message_stop'
              ) {
                for (const flushed of flushBuffers()) {
                  yield flushed;
                }
              }
            }
            break;
          }

          case 'tool_progress': {
            // Tool execution progress - may contain tool details we need
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const progressMsg = msg as SDKMessage & { tool_use_id?: string; tool_name?: string; parent_tool_use_id?: string | null; content?: any; elapsed_time_seconds?: number; task_id?: string };
            if (STREAM_DEBUG) {
              console.log('[Claude SDK] Tool progress:', JSON.stringify(progressMsg).slice(0, 300));
            }

            // Emit tool progress to renderer for MonitorBlock + BackgroundTasksBlock
            if (this.mainWindow && progressMsg.tool_use_id) {
              this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
                sessionId,
                taskId: progressMsg.task_id,
                toolUseId: progressMsg.tool_use_id,
                toolName: progressMsg.tool_name,
                elapsedSeconds: progressMsg.elapsed_time_seconds,
              });
            }

            // Track agent from tool_progress messages too
            const progressAgentId = progressMsg.parent_tool_use_id || undefined;

            // Check if this has tool information we should capture
            if (progressMsg.tool_name && progressMsg.tool_use_id) {
              const existingTool = toolCalls.find(tc => tc.id === progressMsg.tool_use_id);
              if (!existingTool) {
                if (STREAM_DEBUG) {
                  console.log('[Claude SDK] Tool from progress:', progressMsg.tool_name, progressAgentId ? `(agent: ${progressAgentId.slice(0, 8)})` : '(lead)');
                }
                const toolCall: ToolCall = {
                  id: progressMsg.tool_use_id,
                  name: progressMsg.tool_name,
                  input: {},
                  status: 'running',
                  startedAt: new Date(),
                  agentId: progressAgentId,
                };
                toolCalls.push(toolCall);
                // Add tool_use content block to track order
                contentBlocks.push({ type: 'tool_use', toolCallId: toolCall.id, agentId: progressAgentId });
                yield { type: 'tool_use', toolCall, agentId: progressAgentId };
              }
            }
            break;
          }

          case 'user': {
            // User message (tool results)
            const userMsg = msg as SDKMessage & { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string }> } };
            if (userMsg.message?.content) {
              for (const block of userMsg.message.content) {
                if (block.type === 'tool_result') {
                  const content = block.content || '';

                  // Check if tool requires approval
                  if (typeof content === 'string' && content.includes('requires approval')) {
                    const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                    if (toolCall) {
                      // Emit permission request to renderer
                      yield {
                        type: 'permission_request',
                        sessionId,
                        requestId: block.tool_use_id || '',
                        toolName: toolCall.name,
                        toolInput: toolCall.input,
                        approvalMessage: content,
                      };
                      continue;
                    }
                  }

                  // Find and update the corresponding tool call
                  const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                  if (toolCall) {
                    toolCall.status = 'completed';
                    toolCall.result = content;
                    toolCall.completedAt = new Date();
                    yield { type: 'tool_result', toolCall, result: content };

                    // Check if this is a Write tool call to a plan file
                    if (toolCall.name === 'Write') {
                      const filePath = toolCall.input?.file_path as string;
                      const plansDir = path.join(os.homedir(), '.claude', 'plans');
                      if (filePath && filePath.startsWith(plansDir) && filePath.endsWith('.md')) {
                        // Read the plan file and emit plan_content event
                        try {
                          const planContent = fs.readFileSync(filePath, 'utf-8');
                          console.log(`[Claude Service] Plan file written: ${filePath}`);

                          // Cache the plan content for this session (for later ExitPlanMode use)
                          this.sessionPlanFiles.set(sessionId, { content: planContent, filePath });

                          // Emit to renderer via IPC
                          if (this.mainWindow) {
                            this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PLAN_CONTENT, {
                              sessionId,
                              planContent,
                              planFilePath: filePath,
                            });
                          }

                          yield { type: 'plan_content', sessionId, planContent, planFilePath: filePath };
                        } catch (err) {
                          console.error(`[Claude Service] Failed to read plan file: ${err}`);
                        }
                      }
                    }
                  }
                }
              }
            }
            break;
          }

          case 'rate_limit_event': {
            const rlMsg = msg as SDKMessage & { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } };
            const info = rlMsg.rate_limit_info;
            if (info?.status === 'rejected') {
              console.warn(`[Claude SDK] Rate limited (${info?.rateLimitType}) — will auto-retry in 10s`);
              pendingRateLimitRetry = true;
              yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
            }
            break;
          }

          case 'result': {
            // Result message may contain errors from the API
            const resultMsg = msg as SDKMessage & { is_error?: boolean; result?: string };

            // Check for empty text content blocks error
            if (resultMsg.is_error && resultMsg.result?.includes('text content blocks must be non-empty')) {
              console.error('[Claude SDK] Empty text content blocks detected in transcript for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              // Attempt to repair the transcript by removing entries with empty text
              const repaired = await this.repairEmptyTextBlocks(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ Empty text content was found in the session transcript. The transcript has been repaired - please try sending your message again.'
                };
              } else {
                // If repair failed, clear SDK session ID to start fresh
                this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
                yield {
                  type: 'error',
                  error: 'Session transcript was corrupted with empty content. Please try sending your message again - a fresh session will be started.'
                };
              }
              return;
            }

            // Check for thinking blocks corruption error
            if (resultMsg.is_error && resultMsg.result?.includes('thinking or redacted_thinking blocks')) {
              console.error('[Claude SDK] Thinking blocks corrupted in transcript for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              // Attempt to repair the transcript
              const repaired = await this.repairCorruptedTranscript(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ Thinking blocks were corrupted in the session transcript. The transcript has been repaired by removing the corrupted entries. Please try sending your message again.'
                };
              } else {
                // If repair failed, clear SDK session ID to start fresh
                this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
                yield {
                  type: 'error',
                  error: '⚠️ Thinking blocks were corrupted in the session transcript. Could not repair automatically - starting a fresh session. Please try sending your message again.'
                };
              }
              return;
            }

            // Check for "Prompt is too long" error - this means conversation is ALREADY too long
            // By this point, compaction will also fail. We need to ask user to rewind.
            if (resultMsg.is_error && resultMsg.result?.toLowerCase().includes('prompt is too long')) {
              console.error('[Claude SDK] Conversation too long - compaction will also fail at this point');

              yield {
                type: 'error',
                error: '❌ Your conversation history has exceeded the maximum length. Compaction cannot run at this point. Please use the /rewind command to go back a few messages and try again, or start a new session.'
              };
              return;
            }

            // Check for compaction failure error (conversation already too long for compaction)
            if (resultMsg.is_error && resultMsg.result?.toLowerCase().includes('conversation too long')) {
              console.error('[Claude SDK] Conversation too long for compaction');

              yield {
                type: 'error',
                error: '❌ Your conversation history is too long to compact. Please use the /rewind command to go back a few messages, or start a new session.'
              };
              return;
            }

            // Check for image size errors - auto-rewind past the problematic message
            if (resultMsg.is_error && (resultMsg.result?.includes('exceed max allowed size') || resultMsg.result?.includes('exceeds the dimension limit'))) {
              console.error('[Claude SDK] Image size error detected, attempting auto-repair for:', sessionId);
              const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

              const repaired = await this.repairOversizedImages(sessionId, sdkSessionId);

              if (repaired) {
                yield {
                  type: 'error',
                  error: '⚠️ An image in the conversation was too large. The problematic message has been removed. Please try again.'
                };
              } else {
                // Repair failed (e.g. SSH session where transcript is remote) — clear SDK session to start fresh
                console.log('[Claude SDK] Repair failed, clearing SDK session to start fresh for:', sessionId);
                this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
                this.sessionStore.delete(`sdkSessionMappings.${sessionId}`);
                yield {
                  type: 'error',
                  error: '⚠️ An image in the conversation history was too large. Starting fresh conversation — please try your message again.'
                };
              }
              return;
            }

            // Stale session ID — remote conversation was lost (OOM/crash/cleanup).
            // Auto-heal: clear the dead ID and retry the message immediately as a
            // fresh session so the user never sees a failure.
            if (resultMsg.is_error && resultMsg.result?.includes('No conversation found with session ID')) {
              console.error('[Claude SDK] Stale session ID — auto-healing:', resultMsg.result);
              this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
              this.sessionStore.delete(`sdkSessionMappings.${sessionId}`);
              yield { type: 'text_delta', content: '⚠️ Remote session expired — reconnecting automatically...\n\n' };
              // Retry with clean state — yield* delegates to a fresh generator
              yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages);
              return;
            }

            // Rate limit auto-retry: wait 10s then resend
            if (resultMsg.is_error && (pendingRateLimitRetry || resultMsg.result?.match(/rate.?limit|429|too many requests|overloaded/i))) {
              console.log('[Claude SDK] Rate limit auto-retry: waiting 10s');
              if (!pendingRateLimitRetry) {
                yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
              }
              await new Promise(r => setTimeout(r, 10000));
              if (abortController.signal.aborted) return;
              yield { type: 'text_delta', content: '🔄 Retrying...\n\n' };
              yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages);
              return;
            }

            // Check for other API errors
            if (resultMsg.is_error && resultMsg.result) {
              yield { type: 'error', error: resultMsg.result };
              return;
            }

            // Final result message with cost info - this marks end of query
            // Flush any remaining buffered content
            for (const flushed of flushBuffers()) {
              yield flushed;
            }

            // Extract terminal_reason from result message (SDK v0.2.91+)
            // Indicates why the query loop terminated (e.g. 'completed', 'max_turns', 'aborted_tools', etc.)
            const resultWithReason = resultMsg as SDKMessage & { terminal_reason?: TerminalReason };
            if (resultWithReason.terminal_reason) {
              console.log(`[Claude SDK] Terminal reason: ${resultWithReason.terminal_reason}`);
            }

            // Track token usage and send to renderer
            // Total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
            const successResult = resultMsg as SDKMessage & { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; model?: string };
            if (successResult.usage) {
              const inputTokens = (successResult.usage.input_tokens || 0)
                + (successResult.usage.cache_creation_input_tokens || 0)
                + (successResult.usage.cache_read_input_tokens || 0);
              const outputTokens = successResult.usage.output_tokens || 0;
              const currentModel = successResult.model || selectedModel || 'claude-opus-4-6';
              const hasLargeContext = currentModel.includes('opus-4-6') || currentModel.includes('sonnet-4-6') || currentModel.includes('sonnet-4-5');
              const contextWindowSize = hasLargeContext ? 1000000 : 200000;
              const percentage = Math.round((inputTokens / contextWindowSize) * 100);

              console.log(`[Claude SDK] Conversation tokens: ${inputTokens}/${contextWindowSize} (${percentage}%)`);
              this.sessionContextPercentage.set(sessionId, percentage);

              if (inputTokens >= contextWindowSize * 0.75) {
                console.warn(`[Claude SDK] ⚠️ Conversation approaching context limit: ${percentage}%`);
              }

              // Fetch rich context usage breakdown from SDK (v0.2.86+)
              // Provides per-category token counts (system prompt, tools, messages, MCP, etc.)
              // Fetch rich context usage breakdown — but NOT on SSH sessions.
              // getContextUsage() sends a request to the Claude Code process over
              // stdin/stdout. On SSH, this hangs indefinitely (the response gets
              // lost in the transport), blocking the entire stream pipeline.
              let contextUsageBreakdown: Record<string, unknown> | undefined;
              if (!session?.sshConfig) {
                try {
                  const queryObj = this.activeQueryObjects.get(sessionId);
                  if (queryObj) {
                    const richUsage = await Promise.race([
                      queryObj.getContextUsage(),
                      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getContextUsage timeout')), 5000)),
                    ]);
                    contextUsageBreakdown = richUsage as unknown as Record<string, unknown>;
                    console.log(`[Claude SDK] Rich context usage: ${richUsage.totalTokens}/${richUsage.maxTokens} (${richUsage.percentage}%) across ${richUsage.categories.length} categories`);
                  }
                } catch (ctxErr) {
                  console.warn('[Claude SDK] getContextUsage() failed, using basic token counts:', ctxErr);
                }
              }

              // Record analytics event for cost tracking
              const cacheReadTokens = successResult.usage.cache_read_input_tokens || 0;
              const cacheWriteTokens = successResult.usage.cache_creation_input_tokens || 0;
              const cost = estimateCost(currentModel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
              const tokenEvent = {
                sessionId,
                sessionName: session?.name || sessionId,
                timestamp: Date.now(),
                model: currentModel,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                toolName: lastToolName,
                estimatedCostUsd: cost,
              };
              analyticsService.recordTokenEvent(tokenEvent);
              if (this.mainWindow) {
                this.mainWindow.webContents.send(IPC_CHANNELS.ANALYTICS_TOKEN_EVENT, tokenEvent);
              }

              // Send context usage to renderer for display (enhanced with rich breakdown when available)
              yield {
                type: 'context_usage',
                inputTokens,
                outputTokens,
                contextWindowSize,
                percentage,
                estimatedCostUsd: cost,
                ...(contextUsageBreakdown ? { contextUsageBreakdown } : {}),
              } as StreamEvent & { inputTokens: number; outputTokens?: number; contextWindowSize: number; percentage: number; estimatedCostUsd?: number; contextUsageBreakdown?: Record<string, unknown> };
            }

            // Store terminal_reason for inclusion in the message_complete event
            if (resultWithReason.terminal_reason) {
              lastTerminalReason = resultWithReason.terminal_reason;
            }

            // Mark query as complete so we exit the loop
            // (For SSH sessions, the process stays alive for next query, so iterator won't close naturally)
            queryComplete = true;
            break;
          }

          default:
            // Log unhandled types so we can catch notifications/monitors we're missing
            if (STREAM_DEBUG || (msg as any).subtype === 'notification' || (msg as any).subtype === 'task_notification' || (msg as any).subtype === 'task_progress' || (msg as any).subtype === 'task_started') {
              console.log('[Claude SDK] Unhandled message type:', msg.type, 'subtype:', (msg as any).subtype, JSON.stringify(msg).slice(0, 200));
            }
            break;
        }

        // If query is complete (result message received), exit the main loop
        // but start a background listener for task events from running monitors/agents
        if (queryComplete) {
          console.log('[Claude SDK] Query complete, exiting message loop');

          // Keep reading from the iterator in the background for task lifecycle events.
          // The CC process stays alive between turns (especially SSH sessions), so
          // background tasks (Monitor, Agent) continue producing task_updated,
          // task_notification, and task_progress events after the assistant's turn ends.
          // Pass the raw iterator (NOT the Query) so it stays open.
          this.startBackgroundTaskListener(sessionId, msgIterator, abortController.signal);
          break;
        }
        iterResult = await msgIterator.next();
      }

      // Detect abnormal stream termination (e.g., remote process killed externally)
      // If the message loop exits without receiving a 'result' message, the remote
      // process likely died. Emit an error so the UI doesn't hang on "thinking...".
      if (!queryComplete && session?.sshConfig) {
        console.error('[Claude SDK] Stream ended without result message — remote process may have died');
        yield { type: 'error', error: 'Remote session disconnected. The remote process may have stopped. Try sending your message again to reconnect.' };
        return;
      }

      // Final flush before creating message
      for (const flushed of flushBuffers()) {
        yield flushed;
      }

      // Post-process content blocks to merge adjacent text blocks only
      // We keep text and tool_use blocks in their natural order, just combining
      // consecutive text blocks that might have been split during streaming
      const mergedBlocks: ContentBlock[] = [];
      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];
        const lastMerged = mergedBlocks[mergedBlocks.length - 1];

        if (block.type === 'text') {
          const text = block.text || '';

          // Only merge with immediately preceding text block from the SAME agent (not across tools or agent boundaries)
          if (lastMerged?.type === 'text' && lastMerged.agentId === block.agentId) {
            lastMerged.text = (lastMerged.text || '') + text;
          } else {
            mergedBlocks.push({ ...block });
          }
        } else {
          // tool_use block - add as-is
          mergedBlocks.push({ ...block });
        }
      }

      // Create final message with contentBlocks for interleaved rendering
      const message: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: fullContent,
        contentBlocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: new Date(),
        harness: 'claude',
      };

      yield { type: 'message_complete', message, ...(lastTerminalReason ? { terminalReason: lastTerminalReason } : {}) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Claude SDK] streamMessage error caught:', errorMessage);

      // Check if this is the thinking blocks corruption error
      if (errorMessage.includes('thinking or redacted_thinking blocks') ||
          errorMessage.includes('cannot be modified')) {
        console.error('[Claude SDK] Thinking blocks corrupted (caught in exception):', sessionId);
        const sdkSessionId = this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

        // Attempt to repair the transcript
        const repaired = await this.repairCorruptedTranscript(sessionId, sdkSessionId);

        if (repaired) {
          yield {
            type: 'error',
            error: '⚠️ Session had corrupted thinking data. The transcript has been repaired - please try your message again.'
          };
        } else {
          // If repair failed, clear SDK session ID to start fresh
          this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
          this.sessionStore.delete(`sdkSessionMappings.${sessionId}`);
          yield {
            type: 'error',
            error: '⚠️ Session had corrupted thinking data. Starting fresh session - please try your message again.'
          };
        }
      } else if (errorMessage.includes('No conversation found with session ID')) {
        console.error('[Claude SDK] Stale session ID (exception) — auto-healing:', errorMessage);
        this.sessionStore.delete(`sessions.${sessionId}.sdkSessionId`);
        this.sessionStore.delete(`sdkSessionMappings.${sessionId}`);
        yield { type: 'text_delta', content: '⚠️ Remote session expired — reconnecting automatically...\n\n' };
        yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages);
        return;
      } else if (errorMessage.match(/process exited with code|process terminated by signal/) && session?.sshConfig) {
        console.error('[Claude SDK] SSH process exit caught:', errorMessage);
        yield {
          type: 'error',
          error: `Remote Claude process exited unexpectedly (${errorMessage}). Messages already streamed are saved on the remote. Send another message to reconnect and continue.`,
        };
      } else if (errorMessage.match(/unauthorized|api.?key.*invalid|invalid.*api.?key|not authenticated|login required|authentication_error/i)) {
        console.error('[Claude SDK] Auth error caught:', errorMessage);
        yield {
          type: 'error',
          error: 'Authentication failed. Either set your Anthropic API key in Settings → API Keys, or run `claude login` in your terminal to authenticate via OAuth.'
        };
      } else if (errorMessage.match(/rate.?limit|429|too many requests|overloaded/i)) {
        console.log('[Claude SDK] Rate limit exception — auto-retry in 10s');
        yield { type: 'text_delta', content: `\n⏳ Rate limited — retrying in 10s...\n` };
        await new Promise(r => setTimeout(r, 10000));
        if (abortController.signal.aborted) return;
        yield { type: 'text_delta', content: '🔄 Retrying...\n\n' };
        yield* this.streamMessage(sessionId, userMessage, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages);
        return;
      } else {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      this.activeQueries.delete(sessionId);
      this.activeQueryObjects.delete(sessionId);
      // Stop health-checking this session's SSH connection now that it's idle.
      const sess = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      if (sess?.sshConfig) sshService.markSessionInactive(sessionId);
      powerService.sessionEnded();
    }
  }

  // Active background task listeners — one per session, cancelled on next query or cleanup
  private backgroundListeners = new Map<string, AbortController>();

  /**
   * Continue reading the SDK message iterator after a query turn completes.
   * Background tasks (Monitor, Agent) keep producing events on the same process
   * between turns. Without this, task_updated/task_notification events are lost.
   * Accepts the raw AsyncIterator (not the Query) so the iterator stays open —
   * `for await` auto-closes iterators on break, which would kill the stream.
   */
  private startBackgroundTaskListener(sessionId: string, iterator: AsyncIterator<SDKMessage>, parentSignal: AbortSignal): void {
    // Cancel any existing listener for this session (e.g., from a previous turn)
    this.backgroundListeners.get(sessionId)?.abort();

    const controller = new AbortController();
    this.backgroundListeners.set(sessionId, controller);

    const taskSubtypes = new Set(['task_updated', 'task_notification', 'task_progress', 'task_started']);

    (async () => {
      try {
        let result = await iterator.next();
        while (!result.done) {
          if (controller.signal.aborted || parentSignal.aborted) break;
          const msg = result.value;

          // Always advance the iterator before any continue/skip logic.
          // Without this, `continue` would re-enter the loop on the same
          // stale result and spin forever.
          result = await iterator.next();

          if (msg.type !== 'system') continue;
          const systemMsg = msg as typeof msg & { subtype?: string };
          if (!systemMsg.subtype || !taskSubtypes.has(systemMsg.subtype)) continue;

          console.log(`[Claude SDK] Background listener (${sessionId.slice(0, 8)}): ${systemMsg.subtype}`, JSON.stringify(msg).slice(0, 200));

          if (!this.mainWindow) continue;

          if (systemMsg.subtype === 'task_updated') {
            const update = systemMsg as typeof systemMsg & { task_id?: string; patch?: Record<string, unknown> };
            if (update.task_id && update.patch) {
              this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_UPDATED, {
                sessionId,
                taskId: update.task_id,
                patch: update.patch,
              });
            }
          } else if (systemMsg.subtype === 'task_notification') {
            const notif = systemMsg as typeof systemMsg & { task_id?: string; status?: string; output_file?: string; summary?: string };
            this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, {
              sessionId,
              taskId: notif.task_id,
              status: notif.status,
              outputFile: notif.output_file,
              summary: notif.summary,
            });
          } else if (systemMsg.subtype === 'task_progress' || systemMsg.subtype === 'task_started') {
            const prog = systemMsg as typeof systemMsg & { task_id?: string; description?: string; summary?: string; last_tool_name?: string };
            this.mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TASK_PROGRESS, {
              sessionId,
              taskId: prog.task_id,
              description: prog.description || (systemMsg.subtype === 'task_started' ? `Started: ${prog.summary || 'task'}` : undefined),
              summary: prog.summary,
              lastToolName: prog.last_tool_name,
            });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted && !parentSignal.aborted) {
          console.warn(`[Claude SDK] Background listener error (${sessionId.slice(0, 8)}):`, err);
        }
      } finally {
        this.backgroundListeners.delete(sessionId);
        console.log(`[Claude SDK] Background listener ended (${sessionId.slice(0, 8)})`);
      }
    })();
  }

  /**
   * Clean up all data associated with a deleted session.
   * Called from SESSION_DELETE handler only — never during streaming lifecycle.
   */
  cleanupSession(sessionId: string): void {
    // Abort active query if any
    const controller = this.activeQueries.get(sessionId);
    if (controller) {
      controller.abort();
      powerService.sessionEnded();
    }
    this.activeQueries.delete(sessionId);
    this.activeQueryObjects.delete(sessionId);
    this.backgroundListeners.get(sessionId)?.abort();
    this.backgroundListeners.delete(sessionId);

    // Kill remote processes if this is an SSH session
    const session = (this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined);
    if (session?.sshConfig) {
      sshService.killRemoteProcesses(sessionId, session.sshConfig).catch(() => {});
    }

    // Clear OpenClaw conversation history
    openclawService.clearHistory(sessionId);

    // Session-keyed maps
    this.sessionPermissionModes.delete(sessionId);
    this.prePlanPermissionModes.delete(sessionId);
    this.sessionContextPercentage.delete(sessionId);
    this.sessionLastMessageTime.delete(sessionId);
    this.sessionsBeingCompacted.delete(sessionId);
    this.sessionPlanFiles.delete(sessionId);
    this.browserMcpServers.delete(sessionId);

    // requestId-keyed maps — iterate and find matching sessionId
    for (const [reqId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Session deleted'));
        this.pendingPermissions.delete(reqId);
      }
    }
    // pendingQuestions and pendingPlanApprovals lack sessionId field —
    // they self-clean via existing timeouts. Acceptable for deletion.
  }

  cancelQuery(sessionId: string): void {
    const controller = this.activeQueries.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeQueries.delete(sessionId);
      this.activeQueryObjects.delete(sessionId);
      powerService.sessionEnded();
    }
    // Stop background task listener
    this.backgroundListeners.get(sessionId)?.abort();
    // Also kill any active Codex, Cursor, or Gemini process for this session
    codexService.cancel(sessionId);
    try { const { getCursorService } = require('./cursor.service'); getCursorService().cancel(sessionId); } catch { /* not loaded */ }
    try { const { getCursorCliService } = require('./cursor-cli.service'); getCursorCliService().cancel(sessionId); } catch { /* not loaded */ }
    try { const { getGeminiService } = require('./gemini.service'); getGeminiService().cancel(sessionId); } catch { /* not loaded */ }

    // Reject pending permissions — the query that requested them is dead
    for (const [reqId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.reject(new Error('Query cancelled'));
        this.pendingPermissions.delete(reqId);
      }
    }
  }

  /**
   * Inject a message into an active query using streamInput.
   * This allows sending follow-up messages without waiting for the current response to complete.
   * The message will be processed after the next tool call completes.
   */
  async injectMessage(sessionId: string, message: string, attachments?: Attachment[]): Promise<boolean> {
    const queryObj = this.activeQueryObjects.get(sessionId);
    if (!queryObj) {
      console.log('[Claude Service] injectMessage: No active query for session', sessionId);
      return false;
    }

    // Validate message is not empty to prevent API error
    let safeMessage = message;
    const hasImages = attachments?.some(a => a.type === 'image');
    if (!message || message.trim() === '') {
      if (!hasImages) {
        console.log('[Claude Service] injectMessage: Empty message with no images, skipping');
        return false;
      }
      safeMessage = 'Please analyze this image.';
    }

    console.log('[Claude Service] injectMessage: Injecting message into active query for session', sessionId);

    try {
      // Create an async generator that yields a single user message
      // Capture `this` for use inside the generator function
      const resizeImage = this.resizeImageIfNeeded.bind(this);
      async function* createMessageStream(): AsyncIterable<SDKUserMessage> {
        // Build content with any image attachments
        const imageAttachments = attachments?.filter(a => a.type === 'image') || [];
        const hasImagesLocal = imageAttachments.length > 0;

        if (hasImagesLocal) {
          const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
            { type: 'text', text: safeMessage }
          ];

          for (const attachment of imageAttachments) {
            const ext = attachment.name.split('.').pop()?.toLowerCase();
            const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
              : 'image/png';

            // Resize image if needed to stay under Anthropic's dimension limits
            const resizedData = await resizeImage(attachment.content, mediaType);

            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: resizedData,
              },
            });
          }

          yield {
            type: 'user',
            message: {
              role: 'user',
              content: content as any,
            },
            parent_tool_use_id: null,
            session_id: '',
          } as SDKUserMessage;
        } else {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: safeMessage,
            },
            parent_tool_use_id: null,
            session_id: '',
          } as SDKUserMessage;
        }
      }

      await queryObj.streamInput(createMessageStream());
      console.log('[Claude Service] injectMessage: Message injected successfully');
      return true;
    } catch (error) {
      console.error('[Claude Service] injectMessage: Failed to inject message:', error);
      return false;
    }
  }

  /**
   * Check if there's an active query for the given session.
   * Uses activeQueries (AbortController map) which covers the full lifetime
   * of streamMessage, including before the SDK Query object is created.
   */
  hasActiveQuery(sessionId: string): boolean {
    return this.activeQueries.has(sessionId);
  }

  /**
   * Get project slug from path - matches SDK's convention
   * The SDK uses: leading dash, preserve case, replace / with -
   */
  private getProjectSlug(projectPath: string): string {
    // SDK uses a slug that starts with dash and preserves case
    // /home/user/dev/project -> -home-user-dev-project
    return projectPath.replace(/\//g, '-');
  }

  /**
   * Prepare attachments for CLI-based harnesses (Cursor, Gemini, etc.) that take
   * a plain-text prompt. DOM elements are embedded as XML text blocks. Images are
   * written to temp files and referenced by path in the prompt.
   *
   * For SSH sessions, images are uploaded to the remote host via SFTP so the
   * remote CLI can actually access them.
   */
  private async prepareCliAttachments(
    sessionId: string,
    message: string,
    attachments?: Attachment[],
    sshConfig?: import('../../shared/types').SSHConfig,
  ): Promise<{ message: string; cleanup: () => Promise<void> }> {
    const noop = async () => {};
    if (!attachments || attachments.length === 0) return { message, cleanup: noop };

    let result = message;

    const domElements = attachments.filter(a => a.type === 'dom_element');
    if (domElements.length > 0) {
      const domContext = domElements.map((el, i) =>
        `<selected-element index="${i + 1}" selector="${el.name}">\n${el.content}\n</selected-element>`
      ).join('\n\n');
      result = `${domContext}\n\n${result}`;
    }

    const images = attachments.filter(a => a.type === 'image');
    if (images.length > 0) {
      const localTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `build-cli-${sessionId}-`));
      const localPaths: string[] = [];
      for (const [idx, img] of images.entries()) {
        const ext = img.name.match(/\.(jpe?g)$/i) ? '.jpg' : '.png';
        const imgPath = path.join(localTempDir, `screenshot-${idx}${ext}`);
        await fs.promises.writeFile(imgPath, img.content, 'base64');
        localPaths.push(imgPath);
      }

      if (sshConfig) {
        return this.uploadCliImagesToRemote(sessionId, result, localPaths, localTempDir, sshConfig);
      }

      const imageRef = localPaths.map((p, i) => `[Attached screenshot ${i + 1}: ${p}]`).join('\n');
      result = `${imageRef}\n\n${result}`;
      console.log(`[Claude Service] Wrote ${localPaths.length} image(s) to ${localTempDir} for CLI harness`);
      return {
        message: result,
        cleanup: async () => { await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => {}); },
      };
    }

    return { message: result, cleanup: noop };
  }

  private async uploadCliImagesToRemote(
    sessionId: string,
    message: string,
    localPaths: string[],
    localTempDir: string,
    sshConfig: import('../../shared/types').SSHConfig,
  ): Promise<{ message: string; cleanup: () => Promise<void> }> {
    const remoteDir = `/tmp/build-cli-${sessionId}-${Date.now()}`;
    const escapedRemoteDir = remoteDir.replace(/'/g, "'\\''");

    try {
      const client = await sshService['getConnection'](sessionId, sshConfig);
      await new Promise<void>((resolve, reject) => {
        client.exec(`mkdir -p '${escapedRemoteDir}'`, (err, ch) => {
          if (err) return reject(err);
          ch.on('close', () => resolve());
          ch.resume();
        });
      });

      const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
        client.sftp((err, s) => err ? reject(err) : resolve(s));
      });

      const remotePaths: string[] = [];
      try {
        for (const [idx, localPath] of localPaths.entries()) {
          const remotePath = `${remoteDir}/screenshot-${idx}${path.extname(localPath) || '.png'}`;
          await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
          });
          remotePaths.push(remotePath);
        }
      } finally {
        try { sftp.end(); } catch { /* ignore */ }
        await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => {});
      }

      const imageRef = remotePaths.map((p, i) => `[Attached screenshot ${i + 1}: ${p}]`).join('\n');
      console.log(`[Claude Service] Uploaded ${remotePaths.length} image(s) to ${sshConfig.host}:${remoteDir}`);

      return {
        message: `${imageRef}\n\n${message}`,
        cleanup: async () => {
          try {
            const c = await sshService['getConnection'](sessionId, sshConfig);
            await new Promise<void>((resolve) => {
              c.exec(`rm -rf '${escapedRemoteDir}'`, (err, ch) => {
                if (err) return resolve();
                ch.on('close', () => resolve());
                ch.resume();
              });
            });
          } catch { /* best-effort remote cleanup */ }
        },
      };
    } catch (err) {
      await fs.promises.rm(localTempDir, { recursive: true, force: true }).catch(() => {});
      console.error(`[Claude Service] Failed to upload images to remote ${sshConfig.host}:`, err);
      return { message, cleanup: async () => {} };
    }
  }

  /**
   * Resize a base64-encoded image if either dimension exceeds the max allowed size.
   * Uses Electron's built-in nativeImage — no external native dependencies needed.
   * Anthropic recommends 1568px max for multi-image requests (hard limit is 2000px).
   */
  private async resizeImageIfNeeded(base64Data: string, mediaType: string): Promise<string> {
    const MAX_DIMENSION = 1568; // Anthropic recommended max (fits well under 2000px limit)

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const image = nativeImage.createFromBuffer(buffer);

      if (image.isEmpty()) return base64Data;

      const { width, height } = image.getSize();
      if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) return base64Data;

      console.log(`[Claude Service] Resizing image from ${width}x${height} (max ${MAX_DIMENSION}px)`);

      // Calculate new dimensions maintaining aspect ratio
      const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      const newWidth = Math.round(width * scale);
      const newHeight = Math.round(height * scale);

      const resized = image.resize({ width: newWidth, height: newHeight });

      // Convert back to the appropriate format
      const resizedBuffer = mediaType.includes('png') ? resized.toPNG() : resized.toJPEG(90);

      console.log(`[Claude Service] Image resized to ${newWidth}x${newHeight}, ${resizedBuffer.length} bytes`);
      return resizedBuffer.toString('base64');
    } catch (error) {
      console.error('[Claude Service] Failed to resize image, using original:', error);
      return base64Data;
    }
  }

  /**
   * Repair a transcript by removing the last user turn that contains oversized images.
   * Follows the same pattern as repairCorruptedTranscript().
   */
  private async repairOversizedImages(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair oversized images');
        return false;
      }

      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;
      const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
      let content: string | null = null;
      let transcriptPath: string | null = null;
      let isRemote = false;

      if (session?.sshConfig) {
        // SSH session — find and read transcript on remote machine
        isRemote = true;
        console.log('[Claude] Searching for remote transcript:', transcriptFilename);
        try {
          // Construct the expected path: ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl
          // Claude encodes the workdir by replacing / with - (keeping leading -)
          const workdir = session.sshConfig.remoteWorkdir || '/tmp';
          const encodedDir = workdir.replace(/\//g, '-');
          transcriptPath = `~/.claude/projects/${encodedDir}/${transcriptFilename}`;
          console.log('[Claude] Trying remote transcript path:', transcriptPath);
          content = await sshService.readRemoteFile(sessionId, session.sshConfig, transcriptPath);
        } catch (e) {
          console.error('[Claude] Failed to read remote transcript:', e);
          return false;
        }
      } else {
        // Local session — find transcript in ~/.claude/projects/
        const claudeDir = path.join(os.homedir(), '.claude', 'projects');
        if (!fs.existsSync(claudeDir)) {
          console.log('[Claude] Claude projects directory not found:', claudeDir);
          return false;
        }
        const projectDirs = fs.readdirSync(claudeDir);
        for (const projectDir of projectDirs) {
          const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
          if (fs.existsSync(candidatePath)) {
            transcriptPath = candidatePath;
            break;
          }
        }
        if (!transcriptPath) {
          console.log('[Claude] Transcript file not found:', transcriptFilename);
          return false;
        }
        content = fs.readFileSync(transcriptPath, 'utf-8');
      }

      if (!content || !transcriptPath) {
        console.log('[Claude] No transcript content to repair');
        return false;
      }

      console.log('[Claude] Repairing oversized images in transcript:', transcriptPath);

      const lines = content.trim().split('\n');
      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      const entries: Array<{ line: string; parsed: Record<string, unknown> }> = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            entries.push({ line, parsed });
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Walk backwards to find the last user turn containing image blocks
      let lastUserTurnStart = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i].parsed;
        const message = entry.message as Record<string, unknown> | undefined;
        if (entry.type === 'user' || (message && message.role === 'user')) {
          const lineStr = entries[i].line;
          const msgContent = message?.content;
          if (lineStr.includes('"type":"image"') || lineStr.includes('"type": "image"') ||
              (Array.isArray(msgContent) && (msgContent as Array<Record<string, unknown>>).some(b => b.type === 'image'))) {
            lastUserTurnStart = i;
            break;
          }
        }
      }

      if (lastUserTurnStart === -1) {
        console.log('[Claude] Could not find user turn with images to remove');
        return false;
      }

      // Remove entries from the last user turn with images onwards
      const repairedEntries = entries.slice(0, lastUserTurnStart);
      const repairedContent = repairedEntries.map(e => e.line).join('\n') + '\n';

      if (isRemote && session?.sshConfig) {
        // Write repaired transcript back to remote machine
        await sshService.writeRemoteFile(sessionId, session.sshConfig, transcriptPath, repairedContent);
      } else {
        // Local backup and write
        const backupPath = transcriptPath + '.backup.' + Date.now();
        fs.copyFileSync(transcriptPath, backupPath);
        console.log('[Claude] Created transcript backup:', backupPath);
        fs.writeFileSync(transcriptPath, repairedContent);
      }

      console.log('[Claude] Transcript repaired - removed', entries.length - lastUserTurnStart, 'entries (oversized image turn)');
      console.log('[Claude] Original entries:', entries.length, '-> Repaired entries:', repairedEntries.length);

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing oversized images:', error);
      return false;
    }
  }

  /**
   * Repair a corrupted transcript by removing the last assistant message entries
   * that contain corrupted thinking blocks.
   *
   * The error "thinking or redacted_thinking blocks in the latest assistant message
   * cannot be modified" means the last assistant turn's thinking was corrupted.
   * We repair this by removing those entries from the transcript.
   */
  private async repairCorruptedTranscript(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      // Resolve the SDK session ID
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair transcript');
        return false;
      }

      // Find the transcript file
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;

      if (!fs.existsSync(claudeDir)) {
        console.log('[Claude] Claude projects directory not found:', claudeDir);
        return false;
      }

      // Search for the transcript file
      let transcriptPath: string | null = null;
      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(candidatePath)) {
          transcriptPath = candidatePath;
          break;
        }
      }

      if (!transcriptPath) {
        console.log('[Claude] Transcript file not found:', transcriptFilename);
        return false;
      }

      console.log('[Claude] Repairing transcript:', transcriptPath);

      // Read the transcript file
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      // Parse lines to find the last assistant message and remove it
      // We need to find entries that are part of the corrupted assistant turn
      const entries: Array<{ line: string; parsed: Record<string, unknown> }> = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            entries.push({ line, parsed });
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Find the last assistant turn start and remove everything from there
      // Look for message types that indicate an assistant response
      let lastAssistantTurnStart = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i].parsed;
        // SDK transcript entries have various types
        // Look for 'assistant' type or message with role 'assistant'
        if (entry.type === 'assistant' ||
            (entry.message && (entry.message as Record<string, unknown>).role === 'assistant')) {
          lastAssistantTurnStart = i;
          break;
        }
      }

      if (lastAssistantTurnStart === -1) {
        console.log('[Claude] Could not find last assistant turn to remove');
        return false;
      }

      // Create backup before modifying
      const backupPath = transcriptPath + '.backup.' + Date.now();
      fs.copyFileSync(transcriptPath, backupPath);
      console.log('[Claude] Created transcript backup:', backupPath);

      // Remove entries from the last assistant turn onwards
      const repairedEntries = entries.slice(0, lastAssistantTurnStart);
      const repairedContent = repairedEntries.map(e => e.line).join('\n') + '\n';

      // Write repaired transcript
      fs.writeFileSync(transcriptPath, repairedContent);
      console.log('[Claude] Transcript repaired - removed', entries.length - lastAssistantTurnStart, 'entries');
      console.log('[Claude] Original entries:', entries.length, '-> Repaired entries:', repairedEntries.length);

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing transcript:', error);
      return false;
    }
  }

  /**
   * Repair a transcript that contains empty text content blocks.
   *
   * The error "text content blocks must be non-empty" means the transcript
   * contains entries with empty text. We repair by either:
   * 1. Removing entries with empty text content
   * 2. Fixing the empty text by replacing with a placeholder
   */
  private async repairEmptyTextBlocks(sessionId: string, sdkSessionId?: string): Promise<boolean> {
    try {
      // Resolve the SDK session ID
      const resolvedSdkSessionId = sdkSessionId
        || this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
        || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;

      if (!resolvedSdkSessionId) {
        console.log('[Claude] No SDK session ID found, cannot repair empty text blocks');
        return false;
      }

      // Find the transcript file
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const transcriptFilename = `${resolvedSdkSessionId}.jsonl`;

      if (!fs.existsSync(claudeDir)) {
        console.log('[Claude] Claude projects directory not found:', claudeDir);
        return false;
      }

      // Search for the transcript file
      let transcriptPath: string | null = null;
      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const candidatePath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(candidatePath)) {
          transcriptPath = candidatePath;
          break;
        }
      }

      if (!transcriptPath) {
        console.log('[Claude] Transcript file not found:', transcriptFilename);
        return false;
      }

      console.log('[Claude] Repairing empty text blocks in transcript:', transcriptPath);

      // Read the transcript file
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length === 0) {
        console.log('[Claude] Transcript is empty, nothing to repair');
        return false;
      }

      // Helper to check if an entry has empty text content
      const hasEmptyTextContent = (entry: Record<string, unknown>): boolean => {
        // Check message.content array for empty text blocks
        const message = entry.message as Record<string, unknown> | undefined;
        if (message?.content) {
          const contentArray = message.content as Array<{ type?: string; text?: string }>;
          if (Array.isArray(contentArray)) {
            for (const block of contentArray) {
              if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
                return true;
              }
            }
          }
        }
        // Check direct content property
        if (entry.content) {
          const contentArray = entry.content as Array<{ type?: string; text?: string }>;
          if (Array.isArray(contentArray)) {
            for (const block of contentArray) {
              if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
                return true;
              }
            }
          }
        }
        return false;
      };

      // Helper to fix empty text content by replacing with placeholder
      const fixEmptyTextContent = (entry: Record<string, unknown>): Record<string, unknown> => {
        const fixed = JSON.parse(JSON.stringify(entry)); // Deep clone

        const fixContent = (content: Array<{ type?: string; text?: string }>) => {
          for (const block of content) {
            if (block.type === 'text' && (block.text === '' || block.text === undefined)) {
              block.text = '[empty]'; // Replace with placeholder
            }
          }
        };

        if (fixed.message?.content && Array.isArray(fixed.message.content)) {
          fixContent(fixed.message.content);
        }
        if (fixed.content && Array.isArray(fixed.content)) {
          fixContent(fixed.content);
        }

        return fixed;
      };

      // Parse and fix entries
      let modified = false;
      const repairedLines: string[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          if (hasEmptyTextContent(parsed)) {
            console.log('[Claude] Found entry with empty text content, fixing...');
            const fixed = fixEmptyTextContent(parsed);
            repairedLines.push(JSON.stringify(fixed));
            modified = true;
          } else {
            repairedLines.push(line);
          }
        } catch {
          // Keep unparseable lines as-is
          repairedLines.push(line);
        }
      }

      if (!modified) {
        console.log('[Claude] No empty text blocks found in transcript');
        // Fall back to removing last assistant turn as a more aggressive fix
        return this.repairCorruptedTranscript(sessionId, sdkSessionId);
      }

      // Create backup before modifying
      const backupPath = transcriptPath + '.backup.' + Date.now();
      fs.copyFileSync(transcriptPath, backupPath);
      console.log('[Claude] Created transcript backup:', backupPath);

      // Write repaired transcript
      const repairedContent = repairedLines.join('\n') + '\n';
      fs.writeFileSync(transcriptPath, repairedContent);
      console.log('[Claude] Transcript repaired - fixed empty text blocks');

      return true;
    } catch (error) {
      console.error('[Claude] Error repairing empty text blocks:', error);
      return false;
    }
  }

  /**
   * Performance optimization: Check if we have cached messages for a session
   * Validates cache by comparing file hash (mtime + size)
   */
  private async getCachedMessages(
    sessionId: string,
    transcriptPath: string
  ): Promise<ChatMessage[] | null> {
    const cached = this.messageCache.get(sessionId);
    if (!cached) return null;

    // Check if file changed (compare mtime + size for quick hash)
    try {
      const stats = await fs.promises.stat(transcriptPath);
      const currentHash = `${stats.mtime.getTime()}-${stats.size}`;

      if (cached.fileHash === currentHash) {
        console.log('[Claude] Using cached messages for', sessionId, `(${cached.messages.length} messages)`);
        return cached.messages;
      } else {
        console.log('[Claude] Cache invalidated - file changed:', sessionId);
      }
    } catch {
      // File doesn't exist or changed, invalidate cache
      console.log('[Claude] Cache invalidated - file not found:', sessionId);
    }

    return null;
  }

  /**
   * Performance optimization: Cache parsed messages with file hash
   */
  private setCachedMessages(
    sessionId: string,
    transcriptPath: string,
    messages: ChatMessage[]
  ): void {
    try {
      const stats = fs.statSync(transcriptPath);
      const fileHash = `${stats.mtime.getTime()}-${stats.size}`;

      this.messageCache.set(sessionId, {
        messages,
        loadedAt: Date.now(),
        fileHash,
      });
      console.log('[Claude] Cached messages for', sessionId, `(${messages.length} messages)`);
    } catch (error) {
      console.warn('[Claude] Failed to cache messages:', error);
    }
  }

  /**
   * Performance optimization: Find and cache transcript file path
   */
  private findTranscriptPath(sessionId: string, sdkSessionId: string): string | null {
    // Check cache first
    if (this.transcriptPathCache.has(sessionId)) {
      const cached = this.transcriptPathCache.get(sessionId)!;
      if (fs.existsSync(cached)) {
        return cached;
      }
      // Path no longer valid, remove from cache
      this.transcriptPathCache.delete(sessionId);
      console.log('[Claude] Transcript path cache invalidated:', sessionId);
    }

    // Search for transcript
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    const transcriptFilename = `${sdkSessionId}.jsonl`;

    try {
      if (!fs.existsSync(claudeDir)) {
        return null;
      }

      const projectDirs = fs.readdirSync(claudeDir);
      for (const projectDir of projectDirs) {
        const transcriptPath = path.join(claudeDir, projectDir, transcriptFilename);
        if (fs.existsSync(transcriptPath)) {
          // Cache for next time
          this.transcriptPathCache.set(sessionId, transcriptPath);
          console.log('[Claude] Cached transcript path for', sessionId);
          return transcriptPath;
        }
      }
    } catch (error) {
      console.error('[Claude] Error searching for transcript:', error);
    }

    return null;
  }

  /**
   * Public API: Invalidate message cache for a session (call when new message sent)
   */
  invalidateMessageCache(sessionId: string): void {
    if (this.messageCache.delete(sessionId)) {
      console.log('[Claude] Invalidated message cache for', sessionId);
    }
  }

  /**
   * Get messages from SDK transcript files for a session
   * @param limit - Optional limit on number of messages to return (most recent). Default 200 for performance.
   */
  // limit: positive = most recent N, 0 or negative = full transcript (cat instead of tail)
  async getMessages(sessionId: string, limit: number = 200): Promise<ChatMessage[]> {
    const session = this.sessionStore.get(`sessions.${sessionId}`) as Session | undefined;
    console.log(`[Claude] getMessages called for ${sessionId.substring(0, 8)}, hasSSH: ${!!session?.sshConfig}, hasTeleport: ${!!session?.isTeleported}`);
    if (session?.isTeleported) {
      console.log('[Claude] Teleported session - no local transcript, will resume from remote:', sessionId);
      return [];
    }

    // Get the stored SDK session ID for this session
    // Try new location first, then fall back to old location for backwards compatibility
    // 'new' is a sentinel for brand-new sessions that have never had a conversation —
    // these must NOT inherit old transcripts from the same remote directory.
    const storedSdkSessionId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined
      || this.sessionStore.get(`sessions.${sessionId}.sdkSessionId`) as string | undefined;
    const isNewSession = storedSdkSessionId === 'new';
    const hasStoredSdkSessionId = !!storedSdkSessionId && !isNewSession;
    const sdkSessionId = hasStoredSdkSessionId ? storedSdkSessionId : sessionId;

    // For SSH sessions, fetch transcript from the remote machine
    if (session?.sshConfig) {
      // Brand-new session — start fresh, don't search for old transcripts
      if (isNewSession) {
        console.log('[Claude] Brand-new SSH session — starting fresh (no transcript search)');
        return [];
      }

      // Only invalidate cache for full fetches (limit <= 0, used by HistoryPanel).
      // Normal loads use the 5-minute cache to avoid hammering SSH on every tab switch.
      if (limit <= 0) {
        sshService.invalidateTranscriptCache(sdkSessionId);
        sshService.invalidateTranscriptCache(sessionId);
      }

      // If no stored SDK ID, try to find the most recent transcript on the remote.
      // This handles the case where the mapping was lost (repair, migration, etc.)
      // but the conversation still exists on the remote.
      if (!hasStoredSdkSessionId) {
        console.log('[Claude] SSH session without stored SDK ID — searching for latest transcript');
        try {
          const transcripts = await sshService.listRemoteTranscripts(
            sessionId,
            session.sshConfig,
            session.sshConfig.remoteWorkdir
          );
          if (transcripts.length > 0) {
            // Use the most recent transcript (last modified)
            const latest = transcripts[0];
            console.log('[Claude] Found orphaned transcript, restoring mapping:', latest.sessionId);
            // Restore the mapping so future loads don't need to search
            this.sessionStore.set(`sdkSessionMappings.${sessionId}`, latest.sessionId);
            const content = await sshService.fetchRemoteTranscript(
              sessionId,
              session.sshConfig,
              latest.sessionId,
              session.sshConfig.remoteWorkdir,
              { full: limit <= 0 }
            );
            if (content) {
              const messages = this.parseTranscriptContent(content);
              const limited = limit > 0 ? messages.slice(-limit) : messages;
              console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages (restored mapping)`);
              this.messageCacheStore.set(sessionId, limited);
              return limited;
            }
          }
          console.log('[Claude] No transcripts found on remote — starting fresh');
          return [];
        } catch (error) {
          console.error('[Claude] Error searching for orphaned transcripts:', error);
          const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
          if (cached?.length) {
            console.log(`[Claude] Orphan search failed — returning ${cached.length} locally cached messages`);
            return cached;
          }
          return [];
        }
      }

      console.log('[Claude] SSH session - fetching transcript from remote:', sdkSessionId);
      try {
        const remoteContent = await sshService.fetchRemoteTranscript(
          sessionId,
          session.sshConfig,
          sdkSessionId,
          session.sshConfig.remoteWorkdir,
          { full: limit <= 0 }
        );

        if (remoteContent) {
          console.log('[Claude] Parsing remote transcript, length:', remoteContent.length);
          const messages = this.parseTranscriptContent(remoteContent);
          const limited = limit > 0 ? messages.slice(-limit) : messages;
          console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages`);
          // Cache locally for resilience against SSH disconnects
          this.messageCacheStore.set(sessionId, limited);
          return limited;
        }

        // Only fall back to listing transcripts if we have a stored SDK ID
        // This prevents new SSH sessions from picking up old conversations
        console.log('[Claude] Stored SDK ID not found directly, listing available transcripts...');
        const transcripts = await sshService.listRemoteTranscripts(
          sessionId,
          session.sshConfig,
          session.sshConfig.remoteWorkdir
        );

        if (transcripts.length > 0) {
          // Only use transcripts that match our stored SDK session ID
          const matching = transcripts.find(t => t.sessionId === storedSdkSessionId);
          if (matching) {
            console.log('[Claude] Found matching transcript:', matching.filename);
            const content = await sshService.fetchRemoteTranscript(
              sessionId,
              session.sshConfig,
              matching.sessionId,
              session.sshConfig.remoteWorkdir,
              { full: limit <= 0 }
            );
            if (content) {
              const messages = this.parseTranscriptContent(content);
              const limited = limit > 0 ? messages.slice(-limit) : messages;
              console.log(`[Claude] Returning ${limited.length}/${messages.length} SSH messages`);
              this.messageCacheStore.set(sessionId, limited);
              return limited;
            }
          } else {
            console.log('[Claude] No transcript matching stored SDK ID:', storedSdkSessionId);
          }
        }

        console.log('[Claude] No matching remote transcript found');
        // Return local cache if available
        const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
        if (cached?.length) {
          console.log(`[Claude] Returning ${cached.length} locally cached messages (no remote match)`);
          return cached;
        }
        return [];
      } catch (error) {
        console.error('[Claude] Error fetching remote transcript:', error);
        // SSH is down — return locally cached messages so the UI doesn't lose history
        const cached = this.messageCacheStore.get(sessionId) as ChatMessage[] | undefined;
        if (cached?.length) {
          console.log(`[Claude] SSH fetch failed — returning ${cached.length} locally cached messages`);
          return cached;
        }
        return [];
      }
    }

    // Look for transcript files in ~/.claude/projects/ - use cached path if available
    const perfStart = performance.now();
    const transcriptPath = this.findTranscriptPath(sessionId, sdkSessionId);

    if (!transcriptPath) {
      console.log('[Claude] Transcript not found:', sdkSessionId);
      return [];
    }

    // Check cache first (performance optimization)
    const cached = await this.getCachedMessages(sessionId, transcriptPath);
    if (cached) {
      const limited = limit > 0 ? cached.slice(-limit) : cached;
      console.log(`[Perf] Message load (cached) took ${performance.now() - perfStart}ms - returning ${limited.length}/${cached.length} messages`);
      return limited;
    }

    try {
      console.log('[Claude] Loading transcript:', path.basename(transcriptPath));
      const projectDir = path.dirname(transcriptPath);
      const messages = this.parseTranscriptsFromDir(projectDir, sdkSessionId);

      // Cache for next time (performance optimization)
      this.setCachedMessages(sessionId, transcriptPath, messages);

      const limited = limit > 0 ? messages.slice(-limit) : messages;
      console.log(`[Perf] Message load (uncached) took ${performance.now() - perfStart}ms - returning ${limited.length}/${messages.length} messages`);
      return limited;
    } catch (error) {
      console.error('[Claude] Error reading transcripts:', error);
      return [];
    }
  }

  /**
   * Parse transcript content (JSONL string) into ChatMessages
   */
  private parseTranscriptContent(content: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const seenIds = new Set<string>();
    const messageMap = new Map<string, ChatMessage>();
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const result = this.parseTranscriptEntry(entry);
        if (!result) continue;

        // parseTranscriptEntry returns { msg, messageId }
        const { msg, messageId } = result;

        // Check if we already have a message with this Claude message ID
        const existing = messageMap.get(messageId);
        if (existing) {
          // Merge content: only add if the new content is different and non-empty
          if (msg.content && msg.content !== existing.content) {
            if (!existing.content) {
              existing.content = msg.content;
            } else if (msg.content.length > existing.content.length) {
              existing.content = msg.content;
            }
          }
          // Merge tool calls
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            if (!existing.toolCalls) {
              existing.toolCalls = msg.toolCalls;
            } else {
              const existingIds = new Set(existing.toolCalls.map(tc => tc.id));
              for (const tc of msg.toolCalls) {
                if (!existingIds.has(tc.id)) {
                  existing.toolCalls.push(tc);
                }
              }
            }
          }
        } else {
          // New message
          messageMap.set(messageId, msg);
          seenIds.add(msg.id);
          messages.push(msg);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  /**
   * Parse JSONL transcript files from a directory into ChatMessages
   * If sdkSessionId is provided, only load that specific session's transcript
   * Otherwise, load the most recently modified transcript
   */
  private parseTranscriptsFromDir(dir: string, sdkSessionId?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const seenIds = new Set<string>();

    try {
      let targetFile: string | null = null;

      if (sdkSessionId) {
        // Look for the specific session's transcript file
        const sessionFile = `${sdkSessionId}.jsonl`;
        const sessionFilePath = path.join(dir, sessionFile);
        if (fs.existsSync(sessionFilePath)) {
          targetFile = sessionFile;
          console.log('[Claude] Loading specific session transcript:', sessionFile);
        } else {
          console.log('[Claude] Session transcript not found, will use most recent:', sdkSessionId);
        }
      }

      if (!targetFile) {
        // Fall back to most recently modified transcript (not agent files)
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
          .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(dir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.mtime - a.mtime); // Sort by most recent first

        if (files.length > 0) {
          targetFile = files[0].name;
          console.log('[Claude] Loading most recent transcript:', targetFile);
        }
      }

      if (!targetFile) {
        console.log('[Claude] No transcript files found in:', dir);
        return [];
      }

      const filePath = path.join(dir, targetFile);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Map to track messages by their Claude message ID for merging partial messages
      const messageMap = new Map<string, ChatMessage>();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const result = this.parseTranscriptEntry(entry);
          if (!result) continue;

          const { msg, messageId } = result;

          // Check if we already have a message with this Claude message ID
          const existing = messageMap.get(messageId);
          if (existing) {
            // Merge content: only add if the new content is different and non-empty
            if (msg.content && msg.content !== existing.content) {
              // If existing has no content, use new content; otherwise don't duplicate
              if (!existing.content) {
                existing.content = msg.content;
              }
              // Don't concatenate - SDK sends the same message multiple times
              // as it streams, we want the final/fullest version
              else if (msg.content.length > existing.content.length) {
                existing.content = msg.content;
              }
            }
            // Merge tool calls
            if (msg.toolCalls && msg.toolCalls.length > 0) {
              if (!existing.toolCalls) {
                existing.toolCalls = msg.toolCalls;
              } else {
                // Add any new tool calls (by id)
                const existingIds = new Set(existing.toolCalls.map(tc => tc.id));
                for (const tc of msg.toolCalls) {
                  if (!existingIds.has(tc.id)) {
                    existing.toolCalls.push(tc);
                  }
                }
              }
            }
          } else {
            // New message
            messageMap.set(messageId, msg);
            seenIds.add(msg.id);
            messages.push(msg);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      console.error('Error parsing transcripts from dir:', dir, error);
    }

    return messages;
  }

  /**
   * Parse a single transcript entry into a ChatMessage
   * Returns the message ID for deduplication (may differ from the ChatMessage.id)
   */
  private parseTranscriptEntry(entry: Record<string, unknown>): { msg: ChatMessage; messageId: string } | null {
    // SDK transcript format varies - handle different message types
    const type = entry.type as string;

    // Extract the actual Claude message ID for deduplication
    // SDK writes multiple JSONL lines per message (thinking, text, tool_use blocks)
    // entry.uuid is unique per line, but entry.message.id is the actual message ID
    const message = entry.message as Record<string, unknown> | undefined;
    const claudeMessageId = (message?.id as string) || (entry.uuid as string) || (entry.id as string);

    if (type === 'user' || type === 'human') {
      const content = this.extractContent(entry);
      if (!content) return null;

      // Filter out system notifications injected as user messages by the CLI
      // (e.g. <task-notification>, <system-reminder>, compaction summaries).
      // These are internal bookkeeping, not actual user input.
      const trimmed = content.trim();
      if (trimmed.startsWith('<task-notification') ||
          trimmed.startsWith('<system-reminder') ||
          trimmed.startsWith('<command-name>') ||
          trimmed.startsWith('<local-command')) {
        return null;
      }

      return {
        msg: {
          id: (entry.uuid as string) || `user-${Date.now()}-${Math.random()}`,
          role: 'user',
          content,
          timestamp: entry.timestamp ? new Date(entry.timestamp as string) : new Date(),
          harness: 'claude' as const,
        },
        messageId: claudeMessageId,
      };
    }

    if (type === 'assistant') {
      const content = this.extractContent(entry);
      const toolCalls = this.extractToolCalls(entry);
      return {
        msg: {
          id: (entry.uuid as string) || `assistant-${Date.now()}-${Math.random()}`,
          role: 'assistant',
          content: content || '',
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: entry.timestamp ? new Date(entry.timestamp as string) : new Date(),
          harness: 'claude' as const,
        },
        messageId: claudeMessageId,
      };
    }

    return null;
  }

  /**
   * Extract text content from various message formats
   */
  private extractContent(entry: Record<string, unknown>): string {
    // Direct content string
    if (typeof entry.content === 'string') {
      return entry.content;
    }

    // Content array (Claude API format)
    if (Array.isArray(entry.content)) {
      return entry.content
        .filter((block: { type?: string; text?: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text || '')
        .join('\n');
    }

    // Message wrapper
    if (entry.message && typeof entry.message === 'object') {
      return this.extractContent(entry.message as Record<string, unknown>);
    }

    return '';
  }

  /**
   * Extract tool calls from message content
   */
  private extractToolCalls(entry: Record<string, unknown>): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    const content = entry.content || (entry.message as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) return toolCalls;

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
          status: 'completed',
          result: block.result,
          startedAt: new Date(),
          completedAt: new Date(),
        });
      }
    }

    return toolCalls;
  }
}
