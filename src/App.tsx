/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  DownloadTask,
  EngineStatusMap,
  AppSettings,
  NotificationItem,
} from './types';
import { api } from './services/api';
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
  const [historyTasks, setHistoryTasks] = useState<DownloadTask[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatusMap | null>(null);
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

  // Load initial data & subscribe to real-time events
  useEffect(() => {
    // 1. Initial fetches
    api.getEngineStatus().then(setEngineStatus).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
    api.getSettings().then(setSettings).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
    api.getTasks().then(setTasks).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
    api.getNotifications().then(setNotifications).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
    api.getDownloadHistory().then(setHistoryTasks).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));

    // 2. Real-time SSE subscription
    const unsubscribe = api.subscribeEvents({
      onInit: (data) => {
        setTasks(data.tasks);
        setSettings(data.settings);
      },
      onTaskUpdated: (updatedTask) => {
        setTasks((prev) => {
          const index = prev.findIndex((t) => t.id === updatedTask.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = updatedTask;
            return next;
          }
          return [updatedTask, ...prev];
        });
        if (updatedTask.status === 'completed' || updatedTask.status === 'failed' || updatedTask.status === 'cancelled') {
          setHistoryTasks((prev) => [updatedTask, ...prev.filter((task) => task.id !== updatedTask.id)]);
        }
      },
      onTaskAdded: (newTask) => {
        setTasks((prev) => [newTask, ...prev.filter((t) => t.id !== newTask.id)]);
      },
      onTaskDeleted: ({ id }) => {
        setTasks((prev) => prev.filter((t) => t.id !== id));
      },
      onTasksCleared: (clearedTasks) => {
        setTasks(clearedTasks);
      },
      onNotification: (notif) => {
        setNotifications((prev) => [notif, ...prev]);
      },
      onSettingsUpdated: (newSettings) => {
        setSettings(newSettings);
      },
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleQuickInspect = (url: string) => {
    setInitialInspectUrl(url);
    setIsNewDownloadOpen(true);
  };

  const reportActionError = (error: unknown) => {
    setActionError(error instanceof Error ? error.message : String(error));
  };

  const runAction = async (operation: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await operation();
    } catch (error) {
      reportActionError(error);
    }
  };

  const handlePauseTask = async (id: string) => runAction(() => api.pauseTask(id));
  const handleResumeTask = async (id: string) => runAction(() => api.resumeTask(id));
  const handleCancelTask = async (id: string) => runAction(() => api.cancelTask(id));
  const handleRetryTask = async (id: string) => runAction(() => api.retryTask(id));
  const handleDeleteTask = async (id: string) => runAction(() => api.deleteTask(id));
  const handlePauseAll = async () => runAction(() => api.pauseAll());
  const handleResumeAll = async () => runAction(() => api.resumeAll());
  const handleClearCompleted = async () => runAction(() => api.clearCompleted());

  const handleClearHistory = async () => {
    setActionError(null);
    try {
      await api.clearDownloadHistory();
      setHistoryTasks([]);
    } catch (error) {
      reportActionError(error);
    }
  };

  const handleDeleteHistoryTask = async (id: string) => {
    setActionError(null);
    try {
      await api.deleteHistoryEntry(id);
      setHistoryTasks((prev) => prev.filter((task) => task.id !== id));
    } catch (error) {
      reportActionError(error);
    }
  };

  const handleRefreshEngines = async () => {
    setActionError(null);
    try {
      const updated = await api.getEngineStatus();
      setEngineStatus(updated);
    } catch (error) {
      reportActionError(error);
    }
  };

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    setActionError(null);
    try {
      const saved = await api.updateSettings(newSettings);
      setSettings(saved);
    } catch (error) {
      reportActionError(error);
      throw error;
    }
  };

  const activeCount = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing' || t.status === 'retrying'
  ).length;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0b0d10] text-[#e6edf3]">
      {/* Native In-App TitleBar Window Header */}
      <TitleBar
        activeDownloadsCount={activeCount}
        onRequestClose={handleInitiateClose}
      />

      {actionError && (
        <div role="alert" className="flex items-start justify-between gap-3 border-b border-[#da3633]/40 bg-[#da3633]/10 px-4 py-2 text-xs text-[#f85149]">
          <span className="min-w-0 break-words">Operation failed: {actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 text-[#c9d1d9] hover:text-white">Dismiss</button>
        </div>
      )}

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
        <main className="flex-1 overflow-y-auto p-3 sm:p-5 md:p-6">
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
              tasks={historyTasks}
              onClearHistory={handleClearHistory}
              onDeleteTask={handleDeleteHistoryTask}
            />
          )}

          {activeTab === 'diagnostics' && (
            <DiagnosticsView
              engineStatus={engineStatus}
              onRefresh={handleRefreshEngines}
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
