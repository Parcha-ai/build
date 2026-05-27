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
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
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
}

export const transcriptService = new TranscriptService();
