import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Search,
  Download,
  Music,
  Video,
  AlertCircle,
  ClipboardPaste,
  Info,
  Trash2,
  Cookie,
  Upload,
  Loader2,
  RotateCw,
  Disc,
  ListMusic,
  FileDown,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import {
  AppSettings,
  CategoryItem,
  CookieStatus,
  CookieValidationResult,
  DownloadTask,
  MediaMetadata,
  TaskPriority,
} from '../types';
import { api } from '../services/api';
import { isLikelyLossySource } from '../utils/audio-quality';
import { validateNetscapeCookies } from '../utils/cookie-validator';
import { describeCookieStatus } from '../utils/cookie-status-ui';
import { InspectionController } from '../utils/inspection-controller';
import { isSpotifyUrl } from '../utils/spotify';
import { buildCuratedVideoOptions } from '../utils/media-formats';
import { formatBytes, parseBatchUrls } from '../utils/engine-parser';
import { matchCategoryForTask } from '../utils/categories';

interface NewDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
  tasks: DownloadTask[];
  categories: CategoryItem[];
  settings: AppSettings | null;
  onTaskCreated: () => void;
  onOpenCookieSettings?: () => void;
}

const SAMPLE_URLS = [
  {
    name: 'Big Buck Bunny 1080p MP4',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
  },
  {
    name: 'SoundHelix CC MP3',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  },
];

export const NewDownloadModal: React.FC<NewDownloadModalProps> = ({
  isOpen,
  onClose,
  initialUrl = '',
  tasks,
  categories,
  settings,
  onTaskCreated,
  onOpenCookieSettings,
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [batchUrls, setBatchUrls] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [isTimeoutError, setIsTimeoutError] = useState(false);

  // Playlist selection
  const [selectedPlaylistKeys, setSelectedPlaylistKeys] = useState<Record<string, boolean>>({});
  const [includePlaylistMode, setIncludePlaylistMode] = useState(true);

  // Live cookie status & inline import panel
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [showInlineCookieImport, setShowInlineCookieImport] = useState(false);
  const [inlineCookieText, setInlineCookieText] = useState('');
  const [inlineCookieValidation, setInlineCookieValidation] = useState<CookieValidationResult | null>(null);
  const [inlineCookieError, setInlineCookieError] = useState<string | null>(null);
  const [savingInlineCookies, setSavingInlineCookies] = useState(false);
  const inlineFileInputRef = useRef<HTMLInputElement | null>(null);
  const inspectionControllerRef = useRef<InspectionController>(new InspectionController());

  // Output & task options
  const [selectedTab, setSelectedTab] = useState<'video' | 'audio'>('video');
  const [selectedFormatId, setSelectedFormatId] = useState<string>('best');
  const [selectedContainer, setSelectedContainer] = useState<string>('mp4');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<string>('mp3');
  const [selectedAudioBitrate, setSelectedAudioBitrate] = useState<string>('320k');
  const [selectedBitDepth, setSelectedBitDepth] = useState<number>(24);
  const [selectedSampleRate, setSelectedSampleRate] = useState<number>(48000);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [customFilename, setCustomFilename] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [expectedSha256, setExpectedSha256] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const applyInspectionPatch = (
    patch: Partial<{
      isExtracting: boolean;
      metadata: MediaMetadata | null;
      extractError: string | null;
      isTimeoutError: boolean;
    }>
  ) => {
    if (patch.isExtracting !== undefined) setIsExtracting(patch.isExtracting);
    if (patch.metadata !== undefined) {
      setMetadata(patch.metadata);
      if (patch.metadata) {
        if (patch.metadata.extractor === 'spotdl') {
          setSelectedTab('audio');
        }
        if (patch.metadata.is_direct_file && patch.metadata.direct_filename) {
          setCustomFilename(patch.metadata.direct_filename);
          const ext = patch.metadata.direct_filename.split('.').pop()?.toLowerCase();
          const matchedCat = matchCategoryForTask(ext, false, categories);
          if (matchedCat) setCategoryId(matchedCat.id);
        }
        if (patch.metadata.entries && patch.metadata.entries.length > 0) {
          const initMap: Record<string, boolean> = {};
          patch.metadata.entries.forEach((e, idx) => {
            initMap[`entry-${idx}-${e.id}`] = true;
          });
          setSelectedPlaylistKeys(initMap);
        } else if (patch.metadata.tracks && patch.metadata.tracks.length > 0) {
          const initMap: Record<string, boolean> = {};
          patch.metadata.tracks.forEach((t, idx) => {
            initMap[`track-${idx}-${t.id}`] = true;
          });
          setSelectedPlaylistKeys(initMap);
        } else {
          setSelectedPlaylistKeys({});
        }
      }
    }
    if (patch.extractError !== undefined) setExtractError(patch.extractError);
    if (patch.isTimeoutError !== undefined) setIsTimeoutError(patch.isTimeoutError);
  };

  const inspect = async (targetUrl: string) => {
    await inspectionControllerRef.current.startInspection(targetUrl, {
      inspectUrl: (u, opts) => api.inspectUrl(u, { ...opts, includePlaylist: includePlaylistMode }),
      cancelInspection: (id) => api.cancelInspection(id),
      onStateChange: applyInspectionPatch,
    });
  };

  const handleCancelInspection = () => {
    inspectionControllerRef.current.cancelCurrent(
      (id) => api.cancelInspection(id),
      applyInspectionPatch
    );
  };

  const handleCloseModal = () => {
    handleCancelInspection();
    onClose();
  };

  const refreshCookies = async () => {
    try {
      const status = await api.getCookieStatus();
      if (inspectionControllerRef.current.isMounted()) {
        setCookieStatus(status);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const controller = inspectionControllerRef.current;
    controller.markMounted();
    return () => {
      controller.dispose((id) => api.cancelInspection(id));
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshCookies();
      if (settings) {
        setSelectedContainer(settings.default_video_format || 'mp4');
        setSelectedAudioFormat(settings.default_audio_format || 'mp3');
        setSelectedAudioBitrate(settings.default_audio_bitrate || '320k');
        if (settings.default_audio_sample_rate) setSelectedSampleRate(settings.default_audio_sample_rate);
        if (settings.default_audio_bit_depth) setSelectedBitDepth(settings.default_audio_bit_depth);
      }
      if (initialUrl) {
        setMode('single');
        setUrl(initialUrl);
        setCustomFilename('');
        setExpectedSha256('');
        inspect(initialUrl);
      }
    } else {
      handleCancelInspection();
    }
  }, [isOpen, initialUrl]);

  useEffect(() => {
    if (!inlineCookieText.trim()) {
      setInlineCookieValidation(null);
      return;
    }
    setInlineCookieValidation(validateNetscapeCookies(inlineCookieText));
  }, [inlineCookieText]);

  const batchValidation = useMemo(() => parseBatchUrls(batchUrls), [batchUrls]);
  const curatedVideoOptions = useMemo(
    () => buildCuratedVideoOptions(metadata?.formats || []),
    [metadata?.formats]
  );

  const duplicateTask = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return null;
    return (
      tasks.find(
        (t) =>
          t.url === trimmed &&
          t.status !== 'failed' &&
          t.status !== 'cancelled'
      ) || null
    );
  }, [url, tasks]);

  if (!isOpen) return null;

  const cookieBadge = describeCookieStatus(cookieStatus);
  const isDirect = Boolean(metadata?.is_direct_file);

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const cleaned = text.trim();
        setUrl(cleaned);
        inspect(cleaned);
      }
    } catch {
      // ignore
    }
  };

  const handleToggleAllPlaylist = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    if (metadata?.entries) {
      metadata.entries.forEach((e, idx) => {
        next[`entry-${idx}-${e.id}`] = checked;
      });
    } else if (metadata?.tracks) {
      metadata.tracks.forEach((t, idx) => {
        next[`track-${idx}-${t.id}`] = checked;
      });
    }
    setSelectedPlaylistKeys(next);
  };

  const handleSubmit = async (quickDownload = false) => {
    const isLossless = selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav';

    if (mode === 'batch') {
      if (batchValidation.valid.length === 0) return;
      setIsSubmitting(true);
      try {
        for (const line of batchValidation.valid) {
          const lineIsSpotify = isSpotifyUrl(line);
          const isAudioOnly = selectedTab === 'audio' || lineIsSpotify;
          const ext = isAudioOnly ? selectedAudioFormat : selectedContainer;
          const autoCat = categoryId || matchCategoryForTask(ext, isAudioOnly, categories)?.id || undefined;
          await api.createTask({
            url: line,
            title: lineIsSpotify ? undefined : `Batch Item: ${line.substring(0, 48)}`,
            format_id: isAudioOnly ? 'bestaudio' : 'best',
            ext,
            is_audio_only: isAudioOnly,
            audio_format: selectedAudioFormat,
            audio_bitrate: selectedAudioBitrate,
            audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
            audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
            is_lossy_source: isLikelyLossySource(line),
            category_id: autoCat,
            priority,
          });
        }
        handleCloseModal();
        onTaskCreated();
      } catch (err: any) {
        setExtractError(err?.message || 'Failed to enqueue batch download tasks.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setIsSubmitting(true);
    try {
      // Playlist multi-track selection submission
      if (metadata?.entries && metadata.entries.length > 0 && !quickDownload) {
        const pickedEntries = metadata.entries.filter(
          (e, idx) => selectedPlaylistKeys[`entry-${idx}-${e.id}`] !== false
        );
        if (pickedEntries.length > 0 && pickedEntries.length <= metadata.entries.length) {
          const isAudioOnly = selectedTab === 'audio';
          const ext = isAudioOnly ? selectedAudioFormat : selectedContainer;
          const autoCat =
            categoryId || matchCategoryForTask(ext, isAudioOnly, categories)?.id || undefined;
          for (const entry of pickedEntries) {
            await api.createTask({
              url: entry.url,
              title: entry.title,
              uploader: entry.uploader || metadata.uploader,
              duration: entry.duration,
              duration_string: entry.duration_string,
              thumbnail: entry.thumbnail || metadata.thumbnail,
              format_id: isAudioOnly ? 'bestaudio' : selectedFormatId,
              ext,
              is_audio_only: isAudioOnly,
              audio_format: selectedAudioFormat,
              audio_bitrate: selectedAudioBitrate,
              audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
              audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
              is_lossy_source: isLikelyLossySource(entry.url, metadata.extractor),
              category_id: autoCat,
              playlist_mode: 'single',
              priority,
            });
          }
          handleCloseModal();
          onTaskCreated();
          return;
        }
      }

      if (metadata?.tracks && metadata.tracks.length > 0 && !quickDownload) {
        const pickedTracks = metadata.tracks.filter(
          (t, idx) => selectedPlaylistKeys[`track-${idx}-${t.id}`] !== false
        );
        const tracksWithUrls = pickedTracks.filter((t) => Boolean(t.url));
        if (tracksWithUrls.length > 0 && pickedTracks.length < metadata.tracks.length) {
          const autoCat =
            categoryId ||
            matchCategoryForTask(selectedAudioFormat, true, categories)?.id ||
            undefined;
          for (const tr of tracksWithUrls) {
            await api.createTask({
              url: tr.url!,
              title: tr.title,
              uploader: tr.artists.join(', ') || metadata.uploader,
              duration: tr.duration,
              duration_string: tr.duration_string,
              thumbnail: tr.artwork || metadata.album_artwork || metadata.thumbnail,
              album: tr.album || metadata.album,
              content_type: 'track',
              engine: 'spotdl',
              format_id: 'bestaudio',
              ext: selectedAudioFormat,
              is_audio_only: true,
              audio_format: selectedAudioFormat,
              audio_bitrate: selectedAudioBitrate,
              audio_sample_rate: isLossless ? selectedSampleRate : undefined,
              audio_bit_depth: isLossless ? selectedBitDepth : undefined,
              is_lossy_source: true,
              category_id: autoCat,
              playlist_mode: 'single',
              priority,
            });
          }
          handleCloseModal();
          onTaskCreated();
          return;
        }
      }

      const urlIsSpotify = metadata?.extractor === 'spotdl' || isSpotifyUrl(trimmedUrl);
      const directExt = metadata?.direct_filename?.split('.').pop()?.toLowerCase();
      const isAudioOnly = isDirect ? false : selectedTab === 'audio' || urlIsSpotify;
      const chosenFormatId = quickDownload ? (isAudioOnly ? 'bestaudio' : 'best') : selectedFormatId;
      const ext = isDirect
        ? directExt || 'bin'
        : isAudioOnly
        ? selectedAudioFormat
        : selectedContainer;
      const autoCat = categoryId || matchCategoryForTask(ext, isAudioOnly, categories)?.id || undefined;
      const isSourceLossy = isLikelyLossySource(trimmedUrl, metadata?.extractor);
      const resolvedUploader =
        metadata?.artists && metadata.artists.length > 0
          ? metadata.artists.join(', ')
          : metadata?.owner || metadata?.uploader;
      const resolvedArtwork = metadata?.album_artwork || metadata?.thumbnail;

      await api.createTask({
        url: trimmedUrl,
        title: metadata?.title || (urlIsSpotify ? undefined : 'Download Task'),
        uploader: resolvedUploader,
        duration: metadata?.duration,
        duration_string: metadata?.duration_string,
        thumbnail: resolvedArtwork,
        album: metadata?.album,
        content_type: metadata?.content_type,
        engine: isDirect ? 'direct' : urlIsSpotify ? 'spotdl' : undefined,
        format_id: isDirect ? 'direct' : chosenFormatId,
        ext,
        total_bytes: metadata?.direct_file_size || 0,
        is_audio_only: isAudioOnly,
        audio_format: selectedAudioFormat,
        audio_bitrate: selectedAudioBitrate,
        audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
        audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
        is_lossy_source: isSourceLossy,
        custom_filename: customFilename.trim() || undefined,
        category_id: autoCat,
        expected_sha256: expectedSha256.trim() || undefined,
        playlist_mode: includePlaylistMode ? 'playlist' : 'single',
        priority,
      });

      handleCloseModal();
      onTaskCreated();
    } catch (err: any) {
      setExtractError(err?.message || 'Failed to create download task.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/70 backdrop-blur-xs select-none">
      <div className="relative w-full max-w-2xl bg-[var(--vanta-surface)] border border-[var(--vanta-border-strong)] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--vanta-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">New Download</h2>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            aria-label="Close dialog"
            className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)] rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs">
          {/* Mode Switcher */}
          <div className="flex items-center gap-1 p-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg">
            <button
              type="button"
              onClick={() => setMode('single')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'single'
                  ? 'bg-[var(--vanta-surface)] text-[var(--vanta-text)] shadow-xs border border-[var(--vanta-border)]'
                  : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
              }`}
            >
              Single URL
            </button>
            <button
              type="button"
              onClick={() => {
                handleCancelInspection();
                setMode('batch');
              }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'batch'
                  ? 'bg-[var(--vanta-surface)] text-[var(--vanta-text)] shadow-xs border border-[var(--vanta-border)]'
                  : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
              }`}
            >
              Batch URLs
            </button>
          </div>

          {mode === 'single' ? (
            <div className="space-y-2.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-[var(--vanta-text-secondary)]">
                    Media, Spotify, or Direct File URL
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--vanta-muted)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includePlaylistMode}
                      onChange={(e) => setIncludePlaylistMode(e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]"
                    />
                    <span>Resolve playlists</span>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <input
                      type="text"
                      placeholder="https://... or https://open.spotify.com/track/..."
                      value={url}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setUrl(nextVal);
                        if (isExtracting) handleCancelInspection();
                        if (extractError) {
                          setExtractError(null);
                          setIsTimeoutError(false);
                        }
                        if (metadata) setMetadata(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          inspect(url);
                        }
                      }}
                      className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs py-2 pl-3 pr-8 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)]"
                    />
                    <button
                      type="button"
                      onClick={handlePasteClipboard}
                      title="Paste from clipboard"
                      aria-label="Paste URL"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--vanta-muted)] hover:text-[var(--vanta-accent)]"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => inspect(url)}
                    disabled={!url.trim()}
                    aria-label="Analyze URL"
                    className="px-3.5 py-2 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40 border border-[var(--vanta-border)] text-xs font-medium text-[var(--vanta-text)] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    {isExtracting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--vanta-accent)]" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>{isExtracting ? 'Analyzing...' : 'Analyze'}</span>
                  </button>

                  {url && (
                    <button
                      type="button"
                      onClick={() => {
                        handleCancelInspection();
                        setUrl('');
                        setMetadata(null);
                        setExtractError(null);
                        setIsTimeoutError(false);
                      }}
                      title="Clear URL"
                      aria-label="Clear URL"
                      className="p-2 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-muted)] hover:text-red-600 dark:hover:text-[#f85149] rounded-lg transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Sample Test Presets */}
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="text-[var(--vanta-muted)]">Test presets:</span>
                {SAMPLE_URLS.map((sample) => (
                  <button
                    key={sample.name}
                    type="button"
                    onClick={() => {
                      setUrl(sample.url);
                      inspect(sample.url);
                    }}
                    className="text-[var(--vanta-accent)] hover:underline font-medium"
                  >
                    {sample.name}
                  </button>
                ))}
              </div>

              {/* Duplicate URL Warning */}
              {duplicateTask && (
                <div className="p-2.5 rounded-lg border border-amber-500/35 bg-amber-500/10 flex items-center gap-2 text-[11px] text-amber-700 dark:text-[#e3b341]">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    This URL already exists in your list ({duplicateTask.status}: &ldquo;{duplicateTask.title}&rdquo;).
                  </span>
                </div>
              )}

              {/* Cookie Status Summary */}
              <div className="p-2.5 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <Cookie className="w-3.5 h-3.5 shrink-0 text-[var(--vanta-accent)]" />
                  <span className="text-[var(--vanta-text-secondary)] truncate" title={cookieBadge.detail}>
                    {cookieBadge.label} · {cookieBadge.badgeText}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowInlineCookieImport((v) => !v)}
                  className="px-2 py-0.5 text-[11px] bg-[var(--vanta-surface)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] rounded transition-colors shrink-0"
                >
                  {showInlineCookieImport ? 'Hide Cookies' : 'Configure Cookies'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-[var(--vanta-text-secondary)] block">
                Batch URL List (one URL per line)
              </label>
              <textarea
                rows={5}
                placeholder="https://...&#10;https://...&#10;https://..."
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs p-3 text-[var(--vanta-text)] font-mono placeholder-[var(--vanta-muted)]"
              />
              {batchUrls.trim() && (
                <div className="text-[11px] font-mono tabular-nums space-y-1">
                  <p className="text-[var(--vanta-text-secondary)]">
                    Valid URLs: <span className="text-emerald-700 dark:text-[#3fb950] font-semibold">{batchValidation.valid.length}</span>
                    {batchValidation.duplicatesRemoved > 0 && ` · Duplicates skipped: ${batchValidation.duplicatesRemoved}`}
                    {batchValidation.invalid.length > 0 && (
                      <span className="text-red-600 dark:text-[#f85149]">
                        {' '}· Invalid lines: {batchValidation.invalid.length}
                      </span>
                    )}
                  </p>
                  {batchValidation.invalid.slice(0, 3).map((inv) => (
                    <p key={inv.line} className="text-red-600 dark:text-[#f85149]">
                      Line {inv.line}: {inv.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Active Inspection Banner */}
          {isExtracting && mode === 'single' && (
            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Loader2 className="w-4 h-4 text-[var(--vanta-accent)] animate-spin shrink-0" />
                <div className="min-w-0">
                  <p className="text-[var(--vanta-text)] font-medium truncate">
                    Inspecting URL metadata &amp; streams...
                  </p>
                  <p className="text-[11px] text-[var(--vanta-muted)] truncate">
                    Timeout protection active. Cancel anytime or use Quick Download.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCancelInspection}
                className="px-2.5 py-1 bg-[var(--vanta-surface)] hover:bg-[var(--vanta-surface-hover)] text-red-600 dark:text-[#f85149] border border-[var(--vanta-border)] rounded text-[11px] font-medium shrink-0"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Extraction Error Notice */}
          {extractError && (
            <div
              className={`p-3 rounded-lg border space-y-2 ${
                isTimeoutError
                  ? 'bg-amber-500/10 border-amber-500/35 text-amber-700 dark:text-[#e3b341]'
                  : 'bg-red-500/10 border-red-500/35 text-red-600 dark:text-[#f85149]'
              }`}
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="whitespace-pre-line break-words flex-1">{extractError}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-current/20">
                <button
                  type="button"
                  onClick={() => inspect(url)}
                  disabled={!url.trim()}
                  className="px-2.5 py-1 bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] text-[11px] font-medium rounded flex items-center gap-1"
                >
                  <RotateCw className="w-3 h-3" />
                  <span>Retry</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowInlineCookieImport(true)}
                  className="px-2.5 py-1 bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text)] text-[11px] font-medium rounded flex items-center gap-1"
                >
                  <Cookie className="w-3 h-3" />
                  <span>Import cookies.txt</span>
                </button>
                {onOpenCookieSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      handleCloseModal();
                      onOpenCookieSettings();
                    }}
                    className="px-2.5 py-1 text-[var(--vanta-accent)] text-[11px] font-medium hover:underline"
                  >
                    Open Cookie Settings
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Inline Validated Cookie Import Panel */}
          {showInlineCookieImport && (
            <div className="p-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--vanta-text)] flex items-center gap-1.5">
                  <Cookie className="w-3.5 h-3.5 text-[var(--vanta-accent)]" />
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
                    className="px-2 py-1 bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[var(--vanta-text-secondary)] text-[11px] rounded flex items-center gap-1"
                  >
                    <Upload className="w-3 h-3" />
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
                      className="px-2 py-1 bg-red-500/12 text-red-600 dark:text-[#f85149] text-[11px] rounded"
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
                placeholder="# Netscape HTTP Cookie File"
                className="w-full bg-[var(--vanta-surface)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-[11px] p-2 font-mono text-[var(--vanta-text)]"
              />

              {inlineCookieValidation && (
                <p
                  className={`text-[11px] font-mono ${
                    inlineCookieValidation.valid
                      ? 'text-emerald-700 dark:text-[#3fb950]'
                      : 'text-red-600 dark:text-[#f85149]'
                  }`}
                >
                  {inlineCookieValidation.valid
                    ? `Valid Netscape cookie format (${inlineCookieValidation.recordCount} entries, ${inlineCookieValidation.domainCount} domains).`
                    : inlineCookieValidation.errors[0]}
                </p>
              )}

              {inlineCookieError && (
                <p className="text-[11px] text-red-600 dark:text-[#f85149]">{inlineCookieError}</p>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowInlineCookieImport(false)}
                  className="px-2.5 py-1 text-[11px] text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]"
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
                      if (url.trim()) inspect(url);
                    } catch (err: any) {
                      setInlineCookieError(err.message || 'Invalid cookies.txt format.');
                    } finally {
                      setSavingInlineCookies(false);
                    }
                  }}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[11px] font-medium rounded"
                >
                  {savingInlineCookies ? 'Saving...' : 'Save & Retry'}
                </button>
              </div>
            </div>
          )}

          {/* Inspected Metadata Card */}
          {metadata && (
            <div className="p-3.5 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] space-y-3">
              <div className="flex items-start gap-3">
                {metadata.album_artwork || metadata.thumbnail ? (
                  <img
                    src={metadata.album_artwork || metadata.thumbnail}
                    alt={metadata.title}
                    referrerPolicy="no-referrer"
                    className={`${
                      metadata.extractor === 'spotdl' ? 'w-16 h-16' : 'w-24 h-16'
                    } rounded-md object-cover bg-[var(--vanta-surface)] border border-[var(--vanta-border)] shrink-0`}
                  />
                ) : (
                  <div className="w-16 h-16 rounded-md bg-[var(--vanta-surface)] border border-[var(--vanta-border)] flex items-center justify-center shrink-0 text-[var(--vanta-muted)]">
                    {metadata.is_direct_file ? (
                      <FileDown className="w-6 h-6 text-[var(--vanta-accent)]" />
                    ) : metadata.extractor === 'spotdl' ? (
                      <Disc className="w-6 h-6 text-emerald-600 dark:text-[#3fb950]" />
                    ) : (
                      <Video className="w-6 h-6" />
                    )}
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--vanta-text)] truncate">
                    {metadata.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[var(--vanta-muted)] mt-1 tabular-nums">
                    {(metadata.artists?.length ? metadata.artists.join(', ') : metadata.uploader) && (
                      <span className="text-[var(--vanta-text-secondary)]">
                        {metadata.artists?.length ? metadata.artists.join(', ') : metadata.uploader}
                      </span>
                    )}
                    {metadata.duration_string && <span>· {metadata.duration_string}</span>}
                    {metadata.is_direct_file && (
                      <>
                        <span>· {metadata.direct_file_size ? formatBytes(metadata.direct_file_size) : 'Unknown size'}</span>
                        {metadata.direct_mime_type && <span>· {metadata.direct_mime_type}</span>}
                        <span>· {metadata.accepts_ranges ? 'Resumable (Ranges)' : 'Single-stream'}</span>
                      </>
                    )}
                    <span>· {metadata.extractor}</span>
                  </div>
                </div>
              </div>

              {/* Generic yt-dlp Playlist Track Picker */}
              {metadata.entries && metadata.entries.length > 0 && (
                <div className="pt-2.5 border-t border-[var(--vanta-border)] space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-[var(--vanta-text)] flex items-center gap-1.5">
                      <ListMusic className="w-3.5 h-3.5 text-[var(--vanta-accent)]" />
                      <span>Playlist Items ({metadata.entries.length})</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleAllPlaylist(true)}
                        className="text-[var(--vanta-accent)] hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleAllPlaylist(false)}
                        className="text-[var(--vanta-muted)] hover:underline"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto divide-y divide-[var(--vanta-border)] rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
                    {metadata.entries.map((entry, idx) => {
                      const key = `entry-${idx}-${entry.id}`;
                      const checked = selectedPlaylistKeys[key] !== false;
                      return (
                        <label
                          key={key}
                          className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] cursor-pointer hover:bg-[var(--vanta-surface-hover)]/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setSelectedPlaylistKeys((prev) => ({
                                  ...prev,
                                  [key]: e.target.checked,
                                }))
                              }
                              className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)] shrink-0"
                            />
                            <span className="font-mono tabular-nums text-[var(--vanta-muted)] w-5 shrink-0">
                              {entry.index}
                            </span>
                            <span className="text-[var(--vanta-text)] truncate">{entry.title}</span>
                          </div>
                          {entry.duration_string && (
                            <span className="font-mono tabular-nums text-[var(--vanta-muted)] shrink-0">
                              {entry.duration_string}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Spotify Tracklist Picker */}
              {metadata.tracks && metadata.tracks.length > 0 && (
                <div className="pt-2.5 border-t border-[var(--vanta-border)] space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-[var(--vanta-text)] flex items-center gap-1.5">
                      <ListMusic className="w-3.5 h-3.5 text-emerald-600 dark:text-[#3fb950]" />
                      <span>
                        Tracklist ({metadata.tracks.length}
                        {metadata.partial_tracks && metadata.total_tracks
                          ? ` of ${metadata.total_tracks}`
                          : ''}
                        )
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleAllPlaylist(true)}
                        className="text-[var(--vanta-accent)] hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleAllPlaylist(false)}
                        className="text-[var(--vanta-muted)] hover:underline"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto divide-y divide-[var(--vanta-border)] rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
                    {metadata.tracks.map((track, idx) => {
                      const key = `track-${idx}-${track.id}`;
                      const checked = selectedPlaylistKeys[key] !== false;
                      return (
                        <label
                          key={key}
                          className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] cursor-pointer hover:bg-[var(--vanta-surface-hover)]/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) =>
                                setSelectedPlaylistKeys((prev) => ({
                                  ...prev,
                                  [key]: e.target.checked,
                                }))
                              }
                              className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)] shrink-0"
                            />
                            <span className="font-mono tabular-nums text-[var(--vanta-muted)] w-5 shrink-0">
                              {track.track_number ?? idx + 1}
                            </span>
                            <div className="min-w-0">
                              <span className="text-[var(--vanta-text)] font-medium truncate block">
                                {track.title}
                              </span>
                              {track.artists.length > 0 && (
                                <span className="text-[10px] text-[var(--vanta-muted)] truncate block">
                                  {track.artists.join(', ')}
                                </span>
                              )}
                            </div>
                          </div>
                          {track.duration_string && (
                            <span className="font-mono tabular-nums text-[var(--vanta-muted)] shrink-0">
                              {track.duration_string}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Output Workflow (hidden for direct non-media HTTP downloads, where SHA-256 & Filename are shown instead) */}
          {!isDirect ? (
            <div className="space-y-3 pt-2 border-t border-[var(--vanta-border)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--vanta-text-secondary)]">
                  Output Workflow
                </span>
                <div className="flex items-center gap-1 p-0.5 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setSelectedTab('video')}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
                      selectedTab === 'video'
                        ? 'bg-[var(--vanta-surface)] text-[var(--vanta-accent)] border border-[var(--vanta-border)]'
                        : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
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
                        ? 'bg-[var(--vanta-surface)] text-[var(--vanta-accent)] border border-[var(--vanta-border)]'
                        : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
                    }`}
                  >
                    <Music className="w-3.5 h-3.5" />
                    <span>Audio Only</span>
                  </button>
                </div>
              </div>

              {selectedTab === 'video' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                      Video Quality (with Audio Mux)
                    </label>
                    <select
                      value={selectedFormatId}
                      onChange={(e) => setSelectedFormatId(e.target.value)}
                      className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                    >
                      {curatedVideoOptions.map((opt) => (
                        <option key={opt.id} value={opt.formatSelector}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                      Container Format
                    </label>
                    <select
                      value={selectedContainer}
                      onChange={(e) => setSelectedContainer(e.target.value)}
                      className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                    >
                      <option value="mp4">MP4 (Universal)</option>
                      <option value="mkv">MKV (Matroska Subtitles/Streams)</option>
                      <option value="webm">WebM (VP9 / AV1)</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                        Audio Codec
                      </label>
                      <select
                        value={selectedAudioFormat}
                        onChange={(e) => setSelectedAudioFormat(e.target.value)}
                        className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                      >
                        <option value="mp3">MP3</option>
                        <option value="m4a">M4A / AAC</option>
                        <option value="opus">OPUS</option>
                        <option value="flac">FLAC (Lossless Container)</option>
                        <option value="wav">WAV (PCM Container)</option>
                      </select>
                    </div>

                    {selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav' ? (
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                          PCM Bit Depth
                        </label>
                        <select
                          value={selectedBitDepth}
                          onChange={(e) => setSelectedBitDepth(parseInt(e.target.value, 10))}
                          className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                        >
                          <option value={16}>16-bit</option>
                          <option value={24}>24-bit</option>
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                          Bitrate
                        </label>
                        <select
                          value={selectedAudioBitrate}
                          onChange={(e) => setSelectedAudioBitrate(e.target.value)}
                          className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                        >
                          <option value="320k">320 kbps</option>
                          <option value="256k">256 kbps</option>
                          <option value="192k">192 kbps</option>
                          <option value="128k">128 kbps</option>
                        </select>
                      </div>
                    )}
                  </div>

                  {(selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav') && (
                    <>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                          Sampling Rate
                        </label>
                        <select
                          value={selectedSampleRate}
                          onChange={(e) => setSelectedSampleRate(parseInt(e.target.value, 10))}
                          className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                        >
                          <option value={44100}>44.1 kHz</option>
                          <option value={48000}>48.0 kHz</option>
                          <option value={96000}>96.0 kHz</option>
                        </select>
                      </div>
                      {isLikelyLossySource(url, metadata?.extractor) && (
                        <div className="p-2.5 rounded-lg border border-blue-500/30 bg-blue-500/10 flex items-start gap-2 text-[11px] text-[var(--vanta-text-secondary)]">
                          <Info className="w-3.5 h-3.5 text-[var(--vanta-accent)] shrink-0 mt-0.5" />
                          <span>
                            Source stream is lossy web audio (Opus/AAC). Exporting to {selectedAudioFormat.toUpperCase()} preserves current quality without restoring lost frequencies.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2.5 pt-2 border-t border-[var(--vanta-border)]">
              <label className="text-[11px] font-medium text-[var(--vanta-muted)] flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-[#3fb950]" />
                <span>Expected SHA-256 Checksum (Optional verification on completion)</span>
              </label>
              <input
                type="text"
                value={expectedSha256}
                onChange={(e) => setExpectedSha256(e.target.value)}
                placeholder="64-character hex SHA-256 digest..."
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs p-2 font-mono text-[var(--vanta-text)]"
              />
            </div>
          )}

          {/* Filename, Category & Priority Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[var(--vanta-border)]">
            {mode === 'single' && (
              <div className="space-y-1 sm:col-span-1">
                <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                  Custom Filename (Optional)
                </label>
                <input
                  type="text"
                  value={customFilename}
                  onChange={(e) => setCustomFilename(e.target.value)}
                  placeholder="Auto from title"
                  className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs p-2 text-[var(--vanta-text)]"
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-[var(--vanta-muted)]">Category</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
              >
                <option value="">Auto-Detect</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-[var(--vanta-muted)]">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="highest">Highest</option>
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-5 py-3 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono text-[var(--vanta-muted)] truncate">
            Dest: {settings?.download_dir || 'Default downloads folder'}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCloseModal}
              className="px-3.5 py-2 text-xs font-medium text-[var(--vanta-text-secondary)] hover:text-[var(--vanta-text)] transition-colors"
            >
              Cancel
            </button>
            {mode === 'single' && !metadata && (
              <button
                type="button"
                disabled={!url.trim() || isSubmitting}
                onClick={() => handleSubmit(true)}
                className="px-3.5 py-2 bg-[var(--vanta-surface)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40 border border-[var(--vanta-border)] text-[var(--vanta-text)] rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors"
              >
                Quick Queue
              </button>
            )}
            <button
              type="button"
              disabled={
                isSubmitting ||
                (mode === 'single' ? !url.trim() : batchValidation.valid.length === 0)
              }
              onClick={() => handleSubmit(false)}
              className="px-4 py-2 bg-[var(--vanta-accent)] hover:bg-[var(--vanta-accent-hover)] disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>
                {mode === 'batch'
                  ? `Queue ${batchValidation.valid.length} URL${batchValidation.valid.length === 1 ? '' : 's'}`
                  : 'Start Download'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
