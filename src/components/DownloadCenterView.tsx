import React, { useState, useMemo } from 'react';
import {
  Play,
  Pause,
  X,
  RotateCw,
  Trash2,
  FolderOpen,
  FileCheck2,
  Plus,
  MoreHorizontal,
  Info,
  AlertTriangle,
  Download,
} from 'lucide-react';
import {
  DownloadQueue,
  DownloadTask,
  EngineInstallProgress,
  EngineStatusMap,
} from '../types';
import {
  calculateAggregateSpeed,
  filterAndSortTasks,
  getActiveDownloadCount,
  SortDirection,
  SortField,
} from '../utils/queue-logic';
import { formatBytes } from '../utils/engine-parser';
import { getStatusLabel, getStatusColorClass } from './ProgressDisplay';
import { MediaThumbnail } from './MediaThumbnail';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../services/api';

export type QueueScopeFilter =
  | 'all'
  | 'active'
  | 'queued'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'audio'
  | 'video'
  | 'finished'
  | 'unfinished';

interface DownloadCenterViewProps {
  tasks: DownloadTask[];
  queues: DownloadQueue[];
  selectedQueueId: string;
  onSelectQueue: (id: string) => void;
  onQueuesChanged: (queues: DownloadQueue[]) => void;
  engineStatus: EngineStatusMap | null;
  scopeFilter: QueueScopeFilter;
  setScopeFilter: (scope: QueueScopeFilter) => void;
  searchQuery: string;
  selectedTaskId: string | null;
  onSelectTask: (task: DownloadTask) => void;
  onOpenNewDownload: () => void;
  onPauseTask: (id: string) => void;
  onResumeTask: (id: string) => void;
  onCancelTask: (id: string) => void;
  onRetryTask: (id: string) => void;
  onDeleteTask: (id: string, deleteFile?: boolean) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onClearCompleted: (deleteFiles?: boolean) => void;
  onClearFailed: () => void;
  onInstallEngines?: () => void;
  isInstallingEngines?: boolean;
  engineInstallError?: string | null;
  installProgress?: Record<string, EngineInstallProgress>;
}

export const DownloadCenterView: React.FC<DownloadCenterViewProps> = ({
  tasks,
  queues,
  selectedQueueId,
  onSelectQueue,
  onQueuesChanged,
  engineStatus,
  scopeFilter,
  setScopeFilter,
  searchQuery,
  selectedTaskId,
  onSelectTask,
  onOpenNewDownload,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onRetryTask,
  onDeleteTask,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
  onClearFailed,
  onInstallEngines,
  isInstallingEngines = false,
  engineInstallError = null,
}) => {
  const [sortField, setSortField] = useState<SortField>('queue');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showNewQueue, setShowNewQueue] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [renameQueueId, setRenameQueueId] = useState<string | null>(null);
  const [renameQueueName, setRenameQueueName] = useState('');
  const [moveTargetQueueId, setMoveTargetQueueId] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    checkboxLabel?: string;
    onConfirm: (checked: boolean) => void;
  } | null>(null);

  const queueTasks = useMemo(
    () => selectedQueueId === 'all' ? tasks : tasks.filter((task) => (task.queue_id || 'main') === selectedQueueId),
    [tasks, selectedQueueId]
  );
  const activeQueue = queues.find((queue) => queue.id === selectedQueueId) || null;

  const visibleTasks = useMemo(
    () => {
      const scoped = scopeFilter === 'finished'
        ? queueTasks.filter((task) => task.status === 'completed')
        : scopeFilter === 'unfinished'
          ? queueTasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
          : queueTasks;
      const statusFilter = scopeFilter === 'finished' || scopeFilter === 'unfinished' ? 'all' : scopeFilter;
      return filterAndSortTasks(scoped, { statusFilter, searchQuery, sortField, sortDirection });
    },
    [queueTasks, scopeFilter, searchQuery, sortField, sortDirection]
  );

  const activeCount = useMemo(() => getActiveDownloadCount(tasks), [tasks]);
  const aggregateSpeed = useMemo(() => calculateAggregateSpeed(tasks), [tasks]);
  const queuedCount = tasks.filter((t) => t.status === 'queued').length;
  const pausedCount = tasks.filter((t) => t.status === 'paused').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  const audioCount = tasks.filter((t) => t.is_audio_only || t.engine === 'spotdl').length;
  const videoCount = tasks.filter((t) => !t.is_audio_only && t.engine !== 'spotdl').length;

  const missingRequiredEngines = useMemo(() => {
    if (!engineStatus) return [];
    const missing: string[] = [];
    if (engineStatus.ytdlp && engineStatus.ytdlp.status !== 'checking' && !engineStatus.ytdlp.available) {
      missing.push('yt-dlp');
    }
    if (engineStatus.ffmpeg && engineStatus.ffmpeg.status !== 'checking' && !engineStatus.ffmpeg.available) {
      missing.push('FFmpeg');
    }
    return missing;
  }, [engineStatus]);

  const toggleSelectAll = () => {
    if (selectedIds.length === visibleTasks.length && visibleTasks.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(visibleTasks.map((t) => t.id));
    }
  };

  const toggleRowSelected = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleBulkAction = async (action: 'pause' | 'resume' | 'retry' | 'cancel' | 'delete') => {
    if (selectedIds.length === 0) return;
    if (action === 'delete') {
      const targetIds = [...selectedIds];
      setConfirmState({
        title: `Delete ${targetIds.length} Selected Download${targetIds.length > 1 ? 's' : ''}`,
        message: 'Remove the selected items from the download list.',
        confirmLabel: 'Delete Selected',
        checkboxLabel: 'Also delete downloaded files from disk',
        onConfirm: async (deleteFiles) => {
          setConfirmState(null);
          await api.bulkTaskAction(targetIds, 'delete', deleteFiles);
          setSelectedIds([]);
        },
      });
      return;
    }
    await api.bulkTaskAction(selectedIds, action, false);
    if (action === 'cancel') setSelectedIds([]);
  };

  const scopeTabs: Array<{ id: QueueScopeFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: tasks.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'queued', label: 'Queued', count: queuedCount },
    { id: 'paused', label: 'Paused', count: pausedCount },
    { id: 'completed', label: 'Completed', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
    { id: 'audio', label: 'Audio', count: audioCount },
    { id: 'video', label: 'Video', count: videoCount },
    { id: 'finished', label: 'Finished', count: completedCount },
    { id: 'unfinished', label: 'Unfinished', count: tasks.length - completedCount },
  ];

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      {/* Compact, collapsible queue controls: keep the transfer list as the primary workspace. */}
      <details className="group rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface)] shrink-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--vanta-text-secondary)] select-none">
          <span className="text-[var(--vanta-accent)]">▸</span>
          <span>Queues</span>
          <span className="text-[10px] text-[var(--vanta-muted)]">{queues.length} queues · {tasks.length} transfers</span>
          <span className="ml-auto text-[10px] text-[var(--vanta-muted)]">Manage queues</span>
        </summary>
        <section className="border-t border-[var(--vanta-border)] p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--vanta-muted)]">Queues</span>
            <span className="text-[10px] text-[var(--vanta-muted)]">{queues.length} queue{queues.length === 1 ? '' : 's'}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowNewQueue((value) => !value)}
            className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] hover:bg-[var(--vanta-surface-hover)] text-[11px] font-medium text-[var(--vanta-text)] inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> New Queue
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => { onSelectQueue('all'); setSelectedIds([]); }}
            className={`px-3 py-2 rounded-lg border text-left min-w-[110px] transition-colors ${selectedQueueId === 'all' ? 'border-[var(--vanta-accent)] bg-[var(--vanta-accent)]/10' : 'border-[var(--vanta-border)] hover:bg-[var(--vanta-surface-hover)]'}`}
          >
            <span className="block text-xs font-semibold text-[var(--vanta-text)]">All Queues</span>
            <span className="block text-[10px] text-[var(--vanta-muted)]">{tasks.length} transfers</span>
          </button>
          {queues.map((queue) => {
            const count = tasks.filter((task) => (task.queue_id || 'main') === queue.id).length;
            const running = tasks.filter((task) => (task.queue_id || 'main') === queue.id && ['connecting','downloading','processing','muxing','verifying','resuming'].includes(task.status)).length;
            const active = selectedQueueId === queue.id;
            return (
              <button
                key={queue.id}
                type="button"
                onClick={() => { onSelectQueue(queue.id); setSelectedIds([]); }}
                className={`px-3 py-2 rounded-lg border text-left min-w-[110px] transition-colors ${active ? 'border-[var(--vanta-accent)] bg-[var(--vanta-accent)]/10' : 'border-[var(--vanta-border)] hover:bg-[var(--vanta-surface-hover)]'}`}
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--vanta-text)]">
                  <span className={`w-1.5 h-1.5 rounded-full ${queue.is_paused ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  <span className="truncate">{queue.name}</span>
                </span>
                <span className="block mt-0.5 text-[10px] text-[var(--vanta-muted)]">{count} items · {running} active</span>
              </button>
            );
          })}
        </div>

        {showNewQueue && (
          <form
            className="flex flex-wrap items-center gap-2 border-t border-[var(--vanta-border)] pt-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const name = newQueueName.trim();
              if (!name) return;
              try {
                const next = await api.createQueue(name);
                onQueuesChanged(next);
                const created = next.find((queue) => queue.name.toLocaleLowerCase() === name.toLocaleLowerCase());
                if (created) onSelectQueue(created.id);
                setNewQueueName('');
                setShowNewQueue(false);
              } catch (error) {
                window.alert(error instanceof Error ? error.message : 'Could not create queue.');
              }
            }}
          >
            <input
              autoFocus
              value={newQueueName}
              onChange={(event) => setNewQueueName(event.target.value)}
              maxLength={40}
              placeholder="Queue name (e.g. Film)"
              className="min-w-[180px] flex-1 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-2 text-xs text-[var(--vanta-text)] outline-none focus:border-[var(--vanta-accent)]"
            />
            <button type="submit" disabled={!newQueueName.trim()} className="px-3 py-2 rounded-lg bg-[var(--vanta-accent)] text-white text-xs font-medium disabled:opacity-40">Create Queue</button>
            <button type="button" onClick={() => { setShowNewQueue(false); setNewQueueName(''); }} className="px-3 py-2 rounded-lg border border-[var(--vanta-border)] text-xs text-[var(--vanta-muted)]">Cancel</button>
          </form>
        )}

        {activeQueue && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--vanta-border)] pt-3">
            {renameQueueId === activeQueue.id ? (
              <form
                className="flex flex-wrap items-center gap-2 flex-1"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    const next = await api.renameQueue(activeQueue.id, renameQueueName);
                    onQueuesChanged(next);
                    setRenameQueueId(null);
                  } catch (error) {
                    window.alert(error instanceof Error ? error.message : 'Could not rename queue.');
                  }
                }}
              >
                <input value={renameQueueName} onChange={(event) => setRenameQueueName(event.target.value)} maxLength={40} className="min-w-[150px] flex-1 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-2.5 py-1.5 text-xs text-[var(--vanta-text)]" />
                <button type="submit" className="px-2.5 py-1.5 rounded-lg bg-[var(--vanta-accent)] text-white text-xs">Save name</button>
                <button type="button" onClick={() => setRenameQueueId(null)} className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] text-xs">Cancel</button>
              </form>
            ) : (
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[var(--vanta-text)]">{activeQueue.name}</div>
                <div className="text-[10px] text-[var(--vanta-muted)]">{activeQueue.is_paused ? 'Queue stopped · new downloads will wait' : 'Queue is running'}</div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={async () => { try { onQueuesChanged(activeQueue.is_paused ? await api.startQueue(activeQueue.id) : await api.stopQueue(activeQueue.id)); } catch (error) { window.alert(error instanceof Error ? error.message : 'Queue action failed.'); } }} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${activeQueue.is_paused ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400'}`}>
                {activeQueue.is_paused ? 'Start Queue' : 'Stop Queue'}
              </button>
              {!activeQueue.is_default && renameQueueId !== activeQueue.id && (
                <>
                  <button type="button" onClick={() => { setRenameQueueId(activeQueue.id); setRenameQueueName(activeQueue.name); }} className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] text-xs text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)]">Rename</button>
                  <button type="button" onClick={() => setConfirmState({ title: 'Delete Queue', message: `Delete "${activeQueue.name}"? Its downloads will be moved to Main Queue.`, confirmLabel: 'Delete Queue', onConfirm: async () => { try { const next = await api.deleteQueue(activeQueue.id); onQueuesChanged(next); onSelectQueue('main'); setSelectedIds([]); } catch (error) { window.alert(error instanceof Error ? error.message : 'Could not delete queue.'); } finally { setConfirmState(null); } } })} className="px-2.5 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/5">Delete</button>
                </>
              )}
            </div>
          </div>
        )}
        </section>
      </details>

      {/* Missing Engine Inline Alert (only shown when missing) */}
      {missingRequiredEngines.length > 0 && (
        <div className="px-4 py-3 rounded-xl border border-amber-500/35 bg-amber-500/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-[#e3b341] shrink-0" />
            <div>
              <p className="font-medium text-[var(--vanta-text)]">
                Required media binaries unavailable: {missingRequiredEngines.join(', ')}
              </p>
              <p className="text-[11px] text-[var(--vanta-muted)]">
                {engineInstallError ||
                  'Install managed engines (yt-dlp and FFmpeg) to download and mux video or music.'}
              </p>
            </div>
          </div>
          {onInstallEngines && (
            <button
              type="button"
              disabled={isInstallingEngines}
              onClick={onInstallEngines}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              {isInstallingEngines ? 'Installing Binaries...' : 'Install Required Binaries'}
            </button>
          )}
        </div>
      )}

      {/* Filter, Sort & Queue Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
        {/* Segmented Status Tabs */}
        <div className="flex flex-wrap items-center gap-1">
          {scopeTabs.map((tab) => {
            const active = scopeFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setScopeFilter(tab.id)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
                  active
                    ? 'bg-[var(--vanta-accent)] text-white'
                    : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono tabular-nums text-[10px] ${
                    active ? 'text-white/85' : 'text-[var(--vanta-muted)]'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Sort + Queue Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Sort downloads"
            value={`${sortField}:${sortDirection}`}
            onChange={(e) => {
              const [f, d] = e.target.value.split(':') as [SortField, SortDirection];
              setSortField(f);
              setSortDirection(d);
            }}
            className="bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--vanta-text)] focus:outline-none focus:border-[var(--vanta-accent)]"
          >
            <option value="queue:asc">Queue Order</option>
            <option value="created_at:desc">Newest First</option>
            <option value="created_at:asc">Oldest First</option>
            <option value="speed:desc">Fastest Speed</option>
            <option value="progress:desc">Highest Progress</option>
            <option value="size:desc">Largest File</option>
            <option value="title:asc">Title (A–Z)</option>
          </select>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={onPauseAll}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] text-xs font-medium text-[var(--vanta-text-secondary)] whitespace-nowrap shrink-0 transition-colors"
            >
              Pause All
            </button>
          )}
          {pausedCount > 0 && (
            <button
              type="button"
              onClick={onResumeAll}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] text-xs font-medium text-emerald-700 dark:text-[#3fb950] whitespace-nowrap shrink-0 transition-colors"
            >
              Resume All
            </button>
          )}
          {completedCount > 0 && (
            <button
              type="button"
              onClick={() =>
                setConfirmState({
                  title: 'Clear Completed Transfers',
                  message: `Remove ${completedCount} completed record(s) from the list.`,
                  confirmLabel: 'Clear Completed',
                  checkboxLabel: 'Also delete completed files from disk',
                  onConfirm: (deleteFiles) => {
                    setConfirmState(null);
                    onClearCompleted(deleteFiles);
                  },
                })
              }
              className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] text-xs font-medium text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] whitespace-nowrap shrink-0 transition-colors"
            >
              Clear Completed
            </button>
          )}
          {failedCount > 0 && (
            <button
              type="button"
              onClick={onClearFailed}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] text-xs font-medium text-red-600 dark:text-[#f85149] whitespace-nowrap shrink-0 transition-colors"
            >
              Clear Failed
            </button>
          )}
        </div>
      </div>

      {/* Multi-Select Bulk Action Bar */}
      {selectedIds.length > 0 && (
        <div className="px-4 py-2 rounded-xl border border-[var(--vanta-accent)]/40 bg-[var(--vanta-accent)]/10 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-[var(--vanta-text)] font-mono tabular-nums">
            {selectedIds.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleBulkAction('pause')}
              className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0"
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() => handleBulkAction('resume')}
              className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={() => handleBulkAction('retry')}
              className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => handleBulkAction('delete')}
              className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white whitespace-nowrap shrink-0"
            >
              Delete
            </button>
            {queues.length > 1 && (
              <div className="flex items-center gap-1.5">
                <select value={moveTargetQueueId} onChange={(event) => setMoveTargetQueueId(event.target.value)} className="max-w-[150px] rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] px-2 py-1 text-xs text-[var(--vanta-text)]">
                  <option value="">Move to queue…</option>
                  {queues.filter((queue) => queue.id !== selectedQueueId).map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}
                </select>
                <button type="button" disabled={!moveTargetQueueId} onClick={async () => {
                  try {
                    await api.moveTasksToQueue(selectedIds, moveTargetQueueId);
                    onSelectQueue(moveTargetQueueId);
                    setSelectedIds([]);
                    setMoveTargetQueueId('');
                  } catch (error) {
                    window.alert(error instanceof Error ? error.message : 'Could not move selected downloads.');
                  }
                }} className="px-2.5 py-1 rounded border border-[var(--vanta-border)] bg-[var(--vanta-surface)] text-[var(--vanta-text)] disabled:opacity-40">Move</button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="px-2 py-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] whitespace-nowrap shrink-0"
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      {/* Main Transfer List */}
      <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[1040px]">
            <div className="grid grid-cols-[30px_34px_minmax(230px,1.8fr)_78px_minmax(130px,1fr)_92px_86px_78px_96px_76px] items-center gap-2 px-3 py-3 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] text-[11px] font-semibold text-[var(--vanta-muted)]">
              <input type="checkbox" aria-label="Select all visible downloads"
                checked={visibleTasks.length > 0 && selectedIds.length === visibleTasks.length}
                onChange={toggleSelectAll} className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]" />
              <span>#</span><span>Name</span><span>Engine</span><span>Progress</span><span>Size</span><span>Speed</span><span>ETA</span><span>Status</span><span>Actions</span>
            </div>

            {visibleTasks.length === 0 ? (
              <div className="py-16 px-4 text-center space-y-3">
                <Download className="w-9 h-9 text-[var(--vanta-muted)]/60 mx-auto" />
                <div>
                  <p className="text-sm font-medium text-[var(--vanta-text)]">{searchQuery || scopeFilter !== 'all' ? 'No matching transfers found' : 'Download queue is empty'}</p>
                  <p className="text-xs text-[var(--vanta-muted)] mt-1">{searchQuery || scopeFilter !== 'all' ? 'Clear your active filter or search term to view all transfers.' : 'Paste a video, playlist, or Spotify URL to inspect and start downloading.'}</p>
                </div>
                <button type="button" onClick={onOpenNewDownload} className="px-4 py-2 rounded-lg bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white text-xs font-medium inline-flex items-center gap-1.5">
                  <Plus className="w-4 h-4" /><span>New Download</span>
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[var(--vanta-border)]">
                {visibleTasks.map((task, index) => {
                  const isSelectedRow = selectedTaskId === task.id;
                  const isChecked = selectedIds.includes(task.id);
                  const isRunning = ['downloading','connecting','resuming','inspecting','processing','muxing','verifying'].includes(task.status);
                  const percentKnown = task.status === 'completed' || (task.percentage_known !== false && (task.total_bytes > 0 || task.progress_percentage > 0));
                  const progress = task.status === 'completed' ? 100 : Math.max(0, Math.min(100, task.progress_percentage || 0));
                  const downloaded = task.status === 'completed' && task.downloaded_bytes === 0 && task.total_bytes > 0 ? task.total_bytes : task.downloaded_bytes;
                  const completedSize = task.status === 'completed' ? (task.downloaded_bytes || task.total_bytes || downloaded) : 0;
                  const sizeText = task.status === 'completed'
                    ? (completedSize > 0 ? formatBytes(completedSize) : '—')
                    : task.total_bytes > 0
                      ? `${downloaded > 0 ? formatBytes(downloaded) : '0 B'} / ≈${formatBytes(task.total_bytes)}`
                      : downloaded > 0 ? formatBytes(downloaded) : '—';

                  return (
                    <div key={task.id} onClick={() => onSelectTask(task)}
                      onContextMenu={(event) => { event.preventDefault(); setOpenMenuId(openMenuId === task.id ? null : task.id); }}
                      className={`relative grid grid-cols-[30px_34px_minmax(230px,1.8fr)_78px_minmax(130px,1fr)_92px_86px_78px_96px_76px] items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${isSelectedRow ? 'bg-[var(--vanta-accent)]/10' : 'hover:bg-[var(--vanta-surface-hover)]/60'}`}>
                      <div onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${task.title}`} checked={isChecked} onChange={() => toggleRowSelected(task.id)} className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]" />
                      </div>
                      <span className="text-xs text-[var(--vanta-muted)] tabular-nums">{index + 1}</span>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MediaThumbnail src={task.thumbnail} title={task.title} isAudio={task.is_audio_only || task.engine === 'spotdl'} ext={task.ext} size="md" aspect={task.is_audio_only || task.engine === 'spotdl' ? 'square' : 'video'} />
                        <div className="min-w-0">
                          <h3 className="text-xs sm:text-sm font-medium text-[var(--vanta-text)] truncate">{task.title}</h3>
                          <p className="mt-0.5 text-[10px] text-[var(--vanta-muted)] truncate">{[task.uploader, task.album, task.duration_string, task.ext?.toUpperCase()].filter(Boolean).join(' · ')}</p>
                        </div>
                      </div>
                      <span className="text-[11px] text-[var(--vanta-text-secondary)] truncate">{task.engine === 'spotdl' ? 'SpotDL' : 'yt-dlp'}</span>
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[10px] text-[var(--vanta-muted)]">{percentKnown ? `${progress.toFixed(1)}%` : '—'}</span>
                          {task.status === 'downloading' && <span className="text-[10px] text-[var(--vanta-muted)] truncate">{task.current_phase || ''}</span>}
                        </div>
                        <div className="h-2 w-full rounded-full bg-[var(--vanta-surface-2)] overflow-hidden border border-[var(--vanta-border)]">
                          <div className={`h-full rounded-full transition-[width] duration-200 ${task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-[var(--vanta-accent)]'}`} style={{ width: `${percentKnown ? progress : 0}%` }} />
                        </div>
                      </div>
                      <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap" title={task.status === 'completed' ? 'Verified final output file size' : 'Estimated total size may change after merging or media processing'}>{sizeText}</span>
                      <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap">{task.status === 'downloading' ? task.speed_str || '—' : '—'}</span>
                      <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap">{task.status === 'downloading' ? task.eta_str || '—' : '—'}</span>
                      <span className={`inline-flex w-fit max-w-full rounded-md px-2 py-1 text-[10px] font-medium truncate ${getStatusColorClass(task.status)} bg-[var(--vanta-surface-2)]`}>{getStatusLabel(task.status)}</span>

                      <div className="flex items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                        <button type="button" title={isRunning ? 'Pause' : task.status === 'paused' ? 'Resume' : task.status === 'failed' || task.status === 'cancelled' ? 'Retry' : 'More actions'}
                          onClick={() => isRunning ? onPauseTask(task.id) : task.status === 'paused' ? onResumeTask(task.id) : task.status === 'failed' || task.status === 'cancelled' ? onRetryTask(task.id) : setOpenMenuId(openMenuId === task.id ? null : task.id)}
                          className="p-1.5 rounded-md text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
                          {isRunning ? <Pause className="w-3.5 h-3.5" /> : task.status === 'paused' ? <Play className="w-3.5 h-3.5" /> : task.status === 'failed' || task.status === 'cancelled' ? <RotateCw className="w-3.5 h-3.5" /> : <MoreHorizontal className="w-3.5 h-3.5" />}
                        </button>
                        <button type="button" title="More actions" aria-label="More transfer actions" onClick={() => setOpenMenuId(openMenuId === task.id ? null : task.id)} className="p-1.5 rounded-md text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {openMenuId === task.id && (
                        <div onClick={(event) => event.stopPropagation()} className="absolute right-3 top-10 z-30 w-48 rounded-lg border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-xl py-1 text-xs">
                          <button type="button" onClick={() => { setOpenMenuId(null); onSelectTask(task); }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"><Info className="w-3.5 h-3.5" />Inspect Details</button>
                          {task.output_path && <button type="button" onClick={() => { setOpenMenuId(null); api.openTaskFolder(task).catch(() => {}); }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"><FolderOpen className="w-3.5 h-3.5" />Open Folder</button>}
                          {task.status === 'completed' && task.output_path && <button type="button" onClick={() => { setOpenMenuId(null); api.openTaskFile(task).catch(() => {}); }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"><FileCheck2 className="w-3.5 h-3.5" />Open File</button>}
                          {isRunning || task.status === 'queued' ? <button type="button" onClick={() => { setOpenMenuId(null); onCancelTask(task.id); }} className="w-full px-3 py-2 text-left hover:bg-red-500/10 flex items-center gap-2 text-red-500"><X className="w-3.5 h-3.5" />Cancel</button> : <button type="button" onClick={() => { setOpenMenuId(null); setConfirmState({ title: 'Remove Transfer', message: `Remove "${task.title}" from the download queue?`, confirmLabel: 'Remove', checkboxLabel: task.output_path ? 'Also delete file from disk' : undefined, onConfirm: (deleteFile) => { setConfirmState(null); onDeleteTask(task.id, deleteFile); } }); }} className="w-full px-3 py-2 text-left hover:bg-red-500/10 flex items-center gap-2 text-red-500"><Trash2 className="w-3.5 h-3.5" />Remove</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      <ConfirmDialog
        isOpen={Boolean(confirmState)}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel}
        danger
        checkboxLabel={confirmState?.checkboxLabel}
        onConfirm={(checked) => confirmState?.onConfirm(checked)}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
};
