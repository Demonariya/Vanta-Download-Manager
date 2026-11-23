import React from 'react';
import {
  Pause, Play, Bell, Plus, Menu, Sun, Moon, Monitor, Link2,
} from 'lucide-react';
import { ThemeMode } from '../types';

interface TopBarProps {
  onOpenNewDownload: () => void;
  onAddUrl: (url: string) => void;
  onOpenNotifications: () => void;
  unreadNotificationsCount: number;
  activeCount: number;
  onPauseAll: () => void;
  onResumeAll: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  theme: ThemeMode;
  onCycleTheme: () => void;
  onToggleMobileMenu?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenNewDownload, onAddUrl, onOpenNotifications, unreadNotificationsCount,
  activeCount, onPauseAll, onResumeAll, searchQuery, setSearchQuery,
  theme, onCycleTheme, onToggleMobileMenu,
}) => {
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const isUrl = /^(https?:\/\/|spotify:)/i.test(searchQuery.trim());

  const handleAdd = () => {
    if (isUrl) {
      onAddUrl(searchQuery.trim());
      setSearchQuery('');
    } else {
      onOpenNewDownload();
    }
  };

  return (
    <header className="h-[68px] border-b border-[var(--vanta-border)] bg-[var(--vanta-surface)]/95 px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0 select-none">
      {onToggleMobileMenu && (
        <button type="button" onClick={onToggleMobileMenu} aria-label="Toggle navigation menu"
          className="p-2 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg md:hidden shrink-0">
          <Menu className="w-5 h-5" />
        </button>
      )}

      <form className="relative flex-1 min-w-0 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); handleAdd(); }}>
        <div className="relative flex-1 min-w-0">
          <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--vanta-muted)]" />
          <input
            type="text"
            placeholder="Paste URL or search..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="Paste download URL or search downloads"
            className="w-full h-11 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-xl text-sm pl-10 pr-3 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)] transition-colors"
          />
        </div>
        <button type="submit" className="h-11 px-4 sm:px-5 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors shrink-0">
          <Plus className="w-4 h-4" />
          <span>Add</span>
        </button>
      </form>

      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onResumeAll} title={`Resume downloads (${activeCount} active)`} aria-label="Resume all downloads"
          className="p-2.5 text-[var(--vanta-muted)] hover:text-emerald-500 hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors">
          <Play className="w-4 h-4" />
        </button>
        <button type="button" onClick={onPauseAll} title="Pause all downloads" aria-label="Pause all downloads"
          className="p-2.5 text-[var(--vanta-muted)] hover:text-amber-500 hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors">
          <Pause className="w-4 h-4" />
        </button>
        <button type="button" onClick={onCycleTheme} title={`Theme: ${theme}`} aria-label="Switch theme"
          className="hidden sm:inline-flex p-2.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors">
          <ThemeIcon className="w-4 h-4" />
        </button>
        <button type="button" onClick={onOpenNotifications} aria-label="Notifications"
          className="relative p-2.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors">
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--vanta-accent)]" />}
        </button>
      </div>
    </header>
  );
};
