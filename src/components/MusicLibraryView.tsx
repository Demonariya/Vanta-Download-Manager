import React, { useState } from 'react';
import {
  Music,
  Disc,
  ListMusic,
  Sparkles,
  Download,
  Settings,
  FolderOpen,
  Check,
  Search,
  ExternalLink,
} from 'lucide-react';
import { DownloadTask } from '../types';
import { api } from '../services/api';
import { formatBytes } from '../utils/engine-parser';

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
  onOpenNewDownload,
}) => {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [audioBitrate, setAudioBitrate] = useState('320k');
  const [embedLyrics, setEmbedLyrics] = useState(true);

  const musicTasks = tasks.filter((t) => t.is_audio_only || t.engine === 'spotdl');

  const handleDownloadMusic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spotifyUrl.trim()) return;

    await api.createTask({
      url: spotifyUrl.trim(),
      title: 'Spotify Track / Album',
      engine: 'spotdl',
      format_id: 'bestaudio',
      ext: audioFormat,
      is_audio_only: true,
      audio_format: audioFormat,
      audio_bitrate: audioBitrate,
    });

    setSpotifyUrl('');
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
              placeholder="Paste Spotify track, album, or playlist URL..."
              value={spotifyUrl}
              onChange={(e) => setSpotifyUrl(e.target.value)}
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
              <option value="flac">FLAC (Lossless)</option>
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
              disabled={!spotifyUrl.trim()}
              className="px-3 sm:px-4 py-2 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors shrink-0 w-full sm:w-auto"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          </div>
        </form>

        {/* Quick Sample Presets */}
        <div className="flex items-center gap-2 pt-2 border-t border-[#21262d] flex-wrap">
          <span className="text-[11px] text-[#7d8590]">1-Click Music Presets:</span>
          {SAMPLE_TRACKS.map((track) => (
            <button
              key={track.title}
              onClick={() => {
                setSpotifyUrl(track.url);
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
          <h3 className="text-xs font-semibold text-white">Lossless & High-Fidelity Audio</h3>
          <p className="text-[11px] text-[#8b949e] mt-1">
            Exports pristine FLAC lossless audio or 320kbps MP3 streams with volume normalization.
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
          <h3 className="text-xs font-semibold text-white">Playlist Expansion</h3>
          <p className="text-[11px] text-[#8b949e] mt-1">
            Accepts full Spotify albums and user playlists, queuing individual tracks automatically.
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
                  <div className="w-10 h-10 rounded-md bg-[#161b22] border border-[#21262d] flex items-center justify-center shrink-0 text-xs font-mono text-[#3fb950]">
                    <Music className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-xs font-semibold text-white truncate">{track.title}</h4>
                    <div className="flex items-center gap-2 text-[11px] text-[#8b949e] mt-0.5 font-mono">
                      <span>{track.audio_format?.toUpperCase() || 'MP3'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{track.audio_bitrate || '320k'}</span>
                      {track.uploader && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{track.uploader}</span>
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
