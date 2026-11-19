import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMediaMetadataFromSpotifyEntity,
  buildMediaMetadataFromSpotifyOembed,
  buildMediaMetadataFromSpotifyWebApi,
  decodeHtmlEntities,
  extractSpotifyNextData,
  isGenericSpotifyIcon,
  isSpotifyUrl,
  parseSpotifyOpenGraphMeta,
  splitSpotifyArtists,
  tryParseSpotifyInput,
} from './spotify';
import { determineEngineForUrl } from './engine-parser';
import { validateClientUrl } from './inspection-controller';
import { validateInspectionUrl } from '../../server/engineManager';
import { SpotifyMetadataService } from '../../server/spotify';

function makeEmbedHtml(entity: unknown): string {
  const payload = {
    props: {
      pageProps: {
        state: {
          data: {
            entity,
          },
        },
      },
    },
  };
  return `<!doctype html><html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload
  )}</script></body></html>`;
}

describe('Spotify URL & URI parser', () => {
  it('parses track, album, playlist, artist URLs including intl, embed, play.spotify.com, and query params', () => {
    const cases: Array<[string, 'track' | 'album' | 'playlist' | 'artist', string]> = [
      ['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123', 'track', '4cOdK2wGLETKBW3PvgPWqT'],
      ['https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3', 'album', '1DFixLWuPkv3KT3TnV35m3'],
      ['https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M', 'playlist', '37i9dQZF1DXcBWIGoYBM5M'],
      ['https://play.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt', 'artist', '0gxyHStUsqpMadRV0Di1Qt'],
      ['spotify:track:4cOdK2wGLETKBW3PvgPWqT', 'track', '4cOdK2wGLETKBW3PvgPWqT'],
      ['spotify:album:1DFixLWuPkv3KT3TnV35m3', 'album', '1DFixLWuPkv3KT3TnV35m3'],
      ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'playlist', '37i9dQZF1DXcBWIGoYBM5M'],
      ['spotify:artist:0gxyHStUsqpMadRV0Di1Qt', 'artist', '0gxyHStUsqpMadRV0Di1Qt'],
    ];

    for (const [input, expectedType, expectedId] of cases) {
      const parsed = tryParseSpotifyInput(input);
      assert.ok(parsed && parsed.kind === 'resource', `Expected resource for ${input}`);
      assert.equal(parsed.type, expectedType);
      assert.equal(parsed.id, expectedId);
      assert.equal(parsed.uri, `spotify:${expectedType}:${expectedId}`);
      assert.equal(parsed.canonicalUrl, `https://open.spotify.com/${expectedType}/${expectedId}`);
      assert.equal(isSpotifyUrl(input), true);
      assert.equal(determineEngineForUrl(input), 'spotdl');
      assert.equal(validateClientUrl(input), null);
      assert.doesNotThrow(() => validateInspectionUrl(input));
    }
  });

  it('recognizes spotify short links and ignores non-Spotify URLs containing spotify in query', () => {
    const shortParsed = tryParseSpotifyInput('https://spotify.link/XyZ123abc');
    assert.deepEqual(shortParsed, {
      kind: 'short_link',
      url: 'https://spotify.link/XyZ123abc',
    });

    const youtubeWithRef = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&ref=spotify.com';
    assert.equal(tryParseSpotifyInput(youtubeWithRef), null);
    assert.equal(isSpotifyUrl(youtubeWithRef), false);
    assert.equal(determineEngineForUrl(youtubeWithRef), 'yt-dlp');
  });

  it('returns explicit validation errors for malformed or unsupported Spotify inputs', () => {
    const invalidInputs = [
      'https://open.spotify.com/user/spotify',
      'https://open.spotify.com/track/',
      'https://open.spotify.com/track/bad',
      'spotify:episode:1234567890abcd',
      'spotify:track',
    ];

    for (const input of invalidInputs) {
      const parsed = tryParseSpotifyInput(input);
      assert.ok(parsed && parsed.kind === 'invalid', `Expected invalid for ${input}`);
      assert.ok(parsed.error.length > 0);
      assert.ok(validateClientUrl(input) !== null);
      assert.throws(() => validateInspectionUrl(input));
    }
  });
});

describe('Spotify payload normalization', () => {
  it('extracts multi-artist track metadata, album/track_number/release_date, duration, and largest artwork', () => {
    const entity = {
      id: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }, { name: 'Guest Vocalist' }],
      subtitle: 'Rick Astley,\u00a0Guest Vocalist',
      duration: 213573,
      isExplicit: false,
      releaseDate: { isoString: '1987-11-12T00:00:00Z' },
      visualIdentity: {
        image: [
          { url: 'https://open.spotifycdn.com/cdn/images/favicon.0f31d2ea.ico', maxWidth: 64 },
          { url: 'https://i.scdn.co/image/small300', maxWidth: 300 },
          { url: 'https://i.scdn.co/image/large640', maxWidth: 640 },
        ],
      },
    };
    const ogHtml = `
      <meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987" />
      <meta property="music:album:track" content="1" />
      <meta property="music:release_date" content="1987-11-12" />
    `;
    const ogMeta = parseSpotifyOpenGraphMeta(ogHtml);
    const meta = buildMediaMetadataFromSpotifyEntity({
      canonicalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      id: '4cOdK2wGLETKBW3PvgPWqT',
      contentType: 'track',
      entity,
      ogMeta,
    });

    assert.equal(meta.title, 'Never Gonna Give You Up');
    assert.deepEqual(meta.artists, ['Rick Astley', 'Guest Vocalist']);
    assert.equal(meta.uploader, 'Rick Astley, Guest Vocalist');
    assert.equal(meta.album, 'Whenever You Need Somebody');
    assert.equal(meta.track_number, 1);
    assert.equal(meta.release_date, '1987-11-12');
    assert.equal(meta.duration, 214);
    assert.equal(meta.duration_string, '03:34');
    assert.equal(meta.album_artwork, 'https://i.scdn.co/image/large640');
    assert.equal(meta.thumbnail, 'https://i.scdn.co/image/large640');
    assert.equal(meta.content_type, 'track');
    assert.equal(meta.explicit, false);
    assert.equal(isGenericSpotifyIcon(meta.thumbnail), false);
    assert.deepEqual(splitSpotifyArtists('Artist A,\u00a0Artist B'), ['Artist A', 'Artist B']);
    assert.equal(decodeHtmlEntities('Tom &amp; Jerry &#39;87'), "Tom & Jerry '87");
  });

  it('normalizes album, large >100 playlist partial_tracks, and artist top tracks', () => {
    const albumEntity = {
      id: '1DFixLWuPkv3KT3TnV35m3',
      title: 'Emotion',
      artists: [{ name: 'Carly Rae Jepsen' }],
      releaseDate: { isoString: '2015-09-25T00:00:00Z' },
      visualIdentity: { image: [{ url: 'https://i.scdn.co/image/album640', maxWidth: 640 }] },
      trackList: [
        { title: 'Run Away with Me', subtitle: 'Carly Rae Jepsen', duration: 251000, uri: 'spotify:track:aaa111222333' },
        { title: 'Emotion', subtitle: 'Carly Rae Jepsen', duration: 197000, uri: 'spotify:track:bbb111222333' },
      ],
    };
    const albumMeta = buildMediaMetadataFromSpotifyEntity({
      canonicalUrl: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
      id: '1DFixLWuPkv3KT3TnV35m3',
      contentType: 'album',
      entity: albumEntity,
    });
    assert.equal(albumMeta.content_type, 'album');
    assert.equal(albumMeta.total_tracks, 2);
    assert.equal(albumMeta.duration, 448);
    assert.equal(albumMeta.duration_string, '07:28');
    assert.equal(albumMeta.tracks?.length, 2);
    assert.equal(albumMeta.partial_tracks, undefined);

    // >100 playlist embed preview should flag partial_tracks when OG music:song_count is 150
    const playlistTracks = Array.from({ length: 100 }, (_, i) => ({
      title: `Track ${i + 1}`,
      subtitle: 'Various Artists',
      duration: 180000,
      uri: `spotify:track:trackid${String(i).padStart(10, '0')}`,
    }));
    const playlistMeta = buildMediaMetadataFromSpotifyEntity({
      canonicalUrl: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      contentType: 'playlist',
      entity: {
        id: '37i9dQZF1DXcBWIGoYBM5M',
        title: "Today's Top Hits",
        subtitle: 'Spotify',
        visualIdentity: { image: [{ url: 'https://i.scdn.co/image/pl640', maxWidth: 640 }] },
        trackList: playlistTracks,
      },
      ogMeta: { songCount: 150 },
    });
    assert.equal(playlistMeta.content_type, 'playlist');
    assert.equal(playlistMeta.owner, 'Spotify');
    assert.equal(playlistMeta.total_tracks, 150);
    assert.equal(playlistMeta.tracks?.length, 100);
    assert.equal(playlistMeta.partial_tracks, true);

    const oembedPartial = buildMediaMetadataFromSpotifyOembed({
      canonicalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      id: '4cOdK2wGLETKBW3PvgPWqT',
      contentType: 'track',
      oembed: {
        title: 'Never Gonna Give You Up',
        thumbnail_url: 'https://open.spotifycdn.com/cdn/images/favicon.0f31d2ea.ico',
      },
    });
    assert.equal(oembedPartial.partial_tracks, true);
    assert.equal(oembedPartial.metadata_source, 'spotify-oembed');
    assert.equal(oembedPartial.thumbnail, undefined);

    const webApiArtist = buildMediaMetadataFromSpotifyWebApi({
      canonicalUrl: 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt',
      id: '0gxyHStUsqpMadRV0Di1Qt',
      contentType: 'artist',
      payload: {
        id: '0gxyHStUsqpMadRV0Di1Qt',
        name: 'Rick Astley',
        images: [{ url: 'https://i.scdn.co/image/artist640', width: 640 }],
      },
      extraTracks: [
        {
          id: '4cOdK2wGLETKBW3PvgPWqT',
          name: 'Never Gonna Give You Up',
          duration_ms: 213000,
          artists: [{ name: 'Rick Astley' }],
          album: { name: 'Whenever You Need Somebody', images: [{ url: 'https://i.scdn.co/image/t640', width: 640 }] },
        },
      ],
    });
    assert.equal(webApiArtist.content_type, 'artist');
    assert.equal(webApiArtist.tracks?.length, 1);
    assert.equal(webApiArtist.metadata_source, 'spotify-web-api');
  });

  it('extracts __NEXT_DATA__ safely and returns null on invalid html', () => {
    const html = makeEmbedHtml({ id: 'abc', title: 'Test Song' });
    const extracted = extractSpotifyNextData(html);
    assert.equal(extracted?.title, 'Test Song');
    assert.equal(extractSpotifyNextData('<html><body>No next data</body></html>'), null);
  });
});

describe('SpotifyMetadataService networking, caching, deduplication, and error states', () => {
  it('resolves embed + OG, handles cache TTL expiry, deduplicates concurrent calls, and handles spotify.link redirects', async () => {
    let now = 1_000_000;
    let embedCalls = 0;

    const mockFetch = async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://spotify.link/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=resolved' },
        });
      }
      if (url.includes('/embed/track/4cOdK2wGLETKBW3PvgPWqT')) {
        embedCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          makeEmbedHtml({
            id: '4cOdK2wGLETKBW3PvgPWqT',
            title: 'Never Gonna Give You Up',
            artists: [{ name: 'Rick Astley' }],
            duration: 213573,
            visualIdentity: { image: [{ url: 'https://i.scdn.co/image/rick640', maxWidth: 640 }] },
          }),
          { status: 200 }
        );
      }
      if (url === 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT') {
        return new Response(
          '<meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987" />',
          { status: 200 }
        );
      }
      return new Response('Not Found', { status: 404 });
    };

    const service = new SpotifyMetadataService({
      fetchFn: mockFetch,
      nowFn: () => now,
      cacheTtlMs: 5_000,
    });

    // Concurrent calls for the same track collapse into 1 embed request
    const [a, b] = await Promise.all([
      service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=1'),
      service.resolveSpotifyUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT'),
    ]);
    assert.equal(embedCalls, 1);
    assert.equal(a.title, 'Never Gonna Give You Up');
    assert.equal(b.album, 'Whenever You Need Somebody');

    // Short link resolves to canonical URL and hits cache!
    const fromShort = await service.resolveSpotifyUrl('https://spotify.link/testShortCode');
    assert.equal(fromShort.title, 'Never Gonna Give You Up');
    assert.equal(embedCalls, 1);

    // Advance clock past TTL -> refreshes
    now += 6_000;
    await service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(embedCalls, 2);
  });

  it('throws clear non-cached errors for 404, 429, network failures, timeouts, and cancellation', async () => {
    let mode: '404' | '429' | 'offline' | 'slow' = '404';
    const service = new SpotifyMetadataService({
      requestTimeoutMs: 60,
      fetchFn: async (_input, init) => {
        if (mode === '404') return new Response('Not Found', { status: 404 });
        if (mode === '429') return new Response('Too Many Requests', { status: 429 });
        if (mode === 'offline') throw new Error('ENOTFOUND open.spotify.com');
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('Aborted')), {
            once: true,
          });
        });
      },
    });

    await assert.rejects(
      () => service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
      /not found, private, or (?:removed|unavailable) \(HTTP 404\)/i
    );
    assert.equal(service.getCacheSize(), 0);

    mode = '429';
    await assert.rejects(
      () => service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
      /rate-limited.*429/i
    );

    mode = 'offline';
    await assert.rejects(
      () => service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
      /Unable to reach Spotify|ENOTFOUND/i
    );

    mode = 'slow';
    await assert.rejects(
      () => service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
      /timed out/i
    );

    const ac = new AbortController();
    ac.abort(new Error('Inspection cancelled.'));
    await assert.rejects(
      () => service.resolveSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', { signal: ac.signal }),
      /cancelled/i
    );
  });
});

describe('Regression: zero fabricated Spotify placeholders remain in UI or engines', () => {
  it('never generates placeholder titles, artists, favicons, or fixed counts', () => {
    const repoRoot = process.cwd();
    const filesToCheck = [
      'server/engineManager.ts',
      'server/spotify.ts',
      'src/components/NewDownloadModal.tsx',
      'src/components/MusicLibraryView.tsx',
      'src/components/QueueView.tsx',
      'src/utils/spotify.ts',
      'src-tauri/src/engines.rs',
    ];

    for (const rel of filesToCheck) {
      const content = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      assert.equal(content.includes('Spotify Music Track'), false, `${rel} contains "Spotify Music Track"`);
      assert.equal(content.includes('Spotify Artist'), false, `${rel} contains "Spotify Artist"`);
      assert.equal(content.includes('Spotify Track / Album'), false, `${rel} contains "Spotify Track / Album"`);
      assert.equal(content.includes('Spotify Album / Playlist'), false, `${rel} contains "Spotify Album / Playlist"`);
      assert.equal(content.includes('favicon.0f31d2ea.ico'), false, `${rel} contains generic Spotify favicon URL`);
    }
  });
});
