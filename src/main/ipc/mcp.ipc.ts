/**
 * MCP IPC Handlers - Handle MCP server management from renderer
 */

import { type IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { mcpService } from '../services/mcp.service';
import { sshService } from '../services/ssh.service';
import { sessionService } from './session.ipc';
import type { MCPServerInfo, MarketplaceMCPServer } from '../../shared/types';

let remoteAuthSyncListenerRegistered = false;
let remoteMcpSyncInFlight = false;
let remoteMcpSyncQueued = false;

const REMOTE_MCP_SYNC_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

export function registerMcpHandlers(ipcMain: IpcMain): void {
  const syncConnectedSshSessions = async () => {
    const sessions = await sessionService.listSessions();
    await Promise.allSettled(
      sessions
        .filter((session) => session.sshConfig && sshService.isConnected(session.id))
        .map((session) => {
          console.log('[MCP IPC] Syncing MCP servers to SSH session:', session.id);
          return withTimeout(
            sshService.syncMcpConfigsToRemote(session.id, session.sshConfig!),
            REMOTE_MCP_SYNC_TIMEOUT_MS,
            `MCP sync to SSH session ${session.id}`
          ).catch((err) => {
            console.error('[MCP IPC] Error syncing to SSH session:', err);
          });
        })
    );
  };

  const scheduleRemoteMcpSync = () => {
    if (remoteMcpSyncInFlight) {
      remoteMcpSyncQueued = true;
      return;
    }

    remoteMcpSyncInFlight = true;
    void (async () => {
      try {
        do {
          remoteMcpSyncQueued = false;
          await syncConnectedSshSessions();
        } while (remoteMcpSyncQueued);
      } catch (err) {
        console.error('[MCP IPC] Error syncing MCP configs to SSH sessions:', err);
      } finally {
        remoteMcpSyncInFlight = false;
        if (remoteMcpSyncQueued) {
          scheduleRemoteMcpSync();
        }
      }
    })();
  };

  const syncHarnessesAndSshSessions = async () => {
    await mcpService.syncLocalHarnessConfigs().catch((err) => {
      console.error('[MCP IPC] Error syncing local harness MCP configs:', err);
    });
    scheduleRemoteMcpSync();
  };

  if (!remoteAuthSyncListenerRegistered) {
    remoteAuthSyncListenerRegistered = true;
    mcpService.onRemoteAuthPrewarmFinished((event) => {
      if (!event.authenticated) return;

      syncHarnessesAndSshSessions().catch((err) => {
        console.error('[MCP IPC] Error syncing MCP configs after remote auth prewarm:', err);
      });
    });
  }

  // Startup is cache-only: merely opening Build must never launch browser
  // OAuth. Completed desktop credentials are discovered and synced; missing
  // auth is omitted until the user explicitly installs/reconnects that server.
  void mcpService.removeLegacyOpenDesignMcpServer()
    .then(() => mcpService.prepareConfiguredRemoteAuth())
    .then(() => syncHarnessesAndSshSessions())
    .catch((error) => {
      console.warn('[MCP IPC] Initial MCP cleanup/auth cache preparation failed:', error);
    });

  // Get list of active/configured MCP servers
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_SERVERS,
    async (_event, sessionId: string, projectPath?: string): Promise<MCPServerInfo[]> => {
      try {
        console.log('[MCP IPC] Getting active servers for session:', sessionId);
        const servers = await mcpService.getActiveServers(projectPath);
        return servers;
      } catch (error) {
        console.error('[MCP IPC] Error getting servers:', error);
        throw error;
      }
    }
  );

  // Get raw electron-store config for a single MCP server
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_RAW_CONFIG,
    async (_event, serverId: string): Promise<Record<string, unknown> | null> => {
      try {
        console.log('[MCP IPC] Getting raw config for server:', serverId);
        return mcpService.getRawConfig(serverId);
      } catch (error) {
        console.error('[MCP IPC] Error getting raw config:', error);
        return null;
      }
    }
  );

  // Get marketplace MCP servers from official registry
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_MARKETPLACE,
    async (): Promise<MarketplaceMCPServer[]> => {
      try {
        console.log('[MCP IPC] Fetching marketplace servers from registry');
        return await mcpService.getMarketplaceServers();
      } catch (error) {
        console.error('[MCP IPC] Error getting marketplace:', error);
        throw error;
      }
    }
  );

  // Install an MCP server
  ipcMain.handle(
    IPC_CHANNELS.MCP_INSTALL_SERVER,
    async (
      _event,
      serverId: string,
      authValues: Record<string, string>
    ): Promise<{ success: boolean; error?: string; authUrl?: string }> => {
      try {
        console.log('[MCP IPC] Installing server:', serverId);

        // Find the server in marketplace
        const marketplaceServers = await mcpService.getMarketplaceServers();
        const server = marketplaceServers.find((s) => s.id === serverId);

        if (!server) {
          return { success: false, error: `Server not found in marketplace: ${serverId}` };
        }

        const result = await mcpService.installServer(server, authValues);

        // If successful, sync to all active SSH sessions
        if (result.success) {
          await syncHarnessesAndSshSessions();
        }

        return result;
      } catch (error) {
        console.error('[MCP IPC] Error installing server:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Install an MCP server with raw config
  ipcMain.handle(
    IPC_CHANNELS.MCP_INSTALL_SERVER_RAW,
    async (
      _event,
      serverId: string,
      config: Record<string, unknown>
    ): Promise<{ success: boolean; error?: string; authUrl?: string }> => {
      try {
        console.log('[MCP IPC] Installing server (raw config):', serverId);
        const result = await mcpService.installServerRaw(serverId, config as any);

        // If successful, sync to all active SSH sessions
        if (result.success) {
          await syncHarnessesAndSshSessions();
        }

        return result;
      } catch (error) {
        console.error('[MCP IPC] Error installing server (raw):', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Uninstall an MCP server
  ipcMain.handle(
    IPC_CHANNELS.MCP_UNINSTALL_SERVER,
    async (_event, serverId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        console.log('[MCP IPC] Uninstalling server:', serverId);
        const result = await mcpService.uninstallServer(serverId);
        if (result.success) {
          await syncHarnessesAndSshSessions();
        }
        return result;
      } catch (error) {
        console.error('[MCP IPC] Error uninstalling server:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );
}
