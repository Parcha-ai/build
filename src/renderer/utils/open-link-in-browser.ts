import { getBrowserPartitionId } from '../../shared/utils/browser-partition';
import { useSessionStore } from '../stores/session.store';
import { useUIStore } from '../stores/ui.store';

function normalizeWebUrl(href: string): string {
  const trimmed = href.trim();
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function browserTabName(url: string): string {
  try {
    return new URL(url).hostname || 'Browser';
  } catch {
    return 'Browser';
  }
}

/**
 * Open a transcript/report link in Build's inline browser workspace. Keeping
 * this in one place prevents individual Markdown renderers from accidentally
 * falling back to a top-level Electron navigation.
 */
export async function openLinkInAppBrowser(href: string, preferredSessionId?: string | null): Promise<void> {
  const url = normalizeWebUrl(href);
  if (!url) return;

  // Browser previews are for navigable pages. Protocol actions still belong to
  // the operating system (email, phone, custom OAuth callbacks, and so on).
  if (!/^https?:\/\//i.test(url)) {
    await window.electronAPI.app.openExternal(url);
    return;
  }

  const sessionState = useSessionStore.getState();
  const session = sessionState.sessions.find((candidate) => candidate.id === preferredSessionId)
    || sessionState.sessions.find((candidate) => candidate.id === sessionState.activeSessionId);
  if (!session) {
    await window.electronAPI.app.openExternal(url);
    return;
  }

  const partitionId = getBrowserPartitionId(session.id, sessionState.sessions);
  const ui = useUIStore.getState();
  const selectedTabId = ui.activeBrowserTabIdsByPartition[partitionId];
  const selectedTab = ui.browserTabs.find((tab) => tab.id === selectedTabId && tab.partitionId === partitionId);

  // Opening the browser is explicitly session-scoped so it restores as a split
  // panel beside the chat instead of replacing the Build renderer.
  ui.enableSessionBrowser(session.id);
  void sessionState.updateSession(session.id, { lastBrowserUrl: url });

  if (!selectedTab) {
    ui.createBrowserTab(session.id, partitionId, url, browserTabName(url));
    return;
  }

  ui.setActiveBrowserTab(selectedTab.id);
  ui.updateBrowserTabUrl(selectedTab.id, url);
  await window.electronAPI.browser.navigateTo(session.id, url);
}
