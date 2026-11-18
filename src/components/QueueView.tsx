import React, { useState } from 'react';
import {
  Play,
  Pause,
  X,
  RotateCcw,
  Trash2,
  ExternalLink,
  FolderOpen,
  ArrowUpDown,
  CheckCircle,
  AlertCircle,
  Clock,
  Activity,
  Filter,
  FileX,
} from 'lucide-react';
import { DownloadTask, TaskStatus, TaskPriority } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { formatAudioQualityBadge } from '../utils/audio-quality';

interface QueueViewProps {
  tasks: DownloadTask[];
  onPauseTask: (id: string) => void;
  onResumeTask: (id: string) => void;
  onCancelTask: (id: string) => void;
  onRetryTask: (id: string) => void;
  onDeleteTask: (id: string, deleteFile?: boolean) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onClearCompleted: (deleteFiles?: boolean) => void;
  onClearFailed?: () => void;
  onClearAll?: (deleteFiles?: boolean) => void;
  onDeleteFile?: (id: string) => void;
  onOpenNewDownload: () => void;
  searchFilter: string;
}

export const QueueView: React.FC<QueueViewProps> = ({
  tasks,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onRetryTask,
  onDeleteTask,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
  onClearFailed,
  onClearAll,
  onDeleteFile,
  onOpenNewDownload,
  searchFilter,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');

  const filteredTasks = tasks.filter((t) => {
    // Status filter
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    // Search query filter
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q) ||
        (t.uploader && t.uploader.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'downloading':
        return <span className="text-[#58a6ff] bg-[#1f6feb]/15 px-2 py-0.5 rounded text-[11px] font-mono">Downloading</span>;
      case 'extracting':
        return <span className="text-[#d29922] bg-[#d29922]/15 px-2 py-0.5 rounded text-[11px] font-mono">Extracting</span>;
      case 'processing':
        return <span className="text-[#a371f7] bg-[#a371f7]/15 px-2 py-0.5 rounded text-[11px] font-mono">Processing</span>;
      case 'completed':
        return <span className="text-[#3fb950] bg-[#238636]/15 px-2 py-0.5 rounded text-[11px] font-mono">Completed</span>;
      case 'paused':
        return <span className="text-[#8b949e] bg-[#30363d]/30 px-2 py-0.5 rounded text-[11px] font-mono">Paused</span>;
      case 'failed':
        return <span className="text-[#f85149] bg-[#da3633]/15 px-2 py-0.5 rounded text-[11px] font-mono">Failed</span>;
      case 'cancelled':
        return <span className="text-[#8b949e] bg-[#21262d] px-2 py-0.5 rounded text-[11px] font-mono">Cancelled</span>;
      default:
        return <span className="text-[#c9d1d9] bg-[#21262d] px-2 py-0.5 rounded text-[11px] font-mono">Queued</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">Download Queue</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Manage priorities, concurrent streams, and active transfers
          </p>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap w-full sm:w-auto">
          <button
            onClick={onResumeAll}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5 text-[#3fb950]" />
            <span>Resume All</span>
          </button>
          <button
            onClick={onPauseAll}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            <Pause className="w-3.5 h-3.5 text-[#d29922]" />
            <span>Pause All</span>
          </button>
          {tasks.some((t) => t.status === 'failed') && onClearFailed && (
            <button
              onClick={onClearFailed}
              className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#f85149] bg-[#da3633]/15 hover:bg-[#da3633]/25 border border-[#da3633]/30 rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Failed</span>
            </button>
          )}
          <button
            onClick={() => onClearCompleted(false)}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors"
          >
            Clear Completed
          </button>
          {tasks.length > 0 && onClearAll && (
            <button
              onClick={() => {
                if (window.confirm('Clear all tasks from queue?')) {
                  onClearAll(false);
                }
              }}
              className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#8b949e] hover:text-[#f85149] bg-[#21262d]/60 hover:bg-[#21262d] rounded-lg transition-colors"
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 p-1 bg-[#12151a] border border-[#21262d] rounded-lg overflow-x-auto scrollbar-none">
        {(
          [
            { id: 'all', label: 'All Tasks', count: tasks.length },
            { id: 'downloading', label: 'Active', count: tasks.filter((t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing').length },
            { id: 'queued', label: 'Queued', count: tasks.filter((t) => t.status === 'queued').length },
            { id: 'paused', label: 'Paused', count: tasks.filter((t) => t.status === 'paused').length },
            { id: 'completed', label: 'Completed', count: tasks.filter((t) => t.status === 'completed').length },
            { id: 'failed', label: 'Failed', count: tasks.filter((t) => t.status === 'failed').length },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setStatusFilter(tab.id as any)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
              statusFilter === tab.id
                ? 'bg-[#21262d] text-white shadow-xs'
                : 'text-[#8b949e] hover:text-[#e6edf3]'
            }`}
          >
            <span>{tab.label}</span>
            <span className="text-[10px] font-mono text-[#7d8590]">({tab.count})</span>
          </button>
        ))}
      </div>

      {/* Tasks List */}
      {filteredTasks.length === 0 ? (
        <div className="py-16 text-center border border-dashed border-[#21262d] rounded-xl bg-[#12151a] p-4">
          <Activity className="w-10 h-10 text-[#484f58] mx-auto mb-2.5" />
          <p className="text-sm font-medium text-[#c9d1d9]">No downloads found</p>
          <p className="text-xs text-[#8b949e] mt-1">
            {statusFilter === 'all'
              ? 'Your queue is empty. Start a new download to populate tasks.'
              : `No tasks matching status "${statusFilter}".`}
          </p>
          <button
            onClick={onOpenNewDownload}
            className="mt-4 px-4 py-2 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-medium rounded-lg inline-flex items-center gap-2 transition-colors"
          >
            Start Download
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTasks.map((task) => (
            <div
              key={task.id}
              className="p-3.5 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a] hover:border-[#30363d] transition-all space-y-3"
            >
              {/* Row 1: Title, status, actions */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {task.thumbnail ? (
                    <img
                      src={task.thumbnail}
                      alt={task.title}
                      referrerPolicy="no-referrer"
                      className="w-14 sm:w-16 h-10 sm:h-11 object-cover rounded-md bg-[#0d1117] shrink-0 border border-[#21262d]"
                    />
                  ) : (
                    <div className="w-14 sm:w-16 h-10 sm:h-11 rounded-md bg-[#161b22] border border-[#21262d] flex items-center justify-center shrink-0 text-[10px] font-mono text-[#8b949e]">
                      {task.ext.toUpperCase()}
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <h3 className="text-xs font-semibold text-white break-words sm:truncate max-w-full sm:max-w-md">
                        {task.title}
                      </h3>
                      {getStatusBadge(task.status)}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8b949e] mt-1 font-mono">
                      <span>{task.engine}</span>
                      <span aria-hidden="true">·</span>
                      {task.verified_audio_info ? (
                        <span className="text-[#3fb950] font-mono text-[10px] bg-[#238636]/15 border border-[#238636]/30 px-1.5 py-0.5 rounded">
                          {task.verified_audio_info} {task.is_lossy_source ? '(Transcoded)' : ''}
                        </span>
                      ) : task.is_audio_only ? (
                        <span className="text-[#58a6ff] font-mono text-[10px] bg-[#1f6feb]/15 border border-[#1f6feb]/30 px-1.5 py-0.5 rounded">
                          {formatAudioQualityBadge(
                            task.audio_format || task.ext,
                            task.audio_bit_depth,
                            task.audio_sample_rate,
                            task.audio_bitrate,
                            task.is_lossy_source,
                            false
                          )}
                        </span>
                      ) : (
                        <span>{task.ext.toUpperCase()}</span>
                      )}
                      {task.uploader && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[120px] sm:max-w-[180px]">{task.uploader}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="text-[#7d8590] uppercase text-[10px]">
                        Priority: {task.priority}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-end gap-1.5 shrink-0 pt-2 sm:pt-0 border-t sm:border-0 border-[#21262d]">
                  {task.status === 'downloading' || task.status === 'extracting' || task.status === 'processing' ? (
                    <button
                      onClick={() => onPauseTask(task.id)}
                      title="Pause"
                      aria-label="Pause task"
                      className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#d29922] hover:bg-[#161b22] rounded-lg transition-colors"
                    >
                      <Pause className="w-4 h-4" />
                    </button>
                  ) : task.status === 'paused' || task.status === 'queued' ? (
                    <button
                      onClick={() => onResumeTask(task.id)}
                      title="Resume"
                      aria-label="Resume task"
                      className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#3fb950] hover:bg-[#161b22] rounded-lg transition-colors"
                    >
                      <Play className="w-4 h-4" />
                    </button>
                  ) : null}

                  {task.status === 'failed' && (
                    <button
                      onClick={() => onRetryTask(task.id)}
                      title="Retry"
                      aria-label="Retry task"
                      className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#58a6ff] hover:bg-[#161b22] rounded-lg transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}

                  {task.output_path && task.status === 'completed' && (
                    <>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(task.output_path || '');
                        }}
                        title="Copy file path to clipboard"
                        aria-label="Copy file path"
                        className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#3fb950] hover:bg-[#161b22] rounded-lg transition-colors"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete downloaded file "${task.title}" from disk?`)) {
                            if (onDeleteFile) {
                              onDeleteFile(task.id);
                            } else {
                              onDeleteTask(task.id, true);
                            }
                          }
                        }}
                        title="Delete file from disk"
                        aria-label="Delete downloaded file from disk"
                        className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#f85149] hover:bg-[#161b22] rounded-lg transition-colors"
                      >
                        <FileX className="w-4 h-4" />
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(task.url);
                    }}
                    title="Copy source URL"
                    aria-label="Copy source URL"
                    className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#161b22] rounded-lg transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>

                  {task.status !== 'completed' && task.status !== 'cancelled' && (
                    <button
                      onClick={() => onCancelTask(task.id)}
                      title="Cancel"
                      aria-label="Cancel task"
                      className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#f85149] hover:bg-[#161b22] rounded-lg transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}

                  <button
                    onClick={() => {
                      const deleteFile = task.status === 'completed' && Boolean(task.output_path);
                      onDeleteTask(task.id, deleteFile);
                    }}
                    title="Delete task from queue"
                    aria-label="Delete task from queue"
                    className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#f85149] hover:bg-[#161b22] rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Row 2: Progress and Error/Status */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono text-[#8b949e] mb-1">
                  <div className="flex items-center gap-2">
                    <span>{task.current_phase}</span>
                    {task.speed_str && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#58a6ff]">{task.speed_str}</span>
                      </>
                    )}
                    {task.eta_str && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>ETA {task.eta_str}</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {task.downloaded_bytes > 0 && (
                      <span>
                        {formatBytes(task.downloaded_bytes)}
                        {task.total_bytes > 0 && ` / ${formatBytes(task.total_bytes)}`}
                      </span>
                    )}
                    <span className="text-white font-medium">
                      {task.progress_percentage.toFixed(1)}%
                    </span>
                  </div>
                </div>

                <div className="w-full h-1.5 bg-[#21262d] rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 rounded-full ${
                      task.status === 'failed'
                        ? 'bg-[#da3633]'
                        : task.status === 'completed'
                        ? 'bg-[#238636]'
                        : task.status === 'paused'
                        ? 'bg-[#d29922]'
                        : 'bg-[#1f6feb]'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(1, task.progress_percentage))}%` }}
                  />
                </div>

                {task.error_message && (
                  <p className="text-[11px] text-[#f85149] mt-1.5 font-mono truncate">
                    Error: {task.error_message}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
