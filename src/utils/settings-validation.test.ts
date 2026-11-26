import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppSettings } from '../types';
import { validateSettingsForm } from './settings-validation';

const validSettings: AppSettings = {
  download_dir: 'C:/Downloads/VANTA',
  max_concurrent_downloads: 3,
  fragment_concurrency: 3,
  global_bandwidth_limit_kbps: 0,
  per_task_bandwidth_limit_kbps: 0,
  max_retries: 3,
  retry_delay_seconds: 5,
  default_video_format: 'best',
  default_audio_format: 'mp3',
  default_audio_bitrate: '320k',
  default_audio_sample_rate: 48000,
  default_audio_bit_depth: 24,
  embed_thumbnail: true,
  embed_metadata: true,
  filename_template: '%(title)s [%(id)s].%(ext)s',
  proxy_url: '',
  auto_dismiss_seconds: 5,
  theme: 'dark',
  auto_retry_failed: true,
  auto_resume_on_startup: true,
  launch_on_startup: false,
  start_minimized: false,
  clipboard_monitoring: false,
  conflict_strategy: 'rename',
  verify_media_on_complete: true,
  verify_fragments: true,
  tray_minimize_on_close: true,
  scheduler: {
    enabled: true,
    start_time: '22:00',
    stop_time: '06:00',
    pause_on_stop: true,
    days: [0, 1, 2, 3, 4, 5, 6],
  },
};

test('accepts valid application settings and supported proxy protocols', () => {
  assert.deepEqual(validateSettingsForm(validSettings), []);
  assert.deepEqual(
    validateSettingsForm({ ...validSettings, proxy_url: 'socks5h://127.0.0.1:1080' }),
    []
  );
});

test('rejects invalid download and connection limits', () => {
  const errors = validateSettingsForm({
    ...validSettings,
    download_dir: ' ',
    max_concurrent_downloads: 0,
    fragment_concurrency: 8,
    max_retries: 21,
    retry_delay_seconds: 0,
    global_bandwidth_limit_kbps: -1,
  });
  assert.ok(errors.some((error) => error.includes('destination folder')));
  assert.ok(errors.some((error) => error.includes('Simultaneous downloads')));
  assert.ok(errors.some((error) => error.includes('Fragment connections')));
  assert.ok(errors.some((error) => error.includes('Maximum retries')));
  assert.ok(errors.some((error) => error.includes('Retry delay')));
  assert.ok(errors.some((error) => error.includes('Global bandwidth')));
});

test('rejects malformed proxy URLs and unsupported formats', () => {
  const errors = validateSettingsForm({
    ...validSettings,
    proxy_url: 'ftp://proxy.example.com:21',
    default_video_format: 'avi',
    default_audio_format: 'aac',
  });
  assert.ok(errors.some((error) => error.includes('Proxy URL')));
  assert.ok(errors.some((error) => error.includes('video format')));
  assert.ok(errors.some((error) => error.includes('audio format')));
});

test('rejects invalid scheduler times and duplicate weekdays', () => {
  const errors = validateSettingsForm({
    ...validSettings,
    scheduler: {
      ...validSettings.scheduler!,
      start_time: '25:90',
      days: [1, 1, 7],
    },
  });
  assert.ok(errors.some((error) => error.includes('24-hour')));
  assert.ok(errors.some((error) => error.includes('weekdays')));
});
