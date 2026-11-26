import { DownloadTask, TaskStatus } from '../types';
import { formatBytes, formatDuration } from './engine-parser';

/**
 * Valid transitions for the Download Core finite state machine.
 * Enforces deterministic lifecycle guarantees and rejects stale out-of-order updates.
 */
export const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['inspecting', 'ready', 'connecting', 'downloading', 'pausing', 'paused', 'cancelled', 'failed'],
  inspecting: ['ready', 'queued', 'connecting', 'downloading', 'paused', 'failed', 'cancelled'],
  ready: ['queued', 'connecting', 'downloading', 'paused', 'failed', 'cancelled'],
  connecting: ['downloading', 'processing', 'muxing', 'verifying', 'pausing', 'paused', 'failed', 'cancelled'],
  downloading: ['connecting', 'processing', 'muxing', 'verifying', 'completed', 'pausing', 'paused', 'failed', 'cancelled'],
  pausing: ['paused', 'cancelled', 'failed'],
  paused: ['resuming', 'queued', 'connecting', 'downloading', 'cancelled'],
  resuming: ['connecting', 'downloading', 'pausing', 'paused', 'failed', 'cancelled'],
  processing: ['muxing', 'downloading', 'verifying', 'completed', 'pausing', 'paused', 'failed', 'cancelled'],
  muxing: ['processing', 'downloading', 'verifying', 'completed', 'pausing', 'paused', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: ['queued'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
};

export function canTransitionTask(current: TaskStatus, next: TaskStatus): boolean {
  if (current === next) return true;
  const allowed = VALID_TASK_TRANSITIONS[current];
  return allowed ? allowed.includes(next) : false;
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'inspecting' ||
    status === 'connecting' ||
    status === 'downloading' ||
    status === 'resuming' ||
    status === 'processing' ||
    status === 'muxing' ||
    status === 'verifying' ||
    status === 'pausing'
  );
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function clampPercentage(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Number(pct.toFixed(2))));
}

export interface ProgressSampleInput {
  downloadedBytes: number;
  totalBytes: number;
  instantSpeedBytesPerSec?: number;
  percentageHint?: number;
  activeConnections?: number;
  nowMs?: number;
}

export interface ComputedProgressState {
  downloaded_bytes: number;
  total_bytes: number;
  remaining_bytes: number;
  progress_percentage: number;
  percentage_known: boolean;
  speed_bytes_per_sec: number;
  avg_speed_bytes_per_sec: number;
  speed_str: string;
  eta_seconds: number | null;
  eta_str: string;
  elapsed_seconds: number;
  active_connections: number;
  last_progress_at: string;
}

/**
 * Stateful EMA-smoothed download progress engine.
 * Never fabricates percentages, speeds, or ETAs when underlying measurements are missing.
 */
export class ProgressTracker {
  private readonly alpha: number;
  private readonly startedAtMs: number;
  private lastSampleAtMs: number;
  private lastDownloadedBytes: number;
  private knownTotalBytes = 0;
  private emaSpeedBytesPerSec = 0;

  constructor(options?: { alpha?: number; startedAtMs?: number; initialBytes?: number }) {
    this.alpha = options?.alpha ?? 0.3;
    const start = options?.startedAtMs ?? Date.now();
    this.startedAtMs = start;
    this.lastSampleAtMs = start;
    this.lastDownloadedBytes = Math.max(0, options?.initialBytes ?? 0);
  }

  public resetStream(options?: { nowMs?: number; initialBytes?: number }): void {
    const now = options?.nowMs ?? Date.now();
    this.lastSampleAtMs = now;
    this.lastDownloadedBytes = Math.max(0, options?.initialBytes ?? 0);
    this.knownTotalBytes = 0;
    this.emaSpeedBytesPerSec = 0;
  }

  public update(sample: ProgressSampleInput): ComputedProgressState {
    const nowMs = sample.nowMs ?? Date.now();
    const rawDownloaded = Math.max(0, Math.round(sample.downloadedBytes));
    const rawTotal = Math.max(0, Math.round(sample.totalBytes));
    if (rawTotal > 0) {
      this.knownTotalBytes = Math.max(this.knownTotalBytes, rawTotal);
    }

    // Within a single active stream, retain monotonic downloaded bytes; if transitioning to
    // a secondary stream (e.g., audio after video), explicit resetStream() handles it cleanly.
    const downloaded = Math.max(this.lastDownloadedBytes, rawDownloaded);
    const total = rawTotal > 0 ? Math.max(rawTotal, downloaded) : this.knownTotalBytes > 0 && downloaded <= this.knownTotalBytes ? this.knownTotalBytes : 0;

    const dtSec = Math.max(0.05, (nowMs - this.lastSampleAtMs) / 1000);
    const totalElapsedSec = Math.max(0, Math.round((nowMs - this.startedAtMs) / 1000));

    let measuredSpeed = sample.instantSpeedBytesPerSec;
    if (measuredSpeed === undefined || !Number.isFinite(measuredSpeed) || measuredSpeed < 0) {
      const deltaBytes = Math.max(0, downloaded - this.lastDownloadedBytes);
      measuredSpeed = deltaBytes / dtSec;
    }

    if (measuredSpeed > 0) {
      this.emaSpeedBytesPerSec =
        this.emaSpeedBytesPerSec === 0
          ? measuredSpeed
          : this.alpha * measuredSpeed + (1 - this.alpha) * this.emaSpeedBytesPerSec;
    } else if (nowMs - this.lastSampleAtMs > 2500) {
      // Decay speed smoothly toward 0 if stalled
      this.emaSpeedBytesPerSec = this.emaSpeedBytesPerSec * 0.5;
      if (this.emaSpeedBytesPerSec < 1) this.emaSpeedBytesPerSec = 0;
    }

    this.lastSampleAtMs = nowMs;
    this.lastDownloadedBytes = downloaded;

    const avgSpeed =
      totalElapsedSec > 0 && downloaded > 0 ? downloaded / totalElapsedSec : this.emaSpeedBytesPerSec;

    let percentageKnown = total > 0;
    let percentage = 0;
    if (total > 0) {
      percentage = clampPercentage((downloaded / total) * 100);
    } else if (
      sample.percentageHint !== undefined &&
      Number.isFinite(sample.percentageHint) &&
      sample.percentageHint > 0
    ) {
      // Allow percentage hint ONLY when the extractor provides a real deterministic ratio
      percentageKnown = true;
      percentage = clampPercentage(sample.percentageHint);
    }

    const remainingBytes = total > 0 ? Math.max(0, total - downloaded) : 0;
    let etaSeconds: number | null = null;
    let etaStr = '--';

    if (total > 0 && this.emaSpeedBytesPerSec >= 1 && remainingBytes > 0) {
      etaSeconds = Math.ceil(remainingBytes / this.emaSpeedBytesPerSec);
      etaStr = formatDuration(etaSeconds);
    } else if (total > 0 && downloaded >= total && percentage >= 100) {
      etaSeconds = 0;
      etaStr = '00:00';
    }

    const roundedSpeed = Math.round(this.emaSpeedBytesPerSec);

    return {
      downloaded_bytes: downloaded,
      total_bytes: total,
      remaining_bytes: remainingBytes,
      progress_percentage: percentage,
      percentage_known: percentageKnown,
      speed_bytes_per_sec: roundedSpeed,
      avg_speed_bytes_per_sec: Math.round(avgSpeed),
      speed_str: roundedSpeed > 0 ? `${formatBytes(roundedSpeed)}/s` : '0 B/s',
      eta_seconds: etaSeconds,
      eta_str: etaStr,
      elapsed_seconds: totalElapsedSec,
      active_connections: Math.max(0, sample.activeConnections ?? 1),
      last_progress_at: new Date(nowMs).toISOString(),
    };
  }
}

/**
 * Resets transient live metrics cleanly when a task pauses, fails, cancels, or returns to queue.
 */
export function buildIdleMetricsPatch(task: DownloadTask): Partial<DownloadTask> {
  return {
    speed_bytes_per_sec: 0,
    speed_str: '0 B/s',
    eta_seconds: null,
    eta_str: '--',
    active_connections: 0,
    remaining_bytes:
      task.total_bytes > 0 ? Math.max(0, task.total_bytes - (task.downloaded_bytes || 0)) : 0,
  };
}
