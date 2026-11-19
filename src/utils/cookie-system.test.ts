/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateNetscapeCookies, normalizeNetscapeCookies } from './cookie-validator';
import { describeCookieStatus } from './cookie-status-ui';
import { sanitizeLog } from './error-classifier';
import {
  detectBrowsersFromRoots,
  resolveCookieSource,
  saveCookiesFile,
  removeCookiesFile,
  getCookieStatus,
} from '../../server/cookies';
import { getSettings, saveSettings } from '../../server/db';
import { ApiService } from '../services/api';
import { AppSettings, CookieStatus } from '../types';

function makeBaseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    download_dir: '/tmp/vanta-downloads',
    max_concurrent_downloads: 3,
    fragment_concurrency: 4,
    global_bandwidth_limit_kbps: 0,
    per_task_bandwidth_limit_kbps: 0,
    max_retries: 3,
    retry_delay_seconds: 5,
    default_video_format: 'best',
    default_audio_format: 'mp3',
    default_audio_bitrate: '320k',
    embed_thumbnail: true,
    embed_metadata: true,
    filename_template: '%(title)s [%(id)s].%(ext)s',
    proxy_url: '',
    floating_notifications_enabled: true,
    auto_dismiss_seconds: 5,
    theme: 'dark',
    auto_retry_failed: true,
    auto_resume_on_startup: true,
    cookies_browser: 'auto',
    ...overrides,
  };
}

test('validateNetscapeCookies accepts valid standard and #HttpOnly_ rows', () => {
  const sample = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tvalue123',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\tsecret456',
  ].join('\n');

  const res = validateNetscapeCookies(sample);
  assert.equal(res.valid, true);
  assert.equal(res.recordCount, 2);
  assert.equal(res.domainCount, 1);
  assert.equal(res.httpOnlyCount, 1);
  assert.equal(res.secureCount, 2);
  assert.equal(res.hasNetscapeHeader, true);
  assert.deepEqual(res.errors, []);

  const normalized = normalizeNetscapeCookies('.example.com\tTRUE\t/\tFALSE\t0\ta\tb');
  assert.ok(normalized.startsWith('# Netscape HTTP Cookie File\n'));
  assert.ok(normalized.endsWith('\n'));
});

test('validateNetscapeCookies rejects malformed columns, paths, and empty input', () => {
  const emptyRes = validateNetscapeCookies('# Netscape HTTP Cookie File\n\n');
  assert.equal(emptyRes.valid, false);
  assert.ok(emptyRes.errors.length > 0);

  const malformed = [
    '.example.com\tTRUE\tmissing-slash\tTRUE\t1893456000\tSID\tval',
    '.example.com\tTRUE\t/\tTRUE\tnot-a-timestamp\tSID\tval',
    'too-few-columns',
  ].join('\n');

  const res = validateNetscapeCookies(malformed);
  assert.equal(res.valid, false);
  assert.equal(res.recordCount, 0);
  assert.equal(res.errors.length, 3);
});

test('sanitizeLog redacts 7-column Netscape cookie values without dropping metadata', () => {
  const raw = '.example.com\tTRUE\t/\tTRUE\t1893456000\tSESSION_ID\tsuper_secret_cookie_value_987';
  const cleaned = sanitizeLog(raw);
  assert.ok(!cleaned.includes('super_secret_cookie_value_987'));
  assert.ok(cleaned.includes('[REDACTED_VALUE]'));
  assert.ok(cleaned.includes('.example.com'));
});

test('describeCookieStatus distinguishes active imported file, browser, auto, none, and errors', () => {
  const base: CookieStatus = {
    activeSource: 'none',
    configuredBrowser: 'none',
    configuredProfile: null,
    resolvedBrowser: null,
    resolvedProfile: null,
    fileConfigured: false,
    fileExists: false,
    filePath: '/tmp/cookies.txt',
    fileValid: false,
    recordCount: 0,
    domainCount: 0,
    httpOnlyCount: 0,
    secureCount: 0,
    updatedAt: null,
    error: null,
    detectedBrowsers: [],
  };

  assert.equal(describeCookieStatus(null).badgeText, 'Checking...');
  assert.equal(describeCookieStatus(base).badgeText, 'Disabled');
  assert.equal(
    describeCookieStatus({ ...base, configuredBrowser: 'auto' }).badgeText,
    'No Browser Found'
  );
  assert.equal(
    describeCookieStatus({
      ...base,
      activeSource: 'auto',
      configuredBrowser: 'auto',
      resolvedBrowser: 'firefox',
      resolvedProfile: 'abc.default-release',
    }).badgeText,
    'Auto (firefox)'
  );
  assert.equal(
    describeCookieStatus({
      ...base,
      activeSource: 'file',
      fileValid: true,
      recordCount: 14,
      domainCount: 3,
    }).badgeText,
    'Imported File (14)'
  );
  assert.equal(
    describeCookieStatus({
      ...base,
      activeSource: 'file',
      error: 'Invalid Netscape cookies format',
    }).badgeText,
    'File Error'
  );
});

test('detectBrowsersFromRoots discovers Windows and POSIX browser profiles cleanly', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-browsers-'));
  try {
    const winLocal = path.join(tmpRoot, 'winLocal');
    const winRoaming = path.join(tmpRoot, 'winRoaming');
    fs.mkdirSync(path.join(winLocal, 'Google', 'Chrome', 'User Data', 'Default', 'Network'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(winLocal, 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'),
      ''
    );
    fs.mkdirSync(path.join(winLocal, 'Google', 'Chrome', 'User Data', 'Profile 2'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(winLocal, 'Google', 'Chrome', 'User Data', 'Profile 2', 'Cookies'),
      ''
    );
    fs.mkdirSync(path.join(winRoaming, 'Mozilla', 'Firefox', 'Profiles', 'xyz.default-release'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(winRoaming, 'Mozilla', 'Firefox', 'Profiles', 'xyz.default-release', 'cookies.sqlite'),
      ''
    );

    const detected = detectBrowsersFromRoots({
      platform: 'win32',
      localAppData: winLocal,
      roamingAppData: winRoaming,
    });

    const chrome = detected.find((b) => b.id === 'chrome');
    const edge = detected.find((b) => b.id === 'edge');
    const firefox = detected.find((b) => b.id === 'firefox');

    assert.equal(chrome?.detected, true);
    assert.equal(chrome?.hasCookieStore, true);
    assert.deepEqual(chrome?.profiles, ['Default', 'Profile 2']);
    assert.equal(edge?.detected, false);
    assert.equal(firefox?.detected, true);
    assert.equal(firefox?.defaultProfile, 'xyz.default-release');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveCookieSource enforces imported file precedence and fails loudly on corrupt configured file', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cookie-res-'));
  try {
    const validFile = path.join(tmpRoot, 'valid_cookies.txt');
    fs.writeFileSync(validFile, '.example.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecret1\n');

    const withFile = resolveCookieSource(
      makeBaseSettings({ cookies_browser: 'firefox', cookies_file: validFile })
    );
    assert.deepEqual(withFile.source, { kind: 'file', path: validFile });
    assert.equal(withFile.error, undefined);

    const invalidFile = path.join(tmpRoot, 'bad_cookies.txt');
    fs.writeFileSync(invalidFile, 'not-valid-netscape-columns');
    const badRes = resolveCookieSource(makeBaseSettings({ cookies_file: invalidFile }));
    assert.ok(badRes.error && badRes.error.includes('invalid'));

    const missingRes = resolveCookieSource(
      makeBaseSettings({ cookies_file: path.join(tmpRoot, 'missing.txt') })
    );
    assert.ok(missingRes.error && missingRes.error.includes('does not exist'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('saveCookiesFile persists file privately without storing cookies_content in settings DB', () => {
  const originalSettings = getSettings();
  const sampleCookies = '.example.com\tTRUE\t/\tTRUE\t1893456000\tSESSION\tvery_secret_cookie_val\n';

  try {
    const savedStatus = saveCookiesFile(sampleCookies);
    assert.equal(savedStatus.activeSource, 'file');
    assert.equal(savedStatus.fileValid, true);
    assert.equal(savedStatus.recordCount, 1);

    const storedSettings = getSettings() as unknown as Record<string, unknown>;
    assert.equal('cookies_content' in storedSettings, false);
    assert.equal('enable_adult_sites' in storedSettings, false);
    assert.equal('bypass_age_gate' in storedSettings, false);
    assert.ok(typeof storedSettings.cookies_file === 'string');

    const removedStatus = removeCookiesFile();
    assert.equal(removedStatus.fileExists, false);
    assert.equal(removedStatus.fileConfigured, false);
    assert.notEqual(getCookieStatus().activeSource, 'file');
  } finally {
    removeCookiesFile();
    saveSettings({
      cookies_browser: originalSettings.cookies_browser,
      cookies_profile: originalSettings.cookies_profile,
      cookies_file: originalSettings.cookies_file,
    });
  }
});

test('ApiService routes cookie commands through Tauri invoke when __TAURI_INTERNALS__ exists and HTTP otherwise', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = (globalThis as any).fetch;

  try {
    const invokedCalls: Array<{ cmd: string; args: unknown }> = [];
    (globalThis as any).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: unknown) => {
          invokedCalls.push({ cmd, args });
          return { ok: true, cmd };
        },
      },
    };

    const tauriApi = new ApiService();
    await tauriApi.getCookieStatus();
    await tauriApi.testCookieExtraction('firefox', 'default-release', 'https://example.com');
    await tauriApi.saveCookies('.example.com\tTRUE\t/\tTRUE\t1893456000\ta\tb');
    await tauriApi.removeCookies();
    await tauriApi.getDiagnosticLogInfo(50);

    assert.deepEqual(
      invokedCalls.map((c) => c.cmd),
      [
        'get_cookie_status',
        'test_cookie_extraction',
        'save_cookies',
        'remove_cookies',
        'get_diagnostic_log_info',
      ]
    );
    assert.deepEqual(invokedCalls[1].args, {
      browser: 'firefox',
      profile: 'default-release',
      testUrl: 'https://example.com',
    });

    const fetchUrls: string[] = [];
    (globalThis as any).window = {};
    (globalThis as any).fetch = async (url: string) => {
      fetchUrls.push(url);
      return {
        ok: true,
        json: async () => ({ activeSource: 'none' }),
      };
    };

    const httpApi = new ApiService();
    await httpApi.getCookieStatus();
    await httpApi.detectBrowsers();
    await httpApi.testCookieExtraction('auto');
    await httpApi.getDiagnosticLogInfo(75);

    assert.deepEqual(fetchUrls, [
      '/api/cookies/status',
      '/api/cookies/browsers',
      '/api/cookies/test',
      '/api/diagnostics/logs?maxLines=75',
    ]);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    (globalThis as any).fetch = prevFetch;
  }
});
