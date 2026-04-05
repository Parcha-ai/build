import { IpcMain } from 'electron';
import Store from 'electron-store';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { ClaudeService } from '../services/claude.service';
import { getMainWindow } from '../index';
import type { QuestionResponse, Attachment, PlanApprovalResponse, ChatMessage } from '../../shared/types';
import { DEFAULT_AUDIO_SETTINGS } from '../../shared/types/audio';

// Settings store for Ralph Loop check
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

// Ralph Loop completion marker
// Ralph Loop uses Stop hook in claude.service.ts (Anthropic SDK pattern)
// Completion marker checked by the Stop hook
const RALPH_LOOP_COMPLETION_MARKER = '<promise>COMPLETE</promise>';

const claudeService = new ClaudeService();

// Batching helper to reduce IPC overhead
class ChunkBatcher {
  private textBuffer = '';
  private thinkingBuffer = '';
  private textTimer: NodeJS.Timeout | null = null;
  private thinkingTimer: NodeJS.Timeout | null = null;
  private currentAgentId: string | undefined = undefined;
  private readonly BATCH_DELAY = 100; // 10 updates/sec - much smoother for markdown parsing

  constructor(
    private sessionId: string,
    private sendText: (content: string, agentId?: string) => void,
    private sendThinking: (content: string) => void
  ) {}

  addText(content: string, agentId?: string) {
    // If agent changed mid-buffer, flush the old agent's text first
    if (this.textBuffer && this.currentAgentId !== agentId) {
      this.flushText();
    }
    this.currentAgentId = agentId;
    this.textBuffer += content;
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => this.flushText(), this.BATCH_DELAY);
    }
  }

  addThinking(content: string) {
    this.thinkingBuffer += content;
    if (!this.thinkingTimer) {
      this.thinkingTimer = setTimeout(() => this.flushThinking(), this.BATCH_DELAY);
    }
  }

  flushText() {
    if (this.textBuffer) {
      this.sendText(this.textBuffer, this.currentAgentId);
      this.textBuffer = '';
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
    }
  }

  flushThinking() {
    if (this.thinkingBuffer) {
      this.sendThinking(this.thinkingBuffer);
      this.thinkingBuffer = '';
    }
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  flush() {
    this.flushText();
    this.flushThinking();
  }
}

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // NOTE: mainWindow reference is set directly in index.ts after window creation
  // Don't try to set it here as the window doesn't exist yet during IPC registration

  // Handler to get available models
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_MODELS, async () => {
    return claudeService.getAvailableModels();
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_SEND_MESSAGE,
    async (_, sessionId: string, message: string, attachments?: Attachment[], permissionMode?: string, thinkingMode?: string, model?: string, gstackMode?: string, supplementalMessages?: ChatMessage[]) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      // Ensure claudeService has the mainWindow reference for browser updates
      claudeService.setMainWindow(mainWindow);

      console.log('[Claude IPC] sendMessage received with attachments:', attachments?.length || 0, 'model:', model, 'permissionMode:', permissionMode, 'gstackMode:', gstackMode, 'supplementalMessages:', supplementalMessages?.length || 0);
      if (attachments) {
        attachments.forEach((a, i) => {
          console.log(`[Claude IPC] Attachment ${i}: type=${a?.type}, name=${a?.name}, content length=${a?.content?.length || 0}`);
        });
      }

      // Create batcher for this session
      const batcher = new ChunkBatcher(
        sessionId,
        (content, agentId) => mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_CHUNK, { sessionId, content, agentId }),
        (content) => mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_THINKING_CHUNK, { sessionId, content })
      );

      let fullMessageContent = '';
      let hadError = false;
      let sentStreamEnd = false;
      let needsCompactionRetry = false;
      const accumulatedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; status: string; result?: string }> = [];

        try {
          // Stream the response (Stop hook handles Ralph Loop iteration)
          for await (const event of claudeService.streamMessage(sessionId, message, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages)) {
            switch (event.type) {
              case 'text_delta':
                batcher.addText(event.content || '', event.agentId);
                fullMessageContent += event.content || '';
                break;

              case 'thinking_delta':
                batcher.addThinking(event.content || '');
                break;

              case 'tool_use':
                if (event.toolCall) accumulatedToolCalls.push(event.toolCall as typeof accumulatedToolCalls[0]);
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TOOL_CALL, {
                  sessionId,
                  toolCall: event.toolCall,
                  agentId: event.agentId,
                });
                break;

              case 'tool_result':
                // Update the accumulated tool call with result
                if (event.toolCall) {
                  const idx = accumulatedToolCalls.findIndex(tc => tc.id === (event.toolCall as { id: string }).id);
                  if (idx >= 0) {
                    accumulatedToolCalls[idx] = event.toolCall as typeof accumulatedToolCalls[0];
                  } else {
                    accumulatedToolCalls.push(event.toolCall as typeof accumulatedToolCalls[0]);
                  }
                }
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_TOOL_RESULT, {
                  sessionId,
                  toolCall: event.toolCall,
                  agentId: event.agentId,
                });
                break;

              case 'system':
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                  sessionId,
                  systemInfo: event.systemInfo,
                });
                break;

              case 'permission_request':
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_PERMISSION_REQUEST, {
                  ...event,
                  sessionId,
                });
                break;

              case 'context_usage':
                // Forward context usage info to renderer for progress display
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_CONTEXT_USAGE, {
                  sessionId,
                  inputTokens: (event as any).inputTokens,
                  contextWindowSize: (event as any).contextWindowSize,
                  percentage: (event as any).percentage,
                });
                break;

              case 'compaction_status':
                // Forward compaction status to renderer
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_STATUS, event.compactionStatus);
                break;

              case 'compaction_complete':
                // Forward compaction complete to renderer
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_COMPACTION_COMPLETE, event.compactionComplete);

                // If we're waiting to retry after compaction, do it now
                if (needsCompactionRetry) {
                  console.log('[Claude IPC] Compaction complete - auto-retrying message');
                  needsCompactionRetry = false;

                  // Wait a moment for SDK to fully settle
                  await new Promise(resolve => setTimeout(resolve, 1000));

                  // Show retrying message to user
                  mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SYSTEM_INFO, {
                    sessionId,
                    systemInfo: { message: 'Compaction complete - retrying your message...' },
                  });

                  // Retry by starting a new stream with the same message
                  console.log('[Claude IPC] Starting retry stream after compaction');
                  try {
                    for await (const retryEvent of claudeService.streamMessage(sessionId, message, attachments, permissionMode, thinkingMode, model, gstackMode, supplementalMessages)) {
                      // Process retry events the same way
                      switch (retryEvent.type) {
                        case 'text_delta':
                          batcher.addText(retryEvent.content || '', retryEvent.agentId);
                          fullMessageContent += retryEvent.content || '';
                          break;
                        case 'thinking_delta':
                          batcher.addThinking(retryEvent.content || '');
                          break;
                        case 'message_complete':
                          batcher.flush();
                          const retryMessage = retryEvent.message || {
                            id: Date.now().toString(),
                            role: 'assistant' as const,
                            content: fullMessageContent,
                            timestamp: new Date(),
                          };
                          sentStreamEnd = true;
                          mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_END, {
                            sessionId,
                            message: retryMessage,
                          });
                          break;
                        case 'error':
                          batcher.flush();
                          mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                            sessionId,
                            error: retryEvent.error,
                          });
                          break;
                        // Handle other event types as needed
                      }
                    }
                  } catch (retryError) {
                    console.error('[Claude IPC] Retry after compaction failed:', retryError);
                    mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                      sessionId,
                      error: 'Failed to retry after compaction',
                    });
                  }
                  return; // Exit after successful retry
                }
                break;

              case 'message_complete':
                // Flush any remaining batched content
                batcher.flush();
                console.log(`[Claude IPC] message_complete for ${sessionId}. fullMessageContent length: ${fullMessageContent.length}, sentStreamEnd was: ${sentStreamEnd}`);

                // Send STREAM_END (Stop hook handles Ralph Loop iteration)
                const finalMessage = event.message ? {
                  ...event.message,
                  content: event.message.content || fullMessageContent,
                  toolCalls: event.message.toolCalls || (accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined),
                } : {
                  id: Date.now().toString(),
                  role: 'assistant' as const,
                  content: fullMessageContent,
                  timestamp: new Date(),
                  toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                };
                sentStreamEnd = true;
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_END, {
                  sessionId,
                  message: finalMessage,
                });
                break;

              case 'error':
                // Check if this is a compaction error (prompt too long)
                const isCompactionError = event.error?.includes('conversation history is being compacted');

                if (isCompactionError) {
                  console.log('[Claude IPC] Compaction error detected - will auto-retry after compaction');
                  needsCompactionRetry = true;

                  // Show user-friendly compaction message
                  batcher.flush();
                  mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                    sessionId,
                    error: event.error,
                  });

                  // Don't mark as hadError since we'll retry
                  // Continue processing events to catch compaction_complete
                  break;
                }

                // Regular error handling
                batcher.flush();
                mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
                  sessionId,
                  error: event.error,
                });
                hadError = true;
                break;
            }
          }
        } catch (error) {
          // Flush any remaining batched content before error
          batcher.flush();
          mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_ERROR, {
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          hadError = true;
        } finally {
          // Safety net: if the generator exited without sending STREAM_END or STREAM_ERROR
          // (e.g., SSH connection stalled, silent timeout, generator yielded error then returned),
          // send a synthetic STREAM_END so the renderer clears isStreaming.
          // Without this, the UI gets permanently stuck in "thinking..." state.
          if (!hadError && !sentStreamEnd) {
            console.log('[Claude IPC] Safety net: generator exited without STREAM_END or error for', sessionId, 'fullMessageContent:', fullMessageContent.length);
            mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_STREAM_END, {
              sessionId,
              message: {
                id: Date.now().toString(),
                role: 'assistant' as const,
                content: fullMessageContent || '',
                timestamp: new Date(),
                toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
              },
            });
          }
        }

    }
  );

  ipcMain.handle(IPC_CHANNELS.CLAUDE_CANCEL, async (_, sessionId: string) => {
    claudeService.cancelQuery(sessionId);
    // Small delay to ensure the abort signal has propagated through the generator
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_MESSAGES, async (_, sessionId: string, limit?: number) => {
    return claudeService.getMessages(sessionId, limit);
  });

  // Handle permission responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PERMISSION_RESPONSE, async (_, response: { requestId: string; approved: boolean; modifiedInput?: Record<string, unknown>; alwaysApprove?: boolean }) => {
    console.log('[Claude IPC] Permission response received:', response.requestId, 'approved:', response.approved, 'alwaysApprove:', response.alwaysApprove);
    claudeService.handlePermissionResponse(response);
  });

  // Handle question responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_QUESTION_RESPONSE, async (_, response: QuestionResponse) => {
    console.log('[Claude IPC] Question response:', response);
    claudeService.handleQuestionResponse(response);
  });

  // Auto-resume handlers for Grep It mode
  // Save streaming state before app closes (called by renderer)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_SAVE_STATE, async (_, state: {
    sessionId: string;
    wasStreaming: boolean;
    permissionMode: string;
    lastMessage?: string;
  }) => {
    console.log('[Claude IPC] Saving auto-resume state:', state.sessionId, 'wasStreaming:', state.wasStreaming);
    settingsStore.set('autoResumeState', {
      ...state,
      timestamp: Date.now(),
    });
    return { success: true };
  });

  // Get saved auto-resume state (called by renderer on startup)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_GET_STATE, async () => {
    const state = settingsStore.get('autoResumeState') as {
      sessionId: string;
      wasStreaming: boolean;
      permissionMode: string;
      lastMessage?: string;
      timestamp: number;
    } | undefined;

    if (!state) {
      return null;
    }

    // Only return state if it's recent (within last 5 minutes)
    // Older states are likely stale
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    if (state.timestamp < fiveMinutesAgo) {
      console.log('[Claude IPC] Auto-resume state is stale, ignoring');
      settingsStore.delete('autoResumeState');
      return null;
    }

    console.log('[Claude IPC] Retrieved auto-resume state:', state.sessionId);
    return state;
  });

  // Clear auto-resume state (called when session completes normally)
  ipcMain.handle(IPC_CHANNELS.AUTO_RESUME_CLEAR_STATE, async () => {
    console.log('[Claude IPC] Clearing auto-resume state');
    settingsStore.delete('autoResumeState');
    return { success: true };
  });

  // Handle plan approval responses from user
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLAN_APPROVAL_RESPONSE, async (_, response: PlanApprovalResponse) => {
    console.log('[Claude IPC] Plan approval response:', response);
    claudeService.handlePlanApprovalResponse(response);
  });

  // Inject message into active query (for async queue processing)
  ipcMain.handle(IPC_CHANNELS.CLAUDE_INJECT_MESSAGE, async (_, sessionId: string, message: string, attachments?: Attachment[]) => {
    console.log('[Claude IPC] Inject message request for session:', sessionId);
    return claudeService.injectMessage(sessionId, message, attachments);
  });

  // Check if session has an active query
  ipcMain.handle(IPC_CHANNELS.CLAUDE_HAS_ACTIVE_QUERY, async (_, sessionId: string) => {
    return claudeService.hasActiveQuery(sessionId);
  });

  // Update permission mode for an active session (used by GREP IT! button)
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SET_PERMISSION_MODE, async (_, sessionId: string, mode: string) => {
    console.log(`[Claude IPC] Setting permission mode for ${sessionId}: ${mode}`);
    claudeService.setSessionPermissionMode(sessionId, mode);
  });

  // Ephemeral side question (/btw) — direct API call, no history pollution
  ipcMain.handle(IPC_CHANNELS.CLAUDE_BTW_ASK, async (_, sessionId: string, question: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    claudeService.setMainWindow(mainWindow);
    await claudeService.askBtw(sessionId, question);
  });

  // Remote control — spawn `claude remote-control` as a child process
  ipcMain.handle(IPC_CHANNELS.CLAUDE_RC_START, async (_, sessionId: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    claudeService.setMainWindow(mainWindow);
    await claudeService.startRemoteControl(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_RC_STOP, async (_, sessionId: string) => {
    claudeService.stopRemoteControl(sessionId);
  });
}

// Export the claude service instance so it can be updated with mainWindow reference
export { claudeService };
