import type { AppSettings } from '../types';

const VIDEO_FORMATS = new Set(['best', 'mp4', 'mkv', 'webm']);
const AUDIO_FORMATS = new Set(['mp3', 'm4a', 'opus', 'flac', 'wav']);
const AUDIO_BITRATES = new Set(['320k', '256k', '192k', '128k']);
const NOTIFICATION_DURATIONS = new Set([3, 5, 8, 10, 15, 30]);

export function validateSettingsForm(settings: AppSettings): string[] {
  const errors: string[] = [];
  const add = (condition: boolean, message: string) => {
    if (condition) errors.push(message);
  };

  add(!settings.download_dir.trim(), 'Download destination folder cannot be empty.');
  add(!Number.isInteger(settings.max_concurrent_downloads) || settings.max_concurrent_downloads < 1 || settings.max_concurrent_downloads > 16,
    'Simultaneous downloads must be between 1 and 16.');
  add(!Number.isInteger(settings.fragment_concurrency) || settings.fragment_concurrency < 1 || settings.fragment_concurrency > 3,
    'Fragment connections must be between 1 and 3.');
  add(!Number.isInteger(settings.max_retries) || settings.max_retries < 0 || settings.max_retries > 20,
    'Maximum retries must be between 0 and 20.');
  add(!Number.isInteger(settings.retry_delay_seconds) || settings.retry_delay_seconds < 1 || settings.retry_delay_seconds > 300,
    'Retry delay must be between 1 and 300 seconds.');
  add(!Number.isFinite(settings.global_bandwidth_limit_kbps) || settings.global_bandwidth_limit_kbps < 0 || settings.global_bandwidth_limit_kbps > 10_000_000,
    'Global bandwidth limit must be between 0 and 10,000,000 KB/s.');
  add(!Number.isFinite(settings.per_task_bandwidth_limit_kbps) || settings.per_task_bandwidth_limit_kbps < 0 || settings.per_task_bandwidth_limit_kbps > 10_000_000,
    'Per-download bandwidth limit must be between 0 and 10,000,000 KB/s.');
  add(!NOTIFICATION_DURATIONS.has(settings.auto_dismiss_seconds),
    'Notification duration must be one of the available preset values.');
  add(!settings.filename_template.trim() || settings.filename_template.length > 512,
    'Filename template must contain 1–512 characters.');
  add(!VIDEO_FORMATS.has(settings.default_video_format),
    'Default video format is not supported.');
  add(!AUDIO_FORMATS.has(settings.default_audio_format),
    'Default audio format is not supported.');
  add(!AUDIO_BITRATES.has(settings.default_audio_bitrate),
    'Default audio bitrate is not supported.');
  add(!['dark', 'light', 'system'].includes(settings.theme),
    'Theme must be Dark, Light, or System.');
  add(!['rename', 'overwrite', 'skip'].includes(settings.conflict_strategy || 'rename'),
    'File conflict strategy is not supported.');

  const proxy = settings.proxy_url.trim();
  if (proxy) {
    try {
      const parsed = new URL(proxy);
      add(!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname,
        'Proxy URL must use HTTP, HTTPS, SOCKS5, or SOCKS5H and include a host.');
    } catch {
      errors.push('Proxy URL is invalid. Use a complete URL such as http://127.0.0.1:8080.');
    }
  }

  const scheduler = settings.scheduler;
  if (scheduler) {
    const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    add(!validTime(scheduler.start_time) || !validTime(scheduler.stop_time),
      'Scheduler start and stop times must use 24-hour HH:MM format.');
    add(!Array.isArray(scheduler.days) || scheduler.days.length < 1 || scheduler.days.length > 7
      || scheduler.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(scheduler.days).size !== scheduler.days.length,
    'Select one or more valid weekdays for the scheduler.');
  }

  return errors;
}
