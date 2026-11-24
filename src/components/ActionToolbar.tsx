import React from 'react';
import { Activity, Check, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { DownloadTask } from '../types';

interface ActionToolbarProps {
  selectedTask: DownloadTask | null;
  activeCount: number;
  pausedCount: number;
  onPauseSelected: () => void;
  onResumeSelected: () => void;
  onRetrySelected: () => void;
  onDeleteSelected: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
}

interface ToolbarButtonProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  label, icon: Icon, onClick, disabled = false, primary = false, danger = false,
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={
      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ' +
      (primary
        ? 'border-[var(--vanta-accent)] bg-[var(--vanta-accent)] text-white hover:bg-[var(--vanta-accent-hover)]'
        : danger
          ? 'border-red-500/25 text-red-500 hover:bg-red-500/10'
          : 'border-[var(--vanta-border)] bg-[var(--vanta-surface)] text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]')
    }
  >
    <Icon className="h-3.5 w-3.5" />
    <span>{label}</span>
  </button>
);

export const ActionToolbar: React.FC<ActionToolbarProps> = ({
  selectedTask, activeCount, pausedCount, onPauseSelected, onResumeSelected,
  onRetrySelected, onDeleteSelected, onPauseAll, onResumeAll,
}) => {
  const canPause = Boolean(selectedTask && [
    'connecting', 'downloading', 'resuming', 'inspecting', 'processing', 'muxing', 'verifying', 'queued',
  ].includes(selectedTask.status));
  const canResume = selectedTask?.status === 'paused';
  const canRetry = selectedTask?.status === 'failed' || selectedTask?.status === 'cancelled';

  return (
    <div className="flex min-h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-1.5 sm:px-4">
      <ToolbarButton label="Resume" icon={Play} onClick={onResumeSelected} disabled={!canResume} />
      <ToolbarButton label="Pause" icon={Pause} onClick={onPauseSelected} disabled={!canPause} />
      <ToolbarButton label="Retry" icon={RotateCcw} onClick={onRetrySelected} disabled={!canRetry} />
      <div className="mx-1 h-5 shrink-0 border-l border-[var(--vanta-border-strong)]" />
      <ToolbarButton label="Pause All" icon={Activity} onClick={onPauseAll} disabled={activeCount === 0} />
      <ToolbarButton label="Resume All" icon={Check} onClick={onResumeAll} disabled={pausedCount === 0} />
      <div className="mx-1 h-5 shrink-0 border-l border-[var(--vanta-border-strong)]" />
      <ToolbarButton label="Delete Selected" icon={Trash2} onClick={onDeleteSelected} disabled={!selectedTask} danger />
      <span className="ml-auto hidden max-w-[34%] truncate text-[10px] text-[var(--vanta-muted)] xl:block" title={selectedTask?.title || 'No download selected'}>
        {selectedTask?.title || 'No download selected'}
      </span>
    </div>
  );
};
