import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { AppSettings, ConflictStrategy, DownloadTask, MediaMetadata } from '../src/types';
import { ProgressTracker, buildIdleMetricsPatch } from '../src/utils/download-core';
import { sanitizeFilename } from '../src/utils/engine-parser';
import { sanitizeLog } from '../src/utils/error-classifier';

interface ActiveDirectDownload {
  aborted: boolean;
  abortReason: 'paused' | 'cancelled' | null;
  destroy: () => void;
}

const activeDirectDownloads = new Map<string, ActiveDirectDownload>();

function parseContentDispositionFilename(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) return null;
  const raw = Array.isArray(headerValue) ? headerValue.join('; ') : headerValue;
  const utfMatch = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utfMatch && utfMatch[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(utfMatch[1].trim().replace(/^["']|["']$/g, '')));
    } catch {
      // fall through
    }
  }
  const stdMatch = raw.match(/filename\s*=\s*("?)([^";\n]+)\1/i);
  if (stdMatch && stdMatch[2]) {
    return sanitizeFilename(stdMatch[2].trim());
  }
  return null;
}

function inferFilenameFromUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.pop() || 'download.bin';
    const decoded = decodeURIComponent(last);
    return sanitizeFilename(decoded) || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

export function resolveUniqueDestinationPath(
  dir: string,
  baseFilename: string,
  strategy: ConflictStrategy = 'rename'
): { targetPath: string; skipped: boolean } {
  const safeName = sanitizeFilename(baseFilename) || `download_${Date.now()}`;
  const candidate = path.join(dir, safeName);

  if (!fs.existsSync(candidate)) {
    return { targetPath: candidate, skipped: false };
  }

  if (strategy === 'overwrite') {
    return { targetPath: candidate, skipped: false };
  }

  if (strategy === 'skip') {
    const stat = fs.statSync(candidate);
    if (stat.isFile() && stat.size > 0) {
      return { targetPath: candidate, skipped: true };
    }
    return { targetPath: candidate, skipped: false };
  }

  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  for (let i = 1; i <= 999; i++) {
    const nextPath = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(nextPath)) {
      return { targetPath: nextPath, skipped: false };
    }
  }

  return {
    targetPath: path.join(dir, `${stem}_${Date.now()}${ext}`),
    skipped: false,
  };
}

function performHttpProbe(
  urlStr: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string>,
  timeoutMs: number,
  redirectsLeft = 5
): Promise<{
  finalUrl: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return reject(new Error('Invalid direct download URL.'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const reqHeaders: Record<string, string> = { ...headers };
    if (method === 'GET') {
      reqHeaders.Range = 'bytes=0-0';
    }

    const req = client.request(
      parsed,
      {
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          performHttpProbe(nextUrl, method, headers, timeoutMs, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        res.resume();
        resolve({
          finalUrl: urlStr,
          statusCode: status,
          headers: res.headers,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`HTTP probe timed out after ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function inspectDirectUrl(
  rawUrl: string,
  settings: AppSettings,
  timeoutMs = 15_000
): Promise<MediaMetadata> {
  const headers: Record<string, string> = {
    'User-Agent':
      settings.user_agent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
  };

  let probe = await performHttpProbe(rawUrl, 'HEAD', headers, timeoutMs);
  if (probe.statusCode === 405 || probe.statusCode === 501 || probe.statusCode === 403) {
    probe = await performHttpProbe(rawUrl, 'GET', headers, timeoutMs);
  }

  if (probe.statusCode >= 400) {
    throw new Error(`HTTP ${probe.statusCode} returned while inspecting direct file URL.`);
  }

  let contentLength = 0;
  const contentRange = probe.headers['content-range'];
  if (typeof contentRange === 'string') {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) {
      contentLength = parseInt(match[1], 10) || 0;
    }
  }
  if (!contentLength && probe.headers['content-length']) {
    const rawLen = Array.isArray(probe.headers['content-length'])
      ? probe.headers['content-length'][0]
      : probe.headers['content-length'];
    contentLength = parseInt(String(rawLen), 10) || 0;
  }

  const acceptRangesHeader = String(probe.headers['accept-ranges'] || '').toLowerCase();
  const acceptsRanges = probe.statusCode === 206 || acceptRangesHeader.includes('bytes');
  const contentType = String(probe.headers['content-type'] || 'application/octet-stream')
    .split(';')[0]
    .trim();

  const dispositionName = parseContentDispositionFilename(probe.headers['content-disposition']);
  const filename = dispositionName || inferFilenameFromUrl(probe.finalUrl || rawUrl);
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase() || 'bin';
  const host = new URL(probe.finalUrl || rawUrl).hostname;

  return {
    url: rawUrl,
    id: crypto.createHash('sha1').update(rawUrl).digest('hex').slice(0, 12),
    title: filename,
    uploader: host,
    formats: [
      {
        format_id: 'direct',
        ext,
        filesize: contentLength > 0 ? contentLength : undefined,
        format_note: acceptsRanges ? 'Direct HTTP (Resumable)' : 'Direct HTTP',
      },
    ],
    is_playlist: false,
    extractor: 'direct-http',
    is_direct_file: true,
    direct_file_size: contentLength > 0 ? contentLength : undefined,
    direct_mime_type: contentType,
    direct_filename: filename,
    accepts_ranges: acceptsRanges,
  };
}

export function abortDirectDownload(taskId: string, reason: 'paused' | 'cancelled'): boolean {
  const entry = activeDirectDownloads.get(taskId);
  if (!entry) return false;
  entry.aborted = true;
  entry.abortReason = reason;
  try {
    entry.destroy();
  } catch {
    // ignore
  }
  activeDirectDownloads.delete(taskId);
  return true;
}

export function executeDirectDownload(
  task: DownloadTask,
  settings: AppSettings,
  onProgress: (update: Partial<DownloadTask>) => void,
  onComplete: (outputPath: string, extra?: Partial<DownloadTask>) => void,
  onError: (err: string) => void
): void {
  const outDir =
    task.output_path && !path.extname(task.output_path)
      ? task.output_path
      : settings.download_dir;

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const preferredName =
    task.custom_filename?.trim()
      ? sanitizeFilename(task.custom_filename.trim())
      : sanitizeFilename(task.title.includes('.') ? task.title : `${task.title}.${task.ext || 'bin'}`);

  const conflictStrategy: ConflictStrategy = settings.conflict_strategy || 'rename';
  const destination = resolveUniqueDestinationPath(outDir, preferredName, conflictStrategy);

  if (destination.skipped) {
    const stat = fs.statSync(destination.targetPath);
    onProgress({
      status: 'verifying',
      current_phase: 'Existing file verified (skip strategy)',
      progress_percentage: 100,
      percentage_known: true,
      downloaded_bytes: stat.size,
      total_bytes: stat.size,
      remaining_bytes: 0,
    });
    onComplete(destination.targetPath, {
      total_bytes: stat.size,
      downloaded_bytes: stat.size,
      remaining_bytes: 0,
      percentage_known: true,
    });
    return;
  }

  const partPath = `${destination.targetPath}.part`;
  let existingOffset = 0;
  if (fs.existsSync(partPath)) {
    try {
      const stat = fs.statSync(partPath);
      if (stat.isFile() && stat.size > 0) {
        existingOffset = stat.size;
      }
    } catch {
      existingOffset = 0;
    }
  }

  const startedAtMs = Date.now();
  const tracker = new ProgressTracker({
    alpha: 0.3,
    startedAtMs,
    initialBytes: existingOffset,
  });

  onProgress({
    status: 'connecting',
    current_phase: existingOffset > 0 ? 'Resuming HTTP connection...' : 'Connecting to server...',
    started_at: task.started_at || new Date(startedAtMs).toISOString(),
    downloaded_bytes: existingOffset,
    active_connections: 1,
  });

  let currentReq: http.ClientRequest | null = null;
  let currentRes: http.IncomingMessage | null = null;
  let writeStream: fs.WriteStream | null = null;

  const control: ActiveDirectDownload = {
    aborted: false,
    abortReason: null,
    destroy: () => {
      try {
        currentReq?.destroy();
      } catch {}
      try {
        currentRes?.destroy();
      } catch {}
      try {
        writeStream?.end();
      } catch {}
    },
  };
  activeDirectDownloads.set(task.id, control);

  const throttleKbps =
    settings.global_bandwidth_limit_kbps > 0
      ? settings.global_bandwidth_limit_kbps
      : settings.per_task_bandwidth_limit_kbps > 0
      ? settings.per_task_bandwidth_limit_kbps
      : 0;
  const maxBytesPerSec = throttleKbps > 0 ? throttleKbps * 1024 : 0;

  const startRequest = (targetUrl: string, offset: number, redirectsLeft: number) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      activeDirectDownloads.delete(task.id);
      return onError('Invalid download URL.');
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const reqHeaders: Record<string, string> = {
      'User-Agent':
        settings.user_agent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: '*/*',
    };

    if (offset > 0) {
      reqHeaders.Range = `bytes=${offset}-`;
    }

    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: reqHeaders,
        timeout: 30_000,
      },
      (res) => {
        currentRes = res;
        const statusCode = res.statusCode || 0;

        if (statusCode >= 300 && statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          startRequest(nextUrl, offset, redirectsLeft - 1);
          return;
        }

        if (statusCode === 416 && offset > 0) {
          res.resume();
          // Offset exceeded remote size or already complete; restart cleanly from 0
          try {
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
          } catch {}
          startRequest(targetUrl, 0, redirectsLeft);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          activeDirectDownloads.delete(task.id);
          return onError(`HTTP ${statusCode} returned from remote server.`);
        }

        const isPartial = statusCode === 206;
        let downloadedBytes = isPartial ? offset : 0;
        let totalBytes = 0;

        const contentRange = res.headers['content-range'];
        if (isPartial && typeof contentRange === 'string') {
          const m = contentRange.match(/\/(\d+)$/);
          if (m) totalBytes = parseInt(m[1], 10) || 0;
        }
        if (!totalBytes && res.headers['content-length']) {
          const cl = parseInt(String(res.headers['content-length']), 10) || 0;
          totalBytes = isPartial ? downloadedBytes + cl : cl;
        }

        writeStream = fs.createWriteStream(partPath, {
          flags: isPartial ? 'a' : 'w',
        });

        let lastEmitMs = 0;
        let windowStartMs = Date.now();
        let windowBytes = 0;

        const emitMetrics = (force = false) => {
          const now = Date.now();
          if (!force && now - lastEmitMs < 250) return;
          lastEmitMs = now;
          const computed = tracker.update({
            downloadedBytes,
            totalBytes,
            activeConnections: 1,
            nowMs: now,
          });
          onProgress({
            status: 'downloading',
            current_phase: isPartial && offset > 0 ? 'Resuming direct stream' : 'Downloading',
            ...computed,
          });
        };

        emitMetrics(true);

        res.on('data', (chunk: Buffer) => {
          if (control.aborted) return;
          downloadedBytes += chunk.length;
          windowBytes += chunk.length;

          if (writeStream && !writeStream.write(chunk)) {
            res.pause();
            writeStream.once('drain', () => {
              if (!control.aborted) res.resume();
            });
          }

          if (maxBytesPerSec > 0) {
            const elapsedMs = Math.max(1, Date.now() - windowStartMs);
            const expectedMs = (windowBytes / maxBytesPerSec) * 1000;
            if (expectedMs > elapsedMs) {
              const delayMs = Math.min(1000, Math.round(expectedMs - elapsedMs));
              res.pause();
              setTimeout(() => {
                windowStartMs = Date.now();
                windowBytes = 0;
                if (!control.aborted) res.resume();
              }, delayMs);
            }
          }

          emitMetrics(false);
        });

        res.on('end', () => {
          if (control.aborted) {
            try {
              writeStream?.end();
            } catch {}
            return;
          }

          writeStream?.end(async () => {
            activeDirectDownloads.delete(task.id);
            try {
              const partStat = fs.statSync(partPath);
              if (!partStat.isFile() || partStat.size <= 0) {
                return onError('Downloaded file is missing or empty (0 bytes).');
              }
              if (totalBytes > 0 && partStat.size < totalBytes) {
                return onError(
                  `Incomplete download: received ${partStat.size} of ${totalBytes} bytes.`
                );
              }

              if (conflictStrategy === 'overwrite' && fs.existsSync(destination.targetPath)) {
                fs.unlinkSync(destination.targetPath);
              }
              fs.renameSync(partPath, destination.targetPath);

              const finalStat = fs.statSync(destination.targetPath);
              const computedFinal = tracker.update({
                downloadedBytes: finalStat.size,
                totalBytes: finalStat.size,
                activeConnections: 0,
              });

              onProgress({
                status: 'verifying',
                current_phase: 'Verifying file integrity on disk...',
                ...computedFinal,
              });

              const fileHash = await new Promise<string>((resolveHash, rejectHash) => {
                const hash = crypto.createHash('sha256');
                const rs = fs.createReadStream(destination.targetPath);
                rs.on('data', (d) => hash.update(d));
                rs.on('end', () => resolveHash(hash.digest('hex')));
                rs.on('error', rejectHash);
              });

              const expected = task.expected_sha256?.trim().toLowerCase();
              if (expected && expected !== fileHash.toLowerCase()) {
                return onError(
                  `SHA-256 checksum mismatch: expected ${expected.slice(0, 12)}..., got ${fileHash.slice(0, 12)}...`
                );
              }

              onComplete(destination.targetPath, {
                total_bytes: finalStat.size,
                downloaded_bytes: finalStat.size,
                remaining_bytes: 0,
                progress_percentage: 100,
                percentage_known: true,
                verified_sha256: fileHash,
                checksum_verified: expected ? expected === fileHash.toLowerCase() : null,
                ...buildIdleMetricsPatch({
                  ...task,
                  total_bytes: finalStat.size,
                  downloaded_bytes: finalStat.size,
                }),
                eta_str: 'Finished',
              });
            } catch (err: any) {
              onError(`Verification error: ${sanitizeLog(err?.message || 'Unknown error')}`);
            }
          });
        });

        res.on('error', (err) => {
          if (control.aborted) return;
          activeDirectDownloads.delete(task.id);
          try {
            writeStream?.end();
          } catch {}
          onError(`Stream error: ${sanitizeLog(err.message)}`);
        });
      }
    );

    currentReq = req;
    req.on('timeout', () => {
      if (control.aborted) return;
      req.destroy(new Error('HTTP connection timed out after 30s.'));
    });

    req.on('error', (err) => {
      if (control.aborted) return;
      activeDirectDownloads.delete(task.id);
      try {
        writeStream?.end();
      } catch {}
      onError(`Network error: ${sanitizeLog(err.message)}`);
    });

    req.end();
  };

  startRequest(task.url, existingOffset, 5);
}
