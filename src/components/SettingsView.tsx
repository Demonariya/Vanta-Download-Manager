import React, { useState, useEffect, useRef } from 'react';
import {
  Save,
  Check,
  Cookie,
  RefreshCw,
  Upload,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
  Terminal,
  RotateCcw,
  SlidersHorizontal,
  Download,
  Gauge,
  CalendarClock,
  Music2,
  Network,
  Info,
} from 'lucide-react';
import {
  AppSettings,
  ConflictStrategy,
  CookieStatus,
  CookieTestResult,
  CookieValidationResult,
  PythonValidationResult,
  ThemeMode,
} from '../types';
import { api } from '../services/api';
import { validateNetscapeCookies } from '../utils/cookie-validator';
import { describeCookieStatus } from '../utils/cookie-status-ui';
import { DEFAULT_SCHEDULER_SETTINGS } from '../utils/scheduler';
import { ConfirmDialog } from './ConfirmDialog';

interface SettingsViewProps {
  settings: AppSettings | null;
  onSaveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings | void> | void;
  onResetSettings?: () => Promise<AppSettings | void> | void;
}

type SettingsSection =
  | 'general'
  | 'downloads'
  | 'connection'
  | 'proxy'
  | 'scheduler'
  | 'media'
  | 'python'
  | 'cookies'
  | 'about';

const BROWSER_LABELS: Record<string, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  brave: 'Brave Browser',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
};

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
  onResetSettings,
}) => {
  const [section, setSection] = useState<SettingsSection>('general');
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  // Python executable configuration state
  const [validatingPython, setValidatingPython] = useState(false);
  const [pythonValidation, setPythonValidation] = useState<PythonValidationResult | null>(null);

  // Cookie state
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [testingCookies, setTestingCookies] = useState(false);
  const [cookieTestUrl, setCookieTestUrl] = useState('');
  const [cookieTestResult, setCookieTestResult] = useState<CookieTestResult | null>(null);
  const [cookieText, setCookieText] = useState('');
  const [cookieValidation, setCookieValidation] = useState<CookieValidationResult | null>(null);
  const [cookieActionError, setCookieActionError] = useState<string | null>(null);
  const [cookieActionNotice, setCookieActionNotice] = useState<string | null>(null);
  const [savingCookies, setSavingCookies] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshCookieStatus = async () => {
    try {
      const status = await api.getCookieStatus();
      setCookieStatus(status);
    } catch {
      // ignore transient error
    }
  };

  useEffect(() => {
    if (settings) {
      setForm({
        ...settings,
        scheduler: settings.scheduler || DEFAULT_SCHEDULER_SETTINGS,
      });
    }
    refreshCookieStatus();
  }, [settings]);

  useEffect(() => {
    if (!cookieText.trim()) {
      setCookieValidation(null);
      return;
    }
    setCookieValidation(validateNetscapeCookies(cookieText));
  }, [cookieText]);

  if (!form) {
    return (
      <div className="p-6 text-xs text-[var(--vanta-muted)]">Loading application settings...</div>
    );
  }

  const badge = describeCookieStatus(cookieStatus);
  const selectedBrowserInfo = cookieStatus?.detectedBrowsers.find(
    (b) => b.id === form.cookies_browser
  );
  const scheduler = form.scheduler || DEFAULT_SCHEDULER_SETTINGS;

  const handleBrowseFolder = async () => {
    const dir = await api.selectDirectory();
    if (dir) {
      setForm({ ...form, download_dir: dir });
    }
  };

  const handleBrowsePython = async () => {
    const selected = await api.browsePythonExecutable();
    if (selected) {
      setForm({ ...form, python_path: selected });
      setPythonValidation(null);
      setSaveError(null);
    }
  };

  const handleValidatePython = async () => {
    setValidatingPython(true);
    setSaveError(null);
    try {
      const res = await api.validatePythonExecutable(form.python_path || '');
      setPythonValidation(res);
    } catch (err: any) {
      setPythonValidation({
        valid: false,
        executablePath: form.python_path || 'python',
        error: err?.message || 'Failed to validate Python executable.',
      });
    } finally {
      setValidatingPython(false);
    }
  };

  const handleClearPython = () => {
    setForm({ ...form, python_path: '' });
    setPythonValidation(null);
    setSaveError(null);
  };

  const handleTestCookies = async () => {
    setTestingCookies(true);
    setCookieTestResult(null);
    setCookieActionError(null);
    try {
      await onSaveSettings({
        cookies_browser: form.cookies_browser || 'auto',
        cookies_profile: form.cookies_profile?.trim() || undefined,
        user_agent: form.user_agent,
      });
      const res = await api.testCookieExtraction(
        form.cookies_browser || 'auto',
        form.cookies_profile,
        cookieTestUrl
      );
      setCookieTestResult(res);
      await refreshCookieStatus();
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed to test cookie extraction.');
    } finally {
      setTestingCookies(false);
    }
  };

  const handleSaveCookieText = async () => {
    setCookieActionError(null);
    setCookieActionNotice(null);
    if (!cookieText.trim()) {
      setCookieActionError('Paste or upload Netscape cookies.txt content before saving.');
      return;
    }
    const validation = validateNetscapeCookies(cookieText);
    setCookieValidation(validation);
    if (!validation.valid) {
      setCookieActionError(validation.errors[0] || 'Invalid Netscape cookies.txt format.');
      return;
    }

    setSavingCookies(true);
    try {
      const updated = await api.saveCookies(cookieText);
      setCookieStatus(updated);
      setCookieText('');
      setCookieValidation(null);
      setForm((prev) => (prev ? { ...prev, cookies_file: updated.filePath } : null));
      setCookieActionNotice(
        `Saved ${updated.recordCount} validated cookie entries across ${updated.domainCount} domain(s).`
      );
      setTimeout(() => setCookieActionNotice(null), 4000);
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed to save cookies file.');
    } finally {
      setSavingCookies(false);
    }
  };

  const handleRemoveCookies = async () => {
    setCookieActionError(null);
    setCookieActionNotice(null);
    try {
      const updated = await api.removeCookies();
      setCookieStatus(updated);
      setCookieText('');
      setCookieValidation(null);
      setCookieTestResult(null);
      setForm((prev) => (prev ? { ...prev, cookies_file: undefined } : null));
      setCookieActionNotice('Imported cookie file removed.');
      setTimeout(() => setCookieActionNotice(null), 4000);
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed removing imported cookie file.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setCookieActionError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setCookieText(await file.text());
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed reading file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setIsSaved(false);
    setIsSaving(true);
    try {
      const saved = await onSaveSettings({
        ...form,
        python_path: form.python_path?.trim() || '',
        cookies_profile: form.cookies_profile?.trim() || undefined,
      });
      if (saved && typeof saved === 'object') {
        setForm({
          ...saved,
          scheduler: saved.scheduler || DEFAULT_SCHEDULER_SETTINGS,
        });
      }
      await refreshCookieStatus();
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2400);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmReset = async () => {
    setConfirmResetOpen(false);
    if (!onResetSettings) return;
    setSaveError(null);
    setIsSaving(true);
    try {
      const reset = await onResetSettings();
      if (reset && typeof reset === 'object') {
        setForm({
          ...reset,
          scheduler: reset.scheduler || DEFAULT_SCHEDULER_SETTINGS,
        });
      }
      setPythonValidation(null);
      await refreshCookieStatus();
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2400);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed resetting settings to defaults.');
    } finally {
      setIsSaving(false);
    }
  };

  const sectionTabs: Array<{
    id: SettingsSection;
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'general', label: 'General', description: 'Appearance and startup', icon: SlidersHorizontal },
    { id: 'downloads', label: 'Downloads', description: 'Folder and file naming', icon: Download },
    { id: 'connection', label: 'Connection', description: 'Speed and retry rules', icon: Gauge },
    { id: 'proxy', label: 'Proxy / SOCKS', description: 'Route media requests', icon: Network },
    { id: 'scheduler', label: 'Scheduler', description: 'Queue and time windows', icon: CalendarClock },
    { id: 'media', label: 'Media', description: 'Video and audio defaults', icon: Music2 },
    { id: 'python', label: 'Python', description: 'spotDL runtime', icon: Terminal },
    { id: 'cookies', label: 'Cookies & Auth', description: 'Browser sessions', icon: Cookie },
    { id: 'about', label: 'About', description: 'Version and shortcuts', icon: Info },
  ];

  return (
    <form onSubmit={handleSubmit} className="settings-form mx-auto w-full max-w-none min-w-0 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
        <div>
          <h1 className="text-base font-semibold text-[var(--vanta-text)]">
            Settings &amp; Preferences
          </h1>
          <p className="text-xs text-[var(--vanta-muted)] mt-0.5">
            Appearance, storage, connection limits, scheduler windows, Python runtime, and authentication
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {onResetSettings && (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => setConfirmResetOpen(true)}
              className="px-3 py-2 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-50 border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset to Defaults</span>
            </button>
          )}
          <button
            type="submit"
            disabled={isSaving}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            {isSaving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : isSaved ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{isSaving ? 'Saving...' : isSaved ? 'Saved' : 'Save Changes'}</span>
          </button>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          className="p-3 rounded-xl border border-red-500/35 bg-red-500/10 text-xs text-red-600 dark:text-[#f85149] flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {/* Responsive settings navigation: compact grid on small windows, vertical rail on desktop. */}
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[232px_minmax(0,1fr)] lg:items-start lg:gap-4">
        <nav aria-label="Settings sections" role="tablist" className="grid grid-cols-2 gap-1.5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] p-2 sm:grid-cols-4 lg:sticky lg:top-3 lg:grid-cols-1 lg:max-h-[calc(100dvh-190px)] lg:overflow-y-auto">
          {sectionTabs.map((tab) => {
            const active = section === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSection(tab.id)}
                className={`flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-[var(--vanta-accent)]/40 bg-[var(--vanta-accent)]/10 text-[var(--vanta-accent)]'
                    : 'border-transparent text-[var(--vanta-text-secondary)] hover:border-[var(--vanta-border)] hover:bg-[var(--vanta-surface-hover)]'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{tab.label}</span>
                  <span className="hidden truncate text-[10px] text-[var(--vanta-muted)] lg:block">{tab.description}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="settings-content min-w-0 space-y-4">
      {/* Section 1: General & Theme */}
      {section === 'general' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-5 text-xs">
          <div>
            <h2 className="text-sm font-semibold text-[var(--vanta-text)] mb-1">Appearance</h2>
            <p className="text-[var(--vanta-muted)] mb-3">
              Choose how VANTA Download Manager renders on your desktop.
            </p>
            <div className="grid grid-cols-3 gap-2.5 max-w-xl">
              {(
                [
                  { id: 'dark', label: 'Dark', icon: Moon },
                  { id: 'light', label: 'Light', icon: Sun },
                  { id: 'system', label: 'System', icon: Monitor },
                ] as const
              ).map(({ id, label, icon: Icon }) => {
                const selected = form.theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={async () => {
                      const nextTheme = id as ThemeMode;
                      setForm({ ...form, theme: nextTheme });
                      setSaveError(null);
                      try {
                        await onSaveSettings({ theme: nextTheme });
                      } catch (err: any) {
                        setSaveError(err?.message || 'Failed saving theme preference.');
                      }
                    }}
                    className={`p-3 rounded-lg border flex items-center justify-center gap-2 font-medium transition-colors ${
                      selected
                        ? 'border-[var(--vanta-accent)] bg-[var(--vanta-accent)]/12 text-[var(--vanta-accent)]'
                        : 'border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] text-[var(--vanta-text-secondary)] hover:bg-[var(--vanta-surface-hover)]'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-[var(--vanta-border)] pt-4 space-y-2.5">
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">Desktop Behavior</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.clipboard_monitoring)}
                  onChange={(e) => setForm({ ...form, clipboard_monitoring: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">
                  Prompt when supported media URL is copied to clipboard
                </span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.tray_minimize_on_close)}
                  onChange={(e) => setForm({ ...form, tray_minimize_on_close: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">
                  Close to System Tray instead of exiting the application
                </span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.launch_on_startup)}
                  onChange={(e) => setForm({ ...form, launch_on_startup: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">Launch VANTA when I sign in to Windows</span>
              </label>

              <label className={`flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] ${form.launch_on_startup ? 'cursor-pointer' : 'opacity-50'}`}>
                <input
                  type="checkbox"
                  checked={Boolean(form.start_minimized)}
                  disabled={!form.launch_on_startup}
                  onChange={(e) => setForm({ ...form, start_minimized: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">Start minimized in the system tray</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.auto_resume_on_startup)}
                  onChange={(e) => setForm({ ...form, auto_resume_on_startup: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">Restore queued downloads when VANTA starts</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.verify_media_on_complete !== false}
                  onChange={(e) => setForm({ ...form, verify_media_on_complete: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">
                  Verify completed media files &amp; codecs with FFprobe
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {section === 'general' && (
        <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] p-4 sm:p-5 space-y-3 text-xs">
          <div>
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">Notifications</h2>
            <p className="mt-1 text-[11px] text-[var(--vanta-muted)]">Choose how long transient status messages remain visible.</p>
          </div>
          <div className="max-w-sm space-y-1.5">
            <label className="block font-medium text-[var(--vanta-text-secondary)]">Notification auto-dismiss time</label>
            <select
              value={form.auto_dismiss_seconds}
              onChange={(e) => setForm({ ...form, auto_dismiss_seconds: parseInt(e.target.value, 10) })}
              className="w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2 text-[var(--vanta-text)]"
            >
              <option value={3}>3 seconds</option>
              <option value={5}>5 seconds</option>
              <option value={8}>8 seconds</option>
              <option value={10}>10 seconds</option>
              <option value={15}>15 seconds</option>
              <option value={30}>30 seconds</option>
            </select>
          </div>
        </div>
      )}

      {/* Section 2: Downloads & Storage */}
      {section === 'downloads' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-4 text-xs">
          <div className="space-y-1.5">
            <label className="font-medium text-[var(--vanta-text-secondary)] block">
              Download Destination Folder
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={form.download_dir}
                onChange={(e) => setForm({ ...form, download_dir: e.target.value })}
                className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg p-2 font-mono text-[var(--vanta-text)]"
              />
              {api.isTauri() && (
                <button
                  type="button"
                  onClick={handleBrowseFolder}
                  className="px-3 py-2 rounded-lg bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text)] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse</span>
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Filename Template (yt-dlp)
              </label>
              <input
                type="text"
                value={form.filename_template}
                onChange={(e) => setForm({ ...form, filename_template: e.target.value })}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg p-2 font-mono text-[var(--vanta-text)]"
              />
              <p className="text-[11px] text-[var(--vanta-muted)]">
                Variables: %(title)s, %(id)s, %(uploader)s, %(ext)s
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                File Conflict Strategy
              </label>
              <select
                value={form.conflict_strategy || 'rename'}
                onChange={(e) =>
                  setForm({ ...form, conflict_strategy: e.target.value as ConflictStrategy })
                }
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 text-[var(--vanta-text)]"
              >
                <option value="rename">Auto-rename (e.g. file (1).ext)</option>
                <option value="overwrite">Overwrite existing file</option>
                <option value="skip">Skip if destination already exists</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
              <input
                type="checkbox"
                checked={form.embed_thumbnail}
                onChange={(e) => setForm({ ...form, embed_thumbnail: e.target.checked })}
                className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
              />
              <span className="text-[var(--vanta-text-secondary)]">Embed Cover Artwork / Thumbnail</span>
            </label>
            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] cursor-pointer">
              <input
                type="checkbox"
                checked={form.embed_metadata}
                onChange={(e) => setForm({ ...form, embed_metadata: e.target.checked })}
                className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
              />
              <span className="text-[var(--vanta-text-secondary)]">Embed Media Tags &amp; Metadata</span>
            </label>
          </div>
        </div>
      )}

      {/* Section 3: Connection & Limits */}
      {section === 'connection' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
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
                className="w-full accent-[var(--vanta-accent)] cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Max Retries per Transfer
              </label>
              <input
                type="number"
                min="0"
                max="10"
                value={form.max_retries}
                onChange={(e) =>
                  setForm({ ...form, max_retries: parseInt(e.target.value, 10) || 0 })
                }
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono tabular-nums text-[var(--vanta-text)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Global Bandwidth Cap (KB/s, 0 = unlimited)
              </label>
              <input
                type="number"
                min="0"
                value={form.global_bandwidth_limit_kbps}
                onChange={(e) =>
                  setForm({
                    ...form,
                    global_bandwidth_limit_kbps: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono tabular-nums text-[var(--vanta-text)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Per-Task Bandwidth Cap (KB/s, 0 = unlimited)
              </label>
              <input
                type="number"
                min="0"
                value={form.per_task_bandwidth_limit_kbps}
                onChange={(e) =>
                  setForm({
                    ...form,
                    per_task_bandwidth_limit_kbps: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono tabular-nums text-[var(--vanta-text)]"
              />
            </div>
          </div>

        </div>
      )}

      {section === 'proxy' && (
        <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] p-4 sm:p-5 space-y-4 text-xs">
          <div>
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">Proxy / SOCKS</h2>
            <p className="mt-1 text-[11px] text-[var(--vanta-muted)]">Route supported media extraction and download requests through an HTTP or SOCKS5 proxy.</p>
          </div>
          <div className="space-y-1.5 max-w-2xl">
            <label className="font-medium text-[var(--vanta-text-secondary)] block">Proxy URL</label>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8080 or socks5://127.0.0.1:1080"
              value={form.proxy_url}
              onChange={(e) => setForm({ ...form, proxy_url: e.target.value })}
              className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2.5 font-mono text-[var(--vanta-text)]"
            />
            <p className="text-[10px] text-[var(--vanta-muted)]">Leave empty to use the normal network route. Credentials, if required, must be included in the proxy URL.</p>
          </div>
        </div>
      )}

      {section === 'connection' && (
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] p-4 sm:grid-cols-2 sm:p-5">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-3">
            <input
              type="checkbox"
              checked={Boolean(form.auto_retry_failed)}
              onChange={(e) => setForm({ ...form, auto_retry_failed: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded accent-[var(--vanta-accent)]"
            />
            <span>
              <span className="block text-xs font-medium text-[var(--vanta-text-secondary)]">Automatically retry failed downloads</span>
              <span className="mt-0.5 block text-[10px] text-[var(--vanta-muted)]">Retry transient network and extraction failures.</span>
            </span>
          </label>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--vanta-text-secondary)]">Delay between retries (seconds)</label>
            <input
              type="number"
              min="1"
              max="120"
              value={form.retry_delay_seconds}
              onChange={(e) => setForm({ ...form, retry_delay_seconds: Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 1)) })}
              className="w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2 font-mono tabular-nums text-[var(--vanta-text)]"
            />
            <p className="text-[10px] text-[var(--vanta-muted)]">Used when automatic retry is enabled.</p>
          </div>
        </div>
      )}

      {/* Section 4: Queue & Scheduler */}
      {section === 'scheduler' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-5 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
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
                className="w-full accent-[var(--vanta-accent)] cursor-pointer"
              />
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_retry_failed}
                  onChange={(e) => setForm({ ...form, auto_retry_failed: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">
                  Auto-retry transient network failures
                </span>
              </label>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_resume_on_startup}
                  onChange={(e) => setForm({ ...form, auto_resume_on_startup: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">
                  Resume unfinished queue items on startup
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-[var(--vanta-border)] pt-4 space-y-3">
            <label className="flex items-center gap-2.5 font-medium text-[var(--vanta-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={scheduler.enabled}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scheduler: { ...scheduler, enabled: e.target.checked },
                  })
                }
                className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
              />
              <span>Enable Scheduled Download Window (Quiet Hours / Off-Peak)</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] text-[var(--vanta-muted)] block">Start Time</label>
                <input
                  type="time"
                  value={scheduler.start_time}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scheduler: { ...scheduler, start_time: e.target.value },
                    })
                  }
                  className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono text-[var(--vanta-text)]"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-[var(--vanta-muted)] block">Stop Time</label>
                <input
                  type="time"
                  value={scheduler.stop_time}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scheduler: { ...scheduler, stop_time: e.target.value },
                    })
                  }
                  className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono text-[var(--vanta-text)]"
                />
              </div>
              <label className="flex items-center gap-2 pt-5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scheduler.pause_on_stop}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scheduler: { ...scheduler, pause_on_stop: e.target.checked },
                    })
                  }
                  className="w-4 h-4 rounded accent-[var(--vanta-accent)]"
                />
                <span className="text-[var(--vanta-text-secondary)]">Pause active outside window</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {DAYS_OF_WEEK.map((dayLabel, idx) => {
                const active = scheduler.days.includes(idx);
                return (
                  <button
                    key={dayLabel}
                    type="button"
                    onClick={() => {
                      const nextDays = active
                        ? scheduler.days.filter((d) => d !== idx)
                        : [...scheduler.days, idx].sort((a, b) => a - b);
                      setForm({
                        ...form,
                        scheduler: { ...scheduler, days: nextDays },
                      });
                    }}
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium transition-colors ${
                      active
                        ? 'bg-[var(--vanta-accent)] border-[var(--vanta-accent)] text-white'
                        : 'bg-[var(--vanta-surface-2)] border-[var(--vanta-border)] text-[var(--vanta-muted)]'
                    }`}
                  >
                    {dayLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Section 5: Audio & Video Defaults */}
      {section === 'media' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div className="space-y-1.5">
            <label className="font-medium text-[var(--vanta-text-secondary)] block">
              Default Video Container
            </label>
            <select
              value={form.default_video_format}
              onChange={(e) => setForm({ ...form, default_video_format: e.target.value })}
              className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 text-[var(--vanta-text)]"
            >
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
              <option value="webm">WebM</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="font-medium text-[var(--vanta-text-secondary)] block">
              Default Audio Format
            </label>
            <select
              value={form.default_audio_format}
              onChange={(e) => setForm({ ...form, default_audio_format: e.target.value })}
              className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 text-[var(--vanta-text)]"
            >
              <option value="mp3">MP3</option>
              <option value="m4a">M4A</option>
              <option value="opus">OPUS</option>
              <option value="flac">FLAC</option>
              <option value="wav">WAV</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="font-medium text-[var(--vanta-text-secondary)] block">
              Default Audio Bitrate
            </label>
            <select
              value={form.default_audio_bitrate}
              onChange={(e) => setForm({ ...form, default_audio_bitrate: e.target.value })}
              className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 text-[var(--vanta-text)]"
            >
              <option value="320k">320 kbps</option>
              <option value="256k">256 kbps</option>
              <option value="192k">192 kbps</option>
              <option value="128k">128 kbps</option>
            </select>
          </div>
        </div>
      )}

      {section === 'media' && (
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] p-4 sm:grid-cols-2 sm:p-5">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--vanta-text-secondary)]">Default PCM sample rate</label>
            <select
              value={form.default_audio_sample_rate ?? 48000}
              onChange={(e) => setForm({ ...form, default_audio_sample_rate: parseInt(e.target.value, 10) })}
              className="w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2 text-[var(--vanta-text)]"
            >
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={96000}>96 kHz</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[var(--vanta-text-secondary)]">Default PCM bit depth</label>
            <select
              value={form.default_audio_bit_depth ?? 24}
              onChange={(e) => setForm({ ...form, default_audio_bit_depth: parseInt(e.target.value, 10) })}
              className="w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2 text-[var(--vanta-text)]"
            >
              <option value={16}>16-bit</option>
              <option value={24}>24-bit</option>
            </select>
          </div>
        </div>
      )}

      {/* Section 6: Python Configuration (for spotDL) */}
      {section === 'python' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-4 text-xs">
          <div className="flex items-start justify-between gap-2 pb-3 border-b border-[var(--vanta-border)]">
            <div>
              <h2 className="text-sm font-semibold text-[var(--vanta-text)] flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[var(--vanta-accent)]" />
                <span>Python Configuration (spotDL Environment)</span>
              </h2>
              <p className="text-[11px] text-[var(--vanta-muted)] mt-1">
                Configure the Python 3 interpreter used to create and run VANTA&apos;s isolated spotDL virtual environment inside Engine\spotdl\venv. When a custom path is provided, VANTA validates it strictly without falling back to PATH.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="python-executable-path"
              className="font-medium text-[var(--vanta-text-secondary)] block"
            >
              Python Executable Path (Optional — leave blank for auto-detection)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="python-executable-path"
                type="text"
                value={form.python_path || ''}
                onChange={(e) => {
                  setForm({ ...form, python_path: e.target.value });
                  setPythonValidation(null);
                }}
                placeholder="C:\\Program Files\\Python312\\python.exe or /usr/bin/python3"
                className="w-full min-w-0 flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg p-2 font-mono text-[var(--vanta-text)]"
              />
              {api.isTauri() && (
                <button
                  type="button"
                  onClick={handleBrowsePython}
                  className="px-3 py-2 rounded-lg bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text)] font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse</span>
                </button>
              )}
              <button
                type="button"
                disabled={validatingPython}
                onClick={handleValidatePython}
                className="px-3 py-2 rounded-lg bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] disabled:opacity-50 text-white font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {validatingPython ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{validatingPython ? 'Validating...' : 'Validate'}</span>
              </button>
              {form.python_path && (
                <button
                  type="button"
                  onClick={handleClearPython}
                  className="px-3 py-2 rounded-lg bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] font-medium whitespace-nowrap shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {pythonValidation && (
            <div
              data-testid="python-validation-result"
              className={`p-3 rounded-lg border space-y-1 ${
                pythonValidation.valid
                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-700 dark:text-[#3fb950]'
                  : 'bg-red-500/10 border-red-500/35 text-red-600 dark:text-[#f85149]'
              }`}
            >
              <div className="flex items-start gap-2">
                {pythonValidation.valid ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 min-w-0">
                  <p className="font-medium">
                    {pythonValidation.valid
                      ? `Verified ${pythonValidation.version || 'Python 3'}`
                      : pythonValidation.error || 'Python validation failed'}
                  </p>
                  <p className="text-[11px] font-mono text-[var(--vanta-text-secondary)] break-all">
                    Executable: {pythonValidation.executablePath}
                  </p>
                  {pythonValidation.stderr && !pythonValidation.valid && (
                    <p className="text-[11px] font-mono text-[var(--vanta-text-secondary)] break-words">
                      {pythonValidation.stderr}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Section 7: Cookies & Auth */}
      {section === 'cookies' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--vanta-border)]">
            <div className="flex items-center gap-2">
              <Cookie className="w-4 h-4 text-emerald-600 dark:text-[#3fb950]" />
              <h2 className="text-sm font-semibold text-[var(--vanta-text)]">
                Cookies &amp; Authenticated Media Access
              </h2>
            </div>
            <span data-testid="cookie-status-badge" className="font-mono text-[11px] text-[var(--vanta-accent)]">
              {badge.badgeText}
            </span>
          </div>

          <div className="p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <p className="font-medium text-[var(--vanta-text)]">
                Active Source: <span className="font-mono">{badge.badgeText}</span>
              </p>
              <p className="text-[11px] text-[var(--vanta-muted)]">{badge.detail}</p>
              {cookieStatus?.fileExists && (
                <p className="text-[11px] text-[var(--vanta-muted)] font-mono truncate">
                  {cookieStatus.filePath} · {cookieStatus.recordCount} entries · {cookieStatus.domainCount} domains
                </p>
              )}
            </div>
            {cookieStatus?.fileExists && (
              <button
                type="button"
                onClick={handleRemoveCookies}
                className="px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-[#f85149] rounded-lg font-medium flex items-center gap-1.5 shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove File</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Browser for Cookie Extraction
              </label>
              <select
                value={form.cookies_browser || 'auto'}
                onChange={(e) => setForm({ ...form, cookies_browser: e.target.value as any })}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 text-[var(--vanta-text)]"
              >
                <option value="auto">Auto-Detect Installed Browser</option>
                {Object.entries(BROWSER_LABELS).map(([id, label]) => {
                  const info = cookieStatus?.detectedBrowsers.find((b) => b.id === id);
                  const suffix = info
                    ? info.detected
                      ? info.hasCookieStore
                        ? ' (Detected)'
                        : ' (No Cookie DB)'
                      : ' (Not Detected)'
                    : '';
                  return (
                    <option key={id} value={id}>
                      {label}
                      {suffix}
                    </option>
                  );
                })}
                <option value="none">Disabled</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Browser Profile (Optional)
              </label>
              <input
                type="text"
                list="vanta-browser-profiles"
                value={form.cookies_profile || ''}
                placeholder={selectedBrowserInfo?.defaultProfile || 'Default'}
                onChange={(e) => setForm({ ...form, cookies_profile: e.target.value })}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono text-[var(--vanta-text)]"
              />
              <datalist id="vanta-browser-profiles">
                {(selectedBrowserInfo?.profiles || []).map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                User-Agent Override (Optional)
              </label>
              <input
                type="text"
                value={form.user_agent || ''}
                placeholder="Mozilla/5.0..."
                onChange={(e) => setForm({ ...form, user_agent: e.target.value })}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono text-[var(--vanta-text)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--vanta-text-secondary)] block">
                Verification Test URL (Optional)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cookieTestUrl}
                  onChange={(e) => setCookieTestUrl(e.target.value)}
                  placeholder="https://..."
                  className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2 font-mono text-[var(--vanta-text)]"
                />
                <button
                  type="button"
                  onClick={handleTestCookies}
                  disabled={testingCookies}
                  className="px-3 py-1.5 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-1.5 shrink-0"
                >
                  {testingCookies ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  <span>{testingCookies ? 'Testing...' : 'Test'}</span>
                </button>
              </div>
            </div>
          </div>

          {cookieTestResult && (
            <div
              data-testid="cookie-test-result"
              className={`p-3 rounded-lg border space-y-1 ${
                cookieTestResult.success
                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-700 dark:text-[#3fb950]'
                  : 'bg-red-500/10 border-red-500/35 text-red-600 dark:text-[#f85149]'
              }`}
            >
              <div className="flex items-start gap-2">
                {cookieTestResult.success ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <p className="font-medium">{cookieTestResult.message}</p>
                  <p className="text-[11px] font-mono text-[var(--vanta-text-secondary)]">
                    Stage: {cookieTestResult.stage} · Source: {cookieTestResult.activeSource}
                  </p>
                  {cookieTestResult.nextAction && (
                    <p className="text-[11px] text-[var(--vanta-text)]">
                      Next action: {cookieTestResult.nextAction}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2 pt-3 border-t border-[var(--vanta-border)]">
            <div className="flex items-center justify-between gap-2">
              <label className="font-medium text-[var(--vanta-text-secondary)]">
                Import or Paste Netscape Cookies (cookies.txt)
              </label>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded flex items-center gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload cookies.txt</span>
                </button>
              </div>
            </div>

            <textarea
              rows={4}
              value={cookieText}
              onChange={(e) => {
                setCookieText(e.target.value);
                setCookieActionError(null);
              }}
              placeholder="# Netscape HTTP Cookie File"
              className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg p-2.5 font-mono text-[var(--vanta-text)]"
            />

            {cookieValidation && (
              <p
                className={`text-[11px] font-mono ${
                  cookieValidation.valid
                    ? 'text-emerald-700 dark:text-[#3fb950]'
                    : 'text-red-600 dark:text-[#f85149]'
                }`}
              >
                {cookieValidation.valid
                  ? `Valid Netscape format: ${cookieValidation.recordCount} entries across ${cookieValidation.domainCount} domain(s).`
                  : cookieValidation.errors[0]}
              </p>
            )}

            {cookieActionError && (
              <div className="p-2.5 rounded-lg border border-red-500/35 bg-red-500/10 text-red-600 dark:text-[#f85149] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{cookieActionError}</span>
              </div>
            )}
            {cookieActionNotice && (
              <div className="p-2.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-[#3fb950] flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{cookieActionNotice}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveCookieText}
                disabled={
                  savingCookies ||
                  !cookieText.trim() ||
                  (cookieValidation !== null && !cookieValidation.valid)
                }
                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-medium"
              >
                {savingCookies ? 'Saving...' : 'Save Cookie File'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Section 8: About */}
      {section === 'about' && (
        <div className="p-4 sm:p-5 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-2 text-xs">
          <h2 className="text-sm font-semibold text-[var(--vanta-text)]">
            VANTA Download Manager
          </h2>
          <p className="text-[var(--vanta-muted)] leading-relaxed">
            Focused video and music download workstation powered by yt-dlp, FFmpeg/FFprobe, and spotDL in an isolated virtual environment.
          </p>
          <p className="font-mono text-[11px] text-[var(--vanta-muted)] pt-2">
            Keyboard shortcuts: Ctrl/Cmd + N (New Download) · Esc (Close inspector/modal)
          </p>
        </div>
      )}

        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmResetOpen}
        title="Reset Settings to Defaults"
        message="Restore all VANTA preferences, scheduler windows, bandwidth limits, and Python path to default values?"
        confirmLabel="Reset Defaults"
        danger
        onConfirm={handleConfirmReset}
        onCancel={() => setConfirmResetOpen(false)}
      />
    </form>
  );
};
