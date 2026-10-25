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
import { classifyDownloadError, sanitizeLog } from '../src/utils/error-classifier';

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

        if (current.is_audio_only || current.audio_format) {
          const verified = engineManager.verifyAudioFile(outputPath);
          if (verified) {
            current.verified_audio_info = verified;
          }
        }

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

        const classified = classifyDownloadError(errorMessage, current.retries);
        const canRetry = current.retries < current.max_retries;

        // 1. Recoverable via Re-Extraction (HTTP 410 Gone / Expired Media URL)
        if (classified.suggestedAction === 're_extract' && canRetry) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Expired URL detected (HTTP 410). Purging cache & re-extracting tokens... (${current.retries}/${current.max_retries})`;
          current.error_message = classified.userMessage;
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: String(Date.now()),
            type: 'warning',
            title: 'HTTP 410 Recovery',
            message: `Stream expired for "${current.title}". Re-extracting fresh tokens and retrying...`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);

          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 1500);
          return;
        }

        // 2. Recoverable via Format Fallback
        if (classified.suggestedAction === 'fallback_format' && canRetry) {
          current.retries += 1;
          current.format_id = 'best';
          current.status = 'queued';
          current.current_phase = `Format unavailable. Falling back to universal stream... (${current.retries}/${current.max_retries})`;
          current.error_message = classified.userMessage;
          upsertTask(current);
          this.broadcast('task_updated', current);

          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 1000);
          return;
        }

        // 3. Recoverable via Exponential Backoff (Rate limits, Network timeouts)
        if (classified.suggestedAction === 'backoff' && canRetry && settings.auto_retry_failed) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Retry ${current.retries}/${current.max_retries} scheduled: ${classified.userMessage}`;
          current.error_message = classified.userMessage;
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: String(Date.now()),
            type: 'warning',
            title: 'Retrying Download',
            message: `"${current.title}": ${classified.userMessage}`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);

          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 3000);
          return;
        }

        // 4. Non-recoverable (DRM, Private, Removed, or retries exhausted)
        current.status = 'failed';
        current.current_phase = 'Failed';
        current.error_message = classified.userMessage;
        current.speed_str = '0 B/s';
        current.speed_bytes_per_sec = 0;
        upsertTask(current);
        this.broadcast('task_updated', current);

        const notif: NotificationItem = {
          id: String(Date.now()),
          type: 'error',
          title: 'Download Failed',
          message: `"${current.title}": ${classified.userMessage}`,
          timestamp: new Date().toISOString(),
          taskId: current.id,
        };
        addNotification(notif);
        this.broadcast('notification', notif);
        this.scheduleNext();
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
