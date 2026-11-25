import { FormatOption, MediaMetadata } from '../types';
import { formatBytes } from './engine-parser';
import { isSpotifyUrl } from './spotify';

export interface CuratedVideoOption {
  id: string;
  label: string;
  formatSelector: string;
  detail: string;
  height: number;
  hasAudio: boolean;
  needsMux: boolean;
  filesize?: number;
}

export interface VideoCodecSummary {
  resolution: string;
  vcodec: string;
  acodec: string;
  fps?: number;
  ext?: string;
}

const AUDIO_FILE_EXT_RE = /\.(mp3|m4a|flac|wav|opus|ogg|aac)(?:$|[?#])/i;
const AUDIO_EXT_SET = new Set(['mp3', 'm4a', 'flac', 'wav', 'opus', 'ogg', 'aac']);

/**
 * Automatically determines whether an inspected URL/metadata payload represents
 * music/audio or video so the unified New Download UI switches controls dynamically.
 */
export function detectInspectedMediaKind(
  metadata: MediaMetadata | null,
  url: string
): 'audio' | 'video' {
  const trimmedUrl = (url || '').trim();
  if (metadata?.extractor === 'spotdl' || isSpotifyUrl(trimmedUrl)) {
    return 'audio';
  }

  const formats = metadata?.formats || [];
  if (formats.length > 0) {
    const hasVideoStream = formats.some(
      (f) =>
        !f.is_audio_only &&
        ((Boolean(f.vcodec) && f.vcodec !== 'none') || (f.height || 0) > 0)
    );
    const hasAudioStream = formats.some(
      (f) =>
        Boolean(f.is_audio_only) ||
        (Boolean(f.acodec) && f.acodec !== 'none') ||
        AUDIO_EXT_SET.has((f.ext || '').toLowerCase())
    );
    if (!hasVideoStream && hasAudioStream) {
      return 'audio';
    }
  }

  if (AUDIO_FILE_EXT_RE.test(trimmedUrl)) {
    return 'audio';
  }

  return 'video';
}

export function detectMediaProvider(url: string): string {
  const trimmed = (url || '').trim();
  if (isSpotifyUrl(trimmed)) return 'Spotify';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Media Link';
    if (!parsed.hostname || parsed.username || parsed.password) return 'Media Link';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (matches('youtube.com') || host === 'youtu.be' || matches('youtube-nocookie.com')) return 'YouTube';
    if (matches('vimeo.com')) return 'Vimeo';
    if (matches('soundcloud.com') || matches('snd.sc')) return 'SoundCloud';
    if (matches('dailymotion.com') || host === 'dai.ly') return 'Dailymotion';
    if (matches('twitch.tv') || matches('twitchcdn.net')) return 'Twitch';
    if (matches('facebook.com') || matches('fb.watch')) return 'Facebook';
    if (matches('instagram.com')) return 'Instagram';
    if (matches('tiktok.com')) return 'TikTok';
    if (matches('x.com') || matches('twitter.com')) return 'X';
    if (matches('reddit.com') || matches('redd.it')) return 'Reddit';
    if (matches('bandcamp.com')) return 'Bandcamp';
    if (matches('mixcloud.com')) return 'Mixcloud';

    const ext = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (ext && AUDIO_EXT_SET.has(ext)) return 'Direct Audio';
    if (ext && /^(mp4|m4v|mov|mkv|webm|avi|flv|mpeg|mpg|ts|m3u8|mpd)$/.test(ext)) return 'Direct Video';
    return 'Media Link';
  } catch {
    return 'Media Link';
  }
}

export function formatMediaRoutingLabel(
  metadata: MediaMetadata | null,
  mediaKind: 'audio' | 'video',
  url: string
): string {
  const isSpotify = metadata?.extractor === 'spotdl' || isSpotifyUrl((url || '').trim());
  if (isSpotify) {
    const kind = metadata?.content_type
      ? metadata.content_type.charAt(0).toUpperCase() + metadata.content_type.slice(1)
      : 'Music';
    return `Spotify ${kind} · spotDL`;
  }
  const provider = detectMediaProvider(url);
  const mode = mediaKind === 'audio' ? 'Audio' : 'Video';
  return `${provider} · ${mode} · yt-dlp`;
}

export function summarizeVideoOptionCodecs(
  formats: FormatOption[] = [],
  selectedFormatId: string
): VideoCodecSummary | null {
  const videoStreams = formats.filter(
    (f) => !f.is_audio_only && f.vcodec && f.vcodec !== 'none'
  );
  if (videoStreams.length === 0) return null;

  // Resolve the primary stream ID from selectors such as "137+bestaudio/best".
  // Ignore slash fallbacks so the codec summary reflects the pinned quality choice.
  const primarySelector = (selectedFormatId || '').split('/')[0];
  const baseId = primarySelector.split('+')[0].trim();
  let matched =
    videoStreams.find((f) => f.format_id === baseId) ||
    [...videoStreams].sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (!matched) return null;

  const bestAudio = formats
    .filter((f) => f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  const vcodec = (matched.vcodec || 'auto').split('.')[0].toUpperCase();
  const acodecRaw =
    matched.acodec && matched.acodec !== 'none'
      ? matched.acodec
      : bestAudio?.acodec || 'auto';
  const acodec = acodecRaw.split('.')[0].toUpperCase();
  const resolution =
    matched.resolution || (matched.height ? `${matched.height}p` : 'Adaptive');

  return {
    resolution,
    vcodec,
    acodec,
    fps: matched.fps,
    ext: matched.ext?.toUpperCase(),
  };
}

const STANDARD_PRESETS: CuratedVideoOption[] = [
  {
    id: 'best',
    label: 'Best Available (Auto Mux Video + Audio)',
    formatSelector: 'bestvideo+bestaudio/best',
    detail: 'Highest available resolution merged cleanly with best audio stream',
    height: 9999,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '2160',
    label: '4K Ultra HD (2160p)',
    formatSelector: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
    detail: 'Up to 2160p video + best audio muxed via FFmpeg',
    height: 2160,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '1440',
    label: '2K Quad HD (1440p)',
    formatSelector: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]',
    detail: 'Up to 1440p video + best audio muxed via FFmpeg',
    height: 1440,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '1080',
    label: 'Full HD (1080p)',
    formatSelector: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    detail: '1080p video + best audio muxed via FFmpeg',
    height: 1080,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '720',
    label: 'HD (720p)',
    formatSelector: 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    detail: '720p video + best audio',
    height: 720,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '480',
    label: 'Standard (480p)',
    formatSelector: 'bestvideo[height<=480]+bestaudio/best[height<=480]',
    detail: '480p compact video + audio',
    height: 480,
    hasAudio: true,
    needsMux: true,
  },
];

/**
 * Ensures any selected video-only stream automatically pairs with bestaudio so
 * video downloads never accidentally output silent files unless explicitly requested.
 */
export function resolveVideoFormatSelector(
  formatId: string,
  availableFormats: FormatOption[] = []
): string {
  const trimmed = (formatId || 'best').trim();
  if (!trimmed || trimmed === 'best') {
    return 'bestvideo+bestaudio/best';
  }
  if (trimmed.includes('+') || trimmed.includes('/')) {
    return trimmed;
  }
  const matched = availableFormats.find((f) => f.format_id === trimmed);
  if (matched) {
    const hasVideo = !matched.is_audio_only &&
      ((Boolean(matched.vcodec) && matched.vcodec !== 'none') || (matched.height || 0) > 0);
    const hasAudio = !matched.is_video_only &&
      Boolean(matched.acodec) && matched.acodec !== 'none';
    if (hasVideo && !hasAudio) {
      return trimmed + '+bestaudio/best';
    }
  }
  return trimmed;
}

/**
 * Builds truthful, human-readable video quality options from real inspected formats.
 */
export function buildCuratedVideoOptions(formats: FormatOption[] = []): CuratedVideoOption[] {
  const videoStreams = formats.filter(
    (f) => !f.is_audio_only && f.vcodec && f.vcodec !== 'none' && (f.height || 0) > 0
  );

  if (videoStreams.length === 0) {
    // Do not advertise fixed resolutions when the extractor did not report
    // any concrete video streams. The adaptive selector remains valid.
    return [STANDARD_PRESETS[0]];
  }

  const byHeight = new Map<number, FormatOption>();
  for (const fmt of videoStreams) {
    const h = fmt.height || 0;
    const existing = byHeight.get(h);
    // Prefer the highest-bitrate stream at each resolution. The previous
    // codec/container-only score could select a low-bitrate muxed rendition
    // over a substantially better video-only stream at the same height.
    const fmtScore = [
      fmt.tbr || 0,
      fmt.fps || 0,
      fmt.acodec && fmt.acodec !== 'none' ? 1 : 0,
      fmt.ext === 'mp4' ? 1 : 0,
    ];
    const existingScore = existing
      ? [
          existing.tbr || 0,
          existing.fps || 0,
          existing.acodec && existing.acodec !== 'none' ? 1 : 0,
          existing.ext === 'mp4' ? 1 : 0,
        ]
      : [];
    const isBetter = !existing || fmtScore.some(
      (value, index) => value !== existingScore[index] &&
        value > existingScore[index] &&
        fmtScore.slice(0, index).every((previous, previousIndex) =>
          previous === existingScore[previousIndex]
        )
    );
    if (isBetter) {
      byHeight.set(h, fmt);
    }
  }

  const realOptions: CuratedVideoOption[] = [STANDARD_PRESETS[0]];
  const sortedHeights = [...byHeight.keys()].sort((a, b) => b - a);

  for (const h of sortedHeights) {
    const fmt = byHeight.get(h)!;
    const isVideoOnly = fmt.is_video_only || !fmt.acodec || fmt.acodec === 'none';
    const hasMuxedAudio = Boolean(fmt.acodec && fmt.acodec !== 'none' && !fmt.is_video_only);
    // Pin the choice to the exact stream discovered during inspection instead
    // of asking yt-dlp to re-rank every format at download time. Video-only
    // streams are paired with the best available audio stream.
    const selector = hasMuxedAudio
      ? `${fmt.format_id}/best[height<=${h}]`
      : `${fmt.format_id}+bestaudio/best[height<=${h}]`;
    const size = fmt.filesize || fmt.filesize_approx;
    const vcodecShort = (fmt.vcodec || '').split('.')[0].toUpperCase();
    const fpsPart = fmt.fps && fmt.fps > 30 ? ` ${Math.round(fmt.fps)}fps` : '';
    const sizePart = size ? ` · ~${formatBytes(size)}` : '';
    const audioPart = isVideoOnly ? '+Audio Mux' : '+Audio';

    realOptions.push({
      id: selector,
      label: `Up to ${h}p${fpsPart} (${vcodecShort || fmt.ext.toUpperCase()} ${audioPart})${sizePart}`,
      formatSelector: selector,
      detail: `${fmt.resolution || `${h}p`} · ${fmt.ext.toUpperCase()} · pinned detected stream #${fmt.format_id}`,
      height: h,
      hasAudio: true,
      needsMux: Boolean(isVideoOnly),
      filesize: size,
    });
  }

  return realOptions;
}
