import { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import type {
  RealtimeVoiceRoutingLog,
  RealtimeVoiceSessionRequest,
  VoiceMemoryAppendRequest,
} from '../../shared/types/realtime-voice';
import { getOpenAIRealtimeVoiceService } from '../services/openai-realtime-voice.service';
import { remoteVoiceService } from '../services/remote-voice.service';
import { getVoiceMemoryService } from '../services/voice-memory.service';

export function registerVoiceHandlers(ipcMain: IpcMain): void {
  const voiceService = getOpenAIRealtimeVoiceService();

  ipcMain.handle(
    IPC_CHANNELS.VOICE_CREATE_REALTIME_SESSION,
    async (_, request: RealtimeVoiceSessionRequest) => voiceService.createSession(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_GET_CONFIGURATION,
    async () => voiceService.getConfiguration(),
  );

  ipcMain.on(
    IPC_CHANNELS.VOICE_LOG_ROUTING_EVENT,
    (_, event: RealtimeVoiceRoutingLog) => {
      const eventName = typeof event?.event === 'string' ? event.event.slice(0, 80) : 'unknown';
      const serialized = JSON.stringify(event?.details || {}, (_key, value) => (
        typeof value === 'string' && value.length > 800 ? `${value.slice(0, 800)}…` : value
      )).slice(0, 5_000);
      console.log(`[VoiceRouting] ${eventName} ${serialized}`);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_APPEND_MEMORY,
    async (_, request: VoiceMemoryAppendRequest) => {
      const entry = getVoiceMemoryService().append(request);
      if (entry) void remoteVoiceService.syncVoiceMemory().catch((error) => {
        console.warn('[VoiceMemory] Could not immediately sync memory to Remote Agent:', error);
      });
      return entry;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_GET_MEMORY,
    async () => getVoiceMemoryService().snapshot(),
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_DEPLOY_REMOTE_AGENT,
    async (_, sessionId: string) => remoteVoiceService.deploy(sessionId),
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_GET_REMOTE_AGENT_STATUS,
    async () => remoteVoiceService.getStatus(),
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_STOP_REMOTE_AGENT,
    async () => remoteVoiceService.stop(),
  );
}
