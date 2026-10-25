/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAudioSettings,
  formatAudioQualityBadge,
  isLikelyLossySource,
  parseFfprobeMetadata,
} from './audio-quality';

test('validateAudioSettings rejects MP3 with 24-bit depth', () => {
  const result = validateAudioSettings('mp3', 24, 44100);
  assert.equal(result.valid, false);
  assert.match(result.error || '', /does not support 24-bit/);
});

test('validateAudioSettings accepts FLAC with 24-bit / 96 kHz', () => {
  const result = validateAudioSettings('flac', 24, 96000);
  assert.equal(result.valid, true);
});

test('validateAudioSettings rejects FLAC with 32-bit integer PCM', () => {
  const result = validateAudioSettings('flac', 32, 96000);
  assert.equal(result.valid, false);
});

test('isLikelyLossySource flags YouTube and Spotify URLs as lossy', () => {
  assert.equal(isLikelyLossySource('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isLikelyLossySource('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), true);
  assert.equal(isLikelyLossySource('https://soundcloud.com/artist/track'), true);
  assert.equal(isLikelyLossySource('https://archive.org/details/lossless_flac_sample.flac'), false);
});

test('formatAudioQualityBadge generates truthful transcode labels for lossy sources', () => {
  const badge = formatAudioQualityBadge('flac', 24, 96000, undefined, true, false);
  assert.match(badge, /FLAC · 24-bit · 96 kHz \(Transcoded\)/);

  const verifiedBadge = formatAudioQualityBadge('flac', 24, 96000, undefined, false, true);
  assert.match(verifiedBadge, /✓ Verified/);
});

test('parseFfprobeMetadata correctly extracts sample rate, bit depth, and channels', () => {
  const sampleData = {
    streams: [
      {
        codec_name: 'flac',
        codec_type: 'audio',
        sample_rate: '96000',
        channels: 2,
        bits_per_sample: 24,
        duration: '185.4',
        bit_rate: '2800000',
      },
    ],
  };

  const parsed = parseFfprobeMetadata(sampleData);
  assert.equal(parsed.codec, 'flac');
  assert.equal(parsed.sampleRate, 96000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.bitDepth, 24);
  assert.equal(parsed.summary, 'FLAC · 24-bit · 96000 Hz · Stereo');
});
