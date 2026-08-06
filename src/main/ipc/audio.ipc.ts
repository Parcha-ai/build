import { IpcMain, systemPreferences } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { AudioService } from '../services/audio.service';
import { getMainWindow } from '../index';
import type { TTSRequest } from '../../shared/types/audio';

const audioService = new AudioService();

export function registerAudioHandlers(ipcMain: IpcMain): void {
  // ============================================
  // Speech-to-Text
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_TRANSCRIBE, async (_, audioData: ArrayBuffer, language?: string) => {
    console.log('[Audio IPC] Transcribe called, data size:', audioData?.byteLength, 'language:', language);
    try {
      const buffer = Buffer.from(audioData);
      console.log('[Audio IPC] Buffer created, size:', buffer.length);
      const result = await audioService.transcribeAudio(buffer, language);
      console.log('[Audio IPC] Transcription result:', result);
      return { success: true, result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Audio IPC] Transcription error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  });

  // ============================================
  // Text-to-Speech Streaming
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_TTS_STREAM, async (_, request: TTSRequest) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      return { success: false, error: 'Main window not available' };
    }

    try {
      const stream = audioService.generateTTSStream(request);

      // Stream audio chunks to renderer
      for await (const chunk of stream) {
        mainWindow.webContents.send(IPC_CHANNELS.AUDIO_TTS_CHUNK, {
          messageId: request.messageId,
          chunk: chunk.toJSON().data, // Convert Buffer to array for IPC
        });
      }

      // Send completion event
      mainWindow.webContents.send(IPC_CHANNELS.AUDIO_TTS_COMPLETE, {
        messageId: request.messageId,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      mainWindow.webContents.send(IPC_CHANNELS.AUDIO_TTS_ERROR, {
        messageId: request.messageId,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUDIO_TTS_CANCEL, async (_, messageId: string) => {
    audioService.cancelTTS(messageId);
    return { success: true };
  });

  // ============================================
  // Voice Management
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_GET_VOICES, async () => {
    try {
      const voices = await audioService.getVoices();
      return { success: true, voices };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  });

  // ============================================
  // Settings
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_SETTINGS_GET, async () => {
    return audioService.getAudioSettings();
  });

  ipcMain.handle(IPC_CHANNELS.AUDIO_SETTINGS_SET, async (_, settings) => {
    audioService.setAudioSettings(settings);
    return { success: true };
  });

  // ============================================
  // API Key Management
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_GET_OPENAI_KEY, async () => {
    return audioService.getOpenAiApiKey() || '';
  });

  ipcMain.handle(IPC_CHANNELS.AUDIO_SET_OPENAI_KEY, async (_, key: string) => {
    audioService.setOpenAiApiKey(key);
    return { success: true };
  });

  // ============================================
  // Microphone Permission (macOS)
  // ============================================

  ipcMain.handle(IPC_CHANNELS.AUDIO_CHECK_MICROPHONE_PERMISSION, async () => {
    // On macOS, check the microphone permission status
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log('[Audio IPC] Microphone permission status:', status);
      return {
        status,
        granted: status === 'granted',
        canRequest: status === 'not-determined',
      };
    }
    // On other platforms, assume granted (browser handles it)
    return { status: 'granted', granted: true, canRequest: false };
  });

  ipcMain.handle(IPC_CHANNELS.AUDIO_REQUEST_MICROPHONE_PERMISSION, async () => {
    // On macOS, request microphone access
    if (process.platform === 'darwin') {
      const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
      console.log('[Audio IPC] Current microphone status before request:', currentStatus);

      if (currentStatus === 'granted') {
        return { success: true, granted: true };
      }

      if (currentStatus === 'denied' || currentStatus === 'restricted') {
        // User has denied or system has restricted - they need to go to System Settings
        return {
          success: false,
          granted: false,
          error: 'Microphone access denied. Please enable it in System Settings > Privacy & Security > Microphone.',
        };
      }

      // Status is 'not-determined' - we can request access
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        console.log('[Audio IPC] Microphone permission request result:', granted);
        return { success: true, granted };
      } catch (error) {
        console.error('[Audio IPC] Error requesting microphone permission:', error);
        return {
          success: false,
          granted: false,
          error: error instanceof Error ? error.message : 'Failed to request microphone permission',
        };
      }
    }

    // On other platforms, return success (browser handles permission)
    return { success: true, granted: true };
  });
}
