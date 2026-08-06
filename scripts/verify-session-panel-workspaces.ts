import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

declare global {
  interface Window {
    electronAPI: import('../src/main/preload').ElectronAPI;
  }
}

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const uiStore = read('src/renderer/stores/ui.store.ts');
const editorStore = read('src/renderer/stores/editor.store.ts');
const app = read('src/renderer/App.tsx');
const mainContent = read('src/renderer/components/layout/MainContent.tsx');
const sessionStore = read('src/renderer/stores/session.store.ts');

assert.ok(uiStore.includes("const SESSION_PANEL_STATES_KEY = 'grep-session-panel-states-v1'"));
assert.ok(uiStore.includes('sessionPanelStates: Record<string, SessionPanelState>'));
assert.ok(uiStore.includes('setActivePanelSession: (sessionId: string | null) => void'));
assert.ok(uiStore.includes('patchSessionPanelState(state, sessionId'));
assert.ok(uiStore.includes('[state.activePanelSessionId]: currentPanelState'));
assert.ok(uiStore.includes('panelSplitPercent: number | null'));
assert.ok(uiStore.includes('persistSessionPanelStates(sessionPanelStates)'));

assert.ok(editorStore.includes('sessionWorkspaces: Record<string, EditorWorkspace>'));
assert.ok(editorStore.includes('setActiveSession: (sessionId: string | null) => void'));
assert.ok(editorStore.includes('const activeSessionId = useSessionStore.getState().activeSessionId'));
assert.ok(editorStore.includes('updateEditorWorkspace(state, activeSessionId'));
assert.ok(editorStore.includes('closeEditorForSession: (sessionId: string) => void'));

assert.ok(app.includes('useLayoutEffect(() => {'));
assert.ok(app.includes('setActivePanelSession(activeSessionId)'));
assert.ok(app.includes('setActiveEditorSession(activeSessionId)'));
assert.ok(mainContent.includes('const panelSplitPercent = useUIStore'));
assert.ok(mainContent.includes('setPanelSplitPercent(newRatio)'));
assert.ok(sessionStore.includes('showPlanPanel(request.sessionId)'));
assert.ok(sessionStore.includes('useEditorStore.getState().cleanupSession(sessionId)'));

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

async function verifyRuntimeIsolation(): Promise<void> {
  Object.assign(globalThis, {
    localStorage: new MemoryStorage(),
    window: { electronAPI: undefined },
  });

  const { useUIStore } = await import('../src/renderer/stores/ui.store');
  const ui = useUIStore.getState();
  ui.setActivePanelSession('session-a');
  useUIStore.getState().toggleBrowserPanel();
  useUIStore.getState().setPanelSplitPercent(63);

  useUIStore.getState().setActivePanelSession('session-b');
  assert.strictEqual(useUIStore.getState().isBrowserPanelOpen, false);
  assert.strictEqual(useUIStore.getState().panelSplitPercent, null);

  useUIStore.getState().setPlanContent('session-c', '# Background plan');
  assert.strictEqual(useUIStore.getState().isPlanPanelOpen, false, 'background plan must not hijack visible session B');
  assert.strictEqual(useUIStore.getState().sessionPanelStates['session-c']?.isPlanPanelOpen, true);
  useUIStore.getState().togglePlanPanel();

  useUIStore.getState().setActivePanelSession('session-a');
  assert.strictEqual(useUIStore.getState().isBrowserPanelOpen, true);
  assert.strictEqual(useUIStore.getState().isPlanPanelOpen, false);
  assert.strictEqual(useUIStore.getState().panelSplitPercent, 63);
  useUIStore.getState().setActivePanelSession('session-b');
  assert.strictEqual(useUIStore.getState().isPlanPanelOpen, true);

  const { useEditorStore } = await import('../src/renderer/stores/editor.store');
  useEditorStore.getState().setActiveSession('session-a');
  useEditorStore.getState().openEditor();
  assert.strictEqual(useEditorStore.getState().isEditorOpen, true);
  useEditorStore.getState().setActiveSession('session-b');
  assert.strictEqual(useEditorStore.getState().isEditorOpen, false);
  useEditorStore.getState().setActiveSession('session-a');
  assert.strictEqual(useEditorStore.getState().isEditorOpen, true);
}

void verifyRuntimeIsolation().then(() => {
  console.log('session panel workspace verifier passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
