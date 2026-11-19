import {
  MediaMetadata,
  SpotifyContentType,
  SpotifyTrackItem,
} from '../types';

function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export type ParsedSpotifyInput =
  | {
      kind: 'resource';
      type: SpotifyContentType;
      id: string;
      uri: string;
      canonicalUrl: string;
    }
  | {
      kind: 'short_link';
      url: string;
    }
  | {
      kind: 'invalid';
      error: string;
    };

export interface SpotifyOpenGraphMeta {
  title?: string;
  description?: string;
  image?: string;
  albumFromDescription?: string;
  trackNumber?: number;
  releaseDate?: string;
  songCount?: number;
  owner?: string;
}

const VALID_TYPES = new Set<SpotifyContentType>(['track', 'album', 'playlist', 'artist']);
const SPOTIFY_RESOURCE_HOSTS = new Set([
  'open.spotify.com',
  'play.spotify.com',
  'www.spotify.com',
  'spotify.com',
]);
const SPOTIFY_SHORT_HOSTS = new Set(['spotify.link', 'spoti.fi']);
const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{10,36}$/;

export function isSpotifyHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    SPOTIFY_RESOURCE_HOSTS.has(lower) ||
    SPOTIFY_SHORT_HOSTS.has(lower) ||
    lower.endsWith('.spotify.com')
  );
}

/**
 * Parses a URL or Spotify URI. Returns null if the input is clearly not a Spotify URL/URI.
 * Returns { kind: 'invalid', error } when it is a Spotify URL/URI that is malformed or unsupported.
 */
export function tryParseSpotifyInput(raw: string): ParsedSpotifyInput | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    if (trimmed.toLowerCase().includes('spotify')) {
      return { kind: 'invalid', error: 'Malformed Spotify URL: contains whitespace or control characters.' };
    }
    return null;
  }

  // spotify:<type>:<id> URI scheme
  if (trimmed.toLowerCase().startsWith('spotify:')) {
    const parts = trimmed.split(':');
    if (parts.length < 3) {
      return {
        kind: 'invalid',
        error: 'Malformed Spotify URI. Expected format spotify:track:<id>, spotify:album:<id>, spotify:playlist:<id>, or spotify:artist:<id>.',
      };
    }
    const rawType = parts[1].toLowerCase() as SpotifyContentType;
    const id = parts[2].trim();
    if (!VALID_TYPES.has(rawType)) {
      return {
        kind: 'invalid',
        error: `Unsupported Spotify URI type "${parts[1]}". Supported types: track, album, playlist, artist.`,
      };
    }
    if (!SPOTIFY_ID_REGEX.test(id)) {
      return {
        kind: 'invalid',
        error: `Malformed Spotify ${rawType} ID "${id}".`,
      };
    }
    return {
      kind: 'resource',
      type: rawType,
      id,
      uri: `spotify:${rawType}:${id}`,
      canonicalUrl: `https://open.spotify.com/${rawType}/${id}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!isSpotifyHost(host)) {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (SPOTIFY_SHORT_HOSTS.has(host)) {
    if (segments.length === 0) {
      return {
        kind: 'invalid',
        error: 'Malformed Spotify short link: missing link code.',
      };
    }
    return {
      kind: 'short_link',
      url: parsed.toString(),
    };
  }

  // Normalize localization prefixes (/intl-de/...) and /embed/...
  let idx = 0;
  if (segments[idx] && /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[idx])) {
    idx += 1;
  }
  if (segments[idx] && segments[idx].toLowerCase() === 'embed') {
    idx += 1;
  }

  const rawType = (segments[idx] || '').toLowerCase();
  const rawId = segments[idx + 1] || '';

  if (!rawType) {
    return {
      kind: 'invalid',
      error: 'Incomplete Spotify URL: expected /track/<id>, /album/<id>, /playlist/<id>, or /artist/<id>.',
    };
  }

  if (!VALID_TYPES.has(rawType as SpotifyContentType)) {
    return {
      kind: 'invalid',
      error: `Unsupported Spotify URL type "${rawType}". Supported types: track, album, playlist, artist.`,
    };
  }

  const contentType = rawType as SpotifyContentType;
  if (!rawId) {
    return {
      kind: 'invalid',
      error: `Malformed Spotify URL: missing ${contentType} ID.`,
    };
  }

  if (!SPOTIFY_ID_REGEX.test(rawId)) {
    return {
      kind: 'invalid',
      error: `Malformed Spotify ${contentType} ID "${rawId}".`,
    };
  }

  return {
    kind: 'resource',
    type: contentType,
    id: rawId,
    uri: `spotify:${contentType}:${rawId}`,
    canonicalUrl: `https://open.spotify.com/${contentType}/${rawId}`,
  };
}

export function isSpotifyUrl(raw: string): boolean {
  return tryParseSpotifyInput(raw) !== null;
}

export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });
}

export function splitSpotifyArtists(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .replace(/\u00a0/g, ' ')
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractSpotifyIdFromUri(uri?: string | null): string {
  if (!uri) return '';
  const parts = uri.split(':');
  return parts[parts.length - 1] || '';
}

export function spotifyUriToUrl(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const parts = uri.split(':');
  if (parts.length >= 3 && parts[0] === 'spotify' && parts[1] && parts[2]) {
    return `https://open.spotify.com/${parts[1]}/${parts[2]}`;
  }
  return undefined;
}

export function isGenericSpotifyIcon(url?: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('favicon') ||
    lower.endsWith('.ico') ||
    lower.includes('spotifycdn.com/cdn/images/')
  );
}

export function pickLargestArtworkUrl(entity: any): string | undefined {
  const candidates: Array<{ url?: string; width?: number; maxWidth?: number; height?: number }> = [];

  if (Array.isArray(entity?.visualIdentity?.image)) {
    candidates.push(...entity.visualIdentity.image);
  }
  if (Array.isArray(entity?.coverArt?.sources)) {
    candidates.push(...entity.coverArt.sources);
  }
  if (Array.isArray(entity?.images)) {
    candidates.push(...entity.images);
  }

  let bestUrl: string | undefined;
  let bestScore = -1;
  for (const item of candidates) {
    if (!item?.url || isGenericSpotifyIcon(item.url)) continue;
    const score = item.maxWidth || item.width || item.height || 0;
    if (!bestUrl || score > bestScore) {
      bestUrl = item.url;
      bestScore = score;
    }
  }
  return bestUrl;
}

export function extractSpotifyNextData(html: string): any | null {
  const match = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed?.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

export function parseSpotifyOpenGraphMeta(html: string): SpotifyOpenGraphMeta {
  const meta: SpotifyOpenGraphMeta = {};
  const tagRegex = /<meta\b([^>]+)>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const attrs = match[1];
    const propMatch = attrs.match(/(?:property|name)=["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content=["']([^"']*)["']/i);
    if (!propMatch || !contentMatch) continue;

    const key = propMatch[1].toLowerCase();
    const val = decodeHtmlEntities(contentMatch[1]).trim();
    if (!val) continue;

    if (key === 'og:title' && !meta.title) {
      meta.title = val;
    } else if (key === 'og:description' && !meta.description) {
      meta.description = val;
    } else if (key === 'og:image' && !isGenericSpotifyIcon(val) && !meta.image) {
      meta.image = val;
    } else if (key === 'music:album:track') {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) meta.trackNumber = n;
    } else if (key === 'music:release_date' && !meta.releaseDate) {
      meta.releaseDate = val;
    } else if (key === 'music:song_count') {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) meta.songCount = n;
    }
  }

  if (meta.description) {
    const parts = meta.description.split('·').map((p) => p.trim()).filter(Boolean);
    // Track og:description pattern: "Artist · Album · Song · Year"
    if (parts.length >= 4 && /^song$/i.test(parts[2])) {
      meta.albumFromDescription = parts[1];
      if (!meta.releaseDate && /^\d{4}$/.test(parts[3])) {
        meta.releaseDate = parts[3];
      }
    }
    // Album og:description pattern: "Artist · album · 2015 · 15 songs"
    const countPart = parts.find((p) => /^\d+\s+songs?$/i.test(p) || /^\d+\s+items?$/i.test(p));
    if (countPart && !meta.songCount) {
      const n = Number.parseInt(countPart, 10);
      if (Number.isFinite(n) && n > 0) meta.songCount = n;
    }
    // Playlist og:description pattern: "Playlist · Owner · N items" or "Description"
    if (parts.length >= 2 && /^playlist$/i.test(parts[0]) && !meta.owner) {
      meta.owner = parts[1];
    }
  }

  return meta;
}

export function buildMediaMetadataFromSpotifyEntity(params: {
  canonicalUrl: string;
  id: string;
  contentType: SpotifyContentType;
  entity: any;
  ogMeta?: SpotifyOpenGraphMeta;
  source?: string;
}): MediaMetadata {
  const { canonicalUrl, id, contentType, entity, ogMeta, source = 'spotify-embed' } = params;

  const rawTitle = (entity?.title || entity?.name || '').trim();
  if (!rawTitle) {
    throw new Error('Spotify metadata payload omitted resource title.');
  }

  const artwork = pickLargestArtworkUrl(entity) || ogMeta?.image;
  const releaseDateRaw =
    entity?.releaseDate?.isoString?.slice(0, 10) || ogMeta?.releaseDate || undefined;
  const explicit = typeof entity?.isExplicit === 'boolean' ? entity.isExplicit : undefined;

  if (contentType === 'track') {
    const artistsFromObj: string[] = Array.isArray(entity?.artists)
      ? entity.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
      : [];
    const artists =
      artistsFromObj.length > 0
        ? artistsFromObj
        : splitSpotifyArtists(entity?.subtitle);

    const durationSec =
      typeof entity?.duration === 'number' && entity.duration > 0
        ? Math.round(entity.duration / 1000)
        : undefined;

    const album = ogMeta?.albumFromDescription || undefined;

    return {
      url: canonicalUrl,
      id: entity?.id || id,
      title: rawTitle,
      uploader: artists.length > 0 ? artists.join(', ') : undefined,
      duration: durationSec,
      duration_string: durationSec ? formatDuration(durationSec) : undefined,
      thumbnail: artwork,
      description: [
        artists.length > 0 ? artists.join(', ') : undefined,
        album,
        releaseDateRaw,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
      formats: [],
      is_playlist: false,
      playlist_count: undefined,
      extractor: 'spotdl',
      content_type: 'track',
      artists: artists.length > 0 ? artists : undefined,
      album,
      album_artwork: artwork,
      track_number: ogMeta?.trackNumber,
      release_date: releaseDateRaw,
      explicit,
      metadata_source: source,
    };
  }

  const rawTrackList: any[] = Array.isArray(entity?.trackList) ? entity.trackList : [];
  const tracks: SpotifyTrackItem[] = rawTrackList
    .filter((t) => Boolean(t?.title))
    .map((t, idx) => {
      const durSec =
        typeof t.duration === 'number' && t.duration > 0
          ? Math.round(t.duration / 1000)
          : undefined;
      const itemUri: string | undefined = t.uri;
      const itemId = extractSpotifyIdFromUri(itemUri) || t.uid || String(idx + 1);
      const artists = splitSpotifyArtists(t.subtitle);
      return {
        id: itemId,
        title: String(t.title).trim(),
        artists,
        album: contentType === 'album' ? rawTitle : undefined,
        duration: durSec,
        duration_string: durSec ? formatDuration(durSec) : undefined,
        track_number: idx + 1,
        artwork,
        explicit: typeof t.isExplicit === 'boolean' ? t.isExplicit : undefined,
        url: spotifyUriToUrl(itemUri),
      };
    });

  const sumDuration = tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
  const totalDuration = sumDuration > 0 ? sumDuration : undefined;

  if (contentType === 'album') {
    const artistsFromObj: string[] = Array.isArray(entity?.artists)
      ? entity.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
      : [];
    const artists =
      artistsFromObj.length > 0 ? artistsFromObj : splitSpotifyArtists(entity?.subtitle);
    const reportedCount = ogMeta?.songCount || 0;
    const totalTracks = Math.max(tracks.length, reportedCount) || undefined;
    const partialTracks = Boolean(totalTracks && tracks.length > 0 && tracks.length < totalTracks);

    return {
      url: canonicalUrl,
      id: entity?.id || id,
      title: rawTitle,
      uploader: artists.length > 0 ? artists.join(', ') : undefined,
      duration: totalDuration,
      duration_string: totalDuration ? formatDuration(totalDuration) : undefined,
      thumbnail: artwork,
      description: [artists.join(', '), totalTracks ? `${totalTracks} tracks` : undefined, releaseDateRaw]
        .filter(Boolean)
        .join(' · ') || undefined,
      formats: [],
      is_playlist: true,
      playlist_count: totalTracks,
      extractor: 'spotdl',
      content_type: 'album',
      artists: artists.length > 0 ? artists : undefined,
      album: rawTitle,
      album_artwork: artwork,
      release_date: releaseDateRaw,
      explicit,
      tracks,
      total_tracks: totalTracks,
      partial_tracks: partialTracks || undefined,
      metadata_source: source,
    };
  }

  if (contentType === 'playlist') {
    const owner =
      (entity?.subtitle || '').trim() ||
      (Array.isArray(entity?.authors) && entity.authors[0]?.name ? String(entity.authors[0].name).trim() : '') ||
      ogMeta?.owner ||
      undefined;
    const reportedCount = ogMeta?.songCount || 0;
    const totalTracks = Math.max(tracks.length, reportedCount) || undefined;
    const partialTracks = Boolean(totalTracks && tracks.length > 0 && tracks.length < totalTracks);

    return {
      url: canonicalUrl,
      id: entity?.id || id,
      title: rawTitle,
      uploader: owner,
      duration: totalDuration,
      duration_string: totalDuration ? formatDuration(totalDuration) : undefined,
      thumbnail: artwork,
      description: [owner ? `Curated by ${owner}` : undefined, totalTracks ? `${totalTracks} tracks` : undefined]
        .filter(Boolean)
        .join(' · ') || undefined,
      formats: [],
      is_playlist: true,
      playlist_count: totalTracks,
      extractor: 'spotdl',
      content_type: 'playlist',
      album_artwork: artwork,
      owner,
      tracks,
      total_tracks: totalTracks,
      partial_tracks: partialTracks || undefined,
      metadata_source: source,
    };
  }

  // artist
  return {
    url: canonicalUrl,
    id: entity?.id || id,
    title: rawTitle,
    uploader: rawTitle,
    duration: totalDuration,
    duration_string: totalDuration ? formatDuration(totalDuration) : undefined,
    thumbnail: artwork,
    description: ogMeta?.description || (tracks.length > 0 ? `${tracks.length} top tracks` : undefined),
    formats: [],
    is_playlist: tracks.length > 0,
    playlist_count: tracks.length > 0 ? tracks.length : undefined,
    extractor: 'spotdl',
    content_type: 'artist',
    artists: [rawTitle],
    album_artwork: artwork,
    tracks,
    total_tracks: tracks.length > 0 ? tracks.length : undefined,
    metadata_source: source,
  };
}

export function buildMediaMetadataFromSpotifyOembed(params: {
  canonicalUrl: string;
  id: string;
  contentType: SpotifyContentType;
  oembed: any;
}): MediaMetadata {
  const { canonicalUrl, id, contentType, oembed } = params;
  const title = (oembed?.title || '').trim();
  if (!title) {
    throw new Error('Spotify oEmbed response did not include a title.');
  }
  const thumbnail =
    typeof oembed?.thumbnail_url === 'string' && !isGenericSpotifyIcon(oembed.thumbnail_url)
      ? oembed.thumbnail_url
      : undefined;

  return {
    url: canonicalUrl,
    id,
    title,
    uploader: undefined,
    duration: undefined,
    duration_string: undefined,
    thumbnail,
    description: 'Partial Spotify metadata retrieved via oEmbed fallback.',
    formats: [],
    is_playlist: contentType === 'album' || contentType === 'playlist',
    playlist_count: undefined,
    extractor: 'spotdl',
    content_type: contentType,
    album_artwork: thumbnail,
    partial_tracks: true,
    metadata_source: 'spotify-oembed',
  };
}

export function buildMediaMetadataFromSpotifyWebApi(params: {
  canonicalUrl: string;
  id: string;
  contentType: SpotifyContentType;
  payload: any;
  extraTracks?: any[];
}): MediaMetadata {
  const { canonicalUrl, id, contentType, payload, extraTracks } = params;
  const pickImg = (images: any[] | undefined): string | undefined => {
    if (!Array.isArray(images)) return undefined;
    const sorted = [...images]
      .filter((i) => i?.url && !isGenericSpotifyIcon(i.url))
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url;
  };

  if (contentType === 'track') {
    const title = (payload?.name || '').trim();
    if (!title) throw new Error('Spotify Web API track payload missing name.');
    const artists = Array.isArray(payload?.artists)
      ? payload.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
      : [];
    const duration =
      typeof payload?.duration_ms === 'number' && payload.duration_ms > 0
        ? Math.round(payload.duration_ms / 1000)
        : undefined;
    const artwork = pickImg(payload?.album?.images);
    const album = payload?.album?.name || undefined;
    const releaseDate = payload?.album?.release_date || undefined;

    return {
      url: canonicalUrl,
      id: payload?.id || id,
      title,
      uploader: artists.length > 0 ? artists.join(', ') : undefined,
      duration,
      duration_string: duration ? formatDuration(duration) : undefined,
      thumbnail: artwork,
      description: [artists.join(', '), album, releaseDate].filter(Boolean).join(' · ') || undefined,
      formats: [],
      is_playlist: false,
      extractor: 'spotdl',
      content_type: 'track',
      artists: artists.length > 0 ? artists : undefined,
      album,
      album_artwork: artwork,
      track_number: typeof payload?.track_number === 'number' ? payload.track_number : undefined,
      release_date: releaseDate,
      explicit: typeof payload?.explicit === 'boolean' ? payload.explicit : undefined,
      metadata_source: 'spotify-web-api',
    };
  }

  if (contentType === 'album') {
    const title = (payload?.name || '').trim();
    if (!title) throw new Error('Spotify Web API album payload missing name.');
    const artists = Array.isArray(payload?.artists)
      ? payload.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
      : [];
    const artwork = pickImg(payload?.images);
    const rawItems = extraTracks || payload?.tracks?.items || [];
    const tracks: SpotifyTrackItem[] = rawItems
      .filter((t: any) => Boolean(t?.name))
      .map((t: any, idx: number) => {
        const dur =
          typeof t.duration_ms === 'number' && t.duration_ms > 0
            ? Math.round(t.duration_ms / 1000)
            : undefined;
        return {
          id: t.id || String(idx + 1),
          title: String(t.name).trim(),
          artists: Array.isArray(t.artists)
            ? t.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
            : artists,
          album: title,
          duration: dur,
          duration_string: dur ? formatDuration(dur) : undefined,
          track_number: t.track_number || idx + 1,
          artwork,
          explicit: typeof t.explicit === 'boolean' ? t.explicit : undefined,
          url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
        };
      });
    const totalTracks = payload?.total_tracks || tracks.length || undefined;
    const sumDuration = tracks.reduce((acc, t) => acc + (t.duration || 0), 0) || undefined;

    return {
      url: canonicalUrl,
      id: payload?.id || id,
      title,
      uploader: artists.length > 0 ? artists.join(', ') : undefined,
      duration: sumDuration,
      duration_string: sumDuration ? formatDuration(sumDuration) : undefined,
      thumbnail: artwork,
      description: [artists.join(', '), totalTracks ? `${totalTracks} tracks` : undefined, payload?.release_date]
        .filter(Boolean)
        .join(' · ') || undefined,
      formats: [],
      is_playlist: true,
      playlist_count: totalTracks,
      extractor: 'spotdl',
      content_type: 'album',
      artists: artists.length > 0 ? artists : undefined,
      album: title,
      album_artwork: artwork,
      release_date: payload?.release_date || undefined,
      tracks,
      total_tracks: totalTracks,
      partial_tracks: Boolean(totalTracks && tracks.length < totalTracks) || undefined,
      metadata_source: 'spotify-web-api',
    };
  }

  if (contentType === 'playlist') {
    const title = (payload?.name || '').trim();
    if (!title) throw new Error('Spotify Web API playlist payload missing name.');
    const owner = payload?.owner?.display_name || payload?.owner?.id || undefined;
    const artwork = pickImg(payload?.images);
    const rawItems = extraTracks || payload?.tracks?.items || [];
    const tracks: SpotifyTrackItem[] = rawItems
      .map((entry: any) => entry?.track || entry)
      .filter((t: any) => Boolean(t?.name))
      .map((t: any, idx: number) => {
        const dur =
          typeof t.duration_ms === 'number' && t.duration_ms > 0
            ? Math.round(t.duration_ms / 1000)
            : undefined;
        return {
          id: t.id || String(idx + 1),
          title: String(t.name).trim(),
          artists: Array.isArray(t.artists)
            ? t.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
            : [],
          album: t.album?.name || undefined,
          duration: dur,
          duration_string: dur ? formatDuration(dur) : undefined,
          track_number: idx + 1,
          artwork: pickImg(t.album?.images) || artwork,
          explicit: typeof t.explicit === 'boolean' ? t.explicit : undefined,
          url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
        };
      });
    const totalTracks = payload?.tracks?.total || tracks.length || undefined;
    const sumDuration = tracks.reduce((acc, t) => acc + (t.duration || 0), 0) || undefined;

    return {
      url: canonicalUrl,
      id: payload?.id || id,
      title,
      uploader: owner,
      duration: sumDuration,
      duration_string: sumDuration ? formatDuration(sumDuration) : undefined,
      thumbnail: artwork,
      description: [owner ? `Curated by ${owner}` : undefined, totalTracks ? `${totalTracks} tracks` : undefined]
        .filter(Boolean)
        .join(' · ') || undefined,
      formats: [],
      is_playlist: true,
      playlist_count: totalTracks,
      extractor: 'spotdl',
      content_type: 'playlist',
      album_artwork: artwork,
      owner,
      tracks,
      total_tracks: totalTracks,
      partial_tracks: Boolean(totalTracks && tracks.length < totalTracks) || undefined,
      metadata_source: 'spotify-web-api',
    };
  }

  // artist
  const title = (payload?.name || '').trim();
  if (!title) throw new Error('Spotify Web API artist payload missing name.');
  const artwork = pickImg(payload?.images);
  const tracks: SpotifyTrackItem[] = (extraTracks || [])
    .filter((t: any) => Boolean(t?.name))
    .map((t: any, idx: number) => {
      const dur =
        typeof t.duration_ms === 'number' && t.duration_ms > 0
          ? Math.round(t.duration_ms / 1000)
          : undefined;
      return {
        id: t.id || String(idx + 1),
        title: String(t.name).trim(),
        artists: Array.isArray(t.artists)
          ? t.artists.map((a: any) => (a?.name || '').trim()).filter(Boolean)
          : [title],
        album: t.album?.name || undefined,
        duration: dur,
        duration_string: dur ? formatDuration(dur) : undefined,
        track_number: idx + 1,
        artwork: pickImg(t.album?.images) || artwork,
        explicit: typeof t.explicit === 'boolean' ? t.explicit : undefined,
        url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
      };
    });
  const sumDuration = tracks.reduce((acc, t) => acc + (t.duration || 0), 0) || undefined;

  return {
    url: canonicalUrl,
    id: payload?.id || id,
    title,
    uploader: title,
    duration: sumDuration,
    duration_string: sumDuration ? formatDuration(sumDuration) : undefined,
    thumbnail: artwork,
    description: tracks.length > 0 ? `${tracks.length} top tracks` : undefined,
    formats: [],
    is_playlist: tracks.length > 0,
    playlist_count: tracks.length > 0 ? tracks.length : undefined,
    extractor: 'spotdl',
    content_type: 'artist',
    artists: [title],
    album_artwork: artwork,
    tracks,
    total_tracks: tracks.length > 0 ? tracks.length : undefined,
    metadata_source: 'spotify-web-api',
  };
}
