import React, { useState } from 'react';
import {
  Search,
  ClipboardPaste,
  Pause,
  Play,
  Bell,
  Settings,
  ArrowRight,
  Menu,
} from 'lucide-react';

interface TopBarProps {
  onQuickInspect: (url: string) => void;
  onOpenNewDownload: () => void;
  onOpenSettings: () => void;
  onOpenNotifications: () => void;
  unreadNotificationsCount: number;
  activeCount: number;
  onPauseAll: () => void;
  onResumeAll: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onToggleMobileMenu?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  onQuickInspect,
  onOpenNewDownload,
  onOpenSettings,
  onOpenNotifications,
  unreadNotificationsCount,
  activeCount: _activeCount,
  onPauseAll,
  onResumeAll,
  searchQuery,
  setSearchQuery,
  onToggleMobileMenu,
}) => {
  const [urlInput, setUrlInput] = useState('');

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('spotify:'))) {
        setUrlInput(text.trim());
        onQuickInspect(text.trim());
      }
    } catch {
      // Clipboard read fallback: trigger New Download modal
      onOpenNewDownload();
    }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (urlInput.trim()) {
      onQuickInspect(urlInput.trim());
      setUrlInput('');
    }
  };

  return (
    <header className="h-14 border-b border-[#21262d] bg-[#0d1117] px-2.5 sm:px-4 flex items-center justify-between gap-1.5 sm:gap-4 shrink-0 select-none">
      {/* Mobile Menu Toggle Button */}
      {onToggleMobileMenu && (
        <button
          type="button"
          onClick={onToggleMobileMenu}
          aria-label="Toggle navigation menu"
          className="p-1.5 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded-lg md:hidden shrink-0 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* Zone 1: Fast URL Input & Quick Inspector */}
      <form onSubmit={handleUrlSubmit} className="flex-1 max-w-xl flex items-center gap-1.5 sm:gap-2 min-w-0">
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            placeholder="Paste media or Spotify URL..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] focus:outline-none rounded-lg text-xs py-1.5 pl-2.5 sm:pl-3 pr-7 sm:pr-8 text-[#e6edf3] placeholder-[#6e7681] transition-colors truncate"
          />
          <button
            type="button"
            onClick={handlePasteFromClipboard}
            title="Paste from clipboard"
            aria-label="Paste URL from clipboard"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8b949e] hover:text-[#58a6ff] transition-colors"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
          </button>
        </div>
        <button
          type="submit"
          disabled={!urlInput.trim()}
          aria-label="Inspect and Download URL"
          className="px-2.5 sm:px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium flex items-center gap-1 sm:gap-1.5 transition-colors shrink-0"
        >
          <span className="hidden sm:inline">Inspect</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </form>

      {/* Zone 2: Filter / Search (Desktop & Tablet) */}
      <div className="relative w-40 lg:w-56 hidden md:block shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#6e7681]" />
        <input
          type="text"
          placeholder="Filter downloads..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] focus:outline-none rounded-lg text-xs py-1.5 pl-8 pr-3 text-[#e6edf3] placeholder-[#6e7681] transition-colors"
        />
      </div>

      {/* Zone 3: Global Controls & Utilities */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        {/* Global Pause / Resume */}
        <div className="flex items-center bg-[#161b22] border border-[#30363d] rounded-lg p-0.5">
          <button
            onClick={onResumeAll}
            title="Resume all downloads"
            aria-label="Resume all downloads"
            className="p-1 sm:p-1.5 text-[#8b949e] hover:text-[#3fb950] hover:bg-[#21262d] rounded transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <div className="w-[1px] h-3 bg-[#30363d] my-auto" />
          <button
            onClick={onPauseAll}
            title="Pause all downloads"
            aria-label="Pause all downloads"
            className="p-1 sm:p-1.5 text-[#8b949e] hover:text-[#d29922] hover:bg-[#21262d] rounded transition-colors"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Notifications */}
        <button
          onClick={onOpenNotifications}
          aria-label="Notifications"
          className="relative p-1.5 sm:p-2 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded-lg border border-transparent hover:border-[#30363d] transition-colors"
        >
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#1f6feb]" />
          )}
        </button>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          aria-label="Application Settings"
          className="p-1.5 sm:p-2 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded-lg border border-transparent hover:border-[#30363d] transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
