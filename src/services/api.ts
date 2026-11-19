import {
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
} from '../types';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export class ApiService {
  private eventSource: EventSource | null = null;
  private tauriUnlisteners: UnlistenFn[] = [];

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

  public async checkEngineUpdates(): Promise<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>> {
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

  public async installAllEngines(includeSpotdl = true, force = false): Promise<{ success: boolean; results: EngineUpdateResult[] }> {
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
    options?: { requestId?: string; signal?: AbortSignal }
  ): Promise<MediaMetadata> {
    const requestId =
      options?.requestId || `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const signal = options?.signal;

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

        invoke<MediaMetadata>('inspect_url', { url, requestId })
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
      body: JSON.stringify({ url, requestId }),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Extraction failed' }));
      throw new Error(err.error || 'Failed to inspect URL');
    }
    return res.json();
  }

  public async getTasks(): Promise<DownloadTask[]> {
    if (this.isTauri()) {
      return invoke<DownloadTask[]>('get_tasks');
    }
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Failed to fetch tasks');
    return res.json();
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
    await fetch(`/api/tasks/${id}/pause`, { method: 'POST' });
  }

  public async resumeTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('resume_task', { id });
    }
    await fetch(`/api/tasks/${id}/resume`, { method: 'POST' });
  }

  public async cancelTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('cancel_task', { id });
    }
    await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
  }

  public async retryTask(id: string): Promise<void> {
    if (this.isTauri()) {
      return invoke('retry_task', { id });
    }
    await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
  }

  public async deleteTask(id: string, deleteFileFromDisk = false): Promise<void> {
    if (this.isTauri()) {
      return invoke('delete_task', { id });
    }
    await fetch(`/api/tasks/${id}?deleteFile=${deleteFileFromDisk ? 'true' : 'false'}`, {
      method: 'DELETE',
    });
  }

  public async deleteDownloadedFile(id: string): Promise<boolean> {
    const res = await fetch(`/api/tasks/${id}/delete-file`, { method: 'POST' });
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
      return invoke('clear_completed');
    }
    await fetch(`/api/tasks/clear-completed?deleteFiles=${deleteFilesFromDisk ? 'true' : 'false'}`, {
      method: 'POST',
    });
  }

  public async clearFailed(): Promise<void> {
    await fetch('/api/tasks/clear-failed', { method: 'POST' });
  }

  public async clearAll(deleteFilesFromDisk = false): Promise<void> {
    await fetch(`/api/tasks/clear-all?deleteFiles=${deleteFilesFromDisk ? 'true' : 'false'}`, {
      method: 'POST',
    });
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
    const info = await this.getDiagnosticLogInfo(10);
    console.info('Diagnostic log directory:', info.logDir);
  }

  public async getSettings(): Promise<AppSettings> {
    if (this.isTauri()) {
      return invoke<AppSettings>('get_settings');
    }
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to fetch settings');
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
    if (!res.ok) throw new Error('Failed to update settings');
    return res.json();
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
    console.info('Opening path (web simulation):', path);
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

      // Initial state fetch
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

      // Listen to native events
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
