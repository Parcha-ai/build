import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { calculateVisibleToolbarActions } from '../src/renderer/utils/toolbar-overflow';

const measure = (toolbarWidth: number, primaryWidth: number, pinnedWidth: number): number => (
  calculateVisibleToolbarActions({
    toolbarWidth,
    primaryWidth,
    pinnedWidth,
    actionCount: 6,
    actionWidth: 24,
    gap: 8,
  })
);

assert.equal(measure(1000, 400, 24), 6, 'all secondary actions should remain inline when they fit');
assert.equal(measure(550, 400, 24), 2, 'secondary actions should progressively collapse as width decreases');
assert.equal(measure(470, 400, 24), 0, 'the overflow trigger should replace all secondary actions in a tight pane');
assert.equal(measure(550, 400, 56), 1, 'the pinned stop button should reduce secondary capacity without overflowing');

const inputArea = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/chat/InputArea.tsx'),
  'utf8',
);
assert.match(inputArea, /icon: <Workflow size=\{14\} \/>/, 'Cascade should use a compact workflow icon');
assert.match(inputArea, /data-testid="toolbar-overflow-toggle"/);
assert.match(inputArea, /data-testid="toolbar-pinned-controls"[\s\S]*?<Square/);
assert.match(inputArea, /data-testid="toolbar-pinned-controls"[\s\S]*?<VoiceComposerControl/);
assert.doesNotMatch(inputArea, /<MicrophoneButton/, 'the singleton voice transport must not be owned by a session toolbar');
assert.doesNotMatch(inputArea, />\s*CASCADE\s*</, 'the inline Cascade text pill should be removed');

const statusBar = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/layout/StatusBar.tsx'),
  'utf8',
);
assert.match(statusBar, /<MicrophoneButton \/>/);

const microphoneButton = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/chat/MicrophoneButton.tsx'),
  'utf8',
);
assert.match(microphoneButton, /sessionId: APP_VOICE_SESSION_ID/);
assert.match(microphoneButton, /return null/, 'the singleton voice transport should be headless');

const voiceComposer = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/chat/VoiceComposerControl.tsx'),
  'utf8',
);
assert.match(voiceComposer, /data-testid="app-voice-control"/);
assert.match(voiceComposer, /build-voice-composer-orb/);
assert.match(voiceComposer, /build-voice-composer-bars/);
assert.match(voiceComposer, /new CustomEvent\('grep-voice-toggle'\)/);
assert.doesNotMatch(voiceComposer, /fixed bottom-/);
assert.doesNotMatch(statusBar, /VoiceModeStatusBar/, 'the bottom status-bar listening animation must not be rendered');

console.log('input toolbar overflow verifier passed');
