import { ChildProcess, execFileSync } from 'child_process';

function getChildPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function collectDescendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const stack = [...getChildPids(rootPid)];

  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || descendants.includes(pid)) continue;
    descendants.push(pid);
    stack.push(...getChildPids(pid));
  }

  return descendants;
}

function getProcessGroupId(pid: number): number | undefined {
  try {
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited or belongs to a context we cannot signal.
  }
}

export function terminateProcessTree(child: ChildProcess, forceAfterMs = 1000, includeProcessGroup = false): void {
  const rootPid = child.pid;
  if (!rootPid) return;
  const rootProcessGroupId = includeProcessGroup && process.platform !== 'win32'
    ? getProcessGroupId(rootPid)
    : undefined;

  const signalTree = (signal: NodeJS.Signals) => {
    const descendants = collectDescendantPids(rootPid);
    for (const pid of descendants.reverse()) {
      signalPid(pid, signal);
    }
    signalPid(rootPid, signal);
    if (rootProcessGroupId && rootProcessGroupId === rootPid) {
      signalPid(-rootProcessGroupId, signal);
    }
  };

  signalTree('SIGTERM');
  setTimeout(() => signalTree('SIGKILL'), forceAfterMs).unref?.();
}
