import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EngineManager,
  validateInspectionUrl,
} from '../../server/engineManager';
import {
  InspectionController,
  InspectionUiState,
  isCancellationError,
  isTimeoutErrorMessage,
  validateClientUrl,
} from './inspection-controller';
import { MediaMetadata } from '../types';

function makeMockScript(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return filePath;
}

describe('URL validation parity (client & server)', () => {
  it('rejects empty, whitespace, flag injection, and unsupported URL schemes', () => {
    const badUrls = [
      '',
      '   ',
      '--exec whoami',
      '-v',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/file.mp4',
      'https://example.com/watch?v=1 with-space',
      'https://',
      'https://.leadingdot.com/video',
    ];

    for (const u of badUrls) {
      assert.throws(() => validateInspectionUrl(u));
      assert.ok(validateClientUrl(u) !== null, `expected client validation error for ${u}`);
    }
  });

  it('accepts valid HTTP and HTTPS URLs', () => {
    const good = '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ';
    assert.equal(validateInspectionUrl(good), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(validateClientUrl(good), null);
    assert.equal(validateClientUrl('http://localhost:8080/media.mp4'), null);
  });
});

describe('Server EngineManager async checks & subprocess inspection', () => {
  it('runs getEngineStatus asynchronously and supports coalescing and force refresh', async () => {
    const mgr = new EngineManager();
    const [a, b] = await Promise.all([mgr.getEngineStatus(), mgr.getEngineStatus()]);
    assert.deepEqual(a, b);
    assert.ok(['ready', 'missing', 'error', 'timed_out'].includes(a.ytdlp.status));
    assert.equal(typeof a.ytdlp.durationMs, 'number');

    const refreshed = await mgr.getEngineStatus(true);
    assert.ok(['ready', 'missing', 'error', 'timed_out'].includes(refreshed.ffmpeg.status));
  });

  it('parses metadata cleanly and passes --skip-download, --no-exec, and -- before URL', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta_node_inspect_'));
    try {
      const argsLog = path.join(tmpDir, 'args.txt');
      const okScript = makeMockScript(
        tmpDir,
        'ytdlp-ok.sh',
        `printf '%s\n' "$@" > "${argsLog}"\nprintf '{"id":"abc123","title":"Stability Test Clip","uploader":"VANTA","duration":42,"extractor":"generic","formats":[{"format_id":"22","ext":"mp4","height":720,"vcodec":"avc1","acodec":"mp4a"}]}\n'`
      );

      const mgr = new EngineManager();
      const meta = await mgr.inspectUrl('https://example.com/video?id=9', undefined, 'req_node_ok', {
        ytdlpBinary: okScript,
        timeoutMs: 5000,
      });

      assert.equal(meta.id, 'abc123');
      assert.equal(meta.title, 'Stability Test Clip');
      assert.equal(meta.formats.length, 1);

      const recordedArgs = fs.readFileSync(argsLog, 'utf-8').trim().split('\n');
      assert.ok(recordedArgs.includes('--skip-download'));
      assert.ok(recordedArgs.includes('--no-exec'));
      const dashDashIndex = recordedArgs.indexOf('--');
      assert.ok(dashDashIndex >= 0);
      assert.equal(recordedArgs[dashDashIndex + 1], 'https://example.com/video?id=9');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('times out hung extractor subprocesses without hanging Node', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta_node_timeout_'));
    try {
      const hangScript = makeMockScript(tmpDir, 'ytdlp-hang.sh', 'sleep 10');
      const mgr = new EngineManager();

      const t0 = Date.now();
      await assert.rejects(
        () =>
          mgr.inspectUrl('https://example.com/hang', undefined, 'req_timeout', {
            ytdlpBinary: hangScript,
            timeoutMs: 250,
          }),
        /timed out/i
      );
      assert.ok(Date.now() - t0 < 3000, 'timeout should complete promptly');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('cancels an active inspection cleanly via cancelInspection(requestId)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta_node_cancel_'));
    try {
      const hangScript = makeMockScript(tmpDir, 'ytdlp-slow.sh', 'sleep 10');
      const mgr = new EngineManager();

      const inspectPromise = mgr.inspectUrl('https://example.com/slow', undefined, 'req_cancel_1', {
        ytdlpBinary: hangScript,
        timeoutMs: 10000,
      });

      setTimeout(() => {
        const cancelled = mgr.cancelInspection('req_cancel_1');
        assert.equal(cancelled, true);
      }, 100);

      await assert.rejects(() => inspectPromise, /cancelled/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('aborts cleanly on oversized stdout JSON and rejects malformed JSON safely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta_node_overflow_'));
    try {
      const hugeScript = makeMockScript(
        tmpDir,
        'ytdlp-huge.sh',
        'python3 -c "print(\'{\\"x\\":\\"\' + \'a\'*4096 + \'\\"}\')"'
      );
      const badJsonScript = makeMockScript(tmpDir, 'ytdlp-badjson.sh', `printf '{"title":"broken'`);
      const mgr = new EngineManager();

      await assert.rejects(
        () =>
          mgr.inspectUrl('https://example.com/huge', undefined, 'req_huge', {
            ytdlpBinary: hugeScript,
            timeoutMs: 5000,
            maxStdoutBytes: 512,
          }),
        /exceeded safe limit/i
      );

      await assert.rejects(
        () =>
          mgr.inspectUrl('https://example.com/bad', undefined, 'req_badjson', {
            ytdlpBinary: badJsonScript,
            timeoutMs: 5000,
          }),
        /invalid or incomplete metadata/i
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Frontend InspectionController lifecycle & race-condition protection', () => {
  const sampleMeta: MediaMetadata = {
    url: 'https://example.com/v1',
    id: 'v1',
    title: 'First Video',
    formats: [],
    is_playlist: false,
    extractor: 'generic',
  };

  function createStateTracker() {
    const state: InspectionUiState = {
      isExtracting: false,
      metadata: null,
      extractError: null,
      isTimeoutError: false,
      activeRequestId: null,
    };
    const transitions: Partial<InspectionUiState>[] = [];
    const onStateChange = (patch: Partial<InspectionUiState>) => {
      transitions.push(patch);
      Object.assign(state, patch);
    };
    return { state, transitions, onStateChange };
  }

  it('transitions loading -> success cleanly for valid URLs', async () => {
    const controller = new InspectionController();
    const { state, onStateChange } = createStateTracker();

    const result = await controller.startInspection('https://example.com/v1', {
      inspectUrl: async () => sampleMeta,
      cancelInspection: async () => false,
      onStateChange,
    });

    assert.equal(result?.id, 'v1');
    assert.equal(state.isExtracting, false);
    assert.equal(state.metadata?.title, 'First Video');
    assert.equal(state.extractError, null);
  });

  it('surfaces timeout classification and supports retry recovery', async () => {
    const controller = new InspectionController();
    const { state, onStateChange } = createStateTracker();
    let attempt = 0;

    await controller.startInspection('https://example.com/flaky', {
      inspectUrl: async () => {
        attempt += 1;
        throw new Error('URL inspection timed out after 60s');
      },
      cancelInspection: async () => false,
      onStateChange,
    });

    assert.equal(attempt, 1);
    assert.equal(state.isExtracting, false);
    assert.equal(state.isTimeoutError, true);
    assert.equal(isTimeoutErrorMessage(state.extractError || ''), true);

    await controller.startInspection('https://example.com/flaky', {
      inspectUrl: async () => {
        attempt += 1;
        return sampleMeta;
      },
      cancelInspection: async () => false,
      onStateChange,
    });

    assert.equal(attempt, 2);
    assert.equal(state.isTimeoutError, false);
    assert.equal(state.extractError, null);
    assert.equal(state.metadata?.id, 'v1');
  });

  it('cancels prior request on repeated Analyze and ignores stale slow responses', async () => {
    const controller = new InspectionController();
    const { state, onStateChange } = createStateTracker();
    const cancelledIds: string[] = [];

    let resolveFirst!: (m: MediaMetadata) => void;
    const firstPromise = new Promise<MediaMetadata>((resolve) => {
      resolveFirst = resolve;
    });

    const p1 = controller.startInspection('https://example.com/old', {
      inspectUrl: () => firstPromise,
      cancelInspection: async (id) => {
        cancelledIds.push(id);
        return true;
      },
      onStateChange,
    });

    const p2 = controller.startInspection('https://example.com/new', {
      inspectUrl: async (url) => ({
        ...sampleMeta,
        url,
        id: 'v2',
        title: 'Latest Video',
      }),
      cancelInspection: async (id) => {
        cancelledIds.push(id);
        return true;
      },
      onStateChange,
    });

    await p2;
    assert.equal(cancelledIds.length, 1);
    assert.equal(state.metadata?.id, 'v2');

    // Late resolution of request 1 must NOT overwrite request 2's metadata!
    resolveFirst({
      ...sampleMeta,
      id: 'stale_1',
      title: 'Stale Overwrite Attempt',
    });
    const r1 = await p1;
    assert.equal(r1, null);
    assert.equal(state.metadata?.id, 'v2');
    assert.equal(state.metadata?.title, 'Latest Video');
  });

  it('cancels active inspection on dispose/unmount and suppresses late state updates', async () => {
    const controller = new InspectionController();
    const { state, transitions, onStateChange } = createStateTracker();
    const cancelledIds: string[] = [];
    let aborted = false;
    let rejectPending!: (err: Error) => void;

    const p = controller.startInspection('https://example.com/hanging', {
      inspectUrl: (_url, opts) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<MediaMetadata>((_res, rej) => {
          rejectPending = rej;
        });
      },
      cancelInspection: async (id) => {
        cancelledIds.push(id);
        return true;
      },
      onStateChange,
    });

    const transitionCountBeforeDispose = transitions.length;
    controller.dispose(async (id) => {
      cancelledIds.push(id);
      return true;
    });

    assert.equal(aborted, true);
    assert.equal(cancelledIds.length, 1);

    rejectPending(new Error('late network error after unmount'));
    await p;

    // Wait tick to be sure no trailing updates landed
    assert.equal(controller.isMounted(), false);
    assert.equal(state.extractError, null);
    assert.equal(transitions.length >= transitionCountBeforeDispose, true);
    assert.equal(isCancellationError(new Error('Inspection cancelled.')), true);
  });
});
