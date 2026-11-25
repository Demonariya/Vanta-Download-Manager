export interface LyricsRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  source?: string;
}

type LiriQoTrack = {
  provider?: string;
  upstreamProvider?: string;
  plain?: string | null;
  lrc?: string | null;
  timed?: Array<{ text?: string; start?: number; end?: number }>;
  instrumental?: boolean;
};

const API_BASE = 'https://lrclib.net/api';
const LIRIQO_BASE = 'https://api.liriqo-alfarrizi.my.id/v1';
const CLIENT_HEADER = 'VANTA Download Manager (https://github.com/Demonariya/Vanta-Download-Manager)';

async function requestJson<T>(url: URL, timeout = 18000): Promise<T> {
  const response = await fetch(url, {
    headers: { 'X-User-Agent': CLIENT_HEADER },
    signal: AbortSignal.timeout(timeout),
  });
  if (response.status === 404) throw new Error('NOT_FOUND');
  if (response.status === 429) throw new Error('Lyrics service rate limit reached. Try again shortly.');
  if (!response.ok) throw new Error(`Lyrics service returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
}

function scoreRecord(record: LyricsRecord, title: string, artist: string, duration?: number): number {
  const wantedTitle = normalize(title);
  const wantedArtist = normalize(artist);
  const foundTitle = normalize(record.trackName || '');
  const foundArtist = normalize(record.artistName || '');
  let score = 0;
  if (foundTitle === wantedTitle) score += 100;
  else if (foundTitle && (foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle))) score += 45;
  if (foundArtist === wantedArtist) score += 80;
  else if (foundArtist && (foundArtist.includes(wantedArtist) || wantedArtist.includes(foundArtist))) score += 35;
  if (duration && record.duration) {
    const difference = Math.abs(duration - record.duration);
    score += difference <= 2 ? 35 : difference <= 5 ? 15 : difference <= 12 ? 4 : -35;
  }
  if (record.syncedLyrics) score += 18;
  if (record.instrumental) score -= 1000;
  return score;
}

function timedLinesToLrc(lines: LiriQoTrack['timed']): string | null {
  if (!lines?.length) return null;
  const output = lines
    .filter((line) => typeof line.start === 'number' && Boolean(line.text?.trim()))
    .map((line) => {
      const time = Math.max(0, Math.floor(line.start!));
      const minutes = Math.floor(time / 60000);
      const seconds = ((time % 60000) / 1000).toFixed(2).padStart(5, '0');
      return `[${String(minutes).padStart(2, '0')}:${seconds}]${line.text!.trim()}`;
    });
  return output.length ? output.join('\\n') : null;
}

function fromLiriQo(data: any, input: { title: string; artist: string; duration?: number }): LyricsRecord[] {
  const tracks: LiriQoTrack[] = [
    ...(data?.primary ? [data.primary] : []),
    ...(Array.isArray(data?.tracks) ? data.tracks : []),
  ];
  const unique = new Set<string>();
  return tracks.flatMap((track) => {
    const syncedLyrics = track.lrc?.trim() || timedLinesToLrc(track.timed);
    const plainLyrics = track.plain?.trim() || null;
    if (track.instrumental || (!syncedLyrics && !plainLyrics)) return [];
    const key = `${syncedLyrics || plainLyrics}`;
    if (unique.has(key)) return [];
    unique.add(key);
    return [{
      id: 0,
      trackName: input.title,
      artistName: input.artist,
      duration: input.duration,
      instrumental: false,
      plainLyrics,
      syncedLyrics,
      source: track.upstreamProvider || track.provider || 'LiriQo multi-provider',
    }];
  });
}

async function searchLiriQo(input: { title: string; artist: string; album?: string; duration?: number }): Promise<LyricsRecord[]> {
  const url = new URL(`${LIRIQO_BASE}/lyrics`);
  url.searchParams.set('title', input.title);
  url.searchParams.set('artist', input.artist);
  if (input.album) url.searchParams.set('album', input.album);
  if (input.duration && input.duration > 0) url.searchParams.set('duration', String(Math.round(input.duration)));
  url.searchParams.set('full', '1');
  const data = await requestJson<any>(url, 30000);
  if (data?.error) throw new Error(String(data.error));
  return fromLiriQo(data, input);
}

async function searchLrclib(input: { title: string; artist: string; album?: string; duration?: number }): Promise<LyricsRecord[]> {
  const exactUrl = new URL(`${API_BASE}/get`);
  exactUrl.searchParams.set('track_name', input.title);
  exactUrl.searchParams.set('artist_name', input.artist);
  if (input.album) exactUrl.searchParams.set('album_name', input.album);
  if (input.duration && input.duration > 0) exactUrl.searchParams.set('duration', String(Math.round(input.duration)));
  try {
    const exact = await requestJson<LyricsRecord>(exactUrl);
    if (!exact.instrumental && (exact.syncedLyrics || exact.plainLyrics)) return [{ ...exact, source: 'LRCLIB' }];
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'NOT_FOUND') throw error;
  }

  const searchUrl = new URL(`${API_BASE}/search`);
  searchUrl.searchParams.set('track_name', input.title);
  searchUrl.searchParams.set('artist_name', input.artist);
  if (input.album) searchUrl.searchParams.set('album_name', input.album);
  const results = await requestJson<LyricsRecord[]>(searchUrl);
  return results
    .filter((record) => !record.instrumental && (record.syncedLyrics || record.plainLyrics))
    .map((record) => ({ ...record, source: 'LRCLIB' }));
}

async function searchLyricsOvh(input: { title: string; artist: string }): Promise<LyricsRecord[]> {
  const url = new URL(`https://api.lyrics.ovh/v1/${encodeURIComponent(input.artist)}/${encodeURIComponent(input.title)}`);
  const data = await requestJson<{ lyrics?: string }>(url, 12000);
  const plainLyrics = data.lyrics?.trim();
  if (!plainLyrics) return [];
  return [{
    id: 0,
    trackName: input.title,
    artistName: input.artist,
    instrumental: false,
    plainLyrics,
    source: 'Lyrics.ovh',
  }];
}

export async function findTrackLyrics(input: {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}): Promise<LyricsRecord> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title || !artist) throw new Error('Track title and artist are required to search lyrics.');

  const normalizedInput = { ...input, title, artist };
  const providers: Array<{ name: string; search: () => Promise<LyricsRecord[]> }> = [
    { name: 'LiriQo (11 lyric providers)', search: () => searchLiriQo(normalizedInput) },
    { name: 'LRCLIB', search: () => searchLrclib(normalizedInput) },
    { name: 'Lyrics.ovh', search: () => searchLyricsOvh(normalizedInput) },
  ];
  const errors: string[] = [];
  const candidates: LyricsRecord[] = [];

  // Sequential requests avoid duplicate load and respect public provider rate limits.
  for (const provider of providers) {
    try {
      candidates.push(...await provider.search());
      const exact = candidates
        .filter((record) => !record.instrumental)
        .sort((a, b) => scoreRecord(b, title, artist, input.duration) - scoreRecord(a, title, artist, input.duration))[0];
      if (exact && scoreRecord(exact, title, artist, input.duration) >= 180 && exact.syncedLyrics) {
        return exact;
      }
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  const best = candidates
    .filter((record) => !record.instrumental && (record.syncedLyrics || record.plainLyrics))
    .sort((a, b) => scoreRecord(b, title, artist, input.duration) - scoreRecord(a, title, artist, input.duration))[0];
  if (best) return best;
  if (errors.length === providers.length) {
    throw new Error(`All lyrics providers failed. ${errors.join(' | ')}`);
  }
  throw new Error('No matching lyrics were found across LiriQo, LRCLIB, and Lyrics.ovh.');
}
