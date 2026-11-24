import React, { useEffect, useRef, useState } from 'react';
import {
  ListVideo, Download, PauseCircle, CheckCircle2, AlertCircle,
  Music2, Video, Layers, PlusCircle, History, Terminal, Settings,
  ShieldCheck, AlertTriangle, ChevronLeft, X,
} from 'lucide-react';
import { DownloadQueue, DownloadTask, EngineStatusMap } from '../types';
import { api } from '../services/api';

export type ActiveTab = 'downloads' | 'history' | 'diagnostics' | 'settings';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  onOpenNewDownload: () => void;
  engineStatus: EngineStatusMap | null;
  tasks: DownloadTask[];
  queues: DownloadQueue[];
  selectedQueueId: string;
  onSelectQueue: (id: string) => void;
  onQueuesChanged: (queues: DownloadQueue[]) => void;
  scopeFilter: string;
  setScopeFilter: (scope: any) => void;
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
  isMobileOpen: boolean;
  setIsMobileOpen: (open: boolean) => void;
}

type FilterItem = {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
};

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab, setActiveTab, onOpenNewDownload, engineStatus, tasks, queues,
  selectedQueueId, onSelectQueue, onQueuesChanged, scopeFilter, setScopeFilter, isCollapsed,
  setIsCollapsed, isMobileOpen, setIsMobileOpen,
}) => {
  const downloadingCount = tasks.filter((task) =>
    ['connecting', 'downloading', 'resuming', 'inspecting', 'processing', 'muxing', 'verifying'].includes(task.status)
  ).length;
  const pausedCount = tasks.filter((task) => task.status === 'paused').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const failedCount = tasks.filter((task) => task.status === 'failed').length;
  const musicCount = tasks.filter((task) => task.is_audio_only || task.engine === 'spotdl').length;
  const videoCount = tasks.length - musicCount;

  const statusItems: FilterItem[] = [
    { id: 'all', label: 'All Downloads', icon: ListVideo, count: tasks.length },
    { id: 'active', label: 'Downloading', icon: Download, count: downloadingCount },
    { id: 'paused', label: 'Paused', icon: PauseCircle, count: pausedCount },
    { id: 'completed', label: 'Completed', icon: CheckCircle2, count: completedCount },
    { id: 'failed', label: 'Failed', icon: AlertCircle, count: failedCount },
  ];
  const mediaItems: FilterItem[] = [
    { id: 'audio', label: 'Music', icon: Music2, count: musicCount },
    { id: 'video', label: 'Video', icon: Video, count: videoCount },
  ];

  const [queueMenu, setQueueMenu] = useState<{ x: number; y: number; queueId: string } | null>(null);
  const [queueEditor, setQueueEditor] = useState<{ mode: 'create' | 'rename'; queueId?: string } | null>(null);
  const [queueName, setQueueName] = useState('');
  const queueMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!queueMenu) return;
    const close = (event: PointerEvent) => {
      if (!queueMenuRef.current?.contains(event.target as Node)) setQueueMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key);
    };
  }, [queueMenu]);

  const allEnginesReady = Boolean(engineStatus?.ytdlp.available && engineStatus?.ffmpeg.available);

  const selectQueue = (id: string) => {
    setActiveTab('downloads');
    setScopeFilter('all');
    onSelectQueue(id);
    setIsMobileOpen(false);
  };

  const navButton = (
    id: string,
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    count: number | undefined,
    active: boolean,
    onClick: () => void,
    accent = false,
  ) => (
    <button
      key={id}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={isCollapsed && !isMobileOpen ? label : undefined}
      className={`w-full flex items-center ${isCollapsed && !isMobileOpen ? 'justify-center px-2' : 'gap-2.5 px-3'} py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
        active
          ? 'bg-[var(--vanta-accent)]/15 text-[var(--vanta-accent)] font-semibold'
          : accent
            ? 'text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] border border-dashed border-[var(--vanta-border)]'
            : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]'
      }`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${accent ? 'text-[var(--vanta-accent)]' : ''}`} />
      {(!isCollapsed || isMobileOpen) && <span className="truncate flex-1 text-left">{label}</span>}
      {(!isCollapsed || isMobileOpen) && count !== undefined && (
        <span className="font-mono tabular-nums text-[11px] text-[var(--vanta-muted)] shrink-0">{count}</span>
      )}
    </button>
  );

  const renderNavContent = (drawer = false) => {
    const compact = isCollapsed && !drawer;
    return (
      <div className="flex flex-col h-full min-h-0 select-none">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className={`h-[72px] flex items-center ${compact ? 'justify-center px-2' : 'justify-between px-3.5'} border-b border-[var(--vanta-border)] shrink-0`}>
            <div className="flex items-center gap-2.5 overflow-hidden">
              <button
                type="button"
                onClick={compact ? () => setIsCollapsed(false) : undefined}
                className="flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--vanta-accent)] text-white shrink-0"
                title={compact ? 'Expand sidebar' : undefined}
                aria-label="VANTA Download Manager"
              >
                <Layers className="w-5 h-5" />
              </button>
              {(!compact || drawer) && (
                <div className="truncate">
                  <span className="font-semibold text-base tracking-tight text-[var(--vanta-text)] block">VANTA</span>
                  <span className="text-[11px] text-[var(--vanta-muted)] block">Download Manager</span>
                </div>
              )}
            </div>
            {drawer ? (
              <button type="button" onClick={() => setIsMobileOpen(false)} aria-label="Close navigation" className="p-1.5 rounded-lg text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]">
                <X className="w-4 h-4" />
              </button>
            ) : !compact ? (
              <button type="button" onClick={() => setIsCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar" className="p-1 rounded-lg text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)]">
                <ChevronLeft className="w-4 h-4" />
              </button>
            ) : null}
          </div>

          <nav className="px-2.5 py-3 space-y-1" aria-label="Download filters">
            {statusItems.map((item) => navButton(
              item.id, item.label, item.icon, item.count,
              activeTab === 'downloads' && scopeFilter === item.id && (item.id !== 'all' || selectedQueueId === 'all'),
              () => selectFilter(item.id),
            ))}

            {(!compact || drawer) && <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--vanta-muted)]">Categories</p>}
            {mediaItems.map((item) => navButton(
              item.id, item.label, item.icon, item.count,
              activeTab === 'downloads' && scopeFilter === item.id,
              () => { setActiveTab('downloads'); setScopeFilter(item.id); setIsMobileOpen(false); },
            ))}

            {(!compact || drawer) && (
              <div className="flex items-center justify-between px-3 pt-4 pb-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--vanta-muted)]">Queues</p>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-[var(--vanta-muted)]">{queues.length}</span>
                  <button type="button" aria-label="Create queue" title="Create queue" onClick={() => {
                    setQueueName('');
                    setQueueEditor({ mode: 'create' });
                  }} className="p-1 rounded-md text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
                    <PlusCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
            {queues.map((queue) => {
              const count = tasks.filter((task) => (task.queue_id || 'main') === queue.id).length;
              return (
                <button
                  key={queue.id}
                  type="button"
                  onClick={() => selectQueue(queue.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setQueueMenu({ x: event.clientX, y: event.clientY, queueId: queue.id });
                  }}
                  title={compact ? queue.name : undefined}
                  aria-label={queue.name}
                  className={`w-full flex items-center ${compact ? 'justify-center px-2' : 'gap-2.5 px-3'} py-2 rounded-lg text-xs font-medium transition-colors ${selectedQueueId === queue.id && activeTab === 'downloads' && scopeFilter === 'all' ? 'bg-[var(--vanta-accent)]/15 text-[var(--vanta-accent)] font-semibold' : 'text-[var(--vanta-muted)] hover:bg-[var(--vanta-surface-hover)] hover:text-[var(--vanta-text)]'}`}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${queue.is_paused ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  {(!compact || drawer) && <span className="truncate flex-1 text-left">{queue.name}</span>}
                  {(!compact || drawer) && <span className="font-mono tabular-nums text-[10px] text-[var(--vanta-muted)]">{count}</span>}
                </button>
              );
            })}

            <div className="pt-2">
              {navButton('new-download', 'New Download', PlusCircle, undefined, false, () => { onOpenNewDownload(); setIsMobileOpen(false); }, true)}
            </div>
          </nav>

          <div className="mx-3 my-2 border-t border-[var(--vanta-border)]" />
          <nav className="px-2.5 pb-3 space-y-1" aria-label="Application pages">
            {navButton('history', 'Queue & History', History, undefined, activeTab === 'history', () => { setActiveTab('history'); setIsMobileOpen(false); })}
            {navButton('diagnostics', 'Engine Management', Terminal, undefined, activeTab === 'diagnostics', () => { setActiveTab('diagnostics'); setIsMobileOpen(false); })}
            {navButton('settings', 'Settings', Settings, undefined, activeTab === 'settings', () => { setActiveTab('settings'); setIsMobileOpen(false); })}
          </nav>
        </div>

        <div className="p-3 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] shrink-0">
          {!compact || drawer ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-[var(--vanta-text-secondary)]">Engine Runtime</span>
                <span className="font-mono text-[10px] text-[var(--vanta-muted)]">{allEnginesReady ? 'Ready' : 'Check Diagnostics'}</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono">
                {[
                  { label: 'yt-dlp', info: engineStatus?.ytdlp },
                  { label: 'spotDL', info: engineStatus?.spotdl },
                  { label: 'FFmpeg', info: engineStatus?.ffmpeg },
                ].map(({ label, info }) => {
                  const status = info?.status || 'checking';
                  const tone = info?.available
                    ? 'text-emerald-700 dark:text-[#3fb950] border-emerald-500/30 bg-emerald-500/10'
                    : status === 'checking'
                      ? 'text-blue-700 dark:text-[#58a6ff] border-blue-500/30 bg-blue-500/10'
                      : 'text-amber-700 dark:text-[#e3b341] border-amber-500/30 bg-amber-500/10';
                  return <div key={label} className={`px-1.5 py-1 rounded text-center truncate border ${tone}`} title={`${label}: ${info?.version || (status === 'checking' ? 'Checking...' : 'Unavailable')}`}>{label}</div>;
                })}
              </div>
            </div>
          ) : (
            <div className="flex justify-center py-1" title="Engine Runtime">
              {allEnginesReady ? <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-[#3fb950]" /> : <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-[#e3b341]" />}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {queueEditor && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4" onClick={() => setQueueEditor(null)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const name = queueName.trim();
              if (!name) return;
              try {
                if (queueEditor.mode === 'create') {
                  const next = await api.createQueue(name);
                  onQueuesChanged(next);
                  const created = next.find((queue) => queue.name.toLocaleLowerCase() === name.toLocaleLowerCase());
                  if (created) selectQueue(created.id);
                } else if (queueEditor.queueId) {
                  onQueuesChanged(await api.renameQueue(queueEditor.queueId, name));
                }
                setQueueEditor(null);
              } catch (error) {
                window.alert(error instanceof Error ? error.message : 'Queue operation failed.');
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] p-5 shadow-2xl"
          >
            <h2 className="text-base font-semibold text-[var(--vanta-text)]">{queueEditor.mode === 'create' ? 'Create Queue' : 'Rename Queue'}</h2>
            <p className="mt-1 text-xs text-[var(--vanta-muted)]">Organize downloads into separate queues.</p>
            <input
              autoFocus
              value={queueName}
              onChange={(event) => setQueueName(event.target.value)}
              maxLength={40}
              placeholder="Queue name"
              className="mt-4 h-10 w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 text-sm text-[var(--vanta-text)] outline-none focus:border-[var(--vanta-accent)]"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setQueueEditor(null)} className="px-3 py-2 rounded-lg border border-[var(--vanta-border)] text-xs text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)]">Cancel</button>
              <button type="submit" disabled={!queueName.trim()} className="px-4 py-2 rounded-lg bg-[var(--vanta-accent)] text-white text-xs font-semibold disabled:opacity-40">{queueEditor.mode === 'create' ? 'Create' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      <aside className={`relative hidden md:flex flex-col border-r border-[var(--vanta-border)] bg-[var(--vanta-surface)] transition-all duration-200 shrink-0 h-full overflow-hidden ${isCollapsed ? 'w-16' : 'w-60'}`}>
        {renderNavContent(false)}
      </aside>

      {queueMenu && (
        <div className="fixed inset-0 z-[90]" onClick={() => setQueueMenu(null)}>
          <div
            ref={queueMenuRef}
            role="menu"
            aria-label="Queue actions"
            onClick={(event) => event.stopPropagation()}
            style={{
              left: Math.max(8, Math.min(queueMenu.x, window.innerWidth - 224)),
              top: Math.max(8, Math.min(queueMenu.y, window.innerHeight - 180)),
            }}
            className="fixed z-[91] w-52 rounded-xl border border-[var(--vanta-border-strong)] bg-[var(--vanta-surface)] py-1.5 text-xs shadow-2xl"
          >
            {(() => {
              const queue = queues.find((item) => item.id === queueMenu.queueId);
              if (!queue) return null;
              return (
                <>
                  <p className="px-3 py-2 font-semibold text-[var(--vanta-text)] truncate">{queue.name}</p>
                  <div className="border-t border-[var(--vanta-border)] my-1" />
                  <button type="button" role="menuitem" onClick={async () => {
                    try {
                      onQueuesChanged(queue.is_paused ? await api.startQueue(queue.id) : await api.stopQueue(queue.id));
                    } catch (error) {
                      window.alert(error instanceof Error ? error.message : 'Queue action failed.');
                    } finally {
                      setQueueMenu(null);
                    }
                  }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] text-[var(--vanta-text)]">
                    {queue.is_paused ? 'Start Queue' : 'Stop Queue'}
                  </button>
                  {!queue.is_default && (
                    <>
                      <button type="button" role="menuitem" onClick={() => {
                        setQueueName(queue.name);
                        setQueueEditor({ mode: 'rename', queueId: queue.id });
                        setQueueMenu(null);
                      }} className="w-full px-3 py-2 text-left hover:bg-[var(--vanta-surface-hover)] text-[var(--vanta-text)]">
                        Rename
                      </button>
                      <button type="button" role="menuitem" onClick={async () => {
                        if (window.confirm(`Delete "${queue.name}"? Downloads will move to Main Queue.`)) {
                          try {
                            onQueuesChanged(await api.deleteQueue(queue.id));
                            if (selectedQueueId === queue.id) selectQueue('main');
                          } catch (error) {
                            window.alert(error instanceof Error ? error.message : 'Could not delete queue.');
                          }
                        }
                        setQueueMenu(null);
                      }} className="w-full px-3 py-2 text-left hover:bg-red-500/10 text-red-500">
                        Delete Queue
                      </button>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {isMobileOpen && <div className="fixed top-8 inset-x-0 bottom-0 z-40 bg-black/60 backdrop-blur-xs md:hidden" onClick={() => setIsMobileOpen(false)} aria-hidden="true" />}

      <aside className={`fixed top-8 bottom-0 left-0 z-50 w-64 bg-[var(--vanta-surface)] border-r border-[var(--vanta-border)] shadow-2xl transition-transform duration-200 md:hidden overflow-hidden ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {renderNavContent(true)}
      </aside>
    </>
  );
};
