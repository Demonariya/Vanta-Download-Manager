import React, { useMemo, useState } from 'react';
import { X, Bell, Trash2, CheckCircle, AlertTriangle, AlertCircle, Info, CheckCheck } from 'lucide-react';
import { NotificationItem } from '../types';

interface NotificationCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  notifications: NotificationItem[];
  onClearAll: () => void;
  onMarkAllRead: () => void;
}

export const NotificationCenterModal: React.FC<NotificationCenterModalProps> = ({
  isOpen,
  onClose,
  notifications,
  onClearAll,
  onMarkAllRead,
}) => {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const unreadCount = notifications.filter((item) => !item.isRead).length;
  const visibleNotifications = useMemo(
    () => filter === 'unread' ? notifications.filter((item) => !item.isRead) : notifications,
    [filter, notifications]
  );

  if (!isOpen) return null;

  const getIcon = (type: NotificationItem['type']) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-[#3fb950] shrink-0" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-[#e3b341] shrink-0" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-600 dark:text-[#f85149] shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-blue-600 dark:text-[#58a6ff] shrink-0" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs select-none" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="notification-center-title" className="relative w-[calc(100vw-1.5rem)] max-w-lg bg-[var(--vanta-surface)] border border-[var(--vanta-border-strong)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[82vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className="w-4 h-4 text-[var(--vanta-accent)] shrink-0" />
            <div className="min-w-0">
              <h2 id="notification-center-title" className="text-xs font-semibold text-[var(--vanta-text)]">Notification Center</h2>
              <p className="text-[10px] text-[var(--vanta-muted)] mt-0.5">{notifications.length} stored · {unreadCount} unread</p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {unreadCount > 0 && (
              <button type="button" onClick={onMarkAllRead} title="Mark all as read" aria-label="Mark all notifications as read" className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-accent)] rounded transition-colors">
                <CheckCheck className="w-4 h-4" />
              </button>
            )}
            {notifications.length > 0 && (
              <button type="button" onClick={onClearAll} title="Clear all notifications" aria-label="Clear all notifications" className="p-1.5 text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] rounded transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close notifications" className="p-1.5 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-4 pt-3 flex items-center gap-1.5 border-b border-[var(--vanta-border)]">
          {(['all', 'unread'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${filter === value ? 'border-[var(--vanta-accent)] text-[var(--vanta-accent)]' : 'border-transparent text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'}`}>
              {value === 'all' ? `All (${notifications.length})` : `Unread (${unreadCount})`}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto space-y-2.5">
          {visibleNotifications.length === 0 ? (
            <div className="py-10 text-center text-[var(--vanta-muted)] text-xs">
              {filter === 'unread' ? 'You are all caught up.' : 'No recent notifications.'}
            </div>
          ) : (
            visibleNotifications.map((item) => (
              <div key={item.id} className={`p-3 rounded-lg border flex items-start gap-3 transition-colors ${item.isRead ? 'border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]' : 'border-[var(--vanta-accent)]/30 bg-[var(--vanta-accent)]/5'}`}>
                {getIcon(item.type)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {!item.isRead && <span className="w-1.5 h-1.5 rounded-full bg-[var(--vanta-accent)] shrink-0" />}
                      <h4 className="text-xs font-semibold text-[var(--vanta-text)] truncate">{item.title}</h4>
                    </div>
                    <span className="text-[10px] font-mono tabular-nums text-[var(--vanta-muted)] shrink-0">
                      {new Date(item.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--vanta-muted)] mt-1 break-words">{item.message}</p>
                  {item.taskId && <p className="text-[10px] font-mono text-[var(--vanta-muted)] mt-1 truncate">Task: {item.taskId}</p>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
