import { spawn, execSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EngineInfo,
  EngineStatusMap,
  EngineUpdateResult,
  EngineInstallProgress,
  ManagedEngineInfo,
  MediaMetadata,
  FormatOption,
  DownloadTask,
  DiagnosticResult,
  AppSettings,
} from '../src/types';
import {
  parseYtdlpProgress,
  formatDuration,
  sanitizeFilename,
  determineEngineForUrl,
} from '../src/utils/engine-parser';
import { sanitizeLog, classifyDownloadError } from '../src/utils/error-classifier';
import { tryParseSpotifyInput } from '../src/utils/spotify';
import { getSettings } from './db';
import {
  resolveCookieSource,
  testCookieExtraction as runCookieTest,
  appendAppLog,
} from './cookies';
import { spotifyMetadataService } from './spotify';

const ENGINE_VERSION_TIMEOUT_MS = 8_000;
const DIAGNOSTICS_TIMEOUT_MS = 15_000;
const INSPECT_URL_TIMEOUT_MS = 60_000;
const INSPECT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const ENGINE_STATUS_CACHE_TTL_MS = 15_000;

interface TrackedInspection {
  proc: ChildProcess | null;
  cancelled: boolean;
  abort?: () => void;
}

function killChildProcessTree(proc: ChildProcess | null): void {
  if (!proc) return;
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } catch {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    return;
  }

  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }, 250);
      timer.unref?.();
      return;
    } catch {
      // Fall back to direct kill if process is not a group leader
    }
  }

  try {
    proc.kill('SIGTERM');
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 250);
    timer.unref?.();
  } catch {
    // ignore
  }
}

function runProcessAsync(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const proc = spawn(command, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killChildProcessTree(proc);
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) {
        stdout += chunk.toString('utf-8');
      }
    });

    proc.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.toString('utf-8');
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

export function validateInspectionUrl(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error('URL cannot be empty. Enter an HTTP or HTTPS media URL.');
  }
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error('Invalid URL: contains whitespace or control characters.');
  }
  if (trimmed.startsWith('-')) {
    throw new Error('Invalid URL: must start with http://, https://, or spotify:.');
  }

  // Validate Spotify URIs and Spotify URLs explicitly (supports spotify:<type>:<id>, open.spotify.com, spotify.link)
  const parsedSpotify = tryParseSpotifyInput(trimmed);
  if (parsedSpotify) {
    if (parsedSpotify.kind === 'invalid') {
      throw new Error(parsedSpotify.error);
    }
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Malformed URL. Check the URL and try again.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported URL scheme. Only http:// and https:// URLs are supported.');
  }
  if (!parsed.hostname || parsed.hostname.startsWith('.')) {
    throw new Error('Malformed URL host. Check the URL and try again.');
  }

  return trimmed;
}

export class EngineManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private activeInspections: Map<string, TrackedInspection> = new Map();
  private cachedEngineStatus: { ts: number; data: EngineStatusMap } | null = null;
  private inflightEngineScan: Promise<EngineStatusMap> | null = null;

  public getManagedRootDir(): string {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'com.vanta.downloadmanager', 'engines');
    }
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(xdgData, 'com.vanta.downloadmanager', 'engines');
  }

  public getManagedBinDir(): string {
    return path.join(this.getManagedRootDir(), 'bin');
  }

  public findExecutable(name: string): string | null {
    const exeName = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
    const candidates = [
      path.join(this.getManagedBinDir(), exeName),
      path.resolve(process.cwd(), 'bin', exeName),
      path.resolve(process.cwd(), '.venv', 'bin', exeName),
      `/app/applet/.venv/bin/${name}`,
      `/opt/spotdl-venv/bin/${name}`,
      `/root/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch {
          try {
            fs.chmodSync(p, 0o755);
            return p;
          } catch {
            // not executable
          }
        }
      }
    }

    try {
      const lookupCmd = process.platform === 'win32' ? `where ${exeName}` : `which ${name} 2>/dev/null`;
      const out = execSync(lookupCmd, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 2000,
      })
        .split(/\r?\n/)[0]
        ?.trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // not in PATH
    }

    return null;
  }

  public async getEngineStatus(forceRefresh = false): Promise<EngineStatusMap> {
    if (!forceRefresh && this.cachedEngineStatus) {
      if (Date.now() - this.cachedEngineStatus.ts < ENGINE_STATUS_CACHE_TTL_MS) {
        return this.cachedEngineStatus.data;
      }
    }

    if (this.inflightEngineScan) {
      return this.inflightEngineScan;
    }

    const check = async (name: string, verFlag = '--version'): Promise<EngineInfo> => {
      const start = Date.now();
      const p = this.findExecutable(name);
      if (!p) {
        return {
          available: false,
          version: '',
          path: '',
          status: 'missing',
          lastChecked: new Date().toISOString(),
          durationMs: Date.now() - start,
          error: `Executable ${name} not found in system paths.`,
        };
      }

      try {
        const res = await runProcessAsync(p, [verFlag], ENGINE_VERSION_TIMEOUT_MS);
        if (res.timedOut) {
          appendAppLog('WARN', 'engines', `${name} version check timed out after ${res.durationMs}ms`);
          return {
            available: false,
            version: '',
            path: p,
            status: 'timed_out',
            lastChecked: new Date().toISOString(),
            durationMs: res.durationMs,
            error: `Version check timed out after ${Math.round(ENGINE_VERSION_TIMEOUT_MS / 1000)}s`,
          };
        }
        if (res.code !== 0) {
          const cleanErr = sanitizeLog((res.stderr || res.stdout || '').trim());
          return {
            available: false,
            version: '',
            path: p,
            status: 'error',
            lastChecked: new Date().toISOString(),
            durationMs: res.durationMs,
            error: cleanErr || `Exited with status ${res.code}`,
          };
        }
        const combined = (res.stdout || res.stderr).trim();
        const firstLine = (combined.split('\n')[0] || '').replace(/^.*?version\s*/i, '').trim();
        return {
          available: true,
          version: firstLine,
          path: p,
          status: 'ready',
          lastChecked: new Date().toISOString(),
          durationMs: res.durationMs,
        };
      } catch (err: any) {
        return {
          available: false,
          version: '',
          path: p,
          status: 'error',
          lastChecked: new Date().toISOString(),
          durationMs: Date.now() - start,
          error: sanitizeLog(err.message || 'Execution failed'),
        };
      }
    };

    const scanPromise = (async () => {
      const [ytdlp, spotdl, ffmpeg, ffprobe, python3] = await Promise.all([
        check('yt-dlp', '--version'),
        check('spotdl', '--version'),
        check('ffmpeg', '-version'),
        check('ffprobe', '-version'),
        check('python3', '--version'),
      ]);
      const data: EngineStatusMap = { ytdlp, spotdl, ffmpeg, ffprobe, python3 };
      this.cachedEngineStatus = { ts: Date.now(), data };
      return data;
    })();

    this.inflightEngineScan = scanPromise;
    try {
      return await scanPromise;
    } finally {
      if (this.inflightEngineScan === scanPromise) {
        this.inflightEngineScan = null;
      }
    }
  }

  public async runDiagnostics(): Promise<DiagnosticResult[]> {
    const engines = [
      { name: 'yt-dlp', flag: '--version' },
      { name: 'spotdl', flag: '--version' },
      { name: 'ffmpeg', flag: '-version' },
      { name: 'ffprobe', flag: '-version' },
    ];

    return Promise.all(
      engines.map(async (eng): Promise<DiagnosticResult> => {
        const start = Date.now();
        const execPath = this.findExecutable(eng.name);
        if (!execPath) {
          return {
            engine: eng.name,
            passed: false,
            command: `${eng.name} ${eng.flag}`,
            output: 'Executable not found in system or bin/ directory.',
            duration_ms: Date.now() - start,
          };
        }

        try {
          const res = await runProcessAsync(execPath, [eng.flag], DIAGNOSTICS_TIMEOUT_MS);
          if (res.timedOut) {
            return {
              engine: eng.name,
              passed: false,
              command: `"${execPath}" ${eng.flag}`,
              output: `Diagnostic check timed out after ${Math.round(DIAGNOSTICS_TIMEOUT_MS / 1000)}s.`,
              duration_ms: res.durationMs,
            };
          }
          const combined = sanitizeLog((res.stdout || res.stderr || '').trim());
          const passed = res.code === 0;
          return {
            engine: eng.name,
            passed,
            version: passed ? combined.split('\n')[0] : undefined,
            command: `"${execPath}" ${eng.flag}`,
            output: combined.slice(0, 500) || (passed ? 'OK' : `Exited with code ${res.code}`),
            duration_ms: res.durationMs,
          };
        } catch (err: any) {
          return {
            engine: eng.name,
            passed: false,
            command: `"${execPath}" ${eng.flag}`,
            output: sanitizeLog(err.message || 'Execution failed'),
            duration_ms: Date.now() - start,
          };
        }
      })
    );
  }

  public getRequestAndCookieArgs(url: string, settings?: AppSettings, overrideBrowser?: string): string[] {
    const s = settings || getSettings();
    const args: string[] = [];

    const ua =
      s.user_agent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    args.push('--user-agent', ua);
    args.push('--add-header', 'Accept-Language:en-US,en;q=0.9');

    try {
      const parsed = new URL(url);
      args.push('--referer', `${parsed.protocol}//${parsed.hostname}/`);
    } catch {
      // ignore invalid URLs here
    }

    const ffmpegPath = this.findExecutable('ffmpeg');
    if (ffmpegPath) {
      args.push('--ffmpeg-location', path.dirname(ffmpegPath));
    }

    const resolved = resolveCookieSource(s, overrideBrowser, s.cookies_profile);
    if (resolved.error) {
      throw new Error(resolved.error);
    }

    if (resolved.source.kind === 'file') {
      args.push('--cookies', resolved.source.path);
    } else if (resolved.source.kind === 'browser') {
      args.push('--cookies-from-browser', resolved.source.spec);
    }

    return args;
  }

  public async testCookieExtraction(
    browser?: string,
    profile?: string,
    testUrl?: string
  ) {
    const ytdlpPath = this.findExecutable('yt-dlp');
    const settings = getSettings();
    return runCookieTest(ytdlpPath, settings, browser, profile, testUrl);
  }

  public cancelInspection(requestId: string): boolean {
    const entry = this.activeInspections.get(requestId);
    if (!entry) return false;
    entry.cancelled = true;
    killChildProcessTree(entry.proc);
    entry.abort?.();
    return true;
  }

  public async inspectUrl(
    rawUrl: string,
    proxy?: string,
    requestId?: string,
    options?: {
      timeoutMs?: number;
      maxStdoutBytes?: number;
      ytdlpBinary?: string;
    }
  ): Promise<MediaMetadata> {
    const url = validateInspectionUrl(rawUrl);
    const engine = determineEngineForUrl(url);

    if (engine === 'spotdl') {
      return this.inspectSpotdlUrl(url, requestId, options?.timeoutMs);
    }

    const ytdlpPath = options?.ytdlpBinary || this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      throw new Error('yt-dlp engine is not installed or not available.');
    }

    const settings = getSettings();
    const cookieRequestArgs = this.getRequestAndCookieArgs(url, settings);
    const reqId = requestId || `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = options?.timeoutMs ?? INSPECT_URL_TIMEOUT_MS;
    const maxStdoutBytes = options?.maxStdoutBytes ?? INSPECT_MAX_STDOUT_BYTES;

    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-call-home',
      '--no-cache-dir',
      '--skip-download',
      '--no-exec',
      '--socket-timeout',
      '15',
      '--retries',
      '2',
      '--extractor-retries',
      '2',
      ...cookieRequestArgs,
    ];

    if (proxy || settings.proxy_url) {
      args.push('--proxy', proxy || settings.proxy_url);
    }

    args.push('--', url);

    const tracker: TrackedInspection = { proc: null, cancelled: false };
    this.activeInspections.set(reqId, tracker);

    try {
      appendAppLog('INFO', 'inspect', `Starting URL inspection '${reqId}' (timeout=${timeoutMs}ms)`);
      return await new Promise<MediaMetadata>((resolve, reject) => {
        const proc = spawn(ytdlpPath, args, {
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        tracker.proc = proc;

        const stdoutChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let overflowed = false;

        const terminateChild = () => {
          killChildProcessTree(proc);
        };

        const finishReject = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.activeInspections.delete(reqId);
          reject(err);
        };

        const finishResolve = (meta: MediaMetadata) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.activeInspections.delete(reqId);
          resolve(meta);
        };

        tracker.abort = () => {
          finishReject(new Error('Inspection cancelled.'));
        };

        const timer = setTimeout(() => {
          timedOut = true;
          terminateChild();
          finishReject(
            new Error(
              `URL inspection timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s because the target site or extractor did not respond in time.`
            )
          );
        }, timeoutMs);

        if (tracker.cancelled) {
          terminateChild();
          finishReject(new Error('Inspection cancelled.'));
          return;
        }

        proc.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxStdoutBytes) {
            overflowed = true;
            terminateChild();
            finishReject(
              new Error(
                `Metadata payload exceeded safe limit (${Math.max(1, Math.round(maxStdoutBytes / (1024 * 1024)))} MiB) and was aborted safely.`
              )
            );
            return;
          }
          stdoutChunks.push(chunk);
        });

        proc.stderr.on('data', (d: Buffer) => {
          if (stderr.length < 64 * 1024) {
            stderr += d.toString('utf-8');
          }
        });

        proc.on('error', (err) => {
          finishReject(new Error(`Failed to execute yt-dlp: ${err.message}`));
        });

        proc.on('close', (code) => {
          if (settled) return;
          if (tracker.cancelled) {
            return finishReject(new Error('Inspection cancelled.'));
          }
          if (timedOut) {
            return finishReject(
              new Error(
                `URL inspection timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s because the target site or extractor did not respond in time.`
              )
            );
          }
          if (overflowed) {
            return finishReject(
              new Error('Metadata payload exceeded safe limit and was aborted safely.')
            );
          }

          const stdoutText = Buffer.concat(stdoutChunks).toString('utf-8');
          if (code !== 0) {
            const rawErr = stderr.trim() || stdoutText.trim() || `Process exited with code ${code}`;
            return finishReject(new Error(rawErr));
          }

          try {
            const raw = JSON.parse(stdoutText);
            const isPlaylist = Boolean(raw._type === 'playlist' || Array.isArray(raw.entries));

            const parsedFormats: FormatOption[] = [];
            if (Array.isArray(raw.formats)) {
              for (const f of raw.formats.slice(0, 500)) {
                if (!f?.format_id) continue;
                const isAudioOnly = f.vcodec === 'none' && f.acodec !== 'none';
                const isVideoOnly = f.acodec === 'none' && f.vcodec !== 'none';

                parsedFormats.push({
                  format_id: f.format_id,
                  ext: f.ext || 'mp4',
                  resolution: f.resolution || (f.height ? `${f.height}p` : undefined),
                  width: f.width,
                  height: f.height,
                  fps: f.fps,
                  vcodec: f.vcodec,
                  acodec: f.acodec,
                  filesize: f.filesize,
                  filesize_approx: f.filesize_approx,
                  tbr: f.tbr,
                  abr: f.abr,
                  format_note: f.format_note,
                  is_audio_only: isAudioOnly,
                  is_video_only: isVideoOnly,
                });
              }
            }

            const metadata: MediaMetadata = {
              url,
              id: raw.id || String(Date.now()),
              title: raw.title || 'Untitled Media',
              uploader: raw.uploader || raw.channel || raw.artist || 'Unknown',
              duration: raw.duration,
              duration_string: formatDuration(raw.duration),
              thumbnail: raw.thumbnail || (raw.thumbnails && raw.thumbnails[0]?.url) || undefined,
              description: raw.description ? String(raw.description).slice(0, 500) : undefined,
              formats: parsedFormats,
              is_playlist: isPlaylist,
              playlist_count: isPlaylist && raw.entries ? raw.entries.length : undefined,
              extractor: raw.extractor || 'generic',
            };

            finishResolve(metadata);
          } catch (err: any) {
            finishReject(
              new Error(`Received invalid or incomplete metadata from extractor: ${err.message}`)
            );
          }
        });
      });
    } catch (err: any) {
      this.activeInspections.delete(reqId);
      const msg = sanitizeLog(err.message || '');
      const lower = msg.toLowerCase();
      appendAppLog('ERROR', 'inspect', `Request '${reqId}' failed: ${msg}`);

      if (lower === 'inspection cancelled.' || lower.includes('timed out') || lower.includes('exceeded safe limit')) {
        throw new Error(msg);
      }

      if (
        lower.includes('could not copy chrome cookie database') ||
        lower.includes('cookie database') ||
        lower.includes('dpapi') ||
        lower.includes('app-bound') ||
        lower.includes('database is locked')
      ) {
        throw new Error(
          `Browser cookie database access failed: ${msg}\n\nClose the browser, select Firefox, or import a Netscape cookies.txt file in Settings > Cookies.`
        );
      }

      if (
        lower.includes('sign in to confirm') ||
        lower.includes('cookies for authentication')
      ) {
        throw new Error(
          `Authentication required: ${msg}\n\nConfigure your browser profile or import a valid cookies.txt file in Settings > Cookies.`
        );
      }

      if (lower.includes('received invalid or incomplete metadata')) {
        throw new Error(msg);
      }

      throw new Error(`Extraction failed: ${msg}`);
    } finally {
      this.activeInspections.delete(reqId);
    }
  }

  private async inspectSpotdlUrl(
    url: string,
    requestId?: string,
    timeoutMs?: number
  ): Promise<MediaMetadata> {
    const reqId = requestId || `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const abortController = new AbortController();
    const tracker: TrackedInspection = {
      proc: null,
      cancelled: false,
      abort: () => abortController.abort(new Error('Inspection cancelled.')),
    };
    this.activeInspections.set(reqId, tracker);

    try {
      return await spotifyMetadataService.resolveSpotifyUrl(url, {
        requestTimeoutMs: timeoutMs,
        signal: abortController.signal,
      });
    } finally {
      this.activeInspections.delete(reqId);
    }
  }

  public startDownload(
    task: DownloadTask,
    settings: AppSettings,
    onProgress: (update: Partial<DownloadTask>) => void,
    onComplete: (outputPath: string) => void,
    onError: (err: string) => void
  ): void {
    if (task.engine === 'spotdl') {
      this.executeSpotdlDownload(task, settings, onProgress, onComplete, onError);
    } else {
      this.executeYtdlpDownload(task, settings, onProgress, onComplete, onError);
    }
  }

  private executeYtdlpDownload(
    task: DownloadTask,
    settings: AppSettings,
    onProgress: (update: Partial<DownloadTask>) => void,
    onComplete: (outputPath: string) => void,
    onError: (err: string) => void
  ): void {
    const ytdlpPath = this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      return onError('yt-dlp executable not found.');
    }

    const outDir = task.output_path || settings.download_dir;
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outTemplate = path.join(outDir, settings.filename_template || '%(title)s [%(id)s].%(ext)s');

    const args: string[] = [
      '--newline',
      '--no-colors',
      '--progress-template',
      '%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s',
      '-o',
      outTemplate,
      '--retries', '10',
      '--fragment-retries', '10',
      '--file-access-retries', '5',
      '--retry-sleep', 'fragment:exp=1:30',
      '--socket-timeout', '30',
      '--extractor-retries', '3',
    ];

    try {
      const requestArgs = this.getRequestAndCookieArgs(task.url, settings);
      args.push(...requestArgs);
    } catch (err: any) {
      return onError(err.message || 'Invalid cookie configuration');
    }

    // On retries (especially after HTTP 410 or expired signatures), bypass cache and use robust player clients
    if (task.retries > 0) {
      args.push('--no-cache-dir');
      args.push('--extractor-args', 'youtube:player_client=default,web,android');
    }

    // Bandwidth limit
    if (settings.global_bandwidth_limit_kbps > 0) {
      args.push('--limit-rate', `${settings.global_bandwidth_limit_kbps}K`);
    } else if (settings.per_task_bandwidth_limit_kbps > 0) {
      args.push('--limit-rate', `${settings.per_task_bandwidth_limit_kbps}K`);
    }

    // Proxy
    if (settings.proxy_url) {
      args.push('--proxy', settings.proxy_url);
    }

    // Audio extraction vs video
    if (task.is_audio_only) {
      args.push('-x');
      const audioFormat = task.audio_format || settings.default_audio_format || 'mp3';
      args.push('--audio-format', audioFormat);
      if (task.audio_bitrate) {
        args.push('--audio-quality', task.audio_bitrate);
      }
      if (task.audio_sample_rate || task.audio_bit_depth) {
        let pp = 'ExtractAudio:';
        if (task.audio_sample_rate) pp += ` -ar ${task.audio_sample_rate}`;
        if (task.audio_bit_depth === 24) pp += ' -sample_fmt s24';
        args.push('--postprocessor-args', pp.trim());
      }
    } else {
      if (task.format_id && task.format_id !== 'best') {
        args.push('-f', task.format_id);
      } else {
        args.push('-f', 'bestvideo+bestaudio/best');
      }
    }

    // Embeddings
    if (settings.embed_thumbnail) {
      args.push('--embed-thumbnail');
    }
    if (settings.embed_metadata) {
      args.push('--embed-metadata');
    }

    // Fragment concurrency if supported
    if (settings.fragment_concurrency > 1) {
      args.push('-N', String(settings.fragment_concurrency));
    }

    let validatedTaskUrl = task.url;
    try {
      validatedTaskUrl = validateInspectionUrl(task.url);
    } catch (urlErr: any) {
      return onError(urlErr.message || 'Invalid download URL');
    }

    args.push('--', validatedTaskUrl);

    onProgress({
      status: 'extracting',
      current_phase: 'Initializing engine...',
      progress_percentage: 2,
    });

    try {
      const proc = spawn(ytdlpPath, args, { windowsHide: true });
      this.activeProcesses.set(task.id, proc);

      let lastOutput = '';
      let detectedOutputFile = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        const lines = text.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Check for destination output
          const destMatch = trimmed.match(/\[(?:download|Merger|ExtractAudio)\] Destination:\s*(.*)$/);
          if (destMatch && destMatch[1]) {
            detectedOutputFile = destMatch[1].trim().replace(/^["']|["']$/g, '');
          }

          const mergerMatch = trimmed.match(/\[(?:Merger|Fixup\w+)\] Merging formats into ["']?(.*?)["']?$/);
          if (mergerMatch && mergerMatch[1]) {
            detectedOutputFile = mergerMatch[1].trim().replace(/^["']|["']$/g, '');
          }

          const parsed = parseYtdlpProgress(trimmed);
          if (parsed) {
            onProgress({
              status: parsed.phase === 'processing' || parsed.phase === 'converting' ? 'processing' : 'downloading',
              progress_percentage: parsed.percentage !== undefined ? parsed.percentage : undefined,
              speed_str: parsed.speedStr,
              speed_bytes_per_sec: parsed.speedBytesPerSec,
              downloaded_bytes: parsed.downloadedBytes,
              total_bytes: parsed.totalBytes,
              eta_str: parsed.etaStr,
              current_phase: parsed.phase || 'downloading',
            });
          }
        }
      });

      proc.stderr.on('data', (data) => {
        lastOutput = (lastOutput + data.toString()).slice(-4000);
      });

      proc.on('close', (code) => {
        this.activeProcesses.delete(task.id);
        if (code === 0) {
          onComplete(detectedOutputFile || outDir);
        } else if (code === null) {
          // Process was killed (paused or cancelled)
        } else {
          onError(`yt-dlp failed (code ${code}): ${sanitizeLog(lastOutput || 'Unknown error')}`);
        }
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(task.id);
        onError(`Execution error: ${sanitizeLog(err.message)}`);
      });
    } catch (err: any) {
      this.activeProcesses.delete(task.id);
      onError(err.message || 'Failed to start download');
    }
  }

  private executeSpotdlDownload(
    task: DownloadTask,
    settings: AppSettings,
    onProgress: (update: Partial<DownloadTask>) => void,
    onComplete: (outputPath: string) => void,
    onError: (err: string) => void
  ): void {
    const spotdlPath = this.findExecutable('spotdl');
    if (!spotdlPath) {
      return onError('spotDL executable not found.');
    }

    const outDir = task.output_path || settings.download_dir;
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const parsedSpotify = tryParseSpotifyInput(task.url);
    if (parsedSpotify && parsedSpotify.kind === 'invalid') {
      return onError(parsedSpotify.error);
    }

    const targetUrl =
      parsedSpotify && parsedSpotify.kind === 'resource'
        ? parsedSpotify.canonicalUrl
        : task.url;

    const format = task.audio_format || settings.default_audio_format || 'mp3';
    const bitrate = task.audio_bitrate || settings.default_audio_bitrate || '320k';
    const outputTemplate =
      task.content_type === 'playlist' || task.content_type === 'album'
        ? path.join(outDir, '{list-name}', '{artists} - {title}.{output-ext}')
        : path.join(outDir, '{artists} - {title}.{output-ext}');

    const args = [
      'download',
      targetUrl,
      '--output',
      outputTemplate,
      '--format',
      format,
      '--bitrate',
      bitrate,
      '--log-level',
      'INFO',
    ];

    onProgress({
      status: 'extracting',
      current_phase: 'Matching audio source via spotDL...',
      progress_percentage: 10,
    });

    try {
      const proc = spawn(spotdlPath, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.activeProcesses.set(task.id, proc);

      let lastOutput = '';

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        if (text.includes('Searching for') || text.includes('Found')) {
          onProgress({
            status: 'extracting',
            current_phase: 'Matching audio source...',
            progress_percentage: 25,
          });
        } else if (text.includes('Downloading')) {
          onProgress({
            status: 'downloading',
            current_phase: 'Downloading audio stream...',
            progress_percentage: 60,
          });
        } else if (text.includes('Converting') || text.includes('Embedding') || text.includes('Downloaded')) {
          onProgress({
            status: 'processing',
            current_phase: 'Embedding metadata & cover artwork...',
            progress_percentage: 85,
          });
        }
      });

      proc.stderr.on('data', (d) => {
        lastOutput = (lastOutput + d.toString()).slice(-4000);
      });

      proc.on('close', (code) => {
        this.activeProcesses.delete(task.id);
        if (code === 0) {
          onComplete(outDir);
        } else if (code === null) {
          // Process killed
        } else {
          onError(`spotDL failed (code ${code}): ${sanitizeLog(lastOutput || 'Unknown error')}`);
        }
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(task.id);
        onError(`Execution error: ${sanitizeLog(err.message)}`);
      });
    } catch (err: any) {
      this.activeProcesses.delete(task.id);
      onError(err.message || 'Failed to start spotDL download');
    }
  }

  public cancelOrPauseProcess(taskId: string): boolean {
    const proc = this.activeProcesses.get(taskId);
    if (proc) {
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {}
        }, 1000);
      } catch {}
      this.activeProcesses.delete(taskId);
      return true;
    }
    return false;
  }

  public verifyAudioFile(filePath: string): string | null {
    const ffprobePath = this.findExecutable('ffprobe');
    if (!ffprobePath) return null;
    if (!fs.existsSync(filePath)) return null;

    try {
      const stats = fs.statSync(filePath);
      let targetFile = filePath;
      if (stats.isDirectory()) {
        const files = fs.readdirSync(filePath);
        const audioFiles = files.filter((f) => /\.(flac|wav|mp3|m4a|aac|opus|ogg)$/i.test(f));
        if (audioFiles.length === 0) return null;
        targetFile = path.join(filePath, audioFiles[audioFiles.length - 1]);
      }

      const jsonStr = execSync(`"${ffprobePath}" -v quiet -print_format json -show_streams -show_format "${targetFile}"`, {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true,
      });
      const data = JSON.parse(jsonStr);
      const audioStream = data?.streams?.find((s: any) => s.codec_type === 'audio') || data?.streams?.[0];
      if (!audioStream) return null;

      const codec = (audioStream.codec_name || 'unknown').toUpperCase();
      const sampleRate = parseInt(audioStream.sample_rate || '44100', 10);
      const channels = parseInt(audioStream.channels || '2', 10);
      let bitDepth = parseInt(audioStream.bits_per_sample || audioStream.bits_per_raw_sample || '0', 10);
      if (!bitDepth || bitDepth === 0) {
        const fmt = (audioStream.sample_fmt || '').toLowerCase();
        if (fmt.includes('s32') || fmt.includes('flt')) bitDepth = 24;
        else if (fmt.includes('s24')) bitDepth = 24;
        else bitDepth = 16;
      }
      const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels}ch`;
      return `${codec} · ${bitDepth}-bit · ${sampleRate} Hz · ${channelLabel}`;
    } catch {
      return null;
    }
  }

  public async checkEngineUpdates(): Promise<Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }>> {
    const status = await this.getEngineStatus();
    const result: Record<string, { currentVersion: string; latestVersion: string; updateAvailable: boolean }> = {};

    // 1. yt-dlp check
    try {
      const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
        headers: { 'User-Agent': 'VANTA-Download-Manager' },
      });
      if (res.ok) {
        const data: any = await res.json();
        const latest = data.tag_name || '';
        const current = status.ytdlp.version;
        result.ytdlp = {
          currentVersion: current,
          latestVersion: latest,
          updateAvailable: Boolean(latest && current && latest !== current),
        };
      }
    } catch {
      result.ytdlp = { currentVersion: status.ytdlp.version, latestVersion: status.ytdlp.version, updateAvailable: false };
    }

    // 2. spotdl check
    try {
      const res = await fetch('https://api.github.com/repos/spotDL/spotify-downloader/releases/latest', {
        headers: { 'User-Agent': 'VANTA-Download-Manager' },
      });
      if (res.ok) {
        const data: any = await res.json();
        const latest = (data.tag_name || '').replace(/^v/, '');
        const current = status.spotdl.version.replace(/^v/, '');
        result.spotdl = {
          currentVersion: current,
          latestVersion: latest,
          updateAvailable: Boolean(latest && current && latest !== current),
        };
      }
    } catch {
      result.spotdl = { currentVersion: status.spotdl.version, latestVersion: status.spotdl.version, updateAvailable: false };
    }

    // 3. ffmpeg & ffprobe
    result.ffmpeg = { currentVersion: status.ffmpeg.version, latestVersion: status.ffmpeg.version, updateAvailable: false };
    result.ffprobe = { currentVersion: status.ffprobe.version, latestVersion: status.ffprobe.version, updateAvailable: false };

    return result;
  }

  public async updateEngine(engineName: string): Promise<EngineUpdateResult> {
    const status = await this.getEngineStatus();
    const binDir = path.resolve(process.cwd(), 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    if (engineName === 'ytdlp' || engineName === 'yt-dlp') {
      const prevVersion = status.ytdlp.version;
      const targetBin = path.join(binDir, 'yt-dlp');
      const tempBin = path.join(binDir, 'yt-dlp.tmp');
      const backupBin = path.join(binDir, 'yt-dlp.bak');

      try {
        execSync(`curl -L -o "${tempBin}" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod +x "${tempBin}"`, {
          timeout: 60000,
          windowsHide: true,
        });

        const verOutput = execSync(`"${tempBin}" --version`, {
          encoding: 'utf-8',
          timeout: 5000,
          windowsHide: true,
        }).trim();
        if (!verOutput) throw new Error('Verification failed: newly downloaded binary returned empty version');

        if (fs.existsSync(targetBin)) {
          fs.copyFileSync(targetBin, backupBin);
        }

        fs.renameSync(tempBin, targetBin);
        fs.chmodSync(targetBin, 0o755);

        return {
          engine: 'yt-dlp',
          success: true,
          previousVersion: prevVersion,
          currentVersion: verOutput,
          message: `Successfully upgraded yt-dlp to version ${verOutput}`,
        };
      } catch (err: any) {
        if (fs.existsSync(backupBin) && !fs.existsSync(targetBin)) {
          fs.copyFileSync(backupBin, targetBin);
        }
        if (fs.existsSync(tempBin)) {
          try { fs.unlinkSync(tempBin); } catch {}
        }
        return {
          engine: 'yt-dlp',
          success: false,
          previousVersion: prevVersion,
          currentVersion: prevVersion,
          message: `Failed to update yt-dlp: ${err.message}`,
          rolledBack: true,
        };
      }
    }

    if (engineName === 'spotdl') {
      const prevVersion = status.spotdl.version;
      try {
        execSync(`python3 -m pip install --upgrade --user spotdl`, {
          encoding: 'utf-8',
          timeout: 120000,
          windowsHide: true,
        });

        const spotdlBin = this.findExecutable('spotdl');
        const verOutput = spotdlBin
          ? execSync(`"${spotdlBin}" --version`, {
              encoding: 'utf-8',
              timeout: 5000,
              windowsHide: true,
            }).trim()
          : '';

        return {
          engine: 'spotdl',
          success: true,
          previousVersion: prevVersion,
          currentVersion: verOutput || prevVersion,
          message: `Successfully upgraded spotDL to ${verOutput || 'latest'}`,
        };
      } catch (err: any) {
        return {
          engine: 'spotdl',
          success: false,
          previousVersion: prevVersion,
          currentVersion: prevVersion,
          message: `Failed to update spotDL: ${err.message}`,
          rolledBack: false,
        };
      }
    }

    return {
      engine: engineName,
      success: false,
      previousVersion: '',
      currentVersion: '',
      message: `Engine ${engineName} does not support in-app automated updates.`,
    };
  }

  public async getManagedEngineInfo(): Promise<ManagedEngineInfo> {
    const engines = await this.getEngineStatus();
    const missingRequired: string[] = [];
    if (!engines.ytdlp.available) missingRequired.push('yt-dlp');
    if (!engines.ffmpeg.available) missingRequired.push('ffmpeg');
    if (!engines.ffprobe.available) missingRequired.push('ffprobe');

    return {
      installDir: this.getManagedBinDir(),
      manifestPath: path.join(this.getManagedRootDir(), 'manifest.json'),
      requiredReady: missingRequired.length === 0,
      missingRequired,
      engines,
    };
  }

  public async installEngine(
    engineName: string,
    force = false,
    onProgress?: (progress: EngineInstallProgress) => void
  ): Promise<EngineUpdateResult> {
    const normalized = engineName.toLowerCase() === 'ytdlp' ? 'yt-dlp' : engineName.toLowerCase();
    const status = await this.getEngineStatus();
    const alreadyReady =
      (normalized === 'yt-dlp' && status.ytdlp.available) ||
      ((normalized === 'ffmpeg' || normalized === 'ffprobe') && status.ffmpeg.available && status.ffprobe.available) ||
      (normalized === 'spotdl' && status.spotdl.available);

    if (!force && alreadyReady) {
      const currentVer =
        normalized === 'yt-dlp'
          ? status.ytdlp.version
          : normalized === 'spotdl'
          ? status.spotdl.version
          : status.ffmpeg.version;
      onProgress?.({
        engine: normalized,
        status: 'ready',
        phase: 'Already installed',
        progressPercentage: 100,
        downloadedBytes: 0,
        totalBytes: 0,
        message: `${normalized} is already installed and verified.`,
      });
      return {
        engine: normalized,
        success: true,
        previousVersion: currentVer,
        currentVersion: currentVer,
        message: `${normalized} is already installed and verified.`,
      };
    }

    if (normalized === 'yt-dlp') {
      const binDir = this.getManagedBinDir();
      fs.mkdirSync(binDir, { recursive: true });
      const prevVersion = status.ytdlp.version;
      const assetName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const targetBin = path.join(binDir, assetName);
      const tempBin = path.join(binDir, `${assetName}.part`);
      const backupBin = path.join(binDir, `${assetName}.bak`);

      try {
        onProgress?.({
          engine: 'yt-dlp',
          status: 'downloading',
          phase: 'Fetching SHA-256 manifest...',
          progressPercentage: 5,
          downloadedBytes: 0,
          totalBytes: 0,
          message: 'Fetching verified yt-dlp release checksums...',
        });

        const sumRes = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS');
        if (!sumRes.ok) throw new Error(`Checksum manifest returned HTTP ${sumRes.status}`);
        const sumText = await sumRes.text();
        const line = sumText
          .split('\n')
          .map((l) => l.trim().split(/\s+/))
          .find((parts) => parts.length >= 2 && parts[1] === assetName);
        if (!line) throw new Error(`Missing SHA-256 entry for ${assetName}`);
        const expectedSha = line[0].toLowerCase();

        const binRes = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`);
        if (!binRes.ok) throw new Error(`Download failed with HTTP ${binRes.status}`);
        const totalBytes = Number(binRes.headers.get('content-length') || 0);
        const buf = Buffer.from(await binRes.arrayBuffer());
        fs.writeFileSync(tempBin, buf);

        onProgress?.({
          engine: 'yt-dlp',
          status: 'verifying',
          phase: 'Verifying SHA-256 checksum...',
          progressPercentage: 90,
          downloadedBytes: buf.length,
          totalBytes: totalBytes || buf.length,
          message: 'Verifying SHA-256 integrity...',
        });

        const actualSha = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
        if (actualSha !== expectedSha) {
          throw new Error(`SHA-256 verification failed (expected ${expectedSha}, got ${actualSha})`);
        }

        if (process.platform !== 'win32') fs.chmodSync(tempBin, 0o755);
        const verOutput = execSync(`"${tempBin}" --version`, {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
        }).trim();
        if (!verOutput) throw new Error('Downloaded binary failed --version check');

        if (fs.existsSync(targetBin)) fs.copyFileSync(targetBin, backupBin);
        fs.renameSync(tempBin, targetBin);
        if (fs.existsSync(backupBin)) fs.unlinkSync(backupBin);

        onProgress?.({
          engine: 'yt-dlp',
          status: 'ready',
          phase: 'Installed & Verified',
          progressPercentage: 100,
          downloadedBytes: buf.length,
          totalBytes: buf.length,
          message: `yt-dlp ${verOutput} installed cleanly`,
        });

        return {
          engine: 'yt-dlp',
          success: true,
          previousVersion: prevVersion,
          currentVersion: verOutput,
          message: `Successfully installed verified yt-dlp ${verOutput}`,
        };
      } catch (err: any) {
        if (fs.existsSync(tempBin)) {
          try { fs.unlinkSync(tempBin); } catch {}
        }
        onProgress?.({
          engine: 'yt-dlp',
          status: 'error',
          phase: 'Installation failed',
          progressPercentage: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          message: err.message,
          error: err.message,
        });
        return {
          engine: 'yt-dlp',
          success: false,
          previousVersion: prevVersion,
          currentVersion: prevVersion,
          message: `Failed to install yt-dlp: ${err.message}`,
          rolledBack: true,
        };
      }
    }

    return this.updateEngine(engineName);
  }

  public async installAllEngines(
    includeSpotdl = true,
    force = false,
    onProgress?: (progress: EngineInstallProgress) => void
  ): Promise<EngineUpdateResult[]> {
    const results: EngineUpdateResult[] = [];
    results.push(await this.installEngine('yt-dlp', force, onProgress));
    if (includeSpotdl) {
      results.push(await this.installEngine('spotdl', force, onProgress));
    }
    return results;
  }

  public async updateAllEngines(): Promise<EngineUpdateResult[]> {
    const results: EngineUpdateResult[] = [];
    results.push(await this.updateEngine('ytdlp'));
    results.push(await this.updateEngine('spotdl'));
    return results;
  }
}

export const engineManager = new EngineManager();
