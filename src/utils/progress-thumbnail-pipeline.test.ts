import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DownloadTask } from '../types';
import { MediaThumbnail } from '../components/MediaThumbnail';
import { ProgressDisplay } from '../components/ProgressDisplay';
import { DownloadCenterView } from '../components/DownloadCenterView';
import { DownloadDetailsDrawer } from '../components/DownloadDetailsDrawer';

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: `task_${Math.random().toString(36).slice(2, 8)}`,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Sample Engineering Lecture',
    engine: 'yt-dlp',
    status: 'queued',
    priority: 'normal',
    queue_order: 1,
    format_id: 'best',
    ext: 'mp4',
    is_audio_only: false,
    output_path: '',
    progress_percentage: 0,
    percentage_known: true,
    downloaded_bytes: 0,
    total_bytes: 0,
    remaining_bytes: 0,
    speed_str: '0 B/s',
    speed_bytes_per_sec: 0,
    avg_speed_bytes_per_sec: 0,
    eta_str: '--',
    eta_seconds: null,
    active_connections: 0,
    elapsed_seconds: 0,
    current_phase: 'Queued',
    retries: 0,
    max_retries: 3,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function writeExecutableNodeScript(filePath: string, body: string): void {
  const content = `#!${process.execPath}\n${body}\n`;
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

test('Pipeline: EngineManager, DB thumbnail preservation, yt-dlp/spotDL progress & UI rendering', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-pipe-'));
  const prevDataDir = process.env.VANTA_DATA_DIR;
  process.env.VANTA_DATA_DIR = tempRoot;

  const downloadsDir = path.join(tempRoot, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  const mockYtdlpPath = path.join(tempRoot, 'mock-ytdlp');
  const mockSpotdlPath = path.join(tempRoot, 'mock-spotdl');

  writeExecutableNodeScript(
    mockYtdlpPath,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const url = args[args.length - 1] || '';

    if (args.includes('--version')) {
      process.stdout.write('2026.10.21\\n');
      process.exit(0);
    }

    if (url.includes('fail-no-progress')) {
      process.stderr.write('ERROR: Video unavailable: private stream\\n');
      process.exit(1);
    }

    const outFlagIdx = args.indexOf('-o');
    const outPattern = outFlagIdx >= 0 ? args[outFlagIdx + 1] : path.join(${JSON.stringify(downloadsDir)}, 'out.%(ext)s');
    const outDir = path.dirname(outPattern);

    if (url.includes('unknown-size')) {
      const target = path.join(outDir, 'unknown-stream.mp4');
      process.stdout.write('[download] Destination: ' + target + '\\r');
      setTimeout(() => {
        process.stderr.write('NA|1.5MiB|NA|NA|512.0KiB/s|Unknown|downloading\\r');
      }, 40);
      setTimeout(() => {
        fs.writeFileSync(target, Buffer.alloc(65536, 1));
        process.stdout.write('VANTA_OUTPUT_FILE:' + target + '\\n');
        process.exit(0);
      }, 120);
      return;
    }

    const target = path.join(outDir, 'sample-lecture.mp4');
    process.stdout.write('VANTA_META:vid123\\tReal Video Title\\tTech Channel\\t180\\thttps://i.ytimg.com/vi/vid123/maxresdefault.jpg\\n');
    setTimeout(() => {
      process.stdout.write('[download] Destination: ' + path.join(outDir, 'video.f137.mp4') + '\\r');
      process.stdout.write('25.0%|2.5MiB|');
      setTimeout(() => {
        process.stdout.write('NA|~ 10.0MiB|2.5MiB/s|00:03|downloading\\r');
      }, 25);
    }, 30);

    setTimeout(() => {
      // Switch to audio stream (resetStream) with smaller total size
      process.stdout.write('[download] Destination: ' + path.join(outDir, 'audio.f140.m4a') + '\\n');
      process.stderr.write('50.0%|512.0KiB|1.0MiB|1.0MiB|1.0MiB/s|00:01|downloading\\n');
    }, 90);

    setTimeout(() => {
      process.stdout.write('[Merger] Merging formats into "' + target + '"\\n');
      fs.writeFileSync(target, Buffer.alloc(131072, 7));
      process.stdout.write('VANTA_OUTPUT_FILE:' + target + '\\n');
      process.exit(0);
    }, 150);
  `
  );

  writeExecutableNodeScript(
    mockSpotdlPath,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      process.stdout.write('4.2.8\\n');
      process.exit(0);
    }

    const outIdx = args.indexOf('--output');
    const outTemplate = outIdx >= 0 ? args[outIdx + 1] : path.join(${JSON.stringify(downloadsDir)}, 'track.mp3');
    const outDir = path.dirname(outTemplate);
    fs.mkdirSync(outDir, { recursive: true });
    const targetUrl = args.find((a) => a.startsWith('http') || a.startsWith('spotify:')) || args[1] || '';

    if (targetUrl.includes('track-fail')) {
      process.stderr.write('LookupError: Track unavailable on provider\\n');
      process.exit(1);
    }

    const filename = path.basename(outTemplate)
      .replace('{artists}', 'Artist')
      .replace('{title}', targetUrl.includes('track-2') ? 'TrackTwo' : 'TrackOne')
      .replace('{output-ext}', 'mp3');
    const dest = path.join(outDir, filename);

    process.stdout.write('Searching for audio match...\\n');
    setTimeout(() => {
      process.stdout.write('Downloading track audio\\n');
      fs.writeFileSync(dest, Buffer.alloc(32768, 3));
    }, 80);

    setTimeout(() => {
      fs.appendFileSync(dest, Buffer.alloc(65536, 4));
    }, 280);

    setTimeout(() => {
      process.stdout.write('Embedding metadata and cover art\\n');
      fs.appendFileSync(dest, Buffer.alloc(16384, 5));
      process.exit(0);
    }, 520);
  `
  );

  const dbMod = await import('../../server/db');
  const engineMod = await import('../../server/engineManager');
  const qcMod = await import('../../server/queueController');
  // Stop background 1s queue scheduler so subtests don't race against the default engineManager singleton
  qcMod.queueController.destroy();

  const settings = dbMod.getSettings();
  settings.download_dir = downloadsDir;
  settings.verify_media_on_complete = false;
  dbMod.saveSettings(settings);

  const engine = new engineMod.EngineManager({
    executables: {
      'yt-dlp': mockYtdlpPath,
      spotdl: mockSpotdlPath,
    },
  });

  t.after(() => {
    qcMod.queueController.destroy();
    if (prevDataDir === undefined) {
      delete process.env.VANTA_DATA_DIR;
    } else {
      process.env.VANTA_DATA_DIR = prevDataDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // 1. yt-dlp chunked stdout + stderr progress, VANTA_META, dual stream reset & completion
  await t.test('yt-dlp chunked stdout/stderr streaming updates real progress and preserves thumbnail', async () => {
    const task = makeTask({
      id: 'yt_stream_1',
      url: 'https://www.youtube.com/watch?v=vid123',
      title: 'Inspecting https://www.youtube.com/watch?v=vid123...',
      thumbnail: undefined,
      output_path: downloadsDir,
    });
    dbMod.upsertTask(task);

    const progressUpdates: Partial<DownloadTask>[] = [];
    let completedOutPath = '';
    let completedExtra: Partial<DownloadTask> | undefined;
    let failedError: string | null = null;

    await new Promise<void>((resolve) => {
      engine.startDownload(
        task,
        settings,
        (p) => progressUpdates.push(p),
        (outputPath, extra) => {
          completedOutPath = outputPath;
          completedExtra = extra;
          resolve();
        },
        (err) => {
          failedError = err;
          resolve();
        }
      );
    });

    assert.equal(failedError, null);
    assert.ok(completedOutPath.endsWith('sample-lecture.mp4'));
    assert.equal(completedExtra?.total_bytes, 131072);
    assert.ok(
      progressUpdates.some(
        (m) => m.title === 'Real Video Title' && m.thumbnail?.includes('maxresdefault.jpg')
      )
    );
    assert.ok(progressUpdates.some((p) => (p.progress_percentage ?? 0) === 25));
    assert.ok(
      progressUpdates.some(
        (p) => Math.abs((p.progress_percentage ?? 0) - 50) < 0.2 && p.total_bytes === 1048576
      )
    );
    assert.ok(progressUpdates.some((p) => p.status === 'muxing'));
  });

  // 2. Unknown total size: emits real downloaded bytes & percentage_known=false (no fake %)
  await t.test('yt-dlp unknown total size reports downloaded_bytes without fake percentage', async () => {
    const task = makeTask({
      id: 'yt_unknown_1',
      url: 'https://example.com/unknown-size',
      title: 'Unknown Size Stream',
      output_path: downloadsDir,
    });
    dbMod.upsertTask(task);

    const updates: Partial<DownloadTask>[] = [];
    let completed = false;

    await new Promise<void>((resolve, reject) => {
      engine.startDownload(
        task,
        settings,
        (p) => updates.push(p),
        () => {
          completed = true;
          resolve();
        },
        (e) => reject(new Error(e))
      );
    });

    assert.equal(completed, true);
    const unknownPatch = updates.find((u) => (u.downloaded_bytes ?? 0) > 1_000_000);
    assert.ok(unknownPatch, 'Expected downloaded bytes update from stderr unknown-size template');
    assert.equal(unknownPatch.percentage_known, false);
    assert.equal(unknownPatch.progress_percentage, 0);
  });

  // 3. Non-zero exit without progress fails with stderr error message
  await t.test('yt-dlp non-zero exit before progress fails cleanly', async () => {
    const task = makeTask({
      id: 'yt_fail_1',
      url: 'https://www.youtube.com/watch?v=fail-no-progress',
      title: 'Private Stream',
      output_path: downloadsDir,
    });
    dbMod.upsertTask(task);

    const errMsg = await new Promise<string>((resolve, reject) => {
      engine.startDownload(
        task,
        settings,
        () => {},
        () => reject(new Error('Expected failure')),
        (e) => resolve(e)
      );
    });

    assert.ok(errMsg.includes('private stream'));
  });

  // 4. spotDL single track: observes filesystem growth and measured speed
  await t.test('spotDL single track observes directory growth bytes and live speed', async () => {
    const spotDir = path.join(downloadsDir, 'spot_single');
    fs.mkdirSync(spotDir, { recursive: true });
    const task = makeTask({
      id: 'spot_single_1',
      url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      title: 'Spotify Single Track',
      engine: 'spotdl',
      ext: 'mp3',
      is_audio_only: true,
      output_path: spotDir,
    });
    dbMod.upsertTask(task);

    const updates: Partial<DownloadTask>[] = [];
    let completedExtra: Partial<DownloadTask> | undefined;

    await new Promise<void>((resolve, reject) => {
      engine.startDownload(
        task,
        settings,
        (p) => updates.push(p),
        (_outputPath, extra) => {
          completedExtra = extra;
          resolve();
        },
        (e) => reject(new Error(e))
      );
    });

    assert.equal(completedExtra?.total_bytes, 32768 + 65536 + 16384);
    assert.ok(
      updates.some((u) => (u.downloaded_bytes ?? 0) > 0 && u.percentage_known === false),
      'Expected spotDL directory growth progress'
    );
  });

  // 5. spotDL multi-track partial failure does not report 100% completion
  await t.test('spotDL multi-track playlist reports failure honestly when a track fails', async () => {
    const playlistDir = path.join(downloadsDir, 'spot_playlist');
    fs.mkdirSync(playlistDir, { recursive: true });
    const task = makeTask({
      id: 'spot_pl_1',
      url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      title: 'Mixed Playlist',
      engine: 'spotdl',
      ext: 'mp3',
      is_audio_only: true,
      content_type: 'playlist',
      selected_items: [
        'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
        'https://open.spotify.com/track/track-fail-missing',
      ],
      output_path: playlistDir,
    });
    dbMod.upsertTask(task);

    const updates: Partial<DownloadTask>[] = [];
    const errMsg = await new Promise<string>((resolve, reject) => {
      engine.startDownload(
        task,
        settings,
        (p) => updates.push(p),
        () => reject(new Error('Expected partial failure error instead of false completion')),
        (e) => resolve(e)
      );
    });

    assert.ok(errMsg.includes('1 of 2 tracks succeeded; 1 failed'));
    assert.ok(updates.some((u) => u.tracks_completed === 1 && u.tracks_failed === 1));
  });

  // 6. DB thumbnail/metadata preservation & QueueController enrichTaskMetadata
  await t.test('DB mergeTaskUpdate and SQLite persistence preserve thumbnails across partial updates', () => {
    const original = makeTask({
      id: 'thumb_keep_1',
      title: 'High Quality Documentary',
      thumbnail: 'https://i.ytimg.com/vi/xyz/maxresdefault.jpg',
      uploader: 'Science Desk',
      duration: 600,
      duration_string: '10:00',
    });
    dbMod.upsertTask(original);

    const merged = dbMod.mergeTaskUpdate(original, {
      title: 'Loading...',
      thumbnail: undefined,
      uploader: undefined,
      status: 'failed',
      error_message: 'Network timeout',
    });
    dbMod.upsertTask(merged);

    const reloaded = dbMod.getTaskById('thumb_keep_1');
    assert.ok(reloaded);
    assert.equal(reloaded.thumbnail, 'https://i.ytimg.com/vi/xyz/maxresdefault.jpg');
    assert.equal(reloaded.title, 'High Quality Documentary');
    assert.equal(reloaded.uploader, 'Science Desk');
    assert.equal(reloaded.status, 'failed');

    // Enrich a task lacking a thumbnail and having a placeholder title
    const stub = makeTask({
      id: 'thumb_enrich_1',
      title: 'Queued video URL',
      thumbnail: undefined,
    });
    dbMod.upsertTask(stub);
    qcMod.queueController.enrichTaskMetadata('thumb_enrich_1', {
      id: 'xyz',
      title: 'Resolved Video Name',
      url: stub.url,
      uploader: 'Creator Hub',
      duration: 125,
      duration_string: '02:05',
      thumbnail: 'https://i.ytimg.com/vi/xyz/maxresdefault.jpg',
      is_playlist: false,
      extractor: 'youtube',
      formats: [],
    });
    const enriched = dbMod.getTaskById('thumb_enrich_1');
    assert.equal(enriched?.title, 'Resolved Video Name');
    assert.equal(enriched?.thumbnail, 'https://i.ytimg.com/vi/xyz/maxresdefault.jpg');
    assert.equal(enriched?.uploader, 'Creator Hub');
    assert.equal(enriched?.duration_string, '02:05');
  });

  // 7. React component SSR rendering assertions
  await t.test('UI components render genuine thumbnails, honest unknown-size progress, and drawer metadata', () => {
    const validThumbHtml = renderToStaticMarkup(
      React.createElement(MediaThumbnail, {
        src: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
        title: 'Demo Video',
      })
    );
    assert.ok(validThumbHtml.includes('<img '));
    assert.ok(validThumbHtml.includes('https://i.ytimg.com/vi/abc/maxresdefault.jpg'));
    assert.ok(validThumbHtml.includes('referrerPolicy="no-referrer"') || validThumbHtml.includes('referrerpolicy="no-referrer"'));

    const badThumbHtml = renderToStaticMarkup(
      React.createElement(MediaThumbnail, {
        src: 'javascript:alert(1)',
        title: 'Demo Video',
        ext: 'mp4',
      })
    );
    assert.equal(badThumbHtml.includes('<img'), false);
    assert.ok(badThumbHtml.includes('MP4'));

    const unknownProgressHtml = renderToStaticMarkup(
      React.createElement(ProgressDisplay, {
        task: makeTask({
          status: 'downloading',
          percentage_known: false,
          downloaded_bytes: 5_242_880,
          total_bytes: 0,
          speed_bytes_per_sec: 1_048_576,
          speed_str: '1.0 MB/s',
          eta_str: '--',
          current_phase: 'Downloading audio stream...',
        }),
      })
    );
    assert.ok(unknownProgressHtml.includes('ETA: Unknown'));
    assert.ok(unknownProgressHtml.includes('--%'));
    assert.ok(unknownProgressHtml.includes('5.0 MB'));
    assert.ok(unknownProgressHtml.includes('1.0 MB/s'));

    const knownProgressHtml = renderToStaticMarkup(
      React.createElement(ProgressDisplay, {
        task: makeTask({
          status: 'downloading',
          percentage_known: true,
          progress_percentage: 42.5,
          downloaded_bytes: 4_250_000,
          total_bytes: 10_000_000,
          remaining_bytes: 5_750_000,
          speed_bytes_per_sec: 500_000,
          speed_str: '500.0 KB/s',
          eta_str: '00:12',
          current_phase: 'Downloading media stream...',
        }),
      })
    );
    assert.ok(knownProgressHtml.includes('42.5%'));
    assert.ok(knownProgressHtml.includes('500.0 KB/s'));
    assert.ok(knownProgressHtml.includes('ETA 00:12'));

    const queueHtml = renderToStaticMarkup(
      React.createElement(DownloadCenterView, {
        tasks: [
          makeTask({
            id: 'q1',
            title: 'Real 4K Test',
            thumbnail: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
            uploader: 'Studio Lab',
            duration_string: '04:20',
            resolution_label: '2160p',
          }),
        ],
        engineStatus: null,
        scopeFilter: 'all',
        setScopeFilter: () => {},
        searchQuery: '',
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenNewDownload: () => {},
        onPauseTask: () => {},
        onResumeTask: () => {},
        onCancelTask: () => {},
        onRetryTask: () => {},
        onDeleteTask: () => {},
        onPauseAll: () => {},
        onResumeAll: () => {},
        onClearCompleted: () => {},
        onClearFailed: () => {},
      })
    );
    assert.ok(queueHtml.includes('https://i.ytimg.com/vi/abc/maxresdefault.jpg'));
    assert.equal(queueHtml.includes('w-12 h-9 shrink-0 hidden sm:block'), false);

    const drawerHtml = renderToStaticMarkup(
      React.createElement(DownloadDetailsDrawer, {
        task: makeTask({
          title: 'Inspected Track',
          thumbnail: 'https://i.scdn.co/image/ab67616d0000b273cover',
          uploader: 'The Artist',
          album: 'Night Drive',
          duration_string: '03:45',
          is_audio_only: true,
          engine: 'spotdl',
          ext: 'mp3',
        }),
        onClose: () => {},
        onRetryTask: () => {},
      })
    );
    assert.ok(drawerHtml.includes('https://i.scdn.co/image/ab67616d0000b273cover'));
    assert.ok(drawerHtml.includes('The Artist'));
    assert.ok(drawerHtml.includes('Night Drive'));
    assert.ok(drawerHtml.includes('03:45'));
  });
});
