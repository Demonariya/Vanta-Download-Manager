import React from 'react';
import {
  ListVideo,
  PlusCircle,
  History,
  Terminal,
  Settings,
  ShieldCheck,
  AlertTriangle,
  ChevronLeft,
  Download,
  X,
} from 'lucide-react';
import { EngineStatusMap } from '../types';

export type ActiveTab =
  | 'downloads'
  | 'history'
  | 'diagnostics'
  | 'settings';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  onOpenNewDownload: () => void;
  engineStatus: EngineStatusMap | null;
  activeCount: number;
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
  isMobileOpen: boolean;
  setIsMobileOpen: (open: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  onOpenNewDownload,
  engineStatus,
  activeCount,
  isCollapsed,
  setIsCollapsed,
  isMobileOpen,
  setIsMobileOpen,
}) => {
  const navItems: Array<{
    id: ActiveTab | 'new-download';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
    isAction?: boolean;
  }> = [
    {
      id: 'downloads',
      label: 'Download Center',
      icon: ListVideo,
      count: activeCount > 0 ? activeCount : undefined,
    },
    {
      id: 'new-download',
      label: 'New Download',
      icon: PlusCircle,
      isAction: true,
    },
    { id: 'history', label: 'Queue & History', icon: History },
    { id: 'diagnostics', label: 'Engine Management', icon: Terminal },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const allEnginesReady =
    engineStatus &&
    engineStatus.ytdlp.available &&
    engineStatus.ffmpeg.available;

  const handleNavClick = (id: ActiveTab | 'new-download') => {
    if (id === 'new-download') {
      setIsMobileOpen(false);
      onOpenNewDownload();
      return;
    }
    setActiveTab(id);
    setIsMobileOpen(false);
  };

  const renderNavContent = (isDrawer = false) => (
    <div className="flex flex-col h-full min-h-0 justify-between select-none">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {/* Brand Header */}
        <div
          className={`h-14 flex items-center ${
            isCollapsed && !isDrawer ? 'justify-center px-2' : 'justify-between px-3.5'
          } border-b border-[var(--vanta-border)] shrink-0`}
        >
          <div className="flex items-center gap-2.5 overflow-hidden">
            <button
              type="button"
              onClick={!isDrawer && isCollapsed ? () => setIsCollapsed(false) : undefined}
              className={`flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--vanta-accent)] text-white shrink-0 ${
                isCollapsed && !isDrawer
                  ? 'cursor-pointer hover:bg-[var(--vanta-accent-hover)] transition-colors'
                  : ''
              }`}
              title={isCollapsed && !isDrawer ? 'Expand sidebar' : undefined}
              aria-label={isCollapsed && !isDrawer ? 'Expand sidebar' : 'VANTA Download Manager'}
            >
              <Download className="w-4 h-4" />
            </button>
            {(!isCollapsed || isDrawer) && (
              <div className="truncate">
                <span className="font-semibold text-sm tracking-tight text-[var(--vanta-text)] block">
                  VANTA
                </span>
                <span className="text-[11px] text-[var(--vanta-muted)] block font-mono">
                  Download Workstation
                </span>
              </div>
            )}
          </div>
          {isDrawer ? (
            <button
              type="button"
              onClick={() => setIsMobileOpen(false)}
              aria-label="Close navigation drawer"
              className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          ) : (
            !isCollapsed && (
              <button
                type="button"
                onClick={() => setIsCollapsed(true)}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            )
          )}
        </div>

        {/* Navigation Links */}
        <nav className="px-2.5 py-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = !item.isAction && activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                aria-label={item.label}
                title={isCollapsed && !isDrawer ? item.label : undefined}
                className={`w-full flex items-center ${
                  isCollapsed && !isDrawer ? 'justify-center px-2' : 'gap-2.5 px-3'
                } py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-[var(--vanta-accent)]/12 text-[var(--vanta-accent)] font-semibold'
                    : item.isAction
                    ? 'text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] border border-dashed border-[var(--vanta-border)]'
                    : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${item.isAction ? 'text-[var(--vanta-accent)]' : ''}`} />
                {(!isCollapsed || isDrawer) && (
                  <span className="truncate flex-1 text-left">{item.label}</span>
                )}
                {(!isCollapsed || isDrawer) && item.count !== undefined && (
                  <span className="font-mono tabular-nums text-[11px] text-[var(--vanta-accent)] shrink-0">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Engine Status Footer */}
      <div className="p-3 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] shrink-0">
        {!isCollapsed || isDrawer ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-[var(--vanta-text-secondary)]">
                Engine Runtime
              </span>
              <span className="font-mono text-[10px] text-[var(--vanta-muted)]">
                {allEnginesReady ? 'Ready' : 'Check Diagnostics'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono">
              {[
                { label: 'yt-dlp', info: engineStatus?.ytdlp },
                { label: 'spotDL', info: engineStatus?.spotdl },
                { label: 'FFmpeg', info: engineStatus?.ffmpeg },
              ].map(({ label, info }) => {
                const st = info?.status || 'checking';
                const tone = info?.available
                  ? 'text-emerald-700 dark:text-[#3fb950] border-emerald-500/30 bg-emerald-500/10'
                  : st === 'checking'
                  ? 'text-blue-700 dark:text-[#58a6ff] border-blue-500/30 bg-blue-500/10'
                  : 'text-amber-700 dark:text-[#e3b341] border-amber-500/30 bg-amber-500/10';
                return (
                  <div
                    key={label}
                    className={`px-1.5 py-1 rounded text-center truncate border ${tone}`}
                    title={`${label}: ${
                      info?.version || (st === 'checking' ? 'Checking...' : 'Unavailable')
                    }`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-1" title="Engine Runtime">
            {allEnginesReady ? (
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-[#3fb950]" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-[#e3b341]" />
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside
        className={`relative hidden md:flex flex-col justify-between border-r border-[var(--vanta-border)] bg-[var(--vanta-surface)] transition-all duration-200 select-none ${
          isCollapsed ? 'w-16' : 'w-60'
        } shrink-0 h-full overflow-hidden`}
      >
        {renderNavContent(false)}
      </aside>

      {isMobileOpen && (
        <div
          className="fixed top-8 inset-x-0 bottom-0 z-40 bg-black/60 backdrop-blur-xs md:hidden"
          onClick={() => setIsMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-8 bottom-0 left-0 z-50 w-64 bg-[var(--vanta-surface)] border-r border-[var(--vanta-border)] shadow-2xl transition-transform duration-200 md:hidden select-none overflow-hidden ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {renderNavContent(true)}
      </aside>
    </>
  );
};
