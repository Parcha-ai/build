import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const monitorBlock = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MonitorBlock.tsx'), 'utf8');

const listenerStart = claudeService.indexOf('private startBackgroundTaskListener(');
const listenerEnd = claudeService.indexOf('\n  /**\n   * Inject a message into an active query', listenerStart);
const listener = listenerStart >= 0 && listenerEnd > listenerStart
  ? claudeService.slice(listenerStart, listenerEnd)
  : '';

assert.ok(listener, 'must find the background SDK task listener');
assert.match(
  listener,
  /const taskSubtypes = new Set\(\['notification', 'task_updated', 'task_notification', 'task_progress', 'task_started'\]\);/,
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
assert.match(inputArea, /const monitorInstances = useSessionStore/, 'input toolbar must subscribe to monitor state');
assert.match(inputArea, /Active background work/, 'input toolbar must expose a persistent background work indicator');
assert.match(inputArea, /activeWorkSummary\.label\} RUNNING/, 'input toolbar must label active agents/monitors as running');
assert.match(monitorBlock, /Background agents and monitors/, 'monitor block must expose explicit agents/monitors labeling');
assert.match(monitorBlock, /activeAgentCount/, 'monitor block must count active subagents separately');

console.log('claude monitor notification verifier passed');
