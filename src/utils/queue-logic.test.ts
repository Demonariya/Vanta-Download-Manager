import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionTask,
  sortQueue,
  getActiveDownloadCount,
  calculateAggregateSpeed,
  shouldAutoRetry,
  moveTaskOrder,
  filterAndSortTasks,
  computeHistoryStats,
} from './queue-logic';
import { DownloadTask } from '../types';

function makeTask(id: string, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id,
    url: `https://example.com/video/${id}`,
    title: `Task ${id}`,
    engine: 'yt-dlp',
    status: 'queued',
    progress_percentage: 0,
    speed_str: '0 B/s',
    speed_bytes_per_sec: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    eta_str: '--',
    current_phase: 'queued',
    format_id: 'best',
    ext: 'mp4',
    is_audio_only: false,
    output_path: '/downloads',
    priority: 'normal',
    created_at: '2026-10-23T10:00:00Z',
    retries: 0,
    max_retries: 3,
    ...overrides,
  };
}

test('canTransitionTask validates legitimate transitions and blocks illegal jumps', () => {
  assert.equal(canTransitionTask('queued', 'connecting'), true);
  assert.equal(canTransitionTask('connecting', 'downloading'), true);
  assert.equal(canTransitionTask('downloading', 'muxing'), true);
  assert.equal(canTransitionTask('muxing', 'verifying'), true);
  assert.equal(canTransitionTask('verifying', 'completed'), true);
  assert.equal(canTransitionTask('downloading', 'paused'), true);
  assert.equal(canTransitionTask('paused', 'queued'), true);
  assert.equal(canTransitionTask('failed', 'queued'), true);

  assert.equal(canTransitionTask('queued', 'completed'), false);
  assert.equal(canTransitionTask('cancelled', 'downloading'), false);
  assert.equal(canTransitionTask('completed', 'failed'), false);
});

test('sortQueue orders tasks by priority first, then queue_order, then timestamp', () => {
  const t1 = makeTask('1', { priority: 'normal', created_at: '2026-10-23T10:00:00Z' });
  const t2 = makeTask('2', { priority: 'highest', created_at: '2026-10-23T10:05:00Z' });
  const t3 = makeTask('3', { priority: 'high', created_at: '2026-10-23T10:02:00Z' });
  const t4 = makeTask('4', { priority: 'highest', created_at: '2026-10-23T09:00:00Z' });

  const sorted = sortQueue([t1, t2, t3, t4]);
  assert.equal(sorted[0].id, '4');
  assert.equal(sorted[1].id, '2');
  assert.equal(sorted[2].id, '3');
  assert.equal(sorted[3].id, '1');
});

test('moveTaskOrder swaps task position cleanly up and down', () => {
  const tasks = [
    makeTask('a', { queue_order: 1, created_at: '2026-10-23T09:00:00Z' }),
    makeTask('b', { queue_order: 2, created_at: '2026-10-23T09:01:00Z' }),
    makeTask('c', { queue_order: 3, created_at: '2026-10-23T09:02:00Z' }),
  ];

  const movedUp = moveTaskOrder(tasks, 'c', 'up');
  assert.deepEqual(
    movedUp.map((t) => t.id),
    ['a', 'c', 'b']
  );

  const movedDown = moveTaskOrder(movedUp, 'a', 'down');
  assert.deepEqual(
    movedDown.map((t) => t.id),
    ['c', 'a', 'b']
  );
});

test('getActiveDownloadCount counts all active FSM states', () => {
  const tasks = [
    { status: 'downloading' },
    { status: 'connecting' },
    { status: 'muxing' },
    { status: 'verifying' },
    { status: 'queued' },
    { status: 'completed' },
    { status: 'paused' },
    { status: 'processing' },
  ] as DownloadTask[];

  assert.equal(getActiveDownloadCount(tasks), 5);
});

test('calculateAggregateSpeed sums speeds of downloading tasks', () => {
  const tasks = [
    { status: 'downloading', speed_bytes_per_sec: 1048576 * 2 },
    { status: 'downloading', speed_bytes_per_sec: 1048576 * 3 },
    { status: 'paused', speed_bytes_per_sec: 1048576 * 10 },
  ] as DownloadTask[];

  const result = calculateAggregateSpeed(tasks);
  assert.equal(result.speedBytesPerSec, 1048576 * 5);
  assert.equal(result.formattedSpeed, '5.0 MB/s');
});

test('shouldAutoRetry checks retry limit', () => {
  const task = makeTask('r', { status: 'failed', retries: 1 });
  assert.equal(shouldAutoRetry(task, 3), true);
  task.retries = 3;
  assert.equal(shouldAutoRetry(task, 3), false);
});

test('filterAndSortTasks and computeHistoryStats derive exact real totals', () => {
  const tasks = [
    makeTask('1', {
      title: 'Alpha Video',
      status: 'completed',
      total_bytes: 1000,
      elapsed_seconds: 10,
      category_id: 'cat_video',
    }),
    makeTask('2', {
      title: 'Beta Track',
      status: 'completed',
      is_audio_only: true,
      total_bytes: 2000,
      elapsed_seconds: 20,
      category_id: 'cat_music',
    }),
    makeTask('3', {
      title: 'Broken Stream',
      status: 'failed',
      total_bytes: 500,
    }),
  ];

  const audioOnly = filterAndSortTasks(tasks, { statusFilter: 'audio' });
  assert.equal(audioOnly.length, 1);
  assert.equal(audioOnly[0].id, '2');

  const stats = computeHistoryStats(tasks);
  assert.equal(stats.totalCompleted, 2);
  assert.equal(stats.totalFailed, 1);
  assert.equal(stats.totalBytesDownloaded, 3000);
  assert.equal(stats.totalElapsedSeconds, 30);
  assert.equal(stats.meanSpeedBytesPerSec, 100);
});
