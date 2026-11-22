import React, { useEffect, useState } from 'react';
import { Music, Video } from 'lucide-react';
import { isValidThumbnailUrl } from '../utils/engine-parser';

export interface MediaThumbnailProps {
  src?: string | null;
  title: string;
  isAudio?: boolean;
  ext?: string;
  size?: 'sm' | 'md' | 'lg';
  aspect?: 'video' | 'square' | 'auto';
  showBadge?: boolean;
  className?: string;
}

export const MediaThumbnail: React.FC<MediaThumbnailProps> = ({
  src,
  title,
  isAudio = false,
  ext,
  size = 'md',
  aspect = 'auto',
  showBadge = true,
  className = '',
}) => {
  const validSrc = isValidThumbnailUrl(src) ? src.trim() : null;
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [validSrc]);

  const effectiveAspect = aspect === 'auto' ? (isAudio && size === 'lg' ? 'square' : 'video') : aspect;

  const sizeClass =
    size === 'sm'
      ? effectiveAspect === 'square'
        ? 'w-11 h-11 aspect-square'
        : 'w-16 sm:w-20 aspect-video'
      : size === 'lg'
      ? effectiveAspect === 'square'
        ? 'w-24 h-24 sm:w-28 sm:h-28 aspect-square'
        : 'w-full aspect-video'
      : effectiveAspect === 'square'
      ? 'w-16 h-16 sm:w-[72px] sm:h-[72px] aspect-square'
      : 'w-24 sm:w-28 aspect-video';

  const MediaIcon = isAudio ? Music : Video;
  const normalizedExt = ext ? ext.trim().replace(/^\./, '').toUpperCase() : '';
  const showImage = Boolean(validSrc && !hasError);

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-[var(--vanta-border)] bg-[var(--vanta-surface-2)] shrink-0 select-none ${sizeClass} ${className}`}
    >
      {showImage ? (
        <img
          src={validSrc!}
          alt={title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setHasError(true)}
          className="w-full h-full object-cover block"
        />
      ) : (
        <div
          aria-label={isAudio ? 'Audio media item' : 'Video media item'}
          className="w-full h-full flex flex-col items-center justify-center gap-1 px-1.5 text-[var(--vanta-muted)]"
        >
          <MediaIcon
            className={`${size === 'lg' ? 'w-7 h-7' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5'} ${
              isAudio ? 'text-emerald-600 dark:text-[#3fb950]' : 'text-[var(--vanta-accent)]'
            }`}
          />
          {normalizedExt && (
            <span className="text-[9px] leading-none font-mono font-semibold tracking-wider text-[var(--vanta-muted)]">
              {normalizedExt}
            </span>
          )}
        </div>
      )}

      {showBadge && showImage && (
        <span
          title={isAudio ? 'Audio / Music' : 'Video'}
          className={`absolute bottom-1 right-1 w-4 h-4 rounded border border-black/30 shadow-sm flex items-center justify-center ${
            isAudio ? 'bg-emerald-600/95 text-white' : 'bg-[var(--vanta-accent)]/95 text-white'
          }`}
        >
          <MediaIcon className="w-2.5 h-2.5" />
        </span>
      )}
    </div>
  );
};
