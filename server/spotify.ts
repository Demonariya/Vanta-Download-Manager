import { MediaMetadata } from '../src/types';
import {
  buildMediaMetadataFromSpotifyEntity,
  buildMediaMetadataFromSpotifyOembed,
  buildMediaMetadataFromSpotifyWebApi,
  extractSpotifyNextData,
  isSpotifyHost,
  parseSpotifyOpenGraphMeta,
  SpotifyOpenGraphMeta,
  tryParseSpotifyInput,
} from '../src/utils/spotify';
import { appendAppLog } from './cookies';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

interface CacheEntry {
  expiresAt: number;
  data: MediaMetadata;
}

export interface SpotifyResolverOptions {
  fetchFn?: FetchLike;
  nowFn?: () => number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  clientId?: string;
  clientSecret?: string;
  signal?: AbortSignal;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_WEB_API_PLAYLIST_TRACKS = 500;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CRAWLER_USER_AGENT = 'curl/8.5.0';

function mergeSignals(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Spotify metadata request timed out after ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason || new Error('Inspection cancelled.'));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
    didTimeout: () => timedOut,
  };
}

export class SpotifyMetadataService {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<MediaMetadata>>();
  private webApiToken: { token: string; expiresAt: number } | null = null;
  private readonly defaultFetch: FetchLike;
  private readonly nowFn: () => number;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options?: {
    fetchFn?: FetchLike;
    nowFn?: () => number;
    cacheTtlMs?: number;
    requestTimeoutMs?: number;
  }) {
    this.defaultFetch = options?.fetchFn || ((input, init) => fetch(input, init));
    this.nowFn = options?.nowFn || (() => Date.now());
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
    this.webApiToken = null;
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    fetchFn: FetchLike,
    externalSignal?: AbortSignal
  ): Promise<Response> {
    if (externalSignal?.aborted) {
      throw new Error('Inspection cancelled.');
    }
    const { signal, cleanup, didTimeout } = mergeSignals(externalSignal, this.requestTimeoutMs);
    try {
      return await fetchFn(url, { ...init, signal });
    } catch (err: any) {
      if (externalSignal?.aborted) {
        throw new Error('Inspection cancelled.');
      }
      if (didTimeout() || err?.name === 'AbortError' || String(err?.message || '').toLowerCase().includes('timed out')) {
        throw new Error(
          `Spotify metadata request timed out after ${Math.max(1, Math.round(this.requestTimeoutMs / 1000))}s.`
        );
      }
      throw new Error(`Unable to reach Spotify metadata service: ${err?.message || 'Network error'}`);
    } finally {
      cleanup();
    }
  }

  public async resolveShortLink(
    shortUrl: string,
    options?: SpotifyResolverOptions
  ): Promise<string> {
    const fetchFn = options?.fetchFn || this.defaultFetch;
    let current = shortUrl;

    for (let hop = 0; hop < 6; hop += 1) {
      const res = await this.fetchWithTimeout(
        current,
        {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        fetchFn,
        options?.signal
      );

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        const resolved = new URL(location, current);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
          throw new Error('Spotify short link redirected to an unsupported URL scheme.');
        }
        current = resolved.toString();
        const parsed = tryParseSpotifyInput(current);
        if (parsed && parsed.kind === 'resource') {
          return parsed.canonicalUrl;
        }
        continue;
      }

      if (res.url) {
        const parsedFinal = tryParseSpotifyInput(res.url);
        if (parsedFinal && parsedFinal.kind === 'resource') {
          return parsedFinal.canonicalUrl;
        }
      }
      break;
    }

    const parsedAfter = tryParseSpotifyInput(current);
    if (!parsedAfter || parsedAfter.kind !== 'resource') {
      if (parsedAfter && parsedAfter.kind === 'short_link') {
        throw new Error('Spotify short link could not be resolved to a track, album, playlist, or artist URL.');
      }
      if (parsedAfter && parsedAfter.kind === 'invalid') {
        throw new Error(parsedAfter.error);
      }
      try {
        const host = new URL(current).hostname;
        if (!isSpotifyHost(host)) {
          throw new Error('Spotify short link did not resolve to a valid open.spotify.com resource.');
        }
      } catch {
        throw new Error('Spotify short link resolved to a malformed URL.');
      }
    }
    return current;
  }

  private async getWebApiAccessToken(
    clientId: string,
    clientSecret: string,
    fetchFn: FetchLike,
    signal?: AbortSignal
  ): Promise<string | null> {
    const now = this.nowFn();
    if (this.webApiToken && this.webApiToken.expiresAt > now + 15_000) {
      return this.webApiToken.token;
    }

    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await this.fetchWithTimeout(
      'https://accounts.spotify.com/api/token',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      fetchFn,
      signal
    );

    if (!res.ok) {
      return null;
    }

    const json: any = await res.json().catch(() => null);
    if (!json?.access_token) return null;
    const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
    this.webApiToken = {
      token: String(json.access_token),
      expiresAt: now + expiresInMs,
    };
    return this.webApiToken.token;
  }

  private async fetchFromWebApi(
    parsed: { type: 'track' | 'album' | 'playlist' | 'artist'; id: string; canonicalUrl: string },
    options?: SpotifyResolverOptions
  ): Promise<MediaMetadata | null> {
    const clientId = (options?.clientId ?? process.env.SPOTIFY_CLIENT_ID ?? process.env.VANTA_SPOTIFY_CLIENT_ID ?? '').trim();
    const clientSecret = (options?.clientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? process.env.VANTA_SPOTIFY_CLIENT_SECRET ?? '').trim();
    if (!clientId || !clientSecret) return null;

    const fetchFn = options?.fetchFn || this.defaultFetch;
    const token = await this.getWebApiAccessToken(clientId, clientSecret, fetchFn, options?.signal);
    if (!token) return null;

    const endpoint =
      parsed.type === 'track'
        ? `https://api.spotify.com/v1/tracks/${parsed.id}`
        : parsed.type === 'album'
        ? `https://api.spotify.com/v1/albums/${parsed.id}`
        : parsed.type === 'playlist'
        ? `https://api.spotify.com/v1/playlists/${parsed.id}`
        : `https://api.spotify.com/v1/artists/${parsed.id}`;

    const res = await this.fetchWithTimeout(
      endpoint,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      fetchFn,
      options?.signal
    );

    if (res.status === 404) {
      throw new Error(`Spotify ${parsed.type} not found, private, or unavailable (HTTP 404).`);
    }
    if (res.status === 429) {
      throw new Error('Spotify API rate limit reached (HTTP 429). Please wait and try again.');
    }
    if (!res.ok) {
      return null;
    }

    const payload: any = await res.json();
    let extraTracks: any[] | undefined;

    if (parsed.type === 'artist') {
      const topRes = await this.fetchWithTimeout(
        `https://api.spotify.com/v1/artists/${parsed.id}/top-tracks?market=US`,
        { headers: { Authorization: `Bearer ${token}` } },
        fetchFn,
        options?.signal
      );
      if (topRes.ok) {
        const topJson: any = await topRes.json().catch(() => null);
        if (Array.isArray(topJson?.tracks)) extraTracks = topJson.tracks;
      }
    } else if (parsed.type === 'album' || parsed.type === 'playlist') {
      const collected: any[] = Array.isArray(payload?.tracks?.items) ? [...payload.tracks.items] : [];
      let nextUrl: string | null = payload?.tracks?.next || null;
      while (nextUrl && collected.length < MAX_WEB_API_PLAYLIST_TRACKS) {
        if (options?.signal?.aborted) throw new Error('Inspection cancelled.');
        const pageRes = await this.fetchWithTimeout(
          nextUrl,
          { headers: { Authorization: `Bearer ${token}` } },
          fetchFn,
          options?.signal
        );
        if (!pageRes.ok) break;
        const pageJson: any = await pageRes.json().catch(() => null);
        if (!Array.isArray(pageJson?.items) || pageJson.items.length === 0) break;
        collected.push(...pageJson.items);
        nextUrl = pageJson.next || null;
      }
      extraTracks = collected.slice(0, MAX_WEB_API_PLAYLIST_TRACKS);
    }

    return buildMediaMetadataFromSpotifyWebApi({
      canonicalUrl: parsed.canonicalUrl,
      id: parsed.id,
      contentType: parsed.type,
      payload,
      extraTracks,
    });
  }

  private async fetchOpenGraphMeta(
    canonicalUrl: string,
    fetchFn: FetchLike,
    signal?: AbortSignal
  ): Promise<{ meta: SpotifyOpenGraphMeta; notFound?: boolean; rateLimited?: boolean }> {
    try {
      const res = await this.fetchWithTimeout(
        canonicalUrl,
        {
          headers: {
            'User-Agent': CRAWLER_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        fetchFn,
        signal
      );

      if (res.status === 404) return { meta: {}, notFound: true };
      if (res.status === 429) return { meta: {}, rateLimited: true };
      if (!res.ok) return { meta: {} };

      const html = await res.text();
      return { meta: parseSpotifyOpenGraphMeta(html) };
    } catch (err: any) {
      if (signal?.aborted || String(err?.message || '').toLowerCase().includes('cancelled')) {
        throw err;
      }
      return { meta: {} };
    }
  }

  private async fetchFromPublicEndpoints(
    parsed: { type: 'track' | 'album' | 'playlist' | 'artist'; id: string; canonicalUrl: string },
    options?: SpotifyResolverOptions
  ): Promise<MediaMetadata> {
    const fetchFn = options?.fetchFn || this.defaultFetch;
    const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;

    // Query embed page and lightweight crawler OpenGraph meta in parallel so track album/track_number
    // and playlist total track count are enriched with zero extra latency.
    const [embedRes, ogResult] = await Promise.all([
      this.fetchWithTimeout(
        embedUrl,
        {
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        fetchFn,
        options?.signal
      ),
      this.fetchOpenGraphMeta(parsed.canonicalUrl, fetchFn, options?.signal),
    ]);

    if (embedRes.status === 404 || ogResult.notFound) {
      throw new Error(
        `Spotify ${parsed.type} not found, private, or unavailable (HTTP 404).`
      );
    }
    if (embedRes.status === 429 || ogResult.rateLimited) {
      throw new Error(
        'Spotify metadata endpoint is temporarily rate-limited (HTTP 429). Please retry in a moment.'
      );
    }

    if (embedRes.ok) {
      const embedHtml = await embedRes.text();
      const entity = extractSpotifyNextData(embedHtml);
      if (entity) {
        return buildMediaMetadataFromSpotifyEntity({
          canonicalUrl: parsed.canonicalUrl,
          id: parsed.id,
          contentType: parsed.type,
          entity,
          ogMeta: ogResult.meta,
          source: 'spotify-embed',
        });
      }
    }

    // Fallback to Spotify's official public oEmbed endpoint (partial real title & artwork only; never fabricated fields)
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.canonicalUrl)}`;
    const oembedRes = await this.fetchWithTimeout(
      oembedUrl,
      {
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'application/json',
        },
      },
      fetchFn,
      options?.signal
    );

    if (oembedRes.status === 404) {
      throw new Error(
        `Spotify ${parsed.type} not found, private, or unavailable (HTTP 404).`
      );
    }
    if (oembedRes.status === 429) {
      throw new Error(
        'Spotify metadata endpoint is temporarily rate-limited (HTTP 429). Please retry in a moment.'
      );
    }
    if (!oembedRes.ok) {
      throw new Error(
        `Unable to retrieve Spotify metadata (embed HTTP ${embedRes.status}, oEmbed HTTP ${oembedRes.status}).`
      );
    }

    const oembedJson: any = await oembedRes.json().catch(() => null);
    return buildMediaMetadataFromSpotifyOembed({
      canonicalUrl: parsed.canonicalUrl,
      id: parsed.id,
      contentType: parsed.type,
      oembed: oembedJson,
    });
  }

  public async resolveSpotifyUrl(
    rawUrl: string,
    options?: SpotifyResolverOptions
  ): Promise<MediaMetadata> {
    let parsed = tryParseSpotifyInput(rawUrl);
    if (!parsed) {
      throw new Error('URL is not a recognized Spotify resource URL or URI.');
    }
    if (parsed.kind === 'invalid') {
      throw new Error(parsed.error);
    }

    if (parsed.kind === 'short_link') {
      const resolvedUrl = await this.resolveShortLink(parsed.url, options);
      parsed = tryParseSpotifyInput(resolvedUrl);
      if (!parsed || parsed.kind !== 'resource') {
        throw new Error(
          parsed?.kind === 'invalid'
            ? parsed.error
            : 'Resolved Spotify short link does not point to a supported track, album, playlist, or artist.'
        );
      }
    }

    const cacheKey = parsed.uri;
    const now = this.nowFn();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    // Deduplicate concurrent identical lookups unless a caller-specific abort signal cancels independently
    const existingInflight = this.inflight.get(cacheKey);
    if (existingInflight && !options?.signal) {
      return existingInflight;
    }

    const resource = parsed;
    let activePromise: Promise<MediaMetadata> | null = null;
    const runPromise = (async (): Promise<MediaMetadata> => {
      try {
        const apiResult = await this.fetchFromWebApi(resource, options).catch((err) => {
          const msg = String(err?.message || '').toLowerCase();
          if (msg.includes('http 404') || msg.includes('rate limit') || msg.includes('cancelled')) {
            throw err;
          }
          return null;
        });

        const metadata =
          apiResult || (await this.fetchFromPublicEndpoints(resource, options));

        this.cache.set(cacheKey, {
          expiresAt: this.nowFn() + this.cacheTtlMs,
          data: metadata,
        });

        try {
          appendAppLog(
            'INFO',
            'spotify',
            `Resolved ${resource.uri} -> "${metadata.title}" (source=${metadata.metadata_source || 'unknown'})`
          );
        } catch {
          // Safe in unit tests without full server initialization
        }

        return metadata;
      } finally {
        if (activePromise && this.inflight.get(cacheKey) === activePromise) {
          this.inflight.delete(cacheKey);
        }
      }
    })();
    activePromise = runPromise;

    if (!options?.signal) {
      this.inflight.set(cacheKey, runPromise);
    }

    return runPromise;
  }
}

export const spotifyMetadataService = new SpotifyMetadataService();
