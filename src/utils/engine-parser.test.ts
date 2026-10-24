import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBytes,
  formatBytes,
  formatDuration,
  determineEngineForUrl,
  sanitizeFilename,
  parseYtdlpProgress,
} from './engine-parser';

test('parseBytes parses various unit strings correctly', () => {
  assert.equal(parseBytes('1024B'), 1024);
  assert.equal(parseBytes('1KB'), 1024);
  assert.equal(parseBytes('2.5MB'), 2621440);
  assert.equal(parseBytes('1GiB'), 1073741824);
  assert.equal(parseBytes('invalid'), 0);
  assert.equal(parseBytes(''), 0);
});

test('formatBytes formats bytes to clean units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1048576 * 15.5), '15.5 MB');
  assert.equal(formatBytes(1073741824 * 2), '2.0 GB');
});

test('formatDuration formats seconds to MM:SS or HH:MM:SS', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(3665), '01:01:05');
});

test('determineEngineForUrl routes Spotify URLs to spotdl and others to yt-dlp', () => {
  assert.equal(determineEngineForUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'spotdl');
  assert.equal(determineEngineForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'yt-dlp');
  assert.equal(determineEngineForUrl('https://vimeo.com/76979871'), 'yt-dlp');
  assert.equal(determineEngineForUrl('https://example.com/video.mp4'), 'yt-dlp');
});

test('sanitizeFilename removes illegal characters safely', () => {
  const dangerous = 'My Video: "The Best <Movie>" | 2026? *cool* /path\\test';
  const clean = sanitizeFilename(dangerous);
  assert.equal(clean.includes(':'), false);
  assert.equal(clean.includes('<'), false);
  assert.equal(clean.includes('>'), false);
  assert.equal(clean.includes('"'), false);
  assert.equal(clean.includes('|'), false);
  assert.equal(clean.includes('?'), false);
  assert.equal(clean.includes('*'), false);
  assert.equal(clean.includes('/'), false);
  assert.equal(clean.includes('\\'), false);
});

test('parseYtdlpProgress parses structured and standard output', () => {
  // Structured format
  const structured = '45.5%|50.2MB|110.3MB|4.2MB/s|00:14|downloading';
  const p1 = parseYtdlpProgress(structured);
  assert.ok(p1);
  assert.equal(p1.percentage, 45.5);
  assert.equal(p1.speedStr, '4.2MB/s');
  assert.equal(p1.etaStr, '00:14');

  // Standard format
  const standard = '[download]  50.0% of 100.00MiB at 5.00MiB/s ETA 00:10';
  const p2 = parseYtdlpProgress(standard);
  assert.ok(p2);
  assert.equal(p2.percentage, 50.0);
  assert.equal(p2.speedStr, '5.00MiB/s');
  assert.equal(p2.etaStr, '00:10');

  // Merger line
  const merger = '[Merger] Merging formats into "video.mp4"';
  const p3 = parseYtdlpProgress(merger);
  assert.ok(p3);
  assert.equal(p3.phase, 'processing');
});
