import React from 'react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { isActiveTaskStatus } from '../utils/download-core';

interface ProgressDisplayProps {
  task: DownloadTask;
  compact?: boolean;
}

export function getStatusLabel(status: DownloadTask['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'inspecting':
      return 'Inspecting';
    case 'ready':
      return 'Ready';
    case 'connecting':
      return 'Connecting';
    case 'downloading':
      return 'Downloading';
    case 'pausing':
      return 'Pausing';
    case 'paused':
      return 'Paused';
    case 'resuming':
      return 'Resuming';
    case 'processing':
      return 'Processing';
    case 'muxing':
      return 'Muxing';
    case 'verifying':
      return 'Verifying';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export function getStatusColorClass(status: DownloadTask['status']): string {
  switch (status) {
    case 'completed':
      return 'text-emerald-700 dark:text-[#3fb950]';
    case 'failed':
      return 'text-red-700 dark:text-[#f85149]';
    case 'paused':
    case 'pausing':
      return 'text-amber-700 dark:text-[#e3b341]';
    case 'cancelled':
      return 'text-[var(--vanta-muted)]';
    case 'muxing':
    case 'processing':
    case 'verifying':
      return 'text-violet-700 dark:text-[#a371f7]';
    case 'downloading':
    case 'connecting':
    case 'resuming':
    case 'inspecting':
      return 'text-blue-700 dark:text-[#58a6ff]';
    default:
      return 'text-[var(--vanta-text-secondary)]';
  }
}

export const ProgressDisplay: React.FC<ProgressDisplayProps> = ({ task, compact = false }) => {
  const isActive = isActiveTaskStatus(task.status);
  const percentageKnown =
    task.status === 'completed' ||
    (task.percentage_known !== false && (task.total_bytes > 0 || task.progress_percentage > 0));

  const isPostProcessing =
    task.status === 'muxing' || task.status === 'processing' || task.status === 'verifying';
  const isPreTransfer =
    task.status === 'inspecting' || task.status === 'connecting' || task.status === 'resuming';
  const isIndeterminate =
    isActive &&
    (isPreTransfer || isPostProcessing || (task.status === 'downloading' && !percentageKnown));

  const clampedPct = Math.min(100, Math.max(0, task.progress_percentage || 0));
  const barWidthPct =
    task.status === 'completed'
      ? 100
      : task.status === 'paused' && !percentageKnown
      ? 0
      : clampedPct;

  const barToneClass =
    task.status === 'completed'
      ? 'bg-emerald-600 dark:bg-[#3fb950]'
      : task.status === 'failed'
      ? 'bg-red-600 dark:bg-[#f85149]'
      : task.status === 'paused' || task.status === 'pausing'
      ? 'bg-amber-500 dark:bg-[#d29922]'
      : isPostProcessing
      ? 'bg-violet-600 dark:bg-[#a371f7]'
      : task.status === 'cancelled'
      ? 'bg-[var(--vanta-muted)]/50'
      : 'bg-blue-600 dark:bg-[#3b82f6]';

  const effectiveDownloadedBytes =
    task.status === 'completed' && task.downloaded_bytes === 0 && task.total_bytes > 0
      ? task.total_bytes
      : task.downloaded_bytes;
  const downloadedText =
    effectiveDownloadedBytes > 0 ? formatBytes(effectiveDownloadedBytes) : '0 B';
  const totalText = task.total_bytes > 0 ? formatBytes(task.total_bytes) : null;
  const remainingBytes =
    (task.remaining_bytes ?? 0) > 0
      ? task.remaining_bytes ?? 0
      : task.total_bytes > effectiveDownloadedBytes
      ? task.total_bytes - effectiveDownloadedBytes
      : 0;

  const sizeSummaryText =
    task.status === 'completed' && totalText && effectiveDownloadedBytes === task.total_bytes
      ? totalText
      : totalText
      ? `${downloadedText} / ${totalText}`
      : task.status === 'downloading' || effectiveDownloadedBytes > 0
      ? `Downloaded: ${downloadedText}`
      : '0 B';

  const phaseText = task.current_phase?.trim() || getStatusLabel(task.status);
  const showSpeed =
    task.status === 'downloading' && task.speed_bytes_per_sec > 0 && Boolean(task.speed_str);
  const hasKnownEta =
    task.status === 'downloading' &&
    percentageKnown &&
    Boolean(task.eta_str) &&
    task.eta_str !== '--' &&
    task.eta_str !== 'Unknown';
  const showUnknownEta = task.status === 'downloading' && !percentageKnown;

  const pctReadout =
    task.status === 'completed'
      ? '100%'
      : isIndeterminate || (task.status === 'paused' && !percentageKnown)
      ? '--%'
      : task.status === 'downloading' && clampedPct >= 99.9 && task.total_bytes > 0
      ? 'Finishing...'
      : `${clampedPct.toFixed(1)}%`;

  return (
    <div className="w-full min-w-0 max-w-full space-y-1.5 overflow-hidden">
      {/* Progress Track */}
      <div
        className="w-full h-1.5 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)]/70 rounded-sm overflow-hidden relative"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={isIndeterminate ? undefined : Math.round(barWidthPct)}
      >
        {isIndeterminate ? (
          <div className={`h-full w-1/2 vanta-indeterminate-bar ${barToneClass}`} />
        ) : (
          <div
            className={`h-full transition-[width] duration-200 ease-out ${barToneClass}`}
            style={{ width: `${barWidthPct}%` }}
          />
        )}
      </div>

      {/* Telemetry Readout */}
      {compact ? (
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums text-[var(--vanta-muted)]">
          <span className={`truncate ${getStatusColorClass(task.status)}`}>{phaseText}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {showSpeed && (
              <span className="text-[var(--vanta-text-secondary)]">{task.speed_str}</span>
            )}
            <span>{sizeSummaryText}</span>
            <span className="font-semibold text-[var(--vanta-text)]">{pctReadout}</span>
          </div>
        </div>
      ) : (
        <div className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 overflow-hidden text-[11px] font-mono tabular-nums text-[var(--vanta-muted)]">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden">
            <span className={`min-w-0 max-w-full truncate font-medium ${getStatusColorClass(task.status)}`} title={phaseText}>{phaseText}</span>
            {task.status !== 'completed' && (
              <>
                <span aria-hidden="true" className="shrink-0">·</span>
                <span className="shrink-0 whitespace-nowrap">{sizeSummaryText}</span>
                {task.status === 'downloading' && remainingBytes > 0 && task.total_bytes > 0 && (
                  <span className="text-[var(--vanta-muted)]">({formatBytes(remainingBytes)} left)</span>
                )}
              </>
            )}
          </div>

          <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 whitespace-nowrap">
            {showSpeed && <span className="text-[var(--vanta-text-secondary)]">{task.speed_str}</span>}
            {hasKnownEta && <span>ETA {task.eta_str}</span>}
            {showUnknownEta && <span>ETA: Unknown</span>}
            {task.status === 'completed' && (task.elapsed_seconds ?? 0) > 0 && <span>in {formatDuration(task.elapsed_seconds)}</span>}
            {task.status !== 'completed' && <span className="font-semibold text-[var(--vanta-text)]">{pctReadout}</span>}
          </div>
        </div>
      )}
    </div>
  );
};
