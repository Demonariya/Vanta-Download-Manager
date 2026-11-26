import React, { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';

interface TitleBarProps {
  onRequestClose: () => void;
  activeDownloadsCount: number;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  onRequestClose,
  activeDownloadsCount,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const checkTauri = async () => {
      try {
        if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
          const win = getCurrentWindow();
          if (!mounted) return;
          setIsTauri(true);
          setIsMaximized(await win.isMaximized());
          unlisten = await win.onResized(async () => {
            if (mounted) setIsMaximized(await win.isMaximized());
          });
        }
      } catch {
        if (mounted) setIsTauri(false);
      }
    };
    void checkTauri();
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTauri) {
      try {
        await getCurrentWindow().minimize();
      } catch (err) {
        console.error('Failed to minimize window:', err);
      }
    }
  };

  const handleToggleMaximize = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (isTauri) {
      try {
        const win = getCurrentWindow();
        await win.toggleMaximize();
        setIsMaximized(await win.isMaximized());
      } catch (err) {
        console.error('Failed to toggle maximize window:', err);
      }
    } else {
      setIsMaximized((v) => !v);
    }
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={() => handleToggleMaximize()}
      className="h-8 bg-[var(--vanta-surface-2)] border-b border-[var(--vanta-border)] flex items-center justify-between px-3 select-none text-[var(--vanta-muted)] text-xs z-50 shrink-0"
    >
      <div className="flex items-center gap-2 pointer-events-none">
        <img src="/vanta-mark.svg" alt="" className="h-5 w-5 object-contain shrink-0" />
        <span className="font-semibold text-[var(--vanta-text)] tracking-tight text-[11px]">
          VANTA Download Manager
        </span>
        {activeDownloadsCount > 0 && (
          <span className="text-[11px] font-mono tabular-nums text-[var(--vanta-accent)]">
            · {activeDownloadsCount} active
          </span>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1 h-full cursor-default" />

      <div className="flex items-center h-full -mr-3" data-tauri-drag-region={false}>
        <button
          type="button"
          onClick={handleMinimize}
          title="Minimize"
          aria-label="Minimize Window"
          className="h-full px-3 hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)] flex items-center justify-center transition-colors focus:outline-none"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => handleToggleMaximize(e)}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore Window' : 'Maximize Window'}
          className="h-full px-3 hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)] flex items-center justify-center transition-colors focus:outline-none"
        >
          {isMaximized ? <Copy className="w-3 h-3 rotate-180" /> : <Square className="w-3 h-3" />}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestClose();
          }}
          title="Close"
          aria-label="Close Window"
          className="h-full px-3.5 hover:bg-red-600 hover:text-white flex items-center justify-center transition-colors focus:outline-none"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
