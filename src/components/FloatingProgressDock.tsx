import React, { useState } from 'react';
import {
  Download,
  Pause,
  Play,
  X,
  ChevronDown,
  ChevronUp,
  Activity,
  CheckCircle,
  ExternalLink,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { formatBytes } from '../utils/engine-parser';

interface FloatingProgressDockProps {
  tasks: DownloadTask[];
  onPauseTask: (id: string) => void;
  onResumeTask: (id: string) => void;
  onCancelTask: (id: string) => void;
  onOpenQueue: () => void;
}

export const FloatingProgressDock: React.FC<FloatingProgressDockProps> = ({
  tasks,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onOpenQueue,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const activeTasks = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'extracting' || t.status === 'processing'
  );

  if (activeTasks.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-80 md:w-96 z-40 select-none shadow-2xl transition-all">
      <div className="rounded-xl border border-[#30363d] bg-[#12151a]/95 backdrop-blur-md overflow-hidden">
        {/* Dock Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 bg-[#0d1117] border-b border-[#21262d]">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-[#58a6ff] animate-pulse" />
            <span className="text-xs font-semibold text-white">Active Transference</span>
            <span className="px-1.5 py-0.2 text-[10px] font-mono rounded bg-[#1f6feb] text-white">
              {activeTasks.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              aria-label={isExpanded ? 'Collapse progress popup' : 'Expand progress popup'}
              className="p-1 text-[#8b949e] hover:text-white rounded transition-colors"
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Collapsible Body */}
        {isExpanded && (
          <div className="p-3 space-y-2.5 max-h-72 overflow-y-auto">
            {activeTasks.slice(0, 4).map((task) => (
              <div
                key={task.id}
                className="p-2.5 rounded-lg border border-[#21262d] bg-[#161b22] space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate">
                    {task.thumbnail ? (
                      <img
                        src={task.thumbnail}
                        alt={task.title}
                        referrerPolicy="no-referrer"
                        className="w-8 h-6 object-cover rounded bg-[#0d1117] shrink-0 border border-[#21262d]"
                      />
                    ) : (
                      <div className="w-8 h-6 rounded bg-[#21262d] flex items-center justify-center shrink-0 text-[8px] font-mono text-[#8b949e]">
                        {task.ext.toUpperCase()}
                      </div>
                    )}
                    <span className="text-xs font-medium text-white truncate max-w-[170px]">
                      {task.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {task.status === 'downloading' || task.status === 'extracting' || task.status === 'processing' ? (
                      <button
                        onClick={() => onPauseTask(task.id)}
                        title="Pause"
                        className="p-1 text-[#8b949e] hover:text-[#d29922] rounded transition-colors"
                      >
                        <Pause className="w-3 h-3" />
                      </button>
                    ) : task.status === 'paused' ? (
                      <button
                        onClick={() => onResumeTask(task.id)}
                        title="Resume"
                        className="p-1 text-[#8b949e] hover:text-[#3fb950] rounded transition-colors"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    ) : null}
                    <button
                      onClick={() => onCancelTask(task.id)}
                      title="Cancel"
                      className="p-1 text-[#8b949e] hover:text-[#f85149] rounded transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1 bg-[#21262d] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#1f6feb] transition-all duration-300 rounded-full"
                    style={{ width: `${Math.min(100, Math.max(2, task.progress_percentage))}%` }}
                  />
                </div>

                {/* Telemetry info */}
                <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
                  <span>{task.speed_str || task.current_phase}</span>
                  <div className="flex items-center gap-2">
                    {task.eta_str && <span>ETA {task.eta_str}</span>}
                    <span className="text-white font-medium">
                      {task.progress_percentage.toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}

            {activeTasks.length > 4 && (
              <button
                onClick={onOpenQueue}
                className="w-full py-1 text-center text-[11px] text-[#58a6ff] hover:underline"
              >
                + {activeTasks.length - 4} more transfers (Open Queue)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
