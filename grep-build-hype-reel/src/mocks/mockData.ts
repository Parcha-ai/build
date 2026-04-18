// Mock data for Build hype reel — realistic sessions, messages, and tool calls
// Mirrors the exact types from Claudette's shared/types/index.ts

export interface MockSession {
  id: string;
  name: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  status: 'running' | 'stopped' | 'error';
  ports: { web: number; api: number; debug: number };
  createdAt: Date;
  updatedAt: Date;
  setupScript: string;
  isDevMode: boolean;
  model?: string;
  isWorktree?: boolean;
  parentRepoPath?: string;
  forkName?: string;
  isStarred?: boolean;
  starredAt?: Date;
  parentSessionId?: string;
  childSessionIds?: string[];
  aiGeneratedName?: string;
  isRoot?: boolean;
  isSSH?: boolean;
  sshHost?: string;
}

export interface MockToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: unknown;
  startedAt?: Date;
  completedAt?: Date;
}

export interface MockContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  toolCallId?: string;
}

export interface MockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  contentBlocks?: MockContentBlock[];
  toolCalls?: MockToolCall[];
  timestamp: Date;
  interrupted?: boolean;
}

export interface MockMonitorEvent {
  id: string;
  text: string;
  timestamp: number;
}

export interface MockMonitorInstance {
  id: string;
  description: string;
  events: MockMonitorEvent[];
  active: boolean;
  persistent?: boolean;
  startedAt: number;
}

export interface MockTask {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// ---- Sessions ----

export const MOCK_SESSIONS: MockSession[] = [
  {
    id: 'session-auth',
    name: 'Auth refactor',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'aj/auth-refactor',
    status: 'running',
    ports: { web: 3000, api: 8080, debug: 9229 },
    createdAt: new Date('2026-03-15T10:00:00'),
    updatedAt: new Date('2026-03-15T14:30:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-opus-4-6',
    isStarred: true,
    starredAt: new Date('2026-03-15T10:05:00'),
    isRoot: true,
  },
  {
    id: 'session-dashboard',
    name: 'Real-time dashboard',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'aj/realtime-dashboard',
    status: 'running',
    ports: { web: 3001, api: 8081, debug: 9230 },
    createdAt: new Date('2026-03-15T09:00:00'),
    updatedAt: new Date('2026-03-15T14:45:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-opus-4-6',
    isStarred: true,
    starredAt: new Date('2026-03-15T09:05:00'),
    isRoot: true,
  },
  {
    id: 'session-api',
    name: 'API endpoints',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'aj/api-endpoints',
    status: 'running',
    ports: { web: 3002, api: 8082, debug: 9231 },
    createdAt: new Date('2026-03-15T09:00:00'),
    updatedAt: new Date('2026-03-15T13:45:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'session-bug',
    name: 'Bug fix #342',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'fix/issue-342',
    status: 'running',
    ports: { web: 3003, api: 8083, debug: 9232 },
    createdAt: new Date('2026-03-15T11:00:00'),
    updatedAt: new Date('2026-03-15T12:30:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-haiku-3-5',
  },
  {
    id: 'session-fork',
    name: 'Alt approach',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette/.claudette-worktrees/worktree-abc123',
    branch: 'aj/auth-refactor-v2',
    status: 'running',
    ports: { web: 3004, api: 8084, debug: 9233 },
    createdAt: new Date('2026-03-15T13:00:00'),
    updatedAt: new Date('2026-03-15T14:00:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-opus-4-6',
    isWorktree: true,
    parentRepoPath: '/Users/aj/dev/parcha/claudette',
    forkName: 'fuzzy-tiger',
    parentSessionId: 'session-auth',
    aiGeneratedName: 'Alt approach',
  },
  {
    id: 'session-fork-2',
    name: 'Redis lock variant',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette/.claudette-worktrees/worktree-def456',
    branch: 'aj/auth-redis-lock',
    status: 'running',
    ports: { web: 3005, api: 8085, debug: 9234 },
    createdAt: new Date('2026-03-15T13:30:00'),
    updatedAt: new Date('2026-03-15T14:10:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-sonnet-4-5',
    isWorktree: true,
    parentRepoPath: '/Users/aj/dev/parcha/claudette',
    forkName: 'bouncy-penguin',
    parentSessionId: 'session-auth',
    aiGeneratedName: 'Redis lock variant',
  },
  {
    id: 'session-ssh-prod',
    name: 'Prod deploy',
    repoPath: '/home/deploy/parcha-api',
    worktreePath: '/home/deploy/parcha-api',
    branch: 'main',
    status: 'running',
    ports: { web: 8080, api: 8080, debug: 0 },
    createdAt: new Date('2026-03-15T14:00:00'),
    updatedAt: new Date('2026-03-15T14:35:00'),
    setupScript: '',
    isDevMode: false,
    model: 'claude-opus-4-6',
    isSSH: true,
    sshHost: 'prod-api-01.parcha.cloud',
  },
  {
    id: 'session-ssh-staging',
    name: 'Staging debug',
    repoPath: '/home/deploy/parcha-api',
    worktreePath: '/home/deploy/parcha-api',
    branch: 'staging',
    status: 'running',
    ports: { web: 8081, api: 8081, debug: 9229 },
    createdAt: new Date('2026-03-15T13:00:00'),
    updatedAt: new Date('2026-03-15T14:20:00'),
    setupScript: '',
    isDevMode: false,
    model: 'claude-sonnet-4-5',
    isSSH: true,
    sshHost: 'staging-01.parcha.cloud',
  },
  {
    id: 'session-perf',
    name: 'Perf optimization',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'aj/perf-bundle-size',
    status: 'stopped',
    ports: { web: 3006, api: 8086, debug: 9235 },
    createdAt: new Date('2026-03-14T16:00:00'),
    updatedAt: new Date('2026-03-14T18:30:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'session-tests',
    name: 'E2E test suite',
    repoPath: '/Users/aj/dev/parcha/claudette',
    worktreePath: '/Users/aj/dev/parcha/claudette',
    branch: 'aj/e2e-tests',
    status: 'stopped',
    ports: { web: 3007, api: 8087, debug: 9236 },
    createdAt: new Date('2026-03-14T10:00:00'),
    updatedAt: new Date('2026-03-14T14:00:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-opus-4-6',
  },
  {
    id: 'session-backend',
    name: 'Payment webhooks',
    repoPath: '/Users/aj/dev/parcha/parcha-backend',
    worktreePath: '/Users/aj/dev/parcha/parcha-backend',
    branch: 'aj/stripe-webhooks',
    status: 'running',
    ports: { web: 4000, api: 8090, debug: 9240 },
    createdAt: new Date('2026-03-15T08:00:00'),
    updatedAt: new Date('2026-03-15T14:15:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-opus-4-6',
    isStarred: true,
    starredAt: new Date('2026-03-15T08:05:00'),
    isRoot: true,
  },
  {
    id: 'session-backend-db',
    name: 'DB migrations',
    repoPath: '/Users/aj/dev/parcha/parcha-backend',
    worktreePath: '/Users/aj/dev/parcha/parcha-backend',
    branch: 'aj/migrate-v3',
    status: 'stopped',
    ports: { web: 4001, api: 8091, debug: 9241 },
    createdAt: new Date('2026-03-13T09:00:00'),
    updatedAt: new Date('2026-03-13T17:00:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'session-fe',
    name: 'Dashboard redesign',
    repoPath: '/Users/aj/dev/parcha/parcha-fe',
    worktreePath: '/Users/aj/dev/parcha/parcha-fe',
    branch: 'aj/dashboard-v2',
    status: 'running',
    ports: { web: 5173, api: 8095, debug: 9245 },
    createdAt: new Date('2026-03-15T11:30:00'),
    updatedAt: new Date('2026-03-15T14:20:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-sonnet-4-5',
  },
  {
    id: 'session-fe-a11y',
    name: 'Accessibility audit',
    repoPath: '/Users/aj/dev/parcha/parcha-fe',
    worktreePath: '/Users/aj/dev/parcha/parcha-fe',
    branch: 'aj/a11y-fixes',
    status: 'stopped',
    ports: { web: 5174, api: 8096, debug: 9246 },
    createdAt: new Date('2026-03-14T13:00:00'),
    updatedAt: new Date('2026-03-14T16:00:00'),
    setupScript: '',
    isDevMode: true,
    model: 'claude-haiku-3-5',
  },
];

// ---- Messages for Auth refactor session ----

export const MOCK_MESSAGES_AUTH: MockMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Refactor the authentication middleware to use JWT refresh tokens with a mutex to prevent race conditions when multiple tabs refresh simultaneously.',
    timestamp: new Date('2026-03-15T10:05:00'),
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: "I'll analyze the current authentication flow and implement the JWT refresh token mutex. Let me start by examining the existing middleware.",
    contentBlocks: [
      { type: 'text', text: "I'll analyze the current authentication flow and implement the JWT refresh token mutex. Let me start by examining the existing middleware." },
      { type: 'tool_use', toolCallId: 'tc-1' },
      { type: 'tool_use', toolCallId: 'tc-2' },
      { type: 'text', text: "I can see the issue. The current `refreshToken` function doesn't have any locking mechanism. When multiple tabs detect an expired token simultaneously, they all race to refresh it, causing 401 errors.\n\nHere's my plan:\n1. Add a Redis-based distributed lock with a 5-second TTL\n2. Implement a token refresh queue that deduplicates requests\n3. Add proper error handling for lock acquisition failures" },
    ],
    toolCalls: [
      {
        id: 'tc-1',
        name: 'Read',
        input: { file_path: '/src/middleware/auth.ts' },
        status: 'completed',
        result: 'export function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1];\n  if (!token) return res.status(401).json({ error: "No token" });\n  // ... existing validation\n}',
        startedAt: new Date('2026-03-15T10:05:05'),
        completedAt: new Date('2026-03-15T10:05:06'),
      },
      {
        id: 'tc-2',
        name: 'Bash',
        input: { command: 'grep -rn "refreshToken" src/' },
        status: 'completed',
        result: 'src/middleware/auth.ts:45:  async function refreshToken(oldToken: string) {\nsrc/lib/api-client.ts:23:    return refreshToken(config.token);\nsrc/hooks/useAuth.ts:18:  const refresh = useCallback(() => refreshToken(), []);',
        startedAt: new Date('2026-03-15T10:05:07'),
        completedAt: new Date('2026-03-15T10:05:08'),
      },
    ],
    timestamp: new Date('2026-03-15T10:05:10'),
  },
  {
    id: 'msg-3',
    role: 'user',
    content: 'Good analysis. Go ahead and implement the mutex approach.',
    timestamp: new Date('2026-03-15T10:06:00'),
  },
  {
    id: 'msg-4',
    role: 'assistant',
    content: "I'll implement the distributed lock pattern using Redis. Here's the implementation:",
    contentBlocks: [
      { type: 'text', text: "I'll implement the distributed lock pattern using Redis." },
      { type: 'tool_use', toolCallId: 'tc-3' },
      { type: 'tool_use', toolCallId: 'tc-4' },
      { type: 'text', text: "The mutex is now in place. The `TokenRefreshMutex` class uses Redis `SET NX EX` for atomic lock acquisition with a 5-second TTL. If a refresh is already in progress, subsequent requests will wait and receive the new token once the first refresh completes.\n\nKey improvements:\n- **No race condition**: Only one refresh happens at a time\n- **Automatic cleanup**: TTL ensures locks are released even if the process crashes\n- **Transparent to callers**: The API client automatically retries with the new token" },
    ],
    toolCalls: [
      {
        id: 'tc-3',
        name: 'Write',
        input: { file_path: '/src/lib/token-mutex.ts', content: '// TokenRefreshMutex implementation...' },
        status: 'completed',
        result: 'File written successfully',
        startedAt: new Date('2026-03-15T10:06:05'),
        completedAt: new Date('2026-03-15T10:06:06'),
      },
      {
        id: 'tc-4',
        name: 'Edit',
        input: { file_path: '/src/middleware/auth.ts', old_string: 'async function refreshToken', new_string: 'async function refreshTokenWithMutex' },
        status: 'completed',
        result: 'Edit applied successfully',
        startedAt: new Date('2026-03-15T10:06:07'),
        completedAt: new Date('2026-03-15T10:06:08'),
      },
    ],
    timestamp: new Date('2026-03-15T10:06:10'),
  },
];

// ---- Messages for Real-time Dashboard session ----

export const MOCK_MESSAGES_DASHBOARD: MockMessage[] = [
  {
    id: 'dash-msg-1',
    role: 'user',
    content: 'Build a real-time analytics dashboard with WebSocket updates. It needs live metrics (active users, requests/sec, error rate), a streaming event log, and charts that update every second. Use React + Recharts on the frontend and a WebSocket server on the backend.',
    timestamp: new Date('2026-03-15T09:05:00'),
  },
  {
    id: 'dash-msg-2',
    role: 'assistant',
    content: "This is a substantial feature. Let me map out the architecture and start building. I'll begin with the WebSocket server, then the React components.",
    contentBlocks: [
      { type: 'text', text: "This is a substantial feature. Let me map out the architecture first.\n\n**Architecture:**\n- WebSocket server on port 8081 broadcasting metrics at 1Hz\n- React dashboard with three panels: KPI cards, streaming chart, event log\n- Connection resilience with exponential backoff reconnection\n\nLet me examine the existing codebase structure and start building." },
      { type: 'tool_use', toolCallId: 'dash-tc-1' },
      { type: 'tool_use', toolCallId: 'dash-tc-2' },
      { type: 'tool_use', toolCallId: 'dash-tc-3' },
      { type: 'text', text: "Good. I can see the project structure. Let me create the WebSocket server and the dashboard components." },
      { type: 'tool_use', toolCallId: 'dash-tc-4' },
      { type: 'tool_use', toolCallId: 'dash-tc-5' },
      { type: 'tool_use', toolCallId: 'dash-tc-6' },
      { type: 'tool_use', toolCallId: 'dash-tc-7' },
      { type: 'text', text: "Now let me wire up the route, install the dependency, and verify everything compiles." },
      { type: 'tool_use', toolCallId: 'dash-tc-8' },
      { type: 'tool_use', toolCallId: 'dash-tc-9' },
      { type: 'tool_use', toolCallId: 'dash-tc-10' },
      { type: 'text', text: "The real-time dashboard is live. Here's what I built:\n\n**Backend** (`ws-metrics-server.ts`):\n- WebSocket server broadcasting at 1Hz with `{ activeUsers, rps, errorRate, p99Latency, events[] }`\n- Simulates realistic traffic patterns with Gaussian noise\n- Graceful shutdown on SIGTERM\n\n**Frontend** (`DashboardView.tsx`):\n- **KPI Cards** — active users, requests/sec, error rate, P99 latency with delta indicators\n- **Live Chart** — 60-second rolling window Recharts AreaChart for RPS + error rate\n- **Event Stream** — auto-scrolling log with severity badges (info/warn/error)\n- **Connection Status** — indicator with auto-reconnect and exponential backoff\n\nAll tests pass. The dashboard is running on `localhost:3001/dashboard`." },
    ],
    toolCalls: [
      {
        id: 'dash-tc-1',
        name: 'Read',
        input: { file_path: '/src/server/index.ts' },
        status: 'completed',
        result: 'import express from "express";\nconst app = express();\n// ... existing server setup',
        startedAt: new Date('2026-03-15T09:05:05'),
        completedAt: new Date('2026-03-15T09:05:06'),
      },
      {
        id: 'dash-tc-2',
        name: 'Bash',
        input: { command: 'ls src/components/dashboard/ 2>/dev/null || echo "directory does not exist"' },
        status: 'completed',
        result: 'directory does not exist',
        startedAt: new Date('2026-03-15T09:05:06'),
        completedAt: new Date('2026-03-15T09:05:07'),
      },
      {
        id: 'dash-tc-3',
        name: 'Read',
        input: { file_path: '/package.json' },
        status: 'completed',
        result: '{\n  "dependencies": {\n    "express": "^4.18.2",\n    "react": "^18.2.0",\n    "recharts": "^2.10.0"\n  }\n}',
        startedAt: new Date('2026-03-15T09:05:07'),
        completedAt: new Date('2026-03-15T09:05:08'),
      },
      {
        id: 'dash-tc-4',
        name: 'Write',
        input: { file_path: '/src/server/ws-metrics-server.ts', content: '// WebSocket metrics broadcaster...' },
        status: 'completed',
        result: 'File written: src/server/ws-metrics-server.ts (127 lines)',
        startedAt: new Date('2026-03-15T09:05:10'),
        completedAt: new Date('2026-03-15T09:05:11'),
      },
      {
        id: 'dash-tc-5',
        name: 'Write',
        input: { file_path: '/src/hooks/useMetricsStream.ts', content: '// WebSocket hook with reconnection...' },
        status: 'completed',
        result: 'File written: src/hooks/useMetricsStream.ts (84 lines)',
        startedAt: new Date('2026-03-15T09:05:12'),
        completedAt: new Date('2026-03-15T09:05:13'),
      },
      {
        id: 'dash-tc-6',
        name: 'Write',
        input: { file_path: '/src/components/dashboard/DashboardView.tsx', content: '// Main dashboard layout...' },
        status: 'completed',
        result: 'File written: src/components/dashboard/DashboardView.tsx (203 lines)',
        startedAt: new Date('2026-03-15T09:05:14'),
        completedAt: new Date('2026-03-15T09:05:16'),
      },
      {
        id: 'dash-tc-7',
        name: 'Write',
        input: { file_path: '/src/components/dashboard/MetricsChart.tsx', content: '// Recharts live area chart...' },
        status: 'completed',
        result: 'File written: src/components/dashboard/MetricsChart.tsx (91 lines)',
        startedAt: new Date('2026-03-15T09:05:17'),
        completedAt: new Date('2026-03-15T09:05:18'),
      },
      {
        id: 'dash-tc-8',
        name: 'Edit',
        input: { file_path: '/src/server/index.ts', old_string: "// ... existing routes", new_string: "import { createMetricsWS } from './ws-metrics-server';\n// ... existing routes" },
        status: 'completed',
        result: 'Edit applied successfully',
        startedAt: new Date('2026-03-15T09:05:20'),
        completedAt: new Date('2026-03-15T09:05:21'),
      },
      {
        id: 'dash-tc-9',
        name: 'Bash',
        input: { command: 'npm install ws @types/ws && npm run build' },
        status: 'completed',
        result: 'added 2 packages\n\n> build\n> tsc && vite build\n\nvite v5.4.8 building for production...\n\u2713 482 modules transformed.\ndist/index.html    0.46 kB | gzip: 0.30 kB\ndist/assets/*.js  187.23 kB | gzip: 61.44 kB\n\u2713 built in 3.21s',
        startedAt: new Date('2026-03-15T09:05:22'),
        completedAt: new Date('2026-03-15T09:05:30'),
      },
      {
        id: 'dash-tc-10',
        name: 'Bash',
        input: { command: 'npm test -- --testPathPattern="dashboard" --coverage' },
        status: 'completed',
        result: 'PASS src/components/dashboard/__tests__/DashboardView.test.tsx\n  \u2713 renders KPI cards with initial data (12ms)\n  \u2713 updates chart on WebSocket message (23ms)\n  \u2713 shows reconnecting state on disconnect (8ms)\n  \u2713 streams events to event log (15ms)\n\nPASS src/server/__tests__/ws-metrics-server.test.ts\n  \u2713 broadcasts metrics at 1Hz interval (1003ms)\n  \u2713 handles multiple clients (45ms)\n  \u2713 graceful shutdown on SIGTERM (12ms)\n\nTest Suites: 2 passed, 2 total\nTests:       7 passed, 7 total\nCoverage:    94.2%',
        startedAt: new Date('2026-03-15T09:05:32'),
        completedAt: new Date('2026-03-15T09:05:40'),
      },
    ],
    timestamp: new Date('2026-03-15T09:05:45'),
  },
];

// ---- Messages for SSH prod deploy session ----

export const MOCK_MESSAGES_SSH: MockMessage[] = [
  {
    id: 'ssh-msg-1',
    role: 'user',
    content: 'The production API is returning 503s. Investigate and fix it.',
    timestamp: new Date('2026-03-15T14:00:00'),
  },
  {
    id: 'ssh-msg-2',
    role: 'assistant',
    content: "I'm connected to prod-api-01.parcha.cloud. Let me check the service status and recent logs.",
    contentBlocks: [
      { type: 'text', text: "I'm connected to `prod-api-01.parcha.cloud` via SSH. Let me investigate the 503 errors immediately." },
      { type: 'tool_use', toolCallId: 'ssh-tc-1' },
      { type: 'tool_use', toolCallId: 'ssh-tc-2' },
      { type: 'tool_use', toolCallId: 'ssh-tc-3' },
      { type: 'text', text: "Found it. The PostgreSQL connection pool is exhausted -- 100/100 connections in use, with 47 idle-in-transaction connections that have been open for over 30 minutes. This is causing new requests to queue and eventually timeout with 503.\n\n**Root cause**: The migration that shipped at 13:42 UTC introduced a transaction that doesn't call `COMMIT` on the error path in `processWebhook()`.\n\n**Fix**: I need to add a `finally` block to release the connection. Let me patch it." },
      { type: 'tool_use', toolCallId: 'ssh-tc-4' },
      { type: 'tool_use', toolCallId: 'ssh-tc-5' },
      { type: 'tool_use', toolCallId: 'ssh-tc-6' },
      { type: 'text', text: "Production is healthy again. The fix:\n1. Patched `processWebhook()` to use `try/finally` ensuring connections are always released\n2. Killed the 47 leaked idle-in-transaction connections\n3. Connection pool recovered to 12/100 active within 30 seconds\n4. Health check is green, 503 rate dropped to 0%\n\nI've committed the fix on `main` and it's deployed. You should also backport this to the staging branch." },
    ],
    toolCalls: [
      {
        id: 'ssh-tc-1',
        name: 'Bash',
        input: { command: 'systemctl status parcha-api --no-pager' },
        status: 'completed',
        result: '\u25cf parcha-api.service - Parcha API Server\n   Loaded: loaded\n   Active: active (running) since Mon 2026-03-15 06:00:00 UTC\n   Main PID: 1847 (node)\n   CGroup: /system.slice/parcha-api.service\n           \u2514\u25001847 node /home/deploy/parcha-api/dist/server.js\n\nMar 15 14:00:01 prod-api-01 node[1847]: [ERROR] Connection pool exhausted: 100/100',
        startedAt: new Date('2026-03-15T14:00:05'),
        completedAt: new Date('2026-03-15T14:00:06'),
      },
      {
        id: 'ssh-tc-2',
        name: 'Bash',
        input: { command: 'psql -c "SELECT count(*), state FROM pg_stat_activity WHERE datname=\'parcha\' GROUP BY state;"' },
        status: 'completed',
        result: ' count |        state\n-------+---------------------\n    47 | idle in transaction\n    53 | active\n     3 | idle\n(3 rows)',
        startedAt: new Date('2026-03-15T14:00:07'),
        completedAt: new Date('2026-03-15T14:00:08'),
      },
      {
        id: 'ssh-tc-3',
        name: 'Bash',
        input: { command: 'journalctl -u parcha-api --since "13:00" --no-pager | grep -i "error\\|transaction" | tail -20' },
        status: 'completed',
        result: 'Mar 15 13:42:17 prod-api-01 node[1847]: [DEPLOY] Applied migration 2026_03_15_webhook_retry.sql\nMar 15 13:45:03 prod-api-01 node[1847]: [ERROR] processWebhook: unhandled rejection: timeout\nMar 15 13:45:03 prod-api-01 node[1847]: [WARN] Connection not released for transaction txn_a8f3\nMar 15 13:52:11 prod-api-01 node[1847]: [ERROR] Pool exhausted, queueing request\nMar 15 14:00:01 prod-api-01 node[1847]: [ERROR] Connection pool exhausted: 100/100',
        startedAt: new Date('2026-03-15T14:00:09'),
        completedAt: new Date('2026-03-15T14:00:10'),
      },
      {
        id: 'ssh-tc-4',
        name: 'Edit',
        input: { file_path: '/home/deploy/parcha-api/src/handlers/webhook.ts', old_string: 'async function processWebhook', new_string: 'async function processWebhook /* patched: connection leak fix */' },
        status: 'completed',
        result: 'Edit applied: added try/finally block to release connection',
        startedAt: new Date('2026-03-15T14:00:15'),
        completedAt: new Date('2026-03-15T14:00:16'),
      },
      {
        id: 'ssh-tc-5',
        name: 'Bash',
        input: { command: 'cd /home/deploy/parcha-api && npm run build && systemctl restart parcha-api' },
        status: 'completed',
        result: '> parcha-api@3.2.1 build\n> tsc\n\nRestarting parcha-api.service...\nService restarted successfully.',
        startedAt: new Date('2026-03-15T14:00:18'),
        completedAt: new Date('2026-03-15T14:00:25'),
      },
      {
        id: 'ssh-tc-6',
        name: 'Bash',
        input: { command: 'curl -s http://localhost:8080/health | jq .' },
        status: 'completed',
        result: '{\n  "status": "healthy",\n  "db": {\n    "pool": { "active": 12, "idle": 88, "total": 100 },\n    "latency_ms": 2\n  },\n  "uptime": "32s",\n  "version": "3.2.1"\n}',
        startedAt: new Date('2026-03-15T14:00:28'),
        completedAt: new Date('2026-03-15T14:00:29'),
      },
    ],
    timestamp: new Date('2026-03-15T14:00:35'),
  },
];

// ---- Messages for API endpoints session ----

export const MOCK_MESSAGES_API: MockMessage[] = [
  {
    id: 'api-msg-1',
    role: 'user',
    content: 'Create REST endpoints for the user dashboard data. Need GET /api/dashboard/stats and GET /api/dashboard/activity.',
    timestamp: new Date('2026-03-15T09:05:00'),
  },
  {
    id: 'api-msg-2',
    role: 'assistant',
    content: "I'll set up the dashboard API endpoints with proper typing and validation.",
    contentBlocks: [
      { type: 'text', text: "I'll create the dashboard API endpoints with TypeScript types and Zod validation." },
      { type: 'tool_use', toolCallId: 'api-tc-1' },
      { type: 'text', text: 'Both endpoints are ready with full TypeScript types, Zod schema validation, and error handling.' },
    ],
    toolCalls: [
      {
        id: 'api-tc-1',
        name: 'Write',
        input: { file_path: '/src/routes/dashboard.ts', content: '// Dashboard routes...' },
        status: 'completed',
        result: 'File written successfully',
        startedAt: new Date('2026-03-15T09:05:05'),
        completedAt: new Date('2026-03-15T09:05:08'),
      },
    ],
    timestamp: new Date('2026-03-15T09:05:10'),
  },
];

// ---- Monitor instances (for dashboard scene with live monitoring) ----

export const MOCK_MONITORS: MockMonitorInstance[] = [
  {
    id: 'mon-1',
    description: 'Watching npm run dev output',
    active: true,
    persistent: true,
    startedAt: Date.now() - 120000,
    events: [
      { id: 'me-1', text: 'webpack compiled successfully in 1247ms', timestamp: Date.now() - 60000 },
      { id: 'me-2', text: '[HMR] Updated modules: ./src/components/DashboardView.tsx', timestamp: Date.now() - 45000 },
      { id: 'me-3', text: '[HMR] Updated modules: ./src/hooks/useMetricsStream.ts', timestamp: Date.now() - 30000 },
      { id: 'me-4', text: 'webpack compiled successfully in 342ms', timestamp: Date.now() - 29000 },
      { id: 'me-5', text: '[WS] Client connected: dashboard-dev', timestamp: Date.now() - 15000 },
      { id: 'me-6', text: '[WS] Broadcasting metrics: { activeUsers: 1247, rps: 3421 }', timestamp: Date.now() - 5000 },
    ],
  },
  {
    id: 'mon-2',
    description: 'Watching test suite (--watch)',
    active: true,
    persistent: false,
    startedAt: Date.now() - 90000,
    events: [
      { id: 'me-7', text: 'PASS src/components/dashboard/__tests__/DashboardView.test.tsx (7 tests)', timestamp: Date.now() - 40000 },
      { id: 'me-8', text: 'PASS src/server/__tests__/ws-metrics-server.test.ts (3 tests)', timestamp: Date.now() - 38000 },
      { id: 'me-9', text: 'Test Suites: 2 passed, 2 total | Tests: 10 passed, 10 total', timestamp: Date.now() - 37000 },
      { id: 'me-10', text: 'Waiting for file changes...', timestamp: Date.now() - 36000 },
    ],
  },
];

// ---- Tasks (for dashboard build scenario) ----

export const MOCK_TASKS_DASHBOARD: MockTask[] = [
  { id: 'task-1', subject: 'Set up WebSocket server with metrics broadcaster', status: 'completed' },
  { id: 'task-2', subject: 'Create useMetricsStream React hook with reconnection', status: 'completed' },
  { id: 'task-3', subject: 'Build DashboardView with KPI cards and chart', status: 'completed' },
  { id: 'task-4', subject: 'Implement live Recharts AreaChart with 60s rolling window', status: 'completed' },
  { id: 'task-5', subject: 'Add streaming event log component', status: 'in_progress', activeForm: 'Writing EventStream component with severity badges' },
  { id: 'task-6', subject: 'Wire up routes and run integration tests', status: 'pending' },
  { id: 'task-7', subject: 'Verify build and test coverage > 90%', status: 'pending' },
];

export const MOCK_TASKS_SSH: MockTask[] = [
  { id: 'ssh-task-1', subject: 'Check service status and error logs', status: 'completed' },
  { id: 'ssh-task-2', subject: 'Identify root cause of 503 errors', status: 'completed' },
  { id: 'ssh-task-3', subject: 'Query PostgreSQL connection pool state', status: 'completed' },
  { id: 'ssh-task-4', subject: 'Patch processWebhook() connection leak', status: 'completed' },
  { id: 'ssh-task-5', subject: 'Rebuild and restart service', status: 'completed' },
  { id: 'ssh-task-6', subject: 'Verify health check returns green', status: 'completed' },
];

// ---- Thinking content for extended thinking scene ----

export const MOCK_THINKING_CONTENT = `Analyzing the authentication flow...

The JWT middleware validates tokens at the gateway level, but the refresh logic has a race condition when multiple tabs request new tokens simultaneously.

Let me trace through the code:
1. Tab A detects expired token -> calls refreshToken()
2. Tab B detects expired token -> calls refreshToken()
3. Tab A gets new token, invalidates old refresh token
4. Tab B tries to use old refresh token -> FAILS with 401

The root cause is that refreshToken() is not idempotent. Each call generates a new refresh token and invalidates the previous one.

Solution: Implement a token refresh mutex using Redis distributed locks with a 5-second TTL. This ensures:
- Only one refresh happens at a time per user
- Other tabs wait for the first refresh to complete
- The TTL prevents deadlocks if the process crashes

Implementation plan:
1. Create TokenRefreshMutex class using Redis SET NX EX
2. Wrap refreshToken() in mutex.acquire() / mutex.release()
3. Add a token refresh queue for waiting requests
4. Add retry logic with exponential backoff`;

// ---- Tool calls for speed montage ----

export const MOCK_TERMINAL_OUTPUT = `\x1b[32m$\x1b[0m npm run test
\x1b[90m> build@0.3.7 test\x1b[0m
\x1b[90m> jest --coverage\x1b[0m

\x1b[32mPASS\x1b[0m src/middleware/__tests__/auth.test.ts
  \x1b[32m\u2713\x1b[0m should validate JWT tokens (3ms)
  \x1b[32m\u2713\x1b[0m should refresh expired tokens with mutex (12ms)
  \x1b[32m\u2713\x1b[0m should handle concurrent refresh requests (8ms)
  \x1b[32m\u2713\x1b[0m should timeout if lock not acquired (5ms)

\x1b[1mTest Suites:\x1b[0m 1 passed, 1 total
\x1b[1mTests:\x1b[0m       \x1b[32m4 passed\x1b[0m, 4 total
\x1b[1mTime:\x1b[0m        1.847s`;

export const MOCK_TERMINAL_OUTPUT_DASHBOARD = `\x1b[32m$\x1b[0m npm run dev
\x1b[90m> build@0.3.7 dev\x1b[0m
\x1b[90m> vite\x1b[0m

  \x1b[36mVITE\x1b[0m v5.4.8  ready in \x1b[32m347ms\x1b[0m

  \x1b[32m\u279c\x1b[0m  Local:   http://localhost:3001/
  \x1b[90m\u279c\x1b[0m  Network: http://192.168.1.42:3001/

\x1b[36m[WS]\x1b[0m Metrics server listening on ws://localhost:8081
\x1b[32m[WS]\x1b[0m Client connected: dashboard-dev
\x1b[32m[WS]\x1b[0m Broadcasting: { activeUsers: 1247, rps: 3421, errorRate: 0.02 }
\x1b[32m[WS]\x1b[0m Broadcasting: { activeUsers: 1253, rps: 3445, errorRate: 0.01 }
\x1b[32m[WS]\x1b[0m Broadcasting: { activeUsers: 1261, rps: 3467, errorRate: 0.02 }`;

export const MOCK_TERMINAL_OUTPUT_SSH = `\x1b[32m$\x1b[0m ssh deploy@prod-api-01.parcha.cloud
\x1b[90mConnected to prod-api-01.parcha.cloud\x1b[0m
\x1b[90mLast login: Mon Mar 15 06:00:12 2026 from 10.0.1.42\x1b[0m

\x1b[33mdeploy@prod-api-01\x1b[0m:\x1b[34m~\x1b[0m$ systemctl status parcha-api
\x1b[32m\u25cf\x1b[0m parcha-api.service - Parcha API Server
   Active: \x1b[32mactive (running)\x1b[0m since Mon 2026-03-15 06:00:00 UTC
   Main PID: 1847 (node)

\x1b[33mdeploy@prod-api-01\x1b[0m:\x1b[34m~\x1b[0m$ curl -s localhost:8080/health | jq .status
\x1b[32m"healthy"\x1b[0m`;

export const MOCK_GIT_CHANGES = [
  { path: 'src/lib/token-mutex.ts', status: 'added' as const, additions: 87, deletions: 0 },
  { path: 'src/middleware/auth.ts', status: 'modified' as const, additions: 23, deletions: 8 },
  { path: 'src/lib/api-client.ts', status: 'modified' as const, additions: 12, deletions: 4 },
  { path: 'src/hooks/useAuth.ts', status: 'modified' as const, additions: 6, deletions: 2 },
  { path: 'src/middleware/__tests__/auth.test.ts', status: 'added' as const, additions: 94, deletions: 0 },
];

export const MOCK_GIT_CHANGES_DASHBOARD = [
  { path: 'src/server/ws-metrics-server.ts', status: 'added' as const, additions: 127, deletions: 0 },
  { path: 'src/hooks/useMetricsStream.ts', status: 'added' as const, additions: 84, deletions: 0 },
  { path: 'src/components/dashboard/DashboardView.tsx', status: 'added' as const, additions: 203, deletions: 0 },
  { path: 'src/components/dashboard/MetricsChart.tsx', status: 'added' as const, additions: 91, deletions: 0 },
  { path: 'src/components/dashboard/EventStream.tsx', status: 'added' as const, additions: 67, deletions: 0 },
  { path: 'src/server/index.ts', status: 'modified' as const, additions: 8, deletions: 1 },
  { path: 'package.json', status: 'modified' as const, additions: 2, deletions: 0 },
  { path: 'src/components/dashboard/__tests__/DashboardView.test.tsx', status: 'added' as const, additions: 112, deletions: 0 },
  { path: 'src/server/__tests__/ws-metrics-server.test.ts', status: 'added' as const, additions: 78, deletions: 0 },
];
