/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ErrorCategory =
  | 'expired_url' // HTTP 410 Gone, HTTP 403 Forbidden stream segment, expired token
  | 'rate_limit' // HTTP 429 Too Many Requests, bot check
  | 'network_transient' // Timeout, connection reset, 502/503/504
  | 'format_unavailable' // Selected format 416, deleted stream
  | 'missing_dependency' // ffmpeg, ffprobe, spotdl missing
  | 'unsupported_source' // DRM, private, removed, copyright
  | 'filesystem_error' // Read-only, disk full, path illegal
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  isRecoverable: boolean;
  userMessage: string;
  sanitizedDetails: string;
  suggestedAction: 're_extract' | 'fallback_format' | 'backoff' | 'fail';
  backoffDelayMs?: number;
}

/**
 * Sanitizes log output to redact private session tokens, authentication headers,
 * signed query parameters, and cookie strings before logging or rendering in UI.
 */
export function sanitizeLog(text: string): string {
  if (!text) return '';

  return text
    // Redact Bearer and Auth tokens
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.~]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(Authorization:\s*)[^\r\n]+/gi, '$1[REDACTED_HEADER]')
    // Redact cookies (including Python/JSON quoted dict style)
    .replace(/(["']?cookie["']?\s*:\s*["']?)[^"'\r\n]+/gi, '$1[REDACTED_COOKIE]')
    .replace(/(["']?Set-Cookie["']?\s*:\s*["']?)[^"'\r\n]+/gi, '$1[REDACTED_COOKIE]')
    // Redact signed URL query parameters (sig, signature, token, exp, key)
    .replace(/([?&](?:sig|signature|token|session_token|auth|key|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    // Redact password parameters
    .replace(/([?&](?:password|passwd)=)[^&\s]+/gi, '$1[REDACTED]')
    // Redact 7-column Netscape cookie values
    .replace(
      /^([^\t\r\n]+\t(?:TRUE|FALSE)\t[^\t\r\n]+\t(?:TRUE|FALSE)\t\d+\t[^\t\r\n]+\t)([^\r\n]+)$/gm,
      '$1[REDACTED_VALUE]'
    )
    // Redact IPv6/internal paths if present in temp traces
    .replace(/\/tmp\/_MEI[A-Za-z0-9]+/g, '/tmp/[TEMP_BUILD]');
}

/**
 * Analyzes stderr and process output from yt-dlp, spotDL, or FFmpeg and categorizes
 * the underlying root cause with actionable recovery instructions.
 */
export function classifyDownloadError(rawOutput: string, retryCount: number = 0): ClassifiedError {
  const sanitized = sanitizeLog(rawOutput);
  const lower = rawOutput.toLowerCase();

  // 1. HTTP 410 Gone / Expired Media URL / Signature Expiration
  if (
    lower.includes('http error 410') ||
    lower.includes('error 410: gone') ||
    lower.includes('410 gone') ||
    lower.includes('url expired') ||
    lower.includes('signature expired') ||
    (lower.includes('http error 403: forbidden') && lower.includes('videoplayback')) ||
    lower.includes('the read operation timed out') && lower.includes('googlevideo')
  ) {
    return {
      category: 'expired_url',
      isRecoverable: true,
      userMessage: 'Stream URL expired (HTTP 410). Purging cache and extracting fresh media tokens...',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 're_extract',
      backoffDelayMs: 1500,
    };
  }

  // 2. HTTP 429 Too Many Requests / Rate Limiting / Bot Verification
  if (
    lower.includes('http error 429') ||
    lower.includes('too many requests') ||
    lower.includes('sign in to confirm you’re not a bot') ||
    lower.includes('bot verification') ||
    lower.includes('rate limit exceeded')
  ) {
    // Exponential backoff with jitter: 5s, 15s, 30s, 60s
    const baseDelay = Math.min(60000, 5000 * Math.pow(2, retryCount));
    const jitter = Math.floor(Math.random() * 2000);
    const delay = baseDelay + jitter;

    return {
      category: 'rate_limit',
      isRecoverable: retryCount < 4,
      userMessage: `Rate limit encountered (HTTP 429). Applying backoff (${Math.round(delay / 1000)}s delay)...`,
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: retryCount < 4 ? 'backoff' : 'fail',
      backoffDelayMs: delay,
    };
  }

  // 3. DRM Protected / Copyright Takedown / Private Video (Permanently non-recoverable)
  if (
    lower.includes('drm') ||
    lower.includes('widevine') ||
    lower.includes('this video is protected by digital rights management') ||
    lower.includes('this video has been removed') ||
    lower.includes('private video') ||
    lower.includes('this video is private') ||
    lower.includes('video unavailable') && lower.includes('copyright') ||
    lower.includes('account has been terminated')
  ) {
    return {
      category: 'unsupported_source',
      isRecoverable: false,
      userMessage: 'Media is inaccessible: video is private, DRM-protected, or removed by rights holder.',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 'fail',
    };
  }

  // 4. Geo-Restricted Source
  if (
    lower.includes('not available in your country') ||
    lower.includes('georestricted') ||
    lower.includes('geo-restricted') ||
    lower.includes('blocked in your region')
  ) {
    return {
      category: 'unsupported_source',
      isRecoverable: false,
      userMessage: 'Media is restricted in this geographic region. Configure a proxy or VPN in Settings.',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 'fail',
    };
  }

  // 5. Format Unavailable / HTTP 416 Requested Range Not Satisfiable
  if (
    lower.includes('requested format is not available') ||
    lower.includes('http error 416') ||
    lower.includes('format not available')
  ) {
    return {
      category: 'format_unavailable',
      isRecoverable: true,
      userMessage: 'Requested format stream unavailable. Falling back to universal best stream...',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 'fallback_format',
      backoffDelayMs: 1000,
    };
  }

  // 6. Network Transient Glitches (DNS, Connection Reset, HTTP 5xx)
  if (
    lower.includes('connection reset') ||
    lower.includes('connection refused') ||
    lower.includes('name or service not known') ||
    lower.includes('getaddrinfo failed') ||
    lower.includes('timed out') ||
    lower.includes('remote host closed connection') ||
    lower.includes('http error 500') ||
    lower.includes('http error 502') ||
    lower.includes('http error 503') ||
    lower.includes('http error 504')
  ) {
    const delay = Math.min(30000, 2000 * Math.pow(1.8, retryCount)) + Math.floor(Math.random() * 1000);
    return {
      category: 'network_transient',
      isRecoverable: retryCount < 5,
      userMessage: `Network connection interrupted. Retrying in ${Math.round(delay / 1000)}s...`,
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: retryCount < 5 ? 'backoff' : 'fail',
      backoffDelayMs: delay,
    };
  }

  // 7. Missing Dependencies
  if (
    lower.includes('ffmpeg not found') ||
    lower.includes('ffprobe not found') ||
    lower.includes('executable not found') ||
    lower.includes('no such file or directory') && lower.includes('bin/')
  ) {
    return {
      category: 'missing_dependency',
      isRecoverable: false,
      userMessage: 'Required media processing binary is missing. Run diagnostics or check engine configuration.',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 'fail',
    };
  }

  // 8. Filesystem / Permission Error
  if (
    lower.includes('permission denied') ||
    lower.includes('no space left on device') ||
    lower.includes('read-only file system')
  ) {
    return {
      category: 'filesystem_error',
      isRecoverable: false,
      userMessage: 'Filesystem error: destination folder is read-only, full, or lacks write permissions.',
      sanitizedDetails: sanitized.slice(-500),
      suggestedAction: 'fail',
    };
  }

  // Default / Unknown Error
  return {
    category: 'unknown',
    isRecoverable: retryCount < 2,
    userMessage: sanitized.length > 120 ? `${sanitized.slice(0, 120)}...` : sanitized || 'Unknown engine error',
    sanitizedDetails: sanitized.slice(-500),
    suggestedAction: retryCount < 2 ? 'backoff' : 'fail',
    backoffDelayMs: 3000,
  };
}
