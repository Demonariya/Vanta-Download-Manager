/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type AudioCodec = 'flac' | 'wav' | 'mp3' | 'm4a' | 'opus' | 'original';

export type BitDepth = 16 | 24 | 32;

export type SampleRate = 44100 | 48000 | 88200 | 96000 | 176400 | 192000;

export interface AudioQualityOption {
  id: string;
  category: 'lossless' | 'pcm_hires' | 'compressed' | 'source';
  label: string;
  codec: AudioCodec;
  bit_depth?: BitDepth;
  sample_rate?: SampleRate;
  bitrate?: string;
  description: string;
  requires_transcode: boolean;
  truth_disclosure?: string;
}

export const AUDIO_QUALITY_OPTIONS: AudioQualityOption[] = [
  // Category 1: Source / Lossless
  {
    id: 'source_original',
    category: 'source',
    label: 'Best Available Source Stream',
    codec: 'original',
    description: 'Preserves the exact untouched audio stream without re-encoding or quality loss.',
    requires_transcode: false,
    truth_disclosure: 'Direct stream extraction: zero generational loss.',
  },
  {
    id: 'flac_lossless',
    category: 'lossless',
    label: 'FLAC Lossless (Standard 16-bit / 44.1 kHz)',
    codec: 'flac',
    bit_depth: 16,
    sample_rate: 44100,
    description: 'Free Lossless Audio Codec container at CD standard.',
    requires_transcode: true,
    truth_disclosure: 'If the source is lossy, transcode creates a lossless container but cannot restore lost frequencies.',
  },
  {
    id: 'wav_pcm',
    category: 'lossless',
    label: 'WAV Linear PCM (16-bit / 44.1 kHz)',
    codec: 'wav',
    bit_depth: 16,
    sample_rate: 44100,
    description: 'Uncompressed waveform audio format.',
    requires_transcode: true,
    truth_disclosure: 'Uncompressed container of the decoded signal.',
  },

  // Category 2: High-Resolution PCM Output
  {
    id: 'flac_24_48',
    category: 'pcm_hires',
    label: 'FLAC Hi-Res (24-bit / 48 kHz)',
    codec: 'flac',
    bit_depth: 24,
    sample_rate: 48000,
    description: 'Broadcast and video production high-resolution audio standard.',
    requires_transcode: true,
    truth_disclosure: 'Requires resampling/bit-padding if source sample rate differs.',
  },
  {
    id: 'flac_24_96',
    category: 'pcm_hires',
    label: 'FLAC Studio Master (24-bit / 96 kHz)',
    codec: 'flac',
    bit_depth: 24,
    sample_rate: 96000,
    description: 'High-resolution studio master sample rate for audiophile hardware.',
    requires_transcode: true,
    truth_disclosure: 'Upsampling lossy sources (e.g. YouTube 128k) increases file size without adding new audio information.',
  },
  {
    id: 'flac_24_192',
    category: 'pcm_hires',
    label: 'FLAC Ultra High-Res (24-bit / 192 kHz)',
    codec: 'flac',
    bit_depth: 24,
    sample_rate: 192000,
    description: 'Extreme dynamic range and sampling bandwidth container.',
    requires_transcode: true,
    truth_disclosure: 'Output is mathematically 24/192, but audio fidelity is strictly bounded by source recording.',
  },
  {
    id: 'wav_24_96',
    category: 'pcm_hires',
    label: 'WAV Studio PCM (24-bit / 96 kHz)',
    codec: 'wav',
    bit_depth: 24,
    sample_rate: 96000,
    description: 'Uncompressed 24-bit linear PCM.',
    requires_transcode: true,
    truth_disclosure: 'Uncompressed PCM output.',
  },

  // Category 3: Compressed Audio
  {
    id: 'mp3_320',
    category: 'compressed',
    label: 'MP3 High Fidelity (320 kbps CBR)',
    codec: 'mp3',
    bitrate: '320k',
    sample_rate: 44100,
    description: 'Maximum standard MP3 bitrate with universal device compatibility.',
    requires_transcode: true,
  },
  {
    id: 'mp3_256',
    category: 'compressed',
    label: 'MP3 Standard High (256 kbps CBR)',
    codec: 'mp3',
    bitrate: '256k',
    sample_rate: 44100,
    description: 'Efficient high quality MP3 encoding.',
    requires_transcode: true,
  },
  {
    id: 'm4a_256',
    category: 'compressed',
    label: 'M4A / AAC (256 kbps)',
    codec: 'm4a',
    bitrate: '256k',
    sample_rate: 44100,
    description: 'Advanced Audio Coding standard for Apple devices.',
    requires_transcode: true,
  },
  {
    id: 'opus_160',
    category: 'compressed',
    label: 'Opus Modern (160 kbps VBR / 48 kHz)',
    codec: 'opus',
    bitrate: '160k',
    sample_rate: 48000,
    description: 'Cutting-edge low-latency codec superior to MP3 at equivalent bitrates.',
    requires_transcode: true,
  },
];

/**
 * Validates whether an audio codec supports the given bit depth and sample rate.
 */
export function validateAudioSettings(
  codec: AudioCodec,
  bitDepth?: BitDepth,
  sampleRate?: SampleRate
): { valid: boolean; error?: string } {
  if (codec === 'mp3') {
    if (bitDepth && bitDepth > 16) {
      return { valid: false, error: 'MP3 codec does not support 24-bit or 32-bit PCM encoding.' };
    }
    if (sampleRate && sampleRate > 48000) {
      return { valid: false, error: 'MP3 codec standard maximum sample rate is 48 kHz.' };
    }
  }

  if (codec === 'opus') {
    if (bitDepth && bitDepth > 16) {
      return { valid: false, error: 'Opus uses an internal lossy psychoacoustic model and does not expose 24-bit PCM storage.' };
    }
  }

  if (codec === 'flac') {
    if (bitDepth && bitDepth === 32) {
      return { valid: false, error: 'Standard FLAC format supports up to 24-bit integer PCM.' };
    }
  }

  return { valid: true };
}

/**
 * Generates an accurate, honest label for audio quality based on source vs requested output.
 */
export function formatAudioQualityBadge(
  codec: string,
  bitDepth?: number,
  sampleRate?: number,
  bitrate?: string,
  sourceIsLossy: boolean = false,
  isVerified: boolean = false
): string {
  const normCodec = codec.toUpperCase();

  if (normCodec === 'FLAC' || normCodec === 'WAV') {
    const depthStr = bitDepth ? `${bitDepth}-bit` : '16-bit';
    const rateStr = sampleRate ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz` : '44.1 kHz';
    const verifiedTag = isVerified ? '✓ Verified' : 'Output';
    const lossyNotice = sourceIsLossy ? ' (Transcoded)' : '';
    return `${normCodec} · ${depthStr} · ${rateStr}${lossyNotice} [${verifiedTag}]`;
  }

  if (normCodec === 'OPUS') {
    const rateStr = sampleRate ? `${(sampleRate / 1000).toFixed(0)} kHz` : '48 kHz';
    const bitStr = bitrate || '160k';
    return `Opus · ${bitStr} · ${rateStr}`;
  }

  if (normCodec === 'MP3') {
    const bitStr = bitrate || '320k';
    return `MP3 · ${bitStr} CBR`;
  }

  if (normCodec === 'M4A' || normCodec === 'AAC') {
    const bitStr = bitrate || '256k';
    return `AAC · ${bitStr}`;
  }

  return `${normCodec} ${bitrate ? `· ${bitrate}` : ''}`;
}

/**
 * Inspects a source URL and detects whether it originates from a lossy streaming service.
 */
export function isLikelyLossySource(url: string, extractor?: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return true;
  if (lower.includes('spotify.com') || lower.includes('open.spotify.com')) return true;
  if (lower.includes('soundcloud.com')) return true;
  if (lower.includes('tiktok.com')) return true;
  if (lower.includes('twitch.tv')) return true;
  if (extractor && (extractor.includes('youtube') || extractor.includes('spotdl'))) return true;
  return false;
}

/**
 * Parses FFprobe stream metadata into verified audio properties.
 */
export function parseFfprobeMetadata(data: any): {
  codec: string;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSeconds: number;
  bitrateKbps: number;
  summary: string;
} {
  const audioStream = data?.streams?.find((s: any) => s.codec_type === 'audio') || data?.streams?.[0] || {};
  const format = data?.format || {};

  const codec = (audioStream.codec_name || format.format_name || 'unknown').toLowerCase();
  const sampleRate = parseInt(audioStream.sample_rate || '44100', 10);
  const channels = parseInt(audioStream.channels || '2', 10);
  
  // Bit depth calculation from bits_per_sample or sample_fmt (e.g. s16p = 16, s32p/fltp = 24/32)
  let bitDepth = parseInt(audioStream.bits_per_sample || audioStream.bits_per_raw_sample || '0', 10);
  if (!bitDepth || bitDepth === 0) {
    const fmt = (audioStream.sample_fmt || '').toLowerCase();
    if (fmt.includes('s32') || fmt.includes('flt')) bitDepth = 24;
    else if (fmt.includes('s24')) bitDepth = 24;
    else bitDepth = 16;
  }

  const durationSeconds = parseFloat(audioStream.duration || format.duration || '0');
  const bitrateKbps = Math.round(parseInt(audioStream.bit_rate || format.bit_rate || '0', 10) / 1000);

  const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels}ch`;
  const summary = `${codec.toUpperCase()} · ${bitDepth}-bit · ${sampleRate} Hz · ${channelLabel}`;

  return {
    codec,
    sampleRate,
    channels,
    bitDepth,
    durationSeconds,
    bitrateKbps,
    summary,
  };
}
