// Audio state types
export interface AudioState {
  isRecording: boolean;
  isPaused: boolean;
  recordingDuration: number; // milliseconds
  audioBlob: Blob | null;
  transcriptionStatus: TranscriptionStatus;
  error: string | null;
}

export type TranscriptionStatus = 'idle' | 'recording' | 'processing' | 'complete' | 'error';

export interface TranscriptionResult {
  text: string;
  partial: boolean; // true for interim results, false for final
  confidence?: number;
}

// TTS types
export interface TTSState {
  isPlaying: boolean;
  isPaused: boolean;
  messageId: string | null;
  progress: number; // 0-100
  error: string | null;
}

export interface TTSRequest {
  text: string;
  messageId: string;
  voiceId: string;
  modelId: string;
}

export interface VoiceSettings {
  voiceId: string;
  stability: number; // 0-1
  similarityBoost: number; // 0-1
  style: number; // 0-1
  useSpeakerBoost: boolean;
}

export interface AudioSettings {
  elevenLabsApiKey?: string;
  openAiApiKey?: string;
  elevenLabsAgentId?: string; // ElevenLabs Conversational AI agent ID for voice mode
  selectedVoice: string;
  voiceSettings: VoiceSettings;
  autoPlayResponses: boolean;
  transcriptionLanguage: string;
  voiceTriggerWord: string; // Word that triggers auto-submit when speaking
  voiceModeEnabled?: boolean; // Enable the new voice conversation mode
  ralphLoopEnabled?: boolean; // Enable Ralph Loop in Build It mode (agent keeps working until task complete)
  computerUseEnabled?: boolean; // Enable Computer Use API for visual browser automation
  maxComputerUseIterations?: number; // Max iterations for Computer Use Stop hook (default: 20)
}

// Default settings
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  selectedVoice: 'EXAVITQu4vr4xnSDxMaL', // Rachel (ElevenLabs default)
  voiceSettings: {
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
  },
  autoPlayResponses: false,
  transcriptionLanguage: 'en',
  voiceTriggerWord: 'please', // Default trigger word
  elevenLabsAgentId: undefined, // User must configure in Settings
  voiceModeEnabled: true, // Enable voice mode by default
  ralphLoopEnabled: false, // Ralph Loop disabled by default
  computerUseEnabled: false, // Computer Use disabled by default
  maxComputerUseIterations: 20, // Default max iterations for Computer Use
};
