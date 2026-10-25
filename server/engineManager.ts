import { spawn, execSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EngineInfo,
  EngineStatusMap,
  EngineUpdateResult,
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

export class EngineManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();

  public findExecutable(name: string): string | null {
    const candidates = [
      path.resolve(process.cwd(), 'bin', name),
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
          timeout: 4000,
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

  public async inspectUrl(url: string, proxy?: string): Promise<MediaMetadata> {
    const engine = determineEngineForUrl(url);

    if (engine === 'spotdl') {
      return this.inspectSpotdlUrl(url);
    }

    const ytdlpPath = this.findExecutable('yt-dlp');
    if (!ytdlpPath) {
      throw new Error('yt-dlp engine is not installed or not available.');
    }

    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-check-certificates',
      '--flat-playlist',
      '--skip-download',
    ];

    if (proxy) {
      args.push('--proxy', proxy);
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
          return reject(
            new Error(
              `Extraction failed (exit code ${code}): ${stderr || stdout || 'Unknown error'}`
            )
          );
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

  public async updateAllEngines(): Promise<EngineUpdateResult[]> {
    const results: EngineUpdateResult[] = [];
    results.push(await this.updateEngine('ytdlp'));
    results.push(await this.updateEngine('spotdl'));
    return results;
  }
}

export const engineManager = new EngineManager();
