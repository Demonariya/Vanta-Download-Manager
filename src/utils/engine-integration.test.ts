/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyDownloadError, sanitizeLog } from './error-classifier';
import { parseFfprobeMetadata } from './audio-quality';

test('Integration: yt-dlp executable runs and reports latest stable release', () => {
  const candidates = [
    path.resolve(process.cwd(), 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];
  const execPath = candidates.find((p) => fs.existsSync(p));
  assert.ok(execPath, 'yt-dlp executable must exist in project or system path');

  const version = execSync(`"${execPath}" --version`, { encoding: 'utf-8' }).trim();
  assert.ok(version.startsWith('2026.'), `Reported version (${version}) should be 2026.x`);
});

test('Integration: spotDL executable runs and reports latest stable version', () => {
  const candidates = [
    path.resolve(process.cwd(), 'bin', 'spotdl'),
    '/root/.local/bin/spotdl',
    '/usr/local/bin/spotdl',
    '/usr/bin/spotdl',
  ];
  const execPath = candidates.find((p) => fs.existsSync(p));
  assert.ok(execPath, 'spotdl executable must exist in project or system path');

  const version = execSync(`"${execPath}" --version`, { encoding: 'utf-8' }).trim();
  assert.ok(version.includes('4.5.'), `Reported version (${version}) should be 4.5.x`);
});

test('Integration: FFmpeg and FFprobe run and inspect media correctly', () => {
  const ffmpegOut = execSync('ffmpeg -version', { encoding: 'utf-8' });
  assert.ok(ffmpegOut.includes('ffmpeg version'), 'FFmpeg should be operational');

  const ffprobeOut = execSync('ffprobe -version', { encoding: 'utf-8' });
  assert.ok(ffprobeOut.includes('ffprobe version'), 'FFprobe should be operational');
});

test('HTTP 410 Recovery Simulation: Expired media URL correctly triggers re-extraction', () => {
  // Simulates an expired streaming URL error from YouTube CDN
  const expiredStreamLog = `
    [youtube] Extracting URL: https://www.youtube.com/watch?v=sample123
    [download] Destination: /app/applet/downloads/sample123.mp4
    [download] Got error: HTTP Error 410: Gone. The server has permanently removed this resource.
    ERROR: unable to download video data: HTTP Error 410: Gone
  `;

  // First attempt fails with 410
  const classification = classifyDownloadError(expiredStreamLog, 0);
  assert.strictEqual(classification.category, 'expired_url');
  assert.strictEqual(classification.isRecoverable, true);
  assert.strictEqual(classification.suggestedAction, 're_extract');
  assert.ok(classification.userMessage.includes('HTTP 410'));

  // On retry, backoff delay is provided
  assert.ok(classification.backoffDelayMs && classification.backoffDelayMs > 0);
});

test('Rate Limit Simulation: HTTP 429 applies exponential backoff delay', () => {
  const rateLimitLog = `
    ERROR: [youtube] sample123: Sign in to confirm you’re not a bot. HTTP Error 429: Too Many Requests
  `;
  const attempt1 = classifyDownloadError(rateLimitLog, 0);
  const attempt2 = classifyDownloadError(rateLimitLog, 2);

  assert.strictEqual(attempt1.category, 'rate_limit');
  assert.strictEqual(attempt1.suggestedAction, 'backoff');
  assert.ok(attempt2.backoffDelayMs! > attempt1.backoffDelayMs!);
});

test('Sensitive Data Protection: Token and Cookie sanitizer strips credentials', () => {
  const leakedLog = `
    [debug] Request headers: {'User-Agent': 'Mozilla', 'Cookie': 'LOGIN_INFO=AF3Qwa...; SID=xyz999', 'Authorization': 'Bearer ya29.a0AfH6SM...'}
    [debug] Fetching https://manifest.googlevideo.com/api/manifest/hls_variant/source/youtube?sig=AOq0QJ8wRA...&expire=1729859999
  `;
  const sanitized = sanitizeLog(leakedLog);
  assert.ok(!sanitized.includes('LOGIN_INFO=AF3Qwa'));
  assert.ok(!sanitized.includes('ya29.a0AfH6SM'));
  assert.ok(!sanitized.includes('AOq0QJ8wRA'));
  assert.ok(sanitized.includes('[REDACTED_COOKIE]'));
  assert.ok(sanitized.includes('[REDACTED_TOKEN]'));
  assert.ok(sanitized.includes('[REDACTED]'));
});
