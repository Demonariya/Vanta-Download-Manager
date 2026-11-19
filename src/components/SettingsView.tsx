import React, { useState, useEffect, useRef } from 'react';
import {
  Save,
  HardDrive,
  Gauge,
  Check,
  Shield,
  Bell,
  Cookie,
  RefreshCw,
  Upload,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  AppSettings,
  CookieStatus,
  CookieTestResult,
  CookieValidationResult,
} from '../types';
import { api } from '../services/api';
import { validateNetscapeCookies } from '../utils/cookie-validator';
import { describeCookieStatus } from '../utils/cookie-status-ui';

interface SettingsViewProps {
  settings: AppSettings | null;
  onSaveSettings: (settings: Partial<AppSettings>) => void;
}

const BROWSER_LABELS: Record<string, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  brave: 'Brave Browser',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
}) => {
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [isSaved, setIsSaved] = useState(false);

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
      // ignore initial transient errors
    }
  };

  useEffect(() => {
    if (settings) {
      setForm(settings);
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

  if (!form) return null;

  const badge = describeCookieStatus(cookieStatus);

  const badgeToneClass =
    badge.tone === 'success'
      ? 'bg-[#238636]/15 text-[#3fb950] border-[#238636]/30'
      : badge.tone === 'info'
      ? 'bg-[#1f6feb]/15 text-[#58a6ff] border-[#1f6feb]/30'
      : badge.tone === 'warning'
      ? 'bg-[#d29922]/15 text-[#e3b341] border-[#d29922]/30'
      : badge.tone === 'error'
      ? 'bg-[#da3633]/15 text-[#f85149] border-[#da3633]/40'
      : 'bg-[#21262d] text-[#8b949e] border-[#30363d]';

  const selectedBrowserInfo = cookieStatus?.detectedBrowsers.find(
    (b) => b.id === form.cookies_browser
  );

  const handleTestCookies = async () => {
    setTestingCookies(true);
    setCookieTestResult(null);
    setCookieActionError(null);
    try {
      // Persist current browser/profile choice first if modified so diagnostics reflects saved settings cleanly
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
      setCookieActionNotice('Imported cookie file removed. Active mode fell back to browser selection.');
      setTimeout(() => setCookieActionNotice(null), 4000);
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed removing imported cookie file.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setCookieActionError(null);
    setCookieActionNotice(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setCookieText(text);
    } catch (err: any) {
      setCookieActionError(err.message || 'Failed reading selected file.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveSettings({
      ...form,
      cookies_profile: form.cookies_profile?.trim() || undefined,
    });
    await refreshCookieStatus();
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <h1 className="text-base font-semibold text-white">System Settings & Preferences</h1>
          <p className="text-xs text-[#8b949e] mt-0.5">
            Configure concurrency scheduler, engine limits, and authenticated media access
          </p>
        </div>

        <button
          type="submit"
          className="w-full sm:w-auto px-4 py-2 bg-[#238636] hover:bg-[#2ea043] text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors shadow-sm"
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

      {/* Section 5: Cookies & Authenticated Media Access */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#21262d] pb-3">
          <div className="flex items-center gap-2">
            <Cookie className="w-4 h-4 text-[#3fb950]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white font-mono">
              Cookies & Authenticated Media Access
            </h2>
          </div>
          <span
            data-testid="cookie-status-badge"
            className={`text-[11px] font-mono px-2 py-0.5 rounded border self-start sm:self-auto ${badgeToneClass}`}
          >
            {badge.badgeText}
          </span>
        </div>

        <p className="text-xs text-[#8b949e]">
          Configure how yt-dlp loads user-authorized session cookies. Imported Netscape <code className="text-[#c9d1d9]">cookies.txt</code> files take precedence over browser extraction; secrets are stored only inside the local cookie file and never logged.
        </p>

        {/* Active Cookie File Metadata Summary */}
        <div className="p-3 rounded-lg border border-[#21262d] bg-[#161b22] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-white">Active Cookie Source:</span>
              <span className="font-mono text-[#58a6ff]">{badge.badgeText}</span>
            </div>
            <p className="text-[11px] text-[#8b949e]">{badge.detail}</p>
            {cookieStatus?.fileExists && (
              <div className="text-[11px] text-[#7d8590] font-mono truncate">
                {cookieStatus.filePath} · {cookieStatus.recordCount} entries · {cookieStatus.domainCount} domain(s) · {cookieStatus.httpOnlyCount} HttpOnly
              </div>
            )}
          </div>

          {cookieStatus?.fileExists && (
            <button
              type="button"
              onClick={handleRemoveCookies}
              className="px-2.5 py-1.5 bg-[#da3633]/15 hover:bg-[#da3633]/25 text-[#f85149] border border-[#da3633]/30 rounded-lg text-xs font-medium flex items-center gap-1.5 shrink-0 self-start sm:self-auto"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove Cookies</span>
            </button>
          )}
        </div>

        {/* Browser & Profile Selection + Multi-Stage Test */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Browser for Cookie Extraction
            </label>
            <select
              value={form.cookies_browser || 'auto'}
              onChange={(e) => setForm({ ...form, cookies_browser: e.target.value as any })}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 text-[#e6edf3]"
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
              <option value="none">Disabled (No cookies)</option>
            </select>
            <span className="text-[11px] text-[#7d8590] block">
              Used when no valid imported cookies.txt file is active
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Browser Profile (Optional)
            </label>
            <input
              type="text"
              list="vanta-browser-profiles"
              value={form.cookies_profile || ''}
              placeholder={selectedBrowserInfo?.defaultProfile || 'Default'}
              onChange={(e) => setForm({ ...form, cookies_profile: e.target.value })}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
            />
            <datalist id="vanta-browser-profiles">
              {(selectedBrowserInfo?.profiles || []).map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <span className="text-[11px] text-[#7d8590] block">
              {selectedBrowserInfo && selectedBrowserInfo.profiles.length > 0
                ? `Detected profiles: ${selectedBrowserInfo.profiles.join(', ')}`
                : 'Leave blank to use default browser profile'}
            </span>
          </div>
        </div>

        {/* User-Agent & Optional Verification URL */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              User-Agent Emulation
            </label>
            <input
              type="text"
              value={form.user_agent || ''}
              placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."
              onChange={(e) => setForm({ ...form, user_agent: e.target.value })}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Optional Test URL for Authentication Check
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={cookieTestUrl}
                onChange={(e) => setCookieTestUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1 bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2 font-mono text-[#e6edf3]"
              />
              <button
                type="button"
                onClick={handleTestCookies}
                disabled={testingCookies}
                className="px-3 py-1.5 bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
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

        {/* Multi-Stage Cookie Test Output */}
        {cookieTestResult && (
          <div
            data-testid="cookie-test-result"
            className={`p-3 rounded-lg border text-xs space-y-2 ${
              cookieTestResult.success
                ? 'bg-[#238636]/10 border-[#238636]/30 text-[#3fb950]'
                : 'bg-[#da3633]/10 border-[#da3633]/30 text-[#f85149]'
            }`}
          >
            <div className="flex items-start gap-2">
              {cookieTestResult.success ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <div className="font-medium">{cookieTestResult.message}</div>
                <div className="flex flex-wrap gap-2 text-[10px] font-mono text-[#c9d1d9]">
                  <span>Stage: {cookieTestResult.stage}</span>
                  <span>· Source: {cookieTestResult.activeSource}</span>
                  {cookieTestResult.resolvedBrowser && (
                    <span>· Browser: {cookieTestResult.resolvedBrowser}</span>
                  )}
                  {cookieTestResult.resolvedProfile && (
                    <span>· Profile: {cookieTestResult.resolvedProfile}</span>
                  )}
                  <span>· DB Accessible: {cookieTestResult.databaseAccessible ? 'Yes' : 'No'}</span>
                </div>
                {cookieTestResult.nextAction && (
                  <div className="text-[11px] text-[#e6edf3]">
                    Next action: {cookieTestResult.nextAction}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Import / Upload / Paste Netscape cookies.txt */}
        <div className="space-y-2 pt-2 border-t border-[#21262d]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <label className="text-xs font-medium text-[#c9d1d9] block">
              Import or Paste Netscape Cookies (cookies.txt format)
            </label>
            <div className="flex items-center gap-2">
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
                className="px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] rounded text-xs font-medium flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5 text-[#58a6ff]" />
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
            placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;1899999999&#9;SID&#9;..."
            className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-xs p-2.5 font-mono text-[#e6edf3] placeholder-[#6e7681]"
          />

          {cookieValidation && (
            <div
              className={`text-[11px] font-mono ${
                cookieValidation.valid ? 'text-[#3fb950]' : 'text-[#f85149]'
              }`}
            >
              {cookieValidation.valid
                ? `Valid Netscape cookie format: ${cookieValidation.recordCount} entries across ${cookieValidation.domainCount} domain(s).`
                : cookieValidation.errors[0] || 'Invalid Netscape format.'}
            </div>
          )}

          {cookieActionError && (
            <div className="p-2.5 rounded-lg border border-[#da3633]/40 bg-[#da3633]/10 text-xs text-[#f85149] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{cookieActionError}</span>
            </div>
          )}

          {cookieActionNotice && (
            <div className="p-2.5 rounded-lg border border-[#238636]/40 bg-[#238636]/10 text-xs text-[#3fb950] flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <span>{cookieActionNotice}</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] text-[#7d8590]">
            <span>
              Use a Netscape-format cookies.txt export when Chrome/Edge database decryption is locked on Windows.
            </span>
            <button
              type="button"
              onClick={handleSaveCookieText}
              disabled={savingCookies || !cookieText.trim() || (cookieValidation !== null && !cookieValidation.valid)}
              className="px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white rounded text-xs font-medium transition-colors shrink-0"
            >
              {savingCookies ? 'Validating & Saving...' : 'Save Cookie File'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
};
