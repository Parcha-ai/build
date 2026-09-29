import * as assert from 'assert';
import Module from 'module';

class MemoryStore {
  private value: Record<string, unknown>;

  constructor(options?: { defaults?: Record<string, unknown> }) {
    this.value = structuredClone(options?.defaults || {});
  }

  get store(): Record<string, unknown> {
    return structuredClone(this.value);
  }

  set store(value: Record<string, unknown>) {
    this.value = structuredClone(value);
  }
}

const moduleWithLoad = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function load(request, parent, isMain) {
  if (request === 'electron-store') return { __esModule: true, default: MemoryStore };
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoiceMemoryService } = require('../src/main/services/voice-memory.service') as typeof import('../src/main/services/voice-memory.service');
moduleWithLoad._load = originalLoad;

const memory = new VoiceMemoryService();
const first = memory.append({
  role: 'user',
  content: '  Please remember that I prefer concise status updates.  ',
  sessionId: 'session-a',
  sessionName: 'Orb',
  source: 'desktop',
});
assert.ok(first);
assert.strictEqual(first?.content, 'Please remember that I prefer concise status updates.');

const duplicate = memory.append({
  role: 'user',
  content: 'Please remember that I prefer concise status updates.',
  sessionId: 'session-a',
  sessionName: 'Orb',
  source: 'desktop',
});
assert.strictEqual(duplicate?.id, first?.id, 'adjacent duplicate transcripts should be coalesced');

memory.merge([{
  id: 'remote-answer',
  role: 'assistant',
  content: 'I will keep status updates concise.',
  createdAt: '2026-07-26T12:00:00.000Z',
  sessionId: 'session-a',
  sessionName: 'Orb',
  source: 'remote',
}]);
assert.strictEqual(memory.snapshot().entries.length, 2, 'desktop and remote entries should merge by ID');

const prompt = memory.formatForPrompt('session-a');
assert.match(prompt, /DURABLE VOICE MEMORY/);
assert.match(prompt, /prefer concise status updates/);
assert.match(prompt, /I will keep status updates concise/);

for (let index = 0; index < 190; index += 1) {
  memory.merge([{
    id: `bounded-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `bounded memory ${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 26, 13, index)).toISOString(),
    source: 'desktop',
  }]);
}
assert.ok(memory.snapshot().entries.length <= 160, 'durable memory must remain bounded');

console.log('Voice memory verifier passed.');
