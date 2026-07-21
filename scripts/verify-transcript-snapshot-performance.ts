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

  console.log('transcript snapshot performance verifier passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
