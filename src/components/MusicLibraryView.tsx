import React, { useState } from 'react';
import { Music, Download, Loader2, AlertCircle, FolderOpen, ListMusic } from 'lucide-react';
import { DownloadTask } from '../types';
import { api } from '../services/api';
import { formatBytes, validateMediaUrl } from '../utils/engine-parser';
import { isSpotifyUrl } from '../utils/spotify';
import { ProgressDisplay } from './ProgressDisplay';

interface MusicLibraryViewProps {
  tasks: DownloadTask[];
  onOpenNewDownload: (url?: string) => void;
  onSelectTask?: (task: DownloadTask) => void;
}

const SAMPLE_AUDIO_PRESETS = [
  {
    title: 'SoundHelix Audio Stream 1 (yt-dlp)',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    artist: 'SoundHelix',
  },
  {
    title: 'SoundHelix Audio Stream 2 (yt-dlp)',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    artist: 'SoundHelix',
  },
];

export const MusicLibraryView: React.FC<MusicLibraryViewProps> = ({
  tasks,
  onOpenNewDownload,
  onSelectTask,
}) => {
  const [musicUrl, setMusicUrl] = useState('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [audioBitrate, setAudioBitrate] = useState('320k');
  const [isResolving, setIsResolving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const musicTasks = tasks.filter((t) => t.is_audio_only || t.engine === 'spotdl');

  const handleInspectAndSelect = () => {
    const target = musicUrl.trim();
    const validation = validateMediaUrl(target);
    if (!validation.valid) {
      setSubmitError(validation.error);
      return;
    }
    setSubmitError(null);
    onOpenNewDownload(validation.normalized);
  };

  const handleDownloadMusic = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = musicUrl.trim();
    if (!target || isResolving) return;

    const validation = validateMediaUrl(target);
    if (!validation.valid) {
      setSubmitError(validation.error);
      return;
    }

    setSubmitError(null);
    setIsResolving(true);

    try {
      const spotifyInput = isSpotifyUrl(validation.normalized);
      if (spotifyInput) {
        const meta = await api.inspectUrl(validation.normalized);
        const uploader =
          meta.artists && meta.artists.length > 0
            ? meta.artists.join(', ')
            : meta.owner || meta.uploader;

        const trackUrls = (meta.tracks || [])
          .map((t) => t.url)
          .filter((u): u is string => Boolean(u && u.trim()));

        await api.createTask({
          url: meta.url || validation.normalized,
          title: meta.title,
          uploader,
          duration: meta.duration,
          duration_string: meta.duration_string,
          thumbnail: meta.album_artwork || meta.thumbnail,
          album: meta.album,
          content_type: meta.content_type,
          engine: 'spotdl',
          format_id: 'bestaudio',
          ext: audioFormat,
          is_audio_only: true,
          audio_format: audioFormat,
          audio_bitrate: audioBitrate,
          is_lossy_source: true,
          playlist_mode: meta.is_playlist || trackUrls.length > 1 ? 'playlist' : 'single',
          selected_items: trackUrls.length > 0 ? trackUrls : undefined,
          tracks_requested: trackUrls.length > 0 ? trackUrls.length : undefined,
        });
      } else {
        const preset = SAMPLE_AUDIO_PRESETS.find((s) => s.url === validation.normalized);
        await api.createTask({
          url: validation.normalized,
          title: preset?.title,
          uploader: preset?.artist,
          engine: 'yt-dlp',
          format_id: 'bestaudio',
          ext: audioFormat,
          is_audio_only: true,
          audio_format: audioFormat,
          audio_bitrate: audioBitrate,
        });
      }

      setMusicUrl('');
    } catch (err: any) {
      setSubmitError(err?.message || 'Unable to resolve music metadata or queue download.');
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)]">
        <div>
          <h1 className="text-base font-semibold text-[var(--vanta-text)] flex items-center gap-2">
            <Music className="w-4 h-4 text-emerald-600 dark:text-[#3fb950]" />
            <span>Music &amp; Audio Workflow</span>
          </h1>
          <p className="text-xs text-[var(--vanta-muted)] mt-0.5">
            Download Spotify tracks, albums, and playlists via spotDL or extract music streams via yt-dlp with artwork and tags
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-[var(--vanta-muted)]">
          {musicTasks.length} audio item{musicTasks.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Music Ingestion Form */}
      <div className="p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-3">
        <form onSubmit={handleDownloadMusic} className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2.5">
          <input
            type="text"
            placeholder="Paste Spotify track/album/playlist URL or YouTube Music / SoundCloud link..."
            value={musicUrl}
            onChange={(e) => {
              setMusicUrl(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs py-2 px-3 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)]"
          />

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <select
              aria-label="Audio format"
              value={audioFormat}
              onChange={(e) => setAudioFormat(e.target.value)}
              className="bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
            >
              <option value="mp3">MP3</option>
              <option value="m4a">M4A</option>
              <option value="opus">OPUS</option>
              <option value="flac">FLAC</option>
              <option value="wav">WAV</option>
            </select>

            <select
              aria-label="Audio bitrate"
              value={audioBitrate}
              onChange={(e) => setAudioBitrate(e.target.value)}
              className="bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] rounded-lg text-xs p-2 text-[var(--vanta-text)]"
            >
              <option value="320k">320k</option>
              <option value="256k">256k</option>
              <option value="192k">192k</option>
              <option value="128k">128k</option>
            </select>

            <button
              type="button"
              disabled={!musicUrl.trim() || isResolving}
              onClick={handleInspectAndSelect}
              className="px-3 py-2 bg-[var(--vanta-surface-2)] hover:bg-[var(--vanta-surface-hover)] disabled:opacity-40 border border-[var(--vanta-border)] text-[var(--vanta-text)] rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <ListMusic className="w-3.5 h-3.5 text-[var(--vanta-accent)]" />
              <span>Select &amp; Order Tracks</span>
            </button>

            <button
              type="submit"
              disabled={!musicUrl.trim() || isResolving}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              {isResolving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>{isResolving ? 'Resolving...' : 'Download Audio'}</span>
            </button>
          </div>
        </form>

        {submitError && (
          <div className="p-2.5 rounded-lg border border-red-500/35 bg-red-500/10 text-xs text-red-600 dark:text-[#f85149] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{submitError}</span>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap text-[11px] pt-1">
          <span className="text-[var(--vanta-muted)]">Presets:</span>
          {SAMPLE_AUDIO_PRESETS.map((track) => (
            <button
              key={track.title}
              type="button"
              onClick={() => {
                setMusicUrl(track.url);
                setSubmitError(null);
              }}
              className="text-[var(--vanta-accent)] hover:underline font-medium"
            >
              {track.title}
            </button>
          ))}
        </div>
      </div>

      {/* Audio Tracks List */}
      <div className="rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] overflow-hidden">
        {musicTasks.length === 0 ? (
          <div className="py-14 px-4 text-center space-y-1.5">
            <Music className="w-8 h-8 text-[var(--vanta-muted)]/60 mx-auto" />
            <p className="text-xs font-medium text-[var(--vanta-text)]">No music downloads yet</p>
            <p className="text-[11px] text-[var(--vanta-muted)]">
              Paste a Spotify URL, YouTube Music link, or supported audio stream above to download tracks or playlists.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--vanta-border)]">
            {musicTasks.map((track) => (
              <div
                key={track.id}
                onClick={() => onSelectTask?.(track)}
                className="p-3.5 hover:bg-[var(--vanta-surface-hover)]/50 transition-colors cursor-pointer space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {track.thumbnail ? (
                      <img
                        src={track.thumbnail}
                        alt={track.title}
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-md object-cover bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-md bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] flex items-center justify-center shrink-0 text-[var(--vanta-muted)]">
                        <Music className="w-4 h-4" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <h4 className="text-xs font-semibold text-[var(--vanta-text)] truncate">
                        {track.title}
                      </h4>
                      <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono text-[var(--vanta-muted)] mt-0.5">
                        <span>{track.engine}</span>
                        <span>· {(track.audio_format || track.ext).toUpperCase()}</span>
                        {track.audio_bitrate && <span>· {track.audio_bitrate}</span>}
                        {track.uploader && <span className="truncate max-w-xs">· {track.uploader}</span>}
                        {track.album && <span className="truncate max-w-xs">· {track.album}</span>}
                        {(track.tracks_requested ?? 0) > 0 && (
                          <span className="tabular-nums text-[var(--vanta-text-secondary)]">
                            · {track.tracks_completed ?? 0}/{track.tracks_requested} tracks
                            {(track.tracks_failed ?? 0) > 0 ? (
                              <span className="text-red-600 dark:text-[#f85149]">
                                {' '}({track.tracks_failed} failed)
                              </span>
                            ) : null}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-xs font-mono tabular-nums text-[var(--vanta-muted)]">
                    <span>
                      {track.total_bytes > 0
                        ? formatBytes(track.total_bytes)
                        : track.downloaded_bytes > 0
                        ? formatBytes(track.downloaded_bytes)
                        : '--'}
                    </span>
                    {track.status === 'completed' && track.output_path && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.openTaskFolder(track).catch(() => {});
                        }}
                        title="Open folder"
                        className="p-1 text-[var(--vanta-muted)] hover:text-[var(--vanta-text)] rounded"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <ProgressDisplay task={track} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
