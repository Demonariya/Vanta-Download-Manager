import {
  DownloadQueue,
  DownloadTask,
  AppSettings,
  MediaMetadata,
  EngineStatusMap,
  DiagnosticResult,
  NotificationItem,
  EngineUpdateResult,
  EngineInstallProgress,
  ManagedEngineInfo,
  CookieStatus,
  CookieTestResult,
  CookieValidationResult,
  DetectedBrowserInfo,
  DiagnosticLogInfo,
  PythonValidationResult,
  TaskPriority,
} from '../types';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export class ApiService {
  private eventSource: EventSource | null = null;

  public isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  public async getEngineStatus(forceRefresh = false): Promise<EngineStatusMap> {
    if (this.isTauri()) {
      return invoke<EngineStatusMap>('get_engine_status', { forceRefresh });
    }
    const url = forceRefresh ? '/api/engines/status?force=1' : '/api/engines/status';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch engine status');
    return res.json();
  }

  public async runDiagnostics(): Promise<{ success: boolean; results: DiagnosticResult[] }> {
    if (this.isTauri()) {
      const results = await invoke<DiagnosticResult[]>('run_diagnostics');
      return { success: true, results };
    }
    const res = await fetch('/api/engines/diagnostics', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run diagnostics');
    return res.json();
  }

  public async checkEngineUpdates(): Promise<
    Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>
  > {
    if (this.isTauri()) {
      return invoke('check_engine_updates');
    }
    const res = await fetch('/api/engines/updates');
    if (!res.ok) throw new Error('Failed to check engine updates');
    return res.json();
  }

  public async getManagedEngineInfo(): Promise<ManagedEngineInfo> {
    if (this.isTauri()) {
      return invoke<ManagedEngineInfo>('get_managed_engine_info');
    }
    const res = await fetch('/api/engines/managed');
    if (!res.ok) throw new Error('Failed to fetch managed engine info');
    return res.json();
  }

  public async installEngine(name: string, force = false): Promise<EngineUpdateResult> {
    if (this.isTauri()) {
      return invoke<EngineUpdateResult>('install_engine', { name, force });
    }
    const res = await fetch(`/api/engines/install/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) throw new Error(`Failed to install ${name}`);
    return res.json();
  }

  public async installAllEngines(
    includeSpotdl = true,
    force = false
  ): Promise<{ success: boolean; results: EngineUpdateResult[] }> {
    if (this.isTauri()) {
      const results = await invoke<EngineUpdateResult[]>('install_all_engines', {
        includeSpotdl,
        force,
      });
      return { success: results.every((r) => r.success), results };
    }
    const res = await fetch('/api/engines/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeSpotdl, force }),
    });
    if (!res.ok) throw new Error('Failed to install managed engines');
    return res.json();
  }

  public async updateEngine(name: string): Promise<EngineUpdateResult> {
    if (this.isTauri()) {
      return invoke<EngineUpdateResult>('update_engine', { name });
    }
    const res = await fetch(`/api/engines/update/${encodeURIComponent(name)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to update ${name}`);
    return res.json();
  }

  public async updateAllEngines(): Promise<{ success: boolean; results: EngineUpdateResult[] }> {
    if (this.isTauri()) {
      const results = await invoke<EngineUpdateResult[]>('update_all_engines');
      return { success: results.every((r) => r.success), results };
    }
    const res = await fetch('/api/engines/update-all', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to update engines');
    return res.json();
  }

  public async removeManagedEngine(name: string): Promise<EngineUpdateResult> {
    if (this.isTauri()) {
      return invoke<EngineUpdateResult>('remove_managed_engine', { name });
    }
    const res = await fetch(`/api/engines/remove/${encodeURIComponent(name)}`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.message || err?.error || `Failed to remove ${name}`);
    }
    return res.json();
  }

  public async cancelInspection(requestId: string): Promise<boolean> {
    if (!requestId) return false;
    try {
      if (this.isTauri()) {
        return await invoke<boolean>('cancel_inspection', { requestId });
      }
      const res = await fetch('/api/inspect/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({ cancelled: false }));
      return Boolean(data?.cancelled);
    } catch {
      return false;
    }
  }

  public async inspectUrl(
    url: string,
    options?: { requestId?: string; signal?: AbortSignal; includePlaylist?: boolean }
  ): Promise<MediaMetadata> {
    const requestId =
      options?.requestId || `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const signal = options?.signal;
    const includePlaylist = options?.includePlaylist;

    if (signal?.aborted) {
      throw new DOMException('Inspection cancelled.', 'AbortError');
    }

    if (this.isTauri()) {
      return new Promise<MediaMetadata>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          this.cancelInspection(requestId).catch(() => {});
          reject(new DOMException('Inspection cancelled.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        invoke<MediaMetadata>('inspect_url', {
          url,
          requestId,
          includePlaylist: includePlaylist ?? null,
        })
          .then((data) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(data);
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            const msg = typeof err === 'string' ? err : err?.message || 'Failed to inspect URL';
            reject(new Error(msg));
          });
      });
    }

    const res = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, requestId, includePlaylist }),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Extraction failed' }));
      throw new Error(err.error || 'Failed to inspect URL');
    }
    return res.json();
  }

  public async getQueues(): Promise<DownloadQueue[]> {
    if (!this.isTauri()) {
      return [{ id: 'main', name: 'Main Queue', is_default: true, is_paused: false, queue_order: 0, max_concurrent_downloads: 0, bandwidth_limit_kbps: 0 }];
    }
    return invoke<DownloadQueue[]>('get_queues');
  }

  public async createQueue(name: string): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue management requires the VANTA desktop app.');
    return invoke<DownloadQueue[]>('create_queue', { name });
  }

  public async renameQueue(id: string, name: string): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue management requires the VANTA desktop app.');
    return invoke<DownloadQueue[]>('rename_queue', { id, name });
  }

  public async deleteQueue(id: string): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue management requires the VANTA desktop app.');
    return invoke<DownloadQueue[]>('delete_queue', { id });
  }

  public async updateQueueLimits(id: string, maxConcurrentDownloads: number, bandwidthLimitKbps: number): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue settings require the VANTA desktop app.');
    return invoke<DownloadQueue[]>('update_queue_limits', {
      id,
      maxConcurrentDownloads,
      bandwidthLimitKbps,
    });
  }

  public async startQueue(id: string): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue controls require the VANTA desktop app.');
    return invoke<DownloadQueue[]>('start_queue', { id });
  }

  public async stopQueue(id: string): Promise<DownloadQueue[]> {
    if (!this.isTauri()) throw new Error('Queue controls require the VANTA desktop app.');
    return invoke<DownloadQueue[]>('stop_queue', { id });
  }

  public async moveTasksToQueue(ids: string[], queueId: string): Promise<DownloadTask[]> {
    if (!ids.length) return this.getTasks();
    if (!this.isTauri()) throw new Error('Moving downloads between queues requires the VANTA desktop app.');
    return invoke<DownloadTask[]>('move_tasks_to_queue', { ids, queueId });
  }

  public async exitApp(): Promise<void> {
    if (!this.isTauri()) return;
    return invoke('exit_app');
  }

  public async getTasks(): Promise<DownloadTask[]> {
    if (this.isTauri()) {
      return invoke<DownloadTask[]>('get_tasks');
    }
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Failed to fetch tasks');
    return res.json();
  }

  public async importHistory(tasks: DownloadTask[]): Promise<DownloadTask[]> {
    if (!this.isTauri()) {
      throw new Error('History import requires the VANTA desktop app.');
    }
    return invoke<DownloadTask[]>('import_history', { importedTasks: tasks });
  }

  public async createTask(taskData: Partial<DownloadTask>): Promise<DownloadTask> {
    if (this.isTauri()) {
      return invoke<DownloadTask>('create_task', { payload: taskData });
    }
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to create download task');
    }
    return res.json();
  }

  public async pauseTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('pause_task', { id });
    }
    await fetch(`/api/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  }

  public async resumeTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('resume_task', { id });
    }
    await fetch(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  }

  public async cancelTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('cancel_task', { id });
    }
    await fetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  public async retryTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('retry_task', { id });
    }
    await fetch(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  }

  public async deleteTask(id: string, deleteFileFromDisk = false): Promise<void> {
    if (this.isTauri()) {
      return invoke('delete_task', { id, deleteFile: deleteFileFromDisk });
    }
    await fetch(
      `/api/tasks/${encodeURIComponent(id)}?deleteFile=${deleteFileFromDisk ? 'true' : 'false'}`,
      { method: 'DELETE' }
    );
  }

  public async deleteDownloadedFile(id: string): Promise<boolean> {
    if (this.isTauri()) {
      return invoke<boolean>('delete_downloaded_file', { id });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/delete-file`, {
      method: 'POST',
    });
    const data = await res.json();
    return Boolean(data.removed);
  }

  public async pauseAll(): Promise<void> {
    if (this.isTauri()) {
      return invoke('pause_all');
    }
    await fetch('/api/tasks/pause-all', { method: 'POST' });
  }

  public async resumeAll(): Promise<void> {
    if (this.isTauri()) {
      return invoke('resume_all');
    }
    await fetch('/api/tasks/resume-all', { method: 'POST' });
  }

  public async clearCompleted(deleteFilesFromDisk = false): Promise<void> {
    if (this.isTauri()) {
      return invoke('clear_completed', { deleteFiles: deleteFilesFromDisk });
    }
    await fetch(
      `/api/tasks/clear-completed?deleteFiles=${deleteFilesFromDisk ? 'true' : 'false'}`,
      { method: 'POST' }
    );
  }

  public async clearFailed(): Promise<void> {
    if (this.isTauri()) {
      return invoke('clear_failed');
    }
    await fetch('/api/tasks/clear-failed', { method: 'POST' });
  }

  public async clearAll(deleteFilesFromDisk = false): Promise<void> {
    if (this.isTauri()) {
      return invoke('clear_all', { deleteFiles: deleteFilesFromDisk });
    }
    await fetch(
      `/api/tasks/clear-all?deleteFiles=${deleteFilesFromDisk ? 'true' : 'false'}`,
      { method: 'POST' }
    );
  }

  public async moveTask(id: string, direction: 'up' | 'down'): Promise<DownloadTask[]> {
    if (this.isTauri()) {
      return invoke<DownloadTask[]>('move_task', { id, direction });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction }),
    });
    if (!res.ok) throw new Error('Failed to reorder task');
    return res.json();
  }

  public async updateTaskMeta(
    id: string,
    patch: { priority?: TaskPriority; custom_filename?: string | null }
  ): Promise<DownloadTask> {
    if (this.isTauri()) {
      return invoke<DownloadTask>('update_task_meta', {
        id,
        priority: patch.priority ?? null,
        customFilename: patch.custom_filename ?? null,
      });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to update task');
    }
    return res.json();
  }

  public async renameTaskFile(id: string, filename: string): Promise<DownloadTask> {
    if (this.isTauri()) {
      return invoke<DownloadTask>('rename_task_file', { id, filename });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to rename output file');
    }
    return res.json();
  }

  public async bulkTaskAction(
    ids: string[],
    action: 'pause' | 'resume' | 'retry' | 'cancel' | 'delete',
    deleteFiles = false
  ): Promise<void> {
    if (ids.length === 0) return;
    if (this.isTauri()) {
      return invoke('bulk_task_action', { ids, action, deleteFiles });
    }
    const res = await fetch('/api/tasks/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action, deleteFiles }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Bulk task operation failed');
    }
  }

  public async openTaskFile(task: DownloadTask): Promise<void> {
    if (this.isTauri()) {
      if (!task.output_path) throw new Error('No output file path recorded');
      return invoke('open_file_or_folder', { path: task.output_path });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/open-file`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to open file');
    }
  }

  public async openTaskFolder(task: DownloadTask): Promise<void> {
    if (this.isTauri()) {
      const target = task.output_path || '';
      if (!target.trim()) throw new Error('No folder path recorded');
      // Completed tasks store the final file path; unfinished tasks store the destination directory.
      const dir = task.status === 'completed'
        ? (target.replace(/[\\/][^\\/]+$/, '') || target)
        : target;
      return invoke('open_file_or_folder', { path: dir });
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/open-folder`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to open folder');
    }
  }

  public async getCookieStatus(): Promise<CookieStatus> {
    if (this.isTauri()) {
      return invoke<CookieStatus>('get_cookie_status');
    }
    const res = await fetch('/api/cookies/status');
    if (!res.ok) throw new Error('Failed to fetch cookie status');
    return res.json();
  }

  public async detectBrowsers(): Promise<DetectedBrowserInfo[]> {
    if (this.isTauri()) {
      return invoke<DetectedBrowserInfo[]>('detect_browsers');
    }
    const res = await fetch('/api/cookies/browsers');
    if (!res.ok) throw new Error('Failed to detect installed browsers');
    return res.json();
  }

  public async validateCookiesText(content: string): Promise<CookieValidationResult> {
    if (this.isTauri()) {
      return invoke<CookieValidationResult>('validate_cookies_text', { content });
    }
    const res = await fetch('/api/cookies/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error('Failed validating cookie text');
    return res.json();
  }

  public async testCookieExtraction(
    browser?: string,
    profile?: string,
    testUrl?: string
  ): Promise<CookieTestResult> {
    if (this.isTauri()) {
      return invoke<CookieTestResult>('test_cookie_extraction', {
        browser: browser || null,
        profile: profile?.trim() || null,
        testUrl: testUrl?.trim() || null,
      });
    }
    const res = await fetch('/api/cookies/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: browser || undefined,
        profile: profile?.trim() || undefined,
        testUrl: testUrl?.trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok && !data) {
      throw new Error('Failed testing cookie extraction');
    }
    return data;
  }

  public async saveCookies(content: string): Promise<CookieStatus> {
    if (this.isTauri()) {
      return invoke<CookieStatus>('save_cookies', { content });
    }
    const res = await fetch('/api/cookies/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save Netscape cookie file');
    }
    return data;
  }

  public async removeCookies(): Promise<CookieStatus> {
    if (this.isTauri()) {
      return invoke<CookieStatus>('remove_cookies');
    }
    const res = await fetch('/api/cookies', { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed removing cookie file');
    }
    return data;
  }

  public async getDiagnosticLogInfo(maxLines = 100): Promise<DiagnosticLogInfo> {
    if (this.isTauri()) {
      return invoke<DiagnosticLogInfo>('get_diagnostic_log_info', { maxLines });
    }
    const res = await fetch(`/api/diagnostics/logs?maxLines=${encodeURIComponent(String(maxLines))}`);
    if (!res.ok) throw new Error('Failed reading diagnostic logs');
    return res.json();
  }

  public async openLogsFolder(): Promise<void> {
    if (this.isTauri()) {
      return invoke('open_logs_folder');
    }
    await this.getDiagnosticLogInfo(10);
  }

  public async getSettings(): Promise<AppSettings> {
    if (this.isTauri()) {
      return invoke<AppSettings>('get_settings');
    }
    const res = await fetch('/api/settings');
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || 'Failed to load settings');
    }
    return res.json();
  }

  public async updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    if (this.isTauri()) {
      return invoke<AppSettings>('save_settings', { settings });
    }
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to persist settings');
    }
    return data;
  }

  public async resetSettings(): Promise<AppSettings> {
    if (this.isTauri()) {
      return invoke<AppSettings>('reset_settings');
    }
    const res = await fetch('/api/settings/reset', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to reset settings to defaults');
    }
    return data;
  }

  public async validatePythonExecutable(pythonPath: string): Promise<PythonValidationResult> {
    if (this.isTauri()) {
      return invoke<PythonValidationResult>('validate_python_executable', { pythonPath });
    }
    const res = await fetch('/api/python/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pythonPath }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok && !data) {
      throw new Error('Failed to validate Python executable');
    }
    return data;
  }

  public async browsePythonExecutable(): Promise<string | null> {
    if (this.isTauri()) {
      return invoke<string | null>('browse_python_executable');
    }
    return null;
  }

  public async getNotifications(): Promise<NotificationItem[]> {
    if (this.isTauri()) {
      return invoke<NotificationItem[]>('get_notifications');
    }
    const res = await fetch('/api/notifications');
    if (!res.ok) throw new Error('Failed to fetch notifications');
    return res.json();
  }

  public async clearNotifications(): Promise<void> {
    if (this.isTauri()) {
      return invoke('clear_notifications');
    }
    await fetch('/api/notifications', { method: 'DELETE' });
  }

  public async openFileOrFolder(path: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('open_file_or_folder', { path });
    }
    const res = await fetch('/api/settings');
    if (!res.ok) return;
  }

  public async selectDirectory(): Promise<string | null> {
    if (this.isTauri()) {
      return invoke<string | null>('select_directory');
    }
    return null;
  }

  public subscribeEvents(callbacks: {
    onTaskUpdated?: (task: DownloadTask) => void;
    onTaskAdded?: (task: DownloadTask) => void;
    onTaskDeleted?: (data: { id: string }) => void;
    onTasksCleared?: (tasks: DownloadTask[]) => void;
    onNotification?: (notif: NotificationItem) => void;
    onSettingsUpdated?: (settings: AppSettings) => void;
    onEngineInstallProgress?: (progress: EngineInstallProgress) => void;
    onInit?: (data: { tasks: DownloadTask[]; settings: AppSettings }) => void;
  }): () => void {
    if (this.isTauri()) {
      let isSubscribed = true;
      const unlisteners: UnlistenFn[] = [];

      Promise.all([
        invoke<DownloadTask[]>('get_tasks'),
        invoke<AppSettings>('get_settings'),
      ])
        .then(([tasks, settings]) => {
          if (isSubscribed) {
            callbacks.onInit?.({ tasks, settings });
          }
        })
        .catch(console.error);

      if (callbacks.onTaskUpdated) {
        listen<DownloadTask>('task_updated', (e) => callbacks.onTaskUpdated?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onTaskAdded) {
        listen<DownloadTask>('task_added', (e) => callbacks.onTaskAdded?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onTaskDeleted) {
        listen<{ id: string }>('task_deleted', (e) => callbacks.onTaskDeleted?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onTasksCleared) {
        listen<DownloadTask[]>('tasks_cleared', (e) => callbacks.onTasksCleared?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onNotification) {
        listen<NotificationItem>('notification', (e) => callbacks.onNotification?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onSettingsUpdated) {
        listen<AppSettings>('settings_updated', (e) => callbacks.onSettingsUpdated?.(e.payload)).then((u) =>
          unlisteners.push(u)
        );
      }
      if (callbacks.onEngineInstallProgress) {
        listen<EngineInstallProgress>('engine_install_progress', (e) =>
          callbacks.onEngineInstallProgress?.(e.payload)
        ).then((u) => unlisteners.push(u));
      }

      return () => {
        isSubscribed = false;
        unlisteners.forEach((u) => u());
      };
    }

    if (this.eventSource) {
      this.eventSource.close();
    }

    const es = new EventSource('/api/events');
    this.eventSource = es;

    es.addEventListener('task_updated', (e) => {
      callbacks.onTaskUpdated?.(JSON.parse(e.data));
    });
    es.addEventListener('task_added', (e) => {
      callbacks.onTaskAdded?.(JSON.parse(e.data));
    });
    es.addEventListener('task_deleted', (e) => {
      callbacks.onTaskDeleted?.(JSON.parse(e.data));
    });
    es.addEventListener('tasks_cleared', (e) => {
      callbacks.onTasksCleared?.(JSON.parse(e.data));
    });
    es.addEventListener('notification', (e) => {
      callbacks.onNotification?.(JSON.parse(e.data));
    });
    es.addEventListener('settings_updated', (e) => {
      callbacks.onSettingsUpdated?.(JSON.parse(e.data));
    });
    es.addEventListener('engine_install_progress', (e) => {
      callbacks.onEngineInstallProgress?.(JSON.parse(e.data));
    });
    es.addEventListener('init', (e) => {
      callbacks.onInit?.(JSON.parse(e.data));
    });

    return () => {
      es.close();
      if (this.eventSource === es) {
        this.eventSource = null;
      }
    };
  }
}

export const api = new ApiService();
