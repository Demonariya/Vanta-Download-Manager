export interface LyricsRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const API_BASE = 'https://lrclib.net/api';
const CLIENT_HEADER = 'VANTA Download Manager (https://github.com/Demonariya/Vanta-Download-Manager)';

async function requestJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: { 'X-User-Agent': CLIENT_HEADER },
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 404) throw new Error('NOT_FOUND');
  if (response.status === 429) throw new Error('Lyrics service rate limit reached. Try again shortly.');
  if (!response.ok) throw new Error(`Lyrics service returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function scoreRecord(record: LyricsRecord, title: string, artist: string, duration?: number): number {
  const wantedTitle = normalize(title);
  const wantedArtist = normalize(artist);
  const foundTitle = normalize(record.trackName || '');
  const foundArtist = normalize(record.artistName || '');
  let score = 0;
  if (foundTitle === wantedTitle) score += 100;
  else if (foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle)) score += 45;
  if (foundArtist === wantedArtist) score += 80;
  else if (foundArtist.includes(wantedArtist) || wantedArtist.includes(foundArtist)) score += 35;
  if (duration && record.duration) {
    const difference = Math.abs(duration - record.duration);
    score += difference <= 2 ? 35 : difference <= 5 ? 15 : difference <= 12 ? 4 : -35;
  }
  if (record.syncedLyrics) score += 12;
  if (record.instrumental) score -= 100;
  return score;
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

  const exactUrl = new URL(`${API_BASE}/get`);
  exactUrl.searchParams.set('track_name', title);
  exactUrl.searchParams.set('artist_name', artist);
  if (input.album?.trim()) exactUrl.searchParams.set('album_name', input.album.trim());
  if (input.duration && input.duration > 0) exactUrl.searchParams.set('duration', String(Math.round(input.duration)));

  try {
    const exact = await requestJson<LyricsRecord>(exactUrl);
    if (!exact.instrumental && (exact.syncedLyrics || exact.plainLyrics)) return exact;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'NOT_FOUND') throw error;
  }

  const searchUrl = new URL(`${API_BASE}/search`);
  searchUrl.searchParams.set('track_name', title);
  searchUrl.searchParams.set('artist_name', artist);
  if (input.album?.trim()) searchUrl.searchParams.set('album_name', input.album.trim());

  const results = await requestJson<LyricsRecord[]>(searchUrl);
  const best = results
    .filter((record) => !record.instrumental && (record.syncedLyrics || record.plainLyrics))
    .sort((a, b) => scoreRecord(b, title, artist, input.duration) - scoreRecord(a, title, artist, input.duration))[0];
  if (!best) throw new Error('No matching lyrics were found for this track.');
  return best;
}
