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
import { getSettings } from './db';

export class EngineManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();

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
      const out = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      // not in PATH
    }

    return null;
  }

  public getEngineStatus(): EngineStatusMap {
    const check = (name: string, verFlag = '--version'): EngineInfo => {
      const p = this.findExecutable(name);
      if (!p) {
        return {
          available: false,
          version: '',
          path: '',
          status: 'missing',
          lastChecked: new Date().toISOString(),
          error: `Executable ${name} not found in system paths.`,
        };
      }

      try {
        const out = execSync(`"${p}" ${verFlag} 2>&1`, {
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        const firstLine = out.split('\n')[0].replace(/^.*?version\s*/i, '').trim();
        return {
          available: true,
          version: firstLine,
          path: p,
          status: 'ready',
          lastChecked: new Date().toISOString(),
        };
      } catch (err: any) {
        return {
          available: false,
          version: '',
          path: p,
          status: 'error',
          lastChecked: new Date().toISOString(),
          error: err.message || 'Execution failed',
        };
      }
    };

    return {
      ytdlp: check('yt-dlp', '--version'),
      spotdl: check('spotdl', '--version'),
      ffmpeg: check('ffmpeg', '-version'),
      ffprobe: check('ffprobe', '-version'),
      python3: check('python3', '--version'),
    };
  }

  public async runDiagnostics(): Promise<DiagnosticResult[]> {
    const results: DiagnosticResult[] = [];
    const engines = [
      { name: 'yt-dlp', flag: '--version' },
      { name: 'spotdl', flag: '--version' },
      { name: 'ffmpeg', flag: '-version' },
      { name: 'ffprobe', flag: '-version' },
    ];

    for (const eng of engines) {
      const start = Date.now();
      const execPath = this.findExecutable(eng.name);
      if (!execPath) {
        results.push({
          engine: eng.name,
          passed: false,
          command: `${eng.name} ${eng.flag}`,
          output: `Executable not found in system or bin/ directory.`,
          duration_ms: Date.now() - start,
        });
        continue;
      }

      try {
        const out = execSync(`"${execPath}" ${eng.flag} 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
        results.push({
          engine: eng.name,
          passed: true,
          version: out.split('\n')[0],
          command: `"${execPath}" ${eng.flag}`,
          output: out.slice(0, 500),
          duration_ms: Date.now() - start,
        });
      } catch (err: any) {
        results.push({
          engine: eng.name,
          passed: false,
          command: `"${execPath}" ${eng.flag}`,
          output: err.stderr || err.stdout || err.message,
          duration_ms: Date.now() - start,
        });
      }
    }

    return results;
  }

  public getCookieAndAdultArgs(url: string, settings?: AppSettings, overrideBrowser?: string): string[] {
    const s = settings || getSettings();
    const args: string[] = [];

    // 1. Adult sites & geoblocking bypass
    if (s.enable_adult_sites !== false) {
      args.push('--age-limit', '99');
      args.push('--no-check-certificates');
    }

    if (s.bypass_age_gate !== false) {
      args.push('--geo-bypass');
    }

    // 2. Realistic User-Agent and Emulation Headers
    const ua =
      s.user_agent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    args.push('--user-agent', ua);
    args.push('--add-header', 'Accept-Language:en-US,en;q=0.9');
    args.push('--add-header', 'Sec-Fetch-Mode:navigate');

    // 3. Dynamic Referer
    try {
      const parsed = new URL(url);
      args.push('--referer', `${parsed.protocol}//${parsed.hostname}/`);
    } catch {
      // ignore
    }

    // 4. Cookies resolution
    // Check if user has pasted / configured custom cookies.txt
    const customCookieFile = s.cookies_file || path.resolve(process.cwd(), '.vanta_data', 'cookies.txt');
    if (customCookieFile && fs.existsSync(customCookieFile)) {
      try {
        const content = fs.readFileSync(customCookieFile, 'utf-8').trim();
        if (content.length > 0) {
          args.push('--cookies', customCookieFile);
          return args;
        }
      } catch {
        // fallback to browser
      }
    }

    // Automatic browser cookie extraction
    const browser = overrideBrowser || s.cookies_browser || 'auto';
    if (browser !== 'none') {
      const target = browser === 'auto' ? 'chrome' : browser;
      args.push('--cookies-from-browser', target);
    }

    return args;
  }

  public async testCookieExtraction(
    browser: string
  ): Promise<{ success: boolean; message: string; browser: string }> {
    const ytdlpPath = this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      return { success: false, message: 'yt-dlp executable not found', browser };
    }
    const targetBrowser = browser === 'auto' ? 'chrome' : browser;
    try {
      execSync(
        `"${ytdlpPath}" --cookies-from-browser ${targetBrowser} --dump-single-json --skip-download "https://www.google.com" 2>&1`,
        {
          encoding: 'utf-8',
          timeout: 10000,
        }
      );
      return {
        success: true,
        message: `Successfully connected to ${targetBrowser} cookies database.`,
        browser: targetBrowser,
      };
    } catch (err: any) {
      const errMsg = err.stderr || err.stdout || err.message || '';
      return {
        success: false,
        message: errMsg.includes('Could not find')
          ? `Could not find cookies database for ${targetBrowser}. Make sure ${targetBrowser} is installed or paste Netscape cookies directly.`
          : errMsg.slice(0, 300),
        browser: targetBrowser,
      };
    }
  }

  public async inspectUrl(url: string, proxy?: string): Promise<MediaMetadata> {
    const engine = determineEngineForUrl(url);

    if (engine === 'spotdl') {
      return this.inspectSpotdlUrl(url);
    }

    const ytdlpPath = this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      throw new Error('yt-dlp engine is not installed or not available.');
    }

    const settings = getSettings();
    const cookieAdultArgs = this.getCookieAndAdultArgs(url, settings);

    const runInspect = (extraArgs: string[]): Promise<MediaMetadata> => {
      const args = [
        '--dump-single-json',
        '--no-warnings',
        '--flat-playlist',
        '--skip-download',
        ...extraArgs,
      ];

      if (proxy || settings.proxy_url) {
        args.push('--proxy', proxy || settings.proxy_url);
      }

      args.push(url);

      return new Promise((resolve, reject) => {
        const proc = spawn(ytdlpPath, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => {
          stdout += d.toString();
        });

        proc.stderr.on('data', (d) => {
          stderr += d.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            const rawErr = stderr || stdout || 'Unknown error';
            return reject(new Error(rawErr));
          }

          try {
            const raw = JSON.parse(stdout);
            const isPlaylist = Boolean(raw._type === 'playlist' || Array.isArray(raw.entries));

            const parsedFormats: FormatOption[] = [];
            if (Array.isArray(raw.formats)) {
              for (const f of raw.formats) {
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
              description: raw.description ? raw.description.slice(0, 300) : undefined,
              formats: parsedFormats,
              is_playlist: isPlaylist,
              playlist_count: isPlaylist && raw.entries ? raw.entries.length : undefined,
              extractor: raw.extractor || 'generic',
            };

            resolve(metadata);
          } catch (err: any) {
            reject(new Error(`Failed to parse metadata JSON: ${err.message}`));
          }
        });
      });
    };

    try {
      // First attempt with full cookie and adult arguments
      return await runInspect(cookieAdultArgs);
    } catch (firstErr: any) {
      const msg = firstErr.message || '';

      // If failed specifically because browser cookie DB was locked or not found on this machine,
      // retry without --cookies-from-browser so open public media still works seamlessly
      if (
        msg.includes('Could not find') &&
        (msg.includes('cookie') || msg.includes('database'))
      ) {
        const withoutBrowserCookies = cookieAdultArgs.filter(
          (a, i, arr) => a !== '--cookies-from-browser' && arr[i - 1] !== '--cookies-from-browser'
        );
        try {
          return await runInspect(withoutBrowserCookies);
        } catch {
          // fall through to formatting friendly message below
        }
      }

      // Format helpful advice for bot-checks or age/login gates
      if (
        msg.includes('Sign in to confirm you') ||
        msg.includes('bot') ||
        msg.includes('HTTP Error 410') ||
        msg.includes('cookies for authentication')
      ) {
        throw new Error(
          `Authentication / Bot check required: ${sanitizeLog(
            msg
          )}\n\n💡 Tip: Go to Settings > Cookies to select your browser for automatic cookie extraction or paste Netscape cookies to authenticate downloads from this site.`
        );
      }

      throw new Error(`Extraction failed: ${sanitizeLog(msg)}`);
    }
  }

  private async inspectSpotdlUrl(url: string): Promise<MediaMetadata> {
    // For Spotify URLs, spotDL matches tracks against audio streaming sources
    // Generate clean metadata response
    const trackId = url.split('/').pop()?.split('?')[0] || 'track';
    const isPlaylist = url.includes('/playlist/') || url.includes('/album/');

    return {
      url,
      id: trackId,
      title: isPlaylist ? 'Spotify Album / Playlist' : 'Spotify Music Track',
      uploader: 'Spotify Artist',
      duration: 180,
      duration_string: '03:00',
      thumbnail: 'https://open.spotifycdn.com/cdn/images/favicon.0f31d2ea.ico',
      description: 'Music track processed via spotDL high-fidelity audio pipeline with embedded ID3 tags and cover artwork.',
      formats: [
        {
          format_id: 'spotdl-best',
          ext: 'mp3',
          resolution: '320kbps Audio',
          is_audio_only: true,
          is_video_only: false,
          format_note: 'High-Fidelity MP3 (320 kbps) with embedded cover artwork',
        },
        {
          format_id: 'spotdl-flac',
          ext: 'flac',
          resolution: 'Lossless Audio',
          is_audio_only: true,
          is_video_only: false,
          format_note: 'Lossless FLAC audio',
        },
        {
          format_id: 'spotdl-m4a',
          ext: 'm4a',
          resolution: 'AAC Audio',
          is_audio_only: true,
          is_video_only: false,
          format_note: 'AAC M4A audio',
        },
      ],
      is_playlist: isPlaylist,
      playlist_count: isPlaylist ? 10 : undefined,
      extractor: 'spotdl',
    };
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

    // Cookies, Adult Sites, & User-Agent emulation
    const cookieAdultArgs = this.getCookieAndAdultArgs(task.url, settings);
    args.push(...cookieAdultArgs);

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

    args.push(task.url);

    onProgress({
      status: 'extracting',
      current_phase: 'Initializing engine...',
      progress_percentage: 2,
    });

    try {
      const proc = spawn(ytdlpPath, args);
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

    const format = task.audio_format || settings.default_audio_format || 'mp3';
    const bitrate = task.audio_bitrate || settings.default_audio_bitrate || '320k';

    const args = [
      'download',
      task.url,
      '--output',
      outDir,
      '--format',
      format,
      '--bitrate',
      bitrate,
      '--log-level',
      'INFO',
    ];

    onProgress({
      status: 'extracting',
      current_phase: 'Resolving track metadata...',
      progress_percentage: 10,
    });

    try {
      const proc = spawn(spotdlPath, args);
      this.activeProcesses.set(task.id, proc);

      let lastOutput = '';

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        lastOutput = (lastOutput + text).slice(-4000);
        if (text.includes('Searching for')) {
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
        } else if (text.includes('Converting') || text.includes('Embedding')) {
          onProgress({
            status: 'processing',
            current_phase: 'Embedding metadata & artwork...',
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
          onError(`spotDL failed (code ${code}): ${lastOutput || 'Unknown error'}`);
        }
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(task.id);
        onError(`Execution error: ${err.message}`);
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
    const status = this.getEngineStatus();
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
    const status = this.getEngineStatus();
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
        });

        const verOutput = execSync(`"${tempBin}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
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
        });

        const spotdlBin = this.findExecutable('spotdl');
        const verOutput = spotdlBin
          ? execSync(`"${spotdlBin}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim()
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

  public getManagedEngineInfo(): ManagedEngineInfo {
    const engines = this.getEngineStatus();
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
    const status = this.getEngineStatus();
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
        const verOutput = execSync(`"${tempBin}" --version`, { encoding: 'utf-8', timeout: 8000 }).trim();
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
