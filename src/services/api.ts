import {
  DownloadTask,
  AppSettings,
  MediaMetadata,
  EngineStatusMap,
  DiagnosticResult,
  NotificationItem,
  EngineUpdateResult,
} from '../types';

export class ApiService {
  private eventSource: EventSource | null = null;

  public async getEngineStatus(): Promise<EngineStatusMap> {
    const res = await fetch('/api/engines/status');
    if (!res.ok) throw new Error('Failed to fetch engine status');
    return res.json();
  }

  public async runDiagnostics(): Promise<{ success: boolean; results: DiagnosticResult[] }> {
    const res = await fetch('/api/engines/diagnostics', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to run diagnostics');
    return res.json();
  }

  public async checkEngineUpdates(): Promise<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>> {
    const res = await fetch('/api/engines/updates');
    if (!res.ok) throw new Error('Failed to check engine updates');
    return res.json();
  }

  public async updateEngine(name: string): Promise<EngineUpdateResult> {
    const res = await fetch(`/api/engines/update/${name}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to update ${name}`);
    return res.json();
  }

  public async updateAllEngines(): Promise<{ success: boolean; results: EngineUpdateResult[] }> {
    const res = await fetch('/api/engines/update-all', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to update engines');
    return res.json();
  }

  public async inspectUrl(url: string): Promise<MediaMetadata> {
    const res = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Extraction failed' }));
      throw new Error(err.error || 'Failed to inspect URL');
    }
    return res.json();
  }

  public async getTasks(): Promise<DownloadTask[]> {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Failed to fetch tasks');
    return res.json();
  }

  public async createTask(taskData: Partial<DownloadTask>): Promise<DownloadTask> {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
    });
    if (!res.ok) throw new Error('Failed to create download task');
    return res.json();
  }

  public async pauseTask(id: string): Promise<void> {
    await fetch(`/api/tasks/${id}/pause`, { method: 'POST' });
  }

  public async resumeTask(id: string): Promise<void> {
    await fetch(`/api/tasks/${id}/resume`, { method: 'POST' });
  }

  public async cancelTask(id: string): Promise<void> {
    await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
  }

  public async retryTask(id: string): Promise<void> {
    await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
  }

  public async deleteTask(id: string): Promise<void> {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  }

  public async pauseAll(): Promise<void> {
    await fetch('/api/tasks/pause-all', { method: 'POST' });
  }

  public async resumeAll(): Promise<void> {
    await fetch('/api/tasks/resume-all', { method: 'POST' });
  }

  public async clearCompleted(): Promise<void> {
    await fetch('/api/tasks/clear-completed', { method: 'POST' });
  }

  public async getSettings(): Promise<AppSettings> {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  }

  public async updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error('Failed to update settings');
    return res.json();
  }

  public async getNotifications(): Promise<NotificationItem[]> {
    const res = await fetch('/api/notifications');
    if (!res.ok) throw new Error('Failed to fetch notifications');
    return res.json();
  }

  public async clearNotifications(): Promise<void> {
    await fetch('/api/notifications', { method: 'DELETE' });
  }

  public subscribeEvents(callbacks: {
    onTaskUpdated?: (task: DownloadTask) => void;
    onTaskAdded?: (task: DownloadTask) => void;
    onTaskDeleted?: (data: { id: string }) => void;
    onTasksCleared?: (tasks: DownloadTask[]) => void;
    onNotification?: (notif: NotificationItem) => void;
    onSettingsUpdated?: (settings: AppSettings) => void;
    onInit?: (data: { tasks: DownloadTask[]; settings: AppSettings }) => void;
  }): () => void {
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
