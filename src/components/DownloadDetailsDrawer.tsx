import React, { useEffect, useMemo, useState } from 'react';
import {
  X, FolderOpen, FileCheck2, Edit3, Copy, AlertCircle, RefreshCw,
  Info, ListVideo, Captions, Music2, Download, ClipboardList, FileDown,
  Search, FileText, ArrowLeftRight, Film, Gauge,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { ProgressDisplay, getStatusLabel, getStatusColorClass } from './ProgressDisplay';
import { MediaThumbnail } from './MediaThumbnail';
import { api } from '../services/api';
import { DownloadPropertiesModal } from './DownloadPropertiesModal';

interface DownloadDetailsDrawerProps {
  task: DownloadTask | null;
  onClose: () => void;
  onRetryTask: (id: string) => void;
  onOpenProgress?: () => void;
}

type InspectorTab = 'overview' | 'file' | 'transfer' | 'media' | 'playlist' | 'logs';
type LogFilter = 'all' | 'info' | 'warn' | 'error';

const EMPTY_LOGS: NonNullable<DownloadTask['logs']> = [];

const valueOrDash = (value?: string | number | null) =>
  value === undefined || value === null || value === '' ? '—' : String(value);

const DetailValue: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono = false }) => (
  <div className="min-w-0 py-2.5">
    <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--vanta-muted)]">{label}</div>
    <div className={`min-w-0 break-words text-xs font-medium text-[var(--vanta-text)] [overflow-wrap:anywhere] ${mono ? 'font-mono' : ''}`}>{value || '—'}</div>
  </div>
);

export const DownloadDetailsDrawer: React.FC<DownloadDetailsDrawerProps> = ({ task, onClose, onRetryTask, onOpenProgress }) => {
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [renameMode, setRenameMode] = useState(false);
  const [filenameDraft, setFilenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [logSearch, setLogSearch] = useState('');
  const [logsNotice, setLogsNotice] = useState<string | null>(null);
  const [showProperties, setShowProperties] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTab('overview');
    setRenameMode(false);
    setFilenameDraft((task.output_path || '').split(/[\\/]/).pop() || task.custom_filename || task.title);
    setActionError(null);
    setActionNotice(null);
    setLogFilter('all');
    setLogSearch('');
    setLogsNotice(null);
    setShowProperties(false);
  }, [task?.id]);

  const taskLogs = task?.logs || EMPTY_LOGS;
  const filteredLogs = useMemo(() => taskLogs.filter((entry) => {
    const matchesLevel = logFilter === 'all' || entry.level === logFilter;
    const query = logSearch.trim().toLowerCase();
    return matchesLevel && (!query || entry.message.toLowerCase().includes(query) || entry.timestamp.toLowerCase().includes(query));
  }), [taskLogs, logFilter, logSearch]);

  if (!task) return null;

  const audioTask = task.is_audio_only || task.engine === 'spotdl';
  const lyrics = task.lyrics_lrc_content?.trim() || '';
  const effectiveBytes = task.status === 'completed'
    ? (task.downloaded_bytes || task.total_bytes)
    : task.downloaded_bytes;
  const displayedTotalSize = task.status === 'completed' ? effectiveBytes : task.total_bytes;
  const handleRename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!filenameDraft.trim()) return;
    setRenameBusy(true);
    setActionError(null);
    try {
      await api.renameTaskFile(task.id, filenameDraft.trim());
      setRenameMode(false);
      setActionNotice('Output file renamed.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to rename output file.');
    } finally {
      setRenameBusy(false);
    }
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(label);
      window.setTimeout(() => setCopiedValue(null), 1500);
    } catch {
      setActionError(`Could not copy ${label.toLowerCase()}.`);
    }
  };

  const downloadTextFile = (text: string, filename: string, mime = 'text/plain;charset=utf-8') => {
    const objectUrl = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const exportLyrics = () => {
    if (!lyrics) return;
    downloadTextFile(lyrics, `${(task.title || 'track').replace(/[\\/:*?"<>|]/g, '_')}.lrc`);
  };

  const formatLogText = (entries: typeof taskLogs) =>
    entries.map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(formatLogText(filteredLogs));
      setLogsNotice(`Copied ${filteredLogs.length} log entries.`);
    } catch {
      setLogsNotice('Could not copy logs to the clipboard.');
    }
  };

  const exportLogs = () => {
    downloadTextFile(
      formatLogText(taskLogs),
      `${(task.title || 'download').replace(/[\\/:*?"<>|]/g, '_')}-logs.txt`,
    );
  };

  const tabs: Array<{ id: InspectorTab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }> = [
    { id: 'overview', label: 'Overview', icon: Info },
    { id: 'file', label: 'File', icon: FileText },
    { id: 'transfer', label: 'Transfer', icon: ArrowLeftRight },
    { id: 'media', label: 'Media', icon: Film },
    { id: 'playlist', label: 'Playlist', icon: ListVideo, count: task.selected_items?.length },
    { id: 'logs', label: 'Logs', icon: ClipboardList, count: taskLogs.length },
  ];

  const statusClass = getStatusColorClass(task.status);
  const progressPercent = task.status === 'completed'
    ? '100%'
    : task.percentage_known === false
      ? '—'
      : `${Math.min(100, Math.max(0, task.progress_percentage || 0)).toFixed(1)}%`;

  return (
    <>
      <aside className="flex h-[clamp(310px,44vh,520px)] w-full shrink-0 flex-col overflow-hidden border-t-2 border-[var(--vanta-accent)]/60 bg-[var(--vanta-surface)] shadow-[0_-12px_32px_rgba(0,0,0,0.12)]" aria-label="Download details inspector">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--vanta-border)] px-3 py-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <MediaThumbnail src={task.thumbnail} title={task.title} isAudio={audioTask} ext={task.ext} size={audioTask ? 'lg' : 'md'} aspect={audioTask ? 'square' : 'video'} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[var(--vanta-text)] sm:text-base" title={task.title}>{task.title}</h2>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--vanta-muted)]">
                <span className="truncate">{task.uploader || (() => { try { return new URL(task.url).hostname; } catch { return task.engine; } })()}</span>
                {task.album && <><span>·</span><span className="truncate">Album: {task.album}</span></>}
                {task.duration_string && <><span>·</span><span>{task.duration_string}</span></>}
                <span className={`font-semibold ${statusClass}`}>· {getStatusLabel(task.status)}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => api.openTaskFolder(task).catch((error) => setActionError(error.message))} disabled={!task.output_path} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-2.5 text-[11px] font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40">
              <FolderOpen className="h-3.5 w-3.5" /><span className="hidden sm:inline">Open Folder</span>
            </button>
            <button type="button" onClick={() => onOpenProgress?.()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-2.5 text-[11px] font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
              <Gauge className="h-3.5 w-3.5" /><span className="hidden sm:inline">Progress Window</span>
            </button>
            <button type="button" onClick={() => setShowProperties(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-2.5 text-[11px] font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
              <Info className="h-3.5 w-3.5" /><span className="hidden sm:inline">Properties</span>
            </button>
            <button type="button" onClick={onClose} aria-label="Close details inspector" className="rounded-md p-2 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--vanta-border)] px-2 py-1.5 sm:px-4" aria-label="Download inspector sections">
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id}
              className={`relative inline-flex h-9 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-medium transition-colors ${tab === id ? 'border-[var(--vanta-accent)] text-[var(--vanta-text)]' : 'border-transparent text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'}`}>
              <Icon className="h-4 w-4" />{label}
              {count !== undefined && count > 0 && <span className="rounded-full bg-[var(--vanta-surface-2)] px-1.5 py-0.5 text-[9px] tabular-nums">{count}</span>}
            </button>
          ))}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          {tab === 'overview' && (
            <div className="min-w-0">
              <section className="grid grid-cols-2 gap-x-5 gap-y-3 border-b border-[var(--vanta-border)] px-4 py-4 sm:grid-cols-4 sm:px-5">
                <div className="col-span-2 min-w-0 sm:col-span-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-[var(--vanta-text)]">Download progress</span>
                    <strong className="font-mono text-sm tabular-nums text-[var(--vanta-text)]">{progressPercent}</strong>
                  </div>
                  <ProgressDisplay task={task} />
                </div>
                <DetailValue label="Downloaded" value={formatBytes(effectiveBytes)} />
                <DetailValue label={task.status === 'completed' ? 'Final size' : 'Total size'} value={displayedTotalSize > 0 ? (task.status === 'completed' ? formatBytes(displayedTotalSize) : `≈ ${formatBytes(displayedTotalSize)}`) : 'Not reported'} />
                <DetailValue label="Speed" value={task.status === 'completed' ? '—' : valueOrDash(task.speed_str)} />
                <DetailValue label={task.status === 'completed' ? 'Elapsed' : 'ETA'} value={task.status === 'completed' ? ((task.elapsed_seconds ?? 0) > 0 ? formatDuration(task.elapsed_seconds) : '—') : valueOrDash(task.eta_str)} />
              </section>
              <section className="grid grid-cols-1 divide-y divide-[var(--vanta-border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <div className="min-w-0 px-4 py-3 sm:px-5">
                  <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--vanta-muted)]">Source URL</h3><button type="button" onClick={() => void copyText(task.url, 'Source URL')} className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--vanta-accent)]"><Copy className="h-3 w-3" />{copiedValue === 'Source URL' ? 'Copied' : 'Copy'}</button></div>
                  <p className="break-all font-mono text-[11px] text-[var(--vanta-text-secondary)] [overflow-wrap:anywhere]">{task.url}</p>
                </div>
                <div className="min-w-0 px-4 py-3 sm:px-5">
                  <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--vanta-muted)]">Output file</h3>{task.output_path && <button type="button" onClick={() => void copyText(task.output_path, 'Output path')} className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--vanta-accent)]"><Copy className="h-3 w-3" />{copiedValue === 'Output path' ? 'Copied' : 'Copy path'}</button>}</div>
                  <p className="break-all font-mono text-[11px] text-[var(--vanta-text-secondary)] [overflow-wrap:anywhere]">{task.output_path || 'Output path not reported'}</p>
                </div>
              </section>
              {task.error_message && <div role="alert" className="flex items-start gap-2 border-t border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-[#f85149]"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-words">{task.error_message}</span></div>}
            </div>
          )}

          {tab === 'file' && (
            <div className="grid grid-cols-1 divide-y divide-[var(--vanta-border)] px-4 sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:px-5">
              <div className="min-w-0 sm:pr-5">
                <DetailValue label="File name" value={(task.output_path || '').split(/[\\/]/).pop() || task.custom_filename || task.title} />
                <DetailValue label="Output directory" value={task.output_path ? task.output_path.replace(/[\\/][^\\/]*$/, '') : 'Not reported'} mono />
                <DetailValue label="Full output path" value={task.output_path} mono />
                <DetailValue label="Container / extension" value={(task.ext || '—').toUpperCase()} />
                <DetailValue label="Status" value={<span className={statusClass}>{getStatusLabel(task.status)}</span>} />
              </div>
              <div className="min-w-0 sm:pl-5">
                <DetailValue label="Source host" value={(() => { try { return new URL(task.url).hostname; } catch { return 'Unrecognized URL'; } })()} />
                <DetailValue label="Uploader / artist" value={task.uploader || task.album} />
                <DetailValue label="Content type" value={task.content_type || (audioTask ? 'Audio' : 'Video')} />
                <DetailValue label="Created" value={task.created_at ? new Date(task.created_at).toLocaleString() : '—'} />
                <DetailValue label="Started" value={task.started_at ? new Date(task.started_at).toLocaleString() : 'Not started'} />
                <DetailValue label="Completed" value={task.completed_at ? new Date(task.completed_at).toLocaleString() : 'Not completed'} />
                <div className="border-t border-[var(--vanta-border)] py-3">
                  <div className="mb-2 flex flex-wrap gap-2">
                    <button type="button" disabled={!task.output_path || task.status !== 'completed'} onClick={() => api.openTaskFile(task).catch((error) => setActionError(error.message))} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--vanta-accent)] px-3 py-2 text-[11px] font-medium text-white disabled:opacity-40"><FileCheck2 className="h-3.5 w-3.5" />Open File</button>
                    <button type="button" disabled={!task.output_path} onClick={() => api.openTaskFolder(task).catch((error) => setActionError(error.message))} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-3 py-2 text-[11px] text-[var(--vanta-text)] disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" />Open Folder</button>
                    {task.status === 'failed' && <button type="button" onClick={() => onRetryTask(task.id)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-3 py-2 text-[11px] text-[var(--vanta-text)]"><RefreshCw className="h-3.5 w-3.5" />Retry</button>}
                    {task.status === 'completed' && task.output_path && <button type="button" onClick={() => setRenameMode((value) => !value)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-3 py-2 text-[11px] text-[var(--vanta-text)]"><Edit3 className="h-3.5 w-3.5" />Rename</button>}
                  </div>
                  {renameMode && <form onSubmit={handleRename} className="flex min-w-0 gap-2"><input value={filenameDraft} onChange={(event) => setFilenameDraft(event.target.value)} className="min-w-0 flex-1 rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-bg)] px-2.5 py-2 text-xs text-[var(--vanta-text)]" aria-label="New filename" /><button type="submit" disabled={renameBusy || !filenameDraft.trim()} className="rounded-md bg-[var(--vanta-accent)] px-3 py-2 text-xs text-white disabled:opacity-40">{renameBusy ? 'Saving…' : 'Save'}</button></form>}
                </div>
              </div>
            </div>
          )}

          {tab === 'transfer' && (
            <div className="min-w-0">
              <section className="grid grid-cols-2 divide-x divide-y divide-[var(--vanta-border)] sm:grid-cols-4 sm:divide-y-0">
                <div className="px-4 py-3 sm:px-5"><DetailValue label="Download engine" value={task.engine} /><DetailValue label="Current phase" value={task.current_phase || getStatusLabel(task.status)} /></div>
                <div className="px-4 py-3 sm:px-5"><DetailValue label="Active connections" value={task.active_connections != null && task.active_connections > 0 ? task.active_connections : 'Not reported'} /><DetailValue label="Retries" value={`${task.retries} / ${task.max_retries}`} /></div>
                <div className="px-4 py-3 sm:px-5"><DetailValue label="Current speed" value={task.speed_str} /><DetailValue label="Average speed" value={(task.avg_speed_bytes_per_sec ?? 0) > 0 ? `${formatBytes(task.avg_speed_bytes_per_sec ?? 0)}/s` : 'Not reported'} /></div>
                <div className="px-4 py-3 sm:px-5"><DetailValue label="Elapsed time" value={(task.elapsed_seconds ?? 0) > 0 ? formatDuration(task.elapsed_seconds) : 'Not reported'} /><DetailValue label="ETA" value={task.eta_str} /></div>
              </section>
              <div className="border-t border-[var(--vanta-border)] px-4 py-3 sm:px-5">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--vanta-muted)]">Engine telemetry</h3>
                <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <DetailValue label="Fragment concurrency" value="Not exposed by current task telemetry" />
                  <DetailValue label="Per-connection state" value="Not exposed by current task telemetry" />
                  <DetailValue label="Last progress update" value={task.last_progress_at || 'Not reported'} />
                  <DetailValue label="Queue" value={task.queue_id || 'main'} />
                  <DetailValue label="Priority" value={task.priority} />
                </div>
              </div>
              {task.error_message && <div role="alert" className="border-t border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-[#f85149]"><AlertCircle className="mr-2 inline h-4 w-4" />{task.error_message}</div>}
            </div>
          )}

          {tab === 'media' && (
            <div className="min-w-0">
              <section className="grid grid-cols-2 divide-x divide-y divide-[var(--vanta-border)] sm:grid-cols-4 sm:divide-y-0">
                <div className="px-4 py-2 sm:px-5"><DetailValue label="Media type" value={audioTask ? 'Audio' : 'Video'} /><DetailValue label="Container" value={(task.ext || '—').toUpperCase()} /><DetailValue label="Duration" value={task.duration_string} /></div>
                <div className="px-4 py-2 sm:px-5"><DetailValue label="Format ID" value={task.format_id} /><DetailValue label="Format note" value={task.format_note} /><DetailValue label="Resolution" value={task.resolution_label} /></div>
                <div className="px-4 py-2 sm:px-5"><DetailValue label="Video codec" value={task.video_codec} /><DetailValue label="Audio codec" value={task.audio_codec || task.verified_audio_info} /><DetailValue label="Audio format" value={task.audio_format} /></div>
                <div className="px-4 py-2 sm:px-5"><DetailValue label="Audio bitrate" value={task.audio_bitrate} /><DetailValue label="Sample rate" value={task.audio_sample_rate ? `${task.audio_sample_rate} Hz` : '—'} /><DetailValue label="Bit depth / channels" value={task.audio_bit_depth ? `${task.audio_bit_depth}-bit · ${task.audio_channels ?? '—'} ch` : (task.audio_channels ? `${task.audio_channels} ch` : '—')} /></div>
              </section>
              <section className="grid grid-cols-1 divide-y divide-[var(--vanta-border)] border-t border-[var(--vanta-border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <div className="px-4 py-3 sm:px-5">
                  <div className="mb-2 flex items-center gap-2"><Captions className="h-4 w-4 text-[var(--vanta-muted)]" /><h3 className="text-xs font-semibold text-[var(--vanta-text)]">Subtitles</h3></div>
                  {task.subtitle_languages?.length ? <div className="flex flex-wrap gap-1.5">{task.subtitle_languages.map((language) => <span key={language} className="border-b border-[var(--vanta-border)] px-2 py-1 text-[11px] text-[var(--vanta-text-secondary)]">{language}</span>)}</div> : <p className="text-[11px] text-[var(--vanta-muted)]">No subtitle languages selected.</p>}
                  <p className="mt-2 text-[10px] text-[var(--vanta-muted)]">{task.write_auto_subtitles ? 'Automatic subtitles enabled.' : 'Automatic subtitles not enabled.'} Embedded subtitles remain selectable in compatible players; they are not burned into the video.</p>
                </div>
                <div className="px-4 py-3 sm:px-5">
                  <div className="mb-2 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Music2 className="h-4 w-4 text-[var(--vanta-muted)]" /><h3 className="text-xs font-semibold text-[var(--vanta-text)]">Lyrics</h3></div><button type="button" disabled={!lyrics} onClick={exportLyrics} className="inline-flex items-center gap-1 text-[10px] text-[var(--vanta-accent)] disabled:opacity-40"><Download className="h-3 w-3" />Export LRC</button></div>
                  {lyrics ? <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-[var(--vanta-text-secondary)]">{lyrics}</pre> : <p className="text-[11px] text-[var(--vanta-muted)]">No synchronized lyrics attached to this task.</p>}
                </div>
              </section>
            </div>
          )}

          {tab === 'playlist' && (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--vanta-border)] px-4 py-3 sm:px-5">
                <div><h3 className="text-xs font-semibold text-[var(--vanta-text)]">Playlist items</h3><p className="mt-1 text-[10px] text-[var(--vanta-muted)]">{task.playlist_mode === 'playlist' ? 'Playlist download' : 'Single item download'}</p></div>
                <span className="font-mono text-xs tabular-nums text-[var(--vanta-text-secondary)]">{task.tracks_completed ?? 0} / {task.tracks_requested ?? task.selected_items?.length ?? 1} completed</span>
              </div>
              {task.selected_items?.length ? <div className="divide-y divide-[var(--vanta-border)]">{task.selected_items.map((item, index) => <div key={`${index}-${item}`} className="flex min-w-0 items-start gap-3 px-4 py-2.5 text-xs sm:px-5"><span className="w-7 shrink-0 font-mono text-[10px] tabular-nums text-[var(--vanta-muted)]">{String(index + 1).padStart(2, '0')}</span><span className="min-w-0 break-words text-[var(--vanta-text-secondary)] [overflow-wrap:anywhere]">{item}</span></div>)}</div> : <div className="px-4 py-8 text-center text-xs text-[var(--vanta-muted)]">No playlist item list was stored for this task.</div>}
              {(task.tracks_failed ?? 0) > 0 && <div className="border-t border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-[#f85149]">{task.tracks_failed} track(s) failed.</div>}
            </div>
          )}

          {tab === 'logs' && (
            <div className="flex h-full min-h-[190px] min-w-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--vanta-border)] px-4 py-2.5 sm:px-5">
                <div><h3 className="text-xs font-semibold text-[var(--vanta-text)]">Activity log</h3><p className="mt-0.5 text-[10px] text-[var(--vanta-muted)]">{filteredLogs.length} of {taskLogs.length} events</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={!filteredLogs.length} onClick={copyLogs} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-2.5 py-1.5 text-[10px] text-[var(--vanta-text-secondary)] disabled:opacity-40"><Copy className="h-3 w-3" />Copy visible</button>
                  <button type="button" disabled={!taskLogs.length} onClick={exportLogs} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-border)] px-2.5 py-1.5 text-[10px] text-[var(--vanta-text-secondary)] disabled:opacity-40"><FileDown className="h-3 w-3" />Export all</button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--vanta-border)] px-4 py-2 sm:px-5">
                <div className="flex flex-wrap items-center gap-1">
                  {(['all', 'info', 'warn', 'error'] as const).map((filter) => (
                    <button key={filter} type="button" onClick={() => setLogFilter(filter)} aria-pressed={logFilter === filter} className={`rounded px-2.5 py-1 text-[10px] font-semibold capitalize ${logFilter === filter ? 'bg-[var(--vanta-accent)] text-white' : 'text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]'}`}>
                      {filter === 'all' ? `All · ${taskLogs.length}` : `${filter} · ${taskLogs.filter((entry) => entry.level === filter).length}`}
                    </button>
                  ))}
                </div>
                <label className="ml-auto flex min-w-[150px] flex-1 items-center gap-2 border-b border-[var(--vanta-border)] px-2 py-1 sm:max-w-[240px]">
                  <Search className="h-3.5 w-3.5 shrink-0 text-[var(--vanta-muted)]" />
                  <input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Search log messages…" className="min-w-0 flex-1 bg-transparent text-[10px] text-[var(--vanta-text)] outline-none placeholder:text-[var(--vanta-muted)]" aria-label="Search activity logs" />
                  {logSearch && <button type="button" onClick={() => setLogSearch('')} className="text-[10px] text-[var(--vanta-muted)]">Clear</button>}
                </label>
                {logsNotice && <span role="status" className="w-full text-right text-[10px] text-[var(--vanta-muted)]">{logsNotice}</span>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-[var(--vanta-bg)]">
                {filteredLogs.length ? <div className="divide-y divide-[var(--vanta-border)]">
                  {[...filteredLogs].reverse().map((entry, index) => (
                    <div key={entry.timestamp + '-' + index} className="grid min-w-0 grid-cols-[minmax(0,125px)_minmax(0,1fr)] gap-3 px-4 py-2.5 text-[11px] hover:bg-[var(--vanta-surface-hover)]/40 sm:grid-cols-[minmax(0,155px)_minmax(0,1fr)] sm:px-5">
                      <div className="min-w-0"><div className="break-all font-mono text-[10px] text-[var(--vanta-muted)]">{entry.timestamp}</div><span className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${entry.level === 'error' ? 'bg-red-500/10 text-red-500' : entry.level === 'warn' ? 'bg-amber-500/10 text-amber-500' : 'bg-blue-500/10 text-blue-500'}`}>{entry.level}</span></div>
                      <p className="min-w-0 break-words text-[var(--vanta-text-secondary)] [overflow-wrap:anywhere]">{entry.message}</p>
                    </div>
                  ))}
                </div> : <div className="flex min-h-[140px] flex-col items-center justify-center px-4 text-center"><ClipboardList className="mb-2 h-6 w-6 text-[var(--vanta-muted)]" /><p className="text-xs font-medium text-[var(--vanta-text)]">{taskLogs.length ? 'No matching log entries' : 'No activity logs recorded'}</p><p className="mt-1 text-[10px] text-[var(--vanta-muted)]">{taskLogs.length ? 'Adjust the severity filter or search phrase.' : 'Engine events will appear here when available.'}</p></div>}
              </div>
            </div>
          )}
        </div>
        {(actionError || actionNotice) && <div className={`flex shrink-0 items-center gap-2 border-t px-4 py-2 text-[11px] ${actionError ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-[#f85149]' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-[#3fb950]'}`} role={actionError ? 'alert' : 'status'}>{actionError ? <AlertCircle className="h-3.5 w-3.5 shrink-0" /> : <Info className="h-3.5 w-3.5 shrink-0" />}{actionError || actionNotice}<button type="button" onClick={() => { setActionError(null); setActionNotice(null); }} className="ml-auto text-current opacity-70 hover:opacity-100">Dismiss</button></div>}
      </aside>
      {showProperties && <DownloadPropertiesModal task={task} onClose={() => setShowProperties(false)} />}
    </>
  );
};
