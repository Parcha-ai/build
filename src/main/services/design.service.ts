import Store from 'electron-store';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { sshService } from './ssh.service';
import type { SSHConfig } from '../../shared/types';

// Extensions synced between the local design mirror and a remote SSH
// workspace. Design artifacts are text (self-contained HTML); binaries are
// skipped and logged.
const SYNCABLE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.svg', '.txt']);
const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsStore = new Store({ name: 'claudette-settings' }) as any;

const DEFAULT_OD_PORT = 7456;
const HEALTH_TIMEOUT_MS = 20000;
const DESIGN_WORKSPACE_DIRNAME = 'design-explorations';

export interface DesignWorkspace {
  projectId: string;
  conversationId?: string;
  workspaceDir: string;
  panelUrl: string;
  daemonUrl: string;
  /** SSH sessions: workspaceDir is a local mirror; designs sync to this remote dir */
  remote?: { sessionId: string; config: SSHConfig; remoteDir: string };
}

interface DesignDaemonState {
  url: string;
  port: number;
  process: ChildProcess | null; // null when we adopted an externally started daemon
}

/**
 * DesignService integrates Open Design (github.com/nexu-io/open-design) as
 * Build's design surface. It manages a headless OD daemon child process and
 * maps Build sessions to folder-backed OD projects rooted inside the
 * session's working directory. The agent writes HTML explorations into that
 * folder; OD's file watcher live-refreshes the preview shown in the RHS
 * design panel.
 */
export class DesignService {
  private daemon: DesignDaemonState | null = null;
  private starting: Promise<DesignDaemonState> | null = null;
  // sessionId -> workspace (also persisted so panel survives app restarts)
  private workspaces = new Map<string, DesignWorkspace>();

  getOpenDesignPath(): string {
    const configured = settingsStore.get('openDesignPath') as string | undefined;
    if (configured && configured.trim()) return configured.replace(/^~/, os.homedir());
    return path.join(os.homedir(), 'dev', 'parcha', 'open-design');
  }

  isInstalled(): boolean {
    const odPath = this.getOpenDesignPath();
    return fs.existsSync(path.join(odPath, 'apps', 'daemon', 'dist', 'cli.js'));
  }

  getDaemonUrl(): string | null {
    return this.daemon?.url ?? null;
  }

  getWorkspaceForSession(sessionId: string): DesignWorkspace | null {
    return this.workspaces.get(sessionId) ?? null;
  }

  /** Start (or adopt) the OD daemon and return its state. Safe to call concurrently. */
  async ensureDaemon(): Promise<DesignDaemonState> {
    if (this.daemon && (await this.isHealthy(this.daemon.url))) return this.daemon;
    if (this.starting) return this.starting;
    this.starting = this.startDaemon().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startDaemon(): Promise<DesignDaemonState> {
    // Adopt an already-running OD daemon on the default port (e.g. the user
    // runs Open Design standalone). Never kill an adopted daemon.
    const defaultUrl = `http://127.0.0.1:${DEFAULT_OD_PORT}`;
    if (await this.isHealthy(defaultUrl)) {
      console.log('[Design Service] Adopted existing Open Design daemon at', defaultUrl);
      this.daemon = { url: defaultUrl, port: DEFAULT_OD_PORT, process: null };
      return this.daemon;
    }

    const odPath = this.getOpenDesignPath();
    const cliEntry = path.join(odPath, 'apps', 'daemon', 'bin', 'od.mjs');
    if (!fs.existsSync(cliEntry)) {
      throw new Error(
        `Open Design is not installed at ${odPath}. Clone github.com/nexu-io/open-design there and run: corepack pnpm install && corepack pnpm --filter @open-design/daemon build && corepack pnpm --filter @open-design/web build (or set "openDesignPath" in settings).`
      );
    }

    const port = await this.findFreePort(DEFAULT_OD_PORT);
    const nodeBin = this.findNodeBinary();
    const args = [cliEntry, 'daemon', 'start', '--headless', '--port', String(port), '--no-open'];
    console.log('[Design Service] Starting OD daemon:', nodeBin, args.join(' '));

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (nodeBin === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

    const child = spawn(nodeBin, args, {
      cwd: odPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    child.stdout?.on('data', (d: Buffer) => console.log('[OD daemon]', d.toString().trim()));
    child.stderr?.on('data', (d: Buffer) => console.warn('[OD daemon:err]', d.toString().trim()));
    child.on('exit', (code) => {
      console.log('[Design Service] OD daemon exited with code', code);
      if (this.daemon?.process === child) this.daemon = null;
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isHealthy(url)) {
        this.daemon = { url, port, process: child };
        console.log('[Design Service] OD daemon healthy at', url);
        return this.daemon;
      }
      if (child.exitCode !== null) {
        throw new Error(`Open Design daemon exited early (code ${child.exitCode}). Check that the daemon and web builds exist under ${odPath}.`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    child.kill('SIGTERM');
    throw new Error('Open Design daemon did not become healthy in time');
  }

  /**
   * Ensure a folder-backed OD project exists for this session and return the
   * workspace info. The workspace directory lives inside the session cwd so
   * the agent can write explorations with plain file tools.
   */
  async ensureDesignWorkspace(
    sessionId: string,
    sessionCwd: string,
    sessionName?: string,
    ssh?: { config: SSHConfig; remoteWorkdir: string }
  ): Promise<DesignWorkspace> {
    const daemon = await this.ensureDaemon();
    // Local sessions design directly in the repo; SSH sessions design in a
    // local mirror (OD's daemon, watchers, and design agent need local FS)
    // that syncs to <remoteWorkdir>/design-explorations on each run.
    const workspaceDir = ssh
      ? path.join(os.homedir(), '.claudette', 'design-workspaces', sessionId.slice(0, 8), DESIGN_WORKSPACE_DIRNAME)
      : path.join(sessionCwd, DESIGN_WORKSPACE_DIRNAME);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const remote = ssh
      ? { sessionId, config: ssh.config, remoteDir: `${ssh.remoteWorkdir.replace(/\/+$/, '')}/${DESIGN_WORKSPACE_DIRNAME}` }
      : undefined;
    if (remote) {
      await this.pullRemoteWorkspace(remote, workspaceDir).catch((err) =>
        console.warn('[Design Service] Remote workspace pull failed (continuing with local mirror):', err instanceof Error ? err.message : err)
      );
    }

    // Reuse a still-valid cached project for this workspace dir
    const cached = this.workspaces.get(sessionId) ?? this.loadPersistedWorkspace(workspaceDir, daemon.url);
    if (cached && cached.workspaceDir === workspaceDir && (await this.projectExists(daemon.url, cached.projectId))) {
      const refreshed: DesignWorkspace = {
        ...cached,
        daemonUrl: daemon.url,
        panelUrl: `${daemon.url}/projects/${cached.projectId}`,
        remote,
      };
      this.workspaces.set(sessionId, refreshed);
      return refreshed;
    }

    // Seed an entry file so the OD project has a visible artifact immediately
    const entryFile = path.join(workspaceDir, 'index.html');
    if (!fs.existsSync(entryFile)) {
      fs.writeFileSync(
        entryFile,
        '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Design Explorations</title></head>\n<body style="font-family: -apple-system, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; background: #111; color: #888">\n<p>Waiting for the agent’s first exploration…</p>\n</body>\n</html>\n'
      );
    }

    const body = JSON.stringify({
      baseDir: workspaceDir,
      name: sessionName ? `Build: ${sessionName}` : `Build session ${sessionId.slice(0, 8)}`,
      orchestratorWorkspace: {
        kind: 'scratch',
        sourceLabel: `build-session:${sessionId}`,
        writeback: 'external',
      },
    });
    const result = await this.requestJson(daemon.url, 'POST', '/api/import/folder', body);
    const project = (result as { project?: { id?: string }; conversationId?: string })?.project;
    if (!project?.id) throw new Error(`Open Design folder import failed: ${JSON.stringify(result).slice(0, 300)}`);

    const workspace: DesignWorkspace = {
      projectId: project.id,
      conversationId: (result as { conversationId?: string }).conversationId,
      workspaceDir,
      daemonUrl: daemon.url,
      panelUrl: `${daemon.url}/projects/${project.id}`,
      remote,
    };
    this.workspaces.set(sessionId, workspace);
    this.persistWorkspace(workspace);
    return workspace;
  }

  /**
   * Start a design run in a fresh OD conversation with the brief as the
   * opening message. OD spawns its own design agent (claude CLI) in the
   * workspace; the daemon streams the run over SSE, which we hold open from
   * here so the run is not cancelled by a dropped client. Returns the
   * conversation deep-link URL for the takeover webview.
   */
  async startDesignRun(sessionId: string, brief: string): Promise<{ conversationId: string; conversationUrl: string }> {
    const workspace = this.workspaces.get(sessionId);
    const daemon = this.daemon;
    if (!workspace || !daemon) throw new Error('Design workspace not initialized');

    const convResult = (await this.requestJson(
      daemon.url,
      'POST',
      `/api/projects/${encodeURIComponent(workspace.projectId)}/conversations`,
      JSON.stringify({ title: brief.slice(0, 80), sessionMode: 'design' })
    )) as { conversation?: { id?: string }; id?: string };
    const conversationId = convResult?.conversation?.id ?? convResult?.id;
    if (!conversationId) throw new Error(`Could not create design conversation: ${JSON.stringify(convResult).slice(0, 200)}`);

    // Build-initiated briefs are fire-and-watch: the user expects the design
    // to appear, not a clarifying-questions form (OD's discovery flow). They
    // can iterate with follow-up questions inside the design session after.
    const message = `${brief}\n\nIMPORTANT: Do not ask clarifying questions or present a question form — make sensible choices on any open design decisions yourself and produce the design directly. The user will iterate with you afterwards.`;
    this.holdChatRun(
      daemon.url,
      {
        agentId: 'claude',
        message,
        projectId: workspace.projectId,
        conversationId,
        sessionMode: 'design',
      },
      { sessionId, brief: message, projectId: workspace.projectId, conversationId }
    );

    const conversationUrl = `${daemon.url}/projects/${workspace.projectId}/conversations/${conversationId}`;
    const updated: DesignWorkspace = { ...workspace, conversationId, panelUrl: conversationUrl };
    this.workspaces.set(sessionId, updated);
    this.persistWorkspace(updated);
    return { conversationId, conversationUrl };
  }

  // Completed design runs per Build session — the daemon does NOT persist
  // run messages itself (in OD's own topology the web client does that), so
  // Build captures the transcript from the SSE stream it already holds.
  private designRuns = new Map<string, Array<{ brief: string; response: string; endedAt: number; status: string }>>();

  getDesignRuns(sessionId: string): Array<{ brief: string; response: string; endedAt: number; status: string }> {
    return this.designRuns.get(sessionId) ?? [];
  }

  /** POST /api/chat and keep the SSE response alive until the run finishes. */
  private holdChatRun(
    daemonUrl: string,
    body: Record<string, unknown>,
    capture?: { sessionId: string; brief: string; projectId: string; conversationId: string }
  ): void {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${daemonUrl}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        let bytes = 0;
        let pending = '';
        let lastEvent = '';
        let responseText = '';
        let runStatus = 'unknown';
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          pending += chunk.toString();
          // SSE frames are newline-delimited; keep the trailing partial line
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('event: ')) lastEvent = line.slice(7).trim();
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (lastEvent === 'agent') {
              try {
                const evt = JSON.parse(data) as { type?: string; delta?: string };
                if (evt.type === 'text_delta' && evt.delta) responseText += evt.delta;
              } catch { /* partial or non-JSON agent frame */ }
            } else if (lastEvent === 'end') {
              try {
                runStatus = String((JSON.parse(data) as { status?: string }).status ?? 'unknown');
              } catch { /* ignore */ }
            } else if (/error|fail/i.test(data)) {
              console.warn(`[Design Service] Design run ${lastEvent}:`, data.slice(0, 500));
            }
          }
        });
        res.on('end', () => {
          console.log(`[Design Service] Design run stream ended (status ${res.statusCode}, ${bytes} bytes, run status: ${runStatus}, response: ${responseText.length} chars)`);
          if (capture) {
            const runs = this.designRuns.get(capture.sessionId) ?? [];
            runs.push({ brief: capture.brief, response: responseText, endedAt: Date.now(), status: runStatus });
            this.designRuns.set(capture.sessionId, runs);
            // Mirror the exchange into OD's conversation store so the OD UI
            // shows the history when the user reopens the design session.
            this.persistConversationMessages(daemonUrl, capture, responseText).catch((err) =>
              console.warn('[Design Service] Could not mirror messages into OD:', err instanceof Error ? err.message : err)
            );
            // SSH sessions: sync the mirror's artifacts back to the remote repo
            this.pushWorkspaceToRemote(capture.sessionId).catch((err) =>
              console.warn('[Design Service] Remote writeback failed:', err instanceof Error ? err.message : err)
            );
          }
        });
        res.on('error', (err) => console.warn('[Design Service] Design run stream error:', err.message));
      }
    );
    req.on('error', (err) => console.warn('[Design Service] Design run request failed:', err.message));
    req.write(payload);
    req.end();
  }

  /**
   * Pull the design session's conversation transcript so the coding agent
   * knows what happened in the design session. Returns a compact formatted
   * block (or '' when there is nothing to sync). Capped to the most recent
   * content so it stays a bounded fraction of the system prompt.
   */
  async fetchDesignSessionContext(sessionId: string, maxChars = 12000): Promise<string> {
    const workspace = this.workspaces.get(sessionId);
    if (!workspace || !this.daemon) return '';
    try {
      const lines: string[] = [];
      // Build-initiated runs captured from the SSE stream we held (the OD
      // daemon does not persist run messages itself).
      for (const run of this.getDesignRuns(sessionId).slice(-5)) {
        lines.push(`[design:user] ${run.brief.length > 1500 ? run.brief.slice(0, 1500) + '…' : run.brief}`);
        const resp = run.response.trim();
        if (resp) lines.push(`[design:agent (${run.status})] ${resp.length > 2500 ? resp.slice(0, 2500) + '…' : resp}`);
      }
      // Plus anything persisted in OD's conversation store (runs the user
      // started from the OD UI itself, and our mirrored messages for
      // conversations from previous app launches).
      const convResult = (await this.requestJson(
        this.daemon.url,
        'GET',
        `/api/projects/${encodeURIComponent(workspace.projectId)}/conversations`
      )) as { conversations?: Array<{ id: string; title?: string; messageCount?: number; updatedAt?: number }> };
      const captured = new Set(this.getDesignRuns(sessionId).flatMap((r) => [r.brief, r.response.trim()]));
      for (const conv of (convResult?.conversations ?? []).filter((c) => (c.messageCount ?? 0) > 0).slice(-3)) {
        const msgResult = (await this.requestJson(
          this.daemon.url,
          'GET',
          `/api/projects/${encodeURIComponent(workspace.projectId)}/conversations/${encodeURIComponent(conv.id)}/messages`
        )) as { messages?: Array<Record<string, unknown>> };
        for (const m of msgResult?.messages ?? []) {
          const role = String(m.role ?? m.author ?? 'unknown');
          const raw = m.content ?? m.text ?? '';
          const text = (typeof raw === 'string' ? raw : JSON.stringify(raw)).trim();
          if (!text || captured.has(text)) continue; // skip messages we mirrored ourselves
          lines.push(`[design:${role}] ${text.length > 1500 ? text.slice(0, 1500) + '…' : text}`);
        }
      }
      if (lines.length === 0) return '';

      let body = lines.join('\n');
      if (body.length > maxChars) body = '…' + body.slice(-maxChars);
      const files = this.listWorkspaceFiles(workspace.workspaceDir);
      const filesLocation = workspace.remote
        ? `${workspace.remote.remoteDir} (on the remote host — synced from the local design mirror)`
        : workspace.workspaceDir;
      return [
        '## Design Session Context',
        `The user ran a design session (Open Design) for this Build session. Design files live in ${filesLocation} — read them directly when working with the designs. Files: ${files.join(', ') || '(none yet)'}`,
        '',
        body,
      ].join('\n');
    } catch (error) {
      console.warn('[Design Service] Failed to fetch design session context:', error);
      return '';
    }
  }

  /**
   * SSH sessions: pull existing remote design files into the local mirror so
   * a design session continues where previous ones left off. Text files only.
   */
  private async pullRemoteWorkspace(
    remote: { sessionId: string; config: SSHConfig; remoteDir: string },
    localDir: string
  ): Promise<void> {
    const client = await sshService.getConnectionForCodex(remote.sessionId, remote.config);
    const escaped = remote.remoteDir.replace(/'/g, "'\\''");
    const listing = await sshService
      .execCommand(client, `find '${escaped}' -maxdepth 2 -type f 2>/dev/null || true`)
      .catch(() => '');
    const files = listing.split('\n').map((l) => l.trim()).filter(Boolean);
    let pulled = 0;
    for (const remotePath of files) {
      const rel = path.relative(remote.remoteDir, remotePath);
      if (rel.startsWith('..') || !SYNCABLE_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
      try {
        const content = await sshService.readRemoteFile(remote.sessionId, remote.config, remotePath);
        const localPath = path.join(localDir, rel);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, content);
        pulled++;
      } catch (err) {
        console.warn(`[Design Service] Pull failed for ${remotePath}:`, err instanceof Error ? err.message : err);
      }
    }
    if (pulled > 0) console.log(`[Design Service] Pulled ${pulled} design file(s) from remote ${remote.remoteDir}`);
  }

  /** SSH sessions: push the local mirror's design files to the remote repo. */
  async pushWorkspaceToRemote(sessionId: string): Promise<number> {
    const workspace = this.workspaces.get(sessionId);
    if (!workspace?.remote) return 0;
    const { remote, workspaceDir } = workspace;
    let pushed = 0;
    const walk = (dir: string, relBase: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(full, rel));
        else out.push(rel);
      }
      return out;
    };
    for (const rel of walk(workspaceDir, '')) {
      const localPath = path.join(workspaceDir, rel);
      const ext = path.extname(rel).toLowerCase();
      const size = fs.statSync(localPath).size;
      if (!SYNCABLE_EXTENSIONS.has(ext) || size > MAX_SYNC_FILE_BYTES) {
        console.warn(`[Design Service] Skipping non-syncable file ${rel} (${ext}, ${size}b)`);
        continue;
      }
      try {
        await sshService.writeRemoteFile(remote.sessionId, remote.config, `${remote.remoteDir}/${rel}`, fs.readFileSync(localPath, 'utf8'));
        pushed++;
      } catch (err) {
        console.warn(`[Design Service] Push failed for ${rel}:`, err instanceof Error ? err.message : err);
      }
    }
    console.log(`[Design Service] Pushed ${pushed} design file(s) to remote ${remote.remoteDir}`);
    return pushed;
  }

  /** Mirror a completed run's user brief + assistant response into OD's DB. */
  private async persistConversationMessages(
    daemonUrl: string,
    capture: { projectId: string; conversationId: string; brief: string },
    responseText: string
  ): Promise<void> {
    const base = `/api/projects/${encodeURIComponent(capture.projectId)}/conversations/${encodeURIComponent(capture.conversationId)}/messages`;
    const now = Date.now();
    const put = (id: string, role: string, content: string, createdAt: number) =>
      this.requestJson(daemonUrl, 'PUT', `${base}/${id}`, JSON.stringify({ id, role, content, createdAt }));
    await put(`build-user-${now}`, 'user', capture.brief, now - 1);
    if (responseText.trim()) await put(`build-assistant-${now}`, 'assistant', responseText, now);
  }

  private listWorkspaceFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).slice(0, 30);
    } catch {
      return [];
    }
  }

  shutdown(): void {
    if (this.daemon?.process) {
      console.log('[Design Service] Shutting down OD daemon');
      const proc = this.daemon.process;
      http
        .request(`${this.daemon.url}/api/daemon/shutdown`, { method: 'POST' }, () => undefined)
        .on('error', () => undefined)
        .end();
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGTERM');
      }, 1500).unref();
    }
    this.daemon = null;
  }

  // --- helpers ---

  private findNodeBinary(): string {
    const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return process.execPath; // Electron as Node via ELECTRON_RUN_AS_NODE
  }

  private isHealthy(url: string): Promise<boolean> {
    return this.requestJson(url, 'GET', '/api/health')
      .then((r) => Boolean((r as { ok?: boolean })?.ok))
      .catch(() => false);
  }

  private projectExists(daemonUrl: string, projectId: string): Promise<boolean> {
    return this.requestJson(daemonUrl, 'GET', `/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => Boolean((r as { project?: unknown; id?: string })))
      .catch(() => false);
  }

  private requestJson(baseUrl: string, method: string, pathname: string, body?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${pathname}`,
        {
          method,
          headers: body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {},
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`OD ${method} ${pathname} -> ${res.statusCode}: ${data.slice(0, 300)}`));
              return;
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve(data);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      if (body) req.write(body);
      req.end();
    });
  }

  private findFreePort(startPort: number): Promise<number> {
    const tryPort = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => {
          server.close();
          if (port > startPort + 50) reject(new Error('No free port found for OD daemon'));
          else resolve(tryPort(port + 1));
        });
        server.once('listening', () => {
          server.close(() => resolve(port));
        });
        server.listen(port, '127.0.0.1');
      });
    return tryPort(startPort);
  }

  private persistWorkspace(workspace: DesignWorkspace): void {
    const all = (settingsStore.get('designWorkspaces') ?? {}) as Record<string, { projectId: string; conversationId?: string }>;
    all[workspace.workspaceDir] = { projectId: workspace.projectId, conversationId: workspace.conversationId };
    settingsStore.set('designWorkspaces', all);
  }

  private loadPersistedWorkspace(workspaceDir: string, daemonUrl: string): DesignWorkspace | null {
    const all = (settingsStore.get('designWorkspaces') ?? {}) as Record<string, { projectId: string; conversationId?: string }>;
    const entry = all[workspaceDir];
    if (!entry) return null;
    return {
      projectId: entry.projectId,
      conversationId: entry.conversationId,
      workspaceDir,
      daemonUrl,
      panelUrl: `${daemonUrl}/projects/${entry.projectId}`,
    };
  }
}

export const designService = new DesignService();
