import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectDirectUrl, executeDirectDownload } from '../../server/directDownloader';
import { AppSettings, DownloadTask } from '../types';

const PAYLOAD = Buffer.from('VANTA-DIRECT-DOWNLOAD-INTEGRATION-PAYLOAD-'.repeat(64));
const PAYLOAD_SHA256 = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function makeSettings(downloadDir: string): AppSettings {
  return {
    download_dir: downloadDir,
    max_concurrent_downloads: 2,
    fragment_concurrency: 4,
    global_bandwidth_limit_kbps: 0,
    per_task_bandwidth_limit_kbps: 0,
    max_retries: 1,
    retry_delay_seconds: 1,
    default_video_format: 'mp4',
    default_audio_format: 'mp3',
    default_audio_bitrate: '320k',
    embed_thumbnail: false,
    embed_metadata: false,
    filename_template: '%(title)s.%(ext)s',
    proxy_url: '',
    floating_notifications_enabled: true,
    auto_dismiss_seconds: 5,
    theme: 'dark',
    auto_retry_failed: false,
    auto_resume_on_startup: false,
    conflict_strategy: 'rename',
  };
}

function makeTask(id: string, url: string, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id,
    url,
    title: 'test_payload',
    engine: 'direct',
    status: 'queued',
    progress_percentage: 0,
    speed_str: '0 B/s',
    speed_bytes_per_sec: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    eta_str: '--',
    current_phase: 'Queued',
    format_id: 'direct',
    ext: 'bin',
    is_audio_only: false,
    output_path: '',
    priority: 'normal',
    created_at: new Date().toISOString(),
    retries: 0,
    max_retries: 1,
    ...overrides,
  };
}

describe('Direct HTTP Downloader integration against local HTTP server', () => {
  let server: http.Server;
  let baseUrl = '';
  let tempDir = '';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-direct-test-'));
    server = http.createServer((req, res) => {
      if (req.url === '/archive.zip') {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="release-bundle.zip"');
        res.setHeader('Accept-Ranges', 'bytes');

        const rangeHeader = req.headers.range;
        if (rangeHeader && rangeHeader.startsWith('bytes=')) {
          const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
          const start = parseInt(startStr, 10) || 0;
          const end = endStr ? Math.min(parseInt(endStr, 10), PAYLOAD.length - 1) : PAYLOAD.length - 1;
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
            res.end();
            return;
          }
          const slice = PAYLOAD.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${PAYLOAD.length}`,
            'Content-Length': String(slice.length),
          });
          res.end(slice);
          return;
        }

        res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(PAYLOAD);
        return;
      }

      if (req.url === '/chunked.bin') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.write(PAYLOAD.subarray(0, 500));
        setTimeout(() => {
          res.end(PAYLOAD.subarray(500));
        }, 20);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('inspects direct HTTP headers (filename, MIME, size, Accept-Ranges)', async () => {
    const meta = await inspectDirectUrl(`${baseUrl}/archive.zip`, makeSettings(tempDir));
    assert.equal(meta.is_direct_file, true);
    assert.equal(meta.direct_filename, 'release-bundle.zip');
    assert.equal(meta.direct_file_size, PAYLOAD.length);
    assert.equal(meta.direct_mime_type, 'application/zip');
    assert.equal(meta.accepts_ranges, true);
  });

  it('downloads full file and verifies matching SHA-256 digest', async () => {
    const dir = path.join(tempDir, 'full');
    const settings = makeSettings(dir);
    const task = makeTask('t_full', `${baseUrl}/archive.zip`, {
      custom_filename: 'release-bundle.zip',
      ext: 'zip',
      expected_sha256: PAYLOAD_SHA256,
    });

    const result = await new Promise<{ outputPath: string; extra?: Partial<DownloadTask> }>((resolve, reject) => {
      executeDirectDownload(
        task,
        settings,
        () => {},
        (outputPath, extra) => resolve({ outputPath, extra }),
        (err) => reject(new Error(err))
      );
    });

    assert.equal(fs.existsSync(result.outputPath), true);
    assert.deepEqual(fs.readFileSync(result.outputPath), PAYLOAD);
    assert.equal(result.extra?.verified_sha256, PAYLOAD_SHA256);
    assert.equal(result.extra?.checksum_verified, true);
  });

  it('fails loudly when expected SHA-256 does not match downloaded bytes', async () => {
    const dir = path.join(tempDir, 'badhash');
    const settings = makeSettings(dir);
    const task = makeTask('t_badhash', `${baseUrl}/archive.zip`, {
      custom_filename: 'bad.zip',
      ext: 'zip',
      expected_sha256: '0'.repeat(64),
    });

    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          executeDirectDownload(
            task,
            settings,
            () => {},
            () => resolve(),
            (err) => reject(new Error(err))
          );
        }),
      /SHA-256 checksum mismatch/i
    );
  });

  it('resumes cleanly from an existing .part file using HTTP Range 206', async () => {
    const dir = path.join(tempDir, 'resume');
    fs.mkdirSync(dir, { recursive: true });
    const partialBytes = PAYLOAD.subarray(0, 1024);
    fs.writeFileSync(path.join(dir, 'resumed.zip.part'), partialBytes);

    const settings = makeSettings(dir);
    const task = makeTask('t_resume', `${baseUrl}/archive.zip`, {
      custom_filename: 'resumed.zip',
      ext: 'zip',
      expected_sha256: PAYLOAD_SHA256,
    });

    const result = await new Promise<{ outputPath: string; extra?: Partial<DownloadTask> }>((resolve, reject) => {
      executeDirectDownload(
        task,
        settings,
        () => {},
        (outputPath, extra) => resolve({ outputPath, extra }),
        (err) => reject(new Error(err))
      );
    });

    assert.equal(fs.existsSync(result.outputPath), true);
    assert.equal(fs.existsSync(path.join(dir, 'resumed.zip.part')), false);
    assert.deepEqual(fs.readFileSync(result.outputPath), PAYLOAD);
    assert.equal(result.extra?.verified_sha256, PAYLOAD_SHA256);
  });

  it('handles chunked unknown-size responses without fabricating mid-stream percentage', async () => {
    const dir = path.join(tempDir, 'chunked');
    const settings = makeSettings(dir);
    const task = makeTask('t_chunked', `${baseUrl}/chunked.bin`, {
      custom_filename: 'chunked.bin',
      ext: 'bin',
    });

    const progressUpdates: Partial<DownloadTask>[] = [];
    const result = await new Promise<{ outputPath: string; extra?: Partial<DownloadTask> }>((resolve, reject) => {
      executeDirectDownload(
        task,
        settings,
        (u) => progressUpdates.push(u),
        (outputPath, extra) => resolve({ outputPath, extra }),
        (err) => reject(new Error(err))
      );
    });

    const downloadingUpdates = progressUpdates.filter((u) => u.status === 'downloading');
    assert.ok(downloadingUpdates.length >= 1);
    for (const u of downloadingUpdates) {
      assert.equal(u.percentage_known, false);
    }
    assert.deepEqual(fs.readFileSync(result.outputPath), PAYLOAD);
    assert.equal(result.extra?.total_bytes, PAYLOAD.length);
  });
});
