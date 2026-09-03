import { BrowserWindow } from 'electron';

class PlanningLockService {
  private active = false;

  setActive(active: boolean, calendarUrl?: string, sourceWindow?: BrowserWindow | null): void {
    if (!active) {
      this.active = false;
      return;
    }

    if (this.active) return;
    this.active = true;

    const mainWindow = sourceWindow && !sourceWindow.isDestroyed()
      ? sourceWindow
      : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

export const planningLockService = new PlanningLockService();
