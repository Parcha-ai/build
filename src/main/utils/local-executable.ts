import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function pathDelimiterSafe(): string {
  return process.platform === 'win32' ? ';' : ':';
}

export function hasMacOSQuarantine(candidate: string): boolean {
  if (process.platform !== 'darwin') return false;

  const pathsToCheck = new Set([candidate]);
  try {
    pathsToCheck.add(fs.realpathSync(candidate));
  } catch {
    // The caller handles invalid paths.
  }

  for (const pathToCheck of pathsToCheck) {
    try {
      const output = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', pathToCheck], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (output.trim()) {
        console.warn(`[LocalExecutable] Ignoring quarantined executable: ${pathToCheck}`);
        return true;
      }
    } catch {
      // xattr exits non-zero when the attribute is absent.
    }
  }

  return false;
}

export function isUsableLocalExecutable(candidate: string): boolean {
  try {
    return fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      !hasMacOSQuarantine(candidate);
  } catch {
    return false;
  }
}

export function findUsableLocalExecutable(binaryNames: string[], extraCandidates: string[] = []): string | null {
  for (const candidate of extraCandidates) {
    if (isUsableLocalExecutable(candidate)) return candidate;
  }

  for (const dir of (process.env.PATH || '').split(pathDelimiterSafe())) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (isUsableLocalExecutable(candidate)) return candidate;
    }
  }

  return null;
}

export function hasUsableLocalExecutable(binaryNames: string[], extraCandidates: string[] = []): boolean {
  return !!findUsableLocalExecutable(binaryNames, extraCandidates);
}
