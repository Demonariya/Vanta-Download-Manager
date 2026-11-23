import React from 'react';
import {
  Search,
  Pause,
  Play,
  Bell,
  Plus,
  Menu,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { ThemeMode } from '../types';

interface TopBarProps {
  onOpenNewDownload: () => void;
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
  onOpenNewDownload,
  onOpenNotifications,
  unreadNotificationsCount,
  onPauseAll,
  onResumeAll,
  searchQuery,
  setSearchQuery,
  theme,
  onCycleTheme,
  onToggleMobileMenu,
}) => {
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <header className="h-14 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface)] px-3 sm:px-4 flex items-center justify-between gap-2 sm:gap-3 shrink-0 select-none">
      {onToggleMobileMenu && (
        <button
          type="button"
          onClick={onToggleMobileMenu}
          aria-label="Toggle navigation menu"
          className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg md:hidden shrink-0 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* Queue Search Filter */}
      <div className="relative flex-1 max-w-md min-w-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--vanta-muted)]" />
        <input
          type="text"
          placeholder="Filter queue by title, artist, album, or URL..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs py-1.5 pl-8 pr-3 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)] transition-colors"
        />
      </div>

      {/* Zone 3: Global Queue, Theme, Dock, Notifications & Primary CTA */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="hidden sm:flex items-center bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-0.5">
          <button
            type="button"
            onClick={onResumeAll}
            title="Resume all downloads"
            aria-label="Resume all downloads"
            className="p-1.5 text-[var(--vanta-muted)] hover:text-emerald-600 dark:hover:text-[#3fb950] hover:bg-[var(--vanta-surface-hover)] rounded transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-3 bg-[var(--vanta-border)]" />
          <button
            type="button"
            onClick={onPauseAll}
            title="Pause all downloads"
            aria-label="Pause all downloads"
            className="p-1.5 text-[var(--vanta-muted)] hover:text-amber-600 dark:hover:text-[#e3b341] hover:bg-[var(--vanta-surface-hover)] rounded transition-colors"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={onCycleTheme}
          title={`Theme: ${theme} (click to switch)`}
          aria-label={`Switch theme (current: ${theme})`}
          className="p-2 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg border border-transparent hover:border-[var(--vanta-border)] transition-colors shrink-0"
        >
          <ThemeIcon className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onOpenNotifications}
          aria-label="Notifications"
          className="relative p-2 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg border border-transparent hover:border-[var(--vanta-border)] transition-colors shrink-0"
        >
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[var(--vanta-accent)]" />
          )}
        </button>

        <button
          type="button"
          onClick={onOpenNewDownload}
          className="px-3 py-1.5 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">New Download</span>
        </button>
      </div>
    </header>
  );
};
