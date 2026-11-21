import express, { Request, Response } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import {
  getAllTasks,
  getTaskById,
  upsertTask,
  deleteTask,
  clearCompletedTasks,
  clearFailedTasks,
  clearAllTasks,
  deleteDownloadedFile,
  moveTaskOrderInDb,
  renameTaskFileInDb,
  getSettings,
  saveSettings,
  resetSettings,
  getNotifications,
  clearNotifications,
} from './server/db';
import {
  getCookieStatus,
  saveCookiesFile,
  removeCookiesFile,
  detectInstalledBrowsers,
  getDiagnosticLogInfo,
} from './server/cookies';
import { validateNetscapeCookies } from './src/utils/cookie-validator';
import { engineManager, validatePythonExecutable } from './server/engineManager';
import { spotifyMetadataService } from './server/spotify';
import { queueController } from './server/queueController';
import { DownloadTask } from './src/types';
import { determineEngineForUrl, validateMediaUrl } from './src/utils/engine-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function openPathWithOs(targetPath: string, revealParent = false): void {
  const resolved = revealParent
    ? fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
      ? targetPath
      : path.dirname(targetPath)
    : targetPath;

  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error('Target path does not exist on disk.');
  }

  if (process.platform === 'win32') {
    if (revealParent && fs.statSync(targetPath).isFile()) {
      execFile('explorer.exe', ['/select,', targetPath], { windowsHide: true });
    } else {
      execFile('cmd.exe', ['/c', 'start', '', resolved], { windowsHide: true });
    }
  } else if (process.platform === 'darwin') {
    execFile('open', revealParent && fs.statSync(targetPath).isFile() ? ['-R', targetPath] : [resolved]);
  } else {
    execFile('xdg-open', [resolved], (err) => {
      if (err) {
        console.info('xdg-open unavailable in headless container:', err.message);
      }
    });
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // SSE Stream
  app.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    queueController.registerClient(res);
  });

  // Engines status
  app.get('/api/engines/status', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      const status = await engineManager.getEngineStatus(force);
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to scan engines' });
    }
  });

  app.get('/api/engines/managed', async (_req: Request, res: Response) => {
    try {
      res.json(await engineManager.getManagedEngineInfo());
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to read managed engine info' });
    }
  });

  app.post('/api/engines/install/:name', async (req: Request, res: Response) => {
    try {
      const result = await engineManager.installEngine(
        req.params.name,
        Boolean(req.body?.force),
        (progress) => queueController.broadcast('engine_install_progress', progress)
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to install engine' });
    }
  });

  app.post('/api/engines/install', async (req: Request, res: Response) => {
    try {
      const results = await engineManager.installAllEngines(
        req.body?.includeSpotdl !== false,
        Boolean(req.body?.force),
        (progress) => queueController.broadcast('engine_install_progress', progress)
      );
      res.json({ success: results.every((r) => r.success), results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to install managed engines' });
    }
  });

  app.post('/api/engines/remove/:name', async (req: Request, res: Response) => {
    try {
      const result = engineManager.removeManagedEngine(req.params.name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to remove engine' });
    }
  });

  app.post('/api/engines/diagnostics', async (_req: Request, res: Response) => {
    try {
      const results = await engineManager.runDiagnostics();
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/engines/updates', async (_req: Request, res: Response) => {
    try {
      const updates = await engineManager.checkEngineUpdates();
      res.json(updates);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to check engine updates' });
    }
  });

  app.post('/api/engines/update/:name', async (req: Request, res: Response) => {
    try {
      const result = await engineManager.updateEngine(req.params.name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update engine' });
    }
  });

  app.post('/api/engines/update-all', async (_req: Request, res: Response) => {
    try {
      const results = await engineManager.updateAllEngines();
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update engines' });
    }
  });

  // Inspect URL
  app.post('/api/inspect', async (req: Request, res: Response) => {
    const { url, requestId, includePlaylist } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const reqIdStr = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined;
    const onAbort = () => {
      if (reqIdStr) {
        engineManager.cancelInspection(reqIdStr);
      }
    };
    req.on('aborted', onAbort);

    try {
      const settings = getSettings();
      const metadata = await engineManager.inspectUrl(url.trim(), settings.proxy_url, reqIdStr, {
        includePlaylist: typeof includePlaylist === 'boolean' ? includePlaylist : undefined,
      });
      res.json(metadata);
    } catch (err: any) {
      const msg = err.message || 'Inspection failed';
      const lower = msg.toLowerCase();
      const statusCode =
        lower.includes('url cannot be empty') ||
        lower.includes('invalid url') ||
        lower.includes('unsupported url scheme') ||
        lower.includes('unsupported file') ||
        lower.includes('only supports video and music') ||
        lower.includes('downloads music and video only') ||
        lower.includes('files are not supported') ||
        lower.includes('malformed url') ||
        lower.includes('malformed spotify') ||
        lower.includes('unsupported spotify') ||
        lower.includes('incomplete spotify')
          ? 400
          : lower.includes('http 404') || lower.includes('not found, private')
          ? 404
          : lower.includes('429') || lower.includes('rate-limited') || lower.includes('rate limit')
          ? 429
          : lower.includes('timed out')
          ? 504
          : 500;
      res.status(statusCode).json({ error: msg });
    } finally {
      req.off('aborted', onAbort);
    }
  });

  app.post('/api/inspect/cancel', (req: Request, res: Response) => {
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }
    const cancelled = engineManager.cancelInspection(requestId);
    res.json({ cancelled });
  });

  // Tasks API
  app.get('/api/tasks', (_req: Request, res: Response) => {
    res.json(getAllTasks());
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    const {
      url,
      title,
      uploader,
      duration,
      duration_string,
      thumbnail,
      album,
      content_type,
      format_id,
      format_note,
      ext,
      is_audio_only,
      audio_format,
      audio_bitrate,
      priority,
      output_path,
      audio_sample_rate,
      audio_bit_depth,
      audio_channels,
      is_lossy_source,
      custom_filename,
      playlist_mode,
      selected_items,
      total_bytes,
    } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const urlCheck = validateMediaUrl(url.trim());
    if (!urlCheck.valid) {
      return res.status(400).json({ error: urlCheck.error });
    }
    const trimmedUrl = urlCheck.normalized;

    const settings = getSettings();
    const engine = determineEngineForUrl(trimmedUrl);

    let resolvedUrl = trimmedUrl;
    let resolvedTitle = typeof title === 'string' ? title.trim() : '';
    let resolvedUploader = typeof uploader === 'string' ? uploader.trim() || undefined : undefined;
    let resolvedDuration = duration || undefined;
    let resolvedDurationStr = duration_string || undefined;
    let resolvedThumbnail = typeof thumbnail === 'string' ? thumbnail.trim() || undefined : undefined;
    let resolvedAlbum = typeof album === 'string' ? album.trim() || undefined : undefined;
    let resolvedContentType = typeof content_type === 'string' ? content_type.trim() || undefined : undefined;

    const isPlaceholderTitle =
      !resolvedTitle ||
      resolvedTitle === 'Download Task' ||
      resolvedTitle === 'Queued Item' ||
      resolvedTitle === 'Spotify Track / Album' ||
      resolvedTitle === 'Spotify Music Track' ||
      resolvedTitle === 'Spotify Album / Playlist' ||
      resolvedTitle.startsWith('Batch Item:');

    if (engine === 'spotdl' && (isPlaceholderTitle || !resolvedThumbnail)) {
      try {
        const meta = await spotifyMetadataService.resolveSpotifyUrl(trimmedUrl);
        resolvedUrl = meta.url || resolvedUrl;
        resolvedTitle = meta.title;
        resolvedUploader = meta.artists?.join(', ') || meta.owner || meta.uploader || resolvedUploader;
        resolvedDuration = meta.duration ?? resolvedDuration;
        resolvedDurationStr = meta.duration_string ?? resolvedDurationStr;
        resolvedThumbnail = meta.album_artwork || meta.thumbnail || resolvedThumbnail;
        resolvedAlbum = meta.album ?? resolvedAlbum;
        resolvedContentType = meta.content_type ?? resolvedContentType;
      } catch (err: any) {
        const msg = err?.message || 'Failed to resolve Spotify metadata.';
        const lower = msg.toLowerCase();
        const code =
          lower.includes('malformed') || lower.includes('unsupported') || lower.includes('incomplete')
            ? 400
            : lower.includes('404') || lower.includes('not found')
            ? 404
            : lower.includes('429')
            ? 429
            : 502;
        return res.status(code).json({ error: msg });
      }
    }

    const resolvedIsAudio = Boolean(is_audio_only || engine === 'spotdl');
    const resolvedExt = ext || (resolvedIsAudio ? settings.default_audio_format || 'mp3' : 'mp4');

    const normalizedSelectedItems = Array.isArray(selected_items)
      ? selected_items.map((item: any) => String(item).trim()).filter(Boolean)
      : [];
    const tracksRequested =
      normalizedSelectedItems.length > 0 ? normalizedSelectedItems.length : undefined;

    const existingTasks = getAllTasks();
    const maxOrder = existingTasks.reduce((max, t) => Math.max(max, t.queue_order || 0), 0);
    const knownTotal = Number(total_bytes || 0);

    const task: DownloadTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      url: resolvedUrl,
      title: resolvedTitle || 'Queued Item',
      uploader: resolvedUploader,
      duration: resolvedDuration,
      duration_string: resolvedDurationStr,
      thumbnail: resolvedThumbnail,
      album: resolvedAlbum,
      content_type: resolvedContentType as any,
      engine,
      status: 'queued',
      progress_percentage: 0,
      percentage_known: knownTotal > 0 || engine !== 'spotdl',
      speed_str: '0 B/s',
      speed_bytes_per_sec: 0,
      avg_speed_bytes_per_sec: 0,
      downloaded_bytes: 0,
      total_bytes: knownTotal,
      remaining_bytes: knownTotal,
      eta_str: '--',
      eta_seconds: null,
      elapsed_seconds: 0,
      active_connections: 0,
      current_phase: 'Queued',
      format_id: format_id || 'best',
      format_note: format_note || undefined,
      ext: resolvedExt,
      is_audio_only: resolvedIsAudio,
      audio_format: audio_format || settings.default_audio_format,
      audio_bitrate: audio_bitrate || settings.default_audio_bitrate,
      audio_sample_rate: audio_sample_rate ? parseInt(audio_sample_rate, 10) : settings.default_audio_sample_rate,
      audio_bit_depth: audio_bit_depth ? parseInt(audio_bit_depth, 10) : settings.default_audio_bit_depth,
      audio_channels: audio_channels ? parseInt(audio_channels, 10) : undefined,
      is_lossy_source: is_lossy_source !== undefined ? Boolean(is_lossy_source) : engine === 'spotdl',
      output_path: (typeof output_path === 'string' && output_path.trim()) || settings.download_dir,
      custom_filename: typeof custom_filename === 'string' && custom_filename.trim() ? custom_filename.trim() : null,
      playlist_mode: playlist_mode === 'playlist' ? 'playlist' : 'single',
      selected_items: normalizedSelectedItems.length > 0 ? normalizedSelectedItems : undefined,
      tracks_requested: tracksRequested ?? undefined,
      tracks_completed: tracksRequested ? 0 : undefined,
      tracks_failed: tracksRequested ? 0 : undefined,
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Task queued via ${engine}`,
        },
      ],
      priority: priority || 'normal',
      queue_order: maxOrder + 1,
      created_at: new Date().toISOString(),
      retries: 0,
      max_retries: settings.max_retries,
    };

    upsertTask(task);
    queueController.broadcast('task_added', task);
    queueController.scheduleNext();

    res.status(201).json(task);
  });

  app.patch('/api/tasks/:id', (req: Request, res: Response) => {
    const task = getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { priority, custom_filename } = req.body || {};
    if (priority) task.priority = priority;
    if (custom_filename !== undefined) task.custom_filename = custom_filename || null;

    upsertTask(task);
    queueController.broadcast('task_updated', task);
    res.json(task);
  });

  app.post('/api/tasks/:id/move', (req: Request, res: Response) => {
    const direction = req.body?.direction === 'down' ? 'down' : 'up';
    const updated = moveTaskOrderInDb(req.params.id, direction);
    queueController.broadcast('tasks_cleared', updated);
    res.json(updated);
  });

  app.post('/api/tasks/:id/rename', (req: Request, res: Response) => {
    try {
      const newFilename = typeof req.body?.filename === 'string' ? req.body.filename : '';
      const updated = renameTaskFileInDb(req.params.id, newFilename);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      queueController.broadcast('task_updated', updated);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Rename failed' });
    }
  });

  app.post('/api/tasks/:id/open-file', (req: Request, res: Response) => {
    const task = getTaskById(req.params.id);
    if (!task || !task.output_path) {
      return res.status(404).json({ error: 'Task file not found' });
    }
    try {
      openPathWithOs(task.output_path, false);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/open-folder', (req: Request, res: Response) => {
    const task = getTaskById(req.params.id);
    if (!task || !task.output_path) {
      return res.status(404).json({ error: 'Task folder not found' });
    }
    try {
      openPathWithOs(task.output_path, true);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/tasks/bulk', (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const action: string = String(req.body?.action || '');
    const deleteFiles = Boolean(req.body?.deleteFiles);

    for (const id of ids) {
      if (action === 'pause') queueController.pauseTask(id);
      else if (action === 'resume') queueController.resumeTask(id);
      else if (action === 'retry') queueController.retryTask(id);
      else if (action === 'cancel') queueController.cancelTask(id);
      else if (action === 'delete') {
        queueController.cancelTask(id);
        deleteTask(id, deleteFiles);
        queueController.broadcast('task_deleted', { id });
      }
    }

    res.json({ success: true, count: ids.length });
  });

  // Task actions
  app.post('/api/tasks/:id/pause', (req: Request, res: Response) => {
    const ok = queueController.pauseTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found or cannot pause' });
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/resume', (req: Request, res: Response) => {
    const ok = queueController.resumeTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found or cannot resume' });
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/cancel', (req: Request, res: Response) => {
    const ok = queueController.cancelTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/retry', (req: Request, res: Response) => {
    const ok = queueController.retryTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  });

  app.delete('/api/tasks/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const deleteFile = req.query.deleteFile === 'true' || req.body?.deleteFile === true;
    queueController.cancelTask(id);
    deleteTask(id, deleteFile);
    queueController.broadcast('task_deleted', { id });
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/delete-file', (req: Request, res: Response) => {
    const id = req.params.id;
    const removed = deleteDownloadedFile(id);
    const updated = getTaskById(id);
    if (updated) {
      queueController.broadcast('task_updated', updated);
    }
    res.json({ success: true, removed });
  });

  app.post('/api/tasks/pause-all', (_req: Request, res: Response) => {
    queueController.pauseAll();
    res.json({ success: true });
  });

  app.post('/api/tasks/resume-all', (_req: Request, res: Response) => {
    queueController.resumeAll();
    res.json({ success: true });
  });

  app.post('/api/tasks/clear-completed', (req: Request, res: Response) => {
    const deleteFiles = req.query.deleteFiles === 'true' || req.body?.deleteFiles === true;
    clearCompletedTasks(deleteFiles);
    const updated = getAllTasks();
    queueController.broadcast('tasks_cleared', updated);
    res.json({ success: true });
  });

  app.post('/api/tasks/clear-failed', (_req: Request, res: Response) => {
    clearFailedTasks();
    const updated = getAllTasks();
    queueController.broadcast('tasks_cleared', updated);
    res.json({ success: true });
  });

  app.post('/api/tasks/clear-all', (req: Request, res: Response) => {
    const deleteFiles = req.query.deleteFiles === 'true' || req.body?.deleteFiles === true;
    clearAllTasks(deleteFiles);
    const updated = getAllTasks();
    queueController.broadcast('tasks_cleared', updated);
    res.json({ success: true });
  });

  // Cookies Management
  app.get('/api/cookies/status', (_req: Request, res: Response) => {
    res.json(getCookieStatus(getSettings()));
  });

  app.get('/api/cookies/browsers', (_req: Request, res: Response) => {
    res.json(detectInstalledBrowsers());
  });

  app.post('/api/cookies/validate', (req: Request, res: Response) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.json(validateNetscapeCookies(content));
  });

  app.post('/api/cookies/test', async (req: Request, res: Response) => {
    const { browser, profile, testUrl } = req.body || {};
    try {
      const result = await engineManager.testCookieExtraction(browser, profile, testUrl);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        stage: 'auth_failed',
        message: err.message || 'Cookie extraction failed',
      });
    }
  });

  app.post('/api/cookies/save', (req: Request, res: Response) => {
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Cookie content is required' });
    }
    try {
      const status = saveCookiesFile(content);
      queueController.broadcast('settings_updated', getSettings());
      res.json(status);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Invalid Netscape cookies format' });
    }
  });

  app.delete('/api/cookies', (_req: Request, res: Response) => {
    try {
      const status = removeCookiesFile();
      queueController.broadcast('settings_updated', getSettings());
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed removing cookie file' });
    }
  });

  app.get('/api/diagnostics/logs', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.maxLines || '100'), 10) || 100;
    res.json(getDiagnosticLogInfo(limit));
  });

  // Settings & Python Validation
  app.get('/api/settings', (_req: Request, res: Response) => {
    try {
      res.json(getSettings());
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed reading settings' });
    }
  });

  app.put('/api/settings', (req: Request, res: Response) => {
    try {
      const updated = saveSettings(req.body || {});
      queueController.broadcast('settings_updated', updated);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed saving settings' });
    }
  });

  app.post('/api/settings/reset', (_req: Request, res: Response) => {
    try {
      const reset = resetSettings();
      queueController.broadcast('settings_updated', reset);
      res.json(reset);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed resetting settings' });
    }
  });

  app.post('/api/python/validate', async (req: Request, res: Response) => {
    try {
      const pythonPath = typeof req.body?.pythonPath === 'string' ? req.body.pythonPath : '';
      const result = await validatePythonExecutable(pythonPath);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        valid: false,
        executablePath: req.body?.pythonPath || '',
        error: err.message || 'Python validation failed',
      });
    }
  });

  // Notifications
  app.get('/api/notifications', (_req: Request, res: Response) => {
    res.json(getNotifications());
  });

  app.delete('/api/notifications', (_req: Request, res: Response) => {
    clearNotifications();
    res.json({ success: true });
  });

  // Mount Vite middlewares in development
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VANTA Download Manager server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
