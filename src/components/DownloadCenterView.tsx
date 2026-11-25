import React, { useState, useMemo, useEffect, useRef } from 'react';
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
  Copy,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Download,
  SlidersHorizontal,
} from 'lucide-react';
import {
  DownloadQueue,
  DownloadTask,
  EngineInstallProgress,
  EngineStatusMap,
} from '../types';
import {
  calculateAggregateSpeed,
  calculateQueueStatusCounts,
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

const RUNNING_TASK_STATUSES = new Set<DownloadTask['status']>([
  'downloading',
  'connecting',
  'resuming',
  'inspecting',
  'processing',
  'muxing',
  'verifying',
]);

const PAUSABLE_TASK_STATUSES = new Set<DownloadTask['status']>([
  ...RUNNING_TASK_STATUSES,
  'queued',
]);

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
  onTasksChanged: (tasks: DownloadTask[]) => void;
  /** Backward-compatible prop used by older view fixtures; queues are managed in the Sidebar. */
  onQueuesChanged?: (queues: DownloadQueue[]) => void;
  engineStatus: EngineStatusMap | null;
  scopeFilter: QueueScopeFilter;
  setScopeFilter?: (scope: QueueScopeFilter) => void;
  /** Deprecated compatibility prop retained for older view fixtures. */
  selectedTaskId?: string | null;
  searchQuery: string;
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

interface DownloadRowIdentityProps {
  title: string;
  thumbnail?: string | null;
  isAudio: boolean;
  ext?: string;
  uploader?: string;
  album?: string;
  duration?: string;
  compact?: boolean;
}

const DownloadRowIdentity = React.memo<DownloadRowIdentityProps>(({
  title,
  thumbnail,
  isAudio,
  ext,
  uploader,
  album,
  duration,
  compact = false,
}) => {
  const metadata = [uploader, album, duration, ext?.toUpperCase()].filter(Boolean).join(' · ');

  if (compact) {
    return (
      <>
        <MediaThumbnail src={thumbnail} title={title} isAudio={isAudio} ext={ext} size="sm" aspect={isAudio ? 'square' : 'video'} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-[var(--vanta-text)]">{title}</h3>
          <p className="mt-0.5 truncate text-[10px] text-[var(--vanta-muted)]">{metadata}</p>
        </div>
      </>
    );
  }

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <MediaThumbnail src={thumbnail} title={title} isAudio={isAudio} ext={ext} size="md" aspect={isAudio ? 'square' : 'video'} />
      <div className="min-w-0">
        <h3 className="text-xs sm:text-sm font-medium text-[var(--vanta-text)] truncate">{title}</h3>
        <p className="mt-0.5 text-[10px] text-[var(--vanta-muted)] truncate">{metadata}</p>
      </div>
    </div>
  );
});
DownloadRowIdentity.displayName = 'DownloadRowIdentity';

export const DownloadCenterView: React.FC<DownloadCenterViewProps> = ({
  tasks,
  queues,
  selectedQueueId,
  onSelectQueue,
  onTasksChanged,
  engineStatus,
  scopeFilter,
  setScopeFilter,
  searchQuery,
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
  const [isDesktopLayout, setIsDesktopLayout] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches,
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1280px)');
    const updateLayout = (event: MediaQueryListEvent) => setIsDesktopLayout(event.matches);
    setIsDesktopLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', updateLayout);
    return () => mediaQuery.removeEventListener('change', updateLayout);
  }, []);

  const [sortField, setSortField] = useState<SortField>('queue');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [isColumnMenuOpen, setIsColumnMenuOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    const defaults = { engine: true, size: true, speed: true, eta: true, status: true };
    try {
      const saved = localStorage.getItem('vanta.download-columns.v1');
      if (!saved) return defaults;
      const parsed: unknown = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
      const stored = parsed as Record<string, unknown>;
      return {
        engine: typeof stored.engine === 'boolean' ? stored.engine : defaults.engine,
        size: typeof stored.size === 'boolean' ? stored.size : defaults.size,
        speed: typeof stored.speed === 'boolean' ? stored.speed : defaults.speed,
        eta: typeof stored.eta === 'boolean' ? stored.eta : defaults.eta,
        status: typeof stored.status === 'boolean' ? stored.status : defaults.status,
      };
    } catch {
      return defaults;
    }
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveTargetQueueId, setMoveTargetQueueId] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    taskId: string;
    targetIds: string[];
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const lastSelectedIdRef = useRef<string | null>(null);
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

  const visibleTasks = useMemo(
    () => filterAndSortTasks(queueTasks, {
      statusFilter: scopeFilter,
      searchQuery,
      sortField,
      sortDirection,
    }),
    [queueTasks, scopeFilter, searchQuery, sortField, sortDirection]
  );

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedIdSet.has(task.id)),
    [tasks, selectedIdSet],
  );

  // Drop stale selections when a task is removed elsewhere (history cleanup, queue action, etc.).
  useEffect(() => {
    const existingIds = new Set(tasks.map((task) => task.id));
    setSelectedIds((current) => {
      const nextIds = current.filter((id) => existingIds.has(id));
      return nextIds.length === current.length ? current : nextIds;
    });
  }, [tasks]);
  const {
    pausableSelectedIds,
    resumableSelectedIds,
    retryableSelectedIds,
  } = useMemo(() => {
    const pausable: string[] = [];
    const resumable: string[] = [];
    const retryable: string[] = [];
    for (const task of selectedTasks) {
      if (PAUSABLE_TASK_STATUSES.has(task.status)) {
        pausable.push(task.id);
      } else if (task.status === 'paused') {
        resumable.push(task.id);
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        retryable.push(task.id);
      }
    }
    return {
      pausableSelectedIds: pausable,
      resumableSelectedIds: resumable,
      retryableSelectedIds: retryable,
    };
  }, [selectedTasks]);
  const cancellableSelectedIds = pausableSelectedIds;

  const activeCount = useMemo(() => getActiveDownloadCount(queueTasks), [queueTasks]);
  const aggregateSpeed = useMemo(() => calculateAggregateSpeed(queueTasks), [queueTasks]);
  const queueStatusCounts = useMemo(() => calculateQueueStatusCounts(queueTasks), [queueTasks]);
  const { paused: pausedCount, completed: completedCount, failed: failedCount } = queueStatusCounts;

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
    const visibleIds = visibleTasks.map((task) => task.id);
    const visibleIdSet = new Set(visibleIds);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIdSet.has(id));
    setSelectedIds((previous) => allVisibleSelected
      ? previous.filter((id) => !visibleIdSet.has(id))
      : [...new Set([...previous, ...visibleIds])]);
    if (!allVisibleSelected && visibleIds.length > 0) lastSelectedIdRef.current = visibleIds[visibleIds.length - 1];
  };

  const toggleRowSelected = (id: string) => {
    lastSelectedIdRef.current = id;
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  const handleBulkAction = async (
    action: 'pause' | 'resume' | 'retry' | 'cancel' | 'delete',
    idsOverride?: string[],
  ) => {
    const targetIds = idsOverride?.length ? [...idsOverride] : [...selectedIds];
    if (targetIds.length === 0) return;
    if (action === 'delete') {
      setConfirmState({
        title: `Remove ${targetIds.length} Selected Download${targetIds.length > 1 ? 's' : ''}`,
        message: 'Remove the selected items from the download list.',
        confirmLabel: 'Remove Selected',
        checkboxLabel: 'Also delete downloaded files from disk',
        onConfirm: async (deleteFiles) => {
          setConfirmState(null);
          try {
            if (targetIds.length === 1) {
              onDeleteTask(targetIds[0], deleteFiles);
            } else {
              const updatedTasks = await api.bulkTaskAction(targetIds, 'delete', deleteFiles);
              if (Array.isArray(updatedTasks)) onTasksChanged(updatedTasks);
            }
            setSelectedIds((previous) => previous.filter((id) => !targetIds.includes(id)));
          } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to remove the selected downloads.');
          }
        },
      });
      return;
    }
    try {
      if (action === 'cancel' && targetIds.length === 1) {
        onCancelTask(targetIds[0]);
      } else {
        const updatedTasks = await api.bulkTaskAction(targetIds, action, false);
        if (Array.isArray(updatedTasks)) onTasksChanged(updatedTasks);
      }
      if (action === 'cancel') setSelectedIds((previous) => previous.filter((id) => !targetIds.includes(id)));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'The selected download action failed.');
    }
  };

  const handleRowClick = (event: React.MouseEvent<HTMLElement>, task: DownloadTask, index: number) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, select, a, [role="menu"]')) return;
    onSelectTask(task);

    if (event.ctrlKey || event.metaKey) {
      toggleRowSelected(task.id);
      return;
    }
    if (event.shiftKey && lastSelectedIdRef.current) {
      const anchorIndex = visibleTasks.findIndex((item) => item.id === lastSelectedIdRef.current);
      if (anchorIndex >= 0) {
        const startIndex = Math.min(anchorIndex, index);
        const endIndex = Math.max(anchorIndex, index);
        const rangeIds = visibleTasks.slice(startIndex, endIndex + 1).map((item) => item.id);
        setSelectedIds((previous) => [...new Set([...previous, ...rangeIds])]);
        lastSelectedIdRef.current = task.id;
        return;
      }
    }
    setSelectedIds([task.id]);
    lastSelectedIdRef.current = task.id;
  };

  const openTaskContextMenu = (event: React.MouseEvent<HTMLElement>, task: DownloadTask) => {
    event.preventDefault();
    event.stopPropagation();
    // Right-click opens actions without changing the selected row or inspector.
    const nextIds = selectedIdSet.has(task.id) ? [...selectedIds] : [task.id];
    setContextMenu({ x: event.clientX, y: event.clientY, taskId: task.id, targetIds: nextIds });
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortDirection(field === 'title' ? 'asc' : 'desc');
    }
  };

  useEffect(() => {
    setSelectedIds([]);
    lastSelectedIdRef.current = null;
    setContextMenu(null);
  }, [selectedQueueId, scopeFilter, searchQuery]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelectedIds(visibleTasks.map((task) => task.id));
        lastSelectedIdRef.current = visibleTasks[visibleTasks.length - 1]?.id || null;
      } else if (event.key === 'Escape') {
        setContextMenu(null);
        setSelectedIds([]);
        lastSelectedIdRef.current = null;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visibleTasks]);



  useEffect(() => {
    try {
      localStorage.setItem('vanta.download-columns.v1', JSON.stringify(visibleColumns));
    } catch {
      // Storage may be unavailable in restricted WebView contexts.
    }
  }, [visibleColumns]);

  const columnOptions = [
    { id: 'engine', label: 'Engine' },
    { id: 'size', label: 'Size' },
    { id: 'speed', label: 'Speed' },
    { id: 'eta', label: 'ETA' },
    { id: 'status', label: 'Status' },
  ] as const;
  const tableGridTemplate = [
    '28px', '32px', 'minmax(210px,2fr)',
    ...(visibleColumns.engine ? ['72px'] : []),
    'minmax(145px,1.2fr)',
    ...(visibleColumns.size ? ['104px'] : []),
    ...(visibleColumns.speed ? ['92px'] : []),
    ...(visibleColumns.eta ? ['76px'] : []),
    ...(visibleColumns.status ? ['92px'] : []),
    '64px',
  ].join(' ');
  const tableGridClassName = 'grid items-center gap-2.5 px-4';
  return (
    <div className="flex min-h-0 flex-col gap-2.5">
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
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">Downloads</h2>
            <p className="text-[10px] text-[var(--vanta-muted)]">{visibleTasks.length} items in this view · {aggregateSpeed.formattedSpeed} total</p>
          </div>
          {selectedIds.length > 0 && (
            <span className="hidden sm:inline-flex px-2 py-1 rounded-md bg-[var(--vanta-accent)]/10 text-[var(--vanta-accent)] text-[10px] font-semibold tabular-nums">
              {selectedIds.length} selected
            </span>
          )}
        </div>

        {/* Sort + Queue Controls */}
        <div className="relative flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={isColumnMenuOpen}
            aria-label="Customize download columns"
            onClick={() => setIsColumnMenuOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-2.5 py-1.5 text-xs font-medium text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Columns
          </button>
          {isColumnMenuOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 w-52 rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] p-2.5 shadow-xl">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--vanta-text)]">Visible columns</p>
                <button type="button" onClick={() => setVisibleColumns({ engine: true, size: true, speed: true, eta: true, status: true })} className="text-[10px] text-[var(--vanta-accent)] hover:underline">Reset</button>
              </div>
              <div className="space-y-1">
                {columnOptions.map((column) => (
                  <label key={column.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)]">
                    <input
                      type="checkbox"
                      checked={visibleColumns[column.id]}
                      onChange={(event) => setVisibleColumns((current) => ({ ...current, [column.id]: event.target.checked }))}
                      className="h-3.5 w-3.5 rounded accent-[var(--vanta-accent)]"
                    />
                    {column.label}
                  </label>
                ))}
              </div>
              <p className="mt-2 border-t border-[var(--vanta-border)] pt-2 text-[10px] text-[var(--vanta-muted)]">Name, Progress and Actions stay visible.</p>
            </div>
          )}
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
            {pausableSelectedIds.length > 0 && (
              <button type="button" onClick={() => handleBulkAction('pause', pausableSelectedIds)}
                className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0">Pause</button>
            )}
            {resumableSelectedIds.length > 0 && (
              <button type="button" onClick={() => handleBulkAction('resume', resumableSelectedIds)}
                className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0">Resume</button>
            )}
            {retryableSelectedIds.length > 0 && (
              <button type="button" onClick={() => handleBulkAction('retry', retryableSelectedIds)}
                className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0">Retry</button>
            )}
            {cancellableSelectedIds.length > 0 && (
              <button type="button" onClick={() => handleBulkAction('cancel', cancellableSelectedIds)}
                className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0">Cancel</button>
            )}
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(selectedTasks.map((task) => task.url).join('\n')).catch(() => window.alert('Could not copy selected links.'))}
              className="px-2.5 py-1 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" /> Copy Links
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
                    const nextTasks = await api.moveTasksToQueue(selectedIds, moveTargetQueueId);
                    onTasksChanged(nextTasks);
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
        {isDesktopLayout && <div className="overflow-x-auto">
          <div className="min-w-[1060px]">
            <div className={`${tableGridClassName} py-3 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] text-[11px] font-semibold text-[var(--vanta-muted)]`} style={{ gridTemplateColumns: tableGridTemplate }}>
              <input type="checkbox" aria-label="Select all visible downloads"
                checked={visibleTasks.length > 0 && visibleTasks.every((task) => selectedIdSet.has(task.id))}
                onChange={toggleSelectAll} className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]" />
              <span>#</span>
              <button type="button" onClick={() => toggleSort('title')} className="inline-flex items-center gap-1 text-left hover:text-[var(--vanta-text)]">Name {sortField === 'title' ? sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3 opacity-50" />}</button>
              {visibleColumns.engine && <span>Engine</span>}<span>Progress</span>
              {visibleColumns.size && <button type="button" onClick={() => toggleSort('size')} className="inline-flex items-center gap-1 text-left hover:text-[var(--vanta-text)]">Size {sortField === 'size' ? sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3 opacity-50" />}</button>}
              {visibleColumns.speed && <button type="button" onClick={() => toggleSort('speed')} className="inline-flex items-center gap-1 text-left hover:text-[var(--vanta-text)]">Speed {sortField === 'speed' ? sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3 opacity-50" />}</button>}
              {visibleColumns.eta && <span>ETA</span>}{visibleColumns.status && <span>Status</span>}<span>Actions</span>
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
              <div
                className="divide-y divide-[var(--vanta-border)]"
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest('[data-download-row]')) {
                    setSelectedIds([]);
                    lastSelectedIdRef.current = null;
                  }
                }}
              >
                {visibleTasks.map((task, index) => {
                  const isSelectedRow = selectedIdSet.has(task.id);
                  const isChecked = selectedIdSet.has(task.id);
                  const isRunning = RUNNING_TASK_STATUSES.has(task.status);
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
                    <div key={task.id} data-download-row
                      onClick={(event) => handleRowClick(event, task, index)}
                      onDoubleClick={() => {
                        if (task.status === 'completed' && task.output_path) {
                          api.openTaskFile(task).catch((error) => window.alert(error instanceof Error ? error.message : 'Could not open file.'));
                        } else onSelectTask(task);
                      }}
                      onContextMenu={(event) => openTaskContextMenu(event, task)}
                      className={`relative ${tableGridClassName} py-3 cursor-pointer transition-colors ${isSelectedRow ? 'bg-[var(--vanta-accent)]/10' : 'hover:bg-[var(--vanta-surface-hover)]/60'}`} style={{ gridTemplateColumns: tableGridTemplate }}>
                      <div onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${task.title}`} checked={isChecked} onChange={() => { toggleRowSelected(task.id); onSelectTask(task); }} className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]" />
                      </div>
                      <span className="text-xs text-[var(--vanta-muted)] tabular-nums">{index + 1}</span>
                      <DownloadRowIdentity
                        title={task.title}
                        thumbnail={task.thumbnail}
                        isAudio={task.is_audio_only || task.engine === 'spotdl'}
                        ext={task.ext}
                        uploader={task.uploader}
                        album={task.album}
                        duration={task.duration_string}
                      />
                      {visibleColumns.engine && <span className="text-[11px] text-[var(--vanta-text-secondary)] truncate">{task.engine === 'spotdl' ? 'SpotDL' : 'yt-dlp'}</span>}
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[10px] text-[var(--vanta-muted)]">{percentKnown ? `${progress.toFixed(1)}%` : '—'}</span>
                          {task.status === 'downloading' && <span className="text-[10px] text-[var(--vanta-muted)] truncate">{task.current_phase || ''}</span>}
                        </div>
                        <div className="h-2.5 w-full rounded-full bg-[var(--vanta-surface-2)] overflow-hidden border border-[var(--vanta-border)]">
                          <div className={`h-full rounded-full transition-[width] duration-200 ${task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-[var(--vanta-accent)]'}`} style={{ width: `${percentKnown ? progress : 0}%` }} />
                        </div>
                      </div>
                      {visibleColumns.size && <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap" title={task.status === 'completed' ? 'Verified final output file size' : 'Estimated total size may change after merging or media processing'}>{sizeText}</span>}
                      {visibleColumns.speed && <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap">{task.status === 'downloading' ? task.speed_str || '—' : '—'}</span>}
                      {visibleColumns.eta && <span className="text-[11px] text-[var(--vanta-text-secondary)] tabular-nums whitespace-nowrap">{task.status === 'downloading' ? task.eta_str || '—' : '—'}</span>}
                      {visibleColumns.status && <span className={`inline-flex w-fit max-w-full rounded-md px-2 py-1 text-[10px] font-medium truncate ${getStatusColorClass(task.status)} bg-[var(--vanta-surface-2)]`}>{getStatusLabel(task.status)}</span>}

                      <div className="flex items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                        <button type="button" title={isRunning ? 'Pause' : task.status === 'paused' ? 'Resume' : task.status === 'failed' || task.status === 'cancelled' ? 'Retry' : 'More actions'}
                          onClick={(event) => isRunning ? onPauseTask(task.id) : task.status === 'paused' ? onResumeTask(task.id) : task.status === 'failed' || task.status === 'cancelled' ? onRetryTask(task.id) : openTaskContextMenu(event, task)}
                          className="p-1.5 rounded-md text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
                          {isRunning ? <Pause className="w-3.5 h-3.5" /> : task.status === 'paused' ? <Play className="w-3.5 h-3.5" /> : task.status === 'failed' || task.status === 'cancelled' ? <RotateCw className="w-3.5 h-3.5" /> : <MoreHorizontal className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>}
        {!isDesktopLayout && <div className="divide-y divide-[var(--vanta-border)]">
          {visibleTasks.length === 0 ? (
            <div className="px-4 py-14 text-center space-y-3">
              <Download className="mx-auto h-9 w-9 text-[var(--vanta-muted)]/60" />
              <div>
                <p className="text-sm font-medium text-[var(--vanta-text)]">{searchQuery || scopeFilter !== 'all' ? 'No matching transfers found' : 'Download queue is empty'}</p>
                <p className="mt-1 text-xs text-[var(--vanta-muted)]">{searchQuery || scopeFilter !== 'all' ? 'Clear a filter or search term to see more transfers.' : 'Paste a video, playlist, or Spotify URL to get started.'}</p>
              </div>
              <button type="button" onClick={onOpenNewDownload} className="inline-flex items-center gap-2 rounded-lg bg-[var(--vanta-accent)] px-4 py-2 text-xs font-semibold text-white">
                <Plus className="h-4 w-4" /> New Download
              </button>
            </div>
          ) : visibleTasks.map((task, index) => {
            const isRunning = RUNNING_TASK_STATUSES.has(task.status);
            const isSelected = selectedIdSet.has(task.id);
            const progress = task.status === 'completed' ? 100 : Math.max(0, Math.min(100, task.progress_percentage || 0));
            const percentKnown = task.status === 'completed' || (task.percentage_known !== false && (task.total_bytes > 0 || task.progress_percentage > 0));
            const downloaded = task.status === 'completed' && task.downloaded_bytes === 0 && task.total_bytes > 0 ? task.total_bytes : task.downloaded_bytes;
            const total = task.status === 'completed' ? (task.downloaded_bytes || task.total_bytes || downloaded) : task.total_bytes;
            const sizeText = total > 0 ? `${formatBytes(downloaded)} / ${task.status === 'completed' ? formatBytes(total) : '≈' + formatBytes(total)}` : downloaded > 0 ? formatBytes(downloaded) : '—';
            return (
              <article
                key={task.id}
                data-download-row
                onClick={(event) => handleRowClick(event, task, index)}
                onDoubleClick={() => task.status === 'completed' && task.output_path
                  ? api.openTaskFile(task).catch((error) => window.alert(error instanceof Error ? error.message : 'Could not open file.'))
                  : onSelectTask(task)}
                onContextMenu={(event) => openTaskContextMenu(event, task)}
                className={`select-none px-3 py-3.5 transition-colors ${
                  isSelected ? 'bg-[var(--vanta-accent)]/10' : 'hover:bg-[var(--vanta-surface-hover)]/50'
                }`}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${task.title}`}
                    checked={isSelected}
                    onChange={() => { toggleRowSelected(task.id); onSelectTask(task); }}
                    onClick={(event) => event.stopPropagation()}
                    className="mt-1 h-3.5 w-3.5 shrink-0 rounded accent-[var(--vanta-accent)]"
                  />
                  <DownloadRowIdentity
                    title={task.title}
                    thumbnail={task.thumbnail}
                    isAudio={task.is_audio_only || task.engine === 'spotdl'}
                    ext={task.ext}
                    uploader={task.uploader}
                    album={task.album}
                    duration={task.duration_string}
                    compact
                  />
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--vanta-text-secondary)]">
                      <span className={`rounded-md px-2 py-0.5 font-medium ${getStatusColorClass(task.status)} bg-[var(--vanta-surface-2)]`}>{getStatusLabel(task.status)}</span>
                      <span>{sizeText}</span>
                      {task.status === 'downloading' && <span>{task.speed_str || '—'}</span>}
                      {task.status === 'downloading' && <span>ETA {task.eta_str || '—'}</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--vanta-surface-2)]">
                        <div className={`h-full rounded-full ${task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-[var(--vanta-accent)]'}`} style={{ width: `${percentKnown ? progress : 0}%` }} />
                      </div>
                      <span className="w-11 shrink-0 text-right text-[10px] font-mono tabular-nums text-[var(--vanta-muted)]">{percentKnown ? `${progress.toFixed(0)}%` : '—'}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      aria-label={isRunning ? 'Pause download' : task.status === 'paused' ? 'Resume download' : task.status === 'failed' || task.status === 'cancelled' ? 'Retry download' : 'Open download actions'}
                      title={isRunning ? 'Pause' : task.status === 'paused' ? 'Resume' : task.status === 'failed' || task.status === 'cancelled' ? 'Retry' : 'More actions'}
                      onClick={(event) => isRunning ? onPauseTask(task.id) : task.status === 'paused' ? onResumeTask(task.id) : task.status === 'failed' || task.status === 'cancelled' ? onRetryTask(task.id) : openTaskContextMenu(event, task)}
                      className="rounded-lg p-2 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]"
                    >
                      {isRunning ? <Pause className="h-4 w-4" /> : task.status === 'paused' ? <Play className="h-4 w-4" /> : task.status === 'failed' || task.status === 'cancelled' ? <RotateCw className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>}
      </div>

      {contextMenu && (
        <div className="fixed inset-0 z-[80]" onClick={() => setContextMenu(null)}>
          <div
            ref={contextMenuRef}
            role="menu"
            aria-label="Download actions"
            onClick={(event) => event.stopPropagation()}
            style={{
              left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 272)),
              top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 460)),
            }}
            className="fixed z-[81] w-[264px] max-h-[min(440px,calc(100vh-16px))] overflow-y-auto rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-2xl py-1.5 text-xs"
          >
            <div className="px-3 py-2 border-b border-[var(--vanta-border)]">
              <p className="font-semibold text-[var(--vanta-text)] truncate">
                {contextMenu.targetIds.length > 1
                  ? `${contextMenu.targetIds.length} downloads selected`
                  : tasks.find((task) => task.id === contextMenu.taskId)?.title || 'Download'}
              </p>
              <p className="text-[10px] text-[var(--vanta-muted)] mt-0.5">Actions apply to the current selection</p>
            </div>
            {contextMenu.targetIds.length === 1 && (
              <>
                <button type="button" role="menuitem" onClick={() => {
                  const task = tasks.find((item) => item.id === contextMenu.taskId);
                  if (task) onSelectTask(task);
                  setContextMenu(null);
                }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                  <Info className="w-4 h-4 text-[var(--vanta-muted)]" /> Details
                </button>
                {(() => {
                  const task = tasks.find((item) => item.id === contextMenu.taskId);
                  if (!task?.output_path) return null;
                  return (
                    <>
                      {task.status === 'completed' && (
                        <button type="button" role="menuitem" onClick={() => {
                          api.openTaskFile(task).catch((error) => window.alert(error instanceof Error ? error.message : 'Could not open file.'));
                          setContextMenu(null);
                        }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                          <FileCheck2 className="w-4 h-4 text-[var(--vanta-muted)]" /> Open File
                        </button>
                      )}
                      <button type="button" role="menuitem" onClick={() => {
                        api.openTaskFolder(task).catch((error) => window.alert(error instanceof Error ? error.message : 'Could not open folder.'));
                        setContextMenu(null);
                      }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                        <FolderOpen className="w-4 h-4 text-[var(--vanta-muted)]" /> Open Folder
                      </button>
                    </>
                  );
                })()}
              </>
            )}
            <div className="my-1 border-t border-[var(--vanta-border)]" />
            {contextMenu.targetIds.some((id) => {
              const task = tasks.find((item) => item.id === id);
              return task && PAUSABLE_TASK_STATUSES.has(task.status);
            }) && (
              <button type="button" role="menuitem" onClick={() => {
                const ids = contextMenu.targetIds.filter((id) => {
                  const task = tasks.find((item) => item.id === id);
                  return task && PAUSABLE_TASK_STATUSES.has(task.status);
                });
                handleBulkAction('pause', ids).catch((error) => window.alert(error instanceof Error ? error.message : 'Pause failed.'));
                setContextMenu(null);
              }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                <Pause className="w-4 h-4 text-[var(--vanta-muted)]" /> Pause
              </button>
            )}
            {contextMenu.targetIds.some((id) => tasks.find((item) => item.id === id)?.status === 'paused') && (
              <button type="button" role="menuitem" onClick={() => {
                const ids = contextMenu.targetIds.filter((id) => tasks.find((item) => item.id === id)?.status === 'paused');
                handleBulkAction('resume', ids).catch((error) => window.alert(error instanceof Error ? error.message : 'Resume failed.'));
                setContextMenu(null);
              }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                <Play className="w-4 h-4 text-[var(--vanta-muted)]" /> Resume
              </button>
            )}
            {contextMenu.targetIds.some((id) => ['failed','cancelled'].includes(tasks.find((item) => item.id === id)?.status || '')) && (
              <button type="button" role="menuitem" onClick={() => {
                const ids = contextMenu.targetIds.filter((id) => ['failed','cancelled'].includes(tasks.find((item) => item.id === id)?.status || ''));
                handleBulkAction('retry', ids).catch((error) => window.alert(error instanceof Error ? error.message : 'Retry failed.'));
                setContextMenu(null);
              }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
                <RotateCw className="w-4 h-4 text-[var(--vanta-muted)]" /> Retry
              </button>
            )}
            {contextMenu.targetIds.some((id) => {
              const task = tasks.find((item) => item.id === id);
              return task && PAUSABLE_TASK_STATUSES.has(task.status);
            }) && (
              <button type="button" role="menuitem" onClick={() => {
                const ids = contextMenu.targetIds.filter((id) => {
                  const task = tasks.find((item) => item.id === id);
                  return task && PAUSABLE_TASK_STATUSES.has(task.status);
                });
                handleBulkAction('cancel', ids).catch((error) => window.alert(error instanceof Error ? error.message : 'Cancel failed.'));
                setContextMenu(null);
              }} className="w-full px-3 py-2 text-left hover:bg-red-500/10 flex items-center gap-2.5 text-[var(--vanta-text)]">
                <X className="w-4 h-4 text-[var(--vanta-muted)]" /> Cancel
              </button>
            )}
            <div className="my-1 border-t border-[var(--vanta-border)]" />
            {queues.filter((queue) => queue.id !== selectedQueueId).length > 0 && (
              <div className="px-3 py-1.5">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--vanta-muted)]">Move to Queue</p>
                {queues.filter((queue) => queue.id !== selectedQueueId).map((queue) => (
                  <button key={queue.id} type="button" role="menuitem" onClick={async () => {
                    try {
                      const nextTasks = await api.moveTasksToQueue(contextMenu.targetIds, queue.id);
                      onTasksChanged(nextTasks);
                      onSelectQueue(queue.id);
                      setSelectedIds([]);
                    } catch (error) {
                      window.alert(error instanceof Error ? error.message : 'Could not move selected downloads.');
                    } finally {
                      setContextMenu(null);
                    }
                  }} className="w-full px-2 py-1.5 rounded-md text-left hover:bg-[var(--vanta-surface-hover)] text-[var(--vanta-text)]">
                    {queue.name}
                  </button>
                ))}
              </div>
            )}
            <button type="button" role="menuitem" onClick={() => {
              const urls = contextMenu.targetIds.map((id) => tasks.find((task) => task.id === id)?.url).filter(Boolean).join('\n');
              navigator.clipboard.writeText(urls).catch(() => window.alert('Could not copy selected links.'));
              setContextMenu(null);
            }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2.5 text-[var(--vanta-text)]">
              <Copy className="w-4 h-4 text-[var(--vanta-muted)]" /> Copy Link{contextMenu.targetIds.length > 1 ? 's' : ''}
            </button>
            <button type="button" role="menuitem" onClick={() => { handleBulkAction('delete', contextMenu.targetIds); setContextMenu(null); }}
              className="w-full px-3 py-2 text-left hover:bg-red-500/10 flex items-center gap-2.5 text-red-500">
              <Trash2 className="w-4 h-4" /> Remove
            </button>
          </div>
        </div>
      )}

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
