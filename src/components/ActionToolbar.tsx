import React, { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { DownloadTask } from '../types';

interface ActionToolbarProps {
  selectedTask: DownloadTask | null;
  activeCount: number;
  pausedCount: number;
  onPauseSelected: () => void;
  onResumeSelected: () => void;
  onRetrySelected: () => void;
  onDeleteSelected: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
}

interface ToolbarButtonProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}

type ToolbarActionId = 'resume' | 'pause' | 'retry' | 'pauseAll' | 'resumeAll' | 'delete';

const DEFAULT_ORDER: ToolbarActionId[] = [
  'resume', 'pause', 'retry', 'pauseAll', 'resumeAll', 'delete',
];
const DEFAULT_VISIBILITY: Record<ToolbarActionId, boolean> = {
  resume: true,
  pause: true,
  retry: true,
  pauseAll: true,
  resumeAll: true,
  delete: true,
};
const TOOLBAR_STORAGE_KEY = 'vanta.action-toolbar.v1';

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  label, icon: Icon, onClick, disabled = false, primary = false, danger = false,
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={
      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ' +
      (primary
        ? 'border-[var(--vanta-accent)] bg-[var(--vanta-accent)] text-white hover:bg-[var(--vanta-accent-hover)]'
        : danger
          ? 'border-red-500/25 text-red-500 hover:bg-red-500/10'
          : 'border-[var(--vanta-border)] bg-[var(--vanta-surface)] text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]')
    }
  >
    <Icon className="h-3.5 w-3.5" />
    <span>{label}</span>
  </button>
);

export const ActionToolbar: React.FC<ActionToolbarProps> = ({
  selectedTask, activeCount, pausedCount, onPauseSelected, onResumeSelected,
  onRetrySelected, onDeleteSelected, onPauseAll, onResumeAll,
}) => {
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [actionOrder, setActionOrder] = useState<ToolbarActionId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TOOLBAR_STORAGE_KEY) || '{}');
      const storedOrder: unknown[] = Array.isArray(saved?.order) ? saved.order : [];
      const validOrder = [...new Set(storedOrder.filter(
        (id): id is ToolbarActionId => typeof id === 'string' && DEFAULT_ORDER.includes(id as ToolbarActionId),
      ))];
      return [...validOrder, ...DEFAULT_ORDER.filter((id) => !validOrder.includes(id))];
    } catch {
      return DEFAULT_ORDER;
    }
  });
  const [visibility, setVisibility] = useState<Record<ToolbarActionId, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TOOLBAR_STORAGE_KEY) || '{}');
      const stored = saved?.visibility && typeof saved.visibility === 'object' && !Array.isArray(saved.visibility)
        ? saved.visibility as Record<string, unknown>
        : {};
      return Object.fromEntries(
        DEFAULT_ORDER.map((id) => [id, typeof stored[id] === 'boolean' ? stored[id] : DEFAULT_VISIBILITY[id]]),
      ) as Record<ToolbarActionId, boolean>;
    } catch {
      return DEFAULT_VISIBILITY;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify({ order: actionOrder, visibility }));
    } catch {
      // Keep toolbar usable when WebView storage is unavailable.
    }
  }, [actionOrder, visibility]);

  const canPause = Boolean(selectedTask && [
    'connecting', 'downloading', 'resuming', 'inspecting', 'processing', 'muxing', 'verifying', 'queued',
  ].includes(selectedTask.status));
  const canResume = selectedTask?.status === 'paused';
  const canRetry = selectedTask?.status === 'failed' || selectedTask?.status === 'cancelled';

  const actions: Record<ToolbarActionId, {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    onClick: () => void;
    disabled: boolean;
    danger?: boolean;
  }> = {
    resume: { label: 'Resume', icon: Play, onClick: onResumeSelected, disabled: !canResume },
    pause: { label: 'Pause', icon: Pause, onClick: onPauseSelected, disabled: !canPause },
    retry: { label: 'Retry', icon: RotateCcw, onClick: onRetrySelected, disabled: !canRetry },
    pauseAll: { label: 'Pause All', icon: Activity, onClick: onPauseAll, disabled: activeCount === 0 },
    resumeAll: { label: 'Resume All', icon: Check, onClick: onResumeAll, disabled: pausedCount === 0 },
    delete: { label: 'Delete Selected', icon: Trash2, onClick: onDeleteSelected, disabled: !selectedTask, danger: true },
  };

  const moveAction = (id: ToolbarActionId, direction: -1 | 1) => {
    setActionOrder((current) => {
      const index = current.indexOf(id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  return (
    <div className="relative flex min-h-11 shrink-0 items-center gap-1.5 overflow-visible border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-1.5 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {actionOrder.filter((id) => visibility[id]).map((id) => {
          const action = actions[id];
          return (
            <React.Fragment key={id}>
              {id === 'pauseAll' && <div className="mx-1 h-5 shrink-0 border-l border-[var(--vanta-border-strong)]" />}
              <ToolbarButton
                label={action.label}
                icon={action.icon}
                onClick={action.onClick}
                disabled={action.disabled}
                danger={action.danger}
              />
            </React.Fragment>
          );
        })}
      </div>

      <span className="hidden max-w-[28%] shrink truncate text-[10px] text-[var(--vanta-muted)] xl:block" title={selectedTask?.title || 'No download selected'}>
        {selectedTask?.title || 'No download selected'}
      </span>

      <button
        type="button"
        aria-label="Customize toolbar"
        aria-expanded={isCustomizeOpen}
        title="Customize toolbar"
        onClick={() => setIsCustomizeOpen((open) => !open)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface)] px-2.5 text-[11px] font-medium text-[var(--vanta-text-secondary)] transition-colors hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]"
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Customize</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${isCustomizeOpen ? 'rotate-180' : ''}`} />
      </button>

      {isCustomizeOpen && (
        <div className="absolute right-3 top-full z-50 mt-2 w-72 rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] p-3 shadow-2xl sm:right-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-[var(--vanta-text)]">Toolbar actions</h3>
              <p className="mt-0.5 text-[10px] text-[var(--vanta-muted)]">Show, hide, or reorder actions</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setActionOrder(DEFAULT_ORDER);
                setVisibility(DEFAULT_VISIBILITY);
              }}
              className="text-[10px] font-medium text-[var(--vanta-accent)] hover:underline"
            >
              Reset
            </button>
          </div>
          <div className="space-y-1">
            {actionOrder.map((id, index) => (
              <div key={id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--vanta-surface-hover)]">
                <input
                  type="checkbox"
                  aria-label={`Show ${actions[id].label}`}
                  checked={visibility[id]}
                  onChange={(event) => setVisibility((current) => ({ ...current, [id]: event.target.checked }))}
                  className="h-3.5 w-3.5 shrink-0 rounded accent-[var(--vanta-accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--vanta-text-secondary)]">{actions[id].label}</span>
                <button
                  type="button"
                  aria-label={`Move ${actions[id].label} up`}
                  disabled={index === 0}
                  onClick={() => moveAction(id, -1)}
                  className="rounded p-1 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-2)] hover:text-[var(--vanta-text)] disabled:opacity-25"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${actions[id].label} down`}
                  disabled={index === actionOrder.length - 1}
                  onClick={() => moveAction(id, 1)}
                  className="rounded p-1 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-2)] hover:text-[var(--vanta-text)] disabled:opacity-25"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
