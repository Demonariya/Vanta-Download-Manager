/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  DownloadTask,
  EngineInfo,
  EngineStatusMap,
  AppSettings,
  NotificationItem,
  EngineInstallProgress,
} from './types';
import { api } from './services/api';

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
import { Sidebar, ActiveTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { DashboardView } from './components/DashboardView';
import { QueueView } from './components/QueueView';
import { MusicLibraryView } from './components/MusicLibraryView';
import { HistoryView } from './components/HistoryView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { SettingsView } from './components/SettingsView';
import { NewDownloadModal } from './components/NewDownloadModal';
import { FloatingProgressDock } from './components/FloatingProgressDock';
import { NotificationCenterModal } from './components/NotificationCenterModal';
import { TitleBar } from './components/TitleBar';
import { SafeCloseDialog } from './components/SafeCloseDialog';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatusMap | null>(
    createInitialCheckingEngineStatus
  );
  const isRefreshingEnginesRef = useRef(false);
  const [isRefreshingEngines, setIsRefreshingEngines] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1024
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Modals
  const [isNewDownloadOpen, setIsNewDownloadOpen] = useState(false);
  const [initialInspectUrl, setInitialInspectUrl] = useState('');
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isSafeCloseOpen, setIsSafeCloseOpen] = useState(false);
  const [installProgress, setInstallProgress] = useState<Record<string, EngineInstallProgress>>({});
  const [isInstallingEngines, setIsInstallingEngines] = useState(false);
  const [engineInstallError, setEngineInstallError] = useState<string | null>(null);

  const executeNativeClose = async () => {
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      }
    } catch (err) {
      console.warn('Native close called in non-Tauri context', err);
    }
  };

  const handleInitiateClose = () => {
    if (activeCount > 0) {
      setIsSafeCloseOpen(true);
    } else {
      executeNativeClose();
    }
  };

  const handleConfirmExit = async () => {
    setIsSafeCloseOpen(false);
    await handlePauseAll();
    executeNativeClose();
  };

  const runEngineScan = async (forceRefresh: boolean, isStillMounted?: () => boolean) => {
    if (isRefreshingEnginesRef.current) return;
    isRefreshingEnginesRef.current = true;
    setIsRefreshingEngines(true);
    try {
      const status = await api.getEngineStatus(forceRefresh);
      if (!isStillMounted || isStillMounted()) {
        setEngineStatus(status);
      }
    } catch (err) {
      console.error('Engine status scan failed:', err);
    } finally {
      isRefreshingEnginesRef.current = false;
      if (!isStillMounted || isStillMounted()) {
        setIsRefreshingEngines(false);
      }
    }
  };

  // Load initial data & subscribe to real-time events without blocking first paint
  useEffect(() => {
    let mounted = true;

    // 1. Initial non-blocking background fetches
    runEngineScan(false, () => mounted);
    api.getSettings().then((s) => mounted && setSettings(s)).catch(console.error);
    api.getTasks().then((t) => mounted && setTasks(t)).catch(console.error);
    api.getNotifications().then((n) => mounted && setNotifications(n)).catch(console.error);

    // 2. Real-time SSE / Tauri event subscription
    const unsubscribe = api.subscribeEvents({
      onInit: (data) => {
        if (!mounted) return;
        setTasks(data.tasks);
        setSettings(data.settings);
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
      },
      onTasksCleared: (clearedTasks) => {
        if (!mounted) return;
        setTasks(clearedTasks);
      },
      onNotification: (notif) => {
        if (!mounted) return;
        setNotifications((prev) => [notif, ...prev]);
      },
      onSettingsUpdated: (newSettings) => {
        if (!mounted) return;
        setSettings(newSettings);
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
    setInitialInspectUrl(url);
    setIsNewDownloadOpen(true);
  };

  const handlePauseTask = async (id: string) => {
    await api.pauseTask(id);
  };

  const handleResumeTask = async (id: string) => {
    await api.resumeTask(id);
  };

  const handleCancelTask = async (id: string) => {
    await api.cancelTask(id);
  };

  const handleRetryTask = async (id: string) => {
    await api.retryTask(id);
  };

  const handleDeleteTask = async (id: string, deleteFile = false) => {
    await api.deleteTask(id, deleteFile);
  };

  const handleDeleteFile = async (id: string) => {
    await api.deleteDownloadedFile(id);
  };

  const handlePauseAll = async () => {
    await api.pauseAll();
  };

  const handleResumeAll = async () => {
    await api.resumeAll();
  };

  const handleClearCompleted = async (deleteFiles = false) => {
    await api.clearCompleted(deleteFiles);
  };

  const handleClearFailed = async () => {
    await api.clearFailed();
  };

  const handleClearAll = async (deleteFiles = false) => {
    await api.clearAll(deleteFiles);
  };

  const handleRefreshEngines = async () => {
    await runEngineScan(true);
  };

  const handleInstallAllEngines = async (force = false) => {
    setIsInstallingEngines(true);
    setEngineInstallError(null);
    try {
      const res = await api.installAllEngines(true, force);
      await handleRefreshEngines();
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

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const saved = await api.updateSettings(newSettings);
    setSettings(saved);
  };

  const activeCount = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing'
  ).length;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0b0d10] text-[#e6edf3]">
      {/* Native In-App TitleBar Window Header */}
      <TitleBar
        activeDownloadsCount={activeCount}
        onRequestClose={handleInitiateClose}
      />

      <div className="flex flex-1 min-h-0 w-full overflow-hidden">
        {/* Sidebar Navigation */}
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

        {/* Main Content Viewport */}
        <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        {/* Top Bar Header */}
        <TopBar
          onQuickInspect={handleQuickInspect}
          onOpenNewDownload={() => {
            setInitialInspectUrl('');
            setIsNewDownloadOpen(true);
          }}
          onOpenSettings={() => setActiveTab('settings')}
          onOpenNotifications={() => setIsNotificationsOpen(true)}
          unreadNotificationsCount={notifications.length}
          activeCount={activeCount}
          onPauseAll={handlePauseAll}
          onResumeAll={handleResumeAll}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onToggleMobileMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        />

        {/* View Content Area */}
        <main className="flex-1 min-w-0 overflow-y-auto p-2.5 sm:p-4 md:p-6 pb-24 sm:pb-8 select-text">
          {activeTab === 'dashboard' && (
            <DashboardView
              tasks={tasks}
              engineStatus={engineStatus}
              settings={settings}
              onOpenNewDownload={() => {
                setInitialInspectUrl('');
                setIsNewDownloadOpen(true);
              }}
              onPauseTask={handlePauseTask}
              onResumeTask={handleResumeTask}
              onCancelTask={handleCancelTask}
              onViewQueue={() => setActiveTab('queue')}
              onRefreshEngines={handleRefreshEngines}
              isRefreshingEngines={isRefreshingEngines}
              onClearFailed={handleClearFailed}
              installProgress={installProgress}
              isInstallingEngines={isInstallingEngines}
              engineInstallError={engineInstallError}
              onInstallEngines={() => handleInstallAllEngines(false)}
            />
          )}

          {activeTab === 'queue' && (
            <QueueView
              tasks={tasks}
              onPauseTask={handlePauseTask}
              onResumeTask={handleResumeTask}
              onCancelTask={handleCancelTask}
              onRetryTask={handleRetryTask}
              onDeleteTask={handleDeleteTask}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onClearCompleted={handleClearCompleted}
              onClearFailed={handleClearFailed}
              onClearAll={handleClearAll}
              onDeleteFile={handleDeleteFile}
              onOpenNewDownload={() => {
                setInitialInspectUrl('');
                setIsNewDownloadOpen(true);
              }}
              searchFilter={searchQuery}
            />
          )}

          {activeTab === 'active' && (
            <QueueView
              tasks={tasks.filter(
                (t) =>
                  t.status === 'downloading' ||
                  t.status === 'extracting' ||
                  t.status === 'processing'
              )}
              onPauseTask={handlePauseTask}
              onResumeTask={handleResumeTask}
              onCancelTask={handleCancelTask}
              onRetryTask={handleRetryTask}
              onDeleteTask={handleDeleteTask}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onClearCompleted={handleClearCompleted}
              onClearFailed={handleClearFailed}
              onClearAll={handleClearAll}
              onDeleteFile={handleDeleteFile}
              onOpenNewDownload={() => {
                setInitialInspectUrl('');
                setIsNewDownloadOpen(true);
              }}
              searchFilter={searchQuery}
            />
          )}

          {activeTab === 'completed' && (
            <QueueView
              tasks={tasks.filter((t) => t.status === 'completed')}
              onPauseTask={handlePauseTask}
              onResumeTask={handleResumeTask}
              onCancelTask={handleCancelTask}
              onRetryTask={handleRetryTask}
              onDeleteTask={handleDeleteTask}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onClearCompleted={handleClearCompleted}
              onClearFailed={handleClearFailed}
              onClearAll={handleClearAll}
              onDeleteFile={handleDeleteFile}
              onOpenNewDownload={() => {
                setInitialInspectUrl('');
                setIsNewDownloadOpen(true);
              }}
              searchFilter={searchQuery}
            />
          )}

          {activeTab === 'music' && (
            <MusicLibraryView
              tasks={tasks}
              onOpenNewDownload={(url) => {
                setInitialInspectUrl(url || '');
                setIsNewDownloadOpen(true);
              }}
            />
          )}

          {activeTab === 'history' && (
            <HistoryView
              tasks={tasks}
              onClearHistory={handleClearCompleted}
              onDeleteTask={handleDeleteTask}
              onDeleteFile={handleDeleteFile}
            />
          )}

          {activeTab === 'diagnostics' && (
            <DiagnosticsView
              engineStatus={engineStatus}
              onRefresh={handleRefreshEngines}
              installProgress={installProgress}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              settings={settings}
              onSaveSettings={handleSaveSettings}
            />
          )}
        </main>
      </div>
      </div>

      {/* Floating Progress Surface */}
      {settings?.floating_notifications_enabled && (
        <FloatingProgressDock
          tasks={tasks}
          onPauseTask={handlePauseTask}
          onResumeTask={handleResumeTask}
          onCancelTask={handleCancelTask}
          onOpenQueue={() => setActiveTab('queue')}
        />
      )}

      {/* Universal Download Modal */}
      <NewDownloadModal
        isOpen={isNewDownloadOpen}
        onClose={() => setIsNewDownloadOpen(false)}
        initialUrl={initialInspectUrl}
        onTaskCreated={() => {
          setActiveTab('queue');
        }}
        onOpenCookieSettings={() => {
          setIsNewDownloadOpen(false);
          setActiveTab('settings');
        }}
      />

      {/* Notification Center Flyout */}
      <NotificationCenterModal
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
        notifications={notifications}
        onClearAll={async () => {
          await api.clearNotifications();
          setNotifications([]);
        }}
      />

      {/* Safe Close Dialog */}
      <SafeCloseDialog
        isOpen={isSafeCloseOpen}
        activeCount={activeCount}
        onCancel={() => setIsSafeCloseOpen(false)}
        onConfirmExit={handleConfirmExit}
      />
    </div>
  );
}
