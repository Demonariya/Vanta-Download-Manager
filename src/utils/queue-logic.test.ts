import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionTask,
  sortQueue,
  getActiveDownloadCount,
  calculateAggregateSpeed,
  shouldAutoRetry,
} from './queue-logic';
import { DownloadTask } from '../types';

test('canTransitionTask validates legitimate transitions and blocks illegal jumps', () => {
  // Valid transitions
  assert.equal(canTransitionTask('queued', 'extracting'), true);
  assert.equal(canTransitionTask('extracting', 'downloading'), true);
  assert.equal(canTransitionTask('downloading', 'processing'), true);
  assert.equal(canTransitionTask('processing', 'completed'), true);
  assert.equal(canTransitionTask('downloading', 'paused'), true);
  assert.equal(canTransitionTask('paused', 'queued'), true);
  assert.equal(canTransitionTask('failed', 'queued'), true);

  // Illegal transitions
  assert.equal(canTransitionTask('queued', 'completed'), false);
  assert.equal(canTransitionTask('extracting', 'paused'), false);
});

test('sortQueue orders tasks by priority first, then timestamp', () => {
  const dummyTask = (id: string, priority: any, createdAt: string): DownloadTask => ({
    id,
    url: 'https://example.com/video',
    title: `Task ${id}`,
    engine: 'yt-dlp',
    status: 'queued',
    progress_percentage: 0,
    speed_str: '0 B/s',
    speed_bytes_per_sec: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    eta_str: '--:--',
    current_phase: 'queued',
    format_id: 'best',
    ext: 'mp4',
    is_audio_only: false,
    output_path: '/downloads',
    priority,
    created_at: createdAt,
    retries: 0,
    max_retries: 3,
  });

  const t1 = dummyTask('1', 'normal', '2026-10-23T10:00:00Z');
  const t2 = dummyTask('2', 'highest', '2026-10-23T10:05:00Z');
  const t3 = dummyTask('3', 'high', '2026-10-23T10:02:00Z');
  const t4 = dummyTask('4', 'highest', '2026-10-23T09:00:00Z');

  const sorted = sortQueue([t1, t2, t3, t4]);
  // t4 and t2 are highest priority, t4 is older so comes first
  assert.equal(sorted[0].id, '4');
  assert.equal(sorted[1].id, '2');
  assert.equal(sorted[2].id, '3');
  assert.equal(sorted[3].id, '1');
});

test('getActiveDownloadCount counts only active states', () => {
  const tasks = [
    { status: 'downloading' },
    { status: 'extracting' },
    { status: 'queued' },
    { status: 'completed' },
    { status: 'paused' },
    { status: 'processing' },
  ] as DownloadTask[];

  assert.equal(getActiveDownloadCount(tasks), 3);
});

test('calculateAggregateSpeed sums speeds of downloading tasks', () => {
  const tasks = [
    { status: 'downloading', speed_bytes_per_sec: 1048576 * 2 }, // 2 MB/s
    { status: 'downloading', speed_bytes_per_sec: 1048576 * 3 }, // 3 MB/s
    { status: 'paused', speed_bytes_per_sec: 1048576 * 10 },     // ignored
  ] as DownloadTask[];

  const result = calculateAggregateSpeed(tasks);
  assert.equal(result.speedBytesPerSec, 1048576 * 5);
  assert.equal(result.formattedSpeed, '5.0 MB/s');
});

test('shouldAutoRetry checks retry limit', () => {
  const task = {
    status: 'failed',
    retries: 1,
  } as DownloadTask;

  assert.equal(shouldAutoRetry(task, 3), true);
  task.retries = 3;
  assert.equal(shouldAutoRetry(task, 3), false);
});
