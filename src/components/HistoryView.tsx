import React, { useState, useMemo, useRef } from 'react';
import { History, Search, Copy, Trash2, Download, Check, FileX, Upload } from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { computeHistoryStats } from '../utils/queue-logic';
import { formatAudioQualityBadge } from '../utils/audio-quality';
import { ConfirmDialog } from './ConfirmDialog';
import { MediaThumbnail } from './MediaThumbnail';

interface HistoryViewProps {
  tasks: DownloadTask[];
  onClearHistory: (deleteFiles?: boolean) => void;
  onDeleteTask: (id: string, deleteFile?: boolean) => void;
  onDeleteFile?: (id: string) => void;
  onSelectTask?: (task: DownloadTask) => void;
  onImportHistory: (tasks: DownloadTask[]) => Promise<DownloadTask[]>;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  tasks,
  onClearHistory,
  onDeleteTask,
  onDeleteFile,
  onSelectTask,
  onImportHistory,
}) => {
  const [search, setSearch] = useState('');
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed' | 'cancelled'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'title' | 'largest'>('newest');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    checkboxLabel?: string;
    onConfirm: (checked: boolean) => void;
  } | null>(null);

  const stats = useMemo(() => computeHistoryStats(tasks), [tasks]);

  const historyTasks = useMemo(() => {
    const filtered = tasks.filter((t) => {
        if (t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled') {
          return false;
        }
        if (statusFilter !== 'all' && t.status !== statusFilter) return false;
        if (!search.trim()) return true;
        const q = search.trim().toLocaleLowerCase();
        return [t.title, t.url, t.uploader, t.engine, t.ext, t.output_path]
          .some((value) => String(value || '').toLocaleLowerCase().includes(q));
      });
    return filtered.sort((a, b) => {
      if (sortOrder === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      if (sortOrder === 'largest') return (b.downloaded_bytes || b.total_bytes || 0) - (a.downloaded_bytes || a.total_bytes || 0);
      const aDate = new Date(a.completed_at || a.created_at).getTime() || 0;
      const bDate = new Date(b.completed_at || b.created_at).getTime() || 0;
      return sortOrder === 'oldest' ? aDate - bDate : bDate - aDate;
    });
  }, [tasks, statusFilter, search, sortOrder]);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const downloadTextFile = (content: string, mimeType: string, extension: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vanta_history_${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleExportJson = () => {
    downloadTextFile(JSON.stringify(historyTasks, null, 2), 'application/json;charset=utf-8', 'json');
  };

  const handleImportJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportNotice(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('History import is limited to 5 MiB per file.');
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) {
        throw new Error('The selected file must contain a VANTA history JSON array.');
      }
      if (parsed.length > 5000) throw new Error('A maximum of 5,000 history records can be imported at once.');

      const records = parsed.filter((item: any) =>
        item &&
        typeof item === 'object' &&
        typeof item.title === 'string' &&
        item.title.trim().length > 0 &&
        typeof item.url === 'string' &&
        item.url.trim().length > 0 &&
        ['completed', 'failed', 'cancelled'].includes(item.status)
      ) as DownloadTask[];

      if (records.length === 0) {
        throw new Error('No valid completed, failed, or cancelled VANTA history records were found.');
      }

      await onImportHistory(records);
      const skipped = parsed.length - records.length;
      setImportNotice(
        `Imported ${records.length} record(s)${skipped > 0 ? `; skipped ${skipped} unsupported record(s)` : ''}.`
      );
    } catch (error) {
      setImportNotice(error instanceof Error ? error.message : 'History import failed.');
    } finally {
      setIsImporting(false);
      event.target.value = '';
    }
  };

  const handleExportCsv = () => {
    const esc = (v: unknown) => {
      let value = String(v ?? '');
      if (/^[=+@\\-\\t\\r]/.test(value)) value = `'${value}`;
      return `"${value.replace(/"/g, '""')}"`;
    };
    const rows = [
      ['id', 'title', 'url', 'engine', 'status', 'ext', 'bytes', 'completed_at'].join(','),
      ...historyTasks.map((t) =>
        [
          esc(t.id),
          esc(t.title),
          esc(t.url),
          esc(t.engine),
          esc(t.status),
          esc(t.ext),
          t.status === 'completed' ? (t.downloaded_bytes || t.total_bytes || 0) : (t.total_bytes || t.downloaded_bytes || 0),
          esc(t.completed_at || t.created_at),
        ].join(',')
      ),
    ].join('\n');
    downloadTextFile(`\\uFEFF${rows}`, 'text/csv;charset=utf-8', 'csv');
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
        <div>
          <h1 className="text-base font-semibold text-[var(--vanta-text)]">Download History</h1>
          <p className="text-xs text-[var(--vanta-muted)] mt-0.5">
            Completed, failed, and cancelled transfer archive
          </p>
          {importNotice && (
            <p role="status" aria-live="polite" className="mt-2 text-[11px] text-[var(--vanta-muted)]">
              {importNotice}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleImportJson}
            className="hidden"
            aria-label="Import VANTA history JSON"
          />
          <button
            type="button"
            disabled={isImporting}
            onClick={() => importInputRef.current?.click()}
            className="px-3 py-1.5 text-xs font-medium text-[var(--vanta-text-secondary)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{isImporting ? 'Importing…' : 'Import JSON'}</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            className="px-3 py-1.5 text-xs font-medium text-[var(--vanta-text-secondary)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-3 py-1.5 text-xs font-medium text-[var(--vanta-text-secondary)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={() =>
              setConfirmState({
                title: 'Clear Completed History',
                message: 'Remove all completed transfer records from history?',
                confirmLabel: 'Clear History',
                checkboxLabel: 'Also delete downloaded files from disk',
                onConfirm: (deleteFiles) => {
                  setConfirmState(null);
                  onClearHistory(deleteFiles);
                },
              })
            }
            className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-[#f85149] bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Completed</span>
          </button>
        </div>
      </div>

      {/* Real Computed Stats Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] text-[var(--vanta-muted)]">Completed Files</p>
          <p className="text-lg font-semibold font-mono tabular-nums text-emerald-700 dark:text-[#3fb950]">
            {stats.totalCompleted}
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] text-[var(--vanta-muted)]">Failed / Cancelled</p>
          <p className="text-lg font-semibold font-mono tabular-nums text-[var(--vanta-text)]">
            {stats.totalFailed} / {stats.totalCancelled}
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] text-[var(--vanta-muted)]">Total Data Saved</p>
          <p className="text-lg font-semibold font-mono tabular-nums text-[var(--vanta-text)]">
            {formatBytes(stats.totalBytesDownloaded)}
          </p>
        </div>
        <div className="px-4 py-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
          <p className="text-[11px] text-[var(--vanta-muted)]">Average Throughput</p>
          <p className="text-lg font-semibold font-mono tabular-nums text-[var(--vanta-accent)]">
            {stats.meanSpeedBytesPerSec > 0
              ? `${formatBytes(stats.meanSpeedBytesPerSec)}/s`
              : stats.totalElapsedSeconds > 0
              ? formatDuration(stats.totalElapsedSeconds)
              : '--'}
          </p>
        </div>
      </div>

      {/* Filter & Search Row */}
      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--vanta-muted)]" />
          <input
            type="text"
            placeholder="Search history by title, URL, or uploader..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--vanta-surface)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs py-2 pl-9 pr-3 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)]"
          />
        </div>
        <select
          aria-label="Filter history status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="bg-[var(--vanta-surface)] border border-[var(--vanta-border)] rounded-lg text-xs px-3 py-2 text-[var(--vanta-text)]"
        >
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          aria-label="Sort download history"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
          className="bg-[var(--vanta-surface)] border border-[var(--vanta-border)] rounded-lg text-xs px-3 py-2 text-[var(--vanta-text)]"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A–Z</option>
          <option value="largest">Largest first</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] overflow-hidden">
        {historyTasks.length === 0 ? (
          <div className="py-14 text-center p-4">
            <History className="w-8 h-8 text-[var(--vanta-muted)]/60 mx-auto mb-2" />
            <p className="text-xs font-medium text-[var(--vanta-text)]">No history records found</p>
            <p className="text-[11px] text-[var(--vanta-muted)] mt-0.5">
              Completed or terminated downloads will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[var(--vanta-surface-2)] border-b border-[var(--vanta-border)] text-[var(--vanta-muted)] font-mono text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Title &amp; Source</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">Engine / Format</th>
                  <th className="py-2.5 px-4 font-medium text-right">Size</th>
                  <th className="py-2.5 px-4 font-medium">Date</th>
                  <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--vanta-border)]">
                {historyTasks.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => onSelectTask?.(item)}
                    className="hover:bg-[var(--vanta-surface-hover)]/50 transition-colors cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <MediaThumbnail
                          src={item.thumbnail}
                          title={item.title}
                          isAudio={item.is_audio_only || item.engine === 'spotdl'}
                          ext={item.ext}
                          size="sm"
                          aspect="video"
                          showBadge={false}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[var(--vanta-text)] truncate max-w-sm">
                            {item.title}
                          </div>
                          {item.uploader && (
                            <div className="text-[11px] text-[var(--vanta-text-secondary)] truncate max-w-sm">
                              {item.uploader}
                            </div>
                          )}
                          <div className="text-[11px] text-[var(--vanta-muted)] truncate max-w-sm font-mono mt-0.5">
                            {item.url}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">
                      <span
                        className={
                          item.status === 'completed'
                            ? 'text-emerald-700 dark:text-[#3fb950]'
                            : item.status === 'failed'
                            ? 'text-red-600 dark:text-[#f85149]'
                            : 'text-[var(--vanta-muted)]'
                        }
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-[var(--vanta-text-secondary)] whitespace-nowrap">
                      {item.engine} ·{' '}
                      {item.verified_audio_info
                        ? item.verified_audio_info
                        : item.is_audio_only
                        ? formatAudioQualityBadge(
                            item.audio_format || item.ext,
                            item.audio_bit_depth,
                            item.audio_sample_rate,
                            item.audio_bitrate,
                            item.is_lossy_source,
                            false
                          )
                        : item.ext.toUpperCase()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-[var(--vanta-text-secondary)] whitespace-nowrap">
                      {item.status === 'completed'
                        ? item.downloaded_bytes > 0 ? formatBytes(item.downloaded_bytes) : item.total_bytes > 0 ? formatBytes(item.total_bytes) : '--'
                        : item.total_bytes > 0 ? `≈${formatBytes(item.total_bytes)}` : item.downloaded_bytes > 0 ? formatBytes(item.downloaded_bytes) : '--'}
                    </td>
                    <td className="py-3 px-4 text-[var(--vanta-muted)] font-mono tabular-nums text-[11px] whitespace-nowrap">
                      {new Date(item.completed_at || item.created_at).toLocaleDateString()}
                    </td>
                    <td
                      className="py-3 px-4 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.url, item.id)}
                          title="Copy source URL"
                          className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-accent)] rounded transition-colors"
                        >
                          {copiedId === item.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-[#3fb950]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        {item.output_path && onDeleteFile && (
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmState({
                                title: 'Delete File From Disk',
                                message: `Permanently delete downloaded file "${item.title}" from disk while keeping the history record?`,
                                confirmLabel: 'Delete File',
                                onConfirm: () => {
                                  setConfirmState(null);
                                  onDeleteFile(item.id);
                                },
                              })
                            }
                            title="Delete file from disk"
                            className="p-1.5 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] rounded transition-colors"
                          >
                            <FileX className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmState({
                              title: 'Remove History Entry',
                              message: `Remove "${item.title}" from download history?`,
                              confirmLabel: 'Remove',
                              checkboxLabel: item.output_path
                                ? 'Also delete downloaded file from disk'
                                : undefined,
                              onConfirm: (deleteFile) => {
                                setConfirmState(null);
                                onDeleteTask(item.id, deleteFile);
                              },
                            })
                          }
                          title="Remove from history"
                          className="p-1.5 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
