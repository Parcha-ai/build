import { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { getElevenLabsVoiceService, VoiceSessionConfig } from '../services/elevenlabs-voice.service';
import { getMainWindow } from '../index';

export function registerVoiceHandlers(ipcMain: IpcMain): void {
  console.log('[Voice IPC] Registering voice handlers...');
  const voiceService = getElevenLabsVoiceService();

  // Remove any existing listeners to prevent duplicates (important for hot reload)
  voiceService.removeAllListeners();

  // Set up event listeners to relay to renderer
  voiceService.on('connected', () => {
    console.log('[Voice IPC] Relaying connected event');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_CONNECTED);
    }
  });

  voiceService.on('disconnected', () => {
    console.log('[Voice IPC] Relaying disconnected event');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_DISCONNECTED);
    }
  });

  voiceService.on('reconnecting', (data: { attempt: number; maxAttempts: number }) => {
    console.log('[Voice IPC] Relaying reconnecting event');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_RECONNECTING, data);
    }
  });

  voiceService.on('user_transcript', (data: { text: string; isFinal: boolean }) => {
    console.log('[Voice IPC] Relaying user transcript:', data.text?.slice(0, 50) || '(empty)', 'final:', data.isFinal);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_USER_TRANSCRIPT, data);
    }
  });

  voiceService.on('agent_response', (text: string) => {
    console.log('[Voice IPC] Relaying agent response:', text?.slice(0, 50) || '(empty)');
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_AGENT_RESPONSE, text);
    }
  });

  voiceService.on('audio', (data: { data: Buffer; eventId: number }) => {
    // Convert Buffer to number array for IPC transfer
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_AUDIO_CHUNK, {
        data: Array.from(data.data),
        eventId: data.eventId,
      });
    }
  });

  voiceService.on('interruption', (reason: string) => {
    console.log('[Voice IPC] Relaying interruption:', reason);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_INTERRUPTION, reason);
    }
  });

  voiceService.on('error', (error: string) => {
    console.error('[Voice IPC] Relaying error:', error);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_ERROR, error);
    }
  });

  voiceService.on('client_tool_call', (data: { toolCallId: string; toolName: string; parameters: Record<string, unknown> }) => {
    console.log('[Voice IPC] Relaying tool call:', data.toolName, data.parameters);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_TOOL_CALL, data);
    }
  });

  // IPC Handlers
  ipcMain.handle(IPC_CHANNELS.VOICE_CONNECT, async (_, config: VoiceSessionConfig) => {
    try {
      console.log('[Voice IPC] Connect requested with agent:', config.agentId);
      await voiceService.connect(config);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Connect error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_DISCONNECT, async () => {
    try {
      console.log('[Voice IPC] Disconnect requested');
      voiceService.disconnect();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Disconnect error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_SEND_AUDIO, async (_, audioData: number[]) => {
    try {
      // Convert Int16 number array back to Buffer (PCM16 format)
      // The audioData contains Int16 values (-32768 to 32767) from the renderer
      const int16Array = new Int16Array(audioData);
      const buffer = Buffer.from(int16Array.buffer);
      voiceService.sendAudio(buffer);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Send audio error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_SEND_TEXT, async (_, text: string) => {
    try {
      console.log('[Voice IPC] Send text for TTS:', text.slice(0, 50));
      voiceService.sendTextForTTS(text);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Send text error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_END_INPUT, async () => {
    try {
      voiceService.endUserInput();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_CLEAR_AUDIO_BUFFER, async () => {
    try {
      voiceService.clearAudioBuffer();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_CONTEXT_UPDATE, async (_, context: string) => {
    try {
      voiceService.sendContextUpdate(context);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Context update error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_TOOL_RESULT, async (_, data: { toolCallId: string; result: string; isError?: boolean }) => {
    try {
      console.log('[Voice IPC] Sending tool result:', data.toolCallId, data.result?.slice(0, 100) || '(empty)');
      voiceService.sendToolResult(data.toolCallId, data.result, data.isError ?? false);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Send tool result error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  // Update agent prompt via ElevenLabs API
  ipcMain.handle(IPC_CHANNELS.VOICE_UPDATE_AGENT_PROMPT, async (_, data: { agentId: string; prompt: string }) => {
    try {
      console.log('[Voice IPC] Updating agent prompt for:', data.agentId);
      await voiceService.updateAgentPrompt(data.agentId, data.prompt);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Update agent prompt error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  // Send user activity signal to prevent timeout prompts
  ipcMain.handle(IPC_CHANNELS.VOICE_USER_ACTIVITY, async () => {
    try {
      voiceService.sendUserActivity();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  });

  // Get signed URL for SDK-based WebSocket connection
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_SIGNED_URL, async (_, config: { agentId: string }) => {
    try {
      console.log('[Voice IPC] Getting signed URL for agent:', config.agentId);
      const signedUrl = await voiceService.getSignedUrlForAgent(config.agentId);
      return { success: true, signedUrl };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Get signed URL error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  // Get conversation token for SDK-based WebRTC connection (better echo cancellation)
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_CONVERSATION_TOKEN, async (_, config: { agentId: string }) => {
    try {
      console.log('[Voice IPC] Getting conversation token for agent:', config.agentId);
      const conversationToken = await voiceService.getConversationToken(config.agentId);
      return { success: true, conversationToken };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Voice IPC] Get conversation token error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });
}
