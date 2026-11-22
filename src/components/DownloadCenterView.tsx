import React, { useState, useMemo } from 'react';
import {
  Play,
  Pause,
  X,
  RotateCw,
  Trash2,
  FolderOpen,
  FileCheck2,
  ArrowUp,
  ArrowDown,
  Plus,
  MoreHorizontal,
  Info,
  AlertTriangle,
  Download,
} from 'lucide-react';
import {
  DownloadTask,
  EngineInstallProgress,
  EngineStatusMap,
  TaskPriority,
} from '../types';
import {
  calculateAggregateSpeed,
  filterAndSortTasks,
  getActiveDownloadCount,
  SortDirection,
  SortField,
} from '../utils/queue-logic';
import { formatBytes } from '../utils/engine-parser';
import { ProgressDisplay, getStatusLabel, getStatusColorClass } from './ProgressDisplay';
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
  | 'video';

interface DownloadCenterViewProps {
  tasks: DownloadTask[];
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
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    checkboxLabel?: string;
    onConfirm: (checked: boolean) => void;
  } | null>(null);

  const visibleTasks = useMemo(
    () =>
      filterAndSortTasks(tasks, {
        statusFilter: scopeFilter,
        searchQuery,
        sortField,
        sortDirection,
      }),
    [tasks, scopeFilter, searchQuery, sortField, sortDirection]
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
  ];

  return (
    <div className="space-y-4">
      {/* Compact Telemetry Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] font-medium text-[var(--vanta-muted)]">Active Transfers</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-[var(--vanta-text)] mt-0.5">
            {activeCount}
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] font-medium text-[var(--vanta-muted)]">Combined Throughput</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-blue-600 dark:text-[#58a6ff] mt-0.5">
            {aggregateSpeed.formattedSpeed}
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] font-medium text-[var(--vanta-muted)]">Queued / Paused</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-[var(--vanta-text)] mt-0.5">
            {queuedCount} <span className="text-sm font-normal text-[var(--vanta-muted)]">/ {pausedCount}</span>
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] font-medium text-[var(--vanta-muted)]">Completed / Failed</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-[var(--vanta-text)] mt-0.5">
            <span className="text-emerald-700 dark:text-[#3fb950]">{completedCount}</span>{' '}
            <span className="text-sm font-normal text-[var(--vanta-muted)]">
              / {failedCount}
            </span>
          </p>
        </div>
      </div>

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
      <div className="flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
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
        {/* Table Header */}
        <div className="px-4 py-2 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] flex items-center justify-between gap-3 text-[11px] font-mono text-[var(--vanta-muted)]">
          <div className="flex items-center gap-3 min-w-0">
            <input
              type="checkbox"
              aria-label="Select all visible downloads"
              checked={visibleTasks.length > 0 && selectedIds.length === visibleTasks.length}
              onChange={toggleSelectAll}
              className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]"
            />
            <span>TRANSFER QUEUE ({visibleTasks.length})</span>
          </div>
          <span className="hidden sm:inline">PRIORITY / TELEMETRY / ACTIONS</span>
        </div>

        {visibleTasks.length === 0 ? (
          <div className="py-16 px-4 text-center space-y-3">
            <Download className="w-9 h-9 text-[var(--vanta-muted)]/60 mx-auto" />
            <div>
              <p className="text-sm font-medium text-[var(--vanta-text)]">
                {searchQuery || scopeFilter !== 'all'
                  ? 'No matching transfers found'
                  : 'Download queue is empty'}
              </p>
              <p className="text-xs text-[var(--vanta-muted)] mt-1">
                {searchQuery || scopeFilter !== 'all'
                  ? 'Clear your active filter or search term to view all transfers.'
                  : 'Paste a YouTube, video, playlist, or Spotify music URL to inspect and start downloading.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenNewDownload}
              className="px-4 py-2 rounded-lg bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New Download</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--vanta-border)]">
            {visibleTasks.map((task) => {
              const isSelectedRow = selectedTaskId === task.id;
              const isChecked = selectedIds.includes(task.id);
              const isRunning =
                task.status === 'downloading' ||
                task.status === 'connecting' ||
                task.status === 'resuming' ||
                task.status === 'inspecting' ||
                task.status === 'processing' ||
                task.status === 'muxing' ||
                task.status === 'verifying';

              return (
                <div
                  key={task.id}
                  onClick={() => onSelectTask(task)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setOpenMenuId(openMenuId === task.id ? null : task.id);
                  }}
                  className={`px-4 py-3 transition-colors cursor-pointer relative ${
                    isSelectedRow
                      ? 'bg-blue-500/8'
                      : 'hover:bg-[var(--vanta-surface-hover)]/60'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Row Checkbox */}
                    <div
                      className="pt-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${task.title}`}
                        checked={isChecked}
                        onChange={() => toggleRowSelected(task.id)}
                        className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]"
                      />
                    </div>

                    {/* Thumbnail or Media Type Tile */}
                    <MediaThumbnail
                      src={task.thumbnail}
                      title={task.title}
                      isAudio={task.is_audio_only || task.engine === 'spotdl'}
                      ext={task.ext}
                      size="md"
                      aspect={task.is_audio_only || task.engine === 'spotdl' ? 'square' : 'video'}
                    />

                    {/* Main Title, Metadata & Progress */}
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className="text-xs sm:text-sm font-medium text-[var(--vanta-text)] truncate">
                              {task.title}
                            </h3>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[var(--vanta-muted)] mt-0.5">
                            <span className={getStatusColorClass(task.status)}>
                              {getStatusLabel(task.status)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {task.is_audio_only || task.engine === 'spotdl' ? 'Audio' : 'Video'} ·{' '}
                              {task.engine}
                            </span>
                            {task.uploader && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-[var(--vanta-text-secondary)] truncate max-w-[180px]">
                                  {task.uploader}
                                </span>
                              </>
                            )}
                            {task.album && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-[160px]">{task.album}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>
                              {task.ext.toUpperCase()}
                              {task.is_audio_only && task.audio_bitrate && !['flac', 'wav'].includes((task.audio_format || '').toLowerCase())
                                ? ` (${task.audio_bitrate})`
                                : task.resolution_label
                                ? ` (${task.resolution_label})`
                                : ''}
                            </span>
                            {(task.tracks_requested ?? 0) > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums text-[var(--vanta-text-secondary)]">
                                  {task.tracks_completed ?? 0}/{task.tracks_requested} tracks
                                  {(task.tracks_failed ?? 0) > 0 ? (
                                    <span className="text-red-600 dark:text-[#f85149]">
                                      {' '}({task.tracks_failed} failed)
                                    </span>
                                  ) : null}
                                </span>
                              </>
                            )}
                            {task.duration_string && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums">{task.duration_string}</span>
                              </>
                            )}
                            {task.total_bytes > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums">{formatBytes(task.total_bytes)}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Row Action Controls */}
                        <div
                          className="flex items-center gap-1 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <select
                            aria-label={`Priority for ${task.title}`}
                            value={task.priority}
                            onChange={(e) =>
                              api.updateTaskMeta(task.id, {
                                priority: e.target.value as TaskPriority,
                              })
                            }
                            className="hidden md:block bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded px-1.5 py-1 text-[11px] font-mono text-[var(--vanta-text-secondary)] focus:outline-none"
                          >
                            <option value="low">Low</option>
                            <option value="normal">Normal</option>
                            <option value="high">High</option>
                            <option value="highest">Highest</option>
                          </select>

                          {isRunning ? (
                            <button
                              type="button"
                              onClick={() => onPauseTask(task.id)}
                              title="Pause"
                              aria-label="Pause transfer"
                              className="p-1.5 text-[var(--vanta-muted)] hover:text-amber-600 dark:hover:text-[#e3b341] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                            >
                              <Pause className="w-3.5 h-3.5" />
                            </button>
                          ) : task.status === 'paused' ? (
                            <button
                              type="button"
                              onClick={() => onResumeTask(task.id)}
                              title="Resume"
                              aria-label="Resume transfer"
                              className="p-1.5 text-[var(--vanta-muted)] hover:text-emerald-600 dark:hover:text-[#3fb950] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          ) : task.status === 'failed' || task.status === 'cancelled' ? (
                            <button
                              type="button"
                              onClick={() => onRetryTask(task.id)}
                              title="Retry"
                              aria-label="Retry transfer"
                              className="p-1.5 text-[var(--vanta-muted)] hover:text-blue-600 dark:hover:text-[#58a6ff] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                          ) : null}

                          {task.status === 'completed' && task.output_path && (
                            <>
                              <button
                                type="button"
                                onClick={() => api.openTaskFile(task).catch(() => {})}
                                title="Open file"
                                aria-label="Open downloaded file"
                                className="p-1.5 text-[var(--vanta-muted)] hover:text-emerald-600 dark:hover:text-[#3fb950] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                              >
                                <FileCheck2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => api.openTaskFolder(task).catch(() => {})}
                                title="Open folder"
                                aria-label="Open containing folder"
                                className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                              >
                                <FolderOpen className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {isRunning || task.status === 'queued' ? (
                            <button
                              type="button"
                              onClick={() => onCancelTask(task.id)}
                              title="Cancel"
                              aria-label="Cancel transfer"
                              className="p-1.5 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmState({
                                  title: 'Remove Transfer',
                                  message: `Remove "${task.title}" from the download queue?`,
                                  confirmLabel: 'Remove',
                                  checkboxLabel: task.output_path
                                    ? 'Also delete file from disk'
                                    : undefined,
                                  onConfirm: (deleteFile) => {
                                    setConfirmState(null);
                                    onDeleteTask(task.id, deleteFile);
                                  },
                                })
                              }
                              title="Delete"
                              aria-label="Remove transfer"
                              className="p-1.5 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => setOpenMenuId(openMenuId === task.id ? null : task.id)}
                            title="More actions"
                            aria-label="More transfer actions"
                            className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-2)] rounded-md transition-colors"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <ProgressDisplay task={task} />

                      {task.error_message && (
                        <p className="text-[11px] text-red-600 dark:text-[#f85149] truncate">
                          {task.error_message}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Row Context Menu */}
                  {openMenuId === task.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-4 top-10 z-30 w-44 rounded-lg border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-xl py-1 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          onSelectTask(task);
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"
                      >
                        <Info className="w-3.5 h-3.5" />
                        <span>Inspect Details</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          api.moveTask(task.id, 'up').catch(() => {});
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                        <span>Move Up in Queue</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          api.moveTask(task.id, 'down').catch(() => {});
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                        <span>Move Down in Queue</span>
                      </button>
                      {task.output_path && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            api.openTaskFolder(task).catch(() => {});
                          }}
                          className="w-full px-3 py-1.5 text-left hover:bg-[var(--vanta-surface-hover)] flex items-center gap-2 text-[var(--vanta-text)]"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>Open Folder</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setConfirmState({
                            title: 'Delete Transfer',
                            message: `Remove "${task.title}" from VANTA?`,
                            confirmLabel: 'Delete',
                            checkboxLabel: task.output_path ? 'Also delete file from disk' : undefined,
                            onConfirm: (deleteFile) => {
                              setConfirmState(null);
                              onDeleteTask(task.id, deleteFile);
                            },
                          });
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-red-500/10 flex items-center gap-2 text-red-600 dark:text-[#f85149]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
