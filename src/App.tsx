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

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
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

  // Load initial data & subscribe to real-time events
  useEffect(() => {
    // 1. Initial fetches
    api.getEngineStatus().then(setEngineStatus).catch(console.error);
    api.getSettings().then(setSettings).catch(console.error);
    api.getTasks().then(setTasks).catch(console.error);
    api.getNotifications().then(setNotifications).catch(console.error);

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

  const handleDeleteTask = async (id: string) => {
    await api.deleteTask(id);
  };

  const handlePauseAll = async () => {
    await api.pauseAll();
  };

  const handleResumeAll = async () => {
    await api.resumeAll();
  };

  const handleClearCompleted = async () => {
    await api.clearCompleted();
  };

  const handleRefreshEngines = async () => {
    const updated = await api.getEngineStatus();
    setEngineStatus(updated);
  };

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const saved = await api.updateSettings(newSettings);
    setSettings(saved);
  };

  const activeCount = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing'
  ).length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0b0d10] text-[#e6edf3]">
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
      <div className="flex flex-col flex-1 min-w-0 h-screen overflow-hidden">
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
              tasks={tasks}
              onClearHistory={handleClearCompleted}
              onDeleteTask={handleDeleteTask}
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
    </div>
  );
}
