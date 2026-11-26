import React from 'react';
import { Clipboard, ArrowRight, X } from 'lucide-react';

interface ClipboardMonitorBannerProps {
  detectedUrl: string | null;
  onInspect: (url: string) => void;
  onDismiss: () => void;
}

export const ClipboardMonitorBanner: React.FC<ClipboardMonitorBannerProps> = ({
  detectedUrl,
  onInspect,
  onDismiss,
}) => {
  if (!detectedUrl) return null;

  return (
    <div className="mb-3 px-3.5 py-2.5 rounded-lg border border-blue-500/35 bg-blue-500/10 flex flex-wrap items-center justify-between gap-2.5 text-xs">
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <Clipboard className="w-4 h-4 text-blue-600 dark:text-[#58a6ff] shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-[var(--vanta-text)]">Detected URL in clipboard: </span>
          <span className="font-mono text-[var(--vanta-muted)] truncate inline-block max-w-full align-bottom">
            {detectedUrl}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onInspect(detectedUrl)}
          className="px-2.5 py-1 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white rounded text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors"
        >
          <span>Inspect URL</span>
          <ArrowRight className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss clipboard URL prompt"
          className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
