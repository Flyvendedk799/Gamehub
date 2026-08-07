'use client';

import { placeholderGradient, resolveThumbnailUrl } from '@/lib/thumbnail';
import Link from 'next/link';

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
      className="group block border border-hairline bg-surface transition-colors hover:border-signal"
    >
      {/* Thumbnail / duotone placeholder */}
      <div className="relative aspect-video w-full overflow-hidden bg-void">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- thumbnails come
          // from an external API origin; next/image needs allowlisted domains.
          <img src={thumb} alt={game.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: placeholderGradient(game.seedId) }}
          >
            <span className="type-label-xs tracking-[.12em] text-signal/70">No capture</span>
          </div>
        )}

        {/* Genre badge overlaid on the thumbnail */}
        {game.genre && (
          <span className="type-label-xs absolute left-2 top-2 border border-edge bg-black/50 px-2 py-1 tracking-[.14em] text-ink-2 backdrop-blur-sm">
            {game.genre.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="border-t border-hairline p-4">
        <h2 className="truncate text-xs font-bold tracking-[-.01em] text-ink sm:text-sm">
          {game.title}
        </h2>
        <p className="mt-1.5 font-mono text-[10px] tracking-[.06em] text-ink-4 sm:text-[11px]">
          {game.playCount !== undefined ? (
            <>
              {game.playCount.toLocaleString()} {game.playCount === 1 ? 'PLAY' : 'PLAYS'}
            </>
          ) : (
            'PUBLISHED'
          )}
          {hasRating && game.ratingAvg !== undefined && (
            <>
              {' '}
              &middot; {game.ratingAvg.toFixed(1)}★ ({game.ratingCount})
            </>
          )}
        </p>

        {/* Clickable tag pills (#3.4) — only when the host wires onTagClick. */}
        {onTagClick && game.tags && game.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {game.tags.slice(0, 3).map((t) => (
              <button
                key={t}
                type="button"
                onClick={(e) => {
                  // The card is a Link; don't navigate when filtering by a tag.
                  e.preventDefault();
                  e.stopPropagation();
                  onTagClick(t);
                }}
                className="border border-hairline px-3 py-1.5 font-mono text-xs text-ink-4 transition-colors hover:border-signal hover:text-signal md:px-2 md:py-0.5 md:text-[10px]"
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
