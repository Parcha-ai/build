import { create } from 'zustand';
import type { AudioSettings, TranscriptionStatus } from '../../shared/types';

// Check if running in Electron environment
const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

// Per-session recording state
interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  duration: number; // milliseconds
  audioBlob: Blob | null;
  transcriptionStatus: TranscriptionStatus;
  error: string | null;
}

// Per-message TTS state
interface TTSState {
  isPlaying: boolean;
  isPaused: boolean;
  progress: number; // 0-100
  audioChunks: Uint8Array[];
  error: string | null;
}

// Per-session OpenAI Realtime voice state
export interface VoiceModeState {
  isConnected: boolean;
  isConnecting: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;  // True when user is actively talking (mic input detected)
  audioLevel: number;  // 0-1, representing mic input volume level
  transcript: string;
  agentResponse: string;
  error: string | null;
}

interface AudioState {
  // Per-session recording state
  recordingStates: Record<string, RecordingState>;

  // Per-message TTS state
  ttsStates: Record<string, TTSState>;

  // Per-session Realtime voice state
  voiceModeStates: Record<string, VoiceModeState>;

  // Audio mode - per session (tracks if last input was via voice)
  audioModeActive: Record<string, boolean>;

  // Global audio settings
  settings: AudioSettings | null;
  availableVoices: Array<{ voice_id: string; name: string }>;

  // Voice mode actions
  setVoiceModeConnecting: (sessionId: string) => void;
  setVoiceModeConnected: (sessionId: string) => void;
  setVoiceModeDisconnected: (sessionId: string) => void;
  setVoiceModeSpeaking: (sessionId: string, speaking: boolean) => void;
  setVoiceModeUserSpeaking: (sessionId: string, speaking: boolean) => void;
  setVoiceModeAudioLevel: (sessionId: string, level: number) => void;
  setVoiceModeTranscript: (sessionId: string, transcript: string) => void;
  setVoiceModeAgentResponse: (sessionId: string, response: string) => void;
  setVoiceModeError: (sessionId: string, error: string | null) => void;
  getVoiceModeState: (sessionId: string) => VoiceModeState | undefined;

  // Audio mode actions
  setAudioMode: (sessionId: string, active: boolean) => void;
  isAudioModeActive: (sessionId: string) => boolean;
  triggerAutoPlayTTS: (sessionId: string, messageId: string, text: string) => Promise<void>;

  // Recording actions
  startRecording: (sessionId: string) => void;
  stopRecording: (sessionId: string) => void;
  pauseRecording: (sessionId: string) => void;
  resumeRecording: (sessionId: string) => void;
  setRecordingDuration: (sessionId: string, duration: number) => void;
  setAudioBlob: (sessionId: string, blob: Blob) => void;
  setTranscriptionStatus: (sessionId: string, status: TranscriptionStatus) => void;
  setRecordingError: (sessionId: string, error: string | null) => void;
  clearRecording: (sessionId: string) => void;

  // TTS actions
  startTTS: (messageId: string) => void;
  stopTTS: (messageId: string) => void;
  pauseTTS: (messageId: string) => void;
  resumeTTS: (messageId: string) => void;
  addTTSChunk: (messageId: string, chunk: Uint8Array) => void;
  setTTSProgress: (messageId: string, progress: number) => void;
  setTTSError: (messageId: string, error: string) => void;
  completeTTS: (messageId: string) => void;
  clearTTS: (messageId: string) => void;
  clearSessionTTS: (messageIds: string[]) => void;

  // Settings actions
  loadSettings: () => Promise<void>;
  updateSettings: (settings: Partial<AudioSettings>) => Promise<void>;
  loadVoices: () => Promise<void>;
}

const defaultRecordingState: RecordingState = {
  isRecording: false,
  isPaused: false,
  duration: 0,
  audioBlob: null,
  transcriptionStatus: 'idle',
  error: null,
};

const defaultTTSState: TTSState = {
  isPlaying: false,
  isPaused: false,
  progress: 0,
  audioChunks: [],
  error: null,
};

const defaultVoiceModeState: VoiceModeState = {
  isConnected: false,
  isConnecting: false,
  isSpeaking: false,
  isUserSpeaking: false,
  audioLevel: 0,
  transcript: '',
  agentResponse: '',
  error: null,
};

// Store cleanup functions for TTS listeners on window to survive HMR
declare global {
  interface Window {
    __ttsListenerCleanups?: Array<() => void>;
    __ttsListenersInitialized?: boolean;
  }
}

// Initialize global TTS event listeners (called once per app lifecycle - HMR safe)
export function initializeTTSListeners() {
  if (!hasElectronAPI) return;

  // If already initialized (survives HMR), clean up old listeners first
  if (window.__ttsListenersInitialized && window.__ttsListenerCleanups) {
    window.__ttsListenerCleanups.forEach(cleanup => cleanup());
    window.__ttsListenerCleanups = [];
  }

  window.__ttsListenersInitialized = true;
  window.__ttsListenerCleanups = [];

  // Subscribe to TTS chunk events and store cleanup
  const cleanupChunk = window.electronAPI.audio.onTTSChunk(({ messageId, chunk }) => {
    useAudioStore.getState().addTTSChunk(messageId, new Uint8Array(chunk));
  });
  window.__ttsListenerCleanups.push(cleanupChunk);

  // Subscribe to TTS complete events and store cleanup
  const cleanupComplete = window.electronAPI.audio.onTTSComplete(({ messageId }) => {
    useAudioStore.getState().completeTTS(messageId);
  });
  window.__ttsListenerCleanups.push(cleanupComplete);

  // Subscribe to TTS error events and store cleanup
  const cleanupError = window.electronAPI.audio.onTTSError(({ messageId, error }) => {
    useAudioStore.getState().setTTSError(messageId, error);
  });
  window.__ttsListenerCleanups.push(cleanupError);
}

export const useAudioStore = create<AudioState>((set, get) => ({
  recordingStates: {},
  ttsStates: {},
  voiceModeStates: {},
  audioModeActive: {},
  settings: null,
  availableVoices: [],

  // Voice mode actions
  setVoiceModeConnecting: (sessionId) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...defaultVoiceModeState,
        isConnecting: true,
      },
    },
  })),

  setVoiceModeConnected: (sessionId) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        isConnected: true,
        isConnecting: false,
        error: null,
      },
    },
  })),

  setVoiceModeDisconnected: (sessionId) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...defaultVoiceModeState,
      },
    },
  })),

  setVoiceModeSpeaking: (sessionId, speaking) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        isSpeaking: speaking,
      },
    },
  })),

  setVoiceModeUserSpeaking: (sessionId, speaking) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        isUserSpeaking: speaking,
      },
    },
  })),

  setVoiceModeAudioLevel: (sessionId, level) => set((state) => {
    const previous = state.voiceModeStates[sessionId]?.audioLevel || 0;
    if (Math.abs(previous - level) < 0.03) return state;
    return {
      voiceModeStates: {
        ...state.voiceModeStates,
        [sessionId]: {
          ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
          audioLevel: level,
        },
      },
    };
  }),

  setVoiceModeTranscript: (sessionId, transcript) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        transcript,
      },
    },
  })),

  setVoiceModeAgentResponse: (sessionId, response) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        agentResponse: response,
      },
    },
  })),

  setVoiceModeError: (sessionId, error) => set((state) => ({
    voiceModeStates: {
      ...state.voiceModeStates,
      [sessionId]: {
        ...(state.voiceModeStates[sessionId] || defaultVoiceModeState),
        error,
        isConnecting: false,
      },
    },
  })),

  getVoiceModeState: (sessionId) => {
    return get().voiceModeStates[sessionId];
  },

  // Audio mode actions
  setAudioMode: (sessionId, active) => set((state) => ({
    audioModeActive: {
      ...state.audioModeActive,
      [sessionId]: active,
    },
  })),

  isAudioModeActive: (sessionId) => {
    return get().audioModeActive[sessionId] || false;
  },

  triggerAutoPlayTTS: async (sessionId, messageId, text) => {
    if (!hasElectronAPI) return;
    const { settings, startTTS, setTTSError, audioModeActive, voiceModeStates } = get();

    console.log('[TTS] triggerAutoPlayTTS called:', {
      sessionId,
      messageId,
      textLength: text?.length,
      audioModeActive: audioModeActive[sessionId],
      voiceModeConnected: voiceModeStates[sessionId]?.isConnected,
      hasSettings: !!settings,
      hasVoiceSettings: !!settings?.voiceSettings,
    });

    // Skip if Realtime voice mode is connected; that session owns audio output.
    if (voiceModeStates[sessionId]?.isConnected) {
      console.log('[TTS] Skipping: Realtime voice mode is connected');
      return;
    }

    // Only auto-play if audio mode is active for this session
    if (!audioModeActive[sessionId]) {
      console.log('[TTS] Skipping: audio mode not active for session', sessionId);
      return;
    }

    // Check if we have voice settings
    if (!settings?.voiceSettings) {
      console.warn('[TTS] Auto-play skipped: Voice settings not configured');
      return;
    }

    console.log('[TTS] Starting TTS playback for message:', messageId);

    try {
      startTTS(messageId);
      const response = await window.electronAPI.audio.streamTTS({
        text,
        messageId,
        voiceId: settings.voiceSettings.voiceId,
        modelId: 'gpt-4o-mini-tts',
      });

      console.log('[TTS] streamTTS response:', response);

      if (!response.success) {
        console.error('[TTS] streamTTS failed:', response.error);
        setTTSError(messageId, response.error || 'Failed to start TTS');
      }
    } catch (error) {
      console.error('[TTS] Exception during TTS:', error);
      setTTSError(messageId, error instanceof Error ? error.message : 'TTS failed');
    }
  },

  // Recording actions
  startRecording: (sessionId) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...defaultRecordingState,
        isRecording: true,
        transcriptionStatus: 'recording',
      },
    },
  })),

  stopRecording: (sessionId) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        isRecording: false,
      },
    },
  })),

  pauseRecording: (sessionId) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        isPaused: true,
      },
    },
  })),

  resumeRecording: (sessionId) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        isPaused: false,
      },
    },
  })),

  setRecordingDuration: (sessionId, duration) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        duration,
      },
    },
  })),

  setAudioBlob: (sessionId, blob) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        audioBlob: blob,
      },
    },
  })),

  setTranscriptionStatus: (sessionId, status) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        transcriptionStatus: status,
      },
    },
  })),

  setRecordingError: (sessionId, error) => set((state) => ({
    recordingStates: {
      ...state.recordingStates,
      [sessionId]: {
        ...state.recordingStates[sessionId],
        error,
        transcriptionStatus: error ? 'error' : state.recordingStates[sessionId]?.transcriptionStatus || 'idle',
      },
    },
  })),

  clearRecording: (sessionId) => set((state) => {
    const { [sessionId]: _, ...rest } = state.recordingStates;
    return { recordingStates: rest };
  }),

  // TTS actions
  startTTS: (messageId) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...defaultTTSState,
        isPlaying: true,
        audioChunks: [],
      },
    },
  })),

  stopTTS: (messageId) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        isPlaying: false,
        isPaused: false,
      },
    },
  })),

  pauseTTS: (messageId) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        isPaused: true,
      },
    },
  })),

  resumeTTS: (messageId) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        isPaused: false,
      },
    },
  })),

  addTTSChunk: (messageId, chunk) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        audioChunks: [...(state.ttsStates[messageId]?.audioChunks || []), chunk],
      },
    },
  })),

  setTTSProgress: (messageId, progress) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        progress,
      },
    },
  })),

  setTTSError: (messageId, error) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        error,
        isPlaying: false,
      },
    },
  })),

  completeTTS: (messageId) => set((state) => ({
    ttsStates: {
      ...state.ttsStates,
      [messageId]: {
        ...state.ttsStates[messageId],
        // Keep isPlaying true so audio can play
        // The audio will stop naturally when playback ends
        progress: 100,
      },
    },
  })),

  clearTTS: (messageId) => set((state) => {
    const { [messageId]: _, ...rest } = state.ttsStates;
    return { ttsStates: rest };
  }),

  clearSessionTTS: (messageIds) => set((state) => {
    const newTTSStates = { ...state.ttsStates };
    for (const id of messageIds) {
      delete newTTSStates[id];
    }
    return { ttsStates: newTTSStates };
  }),

  // Settings actions
  loadSettings: async () => {
    if (!hasElectronAPI) return;
    try {
      const settings = await window.electronAPI.audio.getSettings();
      set({ settings });
    } catch (error) {
      console.error('Failed to load audio settings:', error);
    }
  },

  updateSettings: async (newSettings) => {
    if (!hasElectronAPI) return;
    try {
      await window.electronAPI.audio.setSettings(newSettings);
      const settings = await window.electronAPI.audio.getSettings();
      set({ settings });
    } catch (error) {
      console.error('Failed to update audio settings:', error);
    }
  },

  loadVoices: async () => {
    if (!hasElectronAPI) return;
    try {
      const response = await window.electronAPI.audio.getVoices();
      if (response.success && response.voices) {
        set({ availableVoices: response.voices });
      }
    } catch (error) {
      console.error('Failed to load voices:', error);
    }
  },
}));
