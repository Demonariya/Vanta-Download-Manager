import express, { Request, Response } from 'express';
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
  getSettings,
  saveSettings,
  getNotifications,
  clearNotifications,
} from './server/db';
import {
  getCookieStatus,
  saveCookiesFile,
  removeCookiesFile,
  detectInstalledBrowsers,
  getDiagnosticLogInfo,
  appendAppLog,
} from './server/cookies';
import { validateNetscapeCookies } from './src/utils/cookie-validator';
import { engineManager } from './server/engineManager';
import { queueController } from './server/queueController';
import { DownloadTask } from './src/types';
import { determineEngineForUrl } from './src/utils/engine-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  app.get('/api/engines/status', (req: Request, res: Response) => {
    const status = engineManager.getEngineStatus();
    res.json(status);
  });

  // Managed engine summary
  app.get('/api/engines/managed', (req: Request, res: Response) => {
    res.json(engineManager.getManagedEngineInfo());
  });

  // Install single managed engine
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

  // Install all managed engines
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

  // Diagnostics test
  app.post('/api/engines/diagnostics', async (req: Request, res: Response) => {
    try {
      const results = await engineManager.runDiagnostics();
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Engine updates
  app.get('/api/engines/updates', async (req: Request, res: Response) => {
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

  app.post('/api/engines/update-all', async (req: Request, res: Response) => {
    try {
      const results = await engineManager.updateAllEngines();
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update engines' });
    }
  });

  // Inspect URL
  app.post('/api/inspect', async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    try {
      const settings = getSettings();
      const metadata = await engineManager.inspectUrl(url.trim(), settings.proxy_url);
      res.json(metadata);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Inspection failed' });
    }
  });

  // Tasks API
  app.get('/api/tasks', (req: Request, res: Response) => {
    const tasks = getAllTasks();
    res.json(tasks);
  });

  app.post('/api/tasks', (req: Request, res: Response) => {
    const {
      url,
      title,
      uploader,
      duration,
      duration_string,
      thumbnail,
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
    } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const settings = getSettings();
    const engine = determineEngineForUrl(url);

    const task: DownloadTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      url: url.trim(),
      title: title || 'Queued Item',
      uploader: uploader || undefined,
      duration: duration || undefined,
      duration_string: duration_string || undefined,
      thumbnail: thumbnail || undefined,
      engine,
      status: 'queued',
      progress_percentage: 0,
      speed_str: '0 B/s',
      speed_bytes_per_sec: 0,
      downloaded_bytes: 0,
      total_bytes: 0,
      eta_str: '--:--',
      current_phase: 'Queued',
      format_id: format_id || 'best',
      format_note: format_note || undefined,
      ext: ext || (is_audio_only ? 'mp3' : 'mp4'),
      is_audio_only: Boolean(is_audio_only),
      audio_format: audio_format || settings.default_audio_format,
      audio_bitrate: audio_bitrate || settings.default_audio_bitrate,
      audio_sample_rate: audio_sample_rate ? parseInt(audio_sample_rate, 10) : settings.default_audio_sample_rate,
      audio_bit_depth: audio_bit_depth ? parseInt(audio_bit_depth, 10) : settings.default_audio_bit_depth,
      audio_channels: audio_channels ? parseInt(audio_channels, 10) : undefined,
      is_lossy_source: is_lossy_source !== undefined ? Boolean(is_lossy_source) : false,
      output_path: output_path || settings.download_dir,
      priority: priority || 'normal',
      created_at: new Date().toISOString(),
      retries: 0,
      max_retries: settings.max_retries,
    };

    upsertTask(task);
    queueController.broadcast('task_added', task);
    queueController.scheduleNext();

    res.status(201).json(task);
  });

  // Task actions
  app.post('/api/tasks/:id/pause', (req: Request, res: Response) => {
    const ok = queueController.pauseTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  });

  app.post('/api/tasks/:id/resume', (req: Request, res: Response) => {
    const ok = queueController.resumeTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
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

  app.post('/api/tasks/pause-all', (req: Request, res: Response) => {
    queueController.pauseAll();
    res.json({ success: true });
  });

  app.post('/api/tasks/resume-all', (req: Request, res: Response) => {
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

  app.post('/api/tasks/clear-failed', (req: Request, res: Response) => {
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

  // Settings
  app.get('/api/settings', (req: Request, res: Response) => {
    res.json(getSettings());
  });

  app.put('/api/settings', (req: Request, res: Response) => {
    const updated = saveSettings(req.body);
    queueController.broadcast('settings_updated', updated);
    res.json(updated);
  });

  // Notifications
  app.get('/api/notifications', (req: Request, res: Response) => {
    res.json(getNotifications());
  });

  app.delete('/api/notifications', (req: Request, res: Response) => {
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
    app.get('*', (req: Request, res: Response) => {
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
