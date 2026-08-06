import Store from 'electron-store';
import OpenAI from 'openai';
import {
  DEFAULT_AUDIO_SETTINGS,
  OPENAI_TTS_MODEL,
  OPENAI_VOICES,
  REALTIME_VOICE_OPTIONS,
  type AudioSettings,
  type RealtimeVoiceOption,
  type TranscriptionResult,
  type TTSRequest,
} from '../../shared/types/audio';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';

const OPENAI_TTS_VOICES = [
  ...OPENAI_VOICES,
  'fable',
  'nova',
  'onyx',
] as const;

export class AudioService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private openaiClient: OpenAI | null = null;
  private activeStreams = new Map<string, AbortController>();

  constructor() {
    this.store = new Store({ name: 'claudette-settings' });
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.getOpenAiApiKey();
    this.openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
  }

  private normalizeSettings(stored: Partial<AudioSettings> | undefined): AudioSettings {
    const requestedRealtimeVoice = stored?.realtimeVoice;
    const realtimeVoice: RealtimeVoiceOption = REALTIME_VOICE_OPTIONS.includes(requestedRealtimeVoice as RealtimeVoiceOption)
      ? requestedRealtimeVoice as RealtimeVoiceOption
      : 'marin';
    const providerRealtimeVoice = realtimeVoice === 'M' ? 'marin' : realtimeVoice;
    const requestedTTSVoice = stored?.voiceSettings?.voiceId || stored?.selectedVoice;
    const ttsVoice = OPENAI_TTS_VOICES.includes(requestedTTSVoice as typeof OPENAI_TTS_VOICES[number])
      ? requestedTTSVoice as string
      : providerRealtimeVoice;
    const effort = stored?.realtimeReasoningEffort;

    return {
      ...DEFAULT_AUDIO_SETTINGS,
      ...stored,
      selectedVoice: ttsVoice,
      voiceSettings: { voiceId: ttsVoice },
      realtimeVoice,
      realtimeReasoningEffort: effort === 'medium' || effort === 'high' ? effort : 'low',
    };
  }

  getAudioSettings(): AudioSettings {
    return this.normalizeSettings(this.store.get('audioSettings') as Partial<AudioSettings> | undefined);
  }

  setAudioSettings(updates: Partial<AudioSettings>): void {
    this.store.set('audioSettings', this.normalizeSettings({ ...this.getAudioSettings(), ...updates }));
  }

  getOpenAiApiKey(): string | undefined {
    const userKey = this.store.get('openAiApiKey') as string | undefined;
    return userKey?.trim() || EMBEDDED_KEYS.openAi || undefined;
  }

  setOpenAiApiKey(key: string): void {
    this.store.set('openAiApiKey', key.trim());
    this.initializeClient();
  }

  private getOpenAIClient(): OpenAI {
    if (!this.openaiClient) this.initializeClient();
    if (!this.openaiClient) {
      throw new Error('OpenAI API key not configured. Add it in Settings > API Keys.');
    }
    return this.openaiClient;
  }

  async transcribeAudio(audioData: Buffer, language?: string): Promise<TranscriptionResult> {
    const client = this.getOpenAIClient();
    try {
      const audioBlob = new Blob([audioData], { type: 'audio/webm' });
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
      const response = await client.audio.transcriptions.create({
        file: audioFile,
        model: 'gpt-4o-mini-transcribe',
        language: language || 'en',
        response_format: 'json',
      });
      return { text: response.text, partial: false };
    } catch (error) {
      throw new Error(`Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async *generateTTSStream(request: TTSRequest): AsyncGenerator<Buffer> {
    const apiKey = this.getOpenAiApiKey();
    if (!apiKey) throw new Error('OpenAI API key not configured. Add it in Settings > API Keys.');

    const controller = new AbortController();
    this.activeStreams.set(request.messageId, controller);
    const requestedVoice = request.voiceId || this.getAudioSettings().selectedVoice;
    const voice = OPENAI_TTS_VOICES.includes(requestedVoice as typeof OPENAI_TTS_VOICES[number])
      ? requestedVoice
      : 'marin';

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OPENAI_TTS_MODEL,
          voice,
          input: request.text,
          instructions: 'Speak clearly and naturally in a concise, helpful tone.',
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let detail = '';
        try {
          const payload = await response.json() as { error?: { message?: string } };
          detail = payload.error?.message || '';
        } catch {
          detail = '';
        }
        throw new Error(detail || `OpenAI speech request failed (${response.status}).`);
      }

      const reader = response.body.getReader();
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) yield Buffer.from(value);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`TTS generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.activeStreams.delete(request.messageId);
    }
  }

  cancelTTS(messageId: string): void {
    this.activeStreams.get(messageId)?.abort();
    this.activeStreams.delete(messageId);
  }

  async getVoices(): Promise<Array<{ voice_id: string; name: string }>> {
    return OPENAI_TTS_VOICES.map((voice) => ({
      voice_id: voice,
      name: voice[0].toUpperCase() + voice.slice(1),
    }));
  }
}
