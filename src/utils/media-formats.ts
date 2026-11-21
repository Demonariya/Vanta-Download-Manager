import { FormatOption } from '../types';
import { formatBytes } from './engine-parser';

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
    formatSelector: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]/best',
    detail: 'Up to 2160p video + best audio muxed via FFmpeg',
    height: 2160,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '1440',
    label: '2K Quad HD (1440p)',
    formatSelector: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]/best',
    detail: 'Up to 1440p video + best audio muxed via FFmpeg',
    height: 1440,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '1080',
    label: 'Full HD (1080p)',
    formatSelector: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    detail: '1080p video + best audio muxed via FFmpeg',
    height: 1080,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '720',
    label: 'HD (720p)',
    formatSelector: 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    detail: '720p video + best audio',
    height: 720,
    hasAudio: true,
    needsMux: true,
  },
  {
    id: '480',
    label: 'Standard (480p)',
    formatSelector: 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
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
  if (matched && (matched.is_video_only || matched.acodec === 'none')) {
    return `${trimmed}+bestaudio/best`;
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
    return STANDARD_PRESETS;
  }

  const byHeight = new Map<number, FormatOption>();
  for (const fmt of videoStreams) {
    const h = fmt.height || 0;
    const existing = byHeight.get(h);
    const fmtScore =
      (fmt.acodec && fmt.acodec !== 'none' ? 10 : 0) +
      (fmt.ext === 'mp4' ? 5 : 0) +
      ((fmt.fps || 0) >= 50 ? 2 : 0);
    const existingScore = existing
      ? (existing.acodec && existing.acodec !== 'none' ? 10 : 0) +
        (existing.ext === 'mp4' ? 5 : 0) +
        ((existing.fps || 0) >= 50 ? 2 : 0)
      : -1;
    if (!existing || fmtScore > existingScore) {
      byHeight.set(h, fmt);
    }
  }

  const realOptions: CuratedVideoOption[] = [STANDARD_PRESETS[0]];
  const sortedHeights = [...byHeight.keys()].sort((a, b) => b - a);

  for (const h of sortedHeights) {
    const fmt = byHeight.get(h)!;
    const isVideoOnly = fmt.is_video_only || !fmt.acodec || fmt.acodec === 'none';
    const selector = isVideoOnly ? `${fmt.format_id}+bestaudio/best` : fmt.format_id;
    const size = fmt.filesize || fmt.filesize_approx;
    const vcodecShort = (fmt.vcodec || '').split('.')[0].toUpperCase();
    const fpsPart = fmt.fps && fmt.fps > 30 ? ` ${Math.round(fmt.fps)}fps` : '';
    const sizePart = size ? ` · ~${formatBytes(size)}` : '';
    const audioPart = isVideoOnly ? '+Audio Mux' : '+Audio';

    realOptions.push({
      id: selector,
      label: `${h}p${fpsPart} (${vcodecShort || fmt.ext.toUpperCase()} ${audioPart})${sizePart}`,
      formatSelector: selector,
      detail: `${fmt.resolution || `${h}p`} · ${fmt.ext.toUpperCase()} · stream #${fmt.format_id}`,
      height: h,
      hasAudio: true,
      needsMux: Boolean(isVideoOnly),
      filesize: size,
    });
  }

  return realOptions;
}
