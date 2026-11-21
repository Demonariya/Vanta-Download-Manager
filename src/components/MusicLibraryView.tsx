import React, { useState } from 'react';
import { Music, Download, Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import { DownloadTask } from '../types';
import { api } from '../services/api';
import { formatBytes } from '../utils/engine-parser';
import { isSpotifyUrl } from '../utils/spotify';
import { ProgressDisplay } from './ProgressDisplay';

interface MusicLibraryViewProps {
  tasks: DownloadTask[];
  onOpenNewDownload: (url?: string) => void;
  onSelectTask?: (task: DownloadTask) => void;
}

const SAMPLE_TRACKS = [
  {
    title: 'SoundHelix Song 1 (CC MP3)',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    artist: 'SoundHelix',
  },
  {
    title: 'SoundHelix Song 2 (CC MP3)',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    artist: 'SoundHelix',
  },
];

export const MusicLibraryView: React.FC<MusicLibraryViewProps> = ({
  tasks,
  onSelectTask,
}) => {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [audioBitrate, setAudioBitrate] = useState('320k');
  const [isResolving, setIsResolving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const musicTasks = tasks.filter((t) => t.is_audio_only || t.engine === 'spotdl');

  const handleDownloadMusic = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = spotifyUrl.trim();
    if (!target || isResolving) return;

    setSubmitError(null);
    setIsResolving(true);

    try {
      const spotifyInput = isSpotifyUrl(target);
      if (spotifyInput) {
        const meta = await api.inspectUrl(target);
        const uploader =
          meta.artists && meta.artists.length > 0
            ? meta.artists.join(', ')
            : meta.owner || meta.uploader;

        await api.createTask({
          url: meta.url || target,
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
        });
      } else {
        const preset = SAMPLE_TRACKS.find((s) => s.url === target);
        await api.createTask({
          url: target,
          title: preset?.title,
          uploader: preset?.artist,
          format_id: 'bestaudio',
          ext: audioFormat,
          is_audio_only: true,
          audio_format: audioFormat,
          audio_bitrate: audioBitrate,
        });
      }

      setSpotifyUrl('');
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
            Resolve Spotify tracks/albums/playlists or direct audio streams with ID3 tags and artwork
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-[var(--vanta-muted)]">
          {musicTasks.length} audio item{musicTasks.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Music Ingestion Form */}
      <div className="p-4 rounded-xl border border-[var(--vanta-border)] bg-[var(--vanta-surface)] space-y-3">
        <form onSubmit={handleDownloadMusic} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <input
            type="text"
            placeholder="Paste Spotify track, album, playlist URL or direct MP3 link..."
            value={spotifyUrl}
            onChange={(e) => {
              setSpotifyUrl(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            className="flex-1 bg-[var(--vanta-surface-2)] border border-[var(--vanta-border)] focus:border-[var(--vanta-accent)] focus:outline-none rounded-lg text-xs py-2 px-3 text-[var(--vanta-text)] placeholder-[var(--vanta-muted)]"
          />

          <div className="flex items-center gap-2 shrink-0">
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
            </select>

            <button
              type="submit"
              disabled={!spotifyUrl.trim() || isResolving}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              {isResolving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>{isResolving ? 'Resolving...' : 'Download'}</span>
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
          {SAMPLE_TRACKS.map((track) => (
            <button
              key={track.title}
              type="button"
              onClick={() => {
                setSpotifyUrl(track.url);
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
              Paste a Spotify or direct audio URL above to extract tracks.
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
                        <span>{(track.audio_format || track.ext).toUpperCase()}</span>
                        {track.audio_bitrate && <span>· {track.audio_bitrate}</span>}
                        {track.uploader && <span className="truncate max-w-xs">· {track.uploader}</span>}
                        {track.album && <span className="truncate max-w-xs">· {track.album}</span>}
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
