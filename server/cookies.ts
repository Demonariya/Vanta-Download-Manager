import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppSettings,
  CookieStatus,
  CookieTestResult,
  DetectedBrowserInfo,
  DiagnosticLogInfo,
} from '../src/types';
import {
  normalizeNetscapeCookies,
  validateNetscapeCookies,
} from '../src/utils/cookie-validator';
import { sanitizeLog } from '../src/utils/error-classifier';
import { getSettings, saveSettings } from './db';

export const SUPPORTED_BROWSERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'chrome', label: 'Google Chrome' },
  { id: 'edge', label: 'Microsoft Edge' },
  { id: 'firefox', label: 'Mozilla Firefox' },
  { id: 'brave', label: 'Brave Browser' },
  { id: 'opera', label: 'Opera' },
  { id: 'vivaldi', label: 'Vivaldi' },
];

export type ResolvedCookieSource =
  | { kind: 'file'; path: string }
  | { kind: 'browser'; browser: string; profile?: string; spec: string }
  | { kind: 'disabled' };

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024;

export function getDataDir(): string {
  const dir = path.resolve(process.cwd(), '.vanta_data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getManagedCookiesPath(): string {
  return path.join(getDataDir(), 'cookies.txt');
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

export function getPrimaryLogPath(): string {
  return path.join(getLogsDir(), 'vanta.log');
}

export function appendAppLog(level: 'INFO' | 'WARN' | 'ERROR', component: string, message: string): void {
  try {
    const dir = getLogsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const logPath = getPrimaryLogPath();
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_LOG_SIZE_BYTES) {
      for (let i = 3; i >= 1; i -= 1) {
        const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
        const dst = `${logPath}.${i}`;
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
    }
    const redacted = sanitizeLog(message).replace(/\r/g, '').trimEnd();
    const entry = `[${new Date().toISOString()}] [${level}] [${component}] ${redacted}\n`;
    fs.appendFileSync(logPath, entry, 'utf-8');
  } catch {
    // Non-fatal logging failure
  }
}

export function getDiagnosticLogInfo(maxLines = 100): DiagnosticLogInfo {
  const logDir = getLogsDir();
  const logPath = getPrimaryLogPath();
  const exists = fs.existsSync(logPath);
  let fileSizeBytes = 0;
  let recentLines: string[] = [];

  if (exists) {
    try {
      const stat = fs.statSync(logPath);
      fileSizeBytes = stat.size;
      const content = sanitizeLog(fs.readFileSync(logPath, 'utf-8'));
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      recentLines = lines.slice(-Math.min(500, Math.max(10, maxLines)));
    } catch {
      recentLines = [];
    }
  }

  return {
    logDir,
    logPath,
    exists,
    fileSizeBytes,
    recentLines,
  };
}

function listChromiumProfiles(userDataDir: string): { profiles: string[]; hasCookieStore: boolean } {
  if (!fs.existsSync(userDataDir) || !fs.statSync(userDataDir).isDirectory()) {
    return { profiles: [], hasCookieStore: false };
  }

  const profiles: string[] = [];
  let hasCookieStore = false;

  try {
    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(userDataDir, entry.name);
      const hasNetworkCookies = fs.existsSync(path.join(full, 'Network', 'Cookies'));
      const hasLegacyCookies = fs.existsSync(path.join(full, 'Cookies'));
      if (hasNetworkCookies || hasLegacyCookies) {
        hasCookieStore = true;
        profiles.push(entry.name);
      }
    }
  } catch {
    // ignore permission errors
  }

  if (
    profiles.length === 0 &&
    (fs.existsSync(path.join(userDataDir, 'Network', 'Cookies')) ||
      fs.existsSync(path.join(userDataDir, 'Cookies')))
  ) {
    hasCookieStore = true;
    profiles.push('Default');
  }

  profiles.sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return a.localeCompare(b);
  });

  return { profiles, hasCookieStore };
}

function listFirefoxProfiles(profilesRoot: string): { profiles: string[]; hasCookieStore: boolean } {
  if (!fs.existsSync(profilesRoot) || !fs.statSync(profilesRoot).isDirectory()) {
    return { profiles: [], hasCookieStore: false };
  }

  const profiles: string[] = [];
  let hasCookieStore = false;

  try {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(profilesRoot, entry.name);
      if (fs.existsSync(path.join(full, 'cookies.sqlite'))) {
        hasCookieStore = true;
        profiles.push(entry.name);
      }
    }
  } catch {
    // ignore
  }

  profiles.sort((a, b) => {
    const aDef = a.includes('default-release') || a.endsWith('.default') ? 1 : 0;
    const bDef = b.includes('default-release') || b.endsWith('.default') ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
    return a.localeCompare(b);
  });

  return { profiles, hasCookieStore };
}

export function detectBrowsersFromRoots(opts: {
  platform?: NodeJS.Platform;
  localAppData?: string;
  roamingAppData?: string;
  homeDir?: string;
  xdgConfigHome?: string;
}): DetectedBrowserInfo[] {
  const platform = opts.platform ?? process.platform;
  const results: DetectedBrowserInfo[] = [];

  for (const { id, label } of SUPPORTED_BROWSERS) {
    const candidateRoots: string[] = [];

    if (platform === 'win32') {
      const local = opts.localAppData;
      const roaming = opts.roamingAppData;
      if (local) {
        if (id === 'chrome') candidateRoots.push(path.join(local, 'Google', 'Chrome', 'User Data'));
        if (id === 'edge') candidateRoots.push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
        if (id === 'brave')
          candidateRoots.push(path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'));
        if (id === 'vivaldi') candidateRoots.push(path.join(local, 'Vivaldi', 'User Data'));
      }
      if (roaming) {
        if (id === 'firefox') candidateRoots.push(path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'));
        if (id === 'opera') candidateRoots.push(path.join(roaming, 'Opera Software', 'Opera Stable'));
      }
    } else if (opts.homeDir) {
      const xdg = opts.xdgConfigHome || path.join(opts.homeDir, '.config');
      if (id === 'chrome') {
        candidateRoots.push(
          path.join(xdg, 'google-chrome'),
          path.join(xdg, 'chromium'),
          path.join(opts.homeDir, 'Library/Application Support/Google/Chrome')
        );
      } else if (id === 'edge') {
        candidateRoots.push(
          path.join(xdg, 'microsoft-edge'),
          path.join(opts.homeDir, 'Library/Application Support/Microsoft Edge')
        );
      } else if (id === 'brave') {
        candidateRoots.push(
          path.join(xdg, 'BraveSoftware', 'Brave-Browser'),
          path.join(opts.homeDir, 'Library/Application Support/BraveSoftware/Brave-Browser')
        );
      } else if (id === 'vivaldi') {
        candidateRoots.push(
          path.join(xdg, 'vivaldi'),
          path.join(opts.homeDir, 'Library/Application Support/Vivaldi')
        );
      } else if (id === 'opera') {
        candidateRoots.push(
          path.join(xdg, 'opera'),
          path.join(opts.homeDir, 'Library/Application Support/com.operasoftware.Opera')
        );
      } else if (id === 'firefox') {
        candidateRoots.push(
          path.join(opts.homeDir, '.mozilla', 'firefox'),
          path.join(opts.homeDir, 'Library/Application Support/Firefox/Profiles')
        );
      }
    }

    let detected = false;
    const profiles: string[] = [];
    let hasCookieStore = false;

    for (const root of candidateRoots) {
      if (fs.existsSync(root)) {
        detected = true;
        const found =
          id === 'firefox' ? listFirefoxProfiles(root) : listChromiumProfiles(root);
        if (found.hasCookieStore) hasCookieStore = true;
        for (const p of found.profiles) {
          if (!profiles.includes(p)) profiles.push(p);
        }
      }
    }

    results.push({
      id,
      label,
      detected,
      profiles,
      defaultProfile: profiles[0] ?? null,
      hasCookieStore,
    });
  }

  return results;
}

export function detectInstalledBrowsers(): DetectedBrowserInfo[] {
  return detectBrowsersFromRoots({
    localAppData: process.env.LOCALAPPDATA,
    roamingAppData: process.env.APPDATA,
    homeDir: os.homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
}

export function formatBrowserSpec(browser: string, profile?: string | null): string {
  const p = profile?.trim();
  return p ? `${browser}:${p}` : browser;
}

export function resolveCookieSource(
  settings: AppSettings,
  overrideBrowser?: string,
  overrideProfile?: string
): { source: ResolvedCookieSource; error?: string } {
  const defaultPath = getManagedCookiesPath();
  const explicitFile = settings.cookies_file?.trim() || undefined;
  const candidateFile = explicitFile || (fs.existsSync(defaultPath) ? defaultPath : undefined);

  if (candidateFile) {
    if (fs.existsSync(candidateFile)) {
      try {
        const content = fs.readFileSync(candidateFile, 'utf-8');
        const validation = validateNetscapeCookies(content);
        if (!validation.valid) {
          return {
            source: { kind: 'disabled' },
            error: `Imported cookie file '${candidateFile}' is invalid: ${
              validation.errors[0] || 'Invalid Netscape cookies format'
            }. Replace or remove it in Settings > Cookies.`,
          };
        }
        return { source: { kind: 'file', path: candidateFile } };
      } catch (err: any) {
        return {
          source: { kind: 'disabled' },
          error: `Failed reading imported cookie file '${candidateFile}': ${err.message}`,
        };
      }
    } else if (explicitFile) {
      return {
        source: { kind: 'disabled' },
        error: `Configured cookie file '${explicitFile}' does not exist. Re-import or clear it in Settings > Cookies.`,
      };
    }
  }

  const browserRaw = (overrideBrowser || settings.cookies_browser || 'auto').trim().toLowerCase();
  if (!browserRaw || browserRaw === 'none') {
    return { source: { kind: 'disabled' } };
  }

  const profileTrim = (overrideProfile ?? settings.cookies_profile)?.trim() || undefined;

  if (browserRaw === 'auto') {
    const detected = detectInstalledBrowsers();
    const chosen =
      detected.find((b) => b.hasCookieStore) || detected.find((b) => b.detected);
    if (!chosen) {
      return { source: { kind: 'disabled' } };
    }
    const resolvedProfile = profileTrim || chosen.defaultProfile || undefined;
    return {
      source: {
        kind: 'browser',
        browser: chosen.id,
        profile: resolvedProfile,
        spec: formatBrowserSpec(chosen.id, resolvedProfile),
      },
    };
  }

  return {
    source: {
      kind: 'browser',
      browser: browserRaw,
      profile: profileTrim,
      spec: formatBrowserSpec(browserRaw, profileTrim),
    },
  };
}

export function getCookieStatus(settings?: AppSettings): CookieStatus {
  const s = settings || getSettings();
  const detectedBrowsers = detectInstalledBrowsers();
  const configuredBrowser = (s.cookies_browser || 'auto').trim().toLowerCase();
  const configuredProfile = s.cookies_profile?.trim() || null;

  const defaultPath = getManagedCookiesPath();
  const configuredFile = s.cookies_file?.trim() || '';
  const fileConfigured = Boolean(configuredFile);
  const effectivePath = configuredFile || defaultPath;
  const fileExists = fs.existsSync(effectivePath) && fs.statSync(effectivePath).isFile();

  let fileValid = false;
  let recordCount = 0;
  let domainCount = 0;
  let httpOnlyCount = 0;
  let secureCount = 0;
  let updatedAt: string | null = null;
  let error: string | null = null;

  if (fileExists) {
    try {
      updatedAt = fs.statSync(effectivePath).mtime.toISOString();
      const validation = validateNetscapeCookies(fs.readFileSync(effectivePath, 'utf-8'));
      fileValid = validation.valid;
      recordCount = validation.recordCount;
      domainCount = validation.domainCount;
      httpOnlyCount = validation.httpOnlyCount;
      secureCount = validation.secureCount;
      if (!validation.valid) {
        error = validation.errors[0] || 'Invalid cookie file';
      }
    } catch (err: any) {
      error = err.message || 'Unable to read cookie file';
    }
  } else if (fileConfigured) {
    error = 'Configured cookies.txt file does not exist on disk.';
  }

  const resolved = resolveCookieSource(s);
  let activeSource: CookieStatus['activeSource'] = 'none';
  let resolvedBrowser: string | null = null;
  let resolvedProfile: string | null = null;

  if (resolved.error) {
    activeSource = 'file';
    error = error || resolved.error;
  } else if (resolved.source.kind === 'file') {
    activeSource = 'file';
  } else if (resolved.source.kind === 'browser') {
    activeSource = configuredBrowser === 'auto' ? 'auto' : 'browser';
    resolvedBrowser = resolved.source.browser;
    resolvedProfile = resolved.source.profile || null;
  }

  return {
    activeSource,
    configuredBrowser: configuredBrowser || 'auto',
    configuredProfile,
    resolvedBrowser,
    resolvedProfile,
    fileConfigured,
    fileExists,
    filePath: effectivePath,
    fileValid,
    recordCount,
    domainCount,
    httpOnlyCount,
    secureCount,
    updatedAt,
    error,
    detectedBrowsers,
  };
}

export function saveCookiesFile(content: string): CookieStatus {
  const validation = validateNetscapeCookies(content);
  if (!validation.valid) {
    throw new Error(validation.errors[0] || 'Invalid Netscape cookies.txt format.');
  }

  const dir = getDataDir();
  const target = getManagedCookiesPath();
  const tmpPath = path.join(dir, `cookies.txt.tmp.${crypto.randomUUID()}`);
  const normalized = normalizeNetscapeCookies(content);

  try {
    fs.writeFileSync(tmpPath, normalized, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, target);
    if (process.platform !== 'win32') {
      fs.chmodSync(target, 0o600);
    }
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    throw err;
  }

  saveSettings({ cookies_file: target });
  appendAppLog(
    'INFO',
    'cookies',
    `Saved validated cookie file (${validation.recordCount} records across ${validation.domainCount} domains).`
  );
  return getCookieStatus(getSettings());
}

export function removeCookiesFile(): CookieStatus {
  const s = getSettings();
  const defaultPath = getManagedCookiesPath();
  for (const candidate of [s.cookies_file, defaultPath]) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        fs.unlinkSync(candidate);
      } catch {
        // ignore
      }
    }
  }

  saveSettings({ cookies_file: undefined });
  appendAppLog('INFO', 'cookies', 'Removed imported cookie file and cleared configuration.');
  return getCookieStatus(getSettings());
}

function spawnCaptured(
  execPath: string,
  args: string[],
  timeoutMs = 15000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error('Cookie verification process timed out.'));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export async function testCookieExtraction(
  ytdlpPath: string | null,
  settings: AppSettings,
  overrideBrowser?: string,
  overrideProfile?: string,
  testUrl?: string
): Promise<CookieTestResult> {
  const requestedBrowser = (overrideBrowser || settings.cookies_browser || 'auto').trim().toLowerCase();
  const requestedProfile = (overrideProfile ?? settings.cookies_profile)?.trim() || null;

  if (!ytdlpPath) {
    return {
      success: false,
      stage: 'engine_missing',
      activeSource: 'none',
      browser: requestedBrowser,
      resolvedBrowser: null,
      resolvedProfile: requestedProfile,
      browserDetected: false,
      profileLocated: false,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: 0,
      message: 'yt-dlp executable not found. Install engines in Dashboard or Diagnostics first.',
      nextAction: 'Install required engines before testing cookies.',
    };
  }

  const status = getCookieStatus(settings);
  const resolved = resolveCookieSource(settings, overrideBrowser, overrideProfile);

  if (resolved.error) {
    return {
      success: false,
      stage: 'file_invalid',
      activeSource: 'file',
      browser: requestedBrowser,
      resolvedBrowser: null,
      resolvedProfile: null,
      browserDetected: false,
      profileLocated: false,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: status.recordCount,
      message: resolved.error,
      nextAction: 'Upload or paste a valid Netscape cookies.txt file, or clear it to use browser cookies.',
    };
  }

  if (resolved.source.kind === 'disabled') {
    const isAuto = requestedBrowser === 'auto';
    return {
      success: false,
      stage: isAuto ? 'browser_not_installed' : 'disabled',
      activeSource: 'none',
      browser: requestedBrowser,
      resolvedBrowser: null,
      resolvedProfile: null,
      browserDetected: false,
      profileLocated: false,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: 0,
      message: isAuto
        ? 'No supported browser with an active cookie profile was detected on this machine.'
        : 'Cookie extraction is currently disabled ("none").',
      nextAction: 'Select an installed browser or import a Netscape cookies.txt file.',
    };
  }

  if (resolved.source.kind === 'file') {
    const cleanUrl = testUrl?.trim();
    if (!cleanUrl) {
      return {
        success: true,
        stage: 'file_valid',
        activeSource: 'file',
        browser: 'file',
        resolvedBrowser: null,
        resolvedProfile: null,
        browserDetected: false,
        profileLocated: true,
        databaseAccessible: true,
        extractionSucceeded: true,
        authVerified: null,
        recordCount: status.recordCount,
        message: `Active imported cookies.txt is valid (${status.recordCount} cookies across ${status.domainCount} domains). Add a Test URL to verify site login.`,
        nextAction: null,
      };
    }

    try {
      const res = await spawnCaptured(ytdlpPath, [
        '--cookies',
        resolved.source.path,
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
        cleanUrl,
      ]);
      if (res.code === 0) {
        return {
          success: true,
          stage: 'auth_verified',
          activeSource: 'file',
          browser: 'file',
          resolvedBrowser: null,
          resolvedProfile: null,
          browserDetected: false,
          profileLocated: true,
          databaseAccessible: true,
          extractionSucceeded: true,
          authVerified: true,
          recordCount: status.recordCount,
          message: `Imported cookie file (${status.recordCount} entries across ${status.domainCount} domains) verified against target URL.`,
          nextAction: null,
        };
      }
      const cleanErr = sanitizeLog(res.stderr || res.stdout || 'Authentication rejected');
      return {
        success: false,
        stage: 'auth_failed',
        activeSource: 'file',
        browser: 'file',
        resolvedBrowser: null,
        resolvedProfile: null,
        browserDetected: false,
        profileLocated: true,
        databaseAccessible: true,
        extractionSucceeded: true,
        authVerified: false,
        recordCount: status.recordCount,
        message: `Cookie file format is valid (${status.recordCount} entries), but URL verification failed: ${cleanErr.split('\n')[0]}`,
        nextAction: 'Export fresh cookies for the target site while signed in and re-import.',
      };
    } catch (err: any) {
      return {
        success: false,
        stage: 'auth_failed',
        activeSource: 'file',
        browser: 'file',
        resolvedBrowser: null,
        resolvedProfile: null,
        browserDetected: false,
        profileLocated: true,
        databaseAccessible: true,
        extractionSucceeded: false,
        authVerified: false,
        recordCount: status.recordCount,
        message: err.message || 'Verification failed',
        nextAction: 'Check yt-dlp health in Diagnostics.',
      };
    }
  }

  const { browser, profile, spec } = resolved.source;
  const detectedEntry = status.detectedBrowsers.find((b) => b.id === browser);
  const browserDetected = Boolean(detectedEntry?.detected);
  const profileLocated = detectedEntry
    ? profile
      ? detectedEntry.profiles.some((p) => p.toLowerCase() === profile.toLowerCase())
      : detectedEntry.hasCookieStore
    : false;
  const modeLabel = requestedBrowser === 'auto' ? 'auto' : 'browser';

  if (!browserDetected) {
    return {
      success: false,
      stage: 'browser_not_installed',
      activeSource: modeLabel,
      browser: requestedBrowser,
      resolvedBrowser: browser,
      resolvedProfile: profile || null,
      browserDetected: false,
      profileLocated: false,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: 0,
      message: `Browser '${browser}' was not detected on this machine.`,
      nextAction: 'Choose an installed browser or import a Netscape cookies.txt file.',
    };
  }

  if (profile && !profileLocated) {
    return {
      success: false,
      stage: 'profile_missing',
      activeSource: modeLabel,
      browser: requestedBrowser,
      resolvedBrowser: browser,
      resolvedProfile: profile,
      browserDetected: true,
      profileLocated: false,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: 0,
      message: `Profile '${profile}' was not found for browser '${browser}'. Available: ${
        detectedEntry?.profiles.join(', ') || 'none'
      }`,
      nextAction: 'Select an existing profile name or leave Profile blank for default.',
    };
  }

  const customUrl = testUrl?.trim();
  const targetUrl = customUrl || 'https://www.youtube.com/robots.txt';

  try {
    const res = await spawnCaptured(ytdlpPath, [
      '--cookies-from-browser',
      spec,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      targetUrl,
    ]);
    const combined = sanitizeLog(`${res.stderr}\n${res.stdout}`);
    const lower = combined.toLowerCase();

    const isDbLockOrDpapi =
      lower.includes('could not copy chrome cookie database') ||
      lower.includes('could not copy') ||
      lower.includes('cookie database') ||
      lower.includes('dpapi') ||
      lower.includes('app-bound') ||
      lower.includes('database is locked') ||
      lower.includes('failed to decrypt');

    const isMissingCookieDb =
      lower.includes('could not find') &&
      (lower.includes('cookie') || lower.includes('database') || lower.includes('profile'));

    if (isDbLockOrDpapi) {
      return {
        success: false,
        stage: 'db_locked',
        activeSource: modeLabel,
        browser: requestedBrowser,
        resolvedBrowser: browser,
        resolvedProfile: profile || null,
        browserDetected: true,
        profileLocated,
        databaseAccessible: false,
        extractionSucceeded: false,
        authVerified: null,
        recordCount: 0,
        message: `Cookie database for '${browser}' is locked or protected while the browser is running.`,
        nextAction: 'Close the browser completely, switch to Firefox, or import cookies.txt.',
      };
    }

    if (isMissingCookieDb) {
      return {
        success: false,
        stage: 'profile_missing',
        activeSource: modeLabel,
        browser: requestedBrowser,
        resolvedBrowser: browser,
        resolvedProfile: profile || null,
        browserDetected: true,
        profileLocated: false,
        databaseAccessible: false,
        extractionSucceeded: false,
        authVerified: null,
        recordCount: 0,
        message: `Could not locate a readable cookie database for '${spec}'.`,
        nextAction: 'Verify browser profile name or import cookies.txt directly.',
      };
    }

    if (res.code === 0) {
      return {
        success: true,
        stage: customUrl ? 'auth_verified' : 'extraction_ok',
        activeSource: modeLabel,
        browser: requestedBrowser,
        resolvedBrowser: browser,
        resolvedProfile: profile || null,
        browserDetected: true,
        profileLocated: true,
        databaseAccessible: true,
        extractionSucceeded: true,
        authVerified: customUrl ? true : null,
        recordCount: 0,
        message: customUrl
          ? `Verified cookie extraction from '${spec}' against target URL.`
          : `Successfully accessed '${spec}' cookie database cleanly.`,
        nextAction: null,
      };
    }

    if (!customUrl && lower.includes('unsupported url')) {
      return {
        success: true,
        stage: 'extraction_ok',
        activeSource: modeLabel,
        browser: requestedBrowser,
        resolvedBrowser: browser,
        resolvedProfile: profile || null,
        browserDetected: true,
        profileLocated: true,
        databaseAccessible: true,
        extractionSucceeded: true,
        authVerified: null,
        recordCount: 0,
        message: `Cookie database for '${spec}' opened cleanly without lock or decryption errors.`,
        nextAction: null,
      };
    }

    return {
      success: false,
      stage: 'auth_failed',
      activeSource: modeLabel,
      browser: requestedBrowser,
      resolvedBrowser: browser,
      resolvedProfile: profile || null,
      browserDetected: true,
      profileLocated: true,
      databaseAccessible: true,
      extractionSucceeded: true,
      authVerified: false,
      recordCount: 0,
      message: `Browser cookies loaded from '${spec}', but target URL returned: ${
        combined.split('\n').find((l) => l.trim()) || 'Verification failed'
      }`,
      nextAction: 'Ensure you are signed in inside that browser profile or import cookies.txt.',
    };
  } catch (err: any) {
    return {
      success: false,
      stage: 'auth_failed',
      activeSource: modeLabel,
      browser: requestedBrowser,
      resolvedBrowser: browser,
      resolvedProfile: profile || null,
      browserDetected: true,
      profileLocated,
      databaseAccessible: false,
      extractionSucceeded: false,
      authVerified: null,
      recordCount: 0,
      message: err.message || 'Cookie test failed',
      nextAction: 'Check yt-dlp health in Diagnostics.',
    };
  }
}
