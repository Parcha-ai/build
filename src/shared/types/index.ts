// Core Types for Grep

// SSH configuration for remote execution
export interface SSHConfig {
  host: string;
  port: number;           // Default: 22
  username: string;
  privateKeyPath: string; // Path to local private key
  remoteWorkdir: string;  // Working directory on remote machine
  passphrase?: string;    // Encrypted passphrase for private key
  worktreeScript?: string; // Optional script to run on remote to set up worktree
  syncSettings?: boolean;  // If true, sync ~/.claude settings to remote before starting
}

// Saved SSH config (persisted to electron-store, no passphrase)
export interface SavedSSHConfig {
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
  remoteWorkdir: string;
  sessionName: string;
  worktreeScript: string;
  syncSettings: boolean;
}

export interface Session {
  id: string;
  name: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  containerId?: string;
  sshConfig?: SSHConfig;  // Present if this is an SSH remote session
  status: SessionStatus;
  ports: PortAllocation;
  createdAt: Date;
  updatedAt: Date;
  setupScript: string;
  isDevMode?: boolean; // True for local dev sessions (no Docker)
  isTeleported?: boolean; // True for sessions imported from claude.ai/code
  lastBrowserUrl?: string; // Last URL visited in browser preview
  model?: string; // Selected Claude model for this session
  worktreeInstructions?: string; // Setup instructions to send to Claude when session starts
  worktreeInstructionsSent?: boolean; // Track if instructions have been sent
  errorMessage?: string; // Error message when status is 'error'
  setupOutput?: string; // Output from worktree setup script (for SSH sessions)
  // Fork/worktree relationship
  isWorktree?: boolean; // True if this is a worktree fork of another repo
  parentRepoPath?: string; // Path to the parent repo this was forked from
  forkName?: string; // Silly memorable name for this fork (e.g., "fuzzy-tiger")
  // Teleportation tracking
  teleportedFrom?: string; // Original local session ID if teleported to SSH
  downloadedFrom?: string; // Session ID of source SSH session (reverse teleport)
  sdkSessionId?: string; // Claude Agent SDK session ID for transcript resumption
  // Starring/favorites
  isStarred?: boolean; // True if session is starred
  starredAt?: Date; // When it was starred (for stable ordering)
  // Computer Use API iteration tracking (per-session counter for Stop hook)
  computerUseIterations?: number; // Current iteration count (for Stop hook)
  // Conversation fork relationships (separate from git worktree forks)
  parentSessionId?: string; // ID of parent session (null for root conversation)
  childSessionIds?: string[]; // Array of child fork session IDs
  forkPoint?: string; // Message ID where this fork was created from parent
  aiGeneratedName?: string; // AI-generated short name (2-3 words) for fork tabs
  isRoot?: boolean; // True for original conversation (no parent)
  forkCreatedAt?: Date; // When this conversation fork was created
  gstackMode?: GStackMode; // Active GStack workflow mode
}

export type GStackMode = 'plan-ceo' | 'plan-eng' | 'design' | 'review' | 'ship' | 'qa' | 'browse' | 'retro' | 'office-hours' | 'investigate' | 'careful' | 'freeze' | 'guard' | 'document-release' | 'autoplan' | 'cso' | 'sdd';

export const GSTACK_MODE_META: Record<GStackMode, { color: string; shortName: string }> = {
  'plan-ceo': { color: '#f59e0b', shortName: 'CEO' },
  'plan-eng': { color: '#3b82f6', shortName: 'ENG' },
  'design':   { color: '#ec4899', shortName: 'DES' },
  'review':   { color: '#ef4444', shortName: 'REV' },
  'ship':     { color: '#22c55e', shortName: 'SHIP' },
  'qa':       { color: '#a855f7', shortName: 'QA' },
  'browse':   { color: '#06b6d4', shortName: 'BRW' },
  'retro':    { color: '#f97316', shortName: 'RET' },
  'office-hours': { color: '#10b981', shortName: 'OH' },
  'investigate':  { color: '#8b5cf6', shortName: 'INV' },
  'careful':      { color: '#dc2626', shortName: 'CFL' },
  'freeze':       { color: '#64748b', shortName: 'FRZ' },
  'guard':        { color: '#b91c1c', shortName: 'GRD' },
  'document-release': { color: '#0ea5e9', shortName: 'DOC' },
  'autoplan':         { color: '#7c3aed', shortName: 'APL' },
  'cso':              { color: '#991b1b', shortName: 'CSO' },
  'sdd':              { color: '#0d9488', shortName: 'SDD' },
};

export type SessionStatus = 'creating' | 'starting' | 'setup' | 'running' | 'stopping' | 'stopped' | 'error';

// Setup progress event for worktree initialization
export interface SetupProgressEvent {
  sessionId: string;
  status: 'running' | 'completed' | 'error';
  message?: string;
  output?: string;
  error?: string;
}

export interface PortAllocation {
  web: number;
  api: number;
  debug: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  updatedAt: string;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: Date;
  parents: string[];
}

export interface Branch {
  name: string;
  current: boolean;
  remote?: string;
  commit: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  agentId?: string; // null/undefined = lead agent, string = teammate (parent_tool_use_id from SDK)
}

// Agent colour palette for teammate identification
export const AGENT_COLORS = [
  '#3B82F6', // blue
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#F59E0B', // amber
  '#10B981', // emerald
  '#06B6D4', // cyan
  '#F97316', // orange
  '#6366F1', // indigo
] as const;

export interface AgentInfo {
  id: string;        // parent_tool_use_id from SDK
  name?: string;     // Agent name if available (e.g., "bond", "explore")
  color: string;     // Assigned colour from AGENT_COLORS palette
}

// Content block for interleaved rendering of text and tool calls
export interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string; // For text blocks
  toolCallId?: string; // For tool_use blocks - reference to toolCalls array
  agentId?: string; // Which agent produced this block (null = lead agent)
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string; // Combined text content (for backwards compat and search)
  contentBlocks?: ContentBlock[]; // Ordered blocks for interleaved rendering
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  timestamp: Date;
  interrupted?: boolean; // True if message was interrupted before completion
}

export interface Attachment {
  type: 'file' | 'image' | 'dom_element';
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DOMElementContext {
  tagName: string;
  id?: string;
  className?: string;
  selector: string;
  innerHTML: string;
  outerHTML: string;
  textContent?: string;
  attributes: { name: string; value: string }[];
  computedStyles: Record<string, string>;
  boundingRect: DOMRect;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  fontFamily: string;
  anthropicApiKey?: string;
  githubToken?: string;
  defaultSetupScript: string;
  autoStartContainer: boolean;
  // QMD semantic search settings
  qmdEnabled: boolean; // Global toggle for QMD semantic search
  // Ultra Plan mode - automatic task decomposition after plan approval
  ultraPlanMode: boolean; // Global toggle for Ultra Plan mode
  // Lunch reminder settings
  lunchReminderEnabled: boolean; // Enable/disable lunch reminders
  lunchReminderTime?: string; // Time in HH:MM format (only used if enabled)
  // Foundry settings (Azure-hosted Claude)
  foundryEnabled?: boolean;
  foundryBaseUrl?: string;
  foundryApiKey?: string;
  foundryDefaultSonnetModel?: string;
  foundryDefaultHaikuModel?: string;
  foundryDefaultOpusModel?: string;
  onboardingSkipped?: boolean;
}

// Permission request from Agent SDK
export interface PermissionRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  message?: string;
}

// Permission response to Agent SDK
export interface PermissionResponse {
  requestId: string;
  approved: boolean;
  modifiedInput?: Record<string, unknown>;
  alwaysApprove?: boolean; // If true, save permission pattern to project settings
}

// Question types for AskUserQuestion tool
export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionRequest {
  sessionId: string;
  requestId: string;
  questions: Question[];
}

export interface QuestionResponse {
  requestId: string;
  answers: Record<string, string>;
}

// Extension types (commands, skills, agents)
export interface Command {
  name: string;
  path: string;
  content: string;
  description?: string;
  scope: 'user' | 'project';
}

export interface Skill {
  name: string;
  path: string;
  content: string;
  description?: string;
  scope: 'user' | 'project';
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  disallowedTools?: string[];
  model?: string;
  scope: 'user' | 'project';
}

// Browser snapshot types
export interface BrowserSnapshot {
  url: string;
  screenshot: string;
  html: string;
  timestamp: Date;
}

// Smart Compact types - context compaction with automatic model switching
export interface CompactionStatus {
  sessionId: string;
  isCompacting: boolean;
  smartCompact?: {
    enabled: boolean;
    originalModel: string;
    compactingModel: string;
    reason: string; // e.g., "Model does not support extended context"
  };
  preTokens?: number;
  trigger?: 'manual' | 'auto';
}

export interface CompactionComplete {
  sessionId: string;
  preTokens: number;
  postTokens?: number;
  smartCompact?: {
    modelSwitched: boolean;
    restoredModel: string;
  };
}

// Plan approval types - for ExitPlanMode tool
export interface PlanApprovalRequest {
  sessionId: string;
  requestId: string;
  planContent: string;
  planFilePath?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

export interface PlanApprovalResponse {
  requestId: string;
  approved: boolean;
  feedback?: string; // Optional feedback message when rejecting
}

// MCP Server types for display and management
export interface MCPServerTool {
  name: string;
  description: string;
}

export interface MCPServerInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  status: 'active' | 'inactive' | 'error';
  type: 'sdk' | 'stdio' | 'http';
  tools: MCPServerTool[];
  errorMessage?: string;
  projectEnabled?: boolean;
}

// Marketplace types for browsing and installing MCP servers (from MCP Registry)
export interface MCPRegistryAuthField {
  key: string;
  label: string;
  secret: boolean;
}

export interface MCPRegistryPackage {
  registry_name: string; // 'npm' or 'docker'
  name: string;
  version?: string;
  runtime?: string;
  transport?: Array<{ type: string }>;
  environment_variables?: Array<{
    name: string;
    description?: string;
    required?: boolean;
    isSecret?: boolean;
  }>;
}

export interface MCPRegistryRemote {
  transport_type: string; // 'streamable-http', 'sse', etc.
  url: string;
  headers?: Array<{
    name: string;
    required?: boolean;
    isSecret?: boolean;
  }>;
}

export interface MarketplaceMCPServer {
  // Core identifiers
  id: string; // e.g., "ai.exa/exa"
  name: string; // Display name (from title or derived from id)
  description: string;
  version: string;

  // Source info
  repositoryUrl?: string;
  websiteUrl?: string;
  license?: string;

  // Installation methods
  packages?: MCPRegistryPackage[];
  remotes?: MCPRegistryRemote[];

  // Auth configuration (extracted from packages/remotes)
  authFields: MCPRegistryAuthField[];
  requiresAuth: boolean;

  // Display metadata
  icon?: string;
  keywords?: string[];
  isLatest?: boolean;
  publishedAt?: string;
}

// Plugin marketplace types
export interface PopularMarketplace {
  name: string;
  repo: string;
  description: string;
  official: boolean;
}

export interface PluginMarketplace {
  name: string;
  source: {
    source: 'github' | 'git' | 'local';
    repo?: string; // For github source
    url?: string; // For git source
    path?: string; // For local source
  };
  installLocation: string;
  lastUpdated?: string;
}

export interface InstalledPlugin {
  id: string; // e.g., "code-review@claude-plugins-official"
  name: string;
  version: string;
  scope: 'user' | 'project';
  enabled: boolean;
  marketplace: string;
}

export interface MarketplacePlugin {
  id: string; // Plugin name (e.g., "code-review")
  name: string; // Display name
  description: string;
  marketplace: string; // Marketplace name (e.g., "claude-plugins-official")
  marketplaceRepo?: string; // GitHub repo (e.g., "anthropics/claude-plugins-official")

  // Content types
  hasCommands?: boolean;
  hasSkills?: boolean;
  hasAgents?: boolean;
  hasHooks?: boolean;
  hasMcpServers?: boolean;

  // Status
  installed?: boolean;
  enabled?: boolean;
  installedVersion?: string;
}

// Download session config (reverse teleport: SSH -> local)
export interface DownloadSessionConfig {
  localRepoPath: string;      // Path to local git repo
  sessionName: string;         // Name for new local session
  branch?: string;             // Optional: specific branch to checkout
}

// Export audio types
export * from './audio';
