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
  DownloadCloud,
  ShieldCheck,
} from 'lucide-react';
import { DownloadTask, EngineStatusMap, AppSettings, EngineInstallProgress } from '../types';
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
  isRefreshingEngines?: boolean;
  onClearFailed?: () => void;
  installProgress?: Record<string, EngineInstallProgress>;
  isInstallingEngines?: boolean;
  engineInstallError?: string | null;
  onInstallEngines?: () => void;
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
  isRefreshingEngines = false,
  onClearFailed,
  installProgress = {},
  isInstallingEngines = false,
  engineInstallError = null,
  onInstallEngines,
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

  const missingRequired: string[] = [];
  if (engineStatus) {
    if (!engineStatus.ytdlp.available && engineStatus.ytdlp.status !== 'checking') {
      missingRequired.push('yt-dlp');
    }
    if (!engineStatus.ffmpeg.available && engineStatus.ffmpeg.status !== 'checking') {
      missingRequired.push('FFmpeg');
    }
    if (!engineStatus.ffprobe.available && engineStatus.ffprobe.status !== 'checking') {
      missingRequired.push('FFprobe');
    }
  }
  const activeInstalls = Object.values(installProgress).filter(
    (p) => p.status !== 'ready' && p.status !== 'error'
  );
  const showManagedSetup =
    missingRequired.length > 0 || isInstallingEngines || Boolean(engineInstallError) || activeInstalls.length > 0;

  return (
    <div className="space-y-6">
      {/* Managed Engine Runtime Setup Banner */}
      {showManagedSetup && onInstallEngines && (
        <div className="p-4 sm:p-5 rounded-xl border border-[#1f6feb]/40 bg-[#121923] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-[#1f6feb]/15 text-[#58a6ff] shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Managed Engine Runtime {missingRequired.length > 0 ? 'Setup Required' : 'Installing'}
                </h2>
                <p className="text-xs text-[#8b949e] mt-0.5">
                  {missingRequired.length > 0
                    ? `Missing runtime tools (${missingRequired.join(', ')}). Download SHA-256 verified engines into your per-user app-data directory.`
                    : 'Downloading and verifying external media engines...'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onInstallEngines}
              disabled={isInstallingEngines}
              className="px-4 py-2 text-xs font-medium text-white bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 rounded-lg flex items-center justify-center gap-1.5 transition-colors shrink-0"
            >
              <DownloadCloud className={`w-4 h-4 ${isInstallingEngines ? 'animate-pulse' : ''}`} />
              <span>
                {isInstallingEngines
                  ? 'Installing Verified Engines...'
                  : engineInstallError
                  ? 'Retry Engine Setup'
                  : 'Install Verified Engines'}
              </span>
            </button>
          </div>

          {Object.values(installProgress).length > 0 && (
            <div className="space-y-2 pt-1">
              {Object.values(installProgress).map((prog) => (
                <div key={prog.engine} className="p-2.5 rounded-lg bg-[#0d1117] border border-[#21262d] space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-white font-semibold uppercase">{prog.engine}</span>
                    <span className={prog.status === 'error' ? 'text-[#f85149]' : prog.status === 'ready' ? 'text-[#3fb950]' : 'text-[#58a6ff]'}>
                      {prog.phase} ({prog.progressPercentage.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-[#21262d] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 rounded-full ${
                        prog.status === 'error' ? 'bg-[#f85149]' : prog.status === 'ready' ? 'bg-[#3fb950]' : 'bg-[#1f6feb]'
                      }`}
                      style={{ width: `${Math.min(100, Math.max(2, prog.progressPercentage))}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
                    <span className="truncate">{prog.message}</span>
                    {prog.totalBytes > 0 && (
                      <span className="shrink-0 ml-2">
                        {formatBytes(prog.downloadedBytes)} / {formatBytes(prog.totalBytes)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {engineInstallError && (
            <p className="text-xs text-[#f85149] bg-[#da3633]/10 border border-[#da3633]/30 rounded-lg p-2.5 font-mono">
              {engineInstallError}
            </p>
          )}
        </div>
      )}
      {/* Top Banner / Welcome Action Strip */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4 p-4 sm:p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">VANTA Workstation</h1>
          <p className="text-xs text-[#8b949e] mt-1">
            High-concurrency media ingestion and audio conversion pipeline
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center">
          <button
            onClick={onViewQueue}
            className="px-3 py-2 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors whitespace-nowrap text-center justify-center flex items-center"
          >
            View Queue ({tasks.length})
          </button>
          <button
            onClick={onOpenNewDownload}
            className="px-4 py-2 text-xs font-medium text-white bg-[#238636] hover:bg-[#2ea043] rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-sm whitespace-nowrap text-center"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>New Download</span>
          </button>
        </div>
      </div>

      {/* KPI Real Data Metric Strip - 2x2 grid on mobile, 4 columns on large screens */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        {/* Metric 1: Aggregate Speed */}
        <div className="p-3 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-[11px] sm:text-xs text-[#8b949e]">
            <span className="truncate">Current Speed</span>
            <Activity className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#58a6ff] shrink-0" />
          </div>
          <div className="mt-1.5 sm:mt-2 text-base sm:text-2xl font-bold font-mono tracking-tight text-white tabular-nums truncate">
            {formattedSpeed}
          </div>
          <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] text-[#7d8590] truncate">
            {activeTasks.length} active transfer{activeTasks.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Metric 2: Total Downloaded */}
        <div className="p-3 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-[11px] sm:text-xs text-[#8b949e]">
            <span className="truncate">Downloaded</span>
            <ArrowDownCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#3fb950] shrink-0" />
          </div>
          <div className="mt-1.5 sm:mt-2 text-base sm:text-2xl font-bold font-mono tracking-tight text-white tabular-nums truncate">
            {formatBytes(totalBytesDownloaded)}
          </div>
          <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] text-[#7d8590] truncate">
            {completedTasks.length} completed items
          </div>
        </div>

        {/* Metric 3: Queued & Pending */}
        <div className="p-3 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-[11px] sm:text-xs text-[#8b949e]">
            <span className="truncate">In Queue</span>
            <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#d29922] shrink-0" />
          </div>
          <div className="mt-1.5 sm:mt-2 text-base sm:text-2xl font-bold font-mono tracking-tight text-white tabular-nums truncate">
            {queuedTasks.length}
          </div>
          <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] text-[#7d8590] truncate">
            Limit: {settings?.max_concurrent_downloads || 3}
          </div>
        </div>

        {/* Metric 4: Failed / Errors */}
        <div className="p-3 sm:p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between text-[11px] sm:text-xs text-[#8b949e]">
            <span className="truncate">Failed</span>
            <AlertCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#f85149] shrink-0" />
          </div>
          <div className="mt-1.5 sm:mt-2 flex items-baseline justify-between gap-2">
            <span className="text-base sm:text-2xl font-bold font-mono tracking-tight text-white tabular-nums truncate">
              {failedTasks.length}
            </span>
            {failedTasks.length > 0 && onClearFailed && (
              <button
                type="button"
                onClick={onClearFailed}
                title="Clear failed tasks"
                className="text-[10px] text-[#f85149] hover:underline font-mono shrink-0 cursor-pointer"
              >
                Clear Failed
              </button>
            )}
          </div>
          <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] text-[#7d8590] truncate">
            Retry: {settings?.auto_retry_failed ? 'Enabled' : 'Disabled'}
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
                className="p-3 sm:p-3.5 rounded-lg border border-[#30363d] bg-[#161b22] space-y-2.5"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3">
                  <div className="flex items-center gap-2.5 sm:gap-3 overflow-hidden min-w-0 flex-1">
                    {task.thumbnail ? (
                      <img
                        src={task.thumbnail}
                        alt={task.title}
                        referrerPolicy="no-referrer"
                        className="w-12 h-8 sm:w-14 sm:h-9 object-cover rounded bg-[#0d1117] shrink-0 border border-[#21262d]"
                      />
                    ) : (
                      <div className="w-12 h-8 sm:w-14 sm:h-9 rounded bg-[#21262d] flex items-center justify-center shrink-0 text-[10px] font-mono text-[#8b949e]">
                        {task.ext.toUpperCase()}
                      </div>
                    )}
                    <div className="truncate min-w-0 flex-1">
                      <span className="text-xs font-medium text-white truncate block">
                        {task.title}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] sm:text-[11px] text-[#8b949e] mt-0.5 font-mono">
                        <span className="px-1 py-0.2 rounded bg-[#21262d] text-[#c9d1d9]">{task.engine}</span>
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

                  <div className="flex items-center justify-end gap-1.5 shrink-0 self-end sm:self-auto">
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
        {/* Card 1: Engines */}
        <div className="md:col-span-2 p-4 sm:p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Engine Health Matrix</h2>
              <p className="text-xs text-[#8b949e] mt-0.5">
                Core command-line tools inspected in system PATH
              </p>
            </div>
            <button
              onClick={onRefreshEngines}
              disabled={isRefreshingEngines}
              title="Refresh engines status"
              className="p-1.5 text-[#8b949e] hover:text-white disabled:opacity-50 hover:bg-[#21262d] rounded transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingEngines ? 'animate-spin text-[#58a6ff]' : ''}`} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5">
            {[
              { key: 'ytdlp', label: 'yt-dlp', info: engineStatus?.ytdlp },
              { key: 'spotdl', label: 'spotDL', info: engineStatus?.spotdl },
              { key: 'ffmpeg', label: 'FFmpeg', info: engineStatus?.ffmpeg },
              { key: 'ffprobe', label: 'FFprobe', info: engineStatus?.ffprobe },
            ].map(({ key, label, info }) => {
              const st = info?.status || 'checking';
              const badgeClass = info?.available
                ? 'bg-[#238636]/15 text-[#3fb950]'
                : st === 'checking'
                ? 'bg-[#1f6feb]/15 text-[#58a6ff]'
                : st === 'timed_out'
                ? 'bg-[#d29922]/15 text-[#e3b341]'
                : 'bg-[#da3633]/15 text-[#f85149]';
              const versionText = info?.version
                ? info.version
                : st === 'checking'
                ? 'Checking...'
                : st === 'timed_out'
                ? 'Version check timed out'
                : 'Not installed';
              const pathText = info?.path
                ? info.path
                : st === 'checking'
                ? 'Scanning local paths...'
                : 'Unavailable';

              return (
                <div key={key} className="p-3 rounded-lg border border-[#21262d] bg-[#161b22]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">{label}</span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${badgeClass}`}>
                      {st}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-[#8b949e] mt-1.5 truncate">
                    {versionText}
                  </p>
                  <p className="text-[10px] font-mono text-[#6e7681] truncate mt-0.5">
                    {pathText}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Card 2: Destination Storage */}
        <div className="p-4 sm:p-5 rounded-xl border border-[#21262d] bg-[#12151a] flex flex-col justify-between">
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
