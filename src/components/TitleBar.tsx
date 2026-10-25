import React, { useState, useEffect } from 'react';
import { Minus, Square, Copy, X, Download, ShieldCheck } from 'lucide-react';

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
    // Check if running inside native Tauri environment
    const checkTauri = async () => {
      try {
        if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
          setIsTauri(true);
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          const max = await win.isMaximized();
          setIsMaximized(max);

          const unlisten = await win.onResized(async () => {
            const current = await win.isMaximized();
            setIsMaximized(current);
          });

          return () => {
            unlisten();
          };
        }
      } catch (err) {
        // Running in standard browser / development mode
        setIsTauri(false);
      }
    };

    checkTauri();
  }, []);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTauri) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
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
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.toggleMaximize();
        const max = await win.isMaximized();
        setIsMaximized(max);
      } catch (err) {
        console.error('Failed to toggle maximize window:', err);
      }
    } else {
      setIsMaximized(!isMaximized);
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRequestClose();
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={() => handleToggleMaximize()}
      className="h-8 bg-[#090b0e] border-b border-[#21262d] flex items-center justify-between px-3 select-none text-[#8b949e] text-xs z-50 shrink-0"
    >
      {/* Left: Window Brand & Title */}
      <div className="flex items-center gap-2 pointer-events-none">
        <div className="w-3.5 h-3.5 rounded bg-[#1f6feb] flex items-center justify-center text-white shrink-0">
          <Download className="w-2.5 h-2.5" />
        </div>
        <span className="font-semibold text-white tracking-tight text-[11px]">
          VANTA Download Manager
        </span>
        {activeDownloadsCount > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#1f6feb]/20 text-[#58a6ff] border border-[#1f6feb]/30">
            {activeDownloadsCount} active
          </span>
        )}
      </div>

      {/* Center Draggable Spacer */}
      <div data-tauri-drag-region className="flex-1 h-full cursor-default" />

      {/* Right: Window Control Action Group */}
      <div className="flex items-center h-full -mr-3" data-tauri-drag-region={false}>
        {/* Minimize Button */}
        <button
          onClick={handleMinimize}
          title="Minimize"
          aria-label="Minimize Window"
          className="h-full px-3 hover:bg-[#161b22] hover:text-[#e6edf3] flex items-center justify-center transition-colors focus:outline-none"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        {/* Maximize / Restore Button */}
        <button
          onClick={(e) => handleToggleMaximize(e)}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore Window' : 'Maximize Window'}
          className="h-full px-3 hover:bg-[#161b22] hover:text-[#e6edf3] flex items-center justify-center transition-colors focus:outline-none"
        >
          {isMaximized ? (
            <Copy className="w-3 h-3 rotate-180" />
          ) : (
            <Square className="w-3 h-3" />
          )}
        </button>

        {/* Close Button */}
        <button
          onClick={handleClose}
          title="Close"
          aria-label="Close Window"
          className="h-full px-3.5 hover:bg-[#da3633] hover:text-white flex items-center justify-center transition-colors focus:outline-none"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
