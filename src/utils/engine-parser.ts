import { EngineType } from '../types';
import { isSpotifyUrl } from './spotify';

export interface ParsedProgress {
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  speedStr: string;
  etaStr: string;
  phase: string;
}

export function parseBytes(str: string | undefined | null): number {
  if (!str) return 0;
  const cleaned = str.trim();
  const match = cleaned.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  if (isNaN(value)) return 0;

  const unit = (match[2] || 'B').toUpperCase();

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
  if (isNaN(bytes) || bytes <= 0) return '0 B';
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

export function determineEngineForUrl(url: string): EngineType {
  if (isSpotifyUrl(url)) {
    return 'spotdl';
  }
  return 'yt-dlp';
}

export function sanitizeFilename(name: string): string {
  // Strip control chars and invalid path symbols across Windows/Linux
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

export function parseYtdlpProgress(line: string): Partial<ParsedProgress> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1. Structured custom progress format: %percent%|%downloaded%|%total%|%speed%|%eta%|%status%
  if (trimmed.includes('|')) {
    const parts = trimmed.split('|');
    if (parts.length >= 4) {
      const pct = parseFloat(parts[0].replace('%', '').trim());
      const downloaded = parseBytes(parts[1]);
      const total = parseBytes(parts[2]);
      const speedStr = parts[3].trim();
      const speedBytes = parseBytes(speedStr);
      const etaStr = parts[4] ? parts[4].trim() : '--:--';
      const status = parts[5] ? parts[5].trim() : 'downloading';

      return {
        percentage: isNaN(pct) ? 0 : Math.min(100, Math.max(0, pct)),
        downloadedBytes: downloaded,
        totalBytes: total,
        speedBytesPerSec: speedBytes,
        speedStr: speedStr || '0 B/s',
        etaStr: etaStr || '--:--',
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
      downloadedBytes,
      totalBytes,
      speedBytesPerSec: speedBytes,
      speedStr,
      etaStr,
      phase: 'downloading',
    };
  }

  // 3. Post-processing or merger detection
  if (trimmed.includes('[Merger]') || trimmed.includes('[FixupM3u8]')) {
    return {
      percentage: 95,
      phase: 'processing',
      etaStr: 'Finishing...',
    };
  }
  if (trimmed.includes('[ExtractAudio]') || trimmed.includes('[ffmpeg]')) {
    return {
      percentage: 98,
      phase: 'converting',
      etaStr: 'Converting audio...',
    };
  }

  return null;
}
