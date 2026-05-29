import assert from 'assert';
import type { ChatMessage, ToolCall } from '../src/shared/types';
import { buildCrossHarnessContext, formatConversationContext, mergeConversationMessages } from '../src/main/services/codex-context';
import { buildCompletedStreamMessage } from '../src/shared/utils/stream-finalization';
import { buildMissingToolCall, getMessageRenderArtifacts, getUnrenderedMessageContent } from '../src/shared/utils/message-rendering';
import { normalizeToolCall } from '../src/shared/utils/tool-call-transformer';
import { truncateMiddlePreservingTail } from '../src/shared/utils/prompt-truncation';
import {
  fallbackModelForHarness,
  filterInternalPromptEchoes,
  hasRecoverableOutput,
  isCloseContentDuplicate,
  isCloseTimelineDuplicate,
  isInterruptedSafetyNetDuplicate,
  mergeRecoveredStreamMessages,
  normalizeCompletedStreamMessage,
  serializeCompletedStreamMessage,
  withFallbackHarness,
} from '../src/shared/utils/message-recovery';

function message(id: string, role: ChatMessage['role'], content: string, timestamp: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: new Date(timestamp),
    ...extra,
  };
}

function toolCall(partial: Partial<ToolCall> = {}): ToolCall {
  return {
    id: partial.id || 'tool-1',
    name: partial.name || 'Bash',
    input: partial.input || { command: 'true' },
    status: partial.status || 'completed',
    ...partial,
  };
}

const browserTool = normalizeToolCall({
  id: 'browser-1',
  name: 'mcp_browsermcp_browser_navigate',
  input: { url: 'http://localhost:8765/' },
  status: 'success',
});
assert.equal(browserTool.name, 'BrowserNavigate');
assert.equal(browserTool.status, 'completed');
assert.equal(browserTool.input._rawToolName, 'mcp_browsermcp_browser_navigate');

const globTool = normalizeToolCall({
  id: 'glob-1',
  name: 'glob',
  input: { target_directory: '/tmp/project', glob_pattern: '*.tsx' },
  status: 'queued',
});
assert.equal(globTool.name, 'Glob');
assert.equal(globTool.status, 'pending');
assert.equal(globTool.input.path, '/tmp/project');
assert.equal(globTool.input.pattern, '*.tsx');

const listDirectoryTool = normalizeToolCall({
  id: 'ls-1',
  name: 'list_directory',
  input: { path: '/tmp/project' },
  status: 'failed',
});
assert.equal(listDirectoryTool.name, 'Ls');
assert.equal(listDirectoryTool.status, 'error');
assert.equal(listDirectoryTool.input.path, '/tmp/project');

assert.equal(normalizeToolCall({
  id: 'lint-1',
  name: 'readLints',
  input: { paths: ['src/main.ts'] },
  status: 'completed',
}).name, 'Lint');
assert.equal(normalizeToolCall({
  id: 'image-1',
  name: 'generateImage',
  input: { description: 'hero background' },
  status: 'completed',
}).name, 'GenerateImage');
assert.equal(normalizeToolCall({
  id: 'screen-1',
  name: 'recordScreen',
  input: { mode: 'START_RECORDING' },
  status: 'completed',
}).name, 'RecordScreen');

const recovered = message('assistant-1', 'assistant', 'Recovered Cursor answer', '2026-05-24T01:00:02.000Z');
const attributed = withFallbackHarness(recovered, 'cursor:composer-2.5');
assert.equal(attributed.harness, 'cursor');
assert.equal(withFallbackHarness({ ...recovered, harness: 'gemini' }, 'cursor:composer-2.5').harness, 'gemini');
assert.equal(withFallbackHarness(recovered, 'codex:gpt-5.5').harness, 'codex');
assert.equal(withFallbackHarness(recovered, 'gemini:gemini-3.5-flash').harness, 'gemini');
assert.equal(withFallbackHarness(recovered, 'opencode:qwen').harness, 'opencode');
assert.equal(withFallbackHarness(recovered, 'custom:local-router').harness, 'custom');
assert.equal(withFallbackHarness({ ...recovered, harness: 'custom' }, 'claude-3-5-sonnet').harness, 'custom');
assert.equal(fallbackModelForHarness('auto', 'cursor:composer-2.5'), 'cursor:composer-2.5');
assert.equal(withFallbackHarness(recovered, 'auto', 'cursor:composer-2.5').harness, 'cursor');
assert.equal(withFallbackHarness(recovered, 'auto', 'codex:gpt-5.5').harness, 'codex');
assert.equal(withFallbackHarness({ ...recovered, harness: 'claude' }, 'auto', 'cursor:composer-2.5').harness, 'cursor');

const serialized = serializeCompletedStreamMessage(attributed);
const normalized = normalizeCompletedStreamMessage(serialized);
assert(normalized);
assert(normalized.timestamp instanceof Date);
assert.equal(normalized.harness, 'cursor');

const transcript = [
  message('user-1', 'user', 'do it', '2026-05-24T01:00:00.000Z'),
  message('assistant-transcript', 'assistant', 'Claude answer', '2026-05-24T01:00:01.000Z', { harness: 'claude' }),
];
const merged = mergeRecoveredStreamMessages(transcript, [attributed]);
assert.deepEqual(merged.map((m) => m.id), ['user-1', 'assistant-transcript', 'assistant-1']);
assert.equal(merged[2].harness, 'cursor');

const duplicateById = mergeRecoveredStreamMessages(transcript, [{ ...transcript[1], harness: 'claude' }]);
assert.deepEqual(duplicateById.map((m) => m.id), ['user-1', 'assistant-transcript']);

const duplicateByContent = mergeRecoveredStreamMessages(transcript, [
  message('assistant-close-duplicate', 'assistant', 'Claude answer', '2026-05-24T01:00:30.000Z', { harness: 'claude' }),
]);
assert.deepEqual(duplicateByContent.map((m) => m.id), ['user-1', 'assistant-transcript']);

const duplicateByContentWithBlocks = mergeRecoveredStreamMessages(transcript, [
  message('assistant-close-duplicate-with-blocks', 'assistant', 'Claude answer', '2026-05-24T01:00:02.000Z', {
    harness: 'claude',
    contentBlocks: [{ type: 'text', text: 'Claude answer' }],
  }),
]);
assert.deepEqual(duplicateByContentWithBlocks.map((m) => m.id), ['user-1', 'assistant-transcript']);
assert.deepEqual(duplicateByContentWithBlocks[1].contentBlocks, [{ type: 'text', text: 'Claude answer' }]);

const sameContentDifferentHarness = mergeRecoveredStreamMessages(transcript, [
  message('assistant-same-content-cursor', 'assistant', 'Claude answer', '2026-05-24T01:00:30.000Z', { harness: 'cursor' }),
]);
assert.deepEqual(sameContentDifferentHarness.map((m) => m.id), ['user-1', 'assistant-transcript', 'assistant-same-content-cursor']);
assert.equal(isCloseTimelineDuplicate(
  message('same-content-claude', 'assistant', 'Done', '2026-05-24T01:00:00.000Z', { harness: 'claude' }),
  message('same-content-cursor', 'assistant', 'Done', '2026-05-24T01:00:01.000Z', { harness: 'cursor' }),
), false);
assert.equal(isCloseContentDuplicate(
  message('same-turn-transcript', 'assistant', 'Done', '2026-05-24T01:00:00.000Z', { harness: 'claude' }),
  message('same-turn-stream-final', 'assistant', 'Done', '2026-05-24T01:00:01.000Z', {
    harness: 'claude',
    contentBlocks: [{ type: 'text', text: 'Done' }],
  }),
), true);
assert.equal(isCloseContentDuplicate(
  message('separate-turn-1', 'assistant', 'Done', '2026-05-24T01:00:00.000Z', { harness: 'claude' }),
  message('separate-turn-2', 'assistant', 'Done', '2026-05-24T01:00:10.000Z', { harness: 'claude' }),
), false);

const toolOnlyRecovered = message('tool-only', 'assistant', '', '2026-05-24T01:01:00.000Z', {
  harness: 'cursor',
  toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
  contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
});
assert.equal(hasRecoverableOutput(toolOnlyRecovered), true);

const contentBlockOnlyRecovered = message('block-only', 'assistant', '', '2026-05-24T01:01:05.000Z', {
  harness: 'cursor',
  contentBlocks: [{ type: 'text', text: 'Final text only appeared in content blocks' }],
});
assert.equal(hasRecoverableOutput(contentBlockOnlyRecovered), true);

const duplicateToolOnly = mergeRecoveredStreamMessages([toolOnlyRecovered], [
  message('tool-only-copy', 'assistant', '', '2026-05-24T01:01:10.000Z', {
    harness: 'cursor',
    toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
    contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
  }),
]);
assert.deepEqual(duplicateToolOnly.map((m) => m.id), ['tool-only']);
assert.equal(isCloseTimelineDuplicate(
  message('empty-primary', 'assistant', '', '2026-05-24T01:01:02.000Z'),
  toolOnlyRecovered,
), false);
assert.equal(isCloseTimelineDuplicate(
  toolOnlyRecovered,
  message('tool-only-copy', 'assistant', '', '2026-05-24T01:01:10.000Z', {
    harness: 'cursor',
    toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
    contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
  }),
), true);
assert.equal(isCloseTimelineDuplicate(
  message('partial-error-rendered', 'assistant', '', '2026-05-24T01:01:09.000Z', {
    harness: 'cursor',
    interrupted: true,
    toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
    contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
  }),
  message('safety-net-final', 'assistant', '', '2026-05-24T01:01:10.000Z', {
    harness: 'cursor',
    toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
    contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
  }),
), true);
const interruptedPartial = message('partial-error-rendered', 'assistant', '', '2026-05-24T01:01:09.000Z', {
  harness: 'cursor',
  interrupted: true,
  toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
  contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
});
const interruptedSafetyNetFinal = message('safety-net-final-interrupted', 'assistant', '', '2026-05-24T01:01:10.000Z', {
  harness: 'cursor',
  interrupted: true,
  toolCalls: [toolCall({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } })],
  contentBlocks: [{ type: 'tool_use', toolCallId: 'read-1' }],
});
assert.equal(isInterruptedSafetyNetDuplicate(interruptedPartial, interruptedSafetyNetFinal), true);
assert.equal(isInterruptedSafetyNetDuplicate(interruptedPartial, {
  ...interruptedSafetyNetFinal,
  id: 'ordinary-final',
  interrupted: false,
}), false);
assert.equal(isInterruptedSafetyNetDuplicate(
  message('ordinary-done-1', 'assistant', 'Done', '2026-05-24T01:01:10.000Z', { harness: 'cursor' }),
  message('ordinary-done-2', 'assistant', 'Done', '2026-05-24T01:01:11.000Z', { harness: 'cursor' }),
), false);
assert.equal(isCloseTimelineDuplicate(
  toolOnlyRecovered,
  message('different-tool-only', 'assistant', '', '2026-05-24T01:01:10.000Z', {
    harness: 'cursor',
    toolCalls: [toolCall({ id: 'grep-1', name: 'Grep', input: { pattern: 'TODO' } })],
    contentBlocks: [{ type: 'tool_use', toolCallId: 'grep-1' }],
  }),
), false);

const duplicateContentBlocks = mergeRecoveredStreamMessages([contentBlockOnlyRecovered], [
  message('block-only-copy', 'assistant', '', '2026-05-24T01:01:15.000Z', {
    harness: 'cursor',
    contentBlocks: [{ type: 'text', text: 'Final text only appeared in content blocks' }],
  }),
]);
assert.deepEqual(duplicateContentBlocks.map((m) => m.id), ['block-only']);

const mergedConversation = mergeConversationMessages([
  message('empty-transcript-assistant', 'assistant', '', '2026-05-24T01:01:02.000Z'),
], [toolOnlyRecovered]);
assert.deepEqual(mergedConversation.map((m) => m.id), ['tool-only', 'empty-transcript-assistant']);

const blockOnlyContext = formatConversationContext([contentBlockOnlyRecovered], 10_000);
assert(blockOnlyContext.includes('Final text only appeared in content blocks'));

const toolOnlyCrossHarnessContext = buildCrossHarnessContext([
  message('user-before-tool-only', 'user', 'inspect README', '2026-05-24T01:00:55.000Z', { harness: 'claude' }),
], [toolOnlyRecovered], 'claude');
assert(toolOnlyCrossHarnessContext.includes('Read(README.md)'));

const missingToolRefContext = buildCrossHarnessContext([], [
  message('missing-tool-ref', 'assistant', '', '2026-05-24T01:01:20.000Z', {
    harness: 'cursor',
    contentBlocks: [{ type: 'tool_use', toolCallId: 'lost-tool-1' }],
  }),
], 'claude');
assert(missingToolRefContext.includes('Tool refs without metadata: lost-tool-1'));

const limited = mergeRecoveredStreamMessages(transcript, [attributed, toolOnlyRecovered], 2);
assert.deepEqual(limited.map((m) => m.id), ['assistant-1', 'tool-only']);

const buildPreferred = mergeRecoveredStreamMessages([
  message('build-canonical', 'assistant', 'same visible output', '2026-05-24T01:01:00.000Z', { harness: 'codex' }),
], [
  message('claude-backfill', 'assistant', 'same visible output', '2026-05-24T01:01:01.000Z', { harness: 'codex' }),
]);
assert.deepEqual(buildPreferred.map((m) => m.id), ['build-canonical']);

const filteredInternalGoals = filterInternalPromptEchoes([
  message('visible-user-goal', 'user', 'prioritize the urgent tickets', '2026-05-24T01:01:00.000Z'),
  message('internal-goal-echo', 'user', '/goal prioritize the urgent tickets', '2026-05-24T01:01:20.000Z'),
  message('explicit-goal', 'user', '/goal handle a different objective', '2026-05-24T01:02:00.000Z'),
]);
assert.deepEqual(filteredInternalGoals.map((m) => m.id), ['visible-user-goal', 'explicit-goal']);

const completedFromStream = buildCompletedStreamMessage({
  content: 'streamed text',
  toolCalls: [toolCall({ id: 'bash-1', name: 'Bash' })],
  contentBlocks: [
    { type: 'tool_use', toolCallId: 'bash-1' },
    { type: 'text', text: 'streamed text' },
  ],
  model: 'cursor:composer-2.5',
  fallbackId: 'stream-final',
  timestamp: new Date('2026-05-24T01:02:00.000Z'),
});
assert.equal(completedFromStream.id, 'stream-final');
assert.equal(completedFromStream.content, 'streamed text');
assert.equal(completedFromStream.harness, 'cursor');
assert.equal(completedFromStream.toolCalls?.length, 1);
assert.deepEqual(completedFromStream.contentBlocks?.map((block) => block.type), ['tool_use', 'text']);

const completedFromBackendMessage = buildCompletedStreamMessage({
  message: message('backend-final', 'assistant', '', '2026-05-24T01:03:00.000Z', {
    harness: 'claude',
    contentBlocks: [{ type: 'text', text: 'backend block text' }],
  }),
  content: 'streamed fallback content',
  toolCalls: [toolCall({ id: 'glob-2', name: 'Glob' })],
  contentBlocks: [{ type: 'tool_use', toolCallId: 'glob-2' }],
  model: 'auto',
  resolvedModel: 'gemini:gemini-3.5-flash',
});
assert.equal(completedFromBackendMessage.content, 'streamed fallback content');
assert.equal(completedFromBackendMessage.harness, 'gemini');
assert.equal(completedFromBackendMessage.toolCalls?.[0]?.name, 'Glob');
assert.deepEqual(completedFromBackendMessage.contentBlocks?.map((block) => block.type), ['tool_use', 'text']);

const completedWithFullerStreamContent = buildCompletedStreamMessage({
  message: message('backend-partial-content', 'assistant', 'Final', '2026-05-24T01:03:10.000Z', {
    harness: 'cursor',
  }),
  content: 'Final answer that fully streamed before completion.',
  model: 'cursor:composer-2.5',
});
assert.equal(completedWithFullerStreamContent.content, 'Final answer that fully streamed before completion.');

const completedWithFullerBackendContent = buildCompletedStreamMessage({
  message: message('backend-full-content', 'assistant', 'Final answer that arrived in the terminal message.', '2026-05-24T01:03:15.000Z', {
    harness: 'cursor',
  }),
  content: 'Final answer',
  model: 'cursor:composer-2.5',
});
assert.equal(completedWithFullerBackendContent.content, 'Final answer that arrived in the terminal message.');

const completedFromCustomBackend = buildCompletedStreamMessage({
  message: message('openclaw-final', 'assistant', 'gateway text', '2026-05-24T01:03:30.000Z', {
    harness: 'custom',
  }),
  content: '',
  model: 'claude-3-5-sonnet',
  resolvedModel: 'custom:openclaw',
});
assert.equal(completedFromCustomBackend.harness, 'custom');

const completedFromAutoSafetyNet = buildCompletedStreamMessage({
  content: '',
  toolCalls: [toolCall({ id: 'auto-safety-tool', name: 'Read', input: { file_path: 'route.ts' } })],
  contentBlocks: [{ type: 'tool_use', toolCallId: 'auto-safety-tool' }],
  model: 'auto',
  resolvedModel: 'cursor:composer-2.5',
});
assert.equal(completedFromAutoSafetyNet.harness, 'cursor');
assert.equal(completedFromAutoSafetyNet.toolCalls?.[0]?.id, 'auto-safety-tool');

const completedWithPartialBackendArtifacts = buildCompletedStreamMessage({
  message: message('partial-backend', 'assistant', 'backend text', '2026-05-24T01:03:45.000Z', {
    harness: 'cursor',
    toolCalls: [toolCall({ id: 'backend-tool', name: 'Read', input: { file_path: 'backend.ts' } })],
    contentBlocks: [{ type: 'text', text: 'backend text' }],
  }),
  content: 'stream text',
  toolCalls: [
    toolCall({ id: 'stream-tool', name: 'Grep', input: { pattern: 'lost' } }),
    toolCall({ id: 'backend-tool', name: 'Tool', input: {}, result: 'stream result' }),
  ],
  contentBlocks: [
    { type: 'tool_use', toolCallId: 'stream-tool' },
    { type: 'tool_use', toolCallId: 'backend-tool' },
  ],
  model: 'cursor:composer-2.5',
});
assert.deepEqual(completedWithPartialBackendArtifacts.toolCalls?.map((tool) => tool.id), ['stream-tool', 'backend-tool']);
assert.equal(completedWithPartialBackendArtifacts.toolCalls?.find((tool) => tool.id === 'backend-tool')?.input.file_path, 'backend.ts');
assert.equal(completedWithPartialBackendArtifacts.toolCalls?.find((tool) => tool.id === 'backend-tool')?.result, 'stream result');
assert.deepEqual(completedWithPartialBackendArtifacts.contentBlocks?.map((block) => block.type), ['tool_use', 'tool_use', 'text']);

const completedWithEmptyBackendArrays = buildCompletedStreamMessage({
  message: message('empty-backend-arrays', 'assistant', '', '2026-05-24T01:03:50.000Z', {
    harness: 'gemini',
    toolCalls: [],
    contentBlocks: [],
  }),
  content: 'stream-only text',
  toolCalls: [toolCall({ id: 'stream-only-tool', name: 'Glob', input: { pattern: '*.md' } })],
  contentBlocks: [
    { type: 'tool_use', toolCallId: 'stream-only-tool' },
    { type: 'text', text: 'stream-only text' },
  ],
  model: 'gemini:gemini-3.5-flash',
});
assert.equal(completedWithEmptyBackendArrays.content, 'stream-only text');
assert.equal(completedWithEmptyBackendArrays.toolCalls?.[0]?.id, 'stream-only-tool');
assert.deepEqual(completedWithEmptyBackendArrays.contentBlocks?.map((block) => block.type), ['tool_use', 'text']);

const toolOnlyRender = getMessageRenderArtifacts(toolOnlyRecovered);
assert.equal(toolOnlyRender.isToolOnlyMessage, true);
assert.equal(toolOnlyRender.toolOnlySummary, 'Completed 1 tool call without a final text response.');
assert.equal(toolOnlyRender.toolCalls[0]?.id, 'read-1');

const blockTextRender = getMessageRenderArtifacts(message('block-text-with-tool', 'assistant', '', '2026-05-24T01:03:30.000Z', {
  contentBlocks: [
    { type: 'tool_use', toolCallId: 'block-tool' },
    { type: 'text', text: 'Final text came from a content block' },
  ],
  toolCalls: [toolCall({ id: 'block-tool', name: 'Read', input: { file_path: 'src/app.ts' } })],
}));
assert.equal(blockTextRender.isToolOnlyMessage, false);
assert.equal(blockTextRender.toolOnlySummary, '');

const missingMetadataToolOnlyRender = getMessageRenderArtifacts(message('missing-tool-only', 'assistant', '', '2026-05-24T01:03:40.000Z', {
  contentBlocks: [{ type: 'tool_use', toolCallId: 'missing-tool-metadata' }],
}));
assert.equal(missingMetadataToolOnlyRender.isToolOnlyMessage, true);
assert.equal(missingMetadataToolOnlyRender.toolOnlySummary, 'Completed 1 tool call without a final text response.');

const unreferencedToolRender = getMessageRenderArtifacts(message('mixed-block-tools', 'assistant', 'Block text', '2026-05-24T01:04:00.000Z', {
  contentBlocks: [{ type: 'text', text: 'Block text' }],
  toolCalls: [
    toolCall({ id: 'unreferenced-read', name: 'Read', input: { file_path: 'src/app.ts' } }),
    toolCall({ id: 'unreferenced-glob', name: 'Glob', input: { pattern: '*.tsx' } }),
  ],
}));
assert.deepEqual(unreferencedToolRender.unrenderedToolCalls.map((tool) => tool.id), ['unreferenced-read', 'unreferenced-glob']);
assert.equal(unreferencedToolRender.unrenderedMessageContent, '');

const missingToolCall = buildMissingToolCall('missing-render-tool', 'agent-1');
assert.equal(missingToolCall.name, 'Tool');
assert.equal(missingToolCall.agentId, 'agent-1');
assert.equal(missingToolCall.input.toolCallId, 'missing-render-tool');

assert.equal(getUnrenderedMessageContent('Streamed prefix plus final summary', [
  { type: 'text', text: 'Streamed prefix' },
]), 'plus final summary');
assert.equal(getUnrenderedMessageContent('Intro that only exists in raw content\n\nFinal block text', [
  { type: 'text', text: 'Final block text' },
]), 'Intro that only exists in raw content');
assert.equal(getUnrenderedMessageContent('Raw content not represented by blocks', [
  { type: 'text', text: 'Different block text' },
]), 'Raw content not represented by blocks');
assert.equal(getUnrenderedMessageContent('Block text', [
  { type: 'text', text: 'Block text' },
]), '');

const longHarnessPrompt = [
  'PLAN MODE PREAMBLE',
  'old context '.repeat(8000),
  'LATEST USER INSTRUCTION: reply with smoke codex tail marker',
].join('\n\n');
const truncatedHarnessPrompt = truncateMiddlePreservingTail(longHarnessPrompt, 50000);
assert.ok(truncatedHarnessPrompt.length <= 50000);
assert.ok(truncatedHarnessPrompt.includes('PLAN MODE PREAMBLE'));
assert.ok(truncatedHarnessPrompt.includes('LATEST USER INSTRUCTION: reply with smoke codex tail marker'));
assert.ok(truncatedHarnessPrompt.includes('middle truncated'));

console.log('harness message flow verifier passed');
