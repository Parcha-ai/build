import { EventEmitter } from 'events';

interface ScheduledWakeup {
  sessionId: string;
  prompt: string;
  reason: string;
  timer: ReturnType<typeof setTimeout>;
  scheduledFor: number;
  delaySeconds: number;
}

interface ScheduledCron {
  sessionId: string;
  prompt: string;
  schedule: string;
  interval: ReturnType<typeof setInterval>;
  cronId: string;
}

/**
 * WakeupScheduler — manages timers for ScheduleWakeup, CronCreate, and PushNotification.
 * When a timer fires, emits 'wakeup' with { sessionId, prompt } so the main process
 * can re-invoke the Claude query for that session.
 */
export class WakeupScheduler extends EventEmitter {
  private wakeups = new Map<string, ScheduledWakeup>(); // sessionId → pending wakeup
  private crons = new Map<string, ScheduledCron>(); // cronId → recurring job
  private cronCounter = 0;

  scheduleWakeup(sessionId: string, delaySeconds: number, prompt: string, reason: string): {
    scheduledFor: number;
    clampedDelaySeconds: number;
    wasClamped: boolean;
  } {
    // Cancel any existing wakeup for this session
    this.cancelWakeup(sessionId);

    // Clamp to [60, 3600] like the CLI does
    const clamped = Math.max(60, Math.min(3600, delaySeconds));
    const wasClamped = clamped !== delaySeconds;
    const scheduledFor = Date.now() + clamped * 1000;

    console.log(`[WakeupScheduler] Scheduling wakeup for session ${sessionId} in ${clamped}s (reason: ${reason})`);

    const timer = setTimeout(() => {
      console.log(`[WakeupScheduler] Wakeup fired for session ${sessionId} (reason: ${reason})`);
      this.wakeups.delete(sessionId);
      this.emit('wakeup', { sessionId, prompt, reason });
    }, clamped * 1000);

    // Don't keep the process alive just for wakeups
    timer.unref();

    this.wakeups.set(sessionId, {
      sessionId,
      prompt,
      reason,
      timer,
      scheduledFor,
      delaySeconds: clamped,
    });

    return { scheduledFor, clampedDelaySeconds: clamped, wasClamped };
  }

  cancelWakeup(sessionId: string): boolean {
    const existing = this.wakeups.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.wakeups.delete(sessionId);
      console.log(`[WakeupScheduler] Cancelled wakeup for session ${sessionId}`);
      return true;
    }
    return false;
  }

  createCron(sessionId: string, schedule: string, prompt: string): {
    cronId: string;
    nextRun: number;
  } {
    // Parse simple interval formats: "every 5m", "every 1h", "every 30s"
    const intervalMs = this.parseInterval(schedule);
    if (!intervalMs) {
      throw new Error(`Unsupported schedule format: ${schedule}. Use "every Xs", "every Xm", or "every Xh".`);
    }

    const cronId = `cron-${++this.cronCounter}-${Date.now()}`;
    const nextRun = Date.now() + intervalMs;

    console.log(`[WakeupScheduler] Creating cron ${cronId} for session ${sessionId}: ${schedule}`);

    const interval = setInterval(() => {
      console.log(`[WakeupScheduler] Cron ${cronId} fired for session ${sessionId}`);
      this.emit('wakeup', { sessionId, prompt, reason: `cron: ${schedule}` });
    }, intervalMs);

    interval.unref();

    this.crons.set(cronId, { sessionId, prompt, schedule, interval, cronId });

    return { cronId, nextRun };
  }

  deleteCron(cronId: string): boolean {
    const cron = this.crons.get(cronId);
    if (cron) {
      clearInterval(cron.interval);
      this.crons.delete(cronId);
      console.log(`[WakeupScheduler] Deleted cron ${cronId}`);
      return true;
    }
    return false;
  }

  listCrons(sessionId?: string): Array<{ cronId: string; schedule: string; sessionId: string }> {
    const result: Array<{ cronId: string; schedule: string; sessionId: string }> = [];
    for (const cron of this.crons.values()) {
      if (!sessionId || cron.sessionId === sessionId) {
        result.push({ cronId: cron.cronId, schedule: cron.schedule, sessionId: cron.sessionId });
      }
    }
    return result;
  }

  getPendingWakeup(sessionId: string): { scheduledFor: number; reason: string } | null {
    const wakeup = this.wakeups.get(sessionId);
    if (!wakeup) return null;
    return { scheduledFor: wakeup.scheduledFor, reason: wakeup.reason };
  }

  cancelAllForSession(sessionId: string): void {
    this.cancelWakeup(sessionId);
    for (const [cronId, cron] of this.crons.entries()) {
      if (cron.sessionId === sessionId) {
        this.deleteCron(cronId);
      }
    }
  }

  destroy(): void {
    for (const wakeup of this.wakeups.values()) {
      clearTimeout(wakeup.timer);
    }
    this.wakeups.clear();
    for (const cron of this.crons.values()) {
      clearInterval(cron.interval);
    }
    this.crons.clear();
  }

  private parseInterval(schedule: string): number | null {
    const match = schedule.match(/every\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('s')) return value * 1000;
    if (unit.startsWith('m')) return value * 60 * 1000;
    if (unit.startsWith('h')) return value * 3600 * 1000;
    return null;
  }
}

export const wakeupScheduler = new WakeupScheduler();
