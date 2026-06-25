'use client';

import { GameCard } from '@/components/GameCard';
import type { GameCardData } from '@/components/GameCard';
import { getHubFeed, searchHub } from '@/lib/api';
import type { HubGame, HubSort } from '@/lib/api';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const SORTS: ReadonlyArray<{ id: HubSort; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'popular', label: 'Popular' },
  { id: 'trending', label: 'Trending' },
];

/** Map a HubGame onto the shared gallery-card shape (#3.1). */
function toCardData(game: HubGame): GameCardData {
  return {
    seedId: game.id,
    slug: game.publishSlug,
    title: game.title,
    thumbnailUrl: game.thumbnailUrl,
    genre: game.genre,
    playCount: game.playCount,
    ratingAvg: game.ratingAvg,
    ratingCount: game.ratingCount,
    tags: game.tags,
  };
}

/**
 * Genre chips are derived from whatever genres the feed actually surfaces, so
 * the chip list never drifts from backend data. We track the widest set we've
 * seen this session so chips don't vanish when a narrower filter is applied.
 */
function mergeGenres(prev: string[], games: HubGame[]): string[] {
  const set = new Set(prev);
  for (const g of games) {
    if (g.genre && g.genre.trim().length > 0) set.add(g.genre);
  }
  return Array.from(set).sort();
}

export default function HubPage() {
  const [games, setGames] = useState<HubGame[]>([]);
  const [sort, setSort] = useState<HubSort>('recent');
  const [genre, setGenre] = useState<string>(''); // '' = All
  const [tag, setTag] = useState<string>(''); // '' = no tag filter
  const [knownGenres, setKnownGenres] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // #26 — debounced Hub search. Empty query falls back to the normal feed.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const isSearching = debouncedQuery.trim().length > 0;

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    setLoading(true);
    if (q.length === 0) {
      // Sort + genre + tag filters compose on the feed (#3.3/#3.4).
      void getHubFeed({ sort, genre, tag, limit: 24 })
        .then(({ games: g }) => {
          setGames(g);
          setKnownGenres((prev) => mergeGenres(prev, g));
        })
        .catch(() => setGames([]))
        .finally(() => setLoading(false));
      return;
    }
    // Search ignores sort/genre/tag (the search endpoint is its own ranking);
    // the controls are disabled while searching to keep the UX honest.
    let cancelled = false;
    void searchHub(q, { limit: 24 })
      .then(({ results }) => {
        if (!cancelled) {
          setGames(results);
          setKnownGenres((prev) => mergeGenres(prev, results));
        }
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sort, genre, tag, debouncedQuery]);

  const filtersActive = !isSearching && (genre !== '' || tag !== '');
  const genreChips = useMemo(() => knownGenres, [knownGenres]);

  return (
    <div className="flex flex-col min-h-dvh bg-[#0a0a0a]">
      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 max-w-7xl mx-auto w-full">
        {/* Page heading + sort controls */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-[#f4f4f5]">Community Hub</h1>
            <p className="text-sm text-[#52525b] mt-0.5">Discover games built with PlayerZero</p>
          </div>

          {/* #3.3 — sort tabs */}
          <div className="flex items-center gap-1 bg-[#111111] border border-[#222222] rounded-lg p-0.5">
            <span className="text-xs text-[#52525b] px-2">Sort:</span>
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSort(s.id)}
                disabled={isSearching}
                className={`text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-md transition-colors font-medium disabled:opacity-40 ${
                  sort === s.id ? 'bg-[#6366f1] text-white' : 'text-[#71717a] hover:text-[#f4f4f5]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Search box (#26) */}
        <div className="mb-4 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games…"
            aria-label="Search games"
            className="w-full bg-[#111111] border border-[#222222] rounded-lg pl-9 pr-9 py-2.5 text-sm text-[#f4f4f5] placeholder-[#52525b] outline-none focus:border-[#6366f1] transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#52525b] hover:text-[#a1a1aa] text-sm tap-target inline-flex items-center justify-center md:min-h-0 md:min-w-0"
            >
              ✕
            </button>
          )}
        </div>

        {/* #3.4 — genre filter chips + active tag chip. Hidden while searching
            (search is its own ranking and ignores these filters). */}
        {!isSearching && (genreChips.length > 0 || tag !== '') && (
          <div className="mb-8 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setGenre('')}
              className={`text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-full border transition-colors font-medium ${
                genre === ''
                  ? 'bg-[#6366f1] text-white border-[#6366f1]'
                  : 'bg-[#111111] text-[#71717a] border-[#222222] hover:text-[#f4f4f5] hover:border-[#333333]'
              }`}
            >
              All
            </button>
            {genreChips.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenre(genre === g ? '' : g)}
                className={`text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-full border transition-colors font-medium ${
                  genre === g
                    ? 'bg-[#6366f1] text-white border-[#6366f1]'
                    : 'bg-[#111111] text-[#71717a] border-[#222222] hover:text-[#f4f4f5] hover:border-[#333333]'
                }`}
              >
                {g.replace(/_/g, ' ')}
              </button>
            ))}

            {/* Active tag filter (set by clicking a tag on a card) */}
            {tag !== '' && (
              <button
                type="button"
                onClick={() => setTag('')}
                className="text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-full border bg-[#6366f1]/10 text-[#6366f1] border-[#6366f1]/30 font-medium inline-flex items-center gap-1.5"
                aria-label={`Remove tag filter ${tag}`}
              >
                #{tag}{' '}
                <span className="text-[#6366f1]/70 tap-target inline-flex items-center justify-center md:min-h-0 md:min-w-0">
                  ✕
                </span>
              </button>
            )}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list, never reordered
                key={i}
                className="bg-[#111111] border border-[#222222] rounded-xl overflow-hidden animate-pulse"
              >
                <div className="aspect-video w-full bg-[#1a1a1a]" />
                <div className="p-4">
                  <div className="h-4 bg-[#1a1a1a] rounded w-3/4 mb-3" />
                  <div className="h-3 bg-[#1a1a1a] rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && games.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#111111] border border-[#222222] flex items-center justify-center mb-4">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <polygon points="4,2.5 16,10 4,17.5" fill="#3f3f46" />
              </svg>
            </div>
            {isSearching ? (
              <>
                <p className="text-sm font-medium text-[#71717a]">
                  No games match “{debouncedQuery.trim()}”
                </p>
                <p className="text-xs text-[#52525b] mt-1">Try a different search.</p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-6 text-xs px-4 py-2 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border border-[#222222] font-medium transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : filtersActive ? (
              <>
                <p className="text-sm font-medium text-[#71717a]">No games match this filter</p>
                <p className="text-xs text-[#52525b] mt-1">
                  Try a different genre or clear the filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setGenre('');
                    setTag('');
                  }}
                  className="mt-6 text-xs px-4 py-2 rounded-lg bg-[#1a1a1a] hover:bg-[#222222] text-[#a1a1aa] border border-[#222222] font-medium transition-colors"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-[#71717a]">No games published yet</p>
                <p className="text-xs text-[#52525b] mt-1">Be the first!</p>
                <Link
                  href="/"
                  className="mt-6 text-xs px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white font-medium transition-colors"
                >
                  Build a game
                </Link>
              </>
            )}
          </div>
        )}

        {/* Game gallery (#3.1) */}
        {!loading && games.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {games.map((game) => (
              <GameCard
                key={game.id}
                game={toCardData(game)}
                onTagClick={(t) => {
                  setTag(t);
                  setQuery('');
                }}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
