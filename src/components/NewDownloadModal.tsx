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
} from 'lucide-react';
import { MediaMetadata, FormatOption, TaskPriority } from '../types';
import { api } from '../services/api';
import { formatBytes } from '../utils/engine-parser';

interface NewDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string;
  onTaskCreated: () => void;
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
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [batchUrls, setBatchUrls] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Selected download settings
  const [selectedTab, setSelectedTab] = useState<'video' | 'audio' | 'advanced'>('video');
  const [selectedFormatId, setSelectedFormatId] = useState<string>('best');
  const [selectedResolution, setSelectedResolution] = useState<string>('best');
  const [selectedContainer, setSelectedContainer] = useState<string>('mp4');
  const [selectedAudioFormat, setSelectedAudioFormat] = useState<string>('mp3');
  const [selectedAudioBitrate, setSelectedAudioBitrate] = useState<string>('320k');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (initialUrl && initialUrl !== url) {
      setUrl(initialUrl);
      inspect(initialUrl);
    }
  }, [initialUrl]);

  if (!isOpen) return null;

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
    if (mode === 'batch') {
      const lines = batchUrls
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => Boolean(l));

      if (lines.length === 0) return;
      setIsSubmitting(true);

      for (const line of lines) {
        await api.createTask({
          url: line,
          title: `Batch Item: ${line.substring(0, 40)}`,
          format_id: selectedTab === 'audio' ? 'bestaudio' : 'best',
          ext: selectedTab === 'audio' ? selectedAudioFormat : 'mp4',
          is_audio_only: selectedTab === 'audio',
          audio_format: selectedAudioFormat,
          audio_bitrate: selectedAudioBitrate,
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

          {/* Extraction Error Notice */}
          {extractError && (
            <div className="p-3 bg-[#da3633]/15 border border-[#f85149]/40 rounded-lg text-xs text-[#f85149] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{extractError}</span>
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
                    <option value="flac">FLAC (Lossless Studio Quality)</option>
                    <option value="m4a">M4A / AAC (Apple / High Efficiency)</option>
                    <option value="opus">OPUS (Modern Low-Latency)</option>
                    <option value="wav">WAV (Uncompressed PCM)</option>
                  </select>
                </div>

                {/* Bitrate */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-[#8b949e]">Bitrate Quality</label>
                  <select
                    value={selectedAudioBitrate}
                    onChange={(e) => setSelectedAudioBitrate(e.target.value)}
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg text-xs p-2 text-[#e6edf3]"
                  >
                    <option value="320k">320 kbps (High Fidelity)</option>
                    <option value="256k">256 kbps (Standard High)</option>
                    <option value="192k">192 kbps (Medium)</option>
                    <option value="128k">128 kbps (Compact)</option>
                  </select>
                </div>
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
