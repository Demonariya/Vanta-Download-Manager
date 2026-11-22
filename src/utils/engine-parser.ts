import { EngineType } from '../types';
import { isSpotifyUrl, tryParseSpotifyInput } from './spotify';

export interface ParsedProgress {
  percentage: number;
  percentageKnown: boolean;
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  speedStr: string;
  etaStr: string;
  phase: 'connecting' | 'downloading' | 'muxing' | 'processing' | 'verifying' | string;
  phaseLabel?: string;
  fragmentIndex?: number;
  fragmentCount?: number;
  playlistItemIndex?: number;
  playlistItemCount?: number;
}

export interface BatchUrlValidationResult {
  valid: string[];
  invalid: Array<{ line: number; input: string; reason: string }>;
  duplicatesRemoved: number;
}

export interface RawThumbnailCandidate {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  resolution?: unknown;
  preference?: unknown;
  id?: unknown;
}

export interface ParsedBeforeDlMeta {
  id?: string;
  title?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
}

const STREAMING_SITE_HOST_HINTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'twitch.tv',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'x.com',
  'twitter.com',
  'dailymotion.com',
  'soundcloud.com',
  'bandcamp.com',
  'bilibili.com',
  'reddit.com',
  'rumble.com',
  'kick.com',
];

export const UNSUPPORTED_NON_MEDIA_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'tbz2', 'txz',
  'iso', 'img', 'dmg', 'exe', 'msi', 'msix', 'appimage', 'deb', 'rpm', 'apk', 'cab', 'pkg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf', 'odt', 'epub', 'mobi',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico', 'tiff',
  'bin', 'dat', 'wasm', 'dll', 'so', 'dylib', 'torrent', 'json', 'xml', 'yaml', 'yml', 'md', 'html', 'htm', 'css', 'js',
]);

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_])/g;

export function stripAnsiCodes(input: string): string {
  if (!input) return '';
  return input.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Incremental line parser for child-process stdout/stderr chunks.
 * Splits on \r\n, \n, and standalone \r while preserving incomplete tails across chunks
 * until another delimiter arrives or flush() is called on stream close.
 */
export class StreamingLineParser {
  private buffer = '';

  public push(chunk: string | Buffer): string[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!text) return [];
    this.buffer += stripAnsiCodes(text);

    const lines: string[] = [];
    let start = 0;

    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (ch === '\n' || ch === '\r') {
        // Defer handling a trailing '\r' at the end of chunk in case next chunk starts with '\n'
        if (ch === '\r' && i === this.buffer.length - 1) {
          break;
        }
        const segment = this.buffer.slice(start, i);
        if (segment.trim().length > 0) {
          lines.push(segment);
        }
        if (ch === '\r' && this.buffer[i + 1] === '\n') {
          i += 1;
        }
        start = i + 1;
      }
    }

    this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;
    return lines;
  }

  public flush(): string[] {
    if (!this.buffer) return [];
    const rest = this.buffer.replace(/[\r\n]+/g, '').trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

export function isValidThumbnailUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) return false;
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'na' ||
    lower === 'n/a' ||
    lower === 'none' ||
    lower === 'null' ||
    lower === 'undefined'
  ) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (!parsed.hostname || parsed.hostname.startsWith('.')) {
      return false;
    }
    // Reject YouTube storyboard / sprite sheet URLs which are not video thumbnails
    const fullLower = parsed.toString().toLowerCase();
    if (fullLower.includes('/sb/') || fullLower.includes('storyboard')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseDimensionPair(resolution: unknown): { width: number; height: number } {
  if (typeof resolution !== 'string') return { width: 0, height: 0 };
  const match = resolution.trim().match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return { width: 0, height: 0 };
  return {
    width: Number.parseInt(match[1], 10) || 0,
    height: Number.parseInt(match[2], 10) || 0,
  };
}

function scoreThumbnailCandidate(candidate: RawThumbnailCandidate, urlStr: string): number {
  let width = typeof candidate.width === 'number' && candidate.width > 0 ? candidate.width : 0;
  let height = typeof candidate.height === 'number' && candidate.height > 0 ? candidate.height : 0;
  if ((!width || !height) && candidate.resolution) {
    const parsed = parseDimensionPair(candidate.resolution);
    if (!width) width = parsed.width;
    if (!height) height = parsed.height;
  }

  let areaScore = 0;
  if (width > 0 && height > 0) {
    areaScore = width * height;
  } else if (width > 0) {
    areaScore = width * Math.round((width * 9) / 16);
  } else if (height > 0) {
    areaScore = Math.round((height * 16) / 9) * height;
  } else {
    const lower = urlStr.toLowerCase();
    if (lower.includes('maxresdefault')) areaScore = 1280 * 720;
    else if (lower.includes('sddefault')) areaScore = 640 * 480;
    else if (lower.includes('hq720')) areaScore = 1280 * 720;
    else if (lower.includes('hqdefault')) areaScore = 480 * 360;
    else if (lower.includes('mqdefault')) areaScore = 320 * 180;
    else if (lower.includes('/default.')) areaScore = 120 * 90;
    else areaScore = 1000;
  }

  const prefBoost =
    typeof candidate.preference === 'number' && Number.isFinite(candidate.preference)
      ? candidate.preference * 100
      : 0;
  const formatBoost = /\.(jpe?g|png|webp)(?:$|[?#])/i.test(urlStr) ? 50 : 0;
  return areaScore + prefBoost + formatBoost;
}

/**
 * Selects the highest-quality valid HTTP/HTTPS thumbnail URL from yt-dlp / Spotify metadata.
 * Never blindly picks thumbnails[0] (often lowest resolution) and rejects invalid/storyboard URLs.
 */
export function selectBestThumbnail(raw: any): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const candidates: Array<{ url: string; score: number }> = [];
  const pushCandidate = (cand: RawThumbnailCandidate, bonus = 0) => {
    if (!isValidThumbnailUrl(cand?.url)) return;
    const cleanUrl = cand.url.trim();
    candidates.push({
      url: cleanUrl,
      score: scoreThumbnailCandidate(cand, cleanUrl) + bonus,
    });
  };

  if (Array.isArray(raw.thumbnails)) {
    for (const item of raw.thumbnails) {
      if (item && typeof item === 'object') {
        pushCandidate(item as RawThumbnailCandidate);
      } else if (typeof item === 'string') {
        pushCandidate({ url: item });
      }
    }
  }

  if (isValidThumbnailUrl(raw.album_artwork)) {
    pushCandidate({ url: raw.album_artwork }, 200);
  }

  if (isValidThumbnailUrl(raw.thumbnail)) {
    // Only boost raw.thumbnail modestly so higher-res entries in thumbnails[] still win
    pushCandidate({ url: raw.thumbnail }, 25);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

export function parseBytes(str: string | undefined | null): number {
  if (!str) return 0;
  const cleaned = stripAnsiCodes(str).trim();
  if (
    !cleaned ||
    cleaned.toUpperCase() === 'NA' ||
    cleaned === 'N/A' ||
    cleaned.toLowerCase() === 'none' ||
    cleaned.toLowerCase() === 'unknown' ||
    cleaned.toLowerCase().startsWith('unknown')
  ) {
    return 0;
  }
  const match = cleaned.match(/^~?\s*([\d.]+)\s*([a-zA-Z/]+)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  if (isNaN(value) || value < 0) return 0;

  const unit = (match[2] || 'B').replace('/S', '').replace('/s', '').toUpperCase();

  switch (unit) {
    case 'B':
      return Math.round(value);
    case 'KB':
    case 'KIB':
      return Math.round(value * 1024);
    case 'MB':
    case 'MIB':
      return Math.round(value * 1024 * 1024);
    case 'GB':
    case 'GIB':
      return Math.round(value * 1024 * 1024 * 1024);
    case 'TB':
    case 'TIB':
      return Math.round(value * 1024 * 1024 * 1024 * 1024);
    default:
      return Math.round(value);
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const formatted = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${formatted} ${units[i]}`;
}

export function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Returns the unsupported non-media file extension if the URL targets a generic archive,
 * installer, document, image, or binary rather than audio/video media.
 */
export function getUnsupportedNonMediaExtension(rawUrl: string): string | null {
  try {
    const parsed = new URL((rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    const isKnownStreamingHost = STREAMING_SITE_HOST_HINTS.some(
      (h) => host === h || host.endsWith(`.${h}`)
    );
    if (isKnownStreamingHost || isSpotifyUrl(rawUrl)) {
      return null;
    }
    const pathLower = parsed.pathname.toLowerCase();
    const lastSegment = pathLower.split('/').filter(Boolean).pop() || '';
    const dotIdx = lastSegment.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx < lastSegment.length - 1) {
      const ext = lastSegment.slice(dotIdx + 1);
      if (UNSUPPORTED_NON_MEDIA_EXTENSIONS.has(ext)) {
        return ext;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function isUnsupportedGenericFileUrl(url: string): boolean {
  return getUnsupportedNonMediaExtension(url) !== null;
}

/**
 * Validates and classifies a media URL strictly for VANTA's two engines: yt-dlp and spotDL.
 */
export function validateMediaUrl(
  rawUrl: string
): { valid: true; normalized: string; engine: EngineType } | { valid: false; error: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Please enter a valid video or music URL.' };
  }
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return { valid: false, error: 'Invalid URL: remove spaces or control characters.' };
  }
  if (trimmed.startsWith('-')) {
    return { valid: false, error: 'Invalid URL: must start with http://, https://, or spotify:.' };
  }

  const spotifyParsed = tryParseSpotifyInput(trimmed);
  if (spotifyParsed) {
    if (spotifyParsed.kind === 'invalid') {
      return { valid: false, error: spotifyParsed.error };
    }
    return { valid: true, normalized: trimmed, engine: 'spotdl' };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        error: 'Unsupported URL scheme. Only http://, https://, and spotify: media links are supported.',
      };
    }
    if (!parsed.hostname || parsed.hostname.startsWith('.')) {
      return { valid: false, error: 'Invalid URL host. Please check the URL and try again.' };
    }
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format. Include http://, https://, or a valid spotify: URI.',
    };
  }

  const unsupportedExt = getUnsupportedNonMediaExtension(trimmed);
  if (unsupportedExt) {
    return {
      valid: false,
      error: `VANTA downloads music and video only (yt-dlp / spotDL). Generic ".${unsupportedExt}" files are not supported.`,
    };
  }

  return { valid: true, normalized: trimmed, engine: 'yt-dlp' };
}

/**
 * Classifies a supported media URL into its execution engine (spotDL or yt-dlp).
 */
export function determineEngineForUrl(url: string): EngineType {
  if (isSpotifyUrl(url)) {
    return 'spotdl';
  }
  return 'yt-dlp';
}

export function isPlaylistCandidateUrl(url: string): boolean {
  const trimmed = (url || '').trim();
  if (!trimmed || isUnsupportedGenericFileUrl(trimmed)) return false;
  if (isSpotifyUrl(trimmed)) {
    const parsed = tryParseSpotifyInput(trimmed);
    return Boolean(
      parsed &&
        parsed.kind === 'resource' &&
        (parsed.type === 'playlist' || parsed.type === 'album' || parsed.type === 'artist')
    );
  }
  try {
    const parsed = new URL(trimmed);
    const listParam = parsed.searchParams.get('list');
    if (listParam && listParam.trim().length > 0) return true;
    const lowerPath = parsed.pathname.toLowerCase();
    return (
      lowerPath.includes('/playlist') ||
      lowerPath.includes('/sets/') ||
      lowerPath.includes('/album/')
    );
  } catch {
    return false;
  }
}

export function formatYtDlpPlaylistItems(indices: number[]): string {
  const cleaned: number[] = [];
  const seen = new Set<number>();
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx > 0 && !seen.has(idx)) {
      seen.add(idx);
      cleaned.push(idx);
    }
  }
  return cleaned.join(',');
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 200);
}

export function parseBatchUrls(rawText: string): BatchUrlValidationResult {
  const lines = (rawText || '').split(/\r?\n/);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: Array<{ line: number; input: string; reason: string }> = [];
  let duplicatesRemoved = 0;

  lines.forEach((rawLine, index) => {
    const lineNum = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const checked = validateMediaUrl(trimmed);
    if (!checked.valid) {
      invalid.push({ line: lineNum, input: trimmed, reason: checked.error });
      return;
    }

    if (seen.has(trimmed)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(trimmed);
    valid.push(trimmed);
  });

  return { valid, invalid, duplicatesRemoved };
}

function normalizeEta(raw: string | undefined): string {
  const cleaned = (raw || '').trim();
  if (!cleaned || cleaned === 'NA' || cleaned === 'N/A' || /^unknown$/i.test(cleaned)) {
    return '--';
  }
  return cleaned;
}

export function parseVantaBeforeDlMeta(line: string): ParsedBeforeDlMeta | null {
  const cleaned = stripAnsiCodes(line).trim();
  if (!cleaned.startsWith('VANTA_META:')) return null;
  const payload = cleaned.slice('VANTA_META:'.length);
  const [idRaw, titleRaw, uploaderRaw, durRaw, thumbRaw] = payload.split('\t');
  const cleanField = (val: string | undefined): string | undefined => {
    const s = (val || '').trim();
    if (!s || s === 'NA' || s === 'N/A' || s === 'None') return undefined;
    return s;
  };
  const durNum = durRaw ? Number.parseFloat(durRaw.trim()) : NaN;
  return {
    id: cleanField(idRaw),
    title: cleanField(titleRaw),
    uploader: cleanField(uploaderRaw),
    duration: Number.isFinite(durNum) && durNum > 0 ? Math.round(durNum) : undefined,
    thumbnail: isValidThumbnailUrl(thumbRaw?.trim()) ? thumbRaw.trim() : undefined,
  };
}

export function parseYtdlpProgress(line: string): Partial<ParsedProgress> | null {
  const trimmed = stripAnsiCodes(line).trim();
  if (!trimmed) return null;

  // 1. Structured custom progress format:
  // 7 fields: %percent%|%downloaded%|%total%|%total_estimate%|%speed%|%eta%|%status%
  // 6 fields: %percent%|%downloaded%|%total%|%speed%|%eta%|%status%
  if (trimmed.includes('|') && !trimmed.startsWith('[')) {
    const parts = trimmed.split('|');
    if (parts.length >= 4) {
      const hasEstimateField = parts.length >= 7;
      const pctRaw = parts[0].replace('%', '').trim();
      const pct = parseFloat(pctRaw);
      const downloaded = parseBytes(parts[1]);
      const exactTotal = parseBytes(parts[2]);
      const estimatedTotal = hasEstimateField ? parseBytes(parts[3]) : 0;
      const total = exactTotal > 0 ? exactTotal : estimatedTotal;
      const speedIdx = hasEstimateField ? 4 : 3;
      const etaIdx = hasEstimateField ? 5 : 4;
      const statusIdx = hasEstimateField ? 6 : 5;

      const speedRaw = (parts[speedIdx] || '').trim();
      const speedBytes = parseBytes(speedRaw);
      const etaStr = normalizeEta(parts[etaIdx]);
      const rawStatus = (parts[statusIdx] || 'downloading').trim().toLowerCase();

      const validNumericPct =
        Number.isFinite(pct) &&
        pctRaw !== 'N/A' &&
        pctRaw !== 'NA' &&
        !/^unknown$/i.test(pctRaw);
      const percentageKnown = total > 0 || validNumericPct;
      const effectiveDownloaded =
        rawStatus === 'finished' && total > 0 ? Math.max(downloaded, total) : downloaded;
      const computedPct =
        total > 0
          ? Math.min(100, Math.max(0, (effectiveDownloaded / total) * 100))
          : validNumericPct
          ? Math.min(100, Math.max(0, pct))
          : 0;

      const phase =
        rawStatus === 'processing' || rawStatus === 'postprocessing'
          ? 'processing'
          : rawStatus === 'muxing'
          ? 'muxing'
          : 'downloading';

      return {
        percentage: computedPct,
        percentageKnown,
        downloadedBytes: effectiveDownloaded,
        totalBytes: total,
        speedBytesPerSec: phase === 'downloading' ? speedBytes : 0,
        speedStr: phase === 'downloading' && speedBytes > 0 ? `${formatBytes(speedBytes)}/s` : '0 B/s',
        etaStr: phase === 'downloading' ? etaStr : '--',
        phase,
        phaseLabel:
          rawStatus === 'finished'
            ? 'Finishing stream...'
            : percentageKnown
            ? 'Downloading media stream'
            : 'Downloading stream (size unknown)',
      };
    }
  }

  // 2. Fragment indicator extraction (can appear on standard [download] lines)
  const fragMatch = trimmed.match(/\(frag\s+(\d+)\s*\/\s*(\d+)\)/i);
  const fragmentIndex = fragMatch ? Number.parseInt(fragMatch[1], 10) : undefined;
  const fragmentCount = fragMatch ? Number.parseInt(fragMatch[2], 10) : undefined;

  // 3. Playlist item indicator: [download] Downloading item 2 of 10
  const itemMatch = trimmed.match(/\[download\]\s+Downloading\s+(?:item|video)\s+(\d+)\s+of\s+(\d+)/i);
  if (itemMatch) {
    const idx = Number.parseInt(itemMatch[1], 10);
    const total = Number.parseInt(itemMatch[2], 10);
    return {
      phase: 'downloading',
      phaseLabel: `Downloading item ${idx} of ${total}...`,
      playlistItemIndex: idx,
      playlistItemCount: total,
      percentage: total > 0 ? Math.min(100, Math.round(((idx - 1) / total) * 100)) : 0,
      percentageKnown: total > 0,
      etaStr: '--',
    };
  }

  // 4. Standard yt-dlp format with total:
  // e.g. [download]  45.2% of ~ 120.50MiB at  4.25MiB/s ETA 00:15 (frag 3/20)
  // e.g. [download] 100% of 120.50MiB in 00:00:12 at 10.00MiB/s
  const downloadMatch = trimmed.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+in\s+[\d:]+)?(?:\s+at\s+([^(\r\n]+?))?(?:\s+ETA\s+([^\s(]+))?(?:\s*\(frag\s+\d+\/\d+\))?$/i
  );
  if (downloadMatch) {
    const pct = Math.min(100, Math.max(0, parseFloat(downloadMatch[1])));
    const totalBytes = parseBytes(downloadMatch[2]);
    const rawSpeed = (downloadMatch[3] || '').trim();
    const speedBytes = parseBytes(rawSpeed);
    const etaStr = normalizeEta(downloadMatch[4]);
    const downloadedBytes = totalBytes > 0 ? Math.round((pct / 100) * totalBytes) : 0;
    const fragLabel =
      fragmentIndex && fragmentCount ? `Downloading fragment ${fragmentIndex}/${fragmentCount}` : 'Downloading media stream';

    return {
      percentage: pct,
      percentageKnown: totalBytes > 0 || Number.isFinite(pct),
      downloadedBytes,
      totalBytes,
      speedBytesPerSec: speedBytes,
      speedStr: speedBytes > 0 ? `${formatBytes(speedBytes)}/s` : '0 B/s',
      etaStr,
      phase: 'downloading',
      phaseLabel: fragLabel,
      fragmentIndex,
      fragmentCount,
    };
  }

  // 5. Unknown-size yt-dlp format: [download]  12.4MiB at 2.1MiB/s (00:06) or [download] 12.4MiB at Unknown B/s (frag 2/10)
  const unknownMatch = trimmed.match(
    /\[download\]\s+([\d.]+\s*(?:[KMGT]i?B|B))\s+at\s+([^(\r\n]+?)(?:\s+\(([\d:]+)\))?(?:\s*\(frag\s+\d+\/\d+\))?$/i
  );
  if (unknownMatch) {
    const downloadedBytes = parseBytes(unknownMatch[1]);
    const speedBytes = parseBytes(unknownMatch[2]);
    return {
      percentage: 0,
      percentageKnown: false,
      downloadedBytes,
      totalBytes: 0,
      speedBytesPerSec: speedBytes,
      speedStr: speedBytes > 0 ? `${formatBytes(speedBytes)}/s` : '0 B/s',
      etaStr: '--',
      phase: 'downloading',
      phaseLabel: fragmentIndex && fragmentCount
        ? `Downloading fragment ${fragmentIndex}/${fragmentCount}`
        : 'Downloading stream (size unknown)',
      fragmentIndex,
      fragmentCount,
    };
  }

  // 6. Stage / Extractor / Resuming detection (no fake percentages)
  if (/\[download\]\s+Resuming download at byte/i.test(trimmed)) {
    return {
      phase: 'connecting',
      phaseLabel: 'Resuming interrupted transfer...',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  if (/\[download\]\s+Destination:/i.test(trimmed)) {
    return {
      phase: 'downloading',
      phaseLabel: 'Preparing output stream...',
      etaStr: '--',
    };
  }

  if (
    /Extracting URL/i.test(trimmed) ||
    /Downloading webpage/i.test(trimmed) ||
    /Downloading (?:tv|android|ios|web) player/i.test(trimmed) ||
    /\[download\]\s+Downloading playlist:/i.test(trimmed)
  ) {
    return {
      phase: 'connecting',
      phaseLabel: 'Resolving media source...',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  if (/^\[info\]/i.test(trimmed)) {
    return {
      phase: 'connecting',
      phaseLabel: 'Connected to media source...',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  // 7. Post-processing or merger detection
  if (
    trimmed.includes('[Merger]') ||
    /\[Fixup[A-Za-z0-9]*\]/.test(trimmed)
  ) {
    return {
      phase: 'muxing',
      phaseLabel: 'Muxing video & audio streams via FFmpeg...',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  if (
    trimmed.includes('[ExtractAudio]') ||
    trimmed.includes('[ffmpeg]') ||
    trimmed.includes('[Metadata]') ||
    trimmed.includes('[EmbedThumbnail]') ||
    trimmed.includes('[ModifyChapters]') ||
    trimmed.includes('[SponsorBlock]') ||
    trimmed.includes('[VideoRemuxer]')
  ) {
    return {
      phase: 'processing',
      phaseLabel: trimmed.includes('[EmbedThumbnail]')
        ? 'Embedding thumbnail artwork...'
        : trimmed.includes('[ExtractAudio]')
        ? 'Extracting & encoding audio stream...'
        : 'Processing & embedding metadata...',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  return null;
}

export function parseSpotdlProgressLine(
  line: string
): { phase: 'connecting' | 'downloading' | 'processing'; label: string } | null {
  const trimmed = stripAnsiCodes(line).trim();
  if (!trimmed) return null;

  if (
    /Processing query/i.test(trimmed) ||
    /Fetching/i.test(trimmed) ||
    /Searching for/i.test(trimmed)
  ) {
    return { phase: 'connecting', label: 'Resolving Spotify metadata & audio match...' };
  }
  if (/Converting|Embedding|Applying metadata/i.test(trimmed)) {
    return { phase: 'processing', label: 'Converting & embedding audio metadata...' };
  }
  if (/Found\s+/i.test(trimmed) || /Downloading\s+/i.test(trimmed)) {
    return { phase: 'downloading', label: 'Downloading matched audio stream...' };
  }
  return null;
}
