import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCuratedVideoOptions,
  detectInspectedMediaKind,
  formatMediaRoutingLabel,
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
    assert.equal(formatMediaRoutingLabel(audioMeta, 'audio', audioMeta.url), 'Audio · yt-dlp');
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
    assert.equal(formatMediaRoutingLabel(videoMeta, 'video', videoMeta.url), 'Video · yt-dlp');

    const options = buildCuratedVideoOptions(videoMeta.formats);
    assert.equal(
      options[1].formatSelector,
      'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
    );
    assert.equal(resolveVideoFormatSelector('137', videoMeta.formats), '137+bestaudio/best');

    const codecSummary = summarizeVideoOptionCodecs(videoMeta.formats, '137+bestaudio/best');
    assert.ok(codecSummary);
    assert.equal(codecSummary.resolution, '1920x1080');
    assert.equal(codecSummary.vcodec, 'AVC1');
    assert.equal(codecSummary.acodec, 'MP4A');
    assert.equal(codecSummary.fps, 60);
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
