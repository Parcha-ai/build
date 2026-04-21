import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { History, RotateCcw, X, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
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

function truncateMessage(content: string, maxLength = 60): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength) + '...';
}

function formatTime(timestamp: Date): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function HistoryPanel({ sessionId }: HistoryPanelProps) {
  const messages = useSessionStore(useCallback((s) => s.messages[sessionId] || EMPTY_MESSAGES, [sessionId]));
  const toggleHistoryPanel = useUIStore((s) => s.toggleHistoryPanel);

  const [previews, setPreviews] = useState<Record<string, RewindPreview>>({});
  const [loadingPreviews, setLoadingPreviews] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rewindingId, setRewindingId] = useState<string | null>(null);

  // Filter to user messages only
  const userMessages = useMemo(() => {
    return messages
      .filter((m: ChatMessage) => m.role === 'user' && m.content && m.content.trim().length > 0)
      .reverse(); // Most recent first
  }, [messages]);

  // Lazy-load preview when a message is expanded
  const loadPreview = useCallback(async (messageId: string) => {
    if (previews[messageId] || loadingPreviews[messageId]) return;

    setLoadingPreviews((prev) => ({ ...prev, [messageId]: true }));
    try {
      const result = await window.electronAPI.claude.rewindPreview(sessionId, messageId);
      setPreviews((prev) => ({ ...prev, [messageId]: result }));
    } catch (err: any) {
      setPreviews((prev) => ({
        ...prev,
        [messageId]: { canRewind: false, filesChanged: [], insertions: 0, deletions: 0, error: err.message },
      }));
    } finally {
      setLoadingPreviews((prev) => ({ ...prev, [messageId]: false }));
    }
  }, [sessionId, previews, loadingPreviews]);

  const handleToggleExpand = useCallback((messageId: string) => {
    const next = expandedId === messageId ? null : messageId;
    setExpandedId(next);
    if (next) loadPreview(next);
  }, [expandedId, loadPreview]);

  const handleRewind = useCallback(async (messageId: string) => {
    setRewindingId(messageId);
    try {
      const result = await window.electronAPI.claude.rewindExecute(sessionId, messageId);
      if (result.forkedSessionId) {
        // Switch to the forked session
        useSessionStore.getState().setActiveSession(result.forkedSessionId);
        toggleHistoryPanel();
      }
    } catch (err: any) {
      console.error('[HistoryPanel] Rewind failed:', err);
    } finally {
      setRewindingId(null);
    }
  }, [sessionId, toggleHistoryPanel]);

  return (
    <div className="flex flex-col h-full bg-claude-bg border-l border-claude-border font-mono">
      {/* Header */}
      <div className="h-10 border-b border-claude-border flex items-center justify-between px-4 bg-claude-surface/50 shrink-0">
        <div className="flex items-center gap-2">
          <History size={14} className="text-claude-text-secondary" />
          <span className="text-xs font-bold text-claude-text uppercase" style={{ letterSpacing: '0.1em' }}>
            HISTORY
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

              return (
                <div key={msg.id} className="group">
                  {/* Message row */}
                  <button
                    onClick={() => handleToggleExpand(msg.id)}
                    className="w-full text-left px-4 py-3 hover:bg-claude-surface/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        {isExpanded ? (
                          <ChevronDown size={12} className="text-claude-text-secondary mt-0.5 shrink-0" />
                        ) : (
                          <ChevronRight size={12} className="text-claude-text-secondary mt-0.5 shrink-0" />
                        )}
                        <span className="text-xs text-claude-text break-words leading-relaxed">
                          {truncateMessage(msg.content)}
                        </span>
                      </div>
                      <span className="text-[10px] text-claude-text-secondary shrink-0 tabular-nums mt-0.5">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>

                    {/* Compact preview summary (when preview is loaded but not expanded) */}
                    {!isExpanded && preview && preview.canRewind && preview.filesChanged.length > 0 && (
                      <div className="mt-1 ml-5 text-[10px] text-claude-text-secondary">
                        {preview.filesChanged.length} file{preview.filesChanged.length !== 1 ? 's' : ''} changed{' '}
                        <span className="text-green-500">+{preview.insertions}</span>{' '}
                        <span className="text-red-500">-{preview.deletions}</span>
                      </div>
                    )}
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-3 ml-5">
                      {isLoading ? (
                        <div className="flex items-center gap-2 text-[10px] text-claude-text-secondary py-1">
                          <Loader2 size={10} className="animate-spin" />
                          LOADING PREVIEW...
                        </div>
                      ) : preview ? (
                        <div>
                          {preview.error ? (
                            <div className="text-[10px] text-red-400 py-1">
                              {preview.error}
                            </div>
                          ) : preview.canRewind ? (
                            <>
                              <div className="text-[10px] text-claude-text-secondary mb-2">
                                {preview.filesChanged.length} file{preview.filesChanged.length !== 1 ? 's' : ''} changed{' '}
                                <span className="text-green-500">+{preview.insertions}</span>{' '}
                                <span className="text-red-500">-{preview.deletions}</span>
                              </div>

                              {/* File list */}
                              {preview.filesChanged.length > 0 && (
                                <div className="mb-2 space-y-0.5">
                                  {preview.filesChanged.map((file: string) => (
                                    <div key={file} className="text-[10px] text-claude-text-secondary truncate pl-2 border-l border-claude-border">
                                      {file.split('/').pop() || file}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Rewind button */}
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
                                  <RotateCcw size={10} />
                                )}
                                {isRewinding ? 'REWINDING...' : 'REWIND'}
                              </button>
                            </>
                          ) : (
                            <div className="text-[10px] text-claude-text-secondary py-1">
                              NO FILE CHANGES AT THIS POINT
                            </div>
                          )}
                        </div>
                      ) : null}
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
