import fs from 'node:fs';
import { Response } from 'express';
import { AppSettings, DownloadTask, MediaMetadata, NotificationItem } from '../src/types';
import {
  getAllTasks,
  getTaskById,
  upsertTask,
  getSettings,
  addNotification,
  mergeTaskUpdate,
  isPlaceholderTaskTitle,
} from './db';
import { engineManager } from './engineManager';
import { sortQueue, getActiveDownloadCount } from '../src/utils/queue-logic';
import { canTransitionTask, isActiveTaskStatus, buildIdleMetricsPatch } from '../src/utils/download-core';
import { isWithinSchedulerWindow } from '../src/utils/scheduler';
import { classifyDownloadError } from '../src/utils/error-classifier';
import { isValidThumbnailUrl, selectBestThumbnail } from '../src/utils/engine-parser';

const PROGRESS_PERSIST_INTERVAL_MS = 200;

interface ThrottleEntry {
  lastPersistAt: number;
  timer: NodeJS.Timeout | null;
  pendingTask: DownloadTask | null;
}

export class QueueController {
  private sseClients: Set<Response> = new Set();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private schedulerPausedActive = false;
  private attemptCounter = 0;
  private activeAttempts: Map<string, number> = new Map();
  private throttleState: Map<string, ThrottleEntry> = new Map();

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

  private clearThrottle(taskId: string): void {
    const entry = this.throttleState.get(taskId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    this.throttleState.delete(taskId);
  }

  private persistAndBroadcastImmediate(task: DownloadTask): void {
    this.clearThrottle(task.id);
    this.throttleState.set(task.id, {
      lastPersistAt: Date.now(),
      timer: null,
      pendingTask: null,
    });
    upsertTask(task);
    this.broadcast('task_updated', task);
  }

  private persistAndBroadcastThrottled(task: DownloadTask): void {
    const now = Date.now();
    let entry = this.throttleState.get(task.id);
    if (!entry) {
      entry = { lastPersistAt: 0, timer: null, pendingTask: null };
      this.throttleState.set(task.id, entry);
    }

    const elapsed = now - entry.lastPersistAt;
    if (elapsed >= PROGRESS_PERSIST_INTERVAL_MS) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.pendingTask = null;
      entry.lastPersistAt = now;
      upsertTask(task);
      this.broadcast('task_updated', task);
      return;
    }

    entry.pendingTask = task;
    if (!entry.timer) {
      const delay = Math.max(16, PROGRESS_PERSIST_INTERVAL_MS - elapsed);
      entry.timer = setTimeout(() => {
        const currentEntry = this.throttleState.get(task.id);
        if (!currentEntry || !currentEntry.pendingTask) return;
        const snapshot = currentEntry.pendingTask;
        currentEntry.pendingTask = null;
        currentEntry.timer = null;
        currentEntry.lastPersistAt = Date.now();

        const latestInDb = getTaskById(task.id);
        if (!latestInDb || !isActiveTaskStatus(latestInDb.status)) return;
        const finalMerged = mergeTaskUpdate(latestInDb, snapshot);
        upsertTask(finalMerged);
        this.broadcast('task_updated', finalMerged);
      }, delay);
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
    this.schedulerTimer.unref?.();
  }

  public destroy(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    for (const entry of this.throttleState.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.throttleState.clear();
  }

  public enrichTaskMetadata(taskId: string, meta: MediaMetadata): void {
    const current = getTaskById(taskId);
    if (!current) return;

    const bestThumb = selectBestThumbnail(meta);
    const update: Partial<DownloadTask> = {};

    if (bestThumb && !isValidThumbnailUrl(current.thumbnail)) {
      update.thumbnail = bestThumb;
    }
    if (meta.title && isPlaceholderTaskTitle(current.title)) {
      update.title = meta.title;
    }
    if (!current.uploader && (meta.artists?.join(', ') || meta.owner || meta.uploader)) {
      update.uploader = meta.artists?.join(', ') || meta.owner || meta.uploader;
    }
    if (!current.album && meta.album) {
      update.album = meta.album;
    }
    if ((!current.duration || current.duration <= 0) && typeof meta.duration === 'number' && meta.duration > 0) {
      update.duration = meta.duration;
      update.duration_string = meta.duration_string;
    }
    if (!current.content_type && meta.content_type) {
      update.content_type = meta.content_type;
    }

    if (Object.keys(update).length === 0) return;

    const merged = mergeTaskUpdate(current, update);
    upsertTask(merged);
    this.broadcast('task_updated', merged);
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

    const attemptId = ++this.attemptCounter;
    this.activeAttempts.set(taskId, attemptId);

    const settings = getSettings();
    task.status = 'connecting';
    task.current_phase = 'Starting download engine...';
    task.started_at = task.started_at || new Date().toISOString();
    task.logs = [
      ...(task.logs || []),
      { timestamp: new Date().toISOString(), level: 'info' as const, message: `Starting ${task.engine} download` },
    ].slice(-100);
    this.persistAndBroadcastImmediate(task);

    engineManager.startDownload(
      task,
      settings,
      (update) => {
        if (this.activeAttempts.get(taskId) !== attemptId) return;
        const current = getTaskById(taskId);
        if (!current) return;
        if (current.status === 'paused' || current.status === 'cancelled' || current.status === 'completed') {
          return;
        }
        if (update.status && !canTransitionTask(current.status, update.status)) {
          return;
        }

        const pendingSnapshot = this.throttleState.get(taskId)?.pendingTask;
        const base = pendingSnapshot || current;
        const merged = mergeTaskUpdate(base, update);

        const stateChanged =
          (update.status !== undefined && update.status !== base.status) ||
          (update.current_phase !== undefined && update.current_phase !== base.current_phase) ||
          (update.tracks_completed !== undefined && update.tracks_completed !== base.tracks_completed) ||
          (update.tracks_failed !== undefined && update.tracks_failed !== base.tracks_failed) ||
          (update.thumbnail !== undefined && update.thumbnail !== base.thumbnail) ||
          (update.title !== undefined && update.title !== base.title);

        if (stateChanged) {
          this.persistAndBroadcastImmediate(merged);
        } else {
          this.persistAndBroadcastThrottled(merged);
        }
      },
      (outputPath, extra) => {
        if (this.activeAttempts.get(taskId) !== attemptId) return;
        this.activeAttempts.delete(taskId);
        this.clearThrottle(taskId);

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
          const failedTask = mergeTaskUpdate(current, {
            status: 'failed',
            current_phase: 'Verification failed',
            error_message: 'Completed without a non-empty output file on disk.',
            ...buildIdleMetricsPatch(current),
          });
          this.persistAndBroadcastImmediate(failedTask);
          return;
        }

        const merged = mergeTaskUpdate(current, extra || {});
        merged.status = 'completed';
        merged.current_phase = 'Completed';
        merged.progress_percentage = 100;
        merged.percentage_known = true;
        merged.completed_at = new Date().toISOString();
        merged.output_path = outputPath;
        const reportedTotal = typeof extra?.total_bytes === 'number' && extra.total_bytes > 0 ? extra.total_bytes : 0;
        const resolvedBytes = Math.max(fileSize, reportedTotal);
        merged.total_bytes = resolvedBytes;
        merged.downloaded_bytes = resolvedBytes;
        merged.remaining_bytes = 0;
        merged.speed_str = '0 B/s';
        merged.speed_bytes_per_sec = 0;
        merged.active_connections = 0;
        merged.eta_seconds = 0;
        merged.eta_str = 'Finished';

        if ((merged.is_audio_only || merged.audio_format) && !merged.verified_audio_info) {
          const verified = engineManager.verifyAudioFile(outputPath);
          if (verified) {
            merged.verified_audio_info = verified;
          }
        }

        merged.logs = [
          ...(merged.logs || []),
          {
            timestamp: new Date().toISOString(),
            level: 'info' as const,
            message: `Completed & verified on disk (${fileSize} bytes)`,
          },
        ].slice(-100);

        this.persistAndBroadcastImmediate(merged);

        const notif: NotificationItem = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'success',
          title: 'Download Completed',
          message: `"${merged.title}" finished downloading successfully.`,
          timestamp: new Date().toISOString(),
          taskId: merged.id,
        };
        addNotification(notif);
        this.broadcast('notification', notif);
        this.scheduleNext();
      },
      (errorMessage) => {
        if (this.activeAttempts.get(taskId) !== attemptId) return;
        this.activeAttempts.delete(taskId);
        this.clearThrottle(taskId);

        const current = getTaskById(taskId);
        if (!current) return;
        if (current.status === 'paused' || current.status === 'cancelled') return;

        if (current.tracks_requested && current.tracks_requested > 0 && (current.tracks_failed || 0) > 0) {
          current.status = 'failed';
          current.current_phase = `Partial failure (${current.tracks_completed || 0}/${current.tracks_requested} tracks)`;
          current.error_message = errorMessage;
          Object.assign(current, buildIdleMetricsPatch(current));
          current.logs = [
            ...(current.logs || []),
            { timestamp: new Date().toISOString(), level: 'error' as const, message: errorMessage },
          ].slice(-100);
          this.persistAndBroadcastImmediate(current);

          const notif: NotificationItem = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'error',
            title: 'Playlist Partially Failed',
            message: `"${current.title}": ${errorMessage}`,
            timestamp: new Date().toISOString(),
            taskId: current.id,
          };
          addNotification(notif);
          this.broadcast('notification', notif);
          this.scheduleNext();
          return;
        }

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
          this.persistAndBroadcastImmediate(current);

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
          this.persistAndBroadcastImmediate(current);
          setTimeout(() => this.scheduleNext(), classified.backoffDelayMs || 1000);
          return;
        }

        if (classified.suggestedAction === 'backoff' && canRetry && settings.auto_retry_failed) {
          current.retries += 1;
          current.status = 'queued';
          current.current_phase = `Retry ${current.retries}/${current.max_retries} scheduled: ${classified.userMessage}`;
          current.error_message = classified.userMessage;
          Object.assign(current, buildIdleMetricsPatch(current));
          this.persistAndBroadcastImmediate(current);

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
        this.persistAndBroadcastImmediate(current);

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

    this.activeAttempts.delete(taskId);
    this.clearThrottle(taskId);
    engineManager.cancelOrPauseProcess(taskId, 'paused');
    task.status = 'paused';
    task.current_phase = 'Paused by user';
    Object.assign(task, buildIdleMetricsPatch(task));
    task.logs = [
      ...(task.logs || []),
      { timestamp: new Date().toISOString(), level: 'info' as const, message: 'Paused by user' },
    ].slice(-100);
    this.persistAndBroadcastImmediate(task);
    this.scheduleNext();
    return true;
  }

  public resumeTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;
    if (!canTransitionTask(task.status, 'queued')) return false;

    this.clearThrottle(taskId);
    task.status = 'queued';
    task.current_phase = 'Queued for resume';
    this.persistAndBroadcastImmediate(task);
    this.scheduleNext();
    return true;
  }

  public cancelTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    this.activeAttempts.delete(taskId);
    this.clearThrottle(taskId);
    engineManager.cancelOrPauseProcess(taskId, 'cancelled');
    if (canTransitionTask(task.status, 'cancelled')) {
      task.status = 'cancelled';
      task.current_phase = 'Cancelled by user';
      Object.assign(task, buildIdleMetricsPatch(task));
      this.persistAndBroadcastImmediate(task);
    }
    this.scheduleNext();
    return true;
  }

  public retryTask(taskId: string): boolean {
    const task = getTaskById(taskId);
    if (!task) return false;

    this.activeAttempts.delete(taskId);
    this.clearThrottle(taskId);
    engineManager.cancelOrPauseProcess(taskId, 'cancelled');
    task.status = 'queued';
    task.progress_percentage = 0;
    task.downloaded_bytes = 0;
    task.remaining_bytes = task.total_bytes || 0;
    task.current_phase = 'Queued for retry';
    task.error_message = undefined;
    task.retries = 0;
    Object.assign(task, buildIdleMetricsPatch(task));
    this.persistAndBroadcastImmediate(task);
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

