import React, { useState, useEffect } from 'react';
import {
  X,
  FolderOpen,
  FileCheck2,
  Edit3,
  Check,
  Copy,
  AlertCircle,
  Terminal,
  RefreshCw,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { ProgressDisplay } from './ProgressDisplay';
import { MediaThumbnail } from './MediaThumbnail';
import { api } from '../services/api';

interface DownloadDetailsDrawerProps {
  task: DownloadTask | null;
  onClose: () => void;
  onRetryTask: (id: string) => void;
}

export const DownloadDetailsDrawer: React.FC<DownloadDetailsDrawerProps> = ({
  task,
  onClose,
  onRetryTask,
}) => {
  const [renameMode, setRenameMode] = useState(false);
  const [filenameDraft, setFilenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (!task) return;
    setRenameMode(false);
    const basename = (task.output_path || '').split(/[\\/]/).pop() || task.custom_filename || task.title;
    setFilenameDraft(basename);
    setActionError(null);
    setActionNotice(null);
  }, [task?.id]);

  if (!task) return null;

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!filenameDraft.trim()) return;
    setRenameBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await api.renameTaskFile(task.id, filenameDraft.trim());
      setRenameMode(false);
      setActionNotice('Output file renamed.');
    } catch (err: any) {
      setActionError(err?.message || 'Failed to rename output file.');
    } finally {
      setRenameBusy(false);
    }
  };

  const handleCopyUrl = () => {
    navigator.clipboard?.writeText(task.url).catch(() => {});
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1800);
  };

  const effectiveDownloadedBytes =
    task.status === 'completed' && task.downloaded_bytes === 0 && task.total_bytes > 0
      ? task.total_bytes
      : task.downloaded_bytes;

  return (
    <aside
      className="fixed top-8 bottom-0 right-0 z-30 w-full sm:w-[400px] lg:static lg:z-auto lg:w-[390px] xl:w-[420px] lg:shrink-0 border-l border-[var(--vanta-border)] bg-[var(--vanta-surface)] shadow-2xl lg:shadow-none flex flex-col min-h-0"
      aria-label="Download Inspector"
    >
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--vanta-muted)]">
            Transfer Inspector
          </p>
          <h2 className="text-sm font-semibold text-[var(--vanta-text)] truncate">{task.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close transfer inspector"
          className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Inspector Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
        {/* Media Preview & Genuine Metadata Summary */}
        {(() => {
          const isAudioTask = task.is_audio_only || task.engine === 'spotdl';
          const metaParts: string[] = [];
          if (task.uploader) metaParts.push(task.uploader);
          if (task.album) metaParts.push(task.album);
          if (task.duration_string) metaParts.push(task.duration_string);
          if (task.resolution_label) metaParts.push(task.resolution_label);
          if (task.ext) metaParts.push(task.ext.toUpperCase());

          return (
            <div className="p-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]">
              <div className={isAudioTask ? 'flex items-start gap-3' : 'space-y-2.5'}>
                <MediaThumbnail
                  src={task.thumbnail}
                  title={task.title}
                  isAudio={isAudioTask}
                  ext={task.ext}
                  size="lg"
                  aspect={isAudioTask ? 'square' : 'video'}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="text-xs sm:text-sm font-semibold text-[var(--vanta-text)] leading-snug break-words">
                    {task.title}
                  </h3>
                  {metaParts.length > 0 && (
                    <p className="text-[11px] font-mono tabular-nums text-[var(--vanta-muted)] break-words">
                      {metaParts.join(' · ')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Progress Overview */}
        <div className="space-y-2.5">
          <ProgressDisplay task={task} />
          {task.error_message && (
            <div className="p-2.5 rounded-lg border border-red-500/35 bg-red-500/10 text-red-600 dark:text-[#f85149] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="break-words">{task.error_message}</p>
                {task.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => onRetryTask(task.id)}
                    className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-[11px] font-medium inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Retry Download</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions & File Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!task.output_path || task.status !== 'completed'}
            onClick={() => api.openTaskFile(task).catch((e) => setActionError(e.message))}
            className="px-3 py-1.5 rounded-lg bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] disabled:opacity-40 text-white font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <FileCheck2 className="w-3.5 h-3.5" />
            <span>Open File</span>
          </button>
          <button
            type="button"
            disabled={!task.output_path}
            onClick={() => api.openTaskFolder(task).catch((e) => setActionError(e.message))}
            className="px-3 py-1.5 rounded-lg bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40 border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Open Folder</span>
          </button>
          {task.status === 'completed' && task.output_path && (
            <button
              type="button"
              onClick={() => setRenameMode((v) => !v)}
              className="px-3 py-1.5 rounded-lg bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Rename File</span>
            </button>
          )}
        </div>

        {renameMode && (
          <form onSubmit={handleRenameSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={filenameDraft}
              onChange={(e) => setFilenameDraft(e.target.value)}
              placeholder="New filename.ext"
              className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border-strong)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg px-2.5 py-1.5 font-mono text-xs text-[var(--vanta-text)]"
            />
            <button
              type="submit"
              disabled={renameBusy || !filenameDraft.trim()}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-medium whitespace-nowrap shrink-0"
            >
              {renameBusy ? 'Saving...' : 'Apply'}
            </button>
          </form>
        )}

        {actionError && (
          <div className="p-2.5 rounded-lg border border-red-500/35 bg-red-500/10 text-red-600 dark:text-[#f85149] text-[11px] break-words">
            {actionError}
          </div>
        )}
        {actionNotice && (
          <div className="p-2.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-[#3fb950] text-[11px] break-all font-mono">
            {actionNotice}
          </div>
        )}

        {/* Telemetry & Media Specifications */}
        <div className="border-t border-[var(--vanta-border)] pt-4 space-y-2.5">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-[var(--vanta-muted)]">
            Transfer & Media Telemetry
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono tabular-nums text-[11px]">
            <div>
              <dt className="text-[var(--vanta-muted)]">Engine</dt>
              <dd className="text-[var(--vanta-text)] font-medium">{task.engine}</dd>
            </div>
            <div>
              <dt className="text-[var(--vanta-muted)]">Format / Ext</dt>
              <dd className="text-[var(--vanta-text)] font-medium">
                {task.ext.toUpperCase()} {task.resolution_label ? `(${task.resolution_label})` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--vanta-muted)]">Downloaded / Total</dt>
              <dd className="text-[var(--vanta-text)]">
                {formatBytes(effectiveDownloadedBytes)} / {task.total_bytes > 0 ? formatBytes(task.total_bytes) : '--'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--vanta-muted)]">Average Speed</dt>
              <dd className="text-[var(--vanta-text)]">
                {task.avg_speed_bytes_per_sec && task.avg_speed_bytes_per_sec > 0
                  ? `${formatBytes(task.avg_speed_bytes_per_sec)}/s`
                  : task.speed_str || '0 B/s'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--vanta-muted)]">Elapsed Time</dt>
              <dd className="text-[var(--vanta-text)]">
                {task.elapsed_seconds ? formatDuration(task.elapsed_seconds) : '--'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--vanta-muted)]">Connections / Retries</dt>
              <dd className="text-[var(--vanta-text)]">
                {task.active_connections ?? 0} conn · {task.retries}/{task.max_retries} retries
              </dd>
            </div>
            {(task.video_codec || task.audio_codec || task.verified_audio_info) && (
              <div className="col-span-2">
                <dt className="text-[var(--vanta-muted)]">Verified Codecs</dt>
                <dd className="text-[var(--vanta-text)] break-words">
                  {task.verified_audio_info ||
                    [
                      task.video_codec ? `Video: ${task.video_codec}` : null,
                      task.audio_codec ? `Audio: ${task.audio_codec}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                </dd>
              </div>
            )}
            {(task.tracks_requested ?? 0) > 0 && (
              <div className="col-span-2">
                <dt className="text-[var(--vanta-muted)]">Playlist / Selection Progress</dt>
                <dd className="text-[var(--vanta-text)]">
                  {task.tracks_completed ?? 0} of {task.tracks_requested} completed
                  {(task.tracks_failed ?? 0) > 0 ? ` · ${task.tracks_failed} failed` : ''}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Source & Destination Paths */}
        <div className="border-t border-[var(--vanta-border)] pt-4 space-y-3">

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[var(--vanta-muted)]">Source URL</span>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="text-[11px] text-[var(--vanta-accent)] hover:underline inline-flex items-center gap-1"
              >
                {copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedUrl ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="p-2 rounded-lg bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] font-mono text-[11px] text-[var(--vanta-text-secondary)] break-all">
              {task.url}
            </p>
          </div>

          {task.output_path && (
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-[var(--vanta-muted)] block">
                Destination Path
              </span>
              <p className="p-2 rounded-lg bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] font-mono text-[11px] text-[var(--vanta-text-secondary)] break-all">
                {task.output_path}
              </p>
            </div>
          )}
        </div>

        {/* Sanitized Task Event Log */}
        <div className="border-t border-[var(--vanta-border)] pt-4 space-y-2">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-[var(--vanta-muted)] flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5" />
            <span>Task Event Log</span>
          </h3>
          {task.logs && task.logs.length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2.5 space-y-1 font-mono text-[10px]">
              {task.logs.slice(-40).map((entry, idx) => (
                <div key={idx} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-[var(--vanta-muted)] shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span
                    className={
                      entry.level === 'error'
                        ? 'text-red-600 dark:text-[#f85149]'
                        : entry.level === 'warn'
                        ? 'text-amber-600 dark:text-[#e3b341]'
                        : 'text-[var(--vanta-text-secondary)]'
                    }
                  >
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--vanta-muted)]">No log entries recorded for this transfer yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
};
