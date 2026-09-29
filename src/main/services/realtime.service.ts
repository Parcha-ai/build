import WebSocket from 'ws';
import Store from 'electron-store';
import { EventEmitter } from 'events';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';

// OpenAI Realtime API event types
interface RealtimeEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

interface TranscriptionDelta {
  type: 'conversation.item.input_audio_transcription.delta';
  delta: string;
  item_id: string;
}

interface TranscriptionCompleted {
  type: 'conversation.item.input_audio_transcription.completed';
  transcript: string;
  item_id: string;
}

interface SessionCreated {
  type: 'session.created';
  session: {
    id: string;
    model: string;
  };
}

interface ErrorEvent {
  type: 'error';
  error: {
    type: string;
    code: string;
    message: string;
  };
}

type RealtimeServerEvent = TranscriptionDelta | TranscriptionCompleted | SessionCreated | ErrorEvent | RealtimeEvent;

export class RealtimeService extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private isConnected = false;

  constructor() {
    super();
    this.store = new Store({ name: 'claudette-settings' });
  }

  private getOpenAiApiKey(): string | undefined {
    // User-provided key takes precedence over embedded key
    const userKey = this.store.get('openAiApiKey') as string | undefined;
    if (userKey) return userKey;

    // Fallback to embedded key
    return EMBEDDED_KEYS.openAi || undefined;
  }

  async connect(): Promise<void> {
    const apiKey = this.getOpenAiApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    return new Promise((resolve, reject) => {
      try {
        // GA transcription session. The transcription model is configured in
        // session.update and must not be passed as the WebSocket model query.
        const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

        console.log('[RealtimeService] Connecting to:', url);

        this.ws = new WebSocket(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        });

        this.ws.on('open', () => {
          console.log('[RealtimeService] WebSocket connected');
          this.isConnected = true;

          // Configure the session for transcription
          this.sendEvent({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: {
                    type: 'audio/pcm',
                    rate: 24000,
                  },
                  transcription: {
                    model: 'gpt-realtime-whisper',
                    language: 'en',
                    delay: 'low',
                  },
                },
              },
            },
          });

          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const event = JSON.parse(data.toString()) as RealtimeServerEvent;
            this.handleServerEvent(event);
          } catch (e) {
            console.error('[RealtimeService] Failed to parse message:', e);
          }
        });

        this.ws.on('error', (error) => {
          console.error('[RealtimeService] WebSocket error:', error);
          this.emit('error', error.message);
          if (!this.isConnected) {
            reject(error);
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log('[RealtimeService] WebSocket closed:', code, reason.toString());
          this.isConnected = false;
          this.ws = null;

          // NEVER auto-reconnect - user must explicitly click mic button to reconnect
          // Auto-reconnection was causing voice mode to accidentally trigger
          this.emit('disconnected');
        });

      } catch (error) {
        console.error('[RealtimeService] Connection error:', error);
        reject(error);
      }
    });
  }

  private handleServerEvent(event: RealtimeServerEvent): void {
    // Log all events for debugging
    console.log('[RealtimeService] Received event:', event.type, JSON.stringify(event).slice(0, 200));

    switch (event.type) {
      case 'session.created': {
        const sessionEvent = event as SessionCreated;
        this.sessionId = sessionEvent.session.id;
        console.log('[RealtimeService] Session created:', this.sessionId);
        this.emit('session_created', this.sessionId);
        break;
      }

      case 'session.updated':
        console.log('[RealtimeService] Session updated');
        this.emit('session_updated');
        break;

      case 'conversation.item.input_audio_transcription.delta': {
        const deltaEvent = event as TranscriptionDelta;
        console.log('[RealtimeService] Transcription delta:', deltaEvent.delta);
        this.emit('transcription_delta', deltaEvent.delta);
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const completedEvent = event as TranscriptionCompleted;
        console.log('[RealtimeService] Transcription completed:', completedEvent.transcript);
        this.emit('transcription_completed', completedEvent.transcript);
        break;
      }

      case 'input_audio_buffer.speech_started':
        console.log('[RealtimeService] Speech started');
        this.emit('speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[RealtimeService] Speech stopped');
        this.emit('speech_stopped');
        break;

      case 'input_audio_buffer.committed':
        console.log('[RealtimeService] Audio buffer committed');
        break;

      case 'conversation.item.created':
        console.log('[RealtimeService] Conversation item created:', (event as unknown as { item?: { type?: string } }).item?.type);
        break;

      case 'response.created':
        console.log('[RealtimeService] Response created');
        break;

      case 'response.done':
        console.log('[RealtimeService] Response done');
        break;

      case 'error': {
        const errorEvent = event as ErrorEvent;
        console.error('[RealtimeService] Error:', errorEvent.error);
        this.emit('error', errorEvent.error.message);
        break;
      }

      default:
        // Log all other events for debugging
        console.log('[RealtimeService] Other event:', event.type);
    }
  }

  private sendEvent(event: RealtimeEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[RealtimeService] Cannot send event, WebSocket not connected');
      return;
    }

    const eventWithId = {
      ...event,
      event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };

    console.log('[RealtimeService] Sending event:', eventWithId.type);
    this.ws.send(JSON.stringify(eventWithId));
  }

  /**
   * Send audio data to the Realtime API
   * @param audioData PCM16 audio data (Int16Array or Buffer)
   */
  sendAudio(audioData: Buffer | Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[RealtimeService] Cannot send audio, WebSocket not connected');
      return;
    }

    // Convert to base64
    let base64Audio: string;
    if (audioData instanceof Int16Array) {
      base64Audio = Buffer.from(audioData.buffer).toString('base64');
    } else {
      base64Audio = audioData.toString('base64');
    }

    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  /**
   * Commit the audio buffer to trigger transcription
   */
  commitAudio(): void {
    this.sendEvent({
      type: 'input_audio_buffer.commit',
    });
  }

  /**
   * Clear the audio buffer
   */
  clearAudio(): void {
    this.sendEvent({
      type: 'input_audio_buffer.clear',
    });
  }

  /**
   * Disconnect from the Realtime API
   */
  disconnect(): void {
    if (this.ws) {
      console.log('[RealtimeService] Disconnecting...');
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.sessionId = null;
    }
  }

  /**
   * Check if connected
   */
  getIsConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
let realtimeServiceInstance: RealtimeService | null = null;

export function getRealtimeService(): RealtimeService {
  if (!realtimeServiceInstance) {
    realtimeServiceInstance = new RealtimeService();
  }
  return realtimeServiceInstance;
}
