import React, { useEffect, useRef, useState } from 'react';
import {
  Bell, ChevronDown, Download, History, Info, Monitor, Moon, Pause, Play,
  Settings, Sun, Terminal, X,
} from 'lucide-react';
import { ThemeMode } from '../types';

interface AppMenuBarProps {
  theme: ThemeMode;
  onNewDownload: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onOpenHistory: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenNotifications: () => void;
  onCycleTheme: () => void;
  onExit: () => void | Promise<void>;
}

type MenuItem = {
  label: string;
  shortcut?: string;
  icon?: React.ComponentType<{ className?: string }>;
  separatorBefore?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

export const AppMenuBar: React.FC<AppMenuBarProps> = ({
  theme, onNewDownload, onPauseAll, onResumeAll, onOpenHistory,
  onOpenDiagnostics, onOpenSettings, onOpenNotifications, onCycleTheme, onExit,
}) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutside, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [openMenu]);

  const themeLabel = theme === 'dark' ? 'Dark theme' : theme === 'light' ? 'Light theme' : 'System theme';
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  const menus: Array<{ label: string; items: MenuItem[] }> = [
    {
      label: 'File',
      items: [
        { label: 'New Download', shortcut: 'Ctrl+N', icon: Download, onSelect: onNewDownload },
        { label: 'Settings', shortcut: 'Ctrl+,', icon: Settings, separatorBefore: true, onSelect: onOpenSettings },
        { label: 'Exit', icon: X, separatorBefore: true, danger: true, onSelect: onExit },
      ],
    },
    {
      label: 'Downloads',
      items: [
        { label: 'Resume All', icon: Play, onSelect: onResumeAll },
        { label: 'Pause All', icon: Pause, onSelect: onPauseAll },
        { label: 'Download History', icon: History, separatorBefore: true, onSelect: onOpenHistory },
      ],
    },
    {
      label: 'View',
      items: [
        { label: themeLabel, icon: ThemeIcon, onSelect: onCycleTheme },
        { label: 'Notifications', icon: Bell, separatorBefore: true, onSelect: onOpenNotifications },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Engine Management', icon: Terminal, onSelect: onOpenDiagnostics },
        { label: 'About VANTA', icon: Info, separatorBefore: true, onSelect: () => setShowAbout(true) },
      ],
    },
  ];

  return (
    <>
      <div ref={rootRef} className="relative z-40 flex h-9 shrink-0 items-center gap-1 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface)] px-3 text-xs">
        {menus.map((menu) => (
          <div className="relative h-full" key={menu.label}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.label}
              onClick={() => setOpenMenu((current) => current === menu.label ? null : menu.label)}
              className={
                'flex h-full items-center gap-1 rounded-md px-3 font-medium transition-colors ' +
                (openMenu === menu.label
                  ? 'bg-[var(--vanta-surface-hover)] text-[var(--vanta-text)]'
                  : 'text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]')
              }
            >
              {menu.label}
              <ChevronDown className="h-3 w-3 opacity-55" />
            </button>

            {openMenu === menu.label && (
              <div role="menu" aria-label={menu.label} className="absolute left-0 top-[calc(100%+5px)] z-50 w-56 overflow-hidden rounded-lg border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] py-1.5 shadow-2xl">
                {menu.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <React.Fragment key={item.label}>
                      {item.separatorBefore && <div className="my-1.5 border-t border-[var(--vanta-border)]" />}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenu(null);
                          item.onSelect();
                        }}
                        className={
                          'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ' +
                          (item.danger
                            ? 'text-red-500 hover:bg-red-500/10'
                            : 'text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]')
                        }
                      >
                        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-75" />}
                        <span className="min-w-0 flex-1">{item.label}</span>
                        {item.shortcut && <span className="shrink-0 font-mono text-[10px] text-[var(--vanta-muted)]">{item.shortcut}</span>}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <div className="ml-auto hidden items-center gap-1.5 pr-2 text-[10px] text-[var(--vanta-muted)] sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          VANTA Download Manager
        </div>
      </div>

      {showAbout && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onClick={() => setShowAbout(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="vanta-about-title"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="vanta-about-title" className="text-base font-semibold text-[var(--vanta-text)]">VANTA Download Manager</h2>
                <p className="mt-1 text-xs text-[var(--vanta-muted)]">Version 0.0.1</p>
              </div>
              <button type="button" onClick={() => setShowAbout(false)} aria-label="Close About" className="rounded-lg p-1.5 text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs leading-5 text-[var(--vanta-text-secondary)]">
              A desktop download manager for organizing, monitoring, and controlling file transfers.
            </p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setShowAbout(false)} className="rounded-lg bg-[var(--vanta-accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--vanta-accent-hover)]">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
