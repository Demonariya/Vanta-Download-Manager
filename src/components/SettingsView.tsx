import React, { useState, useEffect } from 'react';
import {
  Settings,
  Save,
  FolderOpen,
  HardDrive,
  Cpu,
  Gauge,
  Sliders,
  Check,
  Shield,
  Bell,
  HelpCircle,
} from 'lucide-react';
import { AppSettings } from '../types';

interface SettingsViewProps {
  settings: AppSettings | null;
  onSaveSettings: (settings: Partial<AppSettings>) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
}) => {
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setForm(settings);
    }
  }, [settings]);

  if (!form) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(form);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">System Settings & Preferences</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Configure concurrency scheduler, engine limits, and output conventions
          </p>
        </div>

        <button
          type="submit"
          className="px-4 py-2 bg-[#238636] hover:bg-[#2ea043] text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors shadow-sm"
        >
          {isSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          <span>{isSaved ? 'Settings Saved' : 'Save Changes'}</span>
        </button>
      </div>

      {/* Section 1: Performance & Concurrency */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <div className="flex items-center gap-2 border-b border-[#21262d] pb-3">
          <Gauge className="w-4 h-4 text-[#58a6ff]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white font-mono">
            Concurrency & Performance
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Max Simultaneous Downloads: {form.max_concurrent_downloads}
            </label>
            <input
              type="range"
              min="1"
              max="10"
              value={form.max_concurrent_downloads}
              onChange={(e) =>
                setForm({ ...form, max_concurrent_downloads: parseInt(e.target.value, 10) })
              }
              className="w-full accent-[#1f6feb] cursor-pointer"
            />
            <span className="text-[11px] text-[#7d8590] block">
              Controls global active task queue slots
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Fragment Concurrency (yt-dlp -N): {form.fragment_concurrency}
            </label>
            <input
              type="range"
              min="1"
              max="16"
              value={form.fragment_concurrency}
              onChange={(e) =>
                setForm({ ...form, fragment_concurrency: parseInt(e.target.value, 10) })
              }
              className="w-full accent-[#1f6feb] cursor-pointer"
            />
            <span className="text-[11px] text-[#7d8590] block">
              Multi-fragment download concurrency per video stream
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Global Bandwidth Limit (KB/s)
            </label>
            <input
              type="number"
              min="0"
              placeholder="0 = unlimited"
              value={form.global_bandwidth_limit_kbps}
              onChange={(e) =>
                setForm({
                  ...form,
                  global_bandwidth_limit_kbps: parseInt(e.target.value, 10) || 0,
                })
              }
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 text-[#e6edf3]"
            />
            <span className="text-[11px] text-[#7d8590] block">
              0 for unrestricted network throughput
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Max Retries on Failure
            </label>
            <input
              type="number"
              min="0"
              max="10"
              value={form.max_retries}
              onChange={(e) =>
                setForm({ ...form, max_retries: parseInt(e.target.value, 10) || 0 })
              }
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 text-[#e6edf3]"
            />
            <span className="text-[11px] text-[#7d8590] block">
              Automatic retry attempts for recoverable network errors
            </span>
          </div>
        </div>
      </div>

      {/* Section 2: Storage & Naming Templates */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <div className="flex items-center gap-2 border-b border-[#21262d] pb-3">
          <HardDrive className="w-4 h-4 text-[#3fb950]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white font-mono">
            Storage & Naming Conventions
          </h2>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Target Download Folder
            </label>
            <input
              type="text"
              value={form.download_dir}
              onChange={(e) => setForm({ ...form, download_dir: e.target.value })}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Filename Template
            </label>
            <input
              type="text"
              value={form.filename_template}
              onChange={(e) => setForm({ ...form, filename_template: e.target.value })}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
            />
            <div className="text-[11px] text-[#7d8590] flex items-center gap-1.5 flex-wrap">
              <span>Variables:</span>
              <code className="text-[#58a6ff] bg-[#161b22] px-1 py-0.5 rounded">%(title)s</code>
              <code className="text-[#58a6ff] bg-[#161b22] px-1 py-0.5 rounded">%(id)s</code>
              <code className="text-[#58a6ff] bg-[#161b22] px-1 py-0.5 rounded">%(uploader)s</code>
              <code className="text-[#58a6ff] bg-[#161b22] px-1 py-0.5 rounded">%(ext)s</code>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[#21262d] bg-[#161b22] cursor-pointer">
              <input
                type="checkbox"
                checked={form.embed_thumbnail}
                onChange={(e) => setForm({ ...form, embed_thumbnail: e.target.checked })}
                className="w-4 h-4 rounded text-[#1f6feb] accent-[#1f6feb]"
              />
              <span className="text-xs text-[#c9d1d9]">Embed Cover Artwork / Thumbnail</span>
            </label>

            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[#21262d] bg-[#161b22] cursor-pointer">
              <input
                type="checkbox"
                checked={form.embed_metadata}
                onChange={(e) => setForm({ ...form, embed_metadata: e.target.checked })}
                className="w-4 h-4 rounded text-[#1f6feb] accent-[#1f6feb]"
              />
              <span className="text-xs text-[#c9d1d9]">Embed Media Tags & ID3 Metadata</span>
            </label>
          </div>
        </div>
      </div>

      {/* Section 3: Network & Proxy */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <div className="flex items-center gap-2 border-b border-[#21262d] pb-3">
          <Shield className="w-4 h-4 text-[#d29922]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white font-mono">
            Network & Proxy Routing
          </h2>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[#c9d1d9] block">
            Proxy URL (Optional)
          </label>
          <input
            type="text"
            placeholder="http://127.0.0.1:8080 or socks5://127.0.0.1:1080"
            value={form.proxy_url}
            onChange={(e) => setForm({ ...form, proxy_url: e.target.value })}
            className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
          />
          <span className="text-[11px] text-[#7d8590] block">
            Passed safely as --proxy to yt-dlp and network requests
          </span>
        </div>
      </div>

      {/* Section 4: Notifications & UI */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <div className="flex items-center gap-2 border-b border-[#21262d] pb-3">
          <Bell className="w-4 h-4 text-[#a371f7]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white font-mono">
            Notifications & Floating Surfaces
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[#21262d] bg-[#161b22] cursor-pointer">
            <input
              type="checkbox"
              checked={form.floating_notifications_enabled}
              onChange={(e) =>
                setForm({ ...form, floating_notifications_enabled: e.target.checked })
              }
              className="w-4 h-4 rounded text-[#1f6feb] accent-[#1f6feb]"
            />
            <span className="text-xs text-[#c9d1d9]">Enable Floating Progress Popups</span>
          </label>

          <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[#21262d] bg-[#161b22] cursor-pointer">
            <input
              type="checkbox"
              checked={form.auto_retry_failed}
              onChange={(e) => setForm({ ...form, auto_retry_failed: e.target.checked })}
              className="w-4 h-4 rounded text-[#1f6feb] accent-[#1f6feb]"
            />
            <span className="text-xs text-[#c9d1d9]">Auto-retry recoverable failures</span>
          </label>
        </div>
      </div>
    </form>
  );
};
