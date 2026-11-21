import fs from 'node:fs';
import { Response } from 'express';
import { AppSettings, DownloadTask, NotificationItem } from '../src/types';
import {
  getAllTasks,
  getTaskById,
  upsertTask,
  getSettings,
  addNotification,
} from './db';
import { engineManager } from './engineManager';
import { sortQueue, getActiveDownloadCount } from '../src/utils/queue-logic';
import { canTransitionTask, isActiveTaskStatus, buildIdleMetricsPatch } from '../src/utils/download-core';
import { isWithinSchedulerWindow } from '../src/utils/scheduler';
import { classifyDownloadError } from '../src/utils/error-classifier';

export class QueueController {
  private sseClients: Set<Response> = new Set();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private schedulerPausedActive = false;

  constructor() {
    this.cleanStartupTasks();
    this.startScheduler();
  }

  private cleanStartupTasks(): void {
    try {
      const settings = getSettings();
      const tasks = getAllTasks();
      for (const t of tasks) {
        if (isActiveTaskStatus(t.status)) {
          if (settings.auto_resume_on_startup) {
            t.status = 'queued';
            t.current_phase = 'Queued for auto-resume';
          } else {
            t.status = 'paused';
            t.current_phase = 'Paused after restart';
          }
          Object.assign(t, buildIdleMetricsPatch(t));
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
      const windowOpen = isWithinSchedulerWindow(settings.scheduler);

      if (!windowOpen) {
        if (settings.scheduler?.pause_on_stop && !this.schedulerPausedActive) {
          this.schedulerPausedActive = true;
          const tasks = getAllTasks();
          for (const t of tasks) {
            if (isActiveTaskStatus(t.status)) {
              this.pauseTask(t.id);
            }
          }
        }
        return;
      }

      if (this.schedulerPausedActive && windowOpen) {
        this.schedulerPausedActive = false;
      }

      const allTasks = getAllTasks();
      const activeCount = getActiveDownloadCount(allTasks);

      const availableSlots = settings.max_concurrent_downloads - activeCount;
      if (availableSlots <= 0) {
        return;
      }

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
    if (!canTransitionTask(task.status, 'connecting')) return;

    const settings = getSettings();
    task.status = 'connecting';
    task.current_phase = 'Starting download engine...';
    task.started_at = task.started_at || new Date().toISOString();
    task.logs = [
      ...(task.logs || []),
      { timestamp: new Date().toISOString(), level: 'info' as const, message: `Starting ${task.engine} download` },
    ].slice(-100);
    upsertTask(task);
    this.broadcast('task_updated', task);

    engineManager.startDownload(
      task,
      settings,
      (update) => {
        const current = getTaskById(taskId);
        if (!current) return;
        if (current.status === 'paused' || current.status === 'cancelled' || current.status === 'completed') {
          return;
        }
        if (update.status && !canTransitionTask(current.status, update.status)) {
          return;
        }

        const merged: DownloadTask = {
          ...current,
          ...update,
        };
        upsertTask(merged);
        this.broadcast('task_updated', merged);
      },
      (outputPath, extra) => {
        const current = getTaskById(taskId);
        if (!current) return;
        if (current.status === 'paused' || current.status === 'cancelled') return;

        let validFile = false;
        let fileSize = 0;
        try {
          const st = fs.statSync(outputPath);
          validFile = st.isFile() && st.size > 0;
          fileSize = st.size;
        } catch {
          validFile = false;
        }

        if (!validFile) {
          current.status = 'failed';
          current.current_phase = 'Verification failed';
          current.error_message = 'Completed without a non-empty output file on disk.';
          Object.assign(current, buildIdleMetricsPatch(current));
          upsertTask(current);
          this.broadcast('task_updated', current);
          return;
        }

        Object.assign(current, extra || {});
        current.status = 'completed';
        current.current_phase = 'Completed';
        current.progress_percentage = 100;
        current.percentage_known = true;
        current.completed_at = new Date().toISOString();
        current.output_path = outputPath;
        current.total_bytes = fileSize;
        current.downloaded_bytes = fileSize;
        current.remaining_bytes = 0;
        current.speed_str = '0 B/s';
        current.speed_bytes_per_sec = 0;
        current.active_connections = 0;
        current.eta_seconds = 0;
        current.eta_str = 'Finished';

        if ((current.is_audio_only || current.audio_format) && !current.verified_audio_info) {
          const verified = engineManager.verifyAudioFile(outputPath);
          if (verified) {
            current.verified_audio_info = verified;
          }
        }

        current.logs = [
          ...(current.logs || []),
          {
            timestamp: new Date().toISOString(),
            level: 'info' as const,
            message: `Completed & verified on disk (${fileSize} bytes)`,
          },
        ].slice(-100);

        upsertTask(current);
        this.broadcast('task_updated', current);

        const notif: NotificationItem = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
        if (current.status === 'paused' || current.status === 'cancelled') return;

        const classified = classifyDownloadError(errorMessage, current.retries);
        const canRetry = current.retries < current.max_retries;

        if (classified.suggestedAction === 're_extract' && canRetry) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Expired URL detected (HTTP 410). Re-extracting tokens... (${current.retries}/${current.max_retries})`;
          current.error_message = classified.userMessage;
          Object.assign(current, buildIdleMetricsPatch(current));
          current.logs = [
            ...(current.logs || []),
            { timestamp: new Date().toISOString(), level: 'warn' as const, message: current.current_phase },
          ].slice(-100);
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'warning',
            title: 'HTTP 410 Recovery',
            message: `Stream expired for "${current.title}". Re-extracting fresh tokens...`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);
          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 1500);
          return;
        }

        if (classified.suggestedAction === 'fallback_format' && canRetry) {
          current.retries += 1;
          current.format_id = 'best';
          current.status = 'queued';
          current.current_phase = `Format unavailable. Falling back to best stream... (${current.retries}/${current.max_retries})`;
          current.error_message = classified.userMessage;
          Object.assign(current, buildIdleMetricsPatch(current));
          upsertTask(current);
          this.broadcast('task_updated', current);
          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 1000);
          return;
        }

        if (classified.suggestedAction === 'backoff' && canRetry && settings.auto_retry_failed) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Retry ${current.retries}/${current.max_retries} scheduled: ${classified.userMessage}`;
          current.error_message = classified.userMessage;
          Object.assign(current, buildIdleMetricsPatch(current));
          upsertTask(current);
          this.broadcast('task_updated', current);

          const notif: NotificationItem = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

        current.status = 'failed';
        current.current_phase = 'Failed';
        current.error_message = classified.userMessage;
        Object.assign(current, buildIdleMetricsPatch(current));
        current.logs = [
          ...(current.logs || []),
          { timestamp: new Date().toISOString(), level: 'error' as const, message: classified.userMessage },
        ].slice(-100);
        upsertTask(current);
        this.broadcast('task_updated', current);

        const notif: NotificationItem = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
    if (!canTransitionTask(task.status, 'paused')) return false;

    engineManager.cancelOrPauseProcess(taskId, 'paused');
    task.status = 'paused';
    task.current_phase = 'Paused by user';
    Object.assign(task, buildIdleMetricsPatch(task));
    task.logs = [
      ...(task.logs || []),
      { timestamp: new Date().toISOString(), level: 'info' as const, message: 'Paused by user' },
    ].slice(-100);
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public resumeTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;
    if (!canTransitionTask(task.status, 'queued')) return false;

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

    engineManager.cancelOrPauseProcess(taskId, 'cancelled');
    if (canTransitionTask(task.status, 'cancelled')) {
      task.status = 'cancelled';
      task.current_phase = 'Cancelled by user';
      Object.assign(task, buildIdleMetricsPatch(task));
      upsertTask(task);
      this.broadcast('task_updated', task);
    }
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
    Object.assign(task, buildIdleMetricsPatch(task));
    upsertTask(task);
    this.broadcast('task_updated', task);
    this.scheduleNext();
    return true;
  }

  public pauseAll(): void {
    const all = getAllTasks();
    for (const t of all) {
      if (isActiveTaskStatus(t.status) || t.status === 'queued') {
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
