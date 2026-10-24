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
    <div className="flex flex-col justify-between h-full">
      <div>
        {/* Brand header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-[#21262d]">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#1f6feb] text-white shrink-0 shadow-sm">
              <Download className="w-4 h-4" />
            </div>
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
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="p-1 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22] rounded transition-colors hidden md:block"
            >
              {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
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
            className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[#238636] hover:bg-[#2ea043] text-white rounded-lg text-xs font-medium transition-all shadow-sm active:scale-[0.98]"
          >
            <PlusCircle className="w-4 h-4 shrink-0" />
            {(!isCollapsed || isDrawer) && <span className="whitespace-nowrap">New Download</span>}
          </button>
        </div>

        {/* Navigation list */}
        <nav className="px-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                aria-label={item.label}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-[#1f6feb]/15 text-[#58a6ff]'
                    : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#58a6ff]' : ''}`} />
                {(!isCollapsed || isDrawer) && (
                  <span className="truncate flex-1 text-left whitespace-nowrap">{item.label}</span>
                )}
                {(!isCollapsed || isDrawer) && item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#1f6feb] text-white">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Engine health summary footer */}
      <div className="p-3 border-t border-[#21262d] bg-[#0b0e14]">
        {!isCollapsed || isDrawer ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-[#8b949e]">
              <span className="font-medium text-[#c9d1d9]">Engine Status</span>
              <span className="font-mono text-[10px] text-[#7d8590]">v1.0.0</span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
              <div
                className={`px-1.5 py-1 rounded text-center truncate ${
                  engineStatus?.ytdlp.available
                    ? 'bg-[#238636]/15 text-[#3fb950]'
                    : 'bg-[#da3633]/15 text-[#f85149]'
                }`}
                title={`yt-dlp: ${engineStatus?.ytdlp.version || 'Missing'}`}
              >
                yt-dlp
              </div>
              <div
                className={`px-1.5 py-1 rounded text-center truncate ${
                  engineStatus?.spotdl.available
                    ? 'bg-[#238636]/15 text-[#3fb950]'
                    : 'bg-[#da3633]/15 text-[#f85149]'
                }`}
                title={`spotDL: ${engineStatus?.spotdl.version || 'Missing'}`}
              >
                spotDL
              </div>
              <div
                className={`px-1.5 py-1 rounded text-center truncate ${
                  engineStatus?.ffmpeg.available
                    ? 'bg-[#238636]/15 text-[#3fb950]'
                    : 'bg-[#da3633]/15 text-[#f85149]'
                }`}
                title={`FFmpeg: ${engineStatus?.ffmpeg.version || 'Missing'}`}
              >
                FFmpeg
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-center" title="Engine Status">
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
        } shrink-0 h-screen overflow-y-auto`}
      >
        {renderNavContent(false)}
      </aside>

      {/* Mobile Backdrop & Drawer */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs md:hidden"
          onClick={() => setIsMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-[#0d1117] border-r border-[#21262d] shadow-2xl transition-transform duration-200 md:hidden select-none overflow-y-auto ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {renderNavContent(true)}
      </aside>
    </>
  );
};
