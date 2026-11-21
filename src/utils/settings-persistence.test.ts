import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SETTINGS_SCHEMA_VERSION,
  atomicWriteFileSync,
  buildDefaultSettings,
  getSettingsFilePath,
  hydrateTaskRow,
  initializeDatabaseSchema,
  readSettingsFromStorage,
  resetSettingsInStorage,
  validateSettings,
  writeSettingsToStorage,
} from '../../server/db';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validateSettings enforces directory, bounds, theme (including system), proxy, and cookies_file rules', () => {
  const valid = buildDefaultSettings();
  assert.doesNotThrow(() => validateSettings(valid));

  assert.doesNotThrow(() => validateSettings({ ...valid, theme: 'system' }));
  assert.doesNotThrow(() => validateSettings({ ...valid, theme: 'light' }));

  assert.throws(() => validateSettings({ ...valid, download_dir: '   ' }), /Download directory/);
  assert.throws(() => validateSettings({ ...valid, theme: 'neon' as any }), /dark, light, or system/);
  assert.throws(() => validateSettings({ ...valid, max_concurrent_downloads: 0 }), /between 1 and 16/);
  assert.throws(() => validateSettings({ ...valid, max_concurrent_downloads: 32 }), /between 1 and 16/);
  assert.throws(() => validateSettings({ ...valid, proxy_url: 'ftp://proxy.local:8080' }), /Proxy URL/);
  assert.throws(
    () => validateSettings({ ...valid, cookies_file: '/nonexistent/path/cookies.txt' }),
    /cookies file/
  );
});

test('writeSettingsToStorage & readSettingsFromStorage persist atomically across settings.v1.json and SQLite', () => {
  const dir = makeTempDir('vanta-settings-roundtrip-');
  const db = new DatabaseSync(path.join(dir, 'vanta.db'));
  try {
    initializeDatabaseSchema(db);
    const defaults = buildDefaultSettings();
    const custom = {
      ...defaults,
      theme: 'system' as const,
      max_concurrent_downloads: 6,
      python_path: '/opt/python/bin/python3',
      download_dir: path.join(dir, 'downloads'),
    };

    const saved = writeSettingsToStorage(db, dir, custom);
    assert.equal(saved.schema_version, SETTINGS_SCHEMA_VERSION);
    assert.equal(saved.theme, 'system');
    assert.equal(saved.python_path, '/opt/python/bin/python3');

    const filePath = getSettingsFilePath(dir);
    assert.equal(fs.existsSync(filePath), true);
    const jsonOnDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(jsonOnDisk.theme, 'system');
    assert.equal(jsonOnDisk.max_concurrent_downloads, 6);

    const reloaded = readSettingsFromStorage(db, dir);
    assert.equal(reloaded.theme, 'system');
    assert.equal(reloaded.max_concurrent_downloads, 6);
    assert.equal(reloaded.python_path, '/opt/python/bin/python3');

    const dbRow = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get() as { value: string };
    assert.equal(JSON.parse(dbRow.value), 'system');

    const reset = resetSettingsInStorage(db, dir);
    assert.equal(reset.theme, 'dark');
    assert.equal(reset.python_path, '');
    assert.equal(reset.max_concurrent_downloads, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSettingsFromStorage backs up corrupt JSON file and recovers defaults cleanly', () => {
  const dir = makeTempDir('vanta-settings-corrupt-');
  const db = new DatabaseSync(path.join(dir, 'vanta.db'));
  try {
    initializeDatabaseSchema(db);
    const settingsFile = getSettingsFilePath(dir);
    atomicWriteFileSync(settingsFile, '{not valid json!!!');

    const recovered = readSettingsFromStorage(db, dir);
    assert.equal(recovered.theme, 'dark');
    assert.equal(recovered.schema_version, SETTINGS_SCHEMA_VERSION);

    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('settings.corrupt.') && f.endsWith('.json')));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initializeDatabaseSchema migrates legacy tasks/categories SQLite schema without losing existing task rows', () => {
  const dir = makeTempDir('vanta-db-migration-');
  const db = new DatabaseSync(path.join(dir, 'legacy.db'));
  try {
    // Simulate a legacy database that had categories & category_id & sha256 columns
    db.exec(`
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO categories (id, name) VALUES ('cat_video', 'Videos');
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        output_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        category_id TEXT DEFAULT 'cat_video',
        verified_sha256 TEXT
      );
      INSERT INTO tasks (id, url, title, engine, status, output_path, created_at, category_id)
      VALUES ('legacy_1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Legacy Video', 'yt-dlp', 'completed', '/downloads/video.mp4', '2026-01-01T00:00:00Z', 'cat_video');
    `);

    initializeDatabaseSchema(db);

    const rows = db.prepare('SELECT * FROM tasks WHERE id = ?').all('legacy_1') as any[];
    assert.equal(rows.length, 1);
    const hydrated = hydrateTaskRow(rows[0]);
    assert.equal(hydrated.id, 'legacy_1');
    assert.equal(hydrated.title, 'Legacy Video');
    assert.equal(hydrated.status, 'completed');
    assert.equal('category_id' in hydrated, false);
    assert.equal('verified_sha256' in hydrated, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
