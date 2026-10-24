import React, { useState } from 'react';
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
} from 'lucide-react';
import { EngineStatusMap, DiagnosticResult } from '../types';
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

  return (
    <div className="space-y-5">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">Diagnostics & Engine Health</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Real binary inspection, version validation, and pipeline test suite
          </p>
        </div>

        <button
          onClick={handleRunDiagnostics}
          disabled={isRunning}
          className="px-4 py-2 bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-2 transition-colors shrink-0"
        >
          <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
          <span>{isRunning ? 'Running Pipeline Tests...' : 'Run Diagnostics Test'}</span>
        </button>
      </div>

      {/* Engine Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {engineStatus &&
          Object.entries(engineStatus).map(([key, info]) => {
            const isReady = info.available;
            return (
              <div
                key={key}
                className="p-4 rounded-xl border border-[#21262d] bg-[#12151a] space-y-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-[#58a6ff]" />
                    <span className="text-xs font-semibold uppercase text-white font-mono">{key}</span>
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
                    <span>Version:</span>
                    <span className="font-mono text-[#e6edf3] truncate max-w-[260px]">
                      {info.version || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#8b949e]">
                    <span>Binary Path:</span>
                    <span className="font-mono text-[#c9d1d9] truncate max-w-[260px]">
                      {info.path || 'Not detected'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[#8b949e]">
                    <span>Last Checked:</span>
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
            );
          })}
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
