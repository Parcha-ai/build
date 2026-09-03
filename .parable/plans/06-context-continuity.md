# Plan: Create ContextContinuityService

## Intent
Create a single entry point for assembling all turn context — system prompt, conversation_sync, design context, supplemental context. This replaces 3 separate context assembly paths (Claude SDK at ~L812-980, non-Claude at ~L2056-2115, and the fresh-start conversation_sync at ~L5731-5743 in claude.service.ts).

## Scope
- **Create**: `src/main/services/context-continuity.service.ts`
- **Off-limits**: Do NOT modify any existing files.

## Conventions
- Electron main-process service in TypeScript
- Export singleton: `export const contextContinuityService = new ContextContinuityService()`
- Import types from `../../shared/types` for Harness, SSHConfig, ChatMessage
- Use lazy imports for designService and claudeService to avoid circular deps

## Read first
- `src/shared/types/index.ts` — Harness type, ChatMessage interface
- `src/main/services/claude.service.ts` lines 5720-5745 — current conversation_sync builder
- `src/main/services/design.service.ts` — fetchDesignSessionContext method, workspace types

## Specification

### Types

```typescript
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
```

### Class: ContextContinuityService

```typescript
class ContextContinuityService {
  /**
   * Build all context for a turn. Single entry point for ALL harness types.
   */
  async buildTurnContext(
    sessionId: string,
    opts: BuildTurnContextOpts,
  ): Promise<TurnContextPayload>

  /**
   * Build the conversation_sync block for injection into user message.
   * This is the core delta/full sync logic.
   */
  buildConversationSync(
    buildTranscript: ChatMessage[],
    nativeTranscript: ChatMessage[],
    mode: 'delta' | 'full',
  ): string | undefined

  /**
   * Build design context, with file embedding for SSH sessions.
   */
  async buildDesignContext(
    sessionId: string,
    ssh?: { config: SSHConfig; remoteWorkdir: string },
  ): Promise<string>
}
```

### buildTurnContext logic

```
1. Get Build transcript (from opts or fetch via transcript service)
2. Determine sync mode:
   - If isResume AND sdkSessionId → DELTA SYNC
     - Get native transcript (from opts or fetch)
     - Compute delta between Build and native
     - If delta has messages → build conversation_sync as 'delta'
   - If isFreshStart AND buildTranscript has messages → FULL SYNC
     - Build conversation_sync as 'full' from Build transcript
   - Else → no conversation_sync needed
3. Build design context if includeDesign is true
   - If SSH: embed local file contents + rewrite paths to remote
4. Return payload
```

### buildConversationSync format

```typescript
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
```

### buildDesignContext with SSH file embedding

```typescript
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
    const fs = await import('fs/promises');
    const path = await import('path');
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
    const remoteDir = workspace.remote.remoteDir || workspace.remote.remotePath;
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
```

### Helper: escapeRegExp

```typescript
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### Delta computation

```typescript
/**
 * Compute messages in buildTranscript that are NOT in nativeTranscript.
 * Uses role + normalized content matching (same as existing comparableMessageText logic).
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

private comparableText(content?: string): string {
  return (content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500)
    .toLowerCase();
}
```

## Testing expectations
File compiles cleanly. Lazy imports for designService. No Electron imports. The service is stateless — each call is independent.
