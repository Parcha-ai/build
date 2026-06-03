import Store from 'electron-store';
import { EMBEDDED_KEYS } from '../../shared/config/embedded-keys';
import type { Session } from '../../shared/types';

type UpdateSessionFn = (sessionId: string, updates: Partial<Session>) => Promise<Session>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;
const lastTitleUpdates = new Map<string, { at: number; signature: string }>();

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', "it's", 'just', 'latest', 'make',
  'me', 'my', 'need', 'now', 'of', 'on', 'or', 'please', 'should', 'so', 'that',
  'the', 'these', 'this', 'those', 'to', 'up', 'use', 'we', 'what', "what's",
  'when', 'why', 'with', 'work', 'working', 'you', 'your',
]);

const BAD_TITLES = new Set([
  'chat', 'continue', 'fix', 'help', 'latest', 'new task', 'session', 'stuff',
  'task', 'that', 'the task', 'thing', 'this', 'this task', 'update', 'work',
]);

function getCerebrasKey(): string {
  return String(settingsStore.get('cerebrasApiKey') || EMBEDDED_KEYS.cerebras || process.env.CEREBRAS_API_KEY || '').trim();
}

function meaningfulWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((word) => word && !TITLE_STOP_WORDS.has(word));
}

function isBadTitle(title: string): boolean {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  if (BAD_TITLES.has(normalized)) return true;
  const words = meaningfulWords(title);
  if (words.length === 0) return true;
  if (words.length === 1 && words[0].length < 7) return true;
  return false;
}

export function sanitizeSessionTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.:;,\-_\s]+$/g, '')
    .trim();
  if (cleaned.length < 3) return null;
  if (isBadTitle(cleaned)) return null;
  return cleaned.length > 56 ? `${cleaned.slice(0, 53).replace(/\s+\S*$/, '')}...` : cleaned;
}

function fallbackTitleFromMessage(message: string): string | null {
  const cleaned = message
    .replace(/^\/\w+\s*/i, '')
    .replace(/^(I want to|can you|please|could you|I need to|I need|let's|we need to|we should|I'd like to|I have a new task[^-]*-)\s*/i, '')
    .trim();
  if (!cleaned) return null;
  const meaningful = cleaned
    .replace(/[`"'()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-zA-Z0-9+#.]+|[^a-zA-Z0-9+#.]+$/g, ''))
    .filter((word) => word && !TITLE_STOP_WORDS.has(word.toLowerCase()));
  const title = (meaningful.length >= 2 ? meaningful : cleaned.split(/\s+/)).slice(0, 6).join(' ');
  return sanitizeSessionTitle(title.charAt(0).toUpperCase() + title.slice(1));
}

async function summarizeWithCerebras(userMessage: string, assistantMessage: string): Promise<string | null> {
  const apiKey = getCerebrasKey();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        temperature: 0.2,
        max_tokens: 24,
        messages: [
          {
            role: 'system',
            content: 'Name an ongoing coding-agent session from its most recent work. Return only a concise title, 2 to 6 words, no quotes, no punctuation at the end.',
          },
          {
            role: 'user',
            content: [
              `Most recent user request:\n${userMessage.slice(-1400)}`,
              `Most recent assistant result:\n${assistantMessage.slice(-1800)}`,
            ].join('\n\n'),
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn('[SessionTitle] Cerebras title request failed:', response.status, await response.text().catch(() => ''));
      return null;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return sanitizeSessionTitle(data.choices?.[0]?.message?.content);
  } catch (error) {
    console.warn('[SessionTitle] Cerebras title request failed:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateDynamicSessionTitle(params: {
  sessionId: string;
  session?: Session | null;
  userMessage: string;
  assistantMessage: string;
  updateSession: UpdateSessionFn;
}): Promise<void> {
  const userMessage = params.userMessage.trim();
  const assistantMessage = params.assistantMessage.trim();
  if (!userMessage || assistantMessage.length < 20) return;

  const signature = `${userMessage.slice(-240)}\n${assistantMessage.slice(-240)}`;
  const last = lastTitleUpdates.get(params.sessionId);
  if (last?.signature === signature) return;
  if (last && Date.now() - last.at < 20_000) return;
  lastTitleUpdates.set(params.sessionId, { at: Date.now(), signature });

  const currentTitle = sanitizeSessionTitle(params.session?.aiGeneratedName || params.session?.forkName || params.session?.name);
  const title = await summarizeWithCerebras(userMessage, assistantMessage)
    || fallbackTitleFromMessage(userMessage);
  if (!title || title === currentTitle) return;

  await params.updateSession(params.sessionId, {
    aiGeneratedName: title,
    name: title,
  });
}
