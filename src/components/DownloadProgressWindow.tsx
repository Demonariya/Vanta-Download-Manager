import React, { useState } from 'react';
import {
  X, Pause, Play, Square, RotateCcw, FolderOpen, Activity,
  Gauge, Clock3, Network, HardDrive, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { ProgressDisplay, getStatusLabel, getStatusColorClass } from './ProgressDisplay';

interface DownloadProgressWindowProps {
  task: DownloadTask | null;
  onClose: () => void;
  onPause: (id: string) => Promise<void> | void;
  onResume: (id: string) => Promise<void> | void;
  onCancel: (id: string) => Promise<void> | void;
  onRetry: (id: string) => Promise<void> | void;
  onOpenFolder: (task: DownloadTask) => Promise<void> | void;
}

const Stat: React.FC<{ label: string; value: string; icon: React.ComponentType<{ className?: string }> }> = ({ label, value, icon: Icon }) => (
  <div className="min-w-0 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3">
    <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--vanta-muted)]">
      <Icon className="h-3.5 w-3.5 shrink-0" /> <span>{label}</span>
    </div>
    <div className="mt-2 truncate font-mono text-base font-semibold tabular-nums text-[var(--vanta-text)]" title={value}>{value}</div>
  </div>
);

export const DownloadProgressWindow: React.FC<DownloadProgressWindowProps> = ({
  task, onClose, onPause, onResume, onCancel, onRetry, onOpenFolder,
}) => {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!task) return null;

  const runAction = async (name: string, action: () => Promise<void> | void) => {
    if (busyAction) return;
    setBusyAction(name);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The requested download action failed.');
    } finally {
      setBusyAction(null);
    }
  };

  const isActive = ['inspecting', 'ready', 'connecting', 'downloading', 'pausing', 'resuming', 'processing', 'muxing', 'verifying'].includes(task.status);
  const isPaused = task.status === 'paused';
  const isFailed = task.status === 'failed';
  const isCompleted = task.status === 'completed';
  const downloaded = task.status === 'completed' && task.downloaded_bytes === 0 ? task.total_bytes : task.downloaded_bytes;
  const total = task.total_bytes > 0 ? formatBytes(task.total_bytes) : 'Unknown';
  const eta = task.status === 'downloading' && task.eta_seconds != null && task.eta_str && task.eta_str !== '--'
    ? task.eta_str
    : task.status === 'downloading' ? 'Calculating…' : '—';
  const speed = task.status === 'downloading' && task.speed_bytes_per_sec > 0 ? task.speed_str : '—';
  const elapsed = (task.elapsed_seconds ?? 0) > 0 ? formatDuration(task.elapsed_seconds ?? 0) : '—';
  const connectionCount = (task.active_connections ?? 0) > 0 ? String(task.active_connections) : 'Not reported';
  const recentLogs = (task.logs || []).slice(-4).reverse();

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="download-progress-title" className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] text-[var(--vanta-accent)]"><Activity className="h-4 w-4" /></div>
            <div className="min-w-0">
              <h2 id="download-progress-title" className="text-sm font-semibold text-[var(--vanta-text)]">Download Progress</h2>
              <p className="truncate text-[11px] text-[var(--vanta-muted)]" title={task.title}>{task.title}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`rounded-full border border-[var(--vanta-border)] px-2.5 py-1 text-[10px] font-semibold ${getStatusColorClass(task.status)}`}>{getStatusLabel(task.status)}</span>
            <button type="button" onClick={onClose} aria-label="Close progress window" className="rounded-lg p-2 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
          <section className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-[var(--vanta-text-secondary)]">Transfer progress</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-[var(--vanta-text)]">{isCompleted ? '100%' : task.percentage_known === false ? '—' : `${Math.max(0, Math.min(100, task.progress_percentage || 0)).toFixed(1)}%`}</span>
            </div>
            <ProgressDisplay task={task} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums text-[var(--vanta-muted)]">
              <span>{formatBytes(downloaded)} downloaded</span>
              <span>{total} total</span>
              <span>{(task.remaining_bytes ?? 0) > 0 ? `${formatBytes(task.remaining_bytes ?? 0)} remaining` : 'Remaining: —'}</span>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Current speed" value={speed} icon={Gauge} />
            <Stat label="Time remaining" value={eta} icon={Clock3} />
            <Stat label="Elapsed time" value={elapsed} icon={Clock3} />
            <Stat label="Connections" value={connectionCount} icon={Network} />
          </section>

          <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--vanta-border)] p-3">
              <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--vanta-muted)]"><HardDrive className="h-3.5 w-3.5" /> Destination</div>
              <div className="mt-1 break-all text-xs text-[var(--vanta-text)]">{task.output_path || 'Output path not reported'}</div>
            </div>
            <div className="rounded-xl border border-[var(--vanta-border)] p-3">
              <div className="text-[11px] font-medium text-[var(--vanta-muted)]">Engine telemetry</div>
              <div className="mt-1 space-y-1 text-xs text-[var(--vanta-text)]">
                <div className="flex justify-between gap-2"><span className="text-[var(--vanta-muted)]">Engine</span><span>{task.engine}</span></div>
                <div className="flex justify-between gap-2"><span className="text-[var(--vanta-muted)]">Fragments</span><span>Not exposed by current engine telemetry</span></div>
                <div className="flex justify-between gap-2"><span className="text-[var(--vanta-muted)]">Phase</span><span className="max-w-[65%] truncate text-right" title={task.current_phase}>{task.current_phase || getStatusLabel(task.status)}</span></div>
              </div>
            </div>
          </section>

          {(task.error_message || actionError) && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-700 dark:text-[#f85149]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{actionError || task.error_message}</span>
            </div>
          )}

          {isCompleted && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-[#3fb950]"><CheckCircle2 className="h-4 w-4" /> Download completed successfully.</div>
          )}

          <section className="rounded-xl border border-[var(--vanta-border)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-[var(--vanta-text)]">Recent engine activity</h3><span className="text-[10px] text-[var(--vanta-muted)]">{recentLogs.length} latest entries</span></div>
            {recentLogs.length ? (
              <div className="max-h-32 space-y-1.5 overflow-y-auto">
                {recentLogs.map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-[10px]">
                    <span className="font-mono text-[var(--vanta-muted)]">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span className={`min-w-0 break-words ${entry.level === 'error' ? 'text-red-600 dark:text-[#f85149]' : entry.level === 'warn' ? 'text-amber-700 dark:text-[#d29922]' : 'text-[var(--vanta-text-secondary)]'}`}>{entry.message}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-[11px] text-[var(--vanta-muted)]">No engine log entries have been reported yet.</p>}
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-4 py-3 sm:px-5">
          <button type="button" onClick={() => void runAction('folder', () => onOpenFolder(task))} disabled={Boolean(busyAction) || !task.output_path} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--vanta-border)] px-3 py-2 text-xs font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" /> Open folder</button>
          <div className="flex flex-wrap items-center gap-2">
            {isActive && (
              <>
                <button type="button" onClick={() => void runAction('pause', () => onPause(task.id))} disabled={Boolean(busyAction) || task.status === 'pausing'} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--vanta-border)] px-3 py-2 text-xs font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40"><Pause className="h-3.5 w-3.5" /> Pause</button>
                <button type="button" onClick={() => void runAction('cancel', () => onCancel(task.id))} disabled={Boolean(busyAction)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-500/5 disabled:opacity-40"><Square className="h-3.5 w-3.5" /> Stop</button>
              </>
            )}
            {isPaused && <button type="button" onClick={() => void runAction('resume', () => onResume(task.id))} disabled={Boolean(busyAction)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--vanta-accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"><Play className="h-3.5 w-3.5" /> Resume</button>}
            {isFailed && <button type="button" onClick={() => void runAction('retry', () => onRetry(task.id))} disabled={Boolean(busyAction)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--vanta-accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" /> Retry</button>}
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-medium text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]">Close</button>
          </div>
        </footer>
      </section>
    </div>
  );
};
