import Store from 'electron-store';
import { Readable } from 'stream';
import type { AudioSettings, TranscriptionResult, TTSRequest } from '../../shared/types/audio';
import { DEFAULT_AUDIO_SETTINGS } from '../../shared/types/audio';
import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';

export class AudioService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;
  private openaiClient: OpenAI | null = null;
  private elevenLabsClient: ElevenLabsClient | null = null;
  private activeStreams: Map<string, AbortController> = new Map();

  constructor() {
    this.store = new Store({ name: 'claudette-settings' });
    this.initializeClients();
  }

  private initializeClients(): void {
    // Initialize OpenAI client for Whisper
    const openAiKey = this.getOpenAiApiKey();
    if (openAiKey) {
      this.openaiClient = new OpenAI({ apiKey: openAiKey });
    }

    // Initialize ElevenLabs client for TTS
    const elevenLabsKey = this.getElevenLabsApiKey();
    if (elevenLabsKey) {
      this.elevenLabsClient = new ElevenLabsClient({ apiKey: elevenLabsKey });
    }
  }

  // ============================================
  // Settings Management
  // ============================================

  getAudioSettings(): AudioSettings {
    return this.store.get('audioSettings', DEFAULT_AUDIO_SETTINGS) as AudioSettings;
  }

  setAudioSettings(updates: Partial<AudioSettings>): void {
    const current = this.getAudioSettings();
    const updated = { ...current, ...updates };
    this.store.set('audioSettings', updated);

    // Reinitialize clients if API keys changed
    if (updates.elevenLabsApiKey !== undefined || updates.openAiApiKey !== undefined) {
      this.initializeClients();
    }
  }

  getElevenLabsApiKey(): string | undefined {
    const userKey = this.store.get('elevenLabsApiKey') as string | undefined;
    if (userKey) return userKey;
    return EMBEDDED_KEYS.elevenLabs || undefined;
  }

  setElevenLabsApiKey(key: string): void {
    this.store.set('elevenLabsApiKey', key);
    this.elevenLabsClient = new ElevenLabsClient({ apiKey: key });
  }

  getOpenAiApiKey(): string | undefined {
    // User-provided key takes precedence over embedded key
    const userKey = this.store.get('openAiApiKey') as string | undefined;
    if (userKey) return userKey;

    // Fallback to embedded key
    return EMBEDDED_KEYS.openAi || undefined;
  }

  setOpenAiApiKey(key: string): void {
    this.store.set('openAiApiKey', key);
    this.openaiClient = new OpenAI({ apiKey: key });
  }

  // ============================================
  // Speech-to-Text (Whisper)
  // ============================================

  async transcribeAudio(audioData: Buffer, language?: string): Promise<TranscriptionResult> {
    console.log('[AudioService] transcribeAudio called, data size:', audioData.length, 'language:', language);

    if (!this.openaiClient) {
      const key = this.getOpenAiApiKey();
      console.log('[AudioService] OpenAI key configured:', !!key);
      if (!key) {
        throw new Error('OpenAI API key not configured. Please add your API key in Settings.');
      }
      this.openaiClient = new OpenAI({ apiKey: key });
    }

    try {
      // Create a File-like object for the API
      // The Whisper API expects a file, so we need to create a proper Blob
      const audioBlob = new Blob([audioData], { type: 'audio/webm' });
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
      console.log('[AudioService] Created audio file, size:', audioFile.size);

      console.log('[AudioService] Calling OpenAI Whisper API...');
      const response = await this.openaiClient.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: language || 'en',
        response_format: 'json',
      });

      console.log('[AudioService] Whisper response:', response.text);
      return {
        text: response.text,
        partial: false,
      };
    } catch (error) {
      console.error('[AudioService] Transcription error:', error);
      if (error instanceof Error) {
        throw new Error(`Transcription failed: ${error.message}`);
      }
      throw new Error('Transcription failed: Unknown error');
    }
  }

  // ============================================
  // Text-to-Speech (ElevenLabs)
  // ============================================

  async *generateTTSStream(request: TTSRequest): AsyncGenerator<Buffer> {
    if (!this.elevenLabsClient) {
      const key = this.getElevenLabsApiKey();
      if (!key) {
        throw new Error('ElevenLabs API key not configured. Please add your API key in Settings.');
      }
      this.elevenLabsClient = new ElevenLabsClient({ apiKey: key });
    }

    // Create abort controller for this stream
    const abortController = new AbortController();
    this.activeStreams.set(request.messageId, abortController);

    try {
      const audioSettings = this.getAudioSettings();

      // Generate TTS using ElevenLabs streaming API
      const audioStream = await this.elevenLabsClient.textToSpeech.convertAsStream(
        request.voiceId || audioSettings.selectedVoice,
        {
          text: request.text,
          model_id: request.modelId || 'eleven_turbo_v2_5',
          voice_settings: {
            stability: audioSettings.voiceSettings.stability,
            similarity_boost: audioSettings.voiceSettings.similarityBoost,
            style: audioSettings.voiceSettings.style,
            use_speaker_boost: audioSettings.voiceSettings.useSpeakerBoost,
          },
        }
      );

      // Convert the async iterable to yield buffers
      for await (const chunk of audioStream) {
        // Check if cancelled
        if (abortController.signal.aborted) {
          break;
        }

        // Convert chunk to Buffer if needed
        if (chunk instanceof Buffer) {
          yield chunk;
        } else if (chunk instanceof Uint8Array) {
          yield Buffer.from(chunk);
        } else if (typeof chunk === 'string') {
          yield Buffer.from(chunk, 'binary');
        } else {
          // For any other type, try to convert
          yield Buffer.from(chunk as ArrayBuffer);
        }
      }
    } catch (error) {
      console.error('TTS generation error:', error);
      if (error instanceof Error) {
        throw new Error(`TTS generation failed: ${error.message}`);
      }
      throw new Error('TTS generation failed: Unknown error');
    } finally {
      this.activeStreams.delete(request.messageId);
    }
  }

  cancelTTS(messageId: string): void {
    const controller = this.activeStreams.get(messageId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(messageId);
    }
  }

  // ============================================
  // Voice Management
  // ============================================

  async getVoices(): Promise<Array<{ id: string; name: string; category: string }>> {
    if (!this.elevenLabsClient) {
      const key = this.getElevenLabsApiKey();
      if (!key) {
        throw new Error('ElevenLabs API key not configured. Please add your API key in Settings.');
      }
      this.elevenLabsClient = new ElevenLabsClient({ apiKey: key });
    }

    try {
      const response = await this.elevenLabsClient.voices.getAll();

      return response.voices.map((voice) => ({
        id: voice.voice_id,
        name: voice.name || 'Unnamed Voice',
        category: voice.category || 'custom',
      }));
    } catch (error) {
      console.error('Failed to fetch voices:', error);
      if (error instanceof Error) {
        throw new Error(`Failed to fetch voices: ${error.message}`);
      }
      throw new Error('Failed to fetch voices: Unknown error');
    }
  }
}
