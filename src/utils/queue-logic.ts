import { DownloadTask, TaskPriority, TaskStatus } from '../types';
import { formatBytes } from './engine-parser';
import { canTransitionTask, isActiveTaskStatus } from './download-core';

export { canTransitionTask };

const priorityWeight: Record<TaskPriority, number> = {
  highest: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export type SortField = 'queue' | 'created_at' | 'title' | 'size' | 'progress' | 'speed';
export type SortDirection = 'asc' | 'desc';

export interface SidebarTaskStats {
  downloading: number;
  queued: number;
  paused: number;
  completed: number;
  unfinished: number;
  failed: number;
  music: number;
  video: number;
  queueCounts: Map<string, number>;
}

/** Computes all sidebar badges and queue counts in one linear pass. */
export function calculateSidebarTaskStats(tasks: DownloadTask[]): SidebarTaskStats {
  const stats: SidebarTaskStats = {
    downloading: 0,
    queued: 0,
    paused: 0,
    completed: 0,
    unfinished: 0,
    failed: 0,
    music: 0,
    video: 0,
    queueCounts: new Map(),
  };

  for (const task of tasks) {
    const queueId = task.queue_id || 'main';
    stats.queueCounts.set(queueId, (stats.queueCounts.get(queueId) || 0) + 1);

    switch (task.status) {
      case 'connecting':
      case 'downloading':
      case 'resuming':
      case 'inspecting':
      case 'processing':
      case 'muxing':
      case 'verifying':
        stats.downloading += 1;
        break;
      case 'queued':
        stats.queued += 1;
        break;
      case 'paused':
        stats.paused += 1;
        break;
      case 'completed':
        stats.completed += 1;
        break;
      case 'failed':
        stats.failed += 1;
        break;
      default:
        break;
    }
    if (task.status !== 'completed' && task.status !== 'cancelled') stats.unfinished += 1;
    if (task.is_audio_only || task.engine === 'spotdl') stats.music += 1;
    else stats.video += 1;
  }

  return stats;
}

export interface QueueStatusCounts {
  paused: number;
  completed: number;
  failed: number;
}

/** Aggregates the compact status counters used by the Download Center in one pass. */
export function calculateQueueStatusCounts(tasks: DownloadTask[]): QueueStatusCounts {
  const counts: QueueStatusCounts = { paused: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    switch (task.status) {
      case 'paused':
        counts.paused += 1;
        break;
      case 'completed':
        counts.completed += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

export interface HistoryStats {
  totalCompleted: number;
  totalFailed: number;
  totalCancelled: number;
  totalBytesDownloaded: number;
  totalElapsedSeconds: number;
  meanSpeedBytesPerSec: number;
}

export function sortQueue(tasks: DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((a, b) => {
    // 1. Priority desc
    const pA = priorityWeight[a.priority] || 2;
    const pB = priorityWeight[b.priority] || 2;
    if (pA !== pB) return pB - pA;

    // 2. Explicit queue_order asc (if set cleanly)
    const qA = a.queue_order ?? 0;
    const qB = b.queue_order ?? 0;
    if (qA !== qB) return qA - qB;

    // 3. Created at asc
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

export function getActiveDownloadCount(tasks: DownloadTask[]): number {
  let count = 0;
  for (const task of tasks) {
    if (isActiveTaskStatus(task.status)) count += 1;
  }
  return count;
}

export function calculateAggregateSpeed(tasks: DownloadTask[]): {
  speedBytesPerSec: number;
  formattedSpeed: string;
} {
  let total = 0;
  for (const task of tasks) {
    if (
      task.status === 'downloading' ||
      task.status === 'connecting' ||
      task.status === 'resuming'
    ) {
      total += task.speed_bytes_per_sec || 0;
    }
  }
  return {
    speedBytesPerSec: total,
    formattedSpeed: `${formatBytes(total)}/s`,
  };
}

export function shouldAutoRetry(task: DownloadTask, maxRetries: number): boolean {
  return task.status === 'failed' && task.retries < maxRetries;
}

export function moveTaskOrder(
  tasks: DownloadTask[],
  taskId: string,
  direction: 'up' | 'down'
): DownloadTask[] {
  const ordered = sortQueue(tasks).map((t, idx) => ({
    ...t,
    queue_order: idx + 1,
  }));
  const idx = ordered.findIndex((t) => t.id === taskId);
  if (idx === -1) return ordered;

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= ordered.length) return ordered;

  const temp = ordered[idx];
  ordered[idx] = ordered[swapIdx];
  ordered[swapIdx] = temp;

  return ordered.map((t, i) => ({
    ...t,
    queue_order: i + 1,
  }));
}

export function filterAndSortTasks(
  tasks: DownloadTask[],
  opts: {
    statusFilter?: 'all' | 'active' | 'queued' | 'paused' | 'completed' | 'failed' | 'audio' | 'video';
    searchQuery?: string;
    sortField?: SortField;
    sortDirection?: SortDirection;
  }
): DownloadTask[] {
  const query = (opts.searchQuery || '').trim().toLowerCase();
  const filtered = tasks.filter((t) => {
    if (opts.statusFilter && opts.statusFilter !== 'all') {
      if (opts.statusFilter === 'active') {
        if (!isActiveTaskStatus(t.status)) return false;
      } else if (opts.statusFilter === 'audio') {
        if (!t.is_audio_only && t.engine !== 'spotdl') return false;
      } else if (opts.statusFilter === 'video') {
        if (t.is_audio_only || t.engine === 'spotdl') return false;
      } else if (opts.statusFilter !== t.status) {
        return false;
      }
    }

    if (query) {
      const haystack = [
        t.title,
        t.url,
        t.uploader || '',
        t.album || '',
        t.ext,
        t.engine,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });

  const field = opts.sortField || 'created_at';
  const dir = opts.sortDirection || 'desc';
  const mult = dir === 'asc' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    if (field === 'queue') {
      const activeRank = (s: TaskStatus) =>
        isActiveTaskStatus(s) ? 0 : s === 'queued' ? 1 : s === 'paused' ? 2 : 3;
      const rDiff = activeRank(a.status) - activeRank(b.status);
      if (rDiff !== 0) return rDiff;
      const pDiff = (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
      if (pDiff !== 0) return pDiff;
      return ((a.queue_order ?? 0) - (b.queue_order ?? 0)) * mult;
    }
    if (field === 'title') {
      return a.title.localeCompare(b.title) * mult;
    }
    if (field === 'size') {
      const sizeA = a.status === 'completed' ? (a.downloaded_bytes || a.total_bytes || 0) : (a.total_bytes || a.downloaded_bytes || 0);
      const sizeB = b.status === 'completed' ? (b.downloaded_bytes || b.total_bytes || 0) : (b.total_bytes || b.downloaded_bytes || 0);
      return (sizeA - sizeB) * mult;
    }
    if (field === 'progress') {
      return ((a.progress_percentage || 0) - (b.progress_percentage || 0)) * mult;
    }
    if (field === 'speed') {
      return ((a.speed_bytes_per_sec || 0) - (b.speed_bytes_per_sec || 0)) * mult;
    }
    return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * mult;
  });
}

export function computeHistoryStats(tasks: DownloadTask[]): HistoryStats {
  let totalCompleted = 0;
  let totalFailed = 0;
  let totalCancelled = 0;
  let totalBytesDownloaded = 0;
  let totalElapsedSeconds = 0;

  for (const t of tasks) {
    if (t.status === 'completed') {
      totalCompleted += 1;
      totalBytesDownloaded += t.downloaded_bytes || t.total_bytes || 0;
      totalElapsedSeconds += t.elapsed_seconds || 0;
    } else if (t.status === 'failed') {
      totalFailed += 1;
    } else if (t.status === 'cancelled') {
      totalCancelled += 1;
    }
  }

  const meanSpeedBytesPerSec =
    totalElapsedSeconds > 0 && totalBytesDownloaded > 0
      ? Math.round(totalBytesDownloaded / totalElapsedSeconds)
      : 0;

  return {
    totalCompleted,
    totalFailed,
    totalCancelled,
    totalBytesDownloaded,
    totalElapsedSeconds,
    meanSpeedBytesPerSec,
  };
}
