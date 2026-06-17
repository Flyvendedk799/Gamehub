'use client';

import Link from 'next/link';
import { placeholderGradient, resolveThumbnailUrl } from '@/lib/thumbnail';

/**
 * Phase 3.1 — thumbnail-gallery card shared by the Hub feed and creator
 * profiles. Leads with the game's thumbnail (or a deterministic gradient
 * placeholder when null), then title, an optional genre badge, and play count.
 */
export interface GameCardData {
  /** Stable seed for the placeholder gradient (game/project id or slug). */
  seedId: string;
  /** Play URL slug; the card links to `/p/<slug>`. */
  slug: string;
  title: string;
  thumbnailUrl: string | null;
  genre: string | null;
  /** Omitted on surfaces that don't have play counts (e.g. creator profiles). */
  playCount?: number;
  ratingAvg?: number;
  ratingCount?: number;
  /** Tags surfaced as clickable pills when `onTagClick` is provided (#3.4). */
  tags?: string[];
}

export function GameCard({
  game,
  onTagClick,
}: {
  game: GameCardData;
  /** When provided, the first few tags render as pills that filter the feed. */
  onTagClick?: (tag: string) => void;
}) {
  const thumb = resolveThumbnailUrl(game.thumbnailUrl);
  const hasRating = (game.ratingCount ?? 0) > 0;

  return (
    <Link
      href={`/p/${game.slug}`}
      className="group bg-[#111111] border border-[#222222] rounded-xl overflow-hidden hover:border-[#333333] transition-colors block"
    >
      {/* Thumbnail / gradient placeholder */}
      <div className="relative aspect-video w-full overflow-hidden bg-[#0a0a0a]">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- thumbnails come
          // from an external API origin; next/image needs allowlisted domains.
          <img
            src={thumb}
            alt={game.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: placeholderGradient(game.seedId) }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <polygon points="6,4 19,12 6,20" fill="rgba(255,255,255,0.85)" />
            </svg>
          </div>
        )}

        {/* Genre badge overlaid on the thumbnail */}
        {game.genre && (
          <span className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-md bg-black/50 backdrop-blur-sm text-[#e4e4e7] border border-white/10">
            {game.genre.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="p-4">
        <h2 className="text-sm font-semibold text-[#f4f4f5] truncate group-hover:text-[#6366f1] transition-colors">
          {game.title}
        </h2>
        <p className="text-xs text-[#52525b] mt-1.5">
          {game.playCount !== undefined ? (
            <>
              {game.playCount.toLocaleString()} {game.playCount === 1 ? 'play' : 'plays'}
            </>
          ) : (
            'Published'
          )}
          {hasRating && game.ratingAvg !== undefined && (
            <>
              {' '}
              &middot; ★ {game.ratingAvg.toFixed(1)} ({game.ratingCount})
            </>
          )}
        </p>

        {/* Clickable tag pills (#3.4) — only when the host wires onTagClick. */}
        {onTagClick && game.tags && game.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {game.tags.slice(0, 3).map((t) => (
              <button
                key={t}
                onClick={(e) => {
                  // The card is a Link; don't navigate when filtering by a tag.
                  e.preventDefault();
                  e.stopPropagation();
                  onTagClick(t);
                }}
                className="text-[10px] px-2 py-0.5 rounded-full bg-[#1a1a1a] text-[#71717a] border border-[#222222] hover:text-[#6366f1] hover:border-[#6366f1]/40 transition-colors"
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
