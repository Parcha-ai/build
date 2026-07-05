import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { Attachment, SSHConfig } from '../../shared/types';
import { sshService } from './ssh.service';
import { truncateMiddlePreservingTail } from '../../shared/utils/prompt-truncation';

export interface PreparedFileAttachment {
  name: string;
  path: string;
  sizeBytes: number;
  preview: string;
}

export interface PreparedFileAttachmentAssets {
  files: PreparedFileAttachment[];
  promptBlock: string;
  cleanup: () => Promise<void>;
}

const FILE_PREVIEW_CHAR_LIMIT = 24_000;
const FILE_PROMPT_CHAR_LIMIT = 80_000;

export function hasFileAttachments(attachments?: Attachment[]): boolean {
  return !!attachments?.some((attachment) => attachment.type === 'file' && attachment.content);
}

function sanitizeFileName(name: string, fallback: string): string {
  const base = path.basename(name || fallback).replace(/[^A-Za-z0-9._-]+/g, '_');
  const cleaned = base.replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function safeSessionSegment(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24) || 'session';
}

function decodeAttachmentContent(attachment: Attachment): Buffer {
  const content = attachment.content || '';
  const dataUrl = content.match(/^data:[^;]+;base64,(.*)$/s);
  if (dataUrl) return Buffer.from(dataUrl[1], 'base64');
  if (attachment.metadata?.encoding === 'base64') return Buffer.from(content, 'base64');
  return Buffer.from(content, 'utf8');
}

function contentPreview(buffer: Buffer): string {
  const text = buffer.toString('utf8').replace(/\u0000/g, '');
  return text.length > FILE_PREVIEW_CHAR_LIMIT
    ? truncateMiddlePreservingTail(text, FILE_PREVIEW_CHAR_LIMIT, {
      marker: '\n\n[... attached file preview truncated; read the file path for full contents ...]\n\n',
      tailRatio: 0.35,
    })
    : text;
}

function formatPromptBlock(files: PreparedFileAttachment[]): string {
  if (files.length === 0) return '';

  const blocks = files.map((file, index) => [
    `<attached-file index="${index + 1}" name="${file.name}">`,
    `Path: ${file.path}`,
    `Size: ${file.sizeBytes} bytes`,
    'Preview:',
    file.preview,
    '</attached-file>',
  ].join('\n'));

  const prompt = [
    '<attached-files>',
    'The user attached these file(s) for the current turn. They are real files available to the active agent at the paths below. Treat them as user input for the current request. If the visible message is empty or only file context, continue from the latest session task using these files instead of asking the user to restate the task.',
    blocks.join('\n\n'),
    '</attached-files>',
  ].join('\n\n');

  return prompt.length > FILE_PROMPT_CHAR_LIMIT
    ? truncateMiddlePreservingTail(prompt, FILE_PROMPT_CHAR_LIMIT, {
      marker: '\n\n[... attached file prompt truncated; read the file paths above for full contents ...]\n\n',
      tailRatio: 0.35,
    })
    : prompt;
}

function escapeShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\\''");
}

async function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp));
  });
}

async function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve());
  });
}

async function execRemoteCommand(client: Client, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      let stderr = '';
      channel.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      channel.on('close', (code: number | null) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(stderr.trim() || `Remote command failed with exit code ${code}`));
      });
      channel.resume();
    });
  });
}

async function prepareLocalFiles(
  sessionId: string,
  attachments: Attachment[],
  workingDir: string,
): Promise<{ files: PreparedFileAttachment[]; localDir: string }> {
  const fileAttachments = attachments.filter((attachment) => attachment.type === 'file' && attachment.content);
  const baseDir = fs.existsSync(workingDir)
    ? path.join(workingDir, '.build', 'attachments', safeSessionSegment(sessionId), String(Date.now()))
    : path.join(os.tmpdir(), `build-attachments-${safeSessionSegment(sessionId)}-${Date.now()}`);
  await fs.promises.mkdir(baseDir, { recursive: true });

  const files: PreparedFileAttachment[] = [];
  for (const [index, attachment] of fileAttachments.entries()) {
    const fileName = sanitizeFileName(attachment.name, `attachment-${index + 1}.txt`);
    const filePath = path.join(baseDir, fileName);
    const buffer = decodeAttachmentContent(attachment);
    await fs.promises.writeFile(filePath, buffer);
    files.push({
      name: fileName,
      path: filePath,
      sizeBytes: buffer.byteLength,
      preview: contentPreview(buffer),
    });
  }

  return { files, localDir: baseDir };
}

export async function prepareFileAttachmentsForHarness(
  sessionId: string,
  attachments: Attachment[] | undefined,
  workingDir: string,
  sshConfig?: SSHConfig,
): Promise<PreparedFileAttachmentAssets> {
  const noop = async () => undefined;
  if (!hasFileAttachments(attachments)) return { files: [], promptBlock: '', cleanup: noop };

  const local = await prepareLocalFiles(sessionId, attachments || [], workingDir);

  if (!sshConfig) {
    return {
      files: local.files,
      promptBlock: formatPromptBlock(local.files),
      cleanup: noop,
    };
  }

  const remoteBase = workingDir
    ? `${workingDir.replace(/\/+$/g, '')}/.build/attachments/${safeSessionSegment(sessionId)}/${Date.now()}`
    : `/tmp/build-attachments-${safeSessionSegment(sessionId)}-${Date.now()}`;

  const client = await sshService.getConnectionForCodex(sessionId, sshConfig);
  await execRemoteCommand(client, `mkdir -p '${escapeShellSingleQuoted(remoteBase)}'`);
  const sftp = await getSftp(client);

  const remoteFiles: PreparedFileAttachment[] = [];
  try {
    for (const file of local.files) {
      const remotePath = `${remoteBase}/${sanitizeFileName(file.name, 'attachment.txt')}`;
      await fastPut(sftp, file.path, remotePath);
      remoteFiles.push({ ...file, path: remotePath });
    }
  } finally {
    try { sftp.end(); } catch { /* ignore */ }
    await fs.promises.rm(local.localDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    files: remoteFiles,
    promptBlock: formatPromptBlock(remoteFiles),
    cleanup: noop,
  };
}
