import React, { useState, useEffect } from 'react';
import {
  Terminal,
  ShieldCheck,
  AlertTriangle,
  Play,
  RotateCw,
  Clock,
  HardDrive,
  Cpu,
  CheckCircle,
  XCircle,
  ArrowUpCircle,
  RefreshCw,
  Check,
  AlertCircle,
  Shield,
  LifeBuoy,
} from 'lucide-react';
import { EngineStatusMap, DiagnosticResult, EngineUpdateResult } from '../types';
import { api } from '../services/api';

interface DiagnosticsViewProps {
  engineStatus: EngineStatusMap | null;
  onRefresh: () => void;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  engineStatus,
  onRefresh,
}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<DiagnosticResult[] | null>(null);

  // Engine Updates State
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updatesInfo, setUpdatesInfo] = useState<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }> | null>(null);
  const [updatingEngine, setUpdatingEngine] = useState<string | null>(null);
  const [updateResults, setUpdateResults] = useState<EngineUpdateResult[] | null>(null);

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
      setUpdateResults((prev) => (prev ? [...prev.filter((r) => r.engine !== res.engine), res] : [res]));
      onRefresh();
      // Re-check updates after upgrading
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
    // Initial update check on mount
    handleCheckUpdates();
  }, []);

  return (
    <div className="space-y-5">
      {/* Top Banner with Action Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">Diagnostics & Engine Health</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Real binary inspection, version validation, and pipeline test suite
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleCheckUpdates}
            disabled={isCheckingUpdates || Boolean(updatingEngine)}
            className="px-3 py-2 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-50 text-[#c9d1d9] rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdates ? 'animate-spin text-[#58a6ff]' : ''}`} />
            <span>{isCheckingUpdates ? 'Checking...' : 'Check Updates'}</span>
          </button>

          <button
            onClick={handleUpdateAll}
            disabled={Boolean(updatingEngine) || isCheckingUpdates}
            className="px-3 py-2 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
          >
            <ArrowUpCircle className={`w-3.5 h-3.5 ${updatingEngine === 'all' ? 'animate-spin' : ''}`} />
            <span>{updatingEngine === 'all' ? 'Upgrading All...' : 'Upgrade All Engines'}</span>
          </button>

          <button
            onClick={handleRunDiagnostics}
            disabled={isRunning}
            className="px-4 py-2 bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-2 transition-colors shrink-0"
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Running Tests...' : 'Run Diagnostics'}</span>
          </button>
        </div>
      </div>

      {/* Update Results Banner if any action occurred */}
      {updateResults && updateResults.length > 0 && (
        <div className="space-y-2">
          {updateResults.map((r, i) => (
            <div
              key={i}
              className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                r.success
                  ? 'bg-[#238636]/15 border-[#238636]/30 text-[#3fb950]'
                  : 'bg-[#da3633]/15 border-[#da3633]/30 text-[#f85149]'
              }`}
            >
              <div className="flex items-center gap-2">
                {r.success ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                <span className="font-semibold uppercase font-mono">{r.engine}:</span>
                <span>{r.message}</span>
              </div>
              {r.rolledBack && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#d29922]/20 text-[#d29922]">
                  ROLLED BACK
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Engine Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {engineStatus &&
          Object.entries(engineStatus).map(([key, info]) => {
            const isReady = info.available;
            const updateData = updatesInfo ? updatesInfo[key] : null;
            const hasUpdate = updateData?.updateAvailable;
            const isThisUpdating = updatingEngine === key;
            const canUpdateInApp = key === 'ytdlp' || key === 'spotdl';

            return (
              <div
                key={key}
                className="p-4 rounded-xl border border-[#21262d] bg-[#12151a] space-y-3 flex flex-col justify-between"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-[#58a6ff]" />
                      <span className="text-xs font-semibold uppercase text-white font-mono">{key}</span>
                      {hasUpdate && (
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/40">
                          Update Available
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                        isReady
                          ? 'bg-[#238636]/15 text-[#3fb950]'
                          : 'bg-[#da3633]/15 text-[#f85149]'
                      }`}
                    >
                      {isReady ? 'OPERATIONAL' : 'UNAVAILABLE'}
                    </span>
                  </div>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-[#8b949e]">
                      <span>Installed Version:</span>
                      <span className="font-mono text-[#e6edf3] truncate max-w-[240px]">
                        {info.version || 'N/A'}
                      </span>
                    </div>

                    {updateData && (
                      <div className="flex justify-between text-[#8b949e]">
                        <span>Latest Release:</span>
                        <span className="font-mono text-[#58a6ff] truncate max-w-[240px]">
                          {updateData.latestVersion || 'Checking...'}
                        </span>
                      </div>
                    )}

                    <div className="flex justify-between text-[#8b949e]">
                      <span>Binary Path:</span>
                      <span className="font-mono text-[#c9d1d9] truncate max-w-[240px]">
                        {info.path || 'Not detected'}
                      </span>
                    </div>
                    <div className="flex justify-between text-[#8b949e]">
                      <span>Health Check:</span>
                      <span className="font-mono text-[#7d8590]">
                        {new Date(info.lastChecked).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>

                  {info.error && (
                    <p className="text-[11px] text-[#f85149] bg-[#da3633]/10 p-2 rounded border border-[#da3633]/30 font-mono">
                      {info.error}
                    </p>
                  )}
                </div>

                {/* Engine Card Action Footer */}
                {canUpdateInApp && (
                  <div className="pt-2 border-t border-[#21262d] flex items-center justify-between">
                    <span className="text-[11px] text-[#7d8590]">Automated In-App Upgrade</span>
                    <button
                      onClick={() => handleUpdateEngine(key)}
                      disabled={Boolean(updatingEngine)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                        hasUpdate
                          ? 'bg-[#1f6feb] hover:bg-[#388bfd] text-white'
                          : 'bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9]'
                      }`}
                    >
                      <ArrowUpCircle className={`w-3.5 h-3.5 ${isThisUpdating ? 'animate-spin' : ''}`} />
                      <span>{isThisUpdating ? 'Upgrading...' : hasUpdate ? 'Upgrade Now' : 'Reinstall / Verify'}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {/* HTTP 410 Recovery & Fault-Tolerance Policy Card */}
      <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a] space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#3fb950]" />
          <h2 className="text-xs font-semibold text-white uppercase font-mono">
            Fault-Tolerance & Error Recovery Engine
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-2.5 rounded-lg border border-[#21262d] bg-[#161b22] space-y-1">
            <span className="text-[11px] font-semibold text-[#58a6ff]">HTTP 410 & Expired URLs</span>
            <p className="text-[11px] text-[#8b949e] leading-relaxed">
              Detects expired player stream tokens; flushes stale extraction cache; retrieves fresh tokens without terminating queued downloads.
            </p>
          </div>
          <div className="p-2.5 rounded-lg border border-[#21262d] bg-[#161b22] space-y-1">
            <span className="text-[11px] font-semibold text-[#d29922]">HTTP 429 & Rate Limits</span>
            <p className="text-[11px] text-[#8b949e] leading-relaxed">
              Applies exponential backoff with randomized jitter (5s–60s) to prevent temporary IP throttles and bot challenges.
            </p>
          </div>
          <div className="p-2.5 rounded-lg border border-[#21262d] bg-[#161b22] space-y-1">
            <span className="text-[11px] font-semibold text-[#3fb950]">Log Redaction & Privacy</span>
            <p className="text-[11px] text-[#8b949e] leading-relaxed">
              All process outputs, query parameters, auth tokens, and session cookies are cryptographically sanitized before storage.
            </p>
          </div>
        </div>
      </div>

      {/* Diagnostics Test Execution Results */}
      {results && (
        <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase font-mono text-[#c9d1d9]">
              Diagnostic Execution Results
            </h2>
            <span className="text-xs font-mono text-[#3fb950]">
              {results.filter((r) => r.passed).length}/{results.length} tests passed
            </span>
          </div>

          <div className="space-y-2.5">
            {results.map((res) => (
              <div
                key={res.engine}
                className="p-3 rounded-lg border border-[#30363d] bg-[#161b22] space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {res.passed ? (
                      <CheckCircle className="w-4 h-4 text-[#3fb950]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#f85149]" />
                    )}
                    <span className="text-xs font-semibold text-white font-mono">{res.engine}</span>
                  </div>
                  <span className="text-[11px] font-mono text-[#8b949e]">
                    {res.duration_ms}ms
                  </span>
                </div>

                <div className="p-2 rounded bg-[#0d1117] font-mono text-[11px] text-[#c9d1d9] overflow-x-auto whitespace-pre">
                  {res.output}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
