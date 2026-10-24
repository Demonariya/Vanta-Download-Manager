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
  getSettings,
  saveSettings,
  getNotifications,
  clearNotifications,
} from './server/db';
import { engineManager } from './server/engineManager';
import { queueController } from './server/queueController';
import { DownloadTask } from './src/types';
import { determineEngineForUrl } from './src/utils/engine-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

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

  // Diagnostics test
  app.post('/api/engines/diagnostics', async (req: Request, res: Response) => {
    try {
      const results = await engineManager.runDiagnostics();
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
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
    queueController.cancelTask(id);
    deleteTask(id);
    queueController.broadcast('task_deleted', { id });
    res.json({ success: true });
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
    clearCompletedTasks();
    const updated = getAllTasks();
    queueController.broadcast('tasks_cleared', updated);
    res.json({ success: true });
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
