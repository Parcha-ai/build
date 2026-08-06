import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { transcriptService, type TranscriptEntry } from '../src/main/services/transcript.service';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-transcript-performance-'));
const service = transcriptService as unknown as {
  dir: string;
  ensured: boolean;
  upsertMessage: typeof transcriptService.upsertMessage;
  replaceMessages: typeof transcriptService.replaceMessages;
  loadMessages: typeof transcriptService.loadMessages;
  appendMessage: typeof transcriptService.appendMessage;
  hasTranscript: typeof transcriptService.hasTranscript;
  writeInProgressMessage: typeof transcriptService.writeInProgressMessage;
  clearInProgressMessage: typeof transcriptService.clearInProgressMessage;
};
service.dir = tempDir;
service.ensured = false;

const sessionId = 'snapshot-performance';
const content = 'Recovered assistant output '.repeat(30);
const existing: TranscriptEntry = {
  id: 'canonical-assistant-id',
  role: 'assistant',
  content,
  timestamp: new Date().toISOString(),
  harness: 'claude',
};

try {
  service.replaceMessages(sessionId, [existing]);

  const duplicate = service.upsertMessage(sessionId, {
    ...existing,
    id: 'recovered-job-id',
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.canonicalId, existing.id);
  assert.equal(service.loadMessages(sessionId).length, 1);

  const extended = service.upsertMessage(sessionId, {
    ...existing,
    id: 'recovered-job-id',
    content: `${content}\nNew recovered tail`,
  });
  assert.equal(extended.changed, true);
  assert.equal(extended.canonicalId, existing.id);
  assert.equal(service.loadMessages(sessionId)[0]?.id, existing.id);
  assert.match(service.loadMessages(sessionId)[0]?.content || '', /New recovered tail/);

  const sidecarSessionId = 'sidecar-recovery';
  const partial: TranscriptEntry = {
    id: 'partial-assistant-id',
    role: 'assistant',
    content: 'Partial response preserved outside the canonical JSONL file.',
    timestamp: new Date().toISOString(),
    harness: 'codex',
  };
  service.writeInProgressMessage(sidecarSessionId, partial);
  assert.equal(service.hasTranscript(sidecarSessionId), true);
  assert.deepEqual(service.loadMessages(sidecarSessionId), [partial]);
  assert.equal(
    fs.existsSync(path.join(tempDir, `${sidecarSessionId}.jsonl`)),
    false,
    'in-progress snapshots must not rewrite the canonical transcript',
  );

  service.appendMessage(sidecarSessionId, {
    id: 'next-user-message',
    role: 'user',
    content: 'Continue',
    timestamp: new Date().toISOString(),
  });
  const promoted = service.loadMessages(sidecarSessionId);
  assert.deepEqual(promoted.map((entry) => entry.id), [partial.id, 'next-user-message']);
  assert.equal(
    fs.existsSync(path.join(tempDir, `${sidecarSessionId}.in-progress.json`)),
    false,
    'starting a new user turn must promote and clear the recovery sidecar',
  );

  console.log('transcript snapshot performance verifier passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
