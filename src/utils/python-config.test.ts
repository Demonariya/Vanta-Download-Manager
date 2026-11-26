import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineManager, validatePythonExecutable } from '../../server/engineManager';
import { buildDefaultSettings } from '../../server/db';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validatePythonExecutable handles paths with spaces, captures stdout/stderr, and rejects non-Python binaries', async () => {
  const dir = makeTempDir('vanta python space test ');
  try {
    const validScript = path.join(dir, 'mock python.sh');
    fs.writeFileSync(validScript, '#!/bin/sh\necho "Python 3.12.4"\n', { mode: 0o755 });

    const stderrScript = path.join(dir, 'mock python stderr.sh');
    fs.writeFileSync(stderrScript, '#!/bin/sh\necho "Python 3.11.9" 1>&2\n', { mode: 0o755 });

    const failingScript = path.join(dir, 'not-python.sh');
    fs.writeFileSync(failingScript, '#!/bin/sh\necho "Not Python" 1>&2\nexit 1\n', { mode: 0o755 });

    const okStdout = await validatePythonExecutable(validScript);
    assert.equal(okStdout.valid, true);
    assert.equal(okStdout.version, 'Python 3.12.4');
    assert.equal(okStdout.stdout, 'Python 3.12.4');
    assert.equal(okStdout.executablePath, path.resolve(validScript));

    const okStderr = await validatePythonExecutable(stderrScript);
    assert.equal(okStderr.valid, true);
    assert.equal(okStderr.version, 'Python 3.11.9');
    assert.equal(okStderr.stderr, 'Python 3.11.9');

    const bad = await validatePythonExecutable(failingScript);
    assert.equal(bad.valid, false);
    assert.match(bad.error || '', /Not Python/);

    const missing = await validatePythonExecutable(path.join(dir, 'missing_python.exe'));
    assert.equal(missing.valid, false);
    assert.match(missing.error || '', /does not exist/);

    const empty = await validatePythonExecutable('   ');
    assert.equal(empty.valid, false);
    assert.match(empty.error || '', /cannot be empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EngineManager.resolvePythonForSpotdl never silently falls back to PATH when custom python_path is invalid', async () => {
  const mgr = new EngineManager();
  const dir = makeTempDir('vanta-python-resolve-');
  try {
    const missingCustom = path.join(dir, 'missing', 'python.exe');
    const settings = { ...buildDefaultSettings(), python_path: missingCustom };
    await assert.rejects(() => mgr.resolvePythonForSpotdl(settings), /does not exist/);

    const validScript = path.join(dir, 'custom python');
    fs.writeFileSync(validScript, '#!/bin/sh\necho "Python 3.12.1"\n', { mode: 0o755 });
    const resolved = await mgr.resolvePythonForSpotdl({ ...buildDefaultSettings(), python_path: validScript });
    assert.equal(resolved, path.resolve(validScript));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EngineManager resolves <InstallDir>/Engine/{yt-dlp,spotdl/venv,ffmpeg/bin} layout via VANTA_ENGINE_ROOT', async () => {
  const installDir = makeTempDir('vanta-install-dir-');
  const engineRoot = path.join(installDir, 'Engine');
  const prevOverride = process.env.VANTA_ENGINE_ROOT;
  process.env.VANTA_ENGINE_ROOT = engineRoot;
  try {
    const mgr = new EngineManager();
    assert.equal(mgr.getInstallRootDir(), path.resolve(installDir));
    assert.equal(mgr.getManagedRootDir(), path.resolve(engineRoot));
    assert.equal(mgr.getYtdlpDir(), path.join(engineRoot, 'yt-dlp'));
    assert.equal(mgr.getSpotdlDir(), path.join(engineRoot, 'spotdl'));
    assert.equal(mgr.getSpotdlVenvDir(), path.join(engineRoot, 'spotdl', 'venv'));
    assert.equal(mgr.getFfmpegDir(), path.join(engineRoot, 'ffmpeg', 'bin'));
    assert.equal(mgr.getManifestPath(), path.join(engineRoot, 'manifest.json'));
  } finally {
    if (prevOverride === undefined) {
      delete process.env.VANTA_ENGINE_ROOT;
    } else {
      process.env.VANTA_ENGINE_ROOT = prevOverride;
    }
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});
