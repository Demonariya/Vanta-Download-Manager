import { Response } from 'express';
import { DownloadTask, AppSettings, NotificationItem } from '../src/types';
import {
  getAllTasks,
  getTaskById,
  upsertTask,
  getSettings,
  addNotification,
} from './db';
import { engineManager } from './engineManager';
import { sortQueue, getActiveDownloadCount, shouldAutoRetry } from '../src/utils/queue-logic';

export class QueueController {
  private sseClients: Set<Response> = new Set();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor() {
    this.cleanStartupTasks();
    this.startScheduler();
  }

  private cleanStartupTasks(): void {
    try {
      const settings = getSettings();
      const tasks = getAllTasks();
      for (const t of tasks) {
        if (t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing') {
          if (settings.auto_resume_on_startup) {
            t.status = 'queued';
            t.current_phase = 'Queued for auto-resume';
          } else {
            t.status = 'paused';
            t.current_phase = 'Paused after restart';
          }
          t.speed_str = '0 B/s';
          t.speed_bytes_per_sec = 0;
          upsertTask(t);
        }
      }
    } catch (err) {
      console.error('Error during startup task cleanup:', err);
    }
  }

  public registerClient(res: Response): void {
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });

    // Send initial snapshot
    const tasks = getAllTasks();
    const settings = getSettings();
    this.sendEventTo(res, 'init', { tasks, settings });
  }

  public broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private sendEventTo(res: Response, event: string, data: any): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.sseClients.delete(res);
    }
  }

  private startScheduler(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = setInterval(() => {
      this.scheduleNext();
    }, 1000);
  }

  public async scheduleNext(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const settings = getSettings();
      const allTasks = getAllTasks();
      const activeCount = getActiveDownloadCount(allTasks);

      const availableSlots = settings.max_concurrent_downloads - activeCount;
      if (availableSlots <= 0) {
        return;
      }

      // Find queued tasks sorted by priority
      const queuedTasks = sortQueue(allTasks.filter((t) => t.status === 'queued'));
      const toStart = queuedTasks.slice(0, availableSlots);

      for (const task of toStart) {
        await this.startTask(task.id);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public async startTask(taskId: string): Promise<void> {
    const task = getTaskById(taskId);
    if (!task) return;

    const settings = getSettings();

    task.status = 'extracting';
    task.current_phase = 'Starting download engine...';
    upsertTask(task);
    this.broadcast('task_updated', task);

    engineManager.startDownload(
      task,
      settings,
      (update) => {
        const current = getTaskById(taskId);
        if (!current) return;
        // Don't update if cancelled or paused in the meantime
        if (current.status === 'paused' || current.status === 'cancelled') return;

        const merged: DownloadTask = {
          ...current,
          ...update,
        };
        upsertTask(merged);
        this.broadcast('task_updated', merged);
      },
      (outputPath) => {
        const current = getTaskById(taskId);
        if (!current) return;

        current.status = 'completed';
        current.current_phase = 'Completed';
        current.progress_percentage = 100;
        current.completed_at = new Date().toISOString();
        current.output_path = outputPath;
        current.speed_str = '0 B/s';
        current.speed_bytes_per_sec = 0;
        current.eta_str = 'Finished';
        upsertTask(current);
        this.broadcast('task_updated', current);

        const notif: NotificationItem = {
          id: String(Date.now()),
          type: 'success',
          title: 'Download Completed',
          message: `"${current.title}" finished downloading successfully.`,
          timestamp: new Date().toISOString(),
          taskId: current.id,
        };
        addNotification(notif);
        this.broadcast('notification', notif);
        this.scheduleNext();
      },
      (errorMessage) => {
        const current = getTaskById(taskId);
        if (!current) return;

        // Auto retry check
        if (settings.auto_retry_failed && shouldAutoRetry(current, current.max_retries)) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Retry ${current.retries}/${current.max_retries} scheduled`;
          current.error_message = errorMessage;
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: String(Date.now()),
            type: 'warning',
            title: 'Retrying Download',
            message: `"${current.title}" failed. Retrying (attempt ${current.retries}/${current.max_retries})...`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);
          this.scheduleNext();
        } else {
          current.status = 'failed';
          current.current_phase = 'Failed';
          current.error_message = errorMessage;
          current.speed_str = '0 B/s';
          current.speed_bytes_per_sec = 0;
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: String(Date.now()),
            type: 'error',
            title: 'Download Failed',
            message: `"${current.title}": ${errorMessage}`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);
          this.scheduleNext();
        }
      }
    );
  }

  public pauseTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    engineManager.cancelOrPauseProcess(taskId);
    task.status = 'paused';
    task.current_phase = 'Paused by user';
    task.speed_str = '0 B/s';
    task.speed_bytes_per_sec = 0;
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public resumeTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    task.status = 'queued';
    task.current_phase = 'Queued for resume';
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public cancelTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    engineManager.cancelOrPauseProcess(taskId);
    task.status = 'cancelled';
    task.current_phase = 'Cancelled by user';
    task.speed_str = '0 B/s';
    task.speed_bytes_per_sec = 0;
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public retryTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    task.status = 'queued';
    task.progress_percentage = 0;
    task.current_phase = 'Queued for retry';
    task.error_message = undefined;
    task.retries = 0;
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public pauseAll(): void {
    const all = getAllTasks();
    for (const t of all) {
      if (t.status === 'downloading' || t.status === 'extracting' || t.status === 'queued') {
        this.pauseTask(t.id);
      }
    }
  }

  public resumeAll(): void {
    const all = getAllTasks();
    for (const t of all) {
      if (t.status === 'paused') {
        this.resumeTask(t.id);
      }
    }
  }
}

export const queueController = new QueueController();
