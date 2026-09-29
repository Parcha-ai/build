# Plan: Create DedupEngine

## Intent
Create a tiered deduplication engine that replaces the 5 separate dedup functions in `message-recovery.ts` with a single class providing exact, prefix, and fuzzy paragraph-overlap matching. This catches regenerated assistant messages with different preambles — a bug that currently lets triple/double output through.

## Scope
- **Create**: `src/shared/utils/dedup-engine.ts`
- **Off-limits**: Do NOT modify any existing files. This plan creates a new standalone file only.

## Conventions
- This is a shared utility (used by both main and renderer processes)
- Import types from `../../shared/types` — specifically `ChatMessage` and `ToolCall`
- Export a singleton instance: `export const dedupEngine = new DedupEngine()`
- Keep the same `normalizeContentForCompare` pattern from the existing `message-recovery.ts`

## Read first
Read `src/shared/utils/message-recovery.ts` to understand the existing dedup functions and the `ChatMessage` type shape. Also read `src/shared/types/index.ts` for the ChatMessage interface.

## Specification

### Class: DedupEngine

```typescript
class DedupEngine {
  /**
   * Check if two messages are duplicates using tiered matching.
   * Tiers are tried in order; first match wins.
   */
  isDuplicate(a: ChatMessage, b: ChatMessage, opts?: {
    maxTimeDeltaMs?: number;  // Default: 300_000 (5 minutes)
    fuzzyThreshold?: number;  // Default: 0.7 (70% paragraph overlap)
  }): boolean

  /**
   * Merge a duplicate pair, keeping the longer/more complete version.
   * Used during transcript recovery when we know two messages are duplicates.
   */
  mergeDuplicate(existing: ChatMessage, incoming: ChatMessage): ChatMessage

  /**
   * Deduplicate an array of messages, preserving order.
   * Later messages are preferred over earlier ones when merging.
   */
  deduplicateMessages(messages: ChatMessage[]): ChatMessage[]
}
```

### isDuplicate tiers (in order)

1. **ID match**: `a.id === b.id` → true
2. **Role mismatch**: `a.role !== b.role` → false (short-circuit)
3. **Exact content match**: normalized content identical AND (content non-empty OR tool signatures match OR content block signatures match) → true
4. **Prefix match**: both normalized contents > 200 chars, one starts with the other → true
5. **Fuzzy paragraph overlap**: both are `role: 'assistant'`, both normalized contents > 500 chars, paragraph overlap > threshold (default 0.7) → true
6. **Tool signature match**: both have toolCalls, tool signatures identical → true
7. **Time gate**: if maxTimeDeltaMs is set and |timestamp_a - timestamp_b| > maxTimeDeltaMs → false (applied before tiers 3-6)

### Helper methods (private)

```typescript
private normalize(content?: string): string
  // Strip \r\n → \n
  // Strip transient status prefixes: "⚠️ Remote session hiccup..." and "⏳ Rate limited..."
  // Trim

private paragraphs(text: string): string[]
  // Split on double newlines (\n{2,})
  // Normalize each: collapse whitespace, trim
  // Filter out fragments < 50 chars

private paragraphOverlap(a: string, b: string): number
  // Get paragraphs of both
  // Count shared paragraphs (exact match after normalization)
  // Return shared / max(a.length, b.length)

private toolSignature(message: ChatMessage): string
  // Map toolCalls to `${id}:${name}:${status}:${JSON.stringify(input)}:${JSON.stringify(result)}:${error}`
  // Join with '|'

private contentBlockSignature(message: ChatMessage): string
  // Map contentBlocks to `${type}:${text}:${toolCallId}:${agentId}`
  // Join with '|'

private messageTimestamp(message: ChatMessage): number
  // Handle Date | string, return epoch ms, default 0 for invalid
```

### mergeDuplicate behavior
- Pick the longer normalized content
- Merge toolCalls by ID (incoming overwrites existing for same ID, keep input/result from whichever has it)
- Merge contentBlocks by deduplicating on `type:text:toolCallId:agentId` key
- Preserve `interrupted` flag from either message
- Keep the earlier timestamp

### deduplicateMessages behavior
- Sort by timestamp
- For each message, check against all already-accepted messages using isDuplicate
- If duplicate found, merge into the existing one
- If not, append to result

## Testing expectations
The file should compile cleanly. It should NOT import anything from the main process (no electron, no node-pty, etc.). Only shared types and standard JS built-ins.
