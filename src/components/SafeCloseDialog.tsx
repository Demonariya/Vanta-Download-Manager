import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface SafeCloseDialogProps {
  isOpen: boolean;
  activeCount: number;
  onCancel: () => void;
  onConfirmExit: () => void;
}

export const SafeCloseDialog: React.FC<SafeCloseDialogProps> = ({
  isOpen,
  activeCount,
  onCancel,
  onConfirmExit,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs select-none">
      <div className="relative w-full max-w-md bg-[var(--vanta-surface)] border border-red-500/40 rounded-2xl shadow-2xl p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-red-500/12 text-red-600 dark:text-[#f85149] shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[var(--vanta-text)]">
              Active Downloads in Progress
            </h3>
            <p className="text-xs text-[var(--vanta-muted)] mt-1 leading-relaxed">
              There {activeCount === 1 ? 'is' : 'are'} currently{' '}
              <span className="font-semibold text-[var(--vanta-text)] font-mono tabular-nums">
                {activeCount}
              </span>{' '}
              active media {activeCount === 1 ? 'transfer' : 'transfers'} running. Closing VANTA now
              will cleanly pause and stop background extraction processes.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded transition-colors"
            aria-label="Cancel exit dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs text-[var(--vanta-text-secondary)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg transition-colors font-medium whitespace-nowrap shrink-0"
          >
            Stay in App
          </button>
          <button
            type="button"
            onClick={onConfirmExit}
            className="px-4 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Pause &amp; Exit
          </button>
        </div>
      </div>
    </div>
  );
};
