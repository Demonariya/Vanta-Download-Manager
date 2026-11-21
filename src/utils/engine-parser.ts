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
  phase: string;
}

export interface BatchUrlValidationResult {
  valid: string[];
  invalid: Array<{ line: number; input: string; reason: string }>;
  duplicatesRemoved: number;
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
  'pornhub.com',
  'xvideos.com',
  'xnxx.com',
  'spankbang.com',
  'redtube.com',
  'youporn.com',
];

const DIRECT_FILE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'iso', 'img', 'dmg', 'exe', 'msi', 'msix', 'appimage', 'deb', 'rpm', 'apk',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'json', 'xml', 'epub',
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv',
  'mp3', 'flac', 'wav', 'm4a', 'aac', 'opus', 'ogg',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif',
  'bin', 'dat', 'wasm',
]);

export function parseBytes(str: string | undefined | null): number {
  if (!str) return 0;
  const cleaned = str.trim();
  if (!cleaned || cleaned.toUpperCase() === 'NA' || cleaned === 'N/A' || cleaned === 'Unknown') {
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
 * Classifies a media or file URL into the correct download provider.
 */
export function determineEngineForUrl(url: string): EngineType {
  if (isSpotifyUrl(url)) {
    return 'spotdl';
  }
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    const isKnownStreamingHost = STREAMING_SITE_HOST_HINTS.some(
      (h) => host === h || host.endsWith(`.${h}`)
    );
    if (!isKnownStreamingHost) {
      const pathLower = parsed.pathname.toLowerCase();
      const lastSegment = pathLower.split('/').filter(Boolean).pop() || '';
      const dotIdx = lastSegment.lastIndexOf('.');
      if (dotIdx > 0 && dotIdx < lastSegment.length - 1) {
        const ext = lastSegment.slice(dotIdx + 1);
        if (DIRECT_FILE_EXTENSIONS.has(ext)) {
          return 'direct';
        }
      }
    }
  } catch {
    // Fallback to yt-dlp
  }
  return 'yt-dlp';
}

export function isDirectFileUrl(url: string): boolean {
  return determineEngineForUrl(url) === 'direct';
}

export function isPlaylistCandidateUrl(url: string): boolean {
  const trimmed = (url || '').trim();
  if (!trimmed) return false;
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

    if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
      invalid.push({ line: lineNum, input: trimmed, reason: 'Contains whitespace or control chars' });
      return;
    }
    if (trimmed.startsWith('-')) {
      invalid.push({ line: lineNum, input: trimmed, reason: 'URL cannot begin with a dash' });
      return;
    }

    const spotifyParsed = tryParseSpotifyInput(trimmed);
    if (spotifyParsed) {
      if (spotifyParsed.kind === 'invalid') {
        invalid.push({ line: lineNum, input: trimmed, reason: spotifyParsed.error });
        return;
      }
    } else {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          invalid.push({ line: lineNum, input: trimmed, reason: 'Unsupported URL scheme' });
          return;
        }
        if (!parsed.hostname || parsed.hostname.startsWith('.')) {
          invalid.push({ line: lineNum, input: trimmed, reason: 'Invalid host' });
          return;
        }
      } catch {
        invalid.push({ line: lineNum, input: trimmed, reason: 'Malformed URL' });
        return;
      }
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

export function parseYtdlpProgress(line: string): Partial<ParsedProgress> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1. Structured custom progress format: %percent%|%downloaded%|%total%|%speed%|%eta%|%status%
  if (trimmed.includes('|')) {
    const parts = trimmed.split('|');
    if (parts.length >= 4) {
      const pctRaw = parts[0].replace('%', '').trim();
      const pct = parseFloat(pctRaw);
      const downloaded = parseBytes(parts[1]);
      const total = parseBytes(parts[2]);
      const speedRaw = parts[3].trim();
      const speedBytes = parseBytes(speedRaw);
      const etaRaw = parts[4] ? parts[4].trim() : '';
      const status = parts[5] ? parts[5].trim() : 'downloading';

      const percentageKnown =
        total > 0 || (Number.isFinite(pct) && pctRaw !== 'N/A' && pctRaw !== 'NA');
      const computedPct =
        total > 0
          ? Math.min(100, Math.max(0, (downloaded / total) * 100))
          : Number.isFinite(pct)
          ? Math.min(100, Math.max(0, pct))
          : 0;

      return {
        percentage: computedPct,
        percentageKnown,
        downloadedBytes: downloaded,
        totalBytes: total,
        speedBytesPerSec: speedBytes,
        speedStr: speedBytes > 0 ? `${formatBytes(speedBytes)}/s` : '0 B/s',
        etaStr: etaRaw && etaRaw !== 'NA' && etaRaw !== 'Unknown' ? etaRaw : '--',
        phase: status,
      };
    }
  }

  // 2. Standard yt-dlp format: [download]  45.2% of 120.50MiB at 4.25MiB/s ETA 00:15
  const downloadMatch = trimmed.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+([\d:]+)/i
  );
  if (downloadMatch) {
    const pct = parseFloat(downloadMatch[1]);
    const totalBytes = parseBytes(downloadMatch[2]);
    const speedStr = downloadMatch[3];
    const speedBytes = parseBytes(speedStr.replace('/s', ''));
    const etaStr = downloadMatch[4];
    const downloadedBytes = Math.round((pct / 100) * totalBytes);

    return {
      percentage: pct,
      percentageKnown: totalBytes > 0 || Number.isFinite(pct),
      downloadedBytes,
      totalBytes,
      speedBytesPerSec: speedBytes,
      speedStr: speedBytes > 0 ? `${formatBytes(speedBytes)}/s` : speedStr,
      etaStr,
      phase: 'downloading',
    };
  }

  // 3. Unknown-size yt-dlp format: [download]  12.4MiB at 2.1MiB/s (00:06)
  const unknownMatch = trimmed.match(/\[download\]\s+([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)/i);
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
    };
  }

  // 4. Post-processing or merger detection
  if (trimmed.includes('[Merger]') || trimmed.includes('[FixupM3u8]')) {
    return {
      phase: 'muxing',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }
  if (trimmed.includes('[ExtractAudio]') || trimmed.includes('[ffmpeg]') || trimmed.includes('[Metadata]')) {
    return {
      phase: 'processing',
      etaStr: '--',
      speedBytesPerSec: 0,
      speedStr: '0 B/s',
    };
  }

  return null;
}
