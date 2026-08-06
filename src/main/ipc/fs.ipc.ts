import { IpcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { sessionService } from './session.ipc';
import { sshService } from '../services/ssh.service';
import { chatFilePathFromHref } from '../../shared/utils/chat-links';

const FS_DEBUG = process.env.GREP_DEBUG_FS === '1';
function debugFs(...args: unknown[]): void {
  if (FS_DEBUG) console.log(...args);
}

function stripPathLineSuffix(filePath: string): string {
  const match = filePath.match(/^(.+):(\d+)(?::\d+)?$/);
  if (!match) return filePath;
  const basePath = match[1];
  if (!basePath.includes('/') && !basePath.includes('\\')) return filePath;
  return basePath;
}

function resolveFilePathForSession(filePath: string, worktreePath?: string): string {
  const normalized = stripPathLineSuffix(chatFilePathFromHref(filePath));
  if (!worktreePath || path.isAbsolute(normalized)) return normalized;
  return path.resolve(worktreePath, normalized);
}

export interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'folder';
  extension?: string;
}

// Directories to skip when listing files
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '__pycache__',
  '.pytest_cache',
  'dist',
  'build',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'coverage',
  '.cache',
  '.turbo',
]);

async function listFilesRecursive(
  dirPath: string,
  basePath: string,
  maxDepth = 30,  // Deep traversal for complex project structures
  currentDepth = 0
): Promise<FileEntry[]> {
  if (currentDepth >= maxDepth) return [];

  const entries: FileEntry[] = [];

  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      // Skip ignored directories
      if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
      // Skip hidden files (except .env files which are often referenced)
      if (item.name.startsWith('.') && !item.name.startsWith('.env')) continue;

      const fullPath = path.join(dirPath, item.name);
      const relativePath = path.relative(basePath, fullPath);

      if (item.isDirectory()) {
        entries.push({
          name: item.name,
          path: fullPath,
          relativePath,
          type: 'folder',
        });

        // Recurse into subdirectories
        const subEntries = await listFilesRecursive(fullPath, basePath, maxDepth, currentDepth + 1);
        entries.push(...subEntries);
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        // Include all files - no filtering
        entries.push({
          name: item.name,
          path: fullPath,
          relativePath,
          type: 'file',
          extension: ext,
        });
      }
    }
  } catch (error) {
    console.error(`Error listing directory ${dirPath}:`, error);
  }

  return entries;
}

interface SearchMatch {
  lineNumber: number;
  lineContent: string;
}

interface SearchResult {
  filePath: string;
  relativePath: string;
  fileName: string;
  matches: SearchMatch[];
  matchCount: number;
}

function parseGrepOutput(output: string, basePath: string, maxResults: number): SearchResult[] {
  const fileMap = new Map<string, SearchMatch[]>();
  const lines = output.split('\n');
  let totalMatches = 0;

  for (const line of lines) {
    if (totalMatches >= maxResults) break;
    if (!line) continue;

    // grep -n output format: filepath:lineNumber:content
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;

    const [, filePath, lineNumStr, lineContent] = match;
    const lineNumber = parseInt(lineNumStr, 10);
    if (isNaN(lineNumber)) continue;

    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, []);
    }
    fileMap.get(filePath)!.push({ lineNumber, lineContent: lineContent.trimEnd() });
    totalMatches++;
  }

  const results: SearchResult[] = [];
  for (const [filePath, matches] of fileMap) {
    const relativePath = path.relative(basePath, filePath);
    const fileName = path.basename(filePath);
    results.push({ filePath, relativePath, fileName, matches, matchCount: matches.length });
  }

  return results;
}

export function registerFsHandlers(ipcMain: IpcMain): void {
  // List files in session working directory
  ipcMain.handle(IPC_CHANNELS.FS_LIST_FILES, async (_event, sessionId: string, query?: string) => {
    debugFs('[FS] listFiles called for session:', sessionId, 'query:', query);
    const session = await sessionService.getSession(sessionId);
    debugFs('[FS] Session found:', session?.id, 'worktreePath:', session?.worktreePath, 'isSSH:', !!session?.sshConfig);
    if (!session?.worktreePath) {
      debugFs('[FS] No worktreePath - returning empty array');
      return [];
    }

    // Check if this is an SSH session
    if (session.sshConfig) {
      debugFs('[FS] SSH session detected - using remote file listing');
      try {
        const files = await sshService.listRemoteFilesRecursive(
          sessionId,
          session.sshConfig,
          session.worktreePath,
          session.worktreePath
        );
        debugFs('[FS] Found', files.length, 'remote files');

        // Filter by query if provided
        if (query && query.trim()) {
          const lowerQuery = query.toLowerCase();
          return files.filter(
            (f) =>
              f.name.toLowerCase().includes(lowerQuery) ||
              f.relativePath.toLowerCase().includes(lowerQuery)
          ).slice(0, 50);
        }

        return files;
      } catch (error) {
        console.error('[FS] Failed to list remote files:', error);
        return [];
      }
    }

    // Local file listing
    const files = await listFilesRecursive(session.worktreePath, session.worktreePath);
    debugFs('[FS] Found', files.length, 'local files');

    // Filter by query if provided
    if (query && query.trim()) {
      const lowerQuery = query.toLowerCase();
      return files.filter(
        (f) =>
          f.name.toLowerCase().includes(lowerQuery) ||
          f.relativePath.toLowerCase().includes(lowerQuery)
      ).slice(0, 50); // Limit filtered results
    }

    // Return all files (the UI will handle filtering)
    return files;
  });

  // Read file content - supports both local and SSH sessions
  ipcMain.handle(IPC_CHANNELS.FS_READ_FILE, async (_event, filePath: string, sessionId?: string) => {
    debugFs('[FS] FS_READ_FILE called, filePath:', filePath, 'sessionId:', sessionId);
    try {
      const session = sessionId ? await sessionService.getSession(sessionId) : undefined;
      const normalizedFilePath = resolveFilePathForSession(filePath, session?.worktreePath);
      if (sessionId) {
        debugFs('[FS] Session found:', !!session, 'has sshConfig:', !!session?.sshConfig);
        if (session?.sshConfig) {
          debugFs('[FS] Reading file from SSH session:', normalizedFilePath);
          const remoteContent = await sshService.readRemoteFile(sessionId, session.sshConfig, normalizedFilePath);
          debugFs('[FS] SSH read successful, content length:', remoteContent.length);
          return { success: true, content: remoteContent };
        }
      }

      // Local file read
      debugFs('[FS] Reading local file:', normalizedFilePath);
      // Read images as base64, everything else as UTF-8
      const isImage = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(normalizedFilePath);
      if (isImage) {
        const buffer = await fs.readFile(normalizedFilePath);
        const base64 = buffer.toString('base64');
        const ext = normalizedFilePath.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'svg' ? 'svg+xml' : ext === 'jpg' ? 'jpeg' : ext;
        return { success: true, content: `data:image/${mime};base64,${base64}` };
      }
      const content = await fs.readFile(normalizedFilePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      console.error('[FS] Read file error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Open generated artifacts in the host OS. Resolve relative Markdown links
  // against the session worktree instead of Electron's process cwd.
  ipcMain.handle(IPC_CHANNELS.FS_OPEN_PATH, async (_event, filePath: string, sessionId?: string) => {
    try {
      const session = sessionId ? await sessionService.getSession(sessionId) : undefined;
      const resolvedPath = resolveFilePathForSession(filePath, session?.worktreePath);
      if (session?.sshConfig) {
        const fingerprint = createHash('sha256')
          .update(`${session.id}\0${resolvedPath}`)
          .digest('hex')
          .slice(0, 16);
        const safeSessionId = session.id.replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeName = path.basename(resolvedPath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'artifact';
        const localPath = path.join(os.tmpdir(), 'claudette-artifacts', safeSessionId, `${fingerprint}-${safeName}`);
        await sshService.downloadRemoteFile(session.id, session.sshConfig, resolvedPath, localPath);
        const error = await shell.openPath(localPath);
        return error
          ? { success: false, path: localPath, error }
          : { success: true, path: localPath };
      }
      const error = await shell.openPath(resolvedPath);
      return error
        ? { success: false, path: resolvedPath, error }
        : { success: true, path: resolvedPath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Write file content (creates parent directories if needed) - supports SSH sessions via sessionId
  ipcMain.handle(IPC_CHANNELS.FS_WRITE_FILE, async (_event, filePath: string, content: string, sessionId?: string) => {
    debugFs('[FS] FS_WRITE_FILE called, filePath:', filePath, 'sessionId:', sessionId);
    try {
      const session = sessionId ? await sessionService.getSession(sessionId) : undefined;
      const normalizedFilePath = resolveFilePathForSession(filePath, session?.worktreePath);
      if (sessionId) {
        debugFs('[FS] Session found:', !!session, 'has sshConfig:', !!session?.sshConfig);
        if (session?.sshConfig) {
          debugFs('[FS] Writing file to remote SSH session:', normalizedFilePath);
          await sshService.writeRemoteFile(sessionId, session.sshConfig, normalizedFilePath, content);
          debugFs('[FS] Remote write successful');
          return { success: true };
        }
      }

      // Local file write — validate path is within session's worktree
      const resolvedPath = path.resolve(normalizedFilePath);
      if (sessionId) {
        if (session?.worktreePath) {
          const resolvedWorktree = path.resolve(session.worktreePath);
          if (!resolvedPath.startsWith(resolvedWorktree + path.sep) && resolvedPath !== resolvedWorktree) {
            console.error('[FS] Path validation failed: write outside worktree', resolvedPath, 'worktree:', resolvedWorktree);
            return { success: false, error: 'Path is outside the session worktree' };
          }
        }
      }

      debugFs('[FS] Writing local file:', resolvedPath);
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('[FS] Write file error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Search files by content using grep
  ipcMain.handle(IPC_CHANNELS.FS_SEARCH_FILES, async (
    _event,
    sessionId: string,
    searchTerm: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; maxResults?: number }
  ) => {
    const session = await sessionService.getSession(sessionId);
    if (!session?.worktreePath || !searchTerm) return [];

    const maxResults = options?.maxResults || 200;

    return new Promise((resolve) => {
      const args = [
        '-rn',
        '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
        '--include=*.json', '--include=*.py', '--include=*.rb', '--include=*.go',
        '--include=*.rs', '--include=*.java', '--include=*.c', '--include=*.cpp',
        '--include=*.h', '--include=*.hpp', '--include=*.cs', '--include=*.php',
        '--include=*.swift', '--include=*.kt', '--include=*.scala', '--include=*.html',
        '--include=*.css', '--include=*.scss', '--include=*.yaml', '--include=*.yml',
        '--include=*.xml', '--include=*.sql', '--include=*.sh', '--include=*.md',
        '--include=*.toml', '--include=*.vue', '--include=*.svelte',
        '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
        '--exclude-dir=build', '--exclude-dir=.next', '--exclude-dir=__pycache__',
        '--exclude-dir=.venv', '--exclude-dir=venv', '--exclude-dir=coverage',
      ];

      if (!options?.caseSensitive) args.push('-i');
      if (options?.wholeWord) args.push('-w');
      if (!options?.regex) args.push('-F');

      args.push('--', searchTerm, session.worktreePath);

      const grep = spawn('grep', args, { cwd: session.worktreePath });

      let output = '';
      grep.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      grep.stderr.on('data', (chunk: Buffer) => {
        debugFs('[FS] grep stderr:', chunk.toString().slice(0, 200));
      });

      grep.on('close', () => {
        const results = parseGrepOutput(output, session.worktreePath, maxResults);
        resolve(results);
      });

      // Kill after 5 seconds to prevent hanging on huge repos
      setTimeout(() => { grep.kill(); }, 5000);
    });
  });

  // Search for symbols (functions, classes, methods, etc.)
  ipcMain.handle(IPC_CHANNELS.FS_SEARCH_SYMBOLS, async (_event, sessionId: string, query: string) => {
    const session = await sessionService.getSession(sessionId);
    if (!session?.worktreePath || !query?.trim()) {
      return [];
    }

    const files = await listFilesRecursive(session.worktreePath, session.worktreePath);
    const symbolResults: Array<{
      name: string;
      kind: string;
      path: string;
      relativePath: string;
      lineNumber: number;
      detail: string;
    }> = [];

    const lowerQuery = query.toLowerCase();

    // Symbol patterns for common languages
    const symbolPatterns = [
      // TypeScript/JavaScript function/const declarations
      /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(\w+)/,
      // TypeScript/JavaScript class declarations
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
      // TypeScript interface/type declarations
      /^(?:export\s+)?(?:interface|type)\s+(\w+)/,
      // TypeScript/JavaScript method declarations (class methods)
      /^\s*(?:public|private|protected|static|async|readonly|\s)*(\w+)\s*(?:<[^>]*>)?\s*\(/,
      // Python function/class
      /^(?:async\s+)?def\s+(\w+)/,
      /^class\s+(\w+)/,
      // Go function/type
      /^func\s+(?:\([^)]+\)\s+)?(\w+)/,
      /^type\s+(\w+)/,
      // Rust function/struct/impl
      /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
      /^(?:pub\s+)?struct\s+(\w+)/,
      /^impl(?:<[^>]*>)?\s+(\w+)/,
    ];

    for (const file of files.filter((f) => f.type === 'file').slice(0, 100)) {
      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          for (const pattern of symbolPatterns) {
            const match = line.match(pattern);
            if (match && match[1]) {
              const symbolName = match[1];

              // Filter by query
              if (symbolName.toLowerCase().includes(lowerQuery)) {
                // Determine symbol kind
                let kind = 'symbol';
                if (/class\s/.test(line)) kind = 'class';
                else if (/interface\s/.test(line)) kind = 'interface';
                else if (/type\s/.test(line)) kind = 'type';
                else if (/(?:function|def|fn)\s/.test(line) || /^\s*(?:async\s+)?(\w+)\s*\(/.test(line)) kind = 'function';
                else if (/struct\s/.test(line)) kind = 'struct';
                else if (/const\s/.test(line)) kind = 'const';

                symbolResults.push({
                  name: symbolName,
                  kind,
                  path: file.path,
                  relativePath: file.relativePath,
                  lineNumber: i + 1,
                  detail: line.trim().substring(0, 80),
                });

                // Only include first match per line
                break;
              }
            }
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Sort by relevance (exact match first, then starts with, then includes)
    symbolResults.sort((a, b) => {
      const aLower = a.name.toLowerCase();
      const bLower = b.name.toLowerCase();
      const aExact = aLower === lowerQuery;
      const bExact = bLower === lowerQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      const aStarts = aLower.startsWith(lowerQuery);
      const bStarts = bLower.startsWith(lowerQuery);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.length - b.name.length;
    });

    return symbolResults.slice(0, 30);
  });
}
