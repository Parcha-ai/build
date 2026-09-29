import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import ToolCallCard from './ToolCallCard';
import type { ChatMessage, ToolCall } from '../../../shared/types';
import { buildMissingToolCall, getMessageRenderArtifacts } from '../../../shared/utils/message-rendering';
import { isTranscriptVisibleToolCall, normalizeToolCall } from '../../../shared/utils/tool-call-transformer';

// Rendering-only grouping of consecutive tool calls (Graphite "Explored N files" card).
// Nothing here mutates message data, ordering or persistence.

const FILE_TOOLS = new Set(['Read', 'Ls']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'Command', 'BashOutput', 'KillShell']);
const DIFF_TOOLS = new Set(['Edit', 'Write']);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function summarizeToolRun(toolCalls: ToolCall[], isLive: boolean): { verb: string; detail: string } {
  const names = toolCalls.map((toolCall) => normalizeToolCall(toolCall).name);
  const files = names.filter((name) => FILE_TOOLS.has(name)).length;
  const searches = names.filter((name) => SEARCH_TOOLS.has(name)).length;
  const commands = names.filter((name) => SHELL_TOOLS.has(name)).length;

  if (files + searches === names.length) {
    const parts: string[] = [];
    if (files > 0) parts.push(plural(files, 'file', 'files'));
    if (searches > 0) parts.push(plural(searches, 'search', 'searches'));
    return { verb: isLive ? 'Exploring' : 'Explored', detail: parts.join(', ') };
  }
  if (commands === names.length) {
    return { verb: isLive ? 'Running' : 'Ran', detail: plural(commands, 'command', 'commands') };
  }
  return { verb: isLive ? 'Using' : 'Used', detail: plural(names.length, 'tool', 'tools') };
}

/**
 * Visible tool calls of an assistant message in content-block order, matching
 * the order MessageBubble would have rendered them.
 */
export function getOrderedVisibleToolCalls(message: ChatMessage): ToolCall[] {
  const { toolCalls, unrenderedToolCalls } = getMessageRenderArtifacts(message);
  const hiddenIds = new Set(
    (message.toolCalls || []).filter((toolCall) => !isTranscriptVisibleToolCall(toolCall)).map((toolCall) => toolCall.id),
  );
  if (!message.contentBlocks || message.contentBlocks.length === 0) return toolCalls;

  const byId = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall] as const));
  const ordered: ToolCall[] = [];
  for (const block of message.contentBlocks) {
    if (block.type !== 'tool_use' || !block.toolCallId || hiddenIds.has(block.toolCallId)) continue;
    const toolCall = byId.get(block.toolCallId) || buildMissingToolCall(block.toolCallId, block.agentId);
    if (isTranscriptVisibleToolCall(toolCall)) ordered.push(toolCall);
  }
  return [...ordered, ...unrenderedToolCalls];
}

/**
 * Main slims older assistant messages for the renderer: tool payloads are
 * dropped and content becomes "Completed N historical tool call(s)." (see
 * slimHistoricalMessageForRenderer in claude.ipc.ts). For those tool-only
 * placeholders return N so they can fold into a run; otherwise 0.
 */
export function getHistoricalToolOnlyCount(message: ChatMessage): number {
  if (message.role !== 'assistant' || message.interrupted) return 0;
  if (message.toolCalls?.length || message.contentBlocks?.length) return 0;
  const count = Number(message.metadata?.historicalToolCallCount);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const placeholder = `Completed ${count} historical tool call${count === 1 ? '' : 's'}.`;
  return (message.content || '').trim() === placeholder ? count : 0;
}

/** True when an assistant message renders as nothing but tool calls (safe to fold into a run). */
export function isGroupableToolOnlyMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.interrupted) return false;
  const { isToolOnlyMessage } = getMessageRenderArtifacts(message);
  return isToolOnlyMessage && getOrderedVisibleToolCalls(message).length > 0;
}

function isToolCallLive(toolCall: ToolCall): boolean {
  return toolCall.status === 'running' || toolCall.status === 'pending';
}

interface ToolRunGroupProps {
  toolCalls: ToolCall[];
  /** Force "live" (expanded) state, e.g. while the run is still streaming. */
  isLive?: boolean;
  onBackground?: (toolCall: ToolCall) => void;
  /** Older calls in this run whose details main trimmed from the live view (count only). */
  trimmedCount?: number;
}

export default function ToolRunGroup({ toolCalls, isLive: isLiveProp = false, onBackground, trimmedCount = 0 }: ToolRunGroupProps) {
  const isLive = isLiveProp || toolCalls.some(isToolCallLive);
  // Auto state follows liveness (expanded while live, collapsed when complete)
  // until the user explicitly toggles it.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isExpanded = userExpanded ?? isLive;
  const failed = toolCalls.filter((toolCall) => toolCall.status === 'error').length;
  const summary = summarizeToolRun(toolCalls, isLive);
  const totalCount = toolCalls.length + trimmedCount;
  // Trimmed history has no tool names, so the kind-specific label only holds when nothing was trimmed.
  const { verb, detail } = trimmedCount > 0
    ? { verb: 'Used', detail: plural(totalCount, 'tool', 'tools') }
    : summary;
  const canExpand = toolCalls.length > 0;

  return (
    <div className="overflow-hidden bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]" data-testid="tool-run-group">
      <button
        type="button"
        onClick={() => { if (canExpand) setUserExpanded(!isExpanded); }}
        className={`flex w-full items-center gap-2 px-3 py-[9px] text-left text-[12.5px] text-fg-3 transition-colors ${canExpand ? 'hover:bg-white/[0.02]' : 'cursor-default'}`}
        aria-expanded={canExpand ? isExpanded : undefined}
        title={trimmedCount > 0 ? 'Details of older tool calls are trimmed from the live view' : undefined}
      >
        {!canExpand ? (
          <span className="h-3 w-3 flex-shrink-0" />
        ) : isExpanded ? (
          <ChevronDown size={12} strokeWidth={2.4} className="flex-shrink-0" />
        ) : (
          <ChevronRight size={12} strokeWidth={2.4} className="flex-shrink-0" />
        )}
        <span className={isLive ? 'text-shimmer font-medium' : 'text-fg-2'}>{verb}</span>
        <span className="min-w-0 truncate">{detail}</span>
        <span className="flex-1" />
        {failed > 0 && (
          <span className="flex-shrink-0 font-mono text-[11px] text-diff-del">{failed} failed</span>
        )}
        {isLive && <Loader2 size={12} strokeWidth={2.4} className="flex-shrink-0 animate-spin text-accent" />}
      </button>
      {isExpanded && canExpand && (
        <div className="flex flex-col pb-1.5">
          {toolCalls.map((toolCall) => {
            const name = normalizeToolCall(toolCall).name;
            if (DIFF_TOOLS.has(name)) {
              // Edit/Write keep their diff card inside the group
              return (
                <div key={toolCall.id} className="px-2 py-1">
                  <ToolCallCard toolCall={toolCall} isStreaming={isLive} onBackground={onBackground} />
                </div>
              );
            }
            return (
              <ToolCallCard
                key={toolCall.id}
                toolCall={toolCall}
                variant="row"
                defaultCollapsed
                isStreaming={isLive}
                onBackground={onBackground}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
