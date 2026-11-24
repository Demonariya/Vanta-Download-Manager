import React from 'react';
import { Activity, CheckCircle2, Download, Gauge, ListChecks } from 'lucide-react';
import { DownloadTask } from '../types';
import { calculateAggregateSpeed, getActiveDownloadCount } from '../utils/queue-logic';
import { formatBytes } from '../utils/engine-parser';

interface StatusBarProps {
  tasks: DownloadTask[];
}

export const StatusBar: React.FC<StatusBarProps> = ({ tasks }) => {
  const activeCount = getActiveDownloadCount(tasks);
  const queuedCount = tasks.filter((task) => task.status === 'queued').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const downloadedBytes = tasks.reduce((total, task) => total + Math.max(0, task.downloaded_bytes || 0), 0);
  const aggregateSpeed = calculateAggregateSpeed(tasks);

  return (
    <footer role="status" aria-label="Download status" className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 text-[10px] text-[var(--vanta-muted)] sm:gap-4 sm:px-4">
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <Download className="h-3 w-3" />
        <span>{tasks.length} downloads</span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 sm:inline-flex">
        <Activity className="h-3 w-3" />
        <span>{activeCount} active</span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 md:inline-flex">
        <ListChecks className="h-3 w-3" />
        <span>{queuedCount} queued</span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 lg:inline-flex">
        <CheckCircle2 className="h-3 w-3" />
        <span>{completedCount} completed</span>
      </span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
        <Gauge className="h-3 w-3" />
        <span>Speed {aggregateSpeed.formattedSpeed}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 xl:inline-flex">
        <span>Transferred {formatBytes(downloadedBytes)}</span>
      </span>
    </footer>
  );
};
