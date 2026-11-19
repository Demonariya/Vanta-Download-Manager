import React, { useState } from 'react';
import {
  Music,
  Disc,
  ListMusic,
  Sparkles,
  Download,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { api } from '../services/api';
import { formatBytes } from '../utils/engine-parser';
import { isSpotifyUrl } from '../utils/spotify';

interface MusicLibraryViewProps {
  tasks: DownloadTask[];
  onOpenNewDownload: (url?: string) => void;
}

const SAMPLE_TRACKS = [
  {
    title: 'Royalty-Free Synthwave CC',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    artist: 'SoundHelix',
    genre: 'Synthwave',
  },
  {
    title: 'Ambient Acoustic Chill',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    artist: 'SoundHelix Collective',
    genre: 'Acoustic',
  },
  {
    title: 'Lo-Fi Focus Beat',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    artist: 'Open Beat Laboratory',
    genre: 'Lo-Fi',
  },
];

export const MusicLibraryView: React.FC<MusicLibraryViewProps> = ({
  tasks,
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
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div>
          <div className="flex items-center gap-2">
            <Music className="w-5 h-5 text-[#3fb950]" />
            <h1 className="text-base font-bold text-white">spotDL Music Workflow</h1>
          </div>
          <p className="text-xs text-[#8b949e] mt-1">
            Dedicated music extraction engine with ID3 tagging, high-res artwork, and lyrics sync
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-[#3fb950] bg-[#238636]/15 px-2.5 py-1 rounded-md">
            Engine: spotDL Active
          </span>
        </div>
      </div>

      {/* spotDL Ingestion Bar */}
      <div className="p-4 sm:p-5 rounded-xl border border-[#21262d] bg-[#12151a] space-y-4">
        <h2 className="text-xs font-semibold text-[#c9d1d9] uppercase tracking-wider font-mono">
          Download Track, Album, or Playlist
        </h2>

        <form onSubmit={handleDownloadMusic} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
          <div className="relative flex-1 w-full min-w-0">
            <input
              type="text"
              placeholder="Paste Spotify track, album, playlist, or artist URL..."
              value={spotifyUrl}
              onChange={(e) => {
                setSpotifyUrl(e.target.value);
                if (submitError) setSubmitError(null);
              }}
              className="w-full bg-[#161b22] border border-[#30363d] focus:border-[#3fb950] focus:outline-none rounded-lg text-xs py-2 px-3 text-[#e6edf3] placeholder-[#6e7681]"
            />
          </div>

          <div className="grid grid-cols-3 gap-2 w-full sm:w-auto sm:flex sm:items-center">
            <select
              value={audioFormat}
              onChange={(e) => setAudioFormat(e.target.value)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3] w-full sm:w-auto"
            >
              <option value="mp3">MP3</option>
              <option value="flac">FLAC (Container)</option>
              <option value="m4a">M4A</option>
              <option value="opus">OPUS</option>
            </select>

            <select
              value={audioBitrate}
              onChange={(e) => setAudioBitrate(e.target.value)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3] w-full sm:w-auto"
            >
              <option value="320k">320 kbps</option>
              <option value="256k">256 kbps</option>
              <option value="192k">192 kbps</option>
            </select>

            <button
              type="submit"
              disabled={!spotifyUrl.trim() || isResolving}
              className="px-3 sm:px-4 py-2 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors shrink-0 w-full sm:w-auto"
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
          <div className="p-3 rounded-lg border border-[#f85149]/40 bg-[#da3633]/15 text-xs text-[#f85149] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{submitError}</span>
          </div>
        )}

        {/* Quick Sample Presets */}
        <div className="flex items-center gap-2 pt-2 border-t border-[#21262d] flex-wrap">
          <span className="text-[11px] text-[#7d8590]">1-Click Music Presets:</span>
          {SAMPLE_TRACKS.map((track) => (
            <button
              key={track.title}
              type="button"
              onClick={() => {
                setSpotifyUrl(track.url);
                if (submitError) setSubmitError(null);
              }}
              className="px-2.5 py-1 text-[11px] bg-[#161b22] hover:bg-[#21262d] text-[#3fb950] border border-[#30363d] rounded-md transition-colors"
            >
              {track.title} ({track.genre})
            </button>
          ))}
        </div>
      </div>

      {/* Music Features Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <Disc className="w-5 h-5 text-[#58a6ff] mb-2" />
          <h3 className="text-xs font-semibold text-white">High-Bitrate Audio Export</h3>
          <p className="text-[11px] text-[#8b949e] mt-1">
            Matches Spotify metadata to public audio streams and exports MP3 (320k), M4A, OPUS, or FLAC containers.
          </p>
        </div>

        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <Sparkles className="w-5 h-5 text-[#a371f7] mb-2" />
          <h3 className="text-xs font-semibold text-white">Automatic Tag & Artwork Embedding</h3>
          <p className="text-[11px] text-[#8b949e] mt-1">
            Injects verified ID3v2 tags including artist, album, track number, year, and cover art.
          </p>
        </div>

        <div className="p-4 rounded-xl border border-[#21262d] bg-[#12151a]">
          <ListMusic className="w-5 h-5 text-[#3fb950] mb-2" />
          <h3 className="text-xs font-semibold text-white">Collection & Tracklist Resolution</h3>
          <p className="text-[11px] text-[#8b949e] mt-1">
            Resolves verified titles, artists, artwork, and tracklists for Spotify tracks, albums, playlists, and artists.
          </p>
        </div>
      </div>

      {/* Music History / Library List */}
      <div className="p-5 rounded-xl border border-[#21262d] bg-[#12151a]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Downloaded Music Tracks</h2>
          <span className="text-xs font-mono text-[#8b949e]">
            {musicTasks.length} audio track{musicTasks.length === 1 ? '' : 's'}
          </span>
        </div>

        {musicTasks.length === 0 ? (
          <div className="py-12 text-center border border-dashed border-[#21262d] rounded-lg">
            <Music className="w-8 h-8 text-[#484f58] mx-auto mb-2" />
            <p className="text-xs font-medium text-[#c9d1d9]">No music downloads yet</p>
            <p className="text-[11px] text-[#8b949e] mt-1">
              Paste a music link above or pick a sample preset to download audio tracks
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {musicTasks.map((track) => (
              <div key={track.id} className="py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {track.thumbnail ? (
                    <img
                      src={track.thumbnail}
                      alt={track.title}
                      referrerPolicy="no-referrer"
                      className="w-10 h-10 rounded-md object-cover bg-[#161b22] border border-[#21262d] shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-[#161b22] border border-[#21262d] flex items-center justify-center shrink-0 text-xs font-mono text-[#3fb950]">
                      <Music className="w-4 h-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h4 className="text-xs font-semibold text-white truncate">{track.title}</h4>
                      {track.content_type && (
                        <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#238636]/15 text-[#3fb950] shrink-0">
                          {track.content_type}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8b949e] mt-0.5 font-mono">
                      <span>{track.audio_format?.toUpperCase() || 'MP3'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{track.audio_bitrate || '320k'}</span>
                      {track.uploader && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[180px]">{track.uploader}</span>
                        </>
                      )}
                      {track.album && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[180px] text-[#7d8590]">{track.album}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 text-right">
                  <div className="font-mono text-xs text-[#c9d1d9]">
                    {track.downloaded_bytes > 0 ? formatBytes(track.downloaded_bytes) : '--'}
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                      track.status === 'completed'
                        ? 'bg-[#238636]/15 text-[#3fb950]'
                        : track.status === 'failed'
                        ? 'bg-[#da3633]/15 text-[#f85149]'
                        : 'bg-[#1f6feb]/15 text-[#58a6ff]'
                    }`}
                  >
                    {track.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
