import type { ChatMessage, Session, ToolCall } from '../../shared/types';
import { getSessionDisplayName, getSidebarSessionDisplayName } from './session-display';

export const APP_VOICE_SESSION_ID = 'build-app';
export const VOICE_RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface VoiceDirectoryState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  isStreaming: Record<string, boolean>;
  currentThinkingContent: Record<string, string>;
  currentStreamContent: Record<string, string>;
  currentToolCalls: Record<string, ToolCall[]>;
  activeStreamModel: Record<string, string | undefined>;
  selectedModel: Record<string, string>;
  pendingPermission: Record<string, { requestId?: string; toolName?: string } | null>;
  pendingQuestion: Record<string, { requestId?: string; questions?: Array<{ question?: string }> } | null>;
  pendingPlanApproval: Record<string, { requestId?: string; planContent?: string } | null>;
}

export interface VoiceSessionGroup {
  root: Session;
  sessionName: string;
  tabs: Session[];
  activeTab: Session | null;
  defaultTab: Session;
  starred: boolean;
  working: boolean;
  updatedAtMs: number;
}

export interface VoiceTabLocation {
  group: VoiceSessionGroup;
  tab: Session;
  sessionName: string;
  tabName: string;
  label: string;
}

export interface VoiceDestinationResolution {
  match: VoiceTabLocation | null;
  candidates: string[];
}

function asTime(value: Date | string | number | undefined): number {
  if (!value) return 0;
  const time = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? new Date(value).getTime()
      : typeof value.getTime === 'function'
        ? value.getTime()
        : 0;
  return Number.isFinite(time) ? time : 0;
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const DESTINATION_FILLER_WORDS = new Set([
  'a', 'an', 'back', 'bring', 'conversation', 'focus', 'go', 'i', 'in', 'jump',
  'last', 'latest', 'me', 'most', 'on', 'open', 'please', 'recent', 'recently',
  'return', 'session', 'show', 'switch', 'tab', 'take', 'the', 'to', 'view', 'was',
  'we', 'were', 'work', 'worked', 'working',
]);

function normalizeDestinationQuery(value: string): string {
  const normalized = normalizeLookup(value);
  const meaningful = normalized
    .split(' ')
    .filter((word) => word && !DESTINATION_FILLER_WORDS.has(word));
  return meaningful.join(' ') || normalized;
}

function prefersMostRecent(value: string): boolean {
  return /\b(?:last|latest|newest|most recent|recently|updated|we (?:were|have been) working on|worked on)\b/i.test(value);
}

function rootFor(session: Session, byId: Map<string, Session>): Session {
  let root = session;
  const seen = new Set<string>([root.id]);
  while (root.parentSessionId && !seen.has(root.parentSessionId)) {
    const parent = byId.get(root.parentSessionId);
    if (!parent) break;
    root = parent;
    seen.add(root.id);
  }
  return root;
}

function tabSort(a: Session, b: Session): number {
  return asTime(a.forkCreatedAt || a.createdAt) - asTime(b.forkCreatedAt || b.createdAt);
}

function latestMessageByRole(messages: ChatMessage[], role: ChatMessage['role']): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return messages[index];
  }
  return undefined;
}

function excerpt(content: unknown, maxLength: number): string {
  const value = typeof content === 'string' ? content : JSON.stringify(content);
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function attentionFor(state: VoiceDirectoryState, tabId: string): string | undefined {
  if (state.pendingPermission[tabId]) return 'permission';
  if (state.pendingQuestion[tabId]) return 'question';
  if (state.pendingPlanApproval[tabId]) return 'plan approval';
  const session = state.sessions.find((candidate) => candidate.id === tabId);
  return session?.status === 'error' ? 'error' : undefined;
}

function aliasesForSession(session: Session): string[] {
  const workspace = session.worktreePath || session.repoPath || session.sshConfig?.remoteWorkdir || '';
  const workspaceLeaf = workspace.split('/').filter(Boolean).at(-1) || '';
  return [
    session.id,
    getSessionDisplayName(session),
    session.manualName,
    session.aiGeneratedName,
    session.forkName,
    session.name,
    session.branch,
    workspace,
    workspaceLeaf,
  ].filter((value): value is string => Boolean(value));
}

function topicAliasesForTab(state: VoiceDirectoryState, tabId: string): string[] {
  return (state.messages[tabId] || [])
    .filter((message) => message.role === 'user')
    .slice(-8)
    .map((message) => excerpt(message.content, 500));
}

function scoreAliases(query: string, aliases: string[]): number {
  query = normalizeDestinationQuery(query);
  const values = aliases.map(normalizeLookup).filter(Boolean);
  if (values.some((value) => value === query)) return 4;
  if (values.some((value) => value.startsWith(query) || query.startsWith(value))) return 3;
  if (values.some((value) => value.includes(query) || query.includes(value))) return 2;
  const words = query.split(' ').filter(Boolean);
  return words.length > 1 && values.some((value) => words.every((word) => value.includes(word))) ? 1 : 0;
}

/**
 * Model the same two levels the UI exposes: one sidebar session containing one
 * or more conversation tabs. A stale starred bit on an old child tab must not
 * turn that child into a fake top-level favorite.
 */
export function getVoiceSessionGroups(
  state: VoiceDirectoryState,
  now = Date.now(),
): VoiceSessionGroup[] {
  const byId = new Map(state.sessions.map((session) => [session.id, session]));
  const tabsByRoot = new Map<string, Session[]>();

  for (const session of state.sessions) {
    const root = rootFor(session, byId);
    const tabs = tabsByRoot.get(root.id) || [];
    tabs.push(session);
    tabsByRoot.set(root.id, tabs);
  }

  const groups: VoiceSessionGroup[] = [];
  for (const [rootId, unsortedTabs] of tabsByRoot) {
    const root = byId.get(rootId);
    if (!root) continue;
    const tabs = [...unsortedTabs].sort(tabSort);
    const activeTab = tabs.find((tab) => tab.id === state.activeSessionId) || null;
    const workingTabs = tabs.filter((tab) => state.isStreaming[tab.id]);
    const updatedAtMs = Math.max(...tabs.map((tab) => asTime(tab.updatedAt)), 0);
    const recent = now - updatedAtMs <= VOICE_RECENT_SESSION_WINDOW_MS;
    const starred = Boolean(root.isStarred);
    if (!starred && !activeTab && workingTabs.length === 0 && !recent) continue;

    const visibleTabs = tabs.filter((tab) => !tab.tabHidden);
    const defaultTab = activeTab
      || [...workingTabs].sort((a, b) => asTime(b.updatedAt) - asTime(a.updatedAt))[0]
      || [...visibleTabs].sort((a, b) => asTime(b.updatedAt) - asTime(a.updatedAt))[0]
      || [...tabs].sort((a, b) => asTime(b.updatedAt) - asTime(a.updatedAt))[0]
      || root;
    groups.push({
      root,
      sessionName: getSidebarSessionDisplayName(root, state.sessions),
      tabs,
      activeTab,
      defaultTab,
      starred,
      working: workingTabs.length > 0,
      updatedAtMs,
    });
  }

  return groups.sort((a, b) => {
    if (Boolean(a.activeTab) !== Boolean(b.activeTab)) return a.activeTab ? -1 : 1;
    if (a.working !== b.working) return a.working ? -1 : 1;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

export function getVoiceEligibleTabs(state: VoiceDirectoryState, now = Date.now()): Session[] {
  return getVoiceSessionGroups(state, now).flatMap((group) => group.tabs);
}

export function getVoiceTabLocation(
  sessionId: string,
  state: VoiceDirectoryState,
  now = Date.now(),
): VoiceTabLocation | null {
  for (const group of getVoiceSessionGroups(state, now)) {
    const tab = group.tabs.find((candidate) => candidate.id === sessionId);
    if (!tab) continue;
    const tabName = getSessionDisplayName(tab);
    const sameName = normalizeLookup(tabName) === normalizeLookup(group.sessionName);
    return {
      group,
      tab,
      sessionName: group.sessionName,
      tabName,
      label: group.tabs.length === 1 || sameName
        ? group.sessionName
        : `${tabName} tab in ${group.sessionName}`,
    };
  }
  return null;
}

function rankedMatches<T>(
  queryValue: string,
  entries: Array<{
    value: T;
    aliases: string[];
    label: string;
    updatedAtMs?: number;
    working?: boolean;
  }>,
): Array<{ value: T; label: string; score: number; updatedAtMs: number; working: boolean }> {
  const query = normalizeDestinationQuery(queryValue);
  if (!query) return [];
  return entries
    .map((entry) => ({
      ...entry,
      score: scoreAliases(query, entry.aliases),
      updatedAtMs: entry.updatedAtMs || 0,
      working: Boolean(entry.working),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (prefersMostRecent(queryValue) && a.working !== b.working) return a.working ? -1 : 1;
      return b.updatedAtMs - a.updatedAtMs;
    });
}

function chooseMatch<T>(
  matches: Array<{ value: T; score: number; updatedAtMs: number }>,
  query: string,
  allowRecencyFallback = false,
): T | null {
  const topScore = matches[0]?.score || 0;
  const topMatches = matches.filter((entry) => entry.score === topScore);
  if (topMatches.length === 1) return topMatches[0].value;
  // Switching tabs is harmless and reversible. When multiple tabs have the
  // exact same visible name, default to the latest one instead of making the
  // voice model conduct an impossible disambiguation through identical names.
  // Explicit IDs/prefixes still select an older duplicate deterministically.
  if ((topScore === 4 || prefersMostRecent(query) || allowRecencyFallback) && topMatches.length > 1) {
    const [latest, next] = topMatches;
    if (latest.updatedAtMs > next.updatedAtMs) return latest.value;
  }
  return null;
}

function candidateLabel(location: VoiceTabLocation): string {
  return `${location.label} [${location.tab.id.slice(0, 8)}; updated ${new Date(location.tab.updatedAt).toISOString()}]`;
}

/** Resolve either a sidebar session, a tab by itself, or a tab within a named session. */
export function resolveVoiceDestination(
  state: VoiceDirectoryState,
  sessionName: string,
  tabName?: string,
  now = Date.now(),
): VoiceDestinationResolution {
  const groups = getVoiceSessionGroups(state, now);
  let scopedGroups = groups;

  if (sessionName.trim()) {
    const groupMatches = rankedMatches(sessionName, groups.map((group) => ({
      value: group,
      aliases: [group.root.id, group.sessionName, ...aliasesForSession(group.root)],
      label: group.sessionName,
      updatedAtMs: group.updatedAtMs,
      working: group.working,
    })));
    const selectedGroup = chooseMatch(groupMatches, sessionName);
    if (!tabName?.trim() && selectedGroup) {
      const group = selectedGroup;
      return {
        match: getVoiceTabLocation(group.defaultTab.id, state, now),
        candidates: groupMatches.slice(0, 5).map((entry) => entry.label),
      };
    }
    if (tabName?.trim()) {
      if (!selectedGroup) {
        return { match: null, candidates: groupMatches.slice(0, 5).map((entry) => entry.label) };
      }
      scopedGroups = [selectedGroup];
    }
  }

  const effectiveTabQuery = tabName?.trim() || sessionName.trim();
  const tabEntries = scopedGroups.flatMap((group) => group.tabs.map((tab) => {
    const location = getVoiceTabLocation(tab.id, state, now)!;
    return {
      value: location,
      aliases: aliasesForSession(tab),
      label: candidateLabel(location),
      updatedAtMs: asTime(tab.updatedAt),
      working: Boolean(state.isStreaming[tab.id]),
    };
  }));
  const tabMatches = rankedMatches(effectiveTabQuery, tabEntries);
  const structuralMatch = chooseMatch(tabMatches, effectiveTabQuery);
  if (structuralMatch) {
    return {
      match: structuralMatch,
      candidates: tabMatches.slice(0, 5).map((entry) => entry.label),
    };
  }

  // A tab may have been renamed since the work the user remembers. Search its
  // recent requests only after structural aliases fail, then select the most
  // recently used clear winner. This makes requests such as "open the last
  // changelog tab" work even when that conversation was later renamed.
  if (tabMatches.length === 0) {
    const topicMatches = rankedMatches(effectiveTabQuery, scopedGroups.flatMap((group) => group.tabs.map((tab) => {
      const location = getVoiceTabLocation(tab.id, state, now)!;
      return {
        value: location,
        aliases: topicAliasesForTab(state, tab.id),
        label: candidateLabel(location),
        updatedAtMs: asTime(tab.updatedAt),
        working: Boolean(state.isStreaming[tab.id]),
      };
    })));
    return {
      match: chooseMatch(topicMatches, effectiveTabQuery, true),
      candidates: topicMatches.slice(0, 5).map((entry) => entry.label),
    };
  }

  return {
    match: null,
    candidates: tabMatches.slice(0, 5).map((entry) => entry.label),
  };
}

export function describeVoiceSessionDirectory(
  state: VoiceDirectoryState,
  options: { maxGroups?: number; maxTabsPerGroup?: number } = {},
): string {
  const maxGroups = options.maxGroups ?? 12;
  const maxTabsPerGroup = options.maxTabsPerGroup ?? 8;
  const groups = getVoiceSessionGroups(state);
  const entries = groups.slice(0, maxGroups).map((group) => {
    const priorityTabs = [...group.tabs].sort((a, b) => {
      if (a.id === state.activeSessionId) return -1;
      if (b.id === state.activeSessionId) return 1;
      if (Boolean(state.isStreaming[a.id]) !== Boolean(state.isStreaming[b.id])) return state.isStreaming[a.id] ? -1 : 1;
      if (Boolean(a.tabHidden) !== Boolean(b.tabHidden)) return a.tabHidden ? 1 : -1;
      return asTime(b.updatedAt) - asTime(a.updatedAt);
    });
    const tabs = priorityTabs.slice(0, maxTabsPerGroup).map((tab) => {
      const messages = state.messages[tab.id] || [];
      const latestUser = latestMessageByRole(messages, 'user');
      const latestAssistant = latestMessageByRole(messages, 'assistant');
      const latestTool = (state.currentToolCalls[tab.id] || []).at(-1);
      return {
        tabId: tab.id,
        tabName: getSessionDisplayName(tab),
        active: tab.id === state.activeSessionId,
        working: Boolean(state.isStreaming[tab.id]),
        hidden: Boolean(tab.tabHidden),
        runtimeStatus: tab.status,
        attention: attentionFor(state, tab.id),
        model: state.activeStreamModel[tab.id] || state.selectedModel[tab.id] || tab.model,
        harness: latestAssistant?.harness || latestUser?.harness,
        branch: tab.branch,
        updatedAt: new Date(tab.updatedAt).toISOString(),
        latestUserRequest: latestUser ? excerpt(latestUser.content, 220) : undefined,
        latestOutcome: latestAssistant ? excerpt(latestAssistant.content, 260) : undefined,
        currentActivity: latestTool ? { name: latestTool.name, input: latestTool.input } : undefined,
        recentThinking: state.isStreaming[tab.id]
          ? excerpt(state.currentThinkingContent[tab.id] || state.currentStreamContent[tab.id] || '', 220)
          : undefined,
      };
    });
    const workspace = group.root.sshConfig?.remoteWorkdir || group.root.worktreePath || group.root.repoPath;
    return {
      sessionId: group.root.id,
      sessionName: group.sessionName,
      active: Boolean(group.activeTab),
      activeTabId: group.activeTab?.id,
      starred: group.starred,
      working: group.working,
      host: group.root.sshConfig
        ? `${group.root.sshConfig.username}@${group.root.sshConfig.host}`
        : 'local',
      workspace,
      branch: group.defaultTab.branch || group.root.branch,
      updatedAt: new Date(group.updatedAtMs).toISOString(),
      tabs,
      omittedTabs: Math.max(0, group.tabs.length - tabs.length),
    };
  });

  return JSON.stringify({
    scope: 'sidebar sessions that are favorited, currently working, active, or updated during the last 24 hours; tabs are nested under their sidebar session',
    generatedAt: new Date().toISOString(),
    activeTabId: state.activeSessionId,
    sessions: entries,
    omittedSessions: Math.max(0, groups.length - entries.length),
  });
}
