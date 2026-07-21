import * as fs from 'fs/promises';
import * as path from 'path';
import type { SSHConfig, ChatMessage } from '../../shared/types';

/**
 * Payload returned by buildTurnContext — all context pieces for a turn.
 */
export interface TurnContextPayload {
  /** The system prompt to send with the turn */
  systemPrompt: string;
  /** conversation_sync block — goes INSIDE the user message, not system prompt */
  conversationSync?: string;
  /** Design context with file contents (embedded for SSH) */
  designContext?: string;
  /** Supplemental context (goal, session metadata) */
  supplementalContext?: string;
}

/**
 * Options for buildTurnContext.
 */
export interface BuildTurnContextOpts {
  harness: string;              // 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'custom'
  isResume: boolean;
  isFreshStart: boolean;        // true when doomed-resume dropped SDK session
  sdkSessionId?: string;        // Claude SDK session ID for native transcript fetch
  includeDesign?: boolean;
  ssh?: { config: SSHConfig; remoteWorkdir: string };
  buildTranscript?: ChatMessage[];  // Pre-fetched Build transcript (optional)
  nativeTranscript?: ChatMessage[]; // Pre-fetched native transcript (optional)
}

/**
 * Helper to escape special regex characters in a string for safe use in RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ContextContinuityService assembles all turn context — system prompt,
 * conversation_sync, design context, supplemental context. This replaces
 * multiple separate context assembly paths in claude.service.ts.
 */
export class ContextContinuityService {
  /**
   * Build all context for a turn. Single entry point for ALL harness types.
   */
  async buildTurnContext(
    sessionId: string,
    opts: BuildTurnContextOpts,
  ): Promise<TurnContextPayload> {
    // 1. Get Build transcript (from opts or fetch via transcript service)
    const buildTranscript = opts.buildTranscript ?? await this.fetchBuildTranscript(sessionId);

    // 2. Determine sync mode
    let conversationSync: string | undefined;

    if (opts.isResume && opts.sdkSessionId) {
      // DELTA SYNC: fetch native transcript, compute delta
      const nativeTranscript = opts.nativeTranscript ?? await this.fetchNativeTranscript(opts.sdkSessionId);
      const delta = this.computeDelta(buildTranscript, nativeTranscript);
      if (delta.length > 0) {
        conversationSync = this.buildConversationSync(delta, nativeTranscript, 'delta');
      }
    } else if (opts.isFreshStart && buildTranscript.length > 0) {
      // FULL SYNC: for doomed-resume fresh starts
      conversationSync = this.buildConversationSync(buildTranscript, [], 'full');
    }
    // Else: no conversation_sync needed

    // 3. Build design context if includeDesign is true
    let designContext: string | undefined;
    if (opts.includeDesign) {
      designContext = await this.buildDesignContext(sessionId, opts.ssh);
    }

    // 4. Build system prompt (placeholder — caller may override)
    const systemPrompt = this.buildSystemPrompt(opts.harness);

    return {
      systemPrompt,
      conversationSync,
      designContext,
      supplementalContext: undefined, // Caller can add goal/session metadata
    };
  }

  /**
   * Build the conversation_sync block for injection into user message.
   * This is the core delta/full sync logic.
   */
  buildConversationSync(
    buildTranscript: ChatMessage[],
    nativeTranscript: ChatMessage[],
    mode: 'delta' | 'full',
  ): string | undefined {
    const messagesToSync = mode === 'delta'
      ? this.computeDelta(buildTranscript, nativeTranscript)
      : buildTranscript;

    if (messagesToSync.length === 0) return undefined;

    return this.formatSync(messagesToSync, mode);
  }

  /**
   * Build design context, with file embedding for SSH sessions.
   */
  async buildDesignContext(
    sessionId: string,
    ssh?: { config: SSHConfig; remoteWorkdir: string },
  ): Promise<string> {
    // Lazy import to avoid circular deps
    const designService = (await import('./design.service')).designService;

    const workspace = designService.getWorkspaceForSession?.(sessionId);
    if (!workspace) return '';

    const context = await designService.fetchDesignSessionContext?.(sessionId);
    if (!context) return '';

    if (ssh && workspace.remote) {
      // Read local design files
      let embedded = '';
      try {
        const dir = workspace.workspaceDir;
        const files = await fs.readdir(dir, { recursive: true });
        const textFiles = (files as string[]).filter(f =>
          /\.(md|txt|json|yaml|yml|html|css|js|ts|tsx)$/i.test(f)
        );
        const contents = await Promise.all(
          textFiles.slice(0, 20).map(async f => {
            try {
              const content = await fs.readFile(path.join(dir, f), 'utf-8');
              return `--- ${f} ---\n${content.substring(0, 5000)}`;
            } catch { return null; }
          })
        );
        embedded = contents.filter(Boolean).join('\n\n');
      } catch { /* workspace may not exist locally */ }

      // Rewrite local paths to remote paths
      const localDir = workspace.workspaceDir;
      const remoteDir = workspace.remote.remoteDir;
      const rewritten = localDir && remoteDir
        ? context.replace(new RegExp(escapeRegExp(localDir), 'g'), remoteDir)
        : context;

      if (embedded) {
        return rewritten + '\n\n## Design File Contents (embedded for SSH)\n' + embedded;
      }
      return rewritten;
    }

    return context;
  }

  /**
   * Compute messages in buildTranscript that are NOT in nativeTranscript.
   * Uses role + normalized content matching.
   */
  private computeDelta(
    buildTranscript: ChatMessage[],
    nativeTranscript: ChatMessage[],
  ): ChatMessage[] {
    const nativeSet = new Set(
      nativeTranscript.map(m => `${m.role}:${this.comparableText(m.content)}`)
    );
    return buildTranscript.filter(m => {
      const key = `${m.role}:${this.comparableText(m.content)}`;
      return !nativeSet.has(key);
    });
  }

  /**
   * Normalize message content for comparison.
   */
  private comparableText(content?: string): string {
    return (content || '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500)
      .toLowerCase();
  }

  /**
   * Format messages as a conversation_sync block.
   */
  private formatSync(messages: ChatMessage[], mode: 'delta' | 'full'): string {
    const body = messages.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const ts = m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp;
      return `[${ts}] ${role}: ${(m.content || '').substring(0, 2000)}`;
    }).join('\n\n');

    return [
      '<conversation_sync>',
      'You are CONTINUING an existing conversation. The messages below',
      'are YOUR prior conversation history. They are authoritative —',
      'treat them as your own memory, not external context.',
      `Mode: ${mode} | Messages: ${messages.length}`,
      '',
      body,
      '',
      '</conversation_sync>',
    ].join('\n');
  }

  /**
   * Build a basic system prompt (placeholder).
   */
  private buildSystemPrompt(harness: string): string {
    return `You are a helpful AI assistant using the ${harness} harness.`;
  }

  /**
   * Fetch Build transcript from transcript service.
   * Placeholder — caller should provide buildTranscript in opts.
   */
  private async fetchBuildTranscript(sessionId: string): Promise<ChatMessage[]> {
    // Lazy import to avoid circular deps
    const transcriptService = (await import('./transcript.service')).transcriptService;
    const entries = transcriptService.loadMessages(sessionId);
    const { transcriptEntriesToChatMessages } = await import('./transcript.service');
    return transcriptEntriesToChatMessages(entries);
  }

  /**
   * Fetch native transcript from Claude SDK.
   * Placeholder — caller should provide nativeTranscript in opts.
   */
  private async fetchNativeTranscript(_sdkSessionId: string): Promise<ChatMessage[]> {
    // Caller must provide nativeTranscript via opts — claudeService is not
    // exported as a module singleton (it's instantiated in claude.ipc.ts).
    console.warn('[Context Continuity] fetchNativeTranscript called without opts.nativeTranscript — returning empty');
    return [];
  }
}

/**
 * Singleton export for use across services.
 */
export const contextContinuityService = new ContextContinuityService();
