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
  ListMusic,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  FolderOpen,
} from 'lucide-react';
import {
  AppSettings,
  DownloadQueue,
  CookieStatus,
  CookieValidationResult,
  DownloadTask,
  MediaMetadata,
  PlaylistEntry,
  SpotifyTrackItem,
  TaskPriority,
} from '../types';
import { api } from '../services/api';
import { isLikelyLossySource } from '../utils/audio-quality';
import { validateNetscapeCookies } from '../utils/cookie-validator';
import { describeCookieStatus } from '../utils/cookie-status-ui';
import { InspectionController } from '../utils/inspection-controller';
import { isSpotifyUrl } from '../utils/spotify';
import {
  buildCuratedVideoOptions,
  detectInspectedMediaKind,
  formatMediaRoutingLabel,
  getDefaultVideoFormatSelector,
  summarizeVideoOptionCodecs,
} from '../utils/media-formats';
import { parseBatchUrls, validateMediaUrl } from '../utils/engine-parser';
import { MediaThumbnail } from './MediaThumbnail';
import { findTrackLyrics } from '../utils/lyrics';

interface NewDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
  tasks: DownloadTask[];
  settings: AppSettings | null;
  queues: DownloadQueue[];
  defaultQueueId: string;
  onTaskCreated: () => void;
  onOpenCookieSettings?: () => void;
}

const SAMPLE_URLS = [
  {
    name: 'Big Buck Bunny 1080p MP4 (yt-dlp)',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
  },
  {
    name: 'SoundHelix CC MP3 (yt-dlp)',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  },
];

export const NewDownloadModal: React.FC<NewDownloadModalProps> = ({
  isOpen,
  onClose,
  initialUrl = '',
  tasks,
  settings,
  queues,
  defaultQueueId,
  onTaskCreated,
  onOpenCookieSettings,
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [selectedQueueId, setSelectedQueueId] = useState(defaultQueueId || 'main');
  const [batchUrls, setBatchUrls] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [isTimeoutError, setIsTimeoutError] = useState(false);

  // Ordered playlist & track selection state
  const [orderedEntries, setOrderedEntries] = useState<PlaylistEntry[]>([]);
  const [orderedSpotifyTracks, setOrderedSpotifyTracks] = useState<SpotifyTrackItem[]>([]);
  const [selectedPlaylistKeys, setSelectedPlaylistKeys] = useState<Record<string, boolean>>({});
  const [playlistSearch, setPlaylistSearch] = useState('');
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
  const [selectedFormatId, setSelectedFormatId] = useState<string>('bestvideo+bestaudio/best');
  const [selectedContainer, setSelectedContainer] = useState<string>('mp4');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<string>('mp3');
  const [selectedAudioBitrate, setSelectedAudioBitrate] = useState<string>('320k');
  const [selectedBitDepth, setSelectedBitDepth] = useState<number>(24);
  const [selectedSampleRate, setSelectedSampleRate] = useState<number>(48000);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [customFilename, setCustomFilename] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [downloadWholeCollection, setDownloadWholeCollection] = useState(true);
  const [downloadSubtitles, setDownloadSubtitles] = useState(false);
  const [includeAutoSubtitles, setIncludeAutoSubtitles] = useState(true);
  const [selectedSubtitleLanguages, setSelectedSubtitleLanguages] = useState<string[]>([]);
  const [subtitleDropdownOpen, setSubtitleDropdownOpen] = useState(false);
  const [lrcFile, setLrcFile] = useState<{ name: string; content: string } | null>(null);
  const [isFindingLyrics, setIsFindingLyrics] = useState(false);
  const [lyricsSearchMessage, setLyricsSearchMessage] = useState<string | null>(null);
  const [plainLyricsPreview, setPlainLyricsPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const lastInspectedUrlRef = useRef(initialUrl);

  const entryKey = (e: PlaylistEntry) => `entry-${e.index}-${e.id}`;
  const trackKey = (t: SpotifyTrackItem, _fallbackIdx: number) => `track-${t.id}`;

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
        setPlaylistSearch('');
        const detectedKind = detectInspectedMediaKind(
          patch.metadata,
          patch.metadata.url || lastInspectedUrlRef.current
        );
        setSelectedTab(detectedKind);
        setSelectedFormatId(getDefaultVideoFormatSelector(patch.metadata.formats || []));
        setDownloadWholeCollection(true);
        const subtitleCodes = new Set([
          ...(patch.metadata.subtitles || []).map((item) => item.code),
          ...(patch.metadata.automatic_subtitles || []).map((item) => item.code),
        ]);
        setSelectedSubtitleLanguages([...subtitleCodes]);
        if (patch.metadata.entries && patch.metadata.entries.length > 0) {
          setOrderedEntries([...patch.metadata.entries]);
          setOrderedSpotifyTracks([]);
          const initMap: Record<string, boolean> = {};
          patch.metadata.entries.forEach((e) => {
            initMap[entryKey(e)] = true;
          });
          setSelectedPlaylistKeys(initMap);
        } else if (patch.metadata.tracks && patch.metadata.tracks.length > 0) {
          setOrderedSpotifyTracks([...patch.metadata.tracks]);
          setOrderedEntries([]);
          const initMap: Record<string, boolean> = {};
          patch.metadata.tracks.forEach((t, idx) => {
            initMap[trackKey(t, idx)] = true;
          });
          setSelectedPlaylistKeys(initMap);
        } else {
          setOrderedEntries([]);
          setOrderedSpotifyTracks([]);
          setSelectedPlaylistKeys({});
        }
      } else {
        setOrderedEntries([]);
        setOrderedSpotifyTracks([]);
        setSelectedPlaylistKeys({});
        setSelectedSubtitleLanguages([]);
      }
    }
    if (patch.extractError !== undefined) setExtractError(patch.extractError);
    if (patch.isTimeoutError !== undefined) setIsTimeoutError(patch.isTimeoutError);
  };

  const inspect = async (targetUrl: string) => {
    lastInspectedUrlRef.current = targetUrl;
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
    setLrcFile(null);
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
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const preferredQueue = queues.find((queue) => queue.id === defaultQueueId);
      const firstRunningQueue = queues.find((queue) => !queue.is_paused);
      setSelectedQueueId(
        preferredQueue && !preferredQueue.is_paused
          ? preferredQueue.id
          : firstRunningQueue?.id || preferredQueue?.id || 'main'
      );
      refreshCookies();
      if (settings) {
        setSelectedContainer(settings.default_video_format || 'mp4');
        setSelectedAudioFormat(settings.default_audio_format || 'mp3');
        setSelectedAudioBitrate(settings.default_audio_bitrate || '320k');
        if (settings.default_audio_sample_rate) setSelectedSampleRate(settings.default_audio_sample_rate);
        if (settings.default_audio_bit_depth) setSelectedBitDepth(settings.default_audio_bit_depth);
        setOutputDir(settings.download_dir || '');
      }
      if (initialUrl) {
        setMode('single');
        setUrl(initialUrl);
        setCustomFilename('');
        setSelectedTab(detectInspectedMediaKind(null, initialUrl));
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
  const videoCodecSummary = useMemo(
    () => summarizeVideoOptionCodecs(metadata?.formats || [], selectedFormatId),
    [metadata?.formats, selectedFormatId]
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
  const isSpotifyContent = metadata?.extractor === 'spotdl' || isSpotifyUrl(url.trim());
  const detectedMediaKind = detectInspectedMediaKind(metadata, url);
  const routingLabel = formatMediaRoutingLabel(metadata, selectedTab, url);
  const subtitleLanguageOptions = (() => {
    const map = new Map<string, { code: string; name: string; manual: boolean; automatic: boolean }>();
    for (const item of metadata?.subtitles || []) {
      const current = map.get(item.code) || { code: item.code, name: item.name, manual: false, automatic: false };
      current.name = item.name || current.name;
      current.manual = true;
      map.set(item.code, current);
    }
    for (const item of metadata?.automatic_subtitles || []) {
      const current = map.get(item.code) || { code: item.code, name: item.name, manual: false, automatic: false };
      current.name = item.name || current.name;
      current.automatic = true;
      map.set(item.code, current);
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  })();

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const cleaned = text.trim();
        setUrl(cleaned);
        setSelectedTab(detectInspectedMediaKind(null, cleaned));
        inspect(cleaned);
      }
    } catch {
      // ignore
    }
  };

  const handleFindLyrics = async () => {
    const selectedTrack = orderedSpotifyTracks.filter(
      (track, idx) => selectedPlaylistKeys[trackKey(track, idx)] !== false
    )[0];
    const title = selectedTrack?.title || metadata?.title || '';
    const artist = selectedTrack?.artists?.join(', ') || metadata?.artists?.join(', ') || metadata?.uploader || '';
    const album = selectedTrack?.album || metadata?.album || undefined;
    const duration = selectedTrack?.duration || metadata?.duration || undefined;

    if (!title.trim() || !artist.trim()) {
      setLyricsSearchMessage('Analyze the media URL first so VANTA can identify the track and artist.');
      return;
    }

    setIsFindingLyrics(true);
    setLyricsSearchMessage(null);
    setPlainLyricsPreview(null);
    try {
      const result = await findTrackLyrics({ title, artist, album, duration });
      if (result.syncedLyrics?.trim()) {
        setLrcFile({ name: `${result.trackName} - ${result.artistName}.lrc`, content: result.syncedLyrics.trim() });
        setPlainLyricsPreview(null);
        setLyricsSearchMessage(`Found synchronized lyrics: ${result.trackName} — ${result.artistName}`);
      } else if (result.plainLyrics?.trim()) {
        setLrcFile(null);
        setPlainLyricsPreview(result.plainLyrics.trim());
        setLyricsSearchMessage('Only plain lyrics were found. They cannot be embedded as synchronized LRC without timestamps.');
      } else {
        setLyricsSearchMessage('This track has no available lyrics record.');
      }
    } catch (error) {
      setLyricsSearchMessage(error instanceof Error ? error.message : 'Lyrics search failed.');
    } finally {
      setIsFindingLyrics(false);
    }
  };

  const handleLrcFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.lrc')) {
      setExtractError('Choose a .lrc synchronized lyrics file.');
      return;
    }
    if (file.size > 512 * 1024) {
      setExtractError('The LRC file must be 512 KiB or smaller.');
      return;
    }
    try {
      const content = await file.text();
      if (!/^\s*\[\d{1,3}:\d{2}(?:[.,:]\d{1,3})?\]/m.test(content)) {
        setExtractError('This file does not contain valid LRC timestamps.');
        return;
      }
      setLrcFile({ name: file.name, content });
      setExtractError(null);
    } catch {
      setExtractError('Could not read the selected LRC file.');
    }
  };

  const handleBrowseOutputDir = async () => {
    try {
      const chosen = await api.selectDirectory();
      if (chosen) {
        setOutputDir(chosen);
      }
    } catch {
      // ignore if browser context lacks native folder picker
    }
  };

  const handleToggleAllPlaylist = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    orderedEntries.forEach((e) => {
      next[entryKey(e)] = checked;
    });
    orderedSpotifyTracks.forEach((t, idx) => {
      next[trackKey(t, idx)] = checked;
    });
    setSelectedPlaylistKeys(next);
  };

  const moveEntry = (idx: number, direction: -1 | 1) => {
    const target = idx + direction;
    if (target < 0 || target >= orderedEntries.length) return;
    setOrderedEntries((prev) => {
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const moveSpotifyTrack = (idx: number, direction: -1 | 1) => {
    const target = idx + direction;
    if (target < 0 || target >= orderedSpotifyTracks.length) return;
    setOrderedSpotifyTracks((prev) => {
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const handleSubmit = async (quickDownload = false) => {
    const isLossless = selectedAudioFormat === 'flac' || selectedAudioFormat === 'wav';
    const resolvedOutputDir = outputDir.trim() || settings?.download_dir || undefined;

    if (mode === 'batch') {
      if (batchValidation.valid.length === 0) return;
      setIsSubmitting(true);
      setExtractError(null);
      try {
        const selectedQueue = queues.find((queue) => queue.id === selectedQueueId);
        if (api.isTauri() && selectedQueue?.is_paused) {
          await api.startQueue(selectedQueueId);
        }
        for (const line of batchValidation.valid) {
          const lineIsSpotify = isSpotifyUrl(line);
          const isAudioOnly =
            selectedTab === 'audio' ||
            lineIsSpotify ||
            detectInspectedMediaKind(null, line) === 'audio';
          const ext = isAudioOnly ? selectedAudioFormat : selectedContainer;
          await api.createTask({
            url: line,
            queue_id: selectedQueueId,
            title: lineIsSpotify ? undefined : `Batch Media: ${line.substring(0, 48)}`,
            engine: lineIsSpotify ? 'spotdl' : 'yt-dlp',
            format_id: isAudioOnly ? 'bestaudio' : 'best',
            ext,
            is_audio_only: isAudioOnly,
            audio_format: selectedAudioFormat,
            audio_bitrate: selectedAudioBitrate,
            audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
            audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
            is_lossy_source: isLikelyLossySource(line),
            output_path: resolvedOutputDir,
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

    const checked = validateMediaUrl(trimmedUrl);
    if (!checked.valid) {
      setExtractError(checked.error);
      setIsTimeoutError(false);
      return;
    }

    setExtractError(null);
    setIsSubmitting(true);
    try {
      // "Start Download" must not silently add work to a stopped queue.
      // Quick Queue intentionally preserves the selected queue's stopped state.
      const selectedQueue = queues.find((queue) => queue.id === selectedQueueId);
      if (!quickDownload && api.isTauri() && selectedQueue?.is_paused) {
        await api.startQueue(selectedQueueId);
      }

      const urlIsSpotify = metadata?.extractor === 'spotdl' || checked.engine === 'spotdl';
      const isAudioOnly = selectedTab === 'audio' || urlIsSpotify;
      const chosenFormatId = quickDownload ? (isAudioOnly ? 'bestaudio' : 'best') : selectedFormatId;
      const ext = isAudioOnly ? selectedAudioFormat : selectedContainer;
      const isSourceLossy = isLikelyLossySource(checked.normalized, metadata?.extractor);
      const resolvedUploader =
        metadata?.artists && metadata.artists.length > 0
          ? metadata.artists.join(', ')
          : metadata?.owner || metadata?.uploader;
      const resolvedArtwork = metadata?.album_artwork || metadata?.thumbnail;
      let effectiveUrl = checked.normalized;
      let effectiveTitle = metadata?.title || (urlIsSpotify ? undefined : 'Media Download');
      let effectiveUploader = resolvedUploader;
      let effectiveDuration = metadata?.duration;
      let effectiveDurationString = metadata?.duration_string;

      // In single-item mode, use the selected item's own URL instead of passing the
      // parent playlist URL with --no-playlist (which would otherwise grab its first item).
      if (!downloadWholeCollection && orderedEntries.length > 0) {
        const picked = orderedEntries.filter((entry) => selectedPlaylistKeys[entryKey(entry)] !== false);
        if (picked.length !== 1) {
          setExtractError('Select exactly one video from the playlist for single-item mode.');
          setIsSubmitting(false);
          return;
        }
        const selected = picked[0];
        if (!/^https?:\/\//i.test(selected.url) || selected.url === checked.normalized) {
          setExtractError('The selected playlist item does not have a direct media URL. Use Playlist / Album mode instead.');
          setIsSubmitting(false);
          return;
        }
        effectiveUrl = selected.url;
        effectiveTitle = selected.title;
        effectiveUploader = selected.uploader || resolvedUploader;
        effectiveDuration = selected.duration;
        effectiveDurationString = selected.duration_string;
      } else if (!downloadWholeCollection && orderedSpotifyTracks.length > 0) {
        const picked = orderedSpotifyTracks.filter((track, idx) => selectedPlaylistKeys[trackKey(track, idx)] !== false);
        if (picked.length !== 1) {
          setExtractError('Select exactly one track for single-item mode.');
          setIsSubmitting(false);
          return;
        }
        const selectedTrackUrl = picked[0].url?.trim();
        if (!selectedTrackUrl || !/^https?:\/\//i.test(selectedTrackUrl)) {
          setExtractError('The selected Spotify track does not have a direct track URL. Use Playlist / Album mode instead.');
          setIsSubmitting(false);
          return;
        }
        effectiveUrl = selectedTrackUrl;
        effectiveTitle = picked[0].title;
        effectiveUploader = picked[0].artists.join(', ') || resolvedUploader;
        effectiveDuration = picked[0].duration;
        effectiveDurationString = picked[0].duration_string;
      }

      // Playlist / Album selection + custom ordering for yt-dlp
      if (orderedEntries.length > 0 && downloadWholeCollection && !quickDownload) {
        const pickedEntries = orderedEntries.filter(
          (e) => selectedPlaylistKeys[entryKey(e)] !== false
        );
        if (pickedEntries.length === 0) {
          setExtractError('Select at least one playlist item to download.');
          setIsSubmitting(false);
          return;
        }
        await api.createTask({
          url: checked.normalized,
          queue_id: selectedQueueId,
          title: metadata?.title || 'Media Playlist',
          uploader: resolvedUploader,
          duration: metadata?.duration,
          duration_string: metadata?.duration_string,
          thumbnail: resolvedArtwork,
          engine: 'yt-dlp',
          format_id: isAudioOnly ? 'bestaudio' : chosenFormatId,
          ext,
          is_audio_only: isAudioOnly,
          audio_format: selectedAudioFormat,
          audio_bitrate: selectedAudioBitrate,
          audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
          audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
          is_lossy_source: isSourceLossy,
          output_path: resolvedOutputDir,
          custom_filename: customFilename.trim() || undefined,
          playlist_mode: 'playlist',
          selected_items: pickedEntries.map((e) => String(e.index)),
          subtitle_languages: downloadSubtitles ? selectedSubtitleLanguages : [],
          write_auto_subtitles: downloadSubtitles && includeAutoSubtitles,
          tracks_requested: pickedEntries.length,
          priority,
        });
        handleCloseModal();
        onTaskCreated();
        return;
      }

      // Spotify album / playlist track selection + custom ordering for spotDL
      if (orderedSpotifyTracks.length > 0 && downloadWholeCollection && !quickDownload) {
        const pickedTracks = orderedSpotifyTracks.filter(
          (t, idx) => selectedPlaylistKeys[trackKey(t, idx)] !== false
        );
        if (pickedTracks.length === 0) {
          setExtractError('Select at least one track to download.');
          setIsSubmitting(false);
          return;
        }
        const trackUrls = pickedTracks
          .map((t) => t.url)
          .filter((u): u is string => Boolean(u && u.trim()));

        await api.createTask({
          url: checked.normalized,
          queue_id: selectedQueueId,
          title: metadata?.title,
          uploader: resolvedUploader,
          duration: metadata?.duration,
          duration_string: metadata?.duration_string,
          thumbnail: resolvedArtwork,
          album: metadata?.album,
          content_type: metadata?.content_type,
          engine: 'spotdl',
          format_id: 'bestaudio',
          ext: selectedAudioFormat,
          is_audio_only: true,
          audio_format: selectedAudioFormat,
          audio_bitrate: selectedAudioBitrate,
          audio_sample_rate: isLossless ? selectedSampleRate : undefined,
          audio_bit_depth: isLossless ? selectedBitDepth : undefined,
          is_lossy_source: true,
          output_path: resolvedOutputDir,
          custom_filename: customFilename.trim() || undefined,
          playlist_mode: trackUrls.length === 1 && !metadata?.is_playlist ? 'single' : 'playlist',
          selected_items: trackUrls.length > 0 ? trackUrls : undefined,
          tracks_requested: trackUrls.length > 0 ? trackUrls.length : undefined,
          lyrics_lrc_content: trackUrls.length === 1 ? lrcFile?.content : undefined,
          priority,
        });
        handleCloseModal();
        onTaskCreated();
        return;
      }

      await api.createTask({
        url: effectiveUrl,
        queue_id: selectedQueueId,
        title: effectiveTitle,
        uploader: effectiveUploader,
        duration: effectiveDuration,
        duration_string: effectiveDurationString,
        thumbnail: resolvedArtwork,
        album: metadata?.album,
        content_type: metadata?.content_type,
        engine: urlIsSpotify ? 'spotdl' : 'yt-dlp',
        format_id: isAudioOnly ? 'bestaudio' : chosenFormatId,
        ext,
        is_audio_only: isAudioOnly,
        audio_format: selectedAudioFormat,
        audio_bitrate: selectedAudioBitrate,
        audio_sample_rate: isAudioOnly && isLossless ? selectedSampleRate : undefined,
        audio_bit_depth: isAudioOnly && isLossless ? selectedBitDepth : undefined,
        is_lossy_source: isSourceLossy,
        output_path: resolvedOutputDir,
        custom_filename: customFilename.trim() || undefined,
        subtitle_languages: downloadSubtitles ? selectedSubtitleLanguages : [],
        write_auto_subtitles: downloadSubtitles && includeAutoSubtitles,
        lyrics_lrc_content: isAudioOnly ? lrcFile?.content : undefined,
        playlist_mode:
          downloadWholeCollection && includePlaylistMode && metadata?.is_playlist
            ? 'playlist'
            : 'single',
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

  const selectedEntryCount = orderedEntries.filter(
    (e) => selectedPlaylistKeys[entryKey(e)] !== false
  ).length;
  const selectedTrackCount = orderedSpotifyTracks.filter(
    (t, idx) => selectedPlaylistKeys[trackKey(t, idx)] !== false
  ).length;
  const playlistQuery = playlistSearch.trim().toLocaleLowerCase();
  const visibleEntries = orderedEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      !playlistQuery ||
      `${entry.title} ${entry.uploader || ''} ${entry.id}`.toLocaleLowerCase().includes(playlistQuery)
    );
  const visibleSpotifyTracks = orderedSpotifyTracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) =>
      !playlistQuery ||
      `${track.title} ${track.artists.join(' ')} ${track.album || ''}`.toLocaleLowerCase().includes(playlistQuery)
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/70 backdrop-blur-xs select-none">
      <div className="relative w-full max-w-2xl bg-[var(--vanta-surface)] border border-[var(--vanta-border-strong)] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-[var(--vanta-border)] bg-[var(--vanta-surface-2)]">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--vanta-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--vanta-text)]">New Media Download</h2>
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
          <div className="flex items-center gap-3 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="download-queue" className="block text-[10px] font-medium uppercase tracking-wide text-[var(--vanta-muted)]">Add to Queue</label>
              <select
                id="download-queue"
                value={selectedQueueId}
                onChange={(e) => setSelectedQueueId(e.target.value)}
                className="mt-0.5 w-full bg-transparent text-xs font-medium text-[var(--vanta-text)] outline-none"
              >
                {queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>{queue.name}{queue.is_paused ? ' · Stopped' : ''}</option>
                ))}
              </select>
            </div>
            <span className="shrink-0 text-[10px] text-[var(--vanta-muted)]">Downloads are grouped here</span>
          </div>

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
              Single URL / Playlist
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
              Batch Media URLs
            </button>
          </div>

          {mode === 'single' ? (
            <div className="space-y-2.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-[var(--vanta-text-secondary)]">
                    Video or Music URL (YouTube, Spotify, etc.)
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
                      placeholder="https://www.youtube.com/watch?v=... or https://open.spotify.com/..."
                      value={url}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setUrl(nextVal);
                        setSelectedTab(detectInspectedMediaKind(null, nextVal));
                        if (isExtracting) handleCancelInspection();
                        if (extractError) {
                          setExtractError(null);
                          setIsTimeoutError(false);
                        }
                        if (metadata) {
                          setMetadata(null);
                          setOrderedEntries([]);
                          setOrderedSpotifyTracks([]);
                        }
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
                        setOrderedEntries([]);
                        setOrderedSpotifyTracks([]);
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

              {/* Sample Media Presets */}
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="text-[var(--vanta-muted)]">Media presets:</span>
                {SAMPLE_URLS.map((sample) => (
                  <button
                    key={sample.name}
                    type="button"
                    onClick={() => {
                      setUrl(sample.url);
                      setSelectedTab(detectInspectedMediaKind(null, sample.url));
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
                Batch Media URL List (one video/music URL per line)
              </label>
              <textarea
                rows={5}
                placeholder="https://www.youtube.com/watch?v=...&#10;https://open.spotify.com/track/..."
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                className="w-full bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs p-3 text-[var(--vanta-text)] font-mono placeholder-[var(--vanta-muted)]"
              />
              {batchUrls.trim() && (
                <div className="text-[11px] font-mono tabular-nums space-y-1">
                  <p className="text-[var(--vanta-text-secondary)]">
                    Valid URLs:{' '}
                    <span className="text-emerald-700 dark:text-[#3fb950] font-semibold">
                      {batchValidation.valid.length}
                    </span>
                    {batchValidation.duplicatesRemoved > 0 &&
                      ` · Duplicates skipped: ${batchValidation.duplicatesRemoved}`}
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
                    Timeout protection active. Cancel anytime or use Quick Queue.
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

          {/* Extraction / Validation Error Notice */}
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
              {!/music and video only|files are not supported|Invalid URL|Unsupported URL scheme/i.test(
                extractError
              ) && (
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
              )}
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
                <MediaThumbnail
                  src={metadata.album_artwork || metadata.thumbnail}
                  title={metadata.title}
                  isAudio={detectedMediaKind === 'audio'}
                  size={detectedMediaKind === 'audio' ? 'md' : 'md'}
                  aspect={detectedMediaKind === 'audio' ? 'square' : 'video'}
                  showBadge={false}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--vanta-text)] truncate">
                      {metadata.title}
                    </h3>
                    {metadata.explicit && (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--vanta-surface)] border border-[var(--vanta-border)] text-[10px] font-mono text-[var(--vanta-muted)] shrink-0">
                        Explicit
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[var(--vanta-muted)] mt-1 tabular-nums">
                    <span
                      className={`font-semibold ${
                        detectedMediaKind === 'audio'
                          ? 'text-emerald-700 dark:text-[#3fb950]'
                          : 'text-[var(--vanta-accent)]'
                      }`}
                    >
                      {routingLabel}
                    </span>
                    {(metadata.artists?.length ? metadata.artists.join(', ') : metadata.owner || metadata.uploader) && (
                      <span className="text-[var(--vanta-text-secondary)]">
                        · {metadata.artists?.length ? metadata.artists.join(', ') : metadata.owner || metadata.uploader}
                      </span>
                    )}
                    {metadata.album && <span>· {metadata.album}</span>}
                    {metadata.release_date && <span>· {metadata.release_date}</span>}
                    {metadata.duration_string && <span>· {metadata.duration_string}</span>}
                    {(metadata.total_tracks || metadata.playlist_count) && (
                      <span>· {metadata.total_tracks || metadata.playlist_count} tracks</span>
                    )}
                  </div>
                </div>
              </div>

              {(orderedEntries.length > 1 || orderedSpotifyTracks.length > 1) && (
                <div className="pt-2 border-t border-[var(--vanta-border)] flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="text-[var(--vanta-muted)]">Collection handling:</span>
                  <div className="flex items-center gap-1 p-0.5 rounded-md bg-[var(--vanta-surface)] border border-[var(--vanta-border)]">
                    <button
                      type="button"
                      onClick={() => setDownloadWholeCollection(true)}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        downloadWholeCollection
                          ? 'bg-[var(--vanta-accent)] text-white'
                          : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
                      }`}
                    >
                      Playlist / Album
                    </button>
                    <button
                      type="button"
                      onClick={() => setDownloadWholeCollection(false)}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        !downloadWholeCollection
                          ? 'bg-[var(--vanta-accent)] text-white'
                          : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
                      }`}
                    >
                      Single Item Only
                    </button>
                  </div>
                </div>
              )}

              {(orderedEntries.length > 0 || orderedSpotifyTracks.length > 0) && downloadWholeCollection && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--vanta-muted)]" />
                  <input
                    type="search"
                    value={playlistSearch}
                    onChange={(e) => setPlaylistSearch(e.target.value)}
                    placeholder="Search playlist items by title, artist, or ID..."
                    aria-label="Search playlist items"
                    className="w-full pl-9 pr-3 py-2 rounded-md bg-[var(--vanta-surface)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none text-[11px] text-[var(--vanta-text)] placeholder:text-[var(--vanta-muted)]"
                  />
                </div>
              )}

              {/* yt-dlp Playlist Selection & Ordering */}
              {orderedEntries.length > 0 && downloadWholeCollection && (
                <div className="pt-2.5 border-t border-[var(--vanta-border)] space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-[var(--vanta-text)] flex items-center gap-1.5">
                      <ListMusic className="w-3.5 h-3.5 text-[var(--vanta-accent)]" />
                      <span>
                        Playlist Items ({selectedEntryCount}/{orderedEntries.length} selected · download order)
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
                  <div className="max-h-48 overflow-y-auto divide-y divide-[var(--vanta-border)] rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
                    {visibleEntries.map(({ entry, index: idx }) => {
                      const key = entryKey(entry);
                      const checked = selectedPlaylistKeys[key] !== false;
                      return (
                        <div
                          key={key}
                          className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] hover:bg-[var(--vanta-surface-hover)]/50"
                        >
                          <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
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
                          </label>
                          <div className="flex items-center gap-1 shrink-0">
                            {entry.duration_string && (
                              <span className="font-mono tabular-nums text-[var(--vanta-muted)] mr-1">
                                {entry.duration_string}
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveEntry(idx, -1)}
                              aria-label={`Move ${entry.title} up`}
                              className="p-0.5 rounded text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] disabled:opacity-30"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderedEntries.length - 1}
                              onClick={() => moveEntry(idx, 1)}
                              aria-label={`Move ${entry.title} down`}
                              className="p-0.5 rounded text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] disabled:opacity-30"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Spotify Tracklist Selection & Ordering */}
              {orderedSpotifyTracks.length > 0 && downloadWholeCollection && (
                <div className="pt-2.5 border-t border-[var(--vanta-border)] space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-[var(--vanta-text)] flex items-center gap-1.5">
                      <ListMusic className="w-3.5 h-3.5 text-emerald-600 dark:text-[#3fb950]" />
                      <span>
                        Tracklist ({selectedTrackCount}/{orderedSpotifyTracks.length} selected
                        {metadata.partial_tracks && metadata.total_tracks
                          ? ` of ${metadata.total_tracks}`
                          : ''}
                        {' '}· download order)
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
                  <div className="max-h-48 overflow-y-auto divide-y divide-[var(--vanta-border)] rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
                    {visibleSpotifyTracks.map(({ track, index: idx }) => {
                      const key = trackKey(track, idx);
                      const checked = selectedPlaylistKeys[key] !== false;
                      return (
                        <div
                          key={key}
                          className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] hover:bg-[var(--vanta-surface-hover)]/50"
                        >
                          <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
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
                          </label>
                          <div className="flex items-center gap-1 shrink-0">
                            {track.duration_string && (
                              <span className="font-mono tabular-nums text-[var(--vanta-muted)] mr-1">
                                {track.duration_string}
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveSpotifyTrack(idx, -1)}
                              aria-label={`Move ${track.title} up`}
                              className="p-0.5 rounded text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] disabled:opacity-30"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderedSpotifyTracks.length - 1}
                              onClick={() => moveSpotifyTrack(idx, 1)}
                              aria-label={`Move ${track.title} down`}
                              className="p-0.5 rounded text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] disabled:opacity-30"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Output Workflow */}
          <div className="space-y-3 pt-2 border-t border-[var(--vanta-border)]">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <span className="text-xs font-medium text-[var(--vanta-text-secondary)] block">
                  Download Format &amp; Quality
                </span>
                <span className="text-[11px] font-mono text-[var(--vanta-muted)]">
                  Engine routing: {routingLabel}
                </span>
              </div>
              <div className="flex items-center gap-1 p-0.5 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg">
                {!isSpotifyContent && (
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
                )}
                <button
                  type="button"
                  onClick={() => setSelectedTab('audio')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${
                    selectedTab === 'audio' || isSpotifyContent
                      ? 'bg-[var(--vanta-surface)] text-[var(--vanta-accent)] border border-[var(--vanta-border)]'
                      : 'text-[var(--vanta-muted)] hover:text-[var(--vanta-text)]'
                  }`}
                >
                  <Music className="w-3.5 h-3.5" />
                  <span>Audio Only</span>
                </button>
              </div>
            </div>

            {selectedTab === 'video' && !isSpotifyContent ? (
              <div className="space-y-2.5">
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
                      <option value="mkv">MKV (Matroska Streams)</option>
                      <option value="webm">WebM (VP9 / AV1)</option>
                    </select>
                  </div>
                </div>
                {videoCodecSummary && (
                  <p className="text-[11px] font-mono text-[var(--vanta-muted)]">
                    Detected streams: {videoCodecSummary.resolution} · Video {videoCodecSummary.vcodec} · Audio{' '}
                    {videoCodecSummary.acodec}
                    {videoCodecSummary.fps ? ` · ${Math.round(videoCodecSummary.fps)} fps` : ''}
                  </p>
                )}
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
                          Source stream is lossy web audio (Opus/AAC). Exporting to{' '}
                          {selectedAudioFormat.toUpperCase()} preserves current quality without
                          restoring lost frequencies.
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Optional local synchronized lyrics sidecar */}
          {mode === 'single' && selectedTab === 'audio' &&
            (orderedSpotifyTracks.length === 0 || selectedTrackCount === 1) && (
            <div className="space-y-2 pt-3 border-t border-[var(--vanta-border)]">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-xs font-semibold text-[var(--vanta-text)]">
                  Synchronized lyrics
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { void handleFindLyrics(); }}
                    disabled={isFindingLyrics}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--vanta-accent)]/40 px-2.5 py-1.5 text-[11px] font-medium text-[var(--vanta-accent)] hover:bg-[var(--vanta-accent)]/10 disabled:opacity-50"
                  >
                    {isFindingLyrics ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                    {isFindingLyrics ? 'Searching…' : 'Find Lyrics'}
                  </button>
                  <span className="text-[10px] text-[var(--vanta-muted)]">Optional · .LRC</span>
                </div>
              </div>
              <textarea
                value={lrcFile?.content || ''}
                onChange={(event) => {
                  const content = event.target.value;
                  if (new TextEncoder().encode(content).length > 512 * 1024) {
                    setExtractError('Lyrics must be 512 KiB or smaller.');
                    return;
                  }
                  setLrcFile(content.trim() ? { name: 'Pasted lyrics.lrc', content } : null);
                  if (!content.trim() || /^\s*\[\d{1,3}:\d{2}(?:[.,:]\d{1,3})?\]/m.test(content)) {
                    setExtractError(null);
                  } else {
                    setExtractError('Use timestamped LRC lines such as [00:12.40]...');
                  }
                }}
                rows={4}
                maxLength={512 * 1024}
                placeholder={'Paste your synchronized LRC text here…\n[00:12.40] First line\n[00:16.20] Next line'}
                className="w-full resize-y min-h-[92px] rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-2 text-[11px] leading-5 font-mono text-[var(--vanta-text)] placeholder:text-[var(--vanta-muted)] focus:outline-none focus:border-[var(--vanta-accent)]"
              />
              {lyricsSearchMessage && (
                <p role="status" className="text-[10px] leading-4 text-[var(--vanta-text-secondary)]">{lyricsSearchMessage}</p>
              )}
              {plainLyricsPreview && (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-medium text-[var(--vanta-muted)]">Plain lyrics preview (not timestamped)</span>
                  <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] p-2.5 text-[10px] leading-4 text-[var(--vanta-text-secondary)]">{plainLyricsPreview}</pre>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--vanta-muted)]">Search online, paste text directly, or import an existing LRC file.</span>
                <label className="cursor-pointer rounded-md border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-1.5 text-[11px] text-[var(--vanta-text)] hover:bg-[var(--vanta-surface-hover)]">
                  Import .LRC
                  <input type="file" accept=".lrc,text/plain" onChange={handleLrcFileChange} className="hidden" />
                </label>
              </div>
              {lrcFile && (
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-[var(--vanta-text-secondary)]">{lrcFile.name}</span>
                  <button
                    type="button"
                    onClick={() => setLrcFile(null)}
                    className="shrink-0 text-[var(--vanta-muted)] hover:text-red-500"
                  >
                    Remove
                  </button>
                </div>
              )}
              <p className="text-[10px] text-[var(--vanta-muted)]">
                VANTA embeds timestamped lyrics in MP3 ID3 tags (SYLT) and also saves an .LRC sidecar. Other audio formats keep the .LRC sidecar beside the track.
              </p>
            </div>
          )}

          {/* Subtitle selection */}
          {selectedTab === 'video' && !isSpotifyContent && subtitleLanguageOptions.length > 0 && (
            <div className="space-y-2.5 pt-3 border-t border-[var(--vanta-border)]">
              <label className="flex items-center gap-2 text-xs font-medium text-[var(--vanta-text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={downloadSubtitles}
                  onChange={(e) => {
                    setDownloadSubtitles(e.target.checked);
                    if (e.target.checked) setSubtitleDropdownOpen(true);
                  }}
                  className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]"
                />
                Embed subtitles in video ({subtitleLanguageOptions.length} languages available)
              </label>
              {downloadSubtitles && (
                <>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setSubtitleDropdownOpen((open) => !open)}
                      aria-expanded={subtitleDropdownOpen}
                      className="w-full flex items-center justify-between gap-2 rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] px-3 py-2 text-xs text-[var(--vanta-text)]"
                    >
                      <span className="truncate text-left">
                        {selectedSubtitleLanguages.length === 0
                          ? 'Select subtitle languages'
                          : selectedSubtitleLanguages.length === subtitleLanguageOptions.length
                            ? 'All languages selected'
                            : subtitleLanguageOptions.filter((item) => selectedSubtitleLanguages.includes(item.code)).map((item) => item.name).join(', ')}
                      </span>
                      <span className="text-[var(--vanta-muted)] shrink-0">{subtitleDropdownOpen ? '▲' : '▼'}</span>
                    </button>
                    {subtitleDropdownOpen && (
                      <div className="absolute z-30 mt-1 w-full rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface)] shadow-xl p-2">
                        <div className="flex items-center justify-between px-1 pb-2 text-[11px]">
                          <span className="text-[var(--vanta-muted)]">{selectedSubtitleLanguages.length} / {subtitleLanguageOptions.length} selected</span>
                          <div className="flex gap-3">
                            <button
                              type="button"
                              onClick={() => setSelectedSubtitleLanguages(subtitleLanguageOptions.map((item) => item.code))}
                              className="text-[var(--vanta-accent)] hover:underline"
                            >Select all</button>
                            <button
                              type="button"
                              onClick={() => setSelectedSubtitleLanguages([])}
                              className="text-[var(--vanta-muted)] hover:underline"
                            >Clear</button>
                          </div>
                        </div>
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {subtitleLanguageOptions.map((item) => (
                            <label key={item.code} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--vanta-surface-2)] text-[11px] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selectedSubtitleLanguages.includes(item.code)}
                                onChange={(e) => setSelectedSubtitleLanguages((prev) =>
                                  e.target.checked
                                    ? [...new Set([...prev, item.code])]
                                    : prev.filter((code) => code !== item.code)
                                )}
                                className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)] shrink-0"
                              />
                              <span className="truncate text-[var(--vanta-text)]">{item.name}</span>
                              <span className="font-mono text-[var(--vanta-muted)] ml-auto shrink-0">{item.code}</span>
                              <span className="text-[9px] text-[var(--vanta-muted)] shrink-0">
                                {item.manual && item.automatic ? 'Manual + Auto' : item.manual ? 'Manual' : 'Auto'}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-[var(--vanta-text-secondary)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAutoSubtitles}
                      onChange={(e) => setIncludeAutoSubtitles(e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-[var(--vanta-accent)]"
                    />
                    Include auto-generated captions
                  </label>
                </>
              )}
            </div>
          )}

          {/* Filename, Priority & Output Directory */}
          <div className="space-y-3 pt-2 border-t border-[var(--vanta-border)]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {mode === 'single' && (
                <div className="space-y-1">
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

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-[var(--vanta-muted)]">
                Output Directory
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  placeholder={settings?.download_dir || 'Default downloads folder'}
                  className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs p-2 font-mono text-[var(--vanta-text)]"
                />
                {api.isTauri() && (
                  <button
                    type="button"
                    onClick={handleBrowseOutputDir}
                    className="px-2.5 py-2 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] border border-[var(--vanta-border)] rounded-lg text-xs text-[var(--vanta-text)] inline-flex items-center gap-1.5 shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Browse</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-5 py-3 border-t border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono text-[var(--vanta-muted)] truncate">
            {routingLabel} · {outputDir || settings?.download_dir || 'Default folder'}
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
