/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { classifyDownloadError, sanitizeLog } from './error-classifier';

test('classifyDownloadError identifies HTTP 410 Gone and recommends re_extract', () => {
  const rawStderr = `
    [youtube] Extracting URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ
    [download] Destination: song.mp4
    ERROR: unable to download video data: HTTP Error 410: Gone
  `;
  const result = classifyDownloadError(rawStderr, 0);
  assert.strictEqual(result.category, 'expired_url');
  assert.strictEqual(result.isRecoverable, true);
  assert.strictEqual(result.suggestedAction, 're_extract');
  assert.ok(result.userMessage.includes('HTTP 410'));
});

test('classifyDownloadError identifies expired googlevideo 403 as expired_url', () => {
  const rawStderr = `
    ERROR: unable to download video data: HTTP Error 403: Forbidden for https://rr1---sn-4g5ednks.googlevideo.com/videoplayback?expire=1729851234
  `;
  const result = classifyDownloadError(rawStderr, 0);
  assert.strictEqual(result.category, 'expired_url');
  assert.strictEqual(result.suggestedAction, 're_extract');
});

test('classifyDownloadError identifies HTTP 429 and applies backoff', () => {
  const rawStderr = `
    ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. This helps protect our community. HTTP Error 429: Too Many Requests
  `;
  const result = classifyDownloadError(rawStderr, 1);
  assert.strictEqual(result.category, 'rate_limit');
  assert.strictEqual(result.isRecoverable, true);
  assert.strictEqual(result.suggestedAction, 'backoff');
  assert.ok(result.backoffDelayMs && result.backoffDelayMs >= 10000);
});

test('classifyDownloadError blocks retries for DRM or private videos', () => {
  const drmStderr = `
    ERROR: [youtube] dQw4w9WgXcQ: This video is protected by digital rights management (DRM) and cannot be processed.
  `;
  const result = classifyDownloadError(drmStderr, 0);
  assert.strictEqual(result.category, 'unsupported_source');
  assert.strictEqual(result.isRecoverable, false);
  assert.strictEqual(result.suggestedAction, 'fail');
});

test('classifyDownloadError handles format unavailable by suggesting format fallback', () => {
  const fmtStderr = `
    ERROR: requested format is not available for requested download parameters
  `;
  const result = classifyDownloadError(fmtStderr, 0);
  assert.strictEqual(result.category, 'format_unavailable');
  assert.strictEqual(result.isRecoverable, true);
  assert.strictEqual(result.suggestedAction, 'fallback_format');
});

test('sanitizeLog redacts cookies, tokens, and signed parameters', () => {
  const sensitive = `
    curl -H "Cookie: session_id=secret_12345; auth=xyz" "https://example.com/stream?sig=a1b2c3d4e5f6&key=secret99"
    Authorization: Bearer my_secret_bearer_token_abc
  `;
  const sanitized = sanitizeLog(sensitive);
  assert.ok(!sanitized.includes('secret_12345'));
  assert.ok(!sanitized.includes('a1b2c3d4e5f6'));
  assert.ok(!sanitized.includes('my_secret_bearer_token_abc'));
  assert.ok(sanitized.includes('[REDACTED_COOKIE]'));
  assert.ok(sanitized.includes('[REDACTED]'));
  assert.ok(sanitized.includes('[REDACTED_HEADER]'));
});
