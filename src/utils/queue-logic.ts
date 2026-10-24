import { DownloadTask, TaskPriority, TaskStatus } from '../types';
import { formatBytes } from './engine-parser';

const priorityWeight: Record<TaskPriority, number> = {
  highest: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const validTransitions: Record<TaskStatus, TaskStatus[]> = {
  queued: ['extracting', 'downloading', 'paused', 'cancelled', 'failed'],
  extracting: ['downloading', 'processing', 'failed', 'cancelled'],
  downloading: ['processing', 'completed', 'paused', 'failed', 'cancelled'],
  processing: ['completed', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
  completed: ['queued'],
};

export function canTransitionTask(current: TaskStatus, next: TaskStatus): boolean {
  if (current === next) return true;
  const allowed = validTransitions[current];
  return allowed ? allowed.includes(next) : false;
}

export function sortQueue(tasks: DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((a, b) => {
    // 1. Priority desc
    const pA = priorityWeight[a.priority] || 2;
    const pB = priorityWeight[b.priority] || 2;
    if (pA !== pB) return pB - pA;

    // 2. Created at asc
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

export function getActiveDownloadCount(tasks: DownloadTask[]): number {
  return tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing'
  ).length;
}

export function calculateAggregateSpeed(tasks: DownloadTask[]): {
  speedBytesPerSec: number;
  formattedSpeed: string;
} {
  const active = tasks.filter((t) => t.status === 'downloading');
  const total = active.reduce((acc, t) => acc + (t.speed_bytes_per_sec || 0), 0);
  return {
    speedBytesPerSec: total,
    formattedSpeed: `${formatBytes(total)}/s`,
  };
}

export function shouldAutoRetry(task: DownloadTask, maxRetries: number): boolean {
  return task.status === 'failed' && task.retries < maxRetries;
}
