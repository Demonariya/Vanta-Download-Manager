import { CategoryItem } from '../types';

export const DEFAULT_CATEGORIES: CategoryItem[] = [
  {
    id: 'cat_video',
    name: 'Video',
    color: '#58a6ff',
    extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v'],
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cat_music',
    name: 'Music & Audio',
    color: '#3fb950',
    extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'opus', 'ogg'],
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cat_documents',
    name: 'Documents',
    color: '#d29922',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub'],
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cat_archives',
    name: 'Archives',
    color: '#a371f7',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'],
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cat_software',
    name: 'Software & Disk Images',
    color: '#f0883e',
    extensions: ['exe', 'msi', 'msix', 'dmg', 'iso', 'img', 'deb', 'rpm', 'apk', 'appimage'],
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

export function matchCategoryForTask(
  ext: string | undefined,
  isAudioOnly: boolean,
  categories: CategoryItem[] = DEFAULT_CATEGORIES
): CategoryItem | null {
  const cleanExt = (ext || '').replace(/^\./, '').trim().toLowerCase();
  if (cleanExt) {
    for (const cat of categories) {
      if (cat.extensions.some((e) => e.toLowerCase() === cleanExt)) {
        return cat;
      }
    }
  }
  if (isAudioOnly) {
    return categories.find((c) => c.id === 'cat_music') || null;
  }
  return null;
}

export function normalizeExtensionsList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.replace(/^\./, '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
}
