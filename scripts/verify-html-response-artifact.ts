import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { extractHtml, isHtmlResponse } from '../src/renderer/utils/htmlDetector';

const root = path.resolve(__dirname, '..');
const messageBubble = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageBubble.tsx'), 'utf8');
const messageList = fs.readFileSync(path.join(root, 'src/renderer/components/chat/MessageList.tsx'), 'utf8');
const htmlArtifactLink = fs.readFileSync(path.join(root, 'src/renderer/components/chat/HtmlArtifactLink.tsx'), 'utf8');
const htmlArtifactPanel = fs.readFileSync(path.join(root, 'src/renderer/components/preview/HtmlArtifactPanel.tsx'), 'utf8');
const mainContent = fs.readFileSync(path.join(root, 'src/renderer/components/layout/MainContent.tsx'), 'utf8');
const chatContainer = fs.readFileSync(path.join(root, 'src/renderer/components/chat/ChatContainer.tsx'), 'utf8');
const agentView = fs.readFileSync(path.join(root, 'src/renderer/components/agent-view/AgentView.tsx'), 'utf8');
const commandCenterCell = fs.readFileSync(path.join(root, 'src/renderer/components/command-center/CommandCenterCell.tsx'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
const uiStore = fs.readFileSync(path.join(root, 'src/renderer/stores/ui.store.ts'), 'utf8');

const fullDocument = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>ok</body></html>';
const fragment = '<section><h1>Rendered</h1><p>HTML fragment</p></section>';
const fencedFragment = '```html\n<div class="card">Rendered</div>\n```';

assert.equal(isHtmlResponse(fullDocument), true, 'complete HTML documents must still render in default mode');
assert.equal(isHtmlResponse(fragment), false, 'HTML fragments must not render in Markdown mode');
assert.equal(isHtmlResponse(fragment, { allowFragment: true }), true, 'HTML mode must render HTML fragments');
assert.equal(isHtmlResponse(fencedFragment, { allowFragment: true }), true, 'HTML mode must render fenced HTML fragments');
assert.equal(extractHtml(fencedFragment), '<div class="card">Rendered</div>', 'HTML extraction must unwrap fenced HTML');

assert.match(
  messageBubble,
  /renderHtmlResponse\?: boolean/,
  'MessageBubble must accept the per-session HTML render flag',
);
assert.match(
  messageBubble,
  /getRenderedBlockText\(message\.contentBlocks\)/,
  'MessageBubble must assemble text blocks before deciding whether to render HTML',
);
assert.match(
  messageBubble,
  /shouldRenderAssistantTextAsHtml[\s\S]*?isHtmlResponse\(assistantTextContent, \{ allowFragment: true \}\)/,
  'MessageBubble must detect HTML-mode responses from the assembled assistant text',
);
assert.match(
  messageBubble,
  /key="html-response-artifact"[\s\S]*?html=\{extractHtml\(assistantTextContent\)\}/,
  'MessageBubble must expose completed HTML-mode responses as an HTML artifact',
);
assert.match(
  messageBubble,
  /<HtmlArtifactLink/,
  'MessageBubble must use the sidebar HTML artifact launcher',
);
assert.doesNotMatch(
  messageBubble,
  /<HtmlContentBlock/,
  'MessageBubble must not render HTML iframes inline',
);

assert.match(
  messageList,
  /sessionId\?: string/,
  'MessageList must receive the displayed session id',
);
assert.match(
  messageList,
  /renderHtmlResponse=\{renderHtmlResponse\}/,
  'MessageList must pass HTML mode into MessageBubble',
);
assert.match(
  messageList,
  /isHtmlResponse\(event\.content, \{ allowFragment: true \}\)/,
  'MessageList must render live streamed HTML-mode text through the HTML detector',
);
assert.match(
  messageList,
  /<HtmlArtifactLink[\s\S]*?html=\{extractHtml\(event\.content\)\}/,
  'MessageList must route live HTML-mode text to the sidebar artifact launcher',
);
assert.doesNotMatch(
  messageList,
  /<HtmlContentBlock/,
  'MessageList must not render live HTML iframes inline',
);

assert.match(
  htmlArtifactLink,
  /setHtmlArtifact\(sessionId/,
  'HtmlArtifactLink must store the response in the per-session HTML artifact state',
);
assert.match(
  htmlArtifactLink,
  /autoOpen[\s\S]*?openArtifact/,
  'HtmlArtifactLink must auto-open latest or streaming HTML artifacts',
);
assert.match(
  htmlArtifactPanel,
  /sessionHtmlArtifacts\[sessionId\]/,
  'HtmlArtifactPanel must read the current session artifact',
);
assert.match(
  htmlArtifactPanel,
  /<iframe[\s\S]*?srcDoc=\{srcDoc\}/,
  'HtmlArtifactPanel must render the HTML in the sidebar iframe',
);
assert.match(
  mainContent,
  /isHtmlPanelOpen/,
  'MainContent must include the HTML artifact side panel in layout state',
);
assert.match(
  mainContent,
  /<HtmlArtifactPanel sessionId=\{artifactTargetSessionId\}/,
  'MainContent must render HtmlArtifactPanel in the right-side panel area',
);
assert.match(
  uiStore,
  /isHtmlPanelOpen: boolean/,
  'UI store must track the HTML panel open state',
);
assert.match(
  uiStore,
  /sessionHtmlArtifacts: Record<string, HtmlArtifact>/,
  'UI store must store HTML artifacts per session',
);
assert.match(
  uiStore,
  /setHtmlArtifact: \(sessionId: string/,
  'UI store must expose setHtmlArtifact',
);

assert.match(chatContainer, /<MessageList[\s\S]*?sessionId=\{session\.id\}/, 'ChatContainer must pass sessionId to MessageList');
assert.match(agentView, /<MessageList[\s\S]*?sessionId=\{selectedId \|\| undefined\}/, 'AgentView must pass sessionId to MessageList');
assert.match(commandCenterCell, /<MessageList[\s\S]*?sessionId=\{displayId\}/, 'CommandCenter must pass sessionId to MessageList');

assert.match(
  sessionStore,
  /function collectSessionHtmlRenderModes\(sessions: Session\[\]\): Record<string, 'md' \| 'html'>/,
  'session store must restore persisted HTML render modes',
);
assert.match(
  sessionStore,
  /htmlRenderMode: restoredHtmlRenderMode/,
  'loadSessions must hydrate HTML render mode from persisted sessions',
);
assert.match(
  sessionStore,
  /htmlRenderMode: collectSessionHtmlRenderModes\(sessions\)/,
  'session list refreshes must keep HTML render mode hydrated',
);
assert.match(
  sessionStore,
  /clearHtmlArtifact\(sessionId\)/,
  'deleting a session must clear its HTML artifact',
);

console.log('html response artifact verifier passed');
