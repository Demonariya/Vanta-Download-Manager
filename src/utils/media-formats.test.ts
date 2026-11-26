import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCuratedVideoOptions,
  detectInspectedMediaKind,
  formatMediaRoutingLabel,
  getDefaultVideoFormatSelector,
  resolveVideoFormatSelector,
  summarizeVideoOptionCodecs,
} from './media-formats';
import { MediaMetadata } from '../types';

function makeBaseMetadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    url: 'https://example.com/watch?v=123',
    id: '123',
    title: 'Sample Media',
    formats: [],
    is_playlist: false,
    extractor: 'yt-dlp',
    ...overrides,
  };
}

describe('Unified media kind auto-detection', () => {
  it('routes Spotify metadata and URLs automatically to audio', () => {
    const meta = makeBaseMetadata({
      url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      extractor: 'spotdl',
      content_type: 'track',
    });
    assert.equal(detectInspectedMediaKind(meta, meta.url), 'audio');
    assert.equal(detectInspectedMediaKind(null, 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'), 'audio');
    assert.equal(formatMediaRoutingLabel(meta, 'audio', meta.url), 'Spotify Track · spotDL');
  });

  it('detects yt-dlp audio-only streams and direct audio URLs as audio', () => {
    const audioMeta = makeBaseMetadata({
      url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      formats: [
        {
          format_id: '0',
          ext: 'mp3',
          vcodec: 'none',
          acodec: 'mp3',
          is_audio_only: true,
        },
      ],
    });
    assert.equal(detectInspectedMediaKind(audioMeta, audioMeta.url), 'audio');
    assert.equal(detectInspectedMediaKind(null, 'https://cdn.example.com/tracks/demo.flac?token=1'), 'audio');
    assert.equal(formatMediaRoutingLabel(audioMeta, 'audio', audioMeta.url), 'Direct Audio · Audio · yt-dlp');
  });

  it('detects video streams as video and summarizes video/audio codecs cleanly', () => {
    const videoMeta = makeBaseMetadata({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formats: [
        {
          format_id: '137',
          ext: 'mp4',
          resolution: '1920x1080',
          width: 1920,
          height: 1080,
          fps: 60,
          vcodec: 'avc1.64002a',
          acodec: 'none',
          is_video_only: true,
        },
        {
          format_id: '140',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          abr: 128,
          is_audio_only: true,
        },
      ],
    });

    assert.equal(detectInspectedMediaKind(videoMeta, videoMeta.url), 'video');
    assert.equal(formatMediaRoutingLabel(videoMeta, 'video', videoMeta.url), 'YouTube · Video · yt-dlp');

    const options = buildCuratedVideoOptions(videoMeta.formats);
    assert.equal(
      options[1].formatSelector,
      '137+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]'
    );
    assert.equal(resolveVideoFormatSelector('137', videoMeta.formats), '137+bestaudio/best');
    assert.equal(
      resolveVideoFormatSelector('silent-unknown-codec', [
        { format_id: 'silent-unknown-codec', ext: 'webm', vcodec: 'vp9' },
      ]),
      'silent-unknown-codec+bestaudio/best'
    );
    assert.equal(
      resolveVideoFormatSelector('audio-140', [
        { format_id: 'audio-140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', is_audio_only: true },
      ]),
      'audio-140'
    );

    const codecSummary = summarizeVideoOptionCodecs(videoMeta.formats, '137+bestaudio/best');
    assert.ok(codecSummary);
    assert.equal(codecSummary.resolution, '1920x1080');
    assert.equal(codecSummary.vcodec, 'AVC1');
    assert.equal(codecSummary.acodec, 'MP4A');
    assert.equal(codecSummary.fps, 60);
  });
});

describe('Default video quality selection', () => {
  it('defaults to the highest concrete resolution returned by the extractor', () => {
    assert.equal(getDefaultVideoFormatSelector([
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' },
      { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a' },
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', is_video_only: true },
    ]), '137+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]');
  });

  it('keeps the adaptive preset when no concrete video stream is available', () => {
    assert.equal(getDefaultVideoFormatSelector([
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', is_audio_only: true },
    ]), 'bestvideo+bestaudio/best');
  });
});

describe('Truthful video format selection', () => {
  it('does not advertise fixed resolutions when extractor reports no video stream', () => {
    const options = buildCuratedVideoOptions([
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', is_audio_only: true },
    ]);
    assert.equal(options.length, 1);
    assert.equal(options[0].id, 'best');
  });


  it('falls back to the best video-only stream instead of a low-resolution muxed format', () => {
    const options = buildCuratedVideoOptions([
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' },
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', is_video_only: true },
    ]);
    assert.equal(
      options.find((option) => option.height === 1080)?.formatSelector,
      '137+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]'
    );
  });

  it('uses the same high-resolution fallback for a muxed inspected stream', () => {
    const options = buildCuratedVideoOptions([
      { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a' },
    ]);
    assert.equal(
      options.find((option) => option.height === 720)?.formatSelector,
      '22/bestvideo[height<=720]+bestaudio/best[height<=720]'
    );
  });

  it('only advertises heights present in real video formats', () => {
    const options = buildCuratedVideoOptions([
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' },
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', is_video_only: true },
    ]);
    assert.deepEqual(options.slice(1).map((option) => option.height), [1080, 360]);
    assert.equal(options.some((option) => option.height === 2160), false);
    assert.equal(options[1].formatSelector, '137+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]');
  });
});

describe('Media provider recognition', () => {
  it('recognizes common supported media hosts without matching deceptive suffixes', () => {
    assert.equal(formatMediaRoutingLabel(null, 'video', 'https://www.youtube.com/watch?v=abc'), 'YouTube · Video · yt-dlp');
    assert.equal(formatMediaRoutingLabel(null, 'video', 'https://youtu.be/abc'), 'YouTube · Video · yt-dlp');
    assert.equal(formatMediaRoutingLabel(null, 'audio', 'https://soundcloud.com/artist/track'), 'SoundCloud · Audio · yt-dlp');
    assert.equal(formatMediaRoutingLabel(null, 'video', 'https://notyoutube.com/watch?v=abc'), 'Media Link · Video · yt-dlp');
    assert.equal(formatMediaRoutingLabel(null, 'video', 'ftp://youtube.com/video.mp4'), 'Media Link · Video · yt-dlp');
    assert.equal(formatMediaRoutingLabel(null, 'video', 'https://user:pass@youtube.com/watch?v=abc'), 'Media Link · Video · yt-dlp');
  });
});

describe('Unified workflow architectural guarantee', () => {
  it('ensures no separate Music Workflow UI or duplicate TopBar URL form remains', () => {
    const root = process.cwd();
    assert.equal(
      fs.existsSync(path.join(root, 'src/components/MusicLibraryView.tsx')),
      false,
      'MusicLibraryView.tsx must be completely removed'
    );

    const sidebar = fs.readFileSync(path.join(root, 'src/components/Sidebar.tsx'), 'utf-8');
    const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf-8');
    const topBar = fs.readFileSync(path.join(root, 'src/components/TopBar.tsx'), 'utf-8');

    assert.equal(sidebar.includes('Music Workflow'), false);
    assert.equal(app.includes('MusicLibraryView'), false);
    assert.equal(topBar.includes('Inspect URL'), false);
  });
});
