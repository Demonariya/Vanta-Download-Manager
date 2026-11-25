import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProgressTracker,
  buildIdleMetricsPatch,
  clampPercentage,
  isActiveTaskStatus,
  isTerminalTaskStatus,
} from './download-core';
import { resolveVideoFormatSelector, buildCuratedVideoOptions } from './media-formats';
import { isWithinSchedulerWindow } from './scheduler';
import { DownloadTask } from '../types';

test('ProgressTracker calculates determinate progress, EMA speed, remaining bytes, and ETA', () => {
  const tracker = new ProgressTracker({ alpha: 0.5, startedAtMs: 1000 });
  const s1 = tracker.update({
    downloadedBytes: 500_000,
    totalBytes: 2_000_000,
    nowMs: 2000,
  });

  assert.equal(s1.percentage_known, true);
  assert.equal(s1.progress_percentage, 25);
  assert.equal(s1.remaining_bytes, 1_500_000);
  assert.equal(s1.speed_bytes_per_sec, 500_000);
  assert.equal(s1.eta_seconds, 3);
  assert.equal(s1.elapsed_seconds, 1);

  const s2 = tracker.update({
    downloadedBytes: 1_500_000,
    totalBytes: 2_000_000,
    nowMs: 3000,
  });
  // Instant speed = 1_000_000, EMA = 0.5 * 1_000_000 + 0.5 * 500_000 = 750_000
  assert.equal(s2.speed_bytes_per_sec, 750_000);
  assert.equal(s2.progress_percentage, 75);
  assert.equal(s2.remaining_bytes, 500_000);
});

test('ProgressTracker handles unknown total size without fabricating percentage or ETA', () => {
  const tracker = new ProgressTracker({ startedAtMs: 1000 });
  const state = tracker.update({
    downloadedBytes: 256_000,
    totalBytes: 0,
    nowMs: 2000,
  });

  assert.equal(state.percentage_known, false);
  assert.equal(state.progress_percentage, 0);
  assert.equal(state.eta_seconds, null);
  assert.equal(state.eta_str, '--');
  assert.equal(state.speed_bytes_per_sec, 256_000);
});

test('clampPercentage and buildIdleMetricsPatch reset transient speed/ETA cleanly', () => {
  assert.equal(clampPercentage(140), 100);
  assert.equal(clampPercentage(-5), 0);
  assert.equal(isActiveTaskStatus('muxing'), true);
  assert.equal(isTerminalTaskStatus('completed'), true);

  const patch = buildIdleMetricsPatch({
    downloaded_bytes: 400,
    total_bytes: 1000,
  } as DownloadTask);

  assert.equal(patch.speed_bytes_per_sec, 0);
  assert.equal(patch.speed_str, '0 B/s');
  assert.equal(patch.eta_seconds, null);
  assert.equal(patch.eta_str, '--');
  assert.equal(patch.remaining_bytes, 600);
});

test('resolveVideoFormatSelector and buildCuratedVideoOptions always pair video-only streams with audio', () => {
  const formats = [
    { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', is_video_only: true },
    { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', is_video_only: false },
  ];

  assert.equal(resolveVideoFormatSelector('137', formats), '137+bestaudio/best');
  assert.equal(resolveVideoFormatSelector('18', formats), '18');
  assert.equal(resolveVideoFormatSelector('best', formats), 'bestvideo+bestaudio/best');

  const curated = buildCuratedVideoOptions(formats);
  const highQuality = curated.find((option) => option.height === 1080);
  assert.ok(highQuality);
  assert.equal(highQuality.needsMux, true);
  assert.match(highQuality.formatSelector, /^137\\+bestaudio\\//);
  assert.match(highQuality.formatSelector, /bestvideo\\[height<=1080\\]\\+bestaudio/);
});

test('Scheduler evaluates overnight and active download windows deterministically', () => {
  const overnight = {
    enabled: true,
    start_time: '23:00',
    stop_time: '06:00',
    pause_on_stop: true,
    days: [0, 1, 2, 3, 4, 5, 6],
  };
  assert.equal(isWithinSchedulerWindow(overnight, new Date('2026-10-23T23:30:00')), true);
  assert.equal(isWithinSchedulerWindow(overnight, new Date('2026-10-24T04:00:00')), true);
  assert.equal(isWithinSchedulerWindow(overnight, new Date('2026-10-24T12:00:00')), false);
});

test('ProgressTracker.resetStream cleanly transitions from video stream to smaller audio stream', () => {
  const tracker = new ProgressTracker({ startedAtMs: 1000 });
  const videoDone = tracker.update({
    downloadedBytes: 10_000_000,
    totalBytes: 10_000_000,
    nowMs: 3000,
  });
  assert.equal(videoDone.progress_percentage, 100);

  tracker.resetStream();
  const audioStart = tracker.update({
    downloadedBytes: 250_000,
    totalBytes: 1_000_000,
    nowMs: 4000,
  });
  assert.equal(audioStart.downloaded_bytes, 250_000);
  assert.equal(audioStart.total_bytes, 1_000_000);
  assert.equal(audioStart.progress_percentage, 25);
});

