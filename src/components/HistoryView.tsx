import React, { useState } from 'react';
import {
  History,
  Search,
  Copy,
  Trash2,
  FolderOpen,
  Download,
  Upload,
  Check,
  FileCheck,
  Clock,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes } from '../utils/engine-parser';

interface HistoryViewProps {
  tasks: DownloadTask[];
  onClearHistory: () => void;
  onDeleteTask: (id: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  tasks,
  onClearHistory,
  onDeleteTask,
}) => {
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const completedTasks = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );

  const filtered = completedTasks.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      t.url.toLowerCase().includes(q) ||
      (t.uploader && t.uploader.toLowerCase().includes(q))
    );
  });

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(tasks, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `vanta_download_history_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">Download History</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Audit log of completed and processed media files
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportJson}
            className="px-3 py-1.5 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>
          <button
            onClick={onClearHistory}
            className="px-3 py-1.5 text-xs font-medium text-[#f85149] bg-[#da3633]/15 hover:bg-[#da3633]/25 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear History</span>
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6e7681]" />
        <input
          type="text"
          placeholder="Search history by title, URL, or uploader..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-[#12151a] border border-[#21262d] focus:border-[#58a6ff] focus:outline-none rounded-lg text-xs py-2.5 pl-9 pr-3 text-[#e6edf3] placeholder-[#6e7681]"
        />
      </div>

      {/* History Table */}
      <div className="rounded-xl border border-[#21262d] bg-[#12151a] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-14 text-center">
            <History className="w-8 h-8 text-[#484f58] mx-auto mb-2" />
            <p className="text-xs font-medium text-[#c9d1d9]">No history records found</p>
            <p className="text-[11px] text-[#8b949e] mt-0.5">
              Downloaded items will appear here after completion
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0d1117] border-b border-[#21262d] text-[#8b949e] font-mono text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Title & Source</th>
                  <th className="py-2.5 px-4 font-medium">Engine</th>
                  <th className="py-2.5 px-4 font-medium">Format</th>
                  <th className="py-2.5 px-4 font-medium text-right">Size</th>
                  <th className="py-2.5 px-4 font-medium">Completed</th>
                  <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#21262d]">
                {filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-[#161b22] transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-medium text-white truncate max-w-sm">{item.title}</div>
                      <div className="text-[11px] text-[#8b949e] truncate max-w-sm font-mono mt-0.5">
                        {item.url}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[#8b949e] whitespace-nowrap">
                      {item.engine}
                    </td>
                    <td className="py-3 px-4 font-mono text-[#c9d1d9] whitespace-nowrap">
                      {item.is_audio_only
                        ? `${item.audio_format?.toUpperCase()} (${item.audio_bitrate || '320k'})`
                        : item.ext.toUpperCase()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-[#c9d1d9] whitespace-nowrap">
                      {item.total_bytes > 0
                        ? formatBytes(item.total_bytes)
                        : item.downloaded_bytes > 0
                        ? formatBytes(item.downloaded_bytes)
                        : '--'}
                    </td>
                    <td className="py-3 px-4 text-[#8b949e] font-mono text-[11px] whitespace-nowrap">
                      {item.completed_at
                        ? new Date(item.completed_at).toLocaleDateString()
                        : new Date(item.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => copyToClipboard(item.url, item.id)}
                          title="Copy source URL"
                          className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] hover:bg-[#21262d] rounded transition-colors"
                        >
                          {copiedId === item.id ? (
                            <Check className="w-3.5 h-3.5 text-[#3fb950]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => onDeleteTask(item.id)}
                          title="Remove from history"
                          className="p-1.5 text-[#8b949e] hover:text-[#f85149] hover:bg-[#21262d] rounded transition-colors"
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
    </div>
  );
};
