import { spawn, execFileSync, ChildProcess } from 'node:child_process';
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
  PlaylistEntry,
  PythonValidationResult,
} from '../src/types';
import {
  parseYtdlpProgress,
  parseVantaBeforeDlMeta,
  parseSpotdlProgressLine,
  StreamingLineParser,
  selectBestThumbnail,
  isValidThumbnailUrl,
  formatDuration,
  sanitizeFilename,
  determineEngineForUrl,
  isPlaylistCandidateUrl,
  validateMediaUrl,
  formatYtDlpPlaylistItems,
} from '../src/utils/engine-parser';
import { ProgressTracker, buildIdleMetricsPatch } from '../src/utils/download-core';
import { resolveVideoFormatSelector } from '../src/utils/media-formats';
import { sanitizeLog } from '../src/utils/error-classifier';
import { tryParseSpotifyInput } from '../src/utils/spotify';
import { getAppDataDir, getSettings, getSettingsFilePath, isPlaceholderTaskTitle } from './db';
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

export interface EngineManagerOptions {
  executables?: Partial<Record<'yt-dlp' | 'spotdl' | 'ffmpeg' | 'ffprobe' | 'python3', string>>;
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
  const res = validateMediaUrl(raw);
  if (!res.valid) {
    throw new Error(res.error);
  }
  return res.normalized;
}

export async function validatePythonExecutable(rawPath: string): Promise<PythonValidationResult> {
  const trimmed = (rawPath || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      executablePath: '',
      error: 'Python executable path cannot be empty.',
    };
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    return {
      valid: false,
      executablePath: trimmed,
      error: `Configured Python executable does not exist: ${trimmed}`,
    };
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) {
      return {
        valid: false,
        executablePath: trimmed,
        error: `Configured Python path is not a file: ${trimmed}`,
      };
    }
  } catch (err: any) {
    return {
      valid: false,
      executablePath: trimmed,
      error: `Unable to inspect Python path: ${err?.message || String(err)}`,
    };
  }

  try {
    const res = await runProcessAsync(resolved, ['--version'], ENGINE_VERSION_TIMEOUT_MS);
    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();
    if (res.timedOut) {
      return {
        valid: false,
        executablePath: resolved,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        error: 'Timed out waiting for Python --version response.',
      };
    }
    const combined = (stdout || stderr).trim();
    const firstLine = combined.split(/\r?\n/)[0]?.trim() || '';
    if (res.code === 0 && /^python\s+\d+/i.test(firstLine)) {
      return {
        valid: true,
        executablePath: resolved,
        version: firstLine,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }
    return {
      valid: false,
      executablePath: resolved,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
      error:
        combined ||
        `Executable exited with status ${res.code ?? 'unknown'} and did not report a Python version.`,
    };
  } catch (err: any) {
    return {
      valid: false,
      executablePath: resolved,
      error: `Failed to execute Python binary: ${err?.message || String(err)}`,
    };
  }
}

export class EngineManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private activeAbortHandlers: Map<string, () => void> = new Map();
  private cancelledTasks: Set<string> = new Set();
  private activeInspections: Map<string, TrackedInspection> = new Map();
  private cachedEngineStatus: { ts: number; data: EngineStatusMap } | null = null;
  private inflightEngineScan: Promise<EngineStatusMap> | null = null;
  private readonly executableOverrides: Partial<Record<string, string>>;

  constructor(options?: EngineManagerOptions) {
    this.executableOverrides = { ...(options?.executables || {}) };
  }

  public getInstallRootDir(): string {
    const override = process.env.VANTA_ENGINE_ROOT?.trim();
    if (override) {
      return path.dirname(path.resolve(override));
    }
    if (process.platform === 'win32') {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const installedDir = path.join(programFiles, 'VANTA Download Manager');
      if (fs.existsSync(installedDir)) {
        return installedDir;
      }
      return path.resolve(process.cwd(), '.vanta_install');
    }
    if (process.env.XDG_DATA_HOME?.trim()) {
      return path.join(process.env.XDG_DATA_HOME.trim(), 'vanta-download-manager', 'install');
    }
    const home = os.homedir();
    if (home && home !== '/') {
      return path.join(home, '.local', 'share', 'vanta-download-manager', 'install');
    }
    return path.join(os.tmpdir(), 'vanta-download-manager-install');
  }

  public getManagedRootDir(): string {
    const override = process.env.VANTA_ENGINE_ROOT?.trim();
    if (override) {
      return path.resolve(override);
    }
    return path.join(this.getInstallRootDir(), 'Engine');
  }

  public getYtdlpDir(): string {
    return path.join(this.getManagedRootDir(), 'yt-dlp');
  }

  public getSpotdlDir(): string {
    return path.join(this.getManagedRootDir(), 'spotdl');
  }

  public getSpotdlVenvDir(): string {
    return path.join(this.getSpotdlDir(), 'venv');
  }

  public getSpotdlVenvPython(): string {
    return process.platform === 'win32'
      ? path.join(this.getSpotdlVenvDir(), 'Scripts', 'python.exe')
      : path.join(this.getSpotdlVenvDir(), 'bin', 'python3');
  }

  public getSpotdlVenvExe(): string {
    return process.platform === 'win32'
      ? path.join(this.getSpotdlVenvDir(), 'Scripts', 'spotdl.exe')
      : path.join(this.getSpotdlVenvDir(), 'bin', 'spotdl');
  }

  public getFfmpegDir(): string {
    return path.join(this.getManagedRootDir(), 'ffmpeg', 'bin');
  }

  public getManagedBinDir(): string {
    return this.getManagedRootDir();
  }

  public getManifestPath(): string {
    return path.join(this.getManagedRootDir(), 'manifest.json');
  }

  private isDirWritable(dir: string): boolean {
    try {
      const checkDir = fs.existsSync(dir) ? dir : this.getInstallRootDir();
      if (!fs.existsSync(checkDir)) {
        fs.mkdirSync(checkDir, { recursive: true });
      }
      const probe = path.join(checkDir, `.vanta_probe_${process.pid}_${Date.now()}`);
      fs.writeFileSync(probe, 'ok', 'utf-8');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  public findExecutable(name: string): string | null {
    const instanceOverride = this.executableOverrides[name]?.trim();
    if (instanceOverride && fs.existsSync(instanceOverride)) {
      return instanceOverride;
    }

    const envKey =
      name === 'yt-dlp'
        ? 'VANTA_TEST_YTDLP_PATH'
        : name === 'spotdl'
        ? 'VANTA_TEST_SPOTDL_PATH'
        : name === 'ffmpeg'
        ? 'VANTA_TEST_FFMPEG_PATH'
        : name === 'ffprobe'
        ? 'VANTA_TEST_FFPROBE_PATH'
        : '';
    const envOverride = envKey ? process.env[envKey]?.trim() : '';
    if (envOverride && fs.existsSync(envOverride)) {
      return envOverride;
    }

    const exeName = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
    const candidates: string[] = [];

    if (name === 'yt-dlp') {
      candidates.push(path.join(this.getYtdlpDir(), exeName));
    } else if (name === 'ffmpeg' || name === 'ffprobe') {
      candidates.push(path.join(this.getFfmpegDir(), exeName));
    } else if (name === 'spotdl') {
      candidates.push(this.getSpotdlVenvExe());
      candidates.push(path.join(this.getSpotdlDir(), exeName));
    }

    candidates.push(
      path.join(this.getManagedRootDir(), exeName),
      path.resolve(process.cwd(), 'bin', exeName),
      path.resolve(process.cwd(), '.venv', 'bin', exeName),
      `/app/applet/.venv/bin/${name}`,
      `/opt/spotdl-venv/bin/${name}`,
      `/root/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`
    );

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
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(lookupCmd, [process.platform === 'win32' ? exeName : name], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)[0]
        ?.trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // not in PATH
    }

    return null;
  }

  public async resolvePythonForSpotdl(settings?: AppSettings): Promise<string> {
    const s = settings || getSettings();
    const configured = (s.python_path || '').trim();
    if (configured) {
      const check = await validatePythonExecutable(configured);
      if (!check.valid) {
        throw new Error(
          check.error ||
            `Configured Python executable '${configured}' is invalid. Fix or clear Python Configuration in Settings.`
        );
      }
      return check.executablePath;
    }

    const systemNames = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    for (const candidate of systemNames) {
      const found = this.findExecutable(candidate.replace(/\.exe$/i, ''));
      if (found) {
        const check = await validatePythonExecutable(found);
        if (check.valid) return check.executablePath;
      }
    }

    throw new Error(
      'No valid Python 3 interpreter found. Configure the Python executable path in Settings > Python Configuration.'
    );
  }

  public async resolveSpotdlInvocation(settings?: AppSettings): Promise<{ program: string; leadingArgs: string[] }> {
    const testSpotdlOverride =
      this.executableOverrides['spotdl']?.trim() || process.env.VANTA_TEST_SPOTDL_PATH?.trim();
    if (testSpotdlOverride && fs.existsSync(testSpotdlOverride)) {
      return { program: testSpotdlOverride, leadingArgs: [] };
    }

    const s = settings || getSettings();
    if ((s.python_path || '').trim()) {
      await this.resolvePythonForSpotdl(s);
    }

    const venvPy = this.getSpotdlVenvPython();
    if (fs.existsSync(venvPy)) {
      return { program: venvPy, leadingArgs: ['-m', 'spotdl'] };
    }
    const venvExe = this.getSpotdlVenvExe();
    if (fs.existsSync(venvExe)) {
      return { program: venvExe, leadingArgs: [] };
    }
    const standalone = path.join(
      this.getSpotdlDir(),
      process.platform === 'win32' ? 'spotdl.exe' : 'spotdl'
    );
    if (fs.existsSync(standalone)) {
      return { program: standalone, leadingArgs: [] };
    }
    const found = this.findExecutable('spotdl');
    if (found) {
      return { program: found, leadingArgs: [] };
    }
    throw new Error(
      'spotDL runtime is not installed in Engine/spotdl. Install spotDL from Diagnostics or configure Python 3 in Settings.'
    );
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
      includePlaylist?: boolean;
    }
  ): Promise<MediaMetadata> {
    const url = validateInspectionUrl(rawUrl);
    const engine = determineEngineForUrl(url);
    const settings = getSettings();

    if (engine === 'spotdl') {
      return this.inspectSpotdlUrl(url, requestId, options?.timeoutMs);
    }

    const ytdlpPath = options?.ytdlpBinary || this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      throw new Error('yt-dlp engine is not installed or not available.');
    }

    const cookieRequestArgs = this.getRequestAndCookieArgs(url, settings);
    const reqId = requestId || `insp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = options?.timeoutMs ?? INSPECT_URL_TIMEOUT_MS;
    const maxStdoutBytes = options?.maxStdoutBytes ?? INSPECT_MAX_STDOUT_BYTES;
    const wantsPlaylist = isPlaylistCandidateUrl(url) && (options?.includePlaylist ?? true);

    const args = [
      '--dump-single-json',
      wantsPlaylist ? '--flat-playlist' : '--no-playlist',
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

            const entries: PlaylistEntry[] | undefined =
              isPlaylist && Array.isArray(raw.entries)
                ? raw.entries
                    .map((entry: any, rawIndex: number) => ({ entry, rawIndex }))
                    .filter(({ entry }: { entry: any }) => Boolean(entry))
                    .slice(0, 1000)
                    .map(({ entry: e, rawIndex }: { entry: any; rawIndex: number }): PlaylistEntry => {
                      const candidateUrl = e.webpage_url || e.original_url || e.url;
                      const isAbsoluteMediaUrl =
                        typeof candidateUrl === 'string' && /^https?:\/\//i.test(candidateUrl);
                      const entryUrl =
                        (isAbsoluteMediaUrl ? candidateUrl : undefined) ||
                        (e.id && /youtube/i.test(String(raw.extractor_key || raw.extractor || ''))
                          ? `https://www.youtube.com/watch?v=${e.id}`
                          : url);
                      return {
                        id: String(e.id || rawIndex + 1),
                        index: Number.isInteger(e.playlist_index) && e.playlist_index > 0 ? e.playlist_index : rawIndex + 1,
                        title: String(e.title || `Item ${rawIndex + 1}`),
                        url: String(entryUrl),
                        duration: typeof e.duration === 'number' ? e.duration : undefined,
                        duration_string: e.duration ? formatDuration(e.duration) : undefined,
                        uploader: e.uploader || e.channel || raw.uploader || undefined,
                        thumbnail: selectBestThumbnail(e),
                      };
                    })
                : undefined;

            const metadata: MediaMetadata = {
              url,
              id: raw.id || String(Date.now()),
              title: raw.title || 'Untitled Media',
              uploader: raw.uploader || raw.channel || raw.artist || 'Unknown',
              duration: raw.duration,
              duration_string: formatDuration(raw.duration),
              thumbnail: selectBestThumbnail(raw),
              description: raw.description ? String(raw.description).slice(0, 500) : undefined,
              formats: parsedFormats,
              is_playlist: isPlaylist,
              playlist_count: isPlaylist && raw.entries ? raw.entries.length : undefined,
              entries,
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
    onComplete: (outputPath: string, extra?: Partial<DownloadTask>) => void,
    onError: (err: string) => void
  ): void {
    this.cancelledTasks.delete(task.id);
    if (task.engine !== 'spotdl' && task.engine !== 'yt-dlp') {
      return onError(
        'Generic direct file downloads are not supported. VANTA only downloads video and music URLs via yt-dlp or spotDL.'
      );
    }
    if (task.engine === 'spotdl') {
      void this.executeSpotdlDownload(task, settings, onProgress, onComplete, onError);
    } else {
      this.executeYtdlpDownload(task, settings, onProgress, onComplete, onError);
    }
  }

  private resolveOutputDir(task: DownloadTask, settings: AppSettings): string {
    if (task.output_path && !path.extname(task.output_path)) {
      return task.output_path;
    }
    return settings.download_dir;
  }

  private findRecentlyCreatedFile(
    dir: string,
    startedAtMs: number,
    isAudio: boolean,
    excludePaths?: Set<string>
  ): string | null {
    if (!fs.existsSync(dir)) return null;
    const allowedExts = isAudio
      ? new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.opus', '.ogg', '.webm'])
      : new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.m4v', '.ts', '.mp3', '.m4a', '.opus', '.flac']);

    let bestPath: string | null = null;
    let bestMtime = 0;

    const scan = (currentDir: string, depth: number) => {
      if (depth > 2) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        if (excludePaths?.has(full)) continue;
        if (entry.isDirectory()) {
          scan(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.part') || lower.endsWith('.ytdl') || lower.endsWith('.temp') || lower.endsWith('.tmp')) {
          continue;
        }
        const ext = path.extname(lower);
        if (!allowedExts.has(ext)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > 0 && st.mtimeMs >= startedAtMs - 2500 && st.mtimeMs >= bestMtime) {
            bestMtime = st.mtimeMs;
            bestPath = full;
          }
        } catch {
          // ignore
        }
      }
    };

    scan(dir, 0);
    return bestPath;
  }

  private snapshotDirFiles(dir: string): Map<string, { size: number; mtimeMs: number }> {
    const snap = new Map<string, { size: number; mtimeMs: number }>();
    if (!fs.existsSync(dir)) return snap;
    const scan = (currentDir: string, depth: number) => {
      if (depth > 2) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (entry.isFile()) {
          try {
            const st = fs.statSync(full);
            snap.set(full, { size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // ignore
          }
        }
      }
    };
    scan(dir, 0);
    return snap;
  }

  private measureSpotdlActiveBytes(
    dir: string,
    baseline: Map<string, { size: number; mtimeMs: number }>,
    startedAtMs: number
  ): { totalBytes: number; latestFile: string | null } {
    if (!fs.existsSync(dir)) return { totalBytes: 0, latestFile: null };
    const mediaOrTempExt = /\.(mp3|flac|wav|m4a|aac|opus|ogg|webm|mp4|mkv|part|temp)$/i;
    let totalBytes = 0;
    let latestFile: string | null = null;
    let latestMtime = 0;

    const scan = (currentDir: string, depth: number) => {
      if (depth > 2) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (entry.isFile() && (mediaOrTempExt.test(entry.name) || entry.name.includes('.part'))) {
          try {
            const st = fs.statSync(full);
            const prev = baseline.get(full);
            const isRecent =
              !prev || st.size > prev.size || st.mtimeMs >= startedAtMs - 1000;
            if (isRecent && st.size > 0) {
              const contributed = prev && st.mtimeMs <= prev.mtimeMs ? Math.max(0, st.size - prev.size) : st.size;
              totalBytes += contributed;
              if (st.mtimeMs >= latestMtime && !entry.name.endsWith('.part') && !entry.name.endsWith('.temp')) {
                latestMtime = st.mtimeMs;
                latestFile = full;
              }
            }
          } catch {
            // ignore
          }
        }
      }
    };
    scan(dir, 0);
    return { totalBytes, latestFile };
  }

  private executeYtdlpDownload(
    task: DownloadTask,
    settings: AppSettings,
    onProgress: (update: Partial<DownloadTask>) => void,
    onComplete: (outputPath: string, extra?: Partial<DownloadTask>) => void,
    onError: (err: string) => void
  ): void {
    const ytdlpPath = this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      return onError('yt-dlp executable not found.');
    }

    const outDir = this.resolveOutputDir(task, settings);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const customStem = task.custom_filename?.trim()
      ? sanitizeFilename(task.custom_filename.trim()).replace(/\.[^.]+$/, '')
      : '';
    const outTemplate = customStem
      ? path.join(outDir, `${customStem}.%(ext)s`)
      : path.join(outDir, settings.filename_template || '%(title)s [%(id)s].%(ext)s');

    const args: string[] = [
      '--newline',
      '--no-colors',
      '--no-quiet',
      '--progress',
      '--progress-delta',
      '0.2',
      '--progress-template',
      'download:%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s',
      '--print',
      'before_dl:VANTA_META:%(id)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s',
      '--print',
      'after_move:VANTA_OUTPUT_FILE:%(filepath)s',
      '-o',
      outTemplate,
      // Retry transient CDN/segment failures and never report a file as complete
      // when yt-dlp had to skip an unavailable media fragment.
      '--retries', '15',
      '--fragment-retries', '20',
      '--file-access-retries', '10',
      '--retry-sleep', 'fragment:exp=1:60',
      '--socket-timeout', '60',
      '--extractor-retries', '5',
      '--abort-on-unavailable-fragments',
    ];

    if (task.playlist_mode === 'playlist') {
      args.push('--yes-playlist');
      const selectedNums = (task.selected_items || [])
        .map((item) => Number(item))
        .filter((n) => Number.isInteger(n) && n > 0);
      const playlistSpec = formatYtDlpPlaylistItems(selectedNums);
      if (playlistSpec) {
        args.push('--playlist-items', playlistSpec);
      }
    } else {
      args.push('--no-playlist');
    }

    if (settings.conflict_strategy === 'overwrite') {
      args.push('--force-overwrites');
    } else {
      args.push('--no-overwrites');
    }

    try {
      const requestArgs = this.getRequestAndCookieArgs(task.url, settings);
      args.push(...requestArgs);
    } catch (err: any) {
      return onError(err.message || 'Invalid cookie configuration');
    }

    if (task.retries > 0) {
      args.push('--no-cache-dir');
      args.push('--extractor-args', 'youtube:player_client=default,web,android');
    }

    if (settings.global_bandwidth_limit_kbps > 0) {
      args.push('--limit-rate', `${settings.global_bandwidth_limit_kbps}K`);
    } else if (settings.per_task_bandwidth_limit_kbps > 0) {
      args.push('--limit-rate', `${settings.per_task_bandwidth_limit_kbps}K`);
    }

    if (settings.proxy_url) {
      args.push('--proxy', settings.proxy_url);
    }

    if (task.is_audio_only) {
      args.push('-x');
      const audioFormat = task.audio_format || settings.default_audio_format || 'mp3';
      args.push('--audio-format', audioFormat);
      // Lossless containers do not use a lossy encoder bitrate target.
      if (task.audio_bitrate && !['flac', 'wav'].includes(audioFormat.toLowerCase())) {
        args.push('--audio-quality', task.audio_bitrate);
      }
      if (task.audio_sample_rate || task.audio_bit_depth) {
        let pp = 'ExtractAudio:';
        if (task.audio_sample_rate) pp += ` -ar ${task.audio_sample_rate}`;
        // FFmpeg has no packed s24 sample format. Use 32-bit working samples and
        // explicitly request 24-bit FLAC encoding; don't pass the invalid "s24" format.
        if (task.audio_bit_depth === 24 && audioFormat.toLowerCase() === 'flac') {
          pp += ' -sample_fmt s32 -bits_per_raw_sample 24';
        } else if (task.audio_bit_depth === 24 && audioFormat.toLowerCase() === 'wav') {
          pp += ' -sample_fmt s32';
        }
        args.push('--postprocessor-args', pp.trim());
      }
    } else {
      const selector = resolveVideoFormatSelector(task.format_id);
      args.push('-f', selector);
      const preferredContainer =
        task.ext && ['mp4', 'mkv', 'webm', 'mov'].includes(task.ext.toLowerCase())
          ? task.ext.toLowerCase()
          : 'mp4';
      args.push('--merge-output-format', preferredContainer);
    }

    if (settings.embed_thumbnail) {
      args.push('--embed-thumbnail');
    }
    if (settings.embed_metadata) {
      args.push('--embed-metadata');
    }

    // Conservative concurrency reduces CDN throttling and missing HLS/DASH fragments.
    const safeFragmentConcurrency = Math.max(1, Math.min(2, settings.fragment_concurrency || 1));
    if (safeFragmentConcurrency > 1) {
      args.push('-N', String(safeFragmentConcurrency));
    }

    let validatedTaskUrl = task.url;
    try {
      validatedTaskUrl = validateInspectionUrl(task.url);
    } catch (urlErr: any) {
      return onError(urlErr.message || 'Invalid download URL');
    }

    args.push('--', validatedTaskUrl);

    const startedAtMs = Date.now();
    const tracker = new ProgressTracker({ alpha: 0.3, startedAtMs });
    const stdoutParser = new StreamingLineParser();
    const stderrParser = new StreamingLineParser();
    const seenDownloadDestinations = new Set<string>();

    let lastOutputAtMs = startedAtMs;
    let lastByteAdvanceAtMs = startedAtMs;
    let lastObservedBytes = 0;
    let hasReceivedDownloadProgress = false;
    let currentPhaseStatus: DownloadTask['status'] = 'connecting';
    let lastKnownBytes = 0;
    let lastKnownTotal = task.total_bytes || 0;
    let metadataBackfilled = isValidThumbnailUrl(task.thumbnail) && !isPlaceholderTaskTitle(task.title);
    let settled = false;
    let watchdogTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      this.activeProcesses.delete(task.id);
      this.activeAbortHandlers.delete(task.id);
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
    };

    onProgress({
      status: 'connecting',
      current_phase: 'Connecting to media extractor...',
      started_at: task.started_at || new Date(startedAtMs).toISOString(),
      active_connections: Math.max(1, settings.fragment_concurrency || 1),
    });

    try {
      const proc = spawn(ytdlpPath, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.activeProcesses.set(task.id, proc);

      let lastOutput = '';
      let detectedOutputFile = '';
      let lastComputedState: ReturnType<ProgressTracker['update']> | null = null;

      watchdogTimer = setInterval(() => {
        if (settled || this.cancelledTasks.has(task.id)) return;
        const now = Date.now();
        if (!hasReceivedDownloadProgress && now - lastOutputAtMs >= 12_000) {
          onProgress({
            status: 'connecting',
            current_phase: 'Waiting for source response...',
            elapsed_seconds: Math.round((now - startedAtMs) / 1000),
          });
        } else if (
          hasReceivedDownloadProgress &&
          currentPhaseStatus === 'downloading' &&
          now - lastByteAdvanceAtMs >= 15_000
        ) {
          onProgress({
            status: 'downloading',
            current_phase: 'Transfer stalled — waiting for incoming data...',
            speed_bytes_per_sec: 0,
            speed_str: '0 B/s',
            elapsed_seconds: Math.round((now - startedAtMs) / 1000),
          });
        }
      }, 2_000);
      watchdogTimer.unref?.();

      this.activeAbortHandlers.set(task.id, cleanup);

      const handleLine = (rawLine: string) => {
        if (settled || this.cancelledTasks.has(task.id)) return;
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        lastOutputAtMs = Date.now();

        if (trimmed.startsWith('VANTA_OUTPUT_FILE:')) {
          const printedPath = trimmed.slice('VANTA_OUTPUT_FILE:'.length).trim();
          if (printedPath) detectedOutputFile = printedPath;
          return;
        }

        if (trimmed.startsWith('VANTA_META:')) {
          const meta = parseVantaBeforeDlMeta(trimmed);
          if (meta) {
            const metaPatch: Partial<DownloadTask> = {};
            if (meta.thumbnail && !isValidThumbnailUrl(task.thumbnail)) {
              metaPatch.thumbnail = meta.thumbnail;
            }
            if (meta.title && isPlaceholderTaskTitle(task.title)) {
              metaPatch.title = meta.title;
            }
            if (meta.uploader && !task.uploader) {
              metaPatch.uploader = meta.uploader;
            }
            if (meta.duration && !task.duration) {
              metaPatch.duration = meta.duration;
              metaPatch.duration_string = formatDuration(meta.duration);
            }
            if (Object.keys(metaPatch).length > 0 || !metadataBackfilled) {
              metadataBackfilled = true;
              onProgress(metaPatch);
            }
          }
          return;
        }

        const destMatch = trimmed.match(/\[(?:download|ExtractAudio)\]\s+Destination:\s*(.*)$/);
        if (destMatch && destMatch[1]) {
          const destPath = destMatch[1].trim().replace(/^["']|["']$/g, '');
          if (destPath) {
            detectedOutputFile = destPath;
            if (seenDownloadDestinations.size > 0 && !seenDownloadDestinations.has(destPath)) {
              tracker.resetStream({ nowMs: Date.now() });
              lastObservedBytes = 0;
            }
            seenDownloadDestinations.add(destPath);
          }
        }

        const mergerMatch = trimmed.match(/\[(?:Merger|Fixup\w+)\]\s+Merging formats into\s+["']?(.*?)["']?$/);
        if (mergerMatch && mergerMatch[1]) {
          detectedOutputFile = mergerMatch[1].trim().replace(/^["']|["']$/g, '');
        }

        const parsed = parseYtdlpProgress(trimmed);
        if (!parsed) return;

        if (parsed.phase === 'connecting') {
          currentPhaseStatus = 'connecting';
          onProgress({
            status: 'connecting',
            current_phase: parsed.phaseLabel || 'Resolving media source...',
            elapsed_seconds: Math.round((Date.now() - startedAtMs) / 1000),
          });
          return;
        }

        if (parsed.phase === 'muxing') {
          currentPhaseStatus = 'muxing';
          onProgress({
            status: 'muxing',
            current_phase: parsed.phaseLabel || 'Muxing video & audio streams via FFmpeg...',
            downloaded_bytes: lastComputedState?.downloaded_bytes ?? lastKnownBytes,
            total_bytes: lastComputedState?.total_bytes ?? lastKnownTotal,
            progress_percentage: lastComputedState?.progress_percentage ?? (lastKnownTotal > 0 ? 100 : 0),
            speed_bytes_per_sec: 0,
            speed_str: '0 B/s',
            eta_seconds: null,
            eta_str: '--',
            active_connections: 0,
          });
          return;
        }

        if (parsed.phase === 'processing' || parsed.phase === 'converting') {
          currentPhaseStatus = 'processing';
          onProgress({
            status: 'processing',
            current_phase: parsed.phaseLabel || 'Processing & embedding metadata...',
            downloaded_bytes: lastComputedState?.downloaded_bytes ?? lastKnownBytes,
            total_bytes: lastComputedState?.total_bytes ?? lastKnownTotal,
            progress_percentage: lastComputedState?.progress_percentage ?? (lastKnownTotal > 0 ? 100 : 0),
            speed_bytes_per_sec: 0,
            speed_str: '0 B/s',
            eta_seconds: null,
            eta_str: '--',
            active_connections: 0,
          });
          return;
        }

        if (parsed.playlistItemIndex !== undefined && parsed.playlistItemCount !== undefined) {
          currentPhaseStatus = 'downloading';
          onProgress({
            status: 'downloading',
            current_phase: parsed.phaseLabel || `Downloading item ${parsed.playlistItemIndex} of ${parsed.playlistItemCount}...`,
            tracks_requested: task.tracks_requested || parsed.playlistItemCount,
            tracks_completed: Math.max(0, parsed.playlistItemIndex - 1),
          });
          return;
        }

        const nowMs = Date.now();
        const incomingBytes = parsed.downloadedBytes ?? 0;
        if (incomingBytes > lastObservedBytes || (parsed.speedBytesPerSec ?? 0) > 0) {
          lastObservedBytes = incomingBytes;
          lastByteAdvanceAtMs = nowMs;
        }

        hasReceivedDownloadProgress = true;
        currentPhaseStatus = 'downloading';

        const computed = tracker.update({
          downloadedBytes: incomingBytes,
          totalBytes: parsed.totalBytes ?? 0,
          instantSpeedBytesPerSec: parsed.speedBytesPerSec,
          percentageHint: parsed.percentageKnown ? parsed.percentage : undefined,
          activeConnections: Math.max(1, settings.fragment_concurrency || 1),
          nowMs,
        });
        lastComputedState = computed;
        lastKnownBytes = computed.downloaded_bytes;
        lastKnownTotal = computed.total_bytes;

        onProgress({
          status: 'downloading',
          current_phase: parsed.phaseLabel || 'Downloading media stream',
          ...computed,
        });
      };

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        for (const line of stdoutParser.push(data)) {
          handleLine(line);
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        for (const line of stderrParser.push(data)) {
          handleLine(line);
        }
      });

      proc.on('close', (code) => {
        if (settled) return;
        for (const tailLine of stdoutParser.flush()) {
          handleLine(tailLine);
        }
        for (const tailLine of stderrParser.flush()) {
          handleLine(tailLine);
        }
        settled = true;
        cleanup();

        if (this.cancelledTasks.has(task.id) || code === null) {
          return;
        }

        if (code === 0) {
          const finalFile =
            detectedOutputFile && fs.existsSync(detectedOutputFile) && fs.statSync(detectedOutputFile).isFile()
              ? detectedOutputFile
              : this.findRecentlyCreatedFile(outDir, startedAtMs, task.is_audio_only);

          if (!finalFile || !fs.existsSync(finalFile)) {
            return onError('Download process finished, but no output file was found on disk.');
          }
          const stat = fs.statSync(finalFile);
          if (!stat.isFile() || stat.size <= 0) {
            return onError('Output file verification failed: file is empty (0 bytes).');
          }

          onProgress({
            status: 'verifying',
            current_phase: 'Verifying output file & codecs...',
            progress_percentage: 100,
            percentage_known: true,
            downloaded_bytes: stat.size,
            total_bytes: stat.size,
            remaining_bytes: 0,
            active_connections: 0,
          });

          const mediaInfo = this.verifyMediaFile(finalFile);
          onComplete(finalFile, {
            total_bytes: stat.size,
            downloaded_bytes: stat.size,
            remaining_bytes: 0,
            percentage_known: true,
            ext: path.extname(finalFile).replace(/^\./, '').toLowerCase() || task.ext,
            verified_audio_info: mediaInfo?.audioSummary || undefined,
            video_codec: mediaInfo?.videoCodec ?? null,
            audio_codec: mediaInfo?.audioCodec ?? null,
            resolution_label: mediaInfo?.resolutionLabel ?? null,
            ...buildIdleMetricsPatch({
              ...task,
              total_bytes: stat.size,
              downloaded_bytes: stat.size,
            }),
            eta_str: 'Finished',
          });
        } else {
          onError(`yt-dlp failed (code ${code}): ${sanitizeLog(lastOutput || 'Unknown error')}`);
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        onError(`Execution error: ${sanitizeLog(err.message)}`);
      });
    } catch (err: any) {
      if (!settled) {
        settled = true;
        cleanup();
        onError(err.message || 'Failed to start download');
      }
    }
  }

  private async executeSpotdlDownload(
    task: DownloadTask,
    settings: AppSettings,
    onProgress: (update: Partial<DownloadTask>) => void,
    onComplete: (outputPath: string, extra?: Partial<DownloadTask>) => void,
    onError: (err: string) => void
  ): Promise<void> {
    let invocation: { program: string; leadingArgs: string[] };
    try {
      invocation = await this.resolveSpotdlInvocation(settings);
    } catch (err: any) {
      return onError(err?.message || 'spotDL runtime is not available.');
    }

    const outDir = this.resolveOutputDir(task, settings);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const format = task.audio_format || settings.default_audio_format || 'mp3';
    const bitrate = task.audio_bitrate || settings.default_audio_bitrate || '320k';
    const ffmpegPath = this.findExecutable('ffmpeg');
    const orderedTracks = Array.isArray(task.selected_items)
      ? task.selected_items.map((u) => String(u).trim()).filter(Boolean)
      : [];

    if (orderedTracks.length > 0) {
      const folderName = sanitizeFilename(task.title || 'Spotify Playlist');
      const targetDir =
        (task.content_type === 'playlist' || task.content_type === 'album') && folderName
          ? path.join(outDir, folderName)
          : outDir;
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const startedAtMs = Date.now();
      let completedCount = 0;
      let failedCount = 0;
      let totalCompletedBytes = 0;
      let lastErr = '';
      let lastFile: string | null = null;
      const verifiedTrackFiles = new Set<string>();

      for (let i = 0; i < orderedTracks.length; i += 1) {
        if (this.cancelledTasks.has(task.id)) return;
        const trackUrl = orderedTracks[i];
        const trackStartedAt = Date.now();
        const baseline = this.snapshotDirFiles(targetDir);
        const trackTracker = new ProgressTracker({ alpha: 0.3, startedAtMs: trackStartedAt });
        let currentPhase = `Matching track ${i + 1} of ${orderedTracks.length}...`;

        onProgress({
          status: 'downloading',
          tracks_requested: orderedTracks.length,
          tracks_completed: completedCount,
          tracks_failed: failedCount,
          percentage_known: true,
          progress_percentage: Math.round((completedCount / orderedTracks.length) * 100),
          downloaded_bytes: totalCompletedBytes,
          current_phase: currentPhase,
        });

        const prefix = String(i + 1).padStart(2, '0');
        const outTemplate = path.join(targetDir, `${prefix} - {artists} - {title}.{output-ext}`);
        const args = [
          ...invocation.leadingArgs,
          'download',
          trackUrl,
          '--output',
          outTemplate,
          '--format',
          format,
          '--bitrate',
          bitrate,
          '--log-level',
          'INFO',
        ];
        if (ffmpegPath) {
          args.push('--ffmpeg', ffmpegPath);
        }

        const res = await new Promise<{ ok: boolean; err: string }>((resolve) => {
          const proc = spawn(invocation.program, args, {
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
          this.activeProcesses.set(task.id, proc);

          const stdoutParser = new StreamingLineParser();
          const stderrParser = new StreamingLineParser();
          let tail = '';
          let settled = false;
          let lastOutputAtMs = Date.now();

          const pollTimer = setInterval(() => {
            if (settled || this.cancelledTasks.has(task.id)) return;
            const measured = this.measureSpotdlActiveBytes(targetDir, baseline, trackStartedAt);
            const nowMs = Date.now();
            if (measured.totalBytes > 0) {
              const computed = trackTracker.update({
                downloadedBytes: measured.totalBytes,
                totalBytes: 0,
                percentageHint: Math.round((completedCount / orderedTracks.length) * 100),
                activeConnections: 1,
                nowMs,
              });
              onProgress({
                status: 'downloading',
                current_phase: currentPhase,
                tracks_requested: orderedTracks.length,
                tracks_completed: completedCount,
                tracks_failed: failedCount,
                downloaded_bytes: totalCompletedBytes + computed.downloaded_bytes,
                total_bytes: 0,
                progress_percentage: Math.round((completedCount / orderedTracks.length) * 100),
                percentage_known: true,
                speed_bytes_per_sec: computed.speed_bytes_per_sec,
                avg_speed_bytes_per_sec: computed.avg_speed_bytes_per_sec,
                speed_str: computed.speed_str,
                elapsed_seconds: Math.round((nowMs - startedAtMs) / 1000),
                active_connections: 1,
              });
            } else if (nowMs - lastOutputAtMs >= 12_000) {
              onProgress({
                status: 'downloading',
                current_phase: `Track ${i + 1}/${orderedTracks.length}: Waiting for spotDL response...`,
                elapsed_seconds: Math.round((nowMs - startedAtMs) / 1000),
              });
            }
          }, 400);
          pollTimer.unref?.();

          const finish = (outcome: { ok: boolean; err: string }) => {
            if (settled) return;
            settled = true;
            clearInterval(pollTimer);
            this.activeProcesses.delete(task.id);
            this.activeAbortHandlers.delete(task.id);
            resolve(outcome);
          };

          this.activeAbortHandlers.set(task.id, () => finish({ ok: false, err: 'cancelled' }));

          const processSpotLine = (line: string) => {
            lastOutputAtMs = Date.now();
            const stage = parseSpotdlProgressLine(line);
            if (stage) {
              currentPhase = `Track ${i + 1}/${orderedTracks.length}: ${stage.label}`;
              onProgress({
                status: stage.phase === 'processing' ? 'processing' : 'downloading',
                current_phase: currentPhase,
              });
            }
          };

          proc.stdout?.on('data', (d) => {
            tail = (tail + d.toString()).slice(-2000);
            for (const line of stdoutParser.push(d)) {
              processSpotLine(line);
            }
          });
          proc.stderr?.on('data', (d) => {
            tail = (tail + d.toString()).slice(-2000);
            for (const line of stderrParser.push(d)) {
              processSpotLine(line);
            }
          });
          proc.on('error', (err) => {
            finish({ ok: false, err: err.message });
          });
          proc.on('close', (code) => {
            for (const line of stdoutParser.flush()) processSpotLine(line);
            for (const line of stderrParser.flush()) processSpotLine(line);
            if (this.cancelledTasks.has(task.id) || code === null) {
              finish({ ok: false, err: 'cancelled' });
            } else if (code === 0) {
              finish({ ok: true, err: '' });
            } else {
              finish({ ok: false, err: sanitizeLog(tail || `Exited with code ${code}`) });
            }
          });
        });

        if (this.cancelledTasks.has(task.id)) return;
        if (res.ok) {
          const created = this.findRecentlyCreatedFile(targetDir, trackStartedAt, true, verifiedTrackFiles);
          if (created && fs.statSync(created).size > 0) {
            verifiedTrackFiles.add(created);
            completedCount += 1;
            totalCompletedBytes += fs.statSync(created).size;
            lastFile = created;
          } else {
            failedCount += 1;
            lastErr = `Track ${i + 1} completed without a non-empty audio file on disk.`;
          }
        } else {
          failedCount += 1;
          lastErr = res.err;
        }

        onProgress({
          tracks_requested: orderedTracks.length,
          tracks_completed: completedCount,
          tracks_failed: failedCount,
          downloaded_bytes: totalCompletedBytes,
          progress_percentage: Math.round((completedCount / orderedTracks.length) * 100),
          percentage_known: true,
        });
      }

      if (failedCount > 0 || completedCount < orderedTracks.length) {
        return onError(
          `${completedCount} of ${orderedTracks.length} tracks succeeded; ${failedCount} failed. ${lastErr}`.trim()
        );
      }

      const finalFile = lastFile || this.findRecentlyCreatedFile(targetDir, startedAtMs, true);
      if (!finalFile || !fs.existsSync(finalFile)) {
        return onError('spotDL playlist completed without verified audio files on disk.');
      }
      const stat = fs.statSync(finalFile);
      const totalPlaylistBytes = totalCompletedBytes > 0 ? totalCompletedBytes : stat.size;
      const mediaInfo = this.verifyMediaFile(finalFile);
      return onComplete(targetDir, {
        tracks_requested: orderedTracks.length,
        tracks_completed: completedCount,
        tracks_failed: 0,
        total_bytes: totalPlaylistBytes,
        downloaded_bytes: totalPlaylistBytes,
        remaining_bytes: 0,
        percentage_known: true,
        ext: format,
        verified_audio_info: mediaInfo?.audioSummary || undefined,
        audio_codec: mediaInfo?.audioCodec ?? null,
        ...buildIdleMetricsPatch({
          ...task,
          total_bytes: totalPlaylistBytes,
          downloaded_bytes: totalPlaylistBytes,
        }),
        current_phase: `Completed (${completedCount}/${orderedTracks.length} tracks)`,
        eta_str: 'Finished',
      });
    }

    const parsedSpotify = tryParseSpotifyInput(task.url);
    if (parsedSpotify && parsedSpotify.kind === 'invalid') {
      return onError(parsedSpotify.error);
    }

    const targetUrl =
      parsedSpotify && parsedSpotify.kind === 'resource' ? parsedSpotify.canonicalUrl : task.url;

    const customStem = task.custom_filename?.trim()
      ? sanitizeFilename(task.custom_filename.trim()).replace(/\.[^.]+$/, '')
      : '';
    const outputTemplate = customStem
      ? path.join(outDir, `${customStem}.{output-ext}`)
      : task.content_type === 'playlist' || task.content_type === 'album'
      ? path.join(outDir, '{list-name}', '{artists} - {title}.{output-ext}')
      : path.join(outDir, '{artists} - {title}.{output-ext}');

    const args = [
      ...invocation.leadingArgs,
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
    if (ffmpegPath) {
      args.push('--ffmpeg', ffmpegPath);
    }

    const startedAtMs = Date.now();
    const baseline = this.snapshotDirFiles(outDir);
    const tracker = new ProgressTracker({ alpha: 0.3, startedAtMs });
    const stdoutParser = new StreamingLineParser();
    const stderrParser = new StreamingLineParser();

    let settled = false;
    let lastOutputAtMs = startedAtMs;
    let lastByteAdvanceAtMs = startedAtMs;
    let lastObservedBytes = 0;
    let currentPhase = 'Matching audio source via spotDL...';
    let currentStatus: DownloadTask['status'] = 'connecting';
    let pollTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      this.activeProcesses.delete(task.id);
      this.activeAbortHandlers.delete(task.id);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    onProgress({
      status: 'connecting',
      current_phase: currentPhase,
      started_at: task.started_at || new Date(startedAtMs).toISOString(),
      percentage_known: false,
      progress_percentage: 0,
      eta_str: '--',
    });

    try {
      const proc = spawn(invocation.program, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.activeProcesses.set(task.id, proc);
      this.activeAbortHandlers.set(task.id, () => {
        if (!settled) {
          settled = true;
          cleanup();
        }
      });

      let lastOutput = '';

      pollTimer = setInterval(() => {
        if (settled || this.cancelledTasks.has(task.id)) return;
        const nowMs = Date.now();
        const measured = this.measureSpotdlActiveBytes(outDir, baseline, startedAtMs);
        if (measured.totalBytes > 0) {
          if (measured.totalBytes > lastObservedBytes) {
            lastObservedBytes = measured.totalBytes;
            lastByteAdvanceAtMs = nowMs;
          }
          currentStatus = 'downloading';
          const computed = tracker.update({
            downloadedBytes: measured.totalBytes,
            totalBytes: 0,
            activeConnections: 1,
            nowMs,
          });
          onProgress({
            status: 'downloading',
            current_phase:
              nowMs - lastByteAdvanceAtMs >= 15_000
                ? 'Transfer stalled — waiting for incoming data...'
                : currentPhase === 'Matching audio source via spotDL...'
                ? 'Downloading audio stream...'
                : currentPhase,
            ...computed,
            percentage_known: false,
            progress_percentage: 0,
          });
        } else if (nowMs - lastOutputAtMs >= 12_000) {
          onProgress({
            status: currentStatus,
            current_phase: 'Waiting for source response...',
            elapsed_seconds: Math.round((nowMs - startedAtMs) / 1000),
            percentage_known: false,
          });
        }
      }, 400);
      pollTimer.unref?.();

      const processSpotLine = (line: string) => {
        if (settled || this.cancelledTasks.has(task.id)) return;
        lastOutputAtMs = Date.now();

        const ytdlpParsed = parseYtdlpProgress(line);
        if (ytdlpParsed && ytdlpParsed.phase === 'downloading' && (ytdlpParsed.downloadedBytes ?? 0) > 0) {
          const nowMs = Date.now();
          if ((ytdlpParsed.downloadedBytes ?? 0) > lastObservedBytes) {
            lastObservedBytes = ytdlpParsed.downloadedBytes ?? 0;
            lastByteAdvanceAtMs = nowMs;
          }
          currentStatus = 'downloading';
          const computed = tracker.update({
            downloadedBytes: ytdlpParsed.downloadedBytes ?? 0,
            totalBytes: ytdlpParsed.totalBytes ?? 0,
            instantSpeedBytesPerSec: ytdlpParsed.speedBytesPerSec,
            percentageHint: ytdlpParsed.percentageKnown ? ytdlpParsed.percentage : undefined,
            activeConnections: 1,
            nowMs,
          });
          onProgress({
            status: 'downloading',
            current_phase: ytdlpParsed.phaseLabel || 'Downloading audio stream...',
            ...computed,
          });
          return;
        }

        const stage = parseSpotdlProgressLine(line);
        if (stage) {
          currentPhase = stage.label;
          currentStatus = stage.phase;
          onProgress({
            status: stage.phase,
            current_phase: stage.label,
            percentage_known: false,
          });
        }
      };

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        for (const line of stdoutParser.push(d)) {
          processSpotLine(line);
        }
      });

      proc.stderr.on('data', (d) => {
        const text = d.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        for (const line of stderrParser.push(d)) {
          processSpotLine(line);
        }
      });

      proc.on('close', (code) => {
        if (settled) return;
        for (const line of stdoutParser.flush()) processSpotLine(line);
        for (const line of stderrParser.flush()) processSpotLine(line);
        settled = true;
        cleanup();

        if (this.cancelledTasks.has(task.id) || code === null) return;
        if (code === 0) {
          const finalFile = this.findRecentlyCreatedFile(outDir, startedAtMs, true);
          if (!finalFile || !fs.existsSync(finalFile)) {
            return onError('spotDL completed without creating an output audio file on disk.');
          }
          const stat = fs.statSync(finalFile);
          if (!stat.isFile() || stat.size <= 0) {
            return onError('spotDL produced an empty file (0 bytes).');
          }

          onProgress({
            status: 'verifying',
            current_phase: 'Verifying audio stream via FFprobe...',
            progress_percentage: 100,
            percentage_known: true,
            downloaded_bytes: stat.size,
            total_bytes: stat.size,
            remaining_bytes: 0,
          });

          const mediaInfo = this.verifyMediaFile(finalFile);
          onComplete(finalFile, {
            total_bytes: stat.size,
            downloaded_bytes: stat.size,
            remaining_bytes: 0,
            percentage_known: true,
            ext: path.extname(finalFile).replace(/^\./, '').toLowerCase() || format,
            verified_audio_info: mediaInfo?.audioSummary || undefined,
            audio_codec: mediaInfo?.audioCodec ?? null,
            ...buildIdleMetricsPatch({
              ...task,
              total_bytes: stat.size,
              downloaded_bytes: stat.size,
            }),
            eta_str: 'Finished',
          });
        } else {
          onError(`spotDL failed (code ${code}): ${sanitizeLog(lastOutput || 'Unknown error')}`);
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        onError(`Execution error: ${sanitizeLog(err.message)}`);
      });
    } catch (err: any) {
      if (!settled) {
        settled = true;
        cleanup();
        onError(err.message || 'Failed to start spotDL download');
      }
    }
  }

  public cancelOrPauseProcess(taskId: string, _reason: 'paused' | 'cancelled' = 'cancelled'): boolean {
    this.cancelledTasks.add(taskId);
    const abort = this.activeAbortHandlers.get(taskId);
    if (abort) {
      this.activeAbortHandlers.delete(taskId);
      abort();
    }
    const proc = this.activeProcesses.get(taskId);
    if (proc) {
      killChildProcessTree(proc);
      this.activeProcesses.delete(taskId);
      return true;
    }
    return false;
  }

  public verifyAudioFile(filePath: string): string | null {
    return this.verifyMediaFile(filePath)?.audioSummary || null;
  }

  public verifyMediaFile(filePath: string): {
    audioSummary: string | null;
    audioCodec: string | null;
    videoCodec: string | null;
    resolutionLabel: string | null;
  } | null {
    const ffprobePath = this.findExecutable('ffprobe');
    if (!ffprobePath) return null;
    if (!fs.existsSync(filePath)) return null;

    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.size <= 0) return null;

      const jsonStr = execFileSync(
        ffprobePath,
        ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
        {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
        }
      );
      const data = JSON.parse(jsonStr);
      const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
      const audioStream = streams.find((s) => s.codec_type === 'audio');
      const videoStream = streams.find(
        (s) => s.codec_type === 'video' && (!s.disposition || !s.disposition.attached_pic)
      );

      let audioSummary: string | null = null;
      let audioCodec: string | null = null;
      if (audioStream) {
        audioCodec = String(audioStream.codec_name || 'unknown').toUpperCase();
        const sampleRate = parseInt(audioStream.sample_rate || '44100', 10);
        const channels = parseInt(audioStream.channels || '2', 10);
        let bitDepth = parseInt(
          audioStream.bits_per_sample || audioStream.bits_per_raw_sample || '0',
          10
        );
        if (!bitDepth || bitDepth === 0) {
          const fmt = (audioStream.sample_fmt || '').toLowerCase();
          if (fmt.includes('s32') || fmt.includes('flt') || fmt.includes('s24')) bitDepth = 24;
          else bitDepth = 16;
        }
        const channelLabel = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels}ch`;
        audioSummary = `${audioCodec} · ${bitDepth}-bit · ${sampleRate} Hz · ${channelLabel}`;
      }

      const videoCodec = videoStream ? String(videoStream.codec_name || 'unknown').toUpperCase() : null;
      const resolutionLabel =
        videoStream && videoStream.height
          ? `${videoStream.width || ''}x${videoStream.height} (${videoStream.height}p)`.replace(/^x/, '')
          : null;

      return { audioSummary, audioCodec, videoCodec, resolutionLabel };
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
    return this.installEngine(engineName, true);
  }

  public async getManagedEngineInfo(): Promise<ManagedEngineInfo> {
    const engines = await this.getEngineStatus();
    const missingRequired: string[] = [];
    if (!engines.ytdlp.available) missingRequired.push('yt-dlp');
    if (!engines.ffmpeg.available) missingRequired.push('ffmpeg');
    if (!engines.ffprobe.available) missingRequired.push('ffprobe');

    const writable = this.isDirWritable(this.getManagedRootDir());

    return {
      installRoot: this.getInstallRootDir(),
      installDir: this.getManagedRootDir(),
      ytdlpDir: this.getYtdlpDir(),
      spotdlDir: this.getSpotdlDir(),
      ffmpegDir: this.getFfmpegDir(),
      manifestPath: this.getManifestPath(),
      settingsFilePath: getSettingsFilePath(getAppDataDir()),
      isWritable: writable,
      requiresElevation: !writable && process.platform === 'win32',
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
      const ytdlpDir = this.getYtdlpDir();
      fs.mkdirSync(ytdlpDir, { recursive: true });
      const prevVersion = status.ytdlp.version;
      const assetName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const targetBin = path.join(ytdlpDir, assetName);
      const tempBin = path.join(ytdlpDir, `${assetName}.part`);
      const backupBin = path.join(ytdlpDir, `${assetName}.bak`);

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
        const verOutput = execFileSync(tempBin, ['--version'], {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
        }).trim();
        if (!verOutput) throw new Error('Downloaded binary failed --version check');

        if (fs.existsSync(targetBin)) fs.copyFileSync(targetBin, backupBin);
        fs.renameSync(tempBin, targetBin);
        if (fs.existsSync(backupBin)) fs.unlinkSync(backupBin);
        this.cachedEngineStatus = null;

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

    if (normalized === 'spotdl') {
      const prevVersion = status.spotdl.version;
      try {
        const pythonExe = await this.resolvePythonForSpotdl();
        const spotdlDir = this.getSpotdlDir();
        const venvDir = this.getSpotdlVenvDir();
        fs.mkdirSync(spotdlDir, { recursive: true });

        onProgress?.({
          engine: 'spotdl',
          status: 'installing',
          phase: 'Creating isolated Engine/spotdl venv...',
          progressPercentage: 20,
          downloadedBytes: 0,
          totalBytes: 0,
          message: 'Provisioning isolated Python environment under Engine/spotdl/venv...',
        });

        if (!fs.existsSync(this.getSpotdlVenvPython())) {
          const venvArgs = process.platform === 'win32'
            ? ['-m', 'venv', venvDir]
            : ['-m', 'venv', '--copies', venvDir];
          const mkVenv = await runProcessAsync(pythonExe, venvArgs, 60_000);
          if (mkVenv.code !== 0) {
            throw new Error(mkVenv.stderr || mkVenv.stdout || 'Failed creating isolated venv');
          }
        }

        const venvPy = this.getSpotdlVenvPython();
        onProgress?.({
          engine: 'spotdl',
          status: 'installing',
          phase: 'Installing spotDL in isolated venv...',
          progressPercentage: 60,
          downloadedBytes: 0,
          totalBytes: 0,
          message: 'Installing spotDL without modifying global Python packages...',
        });

        const pipRes = await runProcessAsync(
          venvPy,
          [
            '-m', 'pip', '--isolated', 'install', '--upgrade',
            '--index-url', 'https://pypi.org/simple',
            '--retries', '5',
            '--timeout', '90',
            '--no-cache-dir',
            '--disable-pip-version-check',
            'spotdl',
          ],
          600_000
        );
        if (pipRes.code !== 0) {
          throw new Error(pipRes.stderr || pipRes.stdout || 'pip install spotdl failed');
        }

        const verRes = await runProcessAsync(venvPy, ['-m', 'spotdl', '--version'], 8_000);
        const verOutput = (verRes.stdout || verRes.stderr || '').trim().split(/\r?\n/)[0] || 'installed';
        this.cachedEngineStatus = null;

        onProgress?.({
          engine: 'spotdl',
          status: 'ready',
          phase: 'Installed & Verified',
          progressPercentage: 100,
          downloadedBytes: 0,
          totalBytes: 0,
          message: `spotDL ${verOutput} installed in Engine/spotdl/venv`,
        });

        return {
          engine: 'spotdl',
          success: true,
          previousVersion: prevVersion,
          currentVersion: verOutput,
          message: `Successfully installed isolated spotDL (${verOutput})`,
        };
      } catch (err: any) {
        onProgress?.({
          engine: 'spotdl',
          status: 'error',
          phase: 'Installation failed',
          progressPercentage: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          message: err.message,
          error: err.message,
        });
        return {
          engine: 'spotdl',
          success: false,
          previousVersion: prevVersion,
          currentVersion: prevVersion,
          message: `Failed to install spotDL: ${err.message}`,
          rolledBack: false,
        };
      }
    }

    return {
      engine: normalized,
      success: false,
      previousVersion: '',
      currentVersion: '',
      message: `Engine ${normalized} must be installed via Desktop runtime or bundled packages.`,
    };
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

  public removeManagedEngine(engineName: string): {
    engine: string;
    removed: boolean;
    message: string;
  } {
    const normalized = engineName.toLowerCase() === 'ytdlp' ? 'yt-dlp' : engineName.toLowerCase();
    const exeName = process.platform === 'win32' && !normalized.endsWith('.exe') ? `${normalized}.exe` : normalized;
    const candidates =
      normalized === 'yt-dlp'
        ? [path.join(this.getYtdlpDir(), exeName)]
        : normalized === 'ffmpeg' || normalized === 'ffprobe'
        ? [path.join(this.getFfmpegDir(), exeName)]
        : [path.join(this.getManagedRootDir(), exeName)];

    let removed = false;
    if (normalized === 'spotdl' && fs.existsSync(this.getSpotdlVenvDir())) {
      fs.rmSync(this.getSpotdlVenvDir(), { recursive: true, force: true });
      removed = true;
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        fs.unlinkSync(candidate);
        removed = true;
      }
    }
    this.cachedEngineStatus = null;
    return {
      engine: normalized,
      removed,
      message: removed
        ? `Removed managed ${normalized} from Engine directory.`
        : `No managed ${normalized} found in Engine directory.`,
    };
  }
}

export const engineManager = new EngineManager();
