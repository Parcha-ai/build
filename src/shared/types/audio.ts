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
}

export const OPENAI_REALTIME_MODEL = 'gpt-realtime-2.1' as const;
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts' as const;

export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

export type OpenAIVoice = typeof OPENAI_VOICES[number];
export const REALTIME_VOICE_OPTIONS = ['M', ...OPENAI_VOICES] as const;
export type RealtimeVoiceOption = typeof REALTIME_VOICE_OPTIONS[number];

export function getRealtimeVoiceLabel(voice: RealtimeVoiceOption): string {
  return voice === 'M' ? 'Moneypenny' : voice;
}

export type RealtimeReasoningEffort = 'low' | 'medium' | 'high';

export interface AudioSettings {
  openAiApiKey?: string;
  selectedVoice: string;
  voiceSettings: VoiceSettings;
  realtimeVoice: RealtimeVoiceOption;
  realtimeReasoningEffort: RealtimeReasoningEffort;
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
  selectedVoice: 'marin',
  voiceSettings: {
    voiceId: 'marin',
  },
  realtimeVoice: 'marin',
  realtimeReasoningEffort: 'low',
  autoPlayResponses: false,
  transcriptionLanguage: 'en',
  voiceTriggerWord: 'please', // Default trigger word
  voiceModeEnabled: true, // Enable voice mode by default
  ralphLoopEnabled: false, // Ralph Loop disabled by default
  computerUseEnabled: false, // Computer Use disabled by default
  maxComputerUseIterations: 20, // Default max iterations for Computer Use
};
