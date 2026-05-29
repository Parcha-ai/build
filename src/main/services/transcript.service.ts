/**
 * Canonical per-session transcript store.
 *
 * Persists ALL harness messages (Claude, Codex, Cursor, Gemini, OpenCode, Custom)
 * to disk as append-only JSONL files so nothing is lost on app restart.
 *
 * Storage: ~/.build/transcripts/{sessionId}.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ChatMessage } from '../../shared/types';
import {
  filterInternalPromptEchoes,
  harnessFromModel,
  hasRecoverableOutput,
  mergeRecoveredStreamMessages,
} from '../../shared/utils/message-recovery';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string; // ISO 8601
  harness?: string;  // 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'custom'
  model?: string;    // resolved model ID
  toolCalls?: Array<{ id: string; name: string; input?: string; result?: string }>;
  thinking?: string;
  interrupted?: boolean;
  contentBlocks?: unknown[];
}

function parseTranscriptJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTranscriptMessage(message: ChatMessage): ChatMessage | null {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) return null;
  if (message.role === 'assistant' && !hasRecoverableOutput(message)) return null;
  return {
    ...message,
    timestamp,
  };
}

export function transcriptEntriesToChatMessages(entries: TranscriptEntry[]): ChatMessage[] {
  return entries
    .map((entry): ChatMessage => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      timestamp: new Date(entry.timestamp),
      harness: (entry.harness as ChatMessage['harness']) || undefined,
      toolCalls: entry.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: (parseTranscriptJson(tc.input) as Record<string, unknown> | undefined) || {},
        status: 'completed' as const,
        result: parseTranscriptJson(tc.result),
      })),
      interrupted: entry.interrupted,
      contentBlocks: entry.contentBlocks as ChatMessage['contentBlocks'],
    }))
    .map(normalizeTranscriptMessage)
    .filter((message): message is ChatMessage => Boolean(message));
}

export function chatMessageToTranscriptEntry(
  message: ChatMessage,
  model?: string | null,
  existing?: TranscriptEntry
): TranscriptEntry {
  const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
  const entry: TranscriptEntry = {
    ...existing,
    id: message.id,
    role: message.role,
    content: message.content || '',
    timestamp: (Number.isNaN(timestamp.getTime()) ? new Date() : timestamp).toISOString(),
    harness: message.harness || existing?.harness || harnessFromModel(model),
    model: existing?.model || model || undefined,
    interrupted: message.interrupted || existing?.interrupted || undefined,
  };

  const toolCalls = message.toolCalls?.map(tc => ({
    id: tc.id,
    name: tc.name,
    input: tc.input ? JSON.stringify(tc.input) : undefined,
    result: tc.result != null ? JSON.stringify(tc.result) : undefined,
  }));
  if (toolCalls?.length) {
    entry.toolCalls = toolCalls;
  }
  if (message.contentBlocks?.length) {
    entry.contentBlocks = message.contentBlocks;
  }

  return {
    ...entry,
    thinking: existing?.thinking,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class TranscriptService {
  private dir: string;
  private ensured = false;

  constructor() {
    this.dir = path.join(os.homedir(), '.build', 'transcripts');
  }

  // Lazily ensure the directory exists on first write/read.
  private ensureDir(): void {
    if (this.ensured) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.ensured = true;
    } catch (err) {
      // If another process raced us, that's fine.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[TranscriptService] Failed to create directory:', err);
      }
      this.ensured = true;
    }
  }

  /** Absolute path to a session's JSONL file. */
  getTranscriptPath(sessionId: string): string {
    // Sanitise sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /** Does a transcript file exist for this session? */
  hasTranscript(sessionId: string): boolean {
    try {
      return fs.existsSync(this.getTranscriptPath(sessionId));
    } catch {
      return false;
    }
  }

  /**
   * Append a single message to the session's transcript file.
   * Uses synchronous I/O so the write is durable before we return --
   * we'd rather take a tiny latency hit than lose messages on crash.
   */
  appendMessage(sessionId: string, entry: TranscriptEntry): void {
    this.ensureDir();
    const filePath = this.getTranscriptPath(sessionId);
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(filePath, line, 'utf-8');
    } catch (err) {
      console.error('[TranscriptService] Failed to append message:', err);
    }
  }

  /**
   * Load all (or the last `limit`) messages from a session's transcript file.
   * Returns an empty array if the file doesn't exist or is unreadable.
   */
  loadMessages(sessionId: string, limit?: number): TranscriptEntry[] {
    const filePath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(filePath)) return [];

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entries: TranscriptEntry[] = [];

      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as TranscriptEntry);
        } catch {
          // Skip malformed lines -- append-only means partial writes are possible
          // after a hard crash.
          console.warn('[TranscriptService] Skipping malformed line in', filePath);
        }
      }

      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch (err) {
      console.error('[TranscriptService] Failed to load messages:', err);
      return [];
    }
  }

  /** Replace a session transcript with the supplied entries. */
  replaceMessages(sessionId: string, entries: TranscriptEntry[]): { written: number } {
    this.ensureDir();
    const filePath = this.getTranscriptPath(sessionId);
    try {
      const payload = entries.length > 0
        ? entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
        : '';
      fs.writeFileSync(filePath, payload, 'utf-8');
      return { written: entries.length };
    } catch (err) {
      console.error('[TranscriptService] Failed to replace transcript:', err);
      return { written: 0 };
    }
  }

  /**
   * Merge recovered messages into Build's canonical transcript with Build
   * entries taking precedence for duplicates, then persist the result.
   */
  upsertMessages(
    sessionId: string,
    messages: ChatMessage[],
    options: { existingEntries?: TranscriptEntry[] } = {}
  ): { changed: boolean; written: number } {
    const existingEntries = options.existingEntries ?? this.loadMessages(sessionId);
    const existingMessages = transcriptEntriesToChatMessages(existingEntries);
    const incomingMessages = messages
      .map(normalizeTranscriptMessage)
      .filter((message): message is ChatMessage => Boolean(message));
    const mergedMessages = filterInternalPromptEchoes(
      mergeRecoveredStreamMessages(existingMessages, incomingMessages)
    ).filter((message) => message.role !== 'assistant' || hasRecoverableOutput(message));

    const existingEntryById = new Map(existingEntries.map(entry => [entry.id, entry]));
    const nextEntries = mergedMessages.map(message => (
      chatMessageToTranscriptEntry(message, undefined, existingEntryById.get(message.id))
    ));
    const previousPayload = existingEntries.map(entry => JSON.stringify(entry)).join('\n');
    const nextPayload = nextEntries.map(entry => JSON.stringify(entry)).join('\n');
    if (previousPayload === nextPayload) {
      return { changed: false, written: nextEntries.length };
    }

    const result = this.replaceMessages(sessionId, nextEntries);
    return { changed: true, written: result.written };
  }

  /**
   * Copy a transcript from one Build session id to another.
   *
   * If `upToMessageId` is provided, only entries through that message are
   * copied. This keeps fork/rewind tabs backed by the same canonical Build
   * transcript store as normal session loads.
   */
  cloneTranscript(
    fromSessionId: string,
    toSessionId: string,
    options: { upToMessageId?: string } = {}
  ): { copied: number; foundTarget: boolean } {
    const entries = this.loadMessages(fromSessionId);
    if (entries.length === 0) {
      return { copied: 0, foundTarget: false };
    }

    let foundTarget = false;
    const cloned: TranscriptEntry[] = [];
    for (const entry of entries) {
      cloned.push(entry);
      if (options.upToMessageId && entry.id === options.upToMessageId) {
        foundTarget = true;
        break;
      }
    }

    const entriesToWrite = options.upToMessageId && !foundTarget ? [] : cloned;
    if (options.upToMessageId && !foundTarget) {
      console.warn(
        '[TranscriptService] Fork target not found in Build transcript; skipping Build transcript clone:',
        fromSessionId,
        options.upToMessageId
      );
    }
    if (entriesToWrite.length === 0) {
      return { copied: 0, foundTarget };
    }

    this.ensureDir();
    const filePath = this.getTranscriptPath(toSessionId);
    try {
      const payload = entriesToWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.writeFileSync(filePath, payload, 'utf-8');
      return { copied: entriesToWrite.length, foundTarget };
    } catch (err) {
      console.error('[TranscriptService] Failed to clone transcript:', err);
      return { copied: 0, foundTarget: false };
    }
  }
}

export const transcriptService = new TranscriptService();
