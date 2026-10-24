import React from 'react';
import {
  X,
  Bell,
  Trash2,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { NotificationItem } from '../types';

interface NotificationCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  notifications: NotificationItem[];
  onClearAll: () => void;
}

export const NotificationCenterModal: React.FC<NotificationCenterModalProps> = ({
  isOpen,
  onClose,
  notifications,
  onClearAll,
}) => {
  if (!isOpen) return null;

  const getIcon = (type: NotificationItem['type']) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-[#3fb950] shrink-0" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-[#d29922] shrink-0" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-[#f85149] shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-[#58a6ff] shrink-0" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs select-none">
      <div className="relative w-[calc(100vw-1.5rem)] max-w-md bg-[#12151a] border border-[#30363d] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#21262d] bg-[#0d1117]">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#58a6ff]" />
            <h2 className="text-xs font-semibold text-white">Event Notifications</h2>
          </div>
          <div className="flex items-center gap-1">
            {notifications.length > 0 && (
              <button
                onClick={onClearAll}
                title="Clear all"
                className="p-1 text-[#8b949e] hover:text-[#f85149] rounded transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-[#8b949e] hover:text-white rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="p-4 overflow-y-auto space-y-2.5">
          {notifications.length === 0 ? (
            <div className="py-10 text-center text-[#8b949e] text-xs">
              No recent notifications
            </div>
          ) : (
            notifications.map((item) => (
              <div
                key={item.id}
                className="p-3 rounded-lg border border-[#21262d] bg-[#161b22] flex items-start gap-3"
              >
                {getIcon(item.type)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-white">{item.title}</h4>
                    <span className="text-[10px] font-mono text-[#7d8590]">
                      {new Date(item.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <p className="text-xs text-[#8b949e] mt-1 break-words">{item.message}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
