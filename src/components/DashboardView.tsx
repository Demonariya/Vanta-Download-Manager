import React from 'react';
import {
  Activity,
  ArrowDownCircle,
  CheckCircle,
  AlertCircle,
  HardDrive,
  Cpu,
  Play,
  Pause,
  X,
  ExternalLink,
  Plus,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { DownloadTask, EngineStatusMap, AppSettings } from '../types';
import { formatBytes, formatDuration } from '../utils/engine-parser';
import { calculateAggregateSpeed } from '../utils/queue-logic';

interface DashboardViewProps {
  tasks: DownloadTask[];
  engineStatus: EngineStatusMap | null;
  settings: AppSettings | null;
  onOpenNewDownload: () => void;
  onPauseTask: (id: string) => void;
  onResumeTask: (id: string) => void;
  onCancelTask: (id: string) => void;
  onViewQueue: () => void;
  onRefreshEngines: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  tasks,
  engineStatus,
  settings,
  onOpenNewDownload,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onViewQueue,
  onRefreshEngines,
}) => {
  const activeTasks = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing'
  );
  const queuedTasks = tasks.filter((t) => t.status === 'queued');
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  const failedTasks = tasks.filter((t) => t.status === 'failed');

  const { formattedSpeed } = calculateAggregateSpeed(tasks);

  const totalBytesDownloaded = tasks.reduce(
    (acc, t) => acc + (t.status === 'completed' ? t.total_bytes || t.downloaded_bytes : t.downloaded_bytes || 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* Top Banner / Welcome Action Strip */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">VANTA Workstation</h1>
          <p className="text-xs text-[#8b949e] mt-1">
            High-concurrency media ingestion and audio conversion pipeline
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onViewQueue}
            className="px-3 py-2 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors whitespace-nowrap"
          >
            View Queue ({tasks.length})
          </button>
          <button
            onClick={onOpenNewDownload}
            className="px-4 py-2 text-xs font-medium text-white bg-[#238636] hover:bg-[#2ea043] rounded-lg flex items-center gap-2 transition-colors shadow-sm whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>New Download</span>
          </button>
        </div>
      </div>

      {/* KPI Real Data Metric Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Metric 1: Aggregate Speed */}
        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-xs text-[#8b949e]">
            <span>Current Speed</span>
            <Activity className="w-4 h-4 text-[#58a6ff]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tracking-tight text-white tabular-nums">
            {formattedSpeed}
          </div>
          <div className="mt-1 text-[11px] text-[#7d8590]">
            {activeTasks.length} active transfer{activeTasks.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Metric 2: Total Downloaded */}
        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-xs text-[#8b949e]">
            <span>Total Downloaded</span>
            <ArrowDownCircle className="w-4 h-4 text-[#3fb950]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tracking-tight text-white tabular-nums">
            {formatBytes(totalBytesDownloaded)}
          </div>
          <div className="mt-1 text-[11px] text-[#7d8590]">
            {completedTasks.length} completed items
          </div>
        </div>

        {/* Metric 3: Queued & Pending */}
        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-xs text-[#8b949e]">
            <span>In Queue</span>
            <RefreshCw className="w-4 h-4 text-[#d29922]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tracking-tight text-white tabular-nums">
            {queuedTasks.length}
          </div>
          <div className="mt-1 text-[11px] text-[#7d8590]">
            Concurrency limit: {settings?.max_concurrent_downloads || 3}
          </div>
        </div>

        {/* Metric 4: Failed / Errors */}
        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-xs text-[#8b949e]">
            <span>Failed Tasks</span>
            <AlertCircle className="w-4 h-4 text-[#f85149]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono tracking-tight text-white tabular-nums">
            {failedTasks.length}
          </div>
          <div className="mt-1 text-[11px] text-[#7d8590]">
            Auto-retry: {settings?.auto_retry_failed ? 'Enabled' : 'Disabled'}
          </div>
        </div>
      </div>

      {/* Active Downloads Section */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Active Transference</h2>
            <p className="text-xs text-[#8b949e] mt-0.5">
              Live streaming downloads with real process metrics
            </p>
          </div>
          <span className="text-xs font-mono text-[#58a6ff]">
            {activeTasks.length} running
          </span>
        </div>

        {activeTasks.length === 0 ? (
          <div className="py-10 text-center border border-dashed border-[#21262d] rounded-lg">
            <Activity className="w-8 h-8 text-[#484f58] mx-auto mb-2" />
            <p className="text-xs font-medium text-[#c9d1d9]">No active downloads right now</p>
            <p className="text-[11px] text-[#8b949e] mt-1">
              Paste a URL in the top bar or click New Download to begin
            </p>
            <button
              onClick={onOpenNewDownload}
              className="mt-3 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Start Download</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {activeTasks.map((task) => (
              <div
                key={task.id}
                className="p-3.5 rounded-lg border border-[#30363d] bg-[#161b22] space-y-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 overflow-hidden">
                    {task.thumbnail ? (
                      <img
                        src={task.thumbnail}
                        alt={task.title}
                        referrerPolicy="no-referrer"
                        className="w-14 h-9 object-cover rounded bg-[#0d1117] shrink-0 border border-[#21262d]"
                      />
                    ) : (
                      <div className="w-14 h-9 rounded bg-[#21262d] flex items-center justify-center shrink-0 text-[10px] font-mono text-[#8b949e]">
                        {task.ext.toUpperCase()}
                      </div>
                    )}
                    <div className="truncate">
                      <span className="text-xs font-medium text-white truncate block">
                        {task.title}
                      </span>
                      <div className="flex items-center gap-2 text-[11px] text-[#8b949e] mt-0.5 font-mono">
                        <span>{task.engine}</span>
                        <span aria-hidden="true">·</span>
                        <span>{task.current_phase}</span>
                        {task.speed_str && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#58a6ff]">{task.speed_str}</span>
                          </>
                        )}
                        {task.eta_str && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>ETA {task.eta_str}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {task.status === 'downloading' || task.status === 'extracting' || task.status === 'processing' ? (
                      <button
                        onClick={() => onPauseTask(task.id)}
                        title="Pause"
                        aria-label="Pause task"
                        className="p-1.5 text-[#8b949e] hover:text-[#d29922] hover:bg-[#21262d] rounded transition-colors"
                      >
                        <Pause className="w-3.5 h-3.5" />
                      </button>
                    ) : task.status === 'paused' ? (
                      <button
                        onClick={() => onResumeTask(task.id)}
                        title="Resume"
                        aria-label="Resume task"
                        className="p-1.5 text-[#8b949e] hover:text-[#3fb950] hover:bg-[#21262d] rounded transition-colors"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                    <button
                      onClick={() => onCancelTask(task.id)}
                      title="Cancel"
                      aria-label="Cancel task"
                      className="p-1.5 text-[#8b949e] hover:text-[#f85149] hover:bg-[#21262d] rounded transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#8b949e] mb-1">
                    <span>
                      {task.downloaded_bytes > 0 && task.total_bytes > 0
                        ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`
                        : `${task.progress_percentage.toFixed(1)}%`}
                    </span>
                    <span className="text-white font-medium">{task.progress_percentage.toFixed(1)}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-[#21262d] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#1f6feb] transition-all duration-300 rounded-full"
                      style={{ width: `${Math.min(100, Math.max(2, task.progress_percentage))}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Engine Status Grid & Local Storage Info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Engines */}
        <div className="md:col-span-2 p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Engine Health Matrix</h2>
              <p className="text-xs text-[#8b949e] mt-0.5">
                Core command-line tools inspected in system PATH
              </p>
            </div>
            <button
              onClick={onRefreshEngines}
              title="Refresh engines status"
              className="p-1.5 text-[#8b949e] hover:text-white hover:bg-[#21262d] rounded transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {/* yt-dlp */}
            <div className="p-3 rounded-lg border border-[#21262d] bg-[#161b22]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">yt-dlp</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    engineStatus?.ytdlp.available
                      ? 'bg-[#238636]/15 text-[#3fb950]'
                      : 'bg-[#da3633]/15 text-[#f85149]'
                  }`}
                >
                  {engineStatus?.ytdlp.status || 'unknown'}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[#8b949e] mt-1.5 truncate">
                {engineStatus?.ytdlp.version || 'Not installed'}
              </p>
              <p className="text-[10px] font-mono text-[#6e7681] truncate mt-0.5">
                {engineStatus?.ytdlp.path || 'Unavailable'}
              </p>
            </div>

            {/* spotDL */}
            <div className="p-3 rounded-lg border border-[#21262d] bg-[#161b22]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">spotDL</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    engineStatus?.spotdl.available
                      ? 'bg-[#238636]/15 text-[#3fb950]'
                      : 'bg-[#da3633]/15 text-[#f85149]'
                  }`}
                >
                  {engineStatus?.spotdl.status || 'unknown'}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[#8b949e] mt-1.5 truncate">
                {engineStatus?.spotdl.version || 'Not installed'}
              </p>
              <p className="text-[10px] font-mono text-[#6e7681] truncate mt-0.5">
                {engineStatus?.spotdl.path || 'Unavailable'}
              </p>
            </div>

            {/* FFmpeg */}
            <div className="p-3 rounded-lg border border-[#21262d] bg-[#161b22]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">FFmpeg</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    engineStatus?.ffmpeg.available
                      ? 'bg-[#238636]/15 text-[#3fb950]'
                      : 'bg-[#da3633]/15 text-[#f85149]'
                  }`}
                >
                  {engineStatus?.ffmpeg.status || 'unknown'}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[#8b949e] mt-1.5 truncate">
                {engineStatus?.ffmpeg.version || 'Not installed'}
              </p>
              <p className="text-[10px] font-mono text-[#6e7681] truncate mt-0.5">
                {engineStatus?.ffmpeg.path || 'Unavailable'}
              </p>
            </div>

            {/* FFprobe */}
            <div className="p-3 rounded-lg border border-[#21262d] bg-[#161b22]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">FFprobe</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    engineStatus?.ffprobe.available
                      ? 'bg-[#238636]/15 text-[#3fb950]'
                      : 'bg-[#da3633]/15 text-[#f85149]'
                  }`}
                >
                  {engineStatus?.ffprobe.status || 'unknown'}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[#8b949e] mt-1.5 truncate">
                {engineStatus?.ffprobe.version || 'Not installed'}
              </p>
              <p className="text-[10px] font-mono text-[#6e7681] truncate mt-0.5">
                {engineStatus?.ffprobe.path || 'Unavailable'}
              </p>
            </div>
          </div>
        </div>

        {/* Card 2: Destination Storage */}
        <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Storage Path</h2>
              <HardDrive className="w-4 h-4 text-[#58a6ff]" />
            </div>
            <p className="text-xs text-[#8b949e]">Target download folder:</p>
            <div className="mt-2 p-2.5 rounded-lg bg-[#161b22] border border-[#21262d] text-xs font-mono text-[#c9d1d9] break-all">
              {settings?.download_dir || './downloads'}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-[#21262d] space-y-1.5 text-[11px] text-[#8b949e]">
            <div className="flex justify-between">
              <span>Naming pattern:</span>
              <span className="font-mono text-[#c9d1d9] truncate max-w-[140px]">
                {settings?.filename_template || '%(title)s.%(ext)s'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Thumbnail embed:</span>
              <span className="text-[#3fb950]">{settings?.embed_thumbnail ? 'Yes' : 'No'}</span>
            </div>
            <div className="flex justify-between">
              <span>Metadata tag:</span>
              <span className="text-[#3fb950]">{settings?.embed_metadata ? 'Yes' : 'No'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
