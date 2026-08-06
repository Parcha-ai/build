import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const monitorBlock = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MonitorBlock.tsx'), 'utf8');

const listenerStart = claudeService.indexOf('private startBackgroundTaskListener(');
const listenerEnd = claudeService.indexOf('\n  /**', listenerStart);
const listener = listenerStart >= 0 && listenerEnd > listenerStart
  ? claudeService.slice(listenerStart, listenerEnd)
  : '';

assert.ok(listener, 'must find the background SDK task listener');
assert.match(
  listener,
  /const taskSubtypes = new Set\(\['notification', 'task_updated', 'task_notification', 'task_progress', 'task_started', 'background_tasks_changed'\]\);/,
  'background listener must subscribe to SDK notification events from Monitor',
);

const msgIndex = listener.indexOf('const msg = result.value;');
const systemDispatchIndex = listener.indexOf("if (msg.type === 'system')", msgIndex);
const nextAfterMessageIndex = listener.indexOf('result = await iterator.next();', msgIndex + 1);

assert.ok(msgIndex >= 0, 'background listener must read the current SDK message');
assert.ok(systemDispatchIndex > msgIndex, 'background listener must inspect the current message');
assert.ok(
  nextAfterMessageIndex > systemDispatchIndex,
  'background listener must dispatch the current monitor event before waiting for the next SDK event',
);

assert.match(
  listener,
  /this\.forwardTaskSystemMessage\(sessionId, systemMsg\)/,
  'background listener must route current system monitor events through task forwarding',
);
assert.match(
  listener,
  /this\.forwardTaskSystemMessage\(sessionId, msg\)/,
  'background listener must route current non-system monitor events through task forwarding',
);

const forwardStart = claudeService.indexOf('private forwardTaskSystemMessage(');
const forwardEnd = claudeService.indexOf('\n  /**\n   * Continue reading the SDK message iterator', forwardStart);
const forwarder = forwardStart >= 0 && forwardEnd > forwardStart
  ? claudeService.slice(forwardStart, forwardEnd)
  : '';

assert.ok(forwarder, 'must find task system message forwarding helper');
assert.match(forwarder, /subtype === 'notification'/, 'task forwarding must handle Monitor notification events');
assert.match(forwarder, /IPC_CHANNELS\.CLAUDE_TASK_PROGRESS/, 'Monitor notifications must route to task-progress IPC');
assert.match(forwarder, /taskId: raw\.key/, 'Monitor notification key must be used as the monitor id');
assert.match(forwarder, /description: raw\.text/, 'Monitor notification text must be forwarded as progress text');
assert.match(forwarder, /subtype === 'task_progress'/, 'task forwarding must handle progress events');
assert.match(forwarder, /subtype === 'task_updated'/, 'task forwarding must handle update events');
assert.match(forwarder, /subtype === 'background_tasks_changed'/, 'task forwarding must handle authoritative task snapshots');
assert.match(forwarder, /raw\.tasks \|\| \[\]/, 'task snapshots must rebuild active state from the full SDK task list');
assert.match(forwarder, /activeParentBlockingTasks/, 'task forwarding must track work that blocks parent completion');
assert.match(forwarder, /raw\.task_type === 'local_agent'/, 'delegated agents must hold the parent turn open');
assert.match(
  forwarder,
  /raw\.task_type === 'local_bash'/,
  'background Bash commands must hold the parent turn open so test suites are not killed after a status-only result',
);
assert.match(
  forwarder,
  /\['completed', 'failed', 'killed', 'cancelled', 'stopped'\]/,
  'every terminal task state must release the parent-turn completion guard',
);
assert.match(
  claudeService,
  /Deferring terminal result[\s\S]*background task\(s\) still running/,
  'a parent result must not finalize while delegated agents or background commands are still running',
);
assert.match(
  claudeService,
  /Background work finished[\s\S]*continuing the parent turn for synthesis/,
  'the parent must resume after background work instead of emitting a status-only handoff',
);
assert.match(
  claudeService,
  /All delegated agents and background commands have finished[\s\S]*Do not return another status-only handoff/,
  'the resumed parent must be told to inspect results and complete the original workflow',
);
assert.match(
  claudeService,
  /cancelQuery\(sessionId: string\)[\s\S]*activeParentBlockingTasks\.delete\(sessionId\)/,
  'explicit cancellation must clear parent-blocking task state',
);
assert.doesNotMatch(
  claudeService,
  /yield \{ type: 'error', error: 'No recoverable remote Claude turn was found/,
  'a reattach race with a completed bridge must not surface as a user-facing chat error',
);

assert.match(
  claudeService,
  /default:[\s\S]*this\.forwardTaskSystemMessage\(sessionId, msg\)/,
  'foreground Monitor notifications must also route through task forwarding',
);

assert.match(
  preload,
  /onTaskProgress:[\s\S]*IPC_CHANNELS\.CLAUDE_TASK_PROGRESS/,
  'preload must expose task-progress IPC to the renderer',
);

const progressSubscription = sessionStore.slice(
  sessionStore.indexOf('const unsubTaskProg = window.electronAPI.claude.onTaskProgress'),
  sessionStore.indexOf('const unsubBrowserPreviewTool', sessionStore.indexOf('const unsubTaskProg = window.electronAPI.claude.onTaskProgress')),
);

assert.match(progressSubscription, /if \(!data\.taskId && !data\.toolUseId\) return;/);
assert.match(progressSubscription, /const monitorId = data\.taskId \|\| data\.toolUseId \|\| 'task';/);
assert.match(progressSubscription, /if \(idx < 0\) \{[\s\S]*id: monitorId,[\s\S]*active: true,/);
assert.match(progressSubscription, /events: \[newEvent\]/, 'renderer must create visible monitor events from progress IPC');
assert.match(sessionStore, /kind: 'monitor'/, 'renderer must tag background shell/task monitors');
assert.match(sessionStore, /kind: 'subagent'/, 'renderer must tag Agent/Task subagents');
assert.match(chatContainer, /const sessionMonitors = useSessionStore/, 'chat container must subscribe to session monitor state');
assert.match(chatContainer, /<MonitorBlock/, 'chat container must expose persistent background work');
assert.match(monitorBlock, /Background agents and monitors/, 'monitor block must expose explicit agents/monitors labeling');
assert.match(monitorBlock, /activeAgentCount/, 'monitor block must count active subagents separately');

console.log('claude monitor notification verifier passed');
