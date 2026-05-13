import { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/channels';
import { analyticsService } from '../services/analytics.service';
import type { UsageTierConfig } from '../services/analytics.service';

export function registerAnalyticsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SUMMARY, async () => {
    return analyticsService.getSummary();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SESSION_COST, async (_, sessionId: string) => {
    return analyticsService.getSessionCost(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_TIER_CONFIG, async () => {
    return analyticsService.getTierConfig();
  });

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SET_TIER_CONFIG, async (_, config: UsageTierConfig) => {
    analyticsService.setTierConfig(config);
    return { success: true };
  });
}
