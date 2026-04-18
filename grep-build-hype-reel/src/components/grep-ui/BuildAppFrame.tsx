// Full Build app frame composite — single component for scene use
// Composes TitleBar, Sidebar, Chat area, right panel, and StatusBar

import React from "react";
import { GrepTitleBar } from "./GrepTitleBar";
import { GrepSidebar } from "./GrepSidebar";
import { GrepChatHeader } from "./GrepChatHeader";
import { GrepInputArea } from "./GrepInputArea";
import { GrepStatusBar } from "./GrepStatusBar";
import { GrepTerminal } from "./GrepTerminal";
import { GrepBrowserPreview } from "./GrepBrowserPreview";
import { GrepGitExplorer } from "./GrepGitExplorer";
import { MessageBubble } from "./MessageBubble";
import type { MockSession, MockMessage } from "../../mocks/mockData";

type RightPanelType = 'terminal' | 'browser' | 'editor' | 'git' | 'none';
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
type EffortLevel = 'low' | 'medium' | 'high' | 'max';

interface StatusBarConfig {
  branch?: string;
  version?: string;
  port?: number;
  sessionStatus?: string;
  dockerAvailable?: boolean;
  showSubagent?: boolean;
  subagentType?: string;
}

interface BuildAppFrameProps {
  // Layout
  sidebarOpen?: boolean;
  sidebarWidth?: number;
  rightPanel?: RightPanelType;

  // Sessions
  sessions?: MockSession[];
  activeSessionId?: string;

  // Chat
  sessionName?: string;
  messages?: MockMessage[];
  isStreaming?: boolean;
  inputText?: string;
  permissionMode?: PermissionMode;
  effortLevel?: EffortLevel;
  modelLabel?: string;

  // Chat header
  forkTabs?: Array<{ id: string; name: string }>;
  activeTabId?: string;

  // Right panel content
  terminalOutput?: string;
  terminalVisibleLines?: number;
  browserUrl?: string;
  browserContent?: React.ReactNode;
  gitBranch?: string;
  gitChanges?: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number }>;
  gitCommitMessage?: string;

  // Title bar
  clockTime?: string;
  isTerminalOpen?: boolean;
  isBrowserOpen?: boolean;

  // Status bar
  statusBar?: StatusBarConfig;

  // Custom content injected between messages and input
  chatFooter?: React.ReactNode;

  // Custom content in the messages area (e.g. monitor blocks, task blocks)
  extraBlocks?: React.ReactNode;

  // Streaming message at the bottom
  streamingMessage?: MockMessage;
}

export function BuildAppFrame({
  sidebarOpen = true,
  sidebarWidth = 260,
  rightPanel = 'none',

  sessions = [],
  activeSessionId = '',

  sessionName = 'Session',
  messages = [],
  isStreaming = false,
  inputText = '',
  permissionMode = 'acceptEdits',
  effortLevel = 'high',
  modelLabel = 'Opus 4.6',

  forkTabs = [],
  activeTabId,

  terminalOutput = '',
  terminalVisibleLines,
  browserUrl = 'http://localhost:3000',
  browserContent,
  gitBranch = 'main',
  gitChanges = [],
  gitCommitMessage,

  clockTime = '14:30:00',
  isTerminalOpen,
  isBrowserOpen,

  statusBar = {},

  chatFooter,
  extraBlocks,
  streamingMessage,
}: BuildAppFrameProps) {
  // Auto-detect title bar panel states from rightPanel prop
  const terminalActive = isTerminalOpen ?? rightPanel === 'terminal';
  const browserActive = isBrowserOpen ?? rightPanel === 'browser';

  return (
    <div
      className="flex flex-col bg-claude-bg font-mono"
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    >
      {/* Title bar */}
      <GrepTitleBar
        isSidebarOpen={sidebarOpen}
        isTerminalOpen={terminalActive}
        isBrowserOpen={browserActive}
        isGitOpen={rightPanel === 'git'}
        isEditorOpen={rightPanel === 'editor'}
        clockTime={clockTime}
      />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        {sidebarOpen && (
          <GrepSidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            width={sidebarWidth}
          />
        )}

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header with fork tabs */}
          <GrepChatHeader
            sessionName={sessionName}
            status="running"
            forkTabs={forkTabs}
            activeTabId={activeTabId}
          />

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={false}
                isOldMessage={i < messages.length - 1}
              />
            ))}

            {/* Extra blocks (monitor, tasks, etc.) */}
            {extraBlocks}

            {/* Currently streaming message */}
            {streamingMessage && (
              <MessageBubble
                message={streamingMessage}
                isStreaming={true}
                isOldMessage={false}
              />
            )}
          </div>

          {/* Optional footer between messages and input */}
          {chatFooter}

          {/* Input area */}
          <GrepInputArea
            inputText={inputText}
            isStreaming={isStreaming}
            permissionMode={permissionMode}
            effortLevel={effortLevel}
            modelLabel={modelLabel}
          />
        </div>

        {/* Right panel */}
        {rightPanel !== 'none' && (
          <div className="flex" style={{ width: 500 }}>
            <div className="w-1 bg-claude-border" style={{ flexShrink: 0 }} />
            <div className="flex-1 flex flex-col min-w-0">
              {rightPanel === 'terminal' && (
                <GrepTerminal
                  output={terminalOutput}
                  visibleLines={terminalVisibleLines}
                />
              )}
              {rightPanel === 'browser' && (
                <GrepBrowserPreview url={browserUrl}>
                  {browserContent}
                </GrepBrowserPreview>
              )}
              {rightPanel === 'git' && (
                <GrepGitExplorer
                  branch={gitBranch}
                  changes={gitChanges}
                  commitMessage={gitCommitMessage}
                />
              )}
              {rightPanel === 'editor' && (
                <div className="flex-1 flex items-center justify-center text-claude-text-secondary text-sm font-mono">
                  {/* Editor placeholder */}
                  <span style={{ letterSpacing: '0.05em' }}>EDITOR</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <GrepStatusBar
        branch={statusBar.branch ?? gitBranch}
        version={statusBar.version ?? '0.3.7'}
        port={statusBar.port ?? 3000}
        sessionStatus={statusBar.sessionStatus ?? 'running'}
        dockerAvailable={statusBar.dockerAvailable ?? true}
        showSubagent={statusBar.showSubagent}
        subagentType={statusBar.subagentType}
      />
    </div>
  );
}
