import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  DownloadTask,
  AppSettings,
  MediaMetadata,
  EngineStatusMap,
  DiagnosticResult,
  NotificationItem,
  EngineUpdateResult,
} from '../types';

type EventCallbacks = {
  onTaskUpdated?: (task: DownloadTask) => void;
  onTaskAdded?: (task: DownloadTask) => void;
  onTaskDeleted?: (data: { id: string }) => void;
  onTasksCleared?: (tasks: DownloadTask[]) => void;
  onNotification?: (notification: NotificationItem) => void;
  onSettingsUpdated?: (settings: AppSettings) => void;
  onInit?: (data: { tasks: DownloadTask[]; settings: AppSettings }) => void;
};

export class ApiService {
  public getEngineStatus(): Promise<EngineStatusMap> {
    return invoke<EngineStatusMap>('get_engine_status');
  }

  public runDiagnostics(): Promise<{ success: boolean; results: DiagnosticResult[] }> {
    return invoke<DiagnosticResult[]>('run_engine_diagnostics').then((results) => ({
      success: results.every((item) => item.passed),
      results,
    }));
  }

  public checkEngineUpdates(): Promise<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>> {
    return invoke<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>>('check_engine_updates');
  }

  public updateEngine(name: string): Promise<EngineUpdateResult> {
    return invoke<EngineUpdateResult>('update_engine', { name });
  }

  public updateAllEngines(): Promise<{ success: boolean; results: EngineUpdateResult[] }> {
    return invoke<{ success: boolean; results: EngineUpdateResult[] }>('update_all_engines');
  }

  public inspectUrl(url: string): Promise<MediaMetadata> {
    return invoke<MediaMetadata>('inspect_url', { url });
  }

  public getTasks(): Promise<DownloadTask[]> {
    return invoke<DownloadTask[]>('get_tasks');
  }

  public createTask(taskData: Partial<DownloadTask>): Promise<DownloadTask> {
    return invoke<DownloadTask>('create_download_task', { taskData });
  }

  public pauseTask(id: string): Promise<void> {
    return invoke<void>('pause_task', { id });
  }

  public resumeTask(id: string): Promise<void> {
    return invoke<void>('resume_task', { id });
  }

  public cancelTask(id: string): Promise<void> {
    return invoke<void>('cancel_task', { id });
  }

  public retryTask(id: string): Promise<void> {
    return invoke<void>('retry_task', { id });
  }

  public deleteTask(id: string): Promise<void> {
    return invoke<void>('delete_task', { id });
  }

  public pauseAll(): Promise<void> {
    return invoke<void>('pause_all_downloads');
  }

  public resumeAll(): Promise<void> {
    return invoke<void>('resume_all_downloads');
  }

  public clearCompleted(): Promise<void> {
    return invoke<void>('clear_completed_tasks');
  }

  public getSettings(): Promise<AppSettings> {
    return invoke<AppSettings>('get_settings');
  }

  public updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    return invoke<AppSettings>('update_settings', { settings });
  }

  public getNotifications(): Promise<NotificationItem[]> {
    return invoke<NotificationItem[]>('get_notifications');
  }

  public clearNotifications(): Promise<void> {
    return invoke<void>('clear_notifications');
  }

  public getDownloadHistory(): Promise<DownloadTask[]> {
    return invoke<DownloadTask[]>('get_download_history');
  }

  public deleteHistoryEntry(id: string): Promise<void> {
    return invoke<void>('delete_download_history_entry', { id });
  }

  public clearDownloadHistory(): Promise<void> {
    return invoke<void>('clear_download_history');
  }

  public openDownloadedFile(path: string): Promise<void> {
    return invoke<void>('open_downloaded_file', { path });
  }

  public revealDownloadInFolder(path: string): Promise<void> {
    return invoke<void>('reveal_download_in_folder', { path });
  }

  public chooseDownloadDirectory(): Promise<string> {
    return invoke<string>('choose_download_directory');
  }

  public subscribeEvents(callbacks: EventCallbacks): () => void {
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    const registrations: Array<[string, (payload: unknown) => void]> = [
      ['task_updated', (payload) => callbacks.onTaskUpdated?.(payload as DownloadTask)],
      ['task_added', (payload) => callbacks.onTaskAdded?.(payload as DownloadTask)],
      ['task_deleted', (payload) => callbacks.onTaskDeleted?.(payload as { id: string })],
      ['tasks_cleared', (payload) => callbacks.onTasksCleared?.(payload as DownloadTask[])],
      ['notification', (payload) => callbacks.onNotification?.(payload as NotificationItem)],
      ['settings_updated', (payload) => callbacks.onSettingsUpdated?.(payload as AppSettings)],
    ];

    void Promise.all(
      registrations.map(([eventName, handler]) =>
        listen<unknown>(eventName, (event) => handler(event.payload)),
      ),
    ).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
    }).catch((error) => {
      console.error('Failed to subscribe to VANTA native events:', error);
    });

    void Promise.all([this.getTasks(), this.getSettings()]).then(([tasks, settings]) => {
      if (!disposed) callbacks.onInit?.({ tasks, settings });
    }).catch((error) => {
      console.error('Failed to initialize VANTA state from native backend:', error);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners = [];
    };
  }
}

export const api = new ApiService();
