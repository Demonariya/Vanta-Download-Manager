import React from 'react';
import {
  LayoutDashboard,
  PlusCircle,
  ListVideo,
  Activity,
  CheckCircle2,
  Music2,
  History,
  Terminal,
  Settings,
  ShieldCheck,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
} from 'lucide-react';
import { EngineStatusMap } from '../types';

export type ActiveTab =
  | 'dashboard'
  | 'queue'
  | 'active'
  | 'completed'
  | 'music'
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
  const navItems = [
    { id: 'dashboard' as ActiveTab, label: 'Dashboard', icon: LayoutDashboard },
    { id: 'queue' as ActiveTab, label: 'Download Queue', icon: ListVideo },
    {
      id: 'active' as ActiveTab,
      label: 'Active Downloads',
      icon: Activity,
      badge: activeCount > 0 ? activeCount : undefined,
    },
    { id: 'completed' as ActiveTab, label: 'Completed', icon: CheckCircle2 },
    { id: 'music' as ActiveTab, label: 'Music Library', icon: Music2 },
    { id: 'history' as ActiveTab, label: 'Download History', icon: History },
    { id: 'diagnostics' as ActiveTab, label: 'Diagnostics & Logs', icon: Terminal },
    { id: 'settings' as ActiveTab, label: 'Settings', icon: Settings },
  ];

  const allEnginesReady =
    engineStatus &&
    engineStatus.ytdlp.available &&
    engineStatus.spotdl.available &&
    engineStatus.ffmpeg.available;

  const handleNavClick = (id: ActiveTab) => {
    setActiveTab(id);
    setIsMobileOpen(false);
  };

  const renderNavContent = (isDrawer = false) => (
    <div className="flex flex-col h-full min-h-0 justify-between select-none">
      {/* Scrollable Upper Area (Brand Header + CTA + Navigation) */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {/* Brand header */}
        <div
          className={`h-14 flex items-center ${
            isCollapsed && !isDrawer ? 'justify-center px-2' : 'justify-between px-3.5'
          } border-b border-[#21262d] shrink-0`}
        >
          <div className="flex items-center gap-2.5 overflow-hidden">
            <button
              type="button"
              onClick={!isDrawer && isCollapsed ? () => setIsCollapsed(false) : undefined}
              className={`flex items-center justify-center w-8 h-8 rounded-lg bg-[#1f6feb] text-white shrink-0 shadow-sm ${
                isCollapsed && !isDrawer ? 'cursor-pointer hover:bg-[#388bfd] transition-colors focus:ring-1 focus:ring-[#58a6ff]' : ''
              }`}
              title={isCollapsed && !isDrawer ? 'Expand sidebar' : undefined}
              aria-label={isCollapsed && !isDrawer ? 'Expand sidebar' : 'VANTA Download Manager'}
            >
              <Download className="w-4 h-4" />
            </button>
            {(!isCollapsed || isDrawer) && (
              <div className="truncate">
                <span className="font-semibold text-sm tracking-tight text-white block">VANTA</span>
                <span className="text-[11px] text-[#8b949e] block font-mono">Download Manager</span>
              </div>
            )}
          </div>
          {isDrawer ? (
            <button
              onClick={() => setIsMobileOpen(false)}
              aria-label="Close navigation drawer"
              className="p-1.5 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          ) : (
            !isCollapsed && (
              <button
                onClick={() => setIsCollapsed(true)}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="p-1 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            )
          )}
        </div>

        {/* Primary New Download CTA */}
        <div className="p-3">
          <button
            onClick={() => {
              onOpenNewDownload();
              if (isDrawer) setIsMobileOpen(false);
            }}
            aria-label="New Download"
            title={isCollapsed && !isDrawer ? 'New Download' : undefined}
            className={`w-full flex items-center ${
              isCollapsed && !isDrawer ? 'justify-center p-2' : 'justify-center gap-2 py-2 px-3'
            } bg-[#238636] hover:bg-[#2ea043] text-white rounded-lg text-xs font-medium transition-all shadow-sm active:scale-[0.98]`}
          >
            <PlusCircle className="w-4 h-4 shrink-0" />
            {(!isCollapsed || isDrawer) && <span className="whitespace-nowrap">New Download</span>}
          </button>
        </div>

        {/* Navigation list */}
        <nav className="px-2 py-1 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                aria-label={item.label}
                title={isCollapsed && !isDrawer ? item.label : undefined}
                className={`w-full flex items-center ${
                  isCollapsed && !isDrawer ? 'justify-center px-2' : 'gap-3 px-3'
                } py-2 sm:py-2 rounded-lg text-xs font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-[#1f6feb]/15 text-[#58a6ff] font-semibold shadow-xs'
                    : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]'
                } active:scale-[0.98]`}
              >
                <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? 'text-[#58a6ff]' : 'text-[#8b949e]'}`} />
                {(!isCollapsed || isDrawer) && (
                  <span className="truncate flex-1 text-left whitespace-nowrap">{item.label}</span>
                )}
                {(!isCollapsed || isDrawer) && item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono rounded-full bg-[#1f6feb] text-white font-medium shrink-0">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Engine health summary footer */}
      <div className="p-3 border-t border-[#21262d] bg-[#0b0e14] shrink-0">
        {!isCollapsed || isDrawer ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-[#8b949e]">
              <span className="font-medium text-[#c9d1d9] flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse" />
                Engine Status
              </span>
              <span className="font-mono text-[10px] text-[#7d8590]">v1.0.0</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono">
              {[
                { label: 'yt-dlp', info: engineStatus?.ytdlp },
                { label: 'spotDL', info: engineStatus?.spotdl },
                { label: 'FFmpeg', info: engineStatus?.ffmpeg },
              ].map(({ label, info }) => {
                const st = info?.status || 'checking';
                const pillClass = info?.available
                  ? 'bg-[#238636]/10 border-[#238636]/30 text-[#3fb950]'
                  : st === 'checking'
                  ? 'bg-[#1f6feb]/10 border-[#1f6feb]/30 text-[#58a6ff]'
                  : st === 'timed_out'
                  ? 'bg-[#d29922]/10 border-[#d29922]/30 text-[#e3b341]'
                  : 'bg-[#da3633]/10 border-[#da3633]/30 text-[#f85149]';
                return (
                  <div
                    key={label}
                    className={`px-1.5 py-1 rounded-md text-center truncate border transition-colors ${pillClass}`}
                    title={`${label}: ${
                      info?.version || (st === 'checking' ? 'Checking...' : st === 'timed_out' ? 'Timed out' : 'Missing')
                    }`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-1" title="Engine Status">
            {allEnginesReady ? (
              <ShieldCheck className="w-4 h-4 text-[#3fb950]" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-[#d29922]" />
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside
        className={`relative hidden md:flex flex-col justify-between border-r border-[#21262d] bg-[#0d1117] transition-all duration-200 select-none ${
          isCollapsed ? 'w-16' : 'w-64'
        } shrink-0 h-full overflow-hidden`}
      >
        {renderNavContent(false)}
      </aside>

      {/* Mobile Backdrop & Drawer */}
      {isMobileOpen && (
        <div
          className="fixed top-8 inset-x-0 bottom-0 z-40 bg-black/70 backdrop-blur-xs md:hidden"
          onClick={() => setIsMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-8 bottom-0 left-0 z-50 w-72 bg-[#0d1117] border-r border-[#21262d] shadow-2xl transition-transform duration-200 md:hidden select-none overflow-hidden ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {renderNavContent(true)}
      </aside>
    </>
  );
};
