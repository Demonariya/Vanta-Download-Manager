import React, { useState, useEffect } from 'react';
import {
  X,
  Search,
  Download,
  Music,
  Video,
  Layers,
  Settings2,
  Clock,
  User,
  ExternalLink,
  Check,
  AlertCircle,
  Sparkles,
  ClipboardPaste,
  FileText,
  Info,
  Trash2,
  Cookie,
  Upload,
} from 'lucide-react';
import {
  CookieStatus,
  CookieValidationResult,
  MediaMetadata,
  TaskPriority,
} from '../types';
import { api } from '../services/api';
import { isLikelyLossySource } from '../utils/audio-quality';
import { validateNetscapeCookies } from '../utils/cookie-validator';
import { describeCookieStatus } from '../utils/cookie-status-ui';

interface NewDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
  onTaskCreated: () => void;
  onOpenCookieSettings?: () => void;
}

const SAMPLE_URLS = [
  {
    name: 'Big Buck Bunny (Trailer 4K)',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
    type: 'video',
  },
  {
    name: 'Jellyfish 1080p Test',
    url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_1MB.mp4',
    type: 'video',
  },
  {
    name: 'Creative Commons Audio',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    type: 'audio',
  },
];

export const NewDownloadModal: React.FC<NewDownloadModalProps> = ({
  isOpen,
  onClose,
  initialUrl = '',
  onTaskCreated,
  onOpenCookieSettings,
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [batchUrls, setBatchUrls] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Live cookie status & inline import panel
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [showInlineCookieImport, setShowInlineCookieImport] = useState(false);
  const [inlineCookieText, setInlineCookieText] = useState('');
  const [inlineCookieValidation, setInlineCookieValidation] = useState<CookieValidationResult | null>(null);
  const [inlineCookieError, setInlineCookieError] = useState<string | null>(null);
  const [savingInlineCookies, setSavingInlineCookies] = useState(false);
  const inlineFileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Selected download settings
  const [selectedTab, setSelectedTab] = useState<'video' | 'audio' | 'advanced'>('video');
  const [selectedFormatId, setSelectedFormatId] = useState<string>('best');
  const [selectedContainer, setSelectedContainer] = useState<string>('mp4');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<string>('mp3');
  const [selectedAudioBitrate, setSelectedAudioBitrate] = useState<string>('320k');
  const [selectedBitDepth, setSelectedBitDepth] = useState<number>(24);
  const [selectedSampleRate, setSelectedSampleRate] = useState<number>(48000);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const refreshCookies = async () => {
    try {
      const status = await api.getCookieStatus();
      setCookieStatus(status);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshCookies();
    }
  }, [isOpen]);

  useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      inspect(initialUrl);
    }
  }, [initialUrl]);

  useEffect(() => {
    if (!inlineCookieText.trim()) {
      setInlineCookieValidation(null);
      return;
    }
    setInlineCookieValidation(validateNetscapeCookies(inlineCookieText));
  }, [inlineCookieText]);

  if (!isOpen) return null;

  const cookieBadge = describeCookieStatus(cookieStatus);

  const inspect = async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    setIsExtracting(true);
    setExtractError(null);
    setMetadata(null);

    try {
      const data = await api.inspectUrl(targetUrl.trim());
      setMetadata(data);
      if (data.extractor === 'spotdl') {
        setSelectedTab('audio');
      }
    } catch (err: any) {
      setExtractError(err.message || 'Failed to inspect URL. You can still proceed with standard download.');
    } finally {
      setIsExtracting(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        inspect(text.trim());
      }
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (quickDownload = false) => {
    const isLossless = selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav';

    if (mode === 'batch') {
      const lines = batchUrls
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => Boolean(l));

      if (lines.length === 0) return;
      setIsSubmitting(true);

      for (const line of lines) {
        const isAudioOnly = selectedTab === 'audio';
        await api.createTask({
          url: line,
          title: `Batch Item: ${line.substring(0, 40)}`,
          format_id: isAudioOnly ? 'bestaudio' : 'best',
          ext: isAudioOnly ? selectedAudioFormat : 'mp4',
          is_audio_only: isAudioOnly,
          audio_format: selectedAudioFormat,
          audio_bitrate: selectedAudioBitrate,
          audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
          audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
          is_lossy_source: isLikelyLossySource(line),
          priority,
        });
      }

      setIsSubmitting(false);
      onTaskCreated();
      onClose();
      return;
    }

    if (!url.trim()) return;
    setIsSubmitting(true);

    const isAudioOnly = selectedTab === 'audio' || (metadata?.extractor === 'spotdl');
    const chosenFormatId = quickDownload ? 'best' : selectedFormatId;
    const isSourceLossy = isLikelyLossySource(url.trim(), metadata?.extractor);

    await api.createTask({
      url: url.trim(),
      title: metadata?.title || 'Download Task',
      uploader: metadata?.uploader,
      duration: metadata?.duration,
      duration_string: metadata?.duration_string,
      thumbnail: metadata?.thumbnail,
      format_id: chosenFormatId,
      ext: isAudioOnly ? selectedAudioFormat : selectedContainer,
      is_audio_only: isAudioOnly,
      audio_format: selectedAudioFormat,
      audio_bitrate: selectedAudioBitrate,
      audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
      audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
      is_lossy_source: isSourceLossy,
      priority,
    });

    setIsSubmitting(false);
    onTaskCreated();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/75 backdrop-blur-xs select-none">
      <div className="relative w-full max-w-2xl bg-[#12151a] border border-[#30363d] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-[#21262d] bg-[#0d1117]">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-[#58a6ff]" />
            <h2 className="text-sm font-semibold text-white">Universal Download Workstation</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 text-[#8b949e] hover:text-white hover:bg-[#21262d] rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-3.5 sm:p-5 overflow-y-auto space-y-4">
          {/* Mode Switcher */}
          <div className="flex items-center gap-1 p-1 bg-[#161b22] border border-[#21262d] rounded-lg">
            <button
              onClick={() => setMode('single')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'single'
                  ? 'bg-[#21262d] text-white shadow-xs'
                  : 'text-[#8b949e] hover:text-[#e6edf3]'
              }`}
            >
              Single URL
            </button>
            <button
              onClick={() => setMode('batch')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'batch'
                  ? 'bg-[#21262d] text-white shadow-xs'
                  : 'text-[#8b949e] hover:text-[#e6edf3]'
              }`}
            >
              Batch URLs (Multi-line)
            </button>
          </div>

          {mode === 'single' ? (
            <div>
              {/* URL Input Form */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#c9d1d9] block">
                  Media, Video, or Spotify URL
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      placeholder="https://www.youtube.com/watch?v=... or https://open.spotify.com/track/..."
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          inspect(url);
                        }
                      }}
                      className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] focus:outline-none rounded-lg text-xs py-2 pl-3 pr-8 text-[#e6edf3] placeholder-[#6e7681]"
                    />
                    <button
                      type="button"
                      onClick={handlePasteClipboard}
                      title="Paste from clipboard"
                      aria-label="Paste URL"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8b949e] hover:text-[#58a6ff]"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => inspect(url)}
                    disabled={isExtracting || !url.trim()}
                    aria-label="Analyze URL"
                    className="px-3.5 py-2 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-xs font-medium text-white rounded-lg flex items-center gap-1.5 transition-colors shrink-0"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>{isExtracting ? 'Analyzing...' : 'Analyze'}</span>
                  </button>

                  {url && (
                    <button
                      type="button"
                      onClick={() => {
                        setUrl('');
                        setMetadata(null);
                        setExtractError(null);
                      }}
                      title="Clear URL and reset"
                      aria-label="Clear URL and reset"
                      className="px-2.5 py-2 bg-[#21262d] hover:bg-[#30363d] hover:text-[#f85149] text-xs font-medium text-[#8b949e] rounded-lg flex items-center gap-1 transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Clear</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Sample Test URLs for instant verification */}
              <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-[#7d8590]">Test presets:</span>
                {SAMPLE_URLS.map((sample) => (
                  <button
                    key={sample.name}
                    type="button"
                    onClick={() => {
                      setUrl(sample.url);
                      inspect(sample.url);
                    }}
                    className="px-2 py-0.5 text-[10px] bg-[#161b22] hover:bg-[#21262d] text-[#58a6ff] border border-[#30363d] rounded transition-colors"
                  >
                    {sample.name}
                  </button>
                ))}
              </div>

              {/* Live Cookie Status Banner */}
              <div className="mt-2.5 p-2.5 bg-[#161b22] border border-[#21262d] rounded-lg flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <Cookie
                    className={`w-3.5 h-3.5 shrink-0 ${
                      cookieBadge.tone === 'error'
                        ? 'text-[#f85149]'
                        : cookieBadge.tone === 'warning'
                        ? 'text-[#e3b341]'
                        : cookieBadge.tone === 'muted'
                        ? 'text-[#8b949e]'
                        : 'text-[#3fb950]'
                    }`}
                  />
                  <span className="text-[#c9d1d9] truncate" title={cookieBadge.detail}>
                    {cookieBadge.label}: <span className="text-[#8b949e]">{cookieBadge.detail}</span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    data-testid="modal-cookie-badge"
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      cookieBadge.tone === 'success'
                        ? 'text-[#3fb950] bg-[#238636]/15 border-[#238636]/30'
                        : cookieBadge.tone === 'info'
                        ? 'text-[#58a6ff] bg-[#1f6feb]/15 border-[#1f6feb]/30'
                        : cookieBadge.tone === 'warning'
                        ? 'text-[#e3b341] bg-[#d29922]/15 border-[#d29922]/30'
                        : cookieBadge.tone === 'error'
                        ? 'text-[#f85149] bg-[#da3633]/15 border-[#da3633]/40'
                        : 'text-[#8b949e] bg-[#21262d] border-[#30363d]'
                    }`}
                  >
                    {cookieBadge.badgeText}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowInlineCookieImport((v) => !v)}
                    className="px-2 py-0.5 text-[10px] bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] rounded transition-colors"
                  >
                    {showInlineCookieImport ? 'Hide Cookies' : 'Cookies'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#c9d1d9] block">
                Batch URL List (one URL per line)
              </label>
              <textarea
                rows={5}
                placeholder="https://...&#10;https://...&#10;https://..."
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#58a6ff] focus:outline-none rounded-lg text-xs p-3 text-[#e6edf3] font-mono placeholder-[#6e7681]"
              />
            </div>
          )}

          {/* Extraction Error Notice with Inline Cookie Import Trigger */}
          {extractError && (
            <div className="p-3 bg-[#da3633]/15 border border-[#f85149]/40 rounded-lg text-xs text-[#f85149] space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="whitespace-pre-line">{extractError}</span>
              </div>
              <div className="pt-1 border-t border-[#f85149]/30 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[#e6edf3]">
                  Authentication or cookie access issue?
                </span>
                <button
                  type="button"
                  onClick={() => setShowInlineCookieImport(true)}
                  className="px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-white text-[11px] font-medium rounded transition-colors flex items-center gap-1"
                >
                  <Cookie className="w-3 h-3 text-[#3fb950]" />
                  <span>Import cookies.txt</span>
                </button>
                {onOpenCookieSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenCookieSettings();
                    }}
                    className="px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-[#58a6ff] text-[11px] font-medium rounded transition-colors"
                  >
                    Open Cookie Settings
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => inspect(url)}
                  className="px-2.5 py-1 bg-[#da3633]/25 hover:bg-[#da3633]/40 text-[#ff7b72] text-[11px] font-medium rounded transition-colors"
                >
                  Retry Analysis
                </button>
              </div>
            </div>
          )}

          {/* Inline Validated Cookie Import Panel */}
          {showInlineCookieImport && (
            <div className="p-3 rounded-lg border border-[#30363d] bg-[#161b22] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-white flex items-center gap-1.5">
                  <Cookie className="w-3.5 h-3.5 text-[#3fb950]" />
                  <span>Import Netscape cookies.txt</span>
                </span>
                <div className="flex items-center gap-2">
                  <input
                    ref={inlineFileInputRef}
                    type="file"
                    accept=".txt,text/plain"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setInlineCookieText(await file.text());
                      setInlineCookieError(null);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => inlineFileInputRef.current?.click()}
                    className="px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] text-[11px] rounded flex items-center gap-1"
                  >
                    <Upload className="w-3 h-3 text-[#58a6ff]" />
                    <span>Upload File</span>
                  </button>
                  {cookieStatus?.fileExists && (
                    <button
                      type="button"
                      onClick={async () => {
                        const updated = await api.removeCookies();
                        setCookieStatus(updated);
                        setInlineCookieText('');
                        setInlineCookieError(null);
                      }}
                      className="px-2 py-1 bg-[#da3633]/15 hover:bg-[#da3633]/25 text-[#f85149] text-[11px] rounded"
                    >
                      Remove Existing
                    </button>
                  )}
                </div>
              </div>

              <textarea
                rows={3}
                value={inlineCookieText}
                onChange={(e) => {
                  setInlineCookieText(e.target.value);
                  setInlineCookieError(null);
                }}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;1899999999&#9;SID&#9;..."
                className="w-full bg-[#0d1117] border border-[#30363d] focus:border-[#58a6ff] rounded-lg text-[11px] p-2 font-mono text-[#e6edf3] placeholder-[#6e7681]"
              />

              {inlineCookieValidation && (
                <div
                  className={`text-[11px] font-mono ${
                    inlineCookieValidation.valid ? 'text-[#3fb950]' : 'text-[#f85149]'
                  }`}
                >
                  {inlineCookieValidation.valid
                    ? `Valid Netscape cookie format (${inlineCookieValidation.recordCount} entries, ${inlineCookieValidation.domainCount} domains).`
                    : inlineCookieValidation.errors[0]}
                </div>
              )}

              {inlineCookieError && (
                <div className="text-[11px] text-[#f85149]">{inlineCookieError}</div>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowInlineCookieImport(false)}
                  className="px-2.5 py-1 text-[11px] text-[#8b949e] hover:text-white"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={
                    savingInlineCookies ||
                    !inlineCookieText.trim() ||
                    (inlineCookieValidation !== null && !inlineCookieValidation.valid)
                  }
                  onClick={async () => {
                    setInlineCookieError(null);
                    setSavingInlineCookies(true);
                    try {
                      const updated = await api.saveCookies(inlineCookieText);
                      setCookieStatus(updated);
                      setInlineCookieText('');
                      setShowInlineCookieImport(false);
                      if (url.trim()) {
                        inspect(url);
                      }
                    } catch (err: any) {
                      setInlineCookieError(err.message || 'Invalid cookies.txt format.');
                    } finally {
                      setSavingInlineCookies(false);
                    }
                  }}
                  className="px-3 py-1 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white text-[11px] font-medium rounded"
                >
                  {savingInlineCookies ? 'Saving...' : 'Save Cookies & Retry'}
                </button>
              </div>
            </div>
          )}

          {/* Metadata Preview Card */}
          {metadata && (
            <div className="p-3.5 rounded-lg border border-[#30363d] bg-[#161b22] flex items-start gap-3">
              {metadata.thumbnail ? (
                <img
                  src={metadata.thumbnail}
                  alt={metadata.title}
                  referrerPolicy="no-referrer"
                  className="w-24 h-16 object-cover rounded bg-[#0d1117] shrink-0 border border-[#21262d]"
                />
              ) : (
                <div className="w-24 h-16 rounded bg-[#21262d] flex items-center justify-center shrink-0 text-xs font-mono text-[#8b949e]">
                  MEDIA
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="text-xs font-semibold text-white truncate">{metadata.title}</h3>
                <div className="flex items-center gap-3 text-[11px] text-[#8b949e] mt-1 font-mono">
                  {metadata.uploader && <span>{metadata.uploader}</span>}
                  {metadata.duration_string && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{metadata.duration_string}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="text-[#58a6ff]">{metadata.extractor}</span>
                </div>
                {metadata.is_playlist && (
                  <p className="text-[11px] text-[#d29922] mt-1">
                    Playlist detected ({metadata.playlist_count || 'multiple'} items)
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Format and Stream Customization Section */}
          <div className="space-y-3 pt-2 border-t border-[#21262d]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#c9d1d9]">Output Workflow</span>
              <div className="flex items-center gap-1 p-0.5 bg-[#161b22] border border-[#21262d] rounded-lg">
                <button
                  type="button"
                  onClick={() => setSelectedTab('video')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
                    selectedTab === 'video'
                      ? 'bg-[#21262d] text-[#58a6ff]'
                      : 'text-[#8b949e] hover:text-[#e6edf3]'
                  }`}
                >
                  <Video className="w-3.5 h-3.5" />
                  <span>Video + Audio</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTab('audio')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
                    selectedTab === 'audio'
                      ? 'bg-[#21262d] text-[#58a6ff]'
                      : 'text-[#8b949e] hover:text-[#e6edf3]'
                  }`}
                >
                  <Music className="w-3.5 h-3.5" />
                  <span>Audio Extraction</span>
                </button>
              </div>
            </div>

            {selectedTab === 'video' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Resolution */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#8b949e]">Quality & Resolution</label>
                  <select
                    value={selectedFormatId}
                    onChange={(e) => setSelectedFormatId(e.target.value)}
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                  >
                    <option value="best">Best Available (Recommended)</option>
                    <option value="bestvideo[height<=2160]+bestaudio/best">4K Ultra HD (2160p)</option>
                    <option value="bestvideo[height<=1440]+bestaudio/best">2K Quad HD (1440p)</option>
                    <option value="bestvideo[height<=1080]+bestaudio/best">Full HD (1080p)</option>
                    <option value="bestvideo[height<=720]+bestaudio/best">HD (720p)</option>
                    <option value="bestvideo[height<=480]+bestaudio/best">Standard (480p)</option>
                  </select>
                </div>

                {/* Container */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#8b949e]">Video Container</label>
                  <select
                    value={selectedContainer}
                    onChange={(e) => setSelectedContainer(e.target.value)}
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                  >
                    <option value="mp4">MP4 (Widely Compatible)</option>
                    <option value="mkv">MKV (Matroska Full Subtitles)</option>
                    <option value="webm">WebM (VP9 / AV1)</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Audio Format */}
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[#8b949e]">Audio Codec</label>
                    <select
                      value={selectedAudioFormat}
                      onChange={(e) => setSelectedAudioFormat(e.target.value)}
                      className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                    >
                      <option value="mp3">MP3 (MPEG Audio Layer 3)</option>
                      <option value="flac">FLAC (Lossless Audio Codec)</option>
                      <option value="wav">WAV (Linear Uncompressed PCM)</option>
                      <option value="m4a">M4A / AAC (Apple / High Efficiency)</option>
                      <option value="opus">OPUS (Modern Low-Latency)</option>
                    </select>
                  </div>

                  {selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav' ? (
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-[#8b949e]">PCM Bit Depth</label>
                      <select
                        value={selectedBitDepth}
                        onChange={(e) => setSelectedBitDepth(parseInt(e.target.value, 10))}
                        className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                      >
                        <option value={16}>16-bit (Red Book CD Quality)</option>
                        <option value={24}>24-bit (Studio Master High Dynamic Range)</option>
                      </select>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-[#8b949e]">Bitrate Quality</label>
                      <select
                        value={selectedAudioBitrate}
                        onChange={(e) => setSelectedAudioBitrate(e.target.value)}
                        className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                      >
                        <option value="320k">320 kbps (High Fidelity CBR)</option>
                        <option value="256k">256 kbps (Standard High)</option>
                        <option value="192k">192 kbps (Medium)</option>
                        <option value="128k">128 kbps (Compact)</option>
                      </select>
                    </div>
                  )}
                </div>

                {/* Additional Lossless Sample Rate Selector */}
                {(selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav') && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[#8b949e]">Sampling Rate (Frequency)</label>
                    <select
                      value={selectedSampleRate}
                      onChange={(e) => setSelectedSampleRate(parseInt(e.target.value, 10))}
                      className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                    >
                      <option value={44100}>44.1 kHz (CD Standard)</option>
                      <option value={48000}>48.0 kHz (Studio / Video Standard)</option>
                      <option value={96000}>96.0 kHz (Hi-Res Audio)</option>
                      <option value={192000}>192.0 kHz (Ultra High-Res Master)</option>
                    </select>
                  </div>
                )}

                {/* Truthful Lossy-Source Disclosure Banner */}
                {(selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav') &&
                  isLikelyLossySource(url, metadata?.extractor) && (
                    <div className="p-2.5 rounded-lg border border-[#d29922]/30 bg-[#d29922]/10 text-xs text-[#e3b341] flex items-start gap-2">
                      <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#d29922]" />
                      <div className="text-[11px] leading-relaxed">
                        <span className="font-semibold text-white">Lossy Source Stream Detected: </span>
                        This source (YouTube/Spotify) delivers lossy compressed audio (~128–160 kbps). Converting to{' '}
                        {selectedAudioFormat.toUpperCase()} ({selectedBitDepth}-bit / {selectedSampleRate / 1000} kHz) produces a lossless container with zero generational re-compression, but cannot recover high-frequency data omitted during original encoding.
                      </div>
                    </div>
                  )}
              </div>
            )}

            {/* Task Priority */}
            <div className="flex flex-wrap items-center justify-between pt-1 gap-2">
              <span className="text-[11px] font-medium text-[#8b949e]">Queue Priority</span>
              <div className="flex items-center gap-1">
                {(['low', 'normal', 'high', 'highest'] as TaskPriority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-2 py-0.5 text-[10px] uppercase font-mono rounded transition-colors ${
                      priority === p
                        ? 'bg-[#1f6feb] text-white'
                        : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-2.5 px-4 sm:px-5 py-3 border-t border-[#21262d] bg-[#0d1117]">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-3.5 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors text-center"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {mode === 'single' && (
              <button
                type="button"
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting || !url.trim()}
                className="flex-1 sm:flex-none px-3 py-1.5 text-xs font-medium text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors whitespace-nowrap text-center"
              >
                Quick Add
              </button>
            )}
            <button
              type="button"
              onClick={() => handleSubmit(false)}
              disabled={isSubmitting || (mode === 'single' ? !url.trim() : !batchUrls.trim())}
              className="flex-1 sm:flex-none px-4 py-1.5 text-xs font-medium text-white bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-sm whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Starting...' : 'Start Download'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
