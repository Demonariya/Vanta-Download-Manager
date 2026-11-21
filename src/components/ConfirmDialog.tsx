import React, { useState, useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  checkboxLabel?: string;
  defaultChecked?: boolean;
  onConfirm: (checked: boolean) => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  checkboxLabel,
  defaultChecked = false,
  onConfirm,
  onCancel,
}) => {
  const [checked, setChecked] = useState(defaultChecked);

  useEffect(() => {
    if (isOpen) {
      setChecked(defaultChecked);
    }
  }, [isOpen, defaultChecked]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-xs select-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vanta-confirm-title"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] shadow-2xl p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div
            className={`p-2 rounded-lg shrink-0 ${
              danger
                ? 'bg-red-500/12 text-red-600 dark:text-[#f85149]'
                : 'bg-blue-500/12 text-blue-600 dark:text-[#58a6ff]'
            }`}
          >
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 id="vanta-confirm-title" className="text-sm font-semibold text-[var(--vanta-text)]">
              {title}
            </h3>
            <p className="text-xs text-[var(--vanta-muted)] mt-1 leading-relaxed break-words">
              {message}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close confirmation dialog"
            className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {checkboxLabel && (
          <label className="flex items-center gap-2.5 p-2.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
            />
            <span className="text-xs text-[var(--vanta-text-secondary)]">{checkboxLabel}</span>
          </label>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs font-medium text-[var(--vanta-text-secondary)] bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(checked)}
            className={`px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
