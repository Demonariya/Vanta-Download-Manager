import React, { useState, useEffect } from 'react';
import {
  Terminal,
  Play,
  CheckCircle,
  XCircle,
  ArrowUpCircle,
  RefreshCw,
  Check,
  AlertCircle,
  FileText,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import {
  EngineStatusMap,
  DiagnosticResult,
  EngineUpdateResult,
  EngineInstallProgress,
  DiagnosticLogInfo,
} from '../types';
import { api } from '../services/api';
import { ConfirmDialog } from './ConfirmDialog';

interface DiagnosticsViewProps {
  engineStatus: EngineStatusMap | null;
  onRefresh: () => void;
  installProgress?: Record<string, EngineInstallProgress>;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  engineStatus,
  onRefresh,
  installProgress = {},
}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<DiagnosticResult[] | null>(null);

  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updatesInfo, setUpdatesInfo] = useState<
    Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }> | null
  >(null);
  const [updatingEngine, setUpdatingEngine] = useState<string | null>(null);
  const [updateResults, setUpdateResults] = useState<EngineUpdateResult[] | null>(null);
  const [logInfo, setLogInfo] = useState<DiagnosticLogInfo | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const loadDiagnosticLogs = async () => {
    setIsLoadingLogs(true);
    try {
      const info = await api.getDiagnosticLogInfo(100);
      setLogInfo(info);
    } catch (err) {
      console.error('Failed to load application logs:', err);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  const handleRunDiagnostics = async () => {
    setIsRunning(true);
    try {
      const res = await api.runDiagnostics();
      setResults(res.results);
      onRefresh();
    } catch {
      // ignore
    } finally {
      setIsRunning(false);
    }
  };

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    setUpdateResults(null);
    try {
      const data = await api.checkEngineUpdates();
      setUpdatesInfo(data);
    } catch (err) {
      console.error('Failed to check engine updates:', err);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleUpdateEngine = async (name: string) => {
    setUpdatingEngine(name);
    try {
      const res = await api.updateEngine(name);
      setUpdateResults((prev) =>
        prev ? [...prev.filter((r) => r.engine !== res.engine), res] : [res]
      );
      onRefresh();
      handleCheckUpdates();
    } catch (err: any) {
      setUpdateResults((prev) => [
        ...(prev || []),
        {
          engine: name,
          success: false,
          previousVersion: '',
          currentVersion: '',
          message: err.message || 'Update failed',
        },
      ]);
    } finally {
      setUpdatingEngine(null);
    }
  };

  const handleRemoveEngine = async (name: string) => {
    setUpdatingEngine(name);
    try {
      const res = await api.removeManagedEngine(name);
      setUpdateResults((prev) =>
        prev ? [...prev.filter((r) => r.engine !== res.engine), res] : [res]
      );
      onRefresh();
    } catch (err: any) {
      setUpdateResults((prev) => [
        ...(prev || []),
        {
          engine: name,
          success: false,
          previousVersion: '',
          currentVersion: '',
          message: err.message || 'Removal failed',
        },
      ]);
    } finally {
      setUpdatingEngine(null);
    }
  };

  const handleUpdateAll = async () => {
    setUpdatingEngine('all');
    try {
      const res = await api.updateAllEngines();
      setUpdateResults(res.results);
      onRefresh();
      handleCheckUpdates();
    } catch (err: any) {
      console.error('Update all failed:', err);
    } finally {
      setUpdatingEngine(null);
    }
  };

  useEffect(() => {
    handleCheckUpdates();
    loadDiagnosticLogs();
  }, []);

  return (
    <div className="space-y-5">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
        <div>
          <h1 className="text-base font-semibold text-[var(--vanta-text)]">
            Diagnostics &amp; Managed Engines
          </h1>
          <p className="text-xs text-[var(--vanta-muted)] mt-0.5">
            Inspect binary paths, verify SHA-256 releases, run health checks, and view redacted logs
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCheckUpdates}
            disabled={isCheckingUpdates || Boolean(updatingEngine)}
            className="px-3 py-1.5 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-50 border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdates ? 'animate-spin' : ''}`} />
            <span>{isCheckingUpdates ? 'Checking...' : 'Check Updates'}</span>
          </button>

          <button
            type="button"
            onClick={handleUpdateAll}
            disabled={Boolean(updatingEngine) || isCheckingUpdates}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <ArrowUpCircle className={`w-3.5 h-3.5 ${updatingEngine === 'all' ? 'animate-spin' : ''}`} />
            <span>{updatingEngine === 'all' ? 'Upgrading...' : 'Upgrade All'}</span>
          </button>

          <button
            type="button"
            onClick={handleRunDiagnostics}
            disabled={isRunning}
            className="px-3.5 py-1.5 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Running...' : 'Run Diagnostics'}</span>
          </button>
        </div>
      </div>

      {/* Update Action Results */}
      {updateResults && updateResults.length > 0 && (
        <div className="space-y-2">
          {updateResults.map((r, i) => (
            <div
              key={i}
              className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                r.success
                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-700 dark:text-[#3fb950]'
                  : 'bg-red-500/10 border-red-500/35 text-red-600 dark:text-[#f85149]'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {r.success ? <Check className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span className="font-semibold uppercase font-mono">{r.engine}:</span>
                <span className="break-words">{r.message}</span>
              </div>
              {r.rolledBack && (
                <span className="text-[10px] font-mono text-amber-600 dark:text-[#e3b341] shrink-0">
                  ROLLED BACK
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Engine Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {engineStatus &&
          Object.entries(engineStatus).map(([key, info]) => {
            const isReady = info.available;
            const updateData = updatesInfo ? updatesInfo[key] : null;
            const hasUpdate = updateData?.updateAvailable;
            const isThisUpdating = updatingEngine === key;
            const canManageInApp =
              key === 'ytdlp' || key === 'spotdl' || key === 'ffmpeg' || key === 'ffprobe';
            const progressKey = key === 'ytdlp' ? 'yt-dlp' : key === 'ffprobe' ? 'ffmpeg' : key;
            const prog = installProgress[progressKey];

            return (
              <div
                key={key}
                className="p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-3 flex flex-col justify-between"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-[var(--vanta-accent)]" />
                      <span className="text-xs font-semibold uppercase text-[var(--vanta-text)] font-mono">
                        {key}
                      </span>
                      {hasUpdate && (
                        <span className="text-[10px] font-mono text-[var(--vanta-accent)]">
                          · Update Available
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[11px] font-mono font-medium ${
                        isReady
                          ? 'text-emerald-700 dark:text-[#3fb950]'
                          : info.status === 'checking'
                          ? 'text-[var(--vanta-accent)]'
                          : info.status === 'timed_out'
                          ? 'text-amber-600 dark:text-[#e3b341]'
                          : 'text-red-600 dark:text-[#f85149]'
                      }`}
                    >
                      {isReady
                        ? 'OPERATIONAL'
                        : info.status === 'checking'
                        ? 'CHECKING'
                        : info.status === 'timed_out'
                        ? 'TIMED OUT'
                        : 'UNAVAILABLE'}
                    </span>
                  </div>

                  <div className="space-y-1 text-xs font-mono tabular-nums">
                    <div className="flex justify-between gap-2 text-[var(--vanta-muted)]">
                      <span>Installed:</span>
                      <span className="text-[var(--vanta-text)] truncate max-w-[240px]">
                        {info.version || 'Not installed'}
                      </span>
                    </div>
                    {updateData && (
                      <div className="flex justify-between gap-2 text-[var(--vanta-muted)]">
                        <span>Latest:</span>
                        <span className="text-[var(--vanta-accent)] truncate max-w-[240px]">
                          {updateData.latestVersion || 'Checking...'}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between gap-2 text-[var(--vanta-muted)]">
                      <span>Binary Path:</span>
                      <span
                        className="text-[var(--vanta-text-secondary)] truncate max-w-[240px]"
                        title={info.path || undefined}
                      >
                        {info.path || 'Not detected'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 text-[var(--vanta-muted)]">
                      <span>Checked:</span>
                      <span>{new Date(info.lastChecked).toLocaleTimeString()}</span>
                    </div>
                  </div>

                  {prog && prog.status !== 'ready' && (
                    <div className="space-y-1 p-2 rounded bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)]">
                      <div className="flex justify-between text-[10px] font-mono tabular-nums">
                        <span className="text-[var(--vanta-accent)]">{prog.phase}</span>
                        <span className="text-[var(--vanta-text)]">
                          {prog.progressPercentage.toFixed(0)}%
                        </span>
                      </div>
                      <div className="w-full h-1 bg-[var(--vanta-border)] rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-[var(--vanta-accent)] transition-all duration-200"
                          style={{ width: `${Math.min(100, Math.max(2, prog.progressPercentage))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {info.error && (
                    <p className="text-[11px] text-red-600 dark:text-[#f85149] bg-red-500/10 p-2 rounded border border-red-500/30 font-mono break-words">
                      {info.error}
                    </p>
                  )}
                </div>

                {canManageInApp && (
                  <div className="pt-2.5 border-t border-[var(--vanta-border)] flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[var(--vanta-muted)]">
                      Managed Runtime
                    </span>
                    <div className="flex items-center gap-1.5">
                      {isReady && (
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(key)}
                          disabled={Boolean(updatingEngine)}
                          title="Remove managed binary"
                          className="p-1.5 rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] hover:bg-red-500/10 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleUpdateEngine(key)}
                        disabled={Boolean(updatingEngine)}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                          !isReady || hasUpdate
                            ? 'bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white'
                            : 'bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)]'
                        }`}
                      >
                        <ArrowUpCircle className={`w-3.5 h-3.5 ${isThisUpdating ? 'animate-spin' : ''}`} />
                        <span>
                          {isThisUpdating
                            ? 'Installing...'
                            : !isReady
                            ? 'Install'
                            : hasUpdate
                            ? 'Upgrade'
                            : 'Reinstall'}
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {/* Diagnostic Execution Results */}
      {results && (
        <div className="p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase font-mono text-[var(--vanta-text)]">
              Diagnostic Execution Results
            </h2>
            <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-[#3fb950]">
              {results.filter((r) => r.passed).length}/{results.length} passed
            </span>
          </div>

          <div className="space-y-2">
            {results.map((res) => (
              <div
                key={res.engine}
                className="p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {res.passed ? (
                      <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-[#3fb950]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-600 dark:text-[#f85149]" />
                    )}
                    <span className="text-xs font-semibold text-[var(--vanta-text)] font-mono">
                      {res.engine}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-[var(--vanta-muted)]">
                    {res.duration_ms}ms
                  </span>
                </div>
                <div className="p-2 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] font-mono text-[11px] text-[var(--vanta-text-secondary)] overflow-x-auto whitespace-pre">
                  {res.output}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Application Logs */}
      <div className="p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div>
            <h2 className="text-xs font-semibold uppercase font-mono text-[var(--vanta-text)] flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--vanta-accent)]" />
              <span>Application Logs (Redacted)</span>
            </h2>
            {logInfo && (
              <p className="text-[11px] font-mono tabular-nums text-[var(--vanta-muted)] mt-1 break-all">
                {logInfo.logPath} ({Math.max(1, Math.round(logInfo.fileSizeBytes / 1024))} KiB)
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={loadDiagnosticLogs}
              disabled={isLoadingLogs}
              className="px-2.5 py-1.5 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-50 border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded-lg text-[11px] font-medium flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingLogs ? 'animate-spin' : ''}`} />
              <span>{isLoadingLogs ? 'Refreshing...' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              onClick={() => api.openLogsFolder()}
              className="px-2.5 py-1.5 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded-lg text-[11px] font-medium flex items-center gap-1.5 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Open Logs Folder</span>
            </button>
          </div>
        </div>

        <div className="p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] font-mono text-[11px] text-[var(--vanta-text-secondary)] max-h-64 overflow-auto whitespace-pre-wrap break-words leading-relaxed">
          {logInfo && logInfo.recentLines.length > 0
            ? logInfo.recentLines.join('\n')
            : isLoadingLogs
            ? 'Loading sanitized diagnostic log...'
            : 'No application log entries recorded yet.'}
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(removeTarget)}
        title={`Remove Managed ${removeTarget || ''}`}
        message={`Remove the VANTA-managed ${removeTarget} binary from the local engine directory? System PATH binaries (if installed separately) are not deleted.`}
        confirmLabel="Remove Binary"
        danger
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) handleRemoveEngine(target);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
};
