import { SchedulerSettings } from '../types';

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  enabled: false,
  start_time: '00:00',
  stop_time: '00:00',
  pause_on_stop: true,
  days: [0, 1, 2, 3, 4, 5, 6],
};

function parseMinutes(hhmm: string): number | null {
  const match = (hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/**
 * Evaluates whether queue execution is allowed right now under the active scheduler config.
 * Supports same-day (e.g. 09:00–17:00) and overnight windows (e.g. 23:00–06:00).
 */
export function isWithinSchedulerWindow(
  scheduler: SchedulerSettings | undefined | null,
  now: Date = new Date()
): boolean {
  if (!scheduler || !scheduler.enabled) return true;

  const startMin = parseMinutes(scheduler.start_time);
  const stopMin = parseMinutes(scheduler.stop_time);
  if (startMin === null || stopMin === null) return true;

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const allowedDays = Array.isArray(scheduler.days) && scheduler.days.length > 0
    ? scheduler.days
    : [0, 1, 2, 3, 4, 5, 6];

  const today = now.getDay();

  if (startMin === stopMin) {
    return allowedDays.includes(today);
  }

  if (startMin < stopMin) {
    return allowedDays.includes(today) && currentMin >= startMin && currentMin < stopMin;
  }

  // Overnight window (e.g. 23:00 -> 06:00)
  if (currentMin >= startMin) {
    return allowedDays.includes(today);
  }
  if (currentMin < stopMin) {
    const yesterday = (today + 6) % 7;
    return allowedDays.includes(yesterday);
  }
  return false;
}
