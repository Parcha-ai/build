/**
 * Power management service — prevents system sleep when Claude sessions are actively streaming
 * and the machine is plugged in (AC power).
 *
 * Uses Electron's powerSaveBlocker to prevent app suspension during active queries,
 * and powerMonitor to detect AC/battery transitions.
 */
import { powerSaveBlocker, powerMonitor } from 'electron';

class PowerService {
  private blockerId: number | null = null;
  private activeSessionCount = 0;
  private isOnAC = true;
  private systemResumeListeners = new Set<() => void>();

  init() {
    // Check initial power state
    this.isOnAC = powerMonitor.isOnBatteryPower() === false;
    console.log(`[Power] Initialized — AC power: ${this.isOnAC}`);

    // Listen for power source changes
    powerMonitor.on('on-ac', () => {
      console.log('[Power] Switched to AC power');
      this.isOnAC = true;
      this.updateBlocker();
    });

    powerMonitor.on('on-battery', () => {
      console.log('[Power] Switched to battery power');
      this.isOnAC = false;
      this.updateBlocker();
    });

    // Wake-from-sleep: SSH connections died while asleep, but detached remote
    // turns kept running. Listeners reattach to them.
    powerMonitor.on('resume', () => {
      console.log('[Power] System resumed from sleep — notifying resume listeners');
      for (const listener of this.systemResumeListeners) {
        try {
          listener();
        } catch (error) {
          console.warn('[Power] System resume listener failed:', error);
        }
      }
    });
  }

  /**
   * Register a callback fired when the system wakes from sleep.
   * Returns an unsubscribe function.
   */
  onSystemResume(listener: () => void): () => void {
    this.systemResumeListeners.add(listener);
    return () => this.systemResumeListeners.delete(listener);
  }

  /**
   * Call when a streaming session starts.
   */
  sessionStarted() {
    this.activeSessionCount++;
    console.log(`[Power] Session started — active: ${this.activeSessionCount}`);
    this.updateBlocker();
  }

  /**
   * Call when a streaming session ends (success, error, or abort).
   */
  sessionEnded() {
    this.activeSessionCount = Math.max(0, this.activeSessionCount - 1);
    console.log(`[Power] Session ended — active: ${this.activeSessionCount}`);
    this.updateBlocker();
  }

  private updateBlocker() {
    const shouldBlock = this.activeSessionCount > 0 && this.isOnAC;

    if (shouldBlock && this.blockerId === null) {
      // 'prevent-app-suspension' keeps the app running but allows display to sleep
      this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log(`[Power] Sleep blocker STARTED (id: ${this.blockerId}) — ${this.activeSessionCount} active session(s), on AC`);
    } else if (!shouldBlock && this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId);
      console.log(`[Power] Sleep blocker STOPPED (id: ${this.blockerId}) — active: ${this.activeSessionCount}, AC: ${this.isOnAC}`);
      this.blockerId = null;
    }
  }

  /**
   * Returns current power management state for debugging/UI.
   */
  getStatus() {
    return {
      isBlocking: this.blockerId !== null,
      activeSessionCount: this.activeSessionCount,
      isOnAC: this.isOnAC,
    };
  }

  /**
   * Clean up on app quit.
   */
  dispose() {
    if (this.blockerId !== null) {
      if (powerSaveBlocker.isStarted(this.blockerId)) {
        powerSaveBlocker.stop(this.blockerId);
      }
      this.blockerId = null;
    }
  }
}

export const powerService = new PowerService();
