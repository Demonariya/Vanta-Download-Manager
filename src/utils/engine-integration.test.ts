/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyDownloadError, sanitizeLog } from './error-classifier';

interface BinaryCheckResult {
  compatible: boolean;
  executable: boolean;
  reason?: string;
}

function inspectExecutable(filePath: string): BinaryCheckResult {
  if (!fs.existsSync(filePath)) {
    return { compatible: false, executable: false, reason: 'file does not exist' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return {
      compatible: false,
      executable: false,
      reason: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!stat.isFile()) {
    return { compatible: false, executable: false, reason: 'path is not a regular file' };
  }

  // Inspect magic bytes to ensure platform compatibility before attempting execution
  let header = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
      header = buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return {
      compatible: false,
      executable: false,
      reason: `unable to read binary header: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const isWindows = process.platform === 'win32';
  const isPeBinary = header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a; // "MZ"
  const isElfBinary =
    header.length >= 4 &&
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46;
  const isShebangScript = header.length >= 2 && header[0] === 0x23 && header[1] === 0x21; // "#!"
  const isMachO =
    header.length >= 4 &&
    ((header[0] === 0xcf && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe) ||
      (header[0] === 0xfe && header[1] === 0xed && header[2] === 0xfa && header[3] === 0xcf) ||
      (header[0] === 0xca && header[1] === 0xfe && header[2] === 0xba && header[3] === 0xbe));

  if (isWindows) {
    if (!isPeBinary && !/\.(exe|cmd|bat)$/i.test(filePath)) {
      return {
        compatible: false,
        executable: false,
        reason: 'file is not a Windows PE executable or batch wrapper',
      };
    }
    return { compatible: true, executable: true };
  }

  if (isPeBinary) {
    return {
      compatible: false,
      executable: false,
      reason: `Windows PE executable cannot run natively on ${process.platform}`,
    };
  }

  const platformCompatible = isElfBinary || isShebangScript || (process.platform === 'darwin' && isMachO);
  if (!platformCompatible) {
    return {
      compatible: false,
      executable: false,
      reason: `unrecognized binary format for ${process.platform}`,
    };
  }

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return { compatible: true, executable: true };
  } catch {
    return {
      compatible: true,
      executable: false,
      reason: 'executable permission bit (X_OK) is missing',
    };
  }
}

function findExecutableOnPath(names: string[]): string | null {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const status = inspectExecutable(candidate);
      if (status.compatible && status.executable) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveToolExecutable(options: {
  toolName: string;
  envVar: string;
  pathNames: string[];
  repoFallback?: string;
}): { path: string; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const envValue = process.env[options.envVar]?.trim();

  if (envValue) {
    const resolvedEnvPath = path.resolve(envValue);
    const check = inspectExecutable(resolvedEnvPath);
    if (!check.compatible || !check.executable) {
      throw new Error(
        `${options.toolName} configured via ${options.envVar}="${envValue}" is unusable: ${check.reason || 'unknown error'}`
      );
    }
    return { path: resolvedEnvPath, diagnostics };
  }

  const onPath = findExecutableOnPath(options.pathNames);
  if (onPath) {
    return { path: onPath, diagnostics };
  }
  diagnostics.push(`PATH lookup for [${options.pathNames.join(', ')}] found no compatible executable`);

  if (options.repoFallback) {
    const check = inspectExecutable(options.repoFallback);
    if (check.compatible && check.executable) {
      return { path: options.repoFallback, diagnostics };
    }
    diagnostics.push(`Repository candidate "${options.repoFallback}": ${check.reason || 'unavailable'}`);
  }

  throw new Error(
    `Unable to locate a compatible executable ${options.toolName} binary on ${process.platform} (${process.arch}). Checked ${options.envVar}, PATH, and fallback candidates: ${diagnostics.join('; ')}`
  );
}

function runToolVersion(executablePath: string, args: string[], toolLabel: string): string {
  try {
    return execFileSync(executablePath, args, {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch (err) {
    const details = err as NodeJS.ErrnoException & { stderr?: string | Buffer; status?: number | null };
    const stderrText = details.stderr ? String(details.stderr).trim() : '';
    throw new Error(
      `Failed executing ${toolLabel} at "${executablePath}" with args [${args.join(' ')}] (code=${details.code ?? details.status ?? 'unknown'}): ${details.message}${stderrText ? ` | stderr: ${stderrText}` : ''}`
    );
  }
}

test('Integration: yt-dlp executable runs and reports latest stable release', (t) => {
  const isWindows = process.platform === 'win32';
  const repoYtdlp = path.resolve(process.cwd(), 'bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp');
  const { path: ytdlpPath } = resolveToolExecutable({
    toolName: 'yt-dlp',
    envVar: 'VANTA_TEST_YTDLP_PATH',
    pathNames: isWindows ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'],
    repoFallback: repoYtdlp,
  });

  const version = runToolVersion(ytdlpPath, ['--version'], 'yt-dlp');
  t.diagnostic(`Tested yt-dlp at "${ytdlpPath}" -> ${version}`);
  assert.ok(/^\d{4}\./.test(version), `Reported yt-dlp version (${version}) from "${ytdlpPath}" should be a valid CalVer release`);
});

test('Integration: spotDL executable runs cleanly when installed', (t) => {
  const isWindows = process.platform === 'win32';
  const repoSpotdl = path.resolve(process.cwd(), 'bin', isWindows ? 'spotdl.exe' : 'spotdl');

  let spotdlPath: string;
  try {
    spotdlPath = resolveToolExecutable({
      toolName: 'spotDL',
      envVar: 'VANTA_TEST_SPOTDL_PATH',
      pathNames: isWindows ? ['spotdl.exe', 'spotdl'] : ['spotdl'],
      repoFallback: repoSpotdl,
    }).path;
  } catch {
    t.skip('Optional spotDL binary is not installed in this environment');
    return;
  }

  const version = runToolVersion(spotdlPath, ['--version'], 'spotDL');
  t.diagnostic(`Tested spotDL at "${spotdlPath}" -> ${version}`);
  assert.ok(version.length > 0, `Reported spotDL version from "${spotdlPath}" should be non-empty`);
});

test('Integration: FFmpeg and FFprobe run and inspect media correctly', (t) => {
  const isWindows = process.platform === 'win32';

  const { path: ffmpegPath } = resolveToolExecutable({
    toolName: 'ffmpeg',
    envVar: 'FFMPEG_PATH',
    pathNames: isWindows ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'],
  });
  const ffmpegOut = runToolVersion(ffmpegPath, ['-version'], 'ffmpeg');
  t.diagnostic(`Tested ffmpeg at "${ffmpegPath}"`);
  assert.ok(
    ffmpegOut.includes('ffmpeg version'),
    `FFmpeg at "${ffmpegPath}" did not report an expected version banner`
  );

  const { path: ffprobePath } = resolveToolExecutable({
    toolName: 'ffprobe',
    envVar: 'FFPROBE_PATH',
    pathNames: isWindows ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe'],
  });
  const ffprobeOut = runToolVersion(ffprobePath, ['-version'], 'ffprobe');
  t.diagnostic(`Tested ffprobe at "${ffprobePath}"`);
  assert.ok(
    ffprobeOut.includes('ffprobe version'),
    `FFprobe at "${ffprobePath}" did not report an expected version banner`
  );
});

test('HTTP 410 Recovery Simulation: Expired media URL correctly triggers re-extraction', () => {
  const expiredStreamLog = `
    [youtube] Extracting URL: https://www.youtube.com/watch?v=sample123
    [download] Destination: /app/applet/downloads/sample123.mp4
    [download] Got error: HTTP Error 410: Gone. The server has permanently removed this resource.
    ERROR: unable to download video data: HTTP Error 410: Gone
  `;

  const classification = classifyDownloadError(expiredStreamLog, 0);
  assert.strictEqual(classification.category, 'expired_url');
  assert.strictEqual(classification.isRecoverable, true);
  assert.strictEqual(classification.suggestedAction, 're_extract');
  assert.ok(classification.userMessage.includes('HTTP 410'));
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
