import React, { useState } from 'react';
import { X, Copy, FileDown } from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { ProgressDisplay, getStatusLabel } from './ProgressDisplay';

type Tab = 'general' | 'source' | 'progress' | 'connections' | 'integrity' | 'media' | 'logs';
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' }, { id: 'source', label: 'Source' },
  { id: 'progress', label: 'Progress' }, { id: 'connections', label: 'Connections' },
  { id: 'integrity', label: 'Integrity' }, { id: 'media', label: 'Media' }, { id: 'logs', label: 'Logs' },
];

interface Props { task: DownloadTask; onClose: () => void; }
const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3">
    <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--vanta-muted)]">{label}</div>
    <div className="mt-1 break-all text-xs font-medium text-[var(--vanta-text)]">{value || 'Not reported'}</div>
  </div>
);

export const DownloadPropertiesModal: React.FC<Props> = ({ task, onClose }) => {
  const [tab, setTab] = useState<Tab>('general');
  const [copied, setCopied] = useState(false);
  const logs = task.logs || [];
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(task.url); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  const exportLogs = () => {
    const text = logs.map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${(task.title || 'download').replace(/[\\/:*?"<>|]/g, '_')}-logs.txt`; link.click(); URL.revokeObjectURL(url);
  };
  const integrityLogs = logs.filter((entry) => /sha-?256|checksum|integrity|hash verified|verification|fragment.*recover/i.test(entry.message));
  const integrityFailed = integrityLogs.some((entry) => /failed|mismatch|invalid|error/i.test(entry.message));
  const integrityPassed = integrityLogs.some((entry) => /verified|passed|succeeded|match|valid/i.test(entry.message));

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="download-properties-title" className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-4 py-3.5 sm:px-5">
          <div className="min-w-0"><h2 id="download-properties-title" className="text-sm font-semibold text-[var(--vanta-text)]">Download Properties</h2><p className="mt-0.5 truncate text-[11px] text-[var(--vanta-muted)]" title={task.title}>{task.title}</p></div>
          <button type="button" onClick={onClose} aria-label="Close properties" className="rounded-lg p-2 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]"><X className="h-4 w-4" /></button>
        </header>
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--vanta-border)] px-3 py-2" aria-label="Download property sections">
          {tabs.map(({ id, label }) => <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`rounded-lg px-3 py-2 text-[11px] font-medium whitespace-nowrap ${tab === id ? 'bg-[var(--vanta-accent)] text-white' : 'text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]'}`}>{label}</button>)}
        </nav>
        <div className="min-h-[260px] min-w-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
          {tab === 'general' && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="File name" value={task.output_path.split(/[\\/]/).pop() || task.custom_filename || task.title} />
            <Field label="Output path" value={task.output_path} /><Field label="Status" value={getStatusLabel(task.status)} />
            <Field label="Engine" value={task.engine} /><Field label="Queue" value={task.queue_id || 'main'} />
            <Field label="Priority" value={task.priority} /><Field label="Created" value={task.created_at ? new Date(task.created_at).toLocaleString() : ''} />
            <Field label="Started" value={task.started_at ? new Date(task.started_at).toLocaleString() : 'Not started'} />
            <Field label="Completed" value={task.completed_at ? new Date(task.completed_at).toLocaleString() : 'Not completed'} />
            <Field label="Retries" value={`${task.retries} / ${task.max_retries}`} />
          </div>}
          {tab === 'source' && <div className="space-y-3">
            <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3"><div className="text-[10px] uppercase tracking-wide text-[var(--vanta-muted)]">Source URL</div><p className="mt-2 break-all font-mono text-xs text-[var(--vanta-text)]">{task.url}</p><button type="button" onClick={() => void copyUrl()} className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--vanta-accent)]"><Copy className="h-3 w-3" />{copied ? 'Copied' : 'Copy URL'}</button></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host" value={(() => { try { return new URL(task.url).hostname; } catch { return 'Unrecognized URL'; } })()} />
              <Field label="Uploader / Artist" value={task.uploader || ''} /><Field label="Album" value={task.album || ''} />
              <Field label="Content type" value={task.content_type || (task.is_audio_only ? 'Audio' : 'Video')} />
              <Field label="Playlist mode" value={task.playlist_mode || 'Single item'} />
              <Field label="Playlist items" value={String(task.tracks_requested ?? task.selected_items?.length ?? 1)} />
            </div>
          </div>}
          {tab === 'progress' && <div className="space-y-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-4">
            <div className="flex items-center justify-between"><span className="text-xs text-[var(--vanta-text)]">Transfer completion</span><strong className="font-mono text-sm text-[var(--vanta-text)]">{task.status === 'completed' ? '100%' : task.percentage_known === false ? 'Unknown' : `${Math.max(0, Math.min(100, task.progress_percentage)).toFixed(1)}%`}</strong></div>
            <ProgressDisplay task={task} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Downloaded" value={formatBytes(task.downloaded_bytes)} />
              <Field label="Total size" value={task.total_bytes > 0 ? formatBytes(task.total_bytes) : 'Unknown'} />
              <Field label="Remaining" value={(task.remaining_bytes ?? 0) > 0 ? formatBytes(task.remaining_bytes ?? 0) : 'Not reported'} />
              <Field label="Current speed" value={task.speed_str} />
              <Field label="Average speed" value={(task.avg_speed_bytes_per_sec ?? 0) > 0 ? `${formatBytes(task.avg_speed_bytes_per_sec ?? 0)}/s` : 'Not reported'} />
              <Field label="ETA" value={task.eta_str} /><Field label="Elapsed" value={formatDuration(task.elapsed_seconds ?? 0)} />
              <Field label="Last update" value={task.last_progress_at || 'Not reported'} />
            </div>
          </div>}
          {tab === 'connections' && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Active connections" value={task.active_connections != null && task.active_connections > 0 ? String(task.active_connections) : 'Not reported'} />
            <Field label="Retries used" value={`${task.retries} / ${task.max_retries}`} />
            <Field label="Connection details" value="Per-connection addresses and states are not exposed by the current task model." />
            <Field label="Fragment concurrency" value="Not exposed by current task telemetry." />
          </div>}
          {tab === 'integrity' && <div className="space-y-3">
            <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-4"><div className="text-[10px] uppercase tracking-wide text-[var(--vanta-muted)]">Integrity status from task logs</div><div className={`mt-2 text-sm font-semibold ${integrityFailed ? 'text-red-500' : integrityPassed ? 'text-emerald-500' : 'text-[var(--vanta-text)]'}`}>{integrityFailed ? 'Verification issue recorded' : integrityPassed ? 'Verification event recorded' : 'No verification result recorded'}</div><p className="mt-1 text-[11px] text-[var(--vanta-muted)]">The current task model does not store the SHA-256 digest itself. This panel does not infer success when no verification event is logged.</p></div>
            {integrityLogs.length ? integrityLogs.map((entry, index) => <Field key={entry.timestamp + index} label={entry.timestamp} value={entry.message} />) : <p className="text-xs text-[var(--vanta-muted)]">No checksum, SHA-256 or fragment-recovery events were found in this task's logs.</p>}
          </div>}
          {tab === 'media' && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Media type" value={task.is_audio_only ? 'Audio' : 'Video'} /><Field label="Container" value={task.ext} />
            <Field label="Format ID" value={task.format_id} /><Field label="Format note" value={task.format_note || ''} />
            <Field label="Resolution" value={task.resolution_label || ''} /><Field label="Video codec" value={task.video_codec || ''} />
            <Field label="Audio codec" value={task.audio_codec || task.verified_audio_info || ''} /><Field label="Audio format" value={task.audio_format || ''} />
            <Field label="Audio bitrate" value={task.audio_bitrate || ''} /><Field label="Sample rate" value={task.audio_sample_rate ? `${task.audio_sample_rate} Hz` : ''} />
            <Field label="Bit depth" value={task.audio_bit_depth ? `${task.audio_bit_depth}-bit` : ''} /><Field label="Channels" value={task.audio_channels ? String(task.audio_channels) : ''} />
            <Field label="Duration" value={task.duration_string || ''} /><Field label="Subtitle languages" value={task.subtitle_languages?.join(', ') || 'None selected'} />
          </div>}
          {tab === 'logs' && <div className="space-y-2">
            <div className="flex items-center justify-between"><span className="text-xs text-[var(--vanta-muted)]">{logs.length} recorded events</span><button type="button" onClick={exportLogs} disabled={!logs.length} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--vanta-border)] px-2.5 py-1.5 text-[11px] text-[var(--vanta-text)] disabled:opacity-40"><FileDown className="h-3.5 w-3.5" />Export logs</button></div>
            {logs.length ? <div className="max-h-[48vh] overflow-auto rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]">{[...logs].reverse().map((entry, index) => <div key={entry.timestamp + index} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-[var(--vanta-border)] px-3 py-2.5 text-[11px]"><span className="font-mono text-[10px] text-[var(--vanta-muted)]">{entry.timestamp}</span><span className="break-words [overflow-wrap:anywhere] text-[var(--vanta-text-secondary)]">{entry.message}</span></div>)}</div> : <p className="text-xs text-[var(--vanta-muted)]">No task logs recorded.</p>}
          </div>}
          {task.error_message && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-500">Latest error: {task.error_message}</div>}
        </div>
        <footer className="flex shrink-0 justify-end border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-4 py-3"><button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-xs font-medium text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">Close</button></footer>
      </section>
    </div>
  );
};
