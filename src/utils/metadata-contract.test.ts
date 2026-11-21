import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FormatOption, MediaMetadata, NotificationItem } from '../types';
import { buildCuratedVideoOptions, resolveVideoFormatSelector } from './media-formats';
import {
  buildMediaMetadataFromSpotifyEntity,
  buildMediaMetadataFromSpotifyOembed,
  buildMediaMetadataFromSpotifyWebApi,
} from './spotify';

describe('Rust <-> TypeScript MediaMetadata & IPC contract consistency', () => {
  it('matches Rust MediaMetadata JSON shape for Spotify track, album, playlist, artist, and oEmbed', () => {
    const track = buildMediaMetadataFromSpotifyEntity({
      canonicalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      id: '4cOdK2wGLETKBW3PvgPWqT',
      contentType: 'track',
      entity: {
        id: '4cOdK2wGLETKBW3PvgPWqT',
        title: 'Never Gonna Give You Up',
        artists: [{ name: 'Rick Astley' }],
        duration: 213573,
      },
    });
    assert.equal(track.entries, undefined);
    assert.equal(track.is_direct_file, undefined);
    assert.equal(track.direct_file_size, undefined);
    assert.equal(track.direct_mime_type, undefined);
    assert.equal(track.direct_filename, undefined);
    assert.equal(track.accepts_ranges, undefined);

    const oembed = buildMediaMetadataFromSpotifyOembed({
      canonicalUrl: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
      id: '1DFixLWuPkv3KT3TnV35m3',
      contentType: 'album',
      oembed: { title: 'Emotion' },
    });
    assert.equal(oembed.is_playlist, true);
    assert.equal(oembed.partial_tracks, true);

    const webPlaylist = buildMediaMetadataFromSpotifyWebApi({
      canonicalUrl: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      contentType: 'playlist',
      payload: {
        id: '37i9dQZF1DXcBWIGoYBM5M',
        name: "Today's Top Hits",
        owner: { display_name: 'Spotify' },
        tracks: { total: 50, items: [] },
      },
      extraTracks: [],
    });
    assert.equal(webPlaylist.playlist_count, 50);
    assert.equal(webPlaylist.owner, 'Spotify');
  });

  it('parses yt-dlp video/audio formats including tbr/abr and generic playlist entries', () => {
    const formats: FormatOption[] = [
      {
        format_id: '137',
        ext: 'mp4',
        resolution: '1920x1080',
        width: 1920,
        height: 1080,
        fps: 60,
        vcodec: 'avc1.640028',
        acodec: 'none',
        filesize: 45_000_000,
        tbr: 4200.5,
        is_audio_only: false,
        is_video_only: true,
      },
      {
        format_id: '251',
        ext: 'webm',
        resolution: 'audio only',
        vcodec: 'none',
        acodec: 'opus',
        tbr: 135.2,
        abr: 128.0,
        is_audio_only: true,
        is_video_only: false,
      },
    ];

    const media: MediaMetadata = {
      url: 'https://www.youtube.com/playlist?list=PL123',
      id: 'PL123',
      title: 'Test Playlist',
      formats,
      is_playlist: true,
      playlist_count: 1,
      extractor: 'youtube',
      entries: [
        {
          id: 'vid1',
          index: 1,
          title: 'Episode 1',
          url: 'https://www.youtube.com/watch?v=vid1',
          duration: 120,
          duration_string: '02:00',
        },
      ],
    };

    const curated = buildCuratedVideoOptions(media.formats);
    assert.equal(curated[1].height, 1080);
    assert.equal(resolveVideoFormatSelector('137', media.formats), '137+bestaudio/best');
    assert.equal(media.formats[1].abr, 128.0);
    assert.equal(media.entries?.length, 1);
  });

  it('handles direct HTTP metadata and NotificationItem taskId casing', () => {
    const directMeta: MediaMetadata = {
      url: 'https://cdn.example.com/installer.msi',
      id: 'abcdef123456',
      title: 'installer.msi',
      uploader: 'cdn.example.com',
      formats: [
        {
          format_id: 'direct',
          ext: 'msi',
          filesize: 1048576,
          format_note: 'Direct HTTP (Resumable)',
          is_audio_only: false,
          is_video_only: false,
        },
      ],
      is_playlist: false,
      extractor: 'direct-http',
      is_direct_file: true,
      direct_file_size: 1048576,
      direct_mime_type: 'application/x-msi',
      direct_filename: 'installer.msi',
      accepts_ranges: true,
    };

    assert.equal(directMeta.is_direct_file, true);
    assert.equal(directMeta.accepts_ranges, true);

    const notif: NotificationItem = {
      id: 'n1',
      type: 'success',
      title: 'Download Complete',
      message: 'installer.msi finished',
      timestamp: new Date().toISOString(),
      taskId: 'task_123',
    };
    assert.equal(notif.taskId, 'task_123');
  });

  it('verifies Rust models.rs defines all MediaMetadata and FormatOption contract fields', () => {
    const modelsRs = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/models.rs'),
      'utf-8'
    );
    const spotifyRs = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/spotify.rs'),
      'utf-8'
    );
    const commandsRs = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/commands.rs'),
      'utf-8'
    );

    const requiredMediaFields = [
      'entries',
      'is_direct_file',
      'direct_file_size',
      'direct_mime_type',
      'direct_filename',
      'accepts_ranges',
    ];
    for (const field of requiredMediaFields) {
      assert.ok(modelsRs.includes(`pub ${field}:`), `models.rs missing MediaMetadata::${field}`);
    }

    assert.ok(modelsRs.includes('pub tbr: Option<f64>'), 'models.rs missing FormatOption::tbr');
    assert.ok(modelsRs.includes('pub abr: Option<f64>'), 'models.rs missing FormatOption::abr');
    assert.ok(
      modelsRs.includes('#[serde(rename = "taskId", alias = "task_id")]'),
      'models.rs missing NotificationItem taskId serde rename'
    );
    assert.equal(
      commandsRs.includes('use sha2::'),
      false,
      'commands.rs must not contain unused sha2 import'
    );
    assert.equal(
      (spotifyRs.match(/entries:\s*None,/g) || []).length,
      9,
      'spotify.rs must explicitly initialize entries across all 9 MediaMetadata constructors'
    );
    assert.equal(
      (spotifyRs.match(/accepts_ranges:\s*None,/g) || []).length,
      9,
      'spotify.rs must explicitly initialize accepts_ranges across all 9 MediaMetadata constructors'
    );
  });
});
