import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { History, RotateCcw, X, ChevronRight, ChevronDown, Loader2, GitFork } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUIStore } from '../../stores/ui.store';
import type { ChatMessage } from '../../../shared/types';

interface RewindPreview {
  canRewind: boolean;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  error?: string;
}

interface HistoryPanelProps {
  sessionId: string;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

function truncateMessage(content: string, maxLength = 80): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength) + '...';
}

function formatTime(timestamp: Date | string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function HistoryPanel({ sessionId }: HistoryPanelProps) {
  const messages = useSessionStore(useCallback((s) => s.messages[sessionId] || EMPTY_MESSAGES, [sessionId]));
  const isStreaming = useSessionStore(useCallback((s) => s.isStreaming[sessionId] || false, [sessionId]));
  const toggleHistoryPanel = useUIStore((s) => s.toggleHistoryPanel);

  const [previews, setPreviews] = useState<Record<string, RewindPreview | null>>({});
  const [loadingPreviews, setLoadingPreviews] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rewindingId, setRewindingId] = useState<string | null>(null);
  const [fullMessages, setFullMessages] = useState<ChatMessage[] | null>(null);

  // Load full message history. Use limit=-1 as a signal for "all user messages
  // for history display" — the backend fetches the full transcript via `cat`
  // instead of `tail -n 500`, so we get the complete conversation history
  // across days/weeks, not just the most recent chunk.
  useEffect(() => {
    window.electronAPI?.claude?.getMessages?.(sessionId, -1)
      .then((msgs: ChatMessage[]) => {
        if (msgs && msgs.length > 0) setFullMessages(msgs);
      })
      .catch(() => undefined);
  }, [sessionId]);

  // Use full history if available, otherwise fall back to in-memory
  const sourceMessages = fullMessages && fullMessages.length > messages.length ? fullMessages : messages;

  // Filter to user messages only, most recent first
  const userMessages = useMemo(() => {
    return sourceMessages
      .filter((m: ChatMessage) => m.role === 'user' && m.content && m.content.trim().length > 0)
      .reverse();
  }, [sourceMessages]);

  // Try loading file preview only when expanded AND there's an active query
  const loadPreview = useCallback(async (messageId: string) => {
    if (previews[messageId] !== undefined || loadingPreviews[messageId]) return;

    setLoadingPreviews((prev) => ({ ...prev, [messageId]: true }));
    try {
      const result = await window.electronAPI.claude.rewindPreview(sessionId, messageId);
      setPreviews((prev) => ({ ...prev, [messageId]: result }));
    } catch {
      // No active query or checkpointing not available — that's fine,
      // conversation rewind still works without file preview.
      setPreviews((prev) => ({ ...prev, [messageId]: null }));
    } finally {
      setLoadingPreviews((prev) => ({ ...prev, [messageId]: false }));
    }
  }, [sessionId, previews, loadingPreviews]);

  const handleToggleExpand = useCallback((messageId: string) => {
    const next = expandedId === messageId ? null : messageId;
    setExpandedId(next);
    if (next && isStreaming) loadPreview(next);
  }, [expandedId, loadPreview, isStreaming]);

  // Conversation rewind: create a fork at this message point (works always,
  // even without file checkpointing or an active query)
  const handleRewind = useCallback(async (messageId: string) => {
    setRewindingId(messageId);
    try {
      // First try file rewind if an active query exists
      let fileResult: any = null;
      if (isStreaming) {
        try {
          fileResult = await window.electronAPI.claude.rewindExecute(sessionId, messageId);
        } catch {
          // File rewind not available — continue with conversation rewind only
        }
      }

      if (fileResult?.forkedSessionId) {
        useSessionStore.getState().setActiveSession(fileResult.forkedSessionId);
        toggleHistoryPanel();
        return;
      }

      // Fall back to conversation-only rewind (fork at message point)
      const forkedSession = await window.electronAPI.sessions.createFork(
        sessionId,
        messageId, // forkPoint = this message's UUID
      );
      if (forkedSession) {
        useSessionStore.getState().setActiveSession(forkedSession.id);
        toggleHistoryPanel();
      }
    } catch (err: any) {
      console.error('[HistoryPanel] Rewind failed:', err);
    } finally {
      setRewindingId(null);
    }
  }, [sessionId, isStreaming, toggleHistoryPanel]);

  return (
    <div className="flex flex-col h-full bg-claude-bg border-l border-claude-border font-mono">
      {/* Header */}
      <div className="h-10 border-b border-claude-border flex items-center justify-between px-4 bg-claude-surface/50 shrink-0">
        <div className="flex items-center gap-2">
          <History size={14} className="text-claude-text-secondary" />
          <span className="text-xs font-bold text-claude-text uppercase" style={{ letterSpacing: '0.1em' }}>
            HISTORY
          </span>
          <span className="text-[9px] text-claude-text-secondary">
            {userMessages.length} message{userMessages.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={toggleHistoryPanel}
          className="text-claude-text-secondary hover:text-claude-text p-1 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto">
        {userMessages.length === 0 ? (
          <div className="p-4 text-xs text-claude-text-secondary text-center">
            NO MESSAGES YET
          </div>
        ) : (
          <div className="divide-y divide-claude-border/50">
            {userMessages.map((msg: ChatMessage) => {
              const isExpanded = expandedId === msg.id;
              const preview = previews[msg.id];
              const isLoading = loadingPreviews[msg.id];
              const isRewinding = rewindingId === msg.id;
              const hasFilePreview = preview && preview.canRewind && preview.filesChanged.length > 0;

              return (
                <div key={msg.id} className="group">
                  {/* Message row */}
                  <button
                    onClick={() => handleToggleExpand(msg.id)}
                    className="w-full text-left px-4 py-2.5 hover:bg-claude-surface/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        {isExpanded ? (
                          <ChevronDown size={10} className="text-claude-text-secondary mt-1 shrink-0" />
                        ) : (
                          <ChevronRight size={10} className="text-claude-text-secondary mt-1 shrink-0" />
                        )}
                        <span className="text-[11px] text-claude-text break-words leading-relaxed">
                          {truncateMessage(msg.content)}
                        </span>
                      </div>
                      <span className="text-[9px] text-claude-text-secondary shrink-0 tabular-nums mt-0.5">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>

                    {/* Compact file preview (when loaded but not expanded) */}
                    {!isExpanded && hasFilePreview && (
                      <div className="mt-1 ml-4 text-[9px] text-claude-text-secondary">
                        {preview.filesChanged.length} file{preview.filesChanged.length !== 1 ? 's' : ''}{' '}
                        <span className="text-green-500">+{preview.insertions}</span>{' '}
                        <span className="text-red-500">-{preview.deletions}</span>
                      </div>
                    )}
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-3 ml-4">
                      {/* File changes (only if preview available) */}
                      {isLoading && (
                        <div className="flex items-center gap-2 text-[9px] text-claude-text-secondary py-1 mb-2">
                          <Loader2 size={10} className="animate-spin" />
                          CHECKING FILE CHANGES...
                        </div>
                      )}

                      {hasFilePreview && (
                        <div className="mb-2">
                          <div className="text-[9px] text-claude-text-secondary mb-1">
                            {preview.filesChanged.length} file{preview.filesChanged.length !== 1 ? 's' : ''}{' '}
                            <span className="text-green-500">+{preview.insertions}</span>{' '}
                            <span className="text-red-500">-{preview.deletions}</span>
                          </div>
                          <div className="space-y-0.5">
                            {preview.filesChanged.map((file: string) => (
                              <div key={file} className="text-[9px] text-claude-text-secondary truncate pl-2 border-l border-claude-border">
                                {file.split('/').pop() || file}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Rewind button — always available for conversation rewind */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRewind(msg.id);
                        }}
                        disabled={isRewinding}
                        className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 border border-orange-500/30 transition-colors disabled:opacity-50"
                        style={{ letterSpacing: '0.05em' }}
                      >
                        {isRewinding ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <GitFork size={10} />
                        )}
                        {isRewinding ? 'FORKING...' : hasFilePreview ? 'REWIND & FORK' : 'FORK FROM HERE'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
