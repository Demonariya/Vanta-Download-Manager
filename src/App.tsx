/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  DownloadQueue,
  DownloadTask,
  EngineInfo,
  EngineStatusMap,
  AppSettings,
  NotificationItem,
  EngineInstallProgress,
  ThemeMode,
} from './types';
import { api } from './services/api';
import { isActiveTaskStatus } from './utils/download-core';
import { Sidebar, ActiveTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { DownloadCenterView, QueueScopeFilter } from './components/DownloadCenterView';
import { DownloadDetailsDrawer } from './components/DownloadDetailsDrawer';
import { ClipboardMonitorBanner } from './components/ClipboardMonitorBanner';
import { HistoryView } from './components/HistoryView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { SettingsView } from './components/SettingsView';
import { NewDownloadModal } from './components/NewDownloadModal';
import { NotificationCenterModal } from './components/NotificationCenterModal';
import { TitleBar } from './components/TitleBar';
import { SafeCloseDialog } from './components/SafeCloseDialog';

function makeCheckingEngine(): EngineInfo {
  return {
    available: false,
    version: '',
    path: '',
    status: 'checking',
    lastChecked: new Date().toISOString(),
  };
}

function createInitialCheckingEngineStatus(): EngineStatusMap {
  return {
    ytdlp: makeCheckingEngine(),
    spotdl: makeCheckingEngine(),
    ffmpeg: makeCheckingEngine(),
    ffprobe: makeCheckingEngine(),
    python3: makeCheckingEngine(),
  };
}

function applyThemeToDocument(theme: ThemeMode) {
  try {
    localStorage.setItem('vanta_theme', theme);
  } catch {
    // ignore storage errors
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const shouldUseDark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', shouldUseDark);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('downloads');
  const [scopeFilter, setScopeFilter] = useState<QueueScopeFilter>('all');
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [queues, setQueues] = useState<DownloadQueue[]>([{ id: 'main', name: 'Main Queue', is_default: true, is_paused: false, queue_order: 0 }]);
  const [selectedQueueId, setSelectedQueueId] = useState('main');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const [engineStatus, setEngineStatus] = useState<EngineStatusMap | null>(
    createInitialCheckingEngineStatus
  );
  const isRefreshingEnginesRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem('vanta_theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {
      // ignore
    }
    return 'dark';
  });

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Modals & Clipboard
  const [isNewDownloadOpen, setIsNewDownloadOpen] = useState(false);
  const [initialInspectUrl, setInitialInspectUrl] = useState('');
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isSafeCloseOpen, setIsSafeCloseOpen] = useState(false);
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const lastClipboardSeenRef = useRef<string>('');

  const [installProgress, setInstallProgress] = useState<Record<string, EngineInstallProgress>>({});
  const [isInstallingEngines, setIsInstallingEngines] = useState(false);
  const [engineInstallError, setEngineInstallError] = useState<string | null>(null);

  // Apply theme whenever setting changes or OS color-scheme switches
  useEffect(() => {
    applyThemeToDocument(theme);
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeToDocument('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Global keyboard shortcuts (Ctrl/Cmd+N for New Download, Escape to close inspector)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setInitialInspectUrl('');
        setIsNewDownloadOpen(true);
      } else if (e.key === 'Escape' && !isNewDownloadOpen && !isNotificationsOpen && !isSafeCloseOpen) {
        setSelectedTaskId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isNewDownloadOpen, isNotificationsOpen, isSafeCloseOpen]);

  // Opt-in Clipboard URL monitor on window focus
  useEffect(() => {
    if (!settings?.clipboard_monitoring) return;
    const checkClipboard = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (
          text &&
          text !== lastClipboardSeenRef.current &&
          (text.startsWith('https://') || text.startsWith('http://') || text.startsWith('spotify:'))
        ) {
          lastClipboardSeenRef.current = text;
          setClipboardUrl(text);
        }
      } catch {
        // clipboard permission denied or unavailable
      }
    };
    window.addEventListener('focus', checkClipboard);
    return () => window.removeEventListener('focus', checkClipboard);
  }, [settings?.clipboard_monitoring]);

  const executeNativeClose = async () => {
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        await api.exitApp();
      }
    } catch (err) {
      console.warn('Native application exit failed', err);
    }
  };

  const activeCount = tasks.filter((t) => isActiveTaskStatus(t.status)).length;

  const handleInitiateClose = async () => {
    if (settings?.tray_minimize_on_close && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide().catch(() => executeNativeClose());
      return;
    }
    if (activeCount > 0) {
      setIsSafeCloseOpen(true);
    } else {
      executeNativeClose();
    }
  };

  const handleConfirmExit = async () => {
    setIsSafeCloseOpen(false);
    await api.pauseAll();
    executeNativeClose();
  };

  const runEngineScan = async (forceRefresh: boolean, isStillMounted?: () => boolean) => {
    if (isRefreshingEnginesRef.current) return;
    isRefreshingEnginesRef.current = true;
    try {
      const status = await api.getEngineStatus(forceRefresh);
      if (!isStillMounted || isStillMounted()) {
        setEngineStatus(status);
      }
    } catch (err) {
      console.error('Engine status scan failed:', err);
    } finally {
      isRefreshingEnginesRef.current = false;
    }
  };

  useEffect(() => {
    let mounted = true;

    runEngineScan(false, () => mounted);
    api
      .getSettings()
      .then((s) => {
        if (!mounted) return;
        setSettings(s);
        if (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system') {
          setTheme(s.theme);
        }
      })
      .catch(console.error);
    api.getTasks().then((t) => mounted && setTasks(t)).catch(console.error);
    api.getQueues().then((next) => {
      if (!mounted) return;
      setQueues(next);
      setSelectedQueueId((current) => next.some((queue) => queue.id === current) ? current : 'main');
    }).catch(console.error);
    api.getNotifications().then((n) => mounted && setNotifications(n)).catch(console.error);

    const unsubscribe = api.subscribeEvents({
      onInit: (data) => {
        if (!mounted) return;
        setTasks(data.tasks);
        setSettings(data.settings);
        if (data.settings?.theme) {
          setTheme(data.settings.theme);
        }
      },
      onTaskUpdated: (updatedTask) => {
        if (!mounted) return;
        setTasks((prev) => {
          const index = prev.findIndex((t) => t.id === updatedTask.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = updatedTask;
            return next;
          }
          return [updatedTask, ...prev];
        });
      },
      onTaskAdded: (newTask) => {
        if (!mounted) return;
        setTasks((prev) => [newTask, ...prev.filter((t) => t.id !== newTask.id)]);
      },
      onTaskDeleted: ({ id }) => {
        if (!mounted) return;
        setTasks((prev) => prev.filter((t) => t.id !== id));
        setSelectedTaskId((cur) => (cur === id ? null : cur));
      },
      onTasksCleared: (remainingTasks) => {
        if (!mounted) return;
        setTasks(remainingTasks);
      },
      onNotification: (notif) => {
        if (!mounted) return;
        setNotifications((prev) => [notif, ...prev]);
      },
      onSettingsUpdated: (newSettings) => {
        if (!mounted) return;
        setSettings(newSettings);
        if (newSettings.theme) {
          setTheme(newSettings.theme);
        }
      },
      onEngineInstallProgress: (progress) => {
        if (!mounted) return;
        setInstallProgress((prev) => ({
          ...prev,
          [progress.engine]: progress,
        }));
      },
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleQuickInspect = (url: string) => {
    setClipboardUrl(null);
    setInitialInspectUrl(url);
    setIsNewDownloadOpen(true);
  };

  const handleSaveSettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const prevTheme = theme;
    if (patch.theme) {
      setTheme(patch.theme);
    }
    try {
      const saved = await api.updateSettings(patch);
      setSettings(saved);
      if (saved.theme) {
        setTheme(saved.theme);
      }
      return saved;
    } catch (err) {
      setTheme(prevTheme);
      throw err;
    }
  };

  const handleResetSettings = async (): Promise<AppSettings> => {
    const reset = await api.resetSettings();
    setSettings(reset);
    if (reset.theme) {
      setTheme(reset.theme);
    }
    return reset;
  };

  const handleCycleTheme = () => {
    const order: ThemeMode[] = ['dark', 'light', 'system'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    handleSaveSettings({ theme: next }).catch(() => {});
  };

  const handleInstallAllEngines = async (force = false) => {
    setIsInstallingEngines(true);
    setEngineInstallError(null);
    try {
      const res = await api.installAllEngines(true, force);
      await runEngineScan(true);
      const failures = res.results.filter((r) => !r.success);
      if (failures.length > 0) {
        setEngineInstallError(failures.map((f) => `${f.engine}: ${f.message}`).join(' | '));
      }
    } catch (err: any) {
      setEngineInstallError(err?.message || 'Failed to install managed engines');
    } finally {
      setIsInstallingEngines(false);
    }
  };

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--vanta-bg)] text-[var(--vanta-text)]">
      <TitleBar activeDownloadsCount={activeCount} onRequestClose={handleInitiateClose} />

      <div className="flex flex-1 min-h-0 w-full overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onOpenNewDownload={() => {
            setInitialInspectUrl('');
            setIsNewDownloadOpen(true);
          }}
          engineStatus={engineStatus}
          activeCount={activeCount}
          isCollapsed={isSidebarCollapsed}
          setIsCollapsed={setIsSidebarCollapsed}
          isMobileOpen={isMobileMenuOpen}
          setIsMobileOpen={setIsMobileMenuOpen}
        />

        <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
          <TopBar
            onOpenNewDownload={() => {
              setInitialInspectUrl('');
              setIsNewDownloadOpen(true);
            }}
            onOpenNotifications={() => setIsNotificationsOpen(true)}
            unreadNotificationsCount={notifications.length}
            activeCount={activeCount}
            onPauseAll={() => api.pauseAll()}
            onResumeAll={() => api.resumeAll()}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            theme={theme}
            onCycleTheme={handleCycleTheme}
            onToggleMobileMenu={() => setIsMobileMenuOpen((v) => !v)}
          />

          <div className="flex flex-1 min-h-0 overflow-hidden relative">
            <main className="flex-1 min-w-0 overflow-y-auto p-3 sm:p-5 pb-24 sm:pb-10 select-text">
              <ClipboardMonitorBanner
                detectedUrl={clipboardUrl}
                onInspect={handleQuickInspect}
                onDismiss={() => setClipboardUrl(null)}
              />

              {activeTab === 'downloads' && (
                <DownloadCenterView
                  tasks={tasks}
                  queues={queues}
                  selectedQueueId={selectedQueueId}
                  onSelectQueue={setSelectedQueueId}
                  onQueuesChanged={(next) => {
                    setQueues(next);
                    setSelectedQueueId((current) => next.some((queue) => queue.id === current) ? current : 'main');
                  }}
                  engineStatus={engineStatus}
                  scopeFilter={scopeFilter}
                  setScopeFilter={setScopeFilter}
                  searchQuery={searchQuery}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={(t) => setSelectedTaskId(t.id)}
                  onOpenNewDownload={() => {
                    setInitialInspectUrl('');
                    setIsNewDownloadOpen(true);
                  }}
                  onPauseTask={(id) => api.pauseTask(id)}
                  onResumeTask={(id) => api.resumeTask(id)}
                  onCancelTask={(id) => api.cancelTask(id)}
                  onRetryTask={(id) => api.retryTask(id)}
                  onDeleteTask={(id, deleteFile) => api.deleteTask(id, deleteFile)}
                  onPauseAll={() => api.pauseAll()}
                  onResumeAll={() => api.resumeAll()}
                  onClearCompleted={(deleteFiles) => api.clearCompleted(deleteFiles)}
                  onClearFailed={() => api.clearFailed()}
                  onInstallEngines={() => handleInstallAllEngines(false)}
                  isInstallingEngines={isInstallingEngines}
                  engineInstallError={engineInstallError}
                  installProgress={installProgress}
                />
              )}

              {activeTab === 'history' && (
                <HistoryView
                  tasks={tasks}
                  onClearHistory={(deleteFiles) => api.clearCompleted(deleteFiles)}
                  onDeleteTask={(id, deleteFile) => api.deleteTask(id, deleteFile)}
                  onDeleteFile={(id) => api.deleteDownloadedFile(id)}
                  onSelectTask={(t) => setSelectedTaskId(t.id)}
                />
              )}

              {activeTab === 'diagnostics' && (
                <DiagnosticsView
                  engineStatus={engineStatus}
                  onRefresh={() => runEngineScan(true)}
                  installProgress={installProgress}
                />
              )}

              {activeTab === 'settings' && (
                <SettingsView
                  settings={settings}
                  onSaveSettings={handleSaveSettings}
                  onResetSettings={handleResetSettings}
                />
              )}
            </main>

            {/* Download Details Docked / Slide-Over Inspector */}
            <DownloadDetailsDrawer
              task={selectedTask}
              onClose={() => setSelectedTaskId(null)}
              onRetryTask={(id) => api.retryTask(id)}
            />
          </div>
        </div>
      </div>

      {/* New Download Modal */}
      <NewDownloadModal
        isOpen={isNewDownloadOpen}
        onClose={() => setIsNewDownloadOpen(false)}
        initialUrl={initialInspectUrl}
        tasks={tasks}
        settings={settings}
        queues={queues}
        defaultQueueId={selectedQueueId === 'all' ? 'main' : selectedQueueId}
        onTaskCreated={() => {
          setActiveTab('downloads');
          setScopeFilter('all');
        }}
        onOpenCookieSettings={() => {
          setIsNewDownloadOpen(false);
          setActiveTab('settings');
        }}
      />

      {/* Notifications Modal */}
      <NotificationCenterModal
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
        notifications={notifications}
        onClearAll={async () => {
          await api.clearNotifications();
          setNotifications([]);
        }}
      />

      {/* Safe Close Confirmation */}
      <SafeCloseDialog
        isOpen={isSafeCloseOpen}
        activeCount={activeCount}
        onCancel={() => setIsSafeCloseOpen(false)}
        onConfirmExit={handleConfirmExit}
      />
    </div>
  );
}
