import React, { useEffect, useState } from 'react';
import {
  X, FolderOpen, FileCheck2, Edit3, Copy, AlertCircle, RefreshCw,
  Info, ListVideo, Captions, Music2, Settings2, Download,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { ProgressDisplay, getStatusLabel, getStatusColorClass } from './ProgressDisplay';
import { MediaThumbnail } from './MediaThumbnail';
import { api } from '../services/api';

interface DownloadDetailsDrawerProps {
  task: DownloadTask | null;
  onClose: () => void;
  onRetryTask: (id: string) => void;
}

type InspectorTab = 'details' | 'playlist' | 'subtitles' | 'lyrics' | 'options';

export const DownloadDetailsDrawer: React.FC<DownloadDetailsDrawerProps> = ({ task, onClose, onRetryTask }) => {
  const [tab, setTab] = useState<InspectorTab>('details');
  const [renameMode, setRenameMode] = useState(false);
  const [filenameDraft, setFilenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTab('details');
    setRenameMode(false);
    setFilenameDraft((task.output_path || '').split(/[\\/]/).pop() || task.custom_filename || task.title);
    setActionError(null);
    setActionNotice(null);
  }, [task?.id]);

  if (!task) return null;

  const audioTask = task.is_audio_only || task.engine === 'spotdl';
  const lyrics = task.lyrics_lrc_content?.trim() || '';
  const effectiveBytes = task.status === 'completed'
    ? (task.downloaded_bytes || task.total_bytes)
    : task.downloaded_bytes;
  const displayedTotalSize = task.status === 'completed'
    ? effectiveBytes
    : task.total_bytes;

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

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(task.url);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1600);
    } catch {
      setActionError('Could not copy the source URL.');
    }
  };

  const exportLyrics = () => {
    if (!lyrics) return;
    const blob = new Blob([lyrics], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${(task.title || 'track').replace(/[\\/:*?"<>|]/g, '_')}.lrc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  };

  const tabs: Array<{ id: InspectorTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'playlist', label: 'Playlist', icon: ListVideo },
    { id: 'subtitles', label: 'Subtitles', icon: Captions },
    { id: 'lyrics', label: 'Lyrics', icon: Music2 },
    { id: 'options', label: 'Options', icon: Settings2 },
  ];

  return (
    <aside className="w-full h-[clamp(260px,34vh,380px)] shrink-0 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface)] flex flex-col min-h-0 shadow-[0_-12px_32px_rgba(0,0,0,0.12)]" aria-label="Download details panel">
      <div className="h-12 px-3 sm:px-4 border-b border-[var(--vanta-border)] flex items-center justify-between gap-3 shrink-0">
        <nav className="flex items-center gap-1 min-w-0 overflow-x-auto" aria-label="Download detail sections">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={`h-9 px-3 rounded-lg text-xs sm:text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap transition-colors ${tab === id ? 'bg-[var(--vanta-accent)] text-white' : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]'}`}>
              <Icon className="w-4 h-4" />{label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 min-w-0">
          <span className="hidden md:block text-xs text-[var(--vanta-muted)] truncate max-w-[260px]">{task.title}</span>
          <button type="button" onClick={onClose} aria-label="Close details panel" className="p-2 rounded-lg text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4">
        {tab === 'details' && (
          <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(240px,1.2fr)_minmax(220px,1fr)] gap-3 lg:gap-4">
            <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2.5 flex items-center gap-3 min-w-0">
              <MediaThumbnail src={task.thumbnail} title={task.title} isAudio={audioTask} ext={task.ext} size="lg" aspect={audioTask ? 'square' : 'video'} />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-[var(--vanta-text)] line-clamp-2">{task.title}</h3>
                <p className="mt-1 text-[11px] text-[var(--vanta-muted)] truncate">{[task.uploader, task.album, task.duration_string].filter(Boolean).join(' · ') || (audioTask ? 'Audio download' : 'Video download')}</p>
                <span className={`inline-flex mt-2 px-2 py-1 rounded-md text-[10px] font-semibold ${getStatusColorClass(task.status)} bg-[var(--vanta-surface)]`}>{getStatusLabel(task.status)}</span>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3 space-y-3 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--vanta-text)]">Transfer progress</span>
                <span className="text-sm font-semibold tabular-nums text-[var(--vanta-text)]">{task.status === 'completed' ? '100%' : task.percentage_known === false ? '—' : `${Math.min(100, Math.max(0, task.progress_percentage || 0)).toFixed(1)}%`}</span>
              </div>
              <ProgressDisplay task={task} />
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="block text-[var(--vanta-muted)]">{task.status === 'completed' ? 'Final file size' : 'Downloaded'}</span><strong className="text-[var(--vanta-text)]">{effectiveBytes > 0 ? formatBytes(effectiveBytes) : '—'}</strong></div>
                {task.status !== 'completed' && <div><span className="block text-[var(--vanta-muted)]">Estimated total</span><strong className="text-[var(--vanta-text)]">{displayedTotalSize ? `≈${formatBytes(displayedTotalSize)}` : '—'}</strong></div>}
                <div><span className="block text-[var(--vanta-muted)]">Speed</span><strong className="text-[var(--vanta-text)]">{task.speed_str || '—'}</strong></div>
                <div><span className="block text-[var(--vanta-muted)]">ETA</span><strong className="text-[var(--vanta-text)]">{task.eta_str || '—'}</strong></div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3 space-y-2.5 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--vanta-text)]">File & source</span>
                <button type="button" onClick={copyUrl} className="text-[11px] text-[var(--vanta-accent)] inline-flex items-center gap-1"><Copy className="w-3 h-3" />{copiedUrl ? 'Copied' : 'Copy URL'}</button>
              </div>
              <p className="text-[10px] font-mono text-[var(--vanta-muted)] break-all line-clamp-2">{task.url}</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={!task.output_path || task.status !== 'completed'} onClick={() => api.openTaskFile(task).catch((error) => setActionError(error.message))} className="px-2.5 py-1.5 rounded-lg bg-[var(--vanta-accent)] text-white text-[11px] inline-flex items-center gap-1.5 disabled:opacity-40"><FileCheck2 className="w-3.5 h-3.5" />Open File</button>
                <button type="button" disabled={!task.output_path} onClick={() => api.openTaskFolder(task).catch((error) => setActionError(error.message))} className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] text-[11px] inline-flex items-center gap-1.5 disabled:opacity-40"><FolderOpen className="w-3.5 h-3.5" />Open Folder</button>
                {task.status === 'failed' && <button type="button" onClick={() => onRetryTask(task.id)} className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] text-[var(--vanta-text)] text-[11px] inline-flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" />Retry</button>}
                {task.status === 'completed' && task.output_path && <button type="button" onClick={() => setRenameMode((value) => !value)} className="px-2.5 py-1.5 rounded-lg border border-[var(--vanta-border)] text-[var(--vanta-text)] text-[11px] inline-flex items-center gap-1.5"><Edit3 className="w-3.5 h-3.5" />Rename</button>}
              </div>
              {renameMode && <form onSubmit={handleRename} className="flex gap-2"><input value={filenameDraft} onChange={(event) => setFilenameDraft(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-bg)] px-2 py-1.5 text-xs text-[var(--vanta-text)]" aria-label="New filename" /><button type="submit" disabled={renameBusy || !filenameDraft.trim()} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs disabled:opacity-40">{renameBusy ? 'Saving…' : 'Save'}</button></form>}
              {task.output_path && <p className="text-[10px] font-mono text-[var(--vanta-muted)] break-all line-clamp-2">{task.output_path}</p>}
              {actionError && <p className="text-[11px] text-red-500 break-words">{actionError}</p>}
              {actionNotice && <p className="text-[11px] text-emerald-500">{actionNotice}</p>}
            </div>
          </div>
        )}

        {tab === 'playlist' && (
          <div className="max-w-4xl space-y-3">
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-[var(--vanta-text)]">Playlist selection</h3><p className="text-[11px] text-[var(--vanta-muted)] mt-1">{task.playlist_mode === 'playlist' ? 'Playlist download' : 'Single item download'}</p></div><span className="text-xs font-mono text-[var(--vanta-text-secondary)]">{task.tracks_completed ?? 0} / {task.tracks_requested ?? task.selected_items?.length ?? 1} tracks</span></div>
            {task.selected_items?.length ? <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{task.selected_items.map((item, index) => <div key={`${index}-${item}`} className="rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-2 text-[11px] text-[var(--vanta-text-secondary)] break-all"><span className="text-[var(--vanta-muted)] mr-2">{String(index + 1).padStart(2, '0')}</span>{item}</div>)}</div> : <p className="text-xs text-[var(--vanta-muted)]">No playlist item list was stored for this task.</p>}
            {(task.tracks_failed ?? 0) > 0 && <p className="text-xs text-red-500">{task.tracks_failed} track(s) failed.</p>}
          </div>
        )}

        {tab === 'subtitles' && (
          <div className="max-w-3xl space-y-3">
            <h3 className="text-sm font-semibold text-[var(--vanta-text)]">Subtitle tracks</h3>
            {task.subtitle_languages?.length ? <div className="flex flex-wrap gap-2">{task.subtitle_languages.map((language) => <span key={language} className="px-3 py-1.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] text-xs text-[var(--vanta-text)]">{language}</span>)}</div> : <p className="text-xs text-[var(--vanta-muted)]">No subtitle languages were selected for this download.</p>}
            <p className="text-[11px] text-[var(--vanta-muted)]">{task.write_auto_subtitles ? 'Automatic subtitles were enabled for this task.' : 'Automatic subtitles were not enabled for this task.'} Embedded subtitle tracks remain selectable in compatible media players; they are not burned into the video image.</p>
          </div>
        )}

        {tab === 'lyrics' && (
          <div className="max-w-4xl h-full min-h-0 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 shrink-0"><div><h3 className="text-sm font-semibold text-[var(--vanta-text)]">Synchronized lyrics</h3><p className="text-[11px] text-[var(--vanta-muted)]">Lyrics supplied for this download · LRC format</p></div><button type="button" disabled={!lyrics} onClick={exportLyrics} className="px-3 py-1.5 rounded-lg border border-[var(--vanta-border)] text-xs text-[var(--vanta-text)] inline-flex items-center gap-1.5 disabled:opacity-40"><Download className="w-3.5 h-3.5" />Export .LRC</button></div>
            {lyrics ? <pre className="flex-1 min-h-0 overflow-auto rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3 text-[11px] leading-5 font-mono whitespace-pre-wrap text-[var(--vanta-text-secondary)]">{lyrics}</pre> : <div className="flex-1 min-h-0 rounded-xl border border-dashed border-[var(--vanta-border)] flex flex-col items-center justify-center text-center p-5"><Music2 className="w-7 h-7 text-[var(--vanta-muted)] mb-2" /><p className="text-sm text-[var(--vanta-text)] font-medium">No LRC lyrics attached</p><p className="text-[11px] text-[var(--vanta-muted)] mt-1 max-w-lg">Add an LRC file or paste timestamped lyrics in the Audio section when creating a download. VANTA can then embed the supplied lyrics in MP3 files and keep an LRC sidecar.</p></div>}
          </div>
        )}

        {tab === 'options' && (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            {[
              ['Engine', task.engine],
              ['Format', (task.audio_format || task.ext || '—').toUpperCase()],
              ['Priority', task.priority],
              ['Duration', task.duration_string || '—'],
              ['Connections', String(task.active_connections ?? 0)],
              ['Retries', `${task.retries} / ${task.max_retries}`],
              ['Created', task.created_at ? new Date(task.created_at).toLocaleString() : '—'],
              ['Elapsed', task.elapsed_seconds ? formatDuration(task.elapsed_seconds) : '—'],
            ].map(([label, value]) => <div key={label} className="rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3"><span className="block text-[10px] text-[var(--vanta-muted)] uppercase tracking-wide">{label}</span><strong className="block mt-1 text-xs text-[var(--vanta-text)] break-words">{value}</strong></div>)}
            {task.error_message && <div className="col-span-full rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500"><AlertCircle className="w-4 h-4 inline mr-2" />{task.error_message}</div>}
          </div>
        )}
      </div>
    </aside>
  );
};
