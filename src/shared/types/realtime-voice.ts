import type { RealtimeReasoningEffort, RealtimeVoiceOption } from './audio';

export interface RealtimeVoiceSessionRequest {
  sessionId: string;
  instructions: string;
  memorySessionId?: string;
  voice?: RealtimeVoiceOption;
  reasoningEffort?: RealtimeReasoningEffort;
  language?: string;
}

export interface RealtimeVoiceSessionResult {
  success: boolean;
  clientSecret?: string;
  expiresAt?: number;
  model?: string;
  error?: string;
}

export interface RealtimeVoiceConfiguration {
  configured: boolean;
  model: string;
}

export interface RealtimeVoiceRoutingLog {
  event: string;
  details?: Record<string, unknown>;
}

export type VoiceMemoryRole = 'user' | 'assistant';
export type VoiceMemorySource = 'desktop' | 'remote';

export interface VoiceMemoryEntry {
  id: string;
  role: VoiceMemoryRole;
  content: string;
  createdAt: string;
  sessionId?: string;
  sessionName?: string;
  source: VoiceMemorySource;
}

export interface VoiceMemoryAppendRequest {
  role: VoiceMemoryRole;
  content: string;
  sessionId?: string;
  sessionName?: string;
  source?: VoiceMemorySource;
}

export interface VoiceMemorySnapshot {
  version: number;
  entries: VoiceMemoryEntry[];
}

export interface RemoteVoiceToolCall {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface RemoteVoiceDeploymentStatus {
  active: boolean;
  deploying?: boolean;
  sessionId?: string;
  sessionName?: string;
  host?: string;
  url?: string;
  startedAt?: number;
  error?: string;
}
