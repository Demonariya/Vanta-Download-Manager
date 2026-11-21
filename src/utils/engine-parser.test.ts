import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBytes,
  formatBytes,
  formatDuration,
  determineEngineForUrl,
  validateMediaUrl,
  isUnsupportedGenericFileUrl,
  getUnsupportedNonMediaExtension,
  isPlaylistCandidateUrl,
  formatYtDlpPlaylistItems,
  parseBatchUrls,
  sanitizeFilename,
  parseYtdlpProgress,
} from './engine-parser';

test('parseBytes parses various unit strings correctly', () => {
  assert.equal(parseBytes('1024B'), 1024);
  assert.equal(parseBytes('1KB'), 1024);
  assert.equal(parseBytes('2.5MB'), 2621440);
  assert.equal(parseBytes('1GiB'), 1073741824);
  assert.equal(parseBytes('NA'), 0);
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

test('determineEngineForUrl routes exclusively to spotdl or yt-dlp', () => {
  assert.equal(determineEngineForUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'spotdl');
  assert.equal(determineEngineForUrl('spotify:album:1DFixLWuPkv3KT3TnV35m3'), 'spotdl');
  assert.equal(determineEngineForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'yt-dlp');
  assert.equal(determineEngineForUrl('https://vimeo.com/76979871'), 'yt-dlp');
  assert.equal(determineEngineForUrl('https://soundcloud.com/artist/track'), 'yt-dlp');
});

test('validateMediaUrl rejects non-media files, bad schemes, and CLI injection flags', () => {
  const rejected = [
    'https://example.com/archive.zip',
    'https://example.com/backup.rar',
    'https://cdn.example.org/setup.exe',
    'https://cdn.example.org/installer.msi',
    'https://docs.example.org/manual.pdf',
    'https://mirror.example.org/linux.iso',
    'https://mirror.example.org/app.dmg',
    'ftp://example.com/file.mp4',
    '--exec=evil',
    'not a valid url',
  ];

  for (const url of rejected) {
    const res = validateMediaUrl(url);
    assert.equal(res.valid, false, `Expected rejection for ${url}`);
  }

  assert.equal(getUnsupportedNonMediaExtension('https://example.com/archive.zip'), 'zip');
  assert.equal(isUnsupportedGenericFileUrl('https://cdn.example.org/setup.exe'), true);
  assert.equal(isUnsupportedGenericFileUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);

  const okVideo = validateMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(okVideo.valid, true);
  if (okVideo.valid) {
    assert.equal(okVideo.engine, 'yt-dlp');
  }

  const okSpotify = validateMediaUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(okSpotify.valid, true);
  if (okSpotify.valid) {
    assert.equal(okSpotify.engine, 'spotdl');
  }
});

test('isPlaylistCandidateUrl and formatYtDlpPlaylistItems handle ordered collections cleanly', () => {
  assert.equal(isPlaylistCandidateUrl('https://www.youtube.com/watch?v=abc&list=PL123'), true);
  assert.equal(isPlaylistCandidateUrl('https://www.youtube.com/playlist?list=PL123'), true);
  assert.equal(isPlaylistCandidateUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true);
  assert.equal(isPlaylistCandidateUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), false);
  assert.equal(isPlaylistCandidateUrl('https://example.com/archive.zip'), false);

  assert.equal(formatYtDlpPlaylistItems([3, 1, 3, -1, 2]), '3,1,2');
  assert.equal(formatYtDlpPlaylistItems([]), '');
});

test('parseBatchUrls separates valid media URLs, duplicates, and rejected non-media or invalid lines', () => {
  const res = parseBatchUrls([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'not a valid url',
    'https://example.com/file.zip',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '--exec=evil',
    'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  ].join('\n'));

  assert.equal(res.valid.length, 2);
  assert.equal(res.invalid.length, 3);
  assert.equal(res.duplicatesRemoved, 1);
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

test('parseYtdlpProgress parses structured, standard, unknown-size, and muxing output', () => {
  const structured = '45.5%|50.2MB|110.3MB|4.2MB/s|00:14|downloading';
  const p1 = parseYtdlpProgress(structured);
  assert.ok(p1);
  assert.ok(Math.abs((p1.percentage || 0) - 45.51) < 0.2);
  assert.equal(p1.percentageKnown, true);
  assert.equal(p1.speedStr, '4.2 MB/s');
  assert.equal(p1.etaStr, '00:14');

  const standard = '[download]  50.0% of 100.00MiB at 5.00MiB/s ETA 00:10';
  const p2 = parseYtdlpProgress(standard);
  assert.ok(p2);
  assert.equal(p2.percentage, 50.0);
  assert.equal(p2.speedStr, '5.0 MB/s');
  assert.equal(p2.etaStr, '00:10');

  const unknownSize = '[download]  12.0MiB at 2.0MiB/s';
  const pUnknown = parseYtdlpProgress(unknownSize);
  assert.ok(pUnknown);
  assert.equal(pUnknown.percentageKnown, false);
  assert.equal(pUnknown.etaStr, '--');

  const merger = '[Merger] Merging formats into "video.mp4"';
  const p3 = parseYtdlpProgress(merger);
  assert.ok(p3);
  assert.equal(p3.phase, 'muxing');
});
