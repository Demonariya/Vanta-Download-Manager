import React, { useState } from 'react';
import { Pause, Play, X, ChevronDown, ChevronUp } from 'lucide-react';
import { DownloadTask } from '../types';
import { isActiveTaskStatus } from '../utils/download-core';
import { ProgressDisplay } from './ProgressDisplay';

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

  const activeTasks = tasks.filter((t) => isActiveTaskStatus(t.status));

  if (activeTasks.length === 0) return null;

  return (
    <div className="fixed bottom-3 right-3 left-3 sm:left-auto sm:right-4 sm:bottom-4 sm:w-80 md:w-96 z-30 select-none shadow-2xl">
      <div className="rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)]/95 backdrop-blur-md overflow-hidden">
        <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--vanta-surface-2)] border-b border-[var(--vanta-border)]">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--vanta-text)]">
            <span>Active Transfers</span>
            <span className="font-mono tabular-nums text-[var(--vanta-accent)]">
              ({activeTasks.length})
            </span>
          </div>

          <button
            type="button"
            onClick={() => setIsExpanded((v) => !v)}
            aria-label={isExpanded ? 'Collapse progress dock' : 'Expand progress dock'}
            className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded transition-colors"
          >
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
        </div>

        {isExpanded && (
          <div className="p-3 space-y-2.5 max-h-60 overflow-y-auto">
            {activeTasks.slice(0, 4).map((task) => (
              <div
                key={task.id}
                className="p-2.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--vanta-text)] truncate">
                    {task.title}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {isActiveTaskStatus(task.status) ? (
                      <button
                        type="button"
                        onClick={() => onPauseTask(task.id)}
                        title="Pause"
                        className="p-1 text-[var(--vanta-muted)] hover:text-amber-600 dark:hover:text-[#e3b341] rounded transition-colors"
                      >
                        <Pause className="w-3 h-3" />
                      </button>
                    ) : task.status === 'paused' ? (
                      <button
                        type="button"
                        onClick={() => onResumeTask(task.id)}
                        title="Resume"
                        className="p-1 text-[var(--vanta-muted)] hover:text-emerald-600 dark:hover:text-[#3fb950] rounded transition-colors"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onCancelTask(task.id)}
                      title="Cancel"
                      className="p-1 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] rounded transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <ProgressDisplay task={task} compact />
              </div>
            ))}

            {activeTasks.length > 4 && (
              <button
                type="button"
                onClick={onOpenQueue}
                className="w-full py-1 text-center text-[11px] text-[var(--vanta-accent)] hover:underline"
              >
                + {activeTasks.length - 4} more transfers (View Queue)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
